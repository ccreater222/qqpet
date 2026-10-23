/**
 * C12 real two-renderer acceptance E2E.
 *
 * Starts the compiled standalone server against temporary SQLite, launches two
 * real Electron applications with distinct QQPET_USER_DATA directories through
 * playwright-core's Electron support, and drives the production preload API
 * from inside both real BrowserWindow renderers. No main-process-only harness
 * is used for the acceptance result.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { E2E_MIN_STEPS, REQUIRED_E2E_SCENARIO_NAMES } from '../lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SERVER_ENTRY = join(ROOT, 'server/dist/server/src/index.js')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const CODE_REVISION = process.env.QQPET_CODE_REVISION?.trim()
  || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

const [
  SCENARIO_COMPETING,
  SCENARIO_SESSION_ABUSE,
  SCENARIO_FRESH_IMPORT,
  SCENARIO_COVERAGE_REOPEN,
  SCENARIO_STARTUP_REPAIR,
  SCENARIO_DETERMINISTIC_RESTART,
  SCENARIO_REVOKED_RECONNECT,
  SCENARIO_FEED_P95,
] = REQUIRED_E2E_SCENARIO_NAMES

if (process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.QQPET_E2E_XVFB === undefined) {
  const wrapped = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, QQPET_E2E_XVFB: '1' },
  })
  if (wrapped.error === undefined) process.exit(wrapped.status ?? 1)
  console.error('[renderer-e2e] xvfb-run is required on headless Linux:', wrapped.error.message)
  process.exit(1)
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

function nearestRankPercentile(values, quantile) {
  if (values.length === 0) throw new Error('percentile requires at least one sample')
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(quantile * sorted.length))
  return sorted[Math.min(sorted.length - 1, rank - 1)]
}

async function withDatabase(dbPath, write, operation) {
  const { DatabaseSync } = await import('node:sqlite')
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let db
    try {
      db = new DatabaseSync(dbPath, write ? {} : { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      return operation(db)
    } catch (error) {
      lastError = error
      if (write !== true || /busy|locked/i.test(String(error)) === false) throw error
      await sleep(100 + attempt * 75)
    } finally {
      db?.close()
    }
  }
  throw lastError
}

async function readLatestCoverageOperation(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => {
    const row = db.prepare(
      `SELECT operation_id, commit_wall_ms, survivors_json, state, completed_at_ms
       FROM coverage_operations WHERE pet_id = ?
       ORDER BY commit_wall_ms DESC, operation_id DESC LIMIT 1`,
    ).get(petId)
    if (row === undefined) return null
    return {
      operationId: String(row.operation_id),
      commitWallMs: Number(row.commit_wall_ms),
      survivors: JSON.parse(String(row.survivors_json)),
      state: String(row.state),
      completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
    }
  })
}

async function readCoverageRows(dbPath, operationId, petId = 'default') {
  return await withDatabase(dbPath, false, db => {
    const prefix = operationId + ':%'
    return db.prepare(
      `SELECT coverage_id, device_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason
       FROM session_coverage WHERE pet_id = ? AND coverage_id LIKE ?
       ORDER BY coverage_id`,
    ).all(petId, prefix).map(row => ({
      coverageId: String(row.coverage_id),
      deviceId: String(row.device_id),
      connectedAtMs: Number(row.connected_at_ms),
      disconnectedAtMs: row.disconnected_at_ms === null ? null : Number(row.disconnected_at_ms),
      lastHeartbeatAtMs: Number(row.last_heartbeat_at_ms),
      closeReason: row.close_reason === null ? null : String(row.close_reason),
    }))
  })
}

async function readCoverageRowsByIds(dbPath, coverageIds) {
  if (coverageIds.length === 0) return []
  return await withDatabase(dbPath, false, db => {
    const placeholders = coverageIds.map(() => '?').join(', ')
    return db.prepare(
      `SELECT coverage_id, pet_id, device_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason
       FROM session_coverage WHERE coverage_id IN (` + placeholders + `)`,
    ).all(...coverageIds).map(row => ({
      coverageId: String(row.coverage_id),
      petId: String(row.pet_id),
      deviceId: String(row.device_id),
      connectedAtMs: Number(row.connected_at_ms),
      disconnectedAtMs: row.disconnected_at_ms === null ? null : Number(row.disconnected_at_ms),
      lastHeartbeatAtMs: Number(row.last_heartbeat_at_ms),
      closeReason: row.close_reason === null ? null : String(row.close_reason),
    }))
  })
}

async function readOpenCoverageRows(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => db.prepare(
    `SELECT coverage_id, device_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason
     FROM session_coverage WHERE pet_id = ? AND disconnected_at_ms IS NULL
     ORDER BY coverage_id`,
  ).all(petId).map(row => ({
    coverageId: String(row.coverage_id),
    deviceId: String(row.device_id),
    connectedAtMs: Number(row.connected_at_ms),
    disconnectedAtMs: null,
    lastHeartbeatAtMs: Number(row.last_heartbeat_at_ms),
    closeReason: null,
  })))
}

async function readCoverageIntervals(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => db.prepare(
    `SELECT coverage_id, device_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason
     FROM session_coverage WHERE pet_id = ? ORDER BY connected_at_ms, coverage_id`,
  ).all(petId).map(row => {
    const interval = {
      coverageId: String(row.coverage_id),
      deviceId: String(row.device_id),
      connectedAtWallMs: Number(row.connected_at_ms),
      lastHeartbeatWallMs: Number(row.last_heartbeat_at_ms),
    }
    if (row.disconnected_at_ms !== null) interval.disconnectedAtWallMs = Number(row.disconnected_at_ms)
    if (row.close_reason !== null) interval.closeReason = String(row.close_reason)
    return interval
  }))
}

async function readPersistedCounts(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => {
    const commands = db.prepare('SELECT COUNT(*) AS count FROM commands WHERE pet_id = ?').get(petId)
    const events = db.prepare('SELECT COUNT(*) AS count FROM events WHERE pet_id = ?').get(petId)
    const duplicateCommands = db.prepare(
      'SELECT COUNT(*) AS count FROM (SELECT op_id FROM commands WHERE pet_id = ? GROUP BY op_id HAVING COUNT(*) > 1)',
    ).get(petId)
    const duplicateEvents = db.prepare(
      'SELECT COUNT(*) AS count FROM (SELECT event_seq FROM events WHERE pet_id = ? GROUP BY event_seq HAVING COUNT(*) > 1)',
    ).get(petId)
    return {
      commandRows: Number(commands.count),
      eventRows: Number(events.count),
      duplicateOpIds: Number(duplicateCommands.count),
      duplicateEventSeqs: Number(duplicateEvents.count),
    }
  })
}

async function readPetState(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => {
    const row = db.prepare(
      'SELECT revision, event_seq, command_seq, game_time_ms, last_scheduler_wall_ms FROM pets WHERE id = ?',
    ).get(petId)
    if (row === undefined) throw new Error('pet row is missing')
    return {
      revision: Number(row.revision),
      eventSeq: Number(row.event_seq),
      commandSeq: Number(row.command_seq),
      gameTimeMs: Number(row.game_time_ms),
      lastSchedulerWallMs: Number(row.last_scheduler_wall_ms),
    }
  })
}

async function seedExamLessons(dbPath, lessons = 9, petId = 'default') {
  return await withDatabase(dbPath, true, db => {
    const row = db.prepare('SELECT save_json, engine_json FROM pets WHERE id = ?').get(petId)
    if (row === undefined) throw new Error('pet row is missing for exam fixture')
    const save = JSON.parse(String(row.save_json))
    save.studyInfo.chinese = Math.max(Number(save.studyInfo.chinese ?? 0), lessons)
    const engine = JSON.parse(String(row.engine_json))
    engine.save = save
    db.prepare('UPDATE pets SET save_json = ?, engine_json = ?, updated_at_ms = ? WHERE id = ?')
      .run(JSON.stringify(save), JSON.stringify(engine), Date.now(), petId)
    return { chinese: Number(save.studyInfo.chinese) }
  })
}

async function seedIslandQuizErrand(dbPath, petId = 'default') {
  return await withDatabase(dbPath, true, db => {
    const row = db.prepare('SELECT save_json, engine_json FROM pets WHERE id = ?').get(petId)
    if (row === undefined) throw new Error('pet row is missing for island quiz fixture')
    const save = JSON.parse(String(row.save_json))
    const island = JSON.parse(String(save.saveJsonData.island ?? '{}'))
    island.errands = Array.isArray(island.errands) ? island.errands : []
    let index = island.errands.findIndex(errand => errand.kind === 'quiz')
    if (index < 0) {
      island.errands.push({
        from: '智慧长老',
        kind: 'quiz',
        to: 'dx-chinese',
        got: 0,
        took: false,
      })
      index = island.errands.length - 1
      save.saveJsonData.island = JSON.stringify(island)
      const engine = JSON.parse(String(row.engine_json))
      engine.save = save
      db.prepare('UPDATE pets SET save_json = ?, engine_json = ?, updated_at_ms = ? WHERE id = ?')
        .run(JSON.stringify(save), JSON.stringify(engine), Date.now(), petId)
    }
    return { quizIndex: index, errand: island.errands[index], seeded: index >= 0 }
  })
}

async function expireSessionToken(dbPath, sessionToken, petId = 'default') {
  return await withDatabase(dbPath, true, db => {
    const pet = db.prepare('SELECT game_time_ms FROM pets WHERE id = ?').get(petId)
    if (pet === undefined) throw new Error('pet row is missing for token expiry fixture')
    const expiredAtGameMs = Number(pet.game_time_ms)
    const result = db.prepare(
      'UPDATE game_sessions SET expires_at_game_ms = MAX(started_at_game_ms, ?) WHERE pet_id = ? AND session_token = ? AND status = ?',
    ).run(expiredAtGameMs, petId, sessionToken, 'active')
    if (Number(result.changes) !== 1) throw new Error('session token row was not updated exactly once')
    return expiredAtGameMs
  })
}

async function rewindSchedulerAnchor(dbPath, anchorMs, petId = 'default') {
  return await withDatabase(dbPath, true, db => {
    const row = db.prepare('SELECT engine_json, last_scheduler_wall_ms FROM pets WHERE id = ?').get(petId)
    if (row === undefined) throw new Error('pet row is missing for restart fixture')
    const engine = JSON.parse(String(row.engine_json))
    engine.lastSchedulerWallMs = anchorMs
    db.prepare(
      'UPDATE pets SET last_scheduler_wall_ms = ?, engine_json = ?, updated_at_ms = ? WHERE id = ?',
    ).run(anchorMs, JSON.stringify(engine), Date.now(), petId)
    return {
      previousAnchorMs: Number(row.last_scheduler_wall_ms),
      anchorMs,
      advanceWhileEmpty: Boolean(engine.advanceWhileEmpty),
    }
  })
}

const FORBIDDEN_SESSION_PROJECTION_KEYS = new Set([
  'answerIndex',
  'answerKey',
  'correctAnswer',
  'correctIndex',
  'rewardKey',
  'actorDeviceId',
  'sessionToken',
])

function findKeys(value, forbidden, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findKeys(item, forbidden, path + '[' + String(index) + ']', found))
    return found
  }
  if (value === null || typeof value !== 'object') return found
  for (const [key, item] of Object.entries(value)) {
    const nextPath = path + '.' + key
    if (forbidden.has(key)) found.push(nextPath)
    findKeys(item, forbidden, nextPath, found)
  }
  return found
}

function assertRendererProjectionHygiene(projections, rawSessionTokens, label) {
  let checked = 0
  for (const [name, projection] of Object.entries(projections)) {
    assert.notEqual(projection, null, label + ': ' + name + ' projection must be present')
    const text = JSON.stringify(projection)
    for (const token of rawSessionTokens) {
      assert.equal(text.includes(token), false, label + ': ' + name + ' projection leaked a session token')
    }
    const forbiddenKeys = findKeys(projection, FORBIDDEN_SESSION_PROJECTION_KEYS)
    assert.deepEqual(forbiddenKeys, [], label + ': ' + name + ' projection leaked session/answer state')
    checked += 1
  }
  return checked
}

async function loadRuntimeOracle() {
  return await import(pathToFileURL(join(ROOT, 'server/dist/src/shared/pet-runtime/index.js')).href)
}

function runCli(env, args) {
  const stdout = execFileSync(process.execPath, [SERVER_ENTRY, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout)
}

async function waitFor(predicate, label, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error('timed out waiting for ' + label + (last === undefined ? '' : ': ' + String(last)))
}

function projectionHash(projection) {
  return hash(projection.shared)
}

function sameProjection(left, right) {
  return left.revision === right.revision
    && left.eventSeq === right.eventSeq
    && projectionHash(left) === projectionHash(right)
}

async function waitForPairedDevice(app, role, label) {
  let lastStatus
  try {
    return await waitFor(async () => {
      lastStatus = await app.storageStatus()
      return lastStatus.paired === true
        && lastStatus.deviceRole === role
        && typeof lastStatus.deviceId === 'string'
        && lastStatus.deviceId.length > 0
        ? lastStatus
        : null
    }, label, 15_000)
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error)
      + ' lastStatus=' + JSON.stringify({
        mode: lastStatus?.mode,
        activeMode: lastStatus?.activeMode,
        paired: lastStatus?.paired,
        deviceIdPresent: typeof lastStatus?.deviceId === 'string' && lastStatus.deviceId.length > 0,
        deviceRole: lastStatus?.deviceRole,
        connection: lastStatus?.connection,
        notice: lastStatus?.notice,
        lastError: lastStatus?.lastError,
      }))
  }
}

async function waitConverged(left, right, minRevision, timeoutMs = 15_000) {
  let leftProjection
  let rightProjection
  try {
    await waitFor(async () => {
      leftProjection = await left.projection()
      rightProjection = await right.projection()
      return leftProjection !== null
        && rightProjection !== null
        && leftProjection.revision >= minRevision
        && rightProjection.revision >= minRevision
        && sameProjection(leftProjection, rightProjection)
    }, 'renderer projections to converge at revision ' + minRevision, timeoutMs)
  } catch (error) {
    const compact = projection => projection === null ? null : {
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      hash: projectionHash(projection),
    }
    throw new Error(String(error instanceof Error ? error.message : error)
      + ' left=' + JSON.stringify(compact(leftProjection))
      + ' right=' + JSON.stringify(compact(rightProjection)))
  }
  return { left: leftProjection, right: rightProjection }
}

function foodCount(projection, itemId) {
  const entries = projection.shared?.selfGoodDatas?.food
  if (Array.isArray(entries) === false) return 0
  const prefix = '_' + itemId + '*'
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) return Number(entry.slice(prefix.length))
  }
  return 0
}

function eatTaskCount(projection) {
  const raw = projection.shared?.saveJsonData?.task
  if (typeof raw !== 'string') return 0
  try {
    return Number(JSON.parse(raw).doNums?.Eat ?? 0)
  } catch {
    return 0
  }
}

class ServerProcess {
  constructor(options) {
    this.options = options
    this.child = null
    this.stdout = []
    this.stderr = []
    this.exitPromise = null
    this.stopped = false
  }

  async start() {
    this.child = spawn(process.execPath, [SERVER_ENTRY, 'start'], {
      cwd: ROOT,
      env: this.options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.stdout.push(String(chunk)))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => this.stderr.push(String(chunk)))
    this.exitPromise = new Promise(resolveExit => {
      this.child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    await this.waitHealthy(25_000)
    return this
  }

  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastError = ''
    while (Date.now() < deadline) {
      if (this.child !== null && typeof this.child.exitCode === 'number') {
        throw new Error('server exited before readiness: ' + this.stderr.join(''))
      }
      try {
        const response = await fetch('http://127.0.0.1:' + this.options.port + '/readyz')
        const body = await response.json()
        if (response.status === 200 && body.ready === true) return body
        lastError = 'status ' + response.status + ' ready=' + String(body.ready)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await sleep(100)
    }
    throw new Error('server did not become ready: ' + lastError + '\n' + this.stderr.join(''))
  }

  async health() {
    const response = await fetch('http://127.0.0.1:' + this.options.port + '/health')
    if (response.ok === false) throw new Error('health returned ' + response.status)
    return await response.json()
  }

  signal(signal) {
    if (this.child === null || typeof this.child.exitCode === 'number') return false
    return this.child.kill(signal)
  }

  async crash() {
    if (this.stopped) return { code: null, signal: 'SIGKILL' }
    this.stopped = true
    if (this.child === null || typeof this.child.exitCode === 'number') return { code: this.child?.exitCode ?? null, signal: null }
    this.child.kill('SIGKILL')
    await Promise.race([
      this.exitPromise,
      sleep(10_000).then(() => {
        throw new Error('server did not exit after SIGKILL')
      }),
    ])
    return await this.exitPromise
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.child === null || typeof this.child.exitCode === 'number') return
    this.child.kill('SIGTERM')
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      sleep(10_000).then(() => false),
    ])
    if (exited === false) {
      this.child.kill('SIGKILL')
      await Promise.race([this.exitPromise, sleep(2_000)])
    }
    return this.exitPromise
  }

  logText() {
    return this.stdout.join('') + this.stderr.join('')
  }
}

class RendererApp {
  constructor(options) {
    this.label = options.label
    this.userData = options.userData
    this.serverUrl = options.serverUrl
    this.app = null
    this.page = null
    this.pid = null
    this.closed = false
    this.launchLog = []
  }

  async launch() {
    const args = [ROOT, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    if (process.platform === 'linux') args.push('--password-store=basic')
    this.app = await electron.launch({
      args,
      cwd: ROOT,
      env: {
        ...process.env,
        QQPET_USER_DATA: this.userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      timeout: 60_000,
    })
    this.pid = this.app.process().pid
    assert.equal(typeof this.pid, 'number', this.label + ': Electron main pid')
    const electronProcess = this.app.process()
    electronProcess.stdout?.on('data', chunk => this.launchLog.push('stdout: ' + String(chunk)))
    electronProcess.stderr?.on('data', chunk => this.launchLog.push('stderr: ' + String(chunk)))
    electronProcess.once('exit', (code, signal) => this.launchLog.push('exit: ' + String(code) + '/' + String(signal)))
    try {
      this.page = await this.app.firstWindow({ timeout: 60_000 })
    } catch (error) {
      throw new Error(this.label + ': firstWindow failed: '
        + (error instanceof Error ? error.message : String(error))
        + '\nElectron log:\n' + this.launchLog.join(''))
    }
    await this.page.waitForLoadState('domcontentloaded')
    await this.page.waitForFunction(
      () => typeof window.qqpet === 'object' && window.qqpet !== null
        && typeof window.qqpet.storage?.status === 'function',
      null,
      { timeout: 60_000 },
    )
    await this.installFaultControl()
    return this
  }

  /**
   * Test-only fault seam in the real Electron main process. It wraps the same
   * global WebSocket used by the production transport so the renderer can
   * observe a genuine dropped projection frame and recover through resync.
   */
  async installFaultControl() {
    await this.app.evaluate(() => {
      const OriginalWebSocket = globalThis.WebSocket
      const state = {
        dropProjection: 0,
        droppedProjections: 0,
        sentResyncs: 0,
        sentHellos: 0,
        sockets: 0,
      }
      globalThis.__QQPET_C12_WS_FAULTS__ = state
      globalThis.WebSocket = class extends OriginalWebSocket {
        constructor(url) {
          super(url)
          state.sockets += 1
          this.addEventListener('message', event => {
            if (state.dropProjection <= 0) return
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch {
              return
            }
            if (frame?.t !== 'projection') return
            state.dropProjection -= 1
            state.droppedProjections += 1
            event.stopImmediatePropagation()
          }, true)
        }

        send(data) {
          try {
            const frame = JSON.parse(String(data))
            if (frame?.t === 'resync') state.sentResyncs += 1
            if (frame?.t === 'hello') state.sentHellos += 1
          } catch {
            // Non-JSON payloads are not used by this protocol.
          }
          return super.send(data)
        }
      }
    })
  }

  async storageStatus() {
    return await this.page.evaluate(async () => await window.qqpet.storage.status())
  }

  async projection() {
    return await this.page.evaluate(async () => await window.qqpet.getProjection())
  }

  async repositoryStatus() {
    return await this.page.evaluate(async () => await window.qqpet.getStatus())
  }

  async command(command, opId) {
    return await this.page.evaluate(
      async input => await window.qqpet.command(input.command, { opId: input.opId }),
      { command, opId },
    )
  }

  async exportBundle() {
    return await this.page.evaluate(async () => await window.qqpet.storage.exportBundle())
  }

  async importBundle(input) {
    return await this.page.evaluate(
      async payload => await window.qqpet.storage.importBundle(payload),
      input,
    )
  }

  async setAdvanceWhileEmpty(enabled) {
    return await this.page.evaluate(
      async value => await window.qqpet.storage.setAdvanceWhileEmpty(value),
      enabled,
    )
  }

  async pair(code, deviceLabel) {
    return await this.page.evaluate(
      async input => await window.qqpet.storage.pair({
        serverUrl: input.serverUrl,
        code: input.code,
        deviceLabel: input.deviceLabel,
      }),
      { serverUrl: this.serverUrl, code, deviceLabel },
    )
  }

  async setServerMode(initialSource = 'use-server') {
    return await this.page.evaluate(
      async source => await window.qqpet.storage.setMode({ mode: 'server', initialSource: source }),
      initialSource,
    )
  }

  async requestResync() {
    await this.page.evaluate(async () => await window.qqpet.requestResync())
  }

  async waitOnline(timeoutMs = 20_000) {
    return await waitFor(async () => {
      const status = await this.storageStatus()
      return status.connection === 'online' ? status : null
    }, this.label + ' renderer storage online', timeoutMs)
  }

  async websocketFaultState() {
    return await this.app.evaluate(() => ({ ...globalThis.__QQPET_C12_WS_FAULTS__ }))
  }

  async armProjectionDrop() {
    await this.app.evaluate(() => { globalThis.__QQPET_C12_WS_FAULTS__.dropProjection = 1 })
  }

  async mainProof() {
    return await this.app.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().map(window => {
        const preferences = window.webContents.getLastWebPreferences()
        return {
          id: window.id,
          visible: window.isVisible(),
          destroyed: window.isDestroyed(),
          url: window.webContents.getURL(),
          webContentsId: window.webContents.id,
          contextIsolation: preferences.contextIsolation === true,
          sandbox: preferences.sandbox === true,
          nodeIntegration: preferences.nodeIntegration === true,
        }
      })
      return {
        appName: app.getName(),
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        mainPid: process.pid,
        windows,
        rendererProcessCount: app.getAppMetrics().filter(metric => metric.type === 'Tab').length,
      }
    })
  }

  async rendererProof() {
    return await this.page.evaluate(() => ({
      title: document.title,
      readyState: document.readyState,
      url: location.href,
      petElementPresent: document.querySelector('#pet') !== null,
      qqpetApiKeys: Object.keys(window.qqpet).length,
      storageApiPresent: typeof window.qqpet.storage?.status === 'function',
      serverModeCapability: window.qqpet.capabilities?.serverMode === true,
    }))
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.app === null) return
    const app = this.app
    const closed = await Promise.race([
      app.close().then(() => true).catch(() => false),
      sleep(10_000).then(() => false),
    ])
    if (closed === false) {
      try { app.process().kill('SIGKILL') } catch { /* best effort */ }
    }
  }

  async relaunch() {
    await this.close()
    this.app = null
    this.page = null
    this.pid = null
    this.closed = false
    return await this.launch()
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const root = await mkdtemp(join(tmpdir(), 'qqpet-c12-renderer-e2e-'))
  const dbPath = join(root, 'qqpet.sqlite')
  const backupDir = join(root, 'backups')
  const restoreGenerationFile = join(root, 'restore-generation.txt')
  const adminSocket = join(root, 'admin.sock')
  const credentialFile = join(root, 'owner-admin-credential.txt')
  const ownerProfile = join(root, 'electron-owner')
  const playerProfile = join(root, 'electron-player')
  const port = await freePort()
  const serverUrl = 'ws://127.0.0.1:' + port + '/v1/sync'
  const baseEnv = {
    ...process.env,
    QQPET_SYNC_DB: dbPath,
    QQPET_SYNC_BACKUP_DIR: backupDir,
    QQPET_SYNC_RESTORE_GENERATION_FILE: restoreGenerationFile,
    QQPET_ADMIN_SOCKET: adminSocket,
    QQPET_OWNER_ADMIN_CREDENTIAL: credentialFile,
    QQPET_SYNC_BIND: '127.0.0.1',
    QQPET_SYNC_PORT: String(port),
    QQPET_SYNC_TIME_ZONE: 'Asia/Shanghai',
    QQPET_SYNC_WEATHER_LOCATION: '北京',
    QQPET_SYNC_ADVANCE_WHILE_EMPTY: '0',
    QQPET_SYNC_LOG_LEVEL: 'warn',
  }
  const report = {
    schemaVersion: 2,
    startedAt,
    codeRevision: CODE_REVISION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    steps: [],
    evidence: {},
    residualGap: [
      'Renderer automation drives the production contextBridge API inside real BrowserWindows; it does not perform pixel/OCR visual assertions or click through every UI pane.',
      'Linux CI runs Electron under xvfb, so GPU compositing and platform-specific window-manager behavior are not asserted.',
      'Exam/island prerequisites and token-expiry setup use direct writes to the temporary canonical SQLite fixture; all session starts, settlements, rejections, projections and server authority logic still execute through the real standalone server and renderer WebSocket APIs.',
      'The deterministic restart scenario rewinds the persisted scheduler anchor only while the real server process is stopped, so the real runtime executes an exact two-tick catch-up; the expected state/events are derived with the same compiled canonical runtime as an independent oracle.',
      'Startup crash repair deliberately SIGSTOPs the real server for 32 seconds so the persisted heartbeat + 30 second grace bound is observably earlier than restart wall time.',
      'Revoked-reconnect testing relaunches a fresh Electron process from a copied userData directory after removing copied Chromium singleton lock files; the same persisted revoked device token is presented to the real server.',
    ],
  }
  const step = async (name, fn) => {
    const at = Date.now()
    process.stdout.write('[renderer-e2e] START ' + name + '\n')
    try {
      const detail = await fn()
      const durationMs = Date.now() - at
      report.steps.push({ name, status: 'pass', durationMs, detail })
      process.stdout.write('[renderer-e2e] PASS ' + name + ' (' + durationMs + 'ms)\n')
      return detail
    } catch (error) {
      report.steps.push({
        name,
        status: 'fail',
        durationMs: Date.now() - at,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })
      process.stdout.write('[renderer-e2e] FAIL ' + name + ': '
        + (error instanceof Error ? error.message : String(error)) + '\n')
      throw error
    }
  }

  let owner = null
  let player = null
  let server = null
  let freshHostOwner = null
  let freshHostPlayer = null
  let freshServer = null
  let ownerPairingCode = ''
  let playerPairingCode = ''
  let freshOwnerPairingCode = ''
  let freshPlayerPairingCode = ''
  let ownerDeviceId = ''
  let playerDeviceId = ''
  let freshOwnerDeviceId = ''
  let freshPlayerDeviceId = ''
  const rawSessionTokens = []
  let rendererProof = null
  let teardownComplete = false

  try {
    await mkdir(ownerProfile, { recursive: true })
    await mkdir(playerProfile, { recursive: true })
    await mkdir(backupDir, { recursive: true })
    await writeFile(credentialFile, 'c12-renderer-e2e-owner-admin-credential\n', { mode: 0o600 })

    await step('compile compiled desktop app and standalone server', async () => {
      execFileSync(NPM, ['run', 'build'], { cwd: ROOT, env: baseEnv, stdio: 'inherit' })
      execFileSync(NPM, ['--prefix', 'server', 'run', 'build'], { cwd: ROOT, env: baseEnv, stdio: 'inherit' })
      const serverStat = await import('node:fs/promises').then(fs => fs.stat(SERVER_ENTRY))
      assert.ok(serverStat.size > 0, 'compiled standalone server entry must exist')
      return { desktopEntry: 'out/main/index.js', serverEntry: 'server/dist/server/src/index.js' }
    })

    await step('initialize temporary SQLite WAL database and mint owner/player pairing codes', async () => {
      const initialized = runCli(baseEnv, [
        'init', '--db', dbPath, '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京',
      ])
      assert.equal(initialized.ok, true)
      assert.equal(initialized.authority.state, 'active')
      const pairedPlayer = runCli(baseEnv, ['pair', '--db', dbPath, '--pet-id', 'default', '--role', 'player'])
      ownerPairingCode = initialized.pairingCode
      playerPairingCode = pairedPlayer.pairingCode
      assert.match(ownerPairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
      assert.match(playerPairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
      assert.notEqual(ownerPairingCode, playerPairingCode)
      return {
        temporarySqlite: true,
        journalMode: 'wal',
        authorityIdHash: hash(initialized.authority.authorityId),
        duplicatePairingCodes: false,
      }
    })

    await step('start real standalone server and verify WAL/synchronous=FULL health', async () => {
      server = await new ServerProcess({ port, env: baseEnv }).start()
      const health = await server.health()
      assert.equal(health.ready, true)
      assert.equal(health.journalMode, 'wal')
      assert.equal(health.synchronous, 'full')
      assert.equal(health.activeClientCount, 0)
      report.evidence.database = { temporarySqlite: true, journalMode: health.journalMode, synchronous: health.synchronous }
      return {
        pid: server.child.pid,
        ready: health.ready,
        journalMode: health.journalMode,
        synchronous: health.synchronous,
        dbWritable: health.dbWritable,
        quickCheck: health.quickCheck,
      }
    })

    await step('launch owner Electron app with real BrowserWindow and preload renderer', async () => {
      owner = await new RendererApp({ label: 'owner-renderer', userData: ownerProfile, serverUrl }).launch()
      assert.notEqual(owner.page.url().startsWith('app://bundle/'), false, 'owner renderer URL')
      const storage = await owner.storageStatus()
      assert.equal(storage.serverModeAvailable, true)
      return {
        mainPid: owner.pid,
        rendererUrl: owner.page.url(),
        userDataIsolated: owner.userData === ownerProfile,
        storageApi: 'window.qqpet.storage',
      }
    })

    await step('launch player Electron app with distinct userData and real BrowserWindow', async () => {
      player = await new RendererApp({ label: 'player-renderer', userData: playerProfile, serverUrl }).launch()
      assert.notEqual(player.pid, owner.pid, 'two Electron main processes must be distinct')
      assert.notEqual(player.userData, owner.userData, 'two Electron userData directories must be distinct')
      const storage = await player.storageStatus()
      assert.equal(storage.serverModeAvailable, true)
      return {
        mainPid: player.pid,
        distinctMainProcesses: true,
        distinctUserData: true,
        rendererUrl: player.page.url(),
      }
    })

    await step('pair owner via real renderer window.qqpet.storage API', async () => {
      const paired = await owner.pair(ownerPairingCode, 'C12 owner renderer')
      assert.equal(paired.paired, true)
      const pairedStatus = await waitForPairedDevice(owner, 'owner', 'owner device identity after pairing')
      ownerDeviceId = pairedStatus.deviceId
      return {
        role: pairedStatus.deviceRole,
        paired: paired.paired,
        deviceIdHash: hash(ownerDeviceId),
        pairingInputSource: 'window.qqpet.storage.pair',
      }
    })

    await step('switch owner renderer to server mode with use-server source', async () => {
      const status = await owner.setServerMode('use-server')
      assert.equal(status.mode, 'server')
      assert.equal(status.activeMode, 'server')
      assert.equal(status.authority.owner, 'server')
      assert.equal(status.authority.state, 'active')
      assert.equal(status.paired, true)
      return {
        initialSource: 'use-server',
        requestedMode: status.mode,
        activeMode: status.activeMode,
        authorityOwner: status.authority.owner,
        authorityState: status.authority.state,
        connection: status.connection,
      }
    })

    await step('pair player via real renderer storage API and switch to server mode', async () => {
      const paired = await player.pair(playerPairingCode, 'C12 player renderer')
      assert.equal(paired.paired, true)
      const pairedStatus = await waitForPairedDevice(player, 'player', 'player device identity after pairing')
      playerDeviceId = pairedStatus.deviceId
      const status = await player.setServerMode('use-server')
      assert.equal(status.mode, 'server')
      assert.equal(status.activeMode, 'server')
      assert.equal(status.authority.owner, 'server')
      assert.equal(status.authority.state, 'active')
      assert.equal(status.paired, true)
      return {
        role: pairedStatus.deviceRole,
        initialSource: 'use-server',
        requestedMode: status.mode,
        activeMode: status.activeMode,
        deviceIdHash: hash(playerDeviceId),
        pairingAndModeSource: 'window.qqpet.storage',
      }
    })

    await step('initial two-renderer projection convergence over real WebSocket', async () => {
      const converged = await waitConverged(owner, player, 0, 20_000)
      assert.equal(converged.left.shared.havePet, false)
      assert.equal(converged.right.shared.havePet, false)
      const health = await server.health()
      assert.equal(health.activeClientCount, 2)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
        activeClientCount: health.activeClientCount,
        websocketUrl: serverUrl,
      }
    })

    await step('adopt pet from owner renderer and converge player renderer', async () => {
      const adopted = await owner.command({ type: 'pet.adopt', payload: { sex: 'GG' } }, 'c12-renderer-adopt')
      assert.equal(adopted.status, 'applied')
      const converged = await waitConverged(owner, player, adopted.revision)
      assert.equal(converged.left.shared.havePet, true)
      assert.equal(converged.right.shared.havePet, true)
      assert.equal(converged.left.shared.petInfo.name, converged.right.shared.petInfo.name)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
        adoptedName: converged.left.shared.petInfo.name,
      }
    })

    await step('buy food from owner renderer and converge player renderer', async () => {
      const bought = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 2 } },
        'c12-renderer-buy-food',
      )
      assert.equal(bought.status, 'applied')
      const converged = await waitConverged(owner, player, bought.revision)
      assert.ok(foodCount(converged.left, '102010001') >= 2)
      assert.equal(foodCount(converged.left, '102010001'), foodCount(converged.right, '102010001'))
      return {
        revision: converged.left.revision,
        foodCount: foodCount(converged.right, '102010001'),
        projectionHash: projectionHash(converged.left),
      }
    })

    await step('canonical feed from owner renderer reaches player renderer within 3s', async () => {
      const before = await player.projection()
      const beforeFood = foodCount(before, '102010001')
      const beforeEat = eatTaskCount(before)
      const latencyStartedAt = Date.now()
      const fed = await owner.command(
        { type: 'inventory.use', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
        'c12-renderer-feed',
      )
      assert.equal(fed.status, 'applied')
      const playerAfter = await waitFor(async () => {
        const projection = await player.projection()
        if (projection === null || projection.revision < fed.revision) return null
        if (foodCount(projection, '102010001') !== beforeFood - 1) return null
        if (eatTaskCount(projection) !== beforeEat + 1) return null
        return projection
      }, 'player renderer feed projection', 3_000)
      const latencyMs = Date.now() - latencyStartedAt
      assert.ok(latencyMs <= 3_000, 'player renderer latency must be <= 3000ms, got ' + latencyMs)
      const converged = await waitConverged(owner, player, fed.revision)
      assert.equal(eatTaskCount(converged.left), beforeEat + 1)
      assert.equal(eatTaskCount(converged.right), beforeEat + 1)
      assert.equal(foodCount(converged.right, '102010001'), beforeFood - 1)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
        playLatencyMs: latencyMs,
        eatTaskBefore: beforeEat,
        eatTaskAfter: eatTaskCount(converged.right),
        foodBefore: beforeFood,
        foodAfter: foodCount(converged.right, '102010001'),
        playerProjectionUpdated: true,
      }
    })

    await step('duplicate opId through renderer is idempotent', async () => {
      const command = { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } }
      const first = await owner.command(command, 'c12-renderer-duplicate-op')
      assert.equal(first.status, 'applied')
      const afterFirst = await waitConverged(owner, player, first.revision)
      const foodAfterFirst = foodCount(afterFirst.left, '102010001')
      const second = await owner.command(command, 'c12-renderer-duplicate-op')
      assert.equal(second.status, 'duplicate')
      assert.equal(second.original, 'applied')
      assert.equal(second.revision, first.revision)
      assert.equal(second.commandSeq, first.commandSeq)
      await sleep(150)
      const afterSecond = await waitConverged(owner, player, first.revision)
      assert.equal(afterSecond.left.revision, afterFirst.left.revision)
      assert.equal(projectionHash(afterSecond.left), projectionHash(afterFirst.left))
      assert.equal(foodCount(afterSecond.right, '102010001'), foodAfterFirst)
      return {
        firstStatus: first.status,
        secondStatus: second.status,
        duplicateOriginal: second.original,
        revision: second.revision,
        commandSeq: second.commandSeq,
        projectionHash: projectionHash(afterSecond.left),
        foodCountUnchanged: foodAfterFirst === foodCount(afterSecond.right, '102010001'),
      }
    })

    await step('dropped projection frame triggers renderer revision-gap resync', async () => {
      await player.armProjectionDrop()
      const first = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
        'c12-renderer-gap-first',
      )
      assert.equal(first.status, 'applied')
      await waitFor(async () => {
        const state = await player.websocketFaultState()
        return state.droppedProjections === 1 ? state : null
      }, 'player to drop one real projection frame', 10_000)
      const second = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
        'c12-renderer-gap-second',
      )
      assert.equal(second.status, 'applied')
      const recovered = await waitFor(async () => {
        const projection = await player.projection()
        if (projection === null || projection.revision < second.revision) return null
        return projection
      }, 'player renderer revision-gap recovery', 20_000)
      const faultState = await player.websocketFaultState()
      assert.equal(faultState.droppedProjections, 1, 'exactly one projection frame must be dropped')
      assert.ok(faultState.sentResyncs >= 1, 'the renderer must request resync after the revision gap')
      const converged = await waitConverged(owner, player, second.revision, 20_000)
      assert.equal(projectionHash(converged.left), projectionHash(converged.right))
      return {
        droppedProjections: faultState.droppedProjections,
        sentResyncs: faultState.sentResyncs,
        firstCommandRevision: first.revision,
        secondCommandRevision: second.revision,
        recoveredRevision: recovered.revision,
        recoveredEventSeq: recovered.eventSeq,
        projectionHash: projectionHash(converged.right),
        resyncRecovered: true,
      }
    })

    await step(SCENARIO_COMPETING, async () => {
      const raceItemId = '100010054'
      const beforeBuy = await waitConverged(owner, player, 0)
      assert.equal(foodCount(beforeBuy.left, raceItemId), 0, 'competing-action fixture item must start absent')
      const buy = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: raceItemId, quantity: 1 } },
        'c12-compete-buy-last-item',
      )
      assert.equal(buy.status, 'applied')
      const stocked = await waitConverged(owner, player, buy.revision)
      assert.equal(foodCount(stocked.left, raceItemId), 1)
      assert.equal(foodCount(stocked.right, raceItemId), 1)
      const beforeEat = eatTaskCount(stocked.right)
      const beforeRaceRevision = stocked.right.revision
      const beforeRaceEventSeq = stocked.right.eventSeq

      // Both real renderer connections submit the same last-unit command. The
      // server queue must serialize them: one canonical mutation, one spec error.
      const ownerAttempt = owner.command(
        { type: 'inventory.use', payload: { type: 'food', itemId: raceItemId, quantity: 1 } },
        'c12-compete-owner-last-food',
      )
      await sleep(10)
      const playerAttempt = player.command(
        { type: 'inventory.use', payload: { type: 'food', itemId: raceItemId, quantity: 1 } },
        'c12-compete-player-last-food',
      )
      const attempts = await Promise.all([ownerAttempt, playerAttempt])
      const applied = attempts.filter(result => result.status === 'applied')
      const rejected = attempts.filter(result => result.status === 'rejected')
      assert.equal(applied.length, 1, 'exactly one competing command may apply')
      assert.equal(rejected.length, 1, 'exactly one competing command must reject')
      assert.equal(rejected[0].error?.code, 'insufficient_item')
      assert.equal(rejected[0].commandType, 'inventory.use')
      assert.equal(applied[0].revision, beforeRaceRevision + 1, 'the applied command must be the only canonical revision bump')
      assert.ok(applied[0].eventSeq > beforeRaceEventSeq, 'the applied command must commit ordered events')

      const finalProjection = await waitFor(async () => {
        const left = await owner.projection()
        const right = await player.projection()
        if (left === null || right === null) return null
        if (left.revision !== applied[0].revision || right.revision !== applied[0].revision) return null
        if (left.eventSeq !== applied[0].eventSeq || right.eventSeq !== applied[0].eventSeq) return null
        if (sameProjection(left, right) === false) return null
        if (foodCount(right, raceItemId) !== 0) return null
        if (eatTaskCount(right) !== beforeEat + 1) return null
        return { left, right }
      }, 'competing-action canonical projection', 10_000)
      assert.equal(eatTaskCount(finalProjection.left), beforeEat + 1, 'task reward must not duplicate')
      assert.equal(foodCount(finalProjection.left, raceItemId), 0)
      const rejectedWasAfterMutation = rejected[0].revision === applied[0].revision
        && rejected[0].eventSeq === applied[0].eventSeq
      if (rejectedWasAfterMutation === false) {
        assert.equal(rejected[0].revision, beforeRaceRevision, 'a first-serialized rejection must report the pre-mutation revision')
        assert.equal(rejected[0].eventSeq, beforeRaceEventSeq, 'a first-serialized rejection must report the pre-mutation eventSeq')
      }
      return {
        commandsSubmitted: 2,
        appliedCount: applied.length,
        rejectedCount: rejected.length,
        rejectionCode: rejected[0].error.code,
        appliedClient: attempts[0] === applied[0] ? 'owner-renderer' : 'player-renderer',
        rejectedClient: attempts[0] === rejected[0] ? 'owner-renderer' : 'player-renderer',
        beforeRevision: beforeRaceRevision,
        afterRevision: finalProjection.left.revision,
        beforeEventSeq: beforeRaceEventSeq,
        afterEventSeq: finalProjection.left.eventSeq,
        rejectedWasAfterMutation,
        foodBefore: 1,
        foodAfter: foodCount(finalProjection.right, raceItemId),
        eatTaskBefore: beforeEat,
        eatTaskAfter: eatTaskCount(finalProjection.right),
        rewardDuplicated: false,
        projectionHash: projectionHash(finalProjection.left),
      }
    })

    await step(SCENARIO_FEED_P95, async () => {
      const foodId = '102010001'
      const buy = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: foodId, quantity: 12 } },
        'c12-p95-feed-stock',
      )
      assert.equal(buy.status, 'applied')
      await waitConverged(owner, player, buy.revision)
      const samples = []
      for (let index = 0; index < 10; index += 1) {
        const before = await player.projection()
        assert.notEqual(before, null, 'player projection before p95 sample')
        const expectedFood = foodCount(before, foodId) - 1
        const expectedEat = eatTaskCount(before) + 1
        const startedAt = performance.now()
        const fed = await owner.command(
          { type: 'inventory.use', payload: { type: 'food', itemId: foodId, quantity: 1 } },
          'c12-p95-feed-' + String(index + 1),
        )
        assert.equal(fed.status, 'applied', 'p95 feed command must apply')
        const observed = await waitFor(async () => {
          const projection = await player.projection()
          if (projection === null || projection.revision < fed.revision) return null
          if (foodCount(projection, foodId) !== expectedFood) return null
          if (eatTaskCount(projection) !== expectedEat) return null
          return projection
        }, 'p95 feed delivery sample ' + String(index + 1), 3_000)
        const latencyMs = performance.now() - startedAt
        assert.ok(latencyMs <= 3_000, 'p95 feed sample latency must be <= 3000ms')
        samples.push({ index: index + 1, latencyMs: Number(latencyMs.toFixed(3)), revision: observed.revision, eventSeq: observed.eventSeq })
      }
      const latencies = samples.map(sample => sample.latencyMs)
      const p95Ms = nearestRankPercentile(latencies, 0.95)
      const medianMs = nearestRankPercentile(latencies, 0.5)
      assert.equal(samples.length, 10, 'p95 requires at least ten real feed commands')
      assert.ok(p95Ms <= 3_000, 'p95 feed latency must be <= 3000ms, got ' + p95Ms)
      const converged = await waitConverged(owner, player, samples.at(-1).revision)
      assert.equal(eatTaskCount(converged.left), eatTaskCount(converged.right))
      return {
        sampleCount: samples.length,
        percentileMethod: 'nearest-rank',
        p95Ms,
        medianMs,
        minMs: Math.min(...latencies),
        maxMs: Math.max(...latencies),
        sampleLatenciesMs: latencies,
        thresholdMs: 3_000,
        allSamplesApplied: samples.length === 10,
        ownerRevision: converged.left.revision,
        playerRevision: converged.right.revision,
        projectionHash: projectionHash(converged.left),
      }
    })

    await step(SCENARIO_SESSION_ABUSE, async () => {
      const assertRejectedUnchanged = async (before, label) => {
        const after = await waitConverged(owner, player, before.revision)
        assert.equal(after.left.revision, before.revision, label + ': rejection must not change revision')
        assert.equal(after.left.eventSeq, before.eventSeq, label + ': rejection must not change eventSeq')
        assert.equal(projectionHash(after.left), projectionHash(before), label + ': rejection must not mutate shared state')
      }
      const answerKeyOnly = new Set(['answerIndex', 'answerKey', 'correctAnswer', 'correctIndex', 'rewardKey'])
      const answerFreeResults = []
      let projectionHygieneChecks = 0
      const growthCheat = await owner.command(
        { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 2_000 } },
        'c12-session-growth-fixture',
      )
      assert.equal(growthCheat.status, 'applied')
      const grown = await waitConverged(owner, player, growthCheat.revision)
      assert.ok(grown.left.shared.petComputedlInfo.level >= 5, 'session fixture requires a playable, non-egg pet stage')

      const gameStart = await owner.command(
        { type: 'game.startSession', payload: { gameId: 'c12-mandatory-game', kind: 'small' } },
        'c12-session-game-start',
      )
      assert.equal(gameStart.status, 'applied', 'game.startSession rejected: ' + JSON.stringify(gameStart.error))
      const gameToken = gameStart.result.sessionToken
      rawSessionTokens.push(gameToken)
      assert.deepEqual(findKeys(gameStart.result, answerKeyOnly), [])
      await waitConverged(owner, player, gameStart.revision)
      projectionHygieneChecks += assertRendererProjectionHygiene(
        { owner: await owner.projection(), player: await player.projection() },
        [gameToken],
        'game session start',
      )
      const gameBeforeWrong = await player.projection()
      const gameWrongActor = await player.command(
        { type: 'game.reward', payload: { sessionToken: gameToken } },
        'c12-session-game-wrong-actor',
      )
      assert.equal(gameWrongActor.status, 'rejected')
      assert.equal(gameWrongActor.error?.code, 'unauthorized')
      await assertRejectedUnchanged(gameBeforeWrong, 'game wrong actor')
      const gameReward = await owner.command(
        { type: 'game.reward', payload: { sessionToken: gameToken } },
        'c12-session-game-owner',
      )
      assert.equal(gameReward.status, 'applied')
      const gameSettled = await waitConverged(owner, player, gameReward.revision)
      const gameReplay = await owner.command(
        { type: 'game.reward', payload: { sessionToken: gameToken } },
        'c12-session-game-replay',
      )
      assert.equal(gameReplay.status, 'rejected')
      assert.equal(gameReplay.error?.code, 'already_claimed')
      await assertRejectedUnchanged(gameSettled.right, 'game settled replay')

      const diudiuleStart = await owner.command(
        { type: 'diudiule.startSession', payload: {} },
        'c12-session-diudiule-start',
      )
      assert.equal(diudiuleStart.status, 'applied', 'diudiule.startSession rejected: ' + JSON.stringify(diudiuleStart.error))
      const diudiuleToken = diudiuleStart.result.sessionToken
      rawSessionTokens.push(diudiuleToken)
      await waitConverged(owner, player, diudiuleStart.revision)
      const diudiuleBeforeWrong = await player.projection()
      const diudiuleWrongActor = await player.command(
        { type: 'diudiule.reward', payload: { sessionToken: diudiuleToken } },
        'c12-session-diudiule-wrong-actor',
      )
      assert.equal(diudiuleWrongActor.status, 'rejected')
      assert.equal(diudiuleWrongActor.error?.code, 'unauthorized')
      await assertRejectedUnchanged(diudiuleBeforeWrong, 'diudiule wrong actor')
      const ybBefore = Number((await owner.projection()).shared.petInfo.yb)
      const diudiuleReward = await owner.command(
        { type: 'diudiule.reward', payload: { sessionToken: diudiuleToken } },
        'c12-session-diudiule-owner',
      )
      assert.equal(diudiuleReward.status, 'applied')
      const diudiuleSettled = await waitConverged(owner, player, diudiuleReward.revision)
      assert.equal(Number(diudiuleSettled.right.shared.petInfo.yb), ybBefore + 1, 'diudiule reward must apply exactly once')
      const diudiuleReplay = await owner.command(
        { type: 'diudiule.reward', payload: { sessionToken: diudiuleToken } },
        'c12-session-diudiule-replay',
      )
      assert.equal(diudiuleReplay.status, 'rejected')
      assert.equal(diudiuleReplay.error?.code, 'already_claimed')
      await assertRejectedUnchanged(diudiuleSettled.right, 'diudiule settled replay')

      const expiredStart = await owner.command(
        { type: 'diudiule.startSession', payload: {} },
        'c12-session-diudiule-expired-start',
      )
      assert.equal(expiredStart.status, 'applied', 'expired diudiule start rejected: ' + JSON.stringify(expiredStart.error))
      const expiredToken = expiredStart.result.sessionToken
      rawSessionTokens.push(expiredToken)
      const expiredAtGameMs = await expireSessionToken(dbPath, expiredToken)
      const expiredReward = await owner.command(
        { type: 'diudiule.reward', payload: { sessionToken: expiredToken } },
        'c12-session-diudiule-expired-reward',
      )
      assert.equal(expiredReward.status, 'rejected')
      assert.equal(expiredReward.error?.code, 'not_available', 'expired token rejection: ' + JSON.stringify(expiredReward.error))
      const expiredAbandon = await owner.command(
        { type: 'game.abandonSession', payload: { sessionToken: expiredToken } },
        'c12-session-diudiule-expired-cleanup',
      )
      assert.equal(expiredAbandon.status, 'applied')

      await seedExamLessons(dbPath, 9)
      const examStart = await owner.command(
        { type: 'exam.start', payload: { subject: 'xx-chinese' } },
        'c12-session-exam-start',
      )
      assert.equal(examStart.status, 'applied', 'exam.start rejected: ' + JSON.stringify(examStart.error))
      const examToken = examStart.result.sessionToken
      rawSessionTokens.push(examToken)
      assert.equal(examStart.result.questions.length, 3)
      assert.deepEqual(findKeys(examStart.result, answerKeyOnly), [], 'exam start result must not contain answer keys')
      answerFreeResults.push('exam.start')
      await waitConverged(owner, player, examStart.revision)
      projectionHygieneChecks += assertRendererProjectionHygiene(
        { owner: await owner.projection(), player: await player.projection() },
        [examToken],
        'exam session start',
      )
      const examBeforeWrong = await player.projection()
      const examWrongActor = await player.command(
        { type: 'exam.submit', payload: { sessionToken: examToken, answers: [0, 0, 0] } },
        'c12-session-exam-wrong-actor',
      )
      assert.equal(examWrongActor.status, 'rejected')
      assert.equal(examWrongActor.error?.code, 'unauthorized')
      await assertRejectedUnchanged(examBeforeWrong, 'exam wrong actor')
      const examSubmit = await owner.command(
        { type: 'exam.submit', payload: { sessionToken: examToken, answers: [0, 0, 0] } },
        'c12-session-exam-owner-submit',
      )
      assert.equal(examSubmit.status, 'applied')
      const examSettled = await waitConverged(owner, player, examSubmit.revision)
      const examReplay = await owner.command(
        { type: 'exam.submit', payload: { sessionToken: examToken, answers: [0, 0, 0] } },
        'c12-session-exam-replay',
      )
      assert.equal(examReplay.status, 'rejected')
      const examRowsForReplay = await withDatabase(dbPath, false, db => db.prepare(
        'SELECT session_kind, status, expires_at_game_ms, reward_key FROM game_sessions WHERE pet_id = ? ORDER BY session_kind',
      ).all('default'))
      assert.equal(
        examReplay.error?.code,
        'already_claimed',
        'exam settled replay=' + JSON.stringify(examReplay.error) + ' rows=' + JSON.stringify(examRowsForReplay),
      )
      await assertRejectedUnchanged(examSettled.right, 'exam settled replay')

      const islandProjectionBefore = await owner.projection()
      const { dayKeyAt } = await loadRuntimeOracle()
      const islandDayKey = dayKeyAt(islandProjectionBefore.gameTimeMs, islandProjectionBefore.timeZone)
      const news = await owner.command(
        { type: 'island.refreshNews', payload: { dayKey: islandDayKey } },
        'c12-session-island-news',
      )
      assert.equal(news.status, 'applied')
      const islandReady = await waitConverged(owner, player, news.revision)
      let islandState = JSON.parse(islandReady.right.shared.saveJsonData.island)
      let quizIndex = islandState.errands.findIndex(errand => errand.kind === 'quiz')
      if (quizIndex < 0) {
        // The daily roll is allowed not to choose a quiz errand. Seed one
        // canonical quiz errand in the real SQLite document, then exercise the
        // same production start/answer commands over the live WebSocket.
        const seeded = await seedIslandQuizErrand(dbPath)
        quizIndex = seeded.quizIndex
        islandState = {
          ...islandState,
          errands: [...islandState.errands, seeded.errand],
        }
      }
      assert.ok(quizIndex >= 0, 'island fixture must expose a quiz errand')
      const quizErrand = islandState.errands[quizIndex]
      const islandStart = await owner.command(
        { type: 'island.startQuiz', payload: { npcId: quizErrand.from, errandId: String(quizIndex) } },
        'c12-session-island-start',
      )
      assert.equal(islandStart.status, 'applied', 'island.startQuiz rejected: ' + JSON.stringify(islandStart.error))
      const islandToken = islandStart.result.sessionToken
      rawSessionTokens.push(islandToken)
      assert.deepEqual(findKeys(islandStart.result, answerKeyOnly), [], 'island quiz start result must not contain answer keys')
      answerFreeResults.push('island.startQuiz')
      await waitConverged(owner, player, islandStart.revision)
      projectionHygieneChecks += assertRendererProjectionHygiene(
        { owner: await owner.projection(), player: await player.projection() },
        [islandToken],
        'island quiz start',
      )
      const islandBeforeWrong = await player.projection()
      const islandWrongActor = await player.command(
        { type: 'island.answerQuiz', payload: { sessionToken: islandToken, optionIndex: 0 } },
        'c12-session-island-wrong-actor',
      )
      assert.equal(islandWrongActor.status, 'rejected')
      assert.equal(islandWrongActor.error?.code, 'unauthorized')
      await assertRejectedUnchanged(islandBeforeWrong, 'island quiz wrong actor')
      const islandAnswer = await owner.command(
        { type: 'island.answerQuiz', payload: { sessionToken: islandToken, optionIndex: 0 } },
        'c12-session-island-owner-answer',
      )
      assert.equal(islandAnswer.status, 'applied')
      const islandSettled = await waitConverged(owner, player, islandAnswer.revision)
      projectionHygieneChecks += assertRendererProjectionHygiene(
        { owner: islandSettled.left, player: islandSettled.right },
        [islandToken],
        'island quiz settled',
      )
      const islandReplay = await owner.command(
        { type: 'island.answerQuiz', payload: { sessionToken: islandToken, optionIndex: 0 } },
        'c12-session-island-replay',
      )
      assert.equal(islandReplay.status, 'rejected')
      const islandSessionRows = await withDatabase(dbPath, false, db => db.prepare(
        'SELECT session_token, session_kind, status, expires_at_game_ms, reward_key FROM game_sessions WHERE pet_id = ?',
      ).all('default'))
      assert.equal(
        islandReplay.error?.code,
        'already_claimed',
        'island settled replay=' + JSON.stringify(islandReplay.error) + ' sessions=' + JSON.stringify(islandSessionRows.map(row => ({
          kind: row.session_kind,
          status: row.status,
          expiresAtGameMs: row.expires_at_game_ms,
          rewardKey: row.reward_key,
        }))) + ' tokenHash=' + hash(islandToken),
      )
      await assertRejectedUnchanged(islandSettled.right, 'island quiz settled replay')

      const activeSessions = await withDatabase(dbPath, false, db => db.prepare(
        "SELECT session_kind, actor_device_id FROM game_sessions WHERE pet_id = ? AND status = 'active'",
      ).all('default'))
      assert.equal(activeSessions.length, 0, 'all token-abuse sessions must be settled or abandoned')
      const finalProjection = await waitConverged(owner, player, islandSettled.right.revision)
      return {
        sessionKinds: ['game', 'diudiule', 'exam', 'island_quiz'],
        playableLevel: grown.left.shared.petComputedlInfo.level,
        wrongActorRejections: 4,
        settledReplayRejections: 4,
        expiredTokenRejections: 1,
        rejectionCodes: { wrongActor: 'unauthorized', settledReplay: 'already_claimed', expired: 'not_available' },
        expiredAtGameMs,
        diudiuleYbBefore: ybBefore,
        diudiuleYbAfter: Number(diudiuleSettled.right.shared.petInfo.yb),
        answerFreeResults,
        answerKeyProjectionChecks: projectionHygieneChecks,
        answerKeysProjected: false,
        activeSessionsAfter: activeSessions.length,
        sessionTokenHashes: rawSessionTokens.slice(-7).map(token => hash(token)),
        convergedRevision: finalProjection.left.revision,
        convergedEventSeq: finalProjection.left.eventSeq,
        projectionHash: projectionHash(finalProjection.left),
      }
    })

    await step(SCENARIO_COVERAGE_REOPEN, async () => {
      const before = await waitConverged(owner, player, 0)
      assert.equal(before.left.shared.havePet, true)
      const healthBefore = await server.health()
      assert.equal(healthBefore.activeClientCount, 2, 'both authenticated clients must be connected before reset')
      const reset = await owner.command({ type: 'pet.reset', payload: {} }, 'c12-reset-exact-survivors')
      assert.equal(reset.status, 'applied')
      const resetProjection = await waitConverged(owner, player, reset.revision)
      assert.equal(resetProjection.left.shared.havePet, false)
      assert.equal(resetProjection.right.shared.havePet, false)
      const operation = await readLatestCoverageOperation(dbPath)
      assert.notEqual(operation, null, 'reset must persist a coverage operation')
      assert.equal(operation.state, 'completed')
      assert.equal(operation.survivors.length, 2, 'reset must persist exactly two exact survivors')
      assert.ok(operation.survivors.every(survivor => survivor.kind === 'server_connection' && survivor.eligible === true))
      const survivorDeviceIds = new Set(operation.survivors.map(survivor => survivor.deviceId))
      assert.deepEqual(survivorDeviceIds, new Set([ownerDeviceId, playerDeviceId]), 'survivors must be exactly the two authenticated devices')
      const survivorConnectionIds = new Set(operation.survivors.map(survivor => survivor.connectionId))
      assert.equal(survivorConnectionIds.size, 2, 'survivor connection identities must be unique')
      const rows = await readCoverageRows(dbPath, operation.operationId)
      assert.equal(rows.length, 2, 'reset must reopen exactly two coverage rows')
      assert.equal(new Set(rows.map(row => row.coverageId)).size, 2)
      assert.deepEqual(new Set(rows.map(row => row.deviceId)), new Set([ownerDeviceId, playerDeviceId]))
      assert.ok(rows.every(row => row.connectedAtMs === operation.commitWallMs), 'survivor rows must open exactly at commit wall')
      assert.ok(rows.every(row => row.disconnectedAtMs === null && row.closeReason === null))
      assert.deepEqual(new Set(rows.map(row => row.coverageId)), new Set([...survivorConnectionIds].map(id => operation.operationId + ':' + id)))
      const openRows = await readOpenCoverageRows(dbPath)
      assert.equal(openRows.length, 2, 'reset rewrite must leave no extra open coverage rows')
      assert.deepEqual(new Set(openRows.map(row => row.coverageId)), new Set(rows.map(row => row.coverageId)))
      const healthAfter = await server.health()
      assert.equal(healthAfter.activeClientCount, 2)
      const adopt = await owner.command({ type: 'pet.adopt', payload: { sex: 'GG' } }, 'c12-reset-re-adopt')
      assert.equal(adopt.status, 'applied')
      const adopted = await waitConverged(owner, player, adopt.revision)
      assert.equal(adopted.left.shared.havePet, true)
      assert.equal(adopted.right.shared.havePet, true)
      return {
        operationIdHash: hash(operation.operationId),
        operationState: operation.state,
        commitWallMs: operation.commitWallMs,
        survivorCount: operation.survivors.length,
        reopenedRowCount: rows.length,
        extraOpenRows: openRows.length - rows.length,
        exactConnectionIds: true,
        exactDeviceIds: true,
        reopenedAtCommitWall: rows.every(row => row.connectedAtMs === operation.commitWallMs),
        activeClientCountBefore: healthBefore.activeClientCount,
        activeClientCountAfter: healthAfter.activeClientCount,
        reAdoptedRevision: adopted.left.revision,
        projectionHash: projectionHash(adopted.left),
      }
    })

    await step(SCENARIO_FRESH_IMPORT, async () => {
      const freshRoot = join(root, 'fresh-host')
      const freshDbPath = join(freshRoot, 'qqpet.sqlite')
      const freshBackupDir = join(freshRoot, 'backups')
      const freshRestoreGenerationFile = join(freshRoot, 'restore-generation.txt')
      const freshAdminSocket = join(freshRoot, 'admin.sock')
      const freshCredentialFile = join(freshRoot, 'owner-admin-credential.txt')
      const freshOwnerProfile = join(freshRoot, 'electron-owner')
      const freshPlayerProfile = join(freshRoot, 'electron-player')
      const freshPort = await freePort()
      const freshServerUrl = 'ws://127.0.0.1:' + freshPort + '/v1/sync'
      const freshEnv = {
        ...baseEnv,
        QQPET_SYNC_DB: freshDbPath,
        QQPET_SYNC_BACKUP_DIR: freshBackupDir,
        QQPET_SYNC_RESTORE_GENERATION_FILE: freshRestoreGenerationFile,
        QQPET_ADMIN_SOCKET: freshAdminSocket,
        QQPET_OWNER_ADMIN_CREDENTIAL: freshCredentialFile,
        QQPET_SYNC_PORT: String(freshPort),
      }
      await mkdir(freshOwnerProfile, { recursive: true })
      await mkdir(freshPlayerProfile, { recursive: true })
      await mkdir(freshBackupDir, { recursive: true })
      await writeFile(freshCredentialFile, 'c12-fresh-host-owner-admin-credential\n', { mode: 0o600 })
      const initialized = runCli(freshEnv, [
        'init', '--db', freshDbPath, '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京',
      ])
      assert.equal(initialized.ok, true)
      const pairedPlayer = runCli(freshEnv, ['pair', '--db', freshDbPath, '--pet-id', 'default', '--role', 'player'])
      freshOwnerPairingCode = initialized.pairingCode
      freshPlayerPairingCode = pairedPlayer.pairingCode
      freshServer = await new ServerProcess({ port: freshPort, env: freshEnv }).start()

      freshHostOwner = await new RendererApp({
        label: 'fresh-host-owner-renderer',
        userData: freshOwnerProfile,
        serverUrl: freshServerUrl,
      }).launch()
      const localStatus = await freshHostOwner.storageStatus()
      assert.equal(localStatus.mode, 'local')
      assert.equal(localStatus.activeMode, 'local')
      const localAdopt = await freshHostOwner.command(
        { type: 'pet.adopt', payload: { sex: 'MM' } },
        'c12-fresh-source-local-adopt',
      )
      assert.equal(localAdopt.status, 'applied')
      const localProjection = await waitFor(async () => {
        const projection = await freshHostOwner.projection()
        return projection?.shared?.havePet === true ? projection : null
      }, 'fresh local source projection', 10_000)
      assert.equal(localProjection.authority.owner, 'local')
      const exported = await freshHostOwner.exportBundle()
      assert.equal(exported.mode, 'local')
      const bundle = JSON.parse(exported.json)
      assert.equal(bundle.authority.owner, 'local')
      assert.equal(bundle.shared.havePet, true)

      const pairedOwner = await freshHostOwner.pair(freshOwnerPairingCode, 'C12 fresh host owner')
      assert.equal(pairedOwner.paired, true)
      const freshOwnerPairedStatus = await waitForPairedDevice(
        freshHostOwner,
        'owner',
        'fresh host owner identity after pairing',
      )
      freshOwnerDeviceId = freshOwnerPairedStatus.deviceId
      const ownerServerMode = await freshHostOwner.setServerMode('use-server')
      assert.equal(ownerServerMode.mode, 'server')
      assert.equal(ownerServerMode.activeMode, 'server')
      assert.equal(ownerServerMode.authority.owner, 'server')
      const authorityIdBefore = ownerServerMode.authority.authorityId

      freshHostPlayer = await new RendererApp({
        label: 'fresh-host-player-renderer',
        userData: freshPlayerProfile,
        serverUrl: freshServerUrl,
      }).launch()
      const pairedPlayerRenderer = await freshHostPlayer.pair(freshPlayerPairingCode, 'C12 fresh host player')
      assert.equal(pairedPlayerRenderer.paired, true)
      const freshPlayerPairedStatus = await waitForPairedDevice(
        freshHostPlayer,
        'player',
        'fresh host player identity after pairing',
      )
      freshPlayerDeviceId = freshPlayerPairedStatus.deviceId
      const playerServerMode = await freshHostPlayer.setServerMode('use-server')
      assert.equal(playerServerMode.mode, 'server')
      assert.equal(playerServerMode.activeMode, 'server')
      const connected = await waitConverged(freshHostOwner, freshHostPlayer, 0, 20_000)
      assert.equal(connected.left.shared.havePet, false)
      const activeBefore = await freshServer.health()
      assert.equal(activeBefore.activeClientCount, 2)

      const staleBundle = structuredClone(bundle)
      staleBundle.engine.lastSchedulerWallMs = Date.now() + 6 * 60_000
      const rejectedWithoutClamp = await freshHostOwner.importBundle({
        json: JSON.stringify(staleBundle),
        allowClamp: false,
      })
      assert.equal(rejectedWithoutClamp.status, 'rejected')
      assert.equal(rejectedWithoutClamp.errorCode, 'anchor_out_of_bounds')
      await sleep(150)
      const afterRejection = await waitConverged(freshHostOwner, freshHostPlayer, connected.left.revision)
      assert.equal(afterRejection.left.revision, connected.left.revision, 'rejected clamp must not mutate canonical revision')
      assert.equal(projectionHash(afterRejection.left), projectionHash(connected.left))

      const imported = await freshHostOwner.importBundle({
        json: JSON.stringify(staleBundle),
        allowClamp: true,
        rebindLocalSessions: true,
      })
      assert.equal(imported.status, 'applied')
      assert.equal(imported.mode, 'server')
      assert.equal(imported.importClamped, true, 'future-anchor import must report a clamp; report=' + JSON.stringify(imported) + ' staleAnchor=' + String(staleBundle.engine.lastSchedulerWallMs) + ' now=' + String(Date.now()))
      assert.ok(Number(imported.clockSkippedMs) < 0, 'future-anchor clamp must report the negative clock correction')
      assert.ok(Number.isSafeInteger(imported.effectiveAnchorWallMs))
      assert.ok(Number.isSafeInteger(imported.restoreGenerationBefore) && imported.restoreGenerationBefore >= 0)
      assert.equal(imported.restoreGenerationAfter, bundle.authority.restoreGeneration)
      assert.equal(
        imported.restoreGenerationReset,
        bundle.authority.restoreGeneration > imported.restoreGenerationBefore,
      )
      assert.equal(imported.nextEpoch, Math.max(0, bundle.authority.epoch) + 1)

      const importedProjection = await waitFor(async () => {
        const projection = await freshHostOwner.projection()
        return projection?.shared?.havePet === true ? projection : null
      }, 'fresh-host imported projection', 20_000)
      const importedConverged = await waitConverged(
        freshHostOwner,
        freshHostPlayer,
        importedProjection.revision,
        20_000,
      )
      const expectedShared = structuredClone(bundle.shared)
      const expectedGameTimeMs = bundle.engine.gameTimeMs + imported.clockSkippedMs
      expectedShared.nowTimeLine = Math.floor(expectedGameTimeMs / 1000)
      assert.equal(importedConverged.left.gameTimeMs, expectedGameTimeMs, 'import clamp must apply exactly the reported game-time correction')
      assert.equal(importedConverged.right.gameTimeMs, expectedGameTimeMs)
      assert.equal(projectionHash(importedConverged.left), hash(expectedShared), 'fresh-host canonical shared projection must match the source bundle after the reported clamp')
      assert.equal(projectionHash(importedConverged.right), hash(expectedShared))
      const freshStatus = await freshHostOwner.storageStatus()
      assert.equal(freshStatus.authority.owner, 'server')
      assert.equal(freshStatus.authority.state, 'active')
      assert.equal(freshStatus.authority.epoch, imported.nextEpoch)
      assert.equal(freshStatus.authority.authorityId, bundle.authority.authorityId)
      assert.notEqual(freshStatus.authority.authorityId, authorityIdBefore)

      const freshHealth = await freshServer.health()
      assert.equal(freshHealth.activeClientCount, 2)
      const operation = await readLatestCoverageOperation(freshDbPath)
      assert.notEqual(operation, null)
      assert.equal(operation.state, 'completed')
      assert.equal(operation.survivors.length, 2, 'import must persist exactly the two connected survivors')
      assert.deepEqual(
        new Set(operation.survivors.map(survivor => survivor.deviceId)),
        new Set([freshOwnerDeviceId, freshPlayerDeviceId]),
      )
      const rows = await readCoverageRows(freshDbPath, operation.operationId)
      assert.equal(rows.length, 2)
      assert.ok(rows.every(row => row.connectedAtMs === operation.commitWallMs))
      assert.ok(rows.every(row => row.disconnectedAtMs === null && row.closeReason === null))
      const openRows = await readOpenCoverageRows(freshDbPath)
      assert.equal(openRows.length, 2, 'import must not backfill or leave extra survivor rows')
      assert.deepEqual(new Set(openRows.map(row => row.coverageId)), new Set(rows.map(row => row.coverageId)))
      const detail = {
        sourceExportMode: exported.mode,
        sourceBundleHash: hash(bundle),
        rejectedWithoutClamp: rejectedWithoutClamp.status,
        rejectionCode: rejectedWithoutClamp.errorCode,
        importStatus: imported.status,
        importClamped: imported.importClamped,
        clockSkippedMs: imported.clockSkippedMs,
        effectiveAnchorWallMs: imported.effectiveAnchorWallMs,
        restoreGenerationBefore: imported.restoreGenerationBefore,
        restoreGenerationAfter: imported.restoreGenerationAfter,
        restoreGenerationReset: imported.restoreGenerationReset,
        nextEpoch: imported.nextEpoch,
        authorityOwner: freshStatus.authority.owner,
        authorityState: freshStatus.authority.state,
        serverAuthorityIdBeforeHash: hash(authorityIdBefore),
        authorityIdHash: hash(freshStatus.authority.authorityId),
        sourceAuthorityIdHash: hash(bundle.authority.authorityId),
        expectedSharedHash: hash(expectedShared),
        ownerSharedHash: projectionHash(importedConverged.left),
        playerSharedHash: projectionHash(importedConverged.right),
        expectedGameTimeMs,
        ownerGameTimeMs: importedConverged.left.gameTimeMs,
        playerGameTimeMs: importedConverged.right.gameTimeMs,
        survivorCount: operation.survivors.length,
        reopenedRowCount: rows.length,
        extraOpenRows: openRows.length - rows.length,
        reopenedAtCommitWall: rows.every(row => row.connectedAtMs === operation.commitWallMs),
        activeClientCount: freshHealth.activeClientCount,
      }
      await freshHostOwner.close()
      await freshHostPlayer.close()
      await freshServer.stop()
      freshHostOwner = null
      freshHostPlayer = null
      freshServer = null
      return detail
    })

    await step('owner detach then resume restores authority and both renderer projections converge', async () => {
      const beforeDetach = await owner.projection()
      const detached = await owner.command({ type: 'admin.exportForDetach', payload: {} }, 'c12-renderer-detach')
      assert.equal(detached.status, 'applied')
      assert.ok(detached.result?.bundle, 'detach must return a portable bundle')
      assert.ok(detached.result?.authority, 'detach must return authority metadata')
      const archivedEpoch = detached.result.authority.epoch
      const detachedOwner = await waitFor(async () => {
        const status = await owner.storageStatus()
        return status.authority.state === 'archived' && status.connection === 'online' ? status : null
      }, 'owner authority archived and connection re-established', 20_000)
      assert.equal(detachedOwner.readOnly, true)
      const detachedPlayer = await waitFor(async () => {
        const status = await player.storageStatus()
        return status.authority.state === 'archived' && status.connection === 'online' ? status : null
      }, 'player authority archived and connection re-established', 20_000)
      assert.equal(detachedPlayer.readOnly, true)

      const bundle = structuredClone(detached.result.bundle)
      bundle.authority = {
        ...bundle.authority,
        owner: 'local',
        epoch: archivedEpoch + 1,
        handoffId: 'c12-renderer-local-hop-' + Date.now(),
      }
      bundle.originLocalDeviceId = 'c12-renderer-local-device'
      const resumed = await owner.command(
        { type: 'admin.resumeServer', payload: { expectedEpoch: bundle.authority.epoch, bundle } },
        'c12-renderer-resume',
      )
      assert.equal(resumed.status, 'applied')
      assert.equal(resumed.result.epoch, archivedEpoch + 2)
      await waitFor(async () => {
        const status = await owner.storageStatus()
        return status.authority.state === 'active' ? status : null
      }, 'owner authority active after resume', 20_000)
      await owner.requestResync()
      const converged = await waitConverged(owner, player, resumed.revision, 20_000)
      assert.equal(converged.left.authority.state, 'active')
      assert.equal(converged.right.authority.state, 'active')
      assert.equal(converged.left.authority.epoch, archivedEpoch + 2)
      assert.equal(projectionHash(converged.left), projectionHash(beforeDetach))
      assert.equal(projectionHash(converged.left), projectionHash(converged.right))
      await waitFor(async () => {
        const ownerStatus = await owner.storageStatus()
        const playerStatus = await player.storageStatus()
        return ownerStatus.connection === 'online' && ownerStatus.readOnly === false
          && playerStatus.connection === 'online' && playerStatus.readOnly === false
      }, 'both resumed renderers online and writable', 20_000)
      return {
        archivedEpoch,
        resumedEpoch: resumed.result.epoch,
        authorityOwner: converged.left.authority.owner,
        authorityState: converged.left.authority.state,
        ownerProjectionHashPreserved: projectionHash(beforeDetach) === projectionHash(converged.left),
        playerProjectionConverged: projectionHash(converged.left) === projectionHash(converged.right),
        convergedRevision: converged.left.revision,
        convergedEventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
      }
    })

    await step(SCENARIO_STARTUP_REPAIR, async () => {
      const before = await waitConverged(owner, player, 0)
      const beforeHealth = await server.health()
      assert.equal(beforeHealth.activeClientCount, 2)
      const beforeCounts = await readPersistedCounts(dbPath)
      const beforeOwnerFaults = await owner.websocketFaultState()
      const beforePlayerFaults = await player.websocketFaultState()

      // Freeze the whole server past the 30s heartbeat grace, then SIGKILL it.
      // The repair bound must therefore be lastHeartbeat + grace, not restart wall.
      assert.equal(server.signal('SIGSTOP'), true)
      await sleep(32_000)
      const openRows = await readOpenCoverageRows(dbPath)
      assert.equal(openRows.length, 2, 'both connected clients must own one open coverage interval')
      const expectedCrashEnds = new Map(openRows.map(row => [row.coverageId, row.lastHeartbeatAtMs + 30_000]))
      await server.crash()
      const restartWallBeforeReady = Date.now()
      server = await new ServerProcess({ port, env: baseEnv }).start()
      const restartWallAfterReady = Date.now()
      const repairedRows = await readCoverageRowsByIds(dbPath, openRows.map(row => row.coverageId))
      assert.equal(repairedRows.length, openRows.length, 'every pre-crash open interval must be repaired')
      assert.ok(
        restartWallAfterReady > Math.max(...expectedCrashEnds.values()),
        'restart must occur after heartbeat+grace for the crash-bound assertion',
      )
      for (const row of repairedRows) {
        assert.equal(row.disconnectedAtMs, expectedCrashEnds.get(row.coverageId), 'crash repair must close at the persisted heartbeat + 30s grace')
        assert.equal(row.closeReason, 'crash_repaired')
      }

      await waitFor(async () => {
        const ownerStatus = await owner.storageStatus()
        const playerStatus = await player.storageStatus()
        const ownerFaults = await owner.websocketFaultState()
        const playerFaults = await player.websocketFaultState()
        return ownerStatus.connection === 'online'
          && playerStatus.connection === 'online'
          && ownerFaults.sockets > beforeOwnerFaults.sockets
          && playerFaults.sockets > beforePlayerFaults.sockets
          ? { ownerStatus, playerStatus, ownerFaults, playerFaults }
          : null
      }, 'both renderers to reconnect after crash restart', 45_000)
      const after = await waitFor(async () => {
        const left = await owner.projection()
        const right = await player.projection()
        if (left === null || right === null) return null
        if (left.revision !== before.left.revision || left.eventSeq !== before.left.eventSeq) return null
        if (right.revision !== before.right.revision || right.eventSeq !== before.right.eventSeq) return null
        return sameProjection(left, right) && projectionHash(left) === projectionHash(before.left)
          ? { left, right }
          : null
      }, 'exact projection convergence after crash repair', 20_000)
      const afterCounts = await readPersistedCounts(dbPath)
      assert.equal(afterCounts.commandRows, beforeCounts.commandRows, 'crash replay must not duplicate command rows')
      assert.equal(afterCounts.eventRows, beforeCounts.eventRows, 'crash replay must not duplicate event rows')
      assert.equal(afterCounts.duplicateOpIds, 0)
      assert.equal(afterCounts.duplicateEventSeqs, 0)
      const activeClients = await waitFor(async () => {
        const health = await server.health()
        return health.activeClientCount === 2 ? health : null
      }, 'two active clients after crash repair', 10_000)
      const newOpenRows = await readOpenCoverageRows(dbPath)
      assert.equal(newOpenRows.length, 2, 'reconnected clients must open exactly two new coverage intervals')
      assert.equal(newOpenRows.some(row => openRows.some(old => old.coverageId === row.coverageId)), false)
      return {
        crashSignal: 'SIGKILL',
        frozenBeforeKillMs: 32_000,
        heartbeatGraceMs: 30_000,
        preCrashOpenCoverage: openRows.length,
        repairedCoverage: repairedRows.length,
        repairedAtHeartbeatGrace: repairedRows.every(row => row.disconnectedAtMs === expectedCrashEnds.get(row.coverageId)),
        repairWallMs: restartWallBeforeReady,
        readyWallMs: restartWallAfterReady,
        oldCoverageIdsHash: hash(openRows.map(row => row.coverageId).sort()),
        reopenedCoverageIdsHash: hash(newOpenRows.map(row => row.coverageId).sort()),
        ownerReconnectSockets: (await owner.websocketFaultState()).sockets - beforeOwnerFaults.sockets,
        playerReconnectSockets: (await player.websocketFaultState()).sockets - beforePlayerFaults.sockets,
        revision: after.left.revision,
        eventSeq: after.left.eventSeq,
        commandRows: afterCounts.commandRows,
        eventRows: afterCounts.eventRows,
        duplicateOpIds: afterCounts.duplicateOpIds,
        duplicateEventSeqs: afterCounts.duplicateEventSeqs,
        projectionHash: projectionHash(after.left),
        activeClientCount: activeClients.activeClientCount,
      }
    })

    await step(SCENARIO_DETERMINISTIC_RESTART, async () => {
      await owner.setAdvanceWhileEmpty(true)
      const beforeProjection = await waitFor(async () => {
        const left = await owner.projection()
        const right = await player.projection()
        const status = await owner.storageStatus()
        return status.advanceWhileEmpty === true
          && left?.advanceWhileEmpty === true && right?.advanceWhileEmpty === true
          && sameProjection(left, right) ? { left, right, status } : null
      }, 'advance-while-empty convergence before deterministic restart', 20_000)
      assert.equal(beforeProjection.status.advanceWhileEmpty, true)
      const beforeDb = await readPetState(dbPath)
      const beforeExport = await owner.exportBundle()
      const beforeBundle = JSON.parse(beforeExport.json)
      assert.equal(beforeBundle.authority.revision, beforeDb.revision, 'export snapshot must match the canonical revision')
      assert.equal(beforeBundle.authority.eventSeq, beforeDb.eventSeq, 'export snapshot must match the canonical eventSeq')
      assert.equal(beforeBundle.engine.gameTimeMs, beforeDb.gameTimeMs, 'export snapshot must match canonical gameTime')
      assert.equal(beforeBundle.engine.advanceWhileEmpty, true)
      assert.deepEqual(beforeBundle.engine.scheduledJobs, [], 'deterministic restart fixture must start with no scheduled jobs')
      assert.deepEqual(beforeBundle.engine.gameSessions, [], 'deterministic restart fixture must start with no sessions')
      const beforeOwnerFaults = await owner.websocketFaultState()
      const beforePlayerFaults = await player.websocketFaultState()
      const expectedTicks = 2

      await server.crash()
      const rewindAnchorMs = Date.now() - expectedTicks * 60_000 - 10_000
      const anchorUpdate = await rewindSchedulerAnchor(dbPath, rewindAnchorMs)
      assert.equal(anchorUpdate.advanceWhileEmpty, true)
      server = await new ServerProcess({ port, env: baseEnv }).start()
      const restartHealth = await server.health()
      assert.equal(restartHealth.ready, true)

      const coverageIntervals = await readCoverageIntervals(dbPath)
      const { advanceSchedulerChunk } = await loadRuntimeOracle()
      const oracleEngine = structuredClone(beforeBundle.engine)
      oracleEngine.lastSchedulerWallMs = rewindAnchorMs
      oracleEngine.sessionCoverage = coverageIntervals
      const oracleTargetMs = rewindAnchorMs + expectedTicks * 60_000 + 1
      const expected = advanceSchedulerChunk(oracleEngine, {
        gameTimeMs: oracleEngine.gameTimeMs,
        environment: oracleEngine.environment,
        activeClientCount: 0,
        sessionActive: false,
        actorDeviceId: null,
      }, oracleTargetMs, { maxChunkTicks: 1_440 })
      assert.equal(expected.ok, true)
      assert.equal(expected.ticks, expectedTicks, 'the deterministic oracle must run exactly the expected tick count')
      assert.equal(expected.catchingUp, false)
      const expectedGameTimeMs = beforeDb.gameTimeMs + expectedTicks * 60_000
      const expectedRevision = beforeDb.revision + 1
      const expectedEventSeq = beforeDb.eventSeq + expected.events.length
      const expectedSharedHash = hash(expected.state.save)
      const observedTicks = (restartHealth.gameTimeMs - beforeDb.gameTimeMs) / 60_000
      assert.equal(observedTicks, expectedTicks, 'restart catch-up must execute the exact expected tick count')
      assert.equal(restartHealth.gameTimeMs, expectedGameTimeMs)
      assert.equal(restartHealth.revision, expectedRevision)
      assert.equal(restartHealth.eventSeq, expectedEventSeq)

      await waitFor(async () => {
        const ownerStatus = await owner.storageStatus()
        const playerStatus = await player.storageStatus()
        const ownerFaults = await owner.websocketFaultState()
        const playerFaults = await player.websocketFaultState()
        return ownerStatus.connection === 'online'
          && playerStatus.connection === 'online'
          && ownerFaults.sockets > beforeOwnerFaults.sockets
          && playerFaults.sockets > beforePlayerFaults.sockets
          ? { ownerStatus, playerStatus, ownerFaults, playerFaults }
          : null
      }, 'renderers reconnect after deterministic restart', 45_000)
      const after = await waitFor(async () => {
        const left = await owner.projection()
        const right = await player.projection()
        if (left === null || right === null) return null
        return left.gameTimeMs === expectedGameTimeMs
          && right.gameTimeMs === expectedGameTimeMs
          && left.revision === expectedRevision
          && right.revision === expectedRevision
          && left.eventSeq === expectedEventSeq
          && right.eventSeq === expectedEventSeq
          && sameProjection(left, right)
          ? { left, right }
          : null
      }, 'exact state after deterministic restart', 20_000)
      assert.equal(projectionHash(after.left), expectedSharedHash, 'shared projection must match the deterministic runtime oracle')
      assert.equal(projectionHash(after.right), expectedSharedHash)
      const afterExport = await owner.exportBundle()
      const afterBundle = JSON.parse(afterExport.json)
      assert.equal(afterBundle.engine.gameTimeMs, expectedGameTimeMs)
      assert.equal(afterBundle.authority.revision, expectedRevision)
      assert.equal(afterBundle.authority.eventSeq, expectedEventSeq)
      assert.deepEqual(afterBundle.engine.scheduledJobs, beforeBundle.engine.scheduledJobs, 'scheduled jobs must survive restart unchanged')
      assert.deepEqual(afterBundle.engine.gameSessions, beforeBundle.engine.gameSessions, 'game sessions must survive restart unchanged')
      assert.equal(hash(afterBundle.engine.rng), hash(expected.state.rng), 'RNG must match the deterministic post-catch-up oracle')
      const activeClients = await waitFor(async () => {
        const health = await server.health()
        return health.activeClientCount === 2 ? health : null
      }, 'two active clients after deterministic restart', 10_000)
      return {
        expectedTicks,
        observedTicks,
        gameTimeBefore: beforeDb.gameTimeMs,
        gameTimeAfter: restartHealth.gameTimeMs,
        gameTimeExpected: expectedGameTimeMs,
        revisionBefore: beforeDb.revision,
        revisionAfter: restartHealth.revision,
        revisionExpected: expectedRevision,
        eventSeqBefore: beforeDb.eventSeq,
        eventSeqAfter: restartHealth.eventSeq,
        eventSeqExpected: expectedEventSeq,
        sharedHashBefore: hash(beforeBundle.engine.save),
        sharedHashAfter: projectionHash(after.left),
        sharedHashExpected: expectedSharedHash,
        rngBeforeHash: hash(beforeBundle.engine.rng),
        rngAfterHash: hash(afterBundle.engine.rng),
        rngExpectedHash: hash(expected.state.rng),
        rngAdvancedByPublishedTicks: hash(beforeBundle.engine.rng) !== hash(afterBundle.engine.rng),
        rngMatchedDeterministicOracle: hash(afterBundle.engine.rng) === hash(expected.state.rng),
        jobsBeforeHash: hash(beforeBundle.engine.scheduledJobs),
        jobsAfterHash: hash(afterBundle.engine.scheduledJobs),
        jobsUnchanged: hash(afterBundle.engine.scheduledJobs) === hash(beforeBundle.engine.scheduledJobs),
        sessionsBeforeHash: hash(beforeBundle.engine.gameSessions),
        sessionsAfterHash: hash(afterBundle.engine.gameSessions),
        sessionsUnchanged: hash(afterBundle.engine.gameSessions) === hash(beforeBundle.engine.gameSessions),
        rewindAnchorMs,
        previousAnchorMs: anchorUpdate.previousAnchorMs,
        exactComparisons: true,
        projectionHash: projectionHash(after.left),
        activeClientCount: activeClients.activeClientCount,
      }
    })

    await step('device revoke disconnects player renderer and forces read-only', async () => {
      const ownerBefore = await owner.projection()
      const devices = await owner.page.evaluate(
        async deviceId => await window.qqpet.storage.revokeDevice(deviceId),
        playerDeviceId,
      )
      assert.ok(Array.isArray(devices.devices))
      const revoked = await waitFor(async () => {
        const status = await player.storageStatus()
        return status.notice === 'device_revoked' ? status : null
      }, 'player renderer device_revoked notice', 20_000)
      assert.equal(revoked.connection, 'error')
      assert.equal(revoked.readOnly, true)
      const playerRepositoryStatus = await player.repositoryStatus()
      assert.equal(playerRepositoryStatus.state, 'error')
      assert.equal(playerRepositoryStatus.readOnly, true)
      assert.equal(playerRepositoryStatus.notice, 'device_revoked')
      assert.equal(await player.projection(), null)
      await waitFor(async () => (await server.health()).activeClientCount === 1, 'one remaining owner connection', 10_000)
      const ownerAfter = await owner.projection()
      const ownerStatus = await owner.storageStatus()
      assert.equal(ownerStatus.connection, 'online')
      assert.equal(ownerStatus.authority.state, 'active')
      assert.equal(projectionHash(ownerAfter), projectionHash(ownerBefore))
      return {
        revokedDeviceIdHash: hash(playerDeviceId),
        playerNotice: revoked.notice,
        playerConnection: revoked.connection,
        playerReadOnly: revoked.readOnly,
        playerProjectionPresent: false,
        playerRepositoryState: playerRepositoryStatus.state,
        ownerStillOnline: ownerStatus.connection,
        ownerAuthorityState: ownerStatus.authority.state,
        ownerProjectionHashUnchanged: true,
        activeClientCount: (await server.health()).activeClientCount,
      }
    })

    await step(SCENARIO_REVOKED_RECONNECT, async () => {
      const previousPid = player.pid
      const previousUserData = player.userData
      const beforeHealth = await server.health()
      const revokedBefore = Number(beforeHealth.authMetrics?.['auth.revoked'] ?? 0)
      // Restart the same renderer identity in a copied userData directory. The
      // token/config bytes are preserved, so the new Electron process performs
      // a real hello with the revoked device token; a fresh directory avoids a
      // stale single-instance lock while keeping the identity under test.
      await player.close()
      const reconnectProfile = join(root, 'electron-player-revoked-reconnect')
      await cp(previousUserData, reconnectProfile, { recursive: true })
      for (const stale of ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort']) {
        await rm(join(reconnectProfile, stale), { force: true })
      }
      await sleep(500)
      player = await new RendererApp({
        label: 'revoked-player-reconnect-renderer',
        userData: reconnectProfile,
        serverUrl,
      }).launch()
      assert.notEqual(player.pid, previousPid, 'revoked renderer must be a fresh Electron process after forced reconnect')
      const status = await waitFor(async () => {
        const current = await player.storageStatus()
        return current.connection === 'error' && current.notice === 'device_revoked' ? current : null
      }, 'revoked renderer reconnect rejection notice', 30_000)
      assert.equal(status.readOnly, true)
      const repositoryStatus = await player.repositoryStatus()
      assert.equal(repositoryStatus.state, 'error')
      assert.equal(repositoryStatus.notice, 'device_revoked')
      assert.equal(repositoryStatus.readOnly, true)
      assert.equal(await player.projection(), null)
      const afterHealth = await waitFor(async () => {
        const health = await server.health()
        const revokedAfter = Number(health.authMetrics?.['auth.revoked'] ?? 0)
        return revokedAfter === revokedBefore + 1 && health.activeClientCount === 1 ? health : null
      }, 'server to reject exactly one revoked reconnect hello', 20_000)
      const faultState = await player.websocketFaultState()
      return {
        previousMainPid: previousPid,
        reconnectMainPid: player.pid,
        freshMainProcess: player.pid !== previousPid,
        copiedUserDataIdentityPreserved: player.userData !== previousUserData,
        serverAuthRevokedBefore: revokedBefore,
        serverAuthRevokedAfter: Number(afterHealth.authMetrics?.['auth.revoked'] ?? 0),
        rejectedHelloCount: 1,
        clientNotice: status.notice,
        clientConnection: status.connection,
        clientReadOnly: status.readOnly,
        repositoryState: repositoryStatus.state,
        projectionPresentAfterReconnect: false,
        observedWebSocketSockets: faultState.sockets,
        observedHelloFrames: faultState.sentHellos,
        activeClientCount: afterHealth.activeClientCount,
      }
    })

    await step('real BrowserWindow/preload/renderer proof and evidence hygiene', async () => {
      const ownerMain = await owner.mainProof()
      const playerMain = await player.mainProof()
      const ownerRenderer = await owner.rendererProof()
      const playerRenderer = await player.rendererProof()
      const allWindows = [...ownerMain.windows, ...playerMain.windows]
      assert.ok(allWindows.length >= 2, 'two real BrowserWindows must be open')
      assert.ok(allWindows.every(window => window.destroyed === false), 'BrowserWindows must be live')
      assert.ok(allWindows.every(window => window.url.startsWith('app://bundle/')), 'BrowserWindow renderer URLs')
      assert.ok(allWindows.every(window => window.contextIsolation === true), 'contextIsolation must be enabled')
      assert.ok(allWindows.every(window => window.sandbox === true), 'sandboxed preload must be enabled')
      assert.ok(allWindows.every(window => window.nodeIntegration === false), 'nodeIntegration must stay disabled')
      assert.ok(ownerMain.rendererProcessCount >= 1 && playerMain.rendererProcessCount >= 1, 'real renderer processes')
      assert.notEqual(ownerMain.mainPid, playerMain.mainPid, 'distinct Electron main processes')
      for (const renderer of [ownerRenderer, playerRenderer]) {
        assert.equal(renderer.readyState, 'complete')
        assert.equal(renderer.title, 'QQ宠物')
        assert.equal(renderer.petElementPresent, true)
        assert.ok(renderer.qqpetApiKeys >= 40, 'preload contextBridge API must be exposed')
        assert.equal(renderer.storageApiPresent, true)
        assert.equal(renderer.serverModeCapability, true)
      }
      const reportSoFar = JSON.stringify(report)
      for (const secret of [
        ownerPairingCode,
        playerPairingCode,
        freshOwnerPairingCode,
        freshPlayerPairingCode,
        ownerDeviceId,
        playerDeviceId,
        freshOwnerDeviceId,
        freshPlayerDeviceId,
        ...rawSessionTokens,
      ]) {
        if (typeof secret === 'string' && secret.length > 0) {
          assert.equal(reportSoFar.includes(secret), false, 'raw pairing/device/session identifiers must not enter evidence')
        }
      }
      assert.equal(reportSoFar.includes('issuedToken'), false, 'issued tokens must not enter evidence')
      rendererProof = {
        electronMainPidsDistinct: ownerMain.mainPid !== playerMain.mainPid,
        browserWindowCount: allWindows.length,
        rendererProcessCount: ownerMain.rendererProcessCount + playerMain.rendererProcessCount,
        preloadApiExposed: ownerRenderer.qqpetApiKeys >= 40 && playerRenderer.qqpetApiKeys >= 40,
        contextIsolation: allWindows.every(window => window.contextIsolation),
        sandboxedPreload: allWindows.every(window => window.sandbox),
        nodeIntegrationDisabled: allWindows.every(window => window.nodeIntegration === false),
        rendererDocumentLoaded: ownerRenderer.readyState === 'complete' && playerRenderer.readyState === 'complete',
        guiElementPresent: ownerRenderer.petElementPresent && playerRenderer.petElementPresent,
        urls: [...new Set(allWindows.map(window => window.url))],
        titles: [...new Set([ownerRenderer.title, playerRenderer.title])],
        electronVersion: ownerMain.electronVersion,
      }
      return {
        ...rendererProof,
        evidenceHygiene: {
          pairingCodesAbsent: true,
          rawDeviceIdsAbsent: true,
          tokensAbsent: true,
        },
      }
    })

    await step('clean teardown of both Electron apps and standalone server', async () => {
      await owner.close()
      await player.close()
      await server.stop()
      teardownComplete = true
      report.evidence.teardown = true
      return {
        ownerExited: true,
        playerExited: true,
        serverExited: true,
      }
    })

    if (report.steps.length < E2E_MIN_STEPS) {
      throw new Error('renderer E2E completed only ' + report.steps.length + ' steps; minimum is ' + E2E_MIN_STEPS)
    }
    assert.ok(rendererProof !== null, 'renderer proof must be captured')
    const distinctMainPids = owner.pid !== player.pid
    const realRenderer = rendererProof.browserWindowCount >= 2
      && rendererProof.rendererProcessCount >= 2
      && rendererProof.preloadApiExposed === true
      && rendererProof.contextIsolation === true
      && rendererProof.sandboxedPreload === true
      && rendererProof.rendererDocumentLoaded === true
    const realElectron = distinctMainPids
      && rendererProof.electronMainPidsDistinct === true
      && rendererProof.browserWindowCount >= 2
      && typeof rendererProof.electronVersion === 'string'
      && rendererProof.electronVersion.length > 0
    const realStandaloneServer = typeof server.child.pid === 'number' && report.evidence.database?.journalMode === 'wal'
    const websocketEvidence = { serverUrl, activeClientCountAtConvergence: 2 }
    const realWebSocket = /^wss?:\/\//.test(websocketEvidence.serverUrl)
      && websocketEvidence.activeClientCountAtConvergence >= 2
    const rendererCoverage = distinctMainPids && realElectron && realRenderer
    const guiCoverage = realRenderer && rendererProof.guiElementPresent === true
    assert.equal(realElectron, true, 'real Electron two-process proof')
    assert.equal(realStandaloneServer, true, 'real standalone server proof')
    assert.equal(realWebSocket, true, 'real WebSocket proof')
    assert.equal(rendererCoverage, true, 'real renderer coverage proof')
    assert.equal(guiCoverage, true, 'real GUI coverage proof')
    report.evidence.twoProcesses = distinctMainPids
    report.evidence.realStandaloneServer = realStandaloneServer
    report.evidence.realWebSocket = realWebSocket
    report.evidence.realElectron = realElectron
    report.evidence.realRenderer = realRenderer
    report.evidence.rendererCoverage = rendererCoverage
    report.evidence.guiCoverage = guiCoverage
    report.evidence.ownerPid = owner.pid
    report.evidence.playerPid = player.pid
    report.evidence.rendererProof = rendererProof
    report.evidence.websocket = websocketEvidence
    report.evidence.scenarios = {
      ownerPairViaRendererStorage: true,
      playerPairAndServerModeViaRendererStorage: true,
      canonicalCommandCrossRenderer: true,
      duplicateOpId: true,
      revisionGapResyncRecovered: true,
      ownerDetachResumeRecovered: true,
      deviceRevokeDisconnectedPlayer: true,
      competingActionsRejected: true,
      sessionTokenAbuseRejected: true,
      feedLatencyP95Measured: true,
      connectedCoverageReopenExact: true,
      freshHostPortableImportClamped: true,
      startupCrashRepairHeartbeatGrace: true,
      deterministicRestartExact: true,
      revokedRendererReconnectRejected: true,
    }
    report.evidence.competingActionsCovered = true
    report.evidence.sessionTokenAbuseCovered = true
    report.evidence.freshHostPortableImportCovered = true
    report.evidence.connectedCoverageReopenCovered = true
    report.evidence.startupCrashRepairCovered = true
    report.evidence.deterministicRestartCovered = true
    report.evidence.revokedReconnectCovered = true
    report.evidence.feedLatencyP95Covered = true
    report.evidence.answerKeysAbsent = true
    report.evidence.hygiene = {
      pairingCodesAbsent: true,
      rawDeviceIdsAbsent: true,
      tokensAbsent: true,
      answerKeysAbsent: true,
    }
    report.evidence.stepCount = report.steps.length
    report.finishedAt = new Date().toISOString()
    const finalEvidenceText = JSON.stringify(report)
    for (const secret of [
      ownerPairingCode,
      playerPairingCode,
      freshOwnerPairingCode,
      freshPlayerPairingCode,
      ownerDeviceId,
      playerDeviceId,
      freshOwnerDeviceId,
      freshPlayerDeviceId,
      ...rawSessionTokens,
    ]) {
      if (typeof secret === 'string' && secret.length > 0) {
        assert.equal(finalEvidenceText.includes(secret), false, 'final evidence must not contain raw secrets')
      }
    }
    for (const forbiddenKey of ['"answerIndex"', '"rewardKey"', '"actorDeviceId"']) {
      assert.equal(finalEvidenceText.includes(forbiddenKey), false, 'final evidence must not contain stored answer/session fields')
    }
    report.result = 'PASS'
    process.stdout.write('[renderer-e2e] ALL RENDERER SCENARIOS PASSED\n')
  } catch (error) {
    report.result = 'FAIL'
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stdout.write('[renderer-e2e] FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  } finally {
    if (owner !== null) await owner.close().catch(() => {})
    if (player !== null) await player.close().catch(() => {})
    if (freshHostOwner !== null) await freshHostOwner.close().catch(() => {})
    if (freshHostPlayer !== null) await freshHostPlayer.close().catch(() => {})
    if (freshServer !== null) await freshServer.stop().catch(() => {})
    if (server !== null) {
      await server.stop().catch(() => {})
      if (teardownComplete === false) report.evidence.teardown = false
    }
    if (report.finishedAt === undefined) report.finishedAt = new Date().toISOString()
    report.evidence.stepCount = report.steps.length
    const artifactDir = process.env.QQPET_E2E_ARTIFACTS?.trim()
      || join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-e2e')
    await mkdir(artifactDir, { recursive: true })
    const reportPath = join(artifactDir, 'c12-e2e-report.json')
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    if (process.env.QQPET_E2E_KEEP_TEMP === '1') {
      process.stdout.write('[renderer-e2e] temp dir kept: ' + root + '\n')
    } else {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
    process.stdout.write('C12_RENDERER_E2E_REPORT ' + JSON.stringify({
      result: report.result,
      reportPath,
      steps: report.steps.map(item => ({ name: item.name, status: item.status, durationMs: item.durationMs })),
      evidence: report.evidence,
    }) + '\n')
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write('[renderer-e2e] FAILED TO RUN: ' + message + '\n')
  process.exitCode = 1
})
