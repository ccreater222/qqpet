import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts')
    }
    return nextResolve(specifier)
  },
  load(url, context, nextLoad) {
    // The storage pane only needs its pure refresh planner; stub the DOM dialog
    // module so Node never evaluates renderer DOM/CSS imports.
    if (url.endsWith('/renderer/ui/window-view.ts')) {
      return { format: 'module', shortCircuit: true, source: 'export function windowView() {}\n' }
    }
    return nextLoad(url, context)
  },
})

const { createMobileServerRuntime } = await import('../../src/mobile/server-mode.ts')
const { planStorageRefresh } = await import('../../src/renderer/ui/storage.ts')
const { createSyncFixtures, GAME_TIME_MS } = await import('./sync-fixtures.mjs')
const { PROTOCOL_VERSION, SAVE_SCHEMA_VERSION } = await import('../../src/shared/sync/index.ts')

const fixtures = createSyncFixtures()
const SERVER_URL = 'ws://127.0.0.1:8787/v1/sync'
const PET_ID = 'pet-0001'
const DEVICE_ID = 'server-device-0001'
const AUTHORITY = fixtures.remoteCache.authority

function syncConfigJson() {
  return JSON.stringify({ serverUrl: SERVER_URL, petId: PET_ID, deviceId: DEVICE_ID, lastRevision: 0, lastEventSeq: 0 })
}

function storageConfigJson(mode) {
  return JSON.stringify({ format: 'qqpet-storage-config', schemaVersion: 1, mode, serverUrl: SERVER_URL, deviceLabel: 'Android' })
}

function welcomeFrame(issuedToken) {
  return {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    requestId: 'welcome-1',
    connectionId: 'connection-1',
    petId: PET_ID,
    deviceId: DEVICE_ID,
    deviceRole: 'player',
    protocolVersion: PROTOCOL_VERSION,
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    serverTimeMs: GAME_TIME_MS,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: { ...AUTHORITY },
    headRevision: 3,
    headEventSeq: 4,
    catchingUp: false,
    delivery: 'snapshot',
    ...(issuedToken === undefined ? {} : { issuedToken }),
  }
}

function snapshotFrame() {
  return {
    t: 'snapshot',
    v: PROTOCOL_VERSION,
    revision: 3,
    eventSeq: 4,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: { ...AUTHORITY },
    save: fixtures.remoteCache.shared,
  }
}

function readyFrame() {
  return {
    t: 'ready',
    v: PROTOCOL_VERSION,
    revision: 3,
    eventSeq: 4,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: { ...AUTHORITY },
    catchingUp: false,
  }
}

function commandResultFrame(hello, command) {
  return {
    t: 'commandResult',
    v: PROTOCOL_VERSION,
    requestId: command.requestId,
    opId: command.opId,
    commandType: command.command.type,
    status: 'applied',
    commandSeq: 1,
    revision: 4,
    eventSeq: 5,
    result: {},
  }
}

/** A minimal in-process server: only the frames this host needs. */
function fakeTransport({ open = true, online = true } = {}) {
  return {
    connect(_url, _token, handlers) {
      let closed = false
      if (open) queueMicrotask(() => { if (!closed) handlers.onOpen() })
      return {
        send(data) {
          if (closed) return
          const frame = JSON.parse(data)
          if (frame.t === 'hello') {
            queueMicrotask(() => {
              if (closed) return
              if (online === false) return
              handlers.onMessage(JSON.stringify(welcomeFrame(frame.auth.kind === 'pairing' ? 'android-token-1' : undefined)))
              handlers.onMessage(JSON.stringify(snapshotFrame()))
              handlers.onMessage(JSON.stringify(readyFrame()))
            })
          } else if (frame.t === 'command') {
            queueMicrotask(() => {
              if (closed) return
              handlers.onMessage(JSON.stringify(commandResultFrame(null, frame)))
            })
          } else if (frame.t === 'resync') {
            queueMicrotask(() => {
              if (closed) return
              handlers.onMessage(JSON.stringify(snapshotFrame()))
              handlers.onMessage(JSON.stringify(readyFrame()))
            })
          }
        },
        close() { closed = true },
      }
    },
  }
}

function memoryNative() {
  const files = new Map()
  let token = null
  const encode = (text) => JSON.stringify({ status: 'ok', text })
  return {
    files,
    get token() { return token },
    read: (name) => files.get(name),
    readStateFile: (name) => encode(files.has(name) ? files.get(name) : null),
    writeAtomic: (name, text) => { files.set(name, text); return true },
    removeStateFile: (name) => { files.delete(name); return true },
    saveRemoteToken: (value) => { token = value; return true },
    loadRemoteToken: () => encode(token),
    clearRemoteToken: () => { token = null; return true },
  }
}

function localStatus() {
  return {
    mode: 'local',
    connection: 'local',
    revision: 1,
    eventSeq: 1,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: { owner: 'local', authorityId: 'local-authority', restoreGeneration: 0, epoch: 0, state: 'active' },
    readOnly: false,
    catchingUp: false,
    state: 'ready',
    serverMode: false,
  }
}

function memoryLocal() {
  let started = false
  let suspended = false
  let loadCalls = 0
  let lastLoadedSave = null
  let projectionListener = null
  let resyncListener = null
  let commandListener = null
  let statusListener = null
  return {
    get started() { return started },
    get suspended() { return suspended },
    get loadCalls() { return loadCalls },
    get lastLoadedSave() { return lastLoadedSave },
    async load() {
      loadCalls += 1
      started = true
      // The real MobileLocalRepositoryBridge.load() returns a fresh JSON clone;
      // identity of this object exposes any extra runtime-level clone.
      lastLoadedSave = JSON.parse(JSON.stringify(fixtures.save))
      return lastLoadedSave
    },
    async command() { return { status: 'applied', commandType: 'pet.cheer', opId: 'local-op', commandSeq: 1, revision: 2, eventSeq: 2, result: {} } },
    async setAdvanceWhileEmpty() {},
    async exportPortableBundleJson() { return JSON.stringify(fixtures.bundle) },
    async importPortableBundleJson() { return fixtures.save },
    async flush() {},
    async suspend() { suspended = true },
    async resume() { suspended = false },
    async stop() {},
    async pump() {},
    runtimeInfo: () => ({ localRepositoryV2: true, serverMode: false }),
    localSettings: {
      async load() { return fixtures.device },
      async update() { return fixtures.device },
    },
    getProjection: () => null,
    getStatus: () => localStatus(),
    getRecentEvents: () => [],
    onProjection(listener) { projectionListener = listener },
    onResync(listener) { resyncListener = listener },
    onCommandResult(listener) { commandListener = listener },
    onSyncStatus(listener) { statusListener = listener },
    requestResync() {},
    emitProjection() { projectionListener?.({}, []) },
    emitStatus() { statusListener?.(localStatus()) },
  }
}

test('Android server mode pairs, loads a server projection and routes a player command', async () => {
  const native = memoryNative()
  const local = memoryLocal()
  const runtime = createMobileServerRuntime({
    local,
    native,
    appVersion: 'test/0.0.1',
    transport: fakeTransport(),
    connectTimeoutMs: 200,
    pairTimeoutMs: 500,
  })
  const status = await runtime.storage.pair({ serverUrl: SERVER_URL, code: 'QQP-test', deviceLabel: 'Android' })
  assert.equal(status.activeMode, 'server')
  assert.equal(status.paired, true)
  assert.equal(status.deviceRole, 'player')
  assert.equal(status.petId, PET_ID)
  assert.equal(typeof native.token, 'string')
  assert.equal(runtime.runtimeInfo().serverMode, true)
  const save = await runtime.load()
  assert.equal(save.havePet, true)
  assert.equal(runtime.getProjection()?.revision, 3)
  const result = await runtime.command({ type: 'pet.cheer', payload: {} })
  assert.equal(result.status, 'applied')
  assert.equal(result.revision, 4)
  await runtime.stop()
})

test('restart reuses the persisted token and projection cache', async () => {
  const native = memoryNative()
  const local = memoryLocal()
  const first = createMobileServerRuntime({ local, native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 200, pairTimeoutMs: 500 })
  await first.storage.pair({ serverUrl: SERVER_URL, code: 'QQP-test', deviceLabel: 'Android' })
  await first.load()
  await first.stop()
  assert.equal(typeof native.token, 'string')
  assert.ok(native.files.has('sync-config.json'))
  assert.ok(native.files.has('remote-projection-cache.json'))

  const second = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport({ online: false }), connectTimeoutMs: 50 })
  const save = await second.load()
  assert.equal(second.runtimeInfo().serverMode, true)
  assert.equal(second.storage.status ? (await second.storage.status()).paired : false, true)
  assert.equal(save.havePet, true)
  await second.stop()
})

test('server mode without a cache falls back to the local pet and preserves pairing', async () => {
  const native = memoryNative()
  native.saveRemoteToken('android-token-1')
  native.writeAtomic('sync-config.json', JSON.stringify({ serverUrl: SERVER_URL, petId: PET_ID, deviceId: DEVICE_ID, lastRevision: 0, lastEventSeq: 0 }))
  native.writeAtomic('storage-config.json', JSON.stringify({ format: 'qqpet-storage-config', schemaVersion: 1, mode: 'server', serverUrl: SERVER_URL, deviceLabel: 'Android' }))
  const local = memoryLocal()
  const runtime = createMobileServerRuntime({ local, native, appVersion: 'test', transport: fakeTransport({ online: false }), connectTimeoutMs: 50 })
  const save = await runtime.load()
  assert.equal(save.havePet, true)
  const status = await runtime.storage.status()
  assert.equal(status.activeMode, 'local')
  assert.equal(status.paired, true)
  assert.match(status.notice ?? '', /离线/)
  assert.equal(status.mode, 'local')
  await runtime.stop()
})

test('an unreadable Keystore token keeps the persisted server mode and retries on the next start', async () => {
  const native = memoryNative()
  native.saveRemoteToken('android-token-1')
  native.writeAtomic('sync-config.json', syncConfigJson())
  native.writeAtomic('storage-config.json', storageConfigJson('server'))
  native.loadRemoteToken = () => JSON.stringify({ status: 'error', error: 'keystore decrypt failed' })
  const first = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 50 })
  const save = await first.load()
  assert.equal(save.havePet, true, 'this run falls back to the local pet')
  const status = await first.storage.status()
  assert.equal(status.activeMode, 'local')
  assert.equal(status.mode, 'server', 'the requested mode must stay server after a transient read failure')
  assert.match(status.lastError ?? '', /keystore decrypt failed/)
  assert.match(status.notice ?? '', /不可读/)
  assert.equal(JSON.parse(native.files.get('storage-config.json')).mode, 'server', 'startup must not persist a local downgrade')
  await first.stop()

  // Once the Keystore recovers, the same persisted mode=server is retried at startup.
  native.loadRemoteToken = () => JSON.stringify({ status: 'ok', text: 'android-token-1' })
  const second = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 200 })
  await second.load()
  assert.equal(second.runtimeInfo().serverMode, true)
  assert.equal((await second.storage.status()).activeMode, 'server')
  await second.stop()
})

test('a corrupt sync config keeps the persisted server mode for the next retry', async () => {
  const native = memoryNative()
  native.saveRemoteToken('android-token-1')
  native.writeAtomic('sync-config.json', '{"serverUrl":')
  native.writeAtomic('storage-config.json', storageConfigJson('server'))
  const runtime = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 50 })
  const save = await runtime.load()
  assert.equal(save.havePet, true)
  const status = await runtime.storage.status()
  assert.equal(status.activeMode, 'local')
  assert.equal(status.mode, 'server')
  assert.match(status.lastError ?? '', /state_corrupt/)
  assert.equal(JSON.parse(native.files.get('storage-config.json')).mode, 'server')
  await runtime.stop()
})

test('a corrupt storage config is surfaced and left untouched', async () => {
  const native = memoryNative()
  native.writeAtomic('storage-config.json', '{"mode":')
  const runtime = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 50 })
  await runtime.load()
  const status = await runtime.storage.status()
  assert.equal(status.activeMode, 'local')
  assert.match(status.notice ?? '', /存储配置不可读/)
  assert.equal(native.files.get('storage-config.json'), '{"mode":', 'a corrupt config must not be rewritten during startup')
  await runtime.stop()
})

test('local commands and settings do not reload the save, and each renderer load takes one bridge copy', async () => {
  const native = memoryNative()
  const local = memoryLocal()
  const runtime = createMobileServerRuntime({ local, native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 50 })
  const first = await runtime.load()
  assert.equal(local.loadCalls, 1)
  assert.equal(first, local.lastLoadedSave, 'runtime.load must reuse the bridge copy instead of cloning it twice')
  const loadsAfterFirst = local.loadCalls

  await runtime.command({ type: 'pet.cheer', payload: {} })
  assert.equal(local.loadCalls, loadsAfterFirst, 'an already-started local command must not call local.load()')
  await runtime.localSettings.load()
  assert.equal(local.loadCalls, loadsAfterFirst, 'local settings reads must not call local.load()')
  await runtime.setAdvanceWhileEmpty(true)
  assert.equal(local.loadCalls, loadsAfterFirst, 'advance-while-empty writes must not call local.load()')

  const second = await runtime.load()
  assert.equal(local.loadCalls, loadsAfterFirst + 1, 'each renderer load takes exactly one fresh bridge copy')
  assert.equal(second, local.lastLoadedSave)
  await runtime.stop()
})

test('a paired local-authority device never requests or surfaces a fake offline device error', () => {
  const fakeOffline = { devices: [], owner: false, canRevoke: false, error: 'offline: pair a server first' }
  const localPlan = planStorageRefresh({ paired: true, activeMode: 'local' }, fakeOffline)
  assert.equal(localPlan.listDevices, false, 'a local-authority device has no server session to list devices from')
  assert.deepEqual(localPlan.devices, [])
  assert.equal(localPlan.message, '', 'the canned offline reply must not become a storage panel error')

  const serverPlan = planStorageRefresh(
    { paired: true, activeMode: 'server' },
    { devices: [{ deviceId: 'device-1' }], owner: true, canRevoke: true },
  )
  assert.equal(serverPlan.listDevices, true)
  assert.deepEqual(serverPlan.devices, [{ deviceId: 'device-1' }])
  assert.equal(serverPlan.message, '')

  const ownerOnly = planStorageRefresh(
    { paired: true, activeMode: 'server' },
    { devices: [], owner: false, canRevoke: false, error: 'unauthorized: only an owner device can list devices' },
  )
  assert.equal(ownerOnly.message, '', 'player devices keep the existing silent unauthorized handling')
})

test('unpair clears the token/config/cache and restores the local pet', async () => {
  const native = memoryNative()
  const runtime = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 200, pairTimeoutMs: 500 })
  await runtime.storage.pair({ serverUrl: SERVER_URL, code: 'QQP-test', deviceLabel: 'Android' })
  const status = await runtime.storage.unpair()
  assert.equal(status.activeMode, 'local')
  assert.equal(status.paired, false)
  assert.equal(native.token, null)
  assert.equal(native.files.has('sync-config.json'), false)
  assert.equal(native.files.has('remote-projection-cache.json'), false)
  await runtime.stop()
})

test('a local suspend failure fails the server switch instead of creating two writers', async () => {
  const native = memoryNative()
  const local = memoryLocal()
  local.suspend = async () => { throw new Error('local suspend failed') }
  const runtime = createMobileServerRuntime({ local, native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 200, pairTimeoutMs: 500 })
  await runtime.load()
  await assert.rejects(
    runtime.storage.pair({ serverUrl: SERVER_URL, code: 'QQP-test', deviceLabel: 'Android' }),
    /local suspend failed/,
  )
  const status = await runtime.storage.status()
  assert.equal(status.activeMode, 'local')
  assert.equal(runtime.runtimeInfo().serverMode, false)
  await runtime.stop()
})

test('private-network plaintext ws is rejected before the transport sees it', async () => {
  const native = memoryNative()
  const base = fakeTransport()
  let calls = 0
  const transport = { connect(...args) { calls += 1; return base.connect(...args) } }
  const runtime = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport, connectTimeoutMs: 200, pairTimeoutMs: 500 })
  await assert.rejects(
    runtime.storage.pair({ serverUrl: 'ws://10.0.2.2:8787/v1/sync', code: 'QQP-test', deviceLabel: 'Android' }),
    /android_transport_unsupported/,
  )
  assert.equal(calls, 0)
  assert.equal(native.token, null)
  await runtime.stop()
})

test('an unsafe persisted server URL falls back to local instead of wedging startup', async () => {
  const native = memoryNative()
  native.saveRemoteToken('android-token-1')
  native.writeAtomic('sync-config.json', JSON.stringify({ serverUrl: 'ws://10.0.2.2:8787/v1/sync', petId: PET_ID, deviceId: DEVICE_ID, lastRevision: 0, lastEventSeq: 0 }))
  native.writeAtomic('storage-config.json', JSON.stringify({ format: 'qqpet-storage-config', schemaVersion: 1, mode: 'server', serverUrl: 'ws://10.0.2.2:8787/v1/sync', deviceLabel: 'Android' }))
  const runtime = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 50 })
  const save = await runtime.load()
  assert.equal(save.havePet, true)
  const status = await runtime.storage.status()
  assert.equal(status.activeMode, 'local')
  assert.match(status.notice ?? '', /Android 上不可用/)
  await runtime.stop()
})

test('switching to a server projection replays it as a full resync', async () => {
  const native = memoryNative()
  const runtime = createMobileServerRuntime({ local: memoryLocal(), native, appVersion: 'test', transport: fakeTransport(), connectTimeoutMs: 200, pairTimeoutMs: 500 })
  const resyncs = []
  runtime.onResync((projection) => resyncs.push(projection))
  await runtime.storage.pair({ serverUrl: SERVER_URL, code: 'QQP-test', deviceLabel: 'Android' })
  assert.ok(resyncs.length >= 1, 'the newly activated server projection must be replayed')
  assert.equal(resyncs.at(-1).revision, 3)
  await runtime.stop()
})
