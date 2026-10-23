import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import {
  PROTOCOL_VERSION,
  type PortablePetBundleV1,
  type ServerToClient,
} from '../../src/shared/sync/index.js'
import { createHeadlessRuntime, dailyBoundaryMs, dayKeyAt, nextDailyBoundaryMs, type EngineState } from '../../src/shared/pet-runtime/index.js'
import { createServerConfig, type ServerConfig, type ServerConfigInput } from '../src/config.js'
import { initializePet, openDatabase, type CanonicalPetSnapshot } from '../src/db.js'
import { SyncServer } from '../src/index.js'
import { materializeImportedCoverage } from '../src/portable-import.js'

interface Clock {
  now(): number
  set(value: number): void
  advance(ms: number): void
}

function makeClock(start: number): Clock {
  let value = start
  return {
    now: () => value,
    set: next => { value = next },
    advance: ms => { value += ms },
  }
}

interface Harness {
  directory: string
  dbPath: string
  config: ServerConfig
  server: SyncServer
  url: string
  pairingCode: string
  clock: Clock
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

const ONE_HUNDRED_YEARS_MS = 100 * 365 * 24 * 60 * 60 * 1000

async function createHarness(
  t: test.TestContext,
  clock: Clock,
  input: ServerConfigInput & { advanceWhileEmpty?: boolean } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-c9-'))
  const dbPath = join(directory, 'qqpet.sqlite')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    backupDir: join(directory, 'backups'),
    adminSocket: join(directory, 'admin.sock'),
    helloTimeoutMs: 500,
    schedulerEnabled: false,
    ...input,
  })
  const store = openDatabase(dbPath)
  initializePet(store, {
    petId: 'default',
    timeZone: input.timeZone ?? 'Asia/Shanghai',
    weatherCity: '北京',
    nowMs: clock.now(),
    advanceWhileEmpty: input.advanceWhileEmpty ?? true,
  })
  const pairingCode = store.issuePairingCode('default', 'owner', ONE_HUNDRED_YEARS_MS, clock.now()).code
  const server = new SyncServer(config, store, { now: () => clock.now() })
  await server.start()
  const address = server.address()
  const harness: Harness = {
    directory,
    dbPath,
    config,
    server,
    url: 'ws://127.0.0.1:' + address.port + '/v1/sync',
    pairingCode,
    clock,
    async close() {
      await server.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
  t.after(() => harness.close())
  return harness
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
  const ready = await session.next('ready')
  if (ready.t !== 'ready') throw new Error('missing ready')
  return session
}

async function sendCommand(session: Session, requestId: string, command: unknown, observedRevision?: number): Promise<Extract<ServerToClient, { t: 'commandResult' }>> {
  session.send({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId,
    opId: requestId,
    command,
    ...(observedRevision === undefined ? {} : { observedRevision }),
  })
  const result = await Promise.race([
    session.next('commandResult'),
    new Promise<ServerToClient>((_resolve, reject) => setTimeout(() => reject(new Error('timeout waiting for commandResult ' + requestId)), 3000)),
  ])
  if (result.t !== 'commandResult') throw new Error('missing command result')
  return result
}

function canonical(h: Harness): CanonicalPetSnapshot {
  return h.server.store.loadCanonical('default')
}

function eventsOfType(h: Harness, type: string): Array<Record<string, unknown>> {
  return h.server.store.getEvents('default', 0, 1_000_000)
    .filter(event => event.type === type)
    .map(event => JSON.parse(event.payloadJson) as Record<string, unknown>)
}

async function waitFor(predicate: () => boolean, rounds = 500): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('condition was not met')
}

function adoptDirect(h: Harness): void {
  const snapshot = canonical(h)
  const runtime = createHeadlessRuntime(snapshot.engine)
  const outcome = runtime.execute(
    { type: 'pet.adopt', payload: { sex: 'GG' } } as never,
    {
      gameTimeMs: snapshot.pet.gameTimeMs,
      environment: snapshot.engine.environment,
      activeClientCount: 0,
      sessionActive: false,
      actorDeviceId: 'setup-device',
      actorRole: 'owner',
    } as never,
  )
  if (outcome.ok === false) throw new Error('setup adopt failed: ' + outcome.error.message)
  outcome.state.save.settings.undying = true
  h.server.store.transaction(() => {
    const nextPet = h.server.store.replaceEngineAndRevision('default', outcome.state, snapshot.pet.revision, true, h.clock.now())
    let seq = snapshot.pet.eventSeq
    for (const event of outcome.events) {
      seq += 1
      h.server.store.insertEvent('default', {
        eventSeq: seq,
        revision: nextPet.revision,
        commandSeq: null,
        gameTimeMs: outcome.state.gameTimeMs,
        type: event.type,
        payload: event.payload,
        createdAtMs: h.clock.now(),
      })
    }
    h.server.store.db.prepare('UPDATE pets SET event_seq = ? WHERE id = ?').run(seq, 'default')
  })
}

test('advanceWhileEmpty true advances zero-client world time in bounded chunks without session-clock credit', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true, catchupChunkTicks: 2 })
  adoptDirect(h)
  const before = canonical(h)
  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const after = canonical(h)
  assert.equal(after.pet.gameTimeMs - before.pet.gameTimeMs, 5 * 60_000)
  assert.equal(after.pet.lastSchedulerWallMs, clock.now())
  assert.equal(after.engine.save.petInfo.onLineTime, before.engine.save.petInfo.onLineTime)
  assert.equal(after.engine.save.petInfo.onlineDataTime, before.engine.save.petInfo.onlineDataTime)
  const metrics = h.server.metrics.snapshot()
  assert.ok((metrics['scheduler.catchup_chunks'] ?? 0) >= 3)
  assert.equal(metrics['scheduler.ticks'], 5)
  const health = h.server.scheduler.health('default')
  assert.ok(health)
  if (health === undefined) throw new Error('missing health')
  assert.equal(health.catchingUp, false)
  assert.equal(health.wallLagMs, 0)
  assert.equal(health.scheduledJobs, 0)
  assert.equal(health.authorityState, 'active')
  const httpHealth = await fetch('http://127.0.0.1:' + h.server.address().port + '/health').then(response => response.json()) as Record<string, unknown>
  assert.equal(httpHealth.ready, true)
  assert.equal(httpHealth.gameTimeMs, after.pet.gameTimeMs)
  assert.equal(httpHealth.nextTickAtMs, after.pet.lastSchedulerWallMs + 60_000)
})

test('advanceWhileEmpty false freezes with zero clients and reconnect discards the empty gap', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: false })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const start = canonical(h)

  clock.advance(2 * 60_000)
  await h.server.scheduler.runOnce()
  const active = canonical(h)
  assert.equal(active.pet.gameTimeMs - start.pet.gameTimeMs, 2 * 60_000)
  assert.equal(active.engine.save.petInfo.onLineTime - start.engine.save.petInfo.onLineTime, 2)

  await owner.close()
  await waitFor(() => h.server.scheduler.health('default')?.activeClientCount === 0)
  clock.advance(10 * 60_000)
  await h.server.scheduler.runOnce()
  const frozen = canonical(h)
  assert.equal(frozen.pet.gameTimeMs, active.pet.gameTimeMs)
  assert.equal(frozen.pet.lastSchedulerWallMs, clock.now())

  const reconnect = await connect(h, { kind: 'token', token: owner.token })
  clock.advance(2 * 60_000)
  await h.server.scheduler.runOnce()
  const resumed = canonical(h)
  assert.equal(resumed.pet.gameTimeMs - frozen.pet.gameTimeMs, 2 * 60_000)
  assert.equal(resumed.engine.save.petInfo.onLineTime - frozen.engine.save.petInfo.onLineTime, 2)

  clock.advance(60_000)
  await h.server.scheduler.runOnce()
  const oneMinute = canonical(h)
  assert.equal(oneMinute.pet.gameTimeMs - frozen.pet.gameTimeMs, 3 * 60_000)
  assert.equal(oneMinute.engine.save.petInfo.onLineTime - frozen.engine.save.petInfo.onLineTime, 3)
  await reconnect.close()
})

test('historical catch-up derives session-active minutes from persisted coverage only', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const base = canonical(h)
  const startGameTime = base.pet.gameTimeMs

  clock.advance(10 * 60_000)
  const coverageId = h.server.store.beginCoverage('default', 'device-mid', 'connection-mid', clock.now() - 5 * 60_000)
  await h.server.scheduler.runOnce()
  const midway = canonical(h)
  assert.equal(midway.pet.gameTimeMs - startGameTime, 10 * 60_000)
  assert.equal(midway.engine.save.petInfo.onLineTime, 5)
  h.server.store.closeCoverage('default', coverageId, clock.now(), 'disconnect')

  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const uncovered = canonical(h)
  assert.equal(uncovered.pet.gameTimeMs - startGameTime, 15 * 60_000)
  assert.equal(uncovered.engine.save.petInfo.onLineTime, 5)

  const stallCoverage = h.server.store.beginCoverage('default', 'device-stall', 'connection-stall', clock.now())
  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const stall = canonical(h)
  assert.equal(stall.pet.gameTimeMs - startGameTime, 20 * 60_000)
  assert.equal(stall.engine.save.petInfo.onLineTime, 10)
  h.server.store.closeCoverage('default', stallCoverage, clock.now(), 'disconnect')
})

test('direct 06:00 boundaries run exactly once with no daily job rows and handle DST/timezone changes', async t => {
  const clock = makeClock(Date.UTC(2026, 2, 8, 9, 0, 0))
  const h = await createHarness(t, clock, { timeZone: 'America/New_York', advanceWhileEmpty: true })
  adoptDirect(h)
  const store = h.server.store

  clock.set(Date.UTC(2026, 2, 8, 10, 30, 0))
  await h.server.scheduler.runOnce()
  const springForward = canonical(h)
  assert.equal(springForward.engine.lastProcessedDayBoundaryKey, '2026-03-08')
  assert.equal(springForward.engine.nextDailyBoundaryMs, dailyBoundaryMs('2026-03-09', 'America/New_York'))
  assert.equal(eventsOfType(h, 'task.progress').filter(payload => payload.dailyReset === true).length, 1)
  assert.equal(eventsOfType(h, 'signin.changed').filter(payload => payload.dailyReset === true).length, 1)
  assert.equal(store.listScheduledJobs('default').length, 0)

  clock.set(Date.UTC(2026, 2, 9, 10, 30, 0))
  await h.server.scheduler.runOnce()
  const nextDay = canonical(h)
  assert.equal(nextDay.engine.lastProcessedDayBoundaryKey, '2026-03-09')
  const resets = eventsOfType(h, 'task.progress').filter(payload => payload.dailyReset === true)
  assert.equal(resets.length, 2)
  assert.deepEqual(resets.map(payload => payload.dayKey).sort(), ['2026-03-08', '2026-03-09'])
  assert.equal(store.listScheduledJobs('default').length, 0)

  const owner = await pairOwner(h)
  const timezoneChange = await sendCommand(owner, 'tz-change', { type: 'server.setTimeZone', payload: { timeZone: 'Asia/Shanghai' } })
  assert.equal(timezoneChange.status, 'applied')
  const shanghai = canonical(h)
  assert.equal(shanghai.engine.lastProcessedDayBoundaryKey, dayKeyAt(shanghai.pet.gameTimeMs, 'Asia/Shanghai'))
  assert.equal(shanghai.engine.nextDailyBoundaryMs, dailyBoundaryMs('2026-03-10', 'Asia/Shanghai'))
  assert.equal(eventsOfType(h, 'task.progress').filter(payload => payload.dailyReset === true).length, 2)

  clock.set(Date.UTC(2026, 2, 9, 22, 30, 0))
  await h.server.scheduler.runOnce()
  const shanghaiNext = canonical(h)
  assert.equal(shanghaiNext.engine.lastProcessedDayBoundaryKey, '2026-03-10')
  const shanghaiResets = eventsOfType(h, 'task.progress').filter(payload => payload.dailyReset === true)
  assert.equal(shanghaiResets.length, 3)
  assert.equal(shanghaiResets[2].dayKey, '2026-03-10')
  await owner.close()

  assert.equal(dailyBoundaryMs('2026-11-01', 'America/New_York'), Date.UTC(2026, 10, 1, 11, 0, 0))
  assert.equal(dayKeyAt(Date.UTC(2026, 10, 1, 11, 30, 0), 'America/New_York'), '2026-11-01')
})

function buildLocalBundle(h: Harness, options: {
  anchorMs?: number
  epoch?: number
  restoreGeneration?: number
  authorityId?: string
  handoffId?: string
  originLocalDeviceId?: string
  mutateEngine?: (engine: EngineState) => void
} = {}): PortablePetBundleV1 {
  const snapshot = canonical(h)
  const engine = JSON.parse(JSON.stringify(snapshot.engine)) as EngineState
  if (options.mutateEngine !== undefined) options.mutateEngine(engine)
  if (options.anchorMs !== undefined) engine.lastSchedulerWallMs = options.anchorMs
  return {
    format: 'qqpet-portable-v1',
    schemaVersion: 1,
    exportedAtWallMs: h.clock.now(),
    authority: {
      owner: 'local',
      authorityId: options.authorityId ?? snapshot.authority.authorityId,
      epoch: options.epoch ?? snapshot.authority.epoch + 1,
      restoreGeneration: options.restoreGeneration ?? snapshot.authority.restoreGeneration,
      revision: snapshot.pet.revision,
      eventSeq: snapshot.pet.eventSeq,
      handoffId: options.handoffId ?? 'local-handoff-' + snapshot.authority.epoch,
      detachedAtWallMs: h.clock.now(),
    },
    originLocalDeviceId: options.originLocalDeviceId ?? 'local-device-1',
    shared: engine.save,
    engine,
  }
}

test('commands are rejected with server_catching_up during catch-up and a final ready follows', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true, catchupChunkTicks: 1 })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const before = canonical(h)
  clock.advance(5 * 60_000)
  const catchup = h.server.scheduler.runOnce()
  assert.equal(h.server.scheduler.isCatchingUp('default'), true)

  const rejected = await sendCommand(owner, 'during-catchup', { type: 'pet.rename', payload: { name: 'ShouldNotApply' } })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'server_catching_up')
  assert.equal(rejected.error?.refreshProjection, true)
  const afterRejected = canonical(h)
  assert.equal(afterRejected.engine.save.petInfo.name, before.engine.save.petInfo.name)

  await catchup
  assert.equal(h.server.scheduler.isCatchingUp('default'), false)
  const after = canonical(h)
  assert.equal(after.pet.gameTimeMs - before.pet.gameTimeMs, 5 * 60_000)
  const ready = await owner.next('ready')
  assert.equal(ready.t, 'ready')
  if (ready.t === 'ready') assert.equal(ready.catchingUp, false)
  await owner.close()
})

test('failed catch-up stays not-ready and fences commands until a retry reaches the target', async t => {
  const clock = makeClock(Date.UTC(2026, 2, 8, 9, 0, 0))
  const h = await createHarness(t, clock, {
    advanceWhileEmpty: true,
    timeZone: 'America/New_York',
    catchupChunkTicks: 120,
  })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const before = canonical(h)
  clock.set(Date.UTC(2026, 2, 9, 11, 0, 0))

  const originalCommit = h.server.store.commitSchedulerBatch.bind(h.server.store)
  let forcedFailures = 1
  h.server.store.commitSchedulerBatch = (...args) => {
    if (forcedFailures > 0) {
      forcedFailures -= 1
      throw new Error('forced daily-boundary catch-up failure')
    }
    return originalCommit(...args)
  }

  await h.server.scheduler.runOnce()
  assert.equal(forcedFailures, 0)
  assert.equal(canonical(h).pet.gameTimeMs, before.pet.gameTimeMs)
  assert.equal(h.server.scheduler.isCatchingUp('default'), false)
  assert.equal(h.server.scheduler.isCatchUpBlocked('default'), true)
  assert.equal(h.server.scheduler.isReady('default'), false)
  const failedHealth = h.server.scheduler.health('default')
  assert.ok(failedHealth)
  assert.equal(failedHealth.ready, false)
  assert.equal(failedHealth.catchingUp, true)
  const failedHttpHealth = await fetch('http://127.0.0.1:' + h.server.address().port + '/health')
    .then(response => response.json()) as Record<string, unknown>
  assert.equal(failedHttpHealth.ready, false)
  assert.equal(failedHttpHealth.lastErrorEvent, 'scheduler.tick_failed')
  assert.match(String(failedHttpHealth.lastError), /forced daily-boundary catch-up failure/)
  assert.equal(failedHttpHealth.dbWritable, true)
  assert.equal(failedHttpHealth.quickCheck, 'ok')
  const failedHealthz = await fetch('http://127.0.0.1:' + h.server.address().port + '/healthz')
  assert.equal(failedHealthz.status, 200)
  assert.equal((await failedHealthz.json() as Record<string, unknown>).ok, true)
  const failedReadyz = await fetch('http://127.0.0.1:' + h.server.address().port + '/readyz')
  assert.equal(failedReadyz.status, 503)
  assert.equal((await failedReadyz.json() as Record<string, unknown>).ready, false)

  const rejected = await sendCommand(owner, 'command-during-failed-catchup', {
    type: 'pet.rename',
    payload: { name: 'MustNotApply' },
  })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'server_catching_up')
  assert.equal(canonical(h).engine.save.petInfo.name, before.engine.save.petInfo.name)

  await h.server.scheduler.runOnce()
  assert.equal(h.server.scheduler.isCatchUpBlocked('default'), false)
  assert.equal(h.server.scheduler.isReady('default'), true)
  const healthy = h.server.scheduler.health('default')
  assert.ok(healthy)
  assert.equal(healthy.ready, true)
  assert.equal(healthy.catchingUp, false)
  const recoveredHttpHealth = await fetch('http://127.0.0.1:' + h.server.address().port + '/health')
    .then(response => response.json()) as Record<string, unknown>
  assert.equal(recoveredHttpHealth.ready, true)
  const recoveredReadyz = await fetch('http://127.0.0.1:' + h.server.address().port + '/readyz')
  assert.equal(recoveredReadyz.status, 200)
  assert.equal((await recoveredReadyz.json() as Record<string, unknown>).ready, true)

  const after = canonical(h)
  assert.equal(after.pet.lastSchedulerWallMs, clock.now())
  assert.equal(after.pet.gameTimeMs, before.pet.gameTimeMs + (clock.now() - before.pet.lastSchedulerWallMs))
  assert.ok(eventsOfType(h, 'task.progress').some(payload => payload.dailyReset === true))

  const accepted = await sendCommand(owner, 'command-after-catchup-retry', {
    type: 'pet.rename',
    payload: { name: 'AfterRetry' },
  })
  assert.equal(accepted.status, 'applied')
  assert.equal(canonical(h).engine.save.petInfo.name, 'AfterRetry')
  await owner.close()
})

test('readiness detects a stalled scheduler pass', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, {
    advanceWhileEmpty: true,
    schedulerEnabled: true,
    schedulerPollMs: 1000,
  })
  adoptDirect(h)
  clock.advance(31_000)
  const health = h.server.health()
  assert.equal(health.ready, false)
  assert.equal(health.petHealth[0]?.stuck, true)
  assert.equal(health.scheduler[0]?.stuck, true)
})

test('scheduled work rewards are ordered and committed exactly once across a restart', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const cheat = await sendCommand(owner, 'cheat-growth', { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 5000 } })
  assert.equal(cheat.status, 'applied')
  const started = await sendCommand(owner, 'start-work', { type: 'job.startWork', payload: { jobId: 'bz' } })
  assert.equal(started.status, 'applied')
  const startResult = started.result as { dueAtGameMs: number }
  const startGameTime = canonical(h).pet.gameTimeMs
  clock.advance(startResult.dueAtGameMs - startGameTime + 5 * 60_000)
  await h.server.scheduler.runOnce()
  const workRewards = eventsOfType(h, 'reward.granted').filter(payload => payload.source === 'work')
  assert.equal(workRewards.length, 1)
  const jobs = h.server.store.listScheduledJobs('default')
  assert.equal(jobs.filter(job => job.type === 'work' && job.status === 'completed').length, 1)

  await h.server.scheduler.runOnce()
  assert.equal(eventsOfType(h, 'reward.granted').filter(payload => payload.source === 'work').length, 1)

  await owner.close()
  await h.server.stop()
  const restoredStore = openDatabase(h.dbPath)
  const restoredServer = new SyncServer(h.config, restoredStore, { now: () => clock.now() })
  await restoredServer.scheduler.runOnce()
  const restoredEvents = restoredStore.getEvents('default', 0, 1_000_000)
  assert.equal(restoredEvents.filter(event => event.type === 'reward.granted' && JSON.parse(event.payloadJson).source === 'work').length, 1)
  await restoredServer.stop()
})

test('game session expiry happens once in game time and a token can never be rewarded after expiry', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  await sendCommand(owner, 'cheat-session', { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 5000 } })
  const started = await sendCommand(owner, 'start-session', { type: 'game.startSession', payload: { gameId: 'small-1', kind: 'small' } })
  assert.equal(started.status, 'applied')
  const token = (started.result as { sessionToken: string }).sessionToken

  clock.advance(61 * 60_000)
  await h.server.scheduler.runOnce()
  const session = h.server.store.listGameSessions('default').find(candidate => candidate.sessionToken === token)
  assert.ok(session)
  if (session === undefined) throw new Error('missing session')
  assert.equal(session.status, 'expired')
  assert.equal(session.cancelReason, 'deadline_expired')
  const expiredEvents = eventsOfType(h, 'game.sessionSettled').filter(payload => payload.status === 'expired')
  assert.equal(expiredEvents.length, 1)
  const job = h.server.store.listScheduledJobs('default').find(candidate => candidate.type === 'game-session' && candidate.payload.sessionToken === token)
  assert.ok(job)
  if (job === undefined) throw new Error('missing session job')
  assert.equal(job.status, 'completed')

  const reward = await sendCommand(owner, 'reward-expired', { type: 'game.reward', payload: { sessionToken: token } })
  assert.equal(reward.status, 'rejected')
  await h.server.scheduler.runOnce()
  assert.equal(eventsOfType(h, 'game.sessionSettled').filter(payload => payload.status === 'expired').length, 1)
  await owner.close()
})

test('portable import rejects out-of-bounds anchors by default and explicit clamp realigns deadlines', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  await sendCommand(owner, 'cheat-import', { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 5000 } })
  const importedSession = await sendCommand(owner, 'start-session-import', { type: 'game.startSession', payload: { gameId: 'small-import', kind: 'small' } })
  assert.equal(importedSession.status, 'applied')
  await sendCommand(owner, 'start-work-import', { type: 'job.startWork', payload: { jobId: 'bz' } })
  const before = canonical(h)
  const staleAnchor = clock.now() - 7 * 24 * 60 * 60_000
  const bundle = buildLocalBundle(h, { anchorMs: staleAnchor })

  const rejected = await sendCommand(owner, 'import-reject', { type: 'admin.importPortableBundle', payload: { bundle, allowClamp: false } })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'anchor_out_of_bounds')
  const unchanged = canonical(h)
  assert.equal(unchanged.authority.epoch, before.authority.epoch)
  assert.equal(unchanged.pet.gameTimeMs, before.pet.gameTimeMs)

  const accepted = await sendCommand(owner, 'import-clamp', { type: 'admin.importPortableBundle', payload: { bundle, allowClamp: true, rebindLocalSessions: true } })
  assert.equal(accepted.status, 'applied')
  assert.equal((accepted.result as { importClamped?: boolean } | undefined)?.importClamped, true)
  const imported = canonical(h)
  assert.equal(imported.engine.importClamped, true)
  const skipped = imported.engine.clockSkippedMs
  assert.ok(skipped > 0)
  assert.equal(imported.pet.lastSchedulerWallMs, clock.now() - 48 * 60 * 60_000)
  const beforeJob = before.engine.scheduledJobs.find(job => job.type === 'work')
  const afterJob = imported.engine.scheduledJobs.find(job => job.type === 'work')
  assert.ok(beforeJob)
  assert.ok(afterJob)
  if (beforeJob === undefined || afterJob === undefined) throw new Error('missing work job')
  assert.equal(afterJob.dueAtGameMs, beforeJob.dueAtGameMs + skipped)
  const beforeSession = before.engine.gameSessions.find(session => session.status === 'active')
  const afterSession = imported.engine.gameSessions.find(session => session.status === 'active')
  assert.ok(beforeSession)
  assert.ok(afterSession)
  if (beforeSession === undefined || afterSession === undefined) throw new Error('missing session')
  assert.equal(afterSession.expiresAtGameMs, beforeSession.expiresAtGameMs + skipped)
  assert.equal(afterSession.actorDeviceId, owner.deviceId)
  assert.equal(afterJob.status, 'pending')
  assert.equal(afterSession.status, 'active')
  assert.equal(eventsOfType(h, 'reward.granted').filter(payload => payload.source === 'work').length, 0)
  assert.equal(eventsOfType(h, 'game.sessionSettled').length, 0)

  const coverage = h.server.store.listSessionCoverage('default')
  assert.equal(coverage.filter(interval => interval.closeReason === 'import_replaced').length > 0, true)
  const operation = h.server.store.db.prepare(
    'SELECT * FROM coverage_operations WHERE pet_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get('default') as { operation_id: string; commit_wall_ms: number; state: string } | undefined
  assert.ok(operation)
  if (operation === undefined) throw new Error('missing coverage operation')
  assert.equal(operation.state, 'completed')
  const reopened = coverage.find(interval => interval.coverageId === operation.operation_id + ':' + owner.welcome.connectionId)
  assert.ok(reopened)
  if (reopened === undefined) throw new Error('missing reopened coverage')
  assert.equal(reopened.disconnectedAtWallMs, undefined)
  assert.equal(reopened.connectedAtWallMs, Number(operation.commit_wall_ms))
  assert.equal(imported.engine.save.nowTimeLine, Math.floor(imported.pet.gameTimeMs / 1000))
  assert.equal(imported.engine.lastProcessedDayBoundaryKey, dayKeyAt(imported.pet.gameTimeMs, imported.engine.timeZone))
  assert.equal(imported.engine.nextDailyBoundaryMs, nextDailyBoundaryMs(imported.pet.gameTimeMs, imported.engine.timeZone))
  await owner.close()
})

test('portable import rejects invalid daily-boundary metadata before commit', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const before = canonical(h)

  const invalidNext = buildLocalBundle(h, {
    mutateEngine: engine => {
      engine.nextDailyBoundaryMs = 0
    },
  })
  const rejectedNext = await sendCommand(owner, 'import-invalid-next-boundary', {
    type: 'admin.importPortableBundle',
    payload: { bundle: invalidNext },
  })
  assert.equal(rejectedNext.status, 'rejected')
  assert.equal(rejectedNext.error?.code, 'invalid_payload')
  assert.match(rejectedNext.error?.message ?? '', /daily-boundary metadata/)

  const invalidLast = buildLocalBundle(h, {
    mutateEngine: engine => {
      engine.lastProcessedDayBoundaryKey = '1999-01-01'
    },
  })
  const rejectedLast = await sendCommand(owner, 'import-invalid-last-boundary', {
    type: 'admin.importPortableBundle',
    payload: { bundle: invalidLast },
  })
  assert.equal(rejectedLast.status, 'rejected')
  assert.equal(rejectedLast.error?.code, 'invalid_payload')
  assert.match(rejectedLast.error?.message ?? '', /daily-boundary metadata/)

  const after = canonical(h)
  assert.equal(after.authority.epoch, before.authority.epoch)
  assert.equal(after.pet.gameTimeMs, before.pet.gameTimeMs)
  assert.equal(after.engine.save.nowTimeLine, before.engine.save.nowTimeLine)
  await owner.close()
})

test('materializeImportedCoverage preserves stable suspend rows without extending or rewriting them', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  const engine = canonical(h).engine
  const commitWallMs = engine.gameTimeMs
  const suspendedAtWallMs = commitWallMs + 60_000
  const firstSurvivor = {
    kind: 'server_connection' as const,
    connectionId: 'suspend-current',
    deviceId: 'device-current',
    lastHeartbeatWallMs: commitWallMs,
    eligible: true,
  }
  const secondSurvivor = {
    kind: 'server_connection' as const,
    connectionId: 'suspend-earlier',
    deviceId: 'device-earlier',
    lastHeartbeatWallMs: commitWallMs,
    eligible: true,
  }
  engine.sessionCoverage = [
    {
      coverageId: 'op-suspend:suspend-current',
      deviceId: 'device-current',
      connectedAtWallMs: commitWallMs,
      disconnectedAtWallMs: suspendedAtWallMs,
      lastHeartbeatWallMs: suspendedAtWallMs,
      closeReason: 'suspend',
    },
    {
      coverageId: 'op-suspend:suspend-earlier',
      deviceId: 'device-earlier',
      connectedAtWallMs: commitWallMs,
      disconnectedAtWallMs: commitWallMs + 20_000,
      lastHeartbeatWallMs: commitWallMs + 20_000,
      closeReason: 'suspend',
    },
  ]
  engine.coverageReopen = {
    operationId: 'op-suspend',
    commitWallMs,
    survivors: [firstSurvivor, secondSurvivor],
    state: 'suspended',
    suspendedAtWallMs,
  }

  const rows = materializeImportedCoverage(engine, commitWallMs + 3_600_000)
  const byId = new Map(rows.map(row => [row.coverageId, row]))
  const current = byId.get('op-suspend:suspend-current')
  const earlier = byId.get('op-suspend:suspend-earlier')
  assert.ok(current)
  assert.ok(earlier)
  if (current === undefined || earlier === undefined) throw new Error('missing materialized suspend rows')
  assert.equal(current.disconnectedAtWallMs, suspendedAtWallMs)
  assert.equal(current.lastHeartbeatWallMs, suspendedAtWallMs)
  assert.equal(current.closeReason, 'suspend')
  assert.equal(earlier.disconnectedAtWallMs, commitWallMs + 20_000)
  assert.equal(earlier.lastHeartbeatWallMs, commitWallMs + 20_000)
  assert.equal(earlier.closeReason, 'suspend')
})

test('portable import adopts an independent local authority into an unclaimed server pet', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  const owner = await pairOwner(h)
  const placeholder = canonical(h).authority
  assert.equal(placeholder.owner, 'server')
  assert.equal(placeholder.restoreGeneration, 0)
  const localAuthorityId = '11111111-1111-4111-8111-111111111111'
  assert.notEqual(placeholder.authorityId, localAuthorityId)

  const source = buildLocalBundle(h, {
    authorityId: localAuthorityId,
    restoreGeneration: 1,
    epoch: 1,
    handoffId: 'local-handoff-migration',
    anchorMs: clock.now(),
    mutateEngine: engine => {
      engine.save.settings.undying = true
    },
  })
  const imported = await sendCommand(owner, 'import-independent-local', {
    type: 'admin.importPortableBundle',
    payload: { bundle: source },
  })
  assert.equal(imported.status, 'applied')
  const adopted = canonical(h)
  assert.equal(adopted.authority.authorityId, localAuthorityId)
  assert.equal(adopted.authority.restoreGeneration, 1)
  assert.equal(adopted.authority.epoch, 2)
  assert.equal(adopted.authority.owner, 'server')
  assert.equal(adopted.authority.state, 'active')
  assert.equal(adopted.engine.save.settings.undying, true)

  const fork = await sendCommand(owner, 'import-independent-fork', {
    type: 'admin.importPortableBundle',
    payload: {
      bundle: {
        ...source,
        authority: {
          ...source.authority,
          authorityId: '22222222-2222-4222-8222-222222222222',
          epoch: 2,
        },
      },
    },
  })
  assert.equal(fork.status, 'rejected')
  assert.equal(fork.error?.code, 'authority_fork_risk')
  await owner.close()

  const reconnected = await connect(h, { kind: 'token', token: owner.token })
  assert.equal(reconnected.welcome.authority.authorityId, localAuthorityId)
  assert.equal(reconnected.welcome.authority.restoreGeneration, 1)
  assert.equal(reconnected.welcome.authority.epoch, 2)
  await reconnected.close()
})

test('pre-import backups run once only for a valid owner import', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  const owner = await pairOwner(h)
  const playerCode = h.server.store.issuePairingCode('default', 'player', 10 * 60_000, clock.now())
  const player = await connect(h, { kind: 'pairing', code: playerCode.code, deviceLabel: 'Player phone' })
  await player.next('ready')

  const backupNames = async (): Promise<string[]> => (await readdir(h.config.backupDir))
    .filter(name => name.includes('-pre-import-'))
  assert.deepEqual(await backupNames(), [])

  const localAuthorityId = '33333333-3333-4333-8333-333333333333'
  const staleBundle = buildLocalBundle(h, {
    authorityId: localAuthorityId,
    restoreGeneration: 1,
    epoch: 1,
    handoffId: 'local-handoff-backup',
    anchorMs: clock.now() - 7 * 24 * 60 * 60_000,
  })
  const unauthorized = await sendCommand(player, 'backup-unauthorized', {
    type: 'admin.importPortableBundle',
    payload: { bundle: staleBundle },
  })
  assert.equal(unauthorized.status, 'rejected')
  assert.equal(unauthorized.error?.code, 'unauthorized')
  assert.deepEqual(await backupNames(), [])

  const rejected = await sendCommand(owner, 'backup-rejected', {
    type: 'admin.importPortableBundle',
    payload: { bundle: staleBundle },
  })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'anchor_out_of_bounds')
  assert.deepEqual(await backupNames(), [])

  const validBundle = buildLocalBundle(h, {
    authorityId: localAuthorityId,
    restoreGeneration: 1,
    epoch: 1,
    handoffId: 'local-handoff-backup',
    anchorMs: clock.now(),
  })
  const importCommand = {
    type: 'admin.importPortableBundle' as const,
    payload: { bundle: validBundle },
  }
  const applied = await sendCommand(owner, 'backup-valid', importCommand)
  assert.equal(applied.status, 'applied')
  assert.equal((await backupNames()).length, 1)

  const duplicate = await sendCommand(owner, 'backup-valid', importCommand)
  assert.equal(duplicate.status, 'duplicate')
  assert.equal((await backupNames()).length, 1)

  const rejectedAfterAdoption = await sendCommand(owner, 'backup-rejected-after', {
    type: 'admin.importPortableBundle',
    payload: { bundle: staleBundle },
  })
  assert.equal(rejectedAfterAdoption.status, 'rejected')
  assert.equal(rejectedAfterAdoption.error?.code, 'authority_fork_risk')
  assert.equal((await backupNames()).length, 1)
  await owner.close()
  await player.close()
})

test('future-skewed imports use wall now without backfill and beyond-window imports reject unless clamped', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const before = canonical(h)
  const nearFuture = buildLocalBundle(h, { anchorMs: clock.now() + 2 * 60_000 })
  const applied = await sendCommand(owner, 'import-future', { type: 'admin.importPortableBundle', payload: { bundle: nearFuture } })
  assert.equal(applied.status, 'applied')
  const imported = canonical(h)
  assert.equal(imported.pet.lastSchedulerWallMs, clock.now())
  assert.equal(imported.engine.importClamped, false)
  assert.equal(imported.pet.gameTimeMs, before.pet.gameTimeMs)
  await h.server.scheduler.runOnce()
  assert.equal(canonical(h).pet.gameTimeMs, before.pet.gameTimeMs)

  const exactBoundary = buildLocalBundle(h, { anchorMs: clock.now() - 48 * 60 * 60_000 })
  const exactApplied = await sendCommand(owner, 'import-exact-boundary', { type: 'admin.importPortableBundle', payload: { bundle: exactBoundary } })
  assert.equal(exactApplied.status, 'applied')
  const exactState = canonical(h)
  assert.equal(exactState.engine.importClamped, false)
  assert.equal(exactState.pet.lastSchedulerWallMs, clock.now() - 48 * 60 * 60_000)

  const farFuture = buildLocalBundle(h, { anchorMs: clock.now() + 60 * 60_000 })
  const rejected = await sendCommand(owner, 'import-far-future', { type: 'admin.importPortableBundle', payload: { bundle: farFuture, allowClamp: false } })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error?.code, 'anchor_out_of_bounds')
  const unchanged = canonical(h)
  const clamped = await sendCommand(owner, 'import-far-future-clamp', { type: 'admin.importPortableBundle', payload: { bundle: farFuture, allowClamp: true } })
  assert.equal(clamped.status, 'applied')
  assert.equal((clamped.result as { importClamped?: boolean } | undefined)?.importClamped, true)
  const clampedState = canonical(h)
  assert.equal(clampedState.engine.importClamped, true)
  assert.equal(clampedState.engine.clockSkippedMs, clock.now() - (clock.now() + 60 * 60_000))
  assert.equal(clampedState.pet.lastSchedulerWallMs, clock.now())
  assert.equal(clampedState.pet.gameTimeMs, unchanged.pet.gameTimeMs + clampedState.engine.clockSkippedMs)
  await owner.close()

  const expectedGameTime = clampedState.pet.gameTimeMs
  await h.server.stop()
  const restartedStore = openDatabase(h.dbPath)
  const restartedServer = new SyncServer(
    { ...h.config, dbPath: h.dbPath, backupDir: join(h.directory, 'restart-backups') },
    restartedStore,
    { now: () => clock.now() },
  )
  await restartedServer.scheduler.runOnce()
  assert.equal(restartedStore.loadCanonical('default').pet.gameTimeMs, expectedGameTime)
  await restartedServer.stop()
})

test('exportForDetach clears archived sockets and resumeServer enforces epoch fencing and reopens coverage', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const before = canonical(h)
  const ownerClosed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    owner.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    owner.ws.once('error', reject)
  })
  const exported = await sendCommand(owner, 'detach', { type: 'admin.exportForDetach', payload: {} })
  assert.equal(exported.status, 'applied')
  const detached = exported.result as { authority: { epoch: number; handoffId: string }; bundle: PortablePetBundleV1 }
  const archivedStatus = await owner.next('ready')
  if (archivedStatus.t !== 'ready') throw new Error('missing archived status')
  assert.equal(archivedStatus.authority.state, 'archived')
  const ownerClose = await ownerClosed
  assert.equal(ownerClose.code, 1000)
  assert.equal(ownerClose.reason, 'authority_archived')
  await waitFor(() => h.server.scheduler.health('default')?.activeClientCount === 0)
  const archived = canonical(h)
  assert.equal(archived.authority.state, 'archived')
  assert.equal(archived.authority.epoch, before.authority.epoch)
  assert.equal(archived.authority.handoffEpoch, before.authority.epoch + 1)
  assert.equal(h.server.scheduler.health('default')?.activeClientCount, 0)
  assert.equal(h.server.scheduler.isReady('default'), false)
  assert.equal(h.server.store.listSessionCoverage('default').some(interval => interval.disconnectedAtWallMs === undefined), false)

  const archivedOwner = await connect(h, { kind: 'token', token: owner.token })
  const reconnectStatus = await archivedOwner.next('ready')
  if (reconnectStatus.t !== 'ready') throw new Error('missing archived reconnect status')
  assert.equal(reconnectStatus.authority.state, 'archived')

  const resent = await sendCommand(archivedOwner, 'detach-resend', { type: 'admin.exportForDetach', payload: {} })
  assert.equal(resent.status, 'applied')
  const resentResult = resent.result as { authority: { epoch: number; handoffId: string }; bundle: PortablePetBundleV1 }
  assert.equal(resentResult.authority.epoch, detached.authority.epoch)
  assert.equal(resentResult.authority.handoffId, detached.authority.handoffId)
  const afterResend = canonical(h)
  assert.equal(afterResend.authority.state, 'archived')
  assert.equal(afterResend.authority.epoch, detached.authority.epoch)
  assert.equal(afterResend.engine.gameTimeMs, archived.engine.gameTimeMs)

  const denied = await sendCommand(archivedOwner, 'archived-rename', { type: 'pet.rename', payload: { name: 'ArchivedShouldNotApply' } })
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.error?.code, 'authority_not_active')

  const staleBundle = {
    ...detached.bundle,
    authority: { ...detached.bundle.authority, owner: 'local' as const, epoch: detached.authority.epoch, handoffId: 'stale-handoff' },
    originLocalDeviceId: 'local-device-1',
  }
  const stale = await sendCommand(archivedOwner, 'resume-stale', { type: 'admin.resumeServer', payload: { expectedEpoch: staleBundle.authority.epoch, bundle: staleBundle } })
  assert.equal(stale.status, 'rejected')
  assert.equal(stale.error?.code, 'authority_fork_risk')

  const validBundle = {
    ...detached.bundle,
    authority: { ...detached.bundle.authority, owner: 'local' as const, epoch: detached.authority.epoch + 1, handoffId: 'local-handoff-next' },
    originLocalDeviceId: 'local-device-1',
  }
  const wrongEpoch = await sendCommand(archivedOwner, 'resume-wrong-epoch', { type: 'admin.resumeServer', payload: { expectedEpoch: detached.authority.epoch + 5, bundle: validBundle } })
  assert.equal(wrongEpoch.status, 'rejected')
  assert.equal(wrongEpoch.error?.code, 'authority_fork_risk')

  const resumed = await sendCommand(archivedOwner, 'resume-valid', { type: 'admin.resumeServer', payload: { expectedEpoch: validBundle.authority.epoch, bundle: validBundle } })
  assert.equal(resumed.status, 'applied')
  const active = canonical(h)
  assert.equal(active.authority.state, 'active')
  assert.equal(active.authority.epoch, detached.authority.epoch + 2)
  const operation = h.server.store.db.prepare(
    'SELECT * FROM coverage_operations WHERE pet_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get('default') as { operation_id: string; commit_wall_ms: number; state: string } | undefined
  assert.ok(operation)
  if (operation === undefined) throw new Error('missing coverage operation')
  assert.equal(operation.state, 'completed')
  const reopened = h.server.store.listSessionCoverage('default').find(interval => interval.coverageId === operation.operation_id + ':' + archivedOwner.welcome.connectionId)
  assert.ok(reopened)
  if (reopened === undefined) throw new Error('missing reopened coverage')
  assert.equal(reopened.disconnectedAtWallMs, undefined)
  await archivedOwner.close()
})

test('SQLite backup restores the committed anchor and deterministic catch-up continues identically', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const checkpoint = join(h.directory, 'checkpoint.sqlite')
  await h.server.store.backup(checkpoint)
  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const expected = canonical(h)
  await h.server.stop()

  const restoredStore = openDatabase(checkpoint)
  const restoredServer = new SyncServer(
    { ...h.config, dbPath: checkpoint, backupDir: join(h.directory, 'restored-backups') },
    restoredStore,
    { now: () => clock.now() },
  )
  await restoredServer.scheduler.runOnce()
  const restored = restoredStore.loadCanonical('default')
  assert.equal(restored.pet.gameTimeMs, expected.pet.gameTimeMs)
  assert.equal(restored.pet.revision, expected.pet.revision)
  assert.equal(JSON.stringify(restored.engine.save), JSON.stringify(expected.engine.save))
  assert.equal(JSON.stringify(restored.engine.rng), JSON.stringify(expected.engine.rng))
  assert.equal(JSON.stringify(restored.engine.scheduledJobs), JSON.stringify(expected.engine.scheduledJobs))
  await restoredServer.stop()
})

test('pause shifts pending deadlines without settling rewards until active game time elapses', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  await sendCommand(owner, 'pause-cheat', { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 5000 } })
  await sendCommand(owner, 'pause-work', { type: 'job.startWork', payload: { jobId: 'bz' } })
  const before = canonical(h)
  const initialJob = before.engine.scheduledJobs.find(job => job.type === 'work')
  assert.ok(initialJob)
  if (initialJob === undefined) throw new Error('missing work job')
  const paused = await sendCommand(owner, 'pause-on', { type: 'pet.setPaused', payload: { paused: true } })
  assert.equal(paused.status, 'applied')

  clock.advance(40 * 60_000)
  await h.server.scheduler.runOnce()
  const pausedState = canonical(h)
  const pausedJob = pausedState.engine.scheduledJobs.find(job => job.type === 'work')
  assert.ok(pausedJob)
  if (pausedJob === undefined) throw new Error('missing paused job')
  assert.equal(pausedJob.status, 'pending')
  assert.equal(pausedJob.dueAtGameMs - initialJob.dueAtGameMs, 40 * 60_000)
  assert.equal(eventsOfType(h, 'reward.granted').filter(payload => payload.source === 'work').length, 0)

  const unpaused = await sendCommand(owner, 'pause-off', { type: 'pet.setPaused', payload: { paused: false } })
  assert.equal(unpaused.status, 'applied')
  const activeState = canonical(h)
  clock.advance(pausedJob.dueAtGameMs - activeState.pet.gameTimeMs + 2 * 60_000)
  await h.server.scheduler.runOnce()
  assert.equal(eventsOfType(h, 'reward.granted').filter(payload => payload.source === 'work').length, 1)
  const completed = canonical(h).engine.scheduledJobs.find(job => job.type === 'work')
  assert.ok(completed)
  if (completed === undefined) throw new Error('missing completed job')
  assert.equal(completed.status, 'completed')
  await owner.close()
})

test('daily boundary keys are not replayed across a scheduler restart', async t => {
  const clock = makeClock(Date.UTC(2026, 2, 8, 9, 0, 0))
  const h = await createHarness(t, clock, { timeZone: 'America/New_York', advanceWhileEmpty: true })
  adoptDirect(h)
  clock.set(Date.UTC(2026, 2, 8, 10, 30, 0))
  await h.server.scheduler.runOnce()
  const before = h.server.store.getEvents('default', 0, 1_000_000)
    .filter(event => event.type === 'task.progress' && JSON.parse(event.payloadJson).dailyReset === true)
  assert.equal(before.length, 1)
  await h.server.stop()

  const restoredStore = openDatabase(h.dbPath)
  const restoredServer = new SyncServer(h.config, restoredStore, { now: () => clock.now() })
  clock.advance(60_000)
  await restoredServer.scheduler.runOnce()
  const after = restoredStore.getEvents('default', 0, 1_000_000)
    .filter(event => event.type === 'task.progress' && JSON.parse(event.payloadJson).dailyReset === true)
  assert.equal(after.length, 1)
  await restoredServer.stop()
})

test('scheduler batches are broadcast as projections to authenticated clients', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const before = canonical(h)
  clock.advance(2 * 60_000)
  await h.server.scheduler.runOnce()
  const after = canonical(h)
  assert.equal(after.pet.gameTimeMs - before.pet.gameTimeMs, 2 * 60_000)
  const projection = await owner.next('projection')
  assert.equal(projection.t, 'projection')
  if (projection.t !== 'projection') throw new Error('missing projection')
  assert.equal(projection.gameTimeMs, after.pet.gameTimeMs)
  assert.equal(projection.revision, after.pet.revision)
  assert.ok(projection.events.length > 0)
  assert.equal(projection.events.some(event => event.type === 'pet.statsChanged'), true)
  await owner.close()
})

test('disabled restart with zero clients freezes the anchor without backfill', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: false })
  adoptDirect(h)
  const start = canonical(h)
  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const frozen = canonical(h)
  assert.equal(frozen.pet.gameTimeMs, start.pet.gameTimeMs)
  assert.equal(frozen.pet.lastSchedulerWallMs, clock.now())
  await h.server.stop()

  clock.advance(10 * 60_000)
  const restoredStore = openDatabase(h.dbPath)
  const restoredServer = new SyncServer(h.config, restoredStore, { now: () => clock.now() })
  await restoredServer.scheduler.runOnce()
  const restored = restoredStore.loadCanonical('default')
  assert.equal(restored.pet.gameTimeMs, start.pet.gameTimeMs)
  assert.equal(restored.pet.lastSchedulerWallMs, clock.now())
  await restoredServer.stop()
})

test('portable import cancels non-rebindable sessions with an ordered status event', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const beforeEvents = h.server.store.getEvents('default', 0, 1_000_000).length
  const gameTime = canonical(h).pet.gameTimeMs
  const bundle = buildLocalBundle(h, {
    mutateEngine: engine => {
      engine.gameSessions.push({
        sessionToken: 'foreign-session-token',
        actorDeviceId: 'foreign-device',
        payload: { kind: 'game', gameId: 'foreign', gameKind: 'small', presentationSeed: 'seed' },
        startedAtGameMs: gameTime,
        expiresAtGameMs: gameTime + 60 * 60_000,
        status: 'active',
      })
    },
  })
  const result = await sendCommand(owner, 'import-cancel-session', {
    type: 'admin.importPortableBundle',
    payload: { bundle, rebindLocalSessions: false },
  })
  assert.equal(result.status, 'applied')
  const session = canonical(h).engine.gameSessions.find(candidate => candidate.sessionToken === 'foreign-session-token')
  assert.ok(session)
  if (session === undefined) throw new Error('missing imported session')
  assert.equal(session.status, 'abandoned')
  assert.equal(session.cancelReason, 'actor_rebind_failed')
  const events = h.server.store.getEvents('default', 0, 1_000_000).slice(beforeEvents)
  const cancellations = events.filter(event => event.type === 'game.sessionSettled')
  assert.equal(cancellations.length, 1)
  assert.equal(JSON.parse(cancellations[0].payloadJson).status, 'abandoned')
  assert.equal(JSON.parse(cancellations[0].payloadJson).cancelReason, 'actor_rebind_failed')
  await owner.close()
})

test('an interrupted bounded catch-up resumes from the last committed chunk without duplicate ticks', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: true, catchupChunkTicks: 1 })
  adoptDirect(h)
  const start = canonical(h)
  const checkpoint = join(h.directory, 'pre-crash.sqlite')
  await h.server.store.backup(checkpoint)
  clock.advance(20 * 60_000)

  const pass = h.server.scheduler.runOnce()
  await waitFor(() => (h.server.metrics.snapshot()['scheduler.catchup_chunks'] ?? 0) >= 2)
  await h.server.scheduler.stop()
  await pass
  const partial = canonical(h)
  assert.ok(partial.pet.gameTimeMs > start.pet.gameTimeMs)
  assert.ok(partial.pet.gameTimeMs < start.pet.gameTimeMs + 20 * 60_000)
  assert.equal(partial.pet.revision, start.pet.revision + (partial.pet.gameTimeMs - start.pet.gameTimeMs) / 60_000)
  await h.server.stop()

  const restoredStore = openDatabase(checkpoint)
  const restoredServer = new SyncServer(h.config, restoredStore, { now: () => clock.now() })
  await restoredServer.scheduler.runOnce()
  const recovered = restoredStore.loadCanonical('default')
  assert.equal(recovered.pet.gameTimeMs, start.pet.gameTimeMs + 20 * 60_000)
  assert.equal(recovered.pet.revision, start.pet.revision + 20)
  await restoredServer.stop()
})

test('setAdvanceWhileEmpty toggles future empty-period semantics without retroactive backfill', async t => {
  const clock = makeClock(Date.now())
  const h = await createHarness(t, clock, { advanceWhileEmpty: false })
  adoptDirect(h)
  const owner = await pairOwner(h)
  const start = canonical(h)

  clock.advance(2 * 60_000)
  await h.server.scheduler.runOnce()
  const active = canonical(h)
  assert.equal(active.pet.gameTimeMs - start.pet.gameTimeMs, 2 * 60_000)
  assert.equal(active.engine.save.petInfo.onLineTime - start.engine.save.petInfo.onLineTime, 2)

  await owner.close()
  await waitFor(() => h.server.scheduler.health('default')?.activeClientCount === 0)
  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const frozen = canonical(h)
  assert.equal(frozen.pet.gameTimeMs, active.pet.gameTimeMs)

  const reconnect = await connect(h, { kind: 'token', token: owner.token })
  clock.advance(2 * 60_000)
  await h.server.scheduler.runOnce()
  const resumed = canonical(h)
  assert.equal(resumed.pet.gameTimeMs - frozen.pet.gameTimeMs, 2 * 60_000)

  const enabled = await sendCommand(reconnect, 'toggle-empty-on', { type: 'server.setAdvanceWhileEmpty', payload: { enabled: true } })
  assert.equal(enabled.status, 'applied')
  clock.advance(3 * 60_000)
  await h.server.scheduler.runOnce()
  const enabledActive = canonical(h)
  assert.equal(enabledActive.pet.gameTimeMs - resumed.pet.gameTimeMs, 3 * 60_000)
  assert.equal(enabledActive.engine.save.petInfo.onLineTime - resumed.engine.save.petInfo.onLineTime, 3)

  await reconnect.close()
  await waitFor(() => h.server.scheduler.health('default')?.activeClientCount === 0)
  const beforeEmpty = canonical(h)
  clock.advance(10 * 60_000)
  await h.server.scheduler.runOnce()
  const afterEmpty = canonical(h)
  assert.equal(afterEmpty.pet.gameTimeMs - beforeEmpty.pet.gameTimeMs, 10 * 60_000)
  assert.equal(afterEmpty.engine.save.petInfo.onLineTime, beforeEmpty.engine.save.petInfo.onLineTime)

  const reconnectAgain = await connect(h, { kind: 'token', token: owner.token })
  clock.advance(60_000)
  await h.server.scheduler.runOnce()
  const liveAgain = canonical(h)
  assert.equal(liveAgain.pet.gameTimeMs - afterEmpty.pet.gameTimeMs, 60_000)
  await sendCommand(reconnectAgain, 'toggle-empty-off', { type: 'server.setAdvanceWhileEmpty', payload: { enabled: false } })
  await reconnectAgain.close()
  await waitFor(() => h.server.scheduler.health('default')?.activeClientCount === 0)
  const beforeFreezeAgain = canonical(h)
  clock.advance(5 * 60_000)
  await h.server.scheduler.runOnce()
  const frozenAgain = canonical(h)
  assert.equal(frozenAgain.pet.gameTimeMs, beforeFreezeAgain.pet.gameTimeMs)
  assert.equal(frozenAgain.pet.lastSchedulerWallMs, clock.now())
})
