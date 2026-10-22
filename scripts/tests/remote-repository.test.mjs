import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.')
      && context.parentURL
      && /\.[cm]?[jt]s$/.test(specifier) === false
      && specifier.endsWith('.json') === false
    ) {
      return nextResolve(specifier + '.ts')
    }
    return nextResolve(specifier)
  },
})

const {
  PROTOCOL_VERSION,
  SAVE_SCHEMA_VERSION,
  REMOTE_PROJECTION_CACHE_FORMAT,
  parseClientMessage,
  parseServerMessage,
  validateRemoteProjectionCacheV2,
} = await import('../../src/shared/sync/index.ts')
const { IPC } = await import('../../src/shared/ipc.ts')
const {
  desktopServerModeCapability,
} = await import('../../src/main/renderer-runtime-flags.ts')
const { createSyncFixtures, GAME_TIME_MS } = await import('./sync-fixtures.mjs')
const { assertRemoteServerUrl } = await import('../../src/main/remote-endpoint.ts')
const { createWebSocketTransport } = await import('../../src/main/remote-websocket-transport.ts')

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const fixtures = createSyncFixtures()
const PET_ID = 'pet-c10'
const OWNER_DEVICE_ID = 'device-owner-c10'
const PLAYER_DEVICE_ID = 'device-player-c10'
const TOKEN = 'device-token-c10-secret'
const PLAYER_TOKEN = 'device-token-player-c10-secret'
const PAIRING_CODE = 'pairing-code-c10-secret'
const ISSUED_TOKEN = 'issued-token-c10-secret'
const WSS_URL = 'wss://pet.example/v1/sync'
const WEATHER_LOCATION = '杭州'
const AUTHORITY = {
  owner: 'server',
  authorityId: 'authority-server-c10',
  restoreGeneration: 3,
  epoch: 7,
  state: 'active',
}
const AUTHORITY_STAMP = {
  owner: 'server',
  authorityId: 'authority-server-c10',
  restoreGeneration: 3,
  epoch: 7,
  revision: 3,
  eventSeq: 4,
  handoffId: 'handoff-server-c10',
  detachedAtWallMs: GAME_TIME_MS,
}
const RESET_AUTHORITY = {
  owner: 'server',
  authorityId: 'authority-reset-c10',
  restoreGeneration: 3,
  epoch: 9,
  state: 'active',
}
const ARCHIVED_AUTHORITY = {
  ...AUTHORITY,
  state: 'archived',
}
const RESET_STAMP = {
  owner: 'server',
  authorityId: 'authority-reset-c10',
  restoreGeneration: 3,
  epoch: 9,
  revision: 5,
  eventSeq: 6,
  handoffId: 'handoff-reset-c10',
  detachedAtWallMs: GAME_TIME_MS,
}

function clone(value) {
  return structuredClone(value)
}

function sharedWithYb(yb) {
  const shared = clone(fixtures.shared)
  shared.petInfo.yb = yb
  return shared
}

function welcomeFrame(deviceId, delivery = 'snapshot', issuedToken, weatherLocation = WEATHER_LOCATION) {
  return {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    requestId: 'welcome-' + deviceId,
    connectionId: 'connection-' + deviceId,
    petId: PET_ID,
    deviceId,
    deviceRole: deviceId === OWNER_DEVICE_ID ? 'owner' : 'player',
    protocolVersion: PROTOCOL_VERSION,
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    serverTimeMs: GAME_TIME_MS,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    weatherLocation,
    authority: clone(AUTHORITY),
    headRevision: 1,
    headEventSeq: 1,
    catchingUp: false,
    delivery,
    ...(issuedToken === undefined ? {} : { issuedToken }),
  }
}

function snapshotFrame(shared, revision, eventSeq, authority, weatherLocation = WEATHER_LOCATION) {
  return {
    t: 'snapshot',
    v: PROTOCOL_VERSION,
    revision,
    eventSeq,
    gameTimeMs: GAME_TIME_MS + revision * 60_000,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    weatherLocation,
    authority: clone(authority),
    save: clone(shared),
  }
}

function readyFrame(revision, eventSeq, authority, catchingUp = false, weatherLocation = WEATHER_LOCATION) {
  return {
    t: 'ready',
    v: PROTOCOL_VERSION,
    revision,
    eventSeq,
    gameTimeMs: GAME_TIME_MS + revision * 60_000,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    weatherLocation,
    authority: clone(authority),
    catchingUp,
  }
}

function commandResultFrame({
  opId,
  requestId,
  commandType,
  commandSeq = 0,
  revision = 0,
  eventSeq = 0,
  status = 'applied',
  result,
  error,
  original,
}) {
  return {
    t: 'commandResult',
    v: PROTOCOL_VERSION,
    requestId,
    opId,
    commandType,
    status,
    commandSeq,
    revision,
    eventSeq,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    ...(original === undefined ? {} : { original }),
  }
}

function commandStatusResultFrame(opId, requestId, status, result) {
  return {
    t: 'commandStatusResult',
    v: PROTOCOL_VERSION,
    requestId,
    opId,
    status,
    ...(result === undefined ? {} : { result }),
  }
}

function assertClientFrame(frame) {
  const parsed = parseClientMessage(frame)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
}

function assertServerFrame(frame) {
  const parsed = parseServerMessage(frame)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
}

async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 2000
  while (predicate() === false) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

class MemoryTokenStore {
  token = null
  config = null
  projectionCache = null
  writes = []
  configWrites = []
  cacheWrites = []
  cacheClears = 0

  async loadToken() {
    return this.token
  }

  async saveToken(token) {
    this.writes.push(token)
    this.token = token
  }

  async loadConfig() {
    return this.config === null ? null : clone(this.config)
  }

  async saveConfig(config) {
    this.configWrites.push(clone(config))
    this.config = clone(config)
  }

  async loadProjectionCache() {
    return this.projectionCache === null ? null : clone(this.projectionCache)
  }

  async saveProjectionCache(cache) {
    assert.equal(validateRemoteProjectionCacheV2(cache), true)
    this.cacheWrites.push(clone(cache))
    this.projectionCache = clone(cache)
  }

  async clearProjectionCache() {
    this.cacheClears += 1
    this.projectionCache = null
  }

  async clear() {
    this.token = null
    this.config = null
    this.projectionCache = null
  }
}

class FakeTransport {
  connections = []

  constructor(onConnect) {
    this.onConnect = onConnect
  }

  connect(url, token, handlers) {
    const connection = { url, token, handlers, sent: [], closed: false }
    this.connections.push(connection)
    connection.send = raw => {
      const frame = typeof raw === 'string' ? JSON.parse(raw) : clone(raw)
      assertClientFrame(frame)
      connection.sent.push(frame)
      queueMicrotask(() => {
        if (!connection.closed) void this.onConnect(connection, frame)
      })
    }
    connection.emit = incoming => {
      assertServerFrame(incoming)
      if (!connection.closed) handlers.onMessage(clone(incoming))
    }
    connection.close = (code = 1006, reason = 'test close') => {
      if (connection.closed) return
      connection.closed = true
      handlers.onClose({ code, reason })
    }
    queueMicrotask(() => {
      if (!connection.closed) handlers.onOpen()
    })
    return { send: connection.send, close: () => connection.close() }
  }
}

class FakeServer {
  constructor() {
    this.clients = new Set()
    this.commands = new Map()
    this.projectionEvents = new Map()
    this.revision = 1
    this.eventSeq = 1
    this.shared = clone(fixtures.shared)
    this.timeZone = 'Asia/Shanghai'
    this.advanceWhileEmpty = true
    this.weatherLocation = WEATHER_LOCATION
    this.authority = clone(AUTHORITY)
    this.pairingCode = PAIRING_CODE
    this.issuedToken = ISSUED_TOKEN
    this.dropResultOnce = false
    this.gapAfterCommandOnce = false
    this.authorityResetAfterCommandOnce = false
    this.forceNotApplied = new Set()
    this.replayDeliveryOnReconnect = false
    this.authorityResetOnNextCachedHello = false
    this.muteProjection = null
  }

  gameTimeMs() {
    return GAME_TIME_MS + this.revision * 60_000
  }

  transport() {
    return new FakeTransport((connection, frame) => this.handle(connection, frame))
  }

  snapshotFrame() {
    return snapshotFrame(this.shared, this.revision, this.eventSeq, this.authority, this.weatherLocation)
  }

  projectionFrame() {
    return {
      t: 'projection',
      v: PROTOCOL_VERSION,
      revision: this.revision,
      eventSeq: this.eventSeq,
      gameTimeMs: this.gameTimeMs(),
      timeZone: this.timeZone,
      advanceWhileEmpty: this.advanceWhileEmpty,
      weatherLocation: this.weatherLocation,
      authority: clone(this.authority),
      save: clone(this.shared),
      events: [{
        eventSeq: this.eventSeq,
        revision: this.revision,
        commandSeq: this.revision,
        gameTimeMs: this.gameTimeMs(),
        type: 'reward.granted',
        payload: { amount: 1 },
      }],
    }
  }

  handle(connection, frame) {
    if (frame.t === 'hello') {
      if (this.authorityResetOnNextCachedHello && frame.cachedAuthority !== undefined) {
        this.authorityResetOnNextCachedHello = false
        this.authority = clone(RESET_AUTHORITY)
        this.revision = 5
        this.eventSeq = 6
        this.shared = sharedWithYb(this.shared.petInfo.yb + 1)
        connection.emit({
          t: 'authorityResetRequired',
          code: 'authority_reset_required',
          v: PROTOCOL_VERSION,
          requestId: frame.requestId,
          authority: clone(RESET_STAMP),
          reason: 'cache_newer',
          requireFullSnapshot: true,
        })
        connection.close(4002, 'authority_reset_required')
        return
      }
      this.clients.add(connection)
      let deviceId = OWNER_DEVICE_ID
      if (frame.auth.kind === 'pairing') {
        assert.equal(frame.auth.code, this.pairingCode)
      } else if (frame.auth.token !== TOKEN) {
        deviceId = PLAYER_DEVICE_ID
      }
      const missed = frame.lastEventSeq === undefined
        ? []
        : [...this.projectionEvents.values()].filter(event => event.eventSeq > frame.lastEventSeq)
      if (this.replayDeliveryOnReconnect && missed.length > 0) {
        const welcome = welcomeFrame(deviceId, 'replay', undefined, this.weatherLocation)
        welcome.headRevision = this.revision
        welcome.headEventSeq = this.eventSeq
        connection.emit(welcome)
        connection.emit({
          t: 'replay',
          v: PROTOCOL_VERSION,
          fromEventSeq: missed[0].eventSeq,
          toEventSeq: missed[missed.length - 1].eventSeq,
          events: clone(missed),
        })
        connection.emit(readyFrame(this.revision, this.eventSeq, this.authority))
        return
      }
      connection.emit(welcomeFrame(
        deviceId,
        'snapshot',
        frame.auth.kind === 'pairing' ? this.issuedToken : undefined,
        this.weatherLocation,
      ))
      connection.emit(this.snapshotFrame())
      connection.emit(readyFrame(this.revision, this.eventSeq, this.authority, false, this.weatherLocation))
      return
    }
    if (frame.t === 'command') {
      this.applyCommand(connection, frame)
      return
    }
    if (frame.t === 'commandStatus') {
      const stored = this.commands.get(frame.opId)
      if (stored === undefined) {
        connection.emit(commandStatusResultFrame(frame.opId, frame.requestId, 'not_applied'))
      } else {
        connection.emit(commandStatusResultFrame(frame.opId, frame.requestId, stored.status, {
          ...clone(stored),
          requestId: frame.requestId,
        }))
      }
      return
    }
    if (frame.t === 'resync') {
      if (frame.discardCachedAuthority === true) {
        this.authority = clone(RESET_AUTHORITY)
        this.revision = Math.max(this.revision, 5)
        this.eventSeq = Math.max(this.eventSeq, 6)
      }
      connection.emit(this.snapshotFrame())
      connection.emit(readyFrame(this.revision, this.eventSeq, this.authority))
      return
    }
    if (frame.t === 'exportBundle') {
      connection.emit({
        t: 'portableBundle',
        v: PROTOCOL_VERSION,
        requestId: frame.requestId,
        bundle: clone(fixtures.bundle),
      })
      return
    }
    if (frame.t === 'ping') {
      connection.emit({ t: 'pong', v: PROTOCOL_VERSION, nonce: frame.nonce, serverTimeMs: GAME_TIME_MS })
    }
  }

  applyCommand(connection, frame) {
    if (this.forceNotApplied.has(frame.opId)) {
      connection.emit(commandStatusResultFrame(frame.opId, frame.requestId, 'not_applied'))
      return
    }
    const existing = this.commands.get(frame.opId)
    if (existing !== undefined) {
      connection.emit({
        ...clone(existing),
        requestId: frame.requestId,
        status: 'duplicate',
        original: existing.status,
      })
      return
    }
    if (frame.command.type === 'admin.exportForDetach') {
      const result = commandResultFrame({
        opId: frame.opId,
        requestId: frame.requestId,
        commandType: frame.command.type,
        result: { authority: clone(AUTHORITY_STAMP), bundle: clone(fixtures.bundle) },
      })
      this.commands.set(frame.opId, clone(result))
      connection.emit(result)
      return
    }
    if (frame.command.type === 'admin.resumeServer') {
      const result = commandResultFrame({
        opId: frame.opId,
        requestId: frame.requestId,
        commandType: frame.command.type,
      })
      this.commands.set(frame.opId, clone(result))
      connection.emit(result)
      return
    }
    this.revision += 1
    this.eventSeq += 1
    this.shared = sharedWithYb(this.shared.petInfo.yb + 1)
    const result = commandResultFrame({
      opId: frame.opId,
      requestId: frame.requestId,
      commandType: frame.command.type,
      commandSeq: this.revision,
      revision: this.revision,
      eventSeq: this.eventSeq,
      result: { accepted: true },
    })
    this.commands.set(frame.opId, clone(result))
    if (this.dropResultOnce) this.dropResultOnce = false
    else connection.emit(result)
    const projection = this.projectionFrame()
    this.projectionEvents.set(this.eventSeq, clone(projection.events[0]))
    for (const client of this.clients) {
      if (client === this.muteProjection) continue
      if (!client.closed) client.emit(projection)
    }
    if (this.gapAfterCommandOnce) {
      this.gapAfterCommandOnce = false
      this.revision += 2
      this.eventSeq += 2
      this.shared = sharedWithYb(this.shared.petInfo.yb + 1)
      const gap = this.projectionFrame()
      this.projectionEvents.set(this.eventSeq, clone(gap.events[0]))
      for (const client of this.clients) {
        if (!client.closed) client.emit(gap)
      }
    }
    if (this.authorityResetAfterCommandOnce) {
      this.authorityResetAfterCommandOnce = false
      this.revision = Math.max(this.revision, 5)
      this.eventSeq = Math.max(this.eventSeq, 6)
      connection.emit({
        t: 'authorityResetRequired',
        code: 'authority_reset_required',
        v: PROTOCOL_VERSION,
        requestId: frame.requestId,
        authority: clone(RESET_STAMP),
        reason: 'cache_newer',
        requireFullSnapshot: true,
      })
    }
  }
}

async function makeRepository(server, overrides = {}) {
  const mod = await import('../../src/main/remote-repository.ts')
  const store = overrides.store ?? new MemoryTokenStore()
  if (Object.prototype.hasOwnProperty.call(overrides, 'token')) store.token = overrides.token
  else store.token = TOKEN
  if (Object.prototype.hasOwnProperty.call(overrides, 'config')) store.config = overrides.config
  else store.config = {
    serverUrl: WSS_URL,
    petId: PET_ID,
    deviceId: OWNER_DEVICE_ID,
    lastRevision: 0,
    lastEventSeq: 0,
  }
  let id = 0
  const sleeps = []
  const repository = new mod.RemoteRepository({
    serverUrl: WSS_URL,
    appVersion: '0.1.0-c10-test',
    tokenStore: store,
    transport: overrides.transport ?? server.transport(),
    backoff: overrides.backoff ?? { baseMs: 10, maxMs: 1_000, random: () => 0.5 },
    sleep: async ms => {
      sleeps.push(ms)
      if (overrides.blockSleep !== undefined) await overrides.blockSleep(ms)
    },
    randomUUID: overrides.randomUUID ?? (() => 'request-' + String(++id).padStart(4, '0')),
    exportRequestTimeoutMs: overrides.exportRequestTimeoutMs ?? 1_000,
    ...(overrides.pair === undefined ? {} : { pair: overrides.pair }),
    ...(overrides.deviceOverlay === undefined ? {} : { deviceOverlay: overrides.deviceOverlay }),
  })
  return { repository, store, sleeps, mod }
}

test('hello/welcome handshake applies a snapshot and exposes the server repository surface', async t => {
  const server = new FakeServer()
  const { repository, store } = await makeRepository(server)
  t.after(() => repository.stop())
  const projections = []
  const statuses = []
  const commandResults = []
  repository.onProjection((projection, events) => projections.push({ projection, events }))
  repository.onSyncStatus(status => statuses.push(status))
  repository.onCommandResult(result => commandResults.push(result))
  await repository.start()
  await until(() => projections.length > 0, 'initial projection')
  assert.equal(projections[0].projection.shared.petInfo.yb, server.shared.petInfo.yb)
  assert.equal(projections[0].events.length, 0)
  assert.equal(repository.getStatus().mode, 'server')
  assert.equal(repository.getStatus().serverMode, true)
  assert.equal(repository.getWeatherCity(), WEATHER_LOCATION)
  assert.equal(repository.getStatus().weatherCity, WEATHER_LOCATION)
  assert.equal(statuses.some(item => item.connection === 'connecting'), true)
  assert.equal(statuses.at(-1).connection, 'online')
  assert.equal(store.token, TOKEN)
  assert.equal(JSON.stringify(repository.getStatus()).includes(TOKEN), false)
  const loaded = await repository.load()
  assert.deepEqual(loaded, repository.getProjection().save)
  const result = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-feed-1' })
  assert.equal(result.status, 'applied')
  assert.equal(result.opId, 'op-feed-1')
  assert.equal(commandResults.at(-1).status, 'applied')
  await until(() => projections.length >= 2, 'live projection')
  assert.equal(projections.at(-1).projection.shared.petInfo.yb, server.shared.petInfo.yb)
  const connection = [...server.clients].at(-1)
  const command = connection.sent.find(frame => frame.t === 'command')
  assert.deepEqual(command.command, { type: 'pet.cheer', payload: {} })
  assert.equal(command.observedRevision >= 1, true)
})

test('welcome and catching-up ready gate start and commands until a final ready', async t => {
  const server = new FakeServer()
  const transport = new FakeTransport((connection, frame) => {
    if (frame.t === 'hello') {
      server.clients.add(connection)
      const welcome = welcomeFrame(OWNER_DEVICE_ID, 'snapshot')
      welcome.catchingUp = true
      connection.emit(welcome)
      connection.emit(server.snapshotFrame())
      connection.emit(readyFrame(server.revision, server.eventSeq, server.authority, true))
      return
    }
    server.handle(connection, frame)
  })
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  let settled = false
  const starting = repository.start().then(value => {
    settled = true
    return value
  })
  await until(() => repository.getStatus().state === 'catching_up', 'catch-up welcome')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false, 'start must not resolve on a catching-up welcome/ready')
  assert.deepEqual(repository.getProjection()?.shared, server.shared)
  assert.equal(repository.getStatus().readOnly, true)
  const blocked = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-catchup-gate' })
  assert.equal(blocked.status, 'rejected')
  assert.equal(blocked.error.code, 'server_catching_up')
  const connection = transport.connections[0]
  assert.equal(connection.sent.some(frame => frame.t === 'command'), false)

  connection.emit(server.snapshotFrame())
  connection.emit(readyFrame(server.revision, server.eventSeq, server.authority))
  await starting
  assert.equal(settled, true)
  assert.equal(repository.getStatus().state, 'online')
  assert.equal(repository.getStatus().readOnly, false)
  assert.deepEqual(repository.getProjection().shared, server.shared)
})

test('welcome, ready and snapshot authority transitions are public and force read-only', async t => {
  const server = new FakeServer()
  const { repository, store } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const connection = [...server.clients][0]
  const current = repository.getProjection()

  const welcome = welcomeFrame(OWNER_DEVICE_ID, 'none')
  welcome.authority = clone(ARCHIVED_AUTHORITY)
  connection.emit(welcome)
  await until(() => repository.getProjection()?.authority.state === 'archived', 'welcome authority propagation')
  assert.equal(repository.getStatus().authority.state, 'archived')
  assert.equal(repository.getStatus().readOnly, true)
  const beforeReady = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-archived-before-ready' })
  assert.equal(beforeReady.status, 'rejected')
  assert.equal(beforeReady.error.code, 'offline')

  connection.emit(readyFrame(current.revision, current.eventSeq, ARCHIVED_AUTHORITY))
  await until(() => repository.getStatus().state === 'online', 'archived ready')
  assert.equal(repository.getProjection().authority.state, 'archived')
  assert.equal(repository.getStatus().authority.state, 'archived')
  assert.equal(repository.getStatus().readOnly, true)
  const blocked = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-archived-command' })
  assert.equal(blocked.status, 'rejected')
  assert.equal(blocked.error.code, 'authority_not_active')
  assert.equal(connection.sent.some(frame => frame.t === 'command'), false)
  await repository.flush()
  assert.equal(store.projectionCache?.authority.state, 'archived')

  connection.emit(snapshotFrame(server.shared, current.revision, current.eventSeq, ARCHIVED_AUTHORITY))
  await until(() => repository.getProjection()?.authority.state === 'archived', 'snapshot authority propagation')
  assert.equal(repository.getStatus().readOnly, true)
  assert.equal(repository.getProjection().revision, current.revision)
  assert.deepEqual(repository.getProjection().shared, server.shared)
})

test('two clients converge on one ordered projection after a feed command', async t => {
  const server = new FakeServer()
  const owner = await makeRepository(server)
  const playerStore = new MemoryTokenStore()
  playerStore.token = PLAYER_TOKEN
  playerStore.config = {
    serverUrl: WSS_URL,
    petId: PET_ID,
    deviceId: PLAYER_DEVICE_ID,
    lastRevision: 0,
    lastEventSeq: 0,
  }
  const player = await makeRepository(server, { store: playerStore })
  t.after(async () => {
    await owner.repository.stop()
    await player.repository.stop()
  })
  const ownerProjections = []
  const playerProjections = []
  owner.repository.onProjection(projection => ownerProjections.push(projection))
  player.repository.onProjection(projection => playerProjections.push(projection))
  await Promise.all([owner.repository.start(), player.repository.start()])
  await until(() => ownerProjections.length > 0 && playerProjections.length > 0, 'both initial projections')
  await owner.repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-two-client-feed' })
  await until(() => ownerProjections.length >= 2 && playerProjections.length >= 2, 'both updates')
  const a = ownerProjections.at(-1)
  const b = playerProjections.at(-1)
  assert.deepEqual(a.shared, b.shared)
  assert.equal(a.revision, b.revision)
  assert.equal(a.eventSeq, b.eventSeq)
})

test('lost command result is reconciled by opId with commandStatus after reconnect without a resend', async t => {
  const server = new FakeServer()
  server.dropResultOnce = true
  const transport = server.transport()
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()
  const pending = repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-lost-result' })
  await until(() => server.commands.has('op-lost-result'), 'command commit')
  const serverConnection = [...server.clients][0]
  server.clients.delete(serverConnection)
  serverConnection.close()
  const result = await pending
  assert.equal(result.status, 'applied')
  assert.equal(result.opId, 'op-lost-result')
  await until(() => transport.connections.length >= 2, 'reconnect')
  await until(
    () => transport.connections.at(-1).sent.some(frame => frame.t === 'commandStatus' && frame.opId === 'op-lost-result'),
    'commandStatus reconciliation',
  )
  assert.equal(
    transport.connections.flatMap(connection => connection.sent).filter(frame => frame.t === 'command').length,
    1,
  )
})

test('commandStatus not_applied rejects the in-flight command and a fresh opId retries', async t => {
  const server = new FakeServer()
  server.forceNotApplied.add('op-not-applied')
  const transport = server.transport()
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()
  const first = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-not-applied' })
  assert.equal(first.status, 'rejected')
  assert.equal(first.opId, 'op-not-applied')
  const retry = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-fresh-retry' })
  assert.equal(retry.status, 'applied')
  assert.equal(retry.opId, 'op-fresh-retry')
  assert.deepEqual(
    transport.connections.flatMap(connection => connection.sent)
      .filter(frame => frame.t === 'command')
      .map(frame => frame.opId),
    ['op-not-applied', 'op-fresh-retry'],
  )
})

test('correlated protocol error frames settle the matching command and export', async t => {
  const server = new FakeServer()
  let commandFrame = null
  const transport = new FakeTransport((connection, frame) => {
    if (frame.t === 'command') {
      commandFrame = frame
      return
    }
    if (frame.t === 'exportBundle') {
      connection.emit({
        t: 'error',
        v: PROTOCOL_VERSION,
        requestId: frame.requestId,
        code: 'internal',
        message: 'export handler failed',
        refreshProjection: false,
      })
      return
    }
    server.handle(connection, frame)
  })
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()

  let commandSettled = false
  const commandPromise = repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-handler-error' })
  commandPromise.then(() => { commandSettled = true })
  await until(() => commandFrame !== null, 'command request')
  const connection = transport.connections[0]
  connection.emit({
    t: 'error',
    v: PROTOCOL_VERSION,
    requestId: 'some-other-request',
    code: 'internal',
    message: 'not mine',
    refreshProjection: false,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(commandSettled, false, 'an uncorrelated error frame must not settle the command')
  connection.emit({
    t: 'error',
    v: PROTOCOL_VERSION,
    requestId: commandFrame.requestId,
    code: 'internal',
    message: 'command handler failed',
    refreshProjection: false,
  })
  const result = await commandPromise
  assert.equal(result.status, 'rejected')
  assert.equal(result.error.code, 'internal')
  assert.equal(result.error.message, 'command handler failed')

  const exportPromise = repository.exportBundle()
  await until(
    () => connection.sent.some(frame => frame.t === 'exportBundle'),
    'export request',
  )
  const exportRequest = connection.sent.find(frame => frame.t === 'exportBundle')
  connection.emit({
    t: 'error',
    v: PROTOCOL_VERSION,
    requestId: exportRequest.requestId,
    code: 'internal',
    message: 'export handler failed',
    refreshProjection: false,
  })
  await assert.rejects(exportPromise, /internal: export handler failed/)
})

test('refresh rejection keeps the command pending and read-only until the projection arrives', async t => {
  const server = new FakeServer()
  const transport = new FakeTransport((connection, frame) => {
    if (frame.t === 'command') {
      if (frame.opId === 'op-refresh-first') {
        connection.emit(commandResultFrame({
          opId: frame.opId,
          requestId: frame.requestId,
          commandType: frame.command.type,
          status: 'rejected',
          error: { code: 'busy', message: 'state changed; refresh required', refreshProjection: true },
        }))
      } else {
        connection.emit(commandResultFrame({
          opId: frame.opId,
          requestId: frame.requestId,
          commandType: frame.command.type,
          status: 'applied',
          commandSeq: 2,
          revision: server.revision,
          eventSeq: server.eventSeq,
          result: { accepted: true },
        }))
      }
      return
    }
    server.handle(connection, frame)
  })
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()

  let firstSettled = false
  const first = repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-refresh-first' })
  first.then(() => { firstSettled = true })
  await until(
    () => transport.connections[0].sent.some(frame => frame.t === 'command' && frame.opId === 'op-refresh-first'),
    'first command',
  )
  await until(
    () => repository.getStatus().state === 'catching_up' && repository.getStatus().readOnly === true,
    'refresh gate',
  )
  assert.equal(firstSettled, false, 'the refresh command must not settle before its projection')

  const retryBefore = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-refresh-before' })
  assert.equal(retryBefore.status, 'rejected')
  assert.equal(retryBefore.error.code, 'server_catching_up')
  assert.equal(
    transport.connections[0].sent.filter(frame => frame.t === 'command').length,
    1,
    'no retry may be sent while the refresh projection is outstanding',
  )

  const current = repository.getProjection()
  transport.connections[0].emit({
    t: 'projection',
    v: PROTOCOL_VERSION,
    revision: current.revision + 1,
    eventSeq: current.eventSeq,
    gameTimeMs: current.gameTimeMs + 60_000,
    timeZone: current.timeZone,
    advanceWhileEmpty: current.advanceWhileEmpty,
    authority: clone(current.authority),
    save: clone(server.shared),
    events: [],
  })
  const firstResult = await first
  assert.equal(firstResult.status, 'rejected')
  assert.equal(firstResult.error.refreshProjection, true)
  assert.equal(repository.getStatus().state, 'online')
  assert.equal(repository.getStatus().readOnly, false)

  const retryAfter = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-refresh-after' })
  assert.equal(retryAfter.status, 'applied')
  assert.equal(
    transport.connections[0].sent.filter(frame => frame.t === 'command').length,
    2,
  )
})

test('protocol error with refreshProjection keeps the command pending until a projection', async t => {
  const server = new FakeServer()
  let commandFrame = null
  const transport = new FakeTransport((connection, frame) => {
    if (frame.t === 'command') {
      commandFrame = frame
      return
    }
    server.handle(connection, frame)
  })
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()

  let settled = false
  const pending = repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-error-refresh' })
  pending.then(() => { settled = true })
  await until(() => commandFrame !== null, 'command request')
  const connection = transport.connections[0]
  connection.emit({
    t: 'error',
    v: PROTOCOL_VERSION,
    requestId: commandFrame.requestId,
    code: 'internal',
    message: 'projection refresh required',
    refreshProjection: true,
  })
  await until(
    () => repository.getStatus().state === 'catching_up' && repository.getStatus().readOnly === true,
    'error refresh gate',
  )
  assert.equal(settled, false)
  const blockedRetry = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-error-refresh-retry' })
  assert.equal(blockedRetry.status, 'rejected')
  assert.equal(blockedRetry.error.code, 'server_catching_up')

  const current = repository.getProjection()
  connection.emit({
    t: 'projection',
    v: PROTOCOL_VERSION,
    revision: current.revision + 1,
    eventSeq: current.eventSeq,
    gameTimeMs: current.gameTimeMs + 60_000,
    timeZone: current.timeZone,
    advanceWhileEmpty: current.advanceWhileEmpty,
    authority: clone(current.authority),
    save: clone(server.shared),
    events: [],
  })
  const result = await pending
  assert.equal(result.status, 'rejected')
  assert.equal(result.error.refreshProjection, true)
  assert.equal(repository.getStatus().state, 'online')
})

test('duplicate opId returns the stored result without a second mutation', async t => {
  const server = new FakeServer()
  const { repository } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const first = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-duplicate' })
  const revision = server.revision
  const eventSeq = server.eventSeq
  const second = await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-duplicate' })
  assert.equal(first.status, 'applied')
  assert.equal(second.status, 'duplicate')
  assert.equal(second.original, 'applied')
  assert.equal(server.revision, revision)
  assert.equal(server.eventSeq, eventSeq)
  assert.deepEqual(second.result, first.result)
})

test('event/revision gaps stop projection delivery and request a full resync', async t => {
  const server = new FakeServer()
  const { repository } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const deliveries = []
  repository.onProjection(projection => deliveries.push(projection))
  repository.onResync(projection => deliveries.push(projection))
  server.gapAfterCommandOnce = true
  await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-gap' })
  const connection = [...server.clients].at(-1)
  await until(() => connection.sent.some(frame => frame.t === 'resync'), 'resync request')
  const resync = connection.sent.find(frame => frame.t === 'resync')
  assert.equal(resync.lastRevision >= 1, true)
  await until(() => repository.getProjection()?.revision === server.revision, 'authoritative snapshot after resync')
  assert.equal(deliveries.at(-1).revision, server.revision)
  assert.equal(deliveries.at(-1).eventSeq, server.eventSeq)
})

test('authority_reset_required discards the cache and recovers from a full snapshot', async t => {
  const server = new FakeServer()
  server.authorityResetAfterCommandOnce = true
  const { repository, store } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const statuses = []
  repository.onSyncStatus(status => statuses.push(status))
  const resyncProjections = []
  repository.onResync(projection => resyncProjections.push(projection))
  await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-reset-authority' })
  const connection = [...server.clients][0]
  await until(
    () => connection.sent.some(frame => frame.t === 'resync' && frame.discardCachedAuthority === true),
    'discarded-authority resync',
  )
  assert.equal(statuses.some(status => status.notice === 'authority_reset_required'), true)
  await until(
    () => repository.getProjection()?.authority.authorityId === 'authority-reset-c10',
    'authority recovery snapshot',
  )
  assert.equal(repository.getProjection().authority.epoch, 9)
  assert.equal(store.token, TOKEN)
  assert.equal(resyncProjections.at(-1).authority.authorityId, 'authority-reset-c10')
})

test('4002 authority reset close is recoverable and reconnects without cachedAuthority', async t => {
  const server = new FakeServer()
  server.authorityResetOnNextCachedHello = true
  const transport = server.transport()
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()
  const first = [...server.clients][0]
  server.clients.delete(first)
  first.close(1006, 'network lost')
  await until(() => transport.connections.length >= 3, 'post-reset reconnect')
  await until(
    () => repository.getProjection()?.authority.authorityId === RESET_AUTHORITY.authorityId,
    'reset authority snapshot',
  )
  const secondHello = transport.connections[1].sent.find(frame => frame.t === 'hello')
  const thirdHello = transport.connections[2].sent.find(frame => frame.t === 'hello')
  assert.ok(secondHello?.cachedAuthority, 'the first reconnect still presents the stale cached authority')
  assert.equal(thirdHello?.cachedAuthority, undefined)
  assert.equal(thirdHello?.lastRevision, undefined)
  assert.equal(thirdHello?.lastEventSeq, undefined)
  assert.equal(repository.getStatus().notice, undefined)
  assert.equal(repository.getStatus().readOnly, false)
  assert.notEqual(repository.getStatus().notice, 'device_revoked')
})

test('owner export, detach and handoff commands use the shared catalog', async t => {
  const server = new FakeServer()
  const { repository } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const exportedPromise = repository.exportBundle()
  const connection = [...server.clients][0]
  await until(() => connection.sent.some(frame => frame.t === 'exportBundle'), 'export request')
  const request = connection.sent.find(frame => frame.t === 'exportBundle')
  const exported = await exportedPromise
  assert.deepEqual(exported, fixtures.bundle)
  const detach = await repository.command({ type: 'admin.exportForDetach', payload: {} }, { opId: 'op-detach' })
  assert.equal(detach.status, 'applied')
  assert.deepEqual(detach.result.authority, AUTHORITY_STAMP)
  assert.deepEqual(detach.result.bundle, fixtures.bundle)
  const resume = await repository.command({
    type: 'admin.resumeServer',
    payload: { expectedEpoch: 7, bundle: fixtures.bundle },
  }, { opId: 'op-resume' })
  assert.equal(resume.status, 'applied')
  assert.deepEqual(
    connection.sent.filter(frame => frame.t === 'command').map(frame => frame.command.type),
    ['admin.exportForDetach', 'admin.resumeServer'],
  )
})

test('renderer-provided SavePatch cannot enter RemoteRepository commands', async t => {
  const server = new FakeServer()
  const { repository } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  await assert.rejects(
    repository.command(
      { type: 'pet.cheer', payload: { save: { petInfo: { yb: 999999 } } } },
      { opId: 'op-patch' },
    ),
    /invalid_payload|unknown|malformed/i,
  )
  const connection = [...server.clients][0]
  assert.equal(connection.sent.some(frame => frame.t === 'command'), false)
})

test('reconnect uses capped jittered exponential backoff', async t => {
  const server = new FakeServer()
  const transport = server.transport()
  const failing = {
    connects: 0,
    connect(url, token, handlers) {
      this.connects++
      if (this.connects > 1) throw new Error('transport unavailable')
      return transport.connect(url, token, handlers)
    },
  }
  const { repository, sleeps } = await makeRepository(server, {
    transport: failing,
    backoff: { baseMs: 100, maxMs: 10_000, random: () => 0.5 },
    blockSleep: () => new Promise(resolve => setTimeout(resolve, 0)),
  })
  t.after(() => repository.stop())
  await repository.start()
  const first = [...server.clients][0]
  server.clients.delete(first)
  first.close()
  await until(() => failing.connects >= 4, 'retry attempts')
  await repository.stop()
  assert.ok(sleeps.length >= 3)
  assert.equal(sleeps[0], 75)
  assert.equal(sleeps[1], 150)
  assert.ok(sleeps.every(delay => delay >= 50 && delay <= 10_000))
})

test('remote endpoint validation requires wss for non-loopback hosts at every boundary', async () => {
  const valid = [
    'wss://pet.example/v1/sync',
    'wss://127.0.0.1:8443/v1/sync',
    'ws://localhost:8080/v1/sync',
    'ws://dev.localhost:8080/v1/sync',
    'ws://127.0.0.1:8080/v1/sync',
    'ws://127.2.3.4:8080/v1/sync',
    'ws://[::1]:8080/v1/sync',
  ]
  for (const url of valid) assert.equal(assertRemoteServerUrl(url), url)
  const insecure = [
    'ws://pet.example/v1/sync',
    'ws://localhost.evil.example/v1/sync',
    'ws://127.0.0.1.evil.example/v1/sync',
    'https://pet.example/v1/sync',
    'wss://user:pass@pet.example/v1/sync',
    'ws://user:pass@127.0.0.1:8080/v1/sync',
    'not a url',
  ]
  for (const url of insecure) {
    assert.throws(() => assertRemoteServerUrl(url), /ws:\/\/|wss|loopback|invalid_payload/i)
  }

  const mod = await import('../../src/main/remote-repository.ts')
  const store = new MemoryTokenStore()
  store.token = TOKEN
  const noopTransport = { connect() { throw new Error('must not connect') } }
  assert.throws(
    () => new mod.RemoteRepository({
      serverUrl: 'ws://pet.example/v1/sync',
      appVersion: 'test',
      tokenStore: store,
      transport: noopTransport,
    }),
    /loopback|wss/i,
  )
  assert.doesNotThrow(() => new mod.RemoteRepository({
    serverUrl: 'ws://localhost:8080/v1/sync',
    appVersion: 'test',
    tokenStore: store,
    transport: noopTransport,
  }))
  assert.doesNotThrow(() => new mod.RemoteRepository({
    serverUrl: 'wss://pet.example/v1/sync',
    appVersion: 'test',
    tokenStore: store,
    transport: noopTransport,
  }))

  let socketsCreated = 0
  class FakeSocket {
    constructor(url) {
      socketsCreated += 1
      this.url = url
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
    }
    send() {}
    close() {}
  }
  const transport = createWebSocketTransport(FakeSocket)
  const handlers = { onOpen() {}, onMessage() {}, onClose() {} }
  assert.throws(() => transport.connect('ws://pet.example/v1/sync', null, handlers), /loopback|wss/i)
  assert.equal(socketsCreated, 0, 'the transport must reject before constructing a socket')
  transport.connect('ws://127.0.0.1:8080/v1/sync', null, handlers)
  transport.connect('wss://pet.example/v1/sync', null, handlers)
  assert.equal(socketsCreated, 2)
})

test('fatal hello closes reject start and do not reconnect', async t => {
  for (const scenario of [
    { code: 4000, reason: 'auth_failed' },
    { code: 4001, reason: 'protocol_mismatch' },
  ]) {
    await t.test(scenario.reason, async t => {
      const server = new FakeServer()
      const transport = new FakeTransport((connection, frame) => {
        if (frame.t === 'hello') {
          connection.close(scenario.code, scenario.reason)
        }
      })
      const { repository } = await makeRepository(server, { transport })
      t.after(() => repository.stop())
      await assert.rejects(repository.start(), new RegExp(scenario.reason))
      await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(transport.connections.length, 1, 'a terminal hello close must not be retried')
      assert.equal(repository.getStatus().state, 'error')
      assert.equal(repository.getStatus().connection, 'error')
    })
  }
})

test('reconnect backoff is not reset by a socket open before welcome', async t => {
  let connects = 0
  const transport = {
    connect(_url, _token, handlers) {
      connects += 1
      const connection = { send() {}, close() {} }
      queueMicrotask(() => {
        handlers.onOpen()
        queueMicrotask(() => handlers.onClose({ code: 1006, reason: 'dropped before welcome' }))
      })
      return connection
    },
  }
  const server = new FakeServer()
  const { repository, sleeps } = await makeRepository(server, {
    transport,
    backoff: { baseMs: 100, maxMs: 10_000, random: () => 0.5 },
  })
  t.after(() => repository.stop())
  const startup = repository.start()
  await until(() => connects >= 4, 'pre-welcome reconnect attempts')
  await repository.stop()
  await startup
  assert.ok(sleeps.length >= 3)
  assert.equal(sleeps[0], 75)
  assert.equal(sleeps[1], 150)
  assert.equal(sleeps[2], 300)
})

test('pairing exchange persists the issued token and never exposes secrets', async t => {
  const server = new FakeServer()
  const store = new MemoryTokenStore()
  const transport = new FakeTransport(async (connection, frame) => {
    if (frame.t !== 'hello') return
    assert.equal(frame.auth.kind, 'pairing')
    assert.equal(frame.auth.code, PAIRING_CODE)
    assert.equal(frame.auth.deviceLabel, 'Desktop C10')
    connection.emit(welcomeFrame(OWNER_DEVICE_ID, 'snapshot', ISSUED_TOKEN))
    connection.emit(snapshotFrame(server.shared, server.revision, server.eventSeq, AUTHORITY))
    connection.emit(readyFrame(server.revision, server.eventSeq, AUTHORITY))
  })
  const logs = []
  const original = { log: console.log, error: console.error, warn: console.warn }
  console.log = (...args) => logs.push(args)
  console.error = (...args) => logs.push(args)
  console.warn = (...args) => logs.push(args)
  t.after(() => Object.assign(console, original))
  const mod = await import('../../src/main/remote-repository.ts')
  const repository = new mod.RemoteRepository({
    serverUrl: WSS_URL,
    appVersion: 'test',
    tokenStore: store,
    transport,
    pair: { code: PAIRING_CODE, deviceLabel: 'Desktop C10' },
    exportRequestTimeoutMs: 50,
  })
  t.after(() => repository.stop())
  await repository.start()
  await until(() => store.token === ISSUED_TOKEN, 'paired token persistence')
  assert.equal(store.writes.includes(ISSUED_TOKEN), true)
  assert.equal(JSON.stringify(repository.getStatus()).includes(ISSUED_TOKEN), false)
  assert.equal(JSON.stringify(repository.getStatus()).includes(PAIRING_CODE), false)
  assert.equal(logs.flat().join(' ').includes(PAIRING_CODE), false)
  assert.equal(logs.flat().join(' ').includes(ISSUED_TOKEN), false)
})

test('canonical weather city follows live projections and survives projection-cache restart', async t => {
  const server = new FakeServer()
  const first = await makeRepository(server)
  t.after(() => first.repository.stop())
  await first.repository.start()
  assert.equal(first.repository.getWeatherCity(), WEATHER_LOCATION)
  const connection = [...server.clients][0]

  server.weatherLocation = '北京'
  server.revision += 1
  server.eventSeq += 1
  connection.emit(server.projectionFrame())
  await until(() => first.repository.getWeatherCity() === '北京', 'live weather projection')
  await until(() => first.store.cacheWrites.at(-1)?.weatherLocation === '北京', 'weather cache write')
  await first.repository.stop()

  const transport = new FakeTransport(() => {})
  const restored = await makeRepository(server, {
    store: first.store,
    config: first.store.config,
    transport,
  })
  t.after(() => restored.repository.stop())
  const starting = restored.repository.start()
  await until(() => restored.repository.hasProjectionCache(), 'weather cache restore')
  assert.equal(restored.repository.getWeatherCity(), '北京')
  const restoredConnection = transport.connections[0]
  const welcome = welcomeFrame(OWNER_DEVICE_ID, 'snapshot', undefined, '广州')
  welcome.headRevision = server.revision
  welcome.headEventSeq = server.eventSeq
  restoredConnection.emit(welcome)
  restoredConnection.emit(snapshotFrame(server.shared, server.revision, server.eventSeq, AUTHORITY, '广州'))
  restoredConnection.emit(readyFrame(server.revision, server.eventSeq, AUTHORITY, false, '广州'))
  await starting
  await until(() => restored.repository.getWeatherCity() === '广州', 'reconnected weather')
  assert.equal(restored.repository.getStatus().weatherCity, '广州')
})

test('accepted state is persisted as a validated v2 cache and restored before the handshake', async t => {
  const server = new FakeServer()
  const first = await makeRepository(server)
  t.after(() => first.repository.stop())
  await first.repository.start()
  await until(() => first.store.cacheWrites.length > 0, 'projection cache write')
  const cache = first.store.projectionCache
  assert.equal(cache.format, REMOTE_PROJECTION_CACHE_FORMAT)
  assert.equal(validateRemoteProjectionCacheV2(cache), true)
  assert.equal(cache.petId, PET_ID)
  assert.equal(cache.deviceId, OWNER_DEVICE_ID)
  assert.equal(cache.revision, server.revision)
  assert.equal(cache.eventSeq, server.eventSeq)
  assert.deepEqual(cache.shared, server.shared)
  assert.deepEqual(cache.authority, AUTHORITY)
  assert.equal(cache.weatherLocation, WEATHER_LOCATION)
  await first.repository.stop()

  const transport = new FakeTransport(() => {})
  const restored = await makeRepository(server, {
    store: first.store,
    config: first.store.config,
    transport,
  })
  t.after(() => restored.repository.stop())
  const starting = restored.repository.start()
  await until(
    () => transport.connections.length > 0
      && transport.connections[0].sent.some(frame => frame.t === 'hello'),
    'restored hello',
  )
  const hello = transport.connections[0].sent.find(frame => frame.t === 'hello')
  assert.equal(hello.lastRevision, server.revision)
  assert.equal(hello.lastEventSeq, server.eventSeq)
  assert.deepEqual(hello.cachedAuthority, {
    authorityId: AUTHORITY.authorityId,
    restoreGeneration: AUTHORITY.restoreGeneration,
    epoch: AUTHORITY.epoch,
  })
  assert.deepEqual(restored.repository.getProjection().shared, server.shared)
  assert.deepEqual(restored.repository.getProjection().authority, AUTHORITY)
  assert.equal(restored.repository.getWeatherCity(), WEATHER_LOCATION)
  assert.equal(restored.repository.getStatus().weatherCity, WEATHER_LOCATION)
  assert.equal(restored.repository.getStatus().readOnly, true, 'a restored cache is not writable before ready')
  assert.equal(restored.repository.getStatus().revision, server.revision)
  assert.equal(restored.repository.hasProjectionCache(), true)
  await restored.repository.stop()
  await starting
})

test('a seeded device-local overlay is persisted in the v2 projection cache', async t => {
  const server = new FakeServer()
  const seed = clone(fixtures.device)
  seed.settings.zoom = 1.75
  seed.settings.petDisplayId = 2
  seed.settings.aiKey = 'sk-seeded-overlay'
  seed.petInfo.lastX = 123
  const { repository, store } = await makeRepository(server, { deviceOverlay: seed })
  t.after(() => repository.stop())
  await repository.start()
  await until(() => store.cacheWrites.length > 0, 'initial cache write')
  assert.equal(store.projectionCache.device.settings.zoom, 1.75)
  assert.equal(store.projectionCache.device.settings.petDisplayId, 2)
  assert.equal(store.projectionCache.device.settings.aiKey, 'sk-seeded-overlay')
  assert.equal(store.projectionCache.device.petInfo.lastX, 123)

  await repository.updateLocalSettings({
    settings: { zoom: 2.25, petDisplayId: 3, aiKey: 'sk-updated-overlay' },
    petInfo: { lastX: 456 },
  })
  await repository.flush()
  assert.equal(store.projectionCache.device.settings.zoom, 2.25)
  assert.equal(store.projectionCache.device.settings.petDisplayId, 3)
  assert.equal(store.projectionCache.device.settings.aiKey, 'sk-updated-overlay')
  assert.equal(store.projectionCache.device.petInfo.lastX, 456)
})

test('invalid projection caches are discarded and never advertised in hello', async t => {
  const server = new FakeServer()
  const transport = server.transport()
  const store = new MemoryTokenStore()
  store.projectionCache = {
    format: REMOTE_PROJECTION_CACHE_FORMAT,
    schemaVersion: 999,
    petId: PET_ID,
    deviceId: OWNER_DEVICE_ID,
    revision: 99,
    eventSeq: 99,
  }
  const { repository } = await makeRepository(server, { store, transport })
  t.after(() => repository.stop())
  await repository.start()
  const hello = transport.connections[0].sent.find(frame => frame.t === 'hello')
  assert.equal(hello.lastRevision, undefined)
  assert.equal(hello.lastEventSeq, undefined)
  assert.equal(hello.cachedAuthority, undefined)
  assert.equal(store.projectionCache, null)
  assert.equal(store.cacheClears > 0, true)
  assert.deepEqual(repository.getProjection().shared, server.shared)
  assert.equal(repository.getStatus().state, 'online')
})

test('a valid reset-lineage cache is discarded instead of advertised', async t => {
  const server = new FakeServer()
  const transport = server.transport()
  const store = new MemoryTokenStore()
  store.projectionCache = {
    format: REMOTE_PROJECTION_CACHE_FORMAT,
    schemaVersion: 1,
    petId: PET_ID,
    deviceId: OWNER_DEVICE_ID,
    revision: 42,
    eventSeq: 43,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: { ...AUTHORITY, state: 'reset' },
    shared: clone(server.shared),
    device: clone(fixtures.device),
  }
  const { repository } = await makeRepository(server, { store, transport })
  t.after(() => repository.stop())
  await repository.start()
  const hello = transport.connections[0].sent.find(frame => frame.t === 'hello')
  assert.equal(hello.lastRevision, undefined)
  assert.equal(hello.lastEventSeq, undefined)
  assert.equal(hello.cachedAuthority, undefined)
  assert.equal(store.projectionCache, null)
  assert.equal(repository.getStatus().revision, server.revision)
  assert.deepEqual(repository.getProjection().shared, server.shared)
})

test('authority reset clears the projection cache until a fresh snapshot is accepted', async t => {
  const server = new FakeServer()
  let resyncFrame = null
  const transport = new FakeTransport((connection, frame) => {
    if (frame.t === 'resync') {
      resyncFrame = frame
      return
    }
    server.handle(connection, frame)
  })
  const { repository, store } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()
  await until(() => store.cacheWrites.length > 0, 'initial cache write')
  const connection = [...server.clients][0]
  connection.emit({
    t: 'authorityResetRequired',
    code: 'authority_reset_required',
    v: PROTOCOL_VERSION,
    requestId: 'reset-' + PET_ID,
    authority: clone(RESET_STAMP),
    reason: 'cache_newer',
    requireFullSnapshot: true,
  })
  await until(() => resyncFrame !== null, 'authority-reset resync')
  assert.equal(resyncFrame.discardCachedAuthority, true)
  await repository.flush()
  assert.equal(store.projectionCache, null)
  assert.equal(repository.getProjection(), null)
  assert.equal(repository.getStatus().readOnly, true)
  assert.equal(repository.hasProjectionCache(), false)
  assert.equal(store.cacheClears > 0, true)
})

test('device revocation clears the public projection and persisted cache', async t => {
  const server = new FakeServer()
  const { repository, store } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  await until(() => store.cacheWrites.length > 0, 'initial cache write')
  const connection = [...server.clients][0]
  connection.emit({
    t: 'deviceRevoked',
    v: PROTOCOL_VERSION,
    deviceId: OWNER_DEVICE_ID,
    revokedAtMs: GAME_TIME_MS,
  })
  await repository.flush()
  assert.equal(store.projectionCache, null)
  assert.equal(repository.getProjection(), null)
  assert.equal(repository.getStatus().notice, 'device_revoked')
  assert.equal(repository.getStatus().readOnly, true)
  assert.equal(store.cacheClears > 0, true)
})

test('replay-only ready with a stale cached revision falls back to a full snapshot', async t => {
  const server = new FakeServer()
  const transport = server.transport()
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()
  const resyncs = []
  repository.onResync((projection, events) => resyncs.push({ projection, events }))
  server.muteProjection = [...server.clients][0]
  await repository.command({ type: 'pet.cheer', payload: {} }, { opId: 'op-replay' })
  assert.equal(repository.getProjection().revision, server.revision - 1)
  const connection = [...server.clients][0]
  server.clients.delete(connection)
  server.muteProjection = null
  server.replayDeliveryOnReconnect = true
  connection.close()
  await until(() => resyncs.length > 0, 'full-snapshot recovery')
  const recovered = resyncs.at(-1)
  assert.equal(recovered.projection.revision, server.revision)
  assert.equal(recovered.projection.eventSeq, server.eventSeq)
  assert.deepEqual(recovered.projection.shared, server.shared)
  assert.equal(recovered.events.length, 0, 'the stale replay was discarded in favor of the snapshot')
  const latest = transport.connections.at(-1)
  assert.equal(latest.sent.some(frame => frame.t === 'resync'), true)
  assert.equal(repository.getProjection().authority.authorityId, AUTHORITY.authorityId)
  assert.deepEqual(repository.getProjection().shared, server.shared)
})

test('valid replay-only reconnect applies contiguous events and preserves canonical shared state', async t => {
  const server = new FakeServer()
  const transport = server.transport()
  const { repository } = await makeRepository(server, { transport })
  t.after(() => repository.stop())
  await repository.start()
  const resyncs = []
  repository.onResync((projection, events) => resyncs.push({ projection, events }))
  const first = [...server.clients][0]
  const eventTwo = {
    eventSeq: 2,
    revision: 1,
    commandSeq: 1,
    gameTimeMs: GAME_TIME_MS,
    type: 'reward.granted',
    payload: { amount: 1 },
  }
  first.emit({
    t: 'projection',
    v: PROTOCOL_VERSION,
    revision: server.revision,
    eventSeq: 2,
    gameTimeMs: server.gameTimeMs(),
    timeZone: server.timeZone,
    advanceWhileEmpty: server.advanceWhileEmpty,
    authority: clone(server.authority),
    save: clone(server.shared),
    events: [eventTwo],
  })
  await until(() => repository.getProjection()?.eventSeq === 2, 'cached event cursor')
  await repository.flush()
  server.eventSeq = 3
  server.projectionEvents.set(3, {
    ...clone(eventTwo),
    eventSeq: 3,
    commandSeq: 2,
  })
  server.clients.delete(first)
  server.replayDeliveryOnReconnect = true
  first.close()
  await until(() => resyncs.length > 0, 'replay resync delivery')
  const delivered = resyncs.at(-1)
  assert.equal(delivered.projection.revision, server.revision)
  assert.equal(delivered.projection.eventSeq, server.eventSeq)
  assert.deepEqual(delivered.projection.shared, server.shared)
  assert.deepEqual(repository.getProjection().shared, server.shared)
  assert.equal(delivered.events.length, 1)
  assert.equal(delivered.events[0].eventSeq, 3)
  assert.equal(repository.getStatus().state, 'online')
  assert.equal(repository.getStatus().readOnly, false)
})

test('replay validation rejects lower starts, empty ranges and missing interiors', async t => {
  const scenarios = [
    {
      name: 'lower start',
      frame: { fromEventSeq: 1, toEventSeq: 2, events: [{ eventSeq: 2, revision: 1, gameTimeMs: GAME_TIME_MS, type: 'reward.granted', payload: { amount: 1 } }] },
    },
    {
      name: 'empty range',
      frame: { fromEventSeq: 2, toEventSeq: 2, events: [] },
    },
    {
      name: 'missing interior',
      frame: {
        fromEventSeq: 2,
        toEventSeq: 4,
        events: [
          { eventSeq: 2, revision: 1, gameTimeMs: GAME_TIME_MS, type: 'reward.granted', payload: { amount: 1 } },
          { eventSeq: 4, revision: 1, gameTimeMs: GAME_TIME_MS, type: 'reward.granted', payload: { amount: 1 } },
        ],
      },
    },
  ]
  for (const scenario of scenarios) {
    const server = new FakeServer()
    const resyncs = []
    const transport = new FakeTransport((connection, frame) => {
      if (frame.t === 'resync') {
        resyncs.push(frame)
        return
      }
      server.handle(connection, frame)
    })
    const { repository } = await makeRepository(server, { transport })
    await repository.start()
    const connection = [...server.clients][0]
    const welcome = welcomeFrame(OWNER_DEVICE_ID, 'replay')
    welcome.headRevision = 1
    welcome.headEventSeq = 4
    connection.emit(welcome)
    connection.emit({
      t: 'replay',
      v: PROTOCOL_VERSION,
      ...scenario.frame,
    })
    await until(() => resyncs.length > 0, 'invalid replay resync for ' + scenario.name)
    assert.equal(resyncs[0].lastRevision, 1, scenario.name)
    assert.equal(resyncs[0].lastEventSeq, 1, scenario.name)
    assert.equal(repository.getStatus().state, 'catching_up', scenario.name)
    assert.equal(connection.sent.some(frame => frame.t === 'command'), false, scenario.name)
    await repository.stop()
  }
})

test('PairingStore encrypts the token with safeStorage and fails closed when unavailable', async () => {
  const mod = await import('../../src/main/pairing-store.ts')
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-c10-store-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('encrypted:' + Buffer.from(value).toString('base64')),
    decryptString: buffer => {
      const text = buffer.toString()
      assert.equal(text.startsWith('encrypted:'), true)
      return Buffer.from(text.slice('encrypted:'.length), 'base64').toString()
    },
  }
  const pairing = new mod.PairingStore({ userDataPath: dir, safeStorage })
  await pairing.saveToken(TOKEN)
  await pairing.saveConfig({
    serverUrl: WSS_URL,
    petId: PET_ID,
    deviceId: OWNER_DEVICE_ID,
    lastRevision: 1,
    lastEventSeq: 2,
  })
  const tokenFile = readFileSync(join(dir, mod.REMOTE_TOKEN_FILE), 'utf8')
  const configFile = readFileSync(join(dir, mod.REMOTE_SYNC_CONFIG_FILE), 'utf8')
  assert.equal(tokenFile.includes(TOKEN), false)
  assert.equal(configFile.includes(TOKEN), false)
  assert.equal(await pairing.loadToken(), TOKEN)
  assert.equal((await pairing.loadConfig()).lastRevision, 1)
  const cache = clone(fixtures.remoteCache)
  await pairing.saveProjectionCache(cache)
  const cacheFile = join(dir, mod.REMOTE_PROJECTION_CACHE_FILE)
  const cacheText = readFileSync(cacheFile, 'utf8')
  assert.equal(cacheText.includes(TOKEN), false)
  assert.deepEqual(await pairing.loadProjectionCache(), cache)
  await assert.rejects(
    pairing.saveProjectionCache({ ...cache, schemaVersion: 999 }),
    /remote projection cache is invalid/,
  )
  writeFileSync(cacheFile, '{"format":"broken"}')
  assert.equal(await pairing.loadProjectionCache(), null)
  assert.equal(existsSync(cacheFile), false, 'a corrupt cache is discarded')
  await pairing.saveProjectionCache(cache)
  await pairing.clear()
  assert.equal(await pairing.loadToken(), null)
  assert.equal(await pairing.loadConfig(), null)
  assert.equal(await pairing.loadProjectionCache(), null)
  const unavailable = new mod.PairingStore({
    userDataPath: dir,
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false },
  })
  await assert.rejects(unavailable.saveToken(TOKEN), /safeStorage unavailable/)
})

test('C11 enables desktop server mode by default while mobile stays explicitly disabled', () => {
  const desktop = desktopServerModeCapability({}, 'linux')
  assert.equal(desktop.flagEnabled, true)
  assert.equal(desktop.canActivate, true)
  assert.equal(desktop.serverMode, true)
  assert.equal(desktopServerModeCapability({}, 'darwin').canActivate, true)
  assert.equal(desktopServerModeCapability({}, 'win32').canActivate, true)
  const mobile = desktopServerModeCapability({}, 'android')
  assert.equal(mobile.canActivate, false)
  assert.equal(mobile.serverMode, false)
  assert.equal(mobile.reason, 'mobile_server_mode_forbidden')
  assert.equal(desktopServerModeCapability({}, 'ios').reason, 'mobile_server_mode_forbidden')
  assert.equal(typeof IPC.remoteStatus, 'string')
  assert.equal(typeof IPC.remotePair, 'string')
  assert.equal(typeof IPC.remoteRevoke, 'string')
  assert.equal(typeof IPC.storageStatus, 'string')
  assert.equal(typeof IPC.storageSetMode, 'string')
})

test('mobile builds never import the desktop remote implementation', () => {
  const files = [
    'src/android/bridge.ts',
    'src/harmony/bridge.ts',
    'src/ios/bridge.ts',
    'src/mobile/local-repository-bridge.ts',
  ]
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.doesNotMatch(source, /RemoteRepository|remote-repository|pairing-store|server-mode|remote-websocket-transport|new WebSocket|wss:\/\//, file)
    assert.match(source, /serverMode:\s*false/, file)
  }
})

test('protocol validation rejects unsupported versions before the repository accepts frames', () => {
  assert.equal(parseServerMessage({ ...welcomeFrame(OWNER_DEVICE_ID), v: 99 }).ok, false)
  assert.equal(parseClientMessage({
    t: 'hello',
    v: 99,
    requestId: 'bad',
    appVersion: 'test',
    auth: { kind: 'token', token: TOKEN },
  }).ok, false)
})

test('deviceRevoked broadcast for another device leaves the live owner projection intact', async t => {
  const server = new FakeServer()
  const { repository, store } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const before = repository.getProjection()
  assert.ok(before)
  const connection = [...server.clients][0]
  connection.emit({
    t: 'deviceRevoked',
    v: PROTOCOL_VERSION,
    deviceId: PLAYER_DEVICE_ID,
    revokedAtMs: GAME_TIME_MS,
  })
  await repository.flush()
  assert.equal(repository.getStatus().notice, undefined)
  assert.deepEqual(repository.getProjection()?.shared, before.shared)
  assert.equal(repository.getProjection()?.revision, before.revision)
  assert.equal(store.projectionCache === null, false)
})

test('archived owner can issue the detach/resume handoff commands through RemoteRepository', async t => {
  const server = new FakeServer()
  const { repository } = await makeRepository(server)
  t.after(() => repository.stop())
  await repository.start()
  const connection = [...server.clients][0]
  const current = repository.getProjection()
  connection.emit(readyFrame(current.revision, current.eventSeq, ARCHIVED_AUTHORITY))
  await until(() => repository.getStatus().authority.state === 'archived', 'archived ready')
  assert.equal(repository.getStatus().readOnly, true)

  const detached = await repository.command({ type: 'admin.exportForDetach', payload: {} }, { opId: 'op-archived-detach' })
  assert.equal(detached.status, 'applied')
  const resumed = await repository.command({
    type: 'admin.resumeServer',
    payload: { expectedEpoch: 7, bundle: fixtures.bundle },
  }, { opId: 'op-archived-resume' })
  assert.equal(resumed.status, 'applied')
  assert.deepEqual(
    connection.sent.filter(frame => frame.t === 'command').map(frame => frame.command.type),
    ['admin.exportForDetach', 'admin.resumeServer'],
  )
})
