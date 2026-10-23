import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { createRngState, dayKeyAt, nextDailyBoundaryMs, type EngineState } from '../../src/shared/pet-runtime/index'
import { emptyEggSave } from '../../src/shared/pet-runtime/handlers-a'
import { assertEngineState } from '../../src/shared/sync/portable'
import type { CoverageEndProvenance, CoverageSurvivor, DomainEvent } from '../../src/shared/pet-runtime/index'
import type { OrderedEvent } from '../../src/shared/pet-runtime/events'
import type { DeviceRole, WireAuthority } from '../../src/shared/sync/index'
import { finalizeSurvivor, stableCoverageId, survivorDeviceId, survivorKey } from './coverage'

export const SCHEMA_VERSION = 1
export const COVERAGE_CRASH_GRACE_MS = 30_000

const MIGRATION_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE pets (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  command_seq INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  game_time_ms INTEGER NOT NULL,
  last_scheduler_wall_ms INTEGER NOT NULL,
  save_json TEXT NOT NULL,
  engine_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE pet_settings (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id) ON DELETE CASCADE,
  advance_while_empty INTEGER NOT NULL CHECK (advance_while_empty IN (0, 1)),
  time_zone TEXT NOT NULL,
  weather_location TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE pet_authority (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL,
  restore_generation INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  handoff_epoch INTEGER,
  owner TEXT NOT NULL CHECK (owner IN ('server', 'local')),
  state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'reset')),
  handoff_id TEXT NOT NULL,
  detached_at_ms INTEGER,
  source_revision INTEGER,
  source_event_seq INTEGER
);

CREATE TABLE scheduled_jobs (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  due_at_game_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_command_seq INTEGER,
  completed_command_seq INTEGER,
  PRIMARY KEY (pet_id, job_id)
);
CREATE INDEX scheduled_jobs_due ON scheduled_jobs(pet_id, status, due_at_game_ms);

CREATE TABLE game_sessions (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL,
  actor_device_id TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('game', 'diudiule', 'exam', 'island_quiz')),
  payload_json TEXT NOT NULL,
  started_at_game_ms INTEGER NOT NULL,
  expires_at_game_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'abandoned', 'expired')),
  settled_command_seq INTEGER,
  reward_key TEXT,
  cancel_reason TEXT,
  PRIMARY KEY (pet_id, session_token)
);
CREATE INDEX game_sessions_open ON game_sessions(pet_id, status, expires_at_game_ms);

CREATE TABLE session_coverage (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  coverage_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  connection_id TEXT,
  authenticated_session_id TEXT,
  connected_at_ms INTEGER NOT NULL,
  disconnected_at_ms INTEGER,
  last_heartbeat_at_ms INTEGER NOT NULL,
  close_reason TEXT CHECK (close_reason IN (
    'disconnect', 'shutdown', 'suspend', 'crash_repaired', 'pet_reset',
    'import_replaced', 'authority_handoff', 'graceful', 'socket_closed', 'app_shutdown'
  )),
  PRIMARY KEY (pet_id, coverage_id)
);
CREATE INDEX session_coverage_time ON session_coverage(pet_id, connected_at_ms, disconnected_at_ms);

CREATE TABLE coverage_operations (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  commit_wall_ms INTEGER NOT NULL,
  survivors_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'suspended', 'completed')),
  suspended_at_ms INTEGER,
  completed_at_ms INTEGER,
  PRIMARY KEY (pet_id, operation_id)
);

CREATE TABLE commands (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  command_seq INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
  result_json TEXT,
  error_json TEXT,
  revision INTEGER NOT NULL,
  event_seq INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pet_id, command_seq),
  UNIQUE (pet_id, device_id, op_id)
);

CREATE TABLE events (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  command_seq INTEGER,
  game_time_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pet_id, event_seq)
);

CREATE TABLE devices (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  token_hash BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  revoked_at_ms INTEGER,
  PRIMARY KEY (pet_id, device_id),
  UNIQUE (token_hash)
);

CREATE TABLE pairing_codes (
  code_hash BLOB PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
);
`

const MIGRATION_1 = [
  'journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout',
  'schema_migrations', 'pets', 'pet_settings', 'pet_authority', 'scheduled_jobs',
  'game_sessions', 'session_coverage', 'coverage_operations', 'commands', 'events', 'devices', 'pairing_codes',
] as const

export interface PetRecord {
  id: string
  schemaVersion: number
  revision: number
  commandSeq: number
  eventSeq: number
  gameTimeMs: number
  lastSchedulerWallMs: number
  saveJson: string
  engineJson: string
  createdAtMs: number
  updatedAtMs: number
}

export interface PetSettingsRecord {
  petId: string
  advanceWhileEmpty: boolean
  timeZone: string
  weatherLocation: string | null
  updatedAtMs: number
}

export interface AuthorityRecord {
  petId: string
  authorityId: string
  restoreGeneration: number
  epoch: number
  handoffEpoch: number | null
  owner: 'server' | 'local'
  state: 'active' | 'archived' | 'reset'
  handoffId: string
  detachedAtMs: number | null
  sourceRevision: number | null
  sourceEventSeq: number | null
}

export interface DeviceRecord {
  petId: string
  deviceId: string
  label: string
  role: DeviceRole
  tokenHash: Buffer
  createdAtMs: number
  lastSeenAtMs: number | null
  revokedAtMs: number | null
}

export interface CommandRecord {
  petId: string
  commandSeq: number
  opId: string
  deviceId: string
  commandType: string
  payloadJson: string
  status: 'applied' | 'rejected'
  resultJson: string | null
  errorJson: string | null
  revision: number
  eventSeq: number
  createdAtMs: number
}

export interface EventRecord {
  petId: string
  eventSeq: number
  revision: number
  commandSeq: number | null
  gameTimeMs: number
  type: string
  payloadJson: string
  createdAtMs: number
}

export interface DatabaseOperationalHealth {
  writable: boolean
  quickCheck: string
  error: string | null
}

export interface CoverageOperationRecord {
  petId: string
  operationId: string
  commitWallMs: number
  survivors: CoverageSurvivor[]
  state: 'pending' | 'suspended' | 'completed'
  suspendedAtMs: number | null
  completedAtMs: number | null
}

export interface CanonicalPetSnapshot {
  pet: PetRecord
  settings: PetSettingsRecord
  authority: AuthorityRecord
  engine: EngineState
}

export interface CanonicalImportOptions {
  petId: string
  engine: EngineState
  authorityId: string
  restoreGeneration: number
  nextEpoch: number
  handoffId: string
  sourceRevision: number
  sourceEventSeq: number
  importedCoverage: EngineState['sessionCoverage']
  operationId: string
  commitWallMs: number
  survivors: CoverageSurvivor[]
  baseRevision: number
  baseEventSeq: number
  at: number
}

export interface AuthorityArchiveOptions {
  petId: string
  nextEpoch: number
  handoffId: string
  operationId: string
  at: number
  survivors: CoverageSurvivor[]
}

interface MigrationResult {
  codeHash: Buffer
  petId: string
  role: DeviceRole
  expiresAtMs: number
  usedAtMs: number | null
}

function codeHashHex(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

function codeHash(code: string): Buffer {
  return Buffer.from(codeHashHex(code), 'hex')
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export function issueOpaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function nowInteger(value: number | undefined): number {
  const resolved = value ?? Date.now()
  if (Number.isSafeInteger(resolved) === false || resolved < 0) throw new Error('timestamp must be a non-negative safe integer')
  return resolved
}

function immutableDatabaseLocation(path: string): string {
  const url = pathToFileURL(path)
  url.searchParams.set('immutable', '1')
  return url.href
}

/** Read the operator's external restore-generation fence without creating the file. */
export function readRestoreGenerationRecord(filePath?: string): number | undefined {
  if (filePath === undefined || filePath === '') return undefined
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (raw === '') return undefined
  const recorded = Number(raw)
  if (Number.isSafeInteger(recorded) === false || recorded < 0) throw new Error('restore generation record is invalid')
  return recorded
}

interface DatabaseStoreOptions {
  readOnly?: boolean
}

export class DatabaseStore {
  readonly db: DatabaseSync
  private readonly readOnly: boolean
  private closed = false

  constructor(path: string, options: DatabaseStoreOptions = {}) {
    this.readOnly = options.readOnly === true
    this.db = this.readOnly
      ? new DatabaseSync(immutableDatabaseLocation(path), { readOnly: true })
      : new DatabaseSync(path)
    if (this.readOnly === false) {
      this.db.exec('PRAGMA busy_timeout = 5000;')
      this.db.exec('PRAGMA foreign_keys = ON;')
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA synchronous = FULL;')
      this.migrate()
    }
    this.assertHealthy()
  }

  private migrate(): void {
    const existing = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get() as { name?: string } | undefined
    if (existing?.name === 'schema_migrations') {
      const applied = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
      if (applied.length === 0 || applied[applied.length - 1].version > SCHEMA_VERSION) {
        throw new Error('unsupported migration state')
      }
      if (applied[applied.length - 1].version === SCHEMA_VERSION) return
    }
    const transaction = this.db.prepare('BEGIN IMMEDIATE')
    const rollback = this.db.prepare('ROLLBACK')
    const commit = this.db.prepare('COMMIT')
    transaction.run()
    try {
      this.db.exec(MIGRATION_SQL)
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)').run(SCHEMA_VERSION, Date.now())
      commit.run()
    } catch (error) {
      rollback.run()
      throw error
    }
  }

  assertHealthy(): void {
    const quick = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (quick === undefined || !Object.values(quick).includes('ok')) throw new Error('sqlite quick_check failed')
    const integrity = this.db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
    if (integrity === undefined || !Object.values(integrity).includes('ok')) throw new Error('sqlite integrity_check failed')
    const migrations = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    if (migrations.length !== 1 || migrations[0].version !== SCHEMA_VERSION) throw new Error('unsupported migration state')
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name),
    )
    for (const table of MIGRATION_1) {
      if (table === 'journal_mode' || table === 'synchronous' || table === 'foreign_keys' || table === 'busy_timeout') continue
      if (!tables.has(table)) throw new Error('missing required table: ' + table)
    }
  }

  /**
   * Non-destructive liveness probe used by health/readiness. quick_check
   * verifies page integrity; a rolled-back no-op UPDATE verifies the connection
   * can still acquire a write transaction without changing canonical state.
   */
  operationalHealth(): DatabaseOperationalHealth {
    if (this.closed) return { writable: false, quickCheck: 'closed', error: 'database is closed' }
    let quickCheck = 'unknown'
    let writable = false
    let errorMessage: string | null = null
    try {
      const quick = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      const values = quick === undefined ? [] : Object.values(quick).map(value => String(value).toLowerCase())
      quickCheck = values.length === 1 ? values[0] : (values.join(', ') || 'unknown')
      if (values.length === 0 || values.some(value => value !== 'ok')) {
        errorMessage = 'sqlite quick_check failed: ' + quickCheck
      }
    } catch (error) {
      quickCheck = 'error'
      errorMessage = error instanceof Error ? error.message : 'sqlite quick_check failed'
    }
    if (quickCheck === 'ok') {
      let transactionOpen = false
      try {
        this.db.exec('BEGIN IMMEDIATE')
        transactionOpen = true
        // Write the same value so a read-only or full/failed volume is caught;
        // rollback guarantees the probe is not observable in canonical state.
        this.db.prepare('UPDATE schema_migrations SET applied_at_ms = applied_at_ms WHERE version = ?').run(SCHEMA_VERSION)
        this.db.exec('ROLLBACK')
        transactionOpen = false
        writable = true
      } catch (error) {
        if (transactionOpen) {
          try {
            this.db.exec('ROLLBACK')
          } catch {
            // Preserve the probe error.
          }
        }
        errorMessage ??= error instanceof Error ? error.message : 'database write probe failed'
      }
    }
    return { writable, quickCheck, error: errorMessage }
  }

  countCommands(petId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM commands WHERE pet_id = ?').get(petId) as { count?: unknown } | undefined
    return Number(row?.count ?? 0)
  }

  countEvents(petId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE pet_id = ?').get(petId) as { count?: unknown } | undefined
    return Number(row?.count ?? 0)
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Preserve the original operation error.
      }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.readOnly === false) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // Closing must remain possible when the database disappeared.
      }
    }
    this.db.close()
  }

  getPet(petId: string): PetRecord | undefined {
    const row = this.db.prepare('SELECT * FROM pets WHERE id = ?').get(petId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapPet(row)
  }

  listPets(): PetRecord[] {
    return (this.db.prepare('SELECT * FROM pets ORDER BY created_at_ms, id').all() as Record<string, unknown>[]).map(mapPet)
  }

  getSettings(petId: string): PetSettingsRecord | undefined {
    const row = this.db.prepare('SELECT * FROM pet_settings WHERE pet_id = ?').get(petId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      petId: String(row.pet_id),
      advanceWhileEmpty: row.advance_while_empty === 1,
      timeZone: String(row.time_zone),
      weatherLocation: row.weather_location === null ? null : String(row.weather_location),
      updatedAtMs: Number(row.updated_at_ms),
    }
  }

  getAuthority(petId: string): AuthorityRecord | undefined {
    const row = this.db.prepare('SELECT * FROM pet_authority WHERE pet_id = ?').get(petId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapAuthority(row)
  }

  getDeviceByToken(petId: string, token: string): DeviceRecord | undefined {
    const hash = tokenHash(token)
    const row = this.db.prepare('SELECT * FROM devices WHERE pet_id = ? AND token_hash = ?').get(petId, hash) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapDevice(row)
  }

  getDeviceByTokenGlobal(token: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenHash(token)) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapDevice(row)
  }

  getDevice(petId: string, deviceId: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE pet_id = ? AND device_id = ?').get(petId, deviceId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapDevice(row)
  }

  listDevices(petId: string): DeviceRecord[] {
    return (this.db.prepare('SELECT * FROM devices WHERE pet_id = ? ORDER BY created_at_ms, device_id').all(petId) as Record<string, unknown>[]).map(mapDevice)
  }

  touchDevice(petId: string, deviceId: string, at: number): void {
    this.db.prepare('UPDATE devices SET last_seen_at_ms = ? WHERE pet_id = ? AND device_id = ?').run(at, petId, deviceId)
  }

  getMigration(code: string): MigrationResult | undefined {
    const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(codeHash(code)) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      codeHash: Buffer.from(row.code_hash as Uint8Array),
      petId: String(row.pet_id),
      role: String(row.role) as DeviceRole,
      expiresAtMs: Number(row.expires_at_ms),
      usedAtMs: row.used_at_ms === null ? null : Number(row.used_at_ms),
    }
  }

  issuePairingCode(petId: string, role: DeviceRole, ttlMs: number, at = Date.now()): { code: string; expiresAtMs: number } {
    if (ttlMs <= 0) throw new Error('pairing TTL must be positive')
    const code = 'QQP-' + issueOpaqueSecret(32)
    const expiresAtMs = at + ttlMs
    this.db.prepare(
      'INSERT INTO pairing_codes (code_hash, pet_id, role, expires_at_ms, used_at_ms) VALUES (?, ?, ?, ?, NULL)',
    ).run(codeHash(code), petId, role, expiresAtMs)
    return { code, expiresAtMs }
  }

  consumePairingCode(code: string, at: number): MigrationResult | undefined {
    const got = this.getMigration(code)
    if (got === undefined || got.usedAtMs !== null || got.expiresAtMs <= at) return undefined
    const result = this.db.prepare(
      'UPDATE pairing_codes SET used_at_ms = ? WHERE code_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?',
    ).run(at, got.codeHash, at)
    if (Number(result.changes) !== 1) return undefined
    return got
  }

  ensureInitialPairingCode(petId: string, code: string, at: number): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO pairing_codes
       (code_hash, pet_id, role, expires_at_ms, used_at_ms)
       VALUES (?, ?, 'owner', ?, NULL)`,
    ).run(codeHash(code), petId, at + 10 * 60_000)
  }

  createDevice(petId: string, label: string, role: DeviceRole, at = Date.now()): { device: DeviceRecord; token: string } {
    const token = issueOpaqueSecret(32)
    const deviceId = randomUUID()
    const tokenBytes = tokenHash(token)
    this.db.prepare(
      'INSERT INTO devices (pet_id, device_id, label, role, token_hash, created_at_ms, last_seen_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    ).run(petId, deviceId, label, role, tokenBytes, at, at)
    return {
      token,
      device: {
        petId, deviceId, label, role, tokenHash: tokenBytes, createdAtMs: at,
        lastSeenAtMs: at, revokedAtMs: null,
      },
    }
  }

  revokeDevice(petId: string, deviceId: string, at = Date.now()): number | undefined {
    return this.transaction(() => {
      const device = this.getDevice(petId, deviceId)
      if (device === undefined) return undefined
      if (device.role === 'owner' && device.revokedAtMs === null) {
        const owners = this.db.prepare(
          'SELECT COUNT(*) AS count FROM devices WHERE pet_id = ? AND role = ? AND revoked_at_ms IS NULL',
        ).get(petId, 'owner') as { count: number }
        if (Number(owners.count) <= 1) throw new Error('cannot revoke the last active owner')
      }
      if (device.revokedAtMs === null) {
        this.db.prepare('UPDATE devices SET revoked_at_ms = ? WHERE pet_id = ? AND device_id = ?').run(at, petId, deviceId)
      }
      return device.revokedAtMs ?? at
    })
  }

  commandByOpId(petId: string, deviceId: string, opId: string): CommandRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM commands WHERE pet_id = ? AND device_id = ? AND op_id = ?',
    ).get(petId, deviceId, opId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapCommand(row)
  }

  commandStatus(petId: string, deviceId: string, opId: string): CommandRecord | undefined {
    return this.commandByOpId(petId, deviceId, opId)
  }

  getEvents(petId: string, afterEventSeq: number, limit: number): EventRecord[] {
    return (this.db.prepare(
      'SELECT * FROM events WHERE pet_id = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?',
    ).all(petId, afterEventSeq, limit) as Record<string, unknown>[]).map(mapEvent)
  }

  getEvent(petId: string, eventSeq: number): EventRecord | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE pet_id = ? AND event_seq = ?').get(petId, eventSeq) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapEvent(row)
  }

  insertEvent(petId: string, event: {
    eventSeq: number
    revision: number
    commandSeq: number | null
    gameTimeMs: number
    type: string
    payload: Record<string, unknown>
    createdAtMs: number
  }): void {
    this.db.prepare(
      `INSERT INTO events
       (pet_id, event_seq, revision, command_seq, game_time_ms, type, payload_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      petId,
      event.eventSeq,
      event.revision,
      event.commandSeq,
      event.gameTimeMs,
      event.type,
      JSON.stringify(event.payload),
      event.createdAtMs,
    )
  }

  insertCommand(petId: string, command: {
    commandSeq: number
    opId: string
    deviceId: string
    commandType: string
    payload: Record<string, unknown>
    status: 'applied' | 'rejected'
    result?: unknown
    error?: unknown
    revision: number
    eventSeq: number
    createdAtMs: number
  }): void {
    this.db.prepare(
      `INSERT INTO commands
       (pet_id, command_seq, op_id, device_id, command_type, payload_json, status,
        result_json, error_json, revision, event_seq, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      petId,
      command.commandSeq,
      command.opId,
      command.deviceId,
      command.commandType,
      JSON.stringify(command.payload),
      command.status,
      command.result === undefined ? null : JSON.stringify(command.result),
      command.error === undefined ? null : JSON.stringify(command.error),
      command.revision,
      command.eventSeq,
      command.createdAtMs,
    )
  }

  compareAndSwapRevision(petId: string, expectedRevision: number, operation: () => void): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM pets WHERE id = ?').get(petId) as { revision: number } | undefined
      if (row === undefined || Number(row.revision) !== expectedRevision) return false
      operation()
      const changed = this.db.prepare('UPDATE pets SET revision = revision + 1, updated_at_ms = ? WHERE id = ? AND revision = ?')
        .run(Date.now(), petId, expectedRevision)
      if (Number(changed.changes) !== 1) throw new Error('revision_conflict')
      return true
    })
  }

  loadCanonical(petId: string): CanonicalPetSnapshot {
    const pet = this.getPet(petId)
    const settings = this.getSettings(petId)
    const authority = this.getAuthority(petId)
    if (pet === undefined || settings === undefined || authority === undefined) throw new Error('pet not found or incomplete: ' + petId)
    let engine: EngineState
    try {
      const parsed = JSON.parse(pet.engineJson) as EngineState
      const save = JSON.parse(pet.saveJson) as EngineState['save']
      engine = {
        ...parsed,
        save,
        gameTimeMs: pet.gameTimeMs,
        lastSchedulerWallMs: pet.lastSchedulerWallMs,
        timeZone: settings.timeZone,
        advanceWhileEmpty: settings.advanceWhileEmpty,
        weatherLocation: settings.weatherLocation === null ? parsed.weatherLocation : settings.weatherLocation,
        scheduledJobs: this.listScheduledJobs(petId),
        gameSessions: this.listGameSessions(petId),
        sessionCoverage: this.listSessionCoverage(petId),
      }
      assertEngineState(engine)
    } catch (error) {
      throw new Error('canonical engine state is corrupt: ' + (error instanceof Error ? error.message : 'invalid JSON'))
    }
    return { pet, settings, authority, engine }
  }

  beginCoverage(petId: string, deviceId: string, connectionId: string, at: number): string {
    const coverageId = randomUUID()
    this.db.prepare(
      `INSERT INTO session_coverage
       (pet_id, coverage_id, device_id, connection_id, authenticated_session_id, connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    ).run(petId, coverageId, deviceId, connectionId, connectionId, at, at)
    return coverageId
  }

  heartbeatCoverage(petId: string, coverageId: string, at: number): void {
    this.db.prepare(
      'UPDATE session_coverage SET last_heartbeat_at_ms = ? WHERE pet_id = ? AND coverage_id = ? AND disconnected_at_ms IS NULL',
    ).run(at, petId, coverageId)
  }

  closeCoverage(petId: string, coverageId: string, at: number, reason: 'disconnect' | 'shutdown' | 'socket_closed' | 'authority_handoff'): void {
    this.db.prepare(
      'UPDATE session_coverage SET disconnected_at_ms = ?, last_heartbeat_at_ms = MAX(last_heartbeat_at_ms, ?), close_reason = ? WHERE pet_id = ? AND coverage_id = ? AND disconnected_at_ms IS NULL',
    ).run(at, at, reason, petId, coverageId)
  }

  listOpenCoverage(petId: string): Array<{ coverageId: string; deviceId: string; connectionId: string | null }> {
    return (this.db.prepare(
      'SELECT coverage_id, device_id, connection_id FROM session_coverage WHERE pet_id = ? AND disconnected_at_ms IS NULL',
    ).all(petId) as Array<Record<string, unknown>>).map(row => ({
      coverageId: String(row.coverage_id),
      deviceId: String(row.device_id),
      connectionId: row.connection_id === null ? null : String(row.connection_id),
    }))
  }

  listScheduledJobs(petId: string): EngineState['scheduledJobs'] {
    return (this.db.prepare(
      'SELECT * FROM scheduled_jobs WHERE pet_id = ? ORDER BY due_at_game_ms, job_id',
    ).all(petId) as Array<Record<string, unknown>>).map(row => ({
      id: Number(row.job_id),
      type: String(row.kind) as EngineState['scheduledJobs'][number]['type'],
      dueAtGameMs: Number(row.due_at_game_ms),
      payload: JSON.parse(String(row.payload_json)) as EngineState['scheduledJobs'][number]['payload'],
      status: String(row.status) as EngineState['scheduledJobs'][number]['status'],
    }))
  }

  listGameSessions(petId: string): EngineState['gameSessions'] {
    return (this.db.prepare(
      'SELECT * FROM game_sessions WHERE pet_id = ? ORDER BY started_at_game_ms, session_token',
    ).all(petId) as Array<Record<string, unknown>>).map(row => {
      const session: EngineState['gameSessions'][number] = {
        sessionToken: String(row.session_token),
        actorDeviceId: String(row.actor_device_id),
        payload: JSON.parse(String(row.payload_json)) as EngineState['gameSessions'][number]['payload'],
        startedAtGameMs: Number(row.started_at_game_ms),
        expiresAtGameMs: Number(row.expires_at_game_ms),
        status: String(row.status) as EngineState['gameSessions'][number]['status'],
      }
      if (row.settled_command_seq !== null) session.settledCommandSeq = Number(row.settled_command_seq)
      if (row.reward_key !== null) session.rewardKey = String(row.reward_key)
      if (row.cancel_reason !== null) session.cancelReason = String(row.cancel_reason)
      return session
    })
  }

  listSessionCoverage(petId: string): EngineState['sessionCoverage'] {
    return (this.db.prepare(
      'SELECT * FROM session_coverage WHERE pet_id = ? ORDER BY connected_at_ms, coverage_id',
    ).all(petId) as Array<Record<string, unknown>>).map(row => {
      const interval: EngineState['sessionCoverage'][number] = {
        coverageId: String(row.coverage_id),
        deviceId: String(row.device_id),
        connectedAtWallMs: Number(row.connected_at_ms),
        lastHeartbeatWallMs: Number(row.last_heartbeat_at_ms),
      }
      if (row.disconnected_at_ms !== null) interval.disconnectedAtWallMs = Number(row.disconnected_at_ms)
      if (row.close_reason !== null) interval.closeReason = String(row.close_reason) as NonNullable<typeof interval.closeReason>
      return interval
    })
  }

  replaceScheduledJobs(petId: string, jobs: EngineState['scheduledJobs']): void {
    this.db.prepare('DELETE FROM scheduled_jobs WHERE pet_id = ?').run(petId)
    const insert = this.db.prepare(
      `INSERT INTO scheduled_jobs
       (pet_id, job_id, kind, due_at_game_ms, payload_json, status, created_command_seq, completed_command_seq)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    for (const job of jobs) {
      insert.run(petId, job.id, job.type, job.dueAtGameMs, JSON.stringify(job.payload), job.status)
    }
  }

  replaceGameSessions(petId: string, sessions: EngineState['gameSessions']): void {
    this.db.prepare('DELETE FROM game_sessions WHERE pet_id = ?').run(petId)
    const insert = this.db.prepare(
      `INSERT INTO game_sessions
       (pet_id, session_token, actor_device_id, session_kind, payload_json, started_at_game_ms,
        expires_at_game_ms, status, settled_command_seq, reward_key, cancel_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const session of sessions) {
      insert.run(
        petId,
        session.sessionToken,
        session.actorDeviceId,
        session.payload.kind,
        JSON.stringify(session.payload),
        session.startedAtGameMs,
        session.expiresAtGameMs,
        session.status,
        session.settledCommandSeq ?? null,
        session.rewardKey ?? null,
        session.cancelReason ?? null,
      )
    }
  }

  setSchedulerAnchor(petId: string, anchorMs: number, at = Date.now()): void {
    if (Number.isSafeInteger(anchorMs) === false || anchorMs < 0) throw new Error('scheduler anchor must be a non-negative safe integer')
    const pet = this.getPet(petId)
    if (pet === undefined) throw new Error('pet not found: ' + petId)
    let engineJson = pet.engineJson
    try {
      const parsed = JSON.parse(engineJson) as Record<string, unknown>
      parsed.lastSchedulerWallMs = anchorMs
      engineJson = JSON.stringify(parsed)
    } catch {
      // The canonical loader validates engine_json on the next read; keep the column authoritative.
    }
    this.db.prepare(
      'UPDATE pets SET last_scheduler_wall_ms = ?, engine_json = ?, updated_at_ms = ? WHERE id = ?',
    ).run(anchorMs, engineJson, at, petId)
  }

  /** Atomically commits one bounded scheduler chunk with its ordered events. */
  commitSchedulerBatch(
    petId: string,
    expectedRevision: number,
    engine: EngineState,
    ticks: Array<{ gameTimeMs: number; events: DomainEvent[] }>,
    at: number,
  ): { pet: PetRecord; events: OrderedEvent[] } {
    assertEngineState(engine)
    return this.transaction(() => {
      const current = this.getPet(petId)
      if (current === undefined) throw new Error('pet not found: ' + petId)
      const nextPet = this.replaceEngineAndRevision(petId, engine, expectedRevision, true, at)
      let eventSeq = current.eventSeq
      const ordered: OrderedEvent[] = []
      for (const tick of ticks) {
        for (const event of tick.events) {
          eventSeq += 1
          const orderedEvent: OrderedEvent = {
            eventSeq,
            revision: nextPet.revision,
            gameTimeMs: tick.gameTimeMs,
            type: event.type,
            payload: event.payload,
          }
          ordered.push(orderedEvent)
          this.insertEvent(petId, {
            eventSeq,
            revision: nextPet.revision,
            commandSeq: null,
            gameTimeMs: tick.gameTimeMs,
            type: event.type,
            payload: event.payload,
            createdAtMs: at,
          })
        }
      }
      this.db.prepare('UPDATE pets SET event_seq = ? WHERE id = ?').run(eventSeq, petId)
      return { pet: { ...nextPet, eventSeq }, events: ordered }
    })
  }

  replaceSessionCoverage(petId: string, intervals: EngineState['sessionCoverage']): void {
    this.db.prepare('DELETE FROM session_coverage WHERE pet_id = ?').run(petId)
    const insert = this.db.prepare(
      `INSERT INTO session_coverage
       (pet_id, coverage_id, device_id, connection_id, authenticated_session_id,
        connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const interval of intervals) {
      insert.run(
        petId,
        interval.coverageId,
        interval.deviceId,
        interval.coverageId,
        interval.coverageId,
        interval.connectedAtWallMs,
        interval.disconnectedAtWallMs ?? null,
        interval.lastHeartbeatWallMs,
        interval.closeReason ?? null,
      )
    }
  }

  /**
   * Portable import commit: replace canonical engine/authority/coverage atomically
   * while recording a pending reopen operation for currently authenticated survivors.
   */
  importCanonicalBundle(options: CanonicalImportOptions): PetRecord {
    return this.transaction(() => this.applyCanonicalImport(options))
  }

  /** Import body; the caller must already be inside a transaction. */
  applyCanonicalImport(options: CanonicalImportOptions): PetRecord {
    assertEngineState(options.engine)
    {
      const current = this.getPet(options.petId)
      if (current === undefined) throw new Error('pet not found: ' + options.petId)
      this.closeAndCreateCoverageOperation(
        options.petId,
        options.operationId,
        options.commitWallMs,
        options.survivors,
        'import_replaced',
      )
      this.replaceSessionCoverage(options.petId, options.importedCoverage)
      const nextRevision = Math.max(current.revision, options.baseRevision) + 1
      const nextEventSeq = Math.max(current.eventSeq, options.baseEventSeq)
      this.db.prepare(
        `UPDATE pets
         SET revision = ?, event_seq = ?, game_time_ms = ?, last_scheduler_wall_ms = ?,
             save_json = ?, engine_json = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(
        nextRevision,
        nextEventSeq,
        options.engine.gameTimeMs,
        options.engine.lastSchedulerWallMs,
        JSON.stringify(options.engine.save),
        JSON.stringify(options.engine),
        options.at,
        options.petId,
      )
      this.db.prepare(
        `UPDATE pet_settings
         SET advance_while_empty = ?, time_zone = ?, weather_location = ?, updated_at_ms = ?
         WHERE pet_id = ?`,
      ).run(
        options.engine.advanceWhileEmpty ? 1 : 0,
        options.engine.timeZone,
        options.engine.weatherLocation || null,
        options.at,
        options.petId,
      )
      this.replaceScheduledJobs(options.petId, options.engine.scheduledJobs)
      this.replaceGameSessions(options.petId, options.engine.gameSessions)
      this.db.prepare(
        `UPDATE pet_authority
         SET authority_id = ?, restore_generation = ?, epoch = ?, handoff_epoch = NULL,
             owner = 'server', state = 'active', handoff_id = ?, detached_at_ms = NULL,
             source_revision = ?, source_event_seq = ?
         WHERE pet_id = ?`,
      ).run(
        options.authorityId,
        options.restoreGeneration,
        options.nextEpoch,
        options.handoffId,
        options.sourceRevision,
        options.sourceEventSeq,
        options.petId,
      )
      const pet = this.getPet(options.petId)
      if (pet === undefined) throw new Error('pet disappeared during import')
      return pet
    }
  }

  /** Archive body; the caller must already be inside a transaction. */
  applyAuthorityArchive(options: AuthorityArchiveOptions): AuthorityRecord {
    const current = this.getPet(options.petId)
    const authority = this.getAuthority(options.petId)
    if (current === undefined || authority === undefined) throw new Error('pet authority is missing: ' + options.petId)
    this.closeAndCreateCoverageOperation(
      options.petId,
      options.operationId,
      options.at,
      options.survivors,
      'authority_handoff',
    )
    // The source authority leaves; terminal-finalize every survivor at the archive wall.
    for (const survivor of options.survivors) {
      if (survivor.eligible === false || survivor.activeEndWallMs !== undefined) continue
      const result = finalizeSurvivor(survivor, {
        commitWallMs: options.at,
        eventBoundaryMs: options.at,
        eventReason: 'authority_handoff',
        terminal: true,
      })
      if (result.materialize) {
        this.upsertStableCoverageRow(options.petId, options.operationId, survivor, options.at, result.endWallMs, result.provenance)
      }
    }
    this.db.prepare(
      'UPDATE coverage_operations SET state = ?, completed_at_ms = ? WHERE pet_id = ? AND operation_id = ?',
    ).run('completed', options.at, options.petId, options.operationId)
    this.db.prepare(
      `UPDATE pet_authority
       SET owner = 'local', state = 'archived', handoff_epoch = ?, handoff_id = ?,
           detached_at_ms = ?, source_revision = ?, source_event_seq = ?
       WHERE pet_id = ?`,
    ).run(
      options.nextEpoch,
      options.handoffId,
      options.at,
      current.revision,
      current.eventSeq,
      options.petId,
    )
    const updated = this.getAuthority(options.petId)
    if (updated === undefined) throw new Error('pet authority disappeared during archive')
    return updated
  }

  archiveAuthority(options: AuthorityArchiveOptions): AuthorityRecord {
    return this.transaction(() => this.applyAuthorityArchive(options))
  }

  replaceEngineAndRevision(
    petId: string,
    engine: EngineState,
    expectedRevision: number,
    incrementRevision: boolean,
    at: number,
  ): PetRecord {
    assertEngineState(engine)
    const nextRevision = incrementRevision ? expectedRevision + 1 : expectedRevision
    const changed = this.db.prepare(
      `UPDATE pets
       SET revision = ?, game_time_ms = ?, last_scheduler_wall_ms = ?, save_json = ?, engine_json = ?, updated_at_ms = ?
       WHERE id = ? AND revision = ?`,
    ).run(
      nextRevision,
      engine.gameTimeMs,
      engine.lastSchedulerWallMs,
      JSON.stringify(engine.save),
      JSON.stringify(engine),
      at,
      petId,
      expectedRevision,
    )
    if (Number(changed.changes) !== 1) throw new Error('revision_conflict')
    this.db.prepare(
      `UPDATE pet_settings
       SET advance_while_empty = ?, time_zone = ?, weather_location = ?, updated_at_ms = ?
       WHERE pet_id = ?`,
    ).run(engine.advanceWhileEmpty ? 1 : 0, engine.timeZone, engine.weatherLocation || null, at, petId)
    this.replaceScheduledJobs(petId, engine.scheduledJobs)
    this.replaceGameSessions(petId, engine.gameSessions)
    const pet = this.getPet(petId)
    if (pet === undefined) throw new Error('pet disappeared during commit')
    return pet
  }

  repairCoverageOnStartup(at: number): number {
    return this.finalizeOpenCoverageOperations({
      at,
      reason: 'crash_repaired',
      plainReason: 'crash_repaired',
      heartbeatGrace: true,
    })
  }

  finalizeCoverageOperationsOnShutdown(at: number): number {
    return this.finalizeOpenCoverageOperations({
      at,
      reason: 'shutdown',
      plainReason: 'shutdown',
      heartbeatGrace: false,
    })
  }

  getCoverageOperation(petId: string, operationId: string): CoverageOperationRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM coverage_operations WHERE pet_id = ? AND operation_id = ?',
    ).get(petId, operationId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapCoverageOperation(row)
  }

  listOpenCoverageOperations(petId?: string): CoverageOperationRecord[] {
    const rows = (petId === undefined
      ? this.db.prepare(
        "SELECT * FROM coverage_operations WHERE state IN ('pending', 'suspended') ORDER BY commit_wall_ms, operation_id",
      ).all()
      : this.db.prepare(
        "SELECT * FROM coverage_operations WHERE pet_id = ? AND state IN ('pending', 'suspended') ORDER BY commit_wall_ms, operation_id",
      ).all(petId)) as Record<string, unknown>[]
    return rows.map(mapCoverageOperation)
  }

  private coverageEndFor(
    petId: string,
    operationId: string,
    survivor: CoverageSurvivor,
  ): { closeReason?: CoverageEndProvenance; endWallMs?: number } {
    const row = this.db.prepare(
      'SELECT close_reason, disconnected_at_ms FROM session_coverage WHERE pet_id = ? AND coverage_id = ?',
    ).get(petId, stableCoverageId(operationId, survivor)) as {
      close_reason?: unknown
      disconnected_at_ms?: unknown
    } | undefined
    if (row === undefined) return {}
    const result: { closeReason?: CoverageEndProvenance; endWallMs?: number } = {}
    if (row.close_reason !== null && row.close_reason !== undefined) {
      result.closeReason = String(row.close_reason) as CoverageEndProvenance
    }
    if (row.disconnected_at_ms !== null && row.disconnected_at_ms !== undefined) {
      result.endWallMs = Number(row.disconnected_at_ms)
    }
    return result
  }

  private upsertStableCoverageRow(
    petId: string,
    operationId: string,
    survivor: CoverageSurvivor,
    connectedAtMs: number,
    endWallMs: number,
    closeReason: CoverageEndProvenance,
  ): number {
    const coverageId = stableCoverageId(operationId, survivor)
    const key = survivorKey(survivor)
    const result = this.db.prepare(
      `INSERT INTO session_coverage
       (pet_id, coverage_id, device_id, connection_id, authenticated_session_id,
        connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pet_id, coverage_id) DO UPDATE SET
         disconnected_at_ms = excluded.disconnected_at_ms,
         last_heartbeat_at_ms = MAX(session_coverage.last_heartbeat_at_ms, excluded.last_heartbeat_at_ms),
         close_reason = CASE
           WHEN session_coverage.close_reason = 'suspend' THEN session_coverage.close_reason
           ELSE excluded.close_reason
         END
       WHERE session_coverage.disconnected_at_ms IS NULL`,
    ).run(
      petId,
      coverageId,
      survivorDeviceId(survivor),
      key,
      key,
      connectedAtMs,
      endWallMs,
      endWallMs,
      closeReason,
    )
    return Number(result.changes)
  }

  /** Close every open interval at the commit boundary and record a pending operation. */
  closeAndCreateCoverageOperation(
    petId: string,
    operationId: string,
    commitWallMs: number,
    survivors: CoverageSurvivor[],
    reason: 'pet_reset' | 'import_replaced' | 'authority_handoff',
  ): void {
    this.db.prepare(
      `UPDATE session_coverage
       SET disconnected_at_ms = MAX(connected_at_ms, ?),
           last_heartbeat_at_ms = MAX(last_heartbeat_at_ms, ?),
           close_reason = ?
       WHERE pet_id = ? AND disconnected_at_ms IS NULL`,
    ).run(commitWallMs, commitWallMs, reason, petId)
    this.db.prepare(
      `INSERT INTO coverage_operations
       (pet_id, operation_id, commit_wall_ms, survivors_json, state, suspended_at_ms, completed_at_ms)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL)`,
    ).run(petId, operationId, commitWallMs, JSON.stringify(survivors))
  }

  commitCoverageOperation(
    petId: string,
    operationId: string,
    commitWallMs: number,
    survivors: CoverageSurvivor[],
    reason: 'pet_reset' | 'import_replaced' | 'authority_handoff',
  ): void {
    this.transaction(() => {
      this.closeAndCreateCoverageOperation(petId, operationId, commitWallMs, survivors, reason)
    })
  }

  /**
   * After a reset/import commit, reopen exactly one interval for each exact
   * persisted survivor that is still authenticated, then complete the operation.
   * `live` maps connectionId/appInstanceId to the authenticated device id.
   */
  completeCoverageReopen(
    petId: string,
    operationId: string,
    commitWallMs: number,
    live: Map<string, string>,
    at: number,
  ): number {
    return this.transaction(() => {
      const operation = this.getCoverageOperation(petId, operationId)
      if (operation === undefined || operation.state === 'completed') return 0
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO session_coverage
         (pet_id, coverage_id, device_id, connection_id, authenticated_session_id,
          connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      let reopened = 0
      for (const survivor of operation.survivors) {
        if (survivor.eligible === false) continue
        const key = survivorKey(survivor)
        if (live.get(key) !== survivorDeviceId(survivor)) continue
        const result = insert.run(
          petId,
          stableCoverageId(operationId, survivor),
          survivorDeviceId(survivor),
          key,
          key,
          commitWallMs,
          at,
        )
        if (Number(result.changes) === 1) reopened += 1
      }
      this.db.prepare(
        'UPDATE coverage_operations SET state = ?, completed_at_ms = ? WHERE pet_id = ? AND operation_id = ?',
      ).run('completed', at, petId, operationId)
      return reopened
    })
  }

  /** Known suspend: non-terminal-finalize eligible survivors and keep the operation resumable. */
  markCoverageOperationSuspended(petId: string, operationId: string, at: number): number {
    return this.transaction(() => {
      const operation = this.getCoverageOperation(petId, operationId)
      if (operation === undefined || operation.state === 'completed') return 0
      let finalized = 0
      // A repeated suspension is idempotent: the first known suspend wall is the cap.
      const suspendedAt = operation.suspendedAtMs ?? at
      const survivors = operation.survivors.map(original => {
        if (original.eligible === false || original.activeEndWallMs !== undefined) return original
        const existing = this.coverageEndFor(petId, operationId, original)
        const result = finalizeSurvivor(original, {
          commitWallMs: operation.commitWallMs,
          eventBoundaryMs: at,
          eventReason: 'suspend',
          terminal: false,
          suspendedAtMs: suspendedAt,
          ...(existing.closeReason === undefined ? {} : { existingCloseReason: existing.closeReason }),
          ...(existing.endWallMs === undefined ? {} : { existingEndWallMs: existing.endWallMs }),
        })
        const changed = this.upsertStableCoverageRow(
          petId,
          operationId,
          original,
          operation.commitWallMs,
          result.endWallMs,
          'suspend',
        )
        if (changed > 0) finalized += 1
        return result.survivor
      })
      this.db.prepare(
        'UPDATE coverage_operations SET state = ?, suspended_at_ms = ?, survivors_json = ? WHERE pet_id = ? AND operation_id = ?',
      ).run('suspended', suspendedAt, JSON.stringify(survivors), petId, operationId)
      return finalized
    })
  }

  /** Same-process resume opens fresh intervals at the actual resume wall and completes the operation. */
  resumeCoverageOperation(petId: string, operationId: string, live: Map<string, string>, at: number): number {
    return this.transaction(() => {
      const operation = this.getCoverageOperation(petId, operationId)
      if (operation === undefined || operation.state === 'completed') return 0
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO session_coverage
         (pet_id, coverage_id, device_id, connection_id, authenticated_session_id,
          connected_at_ms, disconnected_at_ms, last_heartbeat_at_ms, close_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      let reopened = 0
      for (const survivor of operation.survivors) {
        if (survivor.eligible === false) continue
        const key = survivorKey(survivor)
        if (live.get(key) !== survivorDeviceId(survivor)) continue
        const result = insert.run(
          petId,
          operationId + ':' + key + ':resume',
          survivorDeviceId(survivor),
          key,
          key,
          at,
          at,
        )
        if (Number(result.changes) === 1) reopened += 1
      }
      this.db.prepare(
        'UPDATE coverage_operations SET state = ?, completed_at_ms = ? WHERE pet_id = ? AND operation_id = ?',
      ).run('completed', at, petId, operationId)
      return reopened
    })
  }

  /**
   * Startup/shutdown reconciliation. Pending operations are terminal-finalized
   * monotonically using the crash bound (or the known suspend cap); plain open
   * intervals are repaired separately. Never reopens old sockets.
   */
  finalizeOpenCoverageOperations(options: {
    at: number
    reason: CoverageEndProvenance
    plainReason: CoverageEndProvenance
    heartbeatGrace: boolean
  }): number {
    return this.transaction(() => {
      let finalized = 0
      for (const operation of this.listOpenCoverageOperations()) {
        const suspendedAt = operation.state === 'suspended' ? operation.suspendedAtMs : null
        const survivors = operation.survivors.map(original => {
          if (original.eligible === false || original.activeEndWallMs !== undefined) return original
          const heartbeatBound = options.heartbeatGrace
            ? Math.min(options.at, original.lastHeartbeatWallMs + COVERAGE_CRASH_GRACE_MS)
            : options.at
          const boundary = suspendedAt === null ? heartbeatBound : Math.min(suspendedAt, heartbeatBound)
          const existing = this.coverageEndFor(operation.petId, operation.operationId, original)
          const result = finalizeSurvivor(original, {
            commitWallMs: operation.commitWallMs,
            eventBoundaryMs: boundary,
            eventReason: options.reason,
            terminal: true,
            ...(suspendedAt === null ? {} : { suspendedAtMs: suspendedAt }),
            ...(existing.closeReason === undefined ? {} : { existingCloseReason: existing.closeReason }),
            ...(existing.endWallMs === undefined ? {} : { existingEndWallMs: existing.endWallMs }),
          })
          if (result.materialize) {
            this.upsertStableCoverageRow(
              operation.petId,
              operation.operationId,
              original,
              operation.commitWallMs,
              result.endWallMs,
              result.provenance,
            )
            finalized += 1
          }
          return result.survivor
        })
        this.db.prepare(
          'UPDATE coverage_operations SET state = ?, completed_at_ms = ?, survivors_json = ? WHERE pet_id = ? AND operation_id = ?',
        ).run('completed', options.at, JSON.stringify(survivors), operation.petId, operation.operationId)
      }
      const rows = this.db.prepare(
        'SELECT pet_id, coverage_id, connected_at_ms, last_heartbeat_at_ms FROM session_coverage WHERE disconnected_at_ms IS NULL',
      ).all() as Array<Record<string, unknown>>
      for (const row of rows) {
        const bound = options.heartbeatGrace
          ? Math.max(Number(row.connected_at_ms), Math.min(options.at, Number(row.last_heartbeat_at_ms) + COVERAGE_CRASH_GRACE_MS))
          : Math.max(Number(row.connected_at_ms), options.at)
        this.db.prepare(
          'UPDATE session_coverage SET disconnected_at_ms = ?, last_heartbeat_at_ms = MAX(last_heartbeat_at_ms, ?), close_reason = ? WHERE pet_id = ? AND coverage_id = ? AND disconnected_at_ms IS NULL',
        ).run(bound, bound, options.plainReason, String(row.pet_id), String(row.coverage_id))
      }
      return finalized
    })
  }

  /** Retention/compaction must never delete a stable row referenced by a pending/suspended operation. */
  pruneClosedCoverage(petId: string, beforeMs: number): number {
    return this.transaction(() => {
      const blocked = new Set<string>()
      for (const operation of this.listOpenCoverageOperations(petId)) {
        for (const survivor of operation.survivors) blocked.add(stableCoverageId(operation.operationId, survivor))
      }
      const rows = this.db.prepare(
        'SELECT coverage_id FROM session_coverage WHERE pet_id = ? AND disconnected_at_ms IS NOT NULL AND disconnected_at_ms < ?',
      ).all(petId, beforeMs) as Array<{ coverage_id: string }>
      let deleted = 0
      const remove = this.db.prepare('DELETE FROM session_coverage WHERE pet_id = ? AND coverage_id = ?')
      for (const row of rows) {
        if (blocked.has(String(row.coverage_id))) continue
        deleted += Number(remove.run(petId, String(row.coverage_id)).changes)
      }
      return deleted
    })
  }

  maxRestoreGeneration(): number {
    const row = this.db.prepare('SELECT MAX(restore_generation) AS generation FROM pet_authority').get() as { generation: number | null }
    return row.generation === null ? 0 : Number(row.generation)
  }

  /**
   * Restore fencing: an operator-recorded generation file outside the DB is the
   * authority on rollback acceptance. A DB older than the recorded generation
   * must fail closed instead of silently serving rolled-back authority.
   */
  verifyRestoreGeneration(filePath?: string): number {
    const current = this.maxRestoreGeneration()
    const recorded = readRestoreGenerationRecord(filePath)
    if (recorded !== undefined && recorded > current) {
      throw new Error('database restore is older than the recorded restore generation; run restore --accept-rollback')
    }
    if (recorded !== undefined && recorded !== current) {
      throw new Error('database restore generation does not match the recorded restore fence; run restore --accept-rollback')
    }
    if (filePath !== undefined && recorded === undefined && current > 0) {
      throw new Error('database restore generation fence is missing; run restore --accept-rollback')
    }
    return current
  }

  resetAuthorityAfterRestore(petId: string, nextGeneration: number, at = Date.now()): AuthorityRecord {
    return this.resetAuthoritiesAfterRestore([petId], nextGeneration, at)[0]
  }

  /**
   * Reset every restored pet in one transaction. All preconditions are checked
   * before the first UPDATE, so the staged database is either fully reset or
   * left untouched.
   */
  resetAuthoritiesAfterRestore(petIds: readonly string[], nextGeneration: number, at = Date.now()): AuthorityRecord[] {
    if (Number.isSafeInteger(nextGeneration) === false || nextGeneration < 0) {
      throw new Error('restore generation must be a non-negative safe integer')
    }
    const uniquePetIds = [...new Set(petIds)]
    if (uniquePetIds.length === 0) throw new Error('restore requires at least one pet')
    if (uniquePetIds.length !== petIds.length) throw new Error('restore pet list contains duplicates')
    return this.transaction(() => {
      const current = uniquePetIds.map(petId => {
        const authority = this.getAuthority(petId)
        if (authority === undefined) throw new Error('pet authority is missing: ' + petId)
        if (Number.isSafeInteger(authority.restoreGeneration) === false || authority.restoreGeneration < 0) {
          throw new Error('pet authority restore generation is invalid: ' + petId)
        }
        if (authority.restoreGeneration >= nextGeneration) {
          throw new Error('restore generation does not advance pet authority: ' + petId)
        }
        if (Number.isSafeInteger(authority.epoch) === false || authority.epoch >= Number.MAX_SAFE_INTEGER) {
          throw new Error('pet authority epoch is not restorable: ' + petId)
        }
        return { petId, authority }
      })
      const update = this.db.prepare(
        `UPDATE pet_authority
         SET authority_id = ?, restore_generation = ?, epoch = ?, handoff_epoch = NULL,
             owner = 'server', state = 'active', handoff_id = ?, detached_at_ms = NULL,
             source_revision = NULL, source_event_seq = NULL
         WHERE pet_id = ?`,
      )
      void at
      return current.map(({ petId, authority }) => {
        update.run(randomUUID(), nextGeneration, authority.epoch + 1, randomUUID(), petId)
        const updated = this.getAuthority(petId)
        if (updated === undefined) throw new Error('pet authority disappeared during restore')
        return updated
      })
    })
  }

  async backup(path: string): Promise<void> {
    await sqliteBackup(this.db, path)
  }
}

export interface InitializePetOptions {
  petId: string
  timeZone: string
  weatherCity?: string
  nowMs?: number
  advanceWhileEmpty?: boolean
  seedHex?: string
}

export interface InitializePetResult {
  petId: string
  pairingCode: string
  pairingExpiresAtMs: number
  authority: WireAuthority
}

export function createEmptyEngine(options: {
  timeZone: string
  weatherLocation?: string
  nowMs: number
  advanceWhileEmpty: boolean
  seedHex?: string
}): EngineState {
  const seedHex = options.seedHex ?? randomBytes(16).toString('hex')
  const rng = createRngState(seedHex)
  const save = emptyEggSave({
    settings: { paused: false, difficulty: 'easy', undying: false },
  } as never)
  const engine: EngineState = {
    schemaVersion: 1,
    save,
    gameTimeMs: options.nowMs,
    lastSchedulerWallMs: options.nowMs,
    timeZone: options.timeZone,
    weatherLocation: options.weatherLocation ?? '',
    advanceWhileEmpty: options.advanceWhileEmpty,
    rng,
    scheduledJobs: [],
    nextScheduledJobId: 1,
    gameSessions: [],
    sessionCoverage: [],
    lastProcessedDayBoundaryKey: dayKeyAt(options.nowMs, options.timeZone),
    nextDailyBoundaryMs: nextDailyBoundaryMs(options.nowMs, options.timeZone),
    importClamped: false,
    clockSkippedMs: 0,
    environment: { calendarByDay: {}, weatherByDay: {} },
  }
  assertEngineState(engine)
  return engine
}

export function initializePet(store: DatabaseStore, options: InitializePetOptions): InitializePetResult {
  if (store.getPet(options.petId) !== undefined) throw new Error('pet already exists: ' + options.petId)
  const nowMs = nowInteger(options.nowMs)
  const engine = createEmptyEngine({
    timeZone: options.timeZone,
    weatherLocation: options.weatherCity,
    nowMs,
    advanceWhileEmpty: options.advanceWhileEmpty ?? true,
    seedHex: options.seedHex,
  })
  const authorityId = randomUUID()
  const handoffId = randomUUID()
  store.transaction(() => {
    store.db.prepare(
      `INSERT INTO pets
       (id, schema_version, revision, command_seq, event_seq, game_time_ms, last_scheduler_wall_ms, save_json, engine_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      options.petId,
      SCHEMA_VERSION,
      engine.gameTimeMs,
      engine.lastSchedulerWallMs,
      JSON.stringify(engine.save),
      JSON.stringify(engine),
      nowMs,
      nowMs,
    )
    store.db.prepare(
      'INSERT INTO pet_settings (pet_id, advance_while_empty, time_zone, weather_location, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run(options.petId, engine.advanceWhileEmpty ? 1 : 0, options.timeZone, engine.weatherLocation || null, nowMs)
    store.db.prepare(
      `INSERT INTO pet_authority
       (pet_id, authority_id, restore_generation, epoch, handoff_epoch, owner, state, handoff_id, detached_at_ms, source_revision, source_event_seq)
       VALUES (?, ?, 0, 0, 1, 'server', 'active', ?, NULL, 0, 0)`,
    ).run(options.petId, authorityId, handoffId)
  })
  const initial = store.issuePairingCode(options.petId, 'owner', 10 * 60_000)
  return {
    petId: options.petId,
    pairingCode: initial.code,
    pairingExpiresAtMs: initial.expiresAtMs,
    authority: {
      owner: 'server',
      authorityId,
      restoreGeneration: 0,
      epoch: 0,
      state: 'active',
    },
  }
}

export function openDatabase(path: string): DatabaseStore {
  return new DatabaseStore(path)
}

export function openDatabaseReadOnly(path: string): DatabaseStore {
  return new DatabaseStore(path, { readOnly: true })
}

export interface RestoreSourceInfo {
  petIds: string[]
  authorities: AuthorityRecord[]
  maxRestoreGeneration: number
}

/**
 * Validate a restore candidate without modifying it. SQLite is opened through
 * an immutable read-only URI so validation cannot create WAL/SHM sidecars.
 */
export function inspectRestoreSource(path: string): RestoreSourceInfo {
  const store = openDatabaseReadOnly(path)
  try {
    const foreignKeyViolations = store.db.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length > 0) throw new Error('sqlite foreign_key_check failed')
    const pets = store.listPets()
    if (pets.length === 0) throw new Error('backup contains no pets')
    const authorities: AuthorityRecord[] = []
    for (const pet of pets) {
      if (pet.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported pet schema version: ' + pet.id)
      const canonical = store.loadCanonical(pet.id)
      const authority = canonical.authority
      if (Number.isSafeInteger(authority.restoreGeneration) === false || authority.restoreGeneration < 0) {
        throw new Error('pet authority restore generation is invalid: ' + pet.id)
      }
      if (Number.isSafeInteger(authority.epoch) === false || authority.epoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error('pet authority epoch is not restorable: ' + pet.id)
      }
      authorities.push(authority)
    }
    const maxRestoreGeneration = store.maxRestoreGeneration()
    if (Number.isSafeInteger(maxRestoreGeneration) === false || maxRestoreGeneration < 0) {
      throw new Error('restore generation is invalid')
    }
    return { petIds: pets.map(pet => pet.id), authorities, maxRestoreGeneration }
  } finally {
    store.close()
  }
}

function mapCoverageOperation(row: Record<string, unknown>): CoverageOperationRecord {
  const survivors = JSON.parse(String(row.survivors_json)) as CoverageSurvivor[]
  if (Array.isArray(survivors) === false) throw new Error('coverage operation survivors_json is invalid')
  return {
    petId: String(row.pet_id),
    operationId: String(row.operation_id),
    commitWallMs: Number(row.commit_wall_ms),
    survivors,
    state: String(row.state) as CoverageOperationRecord['state'],
    suspendedAtMs: row.suspended_at_ms === null ? null : Number(row.suspended_at_ms),
    completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
  }
}

function mapPet(row: Record<string, unknown>): PetRecord {
  return {
    id: String(row.id),
    schemaVersion: Number(row.schema_version),
    revision: Number(row.revision),
    commandSeq: Number(row.command_seq),
    eventSeq: Number(row.event_seq),
    gameTimeMs: Number(row.game_time_ms),
    lastSchedulerWallMs: Number(row.last_scheduler_wall_ms),
    saveJson: String(row.save_json),
    engineJson: String(row.engine_json),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  }
}

function mapAuthority(row: Record<string, unknown>): AuthorityRecord {
  return {
    petId: String(row.pet_id),
    authorityId: String(row.authority_id),
    restoreGeneration: Number(row.restore_generation),
    epoch: Number(row.epoch),
    handoffEpoch: row.handoff_epoch === null ? null : Number(row.handoff_epoch),
    owner: String(row.owner) as AuthorityRecord['owner'],
    state: String(row.state) as AuthorityRecord['state'],
    handoffId: String(row.handoff_id),
    detachedAtMs: row.detached_at_ms === null ? null : Number(row.detached_at_ms),
    sourceRevision: row.source_revision === null ? null : Number(row.source_revision),
    sourceEventSeq: row.source_event_seq === null ? null : Number(row.source_event_seq),
  }
}

function mapDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    petId: String(row.pet_id),
    deviceId: String(row.device_id),
    label: String(row.label),
    role: String(row.role) as DeviceRole,
    tokenHash: Buffer.from(row.token_hash as Uint8Array),
    createdAtMs: Number(row.created_at_ms),
    lastSeenAtMs: row.last_seen_at_ms === null ? null : Number(row.last_seen_at_ms),
    revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
  }
}

function mapCommand(row: Record<string, unknown>): CommandRecord {
  return {
    petId: String(row.pet_id),
    commandSeq: Number(row.command_seq),
    opId: String(row.op_id),
    deviceId: String(row.device_id),
    commandType: String(row.command_type),
    payloadJson: String(row.payload_json),
    status: String(row.status) as CommandRecord['status'],
    resultJson: row.result_json === null ? null : String(row.result_json),
    errorJson: row.error_json === null ? null : String(row.error_json),
    revision: Number(row.revision),
    eventSeq: Number(row.event_seq),
    createdAtMs: Number(row.created_at_ms),
  }
}

function mapEvent(row: Record<string, unknown>): EventRecord {
  return {
    petId: String(row.pet_id),
    eventSeq: Number(row.event_seq),
    revision: Number(row.revision),
    commandSeq: row.command_seq === null ? null : Number(row.command_seq),
    gameTimeMs: Number(row.game_time_ms),
    type: String(row.type),
    payloadJson: String(row.payload_json),
    createdAtMs: Number(row.created_at_ms),
  }
}
