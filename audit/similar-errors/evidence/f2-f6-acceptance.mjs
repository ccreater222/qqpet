// F2–F6 验收证据（lead 独立复跑，不依赖子代理测试文件）。
// 运行：node --experimental-strip-types audit/similar-errors/evidence/f2-f6-acceptance.mjs
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\/src\/(shared|renderer)\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) return nextResolve(specifier + '.ts', context)
    if (specifier.endsWith('.json') && context.parentURL) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', source: 'export default ' + readFileSync(new URL(url), 'utf8'), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const ROOT = new URL('../../..', import.meta.url)
const importTs = path => import(new URL(path, ROOT).href)
const clone = value => JSON.parse(JSON.stringify(value))

const { createHeadlessRuntime, createRngState, levelAndCapsOf, TRAVEL_PROVINCES } = await importTs('src/shared/pet-runtime/index.ts')
const { migrateLegacySaveDataToPortableBundle, validateEngineState } = await importTs('src/shared/sync/portable.ts')
const { medicalQuote } = await importTs('src/shared/pet-runtime/medical-cost.ts')
const { settleCartLines } = await importTs('src/renderer/ui/shop-cart.ts')
const { previewTaskGoods } = await importTs('src/renderer/pet/task-preview.ts')
const { createSyncFixtures, SEED, GAME_TIME_MS, DAY_KEY, NEXT_BOUNDARY_MS } = await importTs('scripts/tests/sync-fixtures.mjs')

const fixtures = createSyncFixtures()
const fixture = JSON.parse(readFileSync(new URL('./../fixtures/imported-shared.json', import.meta.url), 'utf8'))
const context = state => ({
  gameTimeMs: state.gameTimeMs,
  environment: state.environment,
  activeClientCount: 1,
  sessionActive: true,
  actorDeviceId: 'audit-device',
  actorRole: 'owner',
})
const taskBlob = state => JSON.parse(state.save.saveJsonData.task)
const MIGRATION = {
  nowMs: GAME_TIME_MS,
  seedHex: SEED,
  authority: fixtures.authority,
  localDeviceId: 'local-device-0001',
  timeZone: 'Asia/Shanghai',
  advanceWhileEmpty: true,
  weatherLocation: 'Shanghai',
}

function engineWith(save) {
  const state = clone(fixtures.engine)
  state.save = save
  Object.assign(state.save.petInfo, { growth: 5000, health: 5, hunger: 1100, clean: 1100, mood: 1000, yb: 50000 })
  state.save.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  state.gameTimeMs = GAME_TIME_MS
  state.lastSchedulerWallMs = GAME_TIME_MS
  state.timeZone = 'Asia/Shanghai'
  state.rng = createRngState(SEED)
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  return state
}

// ---- F2：首 tick / 新领养立即拥有今日任务 ---------------------------------
{
  const runtime = createHeadlessRuntime(engineWith(clone(fixture)))
  const ticked = runtime.tick(context(runtime.snapshot()))
  const blob = taskBlob(ticked.state)
  console.log('F2 first tick: ok=' + ticked.ok, 'daily=' + blob.daily.length, 'entries=' + blob.taskList.daily.length, 'dailyDay=' + blob.dailyDay)

  blob.doNums = { Eat: 99, Clean: 99, Toy: 99, Amusing: 99, Work: 99, Study: 99, GameRound: 99, Game: 99, Travel1: 99 }
  ticked.state.save.saveJsonData.task = JSON.stringify(blob)
  const claimed = runtime.execute({ type: 'task.claim', payload: { tab: 'daily', index: 0 } }, context(runtime.snapshot()))
  console.log('F2 daily claim after materialization: ok=' + claimed.ok, 'goods=' + (claimed.ok ? claimed.result.goods.length : claimed.error.code))

  const adoptState = engineWith(clone(fixture))
  adoptState.save.havePet = false
  const adopted = createHeadlessRuntime(adoptState)
  const adoptOutcome = adopted.execute({ type: 'pet.adopt', payload: { sex: 'MM' } }, context(adopted.snapshot()))
  const adoptedBlob = taskBlob(adopted.snapshot())
  console.log('F2 adopt: ok=' + adoptOutcome.ok, 'daily=' + adoptedBlob.daily.length, 'entries=' + adoptedBlob.taskList.daily.length)
}

// ---- F3：投影模式不本地抽 reroll 奖励 ------------------------------------
{
  const task = { reroll: 2, good: ['_102010001*1'] }
  let draws = 0
  const loot = count => { draws += count; return [{ id: 'x', type: 'food', num: 1, name: 'x', url: '' }] }
  const projected = previewTaskGoods(task, { projectionMode: true, loot })
  const projectedDraws = draws
  const legacy = previewTaskGoods(task, { projectionMode: false, loot })
  console.log('F3 preview projection: goods=' + projected.map(good => good.id).join(','), 'lootDraws=' + projectedDraws,
    '| legacy goods=' + legacy.length, 'legacyLootDraws=' + draws)
}

// ---- F4：医生报价 == 实扣；商城逐行结算 --------------------------------
{
  for (const [health, medicine, label] of [[4, [], 'health4 no med'], [4, ['_10003*2'], 'health4 owned'], [0, [], 'dead no med']]) {
    const state = engineWith(clone(fixture))
    state.save.petInfo.health = health
    state.save.activeOption.ill = health === 0 ? '0-' : '0-'
    state.save.selfGoodDatas.medicine = medicine.slice()
    state.save.petInfo.yb = 30_000
    const quote = medicalQuote(state.save)
    const runtime = createHeadlessRuntime(state)
    const outcome = runtime.execute({ type: 'medical.treat', payload: { mode: 'doctor' } }, context(runtime.snapshot()))
    const charged = state.save.petInfo.yb - outcome.state.save.petInfo.yb
    console.log('F4 ' + label + ': quote=' + quote.total, 'charged=' + charged, 'ok=' + outcome.ok)
  }
  const lines = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  const settled = settleCartLines(lines, [{ key: 'a', ok: true }, { key: 'b', ok: false }])
  console.log('F4 cart partial: remaining=' + settled.remaining.map(line => line.key).join(','), 'allOk=' + settled.allOk)
}

// ---- F5：partial legacy save 经迁移后命令面健康 ---------------------------
{
  const legacy = clone(fixtures.shared)
  Object.assign(legacy.petInfo, { growth: 5000, yb: 30000 })
  legacy.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  legacy.activeOption = {}
  delete legacy.studyInfo.wushu
  delete legacy.selfGoodDatas.food
  delete legacy.selfGoodUseOption.toy
  delete legacy.gameSaveDatas.travel_china
  legacy.illustrated = null
  const bundle = migrateLegacySaveDataToPortableBundle(legacy, MIGRATION)
  const runtime = createHeadlessRuntime(bundle.engine)
  const buy = runtime.execute({ type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } }, context(runtime.snapshot()))
  const work = runtime.execute({ type: 'job.startWork', payload: { jobId: 'bz' } }, context(runtime.snapshot()))
  const tick = runtime.tick(context(runtime.snapshot()))
  const travelState = clone(bundle.engine)
  travelState.save.gameSaveDatas.travel_china = TRAVEL_PROVINCES.map(province => ({ name: province.name, value: 1 }))
  const collected = createHeadlessRuntime(travelState).execute({ type: 'travel.completeCollection', payload: {} }, context(runtime.snapshot()))
  console.log('F5 normalized import: validate=' + validateEngineState(bundle.engine),
    'buy=' + buy.ok, 'work=' + (work.ok ? 'ok' : work.error.code + ':' + work.error.message),
    'tick=' + tick.ok, 'travel=' + (collected.ok ? 'ok' : collected.error.code))
}

// ---- F6：迁移在途活动后 job 继续并在到期结算一次 -------------------------
{
  const legacy = clone(fixtures.shared)
  Object.assign(legacy.petInfo, { growth: 5000, health: 5 })
  legacy.activeOption = { work: 'bz', study: null, trip: null, ill: null, die: null }
  legacy.saveJsonData.activity = '10'
  const bundle = migrateLegacySaveDataToPortableBundle(legacy, MIGRATION)
  const job = bundle.engine.scheduledJobs[0]
  const runtime = createHeadlessRuntime(bundle.engine)
  const before = runtime.snapshot()
  runtime.advance(context(before), 1)
  console.log('F6 migrated work job: type=' + job.type, 'dueInMin=' + Math.round((job.dueAtGameMs - before.gameTimeMs) / 60000),
    'pendingAfter1=' + runtime.snapshot().scheduledJobs.filter(item => item.status === 'pending').length)
  const remaining = Math.ceil((job.dueAtGameMs - runtime.snapshot().gameTimeMs) / 60000)
  const settled = runtime.advance(context(runtime.snapshot()), remaining)
  const after = runtime.snapshot()
  console.log('F6 settle: ok=' + settled.ok, 'work=' + String(after.save.activeOption.work),
    'workCounter=' + (JSON.parse(after.save.saveJsonData.task).doNums?.Work ?? 0),
    'completedJobs=' + after.scheduledJobs.filter(item => item.status === 'completed').length)
}
