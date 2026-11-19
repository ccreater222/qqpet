import { withTimeoutSignal } from './compat'
import type { CalendarDay, Fetch } from './ipc'
import { computeCalendarDays } from './calendar-data'
import { clientUrl } from './upstream'

const DAYS = 31

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function isCalendarDay(value: unknown): value is CalendarDay {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const day = value as Record<string, unknown>
  if (typeof day.date !== 'string' || /^\d{4}-\d{2}-\d{2}$/.test(day.date) === false) return false
  if (typeof day.lunar !== 'string' || day.lunar === '') return false
  if (day.term !== null && typeof day.term !== 'string') return false
  if (day.holiday === null) return true
  if (typeof day.holiday !== 'object' || Array.isArray(day.holiday)) return false
  const holiday = day.holiday as Record<string, unknown>
  return typeof holiday.name === 'string' && typeof holiday.off === 'boolean'
}

/** The upstream's reply, refused as a whole when any day is malformed. */
function parseDays(value: unknown): CalendarDay[] {
  if (Array.isArray(value) === false || value.length === 0) throw new Error('calendar_invalid')
  if (value.every((entry) => isCalendarDay(entry)) === false) throw new Error('calendar_invalid')
  return value as CalendarDay[]
}

async function load(fetch: Fetch, base: string | null | undefined, date: string): Promise<CalendarDay[]> {
  if (base === null || base === undefined || base === '') return computeCalendarDays(date, DAYS)
  // One ranged GET: the local-mode 31-request fan-out is gone.
  const url = clientUrl(base, `/v1/client/calendar?from=${date}&days=${DAYS}`)
  return withTimeoutSignal(15_000, async (signal) => {
    // The day's tasks and mail wait for this; a stalled network must not hold them back.
    const response = await fetch(url, { signal })
    if (response.ok === false) throw new Error(`${response.status} ${(await response.text()).slice(0, 100)}`)
    return parseDays(await response.json())
  })
}

let cache: { key: string; days: Promise<CalendarDay[]> } | null = null

/**
 * Today and the next 30 days, fetched once per date and upstream: one ranged GET from
 * qqpet-server when `base` is configured, local computation (`computeCalendarDays`) otherwise.
 * Empty while the upstream fails; the next call retries.
 */
export function calendar(fetch: Fetch, base?: string | null): Promise<CalendarDay[]> {
  const date = ymd(new Date())
  const key = (base ?? '') + '|' + date
  if (cache?.key !== key) {
    const days = load(fetch, base, date).catch(() => {
      if (cache?.key === key) cache = null
      return []
    })
    cache = { key, days }
  }
  return cache.days
}
