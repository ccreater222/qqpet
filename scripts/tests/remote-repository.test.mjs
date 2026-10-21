import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
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
  parseClientMessage,
  parseServerMessage,
} = await import('../../src/shared/sync/index.ts')
const { IPC } = await import('../../src/shared/ipc.ts')
const {
  DESKTOP_SERVER_MODE_ENV_FLAG,
  desktopServerModeCapability,
} = await import('../../src/main/renderer-runtime-flags.ts')
const { createSyncFixtures, GAME_TIME_MS } = await import('./sync-fixtures.mjs')

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

function welcomeFrame(deviceId, delivery = 'snapshot', issuedToken) {
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
    authority: clone(AUTHORITY),
    headRevision: 1,
    headEventSeq: 1,
    catchingUp: false,
    delivery,
    ...(issuedToken === undefined ? {} : { issuedToken }),
  }
}

function snapshotFrame(shared, revision, eventSeq, authority) {
  return {
    t: 'snapshot',
    v: PROTOCOL_VERSION,
    revision,
    eventSeq,
    gameTimeMs: GAME_TIME_MS + revision * 60_000,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: clone(authority),
    save: clone(shared),
  }
}

function readyFrame(revision, eventSeq, authority, catchingUp = false) {
  return {
    t: 'ready',
    v: PROTOCOL_VERSION,
    revision,
    eventSeq,
    gameTimeMs: GAME_TIME_MS + revision * 60_000,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
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
  writes = []
  configWrites = []

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

  async clear() {
    this.token = null
    this.config = null
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
    this.authority = clone(AUTHORITY)
    this.pairingCode = PAIRING_CODE
    this.issuedToken = ISSUED_TOKEN
    this.dropResultOnce = false
    this.gapAfterCommandOnce = false
    this.authorityResetAfterCommandOnce = false
    this.forceNotApplied = new Set()
    this.replayDeliveryOnReconnect = false
    this.muteProjection = null
  }

  gameTimeMs() {
    return GAME_TIME_MS + this.revision * 60_000
  }

  transport() {
    return new FakeTransport((connection, frame) => this.handle(connection, frame))
  }

  snapshotFrame() {
    return snapshotFrame(this.shared, this.revision, this.eventSeq, this.authority)
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
        connection.emit(welcomeFrame(deviceId, 'replay'))
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
      ))
      connection.emit(this.snapshotFrame())
      connection.emit(readyFrame(this.revision, this.eventSeq, this.authority))
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

test('replay-only reconnect catches up cached projections without a full snapshot', async t => {
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
  await until(() => resyncs.length > 0, 'replay resync delivery')
  assert.equal(resyncs.at(-1).projection.revision, server.revision)
  assert.equal(resyncs.at(-1).projection.eventSeq, server.eventSeq)
  assert.equal(resyncs.at(-1).events.length, 1)
  assert.equal(resyncs.at(-1).events[0].eventSeq, server.eventSeq)
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
  await pairing.clear()
  assert.equal(await pairing.loadToken(), null)
  assert.equal(await pairing.loadConfig(), null)
  const unavailable = new mod.PairingStore({
    userDataPath: dir,
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false },
  })
  await assert.rejects(unavailable.saveToken(TOKEN), /safeStorage unavailable/)
})

test('desktop server-mode feature flag keeps mobile explicitly disabled', () => {
  const disabled = desktopServerModeCapability({}, 'linux')
  assert.equal(disabled.flagEnabled, false)
  assert.equal(disabled.canActivate, false)
  assert.equal(disabled.serverMode, false)
  assert.equal(disabled.reason, 'flag_disabled')
  const enabled = desktopServerModeCapability({ [DESKTOP_SERVER_MODE_ENV_FLAG]: '1' }, 'linux')
  assert.equal(enabled.canActivate, true)
  assert.equal(enabled.serverMode, true)
  const mobile = desktopServerModeCapability({ [DESKTOP_SERVER_MODE_ENV_FLAG]: '1' }, 'android')
  assert.equal(mobile.canActivate, false)
  assert.equal(mobile.serverMode, false)
  assert.equal(mobile.reason, 'mobile_server_mode_forbidden')
  assert.equal(typeof IPC.remoteStatus, 'string')
  assert.equal(typeof IPC.remotePair, 'string')
  assert.equal(typeof IPC.remoteRevoke, 'string')
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
