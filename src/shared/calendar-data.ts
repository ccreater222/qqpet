// The Chinese calendar a day carries: lunar date, solar term and statutory holiday.
//
// Pure functions plus built-in data, shared by the desktop calendar (local mode, no upstream)
// and qqpet-server's `GET /v1/client/calendar`, so both produce the same `CalendarDay[]`.
// No network, no Node/Electron APIs.
//
// Statutory holidays and make-up working days for 2025-2027 come from
// https://github.com/NateScarlet/holiday-cn (MIT), files 2025.json / 2026.json / 2027.json,
// which transcribe the State Council notices. Refresh this table every year: a date outside
// those years is returned with `holiday: null` (never an error, and never a guess).
//
// Solar terms use the standard low-precision apparent-sun algorithm (Meeus, Astronomical
// Algorithms ch. 25) evaluated in Beijing time, which is how Chinese calendars publish them.
// The 24 term dates for 2025, 2026 and 2027 match the Hong Kong Observatory tables exactly;
// the algorithm is good for 1900-2100, and years outside that range report no term.
//
// Known deviation: ICU's lunar model moves a month start when the new moon falls within a few
// minutes of Beijing midnight, and it names the 12th month 腊月 (the traditional tables and
// src/renderer/pet/data/greet.ts both use that name, so it is kept). Across 2025-2027 every
// lunar day matches the HKO tables except the 2027 正月: its new moon is 2027-02-06 23:57 CST
// and Intl starts the month on 2027-02-07, one day after the published calendar. Correcting
// that would mean replacing this Intl conversion with an own new-moon model.

import type { CalendarDay } from './ipc'

/** The longest range `computeCalendarDays` serves; mirrors the /v1/client/calendar contract. */
export const MAX_CALENDAR_DAYS = 31

const DAY_MS = 86_400_000
/** Lunar dates and solar terms are published in Beijing time (no DST since 1991). */
const CHINA_OFFSET_MS = 8 * 3_600_000

const YEAR_YMD = /^(\d{4})-(\d{2})-(\d{2})$/

interface HolidayEntry {
  name: string
  off: boolean
}

/** Years covered by the built-in holiday table; a release must extend this yearly. */
export const HOLIDAY_DATA_YEARS = [2025, 2026, 2027] as const

const HOLIDAY_DAYS: Readonly<Record<string, HolidayEntry>> = {
  '2025-01-01': { name: '元旦', off: true },
  '2025-01-26': { name: '春节', off: false },
  '2025-01-28': { name: '春节', off: true },
  '2025-01-29': { name: '春节', off: true },
  '2025-01-30': { name: '春节', off: true },
  '2025-01-31': { name: '春节', off: true },
  '2025-02-01': { name: '春节', off: true },
  '2025-02-02': { name: '春节', off: true },
  '2025-02-03': { name: '春节', off: true },
  '2025-02-04': { name: '春节', off: true },
  '2025-02-08': { name: '春节', off: false },
  '2025-04-04': { name: '清明节', off: true },
  '2025-04-05': { name: '清明节', off: true },
  '2025-04-06': { name: '清明节', off: true },
  '2025-04-27': { name: '劳动节', off: false },
  '2025-05-01': { name: '劳动节', off: true },
  '2025-05-02': { name: '劳动节', off: true },
  '2025-05-03': { name: '劳动节', off: true },
  '2025-05-04': { name: '劳动节', off: true },
  '2025-05-05': { name: '劳动节', off: true },
  '2025-05-31': { name: '端午节', off: true },
  '2025-06-01': { name: '端午节', off: true },
  '2025-06-02': { name: '端午节', off: true },
  '2025-09-28': { name: '国庆节、中秋节', off: false },
  '2025-10-01': { name: '国庆节、中秋节', off: true },
  '2025-10-02': { name: '国庆节、中秋节', off: true },
  '2025-10-03': { name: '国庆节、中秋节', off: true },
  '2025-10-04': { name: '国庆节、中秋节', off: true },
  '2025-10-05': { name: '国庆节、中秋节', off: true },
  '2025-10-06': { name: '国庆节、中秋节', off: true },
  '2025-10-07': { name: '国庆节、中秋节', off: true },
  '2025-10-08': { name: '国庆节、中秋节', off: true },
  '2025-10-11': { name: '国庆节、中秋节', off: false },
  '2026-01-01': { name: '元旦', off: true },
  '2026-01-02': { name: '元旦', off: true },
  '2026-01-03': { name: '元旦', off: true },
  '2026-01-04': { name: '元旦', off: false },
  '2026-02-14': { name: '春节', off: false },
  '2026-02-15': { name: '春节', off: true },
  '2026-02-16': { name: '春节', off: true },
  '2026-02-17': { name: '春节', off: true },
  '2026-02-18': { name: '春节', off: true },
  '2026-02-19': { name: '春节', off: true },
  '2026-02-20': { name: '春节', off: true },
  '2026-02-21': { name: '春节', off: true },
  '2026-02-22': { name: '春节', off: true },
  '2026-02-23': { name: '春节', off: true },
  '2026-02-28': { name: '春节', off: false },
  '2026-04-04': { name: '清明节', off: true },
  '2026-04-05': { name: '清明节', off: true },
  '2026-04-06': { name: '清明节', off: true },
  '2026-05-01': { name: '劳动节', off: true },
  '2026-05-02': { name: '劳动节', off: true },
  '2026-05-03': { name: '劳动节', off: true },
  '2026-05-04': { name: '劳动节', off: true },
  '2026-05-05': { name: '劳动节', off: true },
  '2026-05-09': { name: '劳动节', off: false },
  '2026-06-19': { name: '端午节', off: true },
  '2026-06-20': { name: '端午节', off: true },
  '2026-06-21': { name: '端午节', off: true },
  '2026-09-20': { name: '国庆节', off: false },
  '2026-09-25': { name: '中秋节', off: true },
  '2026-09-26': { name: '中秋节', off: true },
  '2026-09-27': { name: '中秋节', off: true },
  '2026-10-01': { name: '国庆节', off: true },
  '2026-10-02': { name: '国庆节', off: true },
  '2026-10-03': { name: '国庆节', off: true },
  '2026-10-04': { name: '国庆节', off: true },
  '2026-10-05': { name: '国庆节', off: true },
  '2026-10-06': { name: '国庆节', off: true },
  '2026-10-07': { name: '国庆节', off: true },
  '2026-10-10': { name: '国庆节', off: false },
  '2027-01-01': { name: '元旦', off: true },
  '2027-01-02': { name: '元旦', off: true },
  '2027-01-03': { name: '元旦', off: true },
  '2027-01-31': { name: '春节', off: false },
  '2027-02-05': { name: '春节', off: true },
  '2027-02-06': { name: '春节', off: true },
  '2027-02-07': { name: '春节', off: true },
  '2027-02-08': { name: '春节', off: true },
  '2027-02-09': { name: '春节', off: true },
  '2027-02-10': { name: '春节', off: true },
  '2027-02-11': { name: '春节', off: true },
  '2027-02-12': { name: '春节', off: true },
  '2027-02-13': { name: '春节', off: true },
  '2027-02-14': { name: '春节', off: false },
  '2027-04-03': { name: '清明节', off: true },
  '2027-04-04': { name: '清明节', off: true },
  '2027-04-05': { name: '清明节', off: true },
  '2027-05-01': { name: '劳动节', off: true },
  '2027-05-02': { name: '劳动节', off: true },
  '2027-05-03': { name: '劳动节', off: true },
  '2027-05-04': { name: '劳动节', off: true },
  '2027-05-05': { name: '劳动节', off: true },
  '2027-05-08': { name: '劳动节', off: false },
  '2027-06-09': { name: '端午节', off: true },
  '2027-09-15': { name: '中秋节', off: true },
  '2027-09-26': { name: '国庆节', off: false },
  '2027-10-01': { name: '国庆节', off: true },
  '2027-10-02': { name: '国庆节', off: true },
  '2027-10-03': { name: '国庆节', off: true },
  '2027-10-04': { name: '国庆节', off: true },
  '2027-10-05': { name: '国庆节', off: true },
  '2027-10-06': { name: '国庆节', off: true },
  '2027-10-07': { name: '国庆节', off: true },
  '2027-10-09': { name: '国庆节', off: false },
}

const HOLIDAY_INDEX = new Map<string, HolidayEntry>(Object.entries(HOLIDAY_DAYS))

/** The statutory holiday or make-up working day of a YYYY-MM-DD date; null outside the table. */
export function holidayOf(date: string): CalendarDay['holiday'] {
  const entry = HOLIDAY_INDEX.get(date)
  if (entry === undefined) return null
  return { name: entry.name, off: entry.off }
}

const LUNAR_FORMAT = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  month: 'long',
  day: 'numeric',
  timeZone: 'Asia/Shanghai',
})

/** 初一 … 三十, the day names Chinese calendars use (廿 not 二十). */
const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
] as const

/** 小寒 starts the term year at 285° of apparent solar longitude; each next term adds 15°. */
const FIRST_TERM_LONGITUDE = 285
const DEGREES_PER_DAY = 0.98564736
const J2000_JDN = 2451545
const UNIX_EPOCH_JDN = 2440587.5
const TERM_YEAR_MIN = 1900
const TERM_YEAR_MAX = 2100

/** MM-DD of one Gregorian year -> the solar term starting that day. */
const TERM_CACHE = new Map<number, Map<string, string>>()

function requireValidDate(date: Date): number {
  const instant = date instanceof Date ? date.getTime() : Number.NaN
  if (Number.isNaN(instant)) throw new RangeError('invalid_date')
  return instant
}

/** The apparent geocentric longitude of the sun in degrees [0, 360). */
function solarLongitude(julianDay: number): number {
  const century = (julianDay - J2000_JDN) / 36525
  const meanLongitude = 280.46646 + 36000.76983 * century + 0.0003032 * century * century
  const meanAnomaly = (357.52911 + 35999.05029 * century - 0.0001537 * century * century) * (Math.PI / 180)
  const equation = (1.914602 - 0.004817 * century - 0.000014 * century * century) * Math.sin(meanAnomaly)
    + (0.019993 - 0.000101 * century) * Math.sin(2 * meanAnomaly)
    + 0.000289 * Math.sin(3 * meanAnomaly)
  const nutation = (125.04 - 1934.136 * century) * (Math.PI / 180)
  const apparent = meanLongitude + equation - 0.00569 - 0.00478 * Math.sin(nutation)
  return ((apparent % 360) + 360) % 360
}

/** Julian day (UT) at which the given term of `year` starts. */
function termInstant(year: number, index: number): number {
  const target = (FIRST_TERM_LONGITUDE + 15 * index) % 360
  let julianDay = J2000_JDN + (year - 2000) * 365.2425 + index * 15.2 + 5
  for (let step = 0; step < 12; step++) {
    const delta = ((target - solarLongitude(julianDay) + 540) % 360) - 180
    julianDay += delta / DEGREES_PER_DAY
  }
  return julianDay
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function monthDayKey(date: Date): string {
  return pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
}

function termDaysOfYear(year: number): Map<string, string> {
  const cached = TERM_CACHE.get(year)
  if (cached !== undefined) return cached
  const days = new Map<string, string>()
  if (year >= TERM_YEAR_MIN && year <= TERM_YEAR_MAX) {
    for (let index = 0; index < TERM_NAMES.length; index++) {
      const china = new Date((termInstant(year, index) - UNIX_EPOCH_JDN) * DAY_MS + CHINA_OFFSET_MS)
      days.set(monthDayKey(china), TERM_NAMES[index])
    }
  }
  TERM_CACHE.set(year, days)
  return days
}

function lunarDayNumber(value: string): number {
  const numeric = Number(value)
  if (Number.isSafeInteger(numeric) && numeric >= 1) return numeric
  // Defensive: an ICU build that localizes the day to Chinese numerals still resolves by name.
  return LUNAR_DAY_NAMES.indexOf(value) + 1
}

/**
 * The lunar date of an instant's Beijing-time day, e.g. 十月十一 or 闰六月初一.
 * Throws a RangeError for an invalid Date (an unknown lunar day is a bug, not data).
 */
export function lunarDateText(date: Date): string {
  const parts = LUNAR_FORMAT.formatToParts(requireValidDate(date))
  let month = ''
  let day = 0
  for (const part of parts) {
    if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = lunarDayNumber(part.value)
  }
  const name: string | undefined = day >= 1 && day <= LUNAR_DAY_NAMES.length ? LUNAR_DAY_NAMES[day - 1] : undefined
  if (month === '' || name === undefined) throw new RangeError('invalid_lunar_date')
  return month + name
}

/** The solar term starting on an instant's Beijing-time day, e.g. 立冬; null for an ordinary day. */
export function solarTerm(date: Date): string | null {
  const china = new Date(requireValidDate(date) + CHINA_OFFSET_MS)
  return termDaysOfYear(china.getUTCFullYear()).get(monthDayKey(china)) ?? null
}

function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

function formatYmd(date: Date): string {
  return pad4(date.getUTCFullYear()) + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
}

/** UTC midnight of a calendar date; setUTCFullYear keeps years below 100 out of the 1900 quirk. */
function utcMidnight(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function parseYmd(from: string): number {
  const match = typeof from === 'string' ? YEAR_YMD.exec(from) : null
  if (match === null) throw new RangeError('invalid_range')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) throw new RangeError('invalid_range')
  const date = utcMidnight(year, month, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError('invalid_range')
  }
  return date.getTime()
}

/**
 * `days` consecutive CalendarDay entries starting at `from` (YYYY-MM-DD), today first.
 * Date arithmetic runs in UTC so the labels never depend on the host time zone; lunar dates
 * and solar terms are resolved for the Beijing-time day, as Chinese calendars publish them.
 * Throws a RangeError for a malformed/impossible date or a day count outside 1..31.
 */
export function computeCalendarDays(from: string, days: number): CalendarDay[] {
  const start = parseYmd(from)
  if (Number.isSafeInteger(days) === false || days < 1 || days > MAX_CALENDAR_DAYS) {
    throw new RangeError('invalid_range')
  }
  const result: CalendarDay[] = []
  for (let index = 0; index < days; index++) {
    const label = new Date(start + index * DAY_MS)
    const date = formatYmd(label)
    // 12:00 in Beijing, so neither the lunar date nor the term can fall on the neighbouring day.
    const noon = new Date(label.getTime() + 4 * 3_600_000)
    result.push({ date, lunar: lunarDateText(noon), term: solarTerm(noon), holiday: holidayOf(date) })
  }
  return result
}
