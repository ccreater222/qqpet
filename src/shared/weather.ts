import { withTimeoutSignal } from './compat'
import type { Fetch, Weather } from './ipc'
import { clientUrl } from './upstream'

// wttr.in's `format=j1` reply, which qqpet-server proxies for the client: numbers come as
// strings and each day's `time` as "0", "300" … "2100". Only a few fields are read, so the
// reply is walked as untyped JSON and every value is validated on the way in.

const INVALID = 'weather_invalid'

function numeric(value: unknown, field: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (Number.isFinite(parsed) === false) throw new Error(INVALID + ': ' + field + ' is not a number')
  return parsed
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(INVALID + ': ' + field + ' is not an object')
  }
  return value as Record<string, unknown>
}

/**
 * Turns a wttr.in `format=j1` reply into the shared `Weather`, keeping every 3-hourly slot
 * of today (`filterWeatherHours` narrows them for display). Throws `weather_invalid` for a
 * malformed reply; qqpet-server maps that to its upstream-failure status and the client
 * never shows invented weather.
 */
export function normalizeWeatherReply(reply: unknown): Weather {
  const root = record(reply, 'reply')
  const current = root.current_condition
  const days = root.weather
  if (Array.isArray(current) === false || current.length === 0) throw new Error(INVALID + ': current_condition')
  if (Array.isArray(days) === false || days.length < 2) throw new Error(INVALID + ': weather')
  const now = record(current[0], 'current_condition[0]')
  const today = record(days[0], 'weather[0]')
  const tomorrow = record(days[1], 'weather[1]')
  const hourly = today.hourly
  if (Array.isArray(hourly) === false || hourly.length === 0) throw new Error(INVALID + ': weather[0].hourly')
  const hours = hourly.map((slot, index) => {
    const entry = record(slot, 'weather[0].hourly[' + index + ']')
    const hour = numeric(entry.time, 'time') / 100
    if (Number.isInteger(hour) === false || hour < 0 || hour > 23) throw new Error(INVALID + ': time')
    return {
      hour,
      code: numeric(entry.weatherCode, 'weatherCode'),
      wind: numeric(entry.windspeedKmph, 'windspeedKmph'),
    }
  })
  return {
    code: numeric(now.weatherCode, 'current_condition[0].weatherCode'),
    max: numeric(today.maxtempC, 'weather[0].maxtempC'),
    min: numeric(today.mintempC, 'weather[0].mintempC'),
    tomorrowMax: numeric(tomorrow.maxtempC, 'weather[1].maxtempC'),
    hours,
  }
}

/**
 * The slots that are not fully past `hourOfDay` (0-23, the viewer's local clock), e.g. at 15:00
 * the 15:00, 18:00 and 21:00 slots. The reply itself carries no time zone, so the caller decides
 * which clock applies: the client's `weather()` uses the local hour, qqpet-server keeps all slots.
 */
export function filterWeatherHours(weather: Weather, hourOfDay: number): Weather {
  if (Number.isInteger(hourOfDay) === false || hourOfDay < 0 || hourOfDay > 23) throw new RangeError('invalid_hour')
  return { ...weather, hours: weather.hours.filter((slot) => slot.hour + 3 > hourOfDay) }
}

/**
 * Today's weather from qqpet-server's `/v1/client/weather`, an unresolved city located by the
 * upstream when `city` is empty. Rejects with `upstream_not_configured` when `base` is unusable
 * and with the server's error otherwise. Only the slots from the local current hour on are kept,
 * as the client has always displayed it; qqpet-server itself uses `normalizeWeatherReply`.
 */
export async function weather(fetch: Fetch, base: string | null | undefined, city: string): Promise<Weather> {
  const url = clientUrl(base, '/v1/client/weather?city=' + encodeURIComponent(city))
  return withTimeoutSignal(20_000, async (signal) => {
    const response = await fetch(url, { signal })
    if (response.ok === false) throw new Error(`${response.status} ${(await response.text()).slice(0, 100)}`)
    return filterWeatherHours(normalizeWeatherReply(await response.json()), new Date().getHours())
  })
}
