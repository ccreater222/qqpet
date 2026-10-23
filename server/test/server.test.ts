import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, type ServerToClient } from '../../src/shared/sync/index.js'
import { createServerConfig, type ServerConfig, type ServerConfigInput } from '../src/config.js'
import { initializePet, openDatabase, openDatabaseReadOnly } from '../src/db.js'
import { SyncServer } from '../src/index.js'
import { finalizeSurvivor } from '../src/coverage.js'
import type { CoverageSurvivor } from '../../src/shared/pet-runtime/index.js'

interface Harness {
  directory: string
  dbPath: string
  config: ServerConfig
  server: SyncServer
  url: string
  pairingCode: string
  close(): Promise<void>
}

interface Session {
  ws: WebSocket
  token: string
  petId: string
  deviceId: string
  readonly welcome: Extract<ServerToClient, { t: 'welcome' }>
  messages: ServerToClient[]
  next(type: ServerToClient['t']): Promise<ServerToClient>
  send(value: unknown): void
  close(): Promise<void>
}

async function createHarness(t: test.TestContext, input: ServerConfigInput = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-'))
  const dbPath = join(directory, 'qqpet.sqlite')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    adminSocket: join(directory, 'admin.sock'),
    helloTimeoutMs: 500,
    schedulerEnabled: false,
    ...input,
  })
  const store = openDatabase(dbPath)
  const init = initializePet(store, {
    petId: 'default',
    timeZone: 'Asia/Shanghai',
    weatherCity: '北京',
    nowMs: Date.UTC(2026, 9, 20, 4, 0, 0),
  })
  const server = new SyncServer(config, store)
  await server.start()
  const address = server.address()
  const harness: Harness = {
    directory,
    dbPath,
    config,
    server,
    url: 'ws://127.0.0.1:' + address.port + '/v1/sync',
    pairingCode: init.pairingCode,
    async close() {
      await server.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
  t.after(() => harness.close())
  return harness
}

function waitFor(session: Session, type: ServerToClient['t']): Promise<ServerToClient> {
  return session.next(type)
}

async function readUntil(session: Session, type: ServerToClient['t']): Promise<ServerToClient> {
  return waitFor(session, type)
}

async function connect(
  harness: Harness,
  auth: { kind: 'pairing'; code: string; deviceLabel: string } | { kind: 'token'; token: string },
  cursors: { lastRevision?: number; lastEventSeq?: number } = {},
  helloExtras: Record<string, unknown> = {},
): Promise<Session> {
  const ws = new WebSocket(harness.url, { perMessageDeflate: false })
  const queue: ServerToClient[] = []
  const waiters: Array<{ type: ServerToClient['t']; resolve(value: ServerToClient): void; reject(error: Error): void }> = []
  let token = auth.kind === 'token' ? auth.token : ''
  let petId = 'default'
  let deviceId = ''
  let closeError: Error | undefined
  ws.on('message', data => {
    const value = JSON.parse(data.toString()) as ServerToClient
    if (value.t === 'welcome') {
      petId = value.petId
      deviceId = value.deviceId
      if (value.issuedToken !== undefined) token = value.issuedToken
    }
    const index = waiters.findIndex(waiter => waiter.type === value.t)
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0]
      waiter.resolve(value)
    } else {
      queue.push(value)
    }
  })
  ws.on('close', (code, reason) => {
    closeError = new Error('socket closed: ' + code + ' ' + reason.toString())
    for (const waiter of waiters.splice(0)) waiter.reject(closeError)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const session: Session = {
    ws,
    welcome: undefined as never,
    get token() {
      return token
    },
    get petId() {
      return petId
    },
    get deviceId() {
      return deviceId
    },
    get messages() {
      return queue
    },
    next(type) {
      const index = queue.findIndex(message => message.t === type)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0])
      if (closeError) return Promise.reject(closeError)
      return new Promise((resolve, reject) => waiters.push({ type, resolve, reject }))
    },
    send(value) {
      ws.send(JSON.stringify(value))
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return
      const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
      ws.close(1000, 'test')
      await closed
    },
  }
  session.send({
    t: 'hello',
    v: PROTOCOL_VERSION,
    requestId: 'hello-' + Math.random(),
    appVersion: 'test',
    ...cursors,
    ...helloExtras,
    auth,
  })
  const welcome = await session.next('welcome')
  assert.equal(welcome.t, 'welcome')
  if (welcome.t !== 'welcome') throw new Error('missing welcome')
  Object.defineProperty(session, 'welcome', { value: welcome, enumerable: true })
  return session
}

async function pairOwner(harness: Harness): Promise<Session> {
  const session = await connect(harness, {
    kind: 'pairing',
    code: harness.pairingCode,
    deviceLabel: 'Owner desktop',
  })
  await readUntil(session, 'ready')
  assert.match(session.token, /^[A-Za-z0-9_-]{43,}$/)
  return session
}

test('pairing creates an owner token, code is single use, and token reconnect authenticates', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  assert.notEqual(owner.token, '')
  await owner.close()

  await assert.rejects(
    connect(harness, { kind: 'pairing', code: harness.pairingCode, deviceLabel: 'Replay' }),
    /socket closed: 4000/,
  )

  const reconnect = await connect(harness, { kind: 'token', token: owner.token }, {
    lastRevision: 0,
    lastEventSeq: 0,
  })
  assert.equal((await readUntil(reconnect, 'ready')).t, 'ready')
  await reconnect.close()
})

test('duplicate opId returns the stored result without re-applying or consuming revision/events', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const command = {
    t: 'command' as const,
    v: PROTOCOL_VERSION,
    requestId: 'adopt-1',
    opId: 'adopt-once',
    command: { type: 'pet.adopt' as const, payload: { sex: 'GG' as const } },
  }
  owner.send(command)
  const first = await owner.next('commandResult')
  assert.equal(first.t, 'commandResult')
  if (first.t !== 'commandResult') throw new Error('unreachable')
  assert.equal(first.status, 'applied')

  owner.send({ ...command, requestId: 'adopt-2' })
  const second = await owner.next('commandResult')
  assert.equal(second.t, 'commandResult')
  if (second.t !== 'commandResult') throw new Error('unreachable')
  assert.equal(second.status, 'duplicate')
  assert.equal(second.commandSeq, first.commandSeq)
  assert.equal(second.revision, first.revision)
  assert.equal(second.eventSeq, first.eventSeq)

  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  const count = store.db.prepare('SELECT COUNT(*) AS count FROM commands WHERE pet_id = ?').get('default') as { count: number }
  assert.equal(count.count, 1)
  assert.equal(pet?.revision, first.revision)
  assert.equal(pet?.eventSeq, first.eventSeq)
  store.close()
  await owner.close()
})

test('duplicate opId with a different command type returns op_id_conflict', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const opId = 'op-conflict-type'
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'conflict-type-adopt',
    opId,
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const adopted = await owner.next('commandResult')
  if (adopted.t !== 'commandResult') throw new Error('missing adopt result')
  assert.equal(adopted.status, 'applied')
  await owner.next('projection')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'conflict-type-rename',
    opId,
    command: { type: 'pet.rename', payload: { name: 'WrongCommand' } },
  })
  const conflict = await owner.next('commandResult')
  if (conflict.t !== 'commandResult') throw new Error('missing conflict result')
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.commandType, 'pet.rename')
  assert.equal(conflict.error?.code, 'op_id_conflict')
  assert.equal(conflict.error?.refreshProjection, false)

  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  const count = store.db.prepare(
    'SELECT COUNT(*) AS count FROM commands WHERE pet_id = ? AND op_id = ?',
  ).get('default', opId) as { count: number }
  assert.equal(count.count, 1)
  assert.equal(pet?.revision, adopted.revision)
  assert.equal(pet?.commandSeq, adopted.commandSeq)
  store.close()
  await owner.close()
})

test('duplicate opId with a different payload returns op_id_conflict', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const opId = 'op-conflict-payload'
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'conflict-payload-first',
    opId,
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const adopted = await owner.next('commandResult')
  if (adopted.t !== 'commandResult') throw new Error('missing adopt result')
  assert.equal(adopted.status, 'applied')
  await owner.next('projection')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'conflict-payload-second',
    opId,
    command: { type: 'pet.adopt', payload: { sex: 'MM' } },
  })
  const conflict = await owner.next('commandResult')
  if (conflict.t !== 'commandResult') throw new Error('missing conflict result')
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.commandType, 'pet.adopt')
  assert.equal(conflict.error?.code, 'op_id_conflict')

  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  const rows = store.db.prepare(
    'SELECT op_id, command_type, payload_json FROM commands WHERE pet_id = ?',
  ).all('default') as Array<{ op_id: string; command_type: string; payload_json: string }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0].payload_json, JSON.stringify({ sex: 'GG' }))
  assert.equal(pet?.revision, adopted.revision)
  assert.equal(pet?.commandSeq, adopted.commandSeq)
  store.close()
  await owner.close()
})

test('a rejected command is persisted with a new commandSeq and leaves revision unchanged', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt',
    opId: 'op-adopt',
    command: { type: 'pet.adopt', payload: { sex: 'MM' } },
  })
  const adopted = await owner.next('commandResult')
  if (adopted.t !== 'commandResult') throw new Error('missing result')
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt-again',
    opId: 'op-adopt-again',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const rejected = await owner.next('commandResult')
  if (rejected.t !== 'commandResult') throw new Error('missing result')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.commandSeq, adopted.commandSeq + 1)
  assert.equal(rejected.revision, adopted.revision)
  const store = openDatabase(harness.dbPath)
  const row = store.db.prepare(
    'SELECT status, command_seq, revision FROM commands WHERE pet_id = ? AND op_id = ?',
  ).get('default', 'op-adopt-again') as { status: string; command_seq: number; revision: number }
  assert.deepEqual({ ...row }, {
    status: 'rejected',
    command_seq: rejected.commandSeq,
    revision: adopted.revision,
  })
  store.close()
  await owner.close()
})

test('revision compare-and-swap rejects a stale writer without mutating canonical state', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const current = store.getPet('default')
  assert.ok(current)
  const expected = current.revision
  assert.equal(store.compareAndSwapRevision('default', expected, () => undefined), true)
  assert.equal(store.compareAndSwapRevision('default', expected, () => undefined), false)
  const after = store.getPet('default')
  assert.equal(after?.revision, expected + 1)
  store.close()
})

test('compareAndSwapRevision rolls back callback writes when the revision update loses', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  const settings = store.getSettings('default')
  assert.ok(pet)
  assert.ok(settings)
  assert.throws(
    () => store.compareAndSwapRevision('default', pet.revision, () => {
      store.db.prepare(
        'UPDATE pet_settings SET time_zone = ?, updated_at_ms = ? WHERE pet_id = ?',
      ).run('UTC', settings.updatedAtMs + 1, 'default')
      store.db.prepare('UPDATE pets SET revision = revision + 1 WHERE id = ?').run('default')
    }),
    /revision_conflict/,
  )
  const after = store.getPet('default')
  const settingsAfter = store.getSettings('default')
  assert.equal(after?.revision, pet.revision)
  assert.equal(settingsAfter?.timeZone, settings.timeZone)
  assert.equal(settingsAfter?.updatedAtMs, settings.updatedAtMs)
  store.close()
})

test('reconnect gets retained replay and a snapshot, and resync sends a fresh snapshot', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt',
    opId: 'adopt-replay',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const result = await owner.next('commandResult')
  if (result.t !== 'commandResult') throw new Error('missing result')
  await owner.close()

  const reconnecting = await connect(harness, { kind: 'token', token: owner.token }, {
    lastRevision: 0,
    lastEventSeq: 0,
  })
  const welcome = reconnecting.welcome
  assert.equal(welcome.delivery, 'replay+snapshot')
  const replay = await reconnecting.next('replay')
  if (replay.t !== 'replay') throw new Error('missing replay')
  assert.ok(replay.events.length > 0)
  assert.equal(replay.events[0].eventSeq, 1)
  const snapshot = await reconnecting.next('snapshot')
  if (snapshot.t !== 'snapshot') throw new Error('missing snapshot')
  assert.equal(snapshot.revision, result.revision)
  await reconnecting.next('ready')
  reconnecting.send({
    t: 'resync',
    v: PROTOCOL_VERSION,
    requestId: 'resync-1',
    discardCachedAuthority: true,
  })
  assert.equal((await reconnecting.next('snapshot')).t, 'snapshot')
  assert.equal((await reconnecting.next('ready')).t, 'ready')
  await reconnecting.close()
})

test('reconnect falls back to a full snapshot when a complete replay exceeds maxReplayEvents', async t => {
  const harness = await createHarness(t, { maxReplayEvents: 2 })
  const owner = await pairOwner(harness)

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'overflow-adopt',
    opId: 'overflow-adopt',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const adopted = await owner.next('commandResult')
  if (adopted.t !== 'commandResult') throw new Error('missing adopt result')
  assert.equal(adopted.status, 'applied')
  await owner.next('projection')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'overflow-rename',
    opId: 'overflow-rename',
    command: { type: 'pet.rename', payload: { name: 'ReplayOverflow' } },
  })
  const renamed = await owner.next('commandResult')
  if (renamed.t !== 'commandResult') throw new Error('missing rename result')
  assert.equal(renamed.status, 'applied')
  await owner.next('projection')
  assert.ok(renamed.eventSeq > harness.config.maxReplayEvents)
  await owner.close()

  const reconnecting = await connect(harness, { kind: 'token', token: owner.token }, {
    lastRevision: 0,
    lastEventSeq: 0,
  })
  assert.equal(reconnecting.welcome.delivery, 'snapshot')
  const snapshot = await reconnecting.next('snapshot')
  if (snapshot.t !== 'snapshot') throw new Error('missing snapshot')
  assert.equal(snapshot.eventSeq, renamed.eventSeq)
  assert.equal((await reconnecting.next('ready')).t, 'ready')
  assert.equal(reconnecting.messages.some(message => message.t === 'replay'), false)
  await reconnecting.close()
})

test('reconnect falls back to a full snapshot when retained events have a sequence gap', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  await owner.close()

  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  assert.ok(pet)
  for (const eventSeq of [1, 3]) {
    store.insertEvent('default', {
      eventSeq,
      revision: pet.revision + eventSeq,
      commandSeq: null,
      gameTimeMs: pet.gameTimeMs,
      type: 'server.changed',
      payload: { retained: eventSeq },
      createdAtMs: Date.now(),
    })
  }
  store.db.prepare('UPDATE pets SET revision = ?, event_seq = ? WHERE id = ?').run(pet.revision + 2, 3, 'default')
  store.close()

  const reconnecting = await connect(harness, { kind: 'token', token: owner.token }, {
    lastRevision: pet.revision,
    lastEventSeq: pet.eventSeq,
  })
  assert.equal(reconnecting.welcome.delivery, 'snapshot')
  const snapshot = await reconnecting.next('snapshot')
  if (snapshot.t !== 'snapshot') throw new Error('missing snapshot')
  assert.equal(snapshot.eventSeq, 3)
  assert.equal((await reconnecting.next('ready')).t, 'ready')
  assert.equal(reconnecting.messages.some(message => message.t === 'replay'), false)
  await reconnecting.close()
})

test('reconnect falls back to a full snapshot when a complete replay exceeds the frame budget', async t => {
  const harness = await createHarness(t, { maxFrameBytes: 4096 })
  const owner = await pairOwner(harness)
  await owner.close()

  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  assert.ok(pet)
  assert.equal(pet.eventSeq, 0)
  const eventSeq = pet.eventSeq + 1
  const revision = pet.revision + 1
  store.insertEvent('default', {
    eventSeq,
    revision,
    commandSeq: null,
    gameTimeMs: pet.gameTimeMs,
    type: 'server.changed',
    payload: { change: 'oversized-replay', detail: 'x'.repeat(8192) },
    createdAtMs: Date.now(),
  })
  store.db.prepare('UPDATE pets SET revision = ?, event_seq = ? WHERE id = ?').run(revision, eventSeq, 'default')
  store.close()

  const reconnecting = await connect(harness, { kind: 'token', token: owner.token }, {
    lastRevision: pet.revision,
    lastEventSeq: pet.eventSeq,
  })
  assert.equal(reconnecting.welcome.delivery, 'snapshot')
  const snapshot = await reconnecting.next('snapshot')
  if (snapshot.t !== 'snapshot') throw new Error('missing snapshot')
  assert.equal(snapshot.eventSeq, eventSeq)
  assert.equal((await reconnecting.next('ready')).t, 'ready')
  assert.equal(reconnecting.messages.some(message => message.t === 'replay'), false)
  await reconnecting.close()
})

test('owner revocation closes every live device socket with 4002 and rejects token reconnect', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  console.error('[revoke] owner ready')
  const store = openDatabase(harness.dbPath)
  const player = store.issuePairingCode('default', 'player', 10 * 60_000)
  store.close()
  const playerSession = await connect(harness, {
    kind: 'pairing',
    code: player.code,
    deviceLabel: 'Player phone',
  })
  console.error('[revoke] player welcome done', playerSession.deviceId)
  await playerSession.next('ready')
  console.error('[revoke] player ready')
  const revoked = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    playerSession.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    playerSession.ws.once('error', reject)
  })
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'revoke',
    opId: 'revoke-player',
    command: { type: 'device.revoke', payload: { deviceId: playerSession.deviceId } },
  })
  const revokeResult = await owner.next('commandResult')
  console.error('[revoke] revoke result', revokeResult.t, revokeResult.t === 'commandResult' ? revokeResult.status : '')
  const notice = await owner.next('deviceRevoked')
  if (notice.t !== 'deviceRevoked') throw new Error('missing revocation notice')
  assert.equal(notice.deviceId, playerSession.deviceId)
  const close = await revoked
  console.error('[revoke] close', close.code)
  assert.equal(close.code, 4002)
  await assert.rejects(
    connect(harness, { kind: 'token', token: playerSession.token }),
    /socket closed: 4002/,
  )
  await owner.close()
})

test('transaction rollback leaves canonical revision and command sequence unchanged', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const before = store.getPet('default')
  assert.ok(before)
  assert.throws(() => {
    store.transaction(() => {
      store.db.prepare('UPDATE pets SET revision = revision + 1 WHERE id = ?').run('default')
      store.db.prepare('UPDATE pets SET command_seq = command_seq + 1 WHERE id = ?').run('default')
      throw new Error('forced rollback')
    })
  }, /forced rollback/)
  const after = store.getPet('default')
  assert.equal(after?.revision, before.revision)
  assert.equal(after?.commandSeq, before.commandSeq)
  store.close()
})

test('health and readiness expose database, log, authority, error and metric operability fields', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'health-adopt',
    opId: 'health-adopt',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const adopted = await owner.next('commandResult')
  if (adopted.t !== 'commandResult') throw new Error('missing health adopt result')
  assert.equal(adopted.status, 'applied')
  await owner.close()

  const backupPath = join(harness.directory, 'backup.sqlite')
  await harness.server.backup(backupPath)
  assert.ok((await readFile(backupPath)).byteLength > 0)

  const response = await fetch('http://127.0.0.1:' + harness.server.address().port + '/health')
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.journalMode, 'wal')
  assert.equal(body.synchronous, 'full')
  assert.equal(body.dbWritable, true)
  assert.equal(body.quickCheck, 'ok')
  assert.deepEqual(body.database, { writable: true, quickCheck: 'ok', error: null })
  assert.equal(body.commandSeq, adopted.commandSeq)
  assert.equal(body.commandLogSize, 1)
  assert.ok(body.eventLogSize >= adopted.eventSeq)
  assert.equal(body.pets, 1)
  assert.equal(Array.isArray(body.petHealth), true)
  assert.equal(body.petHealth.length, 1)
  assert.equal(body.petHealth[0].commandSeq, adopted.commandSeq)
  assert.equal(body.petHealth[0].eventSeq, adopted.eventSeq)
  assert.equal(body.petHealth[0].authorityId, harness.server.store.getAuthority('default')?.authorityId)
  assert.equal(body.petHealth[0].restoreGeneration, harness.server.store.getAuthority('default')?.restoreGeneration)
  assert.equal(body.petHealth[0].commandLogSize, 1)
  assert.ok(body.petHealth[0].eventLogSize >= adopted.eventSeq)
  assert.equal(body.petHealth[0].canonicalOk, true)
  assert.equal(body.petHealth[0].stuck, false)
  assert.ok((body.authMetrics['auth.success'] ?? 0) >= 1)
  assert.equal(body.backupMetrics['backup.success'], 1)
  assert.equal(typeof body.rateMetrics, 'object')
  assert.equal(body.lastError, null)
  const text = JSON.stringify(body)
  assert.doesNotMatch(text, /pairingCode|token|save_json|payload/i)
  for (const path of ['/healthz', '/readyz']) {
    const ready = await fetch('http://127.0.0.1:' + harness.server.address().port + path)
    assert.equal(ready.status, 200)
    const readyBody = await ready.json() as Record<string, unknown>
    assert.equal(readyBody.ok, true)
    assert.equal(readyBody.ready, true)
  }

  const corruptStore = openDatabase(harness.dbPath)
  corruptStore.db.prepare("UPDATE pets SET engine_json = '{}' WHERE id = 'default'").run()
  corruptStore.close()

  const liveness = await fetch('http://127.0.0.1:' + harness.server.address().port + '/healthz')
  assert.equal(liveness.status, 200)
  const livenessBody = await liveness.json() as Record<string, unknown>
  assert.equal(livenessBody.ok, true)
  assert.equal(livenessBody.ready, false)
  const readiness = await fetch('http://127.0.0.1:' + harness.server.address().port + '/readyz')
  assert.equal(readiness.status, 503)
  const readinessBody = await readiness.json() as Record<string, unknown>
  assert.equal(readinessBody.ok, false)
  assert.equal(readinessBody.ready, false)
  assert.equal(readinessBody.lastErrorEvent, 'canonical.health_failed')
  assert.match(String(readinessBody.lastError), /canonical engine state is corrupt/)
})

test('readiness reports a read-only database as not writable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-readonly-health-'))
  const dbPath = join(directory, 'qqpet.sqlite')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    backupDir: join(directory, 'backups'),
    adminSocket: join(directory, 'admin.sock'),
    schedulerEnabled: false,
  })
  const writable = openDatabase(dbPath)
  initializePet(writable, {
    petId: 'default',
    timeZone: 'UTC',
    nowMs: Date.now(),
  })
  writable.close()
  const readOnly = openDatabaseReadOnly(dbPath)
  const server = new SyncServer(config, readOnly)
  try {
    const health = server.health()
    assert.equal(health.dbWritable, false)
    assert.equal(health.quickCheck, 'ok')
    assert.equal(health.database.writable, false)
    assert.match(health.database.error ?? '', /readonly|read-only/i)
    assert.equal(health.ready, false)
    assert.equal(health.petHealth[0]?.dbWritable, false)
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('readyz reports archived authority as unavailable while healthz stays live', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  store.db.prepare("UPDATE pet_authority SET state = 'archived' WHERE pet_id = 'default'").run()
  store.close()

  const healthz = await fetch('http://127.0.0.1:' + harness.server.address().port + '/healthz')
  assert.equal(healthz.status, 200)
  const liveBody = await healthz.json() as Record<string, unknown>
  assert.equal(liveBody.ok, true)
  assert.equal(liveBody.ready, false)
  const readyz = await fetch('http://127.0.0.1:' + harness.server.address().port + '/readyz')
  assert.equal(readyz.status, 503)
  const readyBody = await readyz.json() as Record<string, unknown>
  assert.equal(readyBody.ok, false)
  assert.equal(readyBody.ready, false)
  assert.equal(readyBody.authorityState, 'archived')
})

const serverRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliEntry = join(serverRoot, 'dist', 'server', 'src', 'index.js')

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', cliEntry, ...args],
      { cwd: serverRoot, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

async function runCliFailure(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    await runCli(args, env)
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
  assert.fail('expected CLI command to fail')
}

function rawConnect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { perMessageDeflate: false })
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
}

function nextServerMessage(ws: WebSocket): Promise<ServerToClient> {
  return new Promise((resolve, reject) => {
    ws.once('message', data => resolve(JSON.parse(data.toString()) as ServerToClient))
    ws.once('error', reject)
  })
}

test('device.list is owner-only and returns redacted metadata', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  store.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player phone' })
  await player.next('ready')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'list-devices',
    opId: 'list-devices-1',
    command: { type: 'device.list', payload: {} },
  })
  const listed = await owner.next('commandResult')
  if (listed.t !== 'commandResult' || listed.status !== 'applied') throw new Error('device.list was not applied')
  const result = listed.result as { devices: Array<Record<string, unknown>> }
  assert.equal(result.devices.length, 2)
  const text = JSON.stringify(result)
  assert.doesNotMatch(text, /token|hash|secret/i)
  assert.ok(result.devices.some(device => device.deviceId === owner.deviceId && device.role === 'owner'))
  assert.ok(result.devices.some(device => device.deviceId === player.deviceId && device.role === 'player'))

  player.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'list-as-player',
    opId: 'list-as-player-1',
    command: { type: 'device.list', payload: {} },
  })
  const denied = await player.next('commandResult')
  if (denied.t !== 'commandResult') throw new Error('missing player result')
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.error?.code, 'unauthorized')
  assert.equal(player.ws.readyState, WebSocket.OPEN)
  await owner.close()
  await player.close()
})

test('last active owner cannot be revoked and the rejection is persisted', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'revoke-self',
    opId: 'revoke-self-1',
    command: { type: 'device.revoke', payload: { deviceId: owner.deviceId } },
  })
  const rejected = await owner.next('commandResult')
  if (rejected.t !== 'commandResult') throw new Error('missing revoke result')
  assert.equal(rejected.status, 'rejected')
  assert.match(rejected.error?.message ?? '', /last active owner/)
  assert.equal(owner.ws.readyState, WebSocket.OPEN)
  const store = openDatabase(harness.dbPath)
  const device = store.getDevice('default', owner.deviceId)
  assert.equal(device?.revokedAtMs, null)
  const row = store.db.prepare(
    'SELECT status, command_seq FROM commands WHERE pet_id = ? AND op_id = ?',
  ).get('default', 'revoke-self-1') as { status: string; command_seq: number }
  assert.deepEqual({ ...row }, { status: 'rejected', command_seq: rejected.commandSeq })
  store.close()
  await owner.close()
})

test('commandStatus resolves applied, rejected and not_applied for the owning device only', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt',
    opId: 'status-adopt',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const applied = await owner.next('commandResult')
  if (applied.t !== 'commandResult') throw new Error('missing adopt result')

  owner.send({ t: 'commandStatus', v: PROTOCOL_VERSION, requestId: 'status-1', opId: 'status-adopt' })
  const appliedStatus = await owner.next('commandStatusResult')
  if (appliedStatus.t !== 'commandStatusResult') throw new Error('missing status result')
  assert.equal(appliedStatus.status, 'applied')
  assert.equal(appliedStatus.result?.commandSeq, applied.commandSeq)

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt-again',
    opId: 'status-reject',
    command: { type: 'pet.adopt', payload: { sex: 'MM' } },
  })
  const rejected = await owner.next('commandResult')
  if (rejected.t !== 'commandResult') throw new Error('missing rejection')
  owner.send({ t: 'commandStatus', v: PROTOCOL_VERSION, requestId: 'status-2', opId: 'status-reject' })
  const rejectedStatus = await owner.next('commandStatusResult')
  if (rejectedStatus.t !== 'commandStatusResult') throw new Error('missing status result')
  assert.equal(rejectedStatus.status, 'rejected')

  owner.send({ t: 'commandStatus', v: PROTOCOL_VERSION, requestId: 'status-3', opId: 'never-sent' })
  const missing = await owner.next('commandStatusResult')
  if (missing.t !== 'commandStatusResult') throw new Error('missing status result')
  assert.equal(missing.status, 'not_applied')

  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  store.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Other device' })
  await player.next('ready')
  player.send({ t: 'commandStatus', v: PROTOCOL_VERSION, requestId: 'status-other', opId: 'status-adopt' })
  const foreign = await player.next('commandStatusResult')
  if (foreign.t !== 'commandStatusResult') throw new Error('missing status result')
  assert.equal(foreign.status, 'not_applied')
  await owner.close()
  await player.close()
})

test('an accepted command is broadcast to every authenticated pet socket', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  store.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player phone' })
  await player.next('ready')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'broadcast-adopt',
    opId: 'broadcast-adopt-1',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const result = await owner.next('commandResult')
  if (result.t !== 'commandResult') throw new Error('missing result')
  const ownerProjection = await owner.next('projection')
  const playerProjection = await player.next('projection')
  if (ownerProjection.t !== 'projection' || playerProjection.t !== 'projection') throw new Error('missing projection')
  assert.equal(ownerProjection.revision, result.revision)
  assert.equal(playerProjection.revision, result.revision)
  assert.ok(playerProjection.events.length > 0)
  assert.deepEqual(
    playerProjection.events.map(event => event.eventSeq),
    playerProjection.events.map((_, index) => playerProjection.events[0].eventSeq + index),
  )
  await owner.close()
  await player.close()
})

test('observedRevision newer than the server is rejected without mutating canonical state', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt-cas',
    opId: 'adopt-cas-1',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const adopted = await owner.next('commandResult')
  if (adopted.t !== 'commandResult') throw new Error('missing result')
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt-stale',
    opId: 'adopt-stale-1',
    observedRevision: adopted.revision + 50,
    command: { type: 'pet.rename', payload: { name: 'Stale' } },
  })
  const rejected = await owner.next('commandResult')
  if (rejected.t !== 'commandResult') throw new Error('missing result')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'invalid_payload')
  assert.equal(rejected.revision, adopted.revision)
  assert.equal((await owner.next('projection')).t, 'projection')
  const store = openDatabase(harness.dbPath)
  const pet = store.getPet('default')
  assert.equal(pet?.revision, adopted.revision)
  store.close()
  await owner.close()
})

test('archived authority rejects commands and reset authority demands a cache discard handshake', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const store = openDatabase(harness.dbPath)
  const originalAuthority = store.getAuthority('default')
  assert.ok(originalAuthority)
  store.db.prepare("UPDATE pet_authority SET state = 'archived' WHERE pet_id = 'default'").run()
  store.close()

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'archived-adopt',
    opId: 'archived-adopt-1',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const rejected = await owner.next('commandResult')
  if (rejected.t !== 'commandResult') throw new Error('missing result')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'authority_not_active')
  assert.equal(rejected.error?.refreshProjection, true)
  const archivedStatus = await owner.next('ready')
  if (archivedStatus.t !== 'ready') throw new Error('missing archived status')
  assert.equal(archivedStatus.authority.state, 'archived')
  assert.equal(owner.messages.some(message => message.t === 'projection'), false)
  await owner.close()

  const store2 = openDatabase(harness.dbPath)
  store2.db.prepare("UPDATE pet_authority SET state = 'reset' WHERE pet_id = 'default'").run()
  store2.close()

  await assert.rejects(
    connect(harness, { kind: 'token', token: owner.token }, {}, {
      cachedAuthority: {
        authorityId: originalAuthority.authorityId,
        restoreGeneration: originalAuthority.restoreGeneration,
        epoch: originalAuthority.epoch,
      },
    }),
    /socket closed: 4002/,
  )
  const recovered = await connect(harness, { kind: 'token', token: owner.token })
  assert.equal(recovered.welcome.authority.state, 'reset')
  assert.equal(recovered.welcome.delivery, 'snapshot')
  const recoveredSnapshot = await recovered.next('snapshot')
  if (recoveredSnapshot.t !== 'snapshot') throw new Error('missing reset recovery snapshot')
  assert.equal(recoveredSnapshot.authority.state, 'reset')
  assert.equal((await recovered.next('ready')).t, 'ready')
  await recovered.close()
})

test('archived sessions receive authority status only while owners retain detach bundle access', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)

  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  store.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player phone' })
  await player.next('ready')
  await player.close()
  await owner.close()

  const archiveStore = openDatabase(harness.dbPath)
  archiveStore.db.prepare("UPDATE pet_authority SET state = 'archived' WHERE pet_id = 'default'").run()
  archiveStore.close()

  const archivedOwner = await connect(harness, { kind: 'token', token: owner.token }, {
    lastRevision: 0,
    lastEventSeq: 0,
  })
  assert.equal(archivedOwner.welcome.delivery, 'none')
  const ownerStatus = await archivedOwner.next('ready')
  if (ownerStatus.t !== 'ready') throw new Error('missing owner status')
  assert.equal(ownerStatus.authority.state, 'archived')
  assert.equal(archivedOwner.messages.some(message => message.t === 'snapshot' || message.t === 'replay'), false)

  archivedOwner.send({ t: 'exportBundle', v: PROTOCOL_VERSION, requestId: 'owner-archived-bundle' })
  const bundle = await archivedOwner.next('portableBundle')
  if (bundle.t !== 'portableBundle') throw new Error('missing owner detach bundle')
  assert.equal(bundle.bundle.authority.owner, 'server')
  assert.equal(archivedOwner.messages.some(message => message.t === 'snapshot' || message.t === 'projection' || message.t === 'replay'), false)

  const archivedPlayer = await connect(harness, { kind: 'token', token: player.token }, {
    lastRevision: 0,
    lastEventSeq: 0,
  })
  assert.equal(archivedPlayer.welcome.delivery, 'none')
  const playerStatus = await archivedPlayer.next('ready')
  if (playerStatus.t !== 'ready') throw new Error('missing player status')
  assert.equal(playerStatus.authority.state, 'archived')
  assert.equal(archivedPlayer.messages.some(message => message.t === 'snapshot' || message.t === 'replay'), false)

  archivedPlayer.send({ t: 'exportBundle', v: PROTOCOL_VERSION, requestId: 'player-archived-bundle' })
  const deniedBundle = await archivedPlayer.next('error')
  if (deniedBundle.t !== 'error') throw new Error('missing player bundle denial')
  assert.equal(deniedBundle.code, 'authority_not_active')
  assert.equal(archivedPlayer.messages.some(message => message.t === 'portableBundle'), false)

  archivedPlayer.send({
    t: 'resync',
    v: PROTOCOL_VERSION,
    requestId: 'player-archived-resync',
    discardCachedAuthority: true,
  })
  const resyncStatus = await archivedPlayer.next('ready')
  if (resyncStatus.t !== 'ready') throw new Error('missing resync status')
  assert.equal(resyncStatus.authority.state, 'archived')
  assert.equal(archivedPlayer.messages.some(message => message.t === 'snapshot' || message.t === 'replay'), false)

  archivedPlayer.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'player-archived-rename',
    opId: 'player-archived-rename',
    command: { type: 'pet.rename', payload: { name: 'NotAllowed' } },
  })
  const rejected = await archivedPlayer.next('commandResult')
  if (rejected.t !== 'commandResult') throw new Error('missing archived command result')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'authority_not_active')
  const commandStatus = await archivedPlayer.next('ready')
  if (commandStatus.t !== 'ready') throw new Error('missing archived command status')
  assert.equal(commandStatus.authority.state, 'archived')
  assert.equal(archivedPlayer.messages.some(message => message.t === 'projection' || message.t === 'snapshot' || message.t === 'replay'), false)

  await archivedOwner.close()
  await archivedPlayer.close()
})

test('protocol version mismatch and unauthenticated sockets are closed with spec codes', async t => {
  const harness = await createHarness(t)
  const mismatched = await rawConnect(harness.url)
  const mismatchClose = nextClose(mismatched)
  mismatched.send(JSON.stringify({
    t: 'hello',
    v: 2,
    requestId: 'bad-version',
    appVersion: 'test',
    auth: { kind: 'pairing', code: harness.pairingCode, deviceLabel: 'Bad' },
  }))
  const mismatch = await mismatchClose
  assert.equal(mismatch.code, 4001)
  assert.equal(mismatch.reason, 'protocol_mismatch')

  const silent = await rawConnect(harness.url)
  const silentClose = nextClose(silent)
  const silentResult = await silentClose
  assert.equal(silentResult.code, 4000)
  assert.equal(silentResult.reason, 'auth_failed')
})

test('pairing codes and device tokens are persisted only as hashes', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const dbBytes = await readFile(harness.dbPath)
  assert.equal(dbBytes.includes(Buffer.from(harness.pairingCode)), false)
  assert.equal(dbBytes.includes(Buffer.from(owner.token)), false)
  const store = openDatabase(harness.dbPath)
  const pairingRow = store.db.prepare('SELECT code_hash, used_at_ms FROM pairing_codes').get() as {
    code_hash: Uint8Array
    used_at_ms: number | null
  }
  assert.equal(Buffer.from(pairingRow.code_hash).byteLength, 32)
  assert.notEqual(pairingRow.used_at_ms, null)
  const deviceRow = store.db.prepare('SELECT token_hash FROM devices WHERE device_id = ?').get(owner.deviceId) as {
    token_hash: Uint8Array
  }
  assert.equal(Buffer.from(deviceRow.token_hash).byteLength, 32)
  assert.notEqual(Buffer.from(deviceRow.token_hash).toString('hex'), owner.token)
  store.close()
  await owner.close()
})

test('CLI init/pair write canonical rows and hashed pairing codes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'cli.sqlite')
  const initRun = await runCli(['init', '--db', dbPath, '--pet-id', 'cli-pet', '--time-zone', 'UTC'])
  const init = JSON.parse(initRun.stdout) as { ok: boolean; pairingCode: string; petId: string; authority: { state: string } }
  assert.equal(init.ok, true)
  assert.equal(init.petId, 'cli-pet')
  assert.match(init.pairingCode, /^QQP-/)
  assert.equal(init.authority.state, 'active')

  const store = openDatabase(dbPath)
  const pet = store.getPet('cli-pet')
  assert.equal(pet?.revision, 0)
  assert.equal(pet?.commandSeq, 0)
  assert.equal(pet?.eventSeq, 0)
  const pairing = store.db.prepare('SELECT COUNT(*) AS count FROM pairing_codes WHERE pet_id = ?').get('cli-pet') as { count: number }
  assert.equal(pairing.count, 1)
  store.close()
  const bytes = await readFile(dbPath)
  assert.equal(bytes.includes(Buffer.from(init.pairingCode)), false)

  const pairRun = await runCli(['pair', '--db', dbPath, '--pet-id', 'cli-pet', '--role', 'player'])
  const pair = JSON.parse(pairRun.stdout) as { ok: boolean; role: string; pairingCode: string }
  assert.equal(pair.ok, true)
  assert.equal(pair.role, 'player')
  assert.match(pair.pairingCode, /^QQP-/)
})

test('successful restore atomically replaces the DB and advances authority/restore generation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-restore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  const credentialFile = join(directory, 'credential.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(credentialFile, 'operator-credential\n', { mode: 0o600 })
  await runCli(['backup', '--db', dbPath, '--pet-id', 'restore-pet', '--output', backupPath])

  const before = openDatabase(dbPath)
  const original = before.getAuthority('restore-pet')
  assert.ok(original)
  before.close()
  const beforeBytes = await readFile(dbPath)

  const env = { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile }
  const restored = await runCli([
    'restore', '--from', backupPath, '--accept-rollback',
    '--db', dbPath, '--restore-generation', '1',
    '--owner-admin-credential', credentialFile,
  ], env)
  const body = JSON.parse(restored.stdout) as { ok: boolean; restoreGeneration: number; authority: Array<{ authorityId: string }> }
  assert.equal(body.ok, true)
  assert.equal(body.restoreGeneration, 1)
  assert.notEqual(body.authority[0].authorityId, original.authorityId)
  assert.equal((await readFile(generationFile, 'utf8')).trim(), '1')
  assert.deepEqual(await readFile(dbPath + '.restore-previous'), beforeBytes)
  assert.notDeepEqual(await readFile(dbPath), beforeBytes)

  const after = openDatabase(dbPath)
  const authority = after.getAuthority('restore-pet')
  assert.ok(authority)
  assert.equal(authority.restoreGeneration, 1)
  assert.equal(authority.epoch, original.epoch + 1)
  assert.equal(authority.state, 'active')
  assert.equal(after.verifyRestoreGeneration(generationFile), 1)
  after.close()

  await writeFile(generationFile, '99\n')
  const stale = openDatabase(dbPath)
  assert.throws(() => stale.verifyRestoreGeneration(generationFile), /older than the recorded restore generation/)
  stale.close()
})

test('stale restore generation is rejected before the live DB changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-restore-stale-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  const credentialFile = join(directory, 'credential.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(credentialFile, 'operator-credential\n', { mode: 0o600 })
  await runCli(['backup', '--db', dbPath, '--pet-id', 'restore-pet', '--output', backupPath])

  const beforeStore = openDatabase(dbPath)
  const beforeAuthority = beforeStore.getAuthority('restore-pet')
  assert.ok(beforeAuthority)
  beforeStore.close()
  const beforeBytes = await readFile(dbPath)
  await writeFile(generationFile, '1\n')

  const failure = await runCliFailure([
    'restore', '--from', backupPath, '--accept-rollback',
    '--db', dbPath, '--restore-generation', '1',
    '--owner-admin-credential', credentialFile,
  ], { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile })
  assert.match(failure.stderr, /must advance beyond the current\/recorded generation/)
  assert.deepEqual(await readFile(dbPath), beforeBytes)

  const afterStore = openDatabase(dbPath)
  const afterAuthority = afterStore.getAuthority('restore-pet')
  assert.ok(afterAuthority)
  assert.equal(afterAuthority.authorityId, beforeAuthority.authorityId)
  assert.equal(afterAuthority.restoreGeneration, beforeAuthority.restoreGeneration)
  afterStore.close()
  await assert.rejects(readFile(dbPath + '.restore-previous'), /ENOENT/)
})

test('corrupt backup is rejected before the live DB changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-restore-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  const credentialFile = join(directory, 'credential.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(credentialFile, 'operator-credential\n', { mode: 0o600 })
  await runCli(['backup', '--db', dbPath, '--pet-id', 'restore-pet', '--output', backupPath])

  const beforeStore = openDatabase(dbPath)
  const beforeAuthority = beforeStore.getAuthority('restore-pet')
  assert.ok(beforeAuthority)
  beforeStore.close()
  const beforeBytes = await readFile(dbPath)
  await writeFile(backupPath, 'not a sqlite database\n')

  const failure = await runCliFailure([
    'restore', '--from', backupPath, '--accept-rollback',
    '--db', dbPath, '--restore-generation', '1',
    '--owner-admin-credential', credentialFile,
  ], { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile })
  assert.match(failure.stderr, /not a database|quick_check|integrity_check|malformed/i)
  assert.deepEqual(await readFile(dbPath), beforeBytes)

  const afterStore = openDatabase(dbPath)
  const afterAuthority = afterStore.getAuthority('restore-pet')
  assert.ok(afterAuthority)
  assert.equal(afterAuthority.authorityId, beforeAuthority.authorityId)
  assert.equal(afterAuthority.restoreGeneration, beforeAuthority.restoreGeneration)
  afterStore.close()
  await assert.rejects(readFile(dbPath + '.restore-previous'), /ENOENT/)
})

test('restore failure after the swap rolls back to the prior live DB', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-restore-rollback-'))
  const lockedDirectory = join(directory, 'locked-generation')
  const generationFile = join(lockedDirectory, 'restore-generation.txt')
  t.after(async () => {
    await chmod(lockedDirectory, 0o700).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  const dbPath = join(directory, 'restore.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const credentialFile = join(directory, 'credential.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(credentialFile, 'operator-credential\n', { mode: 0o600 })
  await runCli(['backup', '--db', dbPath, '--pet-id', 'restore-pet', '--output', backupPath])

  const beforeStore = openDatabase(dbPath)
  const beforeAuthority = beforeStore.getAuthority('restore-pet')
  assert.ok(beforeAuthority)
  beforeStore.close()
  const beforeBytes = await readFile(dbPath)
  await mkdir(lockedDirectory)
  await writeFile(generationFile, '0\n', { mode: 0o600 })
  await chmod(lockedDirectory, 0o500)

  const failure = await runCliFailure([
    'restore', '--from', backupPath, '--accept-rollback',
    '--db', dbPath, '--restore-generation', '1',
    '--owner-admin-credential', credentialFile,
  ], { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile })
  await chmod(lockedDirectory, 0o700)
  assert.match(failure.stderr, /EACCES|permission denied/i)
  assert.deepEqual(await readFile(dbPath), beforeBytes)
  assert.equal((await readFile(generationFile, 'utf8')).trim(), '0')

  const afterStore = openDatabase(dbPath)
  const afterAuthority = afterStore.getAuthority('restore-pet')
  assert.ok(afterAuthority)
  assert.equal(afterAuthority.authorityId, beforeAuthority.authorityId)
  assert.equal(afterAuthority.restoreGeneration, beforeAuthority.restoreGeneration)
  afterStore.close()
  await assert.rejects(readFile(dbPath + '.restore-previous'), /ENOENT/)
})

test('restore is refused while a running server holds the database and succeeds after clean shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c9-restore-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  const credentialFile = join(directory, 'credential.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(credentialFile, 'operator-credential\n', { mode: 0o600 })
  await runCli(['backup', '--db', dbPath, '--pet-id', 'restore-pet', '--output', backupPath])

  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    backupDir: join(directory, 'backups'),
    adminSocket: join(directory, 'admin.sock'),
    restoreGenerationFile: generationFile,
    schedulerEnabled: false,
  })
  const server = new SyncServer(config, openDatabase(dbPath))
  await server.start()
  const beforeAuthority = server.store.getAuthority('restore-pet')
  try {
    const failure = await runCliFailure([
      'restore', '--from', backupPath, '--accept-rollback',
      '--db', dbPath, '--restore-generation', '1',
      '--owner-admin-credential', credentialFile,
    ], { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile })
    assert.match(failure.stderr, /in use by a running server/i)
    const afterAuthority = server.store.getAuthority('restore-pet')
    assert.equal(afterAuthority?.authorityId, beforeAuthority?.authorityId)
    assert.equal(afterAuthority?.restoreGeneration, beforeAuthority?.restoreGeneration)
    await assert.rejects(readFile(generationFile), /ENOENT/)
  } finally {
    await server.stop()
  }

  const restored = await runCli([
    'restore', '--from', backupPath, '--accept-rollback',
    '--db', dbPath, '--restore-generation', '1',
    '--owner-admin-credential', credentialFile,
  ], { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile })
  const body = JSON.parse(restored.stdout) as { ok: boolean; restoreGeneration: number }
  assert.equal(body.ok, true)
  assert.equal(body.restoreGeneration, 1)
  assert.equal((await readFile(generationFile, 'utf8')).trim(), '1')
})

test('startup fails closed when a published restore fence is ahead of the live DB', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c9-restore-crash-fence-ahead-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(generationFile, '1')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    backupDir: join(directory, 'backups'),
    adminSocket: join(directory, 'admin.sock'),
    restoreGenerationFile: generationFile,
    schedulerEnabled: false,
  })
  const server = new SyncServer(config, openDatabase(dbPath))
  await assert.rejects(server.start(), /older than the recorded restore generation/)
  await server.stop()
})

test('startup rejects a DB restore generation ahead of the external fence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c9-restore-crash-fence-behind-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  const seed = openDatabase(dbPath)
  seed.resetAuthorityAfterRestore('restore-pet', 1)
  assert.equal(seed.maxRestoreGeneration(), 1)
  seed.close()
  await writeFile(generationFile, '0')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    backupDir: join(directory, 'backups'),
    adminSocket: join(directory, 'admin.sock'),
    restoreGenerationFile: generationFile,
    schedulerEnabled: false,
  })
  const server = new SyncServer(config, openDatabase(dbPath))
  await assert.rejects(server.start(), /does not match the recorded restore fence/)
  await server.stop()
})

test('restore failure after fence publication rolls the external fence back', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c9-restore-fence-rollback-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'restore.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const generationFile = join(directory, 'restore-generation.txt')
  const credentialFile = join(directory, 'credential.txt')
  await runCli(['init', '--db', dbPath, '--pet-id', 'restore-pet', '--time-zone', 'UTC'])
  await writeFile(credentialFile, 'operator-credential\n', { mode: 0o600 })
  await runCli(['backup', '--db', dbPath, '--pet-id', 'restore-pet', '--output', backupPath])
  await writeFile(generationFile, '0')

  const beforeStore = openDatabase(dbPath)
  const beforeAuthority = beforeStore.getAuthority('restore-pet')
  beforeStore.close()
  const previousPath = dbPath + '.restore-previous'
  await mkdir(previousPath)
  await writeFile(join(previousPath, 'blocker'), 'x')

  const failure = await runCliFailure([
    'restore', '--from', backupPath, '--accept-rollback',
    '--db', dbPath, '--restore-generation', '1',
    '--owner-admin-credential', credentialFile,
  ], { QQPET_SYNC_RESTORE_GENERATION_FILE: generationFile })
  assert.match(failure.stderr, /EISDIR|directory/i)
  assert.equal((await readFile(generationFile, 'utf8')).trim(), '0')
  assert.equal(await readFile(join(previousPath, 'blocker'), 'utf8'), 'x')

  const afterStore = openDatabase(dbPath)
  const afterAuthority = afterStore.getAuthority('restore-pet')
  assert.equal(afterAuthority?.authorityId, beforeAuthority?.authorityId)
  assert.equal(afterAuthority?.restoreGeneration, beforeAuthority?.restoreGeneration)
  afterStore.close()
})

test('finalizeSurvivor preserves existing ends and caps provenance at a known suspend', () => {
  const survivor: CoverageSurvivor = {
    kind: 'server_connection',
    connectionId: 'c1',
    deviceId: 'd1',
    lastHeartbeatWallMs: 1_000,
    eligible: true,
  }
  const skipped = finalizeSurvivor(
    { ...survivor, activeEndWallMs: 900, activeEndProvenance: 'disconnect' },
    { commitWallMs: 100, eventBoundaryMs: 500, eventReason: 'crash_repaired', terminal: true },
  )
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.endWallMs, 900)

  const terminal = finalizeSurvivor(survivor, {
    commitWallMs: 100,
    eventBoundaryMs: 500,
    eventReason: 'disconnect',
    terminal: true,
  })
  assert.equal(terminal.survivor.eligible, false)
  assert.equal(terminal.endWallMs, 500)
  assert.equal(terminal.provenance, 'disconnect')

  const suspended = finalizeSurvivor(survivor, {
    commitWallMs: 100,
    eventBoundaryMs: 500,
    eventReason: 'shutdown',
    terminal: true,
    suspendedAtMs: 300,
  })
  assert.equal(suspended.endWallMs, 300)
  assert.equal(suspended.provenance, 'suspend')

  const knownSuspend = finalizeSurvivor(survivor, {
    commitWallMs: 100,
    eventBoundaryMs: 400,
    eventReason: 'suspend',
    terminal: false,
    suspendedAtMs: 300,
  })
  assert.equal(knownSuspend.survivor.eligible, true)
  assert.equal(knownSuspend.provenance, 'suspend')

  const clamped = finalizeSurvivor(survivor, {
    commitWallMs: 100,
    eventBoundaryMs: 50,
    eventReason: 'disconnect',
    terminal: true,
  })
  assert.equal(clamped.endWallMs, 100)

  const storedCap = finalizeSurvivor(survivor, {
    commitWallMs: 100,
    eventBoundaryMs: 900,
    eventReason: 'shutdown',
    terminal: true,
    suspendedAtMs: 800,
    existingCloseReason: 'suspend',
    existingEndWallMs: 600,
  })
  assert.equal(storedCap.endWallMs, 600)
  assert.equal(storedCap.survivor.activeEndWallMs, 600)
  assert.equal(storedCap.survivor.activeEndProvenance, 'suspend')
})

test('canonical load assembles engine state from canonical tables', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const store = openDatabase(harness.dbPath)
  const snapshot = store.loadCanonical('default')
  assert.equal(snapshot.engine.gameTimeMs, snapshot.pet.gameTimeMs)
  assert.equal(snapshot.engine.timeZone, snapshot.settings.timeZone)
  assert.ok(snapshot.engine.sessionCoverage.some(interval => interval.disconnectedAtWallMs === undefined))
  store.replaceScheduledJobs('default', [{
    id: 7,
    type: 'work',
    dueAtGameMs: snapshot.pet.gameTimeMs + 60_000,
    payload: { jobId: 'assembled' },
    status: 'pending',
  }])
  const reloaded = store.loadCanonical('default')
  assert.equal(reloaded.engine.scheduledJobs.length, 1)
  assert.equal(reloaded.engine.scheduledJobs[0].id, 7)
  store.close()
  await owner.close()
})

test('pet.reset closes open coverage with pet_reset, persists exact survivors, and reopens them at commit wall', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const store0 = openDatabase(harness.dbPath)
  const playerCode = store0.issuePairingCode('default', 'player', 10 * 60_000).code
  store0.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player phone' })
  await player.next('ready')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'adopt-before-reset',
    opId: 'adopt-before-reset-1',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  await owner.next('commandResult')
  await owner.next('projection')
  await player.next('projection')

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'reset',
    opId: 'reset-1',
    command: { type: 'pet.reset', payload: {} },
  })
  const result = await owner.next('commandResult')
  if (result.t !== 'commandResult') throw new Error('missing reset result')
  assert.equal(result.status, 'applied')
  await owner.next('projection')
  await player.next('projection')

  const store = openDatabase(harness.dbPath)
  assert.equal(store.listOpenCoverageOperations('default').length, 0)
  const operation = store.db.prepare(
    'SELECT * FROM coverage_operations WHERE pet_id = ? ORDER BY commit_wall_ms DESC LIMIT 1',
  ).get('default') as { operation_id: string; state: string; commit_wall_ms: number; survivors_json: string }
  assert.equal(operation.state, 'completed')
  const survivors = JSON.parse(operation.survivors_json) as CoverageSurvivor[]
  assert.equal(survivors.length, 2)
  assert.ok(survivors.every(survivor => survivor.kind === 'server_connection' && survivor.eligible === true))
  const rows = store.db.prepare(
    'SELECT coverage_id, connected_at_ms, disconnected_at_ms, close_reason FROM session_coverage WHERE pet_id = ?',
  ).all('default') as Array<Record<string, unknown>>
  const open = rows.filter(row => row.disconnected_at_ms === null)
  const closed = rows.filter(row => row.disconnected_at_ms !== null)
  assert.equal(open.length, 2)
  assert.equal(closed.length, 2)
  assert.ok(open.every(row => String(row.coverage_id).startsWith(operation.operation_id + ':')))
  assert.ok(open.every(row => Number(row.connected_at_ms) === Number(operation.commit_wall_ms)))
  assert.ok(closed.every(row => row.close_reason === 'pet_reset'))
  store.close()

  // The rebound live coverage id must be the one a later disconnect closes.
  await owner.close()
  await player.close()
  const afterClose = openDatabase(harness.dbPath)
  let stillOpen = { count: 1 }
  for (let attempt = 0; attempt < 50 && stillOpen.count !== 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20))
    stillOpen = afterClose.db.prepare(
      'SELECT COUNT(*) AS count FROM session_coverage WHERE pet_id = ? AND disconnected_at_ms IS NULL',
    ).get('default') as { count: number }
  }
  assert.equal(stillOpen.count, 0)
  afterClose.close()
})

test('startup repair finalizes pending and suspended coverage operations monotonically', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const now = Date.now()
  const commitWall = now - 120_000
  const pendingSurvivor: CoverageSurvivor = {
    kind: 'server_connection',
    connectionId: 'c-pending',
    deviceId: 'd-pending',
    lastHeartbeatWallMs: now - 60_000,
    eligible: true,
  }
  store.closeAndCreateCoverageOperation('default', 'op-pending', commitWall, [pendingSurvivor], 'pet_reset')
  assert.equal(store.listOpenCoverageOperations('default').length, 1)
  const repaired = store.repairCoverageOnStartup(now)
  assert.equal(repaired, 1)
  const pending = store.getCoverageOperation('default', 'op-pending')
  assert.equal(pending?.state, 'completed')
  assert.equal(pending?.survivors[0].eligible, false)
  const pendingRow = store.db.prepare(
    'SELECT connected_at_ms, disconnected_at_ms, close_reason FROM session_coverage WHERE coverage_id = ?',
  ).get('op-pending:c-pending') as Record<string, unknown>
  assert.equal(Number(pendingRow.connected_at_ms), commitWall)
  assert.equal(Number(pendingRow.disconnected_at_ms), pendingSurvivor.lastHeartbeatWallMs + 30_000)
  assert.equal(pendingRow.close_reason, 'crash_repaired')

  const suspendedAt = now - 10_000
  const suspendedSurvivor: CoverageSurvivor = {
    kind: 'server_connection',
    connectionId: 'c-suspended',
    deviceId: 'd-suspended',
    lastHeartbeatWallMs: now - 60_000,
    eligible: true,
  }
  store.closeAndCreateCoverageOperation('default', 'op-suspended', commitWall, [suspendedSurvivor], 'pet_reset')
  assert.equal(store.markCoverageOperationSuspended('default', 'op-suspended', suspendedAt), 1)
  const suspendedRowBefore = store.db.prepare(
    'SELECT connected_at_ms, disconnected_at_ms, close_reason FROM session_coverage WHERE coverage_id = ?',
  ).get('op-suspended:c-suspended') as Record<string, unknown>
  assert.equal(Number(suspendedRowBefore.disconnected_at_ms), suspendedAt)
  assert.equal(suspendedRowBefore.close_reason, 'suspend')

  // A crash long after the suspend must preserve the suspend row/end and never credit suspend time.
  store.repairCoverageOnStartup(now + 3_600_000)
  const suspended = store.getCoverageOperation('default', 'op-suspended')
  assert.equal(suspended?.state, 'completed')
  assert.equal(suspended?.survivors[0].eligible, false)
  const suspendedRowAfter = store.db.prepare(
    'SELECT connected_at_ms, disconnected_at_ms, close_reason FROM session_coverage WHERE coverage_id = ?',
  ).get('op-suspended:c-suspended') as Record<string, unknown>
  assert.equal(Number(suspendedRowAfter.connected_at_ms), commitWall)
  assert.equal(Number(suspendedRowAfter.disconnected_at_ms), suspendedAt)
  assert.equal(suspendedRowAfter.close_reason, 'suspend')
  store.close()
})

test('repeated coverage suspension keeps the first suspend cap and is idempotent', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const now = Date.now()
  const commitWall = now - 120_000
  const firstSuspend = now - 20_000
  const repeatedSuspend = now - 10_000
  const survivor: CoverageSurvivor = {
    kind: 'server_connection',
    connectionId: 'c-repeat-suspend',
    deviceId: 'd-repeat-suspend',
    lastHeartbeatWallMs: now - 5_000,
    eligible: true,
  }
  store.closeAndCreateCoverageOperation('default', 'op-repeat-suspend', commitWall, [survivor], 'pet_reset')
  assert.equal(store.markCoverageOperationSuspended('default', 'op-repeat-suspend', firstSuspend), 1)
  const rowBefore = store.db.prepare(
    'SELECT disconnected_at_ms, close_reason FROM session_coverage WHERE coverage_id = ?',
  ).get('op-repeat-suspend:c-repeat-suspend') as Record<string, unknown>
  assert.equal(Number(rowBefore.disconnected_at_ms), firstSuspend)
  assert.equal(rowBefore.close_reason, 'suspend')

  assert.equal(store.markCoverageOperationSuspended('default', 'op-repeat-suspend', repeatedSuspend), 0)
  const operation = store.getCoverageOperation('default', 'op-repeat-suspend')
  assert.equal(operation?.state, 'suspended')
  assert.equal(operation?.suspendedAtMs, firstSuspend)
  const rowAfter = store.db.prepare(
    'SELECT disconnected_at_ms, close_reason FROM session_coverage WHERE coverage_id = ?',
  ).get('op-repeat-suspend:c-repeat-suspend') as Record<string, unknown>
  assert.equal(Number(rowAfter.disconnected_at_ms), firstSuspend)
  assert.equal(rowAfter.close_reason, 'suspend')
  store.close()
})

test('coverage finalization uses the stored suspend end as the survivor cap', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const now = Date.now()
  const commitWall = now - 120_000
  const storedSuspendEnd = now - 40_000
  const survivor: CoverageSurvivor = {
    kind: 'server_connection',
    connectionId: 'c-stored-cap',
    deviceId: 'd-stored-cap',
    lastHeartbeatWallMs: now - 5_000,
    eligible: true,
  }
  store.closeAndCreateCoverageOperation('default', 'op-stored-cap', commitWall, [survivor], 'pet_reset')
  store.db.prepare(
    `INSERT INTO session_coverage
     (pet_id, coverage_id, device_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
     VALUES ('default', ?, ?, ?, ?, ?, 'suspend')`,
  ).run(
    'op-stored-cap:c-stored-cap',
    'd-stored-cap',
    commitWall,
    storedSuspendEnd,
    storedSuspendEnd,
  )
  store.markCoverageOperationSuspended('default', 'op-stored-cap', storedSuspendEnd + 1_000)
  store.repairCoverageOnStartup(now + 60_000)

  const operation = store.getCoverageOperation('default', 'op-stored-cap')
  assert.equal(operation?.state, 'completed')
  assert.equal(operation?.survivors[0].eligible, false)
  assert.equal(operation?.survivors[0].activeEndWallMs, storedSuspendEnd)
  const row = store.db.prepare(
    'SELECT disconnected_at_ms, close_reason FROM session_coverage WHERE coverage_id = ?',
  ).get('op-stored-cap:c-stored-cap') as Record<string, unknown>
  assert.equal(Number(row.disconnected_at_ms), storedSuspendEnd)
  assert.equal(row.close_reason, 'suspend')
  store.close()
})

test('retention cannot delete stable rows referenced by a pending coverage operation', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const now = Date.now()
  const survivor: CoverageSurvivor = {
    kind: 'server_connection',
    connectionId: 'c-retain',
    deviceId: 'd-retain',
    lastHeartbeatWallMs: now - 1_000,
    eligible: true,
  }
  store.closeAndCreateCoverageOperation('default', 'op-retain', now - 1_000, [survivor], 'pet_reset')
  const insert = store.db.prepare(
    `INSERT INTO session_coverage
     (pet_id, coverage_id, device_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
     VALUES ('default', ?, ?, ?, ?, ?, 'pet_reset')`,
  )
  insert.run('op-retain:c-retain', 'd-retain', now - 2_000, now - 1_500, now - 1_500)
  insert.run('old-unrelated', 'd-old', now - 9_000, now - 8_000, now - 8_000)
  const deleted = store.pruneClosedCoverage('default', now)
  assert.equal(deleted, 1)
  const blocked = store.db.prepare('SELECT COUNT(*) AS count FROM session_coverage WHERE coverage_id = ?').get('op-retain:c-retain') as { count: number }
  const unrelated = store.db.prepare('SELECT COUNT(*) AS count FROM session_coverage WHERE coverage_id = ?').get('old-unrelated') as { count: number }
  assert.equal(blocked.count, 1)
  assert.equal(unrelated.count, 0)
  store.close()
})

test('owner server settings commands persist without unauthenticated HTTP exposure', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  assert.equal(owner.welcome.weatherLocation, '北京')
  let latestProjection: Extract<ServerToClient, { t: 'projection' }> | undefined
  for (const command of [
    { type: 'server.setAdvanceWhileEmpty' as const, payload: { enabled: false } },
    { type: 'server.setWeatherCity' as const, payload: { city: '上海' } },
    { type: 'server.setTimeZone' as const, payload: { timeZone: 'America/New_York' } },
  ]) {
    owner.send({
      t: 'command',
      v: PROTOCOL_VERSION,
      requestId: command.type,
      opId: command.type,
      command,
    })
    const result = await owner.next('commandResult')
    if (result.t !== 'commandResult') throw new Error('missing result for ' + command.type)
    assert.equal(result.status, 'applied')
    const projection = await owner.next('projection')
    if (projection.t !== 'projection') throw new Error('missing projection for ' + command.type)
    latestProjection = projection
  }
  assert.equal(latestProjection?.weatherLocation, '上海')
  const store = openDatabase(harness.dbPath)
  const settings = store.getSettings('default')
  assert.equal(settings?.advanceWhileEmpty, false)
  assert.equal(settings?.weatherLocation, '上海')
  const snapshot = store.loadCanonical('default')
  assert.equal(snapshot.engine.timeZone, 'America/New_York')
  store.close()

  const response = await fetch('http://127.0.0.1:' + harness.server.address().port + '/status')
  assert.equal(response.status, 404)
  const body = await response.json() as Record<string, unknown>
  assert.deepEqual(body, { ok: false, error: 'not_found' })
  assert.doesNotMatch(JSON.stringify(body), /default|revision|eventSeq|gameTime|timeZone|weatherLocation/i)

  const store2 = openDatabase(harness.dbPath)
  const playerCode = store2.issuePairingCode('default', 'player', 10 * 60_000).code
  store2.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player' })
  assert.equal(player.welcome.weatherLocation, '上海')
  const playerSnapshot = await player.next('snapshot')
  if (playerSnapshot.t !== 'snapshot') throw new Error('missing snapshot')
  assert.equal(playerSnapshot.weatherLocation, '上海')
  const playerReady = await player.next('ready')
  if (playerReady.t !== 'ready') throw new Error('missing ready')
  assert.equal(playerReady.weatherLocation, '上海')
  player.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'player-setting',
    opId: 'player-setting-1',
    command: { type: 'server.setAdvanceWhileEmpty', payload: { enabled: true } },
  })
  const denied = await player.next('commandResult')
  if (denied.t !== 'commandResult') throw new Error('missing result')
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.error?.code, 'unauthorized')
  await owner.close()
  await player.close()
})

test('websocket parser cap tightly bounds oversized pre-auth frames', async t => {
  const harness = await createHarness(t, {
    maxFrameBytes: 4096,
    maxCommandBytes: 1024,
    helloTimeoutMs: 5000,
    maxPreAuthConnections: 2,
  })
  const wss = (harness.server as unknown as { wss: { options: { maxPayload: number } } }).wss
  assert.equal(wss.options.maxPayload, harness.config.maxFrameBytes + 1)

  const socket = await rawConnect(harness.url)
  const closed = nextClose(socket)
  socket.send('x'.repeat(64 * 1024))
  const close = await closed
  assert.equal(close.code, 4005)
  assert.equal(close.reason, 'payload_too_large')
})

test('pre-auth connection cap rejects excess handshakes and releases on close', async t => {
  const harness = await createHarness(t, {
    helloTimeoutMs: 5000,
    maxPreAuthConnections: 1,
  })
  const first = await rawConnect(harness.url)
  await assert.rejects(rawConnect(harness.url), /429|unexpected server response/i)

  const firstClosed = new Promise<void>(resolve => first.once('close', () => resolve()))
  first.close()
  await firstClosed
  await new Promise(resolve => setTimeout(resolve, 20))

  const third = await rawConnect(harness.url)
  const thirdClosed = new Promise<void>(resolve => third.once('close', () => resolve()))
  third.close()
  await thirdClosed
})

test('oversized command frames are closed with 4005 before dispatch', async t => {
  const harness = await createHarness(t, { maxFrameBytes: 4096, maxCommandBytes: 1024 })
  const owner = await pairOwner(harness)
  const closed = nextClose(owner.ws)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'oversized',
    opId: 'oversized-1',
    command: { type: 'pet.rename', payload: { name: 'x'.repeat(2048) } },
  })
  const close = await closed
  assert.equal(close.code, 4005)
  assert.equal(close.reason, 'payload_too_large')
})

test('oversized WebSocket frames close with 4005 instead of ws 1009', async t => {
  const harness = await createHarness(t, { maxFrameBytes: 4096, maxCommandBytes: 1024 })
  const owner = await pairOwner(harness)
  const closed = nextClose(owner.ws)
  owner.ws.send('x'.repeat(8192))
  const close = await closed
  assert.equal(close.code, 4005)
  assert.equal(close.reason, 'payload_too_large')
})

test('pretty-printed and escaped oversized command frames close with 4005', async t => {
  const harness = await createHarness(t, { maxFrameBytes: 8192, maxCommandBytes: 1024 })
  const owner = await pairOwner(harness)
  const escapedType = 'comm' + String.fromCharCode(92) + 'u0061nd'
  const frame = JSON.stringify({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'pretty-oversized',
    opId: 'pretty-oversized-1',
    command: { type: 'pet.rename', payload: { name: 'x'.repeat(2048) } },
  }, null, 2).replace('"t": "command"', '"t": "' + escapedType + '"')
  assert.equal(frame.includes('"t":"command"'), false)
  assert.ok(Buffer.byteLength(frame) > harness.config.maxCommandBytes)
  assert.ok(Buffer.byteLength(frame) <= harness.config.maxFrameBytes)

  const closed = nextClose(owner.ws)
  owner.ws.send(frame)
  const close = await closed
  assert.equal(close.code, 4005)
  assert.equal(close.reason, 'payload_too_large')

  const store = openDatabase(harness.dbPath)
  assert.equal(store.getPet('default')?.revision, 0)
  const count = store.db.prepare('SELECT COUNT(*) AS count FROM commands WHERE pet_id = ?').get('default') as { count: number }
  assert.equal(count.count, 0)
  store.close()
})

test('command rate limiting closes with 4003 after the burst is exhausted', async t => {
  const harness = await createHarness(t, { commandRatePerSecond: 1, commandRateBurst: 1 })
  const owner = await pairOwner(harness)
  const closed = nextClose(owner.ws)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'rate-1',
    opId: 'rate-1',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'rate-2',
    opId: 'rate-2',
    command: { type: 'pet.adopt', payload: { sex: 'MM' } },
  })
  const close = await closed
  assert.equal(close.code, 4003)
  assert.equal(close.reason, 'rate_limited')
  const metrics = harness.server.metrics.snapshot()
  assert.ok((metrics['rate_limits.hits'] ?? 0) >= 1)
  assert.ok((metrics['rate_limits.commands'] ?? 0) >= 1)
})

test('command rate budget is shared by every socket for one device', async t => {
  const harness = await createHarness(t, { commandRatePerSecond: 1, commandRateBurst: 1 })
  const owner = await pairOwner(harness)
  const second = await connect(harness, { kind: 'token', token: owner.token })

  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'shared-rate-1',
    opId: 'shared-rate-1',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const result = await owner.next('commandResult')
  assert.equal(result.t, 'commandResult')
  if (result.t === 'commandResult') assert.equal(result.status, 'applied')

  const closed = nextClose(second.ws)
  second.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'shared-rate-2',
    opId: 'shared-rate-2',
    command: { type: 'pet.adopt', payload: { sex: 'MM' } },
  })
  const close = await closed
  assert.equal(close.code, 4003)
  assert.equal(close.reason, 'rate_limited')
  assert.equal(owner.ws.readyState, WebSocket.OPEN)
  await owner.close()
})

test('resync and export share an expensive-frame budget across device sockets', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const second = await connect(harness, { kind: 'token', token: owner.token })

  const ownerClosed = nextClose(owner.ws)
  for (let index = 0; index < 5; index += 1) {
    owner.send({
      t: 'resync',
      v: PROTOCOL_VERSION,
      requestId: 'resync-rate-' + index,
      discardCachedAuthority: true,
    })
  }
  const resyncClose = await ownerClosed
  assert.equal(resyncClose.code, 4003)
  assert.equal(resyncClose.reason, 'rate_limited')

  const secondClosed = nextClose(second.ws)
  second.send({ t: 'exportBundle', v: PROTOCOL_VERSION, requestId: 'export-after-resync' })
  const exportClose = await secondClosed
  assert.equal(exportClose.code, 4003)
  assert.equal(exportClose.reason, 'rate_limited')
  const metrics = harness.server.metrics.snapshot()
  assert.ok((metrics['rate_limits.hits'] ?? 0) >= 2)
  assert.ok((metrics['rate_limits.expensive'] ?? 0) >= 2)
})

test('unauthenticated frame flood is rate limited across sockets', async t => {
  const harness = await createHarness(t)
  const sockets = await Promise.all(
    Array.from({ length: 11 }, () => rawConnect(harness.url)),
  )
  const closes = sockets.map(socket => nextClose(socket))
  for (const socket of sockets) socket.send('{')
  const results = await Promise.all(closes)
  assert.equal(results.filter(result => result.code === 4003).length, 1)
  assert.equal(results.filter(result => result.code === 4004).length, 10)
  assert.ok((harness.server.metrics.snapshot()['rate_limits.pre_auth'] ?? 0) >= 1)
})

test('rejected pairing does not burn the one-shot code or orphan a device', async t => {
  const harness = await createHarness(t, { maxConnectionsPerPet: 1 })
  const owner = await pairOwner(harness)
  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  const devicesBefore = store.listDevices('default').length
  store.close()

  await assert.rejects(
    connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Extra' }),
    /socket closed: 4002/,
  )

  const check = openDatabase(harness.dbPath)
  assert.equal(check.listDevices('default').length, devicesBefore)
  const pairing = check.getMigration(playerCode)
  assert.ok(pairing)
  assert.equal(pairing.usedAtMs, null)
  check.close()

  await owner.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Extra' })
  await player.next('ready')
  assert.match(player.token, /^[A-Za-z0-9_-]{43,}$/)
  const after = openDatabase(harness.dbPath)
  assert.equal(after.listDevices('default').length, devicesBefore + 1)
  after.close()
  await player.close()
})

test('authority reset rejection does not consume the pairing code', async t => {
  const harness = await createHarness(t)
  const ws = await rawConnect(harness.url)
  const resetMessage = nextServerMessage(ws)
  const closed = nextClose(ws)
  ws.send(JSON.stringify({
    t: 'hello',
    v: PROTOCOL_VERSION,
    requestId: 'stale-authority',
    appVersion: 'test',
    cachedAuthority: { authorityId: 'stale-authority', restoreGeneration: 0, epoch: 0 },
    auth: { kind: 'pairing', code: harness.pairingCode, deviceLabel: 'Owner desktop' },
  }))
  const [reset, close] = await Promise.all([resetMessage, closed])
  assert.equal(reset.t, 'authorityResetRequired')
  if (reset.t === 'authorityResetRequired') assert.equal(reset.reason, 'authority_mismatch')
  assert.equal(close.code, 4002)
  assert.equal(close.reason, 'authority_reset_required')

  const check = openDatabase(harness.dbPath)
  assert.equal(check.listDevices('default').length, 0)
  const pairing = check.getMigration(harness.pairingCode)
  assert.ok(pairing)
  assert.equal(pairing.usedAtMs, null)
  check.close()

  const owner = await pairOwner(harness)
  assert.match(owner.token, /^[A-Za-z0-9_-]{43,}$/)
  await owner.close()
})

test('expired pairing codes are rejected with auth_failed', async t => {
  const harness = await createHarness(t)
  const store = openDatabase(harness.dbPath)
  const code = store.issuePairingCode('default', 'player', 1).code
  store.close()
  await new Promise(resolve => setTimeout(resolve, 10))
  await assert.rejects(
    connect(harness, { kind: 'pairing', code, deviceLabel: 'Late' }),
    /socket closed: 4000/,
  )
})

test('opId idempotency is scoped to the authenticated device', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  owner.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'scoped-owner',
    opId: 'shared-op-id',
    command: { type: 'pet.adopt', payload: { sex: 'GG' } },
  })
  const ownerResult = await owner.next('commandResult')
  if (ownerResult.t !== 'commandResult') throw new Error('missing result')
  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  store.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player' })
  await player.next('ready')
  player.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'scoped-player',
    opId: 'shared-op-id',
    command: { type: 'pet.pokeFace', payload: { spotId: 'face-1' } },
  })
  const playerResult = await player.next('commandResult')
  if (playerResult.t !== 'commandResult') throw new Error('missing result')
  assert.equal(playerResult.status, 'applied')
  assert.equal(playerResult.commandSeq, ownerResult.commandSeq + 1)
  assert.notEqual(playerResult.commandSeq, ownerResult.commandSeq)
  await owner.close()
  await player.close()
})

test('ctl revoke-device uses the owner-authenticated socket control path', async t => {
  const harness = await createHarness(t)
  const owner = await pairOwner(harness)
  const store = openDatabase(harness.dbPath)
  const playerCode = store.issuePairingCode('default', 'player', 10 * 60_000).code
  store.close()
  const player = await connect(harness, { kind: 'pairing', code: playerCode, deviceLabel: 'Player phone' })
  await player.next('ready')
  const credentialFile = join(harness.directory, 'owner-credential.txt')
  await writeFile(credentialFile, owner.token + '\n', { mode: 0o600 })
  const playerClosed = nextClose(player.ws)
  const run = await runCli([
    'ctl', 'revoke-device', player.deviceId,
    '--pet-id', 'default',
    '--db', harness.dbPath,
    '--port', String(harness.server.address().port),
    '--owner-admin-credential', credentialFile,
  ])
  const output = JSON.parse(run.stdout) as { t: string; status: string; commandType: string }
  assert.equal(output.t, 'commandResult')
  assert.equal(output.status, 'applied')
  assert.equal(output.commandType, 'device.revoke')
  const close = await playerClosed
  assert.equal(close.code, 4002)
  await assert.rejects(
    connect(harness, { kind: 'token', token: player.token }),
    /socket closed: 4002/,
  )
  await owner.close()
})

test('database opens with WAL/FULL pragmas, migrates idempotently, and fails closed on corrupt engine state', async t => {
  const harness = await createHarness(t)
  const first = openDatabase(harness.dbPath)
  const journal = first.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
  const synchronous = first.db.prepare('PRAGMA synchronous').get() as Record<string, unknown>
  const foreignKeys = first.db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>
  const busyTimeout = first.db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>
  assert.equal(String(Object.values(journal)[0]).toLowerCase(), 'wal')
  assert.equal(Number(Object.values(synchronous)[0]), 2)
  assert.equal(Number(Object.values(foreignKeys)[0]), 1)
  assert.equal(Number(Object.values(busyTimeout)[0]), 5000)
  const migrations = first.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  assert.deepEqual(migrations.map(row => row.version), [1])
  const requiredTables = [
    'pets', 'pet_settings', 'pet_authority', 'scheduled_jobs', 'game_sessions',
    'session_coverage', 'coverage_operations', 'commands', 'events', 'devices', 'pairing_codes',
  ]
  const tables = new Set(
    (first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name),
  )
  for (const table of requiredTables) assert.ok(tables.has(table), 'missing table ' + table)
  first.close()

  const second = openDatabase(harness.dbPath)
  assert.equal(second.getPet('default')?.schemaVersion, 1)
  second.db.prepare("UPDATE pets SET engine_json = ? WHERE id = 'default'").run('{"bad":true}')
  assert.throws(() => second.loadCanonical('default'), /canonical engine state is corrupt/)
  second.close()
})

test('server startup fails closed before listening when any canonical pet is corrupt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c8-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'startup.sqlite')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    backupDir: join(directory, 'backups'),
    adminSocket: join(directory, 'admin.sock'),
    schedulerEnabled: false,
  })
  const seed = openDatabase(dbPath)
  initializePet(seed, {
    petId: 'healthy-pet',
    timeZone: 'UTC',
    weatherCity: '北京',
    nowMs: Date.UTC(2026, 9, 20, 4, 0, 0),
  })
  initializePet(seed, {
    petId: 'corrupt-pet',
    timeZone: 'UTC',
    weatherCity: '北京',
    nowMs: Date.UTC(2026, 9, 20, 4, 0, 0),
  })
  seed.db.prepare("UPDATE pets SET engine_json = ? WHERE id = 'corrupt-pet'").run('{"bad":true}')
  seed.close()

  const server = new SyncServer(config, openDatabase(dbPath))
  await assert.rejects(server.start(), /canonical engine state is corrupt/)
  assert.throws(() => server.address(), /server has not started/)
  await server.stop()
})
