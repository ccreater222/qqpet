import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWrite } from './atomic-write'
import {
  REMOTE_PROJECTION_CACHE_FORMAT,
  REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
  validateRemoteProjectionCacheV2,
  backfillRemoteProjectionCacheDefaults,
  type RemoteProjectionCacheV2,
} from '../shared/sync/portable'

/** File names are public so diagnostics and tests can locate the secret-free config. */
export const REMOTE_TOKEN_FILE = 'remote-token.bin'
export const REMOTE_SYNC_CONFIG_FILE = 'sync-config.json'
/** Server mode keeps its read-only projection cache on the historic save path. */
export const REMOTE_PROJECTION_CACHE_FILE = 'save.json'

/**
 * Narrow structural view of Electron safeStorage. Injecting it keeps this module
 * outside Electron in unit tests and makes "fail closed" explicit.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface PairingSyncConfig {
  serverUrl: string
  petId: string
  deviceId: string
  lastRevision: number
  lastEventSeq: number
}

export interface PairingStoreOptions {
  userDataPath: string
  safeStorage: SafeStorageLike
  tokenPath?: string
  configPath?: string
  projectionCachePath?: string
}

function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(name + ' must be a non-empty string')
  return value
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0) {
    throw new Error(name + ' must be a non-negative safe integer')
  }
  return value
}

function parseConfig(raw: unknown): PairingSyncConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('remote sync config must be an object')
  const record = raw as Record<string, unknown>
  return {
    serverUrl: requireNonEmpty(record.serverUrl, 'serverUrl'),
    petId: typeof record.petId === 'string' ? record.petId : '',
    deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
    lastRevision: requireNonNegativeInteger(record.lastRevision, 'lastRevision'),
    lastEventSeq: requireNonNegativeInteger(record.lastEventSeq, 'lastEventSeq'),
  }
}

/**
 * Desktop-only secret store. The long-lived device token is written through
 * Electron safeStorage; when encryption is unavailable the store fails closed
 * and never falls back to plaintext. Non-secret sync metadata lives separately.
 */
export class PairingStore {
  private readonly tokenPath: string
  private readonly configPath: string
  private readonly projectionCachePath: string
  private readonly safeStorage: SafeStorageLike

  constructor(options: PairingStoreOptions) {
    if (typeof options.userDataPath !== 'string' || options.userDataPath.length === 0) {
      throw new Error('PairingStore userDataPath is required')
    }
    if (options.safeStorage === undefined || options.safeStorage === null) {
      throw new Error('PairingStore safeStorage is required')
    }
    this.safeStorage = options.safeStorage
    this.tokenPath = options.tokenPath ?? join(options.userDataPath, REMOTE_TOKEN_FILE)
    this.configPath = options.configPath ?? join(options.userDataPath, REMOTE_SYNC_CONFIG_FILE)
    this.projectionCachePath = options.projectionCachePath ?? join(options.userDataPath, REMOTE_PROJECTION_CACHE_FILE)
  }

  get tokenFilePath(): string {
    return this.tokenPath
  }

  get configFilePath(): string {
    return this.configPath
  }

  get projectionCacheFilePath(): string {
    return this.projectionCachePath
  }

  private requireEncryption(operation: string): void {
    let available = false
    try {
      available = this.safeStorage.isEncryptionAvailable() === true
    } catch {
      available = false
    }
    if (available === false) throw new Error('safeStorage unavailable: refusing to ' + operation)
  }

  private ensureParent(file: string): void {
    const directory = dirname(file)
    if (existsSync(directory) === false) mkdirSync(directory, { recursive: true })
  }

  async saveToken(token: string): Promise<void> {
    const secret = requireNonEmpty(token, 'token')
    this.requireEncryption('persist a device token')
    const encrypted = this.safeStorage.encryptString(secret)
    if (Buffer.isBuffer(encrypted) === false) throw new Error('safeStorage encryptString did not return a Buffer')
    this.ensureParent(this.tokenPath)
    const temporary = this.tokenPath + '.tmp'
    writeFileSync(temporary, encrypted, { mode: 0o600 })
    renameSync(temporary, this.tokenPath)
  }

  async loadToken(): Promise<string | null> {
    if (existsSync(this.tokenPath) === false) return null
    this.requireEncryption('read a device token')
    const encrypted = readFileSync(this.tokenPath)
    try {
      return this.safeStorage.decryptString(encrypted)
    } catch (error) {
      throw new Error('unable to decrypt the stored device token: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  async saveConfig(config: PairingSyncConfig): Promise<void> {
    const safe = parseConfig({
      serverUrl: config.serverUrl,
      petId: config.petId ?? '',
      deviceId: config.deviceId ?? '',
      lastRevision: config.lastRevision,
      lastEventSeq: config.lastEventSeq,
    })
    this.ensureParent(this.configPath)
    atomicWrite(this.configPath, JSON.stringify(safe, null, 2))
  }

  async loadConfig(): Promise<PairingSyncConfig | null> {
    if (existsSync(this.configPath) === false) return null
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.configPath, 'utf8'))
    } catch (error) {
      throw new Error('remote sync config is corrupt: ' + (error instanceof Error ? error.message : String(error)))
    }
    return parseConfig(raw)
  }

  async saveProjectionCache(cache: RemoteProjectionCacheV2): Promise<void> {
    if (validateRemoteProjectionCacheV2(cache) === false) {
      throw new Error('remote projection cache is invalid')
    }
    if (cache.format !== REMOTE_PROJECTION_CACHE_FORMAT || cache.schemaVersion !== REMOTE_PROJECTION_CACHE_SCHEMA_VERSION) {
      throw new Error('remote projection cache version is unsupported')
    }
    this.ensureParent(this.projectionCachePath)
    atomicWrite(this.projectionCachePath, JSON.stringify(cache, null, 2))
  }

  async loadProjectionCache(): Promise<RemoteProjectionCacheV2 | null> {
    if (existsSync(this.projectionCachePath) === false) return null
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.projectionCachePath, 'utf8'))
    } catch {
      this.removeProjectionCache()
      return null
    }
    backfillRemoteProjectionCacheDefaults(raw)
    if (validateRemoteProjectionCacheV2(raw) === false || raw.authority.state === 'reset') {
      this.removeProjectionCache()
      return null
    }
    return raw
  }

  async clearProjectionCache(): Promise<void> {
    this.removeProjectionCache()
  }

  private removeProjectionCache(): void {
    if (existsSync(this.projectionCachePath)) unlinkSync(this.projectionCachePath)
  }

  async clear(): Promise<void> {
    for (const file of [this.tokenPath, this.configPath, this.projectionCachePath]) {
      if (existsSync(file) === false) continue
      unlinkSync(file)
    }
  }
}
