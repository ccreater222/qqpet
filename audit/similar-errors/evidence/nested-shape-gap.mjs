// 证据：canonical 子结构缺失/半结构能通过导入校验，但 runtime handler 假设其完整 → 误导性拒绝或 internal。
// 运行：node --experimental-strip-types audit/similar-errors/evidence/nested-shape-gap.mjs
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

const { createHeadlessRuntime, createRngState, levelAndCapsOf } = await importTs('src/shared/pet-runtime/index.ts')
const { assertSharedSaveData } = await importTs('src/shared/sync/data-boundary.ts')
const { createSyncFixtures, SEED, GAME_TIME_MS, DAY_KEY, NEXT_BOUNDARY_MS } = await importTs('scripts/tests/sync-fixtures.mjs')

const fixture = JSON.parse(readFileSync(new URL('./../fixtures/imported-shared.json', import.meta.url), 'utf8'))
const fixtures = createSyncFixtures()
const context = state => ({
  gameTimeMs: state.gameTimeMs,
  environment: state.environment,
  activeClientCount: 1,
  sessionActive: true,
  actorDeviceId: 'audit-device',
  actorRole: 'owner',
})

function engineWith(save) {
  const state = clone(fixtures.engine)
  state.save = save
  Object.assign(state.save.petInfo, { growth: 5000, health: 5, hunger: 1000, clean: 1000, mood: 900, yb: 50000 })
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

const cases = [
  {
    name: 'activeOption={}',
    mutate: save => { save.activeOption = {} },
    command: { type: 'job.startWork', payload: { jobId: 'bz' } },
  },
  {
    name: 'activeOption 缺 work',
    mutate: save => { delete save.activeOption.work },
    command: { type: 'job.startWork', payload: { jobId: 'bz' } },
  },
  {
    name: 'gameSaveDatas={}',
    mutate: save => { save.gameSaveDatas = {} },
    command: { type: 'travel.completeCollection', payload: {} },
  },
  {
    name: 'selfGoodDatas 缺 food',
    mutate: save => { delete save.selfGoodDatas.food },
    command: { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
  },
]

for (const item of cases) {
  const save = clone(fixture)
  item.mutate(save)
  let validation = 'passes assertSharedSaveData'
  try {
    assertSharedSaveData(save)
  } catch (error) {
    validation = 'rejected: ' + error.message
  }
  const runtime = createHeadlessRuntime(engineWith(save))
  const outcome = runtime.execute(item.command, context(runtime.snapshot()))
  const result = outcome.ok ? 'ok' : outcome.error.code + ': ' + outcome.error.message
  console.log(item.name, '| validator:', validation, '|', item.command.type, '->', result)
}
