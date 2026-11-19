import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const {
  createLocalRepositoryHost,
  localRepositoryHostCapability,
  composeLocalRepositorySave,
} = await import('../../src/shared/local-repository/host.ts')
const { createAtomicV2Storage } = await import('../../src/shared/local-repository/storage.ts')
const { androidLocalRepositoryStorage } = await import('../../src/android/local-repository-storage.ts')
const { harmonyLocalRepositoryStorage } = await import('../../src/harmony/local-repository-storage.ts')
const { iosLocalRepositoryStorage } = await import('../../src/ios/local-repository-storage.ts')
const {
  createMobileLocalRepositoryBridge,
  mobileLocalRepositoryCapability,
  resolveMobileLegacyAuthority,
} = await import('../../src/mobile/local-repository-bridge.ts')
const { validateLocalPetDocumentV2 } = await import('../../src/shared/sync/portable.ts')
const { validatePersistedRuntimeState } = await import('../../src/shared/pet-runtime/idempotency.ts')
const { sessionActivityForInterval } = await import('../../src/shared/pet-runtime/coverage.ts')
const { createLocalRepository } = await import('../../src/main/local-repository.ts')
const { createSyncFixtures, SEED, WALL_TIME_MS } = await import('./sync-fixtures.mjs')
const fixtures = createSyncFixtures()

function memoryFiles(initial = {}) {
  const files = new Map(Object.entries(initial))
  const writes = []
  const host = {
    kind: 'mock-file',
    atomicDocument: true,
    backup: true,
    async readState(name) {
      return { status: 'ok', text: files.has(name) ? files.get(name) : null }
    },
    async readLegacy() {
      return { status: 'ok', text: files.has('save.json') ? files.get('save.json') : null }
    },
    async writeAtomic(name, text) { files.set(name, text); writes.push(name) },
  }
  return { files, writes, host, storage: createAtomicV2Storage(host) }
}

function ids() {
  let value = 0
  return () => 'mobile-uuid-' + String(++value).padStart(4, '0')
}

function activation(storage) {
  return { devRuntimeFlag: true, rendererCapability: true, storage: storage.capability }
}

function hostFor(memory, clock, overrides = {}) {
  return createLocalRepositoryHost({
    storage: memory.storage,
    nowMs: () => clock.value,
    randomUUID: ids(),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    pollIntervalMs: 1_000_000,
    maxChunkTicks: 1440,
    autoScheduler: false,
    ...overrides,
  }, activation(memory.storage))
}

test('portable host migrates legacy save with backup, canonical device id, and atomic v2 document', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  const projection = await host.start()
  assert.ok(projection)
  assert.equal(memory.files.get('save.json'), JSON.stringify(fixtures.save))
  assert.equal(memory.files.get('save.json.bak'), JSON.stringify(fixtures.save))
  const document = JSON.parse(memory.files.get('save.v2.json'))
  assert.equal(document.format, 'qqpet-local-v2')
  assert.equal(document.device.localDeviceId, host.currentDeviceId)
  assert.equal(Object.prototype.hasOwnProperty.call(document.runtime, 'localDeviceId'), false)
  assert.equal(document.bundle.originLocalDeviceId, document.device.localDeviceId)
  assert.equal(validateLocalPetDocumentV2(document), true)
  assert.doesNotThrow(() => validatePersistedRuntimeState({
    schemaVersion: 2,
    engine: document.bundle.engine,
    idempotency: document.idempotency,
  }))
  assert.equal(projection.save.petInfo.lastX, document.device.petInfo.lastX)
  assert.equal(projection.shared.settings.aiKey, undefined)
  assert.equal(projection.save.settings.aiKey, fixtures.save.settings.aiKey)
  assert.deepEqual(composeLocalRepositorySave(projection.shared, projection.device), projection.save)
  await host.stop()
})

test('portable host serializes concurrent opIds and never aliases projections', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const start = host.getProjection()
  const command = { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 11 } }
  const [first, second] = await Promise.all([
    host.command(command, { opId: 'mobile-op-queue' }),
    host.command(command, { opId: 'mobile-op-queue' }),
  ])
  assert.equal([first.status, second.status].filter(status => status === 'duplicate').length, 1)
  assert.equal(host.getProjection().shared.petInfo.yb, start.shared.petInfo.yb + 11)
  assert.equal(host.getDocument().idempotency.records.filter(record => record.opId === 'mobile-op-queue').length, 1)
  const copy = host.getProjection()
  copy.shared.petInfo.yb = -1
  copy.device.petInfo.lastX = 99999
  assert.notEqual(host.getProjection().shared.petInfo.yb, -1)
  assert.notEqual(host.getProjection().device.petInfo.lastX, 99999)
  await host.stop()
})

test('duplicate runtime.localDeviceId migrates only on exact match and backs up original bytes', async () => {
  const matched = JSON.parse(JSON.stringify(fixtures.localDocument))
  matched.runtime.localDeviceId = matched.device.localDeviceId
  const matchText = JSON.stringify(matched, null, 2)
  const memory = memoryFiles({ 'save.v2.json': matchText })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  assert.ok(await host.start())
  assert.equal(memory.files.get('save.v2.json.bak'), matchText)
  const migrated = JSON.parse(memory.files.get('save.v2.json'))
  assert.equal(Object.prototype.hasOwnProperty.call(migrated.runtime, 'localDeviceId'), false)
  assert.equal(host.currentDeviceId, matched.device.localDeviceId)
  assert.equal(host.getStatus().notice, 'legacy-local-device-id-migrated')
  await host.stop()

  const bad = JSON.parse(JSON.stringify(fixtures.localDocument))
  bad.runtime.localDeviceId = 'different-device'
  const badText = JSON.stringify(bad, null, 2)
  const badMemory = memoryFiles({ 'save.v2.json': badText })
  const badHost = hostFor(badMemory, clock)
  assert.equal(await badHost.start(), null)
  assert.equal(badHost.getStatus().state, 'read_only')
  assert.match(badHost.getStatus().error, /localDeviceId/)
  assert.equal(badMemory.files.get('save.v2.json'), badText)
  assert.equal(badMemory.files.get('save.v2.json.bak'), badText)
})

test('scheduler catch-up honors advanceWhileEmpty true and false across restart', async () => {
  const trueMemory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const trueClock = { value: WALL_TIME_MS }
  const trueHost = hostFor(trueMemory, trueClock)
  const started = await trueHost.start()
  const gameStart = started.gameTimeMs
  trueClock.value += 2 * 60_000
  await trueHost.pump()
  assert.equal(trueHost.getProjection().gameTimeMs, gameStart + 2 * 60_000)
  assert.equal(trueHost.getStatus().state, 'ready')
  await trueHost.stop()

  const falseMemory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const falseClock = { value: WALL_TIME_MS }
  const falseHost = hostFor(falseMemory, falseClock)
  const falseStart = await falseHost.start()
  await falseHost.setAdvanceWhileEmpty(false)
  const falseGame = falseStart.gameTimeMs
  await falseHost.stop()

  falseClock.value += 2 * 60_000
  const restarted = hostFor(falseMemory, falseClock)
  const resumed = await restarted.start()
  assert.ok(resumed)
  assert.equal(resumed.gameTimeMs, falseGame)
  assert.equal(resumed.advanceWhileEmpty, false)
  assert.equal(restarted.getStatus().state, 'ready')
  await restarted.stop()
})

test('reset/suspend/resume preserves exact local survivor and excludes suspended time', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const reset = await host.reset('mobile-reset-op')
  assert.equal(reset.status, 'applied')
  let document = host.getDocument()
  assert.equal(document.bundle.engine.sessionCoverage.length, 2)
  assert.equal(document.bundle.engine.sessionCoverage[0].disconnectedAtWallMs, WALL_TIME_MS)
  assert.equal(document.bundle.engine.sessionCoverage[0].closeReason, 'pet_reset')
  assert.equal(document.bundle.engine.sessionCoverage[1].connectedAtWallMs, WALL_TIME_MS)
  assert.equal(document.bundle.engine.sessionCoverage[1].disconnectedAtWallMs, undefined)
  assert.equal(document.bundle.engine.coverageReopen, undefined)
  assert.equal(host.lastReopen.survivors.length, 1)
  assert.equal(host.lastReopen.survivors[0].kind, 'local_app')
  assert.equal(host.lastReopen.survivors[0].appInstanceId, document.runtime.appInstanceId)
  assert.equal(host.lastReopen.survivors[0].localDeviceId, document.device.localDeviceId)
  assert.equal(host.lastReopen.survivors[0].eligible, true)

  clock.value += 1_000
  await host.suspend()
  document = host.getDocument()
  assert.equal(host.getStatus().state, 'suspended')
  const suspendedCoverage = document.bundle.engine.sessionCoverage.at(-1)
  assert.equal(suspendedCoverage.disconnectedAtWallMs, WALL_TIME_MS + 1_000)
  assert.equal(suspendedCoverage.closeReason, 'suspend')
  assert.equal(document.bundle.engine.coverageReopen.state, 'suspended')
  assert.equal(document.bundle.engine.coverageReopen.suspendedAtWallMs, WALL_TIME_MS + 1_000)

  clock.value += 5_000
  await host.resume()
  document = host.getDocument()
  assert.equal(host.getStatus().state, 'ready')
  assert.equal(document.bundle.engine.coverageReopen, undefined)
  const resumedCoverage = document.bundle.engine.sessionCoverage.at(-1)
  assert.equal(resumedCoverage.connectedAtWallMs, WALL_TIME_MS + 6_000)
  assert.equal(resumedCoverage.disconnectedAtWallMs, undefined)
  assert.deepEqual(
    sessionActivityForInterval(document.bundle.engine.sessionCoverage, WALL_TIME_MS + 3_000, WALL_TIME_MS + 4_000),
    { activeClientCount: 0, sessionActive: false },
  )
  await host.stop()
})

test('crash restart terminalizes a suspended reopen operation without backfill', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const first = hostFor(memory, clock)
  await first.start()
  await first.reset('mobile-reset-crash')
  clock.value += 1_000
  await first.suspend()
  const suspendedApp = first.getDocument().runtime.appInstanceId
  const operationId = first.getDocument().bundle.engine.coverageReopen.operationId
  clock.value += 119_000
  const restored = hostFor(memory, clock)
  const projection = await restored.start()
  assert.ok(projection)
  const document = restored.getDocument()
  assert.equal(document.bundle.engine.coverageReopen, undefined)
  const stable = document.bundle.engine.sessionCoverage.find(interval => interval.coverageId === operationId + ':' + suspendedApp)
  assert.ok(stable)
  assert.equal(stable.closeReason, 'suspend')
  assert.equal(stable.disconnectedAtWallMs, WALL_TIME_MS + 1_000)
  assert.equal(document.bundle.engine.sessionCoverage.at(-1).connectedAtWallMs, WALL_TIME_MS + 120_000)
  assert.equal(document.bundle.engine.sessionCoverage.at(-1).disconnectedAtWallMs, undefined)
  await restored.stop()
})

test('Android, Harmony and iOS storage adapters all drive the same v2 host', async () => {
  const cases = []
  const androidFiles = new Map([['save.json', JSON.stringify(fixtures.save)]])
  cases.push({
    name: 'android-native-file',
    storage: androidLocalRepositoryStorage({
      readStateFile: name => JSON.stringify({ status: 'ok', text: androidFiles.has(name) ? androidFiles.get(name) : null }),
      readLegacySave: () => JSON.stringify({ status: 'ok', text: androidFiles.has('save.json') ? androidFiles.get('save.json') : null }),
      writeAtomic: (name, text) => { androidFiles.set(name, text); return true },
    }),
    files: androidFiles,
  })
  const harmonyFiles = new Map([['save.json', JSON.stringify(fixtures.save)]])
  cases.push({
    name: 'harmony-native-file',
    storage: harmonyLocalRepositoryStorage({
      readStateFile: name => JSON.stringify({ status: 'ok', text: harmonyFiles.has(name) ? harmonyFiles.get(name) : null }),
      readLegacySave: () => JSON.stringify({ status: 'ok', text: harmonyFiles.has('save.json') ? harmonyFiles.get('save.json') : null }),
      writeAtomic: (name, text) => { harmonyFiles.set(name, text); return true },
    }),
    files: harmonyFiles,
  })
  const iosFiles = new Map([['save.json', JSON.stringify(fixtures.save)]])
  cases.push({
    name: 'ios-save-bridge',
    storage: iosLocalRepositoryStorage({
      async request(op, args) {
        if (op === 'readLocalStateFile') return { status: 'ok', text: iosFiles.has(args.name) ? iosFiles.get(args.name) : null }
        if (op === 'readLegacySave') return { status: 'ok', text: iosFiles.has('save.json') ? iosFiles.get('save.json') : null }
        if (op === 'writeLocalStateFileAtomic') { iosFiles.set(args.name, args.text); return true }
        throw new Error('unexpected RPC ' + op)
      },
    }),
    files: iosFiles,
  })
  for (const entry of cases) {
    const clock = { value: WALL_TIME_MS }
    assert.equal(entry.storage.capability.kind, entry.name)
    const host = hostFor({ storage: entry.storage }, clock)
    const projection = await host.start()
    assert.ok(projection, entry.name)
    const result = await host.command(
      { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 3 } },
      { opId: 'adapter-op-' + entry.name, role: 'owner' },
    )
    assert.equal(result.status, 'applied', entry.name)
    const document = JSON.parse(entry.files.get('save.v2.json'))
    assert.equal(document.device.localDeviceId, host.currentDeviceId)
    assert.equal(Object.prototype.hasOwnProperty.call(document.runtime, 'localDeviceId'), false)
    assert.equal(validateLocalPetDocumentV2(document), true)
    await host.stop()
  }
})

test('mobile bridge exposes only flag-gated local APIs and fans out projection/status/result events', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const projections = []
  const statuses = []
  const results = []
  const bridge = createMobileLocalRepositoryBridge({
    storage: memory.storage,
    devRuntimeFlag: true,
    rendererCapability: true,
    nowMs: () => clock.value,
    randomUUID: ids(),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    localDeviceId: 'mobile-bridge-device',
    appInstanceId: 'mobile-bridge-app',
    autoScheduler: false,
  })
  bridge.onProjection((projection, events) => projections.push({ projection, events }))
  bridge.onSyncStatus(status => statuses.push(status))
  bridge.onCommandResult(result => results.push(result))
  const save = await bridge.load()
  assert.equal(bridge.capability.serverMode, false)
  assert.equal(bridge.getStatus().mode, 'local')
  assert.equal(bridge.getStatus().serverMode, false)
  assert.ok(save.havePet)
  const result = await bridge.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 5 } },
    { opId: 'mobile-bridge-op' },
  )
  assert.equal(result.status, 'applied')
  assert.ok(projections.length > 0)
  assert.ok(statuses.length > 0)
  assert.equal(results.length, 1)
  assert.equal(projections.at(-1).projection.status.serverMode, false)
  assert.equal(results[0].opId, 'mobile-bridge-op')
  await bridge.setAdvanceWhileEmpty(false)
  assert.equal(bridge.getProjection().advanceWhileEmpty, false)
  await bridge.flush()
  await bridge.stop()
})

test('activation capability fails closed without flag, storage atomicity/backup, and forbids server mode', async () => {
  const memory = memoryFiles()
  assert.deepEqual(localRepositoryHostCapability({
    devRuntimeFlag: false,
    rendererCapability: true,
    storage: memory.storage.capability,
  }), { enabled: false, canActivate: false, serverMode: false, reason: 'dev_flag_disabled' })
  assert.equal(localRepositoryHostCapability({
    devRuntimeFlag: true,
    rendererCapability: false,
    storage: memory.storage.capability,
  }).reason, 'renderer_capability_missing')
  assert.equal(localRepositoryHostCapability({
    devRuntimeFlag: true,
    rendererCapability: true,
    storage: { ...memory.storage.capability, atomicDocument: false },
  }).reason, 'storage_atomic_write_missing')
  assert.equal(localRepositoryHostCapability({
    devRuntimeFlag: true,
    rendererCapability: true,
    storage: { ...memory.storage.capability, backup: false },
  }).reason, 'storage_backup_missing')
  assert.equal(localRepositoryHostCapability({
    devRuntimeFlag: true,
    rendererCapability: true,
    serverMode: true,
    storage: memory.storage.capability,
  }).reason, 'server_mode_forbidden')
  assert.equal(localRepositoryHostCapability({
    devRuntimeFlag: true,
    rendererCapability: true,
    serverMode: false,
    storage: memory.storage.capability,
  }).canActivate, true)
  assert.throws(() => createLocalRepositoryHost({
    storage: memory.storage,
    nowMs: () => WALL_TIME_MS,
    randomUUID: ids(),
    seedHex: SEED,
  }, {
    devRuntimeFlag: false,
    rendererCapability: true,
    storage: memory.storage.capability,
  }), /activation denied/)
  assert.throws(() => createMobileLocalRepositoryBridge({
    storage: memory.storage,
    devRuntimeFlag: false,
    autoScheduler: false,
  }), /local runtime v2 unavailable: dev_flag_disabled/)
  assert.throws(() => createMobileLocalRepositoryBridge({
    storage: {
      ...memory.storage,
      capability: { ...memory.storage.capability, atomicDocument: false },
    },
    devRuntimeFlag: true,
    rendererCapability: true,
    autoScheduler: false,
  }), /local runtime v2 unavailable: storage_atomic_write_missing/)
  assert.equal(mobileLocalRepositoryCapability({
    storage: memory.storage,
    devRuntimeFlag: true,
  }).reason, 'renderer_capability_missing')
  assert.throws(() => createMobileLocalRepositoryBridge({
    storage: memory.storage,
    devRuntimeFlag: true,
    autoScheduler: false,
  }), /local runtime v2 unavailable: renderer_capability_missing/)
})

test('mobile local host parity: same command and scheduler sequence as desktop LocalRepository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-mobile-parity-'))
  const legacyPath = join(dir, 'legacy.json')
  writeFileSync(legacyPath, JSON.stringify(fixtures.save))
  const desktopClock = { value: WALL_TIME_MS }
  let desktopId = 0
  const desktop = createLocalRepository({
    documentPath: join(dir, 'save.json'),
    legacySavePath: legacyPath,
    nowMs: () => desktopClock.value,
    randomUUID: () => 'parity-uuid-' + String(++desktopId).padStart(4, '0'),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    localDeviceId: 'parity-device-0001',
    appInstanceId: 'parity-app-0001',
    pollIntervalMs: 1_000_000,
    maxChunkTicks: 1440,
    autoScheduler: false,
  }, {
    authorityState: 'local-v2-active',
    rendererCapability: true,
    env: { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' },
  })
  await desktop.load()

  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const mobileClock = { value: WALL_TIME_MS }
  const mobile = hostFor(memory, mobileClock, {
    localDeviceId: 'parity-device-0001',
    appInstanceId: 'parity-app-0001',
  })
  await mobile.start()

  assert.deepEqual(mobile.getProjection().shared, desktop.getProjection().shared)
  assert.equal(mobile.getProjection().gameTimeMs, desktop.getProjection().gameTimeMs)
  const command = { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 17 } }
  const desktopResult = await desktop.command(command, 'parity-op', 'owner')
  const mobileResult = await mobile.command(command, { opId: 'parity-op', role: 'owner' })
  assert.equal(desktopResult.outcome.ok, true)
  assert.equal(mobileResult.status, 'applied')
  assert.deepEqual(mobile.getProjection().shared, desktop.getProjection().shared)
  const desktopEvents = desktop.getRecentEvents().map(event => ({ eventSeq: event.eventSeq, type: event.type, payload: event.payload }))
  const mobileEvents = mobile.getRecentEvents().map(event => ({ eventSeq: event.eventSeq, type: event.type, payload: event.payload }))
  assert.deepEqual(mobileEvents, desktopEvents)

  desktopClock.value += 2 * 60_000
  mobileClock.value += 2 * 60_000
  await desktop.pump()
  await mobile.pump()
  assert.equal(mobile.getProjection().gameTimeMs, desktop.getProjection().gameTimeMs)
  assert.deepEqual(mobile.getProjection().shared, desktop.getProjection().shared)
  const desktopAfter = desktop.getRecentEvents().map(event => ({ eventSeq: event.eventSeq, type: event.type, payload: event.payload }))
  const mobileAfter = mobile.getRecentEvents().map(event => ({ eventSeq: event.eventSeq, type: event.type, payload: event.payload }))
  assert.deepEqual(mobileAfter, desktopAfter)
  await desktop.stop()
  await mobile.stop()
})

test('mobile bundles gate v2 explicitly; Android is a server client while iOS/Harmony hide server mode', async () => {
  const root = new URL('../../', import.meta.url)
  const sources = [
    'src/android/bridge.ts',
    'src/harmony/bridge.ts',
    'src/ios/bridge.ts',
  ]
  for (const relative of sources) {
    const source = readFileSync(new URL(relative, root), 'utf8')
    assert.match(source, /VITE_QQPET_LOCAL_RUNTIME_V2/, relative)
    assert.match(source, /localRepositoryV2/, relative)
    assert.match(source, /rendererCapability:\s*true/, relative)
    assert.match(source, /resolveMobileLegacyAuthority/, relative)
    assert.match(source, /legacyAuthorityProbe\.canUseLegacy|legacyAuthorityProbe\.v2DocumentPresent/, relative)
    assert.match(source, /legacyAuthorityDisabled/, relative)
    assert.match(source, /exportPortableBundleJson/, relative)
    assert.match(source, /importPortableBundleJson/, relative)
    assert.match(source, /QQPet-portable-/, relative)
    assert.doesNotMatch(source, /legacy save (?:export|import) is disabled while local runtime v2 is enabled/, relative)
  }

  // Android is the client-only server-mode host: it imports the shared remote
  // state machine through the mobile adapter, but the page itself never opens a
  // WebSocket (the transport is in src/shared/remote).
  const android = readFileSync(new URL('src/android/bridge.ts', root), 'utf8')
  assert.match(android, /createMobileServerRuntime/)
  assert.match(android, /serverModeClientOnly/)
  assert.match(android, /api\.storage = runtime\.storage/)
  assert.doesNotMatch(android, /new WebSocket/)
  assert.doesNotMatch(android, /remote-token\.bin/)

  // iOS and Harmony remain local-only hosts: no pairing, no WSS repository.
  for (const relative of ['src/harmony/bridge.ts', 'src/ios/bridge.ts']) {
    const source = readFileSync(new URL(relative, root), 'utf8')
    assert.match(source, /serverMode:\s*false/, relative)
    assert.doesNotMatch(source, /RemoteRepository|server-mode|new WebSocket|wss:\/\//, relative)
  }
  const core = readFileSync(new URL('src/shared/local-repository/host.ts', root), 'utf8')
  const coreCode = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(coreCode, /from ['"](?:node:|electron|\.\.\/\.\.\/main)/)
  assert.doesNotMatch(coreCode, /\b(?:window|localStorage|WebSocket|navigator|HTMLElement)\b/)
  const nativeRuntime = readFileSync(new URL('ios/native/QPHostController.m', root), 'utf8')
  assert.match(nativeRuntime, /readLocalStateFile/)
  assert.match(nativeRuntime, /writeLocalStateFileAtomic/)
  assert.match(nativeRuntime, /localRuntimeV2Storage/)
  const androidNative = readFileSync(new URL('android/app/src/main/java/net/ankio/qqpet/PetService.kt', root), 'utf8')
  assert.match(androidNative, /readStateFile/)
  assert.match(androidNative, /readLegacySave/)
  assert.match(androidNative, /ATOMIC_MOVE/)
  assert.match(androidNative, /"status", "error"/)
  const androidAllowlist = androidNative.slice(
    androidNative.indexOf('private fun allowedStateName'),
    androidNative.indexOf('private fun stateFile'),
  )
  assert.match(androidAllowlist, /save\.v2\.json/)
  assert.match(androidAllowlist, /save\.v2\.json\.bak/)
  assert.match(androidAllowlist, /save\.json\.bak/)
  assert.match(androidAllowlist, /save\.v2\.json\.corrupt-/)
  assert.match(androidAllowlist, /storage-config\.json/)
  assert.match(androidAllowlist, /sync-config\.json/)
  assert.match(androidAllowlist, /remote-projection-cache\.json/)
  assert.doesNotMatch(androidAllowlist, /"save\.json"/)
  assert.doesNotMatch(androidAllowlist, /remote-token\.bin/)
  assert.match(androidNative, /saveRemoteToken/)
  assert.match(androidNative, /loadRemoteToken/)
  assert.match(androidNative, /clearRemoteToken/)
  assert.match(androidNative, /removeStateFile/)
  assert.match(androidNative, /AndroidKeyStore/)

  const harmonyNative = readFileSync(new URL('harmony/entry/src/main/ets/pet/Native.ets', root), 'utf8')
  assert.match(harmonyNative, /readStateFile/)
  assert.match(harmonyNative, /readLegacySave/)
  assert.match(harmonyNative, /writeAtomic/)
  assert.match(harmonyNative, /this\.okRead\(null\)/)
  assert.match(harmonyNative, /this\.errorRead/)
  assert.match(harmonyNative, /fs\.accessSync\(path\)/)
  assert.match(harmonyNative, /fs\.fsyncSync\(file\.fd\)/)
  assert.match(harmonyNative, /fs\.fsyncSync\(parent\.fd\)/)
  const harmonyAllowlist = harmonyNative.slice(
    harmonyNative.indexOf('private validStateName'),
    harmonyNative.indexOf('private okRead'),
  )
  assert.match(harmonyAllowlist, /save\.v2\.json/)
  assert.match(harmonyAllowlist, /save\.v2\.json\.bak/)
  assert.match(harmonyAllowlist, /save\.json\.bak/)
  assert.match(harmonyAllowlist, /save\.v2\.json\.corrupt-/)
  assert.doesNotMatch(harmonyAllowlist, /'save\.json'/)

  assert.match(nativeRuntime, /QPLocalReadOK\(nil\)/)
  assert.match(nativeRuntime, /QPLocalReadError/)
  assert.match(nativeRuntime, /QPLocalReadFile\(\[self\.state path:name\]\)/)
  assert.match(nativeRuntime, /QPLegacySaveReadResult/)
  assert.match(nativeRuntime, /readLegacySave/)
  const iosAllowlist = nativeRuntime.slice(
    nativeRuntime.indexOf('static BOOL QPLocalStateName'),
    nativeRuntime.indexOf('static CGRect QPBox'),
  )
  assert.match(iosAllowlist, /save\.v2\.json/)
  assert.match(iosAllowlist, /save\.v2\.json\.bak/)
  assert.match(iosAllowlist, /save\.json\.bak/)
  assert.match(iosAllowlist, /save\.v2\.json\.corrupt-/)
  assert.doesNotMatch(iosAllowlist, /@"save\.json"/)
})

test('rejected commands persist idempotency without revision and duplicate retries do not reapply', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const before = host.getProjection()
  const rejected = await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 0 } },
    { opId: 'mobile-rejected-op', role: 'owner' },
  )
  assert.equal(rejected.status, 'rejected')
  assert.equal(host.getProjection().revision, before.revision)
  assert.equal(host.getDocument().revision, before.revision)
  assert.equal(host.getDocument().idempotency.records.some(record => record.opId === 'mobile-rejected-op'), true)
  const retry = await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 0 } },
    { opId: 'mobile-rejected-op', role: 'owner' },
  )
  assert.equal(retry.status, 'duplicate')
  assert.equal(retry.original, 'rejected')
  assert.equal(host.getDocument().idempotency.records.filter(record => record.opId === 'mobile-rejected-op').length, 1)
  await host.stop()
})

test('pending reopen startup caps crash coverage at heartbeat grace and retains one stable row', async () => {
  const document = JSON.parse(JSON.stringify(fixtures.localDocument))
  document.runtime = { appInstanceId: 'old-app-instance', startedAtWallMs: WALL_TIME_MS }
  document.bundle.engine.coverageReopen = {
    operationId: 'pending-operation',
    commitWallMs: WALL_TIME_MS + 1_000,
    survivors: [{
      kind: 'local_app',
      appInstanceId: 'old-app-instance',
      localDeviceId: document.device.localDeviceId,
      lastHeartbeatWallMs: WALL_TIME_MS,
      eligible: true,
    }],
    state: 'pending',
  }
  document.bundle.engine.sessionCoverage[0].disconnectedAtWallMs = WALL_TIME_MS + 1_000
  document.bundle.engine.sessionCoverage[0].closeReason = 'pet_reset'
  document.bundle.engine.sessionCoverage[0].lastHeartbeatWallMs = WALL_TIME_MS
  const memory = memoryFiles({ 'save.v2.json': JSON.stringify(document) })
  const clock = { value: WALL_TIME_MS + 120_000 }
  const host = hostFor(memory, clock)
  assert.ok(await host.start(), host.getStatus().error)
  const repaired = host.getDocument()
  assert.equal(repaired.bundle.engine.coverageReopen, undefined)
  const rows = repaired.bundle.engine.sessionCoverage.filter(interval =>
    interval.coverageId === 'pending-operation:old-app-instance')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].connectedAtWallMs, WALL_TIME_MS + 1_000)
  assert.equal(rows[0].disconnectedAtWallMs, WALL_TIME_MS + 60_000)
  assert.equal(rows[0].closeReason, 'crash_repaired')
  assert.equal(repaired.bundle.engine.sessionCoverage.at(-1).connectedAtWallMs, WALL_TIME_MS + 120_000)
  await host.stop()
})

test('full closed-app catch-up advances game world but not session-clock online time', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const first = hostFor(memory, clock)
  const started = await first.start()
  const gameBefore = started.gameTimeMs
  const onlineBefore = started.shared.petInfo.onLineTime
  await first.stop()
  clock.value += 2 * 60_000
  const restarted = hostFor(memory, clock)
  const resumed = await restarted.start()
  assert.ok(resumed)
  assert.equal(resumed.gameTimeMs, gameBefore + 2 * 60_000)
  assert.equal(resumed.shared.petInfo.onLineTime, onlineBefore)
  await restarted.stop()
})

test('one-second scheduler polls do not consume partial minutes', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  const started = await host.start()
  clock.value += 1_000
  await host.pump()
  assert.equal(host.getProjection().gameTimeMs, started.gameTimeMs)
  assert.equal(host.getDocument().bundle.engine.lastSchedulerWallMs, WALL_TIME_MS)
  clock.value += 29_000
  await host.pump()
  assert.equal(host.getProjection().gameTimeMs, started.gameTimeMs)
  assert.equal(host.getDocument().bundle.engine.lastSchedulerWallMs, WALL_TIME_MS)
  clock.value += 30_000
  await host.pump()
  assert.equal(host.getProjection().gameTimeMs, started.gameTimeMs + 60_000)
  assert.equal(host.getDocument().bundle.engine.lastSchedulerWallMs, WALL_TIME_MS + 60_000)
  await host.stop()
})

test('atomic write failure fails closed and never advances command or scheduler state', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  let failWrites = false
  const storage = {
    ...memory.storage,
    async writeDocumentAtomic(text) {
      if (failWrites) throw new Error('disk full')
      await memory.storage.writeDocumentAtomic(text)
    },
  }
  const activationValue = { devRuntimeFlag: true, rendererCapability: true, storage: storage.capability }
  const clock = { value: WALL_TIME_MS }
  const host = createLocalRepositoryHost({
    storage,
    nowMs: () => clock.value,
    randomUUID: ids(),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    autoScheduler: false,
  }, activationValue)
  await host.start()
  const before = host.getDocument()
  failWrites = true
  const result = await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 9 } },
    { opId: 'mobile-write-failure', role: 'owner' },
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.error.code, 'internal')
  assert.equal(host.getStatus().state, 'read_only')
  assert.equal(host.getDocument().revision, before.revision)
  assert.equal(host.getDocument().idempotency.records.some(record => record.opId === 'mobile-write-failure'), false)
  clock.value += 120_000
  await host.pump()
  assert.equal(host.getDocument().bundle.engine.gameTimeMs, before.bundle.engine.gameTimeMs)
  failWrites = false
})

test('corrupt legacy and v2 bytes are preserved before fail-closed read-only status', async () => {
  const legacy = '{broken-legacy'
  const legacyMemory = memoryFiles({ 'save.json': legacy })
  const clock = { value: WALL_TIME_MS }
  const legacyHost = hostFor(legacyMemory, clock)
  assert.equal(await legacyHost.start(), null)
  assert.equal(legacyHost.getStatus().state, 'read_only')
  assert.match(legacyHost.getStatus().error, /not valid JSON/)
  assert.equal(legacyMemory.files.get('save.json'), legacy)
  assert.equal(legacyMemory.files.get('save.json.bak'), legacy)

  const documentText = '{broken-v2'
  const documentMemory = memoryFiles({ 'save.v2.json': documentText })
  const documentHost = hostFor(documentMemory, clock)
  assert.equal(await documentHost.start(), null)
  assert.equal(documentHost.getStatus().state, 'read_only')
  assert.match(documentHost.getStatus().error, /not valid JSON/)
  assert.equal(documentMemory.files.get('save.v2.json'), documentText)
  assert.equal(documentMemory.files.get('save.v2.json.bak'), documentText)
  assert.equal(documentMemory.files.get('save.v2.json.corrupt-1'), documentText)
})

test('scheduler timers are injected, started after load, and cleared on stop', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  let tick = null
  let intervalMs = 0
  let cleared = 0
  const host = hostFor(memory, clock, {
    autoScheduler: true,
    pollIntervalMs: 5_000,
    timer: {
      start(callback, interval) { tick = callback; intervalMs = interval; return 42 },
      clear(handle) { assert.equal(handle, 42); cleared += 1 },
    },
  })
  const started = await host.start()
  assert.equal(host.isSchedulerRunning(), true)
  assert.equal(intervalMs, 5_000)
  clock.value += 60_000
  tick()
  for (let attempt = 0; attempt < 20 && host.getProjection().gameTimeMs === started.gameTimeMs; attempt++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(host.getProjection().gameTimeMs, started.gameTimeMs + 60_000)
  await host.stop()
  assert.equal(host.isSchedulerRunning(), false)
  assert.equal(cleared, 1)
})

test('local session actor and every coverage row use the canonical device.localDeviceId', async () => {
  const playable = JSON.parse(JSON.stringify(fixtures.save))
  playable.petInfo.growth = 100_000
  playable.petComputedlInfo.level = 20
  const memory = memoryFiles({ 'save.json': JSON.stringify(playable) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const document = host.getDocument()
  const localDeviceId = document.device.localDeviceId
  assert.equal(host.currentDeviceId, localDeviceId)
  assert.equal(document.bundle.originLocalDeviceId, localDeviceId)
  assert.equal(document.bundle.engine.sessionCoverage.every(interval => interval.deviceId === localDeviceId), true)
  const result = await host.command(
    { type: 'game.startSession', payload: { gameId: 'mobile-parity-game', kind: 'small' } },
    { opId: 'mobile-session-actor-op', role: 'owner' },
  )
  assert.equal(result.status, 'applied', JSON.stringify(result))
  const session = host.getDocument().bundle.engine.gameSessions
    .find(item => item.status === 'active' && item.payload.kind === 'game' && item.payload.gameId === 'mobile-parity-game')
  assert.ok(session)
  assert.equal(session.actorDeviceId, localDeviceId)
  assert.equal(session.sessionToken, result.result.sessionToken)
  await host.stop()
})

test('catch-up yields between bounded chunks and commits one revision per chunk', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  let yields = 0
  const host = hostFor(memory, clock, {
    maxChunkTicks: 1,
    yieldToEventLoop: async () => { yields += 1 },
  })
  const started = await host.start()
  const revision = host.getDocument().revision
  clock.value += 2 * 60_000
  await host.pump()
  assert.equal(host.getProjection().gameTimeMs, started.gameTimeMs + 2 * 60_000)
  assert.ok(yields >= 1)
  assert.ok(host.getDocument().revision >= revision + 2)
  await host.stop()
})

test('opId replay requires active authority, matching scope and matching command type', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const first = await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 4 } },
    { opId: 'op-conflict', role: 'owner' },
  )
  assert.equal(first.status, 'applied')
  const revision = host.getDocument().revision
  const conflict = await host.command(
    { type: 'pet.cheer', payload: {} },
    { opId: 'op-conflict', role: 'owner' },
  )
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.error.code, 'op_id_conflict')
  assert.equal(host.getDocument().revision, revision)
  assert.equal(host.getDocument().idempotency.records.filter(record => record.opId === 'op-conflict').length, 1)
  await host.stop()

  const scoped = JSON.parse(memory.files.get('save.v2.json'))
  scoped.idempotency.records[0].petId = 'another-pet-scope'
  memory.files.set('save.v2.json', JSON.stringify(scoped))
  const scopedHost = hostFor(memory, clock)
  await scopedHost.start()
  const scopeConflict = await scopedHost.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 4 } },
    { opId: 'op-conflict', role: 'owner' },
  )
  assert.equal(scopeConflict.status, 'rejected')
  assert.equal(scopeConflict.error.code, 'op_id_conflict')
  assert.equal(scopedHost.getDocument().idempotency.records[0].petId, 'another-pet-scope')
  await scopedHost.stop()

  const readOnlyDocument = JSON.parse(memory.files.get('save.v2.json'))
  readOnlyDocument.authority.state = 'handoff_pending'
  memory.files.set('save.v2.json', JSON.stringify(readOnlyDocument))
  const readOnlyHost = hostFor(memory, clock)
  assert.ok(await readOnlyHost.load())
  assert.equal(readOnlyHost.getStatus().readOnly, true)
  const blocked = await readOnlyHost.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 4 } },
    { opId: 'op-conflict', role: 'owner' },
  )
  assert.equal(blocked.status, 'rejected')
  assert.equal(blocked.error.code, 'authority_not_active')
  assert.notEqual(blocked.status, 'duplicate')
})

test('event history persists commit revision and game time across restart', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 6 } },
    { opId: 'op-event-metadata', role: 'owner' },
  )
  clock.value += 2 * 60_000
  await host.pump()
  const before = host.getRecentEvents()
  assert.ok(before.length > 0)
  assert.equal(before.every(event => Number.isSafeInteger(event.revision) && Number.isSafeInteger(event.gameTimeMs)), true)
  const stored = JSON.parse(memory.files.get('save.v2.json')).eventHistory
  assert.deepEqual(
    stored.map(event => ({ eventSeq: event.eventSeq, revision: event.revision, gameTimeMs: event.gameTimeMs, type: event.type, payload: event.payload })),
    before.map(event => ({ eventSeq: event.eventSeq, revision: event.revision, gameTimeMs: event.gameTimeMs, type: event.type, payload: event.payload })),
  )
  await host.stop()
  const restarted = hostFor(memory, clock)
  await restarted.start()
  assert.deepEqual(restarted.getRecentEvents(), before)
  await restarted.stop()
})

test('valid v2 documents lacking idempotency or event metadata are backed up before rewrite', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const first = hostFor(memory, clock)
  await first.start()
  await first.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 8 } },
    { opId: 'op-before-metadata-migration', role: 'owner' },
  )
  await first.stop()
  const oldDocument = JSON.parse(memory.files.get('save.v2.json'))
  oldDocument.eventHistory = oldDocument.eventHistory.map(event => ({
    eventSeq: event.eventSeq,
    type: event.type,
    payload: event.payload,
  }))
  delete oldDocument.idempotency
  const oldText = JSON.stringify(oldDocument, null, 2)
  memory.files.set('save.v2.json', oldText)
  const migrated = hostFor(memory, clock)
  assert.ok(await migrated.start(), migrated.getStatus().error)
  assert.equal(memory.files.get('save.v2.json.bak'), oldText)
  const rewritten = JSON.parse(memory.files.get('save.v2.json'))
  assert.equal(rewritten.idempotency.schemaVersion, 2)
  assert.equal(rewritten.eventHistory.every(event => Number.isSafeInteger(event.revision) && Number.isSafeInteger(event.gameTimeMs)), true)
  await migrated.stop()
})

test('portable bundle export/import atomically restores engine state with a pre-import backup', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 5 } },
    { opId: 'op-export-state', role: 'owner' },
  )
  const exported = host.exportPortableBundleJson()
  assert.ok(exported)
  const parsed = JSON.parse(exported)
  assert.equal(parsed.format, 'qqpet-portable-v1')
  assert.equal(typeof parsed.shared.petInfo.yb, 'number')
  const ybAtExport = parsed.shared.petInfo.yb
  await host.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 30 } },
    { opId: 'op-import-replaces', role: 'owner' },
  )
  const beforeImportText = memory.files.get('save.v2.json')
  const beforeImport = JSON.parse(beforeImportText)
  const imported = await host.importPortableBundle(exported, { opId: 'op-import-bundle' })
  assert.equal(imported.shared.petInfo.yb, ybAtExport)
  assert.equal(imported.authority.stamp.epoch, beforeImport.authority.stamp.epoch + 1)
  assert.equal(memory.files.get('save.v2.json.bak'), beforeImportText)
  const document = host.getDocument()
  assert.equal(document.idempotency.records.some(record => record.opId === 'op-import-bundle' && record.commandType === 'admin.importPortableBundle'), true)
  assert.equal(document.bundle.engine.sessionCoverage.filter(interval => interval.disconnectedAtWallMs === undefined).length, 1)
  assert.equal(document.bundle.engine.sessionCoverage.every(interval => interval.deviceId === host.currentDeviceId), true)
  assert.equal(document.bundle.engine.coverageReopen, undefined)
  assert.deepEqual(host.getRecentEvents(), [])
  const duplicate = await host.importPortableBundle(exported, { opId: 'op-import-bundle' })
  assert.equal(duplicate.revision, imported.revision)
  await host.stop()
})

test('failed portable import leaves the existing v2 document and projection unchanged', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const beforeText = memory.files.get('save.v2.json')
  const before = host.getProjection()
  await assert.rejects(host.importPortableBundle('{not-json', { opId: 'op-bad-import' }), /not valid JSON/)
  assert.equal(memory.files.get('save.v2.json'), beforeText)
  assert.deepEqual(host.getProjection(), before)
  assert.equal(host.getStatus().state, 'ready')
  await host.stop()
})

test('portable export/import bridge round-trip works through Android, Harmony and iOS storage adapters', async () => {
  const cases = []
  const androidFiles = new Map([['save.json', JSON.stringify(fixtures.save)]])
  cases.push({
    name: 'android',
    storage: androidLocalRepositoryStorage({
      readStateFile: name => JSON.stringify({ status: 'ok', text: androidFiles.has(name) ? androidFiles.get(name) : null }),
      readLegacySave: () => JSON.stringify({ status: 'ok', text: androidFiles.has('save.json') ? androidFiles.get('save.json') : null }),
      writeAtomic: (name, text) => { androidFiles.set(name, text); return true },
    }),
    files: androidFiles,
  })
  const harmonyFiles = new Map([['save.json', JSON.stringify(fixtures.save)]])
  cases.push({
    name: 'harmony',
    storage: harmonyLocalRepositoryStorage({
      readStateFile: name => JSON.stringify({ status: 'ok', text: harmonyFiles.has(name) ? harmonyFiles.get(name) : null }),
      readLegacySave: () => JSON.stringify({ status: 'ok', text: harmonyFiles.has('save.json') ? harmonyFiles.get('save.json') : null }),
      writeAtomic: (name, text) => { harmonyFiles.set(name, text); return true },
    }),
    files: harmonyFiles,
  })
  const iosFiles = new Map([['save.json', JSON.stringify(fixtures.save)]])
  cases.push({
    name: 'ios',
    storage: iosLocalRepositoryStorage({
      async request(op, args) {
        if (op === 'readLocalStateFile') return { status: 'ok', text: iosFiles.has(args.name) ? iosFiles.get(args.name) : null }
        if (op === 'readLegacySave') return { status: 'ok', text: iosFiles.has('save.json') ? iosFiles.get('save.json') : null }
        if (op === 'writeLocalStateFileAtomic') { iosFiles.set(args.name, args.text); return true }
        throw new Error('unexpected RPC ' + op)
      },
    }),
    files: iosFiles,
  })
  for (const entry of cases) {
    const clock = { value: WALL_TIME_MS }
    const bridge = createMobileLocalRepositoryBridge({
      storage: entry.storage,
      devRuntimeFlag: true,
      rendererCapability: true,
      nowMs: () => clock.value,
      randomUUID: ids(),
      seedHex: SEED,
      timeZone: 'Asia/Shanghai',
      localDeviceId: 'bridge-import-device-' + entry.name,
      appInstanceId: 'bridge-import-app-' + entry.name,
      autoScheduler: false,
    })
    const initial = await bridge.load()
    await bridge.command(
      { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 7 } },
      { opId: 'bridge-export-op-' + entry.name },
    )
    const firstState = bridge.getProjection().shared.petInfo.yb
    const exported = await bridge.exportPortableBundleJson()
    assert.equal(JSON.parse(exported).format, 'qqpet-portable-v1', entry.name)
    await bridge.command(
      { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 23 } },
      { opId: 'bridge-after-export-op-' + entry.name },
    )
    assert.equal(bridge.getProjection().shared.petInfo.yb, firstState + 23, entry.name)
    const beforeImport = entry.files.get('save.v2.json')
    const restored = await bridge.importPortableBundleJson(exported)
    assert.equal(restored.petInfo.yb, firstState, entry.name)
    assert.equal(bridge.getProjection().shared.petInfo.yb, firstState, entry.name)
    assert.equal(entry.files.get('save.v2.json.bak'), beforeImport, entry.name)
    assert.equal(initial.havePet, true)
    await bridge.stop()
  }
})

test('state read errors are not treated as missing and never overwrite existing v2 bytes', async () => {
  const cases = []
  {
    const files = new Map([['save.v2.json', '{"existing":true}']])
    let writes = 0
    cases.push({
      name: 'android',
      files,
      writes: () => writes,
      storage: androidLocalRepositoryStorage({
        readStateFile: name => name === 'save.v2.json'
          ? JSON.stringify({ status: 'error', error: 'EACCES state unreadable' })
          : JSON.stringify({ status: 'ok', text: files.has(name) ? files.get(name) : null }),
        readLegacySave: () => JSON.stringify({ status: 'ok', text: files.has('save.json') ? files.get('save.json') : null }),
        writeAtomic: (name, text) => { writes += 1; files.set(name, text); return true },
      }),
    })
  }
  {
    const files = new Map([['save.v2.json', '{"existing":true}']])
    let writes = 0
    cases.push({
      name: 'harmony',
      files,
      writes: () => writes,
      storage: harmonyLocalRepositoryStorage({
        readStateFile: name => name === 'save.v2.json'
          ? JSON.stringify({ status: 'error', error: 'EACCES state unreadable' })
          : JSON.stringify({ status: 'ok', text: files.has(name) ? files.get(name) : null }),
        readLegacySave: () => JSON.stringify({ status: 'ok', text: files.has('save.json') ? files.get('save.json') : null }),
        writeAtomic: (name, text) => { writes += 1; files.set(name, text); return true },
      }),
    })
  }
  {
    const files = new Map([['save.v2.json', '{"existing":true}']])
    let writes = 0
    cases.push({
      name: 'ios',
      files,
      writes: () => writes,
      storage: iosLocalRepositoryStorage({
        async request(op, args) {
          if (op === 'readLocalStateFile') return args.name === 'save.v2.json'
            ? { status: 'error', error: 'EACCES state unreadable' }
            : { status: 'ok', text: files.has(args.name) ? files.get(args.name) : null }
          if (op === 'readLegacySave') return { status: 'ok', text: files.has('save.json') ? files.get('save.json') : null }
          if (op === 'writeLocalStateFileAtomic') { writes += 1; files.set(args.name, args.text); return true }
          throw new Error('unexpected RPC ' + op)
        },
      }),
    })
  }
  for (const entry of cases) {
    const clock = { value: WALL_TIME_MS }
    const host = hostFor({ storage: entry.storage }, clock)
    assert.equal(await host.start(), null, entry.name)
    assert.equal(host.getStatus().state, 'read_only', entry.name)
    assert.match(host.getStatus().error, /EACCES state unreadable/, entry.name)
    assert.equal(entry.files.get('save.v2.json'), '{"existing":true}', entry.name)
    assert.equal(entry.writes(), 0, entry.name)
  }
})

test('legacy read errors do not create a fresh v2 document', async () => {
  const cases = []
  {
    const files = new Map([['save.json', '{"existing":true}']])
    let writes = 0
    cases.push({
      name: 'android',
      writes: () => writes,
      storage: androidLocalRepositoryStorage({
        readStateFile: name => JSON.stringify({ status: 'ok', text: files.has(name) ? files.get(name) : null }),
        readLegacySave: () => JSON.stringify({ status: 'error', error: 'EACCES legacy unreadable' }),
        writeAtomic: (name, text) => { writes += 1; files.set(name, text); return true },
      }),
    })
  }
  {
    const files = new Map([['save.json', '{"existing":true}']])
    let writes = 0
    cases.push({
      name: 'harmony',
      writes: () => writes,
      storage: harmonyLocalRepositoryStorage({
        readStateFile: name => JSON.stringify({ status: 'ok', text: files.has(name) ? files.get(name) : null }),
        readLegacySave: () => JSON.stringify({ status: 'error', error: 'EACCES legacy unreadable' }),
        writeAtomic: (name, text) => { writes += 1; files.set(name, text); return true },
      }),
    })
  }
  {
    const files = new Map([['save.json', '{"existing":true}']])
    let writes = 0
    cases.push({
      name: 'ios',
      writes: () => writes,
      storage: iosLocalRepositoryStorage({
        async request(op, args) {
          if (op === 'readLocalStateFile') return { status: 'ok', text: files.has(args.name) ? files.get(args.name) : null }
          if (op === 'readLegacySave') return { status: 'error', error: 'EACCES legacy unreadable' }
          if (op === 'writeLocalStateFileAtomic') { writes += 1; files.set(args.name, args.text); return true }
          throw new Error('unexpected RPC ' + op)
        },
      }),
    })
  }
  for (const entry of cases) {
    const clock = { value: WALL_TIME_MS }
    const host = hostFor({ storage: entry.storage }, clock)
    assert.equal(await host.start(), null, entry.name)
    assert.equal(host.getStatus().state, 'read_only', entry.name)
    assert.match(host.getStatus().error, /EACCES legacy unreadable/, entry.name)
    assert.equal(entry.writes(), 0, entry.name)
  }
})

test('portable import migrates a bare legacy save through the same backup/atomic path', async () => {
  const memory = memoryFiles({ 'save.json': JSON.stringify(fixtures.save) })
  const clock = { value: WALL_TIME_MS }
  const host = hostFor(memory, clock)
  await host.start()
  const beforeText = memory.files.get('save.v2.json')
  const imported = await host.importPortableBundle(JSON.stringify(fixtures.save), { opId: 'op-import-bare-save' })
  assert.equal(imported.shared.havePet, fixtures.save.havePet)
  assert.equal(memory.files.get('save.v2.json.bak'), beforeText)
  const document = host.getDocument()
  assert.equal(document.bundle.format, 'qqpet-portable-v1')
  assert.equal(document.idempotency.records[0].opId, 'op-import-bare-save')
  assert.equal(document.bundle.engine.sessionCoverage.filter(interval => interval.disconnectedAtWallMs === undefined).length, 1)
  await host.stop()
})

test('flag-off legacy routing decodes native v2 presence for Android, Harmony and iOS mocks', async () => {
  const hosts = [
    {
      name: 'android',
      encoding: 'encoded-json',
      encode: result => JSON.stringify(result),
    },
    {
      name: 'harmony',
      encoding: 'encoded-json',
      encode: result => JSON.stringify(result),
    },
    {
      name: 'ios',
      encoding: 'object',
      encode: result => result,
    },
  ]
  for (const host of hosts) {
    const startup = rawResult => {
      const gate = resolveMobileLegacyAuthority({
        devRuntimeFlag: false,
        readCapability: true,
        readResult: host.encode(rawResult),
        encoding: host.encoding,
      })
      let legacyWrites = 0
      if (gate.canUseLegacy) legacyWrites += 1
      return { gate, legacyWrites }
    }

    const missing = startup({ status: 'ok', text: null })
    assert.equal(missing.gate.v2DocumentPresent, false, host.name)
    assert.equal(missing.gate.legacyDisabled, false, host.name)
    assert.equal(missing.gate.canUseLegacy, true, host.name)
    assert.equal(missing.legacyWrites, 1, host.name)

    const present = startup({ status: 'ok', text: '{"format":"qqpet-local-v2"}' })
    assert.equal(present.gate.v2DocumentPresent, true, host.name)
    assert.equal(present.gate.legacyDisabled, true, host.name)
    assert.equal(present.gate.canUseLegacy, false, host.name)
    assert.match(present.gate.failure, /enable the explicit v2 flag/, host.name)
    assert.equal(present.legacyWrites, 0, host.name)

    const unreadable = startup({ status: 'error', error: 'EACCES state unreadable' })
    assert.equal(unreadable.gate.v2DocumentPresent, false, host.name)
    assert.equal(unreadable.gate.legacyDisabled, true, host.name)
    assert.equal(unreadable.gate.canUseLegacy, false, host.name)
    assert.match(unreadable.gate.error, /EACCES state unreadable/, host.name)
    assert.match(unreadable.gate.failure, /presence check failed/, host.name)
    assert.equal(unreadable.legacyWrites, 0, host.name)

    const oldShell = resolveMobileLegacyAuthority({
      devRuntimeFlag: false,
      readCapability: false,
      encoding: host.encoding,
    })
    assert.equal(oldShell.canUseLegacy, true, host.name)
    assert.equal(oldShell.legacyDisabled, false, host.name)
  }
})
