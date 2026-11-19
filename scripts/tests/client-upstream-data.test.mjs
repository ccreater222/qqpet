import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// src/shared modules import each other without extensions (bundler resolution); resolve those
// the same way the other shared-layer tests do before the modules are loaded.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\/src\/shared\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const { calendar } = await import('../../src/shared/calendar.ts')
const { computeCalendarDays } = await import('../../src/shared/calendar-data.ts')
const { UPSTREAM_NOT_CONFIGURED } = await import('../../src/shared/upstream.ts')
const { latestRelease } = await import('../../src/shared/update.ts')
const { filterWeatherHours, normalizeWeatherReply, weather } = await import('../../src/shared/weather.ts')

// The three client data modules over a fake fetch: what they ask qqpet-server for, what they do
// with the reply, and that no upstream means an explicit failure (or local computation) rather
// than a request to a third party.

const SLOTS = ['0', '300', '600', '900', '1200', '1500', '1800', '2100']

/** A wttr.in format=j1 reply: numbers as strings, times as "0" … "2100". */
function wttrReply(patch = {}) {
  return {
    current_condition: [{ weatherCode: '116' }],
    weather: [
      {
        maxtempC: '21', mintempC: '9',
        hourly: SLOTS.map((time, index) => ({ time, weatherCode: String(100 + index), windspeedKmph: String(index * 4) })),
      },
      { maxtempC: '18', mintempC: '7', hourly: [] },
    ],
    ...patch,
  }
}

function localYmd(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

function fakeFetch(body, log = [], status = 200) {
  return async (url) => {
    log.push(url)
    if (typeof body === 'function') return body(url)
    if (status !== 200) return new Response(JSON.stringify(body), { status })
    return Response.json(body)
  }
}

function rejectsWith(code) {
  return (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error.message, code)
    return true
  }
}

test('normalizeWeatherReply keeps every 3-hourly slot, numbers parsed', () => {
  const parsed = normalizeWeatherReply(wttrReply())
  assert.equal(parsed.code, 116)
  assert.equal(parsed.max, 21)
  assert.equal(parsed.min, 9)
  assert.equal(parsed.tomorrowMax, 18)
  assert.deepEqual(parsed.hours.map((slot) => slot.hour), [0, 3, 6, 9, 12, 15, 18, 21])
  assert.deepEqual(parsed.hours[3], { hour: 9, code: 103, wind: 12 })
})

test('normalizeWeatherReply refuses a malformed upstream reply', () => {
  const malformed = [
    null,
    'not json',
    {},
    { current_condition: [], weather: [] },
    { current_condition: [{}], weather: [{ hourly: [] }, {}] },
    wttrReply({ current_condition: [{ weatherCode: 'fine' }] }),
    { ...wttrReply(), weather: [{ maxtempC: '21', mintempC: '9', hourly: [{ time: '2500', weatherCode: '1', windspeedKmph: '1' }] }, { maxtempC: '18' }] },
    { current_condition: [{ weatherCode: '1' }], weather: [{ maxtempC: 'x', mintempC: '9', hourly: [{ time: '0', weatherCode: '1', windspeedKmph: '1' }] }, { maxtempC: '1' }] },
  ]
  for (const reply of malformed) assert.throws(() => normalizeWeatherReply(reply), /weather_invalid/)
})

test('filterWeatherHours keeps the current slot and the ones after it', () => {
  const full = normalizeWeatherReply(wttrReply())
  assert.deepEqual(filterWeatherHours(full, 0).hours.map((slot) => slot.hour), [0, 3, 6, 9, 12, 15, 18, 21])
  assert.deepEqual(filterWeatherHours(full, 2).hours.map((slot) => slot.hour), [0, 3, 6, 9, 12, 15, 18, 21])
  assert.deepEqual(filterWeatherHours(full, 15).hours.map((slot) => slot.hour), [15, 18, 21])
  assert.deepEqual(filterWeatherHours(full, 16).hours.map((slot) => slot.hour), [15, 18, 21])
  assert.deepEqual(filterWeatherHours(full, 21).hours.map((slot) => slot.hour), [21])
  assert.deepEqual(filterWeatherHours(full, 23).hours.map((slot) => slot.hour), [21])
  assert.equal(full.hours.length, 8)
  assert.equal(filterWeatherHours(full, 12).max, full.max)
  for (const hour of [-1, 24, 1.5, Number.NaN]) {
    assert.throws(() => filterWeatherHours(full, hour), RangeError, String(hour))
  }
})

test('weather() asks the upstream once and trims the slots to the local clock', async () => {
  const log = []
  const city = '北京'
  const expectedUrl = 'https://pet.example.com/v1/client/weather?city=' + encodeURIComponent(city)
  const hour = new Date().getHours()
  const parsed = await weather(fakeFetch(wttrReply(), log), 'https://pet.example.com', city)
  assert.deepEqual(log, [expectedUrl])
  assert.deepEqual(parsed.hours.map((slot) => slot.hour), [0, 3, 6, 9, 12, 15, 18, 21].filter((slot) => slot + 3 > hour))
  assert.equal(parsed.code, 116)
})

test('weather() needs an upstream and passes the server error through', async () => {
  let calls = 0
  const countingFetch = async () => {
    calls++
    return Response.json(wttrReply())
  }
  for (const base of [null, undefined, '']) {
    await assert.rejects(() => weather(countingFetch, base, '北京'), rejectsWith(UPSTREAM_NOT_CONFIGURED), String(base))
  }
  assert.equal(calls, 0)
  await assert.rejects(
    () => weather(fakeFetch({ ok: false, error: 'weather_upstream_failed' }, [], 502), 'https://pet.example.com', ''),
    (error) => {
      assert.match(error.message, /^502/)
      return true
    },
  )
  // A paired sync address is accepted too, and turned into its https origin.
  const syncLog = []
  const viaSyncUrl = await weather(fakeFetch(wttrReply(), syncLog), 'wss://pet.example.com/v1/sync', '')
  assert.deepEqual(syncLog, ['https://pet.example.com/v1/client/weather?city='])
  assert.equal(viaSyncUrl.max, 21)
})

test('latestRelease reads {version, url} from the upstream', async () => {
  const log = []
  const body = { version: '0.8.2', url: 'https://github.com/TinyBrian/qqPet/releases/tag/v0.8.2' }
  assert.deepEqual(await latestRelease(fakeFetch(body, log), 'https://pet.example.com'), body)
  assert.deepEqual(log, ['https://pet.example.com/v1/client/release'])
  assert.deepEqual(
    await latestRelease(() => Response.json({ version: 'v0.9.0', url: 'https://example.com/v0.9.0' }), 'https://pet.example.com/'),
    { version: '0.9.0', url: 'https://example.com/v0.9.0' },
  )

  let calls = 0
  const countingFetch = async () => {
    calls++
    return Response.json(body)
  }
  for (const base of [null, undefined, '']) {
    await assert.rejects(() => latestRelease(countingFetch, base), rejectsWith(UPSTREAM_NOT_CONFIGURED), String(base))
  }
  assert.equal(calls, 0)
  for (const reply of [{}, { version: '', url: 'https://example.com' }, { version: '1.0.0', url: '/relative' }, { version: 1, url: 'https://example.com' }]) {
    await assert.rejects(() => latestRelease(() => Response.json(reply), 'https://pet.example.com'), /release_invalid/)
  }
  await assert.rejects(
    () => latestRelease(() => new Response('boom', { status: 503 }), 'https://pet.example.com'),
    (error) => {
      assert.match(error.message, /^503/)
      return true
    },
  )
})

test('calendar() computes locally when there is no upstream', async () => {
  let calls = 0
  const days = await calendar(async () => {
    calls++
    return Response.json([])
  }, undefined)
  const today = localYmd(new Date())
  assert.equal(calls, 0)
  assert.deepEqual(days, computeCalendarDays(today, 31))
  assert.equal(days.length, 31)
  assert.equal(days[0].date, today)
})

test('calendar() makes one ranged GET when an upstream is configured', async () => {
  const base = 'https://calendar-a.example.com'
  const today = localYmd(new Date())
  const body = computeCalendarDays(today, 31)
  const log = []
  const days = await calendar(fakeFetch(body, log), base)
  assert.deepEqual(log, [`${base}/v1/client/calendar?from=${today}&days=31`])
  assert.deepEqual(days, body)
  const again = await calendar(fakeFetch(body, log), base)
  assert.equal(log.length, 1, 'cached per date and upstream')
  assert.deepEqual(again, body)
})

test('calendar() stays empty on a failing or malformed upstream and retries', async () => {
  const failingBase = 'https://calendar-b.example.com'
  let calls = 0
  const failing = async () => {
    calls++
    return new Response('boom', { status: 503 })
  }
  assert.deepEqual(await calendar(failing, failingBase), [])
  assert.deepEqual(await calendar(failing, failingBase), [])
  assert.equal(calls, 2)

  const malformedBase = 'https://calendar-c.example.com'
  const malformed = async () => Response.json([{ date: '2026-11-19' }])
  assert.deepEqual(await calendar(malformed, malformedBase), [])
  assert.deepEqual(await calendar(() => Response.json([]), 'https://calendar-d.example.com'), [])
})
