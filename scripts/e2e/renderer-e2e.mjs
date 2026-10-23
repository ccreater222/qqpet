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
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { E2E_MIN_STEPS, REQUIRED_E2E_SCENARIO_NAMES } from '../lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SERVER_ENTRY = join(ROOT, 'server/dist/server/src/index.js')
const CLOCKED_SERVER_ENTRY = join(HERE, 'clocked-server.mjs')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
/** Fixed noon in Asia/Shanghai, far from any 06:00 daily boundary. */
const TIME_FIXTURE_CLOCK_MS = Date.UTC(2030, 0, 1, 4, 0, 0)
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
  SCENARIO_TIMED_WORK,
  SCENARIO_ADVANCE_WHILE_EMPTY,
  SCENARIO_ONLINE_SIGNIN,
  SCENARIO_LOCAL_HANDOFF,
  SCENARIO_SURVIVOR_RESTART,
  SCENARIO_ADVANCE_RANDOM_RECONNECT,
  SCENARIO_MUTATION_BLOCKED,
  SCENARIO_SECRET_BOUNDARY,
  SCENARIO_TIMED_BOTH_RENDERERS,
  SCENARIO_SESSION_GRADING,
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
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}
const stableHash = value => createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')

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
    } else {
      // The fixture must be usable more than once after a prior settlement.
      island.errands[index] = { ...island.errands[index], got: 0, took: false }
    }
    save.saveJsonData.island = JSON.stringify(island)
    const engine = JSON.parse(String(row.engine_json))
    engine.save = save
    db.prepare('UPDATE pets SET save_json = ?, engine_json = ?, updated_at_ms = ? WHERE id = ?')
      .run(JSON.stringify(save), JSON.stringify(engine), Date.now(), petId)
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

/**
 * Seeds a valid, non-empty per-day environment into the temporary canonical
 * SQLite fixture. Weather is generated with the same compiled fallback used by
 * the production runtime and is persisted before restart/import assertions.
 */
async function seedCanonicalEnvironment(dbPath, sourceLabel, petId = 'default') {
  const oracle = await loadRuntimeOracle()
  return await withDatabase(dbPath, true, db => {
    const row = db.prepare('SELECT engine_json, game_time_ms FROM pets WHERE id = ?').get(petId)
    if (row === undefined) throw new Error('pet row is missing for environment fixture')
    const engine = JSON.parse(String(row.engine_json))
    const gameTimeMs = Number(row.game_time_ms)
    const seedHex = String(engine.rng?.seedHex ?? '')
    assert.match(seedHex, /^[0-9a-f]{32}$/)
    const dayKey = oracle.dayKeyAt(gameTimeMs, engine.timeZone)
    const weather = oracle.fallbackWeatherForDay(seedHex, dayKey, {
      fetchedAtMs: gameTimeMs,
      sourceLabel,
    })
    engine.environment = {
      calendarByDay: {
        ...(engine.environment?.calendarByDay ?? {}),
        [dayKey]: {
          date: dayKey,
          lunar: 'C12 fixture',
          term: null,
          holiday: { name: 'C12 fixture day', off: false },
        },
      },
      weatherByDay: {
        ...(engine.environment?.weatherByDay ?? {}),
        [dayKey]: weather,
      },
    }
    db.prepare('UPDATE pets SET engine_json = ?, updated_at_ms = ? WHERE id = ?')
      .run(JSON.stringify(engine), Date.now(), petId)
    return {
      dayKey,
      weatherKeys: Object.keys(engine.environment.weatherByDay),
      calendarKeys: Object.keys(engine.environment.calendarByDay),
      weatherHash: hash(weather),
    }
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


async function readScheduledJobRows(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => db.prepare(
    `SELECT job_id, kind, due_at_game_ms, payload_json, status, created_command_seq, completed_command_seq
     FROM scheduled_jobs WHERE pet_id = ? ORDER BY due_at_game_ms, job_id`,
  ).all(petId).map(row => ({
    id: Number(row.job_id),
    kind: String(row.kind),
    dueAtGameMs: Number(row.due_at_game_ms),
    payload: JSON.parse(String(row.payload_json)),
    status: String(row.status),
    createdCommandSeq: row.created_command_seq === null ? null : Number(row.created_command_seq),
    completedCommandSeq: row.completed_command_seq === null ? null : Number(row.completed_command_seq),
  })))
}

async function readSessionPayload(dbPath, sessionToken, petId = 'default') {
  const row = await withDatabase(dbPath, false, db => db.prepare(
    `SELECT session_kind, status, started_at_game_ms, expires_at_game_ms, payload_json
     FROM game_sessions WHERE pet_id = ? AND session_token = ?`,
  ).get(petId, sessionToken))
  if (row === undefined) throw new Error('game session row is missing')
  return {
    kind: String(row.session_kind),
    status: String(row.status),
    startedAtGameMs: Number(row.started_at_game_ms),
    expiresAtGameMs: Number(row.expires_at_game_ms),
    payload: JSON.parse(String(row.payload_json)),
  }
}

async function readEventRows(dbPath, options = {}) {
  const petId = options.petId ?? 'default'
  const type = options.type
  return await withDatabase(dbPath, false, db => {
    const rows = type === undefined
      ? db.prepare(
        `SELECT event_seq, revision, command_seq, game_time_ms, type, payload_json
         FROM events WHERE pet_id = ? ORDER BY event_seq`,
      ).all(petId)
      : db.prepare(
        `SELECT event_seq, revision, command_seq, game_time_ms, type, payload_json
         FROM events WHERE pet_id = ? AND type = ? ORDER BY event_seq`,
      ).all(petId, type)
    return rows.map(row => ({
      eventSeq: Number(row.event_seq),
      revision: Number(row.revision),
      commandSeq: row.command_seq === null ? null : Number(row.command_seq),
      gameTimeMs: Number(row.game_time_ms),
      type: String(row.type),
      payload: JSON.parse(String(row.payload_json)),
    }))
  })
}

/**
 * Independent canonical engine snapshot for the deterministic scheduler
 * oracle. This reconstructs exactly the same public fields DatabaseStore uses,
 * without writing fixture data into the canonical document.
 */
async function readCanonicalEngine(dbPath, petId = 'default') {
  return await withDatabase(dbPath, false, db => {
    const pet = db.prepare(
      `SELECT save_json, engine_json, game_time_ms, last_scheduler_wall_ms
       FROM pets WHERE id = ?`,
    ).get(petId)
    const settings = db.prepare(
      'SELECT advance_while_empty, time_zone, weather_location FROM pet_settings WHERE pet_id = ?',
    ).get(petId)
    if (pet === undefined || settings === undefined) throw new Error('canonical pet/settings row is missing')
    const engine = JSON.parse(String(pet.engine_json))
    engine.save = JSON.parse(String(pet.save_json))
    engine.gameTimeMs = Number(pet.game_time_ms)
    engine.lastSchedulerWallMs = Number(pet.last_scheduler_wall_ms)
    engine.timeZone = String(settings.time_zone)
    engine.advanceWhileEmpty = Number(settings.advance_while_empty) === 1
    engine.weatherLocation = settings.weather_location === null
      ? engine.weatherLocation
      : String(settings.weather_location)
    engine.scheduledJobs = db.prepare(
      `SELECT job_id, kind, due_at_game_ms, payload_json, status
       FROM scheduled_jobs WHERE pet_id = ? ORDER BY due_at_game_ms, job_id`,
    ).all(petId).map(row => ({
      id: Number(row.job_id),
      type: String(row.kind),
      dueAtGameMs: Number(row.due_at_game_ms),
      payload: JSON.parse(String(row.payload_json)),
      status: String(row.status),
    }))
    engine.gameSessions = db.prepare(
      `SELECT session_token, actor_device_id, payload_json, started_at_game_ms,
              expires_at_game_ms, status, settled_command_seq, reward_key, cancel_reason
       FROM game_sessions WHERE pet_id = ? ORDER BY started_at_game_ms, session_token`,
    ).all(petId).map(row => {
      const session = {
        sessionToken: String(row.session_token),
        actorDeviceId: String(row.actor_device_id),
        payload: JSON.parse(String(row.payload_json)),
        startedAtGameMs: Number(row.started_at_game_ms),
        expiresAtGameMs: Number(row.expires_at_game_ms),
        status: String(row.status),
      }
      if (row.settled_command_seq !== null) session.settledCommandSeq = Number(row.settled_command_seq)
      if (row.reward_key !== null) session.rewardKey = String(row.reward_key)
      if (row.cancel_reason !== null) session.cancelReason = String(row.cancel_reason)
      return session
    })
    engine.sessionCoverage = db.prepare(
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
    })
    return engine
  })
}

async function readAuthorityRow(dbPath, petId = 'default') {
  const row = await withDatabase(dbPath, false, db => db.prepare(
    `SELECT authority_id, restore_generation, epoch, handoff_epoch, owner, state, handoff_id,
            detached_at_ms, source_revision, source_event_seq
     FROM pet_authority WHERE pet_id = ?`,
  ).get(petId))
  if (row === undefined) throw new Error('pet authority row is missing')
  return {
    authorityId: String(row.authority_id),
    restoreGeneration: Number(row.restore_generation),
    epoch: Number(row.epoch),
    handoffEpoch: row.handoff_epoch === null ? null : Number(row.handoff_epoch),
    owner: String(row.owner),
    state: String(row.state),
    handoffId: String(row.handoff_id),
    detachedAtMs: row.detached_at_ms === null ? null : Number(row.detached_at_ms),
    sourceRevision: row.source_revision === null ? null : Number(row.source_revision),
    sourceEventSeq: row.source_event_seq === null ? null : Number(row.source_event_seq),
  }
}

function localDocumentPath(userDataPath) {
  return join(userDataPath, 'save.v2.json')
}

async function readLocalDocument(userDataPath) {
  return JSON.parse(await readFile(localDocumentPath(userDataPath), 'utf8'))
}

/**
 * Seeds a valid per-day environment into a stopped LocalRepository document.
 * This is fixture input only: the resulting bundle is exported by the real
 * renderer and then imported by the real server.
 */
async function seedLocalDocumentEnvironment(userDataPath, sourceLabel) {
  const path = localDocumentPath(userDataPath)
  const document = JSON.parse(await readFile(path, 'utf8'))
  const engine = document?.bundle?.engine
  assert.notEqual(engine, undefined, 'local document engine must exist before seeding')
  const oracle = await loadRuntimeOracle()
  const seedHex = String(engine.rng?.seedHex ?? '')
  assert.match(seedHex, /^[0-9a-f]{32}$/)
  const dayKey = oracle.dayKeyAt(engine.gameTimeMs, engine.timeZone)
  const weather = oracle.fallbackWeatherForDay(seedHex, dayKey, {
    fetchedAtMs: engine.gameTimeMs,
    sourceLabel,
  })
  engine.environment = {
    calendarByDay: {
      ...(engine.environment?.calendarByDay ?? {}),
      [dayKey]: {
        date: dayKey,
        lunar: 'C12 import fixture',
        term: null,
        holiday: { name: 'C12 import fixture day', off: false },
      },
    },
    weatherByDay: {
      ...(engine.environment?.weatherByDay ?? {}),
      [dayKey]: weather,
    },
  }
  const temporary = path + '.' + process.pid + '.' + Date.now() + '.tmp'
  await writeFile(temporary, JSON.stringify(document, null, 2))
  await rename(temporary, path)
  return {
    dayKey,
    weatherKeys: Object.keys(engine.environment.weatherByDay),
    calendarKeys: Object.keys(engine.environment.calendarByDay),
    weatherHash: hash(weather),
  }
}

async function fileSha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function writeClockedNow(clockFile, value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, 'test clock must be a non-negative safe integer')
  const temporary = clockFile + '.' + process.pid + '.' + Date.now() + '.tmp'
  await writeFile(temporary, String(value) + '\n')
  await rename(temporary, clockFile)
}

function runClockedCli(env, args) {
  const stdout = execFileSync(process.execPath, [CLOCKED_SERVER_ENTRY, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout)
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

function countBy(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

async function readOptionalFile(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function quoteSqlIdentifier(identifier) {
  return '"' + identifier.replaceAll('"', '""') + '"'
}

/**
 * Reads every table/column in the real temporary SQLite file. The caller can
 * audit the exact persisted cells without trusting a hand-picked column list,
 * and the device/pairing metadata exposes hash storage type/length.
 */
async function readDatabaseAudit(dbPath) {
  return await withDatabase(dbPath, false, db => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map(row => String(row.name))
    const columns = {}
    const textCells = []
    const sessionPayloads = []
    for (const table of tables) {
      const quoted = quoteSqlIdentifier(table)
      const tableColumns = db.prepare(`PRAGMA table_info(${quoted})`).all().map(row => String(row.name))
      columns[table] = tableColumns
      const rows = db.prepare(`SELECT * FROM ${quoted}`).all()
      for (const row of rows) {
        for (const column of tableColumns) {
          const value = row[column]
          if (typeof value !== 'string') continue
          if (table === 'game_sessions' && column === 'payload_json') sessionPayloads.push(value)
          else textCells.push({ table, column, text: value })
        }
      }
    }
    const devices = db.prepare(
      `SELECT device_id, label, role, typeof(token_hash) AS token_hash_type,
              length(token_hash) AS token_hash_length, revoked_at_ms
       FROM devices ORDER BY device_id`,
    ).all().map(row => ({
      deviceId: String(row.device_id),
      label: String(row.label),
      role: String(row.role),
      tokenHashType: String(row.token_hash_type),
      tokenHashLength: Number(row.token_hash_length),
      revoked: row.revoked_at_ms !== null,
    }))
    const pairingCodes = db.prepare(
      `SELECT typeof(code_hash) AS code_hash_type, length(code_hash) AS code_hash_length,
              role, used_at_ms
       FROM pairing_codes ORDER BY code_hash`,
    ).all().map(row => ({
      codeHashType: String(row.code_hash_type),
      codeHashLength: Number(row.code_hash_length),
      role: String(row.role),
      used: row.used_at_ms !== null,
    }))
    return { tables, columns, textCells, sessionPayloads, devices, pairingCodes }
  })
}

function findKeysExcludingPath(value, forbidden, isExcludedPath, path = '$', found = []) {
  if (isExcludedPath(path)) return found
  if (Array.isArray(value)) {
    value.forEach((item, index) => findKeysExcludingPath(
      item,
      forbidden,
      isExcludedPath,
      path + '[' + String(index) + ']',
      found,
    ))
    return found
  }
  if (value === null || typeof value !== 'object') return found
  for (const [key, item] of Object.entries(value)) {
    const nextPath = path + '.' + key
    if (forbidden.has(key)) found.push(nextPath)
    findKeysExcludingPath(item, forbidden, isExcludedPath, nextPath, found)
  }
  return found
}

function findKeysOutsideClosedSessionPayload(value, forbidden) {
  return findKeysExcludingPath(
    value,
    forbidden,
    path => /^\$\.gameSessions\[\d+\]\.payload(?:\.|$)/.test(path),
  )
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

function taskCounter(save, counter) {
  const raw = save?.saveJsonData?.task
  if (typeof raw !== 'string') return 0
  try {
    return Number(JSON.parse(raw).doNums?.[counter] ?? 0)
  } catch {
    return 0
  }
}

function taskCounterSnapshot(save) {
  return {
    GameRound: taskCounter(save, 'GameRound'),
    Game: taskCounter(save, 'Game'),
    Work: taskCounter(save, 'Work'),
    Study: taskCounter(save, 'Study'),
  }
}

function inventoryCount(save, type, id) {
  const entries = save?.selfGoodDatas?.[type]
  if (Array.isArray(entries) === false) return 0
  const prefix = '_' + id + '*'
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) return Number(entry.slice(prefix.length))
  }
  return 0
}

function normalizeScheduledJobs(jobs) {
  return [...(jobs ?? [])].sort((left, right) =>
    Number(left.dueAtGameMs) - Number(right.dueAtGameMs) || Number(left.id) - Number(right.id))
}

function normalizeGameSessions(sessions) {
  return [...(sessions ?? [])].sort((left, right) =>
    Number(left.startedAtGameMs) - Number(right.startedAtGameMs)
    || String(left.sessionToken).localeCompare(String(right.sessionToken)))
}

function sharedBlob(save, key, fallback = {}) {
  const raw = save?.saveJsonData?.[key]
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function signinState(save) {
  const state = sharedBlob(save, 'signin', {})
  return {
    collectionList: state.collectionList ?? {},
    getGrowth: state.getGrowth ?? null,
    onlineGiftNum: Number(state.onlineGiftNum ?? 0),
    isOnlineLastTime: Number(state.isOnlineLastTime ?? 20),
    getBirthDayGift: state.getBirthDayGift ?? true,
  }
}

function countSigninDay(state, day) {
  let count = 0
  for (const months of Object.values(state.collectionList ?? {})) {
    if (months === null || typeof months !== 'object') continue
    for (const days of Object.values(months)) {
      if (Array.isArray(days) === false) continue
      count += days.filter(value => Number(value) === Number(day)).length
    }
  }
  return count
}

class ServerProcess {
  constructor(options) {
    this.options = options
    this.entry = options.entry ?? SERVER_ENTRY
    this.args = options.args ?? ['start']
    this.child = null
    this.stdout = []
    this.stderr = []
    this.exitPromise = null
    this.stopped = false
    this.authToken = options.authToken ?? ''
  }

  setHealthToken(token) {
    assert.equal(typeof token, 'string')
    assert.ok(token.length > 0, 'health auth token must be non-empty')
    this.authToken = token
  }

  async start() {
    this.child = spawn(process.execPath, [this.entry, ...this.args], {
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
    const detailed = this.authToken.length > 0
    const response = await fetch(
      'http://127.0.0.1:' + this.options.port + (detailed ? '/health/detail' : '/health'),
      detailed ? { headers: { authorization: 'Bearer ' + this.authToken } } : undefined,
    )
    if (response.ok === false) throw new Error('health returned ' + response.status)
    return await response.json()
  }

  async publicHealth() {
    const response = await fetch('http://127.0.0.1:' + this.options.port + '/health')
    if (response.ok === false) throw new Error('public health returned ' + response.status)
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
        dropCommandTypes: [],
        droppedCommandFrames: [],
        droppedCommands: 0,
        suppressCommandStatus: false,
        suppressedCommandStatuses: 0,
        lastSocket: null,
      }
      globalThis.__QQPET_C12_WS_FAULTS__ = state
      globalThis.WebSocket = class extends OriginalWebSocket {
        constructor(url) {
          super(url)
          state.sockets += 1
          state.lastSocket = this
          this.addEventListener('message', event => {
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch {
              return
            }
            if (state.suppressCommandStatus && frame?.t === 'commandStatusResult') {
              state.suppressedCommandStatuses += 1
              event.stopImmediatePropagation()
              return
            }
            if (state.dropProjection <= 0 || frame?.t !== 'projection') return
            state.dropProjection -= 1
            state.droppedProjections += 1
            event.stopImmediatePropagation()
          }, true)
        }

        send(data) {
          let frame = null
          try {
            frame = JSON.parse(String(data))
            if (frame?.t === 'resync') state.sentResyncs += 1
            if (frame?.t === 'hello') state.sentHellos += 1
          } catch {
            // Non-JSON payloads are not used by this protocol.
          }
          if (frame?.t === 'command'
            && Array.isArray(state.dropCommandTypes)
            && state.dropCommandTypes.includes(frame.command?.type)) {
            state.droppedCommandFrames.push(String(data))
            state.droppedCommands += 1
            return
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

  /** Exercises the legacy production preload SavePatch channel in the real renderer. */
  async legacySave(patch) {
    await this.page.evaluate(async value => { window.qqpet.save(value) }, patch)
  }

  async loadVisibleSave() {
    return await this.page.evaluate(async () => await window.qqpet.load())
  }

  /** Test-only read of the real safeStorage-encrypted device credential. Never report it. */
  async deviceToken() {
    return await this.app.evaluate(({ app, safeStorage }) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
      const encrypted = fs.readFileSync(path.join(app.getPath('userData'), 'remote-token.bin'))
      return safeStorage.decryptString(encrypted)
    })
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

  async setMode(input) {
    return await this.page.evaluate(
      async payload => await window.qqpet.storage.setMode(payload),
      input,
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
    return await this.app.evaluate(() => {
      const state = globalThis.__QQPET_C12_WS_FAULTS__
      return {
        dropProjection: state.dropProjection,
        droppedProjections: state.droppedProjections,
        sentResyncs: state.sentResyncs,
        sentHellos: state.sentHellos,
        sockets: state.sockets,
        dropCommandTypes: [...state.dropCommandTypes],
        droppedCommandFrames: state.droppedCommandFrames.length,
        droppedCommands: state.droppedCommands,
        suppressCommandStatus: state.suppressCommandStatus,
        suppressedCommandStatuses: state.suppressedCommandStatuses,
      }
    })
  }

  async armCommandDrop(commandType) {
    await this.app.evaluate((_electron, type) => {
      const state = globalThis.__QQPET_C12_WS_FAULTS__
      state.dropCommandTypes = [type]
      state.droppedCommandFrames = []
      state.droppedCommands = 0
      state.suppressCommandStatus = true
      state.suppressedCommandStatuses = 0
    }, commandType)
  }

  async replayDroppedCommand({ expectedEpochDelta = 0 } = {}) {
    return await this.app.evaluate((_electron, delta) => {
      const state = globalThis.__QQPET_C12_WS_FAULTS__
      if (state.droppedCommandFrames.length !== 1) {
        throw new Error('expected exactly one dropped command frame, got ' + state.droppedCommandFrames.length)
      }
      const frame = JSON.parse(state.droppedCommandFrames[0])
      if (delta !== 0) {
        if (typeof frame?.command?.payload?.expectedEpoch !== 'number') {
          throw new Error('dropped command has no expectedEpoch to fence')
        }
        frame.command.payload.expectedEpoch += delta
      }
      const socket = state.lastSocket
      if (socket === null) throw new Error('no live WebSocket for replay')
      state.dropCommandTypes = []
      state.suppressCommandStatus = false
      const text = JSON.stringify(frame)
      socket.send(text)
      state.droppedCommandFrames = []
      return { commandType: frame.command?.type ?? '', expectedEpoch: frame?.command?.payload?.expectedEpoch }
    }, expectedEpochDelta)
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

  /**
   * Captures the production preload's ordered projection/event deliveries from
   * this real renderer. The canned event stream is the only way a renderer can
   * observe a scheduled job's server-owned deadline without reading SQLite.
   */
  async installProjectionEventCapture() {
    await this.page.evaluate(() => {
      const capture = { deliveries: 0, events: [], last: null }
      globalThis.__QQPET_C12_PROJECTION_CAPTURE__ = capture
      const record = (projection, events) => {
        capture.deliveries += 1
        capture.last = {
          revision: projection?.revision ?? null,
          eventSeq: projection?.eventSeq ?? null,
          gameTimeMs: projection?.gameTimeMs ?? null,
        }
        if (Array.isArray(events)) capture.events.push(...events)
      }
      window.qqpet.onProjection(record)
      window.qqpet.onResync(record)
    })
  }

  async projectionEventCapture() {
    return await this.page.evaluate(() => {
      const capture = globalThis.__QQPET_C12_PROJECTION_CAPTURE__
      return capture === undefined ? null : {
        deliveries: capture.deliveries,
        events: capture.events,
        last: capture.last,
      }
    })
  }

  /** SIGKILLs the real Electron process; the server must observe a real socket loss. */
  async kill() {
    if (this.closed) return
    this.closed = true
    if (this.app === null) return
    const app = this.app
    const processHandle = app.process()
    const exited = new Promise(resolveExit => {
      if (typeof processHandle.exitCode === 'number') {
        resolveExit()
        return
      }
      processHandle.once('exit', () => resolveExit())
    })
    try {
      processHandle.kill('SIGKILL')
    } catch {
      // A concurrently exited process is still a valid kill outcome.
    }
    await Promise.race([exited, sleep(10_000)])
    this.app = null
    this.page = null
    void app.close().catch(() => {})
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


async function waitForClients(server, expected, label, timeoutMs = 15_000) {
  return await waitFor(async () => {
    const health = await server.health()
    return health.activeClientCount === expected ? health : null
  }, label, timeoutMs)
}

async function createClockedServerFixture(root, label, baseEnv, options = {}) {
  const directory = join(root, label)
  const dbPath = join(directory, 'qqpet.sqlite')
  const backupDir = join(directory, 'backups')
  const restoreGenerationFile = join(directory, 'restore-generation.txt')
  const adminSocket = join(directory, 'admin.sock')
  const credentialFile = join(directory, 'owner-admin-credential.txt')
  const userData = join(directory, 'electron-owner')
  const playerUserData = join(directory, 'electron-player')
  const clockFile = join(directory, 'clock.txt')
  const port = await freePort()
  const serverUrl = 'ws://127.0.0.1:' + port + '/v1/sync'
  const clockMs = options.clockMs ?? TIME_FIXTURE_CLOCK_MS
  await mkdir(directory, { recursive: true })
  await mkdir(backupDir, { recursive: true })
  await mkdir(userData, { recursive: true })
  if (options.withPlayer === true) await mkdir(playerUserData, { recursive: true })
  await writeFile(credentialFile, 'c12-clocked-fixture-owner-admin-credential\n', { mode: 0o600 })
  await writeClockedNow(clockFile, clockMs)
  const env = {
    ...baseEnv,
    QQPET_SYNC_DB: dbPath,
    QQPET_SYNC_BACKUP_DIR: backupDir,
    QQPET_SYNC_RESTORE_GENERATION_FILE: restoreGenerationFile,
    QQPET_ADMIN_SOCKET: adminSocket,
    QQPET_OWNER_ADMIN_CREDENTIAL: credentialFile,
    QQPET_SYNC_PORT: String(port),
    QQPET_SYNC_ADVANCE_WHILE_EMPTY: options.advanceWhileEmpty === false ? '0' : '1',
    QQPET_E2E_CLOCK_FILE: clockFile,
  }
  const initialized = runClockedCli(env, [
    'init', '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京',
  ])
  assert.equal(initialized.ok, true)
  const ownerPairingCode = initialized.pairingCode
  assert.match(ownerPairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
  const paired = runClockedCli(env, ['pair', '--pet-id', 'default', '--role', 'owner'])
  assert.equal(paired.ok, true)
  assert.match(paired.pairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
  let playerPairingCode = ''
  if (options.withPlayer === true) {
    const pairedPlayer = runClockedCli(env, ['pair', '--pet-id', 'default', '--role', 'player'])
    assert.equal(pairedPlayer.ok, true)
    playerPairingCode = pairedPlayer.pairingCode
    assert.match(playerPairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
    assert.notEqual(playerPairingCode, paired.pairingCode)
  }
  let healthToken = ''
  let server = await new ServerProcess({
    port,
    env,
    entry: CLOCKED_SERVER_ENTRY,
    args: ['serve'],
  }).start()
  let app = null
  let playerApp = null
  const fixture = {
    label,
    directory,
    dbPath,
    userData,
    playerUserData,
    clockFile,
    port,
    serverUrl,
    env,
    db: dbPath,
    get server() { return server },
    get app() { return app },
    get player() { return playerApp },
    set player(next) { playerApp = next },
    get pairingCodes() {
      return { owner: paired.pairingCode, player: playerPairingCode }
    },
    async setClock(value) {
      await writeClockedNow(clockFile, value)
    },
    async startServer() {
      assert.equal(server, null, label + ': server is already running')
      server = await new ServerProcess({
        port,
        env,
        entry: CLOCKED_SERVER_ENTRY,
        args: ['serve'],
        authToken: healthToken,
      }).start()
      return server
    },
    async stopServer() {
      if (server === null) return
      const current = server
      server = null
      await current.stop()
    },
    async relaunchApp() {
      assert.notEqual(app, null, label + ': app has not been launched')
      await app.relaunch()
      await app.waitOnline(30_000)
      return app
    },
    async relaunchPlayerApp() {
      assert.notEqual(playerApp, null, label + ': player app has not been launched')
      await playerApp.relaunch()
      await playerApp.waitOnline(30_000)
      return playerApp
    },
    async cleanup() {
      if (playerApp !== null) {
        await playerApp.close().catch(() => {})
        playerApp = null
      }
      if (app !== null) {
        await app.close().catch(() => {})
        app = null
      }
      if (server !== null) {
        await server.stop().catch(() => {})
        server = null
      }
    },
  }
  try {
    app = await new RendererApp({
      label: label + '-owner-renderer',
      userData,
      serverUrl,
    }).launch()
    const pairedStatus = await app.pair(paired.pairingCode, label + ' owner renderer')
    assert.equal(pairedStatus.paired, true)
    healthToken = await app.deviceToken()
    server.setHealthToken(healthToken)
    const status = await app.setServerMode('use-server')
    assert.equal(status.mode, 'server')
    assert.equal(status.activeMode, 'server')
    assert.equal(status.authority.owner, 'server')
    assert.equal(status.authority.state, 'active')
    if (options.adopt !== false) {
      const adopted = await app.command(
        { type: 'pet.adopt', payload: { sex: 'GG' } },
        label + '-adopt',
      )
      assert.equal(adopted.status, 'applied', label + ': adopt rejected: ' + JSON.stringify(adopted.error))
      await waitFor(async () => {
        const projection = await app.projection()
        return projection?.shared?.havePet === true ? projection : null
      }, label + ' pet projection', 20_000)
    }
    if (options.advanceWhileEmpty === false) {
      await app.setAdvanceWhileEmpty(false)
      const updated = await waitFor(async () => {
        const status = await app.storageStatus()
        return status.advanceWhileEmpty === false ? status : null
      }, label + ' advanceWhileEmpty false status', 10_000)
      assert.equal(updated.advanceWhileEmpty, false)
    }
    if (options.withPlayer === true) {
      playerApp = await new RendererApp({
        label: label + '-player-renderer',
        userData: playerUserData,
        serverUrl,
      }).launch()
      const pairedPlayer = await playerApp.pair(playerPairingCode, label + ' player renderer')
      assert.equal(pairedPlayer.paired, true, label + ': player renderer pairing failed')
      await waitForPairedDevice(playerApp, 'player', label + ' player identity')
      const playerMode = await playerApp.setServerMode('use-server')
      assert.equal(playerMode.mode, 'server')
      assert.equal(playerMode.activeMode, 'server')
      assert.equal(playerMode.authority.owner, 'server')
      await playerApp.waitOnline(30_000)
      await waitConverged(app, playerApp, 0, 20_000)
    }
    return fixture
  } catch (error) {
    await fixture.cleanup()
    throw error
  }
}

async function ensureWorkReady(app, label) {
  for (const [stat, amount] of [['growth', 2_000], ['health', 5], ['mood', 1_000], ['hunger', 1_000]]) {
    const result = await app.command(
      { type: 'admin.grantCheat', payload: { stat, amount } },
      label + '-cheat-' + stat,
    )
    assert.equal(result.status, 'applied', label + ': ' + stat + ' fixture rejected: ' + JSON.stringify(result.error))
  }
  const projection = await waitFor(async () => {
    const current = await app.projection()
    return current?.shared?.havePet === true
      && current.shared.petInfo.health === 5
      && current.shared.petInfo.mood > 0
      && current.shared.petComputedlInfo.level >= 2
      ? current
      : null
  }, label + ' work-ready living pet', 10_000)
  return projection
}

async function createLocalHandoffFixture(root, label, baseEnv, clockMs = Date.now()) {
  const directory = join(root, label)
  const dbPath = join(directory, 'qqpet.sqlite')
  const backupDir = join(directory, 'backups')
  const restoreGenerationFile = join(directory, 'restore-generation.txt')
  const adminSocket = join(directory, 'admin.sock')
  const credentialFile = join(directory, 'owner-admin-credential.txt')
  const userData = join(directory, 'electron-owner')
  const clockFile = join(directory, 'clock.txt')
  const port = await freePort()
  const serverUrl = 'ws://127.0.0.1:' + port + '/v1/sync'
  await mkdir(directory, { recursive: true })
  await mkdir(backupDir, { recursive: true })
  await mkdir(userData, { recursive: true })
  await writeFile(credentialFile, 'c12-local-handoff-owner-admin-credential\n', { mode: 0o600 })
  await writeClockedNow(clockFile, clockMs)
  const env = {
    ...baseEnv,
    QQPET_SYNC_DB: dbPath,
    QQPET_SYNC_BACKUP_DIR: backupDir,
    QQPET_SYNC_RESTORE_GENERATION_FILE: restoreGenerationFile,
    QQPET_ADMIN_SOCKET: adminSocket,
    QQPET_OWNER_ADMIN_CREDENTIAL: credentialFile,
    QQPET_SYNC_PORT: String(port),
    QQPET_SYNC_ADVANCE_WHILE_EMPTY: '1',
    QQPET_E2E_CLOCK_FILE: clockFile,
  }
  const initialized = runClockedCli(env, [
    'init', '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京',
  ])
  assert.equal(initialized.ok, true)
  const pairing = runClockedCli(env, ['pair', '--pet-id', 'default', '--role', 'owner'])
  assert.equal(pairing.ok, true)
  let healthToken = ''
  let server = await new ServerProcess({
    port,
    env,
    entry: CLOCKED_SERVER_ENTRY,
    args: ['serve'],
  }).start()
  let app = null
  const fixture = {
    label,
    directory,
    dbPath,
    userData,
    clockFile,
    port,
    serverUrl,
    env,
    get server() { return server },
    get app() { return app },
    async setClock(value) {
      await writeClockedNow(clockFile, value)
    },
    async stopServer() {
      if (server === null) return
      const current = server
      server = null
      await current.stop()
    },
    async cleanup() {
      if (app !== null) {
        await app.close().catch(() => {})
        app = null
      }
      if (server !== null) {
        await server.stop().catch(() => {})
        server = null
      }
    },
  }
  try {
    app = await new RendererApp({
      label: label + '-owner-renderer',
      userData,
      serverUrl,
    }).launch()
    const localStatus = await app.storageStatus()
    assert.equal(localStatus.mode, 'local')
    assert.equal(localStatus.activeMode, 'local')
    const adopted = await app.command(
      { type: 'pet.adopt', payload: { sex: 'MM' } },
      label + '-local-adopt',
    )
    assert.equal(adopted.status, 'applied', label + ': local adopt rejected: ' + JSON.stringify(adopted.error))
    await waitFor(async () => {
      const projection = await app.projection()
      return projection?.shared?.havePet === true
        && projection.authority.owner === 'local'
        && projection.authority.state === 'active'
        ? projection
        : null
    }, label + ' active local projection', 20_000)
    const paired = await app.pair(pairing.pairingCode, label + ' owner renderer')
    assert.equal(paired.paired, true)
    await waitForPairedDevice(app, 'owner', label + ' owner pairing')
    healthToken = await app.deviceToken()
    server.setHealthToken(healthToken)
    return fixture
  } catch (error) {
    await fixture.cleanup()
    throw error
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
    QQPET_SYNC_LOG_LEVEL: 'info',
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
      'The deterministic restart scenario creates its non-empty jobs and sessions through real renderer commands, directly seeds a valid per-day environment into the stopped temporary SQLite fixture, and rewinds the persisted scheduler anchor only while the real server process is stopped. The expected engine/job/session/RNG/environment state is derived with the same compiled canonical runtime as an independent oracle; the live scheduler may advance the wall anchor without another game tick after catch-up.',
      'The fresh-host import source seeds its non-empty local jobs/sessions through the real local runtime, then inserts a valid per-day environment into the stopped temporary LocalRepository document before the real renderer exports it. The fresh server uses a frozen test clock, and the temporary restore-generation fence is written from the reported import generation before the no-double-catch-up restart.',
      'Startup crash repair deliberately SIGSTOPs the real server for 32 seconds so the persisted heartbeat + 30 second grace bound is observably earlier than restart wall time.',
      'Revoked-reconnect testing relaunches a fresh Electron process from a copied userData directory after removing copied Chromium singleton lock files; the same persisted revoked device token is presented to the real server.',
      'Timed-work, advance-while-empty and online/sign-in coverage scenarios run the real standalone SyncServer, SQLite store, command queue and scheduler with a test-only injected wall clock read from an atomically replaced file; this removes real-minute waits without changing server rules or canonical data.',
      'The local-authority fault case drops one already-serialized admin.resumeServer frame and replays it with only expectedEpoch fenced by +1. The portable bundle itself is produced by LocalRepository and is never edited; the resulting server rejection drives the production rollback path.',
      'Local and server timestamps in the handoff scenario share a near-wall clock fixture, but the test clock is not advanced during the final local scheduler run; local archive/freeze assertions compare persisted document hashes rather than wall-clock tick counts.',
      'The renderer-kill, canonical-mutation and secret-boundary scenarios use dedicated real standalone servers with a test-only injected wall clock so revision/event deltas stay exact; they still launch real Electron renderers, drive the production preload API, and exercise real WebSockets, SQLite and captured server logs.',
      'The secret/device-field audit inspects the temporary server SQLite/WAL/schema, device and pairing hash storage, captured server logs, canonical save/engine JSON and renderer projections. It does not scan OS keychains, encrypted Electron safeStorage blobs or process memory.',
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
  let timedBothRendererEvidence = null
  let sessionGradingEvidence = null
  let restartEngineStateEvidence = null
  let importEngineStateEvidence = null

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
      const publicHealth = await server.publicHealth()
      const pragmas = await withDatabase(dbPath, false, db => {
        const journal = db.prepare('PRAGMA journal_mode').get()
        const synchronous = db.prepare('PRAGMA synchronous').get()
        const quickCheck = db.prepare('PRAGMA quick_check').get()
        return {
          journalMode: String(Object.values(journal)[0] ?? '').toLowerCase(),
          synchronous: Number(Object.values(synchronous)[0]) === 2 ? 'full' : String(Object.values(synchronous)[0]),
          quickCheck: String(Object.values(quickCheck)[0] ?? ''),
        }
      })
      assert.equal(publicHealth.ready, true)
      assert.equal(publicHealth.databaseReady, true)
      assert.equal(pragmas.journalMode, 'wal')
      assert.equal(pragmas.synchronous, 'full')
      assert.equal(pragmas.quickCheck, 'ok')
      assert.equal((await readOpenCoverageRows(dbPath)).length, 0)
      report.evidence.database = {
        temporarySqlite: true,
        journalMode: pragmas.journalMode,
        synchronous: pragmas.synchronous,
      }
      return {
        pid: server.child.pid,
        ready: publicHealth.ready,
        journalMode: pragmas.journalMode,
        synchronous: pragmas.synchronous,
        databaseReady: publicHealth.databaseReady,
        quickCheck: pragmas.quickCheck,
        openCoverageRows: 0,
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
      server.setHealthToken(await owner.deviceToken())
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
      await waitConverged(owner, player, news.revision)
      // The daily roll is allowed not to choose a quiz errand. Always seed the
      // canonical SQLite fixture, then read the current server document again
      // so the command uses the exact persisted errand index rather than a
      // possibly stale renderer projection.
      let islandStart = null
      let quizIndex = -1
      let quizErrand = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await seedIslandQuizErrand(dbPath)
        const canonical = await readCanonicalEngine(dbPath)
        const islandState = JSON.parse(String(canonical.save.saveJsonData.island ?? '{}'))
        quizIndex = Array.isArray(islandState.errands)
          ? islandState.errands.findIndex(errand => errand.kind === 'quiz')
          : -1
        assert.ok(quizIndex >= 0, 'island fixture must expose a quiz errand')
        quizErrand = islandState.errands[quizIndex]
        islandStart = await owner.command(
          { type: 'island.startQuiz', payload: { npcId: quizErrand.from, errandId: String(quizIndex) } },
          'c12-session-island-start-' + attempt,
        )
        if (islandStart.status === 'applied') break
        assert.equal(islandStart.error?.code, 'not_available', 'unexpected island.startQuiz rejection: ' + JSON.stringify(islandStart.error))
        await sleep(150)
      }
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

    await step(SCENARIO_SESSION_GRADING, async () => {
      const fixture = await createClockedServerFixture(root, 'session-grading-authority', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
        withPlayer: true,
      })
      try {
        const owner = fixture.app
        const player = fixture.player
        const dbPath = fixture.dbPath
        const answerKeyOnly = new Set(['answerIndex', 'answerKey', 'correctAnswer', 'correctIndex', 'rewardKey'])
        const sessionTokens = []
        const frozenTaskCounters = save => hash(taskCounterSnapshot(save))
        const eventsFor = async (type, predicate = () => true) =>
          (await readEventRows(dbPath, { type })).filter(predicate)
        const assertRejectedUnchanged = async (before, label) => {
          const after = await waitConverged(owner, player, before.revision)
          assert.equal(after.left.revision, before.revision, label + ': rejection must not change revision')
          assert.equal(after.left.eventSeq, before.eventSeq, label + ': rejection must not change eventSeq')
          assert.equal(projectionHash(after.left), projectionHash(before), label + ': rejection must not mutate projection')
          assert.equal(projectionHash(after.right), projectionHash(before), label + ': rejection must not mutate player projection')
          return after
        }
        const advanceClockAndConverge = async (deltaMs, label) => {
          const healthBefore = await fixture.server.health()
          const targetWallMs = healthBefore.gameTimeMs + deltaMs
          await fixture.setClock(targetWallMs)
          return await waitFor(async () => {
            const [health, left, right] = await Promise.all([
              fixture.server.health(),
              owner.projection(),
              player.projection(),
            ])
            if (left === null || right === null) return null
            return health.gameTimeMs >= targetWallMs
              && left.gameTimeMs === health.gameTimeMs
              && right.gameTimeMs === health.gameTimeMs
              && sameProjection(left, right)
              ? { health, left, right, targetWallMs }
              : null
          }, label, 30_000)
        }
        const assertSessionProjectionHygiene = async (label, tokens) => {
          return assertRendererProjectionHygiene(
            { owner: await owner.projection(), player: await player.projection() },
            tokens,
            label,
          )
        }

        await ensureWorkReady(owner, 'session-grading')
        await waitConverged(owner, player, 0, 20_000)
        let hygieneChecks = 0

        // Game: advance the canonical clock before settlement, then prove the
        // GameRound/Game counters and yuanbao delta land exactly once.
        const gameBefore = await waitConverged(owner, player, 0)
        const gameYbBefore = Number(gameBefore.left.shared.petInfo.yb)
        const gameGrowthBefore = Number(gameBefore.left.shared.petInfo.growth)
        const gameTaskBefore = taskCounterSnapshot(gameBefore.left.shared)
        const gameSettledEventBefore = await eventsFor('game.sessionSettled')
        const gameStart = await owner.command(
          { type: 'game.startSession', payload: { gameId: 'c12-grading-game', kind: 'small' } },
          'c12-grading-game-start',
        )
        assert.equal(gameStart.status, 'applied', 'graded game start rejected: ' + JSON.stringify(gameStart.error))
        const gameToken = gameStart.result.sessionToken
        sessionTokens.push(gameToken)
        await waitConverged(owner, player, gameStart.revision, 20_000)
        hygieneChecks += await assertSessionProjectionHygiene('graded game start', [gameToken])
        const gameTokenRow = await withDatabase(dbPath, false, db => db.prepare(
          'SELECT status, actor_device_id FROM game_sessions WHERE pet_id = ? AND session_token = ?',
        ).get('default', gameToken))
        assert.equal(gameTokenRow?.status, 'active')
        assert.equal(typeof gameTokenRow?.actor_device_id, 'string')

        const gameClock = await advanceClockAndConverge(2 * 60_000, 'graded game clock advance')
        assert.equal(gameClock.targetWallMs - gameClock.health.gameTimeMs, 0)
        const gameBeforeSettle = await waitConverged(owner, player, 0)
        const gameReward = await owner.command(
          { type: 'game.reward', payload: { sessionToken: gameToken } },
          'c12-grading-game-reward',
        )
        assert.equal(gameReward.status, 'applied', 'graded game reward rejected: ' + JSON.stringify(gameReward.error))
        assert.equal(gameReward.result.minutes, 2)
        assert.equal(gameReward.result.gameRound, 1)
        assert.ok(Number.isSafeInteger(gameReward.result.yb) && gameReward.result.yb > 0)
        assert.ok(Number(gameReward.result.growth) > 0)
        const gameSettled = await waitConverged(owner, player, gameReward.revision, 20_000)
        const gameTaskAfter = taskCounterSnapshot(gameSettled.left.shared)
        assert.equal(gameTaskAfter.GameRound, gameTaskBefore.GameRound + 1, 'game reward must increment GameRound once')
        assert.equal(gameTaskAfter.Game, gameTaskBefore.Game + 2, 'game reward must increment Game by elapsed minutes')
        assert.equal(Number(gameSettled.left.shared.petInfo.yb), gameYbBefore + Number(gameReward.result.yb))
        assert.equal(Number(gameSettled.right.shared.petInfo.yb), gameYbBefore + Number(gameReward.result.yb))
        const gameGrowthDelta = Number(gameSettled.left.shared.petInfo.growth) - gameGrowthBefore
        const tickGrowthDelta = Number(gameBeforeSettle.left.shared.petInfo.growth) - gameGrowthBefore
        assert.ok(Math.abs((gameGrowthDelta - tickGrowthDelta) - Number(gameReward.result.growth)) < 1e-6)
        const gameSettledEvents = await eventsFor('game.sessionSettled', event => event.payload.gameId === 'c12-grading-game')
        assert.equal(gameSettledEvents.length, gameSettledEventBefore.filter(event => event.payload.gameId === 'c12-grading-game').length + 1)
        assert.equal(gameSettledEvents.at(-1).gameTimeMs, gameClock.health.gameTimeMs)
        hygieneChecks += await assertSessionProjectionHygiene('graded game settled', [gameToken])
        const gameReplay = await owner.command(
          { type: 'game.reward', payload: { sessionToken: gameToken } },
          'c12-grading-game-replay',
        )
        assert.equal(gameReplay.status, 'rejected')
        assert.equal(gameReplay.error?.code, 'already_claimed')
        await assertRejectedUnchanged(gameSettled.right, 'graded game replay')
        const gameEventsAfterReplay = await eventsFor('game.sessionSettled', event => event.payload.gameId === 'c12-grading-game')
        assert.equal(gameEventsAfterReplay.length, gameSettledEvents.length, 'game replay must not emit a second settle event')
        assert.equal(hash(taskCounterSnapshot(gameSettled.right.shared)), frozenTaskCounters(gameSettled.right.shared))

        // Diudiule: exact +1 yb and one settle event; no task-counter drift.
        const diudiuleBefore = await waitConverged(owner, player, gameSettled.right.revision)
        const diudiuleYbBefore = Number(diudiuleBefore.left.shared.petInfo.yb)
        const diudiuleTaskBefore = taskCounterSnapshot(diudiuleBefore.left.shared)
        const diudiuleSettleEventsBefore = await eventsFor('game.sessionSettled', event => event.payload.gameId === 'diudiule')
        const diudiuleStart = await owner.command(
          { type: 'diudiule.startSession', payload: {} },
          'c12-grading-diudiule-start',
        )
        assert.equal(diudiuleStart.status, 'applied', 'diudiule start rejected: ' + JSON.stringify(diudiuleStart.error))
        const diudiuleToken = diudiuleStart.result.sessionToken
        sessionTokens.push(diudiuleToken)
        await waitConverged(owner, player, diudiuleStart.revision)
        hygieneChecks += await assertSessionProjectionHygiene('graded diudiule start', [diudiuleToken])
        const diudiuleClock = await advanceClockAndConverge(60_000, 'graded diudiule clock advance')
        const diudiuleBeforeSettle = await waitConverged(owner, player, 0)
        const diudiuleReward = await owner.command(
          { type: 'diudiule.reward', payload: { sessionToken: diudiuleToken } },
          'c12-grading-diudiule-reward',
        )
        assert.equal(diudiuleReward.status, 'applied', 'diudiule reward rejected: ' + JSON.stringify(diudiuleReward.error))
        assert.equal(diudiuleReward.result.yb, 1)
        const diudiuleSettled = await waitConverged(owner, player, diudiuleReward.revision)
        assert.equal(Number(diudiuleSettled.left.shared.petInfo.yb), diudiuleYbBefore + 1)
        assert.equal(Number(diudiuleSettled.right.shared.petInfo.yb), diudiuleYbBefore + 1)
        assert.equal(hash(taskCounterSnapshot(diudiuleSettled.left.shared)), hash(diudiuleTaskBefore), 'diudiule must not change task counters')
        const diudiuleSettleEventsAfter = await eventsFor('game.sessionSettled', event => event.payload.gameId === 'diudiule')
        assert.equal(diudiuleSettleEventsAfter.length, diudiuleSettleEventsBefore.length + 1)
        assert.equal(diudiuleSettleEventsAfter.at(-1).gameTimeMs, diudiuleClock.health.gameTimeMs)
        const diudiuleReplay = await owner.command(
          { type: 'diudiule.reward', payload: { sessionToken: diudiuleToken } },
          'c12-grading-diudiule-replay',
        )
        assert.equal(diudiuleReplay.status, 'rejected')
        assert.equal(diudiuleReplay.error?.code, 'already_claimed')
        await assertRejectedUnchanged(diudiuleSettled.right, 'graded diudiule replay')
        assert.equal((await eventsFor('game.sessionSettled', event => event.payload.gameId === 'diudiule')).length, diudiuleSettleEventsAfter.length)
        assert.equal(Number((await owner.projection()).shared.petInfo.yb), diudiuleYbBefore + 1)

        // Exam: the answer key must be read back from the temporary SQlite
        // session payload, then graded correct through the real renderer.
        await seedExamLessons(dbPath, 9)
        const examBeforeEngine = await readCanonicalEngine(dbPath)
        const examTaskBefore = taskCounterSnapshot(examBeforeEngine.save)
        const examStudyBefore = Number(examBeforeEngine.save.studyInfo.chinese ?? 0)
        const examYbBefore = Number(examBeforeEngine.save.petInfo.yb)
        const examCompletedBefore = await eventsFor('activity.completed', event =>
          event.payload.kind === 'exam' && event.payload.subject === 'xx-chinese')
        const examStart = await owner.command(
          { type: 'exam.start', payload: { subject: 'xx-chinese' } },
          'c12-grading-exam-start',
        )
        assert.equal(examStart.status, 'applied', 'graded exam start rejected: ' + JSON.stringify(examStart.error))
        const examToken = examStart.result.sessionToken
        sessionTokens.push(examToken)
        assert.equal(examStart.result.questions.length, 3)
        assert.deepEqual(findKeys(examStart.result, answerKeyOnly), [], 'exam start result must not expose answer keys')
        await waitConverged(owner, player, examStart.revision)
        hygieneChecks += await assertSessionProjectionHygiene('graded exam start', [examToken])
        const storedExam = await readSessionPayload(dbPath, examToken)
        assert.equal(storedExam.kind, 'exam')
        assert.equal(storedExam.status, 'active')
        assert.equal(storedExam.payload.kind, 'exam')
        assert.equal(storedExam.payload.questions.length, 3)
        const examAnswers = storedExam.payload.questions.map((question, index) => {
          assert.ok(Number.isSafeInteger(question.answerIndex), 'stored exam answer must be an integer at question ' + String(index))
          assert.ok(question.answerIndex >= 0 && question.answerIndex < question.options.length)
          return question.answerIndex
        })
        const expectedExamProjection = storedExam.payload.questions.map(question => ({
          questionId: question.questionId,
          prompt: question.prompt,
          options: question.options,
        }))
        assert.equal(hash(examStart.result.questions), hash(expectedExamProjection), 'exam projection must match the persisted session questions')
        const examClock = await advanceClockAndConverge(2 * 60_000, 'graded exam clock advance')
        const examBeforeSettle = await waitConverged(owner, player, 0)
        const examSubmit = await owner.command(
          { type: 'exam.submit', payload: { sessionToken: examToken, answers: examAnswers } },
          'c12-grading-exam-submit-correct',
        )
        assert.equal(examSubmit.status, 'applied', 'graded exam submit rejected: ' + JSON.stringify(examSubmit.error))
        assert.equal(examSubmit.result.passed, true)
        assert.equal(examSubmit.result.correctCount, 3)
        assert.equal(examSubmit.result.total, 3)
        assert.deepEqual(findKeys(examSubmit.result, answerKeyOnly), [], 'exam grading result must not expose answer keys')
        const examSettled = await waitConverged(owner, player, examSubmit.revision)
        assert.equal(Number(examSettled.left.shared.studyInfo.chinese), examStudyBefore + 1)
        assert.equal(Number(examSettled.right.shared.studyInfo.chinese), examStudyBefore + 1)
        assert.equal(Number(examSettled.left.shared.petInfo.yb), examYbBefore, 'passing an exam must not invent a yuanbao reward')
        assert.equal(hash(taskCounterSnapshot(examSettled.left.shared)), hash(examTaskBefore), 'exam settlement must not change task counters')
        const examCompletedAfter = await eventsFor('activity.completed', event =>
          event.payload.kind === 'exam' && event.payload.subject === 'xx-chinese')
        assert.equal(examCompletedAfter.length, examCompletedBefore.length + 1)
        assert.equal(examCompletedAfter.at(-1).gameTimeMs, examClock.health.gameTimeMs)
        assert.equal(examCompletedAfter.at(-1).payload.correctCount, 3)
        assert.equal(examCompletedAfter.at(-1).payload.total, 3)
        assert.equal(examCompletedAfter.at(-1).payload.passed, true)
        hygieneChecks += await assertSessionProjectionHygiene('graded exam settled', [examToken])
        const examReplay = await owner.command(
          { type: 'exam.submit', payload: { sessionToken: examToken, answers: examAnswers } },
          'c12-grading-exam-replay',
        )
        assert.equal(examReplay.status, 'rejected')
        assert.equal(examReplay.error?.code, 'already_claimed')
        await assertRejectedUnchanged(examSettled.right, 'graded exam replay')
        assert.equal(Number((await owner.projection()).shared.studyInfo.chinese), examStudyBefore + 1)
        assert.equal((await eventsFor('activity.completed', event =>
          event.payload.kind === 'exam' && event.payload.subject === 'xx-chinese')).length, examCompletedAfter.length)

        // Island quiz: read the server-only option index from SQLite, answer
        // correctly, and assert every granted good is added exactly once.
        let islandStart = null
        let quizIndex = -1
        let quizErrand = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await seedIslandQuizErrand(dbPath)
          const canonical = await readCanonicalEngine(dbPath)
          const islandState = JSON.parse(String(canonical.save.saveJsonData.island ?? '{}'))
          quizIndex = Array.isArray(islandState.errands)
            ? islandState.errands.findIndex(errand => errand.kind === 'quiz')
            : -1
          assert.ok(quizIndex >= 0, 'island grading fixture must expose a quiz errand')
          quizErrand = islandState.errands[quizIndex]
          islandStart = await owner.command(
            { type: 'island.startQuiz', payload: { npcId: quizErrand.from, errandId: String(quizIndex) } },
            'c12-grading-island-start-' + String(attempt),
          )
          if (islandStart.status === 'applied') break
          assert.equal(islandStart.error?.code, 'not_available', 'unexpected island start rejection: ' + JSON.stringify(islandStart.error))
          await sleep(150)
        }
        assert.equal(islandStart.status, 'applied', 'graded island quiz start rejected: ' + JSON.stringify(islandStart.error))
        const islandToken = islandStart.result.sessionToken
        sessionTokens.push(islandToken)
        assert.deepEqual(findKeys(islandStart.result, answerKeyOnly), [], 'island quiz start must not expose answer keys')
        await waitConverged(owner, player, islandStart.revision)
        hygieneChecks += await assertSessionProjectionHygiene('graded island start', [islandToken])
        const storedIsland = await readSessionPayload(dbPath, islandToken)
        assert.equal(storedIsland.kind, 'island_quiz')
        assert.equal(storedIsland.status, 'active')
        assert.equal(storedIsland.payload.kind, 'island_quiz')
        assert.equal(islandStart.result.recordId, storedIsland.payload.recordId)
        assert.equal(islandStart.result.quizKind, storedIsland.payload.quizKind)
        assert.equal(islandStart.result.prompt, storedIsland.payload.prompt)
        assert.equal(hash(islandStart.result.options), hash(storedIsland.payload.options))
        const islandAnswerIndex = storedIsland.payload.answerIndex
        assert.ok(Number.isSafeInteger(islandAnswerIndex))
        assert.ok(islandAnswerIndex >= 0 && islandAnswerIndex < storedIsland.payload.options.length)
        const islandBeforeEngine = await readCanonicalEngine(dbPath)
        const islandGoodsBefore = new Map()
        for (const type of ['nums', 'food', 'toy', 'clean', 'medicine', 'background', 'service']) {
          if (Array.isArray(islandBeforeEngine.save.selfGoodDatas?.[type])) {
            for (const entry of islandBeforeEngine.save.selfGoodDatas[type]) {
              const match = typeof entry === 'string' ? /^_(.+)\*(\d+)$/.exec(entry) : null
              if (match !== null) islandGoodsBefore.set(type + '/' + match[1], Number(match[2]))
            }
          }
        }
        const islandRewardEventsBefore = await eventsFor('island.rewardGranted')
        const islandPassedEventsBefore = await eventsFor('island.errandChanged', event => event.payload.status === 'quiz_passed')
        const islandClock = await advanceClockAndConverge(60_000, 'graded island clock advance')
        const islandBeforeSettle = await waitConverged(owner, player, 0)
        const islandAnswer = await owner.command(
          { type: 'island.answerQuiz', payload: { sessionToken: islandToken, optionIndex: islandAnswerIndex } },
          'c12-grading-island-answer-correct',
        )
        assert.equal(islandAnswer.status, 'applied', 'graded island answer rejected: ' + JSON.stringify(islandAnswer.error))
        assert.equal(islandAnswer.result.correct, true)
        assert.ok(Array.isArray(islandAnswer.result.goods) && islandAnswer.result.goods.length >= 1)
        assert.deepEqual(findKeys(islandAnswer.result, answerKeyOnly), [], 'island answer result must not expose answer keys')
        const islandSettled = await waitConverged(owner, player, islandAnswer.revision)
        for (const good of islandAnswer.result.goods) {
          const key = String(good.type) + '/' + String(good.id)
          const expected = (islandGoodsBefore.get(key) ?? 0) + Number(good.num)
          assert.equal(inventoryCount(islandSettled.left.shared, String(good.type), String(good.id)), expected, 'island reward good must be credited exactly once: ' + key)
          assert.equal(inventoryCount(islandSettled.right.shared, String(good.type), String(good.id)), expected, 'player projection must receive island reward exactly once: ' + key)
        }
        const islandStateAfter = JSON.parse(String(islandSettled.left.shared.saveJsonData.island ?? '{}'))
        const islandErrandAfter = islandStateAfter.errands?.[quizIndex]
        assert.notEqual(islandErrandAfter, undefined)
        assert.equal(islandErrandAfter.got, 1)
        assert.equal(islandErrandAfter.took, true)
        const islandRewardEventsAfter = await eventsFor('island.rewardGranted')
        const islandPassedEventsAfter = await eventsFor('island.errandChanged', event => event.payload.status === 'quiz_passed')
        assert.equal(islandRewardEventsAfter.length, islandRewardEventsBefore.length + 1)
        assert.equal(islandPassedEventsAfter.length, islandPassedEventsBefore.length + 1)
        assert.equal(islandRewardEventsAfter.at(-1).gameTimeMs, islandClock.health.gameTimeMs)
        hygieneChecks += await assertSessionProjectionHygiene('graded island settled', [islandToken])
        const islandReplay = await owner.command(
          { type: 'island.answerQuiz', payload: { sessionToken: islandToken, optionIndex: islandAnswerIndex } },
          'c12-grading-island-replay',
        )
        assert.equal(islandReplay.status, 'rejected')
        assert.equal(islandReplay.error?.code, 'already_claimed')
        await assertRejectedUnchanged(islandSettled.right, 'graded island replay')
        assert.equal((await eventsFor('island.rewardGranted')).length, islandRewardEventsAfter.length, 'island replay must not grant a second reward')
        for (const good of islandAnswer.result.goods) {
          const key = String(good.type) + '/' + String(good.id)
          const expected = (islandGoodsBefore.get(key) ?? 0) + Number(good.num)
          assert.equal(inventoryCount((await owner.projection()).shared, String(good.type), String(good.id)), expected)
        }

        const finalProjection = await waitConverged(owner, player, islandSettled.right.revision)
        const activeSessions = await withDatabase(dbPath, false, db => db.prepare(
          "SELECT COUNT(*) AS count FROM game_sessions WHERE pet_id = ? AND status = 'active'",
        ).get('default'))
        assert.equal(Number(activeSessions.count), 0, 'all graded sessions must be settled')
        sessionGradingEvidence = {
          sessionKinds: ['game', 'diudiule', 'exam', 'island_quiz'],
          clockAdvancedBeforeEverySettlement: true,
          gameElapsedGameMinutes: Number(gameReward.result.minutes),
          gameYbDelta: Number(gameSettled.left.shared.petInfo.yb) - gameYbBefore,
          gameRoundDelta: gameSettled.left.shared ? taskCounterSnapshot(gameSettled.left.shared).GameRound - gameTaskBefore.GameRound : 0,
          gameCounterDelta: taskCounterSnapshot(gameSettled.left.shared).Game - gameTaskBefore.Game,
          gameSettleEventCount: gameSettledEvents.length,
          gameReplayEventCount: gameEventsAfterReplay.length,
          diudiuleYbDelta: Number(diudiuleSettled.left.shared.petInfo.yb) - diudiuleYbBefore,
          diudiuleSettleEventCount: diudiuleSettleEventsAfter.length,
          examStoredAnswerKeyHash: hash(examAnswers),
          examCorrectCount: Number(examSubmit.result.correctCount),
          examTotal: Number(examSubmit.result.total),
          examPassed: examSubmit.result.passed === true,
          examStudyDelta: Number(examSettled.left.shared.studyInfo.chinese) - examStudyBefore,
          examCompletedEventCount: examCompletedAfter.length,
          examTaskCountersUnchanged: hash(taskCounterSnapshot(examSettled.left.shared)) === hash(examTaskBefore),
          islandStoredAnswerKeyHash: hash(islandAnswerIndex),
          islandCorrect: islandAnswer.result.correct === true,
          islandGoodKinds: islandAnswer.result.goods.map(good => String(good.type) + '/' + String(good.id)),
          islandGoodCount: islandAnswer.result.goods.length,
          islandRewardEventCount: islandRewardEventsAfter.length,
          islandPassEventCount: islandPassedEventsAfter.length,
          islandReplayRewardEventCount: (await eventsFor('island.rewardGranted')).length,
          answerKeyProjectionChecks: hygieneChecks,
          answerKeysProjected: false,
          answerKeysStoredServerSide: true,
          activeSessionsAfter: Number(activeSessions.count),
          bothRenderersConverged: projectionHash(finalProjection.left) === projectionHash(finalProjection.right),
          sessionTokenHashes: sessionTokens.map(token => hash(token)),
        }
        return sessionGradingEvidence
      } finally {
        await fixture.cleanup()
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
      const freshClockFile = join(freshRoot, 'clock.txt')
      const freshClockMs = Date.now()
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
        QQPET_E2E_CLOCK_FILE: freshClockFile,
      }
      await mkdir(freshOwnerProfile, { recursive: true })
      await mkdir(freshPlayerProfile, { recursive: true })
      await mkdir(freshBackupDir, { recursive: true })
      await writeFile(freshCredentialFile, 'c12-fresh-host-owner-admin-credential\n', { mode: 0o600 })
      await writeClockedNow(freshClockFile, freshClockMs)
      const initialized = runClockedCli(freshEnv, [
        'init', '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京',
      ])
      assert.equal(initialized.ok, true)
      const pairedPlayer = runClockedCli(freshEnv, ['pair', '--pet-id', 'default', '--role', 'player'])
      freshOwnerPairingCode = initialized.pairingCode
      freshPlayerPairingCode = pairedPlayer.pairingCode
      freshServer = await new ServerProcess({
        port: freshPort,
        env: freshEnv,
        entry: CLOCKED_SERVER_ENTRY,
        args: ['serve'],
      }).start()

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
      await ensureWorkReady(freshHostOwner, 'fresh-source-local')
      const sourceGame = await freshHostOwner.command(
        { type: 'game.startSession', payload: { gameId: 'c12-import-game', kind: 'small' } },
        'c12-fresh-source-game-start',
      )
      assert.equal(sourceGame.status, 'applied', 'local source game start rejected: ' + JSON.stringify(sourceGame.error))
      rawSessionTokens.push(sourceGame.result.sessionToken)
      const sourceDiudiule = await freshHostOwner.command(
        { type: 'diudiule.startSession', payload: {} },
        'c12-fresh-source-diudiule-start',
      )
      assert.equal(sourceDiudiule.status, 'applied', 'local source diudiule start rejected: ' + JSON.stringify(sourceDiudiule.error))
      rawSessionTokens.push(sourceDiudiule.result.sessionToken)
      const sourceWork = await freshHostOwner.command(
        { type: 'job.startWork', payload: { jobId: 'bz' } },
        'c12-fresh-source-work-start',
      )
      assert.equal(sourceWork.status, 'applied', 'local source work start rejected: ' + JSON.stringify(sourceWork.error))
      const sourceWorkJobId = Number(sourceWork.result.jobId)
      const sourceWorkDueAtGameMs = Number(sourceWork.result.dueAtGameMs)
      await waitFor(async () => {
        const projection = await freshHostOwner.projection()
        return projection?.shared?.activeOption?.work === 'bz' ? projection : null
      }, 'fresh local source timed work projection', 10_000)

      await freshHostOwner.close()
      freshHostOwner = null
      const localEnvironmentSeed = await seedLocalDocumentEnvironment(freshOwnerProfile, 'c12-fresh-import')
      freshHostOwner = await new RendererApp({
        label: 'fresh-host-owner-renderer',
        userData: freshOwnerProfile,
        serverUrl: freshServerUrl,
      }).launch()
      const relaunchedLocalStatus = await freshHostOwner.storageStatus()
      assert.equal(relaunchedLocalStatus.mode, 'local')
      const localRestartProjection = await waitFor(async () => {
        const projection = await freshHostOwner.projection()
        return projection?.shared?.havePet === true
          && projection.shared?.activeOption?.work === 'bz'
          ? projection
          : null
      }, 'fresh local source projection after environment seed', 20_000)
      assert.equal(localRestartProjection.authority.owner, 'local')
      const exported = await freshHostOwner.exportBundle()
      assert.equal(exported.mode, 'local')
      const bundle = JSON.parse(exported.json)
      assert.equal(bundle.authority.owner, 'local')
      assert.equal(bundle.shared.havePet, true)
      assert.ok(bundle.engine.scheduledJobs.length >= 3, 'source bundle must contain scheduled jobs')
      assert.ok(bundle.engine.gameSessions.length >= 2, 'source bundle must contain game sessions')
      assert.ok(bundle.engine.scheduledJobs.some(job => job.id === sourceWorkJobId && job.status === 'pending' && job.dueAtGameMs === sourceWorkDueAtGameMs))
      assert.match(String(bundle.engine.rng?.seedHex ?? ''), /^[0-9a-f]{32}$/)
      assert.match(String(bundle.engine.rng?.stateHex ?? ''), /^[0-9a-f]{32}$/)
      assert.ok(Number.isSafeInteger(bundle.engine.rng?.draws))
      assert.ok(Object.keys(bundle.engine.environment?.weatherByDay ?? {}).includes(localEnvironmentSeed.dayKey), 'source bundle must contain the seeded per-day weather')
      assert.ok(Object.keys(bundle.engine.environment?.calendarByDay ?? {}).includes(localEnvironmentSeed.dayKey), 'source bundle must contain the seeded per-day calendar')
      assert.ok(typeof bundle.engine.lastProcessedDayBoundaryKey === 'string' && bundle.engine.lastProcessedDayBoundaryKey.length > 0)
      assert.ok(Number.isSafeInteger(bundle.engine.nextDailyBoundaryMs) && bundle.engine.nextDailyBoundaryMs > bundle.engine.gameTimeMs)
      assert.ok(Number.isSafeInteger(bundle.engine.lastSchedulerWallMs))
      const sourceActiveSessions = bundle.engine.gameSessions.filter(session => session.status === 'active')
      assert.ok(sourceActiveSessions.length >= 2)
      assert.ok(sourceActiveSessions.every(session => session.actorDeviceId === bundle.originLocalDeviceId), 'local source sessions must be bound to the source local device')

      const pairedOwner = await freshHostOwner.pair(freshOwnerPairingCode, 'C12 fresh host owner')
      assert.equal(pairedOwner.paired, true)
      const freshOwnerPairedStatus = await waitForPairedDevice(
        freshHostOwner,
        'owner',
        'fresh host owner identity after pairing',
      )
      freshOwnerDeviceId = freshOwnerPairedStatus.deviceId
      freshServer.setHealthToken(await freshHostOwner.deviceToken())
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
      staleBundle.engine.lastSchedulerWallMs = freshClockMs + 6 * 60_000
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
      assert.equal(imported.importClamped, true, 'future-anchor import must report a clamp; report=' + JSON.stringify(imported) + ' staleAnchor=' + String(staleBundle.engine.lastSchedulerWallMs) + ' now=' + String(freshClockMs))
      assert.ok(Number(imported.clockSkippedMs) < 0, 'future-anchor clamp must report the negative clock correction')
      assert.equal(imported.effectiveAnchorWallMs, freshClockMs, 'clamped import must anchor exactly at the frozen wall clock')
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

      const { dayKeyAt, nextDailyBoundaryMs } = await loadRuntimeOracle()
      const expectedImportedEngine = structuredClone(bundle.engine)
      expectedImportedEngine.gameTimeMs += imported.clockSkippedMs
      expectedImportedEngine.lastSchedulerWallMs = imported.effectiveAnchorWallMs
      expectedImportedEngine.importClamped = true
      expectedImportedEngine.clockSkippedMs = imported.clockSkippedMs
      expectedImportedEngine.save.nowTimeLine = Math.floor(expectedImportedEngine.gameTimeMs / 1000)
      expectedImportedEngine.lastProcessedDayBoundaryKey = dayKeyAt(expectedImportedEngine.gameTimeMs, expectedImportedEngine.timeZone)
      expectedImportedEngine.nextDailyBoundaryMs = nextDailyBoundaryMs(expectedImportedEngine.gameTimeMs, expectedImportedEngine.timeZone)
      for (const job of expectedImportedEngine.scheduledJobs) {
        job.dueAtGameMs += imported.clockSkippedMs
        if (typeof job.payload?.startedAtGameMs === 'number') job.payload.startedAtGameMs += imported.clockSkippedMs
      }
      for (const session of expectedImportedEngine.gameSessions) {
        session.startedAtGameMs += imported.clockSkippedMs
        session.expiresAtGameMs += imported.clockSkippedMs
        if (session.status === 'active' && session.actorDeviceId === bundle.originLocalDeviceId) {
          session.actorDeviceId = freshOwnerDeviceId
        }
      }
      const importedEngine = await readCanonicalEngine(freshDbPath)
      assert.equal(importedEngine.gameTimeMs, expectedGameTimeMs)
      assert.equal(importedEngine.lastSchedulerWallMs, imported.effectiveAnchorWallMs, 'imported anchor must equal the reported effective wall anchor')
      assert.equal(importedEngine.gameTimeMs, expectedImportedEngine.gameTimeMs)
      assert.equal(importedEngine.timeZone, bundle.engine.timeZone)
      assert.equal(importedEngine.advanceWhileEmpty, bundle.engine.advanceWhileEmpty)
      assert.equal(importedEngine.weatherLocation, bundle.engine.weatherLocation)
      assert.equal(importedEngine.lastProcessedDayBoundaryKey, expectedImportedEngine.lastProcessedDayBoundaryKey, 'imported day-boundary key must match the clamped source')
      assert.equal(importedEngine.nextDailyBoundaryMs, expectedImportedEngine.nextDailyBoundaryMs, 'imported next day boundary must match the clamped source')
      assert.equal(stableHash(importedEngine.rng), stableHash(bundle.engine.rng), 'imported RNG state must match the source bundle')
      assert.equal(stableHash(importedEngine.environment), stableHash(bundle.engine.environment), 'imported per-day environment must match the source bundle')
      assert.equal(
        stableHash(normalizeScheduledJobs(importedEngine.scheduledJobs)),
        stableHash(normalizeScheduledJobs(expectedImportedEngine.scheduledJobs)),
        'imported jobs must match the clamped source deadlines',
      )
      assert.equal(
        stableHash(normalizeGameSessions(importedEngine.gameSessions)),
        stableHash(normalizeGameSessions(expectedImportedEngine.gameSessions)),
        'imported sessions must match the clamped and rebound source sessions',
      )
      assert.equal(importedEngine.scheduledJobs.length, bundle.engine.scheduledJobs.length)
      assert.equal(importedEngine.gameSessions.length, bundle.engine.gameSessions.length)
      assert.ok(importedEngine.scheduledJobs.length >= 3)
      assert.ok(importedEngine.gameSessions.length >= 2)
      assert.ok(importedEngine.gameSessions.filter(session => session.status === 'active')
        .every(session => session.actorDeviceId === freshOwnerDeviceId), 'imported local sessions must be rebound to the destination owner device')
      assert.ok(importedEngine.gameSessions.filter(session => session.payload.kind === 'exam').length === 0)
      const importedCountsBeforeRestart = await readPersistedCounts(freshDbPath)
      const importedHealthBeforeRestart = await freshServer.health()
      assert.equal(importedHealthBeforeRestart.gameTimeMs, expectedGameTimeMs)
      assert.equal(importedHealthBeforeRestart.revision, importedConverged.left.revision)
      assert.equal(importedHealthBeforeRestart.eventSeq, importedConverged.left.eventSeq)

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

      // Restart the fresh host at the same frozen wall clock. The import anchor
      // must not replay consumed time or duplicate jobs/sessions/events.
      // The imported authority carries a non-zero restore generation, so an
      // operator fence file must record that exact generation before restart.
      await writeFile(freshRestoreGenerationFile, String(imported.restoreGenerationAfter) + '\n')
      const freshHealthToken = freshServer.authToken
      await freshServer.crash()
      freshServer = await new ServerProcess({
        port: freshPort,
        env: freshEnv,
        entry: CLOCKED_SERVER_ENTRY,
        args: ['serve'],
        authToken: freshHealthToken,
      }).start()
      const restartedFreshHealth = await freshServer.health()
      assert.equal(restartedFreshHealth.ready, true)
      assert.equal(restartedFreshHealth.gameTimeMs, importedHealthBeforeRestart.gameTimeMs, 'fresh import restart must not catch up the same interval again')
      assert.equal(restartedFreshHealth.revision, importedHealthBeforeRestart.revision, 'fresh import restart must not commit a duplicate revision')
      assert.equal(restartedFreshHealth.eventSeq, importedHealthBeforeRestart.eventSeq, 'fresh import restart must not commit duplicate events')
      const importedEngineAfterRestart = await readCanonicalEngine(freshDbPath)
      const importedCountsAfterRestart = await readPersistedCounts(freshDbPath)
      assert.equal(stableHash(normalizeScheduledJobs(importedEngineAfterRestart.scheduledJobs)), stableHash(normalizeScheduledJobs(importedEngine.scheduledJobs)))
      assert.equal(stableHash(normalizeGameSessions(importedEngineAfterRestart.gameSessions)), stableHash(normalizeGameSessions(importedEngine.gameSessions)))
      assert.equal(stableHash(importedEngineAfterRestart.rng), stableHash(importedEngine.rng))
      assert.equal(stableHash(importedEngineAfterRestart.environment), stableHash(importedEngine.environment))
      assert.equal(importedEngineAfterRestart.lastSchedulerWallMs, importedEngine.lastSchedulerWallMs)
      assert.equal(importedEngineAfterRestart.lastProcessedDayBoundaryKey, importedEngine.lastProcessedDayBoundaryKey)
      assert.equal(importedEngineAfterRestart.nextDailyBoundaryMs, importedEngine.nextDailyBoundaryMs)
      assert.equal(importedCountsAfterRestart.commandRows, importedCountsBeforeRestart.commandRows)
      assert.equal(importedCountsAfterRestart.eventRows, importedCountsBeforeRestart.eventRows)
      assert.equal(importedCountsAfterRestart.duplicateOpIds, 0)
      assert.equal(importedCountsAfterRestart.duplicateEventSeqs, 0)
      await waitFor(async () => {
        const ownerStatus = await freshHostOwner.storageStatus()
        const playerStatus = await freshHostPlayer.storageStatus()
        return ownerStatus.connection === 'online' && playerStatus.connection === 'online' ? true : null
      }, 'fresh host renderers reconnect after import restart', 30_000)
      const importedAfterRestart = await waitFor(async () => {
        const left = await freshHostOwner.projection()
        const right = await freshHostPlayer.projection()
        if (left === null || right === null) return null
        return left.gameTimeMs === expectedGameTimeMs
          && right.gameTimeMs === expectedGameTimeMs
          && left.revision === importedConverged.left.revision
          && right.revision === importedConverged.left.revision
          && left.eventSeq === importedConverged.left.eventSeq
          && right.eventSeq === importedConverged.left.eventSeq
          && sameProjection(left, right)
          ? { left, right }
          : null
      }, 'fresh host exact projection after import restart', 30_000)
      assert.equal(projectionHash(importedAfterRestart.left), hash(expectedShared))
      assert.equal(projectionHash(importedAfterRestart.right), hash(expectedShared))

      importEngineStateEvidence = {
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
        sourceJobCount: bundle.engine.scheduledJobs.length,
        importedJobCount: importedEngine.scheduledJobs.length,
        sourceSessionCount: bundle.engine.gameSessions.length,
        importedSessionCount: importedEngine.gameSessions.length,
        sourceRngHash: stableHash(bundle.engine.rng),
        importedRngHash: stableHash(importedEngine.rng),
        rngPreserved: stableHash(importedEngine.rng) === stableHash(bundle.engine.rng),
        sourceEnvironmentHash: stableHash(bundle.engine.environment),
        importedEnvironmentHash: stableHash(importedEngine.environment),
        environmentPreserved: stableHash(importedEngine.environment) === stableHash(bundle.engine.environment),
        weatherKeys: Object.keys(bundle.engine.environment.weatherByDay),
        calendarKeys: Object.keys(bundle.engine.environment.calendarByDay ?? {}),
        sourceDayBoundaryKey: bundle.engine.lastProcessedDayBoundaryKey,
        importedDayBoundaryKey: importedEngine.lastProcessedDayBoundaryKey,
        expectedDayBoundaryKey: expectedImportedEngine.lastProcessedDayBoundaryKey,
        dayBoundaryPreserved: importedEngine.lastProcessedDayBoundaryKey === expectedImportedEngine.lastProcessedDayBoundaryKey
          && importedEngine.nextDailyBoundaryMs === expectedImportedEngine.nextDailyBoundaryMs,
        sourceAnchorMs: bundle.engine.lastSchedulerWallMs,
        importedAnchorMs: importedEngine.lastSchedulerWallMs,
        effectiveAnchorMs: imported.effectiveAnchorWallMs,
        anchorPreserved: importedEngine.lastSchedulerWallMs === imported.effectiveAnchorWallMs,
        jobsPreserved: stableHash(normalizeScheduledJobs(importedEngine.scheduledJobs)) === stableHash(normalizeScheduledJobs(expectedImportedEngine.scheduledJobs)),
        sessionsPreserved: stableHash(normalizeGameSessions(importedEngine.gameSessions)) === stableHash(normalizeGameSessions(expectedImportedEngine.gameSessions)),
        sessionsReboundToDestination: importedEngine.gameSessions.filter(session => session.status === 'active')
          .every(session => session.actorDeviceId === freshOwnerDeviceId),
        noDoubleCatchUp: restartedFreshHealth.gameTimeMs === importedHealthBeforeRestart.gameTimeMs
          && restartedFreshHealth.revision === importedHealthBeforeRestart.revision
          && restartedFreshHealth.eventSeq === importedHealthBeforeRestart.eventSeq
          && importedCountsAfterRestart.eventRows === importedCountsBeforeRestart.eventRows,
        eventRowsBeforeRestart: importedCountsBeforeRestart.eventRows,
        eventRowsAfterRestart: importedCountsAfterRestart.eventRows,
        survivorCount: operation.survivors.length,
        reopenedRowCount: rows.length,
        extraOpenRows: openRows.length - rows.length,
        reopenedAtCommitWall: rows.every(row => row.connectedAtMs === operation.commitWallMs),
        activeClientCount: freshHealth.activeClientCount,
        bothRenderersConvergedAfterImport: projectionHash(importedConverged.left) === projectionHash(importedConverged.right),
        bothRenderersConvergedAfterRestart: projectionHash(importedAfterRestart.left) === projectionHash(importedAfterRestart.right),
      }
      await freshHostOwner.close()
      await freshHostPlayer.close()
      await freshServer.stop()
      freshHostOwner = null
      freshHostPlayer = null
      freshServer = null
      return importEngineStateEvidence
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
      const healthToken = server.authToken
      await server.crash()
      const restartWallBeforeReady = Date.now()
      server = await new ServerProcess({ port, env: baseEnv, authToken: healthToken }).start()
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

      await seedCanonicalEnvironment(dbPath, 'c12-deterministic-restart')
      await ensureWorkReady(owner, 'deterministic-restart')
      const gameStart = await owner.command(
        { type: 'game.startSession', payload: { gameId: 'c12-restart-game', kind: 'small' } },
        'c12-restart-game-start',
      )
      assert.equal(gameStart.status, 'applied', 'restart game session start rejected: ' + JSON.stringify(gameStart.error))
      rawSessionTokens.push(gameStart.result.sessionToken)
      const diudiuleStart = await owner.command(
        { type: 'diudiule.startSession', payload: {} },
        'c12-restart-diudiule-start',
      )
      assert.equal(diudiuleStart.status, 'applied', 'restart diudiule session start rejected: ' + JSON.stringify(diudiuleStart.error))
      rawSessionTokens.push(diudiuleStart.result.sessionToken)
      const workStart = await owner.command(
        { type: 'job.startWork', payload: { jobId: 'bz' } },
        'c12-restart-work-start',
      )
      assert.equal(workStart.status, 'applied', 'restart work start rejected: ' + JSON.stringify(workStart.error))
      const restartWorkJobId = Number(workStart.result.jobId)
      const restartWorkDueAtGameMs = Number(workStart.result.dueAtGameMs)
      const prepared = await waitConverged(owner, player, workStart.revision, 20_000)
      assert.equal(prepared.left.shared.activeOption.work, 'bz')
      assert.equal(prepared.right.shared.activeOption.work, 'bz')

      const preparedEngine = await readCanonicalEngine(dbPath)
      assert.ok(preparedEngine.scheduledJobs.length >= 3, 'persisted scheduled jobs must be non-empty before export')
      assert.ok(preparedEngine.gameSessions.filter(session => session.status === 'active').length >= 2, 'persisted game sessions must be non-empty before export')
      assert.ok(Object.keys(preparedEngine.environment?.weatherByDay ?? {}).length > 0, 'persisted per-day weather must be non-empty before export')
      assert.ok(Object.keys(preparedEngine.environment?.calendarByDay ?? {}).length > 0, 'persisted per-day calendar must be non-empty before export')
      assert.ok(typeof preparedEngine.lastProcessedDayBoundaryKey === 'string' && preparedEngine.lastProcessedDayBoundaryKey.length > 0)
      assert.ok(Number.isSafeInteger(preparedEngine.nextDailyBoundaryMs) && preparedEngine.nextDailyBoundaryMs > preparedEngine.gameTimeMs)
      const beforeDb = await readPetState(dbPath)
      const beforeExport = await owner.exportBundle()
      const beforeBundle = JSON.parse(beforeExport.json)
      assert.equal(beforeBundle.authority.revision, beforeDb.revision, 'export snapshot must match the canonical revision')
      assert.equal(beforeBundle.authority.eventSeq, beforeDb.eventSeq, 'export snapshot must match the canonical eventSeq')
      assert.equal(beforeBundle.engine.gameTimeMs, beforeDb.gameTimeMs, 'export snapshot must match canonical gameTime')
      assert.equal(beforeBundle.engine.advanceWhileEmpty, true)
      assert.ok(beforeBundle.engine.scheduledJobs.length >= 3, 'deterministic restart fixture must start with non-empty scheduled jobs')
      assert.ok(beforeBundle.engine.gameSessions.length >= 2, 'deterministic restart fixture must start with non-empty game sessions')
      assert.ok(beforeBundle.engine.scheduledJobs.some(job => job.id === restartWorkJobId && job.status === 'pending' && job.dueAtGameMs === restartWorkDueAtGameMs))
      const beforeOwnerFaults = await owner.websocketFaultState()
      const beforePlayerFaults = await player.websocketFaultState()
      assert.ok((await readScheduledJobRows(dbPath)).length >= 3, 'scheduled_jobs table must be non-empty before restart')
      const activeSessionCountRow = await withDatabase(dbPath, false, db => db.prepare(
        "SELECT COUNT(*) AS count FROM game_sessions WHERE pet_id = ? AND status = 'active'",
      ).get('default'))
      assert.ok(Number(activeSessionCountRow.count) >= 2, 'game_sessions table must be non-empty before restart')
      const workRewardRowsBeforeRestart = (await readEventRows(dbPath, { type: 'reward.granted' }))
        .filter(event => event.payload.source === 'work')
      const workCompletionRowsBeforeRestart = (await readEventRows(dbPath, { type: 'activity.completed' }))
        .filter(event => event.payload.kind === 'work')

      const expectedTicks = 2
      const healthToken = server.authToken
      await server.crash()
      const environmentSeed = await seedCanonicalEnvironment(dbPath, 'c12-deterministic-restart')
      const beforeEngine = await readCanonicalEngine(dbPath)
      assert.ok(beforeEngine.scheduledJobs.length >= 3, 'persisted engine must retain scheduled jobs before restart')
      assert.ok(beforeEngine.gameSessions.length >= 2, 'persisted engine must retain game sessions before restart')
      assert.match(String(beforeEngine.rng?.seedHex ?? ''), /^[0-9a-f]{32}$/)
      assert.ok(Object.keys(beforeEngine.environment?.weatherByDay ?? {}).includes(environmentSeed.dayKey), 'per-day weather must be persisted')
      assert.ok(Object.keys(beforeEngine.environment?.calendarByDay ?? {}).includes(environmentSeed.dayKey), 'per-day calendar must be persisted')
      assert.equal(stableHash(normalizeScheduledJobs(beforeEngine.scheduledJobs)), stableHash(normalizeScheduledJobs(beforeBundle.engine.scheduledJobs)), 'exported jobs must match persisted engine before crash')
      assert.equal(stableHash(normalizeGameSessions(beforeEngine.gameSessions)), stableHash(normalizeGameSessions(beforeBundle.engine.gameSessions)), 'exported sessions must match persisted engine before crash')
      assert.equal(stableHash(beforeEngine.rng), stableHash(beforeBundle.engine.rng), 'exported RNG must match persisted engine before crash')

      const rewindAnchorMs = Date.now() - expectedTicks * 60_000 - 10_000
      const anchorUpdate = await rewindSchedulerAnchor(dbPath, rewindAnchorMs)
      assert.equal(anchorUpdate.advanceWhileEmpty, true)
      server = await new ServerProcess({ port, env: baseEnv, authToken: healthToken }).start()
      const restartHealth = await server.health()
      assert.equal(restartHealth.ready, true)

      const coverageIntervals = await readCoverageIntervals(dbPath)
      const { advanceSchedulerChunk, dayKeyAt, nextDailyBoundaryMs } = await loadRuntimeOracle()
      const oracleEngine = structuredClone(beforeEngine)
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
      assert.deepEqual(expected.state.scheduledJobs, beforeEngine.scheduledJobs, 'two catch-up ticks must not complete the seeded jobs')
      assert.deepEqual(expected.state.gameSessions, beforeEngine.gameSessions, 'two catch-up ticks must not settle the seeded sessions')
      assert.deepEqual(expected.state.environment, beforeEngine.environment, 'two catch-up ticks must preserve the per-day environment')
      assert.equal(expected.state.lastSchedulerWallMs, oracleTargetMs)
      assert.equal(expected.state.lastProcessedDayBoundaryKey, beforeEngine.lastProcessedDayBoundaryKey)
      assert.equal(expected.state.nextDailyBoundaryMs, beforeEngine.nextDailyBoundaryMs)
      assert.equal(expected.state.lastProcessedDayBoundaryKey, dayKeyAt(expected.state.gameTimeMs, expected.state.timeZone))
      assert.equal(expected.state.nextDailyBoundaryMs, nextDailyBoundaryMs(expected.state.gameTimeMs, expected.state.timeZone))
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
      const afterEngine = await readCanonicalEngine(dbPath)
      assert.equal(afterBundle.engine.gameTimeMs, expectedGameTimeMs)
      assert.equal(afterBundle.authority.revision, expectedRevision)
      assert.equal(afterBundle.authority.eventSeq, expectedEventSeq)
      assert.deepEqual(afterBundle.engine.scheduledJobs, expected.state.scheduledJobs, 'scheduled jobs must match the pre-restart oracle')
      assert.deepEqual(afterBundle.engine.gameSessions, expected.state.gameSessions, 'game sessions must match the pre-restart oracle')
      assert.deepEqual(afterBundle.engine.environment, expected.state.environment, 'per-day environment must match the pre-restart oracle')
      assert.equal(afterBundle.engine.lastProcessedDayBoundaryKey, expected.state.lastProcessedDayBoundaryKey)
      assert.equal(afterBundle.engine.nextDailyBoundaryMs, expected.state.nextDailyBoundaryMs)
      assert.ok(afterBundle.engine.lastSchedulerWallMs >= expected.state.lastSchedulerWallMs, 'scheduler anchor must reach the oracle target')
      assert.ok(afterBundle.engine.lastSchedulerWallMs <= Date.now(), 'scheduler anchor must not move into the future')
      assert.equal(stableHash(afterBundle.engine.rng), stableHash(expected.state.rng), 'RNG must match the deterministic post-catch-up oracle')
      assert.equal(stableHash(afterEngine.scheduledJobs), stableHash(expected.state.scheduledJobs), 'persisted scheduled_jobs must match the oracle')
      assert.equal(stableHash(afterEngine.gameSessions), stableHash(expected.state.gameSessions), 'persisted game_sessions must match the oracle')
      assert.equal(stableHash(afterEngine.rng), stableHash(expected.state.rng), 'persisted RNG must match the oracle')
      assert.equal(stableHash(afterEngine.environment), stableHash(expected.state.environment), 'persisted environment must match the oracle')
      assert.equal(afterEngine.lastProcessedDayBoundaryKey, expected.state.lastProcessedDayBoundaryKey)
      assert.equal(afterEngine.nextDailyBoundaryMs, expected.state.nextDailyBoundaryMs)
      assert.ok(afterEngine.lastSchedulerWallMs >= expected.state.lastSchedulerWallMs, 'scheduler anchor must advance monotonically past the oracle target')
      assert.ok(afterEngine.lastSchedulerWallMs <= Date.now(), 'scheduler anchor must not move into the future')
      assert.equal(afterEngine.gameTimeMs, expectedGameTimeMs, 'anchor-only scheduler passes must not advance game time')
      const activeClients = await waitFor(async () => {
        const health = await server.health()
        return health.activeClientCount === 2 ? health : null
      }, 'two active clients after deterministic restart', 10_000)

      const firstRestartCounts = await readPersistedCounts(dbPath)
      const firstRestartRewardRows = (await readEventRows(dbPath, { type: 'reward.granted' }))
        .filter(event => event.payload.source === 'work')
      const firstRestartCompletionRows = (await readEventRows(dbPath, { type: 'activity.completed' }))
        .filter(event => event.payload.kind === 'work')
      assert.equal(firstRestartRewardRows.length, workRewardRowsBeforeRestart.length, 'seeded future work must not be rewarded during two-tick catch-up')
      assert.equal(firstRestartCompletionRows.length, workCompletionRowsBeforeRestart.length, 'seeded future work must not complete during two-tick catch-up')
      const afterFirstRestartOwnerFaults = await owner.websocketFaultState()
      const afterFirstRestartPlayerFaults = await player.websocketFaultState()

      // A second restart at the same persisted anchor must not replay the two
      // committed minutes or duplicate any persisted job/session/event row.
      await server.crash()
      server = await new ServerProcess({ port, env: baseEnv, authToken: healthToken }).start()
      const secondRestartHealth = await server.health()
      const secondRestartEngine = await readCanonicalEngine(dbPath)
      const secondRestartCounts = await readPersistedCounts(dbPath)
      assert.equal(secondRestartHealth.ready, true)
      assert.equal(secondRestartHealth.gameTimeMs, restartHealth.gameTimeMs, 'second restart must not catch up the same minutes again')
      assert.equal(secondRestartHealth.revision, restartHealth.revision, 'second restart must not commit a duplicate revision')
      assert.equal(secondRestartHealth.eventSeq, restartHealth.eventSeq, 'second restart must not commit duplicate events')
      assert.equal(stableHash(secondRestartEngine.scheduledJobs), stableHash(afterEngine.scheduledJobs))
      assert.equal(stableHash(secondRestartEngine.gameSessions), stableHash(afterEngine.gameSessions))
      assert.equal(stableHash(secondRestartEngine.rng), stableHash(afterEngine.rng))
      assert.equal(stableHash(secondRestartEngine.environment), stableHash(afterEngine.environment))
      assert.ok(secondRestartEngine.lastSchedulerWallMs >= afterEngine.lastSchedulerWallMs, 'scheduler anchor must be monotonic across restart')
      assert.equal(secondRestartEngine.gameTimeMs, afterEngine.gameTimeMs, 'second restart must not advance game time')
      assert.equal(secondRestartCounts.commandRows, firstRestartCounts.commandRows, 'second restart must not duplicate command rows')
      assert.equal(secondRestartCounts.eventRows, firstRestartCounts.eventRows, 'second restart must not duplicate event rows')
      assert.equal(secondRestartCounts.duplicateOpIds, 0)
      assert.equal(secondRestartCounts.duplicateEventSeqs, 0)
      await waitFor(async () => {
        const ownerStatus = await owner.storageStatus()
        const playerStatus = await player.storageStatus()
        const ownerFaults = await owner.websocketFaultState()
        const playerFaults = await player.websocketFaultState()
        return ownerStatus.connection === 'online'
          && playerStatus.connection === 'online'
          && ownerFaults.sockets > afterFirstRestartOwnerFaults.sockets
          && playerFaults.sockets > afterFirstRestartPlayerFaults.sockets
          ? true
          : null
      }, 'renderers reconnect after no-duplicate restart', 45_000)
      const secondProjection = await waitFor(async () => {
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
      }, 'exact projection after no-duplicate restart', 20_000)
      assert.equal(projectionHash(secondProjection.left), expectedSharedHash)

      restartEngineStateEvidence = {
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
        seededJobRows: (await readScheduledJobRows(dbPath)).length,
        seededSessionRows: beforeEngine.gameSessions.length,
        jobsBeforeCount: beforeEngine.scheduledJobs.length,
        sessionsBeforeCount: beforeEngine.gameSessions.length,
        jobsAfterHash: stableHash(afterEngine.scheduledJobs),
        jobsExpectedHash: stableHash(expected.state.scheduledJobs),
        jobsMatchedOracle: stableHash(afterEngine.scheduledJobs) === stableHash(expected.state.scheduledJobs),
        sessionsAfterHash: stableHash(afterEngine.gameSessions),
        sessionsExpectedHash: stableHash(expected.state.gameSessions),
        sessionsMatchedOracle: stableHash(afterEngine.gameSessions) === stableHash(expected.state.gameSessions),
        rngBeforeHash: stableHash(beforeEngine.rng),
        rngAfterHash: stableHash(afterEngine.rng),
        rngExpectedHash: stableHash(expected.state.rng),
        rngMatchedDeterministicOracle: stableHash(afterEngine.rng) === stableHash(expected.state.rng),
        environmentBeforeHash: stableHash(beforeEngine.environment),
        environmentAfterHash: stableHash(afterEngine.environment),
        environmentExpectedHash: stableHash(expected.state.environment),
        environmentMatchedOracle: stableHash(afterEngine.environment) === stableHash(expected.state.environment),
        weatherKeys: Object.keys(beforeEngine.environment.weatherByDay),
        calendarKeys: Object.keys(beforeEngine.environment.calendarByDay ?? {}),
        dayBoundaryBeforeKey: beforeEngine.lastProcessedDayBoundaryKey,
        dayBoundaryAfterKey: afterEngine.lastProcessedDayBoundaryKey,
        dayBoundaryExpectedKey: expected.state.lastProcessedDayBoundaryKey,
        dayBoundaryBeforeMs: beforeEngine.nextDailyBoundaryMs,
        dayBoundaryAfterMs: afterEngine.nextDailyBoundaryMs,
        dayBoundaryExpectedMs: expected.state.nextDailyBoundaryMs,
        anchorBefore: rewindAnchorMs,
        anchorAfter: afterEngine.lastSchedulerWallMs,
        anchorExpected: expected.state.lastSchedulerWallMs,
        anchorAtOrAfterOracle: afterEngine.lastSchedulerWallMs >= expected.state.lastSchedulerWallMs,
        anchorAdvancedWithoutExtraTicks: afterEngine.gameTimeMs === expectedGameTimeMs,
        anchorPrevious: anchorUpdate.previousAnchorMs,
        sharedHashBefore: hash(beforeEngine.save),
        sharedHashAfter: projectionHash(after.left),
        sharedHashExpected: expectedSharedHash,
        exactJobsSessionsRngEnvironmentAnchorComparisons: true,
        noDuplicateCatchUp: secondRestartHealth.gameTimeMs === restartHealth.gameTimeMs
          && secondRestartHealth.revision === restartHealth.revision
          && secondRestartHealth.eventSeq === restartHealth.eventSeq
          && secondRestartCounts.eventRows === firstRestartCounts.eventRows,
        projectionHash: projectionHash(after.left),
        activeClientCount: activeClients.activeClientCount,
      }
      return restartEngineStateEvidence
    })

    await step(SCENARIO_SURVIVOR_RESTART, async () => {
      const fixture = await createClockedServerFixture(root, 'survivor-restart', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
        withPlayer: true,
      })
      try {
        const survivor = fixture.app
        let killed = fixture.player
        const beforeConverged = await waitConverged(survivor, killed, 0, 20_000)
        const beforeState = await readPetState(fixture.dbPath)
        const beforeCounts = await readPersistedCounts(fixture.dbPath)
        const beforeHealth = await fixture.server.health()
        assert.equal(beforeHealth.activeClientCount, 2)
        assert.equal(sameProjection(beforeConverged.left, beforeConverged.right), true)
        const killedPid = killed.pid
        const killedUserData = killed.userData
        const killedFaults = await killed.websocketFaultState()

        // Kill a real Electron renderer, not just its socket. The surviving
        // renderer must keep its authenticated connection and apply canonical
        // broadcasts while the killed peer is absent.
        await killed.kill()
        await waitForClients(fixture.server, 1, 'one survivor after renderer kill', 20_000)
        const survivorStatus = await survivor.storageStatus()
        assert.equal(survivorStatus.connection, 'online')
        assert.equal(survivorStatus.readOnly, false)
        const signed = await survivor.command(
          { type: 'signin.sign', payload: {} },
          'c12-survivor-signin',
        )
        assert.equal(signed.status, 'applied', 'survivor sign-in rejected: ' + JSON.stringify(signed.error))
        const canonicalAfterSignin = await readCanonicalEngine(fixture.dbPath)
        const stateAfterSignin = await readPetState(fixture.dbPath)
        assert.equal(stateAfterSignin.revision, signed.revision)
        assert.equal(stateAfterSignin.eventSeq, signed.eventSeq)
        const survivorProjection = await waitFor(async () => {
          const projection = await survivor.projection()
          if (projection === null
            || projection.revision !== signed.revision
            || projection.eventSeq !== signed.eventSeq
            || projectionHash(projection) !== hash(canonicalAfterSignin.save)) return null
          return projection
        }, 'survivor renderer applies canonical sign-in projection', 10_000)
        const signinEventsAfterKill = (await readEventRows(fixture.dbPath))
          .filter(event => event.type === 'reward.granted' && event.payload.source === 'signin')
        assert.equal(signinEventsAfterKill.length, 1, 'survivor sign-in reward must be granted exactly once')
        const countsAfterSignin = await readPersistedCounts(fixture.dbPath)
        assert.equal(countsAfterSignin.duplicateOpIds, 0)
        assert.equal(countsAfterSignin.duplicateEventSeqs, 0)
        assert.equal(countsAfterSignin.commandRows, beforeCounts.commandRows + 1)
        assert.equal((await fixture.server.health()).activeClientCount, 1)

        // Relaunch the killed renderer from the same userData/identity. It must
        // resume from the server snapshot and neither replay the survivor's
        // command nor create any duplicate rewards/events.
        for (const stale of ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort']) {
          await rm(join(killedUserData, stale), { force: true })
        }
        const replacement = await new RendererApp({
          label: 'survivor-restart-player-renderer',
          userData: killedUserData,
          serverUrl: fixture.serverUrl,
        }).launch()
        fixture.player = replacement
        assert.notEqual(replacement.pid, killedPid, 'relaunched renderer must be a fresh Electron process')
        await replacement.waitOnline(30_000)
        await waitForClients(fixture.server, 2, 'both renderer clients after relaunch', 20_000)
        const converged = await waitConverged(survivor, replacement, signed.revision, 20_000)
        const expectedSharedHash = hash(canonicalAfterSignin.save)
        assert.equal(projectionHash(converged.left), expectedSharedHash)
        assert.equal(projectionHash(converged.right), expectedSharedHash)
        assert.equal(converged.left.eventSeq, signed.eventSeq)
        assert.equal(converged.right.eventSeq, signed.eventSeq)
        const finalState = await readPetState(fixture.dbPath)
        assert.equal(finalState.revision, stateAfterSignin.revision, 'reconnect must not mutate canonical revision')
        assert.equal(finalState.eventSeq, stateAfterSignin.eventSeq, 'reconnect must not append canonical events')
        const finalCounts = await readPersistedCounts(fixture.dbPath)
        assert.deepEqual(finalCounts, countsAfterSignin, 'reconnect must not duplicate command/event rows')
        const finalSigninEvents = (await readEventRows(fixture.dbPath))
          .filter(event => event.type === 'reward.granted' && event.payload.source === 'signin')
        assert.equal(finalSigninEvents.length, 1, 'reconnect must not replay the sign-in reward')
        const finalSignin = signinState((await readCanonicalEngine(fixture.dbPath)).save)
        assert.equal(countSigninDay(finalSignin, Number(signed.result.day)), 1)
        const replacementFaults = await replacement.websocketFaultState()
        return {
          killedMainPid: killedPid,
          survivorMainPid: survivor.pid,
          replacementMainPid: replacement.pid,
          freshRendererProcess: replacement.pid !== killedPid,
          killedRendererHelloFrames: killedFaults.sentHellos,
          survivorActiveClientCountAfterKill: 1,
          survivorConnection: survivorStatus.connection,
          survivorAppliedRevision: survivorProjection.revision,
          survivorAppliedEventSeq: survivorProjection.eventSeq,
          survivorCommandStatus: signed.status,
          signinDay: Number(signed.result.day),
          signinRewardEventCountAfterReconnect: finalSigninEvents.length,
          signinDayEntryCountAfterReconnect: countSigninDay(finalSignin, Number(signed.result.day)),
          commandRowsBeforeKill: beforeCounts.commandRows,
          commandRowsAfterSignin: countsAfterSignin.commandRows,
          commandRowsAfterReconnect: finalCounts.commandRows,
          eventRowsAfterSignin: countsAfterSignin.eventRows,
          eventRowsAfterReconnect: finalCounts.eventRows,
          duplicateOpIds: finalCounts.duplicateOpIds,
          duplicateEventSeqs: finalCounts.duplicateEventSeqs,
          revisionAfterSignin: stateAfterSignin.revision,
          revisionAfterReconnect: finalState.revision,
          eventSeqAfterSignin: stateAfterSignin.eventSeq,
          eventSeqAfterReconnect: finalState.eventSeq,
          projectionHash: projectionHash(converged.left),
          activeClientCount: (await fixture.server.health()).activeClientCount,
          replacementObservedSockets: replacementFaults.sockets,
          replacementObservedHellos: replacementFaults.sentHellos,
          reconnectedWithoutDuplicate: true,
        }
      } finally {
        await fixture.cleanup()
      }
    })

    await step(SCENARIO_MUTATION_BLOCKED, async () => {
      const fixture = await createClockedServerFixture(root, 'canonical-mutation-boundary', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
        withPlayer: true,
      })
      try {
        const owner = fixture.app
        const player = fixture.player
        const beforeConverged = await waitConverged(owner, player, 0, 20_000)
        const beforeState = await readPetState(fixture.dbPath)
        const beforeEngine = await readCanonicalEngine(fixture.dbPath)
        const beforeCounts = await readPersistedCounts(fixture.dbPath)
        const beforeOwner = await owner.projection()
        const beforePlayer = await player.projection()
        const beforeHash = projectionHash(beforeConverged.left)
        assert.equal(projectionHash(beforeConverged.right), beforeHash)
        const forgedYb = 987_654_321

        // Production legacy preload path: fire-and-forget SavePatch. The
        // storage controller must reject it in server mode and log the
        // canonical_mutation_blocked error in the real Electron main process.
        await owner.legacySave({
          petInfo: { name: 'c12-legacy-savepatch', yb: forgedYb },
          settings: { zoom: 3 },
          saveJsonData: { task: JSON.stringify({ doNums: { Eat: 999 } }) },
        })
        await waitFor(
          () => owner.launchLog.some(line =>
            line.includes('runtime save(patch) rejected') && line.includes('canonical_mutation_blocked')),
          'legacy SavePatch rejection in Electron main log',
          10_000,
        )

        // Mutable-looking IPC results are detached copies. Mutate both the
        // projection object and the devtools-visible load() SaveData, then
        // prove a fresh renderer read and server state never observe them.
        const mutationAttempt = await owner.page.evaluate(async forged => {
          const projection = await window.qqpet.getProjection()
          const visibleSave = await window.qqpet.load()
          const originalProjectionYb = Number(projection.shared.petInfo.yb)
          const originalVisibleSaveYb = Number(visibleSave.petInfo.yb)
          projection.shared.petInfo.yb = forged
          projection.shared.havePet = false
          projection.revision = 999_999_999
          projection.save.petInfo.yb = forged + 2
          visibleSave.petInfo.yb = forged + 1
          visibleSave.havePet = false
          visibleSave.settings.zoom = 4
          return {
            originalProjectionYb,
            originalVisibleSaveYb,
            mutatedProjectionYb: Number(projection.shared.petInfo.yb),
            mutatedComposedSaveYb: Number(projection.save.petInfo.yb),
            mutatedVisibleSaveYb: Number(visibleSave.petInfo.yb),
            mutatedRevision: Number(projection.revision),
            mutatedVisibleHavePet: visibleSave.havePet,
            mutatedVisibleZoom: visibleSave.settings.zoom,
          }
        }, forgedYb)
        assert.equal(mutationAttempt.mutatedProjectionYb, forgedYb)
        assert.equal(mutationAttempt.mutatedComposedSaveYb, forgedYb + 2)
        assert.equal(mutationAttempt.mutatedVisibleSaveYb, forgedYb + 1)
        assert.equal(mutationAttempt.mutatedRevision, 999_999_999)
        assert.equal(mutationAttempt.mutatedVisibleHavePet, false)
        assert.equal(mutationAttempt.mutatedVisibleZoom, 4)

        await owner.requestResync()
        const afterOwner = await waitFor(async () => {
          const projection = await owner.projection()
          return projection !== null
            && projection.revision === beforeOwner.revision
            && projection.eventSeq === beforeOwner.eventSeq
            && sameProjection(projection, beforeOwner)
            ? projection
            : null
        }, 'owner projection refresh after direct mutation attempts', 10_000)
        const afterPlayer = await waitFor(async () => {
          const projection = await player.projection()
          return projection !== null
            && projection.revision === beforePlayer.revision
            && projection.eventSeq === beforePlayer.eventSeq
            && sameProjection(projection, beforePlayer)
            ? projection
            : null
        }, 'player projection unchanged after direct mutation attempts', 10_000)
        const afterState = await readPetState(fixture.dbPath)
        const afterCounts = await readPersistedCounts(fixture.dbPath)
        const afterEngine = await readCanonicalEngine(fixture.dbPath)
        assert.deepEqual(afterState, beforeState, 'SavePatch/direct mutation must not change canonical pet state')
        assert.deepEqual(afterCounts, beforeCounts, 'SavePatch/direct mutation must not add command/event rows')
        assert.equal(hash(afterEngine.save), hash(beforeEngine.save), 'SavePatch/direct mutation must not change canonical save')
        assert.equal(hash(afterEngine.rng), hash(beforeEngine.rng), 'SavePatch/direct mutation must not consume or replace RNG state')
        assert.equal(Number(afterOwner.shared.petInfo.yb), Number(beforeOwner.shared.petInfo.yb))
        assert.equal(afterOwner.shared.havePet, true)
        assert.equal(Number(afterPlayer.shared.petInfo.yb), Number(beforeOwner.shared.petInfo.yb))
        assert.equal(projectionHash(afterOwner), beforeHash)
        assert.equal(projectionHash(afterPlayer), beforeHash)
        return {
          legacySavePatchChannel: 'window.qqpet.save',
          legacySavePatchBlockedInMainLog: true,
          legacySavePatchError: 'canonical_mutation_blocked',
          projectionMutationAttempted: true,
          visibleSaveMutationAttempted: true,
          mutatedDetachedProjectionYb: mutationAttempt.mutatedProjectionYb,
          mutatedDetachedVisibleSaveYb: mutationAttempt.mutatedVisibleSaveYb,
          freshOwnerProjectionYb: Number(afterOwner.shared.petInfo.yb),
          freshPlayerProjectionYb: Number(afterPlayer.shared.petInfo.yb),
          revisionBefore: beforeState.revision,
          revisionAfter: afterState.revision,
          eventSeqBefore: beforeState.eventSeq,
          eventSeqAfter: afterState.eventSeq,
          commandRowsBefore: beforeCounts.commandRows,
          commandRowsAfter: afterCounts.commandRows,
          eventRowsBefore: beforeCounts.eventRows,
          eventRowsAfter: afterCounts.eventRows,
          duplicateOpIds: afterCounts.duplicateOpIds,
          duplicateEventSeqs: afterCounts.duplicateEventSeqs,
          canonicalSaveHashBefore: hash(beforeEngine.save),
          canonicalSaveHashAfter: hash(afterEngine.save),
          canonicalRngHashBefore: hash(beforeEngine.rng),
          canonicalRngHashAfter: hash(afterEngine.rng),
          ownerProjectionHashBefore: beforeHash,
          ownerProjectionHashAfter: projectionHash(afterOwner),
          playerProjectionHashAfter: projectionHash(afterPlayer),
          canonicalUnchanged: true,
          projectionRefreshedUnchanged: true,
        }
      } finally {
        await fixture.cleanup()
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

    await step(SCENARIO_TIMED_WORK, async () => {
      const fixture = await createClockedServerFixture(root, 'timed-work-authority', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
      })
      try {
        let app = fixture.app
        let server = fixture.server
        const beforeWork = await ensureWorkReady(app, 'timed-work')
        const taskBefore = taskCounter(beforeWork.shared, 'Work')
        const ybBefore = Number(beforeWork.shared.petInfo.yb)
        const started = await app.command(
          { type: 'job.startWork', payload: { jobId: 'bz' } },
          'timed-work-start',
        )
        assert.equal(started.status, 'applied', 'timed work start rejected: ' + JSON.stringify(started.error))
        const jobId = Number(started.result.jobId)
        const dueAtGameMs = Number(started.result.dueAtGameMs)
        assert.equal(Number.isSafeInteger(jobId), true)
        assert.equal(dueAtGameMs, Number(beforeWork.gameTimeMs) + 30 * 60_000)
        const jobsAtStart = await readScheduledJobRows(fixture.dbPath)
        const pending = jobsAtStart.filter(job => job.id === jobId)
        assert.equal(pending.length, 1, 'the renderer command must create exactly one canonical job row')
        assert.equal(pending[0].kind, 'work')
        assert.equal(pending[0].status, 'pending')
        assert.equal(pending[0].dueAtGameMs, dueAtGameMs)
        assert.equal(pending[0].payload.activityKind, 'work')
        assert.equal(pending[0].payload.activityId, 'bz')
        assert.equal(pending[0].payload.startedAtGameMs + 30 * 60_000, dueAtGameMs)

        await app.close()
        await waitForClients(server, 0, 'timed-work zero authenticated clients before stop')
        await fixture.stopServer()
        const beforeCatchUp = await readPetState(fixture.dbPath)
        const engineBefore = await readCanonicalEngine(fixture.dbPath)
        assert.equal(engineBefore.lastSchedulerWallMs, engineBefore.gameTimeMs)
        const expectedTicks = (dueAtGameMs - engineBefore.lastSchedulerWallMs) / 60_000
        assert.equal(Number.isSafeInteger(expectedTicks), true)
        assert.equal(expectedTicks, 30, 'timed work must be due exactly 30 server game-minutes after the command')
        const { advanceSchedulerChunk } = await loadRuntimeOracle()
        const expected = advanceSchedulerChunk(engineBefore, {
          gameTimeMs: engineBefore.gameTimeMs,
          environment: engineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, dueAtGameMs, { maxChunkTicks: 1_440 })
        assert.equal(expected.ok, true)
        assert.equal(expected.ticks, expectedTicks)
        assert.equal(expected.catchingUp, false)

        await fixture.setClock(dueAtGameMs)
        server = await fixture.startServer()
        const healthAfter = await server.health()
        assert.equal(healthAfter.activeClientCount, 0, 'catch-up must run with zero authenticated clients')
        assert.equal(healthAfter.ready, true)
        const afterCatchUp = await readPetState(fixture.dbPath)
        const expectedGameTimeMs = beforeCatchUp.gameTimeMs + expectedTicks * 60_000
        const expectedRevision = beforeCatchUp.revision + 1
        const expectedEventSeq = beforeCatchUp.eventSeq + expected.events.length
        assert.equal(afterCatchUp.gameTimeMs, dueAtGameMs)
        assert.equal(afterCatchUp.gameTimeMs, expectedGameTimeMs)
        assert.equal(healthAfter.gameTimeMs, expectedGameTimeMs)
        assert.equal(afterCatchUp.revision, expectedRevision)
        assert.equal(healthAfter.revision, expectedRevision)
        assert.equal(afterCatchUp.eventSeq, expectedEventSeq)
        assert.equal(healthAfter.eventSeq, expectedEventSeq)
        const afterEngine = await readCanonicalEngine(fixture.dbPath)
        assert.equal(hash(afterEngine.save), hash(expected.state.save), 'scheduler result must match the deterministic runtime oracle')

        const rewardEvents = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'work')
        const completionEvents = (await readEventRows(fixture.dbPath, { type: 'activity.completed' }))
          .filter(event => event.payload.kind === 'work')
        assert.equal(rewardEvents.length, 1, 'work reward must be granted exactly once')
        assert.equal(completionEvents.length, 1, 'work completion must be recorded exactly once')
        assert.equal(rewardEvents[0].gameTimeMs, dueAtGameMs, 'the reward event must be stamped at the server-owned due time')
        assert.equal(completionEvents[0].gameTimeMs, dueAtGameMs, 'the completion event must be stamped at the server-owned due time')
        const completedRows = (await readScheduledJobRows(fixture.dbPath)).filter(job => job.id === jobId)
        assert.equal(completedRows.length, 1)
        assert.equal(completedRows[0].status, 'completed')
        assert.equal(afterEngine.scheduledJobs.find(job => job.id === jobId).status, 'completed')
        assert.equal(afterEngine.save.activeOption.work, null)
        const ybReward = Number(rewardEvents[0].payload.yb)
        assert.ok(Number.isSafeInteger(ybReward) && ybReward > 0)
        assert.equal(Number(afterEngine.save.petInfo.yb), ybBefore + ybReward, 'work payout must be credited exactly once')
        assert.equal(taskCounter(afterEngine.save, 'Work'), taskBefore + 1)

        app = await fixture.relaunchApp()
        const projectionAfterRestart = await waitFor(async () => {
          const projection = await app.projection()
          return projection?.gameTimeMs === dueAtGameMs
            && projection.revision === expectedRevision
            && projection.eventSeq === expectedEventSeq
            && projection.shared?.activeOption?.work === null
            ? projection
            : null
        }, 'timed work completion projection after restart', 20_000)
        assert.equal(Number(projectionAfterRestart.shared.petInfo.yb), ybBefore + ybReward)
        assert.equal(taskCounter(projectionAfterRestart.shared, 'Work'), taskBefore + 1)

        // Replay catch-up after the job is already completed. This is the
        // duplicate-completion path: no reward/event may be emitted twice.
        await app.close()
        await waitForClients(server, 0, 'timed-work zero clients before replay restart')
        await fixture.stopServer()
        await fixture.setClock(dueAtGameMs + expectedTicks * 60_000)
        server = await fixture.startServer()
        const replayHealth = await server.health()
        assert.equal(replayHealth.ready, true)
        const replayRewardEvents = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'work')
        const replayCompletionEvents = (await readEventRows(fixture.dbPath, { type: 'activity.completed' }))
          .filter(event => event.payload.kind === 'work')
        const replayJobRows = await readScheduledJobRows(fixture.dbPath)
        assert.equal(replayRewardEvents.length, 1, 'replayed catch-up must not grant the work reward twice')
        assert.equal(replayCompletionEvents.length, 1, 'replayed catch-up must not complete the job twice')
        assert.equal(replayJobRows.filter(job => job.id === jobId && job.status === 'completed').length, 1)
        assert.equal(replayJobRows.filter(job => job.id === jobId).length, 1, 'replayed completion must not insert a duplicate job row')
        app = await fixture.relaunchApp()
        const replayProjection = await waitFor(async () => {
          const projection = await app.projection()
          return projection?.shared?.activeOption?.work === null ? projection : null
        }, 'timed work replay projection', 20_000)
        assert.equal(Number(replayProjection.shared.petInfo.yb), ybBefore + ybReward)
        assert.equal(taskCounter(replayProjection.shared, 'Work'), taskBefore + 1)
        return {
          jobId,
          startedAtGameMs: pending[0].payload.startedAtGameMs,
          dueAtGameMs,
          serverDeadlineMatchesCommand: pending[0].dueAtGameMs === dueAtGameMs,
          expectedTicks,
          observedTicks: (afterCatchUp.gameTimeMs - beforeCatchUp.gameTimeMs) / 60_000,
          gameTimeBefore: beforeCatchUp.gameTimeMs,
          gameTimeAfter: afterCatchUp.gameTimeMs,
          revisionBefore: beforeCatchUp.revision,
          revisionAfter: afterCatchUp.revision,
          revisionExpected: expectedRevision,
          eventSeqBefore: beforeCatchUp.eventSeq,
          eventSeqAfter: afterCatchUp.eventSeq,
          eventSeqExpected: expectedEventSeq,
          rewardEventCount: rewardEvents.length,
          completionEventCount: completionEvents.length,
          rewardGameTimeMs: rewardEvents[0].gameTimeMs,
          completionGameTimeMs: completionEvents[0].gameTimeMs,
          completionExactlyAtDeadline: rewardEvents[0].gameTimeMs === dueAtGameMs && completionEvents[0].gameTimeMs === dueAtGameMs,
          ybBefore,
          ybReward,
          ybAfter: Number(projectionAfterRestart.shared.petInfo.yb),
          taskWorkBefore: taskBefore,
          taskWorkAfter: taskCounter(projectionAfterRestart.shared, 'Work'),
          projectionRevisionAfterRestart: projectionAfterRestart.revision,
          persistedAcrossRestart: true,
          replayRewardEventCount: replayRewardEvents.length,
          replayCompletionEventCount: replayCompletionEvents.length,
          duplicateCompletionRewarded: replayRewardEvents.length !== 1,
          sharedHashMatchesOracle: hash(afterEngine.save) === hash(expected.state.save),
          zeroAuthenticatedClients: replayHealth.activeClientCount === 0,
        }
      } finally {
        await fixture.cleanup()
      }
    })

    await step(SCENARIO_TIMED_BOTH_RENDERERS, async () => {
      const fixture = await createClockedServerFixture(root, 'timed-work-both-renderers', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
        withPlayer: true,
      })
      try {
        const owner = fixture.app
        const player = fixture.player
        let server = fixture.server
        const isStartEvent = event => event?.type === 'activity.started'
          && event.payload?.kind === 'work'
          && event.payload?.activityId === 'bz'
        const isRewardEvent = event => event?.type === 'reward.granted'
          && event.payload?.source === 'work'
        const isCompletionEvent = event => event?.type === 'activity.completed'
          && event.payload?.kind === 'work'
          && event.payload?.activityId === 'bz'
        const waitCapturedStart = async (app, label) => await waitFor(async () => {
          const capture = await app.projectionEventCapture()
          const matches = capture?.events.filter(isStartEvent) ?? []
          return matches.length === 1 ? matches[0] : null
        }, label, 20_000)
        const waitCapturedCompletion = async (app, label) => await waitFor(async () => {
          const capture = await app.projectionEventCapture()
          if (capture === null) return null
          const starts = capture.events.filter(isStartEvent)
          const rewards = capture.events.filter(isRewardEvent)
          const completions = capture.events.filter(isCompletionEvent)
          if (starts.length !== 1 || rewards.length !== 1 || completions.length !== 1) return null
          const projection = await app.projection()
          if (projection === null
            || projection.gameTimeMs !== dueAtGameMs
            || projection.shared?.activeOption?.work !== null) return null
          return {
            projection,
            start: starts[0],
            reward: rewards[0],
            completion: completions[0],
            rewardCount: rewards.length,
            completionCount: completions.length,
            startCount: starts.length,
            deliveries: capture.deliveries,
          }
        }, label, 30_000)

        await owner.installProjectionEventCapture()
        await player.installProjectionEventCapture()
        const beforeWork = await ensureWorkReady(owner, 'timed-work-both-renderers')
        const taskBefore = taskCounter(beforeWork.shared, 'Work')
        const ybBefore = Number(beforeWork.shared.petInfo.yb)
        const started = await owner.command(
          { type: 'job.startWork', payload: { jobId: 'bz' } },
          'timed-work-both-renderers-start',
        )
        assert.equal(started.status, 'applied', 'timed work start rejected: ' + JSON.stringify(started.error))
        const jobId = Number(started.result.jobId)
        const dueAtGameMs = Number(started.result.dueAtGameMs)
        assert.equal(Number.isSafeInteger(jobId), true)
        assert.equal(Number.isSafeInteger(dueAtGameMs), true)

        const jobRowsAtStart = (await readScheduledJobRows(fixture.dbPath)).filter(job => job.id === jobId)
        assert.equal(jobRowsAtStart.length, 1, 'timed work must persist exactly one job row')
        assert.equal(jobRowsAtStart[0].status, 'pending')
        assert.equal(jobRowsAtStart[0].dueAtGameMs, dueAtGameMs)
        assert.equal(jobRowsAtStart[0].payload.activityId, 'bz')
        assert.equal(jobRowsAtStart[0].payload.startedAtGameMs + 30 * 60_000, dueAtGameMs)

        const ownerStarted = await waitCapturedStart(owner, 'owner renderer observes the server work deadline')
        const playerStarted = await waitCapturedStart(player, 'player renderer observes the server work deadline')
        assert.equal(Number(ownerStarted.payload.dueAtGameMs), dueAtGameMs)
        assert.equal(Number(playerStarted.payload.dueAtGameMs), dueAtGameMs)
        assert.equal(Number(playerStarted.payload.dueAtGameMs), jobRowsAtStart[0].dueAtGameMs)
        assert.equal(playerStarted.eventSeq, ownerStarted.eventSeq, 'both renderers must observe the same ordered start event')
        const active = await waitConverged(owner, player, started.revision, 20_000)
        assert.equal(active.left.shared.activeOption.work, 'bz')
        assert.equal(active.right.shared.activeOption.work, 'bz')

        await fixture.setClock(dueAtGameMs)
        const ownerCompleted = await waitCapturedCompletion(owner, 'owner renderer observes exactly one work completion and reward')
        const playerCompleted = await waitCapturedCompletion(player, 'player renderer observes exactly one work completion and reward')
        assert.equal(hash(ownerCompleted.reward.payload), hash(playerCompleted.reward.payload), 'both renderers must observe the same reward payload')
        assert.equal(hash(ownerCompleted.completion.payload), hash(playerCompleted.completion.payload), 'both renderers must observe the same completion payload')
        assert.equal(ownerCompleted.reward.eventSeq, playerCompleted.reward.eventSeq)
        assert.equal(ownerCompleted.completion.eventSeq, playerCompleted.completion.eventSeq)
        assert.equal(ownerCompleted.completion.gameTimeMs, dueAtGameMs)
        assert.equal(playerCompleted.completion.gameTimeMs, dueAtGameMs)

        const ybReward = Number(ownerCompleted.reward.payload.yb)
        assert.ok(Number.isSafeInteger(ybReward) && ybReward > 0)
        const expectedYb = ybBefore + ybReward
        const expectedTaskWork = taskBefore + 1
        for (const [rendererName, state] of [['owner', ownerCompleted], ['player', playerCompleted]]) {
          assert.equal(Number(state.projection.shared.petInfo.yb), expectedYb, rendererName + ' projection must receive the reward delta exactly once')
          assert.equal(taskCounter(state.projection.shared, 'Work'), expectedTaskWork, rendererName + ' projection must receive the work counter exactly once')
          assert.equal(state.projection.shared.activeOption.work, null)
          assert.equal(state.projection.gameTimeMs, dueAtGameMs)
        }

        const completedJobRows = (await readScheduledJobRows(fixture.dbPath)).filter(job => job.id === jobId)
        assert.equal(completedJobRows.length, 1)
        assert.equal(completedJobRows[0].status, 'completed')
        const rewardRows = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'work')
        const completionRows = (await readEventRows(fixture.dbPath, { type: 'activity.completed' }))
          .filter(event => event.payload.kind === 'work' && event.payload.activityId === 'bz')
        assert.equal(rewardRows.length, 1, 'server SQLite must contain exactly one work reward event')
        assert.equal(completionRows.length, 1, 'server SQLite must contain exactly one work completion event')
        assert.equal(rewardRows[0].gameTimeMs, dueAtGameMs)
        assert.equal(completionRows[0].gameTimeMs, dueAtGameMs)
        const afterEngine = await readCanonicalEngine(fixture.dbPath)
        assert.equal(Number(afterEngine.save.petInfo.yb), expectedYb)
        assert.equal(taskCounter(afterEngine.save, 'Work'), expectedTaskWork)
        assert.equal(afterEngine.save.activeOption.work, null)
        assert.equal(afterEngine.scheduledJobs.find(job => job.id === jobId)?.status, 'completed')

        // Repeat the catch-up after a real restart. Both renderers must observe
        // the already-completed state with no second reward, event or job.
        await owner.close()
        await player.close()
        await waitForClients(server, 0, 'timed-work-both-renderers zero clients before restart')
        await fixture.stopServer()
        await fixture.setClock(dueAtGameMs + 30 * 60_000)
        server = await fixture.startServer()
        const replayHealth = await server.health()
        assert.equal(replayHealth.ready, true)
        assert.equal(replayHealth.activeClientCount, 0)
        const replayRewardRows = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'work')
        const replayCompletionRows = (await readEventRows(fixture.dbPath, { type: 'activity.completed' }))
          .filter(event => event.payload.kind === 'work' && event.payload.activityId === 'bz')
        const replayJobRows = (await readScheduledJobRows(fixture.dbPath)).filter(job => job.id === jobId)
        assert.equal(replayRewardRows.length, 1, 'replayed catch-up must not grant work reward twice')
        assert.equal(replayCompletionRows.length, 1, 'replayed catch-up must not emit a second completion event')
        assert.equal(replayJobRows.length, 1, 'replayed catch-up must not insert a duplicate job row')
        assert.equal(replayJobRows[0].status, 'completed')

        await fixture.relaunchApp()
        await fixture.relaunchPlayerApp()
        await owner.waitOnline(30_000)
        await player.waitOnline(30_000)
        const replayProjection = await waitFor(async () => {
          const left = await owner.projection()
          const right = await player.projection()
          if (left === null || right === null) return null
          if (Number(left.shared?.petInfo?.yb) !== expectedYb) return null
          if (Number(right.shared?.petInfo?.yb) !== expectedYb) return null
          if (taskCounter(left.shared, 'Work') !== expectedTaskWork) return null
          if (taskCounter(right.shared, 'Work') !== expectedTaskWork) return null
          if (left.shared?.activeOption?.work !== null || right.shared?.activeOption?.work !== null) return null
          return sameProjection(left, right) ? { left, right } : null
        }, 'both renderers observe no duplicate work credit after restart', 30_000)
        assert.equal(Number(replayProjection.left.shared.petInfo.yb), expectedYb)
        assert.equal(Number(replayProjection.right.shared.petInfo.yb), expectedYb)
        assert.equal(taskCounter(replayProjection.left.shared, 'Work'), expectedTaskWork)
        assert.equal(taskCounter(replayProjection.right.shared, 'Work'), expectedTaskWork)
        const finalRewardRows = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'work')
        const finalCompletionRows = (await readEventRows(fixture.dbPath, { type: 'activity.completed' }))
          .filter(event => event.payload.kind === 'work' && event.payload.activityId === 'bz')
        assert.equal(finalRewardRows.length, 1)
        assert.equal(finalCompletionRows.length, 1)

        timedBothRendererEvidence = {
          bothRenderersSawServerDeadline: true,
          ownerDueAtGameMs: Number(ownerStarted.payload.dueAtGameMs),
          playerDueAtGameMs: Number(playerStarted.payload.dueAtGameMs),
          jobRowDueAtGameMs: jobRowsAtStart[0].dueAtGameMs,
          sameStartEventSeq: ownerStarted.eventSeq === playerStarted.eventSeq,
          ownerStartEventCount: ownerCompleted.startCount,
          playerStartEventCount: playerCompleted.startCount,
          ownerRewardEventCount: ownerCompleted.rewardCount,
          playerRewardEventCount: playerCompleted.rewardCount,
          ownerCompletionEventCount: ownerCompleted.completionCount,
          playerCompletionEventCount: playerCompleted.completionCount,
          exactlyOneCompletionPerRenderer: true,
          sameRewardPayloadInBothRenderers: hash(ownerCompleted.reward.payload) === hash(playerCompleted.reward.payload),
          ybBefore,
          ybReward,
          ybAfterBothRenderers: Number(replayProjection.left.shared.petInfo.yb),
          taskWorkBefore: taskBefore,
          taskWorkAfterBothRenderers: taskCounter(replayProjection.left.shared, 'Work'),
          serverRewardEventCount: rewardRows.length,
          serverCompletionEventCount: completionRows.length,
          replayRewardEventCount: finalRewardRows.length,
          replayCompletionEventCount: finalCompletionRows.length,
          duplicateCreditAfterRestart: finalRewardRows.length !== 1 || Number(replayProjection.left.shared.petInfo.yb) !== expectedYb,
          bothRenderersConvergedAfterRestart: sameProjection(replayProjection.left, replayProjection.right),
        }
        return timedBothRendererEvidence
      } finally {
        await fixture.cleanup()
      }
    })

    await step(SCENARIO_ADVANCE_WHILE_EMPTY, async () => {
      const { advanceSchedulerChunk } = await loadRuntimeOracle()
      const enabledFixture = await createClockedServerFixture(root, 'advance-empty-enabled', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
      })
      let enabledDetail
      try {
        let app = enabledFixture.app
        let server = enabledFixture.server
        await ensureWorkReady(app, 'advance-empty-enabled')
        const started = await app.command(
          { type: 'job.startWork', payload: { jobId: 'bz' } },
          'advance-empty-enabled-start-work',
        )
        assert.equal(started.status, 'applied', JSON.stringify(started.error))
        const dueAtGameMs = Number(started.result.dueAtGameMs)
        await app.close()
        await waitForClients(server, 0, 'enabled fixture zero clients before restart')
        await enabledFixture.stopServer()
        const before = await readPetState(enabledFixture.dbPath)
        const engineBefore = await readCanonicalEngine(enabledFixture.dbPath)
        assert.equal(engineBefore.advanceWhileEmpty, true)
        assert.equal(before.gameTimeMs, engineBefore.gameTimeMs)
        const expectedTicks = (dueAtGameMs - before.gameTimeMs) / 60_000
        assert.equal(expectedTicks, 30)
        const { advanceSchedulerChunk } = await loadRuntimeOracle()
        const expected = advanceSchedulerChunk(engineBefore, {
          gameTimeMs: engineBefore.gameTimeMs,
          environment: engineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, dueAtGameMs, { maxChunkTicks: 1_440 })
        assert.equal(expected.ok, true)
        assert.equal(expected.ticks, expectedTicks)
        await enabledFixture.setClock(dueAtGameMs)
        server = await enabledFixture.startServer()
        const restartHealth = await server.health()
        assert.equal(restartHealth.advanceWhileEmpty, true)
        assert.equal(restartHealth.activeClientCount, 0)
        assert.equal(restartHealth.ready, true)
        const after = await readPetState(enabledFixture.dbPath)
        const expectedGameTime = before.gameTimeMs + expectedTicks * 60_000
        const expectedRevision = before.revision + 1
        const expectedEventSeq = before.eventSeq + expected.events.length
        assert.equal(after.gameTimeMs, expectedGameTime)
        assert.equal(after.revision, expectedRevision)
        assert.equal(after.eventSeq, expectedEventSeq)
        const afterEngine = await readCanonicalEngine(enabledFixture.dbPath)
        assert.equal(hash(afterEngine.save), hash(expected.state.save))
        const rewardEvents = (await readEventRows(enabledFixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'work')
        assert.equal(rewardEvents.length, 1, 'enabled zero-client catch-up must complete a scheduled work effect exactly once')
        assert.equal(rewardEvents[0].gameTimeMs, dueAtGameMs)
        const job = (await readScheduledJobRows(enabledFixture.dbPath))[0]
        assert.equal(job.status, 'completed')

        // With true, zero clients continue advancing in real scheduler passes.
        const liveBefore = await readPetState(enabledFixture.dbPath)
        const liveEngineBefore = await readCanonicalEngine(enabledFixture.dbPath)
        const liveTarget = dueAtGameMs + 60_000
        const liveExpected = advanceSchedulerChunk(liveEngineBefore, {
          gameTimeMs: liveEngineBefore.gameTimeMs,
          environment: liveEngineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, liveTarget, { maxChunkTicks: 1_440 })
        assert.equal(liveExpected.ticks, 1)
        await enabledFixture.setClock(liveTarget)
        const liveAfter = await waitFor(async () => {
          const current = await readPetState(enabledFixture.dbPath)
          return current.gameTimeMs === liveBefore.gameTimeMs + 60_000 ? current : null
        }, 'enabled advance-while-empty live zero-client tick', 10_000)
        assert.equal(liveAfter.revision, liveBefore.revision + 1)
        assert.equal(liveAfter.eventSeq, liveBefore.eventSeq + liveExpected.events.length)
        assert.equal((await server.health()).activeClientCount, 0)
        enabledDetail = {
          advanceWhileEmpty: restartHealth.advanceWhileEmpty,
          activeClientCountAtRestart: restartHealth.activeClientCount,
          expectedTicks,
          observedRestartTicks: (after.gameTimeMs - before.gameTimeMs) / 60_000,
          gameTimeBefore: before.gameTimeMs,
          gameTimeAfterRestart: after.gameTimeMs,
          gameTimeExpected: expectedGameTime,
          revisionBefore: before.revision,
          revisionAfterRestart: after.revision,
          revisionExpected: expectedRevision,
          eventSeqBefore: before.eventSeq,
          eventSeqAfterRestart: after.eventSeq,
          eventSeqExpected: expectedEventSeq,
          scheduledRewardEventCount: rewardEvents.length,
          scheduledRewardAtDueTime: rewardEvents[0].gameTimeMs === dueAtGameMs,
          scheduledJobStatus: job.status,
          liveZeroClientTicks: (liveAfter.gameTimeMs - liveBefore.gameTimeMs) / 60_000,
          liveZeroClientRevisionDelta: liveAfter.revision - liveBefore.revision,
          liveZeroClientEventSeqDelta: liveAfter.eventSeq - liveBefore.eventSeq,
          exactRestartDeltas: true,
          exactLiveDeltas: true,
        }
      } finally {
        await enabledFixture.cleanup()
      }

      const frozenFixture = await createClockedServerFixture(root, 'advance-empty-frozen', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: false,
      })
      try {
        let app = frozenFixture.app
        let server = frozenFixture.server
        await ensureWorkReady(app, 'advance-empty-frozen')
        const started = await app.command(
          { type: 'job.startWork', payload: { jobId: 'bz' } },
          'advance-empty-frozen-start-work',
        )
        assert.equal(started.status, 'applied', JSON.stringify(started.error))
        const dueAtGameMs = Number(started.result.dueAtGameMs)
        const baseline = await readPetState(frozenFixture.dbPath)
        const baselineEngine = await readCanonicalEngine(frozenFixture.dbPath)
        assert.equal(baselineEngine.advanceWhileEmpty, false)
        await app.close()
        await waitForClients(server, 0, 'frozen fixture zero clients before restart')
        await frozenFixture.stopServer()
        const stoppedEngine = await readCanonicalEngine(frozenFixture.dbPath)
        assert.equal(stoppedEngine.advanceWhileEmpty, false)

        const emptyWallGapMs = 10 * 60_000
        const resumeWallMs = stoppedEngine.lastSchedulerWallMs + emptyWallGapMs
        await frozenFixture.setClock(resumeWallMs)
        server = await frozenFixture.startServer()
        const frozenHealth = await server.health()
        assert.equal(frozenHealth.advanceWhileEmpty, false)
        assert.equal(frozenHealth.activeClientCount, 0)
        assert.equal(frozenHealth.ready, true)
        const frozenState = await readPetState(frozenFixture.dbPath)
        assert.equal(frozenState.gameTimeMs, baseline.gameTimeMs, 'false must freeze game time across the zero-client interval')
        assert.equal(frozenState.revision, baseline.revision, 'false must not create a zero-client revision')
        assert.equal(frozenState.eventSeq, baseline.eventSeq, 'false must not create zero-client events')
        const frozenJob = (await readScheduledJobRows(frozenFixture.dbPath)).find(job => job.dueAtGameMs === dueAtGameMs)
        assert.equal(frozenJob.status, 'pending', 'false must leave pending work pending across the empty interval')

        app = await frozenFixture.relaunchApp()
        await waitForClients(server, 1, 'frozen fixture one reconnected client')
        const beforeLive = await waitFor(async () => {
          const state = await readPetState(frozenFixture.dbPath)
          const coverage = await readOpenCoverageRows(frozenFixture.dbPath)
          return coverage.length === 1 && coverage[0].connectedAtMs === resumeWallMs ? state : null
        }, 'frozen fixture resumed active coverage', 10_000)
        const liveEngineBefore = await readCanonicalEngine(frozenFixture.dbPath)
        assert.equal(liveEngineBefore.sessionCoverage.filter(interval => interval.disconnectedAtWallMs === undefined).length, 1)
        assert.equal(liveEngineBefore.lastSchedulerWallMs, resumeWallMs, 'resume must anchor at the actual reconnect wall')
        const expectedLive = advanceSchedulerChunk(liveEngineBefore, {
          gameTimeMs: liveEngineBefore.gameTimeMs,
          environment: liveEngineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, resumeWallMs + 60_000, { maxChunkTicks: 1_440 })
        assert.equal(expectedLive.ok, true)
        assert.equal(expectedLive.ticks, 1)
        await frozenFixture.setClock(resumeWallMs + 60_000)
        const afterLive = await waitFor(async () => {
          const state = await readPetState(frozenFixture.dbPath)
          return state.gameTimeMs === beforeLive.gameTimeMs + 60_000 ? state : null
        }, 'frozen fixture first live scheduler tick', 15_000)
        assert.equal(afterLive.revision, beforeLive.revision + 1)
        assert.equal(afterLive.eventSeq, beforeLive.eventSeq + expectedLive.events.length)
        const afterLiveEngine = await readCanonicalEngine(frozenFixture.dbPath)
        assert.equal(hash(afterLiveEngine.save), hash(expectedLive.state.save), 'resume tick must match the deterministic runtime oracle')
        const onLineBefore = Number(beforeLive && liveEngineBefore.save.petInfo.onLineTime)
        const onLineAfter = Number(afterLiveEngine.save.petInfo.onLineTime)
        assert.equal(onLineAfter, onLineBefore + 1, 'the first post-reconnect live tick must credit exactly one online minute')
        const pendingJobAfterResume = (await readScheduledJobRows(frozenFixture.dbPath)).find(job => job.dueAtGameMs === dueAtGameMs)
        assert.equal(pendingJobAfterResume.status, 'pending')
        const wallElapsedMinutes = (resumeWallMs + 60_000 - baseline.gameTimeMs) / 60_000
        const retroactiveTicks = (afterLive.gameTimeMs - baseline.gameTimeMs) / 60_000 - 1
        assert.equal(retroactiveTicks, 0, 'zero-client wall time must never be backfilled on reconnect')
        return {
          enabled: enabledDetail,
          disabled: {
            advanceWhileEmpty: frozenHealth.advanceWhileEmpty,
            activeClientCountWhileFrozen: frozenHealth.activeClientCount,
            emptyWallGapMs,
            wallElapsedMinutes,
            zeroClientGameTimeDelta: frozenState.gameTimeMs - baseline.gameTimeMs,
            zeroClientRevisionDelta: frozenState.revision - baseline.revision,
            zeroClientEventSeqDelta: frozenState.eventSeq - baseline.eventSeq,
            pendingJobBeforeRelapse: frozenJob.status,
            pendingJobAfterResume: pendingJobAfterResume.status,
            reconnectedAtWallMs: resumeWallMs,
            firstLiveTickGameTimeDelta: afterLive.gameTimeMs - beforeLive.gameTimeMs,
            firstLiveTickRevisionDelta: afterLive.revision - beforeLive.revision,
            firstLiveTickEventSeqDelta: afterLive.eventSeq - beforeLive.eventSeq,
            firstLiveTickExpectedEventSeqDelta: expectedLive.events.length,
            onLineTimeDelta: onLineAfter - onLineBefore,
            retroactiveTicks,
            frozenWithoutBackfill: retroactiveTicks === 0 && frozenState.gameTimeMs === baseline.gameTimeMs,
            exactFrozenDeltas: true,
          },
        }
      } finally {
        await frozenFixture.cleanup()
      }
    })

    await step(SCENARIO_ADVANCE_RANDOM_RECONNECT, async () => {
      const fixture = await createClockedServerFixture(root, 'advance-empty-random-reconnect', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
      })
      try {
        let app = fixture.app
        let server = fixture.server
        const connectedBaseline = await waitFor(async () => {
          const projection = await app.projection()
          return projection?.shared?.havePet === true ? projection : null
        }, 'random-reconnect baseline projection', 20_000)
        const onLineBaseline = Number(connectedBaseline.shared.petInfo.onLineTime)
        await app.close()
        await waitForClients(server, 0, 'random-reconnect fixture zero clients')
        await fixture.stopServer()
        const before = await readPetState(fixture.dbPath)
        const engineBefore = await readCanonicalEngine(fixture.dbPath)
        assert.equal(engineBefore.advanceWhileEmpty, true)
        assert.equal(before.lastSchedulerWallMs, TIME_FIXTURE_CLOCK_MS)
        const emptyIntervalMinutes = 19 * 60 + 5
        const targetWallMs = TIME_FIXTURE_CLOCK_MS + emptyIntervalMinutes * 60_000
        const { advanceSchedulerChunk } = await loadRuntimeOracle()
        const expected = advanceSchedulerChunk(engineBefore, {
          gameTimeMs: engineBefore.gameTimeMs,
          environment: engineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, targetWallMs, { maxChunkTicks: 1_440 })
        assert.equal(expected.ok, true)
        assert.equal(expected.catchingUp, false)
        assert.equal(expected.ticks, emptyIntervalMinutes)
        assert.ok(expected.events.length > 0, 'enabled empty interval must publish canonical events')
        const expectedTypeCounts = countBy(expected.events.map(event => event.type))
        assert.ok((expectedTypeCounts['pet.statsChanged'] ?? 0) > 0, 'RNG-driven minute events must be present')
        assert.ok((expectedTypeCounts['mail.arrived'] ?? 0) > 0, 'the crossed daily boundary must deliver deterministic mail')
        const expectedEventSeq = before.eventSeq + expected.events.length
        const expectedRevision = before.revision + 1

        await fixture.setClock(targetWallMs)
        server = await fixture.startServer()
        const after = await waitFor(async () => {
          const state = await readPetState(fixture.dbPath)
          return state.gameTimeMs === targetWallMs
            && state.revision === expectedRevision
            && state.eventSeq === expectedEventSeq
            ? state
            : null
        }, 'enabled zero-client catch-up reaches the exact clock target', 30_000)
        const afterHealth = await server.health()
        assert.equal(afterHealth.activeClientCount, 0)
        assert.equal(afterHealth.advanceWhileEmpty, true)
        const engineAfter = await readCanonicalEngine(fixture.dbPath)
        assert.equal(hash(engineAfter.save), hash(expected.state.save), 'random/event outcome state must match the deterministic oracle')
        assert.equal(hash(engineAfter.rng), hash(expected.state.rng), 'RNG state must match the deterministic oracle')
        assert.notEqual(hash(engineBefore.rng), hash(engineAfter.rng), 'empty interval must advance deterministic RNG state')
        assert.equal(Number(engineAfter.save.petInfo.onLineTime), onLineBaseline, 'zero-client catch-up must not credit online time')
        const allRowsAfterCatchup = await readEventRows(fixture.dbPath)
        const catchupRows = allRowsAfterCatchup.filter(event => event.eventSeq > before.eventSeq)
        assert.equal(catchupRows.length, expected.events.length, 'every expected event must be persisted exactly once')
        assert.deepEqual(catchupRows.map(event => event.eventSeq), expected.events.map((_, index) => before.eventSeq + index + 1))
        assert.deepEqual(catchupRows.map(event => event.type), expected.events.map(event => event.type))
        assert.equal(hash(catchupRows.map(event => event.payload)), hash(expected.events.map(event => event.payload)))
        assert.deepEqual(countBy(catchupRows.map(event => event.type)), expectedTypeCounts)
        const uniqueCatchupSeqs = new Set(catchupRows.map(event => event.eventSeq))
        assert.equal(uniqueCatchupSeqs.size, catchupRows.length)
        const mailEvents = catchupRows.filter(event => event.type === 'mail.arrived')
        assert.equal(mailEvents.length, expectedTypeCounts['mail.arrived'])

        app = await fixture.relaunchApp()
        await waitForClients(server, 1, 'random-reconnect one authenticated client', 20_000)
        const reconnected = await waitFor(async () => {
          const projection = await app.projection()
          return projection !== null
            && projection.revision === expectedRevision
            && projection.eventSeq === expectedEventSeq
            && projection.gameTimeMs === targetWallMs
            && projectionHash(projection) === hash(expected.state.save)
            ? projection
            : null
        }, 'reconnected renderer applies the precomputed empty-interval outcome', 20_000)
        await app.requestResync()
        const afterResync = await waitFor(async () => {
          const projection = await app.projection()
          return projection !== null
            && projection.revision === expectedRevision
            && projection.eventSeq === expectedEventSeq
            && projectionHash(projection) === hash(expected.state.save)
            ? projection
            : null
        }, 'random-reconnect resync remains exact', 10_000)
        const stateAfterReconnect = await readPetState(fixture.dbPath)
        assert.equal(stateAfterReconnect.gameTimeMs, after.gameTimeMs)
        assert.equal(stateAfterReconnect.revision, after.revision, 'reconnect must not commit another revision')
        assert.equal(stateAfterReconnect.eventSeq, after.eventSeq, 'reconnect must not backfill/duplicate events')
        const allRowsAfterReconnect = await readEventRows(fixture.dbPath)
        assert.equal(allRowsAfterReconnect.length, allRowsAfterCatchup.length, 'reconnect must not append event rows')
        assert.equal(allRowsAfterReconnect.filter(event => event.eventSeq > before.eventSeq).length, expected.events.length)
        const duplicateEventSeqs = allRowsAfterReconnect.length - new Set(allRowsAfterReconnect.map(event => event.eventSeq)).size
        assert.equal(duplicateEventSeqs, 0)
        assert.equal(Number(engineAfter.save.petInfo.onLineTime), onLineBaseline)
        assert.equal(projectionHash(reconnected), projectionHash(afterResync))
        return {
          advanceWhileEmpty: afterHealth.advanceWhileEmpty,
          zeroClientsDuringAdvance: afterHealth.activeClientCount === 0,
          emptyIntervalMinutes,
          wallTargetMs: targetWallMs,
          expectedTicks: expected.ticks,
          observedTicks: (after.gameTimeMs - before.gameTimeMs) / 60_000,
          revisionBefore: before.revision,
          revisionAfterCatchup: after.revision,
          revisionExpected: expectedRevision,
          eventSeqBefore: before.eventSeq,
          eventSeqAfterCatchup: after.eventSeq,
          eventSeqExpected: expectedEventSeq,
          deterministicEventCount: expected.events.length,
          observedEventCount: catchupRows.length,
          eventTypeCounts: expectedTypeCounts,
          randomizedStatsEventCount: expectedTypeCounts['pet.statsChanged'] ?? 0,
          dailyBoundaryMailEventCount: mailEvents.length,
          deterministicRngAdvanced: hash(engineBefore.rng) !== hash(engineAfter.rng),
          rngMatchedOracle: hash(engineAfter.rng) === hash(expected.state.rng),
          stateMatchedOracle: hash(engineAfter.save) === hash(expected.state.save),
          eventPayloadsMatchedOracle: hash(catchupRows.map(event => event.payload)) === hash(expected.events.map(event => event.payload)),
          onLineTimeBaseline: onLineBaseline,
          onLineTimeAfterCatchup: Number(engineAfter.save.petInfo.onLineTime),
          connectedProjectionRevision: reconnected.revision,
          connectedProjectionEventSeq: reconnected.eventSeq,
          connectedProjectionHash: projectionHash(reconnected),
          resyncedProjectionHash: projectionHash(afterResync),
          reconnectRevisionDelta: stateAfterReconnect.revision - after.revision,
          reconnectEventSeqDelta: stateAfterReconnect.eventSeq - after.eventSeq,
          reconnectEventRowDelta: allRowsAfterReconnect.length - allRowsAfterCatchup.length,
          duplicateEventSeqs,
          activeClientCountAfterReconnect: (await server.health()).activeClientCount,
          appliedOnceWithoutBackfill: stateAfterReconnect.revision === after.revision
            && stateAfterReconnect.eventSeq === after.eventSeq
            && allRowsAfterReconnect.length === allRowsAfterCatchup.length,
        }
      } finally {
        await fixture.cleanup()
      }
    })

    await step(SCENARIO_ONLINE_SIGNIN, async () => {
      const fixture = await createClockedServerFixture(root, 'online-signin-split', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
      })
      try {
        let app = fixture.app
        let server = fixture.server
        const base = TIME_FIXTURE_CLOCK_MS
        const baseProjection = await waitFor(async () => {
          const projection = await app.projection()
          return projection?.shared?.havePet === true ? projection : null
        }, 'online split baseline projection', 20_000)
        const onLineBaseline = Number(baseProjection.shared.petInfo.onLineTime)
        const onlineDataBaseline = Number(baseProjection.shared.petInfo.onlineDataTime)
        const signinBaseline = signinState(baseProjection.shared)
        const signed = await app.command({ type: 'signin.sign', payload: {} }, 'online-split-signin-once')
        assert.equal(signed.status, 'applied', 'daily sign-in rejected: ' + JSON.stringify(signed.error))
        const signinDay = Number(signed.result.day)
        assert.equal(Number.isSafeInteger(signinDay), true)
        const afterSignin = await waitFor(async () => {
          const projection = await app.projection()
          return projection?.revision >= signed.revision ? projection : null
        }, 'daily sign-in projection', 10_000)
        let signedState = signinState(afterSignin.shared)
        assert.equal(countSigninDay(signedState, signinDay), 1, 'daily sign-in must grant the day exactly once')
        let signinRewardEvents = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'signin')
        assert.equal(signinRewardEvents.length, 1)

        const duplicateOp = await app.command(
          { type: 'signin.sign', payload: {} },
          'online-split-signin-once',
        )
        assert.equal(duplicateOp.status, 'duplicate', 'same-op sign-in retry must be idempotent')
        const duplicateNewOp = await app.command(
          { type: 'signin.sign', payload: {} },
          'online-split-signin-second-op',
        )
        assert.equal(duplicateNewOp.status, 'rejected')
        assert.equal(duplicateNewOp.error?.code, 'already_claimed')
        signinRewardEvents = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'signin')
        assert.equal(signinRewardEvents.length, 1, 'replayed sign-in commands must not grant a second reward')
        signedState = signinState((await app.projection()).shared)

        const coveredStart = await readPetState(fixture.dbPath)
        const coveredEngineBefore = await readCanonicalEngine(fixture.dbPath)
        const openCoverageBefore = coveredEngineBefore.sessionCoverage.filter(interval => interval.disconnectedAtWallMs === undefined)
        assert.equal(openCoverageBefore.length, 1, 'the connected renderer must own one open coverage interval')
        assert.equal(openCoverageBefore[0].connectedAtWallMs, base)
        const coveredTarget = base + 5 * 60_000
        const { advanceSchedulerChunk } = await loadRuntimeOracle()
        const coveredExpected = advanceSchedulerChunk(coveredEngineBefore, {
          gameTimeMs: coveredEngineBefore.gameTimeMs,
          environment: coveredEngineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, coveredTarget, { maxChunkTicks: 1_440 })
        assert.equal(coveredExpected.ok, true)
        assert.equal(coveredExpected.ticks, 5)
        await fixture.setClock(coveredTarget)
        const coveredAfter = await waitFor(async () => {
          const state = await readPetState(fixture.dbPath)
          return state.gameTimeMs === coveredTarget ? state : null
        }, 'five covered online minutes', 15_000)
        assert.equal(coveredAfter.revision, coveredStart.revision + 1)
        assert.equal(coveredAfter.eventSeq, coveredStart.eventSeq + coveredExpected.events.length)
        const coveredEngineAfter = await readCanonicalEngine(fixture.dbPath)
        assert.equal(hash(coveredEngineAfter.save), hash(coveredExpected.state.save))
        assert.equal(Number(coveredEngineAfter.save.petInfo.onLineTime), onLineBaseline + 5)
        assert.equal(Number(coveredEngineAfter.save.petInfo.onlineDataTime), onlineDataBaseline + 5)
        assert.equal(signinState(coveredEngineAfter.save).isOnlineLastTime, signinBaseline.isOnlineLastTime - 5)
        assert.equal((await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'signin').length, 1)
        assert.equal((await server.health()).activeClientCount, 1)

        await app.close()
        await waitForClients(server, 0, 'online split disconnect')
        const closedCoverage = await readCoverageIntervals(fixture.dbPath)
        const firstInterval = closedCoverage.find(interval => interval.connectedAtWallMs === base)
        assert.notEqual(firstInterval, undefined, 'first known coverage interval must be persisted')
        assert.equal(firstInterval.disconnectedAtWallMs, coveredTarget)
        assert.equal(closedCoverage.filter(interval => interval.disconnectedAtWallMs === undefined).length, 0)
        const stateAtGapStart = await readPetState(fixture.dbPath)
        const onLineAtGapStart = Number(coveredEngineAfter.save.petInfo.onLineTime)
        const signinAtGapStart = signinState(coveredEngineAfter.save)
        await fixture.stopServer()

        const gapEngineBefore = await readCanonicalEngine(fixture.dbPath)
        assert.equal(gapEngineBefore.lastSchedulerWallMs, coveredTarget)
        const gapTarget = base + 15 * 60_000
        const gapExpected = advanceSchedulerChunk(gapEngineBefore, {
          gameTimeMs: gapEngineBefore.gameTimeMs,
          environment: gapEngineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, gapTarget, { maxChunkTicks: 1_440 })
        assert.equal(gapExpected.ok, true)
        assert.equal(gapExpected.ticks, 10)
        await fixture.setClock(gapTarget)
        server = await fixture.startServer()
        const afterGapHealth = await server.health()
        assert.equal(afterGapHealth.activeClientCount, 0)
        assert.equal(afterGapHealth.ready, true)
        const afterGap = await readPetState(fixture.dbPath)
        assert.equal(afterGap.gameTimeMs, gapTarget)
        assert.equal(afterGap.revision, stateAtGapStart.revision + 1)
        assert.equal(afterGap.eventSeq, stateAtGapStart.eventSeq + gapExpected.events.length)
        const gapEngineAfter = await readCanonicalEngine(fixture.dbPath)
        assert.equal(hash(gapEngineAfter.save), hash(gapExpected.state.save))
        assert.equal(Number(gapEngineAfter.save.petInfo.onLineTime), onLineAtGapStart, 'zero-client gap must not credit online time')
        assert.equal(Number(gapEngineAfter.save.petInfo.onlineDataTime), onlineDataBaseline + 5)
        assert.equal(signinState(gapEngineAfter.save).isOnlineLastTime, signinAtGapStart.isOnlineLastTime)
        assert.equal((await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'signin').length, 1)

        app = await fixture.relaunchApp()
        await waitForClients(server, 1, 'online split reconnect')
        const resumedState = await waitFor(async () => {
          const state = await readPetState(fixture.dbPath)
          const open = await readOpenCoverageRows(fixture.dbPath)
          return open.length === 1 && open[0].connectedAtMs === gapTarget ? state : null
        }, 'known reconnect coverage interval', 15_000)
        const resumeEngineBefore = await readCanonicalEngine(fixture.dbPath)
        const resumeTarget = base + 17 * 60_000
        const resumeExpected = advanceSchedulerChunk(resumeEngineBefore, {
          gameTimeMs: resumeEngineBefore.gameTimeMs,
          environment: resumeEngineBefore.environment,
          activeClientCount: 0,
          sessionActive: false,
          actorDeviceId: null,
        }, resumeTarget, { maxChunkTicks: 1_440 })
        assert.equal(resumeExpected.ok, true)
        assert.equal(resumeExpected.ticks, 2)
        const onLineBeforeResume = Number(gapEngineAfter.save.petInfo.onLineTime)
        const signinBeforeResume = signinState(gapEngineAfter.save)
        await fixture.setClock(resumeTarget)
        const resumedAfter = await waitFor(async () => {
          const state = await readPetState(fixture.dbPath)
          return state.gameTimeMs === resumeTarget ? state : null
        }, 'two covered minutes after reconnect', 15_000)
        assert.equal(resumedAfter.revision, resumedState.revision + 1)
        assert.equal(resumedAfter.eventSeq, resumedState.eventSeq + resumeExpected.events.length)
        const finalEngine = await readCanonicalEngine(fixture.dbPath)
        assert.equal(hash(finalEngine.save), hash(resumeExpected.state.save))
        assert.equal(Number(finalEngine.save.petInfo.onLineTime), onLineBeforeResume + 2)
        assert.equal(Number(finalEngine.save.petInfo.onlineDataTime), onlineDataBaseline + 7)
        assert.equal(signinState(finalEngine.save).isOnlineLastTime, signinBeforeResume.isOnlineLastTime - 2)
        const finalSigninAttempt = await app.command(
          { type: 'signin.sign', payload: {} },
          'online-split-signin-after-reconnect',
        )
        assert.equal(finalSigninAttempt.status, 'rejected')
        assert.equal(finalSigninAttempt.error?.code, 'already_claimed')
        const finalSigninRewardEvents = (await readEventRows(fixture.dbPath, { type: 'reward.granted' }))
          .filter(event => event.payload.source === 'signin')
        assert.equal(finalSigninRewardEvents.length, 1, 'daily sign-in reward must survive reconnect/restart exactly once')
        const finalSigninState = signinState(finalEngine.save)
        assert.equal(countSigninDay(finalSigninState, signinDay), 1)
        const finalCoverage = await readCoverageIntervals(fixture.dbPath)
        assert.equal(finalCoverage.filter(interval => interval.disconnectedAtWallMs === undefined).length, 1)
        const finalOpen = finalCoverage.find(interval => interval.disconnectedAtWallMs === undefined)
        assert.equal(finalOpen.connectedAtWallMs, gapTarget)
        const firstCoveredMinutes = (firstInterval.disconnectedAtWallMs - firstInterval.connectedAtWallMs) / 60_000
        const gapMinutes = (finalOpen.connectedAtWallMs - firstInterval.disconnectedAtWallMs) / 60_000
        const secondCoveredMinutes = (resumeTarget - finalOpen.connectedAtWallMs) / 60_000
        const totalOnlineDelta = Number(finalEngine.save.petInfo.onLineTime) - onLineBaseline
        assert.equal(firstCoveredMinutes, 5)
        assert.equal(gapMinutes, 10)
        assert.equal(secondCoveredMinutes, 2)
        assert.equal(totalOnlineDelta, 7, 'only the 5 + 2 covered minutes may accrue')
        return {
          signinDay,
          signinRewardEventCount: finalSigninRewardEvents.length,
          signinDayEntryCount: countSigninDay(finalSigninState, signinDay),
          signinGrantedExactlyOnceAcrossReconnectRestart: finalSigninRewardEvents.length === 1
            && countSigninDay(finalSigninState, signinDay) === 1,
          duplicateOpStatus: duplicateOp.status,
          duplicateNewOpCode: duplicateNewOp.error?.code,
          finalReconnectSigninCode: finalSigninAttempt.error?.code,
          firstCoverageInterval: {
            connectedAtWallMs: firstInterval.connectedAtWallMs,
            disconnectedAtWallMs: firstInterval.disconnectedAtWallMs,
            coveredMinutes: firstCoveredMinutes,
          },
          zeroClientGap: {
            fromWallMs: firstInterval.disconnectedAtWallMs,
            toWallMs: finalOpen.connectedAtWallMs,
            gapMinutes,
            gameTimeDelta: afterGap.gameTimeMs - stateAtGapStart.gameTimeMs,
            revisionDelta: afterGap.revision - stateAtGapStart.revision,
            eventSeqDelta: afterGap.eventSeq - stateAtGapStart.eventSeq,
            expectedEventSeqDelta: gapExpected.events.length,
            onLineTimeDelta: Number(gapEngineAfter.save.petInfo.onLineTime) - onLineAtGapStart,
            onlineDataTimeDelta: Number(gapEngineAfter.save.petInfo.onlineDataTime) - (onlineDataBaseline + 5),
            signinCountdownDelta: signinState(gapEngineAfter.save).isOnlineLastTime - signinAtGapStart.isOnlineLastTime,
          },
          coveredBeforeGap: {
            connectedAtWallMs: base,
            disconnectedAtWallMs: coveredTarget,
            coveredMinutes: firstCoveredMinutes,
            gameTimeDelta: coveredAfter.gameTimeMs - coveredStart.gameTimeMs,
            revisionDelta: coveredAfter.revision - coveredStart.revision,
            eventSeqDelta: coveredAfter.eventSeq - coveredStart.eventSeq,
            expectedEventSeqDelta: coveredExpected.events.length,
            onLineTimeDelta: Number(coveredEngineAfter.save.petInfo.onLineTime) - onLineBaseline,
          },
          coveredAfterGap: {
            connectedAtWallMs: gapTarget,
            observedThroughWallMs: resumeTarget,
            coveredMinutes: secondCoveredMinutes,
            gameTimeDelta: resumedAfter.gameTimeMs - resumedState.gameTimeMs,
            revisionDelta: resumedAfter.revision - resumedState.revision,
            eventSeqDelta: resumedAfter.eventSeq - resumedState.eventSeq,
            expectedEventSeqDelta: resumeExpected.events.length,
            onLineTimeDelta: Number(finalEngine.save.petInfo.onLineTime) - onLineBeforeResume,
          },
          totalOnlineTimeDelta: totalOnlineDelta,
          totalOnlineDataTimeDelta: Number(finalEngine.save.petInfo.onlineDataTime) - onlineDataBaseline,
          totalSigninCountdownDelta: signinState(finalEngine.save).isOnlineLastTime - signinBaseline.isOnlineLastTime,
          retroactiveZeroClientCreditMinutes: totalOnlineDelta - firstCoveredMinutes - secondCoveredMinutes,
          exactCoverageOverlapOnly: totalOnlineDelta === firstCoveredMinutes + secondCoveredMinutes,
        }
      } finally {
        await fixture.cleanup()
      }
    })

    await step(SCENARIO_LOCAL_HANDOFF, async () => {
      const handoffClockBase = Math.floor(Date.now() / 1_000) * 1_000
      const fixture = await createLocalHandoffFixture(
        root,
        'local-authority-handoff',
        baseEnv,
        handoffClockBase,
      )
      try {
        const app = fixture.app
        let server = fixture.server
        const initialLocal = await readLocalDocument(fixture.userData)
        assert.equal(initialLocal.authority.state, 'active')
        assert.equal(initialLocal.authority.stamp.owner, 'local')
        const sourceExport = await app.exportBundle()
        assert.equal(sourceExport.mode, 'local')
        const sourceBundle = JSON.parse(sourceExport.json)
        assert.equal(sourceBundle.authority.owner, 'local')
        assert.equal(sourceBundle.shared.havePet, true)
        const sourceLocalRevision = Number(sourceBundle.authority.revision)
        const sourceLocalEpoch = Number(sourceBundle.authority.epoch)

        // Production LocalRepository -> StorageController upload. The renderer
        // command path freezes the local queue, increments/fences the epoch and
        // exports the real local document; the test never edits bundle fields.
        const uploaded = await app.setMode({
          mode: 'server',
          initialSource: 'upload-local',
          rebindLocalSessions: true,
        })
        assert.equal(uploaded.mode, 'server')
        assert.equal(uploaded.activeMode, 'server')
        assert.equal(uploaded.authority.owner, 'server')
        assert.equal(uploaded.authority.state, 'active')
        assert.equal(uploaded.handoff.direction, 'local_to_server')
        assert.equal(uploaded.handoff.state, 'applied')
        assert.equal(uploaded.handoff.requestedRebind, true)
        const serverAfterUpload = await readAuthorityRow(fixture.dbPath)
        const uploadedPet = await readPetState(fixture.dbPath)
        const localArchivedAfterUpload = await waitFor(async () => {
          const document = await readLocalDocument(fixture.userData)
          return document.authority.state === 'archived' ? document : null
        }, 'local authority archived after upload', 10_000)
        assert.equal(serverAfterUpload.owner, 'server')
        assert.equal(serverAfterUpload.state, 'active')
        assert.equal(serverAfterUpload.epoch, uploaded.handoff.nextEpoch)
        assert.ok(serverAfterUpload.epoch > sourceLocalEpoch)
        assert.equal(uploadedPet.revision > sourceLocalRevision, true, 'server import must fence source revision')
        assert.notEqual(serverAfterUpload.handoffId, sourceBundle.authority.handoffId)
        assert.equal(localArchivedAfterUpload.authority.stamp.owner, 'local')
        assert.ok(Number(localArchivedAfterUpload.authority.stamp.epoch) > sourceLocalEpoch)
        await waitForClients(server, 1, 'handoff owner connection after upload')
        await sleep(250)
        const archivedLocalHashAfterUpload = await fileSha256(localDocumentPath(fixture.userData))
        await sleep(1_200)
        const archivedLocalFrozenAfterUpload = await fileSha256(localDocumentPath(fixture.userData)) === archivedLocalHashAfterUpload
        assert.equal(archivedLocalFrozenAfterUpload, true, 'archived local authority must not tick or mutate while server owns canon')

        // The now-active server must reject a stale real local export before
        // any canonical mutation, then remain writable when the import fails.
        const serverBeforeStaleImport = await readPetState(fixture.dbPath)
        const staleServerImport = await app.importBundle({
          json: JSON.stringify(sourceBundle),
          allowClamp: true,
          rebindLocalSessions: true,
        })
        assert.equal(staleServerImport.status, 'rejected')
        assert.equal(staleServerImport.errorCode, 'authority_fork_risk')
        const serverAfterStaleImport = await readPetState(fixture.dbPath)
        assert.equal(serverAfterStaleImport.gameTimeMs, serverBeforeStaleImport.gameTimeMs)
        assert.equal(serverAfterStaleImport.revision, serverBeforeStaleImport.revision)
        assert.equal(serverAfterStaleImport.eventSeq, serverBeforeStaleImport.eventSeq)
        const serverStillWritable = await app.command(
          { type: 'admin.grantCheat', payload: { stat: 'mood', amount: 1 } },
          'handoff-server-after-stale-import',
        )
        assert.equal(serverStillWritable.status, 'applied')
        await waitFor(async () => (await app.projection())?.revision >= serverStillWritable.revision, 'server projection after stale import', 10_000)

        // Production StorageController server -> local detach. This calls the
        // owner-only exportForDetach command, archives the server, then imports
        // the exact detached bundle through LocalRepository.
        const detached = await app.setMode({ mode: 'local' })
        assert.equal(detached.mode, 'local')
        assert.equal(detached.activeMode, 'local')
        assert.equal(detached.authority.owner, 'local')
        assert.equal(detached.authority.state, 'active')
        assert.equal(detached.handoff.direction, 'server_to_local')
        assert.equal(detached.handoff.state, 'applied')
        const serverArchived = await readAuthorityRow(fixture.dbPath)
        const serverStateWhenArchived = await readPetState(fixture.dbPath)
        const localAfterDetach = await readLocalDocument(fixture.userData)
        assert.equal(serverArchived.owner, 'local')
        assert.equal(serverArchived.state, 'archived')
        assert.equal(serverArchived.handoffEpoch, detached.handoff.nextEpoch)
        assert.equal(localAfterDetach.authority.state, 'active')
        assert.equal(localAfterDetach.authority.stamp.owner, 'local')
        assert.equal(localAfterDetach.authority.stamp.epoch, detached.handoff.nextEpoch)
        assert.equal(localAfterDetach.revision, serverStateWhenArchived.revision)
        const archivedHealth = await server.health()
        assert.equal(archivedHealth.authorityState, 'archived')
        assert.equal(archivedHealth.activeClientCount, 0)

        // Advancing the injected server clock while archived must advance
        // neither game time nor revision/eventSeq.
        await fixture.setClock(handoffClockBase + 5 * 60_000)
        await sleep(1_500)
        const serverStateAfterFrozenWait = await readPetState(fixture.dbPath)
        assert.equal(serverStateAfterFrozenWait.gameTimeMs, serverStateWhenArchived.gameTimeMs)
        assert.equal(serverStateAfterFrozenWait.revision, serverStateWhenArchived.revision)
        assert.equal(serverStateAfterFrozenWait.eventSeq, serverStateWhenArchived.eventSeq)

        // A stale local export is rejected through the production local import
        // planner before touching the document or canonical revision.
        const staleLocalBundle = JSON.parse((await app.exportBundle()).json)
        const localMutation = await app.command(
          { type: 'admin.grantCheat', payload: { stat: 'mood', amount: 1 } },
          'handoff-local-mutation-before-stale-import',
        )
        assert.equal(localMutation.status, 'applied')
        const localProjectionBeforeStaleImport = await waitFor(async () => {
          const projection = await app.projection()
          return projection?.revision >= localMutation.revision ? projection : null
        }, 'local projection after mutation', 10_000)
        const localDocumentBeforeStaleImport = await readLocalDocument(fixture.userData)
        const localHashBeforeStaleImport = await fileSha256(localDocumentPath(fixture.userData))
        const staleLocalImport = await app.importBundle({
          json: JSON.stringify(staleLocalBundle),
          allowClamp: true,
          rebindLocalSessions: true,
        })
        assert.equal(staleLocalImport.status, 'rejected')
        assert.equal(staleLocalImport.errorCode, 'authority_fork_risk')
        const localDocumentAfterStaleImport = await readLocalDocument(fixture.userData)
        assert.equal(localDocumentAfterStaleImport.revision, localDocumentBeforeStaleImport.revision)
        const staleLocalImportFileUnchanged = await fileSha256(localDocumentPath(fixture.userData)) === localHashBeforeStaleImport
        assert.equal(staleLocalImportFileUnchanged, true)
        const localProjectionAfterStaleImport = await app.projection()
        assert.equal(localProjectionAfterStaleImport.revision, localProjectionBeforeStaleImport.revision)
        const localStillWritable = await app.command(
          { type: 'admin.grantCheat', payload: { stat: 'mood', amount: 1 } },
          'handoff-local-after-stale-import',
        )
        assert.equal(localStillWritable.status, 'applied')
        await waitFor(async () => (await app.projection())?.revision >= localStillWritable.revision, 'local projection after failed import', 10_000)

        // Resume local -> archived server, but fault-inject a fenced
        // expectedEpoch on the already-exported command. The bundle itself is
        // the production LocalRepository export and is not edited.
        await app.armCommandDrop('admin.resumeServer')
        const resumeInput = {
          mode: 'server',
          initialSource: 'upload-local',
          rebindLocalSessions: true,
        }
        await app.page.evaluate(input => {
          const scope = window
          // The local->server switch opens a fresh remote connection. The
          // production storage controller intentionally fails closed until
          // that connection is online, so retry the same idempotent switch;
          // once the resume frame is dropped this promise stays pending.
          scope.__C12_HANDOFF_RESULT__ = { done: false, attempts: 0 }
          const attempt = () => {
            scope.__C12_HANDOFF_RESULT__.attempts += 1
            void scope.qqpet.storage.setMode(input).then(status => {
              scope.__C12_HANDOFF_RESULT__ = {
                done: true,
                ok: true,
                attempts: scope.__C12_HANDOFF_RESULT__.attempts,
                mode: status.mode,
                activeMode: status.activeMode,
                handoffState: status.handoff.state,
                handoffReason: status.handoff.reason,
              }
            }).catch(error => {
              const message = String(error?.message ?? error)
              if (message.includes('offline: the server connection is not ready')) {
                setTimeout(attempt, 250)
                return
              }
              scope.__C12_HANDOFF_RESULT__ = {
                done: true,
                ok: false,
                attempts: scope.__C12_HANDOFF_RESULT__.attempts,
                error: message,
              }
            })
          }
          attempt()
        }, resumeInput)
        let frozenObserved = null
        const frozen = await waitFor(async () => {
          try {
            const document = await readLocalDocument(fixture.userData)
            const faultState = await app.websocketFaultState()
            const handoffResult = await app.page.evaluate(() => window.__C12_HANDOFF_RESULT__ ?? null)
            const status = await app.storageStatus()
            frozenObserved = {
              documentAuthority: document.authority,
              documentRevision: document.revision,
              faultState,
              handoffResult,
              status: {
                mode: status.mode,
                activeMode: status.activeMode,
                connection: status.connection,
                readOnly: status.readOnly,
                handoff: status.handoff,
                notice: status.notice,
                lastError: status.lastError,
              },
            }
            return document.authority.state === 'handoff_pending'
              && faultState.droppedCommands === 1
              && faultState.suppressedCommandStatuses >= 0
              ? { document, faultState }
              : null
          } catch (error) {
            frozenObserved = { error: error instanceof Error ? error.stack ?? error.message : String(error) }
            return null
          }
        }, 'frozen local authority with dropped resume command', 30_000).catch(error => {
          let diagnostic = frozenObserved
          try {
            diagnostic = {
              ...(frozenObserved ?? {}),
              serverLogTail: fixture.server.logText().split('\n').filter(line => line.length > 0).slice(-30),
              electronLogTail: app.launchLog.slice(-30),
            }
          } catch { /* keep the primary observation */ }
          throw new Error((error instanceof Error ? error.message : String(error))
            + ' observed=' + JSON.stringify(diagnostic))
        })
        const frozenStatus = await app.storageStatus()
        assert.equal(frozenStatus.handoff.state, 'pending')
        assert.equal(frozenStatus.readOnly, true)
        frozen.status = frozenStatus
        const frozenDocumentHash = await fileSha256(localDocumentPath(fixture.userData))
        const frozenRevision = Number(frozen.document.revision)
        const frozenEpoch = Number(frozen.document.authority.stamp.epoch)
        const frozenCanonicalCommand = await app.command(
          { type: 'admin.grantCheat', payload: { stat: 'mood', amount: 1 } },
          'handoff-local-command-while-frozen',
        )
        assert.equal(frozenCanonicalCommand.status, 'rejected')
        assert.ok(
          ['authority_not_active', 'not_available'].includes(frozenCanonicalCommand.error?.code),
          'frozen local command must fail closed, got ' + JSON.stringify(frozenCanonicalCommand.error),
        )
        assert.equal(frozen.status.readOnly, true)
        assert.equal(await fileSha256(localDocumentPath(fixture.userData)), frozenDocumentHash)
        assert.equal(Number((await readLocalDocument(fixture.userData)).revision), frozenRevision)
        const replay = await app.replayDroppedCommand({ expectedEpochDelta: 1 })
        assert.equal(replay.commandType, 'admin.resumeServer')
        const rolledBack = await waitFor(async () => {
          const result = await app.page.evaluate(() => window.__C12_HANDOFF_RESULT__ ?? null)
          const status = await app.storageStatus()
          const document = await readLocalDocument(fixture.userData)
          return result?.done === true
            && status.handoff.state === 'rolled_back'
            && document.authority.state === 'active'
            ? { result, status, document }
            : null
        }, 'definitive server rejection rolls back frozen local authority', 20_000)
        assert.equal(rolledBack.result.ok, true)
        assert.equal(rolledBack.status.mode, 'local')
        assert.equal(rolledBack.status.activeMode, 'local')
        assert.equal(rolledBack.status.authority.owner, 'local')
        assert.equal(rolledBack.status.authority.state, 'active')
        assert.equal(rolledBack.status.handoff.direction, 'local_to_server')
        assert.equal(rolledBack.status.handoff.state, 'rolled_back')
        assert.equal(rolledBack.status.handoff.reason, 'authority_fork_risk')
        assert.equal(Number(rolledBack.document.revision), frozenRevision - 1, 'rollback must restore the pre-export document exactly')
        assert.equal(Number(rolledBack.document.authority.stamp.epoch), frozenEpoch - 1)
        const serverAfterRollback = await readAuthorityRow(fixture.dbPath)
        const serverStateAfterRollback = await readPetState(fixture.dbPath)
        assert.equal(serverAfterRollback.owner, 'local')
        assert.equal(serverAfterRollback.state, 'archived')
        assert.equal(serverAfterRollback.epoch, serverArchived.epoch)
        assert.equal(serverAfterRollback.handoffId, serverArchived.handoffId)
        assert.equal(serverStateAfterRollback.gameTimeMs, serverStateWhenArchived.gameTimeMs)
        assert.equal(serverStateAfterRollback.revision, serverStateWhenArchived.revision)
        assert.equal(serverStateAfterRollback.eventSeq, serverStateWhenArchived.eventSeq)

        // Retry the same production handoff without the injected fence. It must
        // converge to one active server authority with a higher epoch.
        await sleep(500)
        const resumed = await app.setMode(resumeInput)
        const resumedDiagnostic = {
          mode: resumed.mode,
          activeMode: resumed.activeMode,
          connection: resumed.connection,
          authority: resumed.authority,
          handoff: resumed.handoff,
          revision: resumed.revision,
          eventSeq: resumed.eventSeq,
        }
        assert.equal(resumed.mode, 'server', 'retry failed: ' + JSON.stringify(resumedDiagnostic))
        assert.equal(resumed.activeMode, 'server')
        assert.equal(resumed.handoff.direction, 'local_to_server')
        assert.equal(resumed.handoff.state, 'applied')
        const resumedActive = await waitFor(async () => {
          const status = await app.storageStatus()
          return status.mode === 'server'
            && status.activeMode === 'server'
            && status.authority.owner === 'server'
            && status.authority.state === 'active'
            && status.authority.epoch === resumed.handoff.nextEpoch
            ? status
            : null
        }, 'active server authority projection after resume', 20_000)
        assert.equal(resumedActive.authority.owner, 'server')
        assert.equal(resumedActive.authority.state, 'active')
        const finalAuthority = await readAuthorityRow(fixture.dbPath)
        const finalState = await readPetState(fixture.dbPath)
        const finalLocalArchived = await waitFor(async () => {
          const document = await readLocalDocument(fixture.userData)
          return document.authority.state === 'archived' ? document : null
        }, 'local authority archived after successful resume', 10_000)
        assert.equal(finalAuthority.owner, 'server')
        assert.equal(finalAuthority.state, 'active')
        assert.equal(finalAuthority.handoffEpoch, null)
        assert.equal(finalAuthority.epoch, resumed.handoff.nextEpoch)
        assert.ok(finalAuthority.epoch > frozenEpoch, 'resume epoch must advance beyond the frozen local epoch')
        assert.ok(finalAuthority.epoch > serverArchived.epoch)
        assert.notEqual(finalAuthority.handoffId, serverArchived.handoffId)
        assert.ok(finalAuthority.sourceRevision >= rolledBack.document.revision)
        assert.ok(finalState.revision > rolledBack.document.revision, 'resume must fence and advance canonical revision')
        assert.equal(finalLocalArchived.authority.state, 'archived')
        await sleep(250)
        const finalArchivedLocalHash = await fileSha256(localDocumentPath(fixture.userData))
        await sleep(1_200)
        assert.equal(
          await fileSha256(localDocumentPath(fixture.userData)),
          finalArchivedLocalHash,
          'local archive must remain frozen while resumed server is active',
        )
        const finalServerMutation = await app.command(
          { type: 'admin.grantCheat', payload: { stat: 'mood', amount: 1 } },
          'handoff-final-server-mutation',
        )
        assert.equal(finalServerMutation.status, 'applied')
        await waitFor(async () => (await app.projection())?.revision >= finalServerMutation.revision, 'final active server mutation projection', 10_000)
        const finalStateAfterMutation = await readPetState(fixture.dbPath)
        assert.ok(finalStateAfterMutation.revision > finalState.revision, 'active server command must advance canonical revision')
        assert.equal(await fileSha256(localDocumentPath(fixture.userData)), finalArchivedLocalHash)
        assert.equal((await server.health()).authorityState, 'active')
        return {
          sourceLocalRevision,
          sourceLocalEpoch,
          sourceAuthorityIdHash: hash(sourceBundle.authority.authorityId),
          sourceHandoffIdHash: hash(sourceBundle.authority.handoffId),
          uploadHandoffState: uploaded.handoff.state,
          uploadNextEpoch: uploaded.handoff.nextEpoch,
          uploadServerEpoch: serverAfterUpload.epoch,
          uploadServerRevision: uploadedPet.revision,
          uploadRevisionFenced: uploadedPet.revision > sourceLocalRevision,
          uploadHandoffIdChanged: serverAfterUpload.handoffId !== sourceBundle.authority.handoffId,
          localArchivedAfterUpload: localArchivedAfterUpload.authority.state,
          archivedLocalFrozenAfterUpload,
          staleServerImportStatus: staleServerImport.status,
          staleServerImportErrorCode: staleServerImport.errorCode,
          staleServerImportRevisionDelta: serverAfterStaleImport.revision - serverBeforeStaleImport.revision,
          staleServerImportEventSeqDelta: serverAfterStaleImport.eventSeq - serverBeforeStaleImport.eventSeq,
          serverWritableAfterFailedImport: serverStillWritable.status,
          detachHandoffState: detached.handoff.state,
          detachedServerEpoch: serverArchived.epoch,
          detachedServerHandoffEpoch: serverArchived.handoffEpoch,
          detachedLocalEpoch: localAfterDetach.authority.stamp.epoch,
          detachedLocalRevision: localAfterDetach.revision,
          detachedRevisionMatchesArchivedSource: localAfterDetach.revision === serverStateWhenArchived.revision,
          archivedServerFrozen: serverStateAfterFrozenWait.gameTimeMs === serverStateWhenArchived.gameTimeMs
            && serverStateAfterFrozenWait.revision === serverStateWhenArchived.revision
            && serverStateAfterFrozenWait.eventSeq === serverStateWhenArchived.eventSeq,
          archivedServerGameTimeDelta: serverStateAfterFrozenWait.gameTimeMs - serverStateWhenArchived.gameTimeMs,
          archivedServerRevisionDelta: serverStateAfterFrozenWait.revision - serverStateWhenArchived.revision,
          archivedServerEventSeqDelta: serverStateAfterFrozenWait.eventSeq - serverStateWhenArchived.eventSeq,
          staleLocalImportStatus: staleLocalImport.status,
          staleLocalImportErrorCode: staleLocalImport.errorCode,
          staleLocalImportRevisionDelta: localDocumentAfterStaleImport.revision - localDocumentBeforeStaleImport.revision,
          staleLocalImportFileUnchanged,
          localWritableAfterFailedImport: localStillWritable.status,
          frozenHandoffState: frozen.status.handoff.state,
          frozenDocumentState: frozen.document.authority.state,
          frozenCommandRejectedCode: frozenCanonicalCommand.error?.code,
          frozenDocumentRevision: frozenRevision,
          frozenEpoch,
          injectedResumeFence: replay.expectedEpoch,
          rollbackHandoffState: rolledBack.status.handoff.state,
          rollbackReason: rolledBack.status.handoff.reason,
          rollbackLocalRevision: rolledBack.document.revision,
          rollbackRestoredRevision: rolledBack.document.revision === frozenRevision - 1,
          rollbackRestoredEpoch: rolledBack.document.authority.stamp.epoch === frozenEpoch - 1,
          serverUnchangedAfterRollback: serverStateAfterRollback.gameTimeMs === serverStateWhenArchived.gameTimeMs
            && serverStateAfterRollback.revision === serverStateWhenArchived.revision
            && serverStateAfterRollback.eventSeq === serverStateWhenArchived.eventSeq,
          resumeHandoffState: resumed.handoff.state,
          resumeNextEpoch: resumed.handoff.nextEpoch,
          finalServerEpoch: finalAuthority.epoch,
          finalServerRevision: finalState.revision,
          finalServerHandoffIdChanged: finalAuthority.handoffId !== serverArchived.handoffId,
          finalEpochMonotonic: finalAuthority.epoch > frozenEpoch && frozenEpoch > serverArchived.epoch,
          finalLocalArchivedState: finalLocalArchived.authority.state,
          localFrozenAfterFinalResume: true,
          finalServerMutationStatus: finalServerMutation.status,
          finalServerMutationRevisionDelta: finalStateAfterMutation.revision - finalState.revision,
          finalAuthorityOwner: finalAuthority.owner,
          finalAuthorityState: finalAuthority.state,
          handWrittenBundleFieldsUsed: false,
        }
      } finally {
        await fixture.cleanup()
      }
    })

    await step(SCENARIO_SECRET_BOUNDARY, async () => {
      const fixture = await createClockedServerFixture(root, 'secret-boundary-audit', baseEnv, {
        clockMs: TIME_FIXTURE_CLOCK_MS,
        advanceWhileEmpty: true,
        withPlayer: true,
      })
      try {
        const owner = fixture.app
        const player = fixture.player
        const boundary = await import(
          pathToFileURL(join(ROOT, 'server/dist/src/shared/sync/data-boundary.js')).href
        )
        const neverUploadKeys = [...boundary.NEVER_UPLOAD_KEYS]
        const deviceSettingsKeys = [...boundary.DEVICE_LOCAL_SETTINGS_KEYS]
        const devicePetKeys = [...boundary.DEVICE_ONLY_PET_INFO_KEYS]
        const answerFields = new Set([...boundary.SESSION_ANSWER_KEY_FIELDS, 'correctAnswer', 'correctIndex'])
        const deviceSettingsSet = new Set(deviceSettingsKeys)
        const canonicalForbiddenColumns = new Set([
          ...neverUploadKeys,
          ...deviceSettingsKeys,
          ...devicePetKeys,
          'localDeviceId',
          'device',
          'localSettings',
        ])
        const canonicalGlobalForbidden = new Set([
          ...neverUploadKeys,
          ...devicePetKeys,
          'localDeviceId',
          'device',
          'localSettings',
          'presentation',
        ])
        const findCanonicalBoundaryPaths = value => {
          const paths = findKeys(value, canonicalGlobalForbidden)
          const settingsBlocks = []
          if (value !== null && typeof value === 'object') {
            if (value.settings !== null && typeof value.settings === 'object') {
              settingsBlocks.push({ prefix: '', settings: value.settings })
            }
            const engineSave = value.save
            if (engineSave !== null && typeof engineSave === 'object'
              && engineSave.settings !== null && typeof engineSave.settings === 'object') {
              settingsBlocks.push({ prefix: 'save.', settings: engineSave.settings })
            }
          }
          for (const block of settingsBlocks) {
            for (const path of findKeys(block.settings, deviceSettingsSet)) {
              paths.push(block.prefix + path.slice(1))
            }
          }
          return paths
        }
        const projectionSharedForbidden = new Set([
          ...boundary.NEVER_UPLOAD_KEYS,
          ...devicePetKeys,
          'localDeviceId',
        ])
        await waitConverged(owner, player, 0, 20_000)

        // Create a real server-side exam session so the audit has a legitimate
        // closed session payload containing grading keys.
        await seedExamLessons(fixture.dbPath, 9)
        const examStart = await owner.command(
          { type: 'exam.start', payload: { subject: 'xx-chinese' } },
          'secret-audit-exam-start',
        )
        assert.equal(examStart.status, 'applied', 'exam fixture rejected: ' + JSON.stringify(examStart.error))
        const examToken = examStart.result.sessionToken
        assert.ok(typeof examToken === 'string' && examToken.length > 0)
        rawSessionTokens.push(examToken)
        const examSubmit = await owner.command(
          { type: 'exam.submit', payload: { sessionToken: examToken, answers: [0, 0, 0] } },
          'secret-audit-exam-submit',
        )
        assert.equal(examSubmit.status, 'applied', 'exam submit rejected: ' + JSON.stringify(examSubmit.error))
        await waitConverged(owner, player, examSubmit.revision)

        // Persist unique never-upload markers only in the owner's real local
        // overlay. They must reach the local projection cache but never the
        // server DB, logs, canonical shared projection, or player projection.
        const secretPrefix = 'c12-never-upload-' + randomUUID()
        const secrets = {
          aiKey: secretPrefix + '-ai-key',
          searchKey: secretPrefix + '-search-key',
          webhookToken: secretPrefix + '-webhook-token',
          presentation: secretPrefix + '-presentation',
        }
        const localPetPosition = { lastX: 123_456_789, lastY: 987_654_321 }
        const localUpdate = await owner.page.evaluate(
          async payload => await window.qqpet.localSettings.update(payload),
          {
            settings: {
              aiKey: secrets.aiKey,
              searchKey: secrets.searchKey,
              webhookToken: secrets.webhookToken,
              searchBackend: 'tavily',
            },
            petInfo: localPetPosition,
            presentation: { neverUploadMarker: secrets.presentation },
          },
        )
        assert.equal(localUpdate.settings.aiKey, secrets.aiKey)
        assert.equal(localUpdate.settings.searchKey, secrets.searchKey)
        assert.equal(localUpdate.settings.webhookToken, secrets.webhookToken)
        assert.equal(localUpdate.petInfo.lastX, localPetPosition.lastX)
        assert.equal(localUpdate.petInfo.lastY, localPetPosition.lastY)

        const ownerCachePath = join(owner.userData, 'save.json')
        const localCacheText = await waitFor(async () => {
          try {
            const text = await readFile(ownerCachePath, 'utf8')
            return Object.values(secrets).every(marker => text.includes(marker)) ? text : null
          } catch {
            return null
          }
        }, 'owner local projection cache contains never-upload markers', 10_000)
        assert.ok(localCacheText.length > 0)
        const ownerProjectionWithLocal = await waitFor(async () => {
          const projection = await owner.projection()
          return projection?.device?.settings?.aiKey === secrets.aiKey ? projection : null
        }, 'owner renderer local overlay contains never-upload markers', 10_000)
        assert.equal(ownerProjectionWithLocal.device.settings.searchKey, secrets.searchKey)
        assert.equal(ownerProjectionWithLocal.device.settings.webhookToken, secrets.webhookToken)
        assert.equal(ownerProjectionWithLocal.device.petInfo.lastX, localPetPosition.lastX)
        assert.equal(ownerProjectionWithLocal.device.petInfo.lastY, localPetPosition.lastY)
        const playerProjectionAfterLocalWrite = await player.projection()
        assert.notEqual(playerProjectionAfterLocalWrite, null)
        assert.equal(
          Object.values(secrets).some(marker => JSON.stringify(playerProjectionAfterLocalWrite).includes(marker)),
          false,
          'owner device-local secrets must not enter the player projection',
        )

        // A normal canonical command after the local secret write gives the
        // captured server log real command lifecycle entries to audit.
        const bought = await owner.command(
          { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
          'secret-audit-post-secret-command',
        )
        assert.equal(bought.status, 'applied', 'post-secret command rejected: ' + JSON.stringify(bought.error))
        await waitConverged(owner, player, bought.revision)

        const audit = await readDatabaseAudit(fixture.dbPath)
        const allColumns = Object.values(audit.columns).flat()
        const forbiddenColumns = allColumns.filter(column => canonicalForbiddenColumns.has(column))
        assert.deepEqual(forbiddenColumns, [], 'server schema must not contain never-upload/device-local columns')
        assert.ok(audit.devices.length >= 2, 'server device registry must contain the real paired renderers')
        assert.ok(
          audit.devices.every(row => row.tokenHashType === 'blob' && row.tokenHashLength === 32),
          'device authentication material must be a 32-byte hash blob',
        )
        assert.equal(audit.columns.devices.includes('token'), false, 'devices must not store a plaintext token column')
        assert.equal(audit.columns.devices.includes('token_hash'), true)
        assert.equal(audit.columns.pairing_codes.includes('code'), false, 'pairing codes must not be stored in plaintext')
        assert.equal(audit.columns.pairing_codes.includes('code_hash'), true)
        assert.ok(
          audit.pairingCodes.every(row => row.codeHashType === 'blob' && row.codeHashLength === 32),
          'used pairing codes must remain 32-byte hash blobs',
        )

        const closedSessionAnswerKeyPaths = audit.sessionPayloads.flatMap(text => {
          try {
            return findKeys(JSON.parse(text), answerFields)
          } catch {
            return []
          }
        })
        assert.ok(closedSessionAnswerKeyPaths.length >= 3, 'closed exam payload must retain its grading keys server-side')

        const answerKeyPathsOutsideSessions = []
        const canonicalForbiddenPaths = []
        for (const cell of audit.textCells) {
          let parsed
          try {
            parsed = JSON.parse(cell.text)
          } catch {
            if ([...answerFields].some(field => cell.text.includes(field))) {
              answerKeyPathsOutsideSessions.push(cell.table + '.' + cell.column + ':raw')
            }
            continue
          }
          for (const path of findKeysOutsideClosedSessionPayload(parsed, answerFields)) {
            answerKeyPathsOutsideSessions.push(cell.table + '.' + cell.column + ':' + path)
          }
          if (cell.table === 'pets' && (cell.column === 'save_json' || cell.column === 'engine_json')) {
            for (const path of findCanonicalBoundaryPaths(parsed)) {
              canonicalForbiddenPaths.push(cell.column + ':' + path)
            }
          }
        }
        assert.deepEqual(answerKeyPathsOutsideSessions, [], 'answer keys must exist only inside closed session payloads')
        assert.deepEqual(canonicalForbiddenPaths, [], 'canonical state must not contain never-upload/device-local fields')

        const pairingCodes = Object.values(fixture.pairingCodes).filter(
          value => typeof value === 'string' && value.length > 0,
        )
        assert.ok(pairingCodes.length >= 2, 'both real pairing codes must be available for the leak audit')
        const secretValues = Object.values(secrets)
        const dbBuffers = await Promise.all(
          [fixture.dbPath, fixture.dbPath + '-wal', fixture.dbPath + '-shm'].map(readOptionalFile),
        )
        const databaseFileText = Buffer.concat(dbBuffers.filter(buffer => buffer !== null)).toString('utf8')
        const textCellValues = audit.textCells.map(cell => cell.text).join('\n')
        const databaseText = textCellValues + '\n' + databaseFileText + '\n' + audit.sessionPayloads.join('\n')
        assert.equal(
          [...secretValues, ...pairingCodes].some(value => databaseText.includes(value)),
          false,
          'server SQLite/WAL must not contain never-upload markers or plaintext pairing codes',
        )

        const serverLogs = fixture.server.logText()
        const logLines = serverLogs.split('\n').filter(line => line.length > 0)
        assert.ok(logLines.length > 0, 'server log capture must not be empty')
        assert.match(serverLogs, /"event":"command\.committed"/, 'server info log must record the post-secret canonical command')
        assert.equal(
          [...secretValues, ...pairingCodes, examToken, 'issuedToken'].some(value => serverLogs.includes(value)),
          false,
          'server logs must not contain secrets, pairing codes, or session tokens',
        )
        const answerFieldsInLogs = [...answerFields].filter(field => serverLogs.includes(field))
        assert.deepEqual(answerFieldsInLogs, [], 'server logs must not contain answer-key field names')

        const ownerProjection = await owner.projection()
        const playerProjection = await player.projection()
        assert.notEqual(ownerProjection, null)
        assert.notEqual(playerProjection, null)
        const projectionHygieneChecks = assertRendererProjectionHygiene(
          { owner: ownerProjection, player: playerProjection },
          [examToken],
          'secret boundary projection',
        )
        assert.equal(
          Object.values(secrets).some(marker => JSON.stringify(playerProjection).includes(marker)),
          false,
          'player projection must not contain another renderer local overlay secrets',
        )
        for (const [label, projection] of Object.entries({ owner: ownerProjection, player: playerProjection })) {
          assert.equal(JSON.stringify(projection).includes(examToken), false, label + ' projection leaked a session token')
          const sharedForbiddenPaths = findKeys(projection.shared, projectionSharedForbidden)
          assert.deepEqual(sharedForbiddenPaths, [], label + ' shared projection leaked device-local/never-upload keys')
        }
        const ownerProjectionText = JSON.stringify(ownerProjection)
        assert.equal(
          secretValues.every(marker => ownerProjectionText.includes(marker)),
          true,
          'owner-local overlay should retain its own never-upload markers locally',
        )

        const syncConfig = await readOptionalFile(join(owner.userData, 'sync-config.json'))
        const syncConfigText = syncConfig === null ? '' : syncConfig.toString('utf8')
        assert.equal(secretValues.some(marker => syncConfigText.includes(marker)), false)
        const deviceTokenFile = await readOptionalFile(join(owner.userData, 'remote-token.bin'))
        const deviceTokenFileText = deviceTokenFile === null ? '' : deviceTokenFile.toString('utf8')
        assert.equal(secretValues.some(marker => deviceTokenFileText.includes(marker)), false)

        const scenarioDetail = {
          databaseTables: audit.tables.length,
          databaseColumnsChecked: allColumns.length,
          deviceRows: audit.devices.length,
          deviceTokenHashStorage: 'blob',
          deviceTokenHashBytes: 32,
          plaintextDeviceTokenColumnPresent: audit.columns.devices.includes('token'),
          pairingCodeRows: audit.pairingCodes.length,
          pairingCodeHashStorage: 'blob',
          pairingCodeHashBytes: 32,
          plaintextPairingCodeColumnPresent: audit.columns.pairing_codes.includes('code'),
          neverUploadSecretsChecked: secretValues.length,
          pairingCodesChecked: pairingCodes.length,
          secretMarkersInSqliteOrWal: false,
          pairingCodesInSqliteOrWal: false,
          localOnlyColumnsAbsent: forbiddenColumns.length === 0,
          localOnlyKeyPathsInCanonicalState: canonicalForbiddenPaths.length,
          closedSessionPayloadAnswerKeyPaths: closedSessionAnswerKeyPaths.length,
          answerKeyPathsOutsideClosedSessionPayload: answerKeyPathsOutsideSessions.length,
          answerKeyFieldNamesInServerLogs: answerFieldsInLogs.length,
          sessionTokensInServerLogsOrProjections: 0,
          projectionHygieneChecks,
          playerProjectionSecretMarkerMatches: Object.values(secrets)
            .filter(marker => JSON.stringify(playerProjection).includes(marker)).length,
          ownerLocalOverlaySecretMarkerMatches: secretValues
            .filter(marker => ownerProjectionText.includes(marker)).length,
          ownerLocalProjectionCacheContainsSecrets: localCacheText.length > 0,
          syncConfigContainsSecrets: false,
          serverLogLines: logLines.length,
          serverCommandCommittedLogPresent: true,
          deviceTokenFilePresent: deviceTokenFile !== null,
          deviceTokenFileContainsMarkers: false,
          secretsHash: hash(secretValues),
          pairingCodesHash: hash(pairingCodes),
          sessionTokenHash: hash(examToken),
          answerKeysAbsentOutsideClosedSessionPayload: true,
          neverUploadBoundaryHolds: true,
        }
        const detailText = JSON.stringify(scenarioDetail)
        assert.equal(scenarioDetail.secretsHash.includes(secretPrefix), false)
        for (const value of [...secretValues, ...pairingCodes, examToken]) {
          assert.equal(detailText.includes(value), false, 'scenario detail must not contain raw secret material')
        }
        return scenarioDetail
      } finally {
        await fixture.cleanup()
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
    assert.equal(timedBothRendererEvidence?.bothRenderersSawServerDeadline, true, 'timed work must be observed by both renderers')
    assert.equal(timedBothRendererEvidence?.exactlyOneCompletionPerRenderer, true, 'each renderer must observe exactly one work completion')
    assert.equal(timedBothRendererEvidence?.ownerStartEventCount, 1, 'owner renderer must observe exactly one work start event')
    assert.equal(timedBothRendererEvidence?.playerStartEventCount, 1, 'player renderer must observe exactly one work start event')
    assert.equal(timedBothRendererEvidence?.ownerRewardEventCount, 1, 'owner renderer must observe exactly one work reward event')
    assert.equal(timedBothRendererEvidence?.playerRewardEventCount, 1, 'player renderer must observe exactly one work reward event')
    assert.equal(timedBothRendererEvidence?.ownerCompletionEventCount, 1, 'owner renderer must observe exactly one work completion event')
    assert.equal(timedBothRendererEvidence?.playerCompletionEventCount, 1, 'player renderer must observe exactly one work completion event')
    assert.equal(timedBothRendererEvidence?.duplicateCreditAfterRestart, false, 'restart must not duplicate work credit')
    assert.equal(sessionGradingEvidence?.examPassed, true, 'stored exam answer key must grade as passed')
    assert.equal(sessionGradingEvidence?.examCorrectCount, 3, 'stored exam answer key must grade all three questions correctly')
    assert.equal(sessionGradingEvidence?.examTotal, 3, 'exam grading must report the source question total')
    assert.equal(sessionGradingEvidence?.examStudyDelta, 1, 'passing exam must award one study level exactly once')
    assert.equal(sessionGradingEvidence?.gameRoundDelta, 1, 'game reward must increment GameRound exactly once')
    assert.equal(sessionGradingEvidence?.gameCounterDelta, 2, 'game reward must increment Game by the elapsed minutes')
    assert.equal(sessionGradingEvidence?.diudiuleYbDelta, 1, 'diudiule reward must credit exactly one yuanbao')
    assert.equal(sessionGradingEvidence?.islandCorrect, true, 'stored island answer key must grade as correct')
    assert.equal(sessionGradingEvidence?.islandRewardEventCount, 1, 'island quiz must grant exactly one reward event')
    assert.equal(sessionGradingEvidence?.answerKeysProjected, false, 'answer keys must never be projected')
    assert.equal(sessionGradingEvidence?.answerKeysStoredServerSide, true, 'answer keys must remain server-side for grading')
    assert.equal(restartEngineStateEvidence?.jobsMatchedOracle, true, 'restart must preserve scheduled jobs exactly')
    assert.equal(restartEngineStateEvidence?.sessionsMatchedOracle, true, 'restart must preserve game sessions exactly')
    assert.equal(restartEngineStateEvidence?.rngMatchedDeterministicOracle, true, 'restart must preserve RNG exactly')
    assert.equal(restartEngineStateEvidence?.environmentMatchedOracle, true, 'restart must preserve per-day environment exactly')
    assert.equal(restartEngineStateEvidence?.dayBoundaryAfterKey, restartEngineStateEvidence?.dayBoundaryExpectedKey)
    assert.equal(restartEngineStateEvidence?.dayBoundaryAfterMs, restartEngineStateEvidence?.dayBoundaryExpectedMs)
    assert.equal(restartEngineStateEvidence?.anchorAtOrAfterOracle, true, 'restart anchor must reach the oracle target without extra ticks')
    assert.equal(restartEngineStateEvidence?.anchorAdvancedWithoutExtraTicks, true, 'anchor-only passes must not advance canonical game time')
    assert.equal(restartEngineStateEvidence?.noDuplicateCatchUp, true, 'second restart must not duplicate catch-up')
    assert.equal(importEngineStateEvidence?.rngPreserved, true, 'portable import must preserve source RNG')
    assert.equal(importEngineStateEvidence?.jobsPreserved, true, 'portable import must preserve source jobs with clamp-adjusted deadlines')
    assert.equal(importEngineStateEvidence?.sessionsPreserved, true, 'portable import must preserve and rebind source sessions')
    assert.equal(importEngineStateEvidence?.environmentPreserved, true, 'portable import must preserve per-day environment')
    assert.equal(importEngineStateEvidence?.dayBoundaryPreserved, true, 'portable import must preserve clamped day-boundary metadata')
    assert.equal(importEngineStateEvidence?.anchorPreserved, true, 'portable import must persist the effective anchor')
    assert.equal(importEngineStateEvidence?.sessionsReboundToDestination, true, 'portable import must rebind local sessions to the destination')
    assert.equal(importEngineStateEvidence?.noDoubleCatchUp, true, 'portable import restart must not double catch-up')
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
      timedWorkServerDeadlineExact: true,
      timedWorkSeenByBothRenderers: timedBothRendererEvidence.bothRenderersSawServerDeadline,
      sessionGradingTaskRewardExact: sessionGradingEvidence.examPassed
        && sessionGradingEvidence.gameRoundDelta === 1
        && sessionGradingEvidence.islandCorrect,
      restartEngineStatePreserved: restartEngineStateEvidence.jobsMatchedOracle
        && restartEngineStateEvidence.sessionsMatchedOracle
        && restartEngineStateEvidence.rngMatchedDeterministicOracle
        && restartEngineStateEvidence.environmentMatchedOracle,
      portableImportEngineStatePreserved: importEngineStateEvidence.rngPreserved
        && importEngineStateEvidence.jobsPreserved
        && importEngineStateEvidence.sessionsPreserved
        && importEngineStateEvidence.environmentPreserved
        && importEngineStateEvidence.anchorPreserved,
      advanceWhileEmptyZeroClientExact: true,
      onlineTimeSigninCoverageSplit: true,
      localAuthorityDetachResumeFenced: true,
      survivorRestartNoDuplicate: true,
      advanceWhileEmptyRandomReconnect: true,
      rendererCanonicalMutationBlocked: true,
      secretBoundaryAudit: true,
    }
    report.evidence.competingActionsCovered = true
    report.evidence.sessionTokenAbuseCovered = true
    report.evidence.freshHostPortableImportCovered = true
    report.evidence.connectedCoverageReopenCovered = true
    report.evidence.startupCrashRepairCovered = true
    report.evidence.deterministicRestartCovered = true
    report.evidence.revokedReconnectCovered = true
    report.evidence.feedLatencyP95Covered = true
    report.evidence.timedServerDeadlineCovered = true
    report.evidence.advanceWhileEmptyZeroClientCovered = true
    report.evidence.onlineTimeSigninSplitCovered = true
    report.evidence.localAuthorityHandoffCovered = true
    report.evidence.survivorRestartNoDuplicateCovered = true
    report.evidence.advanceWhileEmptyRandomReconnectCovered = true
    report.evidence.rendererMutationBlockedCovered = true
    report.evidence.secretBoundaryAuditCovered = true
    report.evidence.answerKeysAbsent = true
    report.evidence.timedWorkBothRenderersCovered = timedBothRendererEvidence.bothRenderersSawServerDeadline
      && timedBothRendererEvidence.ownerRewardEventCount === 1
      && timedBothRendererEvidence.playerRewardEventCount === 1
    report.evidence.sessionGradingTaskRewardExactCovered = sessionGradingEvidence.examPassed
      && sessionGradingEvidence.gameRoundDelta === 1
      && sessionGradingEvidence.gameCounterDelta === 2
      && sessionGradingEvidence.diudiuleYbDelta === 1
      && sessionGradingEvidence.islandCorrect
    report.evidence.answerKeyServerSideGradingCovered = sessionGradingEvidence.examCorrectCount === 3
      && sessionGradingEvidence.answerKeysStoredServerSide === true
      && sessionGradingEvidence.answerKeysProjected === false
    report.evidence.restartEngineStatePreservedCovered = restartEngineStateEvidence.jobsMatchedOracle
      && restartEngineStateEvidence.sessionsMatchedOracle
      && restartEngineStateEvidence.rngMatchedDeterministicOracle
      && restartEngineStateEvidence.environmentMatchedOracle
    report.evidence.portableImportEngineStatePreservedCovered = importEngineStateEvidence.rngPreserved
      && importEngineStateEvidence.jobsPreserved
      && importEngineStateEvidence.sessionsPreserved
      && importEngineStateEvidence.environmentPreserved
      && importEngineStateEvidence.anchorPreserved
    report.evidence.noDuplicateCatchUpCovered = restartEngineStateEvidence.noDuplicateCatchUp === true
      && importEngineStateEvidence.noDoubleCatchUp === true
    report.evidence.hygiene = {
      pairingCodesAbsent: true,
      rawDeviceIdsAbsent: true,
      tokensAbsent: true,
      answerKeysAbsent: true,
      neverUploadSecretsAbsentFromServer: true,
      deviceLocalFieldsAbsentFromCanonicalState: true,
      authTokensHashOnlyInSqlite: true,
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
