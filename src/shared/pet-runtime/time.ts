/** One canonical game minute. Wall time is only a scheduler input. */
export const GAME_MINUTE_MS = 60_000
export const FIXED_TICK_MS = GAME_MINUTE_MS
export const DAY_MS = 86_400_000
export const GAME_DAY_BOUNDARY_HOUR = 6

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/
const formatters = new Map<string, Intl.DateTimeFormat>()

/** A clock supplied by the host. Rule code never reads ambient wall time. */
export interface RuntimeClock {
  nowMs(): number
}

export interface CalendarDateParts {
  year: number
  month: number
  day: number
}

export interface ZonedDateTimeParts extends CalendarDateParts {
  hour: number
  minute: number
  second: number
}

export interface DailyBoundary {
  dayKey: string
  boundaryMs: number
}

function fail(message: string): never {
  throw new Error(message)
}

export function assertEpochMs(value: number, name = 'epochMs'): void {
  if (Number.isSafeInteger(value) === false) fail(name + ' must be a safe integer millisecond timestamp')
}

function assertIntegerInRange(value: number, min: number, max: number, name: string): void {
  if (Number.isSafeInteger(value) === false || value < min || value > max) {
    fail(name + ' must be an integer between ' + min + ' and ' + max)
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || timeZone.length === 0) fail('timeZone must be a non-empty IANA name')
  const cached = formatters.get(timeZone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatter.format(0)
  } catch {
    fail('invalid IANA timeZone: ' + timeZone)
  }
  formatters.set(timeZone, formatter)
  return formatter
}

/** Validates an IANA timezone through the platform calendar database. */
export function assertTimeZone(timeZone: string): void {
  formatterFor(timeZone)
}

export function parseDayKey(dayKey: string): CalendarDateParts {
  const match = DAY_KEY.exec(dayKey)
  if (match === null) fail('dayKey must use YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1000) fail('dayKey year must be four digits')
  assertIntegerInRange(month, 1, 12, 'dayKey month')
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    fail('dayKey must name a valid Gregorian date')
  }
  return { year, month, day }
}

export function formatDayKey(parts: CalendarDateParts): string {
  return String(parts.year).padStart(4, '0') + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0')
}

/** Calendar-day arithmetic independent of the host process timezone. */
export function addDaysToDayKey(dayKey: string, days: number): string {
  if (Number.isSafeInteger(days) === false) fail('days must be a safe integer')
  const parts = parseDayKey(dayKey)
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return formatDayKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() })
}

export function isDayKey(value: string): boolean {
  try {
    parseDayKey(value)
    return true
  } catch {
    return false
  }
}

/** Local wall-clock components for an explicit instant and IANA timezone. */
export function zonedDateTimeParts(epochMs: number, timeZone: string): ZonedDateTimeParts {
  assertEpochMs(epochMs)
  const values: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(epochMs)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' ||
        part.type === 'minute' || part.type === 'second') {
      values[part.type] = Number(part.value)
    }
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour % 24,
    minute: values.minute,
    second: values.second,
  }
}

function wallOrdinal(parts: ZonedDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000
  return wallOrdinal(zonedDateTimeParts(wholeSecond, timeZone)) - wholeSecond
}

/** True when two wall-clock component tuples name the same local minute. */
function sameWallSecond(a: ZonedDateTimeParts, b: ZonedDateTimeParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second
}

/**
 * Converts a local wall-clock time in an IANA zone to the earliest matching
 * instant. A nonexistent wall time resolves forward to the first valid instant.
 */
export function zonedTimeToEpochMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): number {
  formatterFor(timeZone)
  assertIntegerInRange(year, 1000, 9999, 'year')
  assertIntegerInRange(month, 1, 12, 'month')
  assertIntegerInRange(day, 1, 31, 'day')
  assertIntegerInRange(hour, 0, 23, 'hour')
  assertIntegerInRange(minute, 0, 59, 'minute')
  assertIntegerInRange(second, 0, 59, 'second')
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const wanted: ZonedDateTimeParts = { year, month, day, hour, minute, second }
  const offsets = [
    timeZoneOffsetMs(wallMs - 36 * 3_600_000, timeZone),
    timeZoneOffsetMs(wallMs, timeZone),
    timeZoneOffsetMs(wallMs + 36 * 3_600_000, timeZone),
  ].filter((offset, index, all) => all.indexOf(offset) === index)
  const candidates = offsets.map(offset => wallMs - offset).sort((a, b) => a - b)
  const matches = candidates.filter(candidate => sameWallSecond(zonedDateTimeParts(candidate, timeZone), wanted))
  if (matches.length > 0) return matches[0]

  let low = candidates[0]
  let high = candidates[candidates.length - 1]
  if (wallOrdinal(zonedDateTimeParts(low, timeZone)) >= wallMs) return low
  while (wallOrdinal(zonedDateTimeParts(high, timeZone)) < wallMs) high += 3_600_000
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (wallOrdinal(zonedDateTimeParts(middle, timeZone)) >= wallMs) high = middle
    else low = middle + 1
  }
  return low
}

/** The 06:00 game-day boundary instant for a local calendar date. */
export function dailyBoundaryMs(dayKey: string, timeZone: string, boundaryHour = GAME_DAY_BOUNDARY_HOUR): number {
  const parts = parseDayKey(dayKey)
  return zonedTimeToEpochMs(timeZone, parts.year, parts.month, parts.day, boundaryHour, 0, 0)
}

/**
 * The game-day key containing `epochMs`: the local date of the most recent
 * 06:00 boundary at or before that instant. Boundaries are monotonic even
 * through repeated local hours.
 */
export function dayKeyAt(epochMs: number, timeZone: string, boundaryHour = GAME_DAY_BOUNDARY_HOUR): string {
  assertEpochMs(epochMs)
  assertIntegerInRange(boundaryHour, 0, 23, 'boundaryHour')
  const local = zonedDateTimeParts(epochMs, timeZone)
  const anchor = formatDayKey(local)
  let bestKey = addDaysToDayKey(anchor, -1)
  let bestMs = Number.NEGATIVE_INFINITY
  for (let offset = -2; offset <= 1; offset++) {
    const key = addDaysToDayKey(anchor, offset)
    const candidate = dailyBoundaryMs(key, timeZone, boundaryHour)
    if (candidate <= epochMs && (candidate > bestMs || (candidate === bestMs && key > bestKey))) {
      bestKey = key
      bestMs = candidate
    }
  }
  return bestKey
}

/** The next 06:00 boundary strictly after `epochMs`. */
export function nextDailyBoundaryMs(epochMs: number, timeZone: string, boundaryHour = GAME_DAY_BOUNDARY_HOUR): number {
  return nextDailyBoundary(epochMs, timeZone, boundaryHour).boundaryMs
}

export function nextDailyBoundary(epochMs: number, timeZone: string, boundaryHour = GAME_DAY_BOUNDARY_HOUR): DailyBoundary {
  assertEpochMs(epochMs)
  assertIntegerInRange(boundaryHour, 0, 23, 'boundaryHour')
  const anchor = formatDayKey(zonedDateTimeParts(epochMs, timeZone))
  let best: DailyBoundary | null = null
  for (let offset = 0; offset <= 2; offset++) {
    const dayKey = addDaysToDayKey(anchor, offset)
    const boundaryMs = dailyBoundaryMs(dayKey, timeZone, boundaryHour)
    if (boundaryMs > epochMs && (best === null || boundaryMs < best.boundaryMs)) best = { dayKey, boundaryMs }
  }
  if (best === null) fail('could not find the next daily boundary')
  return best
}

/**
 * Timezone-change metadata update: the current day key is marked processed
 * without running its daily transitions, and the next boundary is recomputed.
 */
export function reconcileTimeZone(
  gameTimeMs: number,
  timeZone: string,
): { lastProcessedDayBoundaryKey: string; nextDailyBoundaryMs: number } {
  assertTimeZone(timeZone)
  return {
    lastProcessedDayBoundaryKey: dayKeyAt(gameTimeMs, timeZone),
    nextDailyBoundaryMs: nextDailyBoundaryMs(gameTimeMs, timeZone),
  }
}

export function addFixedTicks(gameTimeMs: number, ticks = 1): number {
  return advanceFixedTicks(gameTimeMs, ticks)
}

export function advanceFixedTicks(gameTimeMs: number, ticks = 1): number {
  assertEpochMs(gameTimeMs, 'gameTimeMs')
  if (Number.isSafeInteger(ticks) === false || ticks < 0) fail('ticks must be a non-negative safe integer')
  const next = gameTimeMs + ticks * FIXED_TICK_MS
  assertEpochMs(next, 'advanced gameTimeMs')
  return next
}

export function wholeFixedTicksBetween(fromMs: number, toMs: number): number {
  assertEpochMs(fromMs, 'fromMs')
  assertEpochMs(toMs, 'toMs')
  return Math.max(0, Math.floor((toMs - fromMs) / FIXED_TICK_MS))
}

export function floorToFixedTick(gameTimeMs: number): number {
  assertEpochMs(gameTimeMs, 'gameTimeMs')
  return Math.floor(gameTimeMs / FIXED_TICK_MS) * FIXED_TICK_MS
}

/** The number of whole canonical ticks due between two persisted scheduler anchors. */
export function dueFixedTicks(lastSchedulerWallMs: number, wallNowMs: number): number {
  return wholeFixedTicksBetween(lastSchedulerWallMs, wallNowMs)
}

/** Reads a host-injected clock and validates its value. */
export function readClockMs(clock: RuntimeClock): number {
  const value = clock.nowMs()
  assertEpochMs(value, 'clock.nowMs()')
  return value
}
