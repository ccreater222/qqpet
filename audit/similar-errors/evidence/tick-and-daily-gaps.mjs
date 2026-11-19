// 证据：blob-auditor 的高危候选（C04 每分钟 tick、C10 迁移丢在途活动、C01 daily 表空档）独立复核。
// 运行：node --experimental-strip-types audit/similar-errors/evidence/tick-and-daily-gaps.mjs
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\/src\/shared\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) return nextResolve(specifier + '.ts', context)
    return nextResolve(specifier, context)
  },
})

const ROOT = new URL('../../..', import.meta.url)
const importTs = path => import(new URL(path, ROOT).href)
const clone = value => JSON.parse(JSON.stringify(value))

const { createHeadlessRuntime, createRngState, levelAndCapsOf, advanceMinute } = await importTs('src/shared/pet-runtime/index.ts')
const { createSyncFixtures, SEED, GAME_TIME_MS, DAY_KEY, NEXT_BOUNDARY_MS } = await importTs('scripts/tests/sync-fixtures.mjs')
const fixture = JSON.parse(readFileSync(new URL('./../fixtures/imported-shared.json', import.meta.url), 'utf8'))
const fixtures = createSyncFixtures()

function engineWith(save) {
  const state = clone(fixtures.engine)
  state.save = save
  Object.assign(state.save.petInfo, { growth: 5000, health: 5, hunger: 1100, clean: 1100, mood: 1000, yb: 50000 })
  state.save.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  state.save.settings.paused = false
  state.gameTimeMs = GAME_TIME_MS
  state.lastSchedulerWallMs = GAME_TIME_MS
  state.timeZone = 'Asia/Shanghai'
  state.rng = createRngState(SEED)
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  return state
}

const context = state => ({
  gameTimeMs: state.gameTimeMs,
  environment: state.environment,
  activeClientCount: 1,
  sessionActive: true,
  actorDeviceId: 'audit-device',
  actorRole: 'owner',
})

// C04：selfGoodUseOption 缺键 → 每分钟 tick 是否 internal
for (const shape of [{ background: null, food: null, clean: null }, {}]) {
  const save = clone(fixture)
  save.selfGoodUseOption = shape
  const state = engineWith(save)
  const outcome = advanceMinute(state, context(state))
  console.log('C04 selfGoodUseOption=' + JSON.stringify(shape), '->', outcome.ok ? 'ok' : outcome.error.code + ': ' + outcome.error.message)
}

// C01/C15：daily 定义存在但 taskList.daily 为空 → 领今日任务
const partial = clone(fixture)
partial.saveJsonData.task = JSON.stringify({
  doNums: { Eat: 1 },
  taskList: { daily: [], ddw: [], growth: [], travel: [] },
  daily: [{ label: '喂我吃东西2次', msg: 'eat', obj: 'Eat', num: 1, reroll: 1, good: ['_yb*10'] }],
  dailyDay: Math.floor(GAME_TIME_MS / 1000),
})
const dailyRuntime = createHeadlessRuntime(engineWith(partial))
const dailyClaim = dailyRuntime.execute({ type: 'task.claim', payload: { tab: 'daily', index: 0 } }, context(dailyRuntime.snapshot()))
console.log('C15 daily definition present, taskList.daily empty ->', dailyClaim.ok ? 'ok' : dailyClaim.error.code + ': ' + dailyClaim.error.message)

// F2：导入/新领养后到下一个 06:00 之前，daily 表为空（legacy 模式启动时就会 roll）
const importedState = engineWith(clone(fixture))
const importedBlob = JSON.parse(importedState.save.saveJsonData.task)
console.log('F2 imported: daily=' + (importedBlob.daily ?? []).length + ' taskList.daily=' + (importedBlob.taskList?.daily ?? []).length)
const boundaryRuntime = createHeadlessRuntime(importedState)
const advanced = boundaryRuntime.advance(context(importedState), 841)
const afterBoundary = JSON.parse(advanced.state.save.saveJsonData.task)
console.log('F2 after 841-min advance (cross 06:00): daily=' + (afterBoundary.daily ?? []).length + ' taskList.daily=' + (afterBoundary.taskList?.daily ?? []).length, '| ok=' + advanced.ok)

// C10：legacy 在途活动（activeOption + activity 有值、无 scheduled job）迁移后首次 tick
const inFlight = clone(fixture)
inFlight.activeOption.work = 'bz'
inFlight.saveJsonData.activity = '30'
const flightState = engineWith(inFlight)
flightState.scheduledJobs = []
const flightRuntime = createHeadlessRuntime(flightState)
const before = flightRuntime.snapshot()
const tick = advanceMinute(before, context(before))
const after = flightRuntime.snapshot ? flightRuntime.snapshot() : null
console.log('C10 before tick: work=' + before.save.activeOption.work + ' activity=' + before.save.saveJsonData.activity + ' jobs=' + before.scheduledJobs.length)
console.log('C10 tick ->', tick.ok ? 'ok' : tick.error.code + ': ' + tick.error.message,
  '| event types:', tick.ok ? [...new Set(tick.events.map(event => event.type))].join(',') : '-')
if (tick.ok) {
  console.log('C10 after tick: work=' + tick.state.save.activeOption.work + ' activity=' + tick.state.save.saveJsonData.activity,
    '| doNums=', JSON.stringify(JSON.parse(tick.state.save.saveJsonData.task).doNums))
}
void after
