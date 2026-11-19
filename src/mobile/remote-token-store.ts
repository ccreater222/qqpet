// Android RemoteTokenStore: a Keystore-wrapped device token plus two plain
// non-secret state files. Tokens never touch readStateFile/writeAtomic and the
// token file name is deliberately absent from the native state allowlist; the
// only secret path is saveRemoteToken/loadRemoteToken/clearRemoteToken.
import { decodeEncodedReadResult } from '../shared/local-repository/storage'
import { assertRemoteServerUrl } from '../shared/remote/endpoint'
import type { RemoteSyncConfig, RemoteTokenStore } from '../shared/remote/repository'
import type { RemoteProjectionCacheV2 } from '../shared/sync/portable'
import { validateRemoteProjectionCacheV2 } from '../shared/sync/portable'

/** Non-secret sync metadata (serverUrl/petId/deviceId/cursor). */
export const MOBILE_SYNC_CONFIG_FILE = 'sync-config.json'
/** RemoteProjectionCacheV2, validated on every read and write. */
export const MOBILE_REMOTE_PROJECTION_CACHE_FILE = 'remote-projection-cache.json'

/**
 * The subset of `window.QQPetNative` this store needs. Token methods are
 * optional at the type level so an old shell fails closed at construction with
 * an explicit capability error instead of silently keeping the token in memory.
 */
export interface MobileRemoteTokenNative {
  /** Encoded discriminated result: {"status":"ok","text":string|null} or {"status":"error","error":string}. */
  readStateFile(name: string): string
  /** Writes an allowlisted state file atomically; false means the write failed. */
  writeAtomic(name: string, text: string): boolean
  /** Idempotent allowlisted removal; absent on shells without the server-mode update. */
  removeStateFile?(name: string): boolean
  /** Keystore AES/GCM sealing; false means encryption or the atomic write failed. */
  saveRemoteToken?(token: string): boolean
  /** Encoded result: {"status":"ok","text":string|null} or {"status":"error","error":string}. */
  loadRemoteToken?(): string
  clearRemoteToken?(): boolean
}

/** Host implementation of the shared RemoteTokenStore seam. */
export interface MobileRemoteTokenStore extends RemoteTokenStore {
  loadToken(): Promise<string | null>
  saveToken(token: string): Promise<void>
  loadConfig(): Promise<RemoteSyncConfig | null>
  saveConfig(config: RemoteSyncConfig): Promise<void>
  loadProjectionCache(): Promise<RemoteProjectionCacheV2 | null>
  saveProjectionCache(cache: RemoteProjectionCacheV2): Promise<void>
  clearProjectionCache(): Promise<void>
  clear(): Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validates persisted sync metadata. Every field is required: a config without
 * a server URL, pet id, device id or cursor cannot drive a RemoteRepository.
 */
export function parseMobileSyncConfig(value: unknown): RemoteSyncConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.serverUrl !== 'string' || record.serverUrl.length === 0) return null
  if (typeof record.petId !== 'string' || record.petId.length === 0) return null
  if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) return null
  if (isNonNegativeSafeInteger(record.lastRevision) === false) return null
  if (isNonNegativeSafeInteger(record.lastEventSeq) === false) return null
  try {
    assertRemoteServerUrl(record.serverUrl)
  } catch {
    return null
  }
  return {
    serverUrl: record.serverUrl,
    petId: record.petId,
    deviceId: record.deviceId,
    lastRevision: record.lastRevision,
    lastEventSeq: record.lastEventSeq,
  }
}

/** Decodes the token reply without ever treating a malformed reply as a missing token. */
export function parseMobileRemoteTokenReply(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('remote_token_read_failed: native loadRemoteToken returned no result')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('remote_token_read_failed: native loadRemoteToken returned invalid JSON')
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) {
    const record = parsed as Record<string, unknown>
    if (record.status === 'error' && typeof record.error === 'string') {
      throw new Error('remote_token_read_failed: ' + record.error)
    }
    if (record.status === 'ok' && (record.text === null || typeof record.text === 'string')) {
      return record.text
    }
  }
  throw new Error('remote_token_read_failed: native loadRemoteToken returned an invalid result payload')
}

/**
 * Builds the Android token store. Construction fails closed when the shell lacks
 * any secret or removal method; the returned store then owns all four files.
 */
export function createMobileRemoteTokenStore(native: MobileRemoteTokenNative): MobileRemoteTokenStore {
  const saveRemoteToken = native.saveRemoteToken?.bind(native)
  const loadRemoteToken = native.loadRemoteToken?.bind(native)
  const clearRemoteToken = native.clearRemoteToken?.bind(native)
  const removeStateFile = native.removeStateFile?.bind(native)
  if (
    typeof saveRemoteToken !== 'function'
    || typeof loadRemoteToken !== 'function'
    || typeof clearRemoteToken !== 'function'
    || typeof removeStateFile !== 'function'
  ) {
    throw new Error('native_server_mode_capability_missing: saveRemoteToken/loadRemoteToken/clearRemoteToken/removeStateFile are required')
  }

  const readText = (name: string): string | null => {
    const result = decodeEncodedReadResult(native.readStateFile(name))
    if (result.status === 'error') throw new Error('state_read_failed: ' + name + ': ' + result.error)
    return result.text
  }

  const writeText = (name: string, text: string): void => {
    if (native.writeAtomic(name, text) !== true) throw new Error('state_write_failed: ' + name)
  }

  const removeFile = (name: string): void => {
    if (removeStateFile(name) !== true) throw new Error('state_remove_failed: ' + name)
  }

  const readJson = (name: string): unknown => {
    const text = readText(name)
    if (text === null) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('state_corrupt: ' + name + ' is not valid JSON')
    }
  }

  const discardProjectionCache = (): void => {
    try {
      removeFile(MOBILE_REMOTE_PROJECTION_CACHE_FILE)
    } catch {
      // A stale cache is never authoritative. Failing to remove it must not
      // stop the repository from starting without one.
    }
  }

  return {
    async loadToken() {
      return parseMobileRemoteTokenReply(loadRemoteToken())
    },

    async saveToken(token) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('invalid_payload: a device token must be a non-empty string')
      }
      if (saveRemoteToken(token) !== true) {
        throw new Error('remote_token_write_failed: the native Keystore could not persist the device token')
      }
    },

    async loadConfig() {
      const raw = readJson(MOBILE_SYNC_CONFIG_FILE)
      if (raw === null) return null
      const config = parseMobileSyncConfig(raw)
      if (config === null) throw new Error('state_corrupt: ' + MOBILE_SYNC_CONFIG_FILE + ' is not a valid sync config')
      return config
    },

    async saveConfig(config) {
      const parsed = parseMobileSyncConfig(config)
      if (parsed === null) throw new Error('invalid_payload: refusing to persist an invalid sync config')
      writeText(MOBILE_SYNC_CONFIG_FILE, JSON.stringify(parsed))
    },

    async loadProjectionCache() {
      let raw: unknown
      try {
        raw = readJson(MOBILE_REMOTE_PROJECTION_CACHE_FILE)
      } catch {
        // Corrupt JSON is discarded, exactly like a cache that fails validation.
        discardProjectionCache()
        return null
      }
      if (raw === null) return null
      if (validateRemoteProjectionCacheV2(raw) === false) {
        discardProjectionCache()
        return null
      }
      return raw
    },

    async saveProjectionCache(cache) {
      if (validateRemoteProjectionCacheV2(cache) === false) {
        throw new Error('invalid_payload: refusing to persist an invalid remote projection cache')
      }
      writeText(MOBILE_REMOTE_PROJECTION_CACHE_FILE, JSON.stringify(cache))
    },

    async clearProjectionCache() {
      removeFile(MOBILE_REMOTE_PROJECTION_CACHE_FILE)
    },

    async clear() {
      let failure: Error | null = null
      for (const name of [MOBILE_SYNC_CONFIG_FILE, MOBILE_REMOTE_PROJECTION_CACHE_FILE]) {
        try {
          removeFile(name)
        } catch (error) {
          failure ??= new Error('unpair_failed: ' + messageOf(error))
        }
      }
      try {
        if (clearRemoteToken() !== true) {
          throw new Error('the native Keystore could not remove the device token')
        }
      } catch (error) {
        failure ??= new Error('unpair_failed: ' + messageOf(error))
      }
      if (failure !== null) throw failure
    },
  }
}
