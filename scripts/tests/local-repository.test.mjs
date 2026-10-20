import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts')
    }
    return nextResolve(specifier)
  },
})

const { LocalRepository, createLocalRepository, localRepositoryEnabled, localRepositoryCapability, startLocalRepositoryIfEnabled, registerLocalRepositoryLifecycle } = await import('../../src/main/local-repository.ts')
const { validateLocalPetDocumentV2 } = await import('../../src/shared/sync/portable.ts')
const { createSyncFixtures, SEED, WALL_TIME_MS, LOCAL_DEVICE_ID } = await import('./sync-fixtures.mjs')
const { validateOpIdCache } = await import('../../src/shared/pet-runtime/idempotency.ts')
const fixtures = createSyncFixtures()

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'qqpet-local-repo-'))
}
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2))
}
const ACTIVATION_ENV = { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }
const ACTIVATION = { authorityState: 'local-v2-active', rendererCapability: true, env: ACTIVATION_ENV }
function makeRepo(options) {
  return createLocalRepository(options, ACTIVATION)
}
function repoOptions(dir, nowRef, overrides = {}) {
  let id = 0
  return {
    documentPath: join(dir, 'save.json'),
    legacySavePath: join(dir, 'legacy.json'),
    nowMs: () => nowRef.value,
    randomUUID: () => 'uuid-' + String(++id).padStart(4, '0'),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    pollIntervalMs: 1000000,
    autoScheduler: false,
    ...overrides,
  }
}

test('local repository migrates bare save to atomic v2 document and supports idempotent commands', async () => {
  const dir = tempDir()
  const legacy = join(dir, 'legacy.json')
  writeJson(legacy, fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  const projection = await repo.load()
  assert.ok(projection)
  assert.equal(repo.getStatus().mode, 'local')
  assert.equal(repo.getStatus().offline, true)
  assert.equal(repo.getStatus().role, 'owner')
  assert.ok(existsSync(join(dir, 'save.json')))
  assert.ok(existsSync(legacy + '.bak'))
  assert.equal(repo.currentDeviceId, repo.getDocument().device.localDeviceId)
  assert.equal(validateLocalPetDocumentV2(repo.getDocument()), true)
  assert.doesNotThrow(() => validateOpIdCache(repo.getDocument().idempotency))
  const before = repo.getDocument().bundle.engine.save.petInfo.yb
  const first = await repo.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 25 } }, 'op-local-1', 'owner')
  assert.equal(first.outcome.ok, true)
  assert.equal(first.duplicate, false)
  assert.ok(first.projection.shared.petInfo.yb >= before + 25)
  assert.ok(repo.getRecentEvents().length > 0)
  const revision = repo.getDocument().revision
  const retry = await repo.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 25 } }, 'op-local-1', 'owner')
  assert.equal(retry.duplicate, true)
  assert.equal(repo.getDocument().revision, revision)
  assert.equal(existsSync(join(dir, 'save.json.tmp')), false)
  const saved = JSON.parse(readFileSync(join(dir, 'save.json'), 'utf8'))
  assert.equal(saved.format, 'qqpet-local-v2')
  assert.ok(saved.idempotency.records.some(record => record.opId === 'op-local-1'))
  await repo.setLocalSettings({ zoom: 1.25 })
  assert.equal(repo.getProjection().device.settings.zoom, 1.25)
  repo.setRole('player')
  assert.equal(repo.getStatus().role, 'player')
  await repo.stop()
  assert.equal(repo.getStatus().state, 'stopped')
})

test('scheduler catch-up honors advanceWhileEmpty true and false across restart', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const trueRepo = makeRepo(repoOptions(dir, clock, { advanceWhileEmpty: true, maxChunkTicks: 1440 }))
  const start = await trueRepo.load()
  const gameStart = start.gameTimeMs
  clock.value += 2 * 60000
  await trueRepo.pump()
  assert.equal(trueRepo.getProjection().gameTimeMs, gameStart + 2 * 60000)
  assert.equal(trueRepo.getStatus().state, 'ready')
  await trueRepo.stop()
  assert.equal(existsSync(join(dir, 'save.json.tmp')), false)

  const falseDir = tempDir()
  writeJson(join(falseDir, 'legacy.json'), fixtures.save)
  const falseClock = { value: WALL_TIME_MS }
  const falseRepo = makeRepo(repoOptions(falseDir, falseClock, { advanceWhileEmpty: false, maxChunkTicks: 1440 }))
  const falseStart = await falseRepo.load()
  const falseGame = falseStart.gameTimeMs
  await falseRepo.stop()
  falseClock.value += 2 * 60000
  const restarted = makeRepo(repoOptions(falseDir, falseClock, { advanceWhileEmpty: false, maxChunkTicks: 1440 }))
  const resumed = await restarted.load()
  assert.ok(resumed)
  assert.equal(restarted.getProjection().gameTimeMs, falseGame)
  assert.equal(restarted.getProjection().advanceWhileEmpty, false)
  await restarted.stop()
})

test('reset and portable import close active coverage and reopen exact local survivor intervals', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const before = repo.getDocument().bundle.engine.sessionCoverage
  assert.equal(before.length, 1)
  const reset = await repo.reset('op-reset')
  assert.equal(reset.outcome.ok, true)
  let coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.equal(coverage.length, 2)
  assert.equal(coverage[0].disconnectedAtWallMs, WALL_TIME_MS)
  assert.equal(coverage[0].closeReason, 'pet_reset')
  assert.equal(coverage[1].connectedAtWallMs, WALL_TIME_MS)
  assert.equal(coverage[1].disconnectedAtWallMs, undefined)
  assert.equal(repo.lastReopen.survivors[0].kind, 'local_app')
  assert.equal(repo.lastReopen.survivors[0].activeEndWallMs, WALL_TIME_MS)

  const bundle = repo.exportPortableBundle()
  clock.value += 1000
  await repo.importPortableBundle(bundle, 'op-import')
  coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.ok(coverage.length >= 3)
  const last = coverage[coverage.length - 1]
  assert.equal(last.connectedAtWallMs, WALL_TIME_MS + 1000)
  assert.equal(repo.lastReopen.survivors[0].activeEndProvenance, 'import_replaced')
  await repo.stop()
})

test('legacy duplicate localDeviceId migrates on match and fails read-only without overwriting on mismatch', async () => {
  const matchDir = tempDir()
  const matched = JSON.parse(JSON.stringify(fixtures.localDocument))
  matched.runtime.localDeviceId = matched.device.localDeviceId
  const matchPath = join(matchDir, 'save.json')
  writeJson(matchPath, matched)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(matchDir, clock))
  assert.ok(await repo.load())
  assert.equal(repo.currentDeviceId, matched.device.localDeviceId)
  assert.equal(repo.getDocument().runtime.localDeviceId, undefined)
  assert.ok(existsSync(matchPath + '.bak'))

  const badDir = tempDir()
  const bad = JSON.parse(JSON.stringify(fixtures.localDocument))
  bad.runtime.localDeviceId = 'device-that-does-not-match'
  const badPath = join(badDir, 'save.json')
  writeJson(badPath, bad)
  const original = readFileSync(badPath, 'utf8')
  const badRepo = makeRepo(repoOptions(badDir, clock))
  assert.equal(await badRepo.load(), null)
  assert.equal(badRepo.getStatus().state, 'read_only')
  assert.match(badRepo.getStatus().error, /localDeviceId/)
  assert.equal(readFileSync(badPath, 'utf8'), original)
})

test('crash restart repairs coverage and replays the persisted opId without reapplication', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const first = makeRepo(repoOptions(dir, clock))
  await first.load()
  const yb = first.getProjection().shared.petInfo.yb
  await first.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 7 } }, 'op-crash', 'owner')
  const ybAfter = first.getProjection().shared.petInfo.yb
  clock.value += 120000
  const second = makeRepo(repoOptions(dir, clock))
  assert.ok(await second.load())
  assert.equal(second.getProjection().shared.petInfo.yb, ybAfter)
  const cov = second.getDocument().bundle.engine.sessionCoverage
  assert.ok(cov.length >= 2)
  assert.equal(cov[0].closeReason, 'crash_repaired')
  assert.ok(cov[0].disconnectedAtWallMs <= clock.value)
  assert.equal(cov[cov.length - 1].disconnectedAtWallMs, undefined)
  const replay = await second.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 7 } }, 'op-crash', 'owner')
  assert.equal(replay.duplicate, true)
  assert.equal(second.getProjection().shared.petInfo.yb, ybAfter)
  await second.stop()
  assert.ok(ybAfter >= yb + 7)
})

test('default legacy path stays untouched unless the explicit local repository flag is set', async () => {
  assert.equal(localRepositoryEnabled({}), false)
  assert.equal(localRepositoryEnabled({ QQPET_LOCAL_REPOSITORY_V2: '0' }), false)
  const dir = tempDir()
  const options = repoOptions(dir, { value: WALL_TIME_MS })
  assert.equal(startLocalRepositoryIfEnabled(options, {}), null)
  assert.equal(existsSync(join(dir, 'save.json')), false)
  assert.equal(localRepositoryCapability({}, false).canActivate, false)
  assert.equal(localRepositoryCapability({ QQPET_LOCAL_REPOSITORY_V2: '1' }, false).reason, 'c6_activation_missing')
  assert.equal(localRepositoryCapability({ QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }, false).reason, 'renderer_capability_missing')
  assert.equal(localRepositoryCapability({ QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }, true, true).reason, 'legacy_authority_active')
  assert.equal(localRepositoryCapability({ QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }, false, true).canActivate, true)
  assert.equal(startLocalRepositoryIfEnabled({ ...options, authorityState: 'legacy-active' }, { QQPET_LOCAL_REPOSITORY_V2: '1' }), null)
  const activated = startLocalRepositoryIfEnabled({ ...options, authorityState: 'local-v2-active', rendererCapability: true }, { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' })
  assert.ok(activated)
  await activated.stop()
})

test('suspend/resume closes exact segment without counting suspended time; malformed documents fail read-only', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  clock.value += 1000
  const suspended = await await repo.suspend()
  assert.equal(suspended.status.state, 'suspended')
  let coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.equal(coverage[0].disconnectedAtWallMs, WALL_TIME_MS + 1000)
  assert.equal(coverage[0].closeReason, 'suspend')
  assert.equal(repo.getDocument().bundle.engine.coverageReopen.state, 'suspended')
  clock.value += 5000
  await repo.resume()
  coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.equal(coverage[coverage.length - 1].connectedAtWallMs, WALL_TIME_MS + 6000)
  assert.equal(repo.getDocument().bundle.engine.coverageReopen, undefined)
  await repo.stop()

  const badDir = tempDir()
  const badPath = join(badDir, 'save.json')
  writeFileSync(badPath, '{not-json')
  const bad = makeRepo(repoOptions(badDir, clock))
  assert.equal(await bad.load(), null)
  assert.equal(bad.getStatus().state, 'read_only')
  assert.match(bad.getStatus().error, /not valid JSON/)
})

test('lifecycle starts only on ready when flagged; quit flushes and stops', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const ready = []
  const quit = []
  const hooks = { onReady: fn => ready.push(fn), onQuit: fn => quit.push(fn) }
  assert.equal(registerLocalRepositoryLifecycle(repoOptions(dir, clock), hooks, {}), null)
  assert.equal(ready.length, 0)
  assert.equal(quit.length, 0)
  const repo = registerLocalRepositoryLifecycle({ ...repoOptions(dir, clock), authorityState: 'local-v2-active', rendererCapability: true }, hooks, { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' })
  assert.ok(repo)
  assert.equal(existsSync(join(dir, 'save.json')), false)
  await ready[0]()
  assert.ok(existsSync(join(dir, 'save.json')))
  await quit[0]()
  assert.equal(repo.getStatus().state, 'stopped')
})

test('local command queue serializes concurrent retries and persists one idempotent application', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const startYb = repo.getProjection().shared.petInfo.yb
  const command = { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 11 } }
  const [first, second] = await Promise.all([
    repo.command(command, 'op-queue', 'owner'),
    repo.command(command, 'op-queue', 'owner'),
  ])
  assert.equal([first.duplicate, second.duplicate].filter(Boolean).length, 1)
  assert.equal(repo.getProjection().shared.petInfo.yb, startYb + 11)
  assert.equal(repo.getDocument().idempotency.records.filter(record => record.opId === 'op-queue').length, 1)
  await repo.setAdvanceWhileEmpty(false)
  assert.equal(repo.getProjection().advanceWhileEmpty, false)
  await repo.stop()
})

test('authority gating rejects handoff_pending loads before opening coverage or accepting commands', async () => {
  const dir = tempDir()
  const doc = JSON.parse(JSON.stringify(fixtures.localDocument))
  doc.authority.state = 'handoff_pending'
  const path = join(dir, 'save.json')
  writeJson(path, doc)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  const projection = await repo.load()
  assert.ok(projection)
  assert.equal(repo.getStatus().readOnly, true)
  assert.equal(repo.getStatus().authorityState, 'handoff_pending')
  assert.equal(repo.getDocument().bundle.engine.sessionCoverage.length, 1)
  const before = repo.getDocument().revision
  const result = await repo.command({ type: 'pet.cheer', payload: {} }, 'op-readonly', 'owner')
  assert.equal(result.outcome.ok, false)
  assert.equal(result.outcome.error.code, 'not_available')
  assert.equal(repo.getDocument().revision, before)
})

test('detach freezes epoch and server-detach import validates authority then reactivates locally', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const detached = await repo.exportForDetach(5)
  assert.equal(detached.authority.owner, 'local')
  assert.equal(detached.authority.epoch, 6)
  assert.equal(repo.getDocument().authority.state, 'handoff_pending')
  assert.equal(repo.getStatus().readOnly, true)
  assert.equal(repo.getDocument().bundle.engine.sessionCoverage.every(interval => interval.disconnectedAtWallMs !== undefined), true)
  assert.equal(repo.getDocument().bundle.engine.sessionCoverage[0].closeReason, 'authority_handoff')
  const blocked = await repo.command({ type: 'pet.cheer', payload: {} }, 'op-after-detach', 'owner')
  assert.equal(blocked.outcome.ok, false)

  const serverBundle = JSON.parse(JSON.stringify(detached))
  serverBundle.authority.owner = 'server'
  serverBundle.authority.authorityId = 'server-authority-1'
  serverBundle.authority.epoch = 5
  serverBundle.authority.restoreGeneration = 2
  const imported = await repo.importPortableBundle(serverBundle, {
    opId: 'op-server-import', expectedAuthorityId: 'server-authority-1',
    expectedRestoreGeneration: 2, expectedEpoch: 5, expectedRevision: serverBundle.authority.revision, expectedEventSeq: serverBundle.authority.eventSeq,
  })
  assert.ok(imported)
  const importedDoc = repo.getDocument()
  assert.equal(importedDoc.authority.state, 'active')
  assert.equal(importedDoc.authority.stamp.owner, 'local')
  assert.equal(importedDoc.authority.stamp.epoch, 7)
  assert.equal(importedDoc.authority.stamp.authorityId, 'server-authority-1')
  assert.equal(importedDoc.authority.stamp.restoreGeneration, 2)
  assert.equal(importedDoc.bundle.engine.sessionCoverage.length, detached.engine.sessionCoverage.length + 1)
  assert.equal(importedDoc.bundle.engine.sessionCoverage.filter(interval => interval.disconnectedAtWallMs === undefined).length, 1)
  assert.equal(importedDoc.bundle.engine.sessionCoverage.at(-1).connectedAtWallMs, WALL_TIME_MS)
  assert.ok(importedDoc.idempotency.records.some(record => record.opId === 'op-server-import'))
  const duplicateImport = await repo.importPortableBundle(serverBundle, { opId: 'op-server-import' })
  assert.equal(duplicateImport.bundle, undefined)
  assert.equal(repo.getDocument().bundle.engine.sessionCoverage.length, importedDoc.bundle.engine.sessionCoverage.length)
})

test('failed import stays read-only and rollbackDetach restores the frozen pre-detach authority', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const activeEpoch = repo.getDocument().authority.stamp.epoch
  const bundle = await repo.exportForDetach(1)
  const failed = await repo.importPortableBundle(bundle, { opId: 'op-bad-import', expectedEpoch: 99 })
  assert.equal(failed, null)
  assert.equal(repo.getStatus().state, 'read_only')
  assert.equal(repo.getStatus().readOnly, true)
  const rolled = await repo.rollbackDetach()
  assert.ok(rolled)
  assert.equal(repo.getStatus().state, 'ready')
  assert.equal(repo.getDocument().authority.state, 'active')
  assert.equal(repo.getDocument().authority.stamp.epoch, activeEpoch)
})

test('failed persistence leaves command/catch-up state, cache, revision and anchors untouched', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  let failWrite = false
  const repo = makeRepo(repoOptions(dir, clock, {
    writeDocument: (file, text) => { if (failWrite) throw new Error('disk full'); writeFileSync(file, text) },
  }))
  await repo.load()
  const beforeDoc = repo.getDocument()
  failWrite = true
  const rejected = await repo.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 3 } }, 'op-write-fail', 'owner')
  assert.equal(rejected.outcome.ok, false)
  assert.equal(rejected.outcome.error.code, 'internal')
  assert.equal(repo.getDocument().revision, beforeDoc.revision)
  assert.equal(repo.getDocument().idempotency.records.length, 0)
  assert.deepEqual(repo.getDocument().bundle.engine.save, beforeDoc.bundle.engine.save)
  clock.value += 120000
  await repo.pump()
  assert.equal(repo.getDocument().bundle.engine.gameTimeMs, beforeDoc.bundle.engine.gameTimeMs)
  assert.equal(repo.getDocument().bundle.engine.lastSchedulerWallMs, beforeDoc.bundle.engine.lastSchedulerWallMs)
  failWrite = false
})

test('rejected commands persist idempotency without revision and catch-up emits ordered per-chunk revisions with yields', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  let yields = 0
  const repo = makeRepo(repoOptions(dir, clock, { maxChunkTicks: 1, yieldToEventLoop: async () => { yields++ } }))
  await repo.load()
  const start = repo.getDocument()
  const rejected = await repo.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 0 } }, 'op-rejected-rev', 'owner')
  assert.equal(rejected.outcome.ok, false)
  assert.equal(repo.getDocument().revision, start.revision)
  assert.equal(repo.getDocument().idempotency.records.length, 1)
  clock.value += 120000
  await repo.pump()
  const after = repo.getDocument()
  assert.ok(after.revision >= start.revision + 2)
  assert.equal(after.revision, repo.getProjection().revision)
  assert.equal(after.eventSeq, repo.getProjection().eventSeq)
  assert.ok(yields >= 1)
  const events = repo.getRecentEvents()
  for (let index = 1; index < events.length; index++) assert.ok(events[index].eventSeq > events[index - 1].eventSeq)
})

test('duplicate reset is idempotent and does not close/reopen again', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const first = await repo.reset('op-reset-duplicate')
  const coverageAfterFirst = repo.getDocument().bundle.engine.sessionCoverage
  const second = await repo.reset('op-reset-duplicate')
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.deepEqual(repo.getDocument().bundle.engine.sessionCoverage, coverageAfterFirst)
  assert.equal(repo.getDocument().idempotency.records.filter(record => record.opId === 'op-reset-duplicate').length, 1)
})

test('suspend closes normal coverage at heartbeat grace and projection callbacks/copies do not alias internals', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  let callbackProjection
  const repo = makeRepo(repoOptions(dir, clock, { onProjection: value => { callbackProjection = value } }))
  await repo.load()
  const projection = repo.getProjection()
  projection.shared.petInfo.yb = -1
  projection.device.petInfo.lastX = 9999
  projection.authority.stamp.epoch = -1
  assert.notEqual(repo.getProjection().shared.petInfo.yb, -1)
  assert.notEqual(repo.getProjection().device.petInfo.lastX, 9999)
  callbackProjection.shared.petInfo.yb = -2
  assert.notEqual(repo.getProjection().shared.petInfo.yb, -2)
  clock.value += 120000
  await repo.suspend()
  const doc = repo.getDocument()
  assert.equal(doc.bundle.engine.sessionCoverage[0].disconnectedAtWallMs, WALL_TIME_MS + 60000)
  assert.equal(repo.lastReopen.commitWallMs, WALL_TIME_MS + 60000)
  assert.equal(repo.lastReopen.suspendedAtWallMs, WALL_TIME_MS + 120000)
})

test('flush and stop drain the serialized queue before final write', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const startYb = repo.getProjection().shared.petInfo.yb
  const pending = repo.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 13 } }, 'op-drain', 'owner')
  const flushing = repo.flush()
  await Promise.all([pending, flushing])
  await repo.stop()
  assert.equal(repo.getStatus().state, 'stopped')
  const saved = JSON.parse(readFileSync(join(dir, 'save.json'), 'utf8'))
  assert.equal(saved.bundle.engine.save.petInfo.yb, startYb + 13)
  assert.ok(saved.idempotency.records.some(record => record.opId === 'op-drain'))
})

test('detach rollback snapshot restores active scheduler after restart and clears read-only error', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  let starts = 0
  let stops = 0
  const startTimer = () => { starts++; return () => { stops++ } }
  const first = makeRepo(repoOptions(dir, clock, { autoScheduler: true, startTimer }))
  await first.start()
  assert.equal(first.isSchedulerRunning(), true)
  await first.exportForDetach(2)
  assert.equal(first.isSchedulerRunning(), false)
  assert.ok(existsSync(join(dir, 'save.json.pre-detach.json')))
  const restarted = makeRepo(repoOptions(dir, clock, { autoScheduler: true, startTimer }))
  await restarted.start()
  assert.equal(restarted.getStatus().readOnly, true)
  assert.equal(restarted.isSchedulerRunning(), false)
  await restarted.rollbackDetach()
  assert.equal(restarted.getStatus().state, 'ready')
  assert.equal(restarted.getStatus().error, undefined)
  assert.equal(restarted.isSchedulerRunning(), true)
  assert.ok(starts >= 2)
  assert.ok(stops >= 1)
})

test('server handoff import rejects missing exact authority fields and stays read-only', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const bundle = await repo.exportForDetach(1)
  bundle.authority.owner = 'server'
  bundle.authority.authorityId = 'server-detach-auth'
  const result = await repo.importPortableBundle(bundle, { opId: 'op-missing-authority' })
  assert.equal(result, null)
  assert.equal(repo.getStatus().readOnly, true)
  assert.equal(repo.getDocument().authority.state, 'handoff_pending')
  await repo.rollbackDetach()
  assert.equal(repo.getStatus().state, 'ready')
})

test('public setters/suspend are queued candidate mutations with write-failure rollback', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  let failWrite = false
  const repo = makeRepo(repoOptions(dir, clock, {
    writeDocument: (file, text) => { if (failWrite) throw new Error('write failed'); writeFileSync(file, text) },
  }))
  await repo.load()
  const original = repo.getDocument()
  failWrite = true
  await assert.rejects(repo.setAdvanceWhileEmpty(true))
  await assert.rejects(repo.setLocalSettings({ zoom: 1.5 }))
  await assert.rejects(repo.suspend())
  assert.equal(repo.getProjection().advanceWhileEmpty, original.bundle.engine.advanceWhileEmpty)
  assert.equal(repo.getProjection().device.settings.zoom, original.device.settings.zoom)
  assert.equal(repo.getDocument().bundle.engine.coverageReopen, original.bundle.engine.coverageReopen)
  failWrite = false
  await Promise.all([
    repo.setAdvanceWhileEmpty(true),
    repo.setLocalSettings({ zoom: 1.75 }),
  ])
  assert.equal(repo.getProjection().advanceWhileEmpty, true)
  assert.equal(repo.getProjection().device.settings.zoom, 1.75)
  await repo.stop()
})

test('recent event history persists across restart and aligns with eventSeq', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  await repo.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 9 } }, 'op-history', 'owner')
  const events = repo.getRecentEvents()
  assert.ok(events.length > 0)
  const eventSeq = repo.getDocument().eventSeq
  assert.deepEqual(repo.getDocument().eventHistory, events)
  await repo.stop()
  const restarted = makeRepo(repoOptions(dir, clock))
  await restarted.load()
  assert.equal(restarted.getDocument().eventSeq, eventSeq)
  assert.deepEqual(restarted.getRecentEvents(), events)
  assert.equal(restarted.getRecentEvents().at(-1).eventSeq, eventSeq)
})

test('corrupt v2 and legacy JSON are backed up byte-for-byte before rejection', async () => {
  const v2Dir = tempDir()
  const v2Path = join(v2Dir, 'save.json')
  writeFileSync(v2Path, '{broken-v2')
  const v2Repo = makeRepo(repoOptions(v2Dir, { value: WALL_TIME_MS }))
  assert.equal(await v2Repo.load(), null)
  assert.equal(readFileSync(v2Path + '.bak', 'utf8'), '{broken-v2')
  assert.match(v2Repo.getStatus().error, /not valid JSON/)

  const legacyDir = tempDir()
  const legacyPath = join(legacyDir, 'legacy.json')
  writeFileSync(legacyPath, '{broken-legacy')
  const legacyRepo = makeRepo(repoOptions(legacyDir, { value: WALL_TIME_MS }))
  assert.equal(await legacyRepo.load(), null)
  assert.equal(readFileSync(legacyPath + '.bak', 'utf8'), '{broken-legacy')
  assert.match(legacyRepo.getStatus().error, /not valid JSON/)
})

test('local document schema validates full OpIdCache and event history shape', () => {
  const error = { code: 'invalid_payload', message: 'bad', refreshProjection: false }
  const base = JSON.parse(JSON.stringify(fixtures.localDocument))
  base.idempotency = {
    schemaVersion: 2,
    records: [{ petId: 'p', deviceId: 'd', opId: 'o', commandType: 'pet.bury', resultPresent: true, result: null }],
  }
  assert.equal(validateLocalPetDocumentV2(base), true)
  const both = JSON.parse(JSON.stringify(base))
  both.idempotency.records[0].error = error
  assert.equal(validateLocalPetDocumentV2(both), false)
  const badHistory = JSON.parse(JSON.stringify(base))
  badHistory.eventHistory = [{ eventSeq: 2, type: 'x', payload: {} }]
  badHistory.eventSeq = 1
  assert.equal(validateLocalPetDocumentV2(badHistory), false)
  const badCommand = JSON.parse(JSON.stringify(base))
  badCommand.idempotency.records[0].commandType = 'not-a-command'
  assert.equal(validateLocalPetDocumentV2(badCommand), false)
  const badOpId = JSON.parse(JSON.stringify(base))
  badOpId.idempotency.records[0].opId = 'bad op id'
  assert.equal(validateLocalPetDocumentV2(badOpId), false)
  const badKeys = JSON.parse(JSON.stringify(base))
  badKeys.eventHistory = [{ eventSeq: 1, type: 'pet.statsChanged', payload: {}, extra: true }]
  assert.equal(validateLocalPetDocumentV2(badKeys), false)
  const badEventType = JSON.parse(JSON.stringify(base))
  badEventType.eventHistory = [{ eventSeq: 1, type: 'unknown.event', payload: {} }]
  assert.equal(validateLocalPetDocumentV2(badEventType), false)
  const badErrorCode = JSON.parse(JSON.stringify(base))
  badErrorCode.idempotency.records[0] = {
    petId: 'p', deviceId: 'd', opId: 'o', commandType: 'pet.bury', resultPresent: false,
    error: { code: 'unknown_error_code', message: 'bad', refreshProjection: false },
  }
  assert.equal(validateLocalPetDocumentV2(badErrorCode), false)
})

test('stop/export/suspend/resume preserve prior scheduler, status and coverage on persist failure', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  let failWrite = false
  let starts = 0
  const startTimer = () => { starts++; return () => {} }
  const repo = makeRepo(repoOptions(dir, clock, {
    autoScheduler: true, startTimer,
    writeDocument: (file, text) => { if (failWrite) throw new Error('write failed'); writeFileSync(file, text) },
  }))
  await repo.start()
  const originalCoverage = repo.getDocument().bundle.engine.sessionCoverage
  failWrite = true
  await assert.rejects(repo.stop())
  assert.equal(repo.getStatus().state, 'ready')
  assert.equal(repo.isSchedulerRunning(), true)
  assert.deepEqual(repo.getDocument().bundle.engine.sessionCoverage, originalCoverage)
  await assert.rejects(repo.exportForDetach())
  assert.equal(repo.getStatus().state, 'ready')
  assert.equal(repo.isSchedulerRunning(), true)
  assert.deepEqual(repo.getDocument().bundle.engine.sessionCoverage, originalCoverage)
  await assert.rejects(repo.suspend())
  assert.equal(repo.getStatus().state, 'ready')
  assert.equal(repo.isSchedulerRunning(), true)
  assert.deepEqual(repo.getDocument().bundle.engine.sessionCoverage, originalCoverage)
  failWrite = false
  await repo.suspend()
  assert.equal(repo.getStatus().state, 'suspended')
  assert.equal(repo.isSchedulerRunning(), false)
  const suspendedCoverage = repo.getDocument().bundle.engine.sessionCoverage
  failWrite = true
  await assert.rejects(repo.resume())
  assert.equal(repo.getStatus().state, 'suspended')
  assert.equal(repo.isSchedulerRunning(), false)
  assert.deepEqual(repo.getDocument().bundle.engine.sessionCoverage, suspendedCoverage)
  failWrite = false
  await repo.resume()
  assert.equal(repo.getStatus().state, 'ready')
  assert.equal(repo.isSchedulerRunning(), true)
  await repo.stop()
})

test('import clears stale local events and opIds and next events follow imported eventSeq', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  const oldCommand = { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 5 } }
  await repo.command(oldCommand, 'op-before-import', 'owner')
  assert.ok(repo.getRecentEvents().length > 0)
  assert.ok(repo.getDocument().idempotency.records.some(record => record.opId === 'op-before-import'))
  const bundle = repo.exportPortableBundle()
  const imported = await repo.importPortableBundle(bundle, { opId: 'op-import-reset' })
  assert.ok(imported)
  assert.deepEqual(repo.getRecentEvents(), [])
  assert.equal(repo.getDocument().idempotency.records.some(record => record.opId === 'op-before-import'), false)
  assert.equal(repo.getDocument().idempotency.records.some(record => record.opId === 'op-import-reset'), true)
  const importedSeq = repo.getDocument().eventSeq
  const replayOld = await repo.command(oldCommand, 'op-before-import', 'owner')
  assert.equal(replayOld.duplicate, false)
  assert.ok(repo.getDocument().eventSeq > importedSeq)
  const nextEvents = repo.getRecentEvents()
  assert.ok(nextEvents.every(event => event.eventSeq > importedSeq))
})

test('direct constructor is fail-closed without the private activation token; factory rejects legacy authority', () => {
  const dir = tempDir()
  const options = repoOptions(dir, { value: WALL_TIME_MS })
  assert.throws(() => new LocalRepository(options), /activation token required/)
  assert.throws(() => createLocalRepository(options, { authorityState: 'legacy-active', rendererCapability: true, env: ACTIVATION_ENV }), /activation denied/)
  assert.throws(() => createLocalRepository(options, { authorityState: 'local-v2-active', rendererCapability: false, env: ACTIVATION_ENV }), /activation denied/)
})

test('stopped repositories reject export and rollback without reviving', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = makeRepo(repoOptions(dir, clock))
  await repo.load()
  await repo.exportForDetach(1)
  await repo.stop()
  assert.equal(repo.getStatus().state, 'stopped')
  await assert.rejects(repo.exportForDetach(), /stopped/)
  await assert.rejects(repo.rollbackDetach(), /stopped/)
  assert.equal(repo.getStatus().state, 'stopped')
  assert.equal(repo.getStatus().readOnly, true)
})
