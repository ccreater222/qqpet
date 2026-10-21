import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertTimeZone, GAME_MINUTE_MS } from '../../src/shared/pet-runtime/index.js'

export interface ServerConfig {
  bind: string
  port: number
  dbPath: string
  backupDir: string
  adminSocket: string
  restoreGenerationFile?: string
  timeZone: string
  weatherLocation: string
  advanceWhileEmpty: boolean
  catchupChunkTicks: number
  commandRetention: number
  eventRetention: number
  logRetentionDays: number
  maxFrameBytes: number
  maxCommandBytes: number
  maxSnapshotBytes: number
  maxReplayEvents: number
  maxConnectionsPerPet: number
  helloTimeoutMs: number
  idleTimeoutMs: number
  pingIntervalMs: number
  commandRatePerSecond: number
  commandRateBurst: number
  pairingTtlMs: number
  schedulerPollMs: number
  schedulerEnabled: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export interface ServerConfigInput extends Partial<Omit<ServerConfig, 'dbPath' | 'backupDir' | 'adminSocket'>> {
  dbPath?: string
  backupDir?: string
  adminSocket?: string
  restoreGenerationFile?: string
}

function integer(value: string | number | undefined, fallback: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : value === undefined || value === '' ? fallback : Number(value)
  if (Number.isSafeInteger(parsed) === false || parsed < min || parsed > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max)
  }
  return parsed
}

function boolean(value: string | boolean | undefined, fallback: boolean, name: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === '') return fallback
  if (value === '1' || value.toLowerCase() === 'true') return true
  if (value === '0' || value.toLowerCase() === 'false') return false
  throw new Error(name + ' must be 0, 1, true or false')
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(name + ' must be an absolute path')
  return resolve(value)
}

function defaultDataDirectory(): string {
  return join(homedir(), '.local', 'share', 'qqpet-sync')
}

export function createServerConfig(input: ServerConfigInput = {}, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDirectory = defaultDataDirectory()
  const dbPath = absolutePath(input.dbPath ?? env.QQPET_SYNC_DB ?? join(dataDirectory, 'qqpet.sqlite'), 'QQPET_SYNC_DB')
  const backupDir = absolutePath(
    input.backupDir ?? env.QQPET_SYNC_BACKUP_DIR ?? join(dirname(dbPath), 'backups'),
    'QQPET_SYNC_BACKUP_DIR',
  )
  const adminSocket = absolutePath(
    input.adminSocket ?? env.QQPET_ADMIN_SOCKET ?? join(dirname(dbPath), 'admin-' + hostname() + '.sock'),
    'QQPET_ADMIN_SOCKET',
  )
  const timeZone = input.timeZone ?? env.QQPET_SYNC_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  assertTimeZone(timeZone)
  const restoreGenerationFile = input.restoreGenerationFile ?? env.QQPET_SYNC_RESTORE_GENERATION_FILE
  return {
    bind: input.bind ?? env.QQPET_SYNC_BIND ?? '127.0.0.1',
    port: integer(input.port ?? env.QQPET_SYNC_PORT, 8787, 'QQPET_SYNC_PORT', 0, 65_535),
    dbPath,
    backupDir,
    adminSocket,
    ...(restoreGenerationFile === undefined || restoreGenerationFile === ''
      ? {}
      : { restoreGenerationFile: absolutePath(restoreGenerationFile, 'QQPET_SYNC_RESTORE_GENERATION_FILE') }),
    timeZone,
    weatherLocation: input.weatherLocation ?? env.QQPET_SYNC_WEATHER_LOCATION ?? '',
    advanceWhileEmpty: boolean(
      input.advanceWhileEmpty ?? env.QQPET_SYNC_ADVANCE_WHILE_EMPTY,
      true,
      'QQPET_SYNC_ADVANCE_WHILE_EMPTY',
    ),
    catchupChunkTicks: integer(input.catchupChunkTicks ?? env.QQPET_SYNC_CATCHUP_CHUNK_TICKS, 1440, 'catchupChunkTicks', 1),
    commandRetention: integer(input.commandRetention ?? env.QQPET_SYNC_COMMAND_RETENTION, 10_000, 'commandRetention', 1),
    eventRetention: integer(input.eventRetention ?? env.QQPET_SYNC_EVENT_RETENTION, 10_000, 'eventRetention', 1),
    logRetentionDays: integer(input.logRetentionDays ?? env.QQPET_SYNC_LOG_RETENTION_DAYS, 30, 'logRetentionDays', 1),
    maxFrameBytes: integer(input.maxFrameBytes ?? env.QQPET_SYNC_MAX_FRAME_BYTES, 16 * 1024 * 1024, 'maxFrameBytes', 1024),
    maxCommandBytes: integer(input.maxCommandBytes ?? env.QQPET_SYNC_MAX_COMMAND_BYTES, 256 * 1024, 'maxCommandBytes', 1024),
    maxSnapshotBytes: integer(input.maxSnapshotBytes, 16 * 1024 * 1024, 'maxSnapshotBytes', 1024),
    maxReplayEvents: integer(input.maxReplayEvents, 10_000, 'maxReplayEvents', 1),
    maxConnectionsPerPet: integer(input.maxConnectionsPerPet, 8, 'maxConnectionsPerPet', 1),
    helloTimeoutMs: integer(input.helloTimeoutMs, 5000, 'helloTimeoutMs', 100),
    idleTimeoutMs: integer(input.idleTimeoutMs, 60_000, 'idleTimeoutMs', 1000),
    pingIntervalMs: integer(input.pingIntervalMs, 20_000, 'pingIntervalMs', 1000),
    commandRatePerSecond: integer(input.commandRatePerSecond, 10, 'commandRatePerSecond', 1),
    commandRateBurst: integer(input.commandRateBurst, 20, 'commandRateBurst', 1),
    pairingTtlMs: integer(input.pairingTtlMs, 10 * GAME_MINUTE_MS, 'pairingTtlMs', 1000),
    schedulerPollMs: integer(input.schedulerPollMs, 1000, 'schedulerPollMs', 10),
    schedulerEnabled: input.schedulerEnabled ?? true,
    logLevel: input.logLevel ?? (env.QQPET_SYNC_LOG_LEVEL as ServerConfig['logLevel'] | undefined) ?? 'info',
  }
}

export const DEFAULT_GAME_START_MS = Date.UTC(2026, 0, 1)
