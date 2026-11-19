import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const {
  createHeadlessRuntime,
  levelAndCapsOf,
} = await import('../../src/shared/pet-runtime/index.ts')
const { migrateLegacySaveDataToPortableBundle, validateEngineState } = await import('../../src/shared/sync/portable.ts')
const { STUDY_GOODS, WORK_GOODS } = await import('../../src/shared/pet-runtime/content/index.ts')
const {
  GAME_TIME_MS,
  LOCAL_DEVICE_ID,
  SEED,
  createSyncFixtures,
} = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()
const MINUTE = 60_000

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

const MIGRATION_OPTIONS = {
  nowMs: GAME_TIME_MS,
  seedHex: SEED,
  authority: fixtures.authority,
  localDeviceId: LOCAL_DEVICE_ID,
  timeZone: 'Asia/Shanghai',
  advanceWhileEmpty: true,
  weatherLocation: 'Shanghai',
}

function legacyWith(activeOption, activity) {
  const legacy = clone(fixtures.save)
  Object.assign(legacy.petInfo, { growth: 5000, health: 5, hunger: 1100, clean: 1100, mood: 1000, yb: 5000 })
  legacy.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  legacy.activeOption = { work: null, study: null, trip: null, ill: null, die: null, ...activeOption }
  legacy.saveJsonData = { ...legacy.saveJsonData, activity }
  return legacy
}

function migrate(activeOption, activity) {
  return migrateLegacySaveDataToPortableBundle(legacyWith(activeOption, activity), MIGRATION_OPTIONS)
}

function runtimeContext(state) {
  return {
    gameTimeMs: state.gameTimeMs,
    environment: state.environment,
    activeClientCount: 0,
    sessionActive: false,
    actorDeviceId: LOCAL_DEVICE_ID,
    actorRole: 'player',
  }
}

function taskCounts(state) {
  return JSON.parse(state.save.saveJsonData.task).doNums ?? {}
}

const WORK = WORK_GOODS.find(good => good.id === 'bz')
const STUDY = STUDY_GOODS.find(good => good.id === 'xx-chinese')
assert.ok(WORK !== undefined && STUDY !== undefined)

test('legacy migration rebuilds one pending work job from activeOption and activity', () => {
  const bundle = migrate({ work: 'bz' }, '10')
  assert.equal(validateEngineState(bundle.engine), true)
  assert.equal(bundle.engine.scheduledJobs.length, 1)
  const job = bundle.engine.scheduledJobs[0]
  assert.deepEqual(job, {
    id: 1,
    type: 'work',
    dueAtGameMs: GAME_TIME_MS + (WORK.useTime - 10) * MINUTE,
    payload: {
      activityKind: 'work',
      activityId: 'bz',
      startedAtGameMs: GAME_TIME_MS - 10 * MINUTE,
    },
    status: 'pending',
  })
  assert.equal(bundle.engine.nextScheduledJobId, 2)
  assert.equal(bundle.shared.activeOption.work, 'bz')
})

test('legacy migration rebuilds study and travel jobs with their canonical durations', () => {
  const study = migrate({ study: 'xx-chinese' }, '5')
  assert.equal(study.engine.scheduledJobs.length, 1)
  assert.deepEqual(study.engine.scheduledJobs[0].payload, {
    activityKind: 'study',
    activityId: 'xx-chinese',
    startedAtGameMs: GAME_TIME_MS - 5 * MINUTE,
  })
  assert.equal(study.engine.scheduledJobs[0].type, 'study')
  assert.equal(study.engine.scheduledJobs[0].dueAtGameMs, GAME_TIME_MS + (STUDY.useTime - 5) * MINUTE)

  const travel = migrate({ trip: '北京市' }, '15')
  assert.equal(travel.engine.scheduledJobs.length, 1)
  assert.equal(travel.engine.scheduledJobs[0].type, 'travel')
  assert.deepEqual(travel.engine.scheduledJobs[0].payload, {
    activityKind: 'travel',
    activityId: '北京市',
    startedAtGameMs: GAME_TIME_MS - 15 * MINUTE,
  })
  assert.equal(travel.engine.scheduledJobs[0].dueAtGameMs, GAME_TIME_MS + (60 - 15) * MINUTE)
})

test('a migrated work job stays pending before due and settles once when due', () => {
  const bundle = migrate({ work: 'bz' }, '0')
  const runtime = createHeadlessRuntime(bundle.engine)
  const ybBefore = runtime.snapshot().save.petInfo.yb
  const strongBefore = runtime.snapshot().save.petInfo.strong

  const early = runtime.advance(runtimeContext(runtime.snapshot()), WORK.useTime - 1)
  assert.equal(early.ok, true, early.ok ? '' : early.error.code + ': ' + early.error.message)
  assert.equal(early.state.scheduledJobs[0].status, 'pending')
  assert.equal(early.state.save.activeOption.work, 'bz')
  assert.equal(Number(early.state.save.saveJsonData.activity), WORK.useTime - 1)

  const settled = runtime.advance(runtimeContext(runtime.snapshot()), 1)
  assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code + ': ' + settled.error.message)
  assert.equal(settled.state.scheduledJobs[0].status, 'completed')
  assert.equal(settled.state.save.activeOption.work, null)
  assert.equal(settled.state.save.saveJsonData.activity, '0')
  assert.equal(taskCounts(settled.state).Work, 1)
  assert.equal(settled.state.save.petInfo.yb, ybBefore + WORK.yb)
  assert.equal(settled.state.save.petInfo.strong, strongBefore + WORK.strong)
  assert.equal(
    settled.events.filter(event => event.type === 'reward.granted' && event.payload.source === 'work').length,
    1,
  )

  const again = runtime.advance(runtimeContext(runtime.snapshot()), 5)
  assert.equal(again.ok, true, again.ok ? '' : again.error.code + ': ' + again.error.message)
  assert.equal(taskCounts(again.state).Work, 1)
  assert.equal(again.state.save.petInfo.yb, ybBefore + WORK.yb)
  assert.equal(again.state.scheduledJobs[0].status, 'completed')
  assert.equal(
    again.events.filter(event => event.type === 'reward.granted' && event.payload.source === 'work').length,
    0,
  )
})

test('a migrated study job adds the lesson and study count exactly once', () => {
  const bundle = migrate({ study: 'xx-chinese' }, '0')
  const runtime = createHeadlessRuntime(bundle.engine)
  const intelBefore = runtime.snapshot().save.petInfo.intel

  const early = runtime.advance(runtimeContext(runtime.snapshot()), STUDY.useTime - 1)
  assert.equal(early.ok, true, early.ok ? '' : early.error.code + ': ' + early.error.message)
  assert.equal(early.state.scheduledJobs[0].status, 'pending')
  assert.equal(early.state.save.activeOption.study, 'xx-chinese')

  const settled = runtime.advance(runtimeContext(runtime.snapshot()), 1)
  assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code + ': ' + settled.error.message)
  assert.equal(settled.state.scheduledJobs[0].status, 'completed')
  assert.equal(settled.state.save.activeOption.study, null)
  assert.equal(settled.state.save.studyInfo.chinese, 1)
  assert.equal(taskCounts(settled.state).Study, 1)
  assert.equal(settled.state.save.petInfo.intel, intelBefore + STUDY.intel)

  const again = runtime.advance(runtimeContext(runtime.snapshot()), 5)
  assert.equal(again.ok, true, again.ok ? '' : again.error.code + ': ' + again.error.message)
  assert.equal(settled.state.save.studyInfo.chinese, 1)
  assert.equal(taskCounts(again.state).Study, 1)
})

test('a migrated travel job arrives once at its destination', () => {
  const bundle = migrate({ trip: '北京市' }, '0')
  const runtime = createHeadlessRuntime(bundle.engine)

  const early = runtime.advance(runtimeContext(runtime.snapshot()), 50)
  assert.equal(early.ok, true, early.ok ? '' : early.error.code + ': ' + early.error.message)
  assert.equal(early.state.scheduledJobs[0].status, 'pending')
  assert.equal(early.state.save.activeOption.trip, '北京市')

  const settled = runtime.advance(runtimeContext(runtime.snapshot()), 10)
  assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code + ': ' + settled.error.message)
  assert.equal(settled.state.scheduledJobs[0].status, 'completed')
  assert.equal(settled.state.save.activeOption.trip, null)
  assert.equal(settled.state.save.gameSaveDatas.travel_china.length, 1)
  assert.equal(settled.state.save.gameSaveDatas.travel_china[0].name, '北京市')
  assert.equal(taskCounts(settled.state).Travel1, 1)

  const again = runtime.advance(runtimeContext(runtime.snapshot()), 5)
  assert.equal(again.ok, true, again.ok ? '' : again.error.code + ': ' + again.error.message)
  assert.equal(again.state.save.gameSaveDatas.travel_china.length, 1)
  assert.equal(taskCounts(again.state).Travel1, 1)
})

test('an already finished legacy activity is due immediately and rewards exactly once', () => {
  const bundle = migrate({ work: 'bz' }, '30')
  assert.equal(bundle.engine.scheduledJobs[0].dueAtGameMs, GAME_TIME_MS)
  assert.equal(bundle.engine.scheduledJobs[0].payload.startedAtGameMs, GAME_TIME_MS - 30 * MINUTE)

  const runtime = createHeadlessRuntime(bundle.engine)
  const ybBefore = runtime.snapshot().save.petInfo.yb
  const first = runtime.tick(runtimeContext(runtime.snapshot()))
  assert.equal(first.ok, true, first.ok ? '' : first.error.code + ': ' + first.error.message)
  assert.equal(first.state.scheduledJobs[0].status, 'completed')
  assert.equal(taskCounts(first.state).Work, 1)
  assert.equal(first.state.save.petInfo.yb, ybBefore + WORK.yb)

  const second = runtime.tick(runtimeContext(runtime.snapshot()))
  assert.equal(second.ok, true, second.ok ? '' : second.error.code + ': ' + second.error.message)
  assert.equal(taskCounts(second.state).Work, 1)
  assert.equal(second.state.save.petInfo.yb, ybBefore + WORK.yb)

  // Overshooting the recorded minutes clamps the deadline to the migration instant.
  const overshoot = migrate({ work: 'bz' }, '999')
  assert.equal(overshoot.engine.scheduledJobs[0].dueAtGameMs, GAME_TIME_MS)
  assert.equal(overshoot.engine.scheduledJobs[0].payload.startedAtGameMs, GAME_TIME_MS - WORK.useTime * MINUTE)
})

test('an idle or unknown legacy activity does not invent a job', () => {
  const idle = migrate({}, '0')
  assert.deepEqual(idle.engine.scheduledJobs, [])
  assert.equal(idle.engine.nextScheduledJobId, 1)
  assert.equal(validateEngineState(idle.engine), true)

  const legacy = legacyWith({ work: 'unknown-job' }, '10')
  const unknown = migrateLegacySaveDataToPortableBundle(legacy, MIGRATION_OPTIONS)
  assert.deepEqual(unknown.engine.scheduledJobs, [])
  assert.equal(unknown.engine.nextScheduledJobId, 1)
  assert.equal(unknown.shared.activeOption.work, 'unknown-job')
  assert.equal(validateEngineState(unknown.engine), true)
})
