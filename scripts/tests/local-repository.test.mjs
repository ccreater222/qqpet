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

const { LocalRepository, localRepositoryEnabled, startLocalRepositoryIfEnabled, registerLocalRepositoryLifecycle } = await import('../../src/main/local-repository.ts')
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
  const repo = new LocalRepository(repoOptions(dir, clock))
  const projection = repo.load()
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
  repo.setLocalSettings({ zoom: 1.25 })
  assert.equal(repo.getProjection().device.settings.zoom, 1.25)
  repo.setRole('player')
  assert.equal(repo.getStatus().role, 'player')
  repo.stop()
  assert.equal(repo.getStatus().state, 'stopped')
})

test('scheduler catch-up honors advanceWhileEmpty true and false across restart', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const trueRepo = new LocalRepository(repoOptions(dir, clock, { advanceWhileEmpty: true, maxChunkTicks: 1440 }))
  const start = trueRepo.load()
  const gameStart = start.gameTimeMs
  clock.value += 2 * 60000
  await trueRepo.pump()
  assert.equal(trueRepo.getProjection().gameTimeMs, gameStart + 2 * 60000)
  assert.equal(trueRepo.getStatus().state, 'ready')
  trueRepo.stop()
  assert.equal(existsSync(join(dir, 'save.json.tmp')), false)

  const falseDir = tempDir()
  writeJson(join(falseDir, 'legacy.json'), fixtures.save)
  const falseClock = { value: WALL_TIME_MS }
  const falseRepo = new LocalRepository(repoOptions(falseDir, falseClock, { advanceWhileEmpty: false, maxChunkTicks: 1440 }))
  const falseStart = falseRepo.load()
  const falseGame = falseStart.gameTimeMs
  falseRepo.stop()
  falseClock.value += 2 * 60000
  const restarted = new LocalRepository(repoOptions(falseDir, falseClock, { advanceWhileEmpty: false, maxChunkTicks: 1440 }))
  const resumed = restarted.load()
  assert.ok(resumed)
  assert.equal(restarted.getProjection().gameTimeMs, falseGame)
  assert.equal(restarted.getProjection().advanceWhileEmpty, false)
  restarted.stop()
})

test('reset and portable import close active coverage and reopen exact local survivor intervals', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = new LocalRepository(repoOptions(dir, clock))
  repo.load()
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
  repo.importPortableBundle(bundle, 'op-import')
  coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.ok(coverage.length >= 3)
  const last = coverage[coverage.length - 1]
  assert.equal(last.connectedAtWallMs, WALL_TIME_MS + 1000)
  assert.equal(repo.lastReopen.survivors[0].activeEndProvenance, 'import_replaced')
  repo.stop()
})

test('legacy duplicate localDeviceId migrates on match and fails read-only without overwriting on mismatch', () => {
  const matchDir = tempDir()
  const matched = JSON.parse(JSON.stringify(fixtures.localDocument))
  matched.runtime.localDeviceId = matched.device.localDeviceId
  const matchPath = join(matchDir, 'save.json')
  writeJson(matchPath, matched)
  const clock = { value: WALL_TIME_MS }
  const repo = new LocalRepository(repoOptions(matchDir, clock))
  assert.ok(repo.load())
  assert.equal(repo.currentDeviceId, matched.device.localDeviceId)
  assert.equal(repo.getDocument().runtime.localDeviceId, undefined)
  assert.ok(existsSync(matchPath + '.bak'))

  const badDir = tempDir()
  const bad = JSON.parse(JSON.stringify(fixtures.localDocument))
  bad.runtime.localDeviceId = 'device-that-does-not-match'
  const badPath = join(badDir, 'save.json')
  writeJson(badPath, bad)
  const original = readFileSync(badPath, 'utf8')
  const badRepo = new LocalRepository(repoOptions(badDir, clock))
  assert.equal(badRepo.load(), null)
  assert.equal(badRepo.getStatus().state, 'read_only')
  assert.match(badRepo.getStatus().error, /localDeviceId/)
  assert.equal(readFileSync(badPath, 'utf8'), original)
})

test('crash restart repairs coverage and replays the persisted opId without reapplication', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const first = new LocalRepository(repoOptions(dir, clock))
  first.load()
  const yb = first.getProjection().shared.petInfo.yb
  await first.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 7 } }, 'op-crash', 'owner')
  const ybAfter = first.getProjection().shared.petInfo.yb
  clock.value += 120000
  const second = new LocalRepository(repoOptions(dir, clock))
  assert.ok(second.load())
  assert.equal(second.getProjection().shared.petInfo.yb, ybAfter)
  const cov = second.getDocument().bundle.engine.sessionCoverage
  assert.ok(cov.length >= 2)
  assert.equal(cov[0].closeReason, 'crash_repaired')
  assert.ok(cov[0].disconnectedAtWallMs <= clock.value)
  assert.equal(cov[cov.length - 1].disconnectedAtWallMs, undefined)
  const replay = await second.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 7 } }, 'op-crash', 'owner')
  assert.equal(replay.duplicate, true)
  assert.equal(second.getProjection().shared.petInfo.yb, ybAfter)
  second.stop()
  assert.ok(ybAfter >= yb + 7)
})

test('default legacy path stays untouched unless the explicit local repository flag is set', () => {
  assert.equal(localRepositoryEnabled({}), false)
  assert.equal(localRepositoryEnabled({ QQPET_LOCAL_REPOSITORY_V2: '0' }), false)
  const dir = tempDir()
  const options = repoOptions(dir, { value: WALL_TIME_MS })
  assert.equal(startLocalRepositoryIfEnabled(options, {}), null)
  assert.equal(existsSync(join(dir, 'save.json')), false)
})

test('suspend/resume closes exact segment without counting suspended time; malformed documents fail read-only', () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = new LocalRepository(repoOptions(dir, clock))
  repo.load()
  clock.value += 1000
  const suspended = repo.suspend()
  assert.equal(suspended.status.state, 'suspended')
  let coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.equal(coverage[0].disconnectedAtWallMs, WALL_TIME_MS + 1000)
  assert.equal(coverage[0].closeReason, 'suspend')
  assert.equal(repo.getDocument().bundle.engine.coverageReopen.state, 'suspended')
  clock.value += 5000
  repo.resume()
  coverage = repo.getDocument().bundle.engine.sessionCoverage
  assert.equal(coverage[coverage.length - 1].connectedAtWallMs, WALL_TIME_MS + 6000)
  assert.equal(repo.getDocument().bundle.engine.coverageReopen, undefined)
  repo.stop()

  const badDir = tempDir()
  const badPath = join(badDir, 'save.json')
  writeFileSync(badPath, '{not-json')
  const bad = new LocalRepository(repoOptions(badDir, clock))
  assert.equal(bad.load(), null)
  assert.equal(bad.getStatus().state, 'read_only')
  assert.match(bad.getStatus().error, /not valid JSON/)
})

test('lifecycle starts only on ready when flagged; quit flushes and stops', () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const ready = []
  const quit = []
  const hooks = { onReady: fn => ready.push(fn), onQuit: fn => quit.push(fn) }
  assert.equal(registerLocalRepositoryLifecycle(repoOptions(dir, clock), hooks, {}), null)
  assert.equal(ready.length, 0)
  assert.equal(quit.length, 0)
  const repo = registerLocalRepositoryLifecycle(repoOptions(dir, clock), hooks, { QQPET_LOCAL_REPOSITORY_V2: '1' })
  assert.ok(repo)
  assert.equal(existsSync(join(dir, 'save.json')), false)
  ready[0]()
  assert.ok(existsSync(join(dir, 'save.json')))
  quit[0]()
  assert.equal(repo.getStatus().state, 'stopped')
})

test('local command queue serializes concurrent retries and persists one idempotent application', async () => {
  const dir = tempDir()
  writeJson(join(dir, 'legacy.json'), fixtures.save)
  const clock = { value: WALL_TIME_MS }
  const repo = new LocalRepository(repoOptions(dir, clock))
  repo.load()
  const startYb = repo.getProjection().shared.petInfo.yb
  const command = { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 11 } }
  const [first, second] = await Promise.all([
    repo.command(command, 'op-queue', 'owner'),
    repo.command(command, 'op-queue', 'owner'),
  ])
  assert.equal([first.duplicate, second.duplicate].filter(Boolean).length, 1)
  assert.equal(repo.getProjection().shared.petInfo.yb, startYb + 11)
  assert.equal(repo.getDocument().idempotency.records.filter(record => record.opId === 'op-queue').length, 1)
  repo.setAdvanceWhileEmpty(false)
  assert.equal(repo.getProjection().advanceWhileEmpty, false)
  repo.stop()
})
