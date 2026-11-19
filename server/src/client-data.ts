import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { computeCalendarDays } from '../../src/shared/calendar-data.js'
import type { CalendarDay, Release, Weather } from '../../src/shared/ipc.js'
import { normalizeWeatherReply } from '../../src/shared/weather.js'
import type { ServerConfig } from './config.js'

/**
 * Client data upstream: the public read-only files and proxies the desktop/mobile
 * clients consume through `/v1/client/*`. It returns DTOs or error codes only;
 * `server/src/index.ts` owns the HTTP response and file streaming.
 */

export type ClientDataErrorCode =
  | 'release_invalid'
  | 'release_unavailable'
  | 'weather_upstream_failed'
  | 'weather_upstream_timeout'
  | 'weather_unavailable'
  | 'invalid_range'
  | 'invalid_city'
  | 'packs_invalid'
  | 'packs_unavailable'
  | 'invalid_pack_name'
  | 'pack_not_found'

export type ClientDataResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 502 | 503 | 504; error: ClientDataErrorCode }

/** One content pack entry with its `url` rewritten to the server's pack route. */
export interface ClientPackIndexEntry {
  id: string
  version: string
  base?: string
  minShell: string
  name: string
  url: string
  size: number
  sha256: string
}

export interface ClientPackIndex {
  schema: 1
  packs: ClientPackIndexEntry[]
}

/** A resolved pack file ready for streaming; the caller must not trust `path` beyond this object. */
export interface ClientPackFile {
  path: string
  name: string
  size: number
  etag: string
}

export interface ClientDataDeps {
  /** Network implementation for the weather proxy; defaults to the runtime `fetch`. */
  fetch?: typeof globalThis.fetch
  now?: () => number
}

/** Pack file names are a single path segment so `resolve` cannot leave `clientDataDir`. */
const PACK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.qqpetpack$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAYS = /^\d{1,3}$/
const MAX_CITY_LENGTH = 64
const CACHE_CONTROL_PACK = 'public, max-age=31536000, immutable'

interface CacheEntry {
  expiresAtMs: number
  value: Weather
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function localDate(nowMs: number): string {
  const date = new Date(nowMs)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function validDate(value: string): boolean {
  const match = DATE.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Non-cryptographic tag derived from size and mtime; enough for `If-None-Match` revalidation. */
function statEtag(size: number, mtimeMs: number): string {
  return '"' + size.toString(16) + '-' + Math.trunc(mtimeMs).toString(16) + '"'
}

/** Matches an `If-None-Match` header value against one strong ETag (weak tags compare equal). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some(candidate => {
    const value = candidate.trim()
    return value === '*' || value === etag || value === 'W/' + etag
  })
}

/** Weather responses are a small JSON document; refuse oversized upstream bodies instead of buffering them. */
const MAX_WEATHER_BODY_BYTES = 2 * 1024 * 1024
/** Cache entries are keyed by the requested city; bound it so a hostile caller cannot grow memory without limit. */
const MAX_WEATHER_CACHE_ENTRIES = 64

export class ClientDataService {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  private readonly weatherCache = new Map<string, CacheEntry>()
  private readonly weatherInFlight = new Map<string, Promise<ClientDataResult<Weather>>>()

  constructor(
    private readonly config: ServerConfig,
    deps: ClientDataDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch
    this.now = deps.now ?? Date.now
  }

  async release(): Promise<ClientDataResult<Release>> {
    let text: string
    try {
      text = await readFile(join(this.config.clientDataDir, 'release.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, status: 404, error: 'release_unavailable' }
      }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, status: 503, error: 'release_invalid' }
    }
    if (!isRecord(value) || typeof value.version !== 'string' || typeof value.url !== 'string') {
      return { ok: false, status: 503, error: 'release_invalid' }
    }
    const version = value.version.trim().replace(/^v/, '')
    if (version === '' || isHttpUrl(value.url) === false) {
      return { ok: false, status: 503, error: 'release_invalid' }
    }
    return { ok: true, value: { version, url: value.url } }
  }

  /**
   * Weather is a display-only proxy. An empty `city` deliberately does not read
   * pet settings: it asks the upstream root, which wttr.in resolves from this
   * server's egress IP. Concurrent requests for one city share a single upstream
   * call, and successful replies are cached for `weatherCacheMs` (bounded LRU).
   */
  weather(cityParam?: string): Promise<ClientDataResult<Weather>> {
    const city = (cityParam ?? '').trim()
    if (city.length > MAX_CITY_LENGTH) {
      return Promise.resolve({ ok: false, status: 400, error: 'invalid_city' })
    }
    const cached = this.cachedWeather(city)
    if (cached !== undefined) return Promise.resolve({ ok: true, value: cached })
    const inFlight = this.weatherInFlight.get(city)
    if (inFlight !== undefined) return inFlight
    const request = this.fetchWeather(city)
      .then(result => {
        if (result.ok) this.storeWeather(city, result.value)
        return result
      })
      .finally(() => {
        this.weatherInFlight.delete(city)
      })
    this.weatherInFlight.set(city, request)
    return request
  }

  calendar(from?: string, days?: string): ClientDataResult<CalendarDay[]> {
    const requested = (from ?? '').trim()
    const date = requested === '' ? localDate(this.now()) : requested
    if (validDate(date) === false) {
      return { ok: false, status: 400, error: 'invalid_range' }
    }
    const rawDays = (days ?? '').trim()
    let count = 31
    if (rawDays !== '') {
      if (DAYS.test(rawDays) === false) {
        return { ok: false, status: 400, error: 'invalid_range' }
      }
      count = Number(rawDays)
      if (count < 1 || count > 31) {
        return { ok: false, status: 400, error: 'invalid_range' }
      }
    }
    return { ok: true, value: computeCalendarDays(date, count) }
  }

  async packsIndex(): Promise<ClientDataResult<ClientPackIndex>> {
    let text: string
    try {
      text = await readFile(join(this.config.clientDataDir, 'packs.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, status: 404, error: 'packs_unavailable' }
      }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, status: 503, error: 'packs_invalid' }
    }
    const index = this.normalizePacksIndex(value)
    if (index === null) return { ok: false, status: 503, error: 'packs_invalid' }
    return { ok: true, value: index }
  }

  /**
   * Resolves a pack request to a servable file. Names are one path segment and
   * must stay under `clientDataDir`; anything else is rejected before touching disk.
   */
  async packFile(name: string): Promise<ClientDataResult<ClientPackFile>> {
    if (PACK_FILE.test(name) === false) {
      return { ok: false, status: 400, error: 'invalid_pack_name' }
    }
    const base = resolve(this.config.clientDataDir)
    const path = resolve(base, name)
    if (path !== join(base, name) || path.startsWith(base + sep) === false) {
      return { ok: false, status: 400, error: 'invalid_pack_name' }
    }
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, status: 404, error: 'pack_not_found' }
      }
      throw error
    }
    if (info.isFile() === false) {
      return { ok: false, status: 404, error: 'pack_not_found' }
    }
    return {
      ok: true,
      value: { path, name, size: info.size, etag: statEtag(info.size, info.mtimeMs) },
    }
  }

  /** Opens the pack stream; the HTTP layer pipes and destroys it on client abort. */
  createPackStream(pack: ClientPackFile): Readable {
    return createReadStream(pack.path)
  }

  get packCacheControl(): string {
    return CACHE_CONTROL_PACK
  }

  private cachedWeather(city: string): Weather | undefined {
    if (this.config.weatherCacheMs <= 0) return undefined
    const cached = this.weatherCache.get(city)
    if (cached === undefined) return undefined
    if (cached.expiresAtMs <= this.now()) {
      this.weatherCache.delete(city)
      return undefined
    }
    // Refresh recency so the eviction order stays LRU.
    this.weatherCache.delete(city)
    this.weatherCache.set(city, cached)
    return cached.value
  }

  private storeWeather(city: string, value: Weather): void {
    if (this.config.weatherCacheMs <= 0) return
    this.weatherCache.delete(city)
    this.weatherCache.set(city, { expiresAtMs: this.now() + this.config.weatherCacheMs, value })
    while (this.weatherCache.size > MAX_WEATHER_CACHE_ENTRIES) {
      const oldest = this.weatherCache.keys().next().value
      if (oldest === undefined) break
      this.weatherCache.delete(oldest)
    }
  }

  private normalizePacksIndex(value: unknown): ClientPackIndex | null {
    if (!isRecord(value) || value.schema !== 1 || Array.isArray(value.packs) === false) return null
    const packs: ClientPackIndexEntry[] = []
    for (const entry of value.packs as unknown[]) {
      if (!isRecord(entry)) return null
      const { id, version, minShell, name, url, size, sha256 } = entry
      if (typeof id !== 'string' || id === '') return null
      if (typeof version !== 'string' || version === '') return null
      if (typeof minShell !== 'string' || minShell === '') return null
      if (typeof name !== 'string' || PACK_FILE.test(name) === false) return null
      if (typeof url !== 'string' || this.relativePackUrl(url) === false) return null
      if (typeof size !== 'number' || Number.isSafeInteger(size) === false || size < 0) return null
      if (typeof sha256 !== 'string' || /^[0-9a-f]{64}$/.test(sha256) === false) return null
      const base = entry.base
      if (base !== undefined && (typeof base !== 'string' || base === '')) return null
      packs.push({
        id,
        version,
        ...(base === undefined ? {} : { base }),
        minShell,
        name,
        // Serve every pack from this server; the index's `url` is only a file name.
        url: '/v1/client/packs/' + encodeURIComponent(name),
        size,
        sha256,
      })
    }
    return { schema: 1, packs }
  }

  /** A pack `url` must be a bare relative file name; absolute URLs would send clients to third parties. */
  private relativePackUrl(url: string): boolean {
    if (url === '' || url.includes('/') || url.includes('\\') || url.includes('..')) return false
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return false
    return PACK_FILE.test(url)
  }

  private async fetchWeather(city: string): Promise<ClientDataResult<Weather>> {
    const url = this.config.weatherUpstream + '/' + encodeURIComponent(city) + '?format=j1'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.weatherTimeoutMs)
    timer.unref()
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (response.ok === false) {
        if (city === '') return { ok: false, status: 503, error: 'weather_unavailable' }
        return { ok: false, status: 502, error: 'weather_upstream_failed' }
      }
      const text = await this.readBodyText(response)
      if (text === null) {
        if (city === '') return { ok: false, status: 503, error: 'weather_unavailable' }
        return { ok: false, status: 502, error: 'weather_upstream_failed' }
      }
      let reply: unknown
      try {
        reply = JSON.parse(text)
      } catch {
        if (controller.signal.aborted) return { ok: false, status: 504, error: 'weather_upstream_timeout' }
        if (city === '') return { ok: false, status: 503, error: 'weather_unavailable' }
        return { ok: false, status: 502, error: 'weather_upstream_failed' }
      }
      let value: Weather
      try {
        value = normalizeWeatherReply(reply)
      } catch {
        if (city === '') return { ok: false, status: 503, error: 'weather_unavailable' }
        return { ok: false, status: 502, error: 'weather_upstream_failed' }
      }
      return { ok: true, value }
    } catch {
      if (controller.signal.aborted) return { ok: false, status: 504, error: 'weather_upstream_timeout' }
      if (city === '') return { ok: false, status: 503, error: 'weather_unavailable' }
      return { ok: false, status: 502, error: 'weather_upstream_failed' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Reads the upstream body with a hard byte cap. Returns null when the response
   * is larger than the cap so the caller maps it to the upstream-failure code.
   */
  private async readBodyText(response: Response): Promise<string | null> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > MAX_WEATHER_BODY_BYTES) return null
    }
    if (response.body === null) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_WEATHER_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
}
