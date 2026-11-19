// 同类缺陷动态复现台（audit/similar-errors）。
// 用法：
//   node --experimental-strip-types audit/similar-errors/harness.mjs --scenario imported --json
//   node --experimental-strip-types audit/similar-errors/harness.mjs --diff
// 说明：所有场景共用同一份 boost（资源、等级、学习进度），只让“存档形状”成为变量。
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\/src\/shared\/(pet-runtime|sync)\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const imp = path => import(join(ROOT, path))

const { createHeadlessRuntime, createRngState, levelAndCapsOf } = await imp('src/shared/pet-runtime/index.ts')
const { emptyEggSave } = await imp('src/shared/pet-runtime/handlers-a.ts')
const { dayKeyAt, nextDailyBoundaryMs } = await imp('src/shared/pet-runtime/time.ts')
const { TRAVEL_PROVINCES } = await imp('src/shared/pet-runtime/content/index.ts')
const { createSyncFixtures, SEED } = await imp('scripts/tests/sync-fixtures.mjs')

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'audit/similar-errors/fixtures/imported-shared.json'), 'utf8'))
const GAME_TIME_MS = Date.UTC(2026, 10, 18, 12, 1, 0) // 2026-11-18 20:01 +08
const TIME_ZONE = 'Asia/Shanghai'
const ADVANCE_MINUTES = 601 // 跨过 2026-11-19 06:00 的每日边界

const clone = value => JSON.parse(JSON.stringify(value))
const fixtures = createSyncFixtures()

function engineFrom(shared) {
  const state = clone(fixtures.engine)
  state.save = clone(shared)
  state.gameTimeMs = GAME_TIME_MS
  state.lastSchedulerWallMs = GAME_TIME_MS
  state.timeZone = TIME_ZONE
  state.weatherLocation = 'Shanghai'
  state.advanceWhileEmpty = true
  state.rng = createRngState(SEED)
  state.scheduledJobs = []
  state.nextScheduledJobId = 1
  state.gameSessions = []
  state.sessionCoverage = []
  delete state.coverageReopen
  state.lastProcessedDayBoundaryKey = dayKeyAt(GAME_TIME_MS, TIME_ZONE)
  state.nextDailyBoundaryMs = nextDailyBoundaryMs(GAME_TIME_MS, TIME_ZONE)
  state.importClamped = false
  state.clockSkippedMs = 0
  state.environment = { calendarByDay: {}, weatherByDay: {} }
  return state
}

/** 只放大“数量型”资源，不改动任何 blob/字段的存在性。 */
function boost(save) {
  Object.assign(save.petInfo, {
    growth: 5000, yb: 50000, diamond: 100, health: 5, hunger: 1100, clean: 1100, mood: 1000,
    intel: 200, charm: 200, strong: 200,
  })
  save.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  save.studyInfo = { chinese: 30, mathematics: 30, politics: 30, music: 30, art: 30, manner: 30, pe: 30, labouring: 30, wushu: 30 }
  for (const [type, code] of Object.entries({
    food: '_102010001*20', clean: '_10021005*20', toy: '_t0002*5', medicine: '_60001*5', nums: '_growth*100',
  })) {
    const list = save.selfGoodDatas[type]
    if (Array.isArray(list) && list.length === 0) list.push(code)
  }
  save.gameSaveDatas.travel_china = TRAVEL_PROVINCES.map(province => ({ name: province.name, value: 1 }))
}

function context(state, overrides = {}) {
  return {
    gameTimeMs: state.gameTimeMs,
    environment: state.environment,
    activeClientCount: 1,
    sessionActive: true,
    actorDeviceId: 'audit-device',
    actorRole: 'owner',
    ...overrides,
  }
}

/** 返回三个场景的初始 EngineState。 */
function scenarios() {
  const imported = engineFrom(FIXTURE)
  boost(imported.save)

  const resetRuntime = createHeadlessRuntime(engineFrom(FIXTURE))
  const advanced = resetRuntime.advance(context(resetRuntime.snapshot(), { gameTimeMs: GAME_TIME_MS + ADVANCE_MINUTES * 60_000 }), ADVANCE_MINUTES)
  if (advanced.ok === false) throw new Error('advance failed: ' + JSON.stringify(advanced.error))
  const afterReset = resetRuntime.snapshot()
  boost(afterReset.save)

  const freshRuntime = createHeadlessRuntime(engineFrom(emptyEggSave(clone(FIXTURE))))
  const adopted = freshRuntime.execute(
    { type: 'pet.adopt', payload: { sex: 'MM' } },
    context(freshRuntime.snapshot(), { actorRole: 'owner' }),
  )
  if (adopted.ok === false) throw new Error('fresh adopt failed: ' + JSON.stringify(adopted.error))
  const fresh = freshRuntime.snapshot()
  boost(fresh.save)

  return { imported, 'imported-reset': afterReset, fresh }
}

// ---- 命令链 -------------------------------------------------------------

function chain(name, steps, setup = null) {
  return { name, steps, setup }
}

const CHAINS = [
  chain('pet.lifecycle', [
    ['pet.rename', { name: '小企鹅', host: '主人' }],
    ['pet.pokeFace', { spotId: 'H' }],
    ['pet.cheer', {}],
    ['pet.setPaused', { paused: true }],
    ['pet.setPaused', { paused: false }],
    ['pet.bury', {}],
  ]),
  chain('pet.adopt', [['pet.adopt', { sex: 'MM' }]], save => { save.havePet = false }),
  chain('inventory', [
    ['inventory.buy', { type: 'food', itemId: '102010001', quantity: 1 }],
    ['inventory.use', { type: 'food', itemId: '102010001' }],
    ['inventory.use', { type: 'clean', itemId: '10021005' }],
    ['inventory.use', { type: 'toy', itemId: 't0002' }],
  ], save => { save.petInfo.hunger = 500; save.petInfo.clean = 500 }),
  chain('medical', [
    ['medical.treat', { mode: 'doctor' }],
  ], save => { save.petInfo.health = 4; save.activeOption.ill = '0-' }),
  chain('vip', [
    ['vip.buyPinkDiamond', { days: 1 }],
    ['vip.clearPinkDiamond', {}],
    ['vip.buySweetheart', { days: 1 }],
    ['vip.setSweetheart', { enabled: true }],
  ]),
  chain('jobs', [
    ['job.startWork', { jobId: 'bz' }],
    ['activity.stop', {}],
    ['job.startStudy', { courseId: 'xx-chinese' }],
    ['activity.stop', {}],
    ['job.startTravel', {}],
    ['activity.stop', {}],
  ], save => { save.studyInfo.chinese = 0 }),
  chain('task.static', [
    ['task.claim', { tab: 'ddw', index: 0 }],
    ['task.claim', { tab: 'ddw', index: 1 }],
    ['task.claim', { tab: 'growth', index: 0 }],
    ['task.claim', { tab: 'travel', index: 0 }],
  ], save => { save.saveJsonData.task = JSON.stringify({ doNums: { Amusing: 5, Study: 1, Travel1: 1 }, taskList: { daily: [], ddw: [], growth: [], travel: [] } }) }),
  chain('task.daily', [
    ['task.claim', { tab: 'daily', index: 0 }],
  ], save => {
    save.saveJsonData.task = JSON.stringify({
      doNums: { Eat: 1 },
      taskList: { daily: [{ take: false, good: [{ id: 'yb', type: 'nums', num: 10, name: '元宝', url: '' }] }], ddw: [], growth: [], travel: [] },
      daily: [{ label: 'Eat task', msg: 'eat', obj: 'Eat', num: 1 }],
      dailyDay: Math.floor(GAME_TIME_MS / 1000),
    })
  }),
  chain('exam', [
    ['exam.start', { subject: 'xx-chinese' }],
    ['exam.submit', null],
  ], save => { save.studyInfo.chinese = 9 }),
  chain('signin', [
    ['signin.sign', {}],
    ['signin.drawGrowth', {}],
    ['signin.claimOnlineGift', {}],
    ['signin.claimBirthdayGift', {}],
  ]),
  chain('mail', [
    ['mail.claimAll', {}],
    ['mail.deleteAll', { scope: 'claimed' }],
    ['mail.claim', { mailId: '1' }],
    ['mail.delete', { mailId: '1' }],
  ]),
  chain('diudiule', [
    ['diudiule.startSession', {}],
    ['diudiule.reward', null],
  ]),
  chain('game', [
    ['game.startSession', { gameId: 'game-1', kind: 'small' }],
    ['game.reward', null],
    ['game.startSession', { gameId: 'game-2', kind: 'flash' }],
    ['game.abandonSession', null],
  ]),
  chain('island.core', [
    ['island.arriveScene', { sceneId: '3' }],
    ['island.talkNpc', { npcId: '莉莉' }],
    ['island.visitSpot', { spotId: 'jycat' }],
    ['island.chat', { npcId: '莉莉' }],
    ['island.playGame', { gameKey: 'QQ跆拳道' }],
    ['island.giftNpc', { npcId: '莉莉', itemId: '102010001' }],
  ]),
  chain('island.rewards', [
    ['island.claimGrowthReward', {}],
    ['island.claimTreasure', {}],
    ['island.refreshNews', { dayKey: '2026-11-18' }],
  ]),
  chain('fishing', [
    ['fishing.buy', { fryId: 2, quantity: 1 }],
    ['fishing.feed', null],
    ['fishing.harvest', null],
    ['fishing.harvestAll', {}],
    ['fishing.speedUp', {}],
  ]),
  chain('farm', [
    ['farm.buySeed', { seedId: 'RadishSeed', quantity: 1 }],
    ['farm.reclaim', { plotIds: [6, 7] }],
    ['farm.plant', { seedId: 'RadishSeed', plotIds: [0] }],
    ['farm.care', { plotIds: [0], action: 'water' }],
    ['farm.buyFertilizer', { fertilizerId: 'Fertilizer', quantity: 1 }],
    ['farm.sellProduce', { itemId: 'RadishSeed', quantity: 1 }],
  ]),
  chain('travel.collection', [['travel.completeCollection', {}]]),
  chain('settings', [
    ['settings.setShared', { key: 'difficulty', value: 'standard' }],
    ['settings.setShared', { key: 'undying', value: true }],
  ]),
]

// ---- 执行 ---------------------------------------------------------------

function runChain(state, spec) {
  const initial = clone(state)
  if (spec.setup !== null) spec.setup(initial.save)
  const runtime = createHeadlessRuntime(initial)
  const results = []
  for (const [type, payload] of spec.steps) {
    const snapshot = runtime.snapshot()
    let effective = payload
    if (payload === null) {
      const previous = results[results.length - 1]
      effective = previous?.token === undefined ? {} : { sessionToken: previous.token }
      if (type === 'exam.submit') effective = { sessionToken: previous?.token ?? 'missing', answers: [0, 0, 0] }
      if (type === 'game.reward' || type === 'diudiule.reward' || type === 'game.abandonSession') effective = { sessionToken: previous?.token ?? 'missing' }
      if (type === 'fishing.feed' || type === 'fishing.harvest') effective = { fishId: previous?.fishId ?? 1 }
    }
    const outcome = runtime.execute({ type, payload: effective }, context(snapshot))
    const record = { step: type, ok: outcome.ok }
    if (outcome.ok) {
      const result = outcome.result ?? {}
      if (typeof result.sessionToken === 'string') record.token = result.sessionToken
      if (type === 'game.startSession') record.extra = result.gameId
      if (type === 'fishing.buy') record.fishId = result.fishIds?.[0]
    } else {
      record.code = outcome.error.code
      record.message = outcome.error.message
    }
    results.push(record)
  }
  return results
}

function runScenario(state) {
  const out = {}
  for (const spec of CHAINS) out[spec.name] = runChain(state, spec)
  return out
}

function diffRuns(a, b, aName, bName) {
  const lines = []
  for (const chainName of Object.keys(a)) {
    const left = a[chainName]
    const right = b[chainName]
    left.forEach((step, index) => {
      const other = right[index]
      if (other === undefined) return
      const same = step.ok === other.ok && step.code === other.code && step.message === other.message
      if (!same) {
        lines.push({
          chain: chainName,
          step: step.step,
          [aName]: step.ok ? 'ok' : `${step.code}: ${step.message}`,
          [bName]: other.ok ? 'ok' : `${other.code}: ${other.message}`,
        })
      }
    })
  }
  return lines
}

const args = process.argv.slice(2)
const flag = name => args.includes('--' + name)
const option = name => {
  const index = args.indexOf('--' + name)
  return index < 0 ? undefined : args[index + 1]
}

const states = scenarios()
if (flag('diff')) {
  const base = runScenario(states.imported)
  const report = {
    'imported vs imported-reset': diffRuns(base, runScenario(states['imported-reset']), 'imported', 'imported-reset'),
    'imported vs fresh': diffRuns(base, runScenario(states.fresh), 'imported', 'fresh'),
  }
  console.log(JSON.stringify(report, null, 1))
} else {
  const which = option('scenario') ?? 'imported'
  if (states[which] === undefined) throw new Error('unknown scenario: ' + which)
  console.log(JSON.stringify({ scenario: which, results: runScenario(states[which]) }, null, 1))
}
