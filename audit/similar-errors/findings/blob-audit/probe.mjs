// Static-audit probe: canonical save readers -> fallback -> command dependency.
// Reads the real imported bundle fixture and derives empty/partial shapes only in memory.
// Run from the repo root:
//   node --experimental-strip-types audit/similar-errors/findings/blob-audit/probe.mjs
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

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

const ROOT = new URL('../../../../', import.meta.url)
const importTs = (path) => import(new URL(path, ROOT).href)

const { executeCommand } = await importTs('src/shared/pet-runtime/runtime.ts')
const { advanceMinute } = await importTs('src/shared/pet-runtime/runtime.ts')
const { createRngState } = await importTs('src/shared/pet-runtime/rng.ts')
const { dayKeyAt, nextDailyBoundaryMs } = await importTs('src/shared/pet-runtime/time.ts')
const { validateEngineState } = await importTs('src/shared/sync/portable.ts')
const { resetFishLimits } = await importTs('src/shared/pet-runtime/handlers-b.ts')

const shared = JSON.parse(readFileSync(new URL('../../fixtures/imported-shared.json', import.meta.url), 'utf8'))
const TIME_ZONE = 'Asia/Shanghai'
const GAME_TIME_MS = Date.UTC(2026, 10, 18, 4, 0, 0) // 2026-11-18 12:00 +08
const clone = (value) => JSON.parse(JSON.stringify(value))

function makeEngine(save) {
  return {
    schemaVersion: 1,
    save,
    gameTimeMs: GAME_TIME_MS,
    lastSchedulerWallMs: GAME_TIME_MS,
    timeZone: TIME_ZONE,
    weatherLocation: 'Shanghai',
    advanceWhileEmpty: true,
    rng: createRngState('000102030405060708090a0b0c0d0e0f'),
    scheduledJobs: [],
    nextScheduledJobId: 1,
    gameSessions: [],
    sessionCoverage: [],
    lastProcessedDayBoundaryKey: dayKeyAt(GAME_TIME_MS, TIME_ZONE),
    nextDailyBoundaryMs: nextDailyBoundaryMs(GAME_TIME_MS, TIME_ZONE),
    importClamped: false,
    clockSkippedMs: 0,
    environment: { calendarByDay: {}, weatherByDay: {} },
  }
}

const ctx = (gameTimeMs = GAME_TIME_MS) => ({
  gameTimeMs,
  environment: { calendarByDay: {}, weatherByDay: {} },
  activeClientCount: 1,
  sessionActive: true,
  actorDeviceId: 'audit-device-0001',
  actorRole: 'owner',
})

function run(label, save, command, options = {}) {
  const engine = makeEngine(clone(save))
  const valid = validateEngineState(engine)
  let outcome
  if (options.tick === true) outcome = advanceMinute(engine, ctx())
  else outcome = executeCommand(engine, command, ctx())
  const status = outcome.ok
    ? 'OK ' + JSON.stringify(outcome.result ?? null)
    : 'REJECT ' + outcome.error.code + ' :: ' + outcome.error.message
  console.log([label, 'validEngine=' + valid, status].join(' | '))
  return outcome
}

function line(text) {
  console.log('\n== ' + text + ' ==')
}

line('fixture sanity')
console.log('saveJsonData keys:', Object.keys(shared.saveJsonData).sort().join(','))
console.log('task blob:', shared.saveJsonData.task, '| email:', shared.saveJsonData.email, '| island:', shared.saveJsonData.island)

line('real imported save (task/signin/email/farm/fishs/island as imported)')
run('task.claim daily#0', shared, { type: 'task.claim', payload: { tab: 'daily', index: 0 } })
run('task.claim ddw#0 (counter 0)', shared, { type: 'task.claim', payload: { tab: 'ddw', index: 0 } })
run('task.claim travel#2 Travel2 (counter 0)', shared, { type: 'task.claim', payload: { tab: 'travel', index: 2 } })
run('mail.claimAll', shared, { type: 'mail.claimAll', payload: {} })
run('mail.claim id 0', shared, { type: 'mail.claim', payload: { mailId: '0' } })
run('signin.claimOnlineGift', shared, { type: 'signin.claimOnlineGift', payload: {} })
run('signin.claimBirthdayGift', shared, { type: 'signin.claimBirthdayGift', payload: {} })
run('signin.sign', shared, { type: 'signin.sign', payload: {} })
run('fishing.speedUp (non-VIP)', shared, { type: 'fishing.speedUp', payload: {} })
run('fishing.buy fry 2', shared, { type: 'fishing.buy', payload: { fryId: 2, quantity: 1 } })
run('farm.plant plot0 without seed', shared, { type: 'farm.plant', payload: { seedId: 'RadishSeed', plotIds: [0] } })
run('farm.buySeed RadishSeed x1', shared, { type: 'farm.buySeed', payload: { seedId: 'RadishSeed', quantity: 1 } })
run('island.arriveScene place 3', shared, { type: 'island.arriveScene', payload: { sceneId: '3' } })
run('island.turnInErrand unknown', shared, { type: 'island.turnInErrand', payload: { npcId: 'npc-not-there', errandId: '0' } })
run('travel.completeCollection', shared, { type: 'travel.completeCollection', payload: {} })

line('same save with signin blob = "{}" (post-import no sign-in history)')
const signinEmpty = clone(shared)
signinEmpty.saveJsonData.signin = '{}'
run('signin.claimBirthdayGift', signinEmpty, { type: 'signin.claimBirthdayGift', payload: {} })
run('signin.claimOnlineGift', signinEmpty, { type: 'signin.claimOnlineGift', payload: {} })

line('VIP with empty pond blob: speed-up counter only comes from reset/buy')
const vip = clone(shared)
vip.petInfo.pinkDiamond = true
vip.petInfo.PDiamondLevel = 3
vip.saveJsonData.fishs = '{}'
run('fishing.speedUp vip empty pond', vip, { type: 'fishing.speedUp', payload: {} })
const vipEngine = makeEngine(clone(vip))
resetFishLimits(vipEngine.save)
console.log('after resetFishLimits pond:', vipEngine.save.saveJsonData.fishs)
run('fishing.speedUp vip after reset (still no fish)', vipEngine.save, { type: 'fishing.speedUp', payload: {} })

line('S3 shapes: import-validated save with empty non-blob groups')
const noGameSave = clone(shared)
noGameSave.gameSaveDatas = {}
run('pokeFace (gameSaveDatas.ddw missing)', noGameSave, { type: 'pet.pokeFace', payload: { spotId: '1' } })
run('task.claim travel#2 (travel_china missing)', noGameSave, { type: 'task.claim', payload: { tab: 'travel', index: 2 } })
run('travel.completeCollection (travel_china missing)', noGameSave, { type: 'travel.completeCollection', payload: {} })

const noToy = clone(shared)
delete noToy.selfGoodDatas.toy
run('inventory.use toy t0002 (toy group missing)', noToy, { type: 'inventory.use', payload: { type: 'toy', itemId: 't0002', quantity: 1 } })

const noFood = clone(shared)
delete noFood.selfGoodDatas.food
run('inventory.buy food 102010001 (food group missing)', noFood, { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } })
run('inventory.buy food 102010001 (food group present)', shared, { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } })

const noNums = clone(shared)
delete noNums.selfGoodDatas.nums
run('signin.claimOnlineGift (nums group missing)', noNums, { type: 'signin.claimOnlineGift', payload: {} })

const noIllustratedType = clone(shared)
noIllustratedType.illustrated = null
run('inventory.buy food 102010001 (illustrated=null)', noIllustratedType, { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } })

const emptyStudy = clone(shared)
emptyStudy.studyInfo = {}
run('job.startStudy xx-chinese (studyInfo {})', emptyStudy, { type: 'job.startStudy', payload: { courseId: 'xx-chinese' } })
const studyReady = clone(shared)
studyReady.studyInfo.chinese = 1
run('job.startStudy xx-chinese (studyInfo.chinese=1, below classNum)', studyReady, { type: 'job.startStudy', payload: { courseId: 'xx-chinese' } })
run('exam.start xx-chinese (studyInfo {})', emptyStudy, { type: 'exam.start', payload: { subject: 'xx-chinese' } })

const missingTrip = clone(shared)
missingTrip.activeOption = { work: null, study: null, ill: null, die: null }
run('job.startWork bz (activeOption.trip missing)', missingTrip, { type: 'job.startWork', payload: { jobId: 'bz' } })
run('activity.stop (activeOption.trip missing)', missingTrip, { type: 'activity.stop', payload: {} })

const emptyTimed = clone(shared)
emptyTimed.selfGoodUseOption = {}
run('advanceMinute (selfGoodUseOption {})', emptyTimed, { type: 'tick' }, { tick: true })
const nullTimed = clone(shared)
nullTimed.selfGoodUseOption = { background: null, food: null, clean: null }
run('advanceMinute (selfGoodUseOption missing toy)', nullTimed, { type: 'tick' }, { tick: true })

const emptyComputed = clone(shared)
emptyComputed.petComputedlInfo = {}
run('pokeFace (petComputedlInfo {})', emptyComputed, { type: 'pet.pokeFace', payload: { spotId: '1' } })

line('control: daily tab after a real 06:00 reset')
const { resetDailyTasks } = await importTs('src/shared/pet-runtime/runtime-tasks.ts')
const { createRuntimeRng } = await importTs('src/shared/pet-runtime/runtime-helpers.ts')
const resetEngine = makeEngine(clone(shared))
const resetOut = resetDailyTasks(resetEngine.save, GAME_TIME_MS, TIME_ZONE, createRuntimeRng(resetEngine.rng))
console.log('rolled daily:', resetOut.daily.map(task => task.obj).join(','))
run('task.claim daily#0 after reset', resetEngine.save, { type: 'task.claim', payload: { tab: 'daily', index: 0 } })

line('daily definitions present but taskList.daily entry missing')
const partialDaily = clone(shared)
partialDaily.saveJsonData.task = JSON.stringify({
  doNums: {},
  taskList: { daily: [], ddw: [], growth: [], travel: [] },
  daily: [{ label: 'eat 1', msg: 'eat', obj: 'Eat', num: 1 }],
  dailyDay: 0,
})
run('task.claim daily#0 (definition only)', partialDaily, { type: 'task.claim', payload: { tab: 'daily', index: 0 } })

line('control: fixed static-tab path (poke 5x then claim ddw#0)')
let pokeEngine = makeEngine(clone(shared))
for (let index = 0; index < 5; index++) {
  const outcome = executeCommand(pokeEngine, { type: 'pet.pokeFace', payload: { spotId: '1' } }, ctx())
  if (outcome.ok) pokeEngine = outcome.state
}
run('task.claim ddw#0 after 5 pokes', pokeEngine.save, { type: 'task.claim', payload: { tab: 'ddw', index: 0 } })

line('island lazy materialization from an empty blob')
let islandEngine = makeEngine(clone(shared))
const islandOutcome = executeCommand(islandEngine, { type: 'island.arriveScene', payload: { sceneId: '3' } }, ctx())
if (islandOutcome.ok) islandEngine = islandOutcome.state
const islandBlob = JSON.parse(islandEngine.save.saveJsonData.island)
console.log('materialized island: day=' + islandBlob.day + ' want=' + JSON.stringify(islandBlob.want) + ' errands=' + islandBlob.errands.length)
run('island.giftNpc 小艾 (materialized want)', islandEngine.save, { type: 'island.giftNpc', payload: { npcId: '小艾', itemId: islandBlob.want } })

line('VIP speed-up works only after the reset counter exists')
let vipFishEngine = makeEngine(clone(vip))
resetFishLimits(vipFishEngine.save)
const buyOutcome = executeCommand(vipFishEngine, { type: 'fishing.buy', payload: { fryId: 2, quantity: 1 } }, ctx())
if (buyOutcome.ok) vipFishEngine = buyOutcome.state
run('fishing.speedUp vip after reset + 1 fish', vipFishEngine.save, { type: 'fishing.speedUp', payload: {} })

line('S3 source: legacy migration normalizes petInfo.diamond only')
const { migrateLegacySaveDataToPortableBundle } = await importTs('src/shared/sync/portable.ts')
const { startSave } = await importTs('src/shared/save-logic.ts')
const legacy = startSave(null)
legacy.havePet = true
legacy.saveJsonData = {} // original config.json carried no blobs at all
delete legacy.petInfo.diamond
delete legacy.studyInfo.wushu
delete legacy.selfGoodDatas.toy
delete legacy.gameSaveDatas.travel_china
const bundle = migrateLegacySaveDataToPortableBundle(legacy, {
  nowMs: GAME_TIME_MS,
  seedHex: '000102030405060708090a0b0c0d0e0f',
  authority: {
    owner: 'local', authorityId: 'audit-authority', epoch: 1, restoreGeneration: 1,
    revision: 0, eventSeq: 0, handoffId: 'audit-handoff', detachedAtWallMs: 0,
  },
  localDeviceId: 'audit-device-0001',
  timeZone: TIME_ZONE,
})
const canonical = bundle.engine.save
console.log('bundle canonical studyInfo keys:', Object.keys(canonical.studyInfo).join(','))
console.log('bundle canonical selfGoodDatas keys:', Object.keys(canonical.selfGoodDatas).join(','))
console.log('bundle canonical gameSaveDatas:', JSON.stringify(canonical.gameSaveDatas))
console.log('bundle canonical saveJsonData:', JSON.stringify(canonical.saveJsonData))
console.log('bundle petInfo.diamond backfilled:', canonical.petInfo.diamond)
console.log('bundle engine validates:', validateEngineState(bundle.engine))
const repairedLegacy = startSave(JSON.parse(JSON.stringify(legacy)))
console.log('startSave(raw) repair result studyInfo.wushu:', repairedLegacy.studyInfo.wushu,
  '| toy:', JSON.stringify(repairedLegacy.selfGoodDatas.toy),
  '| travel_china:', JSON.stringify(repairedLegacy.gameSaveDatas.travel_china))

line('commands on the real migrated bundle (no further normalization)')
run('task.claim daily#0', canonical, { type: 'task.claim', payload: { tab: 'daily', index: 0 } })
run('job.startStudy xx-wushu (wushu key dropped)', canonical, { type: 'job.startStudy', payload: { courseId: 'xx-wushu' } })
run('inventory.use toy t0002 (toy group dropped)', canonical, { type: 'inventory.use', payload: { type: 'toy', itemId: 't0002', quantity: 1 } })
run('task.claim travel#2 (travel_china dropped)', canonical, { type: 'task.claim', payload: { tab: 'travel', index: 2 } })
run('travel.completeCollection (travel_china dropped)', canonical, { type: 'travel.completeCollection', payload: {} })
run('signin.claimOnlineGift (signin blob missing)', canonical, { type: 'signin.claimOnlineGift', payload: {} })

line('S3 source: legacy in-progress activity has no scheduled job after migration')
const legacyBusy = startSave(null)
legacyBusy.havePet = true
legacyBusy.saveJsonData = { activity: '30', email: '{}', task: '{}', signin: '{}', fishs: '{}' }
legacyBusy.activeOption = { work: 'bz', study: null, trip: null, ill: null, die: null }
const busyBundle = migrateLegacySaveDataToPortableBundle(legacyBusy, {
  nowMs: GAME_TIME_MS,
  seedHex: '000102030405060708090a0b0c0d0e0f',
  authority: {
    owner: 'local', authorityId: 'audit-authority', epoch: 1, restoreGeneration: 1,
    revision: 0, eventSeq: 0, handoffId: 'audit-handoff', detachedAtWallMs: 0,
  },
  localDeviceId: 'audit-device-0001',
  timeZone: TIME_ZONE,
})
console.log('migrated activeOption.work:', JSON.stringify(busyBundle.engine.save.activeOption.work),
  '| scheduledJobs:', busyBundle.engine.scheduledJobs.length,
  '| activity blob:', JSON.stringify(busyBundle.engine.save.saveJsonData.activity))
const busyTick = advanceMinute(busyBundle.engine, ctx())
if (busyTick.ok) {
  console.log('after one tick -> activeOption.work:', JSON.stringify(busyTick.state.save.activeOption.work),
    '| activity blob:', JSON.stringify(busyTick.state.save.saveJsonData.activity),
    '| task counts:', JSON.stringify(JSON.parse(busyTick.state.save.saveJsonData.task).doNums ?? {}),
    '| events:', busyTick.events.map(e => e.type).join(','))
} else {
  console.log('after one tick -> REJECT', busyTick.error.code, busyTick.error.message)
}

line('petComputedlInfo {} : which first command survives')
run('job.startWork bz (petComputedlInfo {})', emptyComputed, { type: 'job.startWork', payload: { jobId: 'bz' } })
run('game.startSession (petComputedlInfo {})', emptyComputed, { type: 'game.startSession', payload: { gameId: 'g1', kind: 'small' } })
run('pet.cheer (petComputedlInfo {})', emptyComputed, { type: 'pet.cheer', payload: {} })
const healed = makeEngine(clone(emptyComputed))
const healedOut = executeCommand(healed, { type: 'job.startWork', payload: { jobId: 'bz' } }, ctx())
console.log('healed computed after startWork:', JSON.stringify(healedOut.ok ? healedOut.state.save.petComputedlInfo : null))
run('pet.pokeFace after a successful startWork', healedOut.ok ? healedOut.state.save : emptyComputed, { type: 'pet.pokeFace', payload: { spotId: '1' } })
