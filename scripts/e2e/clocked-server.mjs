/**
 * Real-server process wrapper for the C12 time/coverage E2E.
 *
 * The standalone server's SyncServer accepts an injected wall-clock function.
 * This wrapper supplies a test-only clock read atomically from a file, so the
 * E2E can advance wall time deterministically without waiting real minutes.
 * The process still runs the production HTTP/WebSocket server, SQLite store,
 * command service and scheduler exactly as `qqpet-server start` does.
 */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServerConfig } from '../../server/dist/server/src/config.js'
import { initializePet, openDatabase } from '../../server/dist/server/src/db.js'
import { SyncServer } from '../../server/dist/server/src/index.js'

const clockFile = process.env.QQPET_E2E_CLOCK_FILE
if (typeof clockFile !== 'string' || clockFile.length === 0) {
  throw new Error('QQPET_E2E_CLOCK_FILE is required')
}

function now() {
  const raw = readFileSync(clockFile, 'utf8').trim()
  const value = Number(raw)
  if (Number.isSafeInteger(value) === false || value < 0) {
    throw new Error('test clock file must contain a non-negative safe integer: ' + JSON.stringify(raw))
  }
  return value
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const command = process.argv[2] ?? 'serve'
const config = createServerConfig()

if (command === 'init') {
  await mkdir(dirname(config.dbPath), { recursive: true })
  const store = openDatabase(config.dbPath)
  try {
    const result = initializePet(store, {
      petId: argValue('--pet-id', 'default'),
      timeZone: argValue('--time-zone', config.timeZone),
      weatherCity: argValue('--weather-city', config.weatherLocation),
      advanceWhileEmpty: config.advanceWhileEmpty,
      nowMs: now(),
    })
    process.stdout.write(JSON.stringify({
      ok: true,
      petId: result.petId,
      pairingCode: result.pairingCode,
      pairingExpiresAtMs: result.pairingExpiresAtMs,
      authority: result.authority,
    }) + '\n')
  } finally {
    store.close()
  }
} else if (command === 'pair') {
  const store = openDatabase(config.dbPath)
  try {
    const petId = argValue('--pet-id', 'default')
    const role = argValue('--role', 'player')
    if (role !== 'owner' && role !== 'player') throw new Error('--role must be owner or player')
    const result = store.issuePairingCode(petId, role, config.pairingTtlMs, now())
    process.stdout.write(JSON.stringify({
      ok: true,
      petId,
      role,
      pairingCode: result.code,
      expiresAtMs: result.expiresAtMs,
    }) + '\n')
  } finally {
    store.close()
  }
} else if (command === 'serve') {
  const server = new SyncServer(config, openDatabase(config.dbPath), { now })
  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    try {
      await server.stop()
    } finally {
      process.stdout.write('[clocked-server] stopped ' + signal + '\n')
    }
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  await server.start()
  process.stdout.write('[clocked-server] listening on ' + JSON.stringify(server.address()) + '\n')
} else {
  throw new Error('unknown clocked-server command: ' + command)
}
