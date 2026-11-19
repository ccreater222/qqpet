import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServerConfig, type ServerConfigInput } from '../src/config.js'
import { initializePet, openDatabase } from '../src/db.js'
import { SyncServer, type SyncServerOptions } from '../src/index.js'

interface Harness {
  directory: string
  clientDataDir: string
  server: SyncServer
  base: string
  close(): Promise<void>
}

interface HarnessOptions {
  config?: ServerConfigInput
  server?: SyncServerOptions
}

async function createHarness(t: test.TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'qqpet-client-data-'))
  const dbPath = join(directory, 'qqpet.sqlite')
  const clientDataDir = join(directory, 'client-data')
  const config = createServerConfig({
    bind: '127.0.0.1',
    port: 0,
    dbPath,
    clientDataDir,
    adminSocket: join(directory, 'admin.sock'),
    schedulerEnabled: false,
    weatherCacheMs: 0,
    ...options.config,
  })
  const store = openDatabase(dbPath)
  initializePet(store, {
    petId: 'default',
    timeZone: 'Asia/Shanghai',
    // A non-empty canonical city proves the weather endpoint ignores pet settings.
    weatherCity: '北京',
    nowMs: Date.UTC(2026, 10, 19, 4, 0, 0),
  })
  const server = new SyncServer(config, store, options.server)
  await server.start()
  const address = server.address()
  const harness: Harness = {
    directory,
    clientDataDir,
    server,
    base: 'http://127.0.0.1:' + address.port,
    async close() {
      await server.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
  t.after(() => harness.close())
  return harness
}

const WttrReply = {
  current_condition: [{ weatherCode: '113' }],
  weather: [
    {
      maxtempC: '18',
      mintempC: '6',
      hourly: Array.from({ length: 8 }, (_, index) => ({
        time: String(index * 300),
        weatherCode: '113',
        windspeedKmph: '7',
      })),
    },
    { maxtempC: '20' },
  ],
}

interface MockUpstream {
  base: string
  requests: string[]
  setStatus(status: number): void
  setDelay(ms: number): void
  setBody(body: string | null): void
  close(): Promise<void>
}

async function mockUpstream(t: test.TestContext): Promise<MockUpstream> {
  const requests: string[] = []
  let status = 200
  let delayMs = 0
  let body: string | null = null
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url ?? '')
    const send = (): void => {
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'text/plain' })
        response.end('upstream exploded')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body ?? JSON.stringify(WttrReply))
    }
    if (delayMs > 0) setTimeout(send, delayMs)
    else send()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  const mock: MockUpstream = {
    base: 'http://127.0.0.1:' + port,
    requests,
    setStatus(value: number) {
      status = value
    },
    setDelay(value: number) {
      delayMs = value
    },
    setBody(value: string | null) {
      body = value
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
  t.after(() => mock.close())
  return mock
}

async function writeClientFile(directory: string, name: string, body: string | Buffer): Promise<void> {
  await writeFile(join(directory, name), body)
}

test('client-data directory is created on startup', async t => {
  const harness = await createHarness(t)
  const info = await stat(harness.clientDataDir)
  assert.equal(info.isDirectory(), true)
})

test('GET /v1/client/release: missing, valid, and invalid files', async t => {
  const harness = await createHarness(t)

  const missing = await fetch(harness.base + '/v1/client/release')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { ok: false, error: 'release_unavailable' })

  await writeClientFile(harness.clientDataDir, 'release.json', '{ not json')
  const invalidJson = await fetch(harness.base + '/v1/client/release')
  assert.equal(invalidJson.status, 503)
  assert.deepEqual(await invalidJson.json(), { ok: false, error: 'release_invalid' })

  await writeClientFile(harness.clientDataDir, 'release.json', JSON.stringify({
    version: '0.8.2',
    url: 'https://github.com/TinyBrian/qqPet/releases/tag/v0.8.2',
  }))
  const valid = await fetch(harness.base + '/v1/client/release')
  assert.equal(valid.status, 200)
  assert.equal(valid.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(await valid.json(), {
    version: '0.8.2',
    url: 'https://github.com/TinyBrian/qqPet/releases/tag/v0.8.2',
  })

  await writeClientFile(harness.clientDataDir, 'release.json', JSON.stringify({ version: 'v0.8.3', url: 'https://example.com/v0.8.3' }))
  const stripped = await fetch(harness.base + '/v1/client/release')
  assert.equal(stripped.status, 200)
  assert.equal(((await stripped.json()) as { version: string }).version, '0.8.3')

  for (const body of [
    { version: '', url: 'https://example.com' },
    { version: '1.0.0', url: '/relative' },
    { version: '1.0.0', url: 'ftp://example.com/x' },
    { url: 'https://example.com' },
  ]) {
    await writeClientFile(harness.clientDataDir, 'release.json', JSON.stringify(body))
    const response = await fetch(harness.base + '/v1/client/release')
    assert.equal(response.status, 503, JSON.stringify(body))
    assert.deepEqual(await response.json(), { ok: false, error: 'release_invalid' })
  }
})

test('GET /v1/client/weather proxies wttr.in and caches per city', async t => {
  const upstream = await mockUpstream(t)
  const harness = await createHarness(t, {
    config: { weatherUpstream: upstream.base, weatherCacheMs: 600_000 },
  })

  const first = await fetch(harness.base + '/v1/client/weather?city=' + encodeURIComponent('北京'))
  assert.equal(first.status, 200)
  const weather = await first.json() as { code: number; max: number; min: number; tomorrowMax: number; hours: unknown[] }
  assert.equal(weather.code, 113)
  assert.equal(weather.max, 18)
  assert.equal(weather.min, 6)
  assert.equal(weather.tomorrowMax, 20)
  // The server must not filter by its own clock; clients trim the 8 slots themselves.
  assert.equal(weather.hours.length, 8)
  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0], '/' + encodeURIComponent('北京') + '?format=j1')

  const second = await fetch(harness.base + '/v1/client/weather?city=' + encodeURIComponent('北京'))
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), weather)
  assert.equal(upstream.requests.length, 1, 'cached city must not hit the upstream again')

  const other = await fetch(harness.base + '/v1/client/weather?city=上海')
  assert.equal(other.status, 200)
  assert.equal(upstream.requests.length, 2)
})

test('GET /v1/client/weather uses the upstream root for an empty city, never pet settings', async t => {
  const upstream = await mockUpstream(t)
  // The initialized pet carries weatherLocation 北京; an empty `city` must ignore it
  // and let the upstream locate this server's egress IP.
  const harness = await createHarness(t, { config: { weatherUpstream: upstream.base } })

  const response = await fetch(harness.base + '/v1/client/weather')
  assert.equal(response.status, 200)
  assert.equal(upstream.requests[0], '/?format=j1')
})

test('GET /v1/client/weather maps upstream failures and empty-city root requests', async t => {
  const upstream = await mockUpstream(t)
  const harness = await createHarness(t, {
    config: { weatherUpstream: upstream.base, weatherCacheMs: 0 },
  })

  upstream.setStatus(500)
  const failed = await fetch(harness.base + '/v1/client/weather?city=' + encodeURIComponent('北京'))
  assert.equal(failed.status, 502)
  assert.deepEqual(await failed.json(), { ok: false, error: 'weather_upstream_failed' })
  assert.doesNotMatch(await (await fetch(harness.base + '/v1/client/weather?city=' + encodeURIComponent('北京'))).text(), /upstream exploded/)

  const tooLong = await fetch(harness.base + '/v1/client/weather?city=' + 'x'.repeat(65))
  assert.equal(tooLong.status, 400)
  assert.deepEqual(await tooLong.json(), { ok: false, error: 'invalid_city' })

  // An empty city asks the upstream root; a failed location lookup is 503.
  const unavailable = await fetch(harness.base + '/v1/client/weather')
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { ok: false, error: 'weather_unavailable' })
  assert.equal(upstream.requests.at(-1), '/?format=j1')

  upstream.setStatus(200)
  const located = await fetch(harness.base + '/v1/client/weather')
  assert.equal(located.status, 200)
})

test('GET /v1/client/weather rejects oversized upstream bodies', async t => {
  const upstream = await mockUpstream(t)
  const harness = await createHarness(t, { config: { weatherUpstream: upstream.base } })
  upstream.setBody('{"padding":"' + 'x'.repeat(2 * 1024 * 1024) + '"}')

  const city = await fetch(harness.base + '/v1/client/weather?city=' + encodeURIComponent('北京'))
  assert.equal(city.status, 502)
  assert.deepEqual(await city.json(), { ok: false, error: 'weather_upstream_failed' })

  const root = await fetch(harness.base + '/v1/client/weather')
  assert.equal(root.status, 503)
  assert.deepEqual(await root.json(), { ok: false, error: 'weather_unavailable' })
})

test('GET /v1/client/weather coalesces concurrent requests for one city', async t => {
  const upstream = await mockUpstream(t)
  upstream.setDelay(200)
  const harness = await createHarness(t, { config: { weatherUpstream: upstream.base, weatherCacheMs: 600_000 } })
  const url = harness.base + '/v1/client/weather?city=' + encodeURIComponent('广州')

  const [first, second] = await Promise.all([fetch(url), fetch(url)])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(await first.json(), await second.json())
  assert.equal(upstream.requests.length, 1, 'concurrent requests must share one upstream call')
})

test('weather cache is bounded to 64 city entries', async t => {
  const upstream = await mockUpstream(t)
  const harness = await createHarness(t, { config: { weatherUpstream: upstream.base, weatherCacheMs: 600_000 } })

  for (let index = 0; index < 65; index++) {
    const response = await fetch(harness.base + '/v1/client/weather?city=city' + index)
    assert.equal(response.status, 200)
  }
  assert.equal(upstream.requests.length, 65)

  // city0 was evicted by city64; asking again must refetch instead of growing unboundedly.
  const evicted = await fetch(harness.base + '/v1/client/weather?city=city0')
  assert.equal(evicted.status, 200)
  assert.equal(upstream.requests.length, 66)
})

test('GET /v1/client/weather reports upstream timeouts as 504', async t => {
  const hanging: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
  const harness = await createHarness(t, {
    config: { weatherTimeoutMs: 1000 },
    server: { fetch: hanging },
  })

  const response = await fetch(harness.base + '/v1/client/weather?city=' + encodeURIComponent('北京'))
  assert.equal(response.status, 504)
  assert.deepEqual(await response.json(), { ok: false, error: 'weather_upstream_timeout' })
})

test('GET /v1/client/calendar computes 31 days and validates the range', async t => {
  const harness = await createHarness(t)

  const response = await fetch(harness.base + '/v1/client/calendar?from=2026-11-19&days=31')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  const days = await response.json() as { date: string; lunar: string; term: string | null; holiday: unknown }[]
  assert.equal(days.length, 31)
  assert.equal(days[0].date, '2026-11-19')
  assert.equal(days[0].lunar, '十月十一')
  assert.equal(days[30].date, '2026-12-19')
  for (const day of days) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(typeof day.lunar, 'string')
    assert.ok(day.term === null || typeof day.term === 'string')
    assert.ok(day.holiday === null || typeof day.holiday === 'object')
  }

  const week = await fetch(harness.base + '/v1/client/calendar?from=2026-11-19&days=7')
  assert.equal(((await week.json()) as unknown[]).length, 7)

  const defaults = await fetch(harness.base + '/v1/client/calendar')
  assert.equal(defaults.status, 200)
  assert.equal(((await defaults.json()) as unknown[]).length, 31)

  for (const query of [
    'from=2026-13-01',
    'from=2026-02-30',
    'from=yesterday',
    'from=2026-11-19&days=0',
    'from=2026-11-19&days=32',
    'from=2026-11-19&days=abc',
  ]) {
    const bad = await fetch(harness.base + '/v1/client/calendar?' + query)
    assert.equal(bad.status, 400, query)
    assert.deepEqual(await bad.json(), { ok: false, error: 'invalid_range' }, query)
  }
})

test('GET /v1/client/packs.json rewrites relative urls and rejects absolute ones', async t => {
  const harness = await createHarness(t)

  const missing = await fetch(harness.base + '/v1/client/packs.json')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { ok: false, error: 'packs_unavailable' })

  const entry = {
    id: 'core',
    version: '0.8.2',
    minShell: '0.6.8',
    name: 'QQPet-content-0.8.2.qqpetpack',
    url: 'QQPet-content-0.8.2.qqpetpack',
    size: 10,
    sha256: 'a'.repeat(64),
  }
  await writeClientFile(harness.clientDataDir, 'packs.json', JSON.stringify({ schema: 1, packs: [entry] }))
  const rewritten = await fetch(harness.base + '/v1/client/packs.json')
  assert.equal(rewritten.status, 200)
  const index = await rewritten.json() as { schema: number; packs: { url: string; name: string }[] }
  assert.equal(index.schema, 1)
  assert.equal(index.packs[0].name, 'QQPet-content-0.8.2.qqpetpack')
  assert.equal(index.packs[0].url, '/v1/client/packs/QQPet-content-0.8.2.qqpetpack')

  await writeClientFile(harness.clientDataDir, 'packs.json', JSON.stringify({
    schema: 1,
    packs: [{ ...entry, url: 'https://github.com/TinyBrian/qqPet/releases/download/v0.8.2/QQPet-content-0.8.2.qqpetpack' }],
  }))
  const absolute = await fetch(harness.base + '/v1/client/packs.json')
  assert.equal(absolute.status, 503)
  assert.deepEqual(await absolute.json(), { ok: false, error: 'packs_invalid' })

  for (const body of [
    { schema: 2, packs: [entry] },
    { schema: 1, packs: 'nope' },
    { schema: 1, packs: [{ ...entry, url: '../escape.qqpetpack' }] },
    { schema: 1, packs: [{ ...entry, url: 'dir/nested.qqpetpack' }] },
    { schema: 1, packs: [{ ...entry, name: '../escape.qqpetpack' }] },
    { schema: 1, packs: [{ ...entry, sha256: 'nope' }] },
  ]) {
    await writeClientFile(harness.clientDataDir, 'packs.json', JSON.stringify(body))
    const invalid = await fetch(harness.base + '/v1/client/packs.json')
    assert.equal(invalid.status, 503, JSON.stringify(body))
    assert.deepEqual(await invalid.json(), { ok: false, error: 'packs_invalid' })
  }
})

test('GET /v1/client/packs/<name> streams bytes, exposes ETag and honours If-None-Match', async t => {
  const harness = await createHarness(t)
  const bytes = Buffer.from('QQPet content pack fixture\n'.repeat(64))
  const name = 'QQPet-content-0.8.2.qqpetpack'
  await writeClientFile(harness.clientDataDir, name, bytes)

  const response = await fetch(harness.base + '/v1/client/packs/' + name)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('content-length'), String(bytes.length))
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  const etag = response.headers.get('etag')
  assert.ok(etag !== null && etag.startsWith('"') && etag.endsWith('"'))
  const body = Buffer.from(await response.arrayBuffer())
  assert.equal(body.length, bytes.length)
  assert.equal(createHash('sha256').update(body).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(body, bytes)

  const cached = await fetch(harness.base + '/v1/client/packs/' + name, { headers: { 'if-none-match': etag } })
  assert.equal(cached.status, 304)
  assert.equal(await cached.text(), '')

  const stale = await fetch(harness.base + '/v1/client/packs/' + name, { headers: { 'if-none-match': '"stale"' } })
  assert.equal(stale.status, 200)

  const missing = await fetch(harness.base + '/v1/client/packs/missing.qqpetpack')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { ok: false, error: 'pack_not_found' })
})

test('GET /v1/client/packs/<name> rejects traversal and non-pack names', async t => {
  const harness = await createHarness(t)
  for (const path of [
    '/v1/client/packs/..%2Fescape.qqpetpack',
    '/v1/client/packs/%2e%2e%2Fescape.qqpetpack',
    '/v1/client/packs/%2e%2e%5Cescape.qqpetpack',
    '/v1/client/packs/%2Fetc%2Fpasswd',
    '/v1/client/packs/notes.txt',
    '/v1/client/packs/.hidden.qqpetpack',
    '/v1/client/packs/%E4%B8%AD%E6%96%87.qqpetpack',
  ]) {
    const response = await fetch(harness.base + path, { redirect: 'manual' })
    assert.ok(
      response.status === 400 || response.status === 404,
      path + ' must be rejected, got ' + response.status,
    )
  }

  const traversal = await fetch(harness.base + '/v1/client/packs/..%2Fescape.qqpetpack')
  assert.equal(traversal.status, 400)
  assert.deepEqual(await traversal.json(), { ok: false, error: 'invalid_pack_name' })
})

test('client routes are GET-only and unknown paths are 404', async t => {
  const harness = await createHarness(t)

  for (const path of ['/v1/client/release', '/v1/client/weather', '/v1/client/calendar', '/v1/client/packs.json']) {
    const response = await fetch(harness.base + path, { method: 'POST' })
    assert.equal(response.status, 405, path)
    assert.equal(response.headers.get('allow'), 'GET')
  }

  const unknown = await fetch(harness.base + '/v1/client/unknown')
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { ok: false, error: 'not_found' })
})

test('client data config validates absolute paths, upstream URLs and integers', () => {
  const base = createServerConfig({ dbPath: '/tmp/qqpet-config/qqpet.sqlite', backupDir: '/tmp/qqpet-config/backups' }, {})
  assert.equal(base.clientDataDir, '/tmp/qqpet-config/client-data')
  assert.equal(base.weatherUpstream, 'https://wttr.in')
  assert.equal(base.weatherTimeoutMs, 10_000)
  assert.equal(base.weatherCacheMs, 600_000)

  assert.equal(
    createServerConfig({ clientDataDir: '/var/lib/qqpet-sync/client-data' }, {}).clientDataDir,
    '/var/lib/qqpet-sync/client-data',
  )
  assert.equal(
    createServerConfig({ weatherUpstream: 'http://127.0.0.1:9999/path/' }, {}).weatherUpstream,
    'http://127.0.0.1:9999/path',
  )
  assert.equal(createServerConfig({ weatherCacheMs: 0 }, {}).weatherCacheMs, 0)

  assert.throws(() => createServerConfig({ clientDataDir: 'relative/dir' }, {}), /QQPET_SYNC_CLIENT_DATA_DIR must be an absolute path/)
  assert.throws(() => createServerConfig({ weatherUpstream: 'wttr.in' }, {}), /QQPET_SYNC_WEATHER_UPSTREAM must be an absolute http\(s\) URL/)
  assert.throws(() => createServerConfig({ weatherUpstream: 'ftp://wttr.in' }, {}), /QQPET_SYNC_WEATHER_UPSTREAM must be an absolute http\(s\) URL/)
  assert.throws(() => createServerConfig({ weatherTimeoutMs: 999 }, {}), /weatherTimeoutMs must be an integer between 1000 and 60000/)
  assert.throws(() => createServerConfig({ weatherCacheMs: 3_600_001 }, {}), /weatherCacheMs must be an integer between 0 and 3600000/)
  assert.equal(createServerConfig({}, { QQPET_SYNC_CLIENT_DATA_DIR: '/srv/qqpet/client-data' }).clientDataDir, '/srv/qqpet/client-data')
  assert.equal(createServerConfig({}, { QQPET_SYNC_WEATHER_UPSTREAM: 'https://weather.example.com' }).weatherUpstream, 'https://weather.example.com')
  assert.equal(createServerConfig({}, { QQPET_SYNC_WEATHER_TIMEOUT_MS: '3000' }).weatherTimeoutMs, 3000)
  assert.equal(createServerConfig({}, { QQPET_SYNC_WEATHER_CACHE_MS: '0' }).weatherCacheMs, 0)
})
