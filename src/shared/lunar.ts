// Lunar calendar conversion for 1900-2100.
//
// The month table and the year/month/day conversion are adapted from solarlunar 3.1.0
// (https://github.com/yize/solarlunar), ISC License:
//
// Copyright (c) 2015, yize
//
// Permission to use, copy, modify, and/or distribute this software for any purpose with or
// without fee is hereby granted, provided that the above copyright notice and this permission
// notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
// WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
// AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
// CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
// WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
// CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// The table encodes, for each lunar year, the leap month (low four bits), the 12 month
// lengths (0x8000 down to 0x10) and the leap month length (0x10000). Unlike ICU's Chinese
// calendar, this table follows the published Chinese calendar for 2027 正月 (2027-02-06 is
// 正月初一), which is the one known ICU boundary disagreement in 2025-2027.

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252,
  0x0d520,
] as const

const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '腊月'] as const
const DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
] as const

const MIN_YEAR = 1900
const MAX_YEAR = 2100
const DAY_MS = 86_400_000
const CHINA_OFFSET_MS = 8 * 3_600_000
const LUNAR_BASE_UTC = Date.UTC(1900, 0, 31)

function infoOf(year: number): number {
  if (year < MIN_YEAR || year > MAX_YEAR) throw new RangeError('lunar_year_out_of_range')
  return LUNAR_INFO[year - MIN_YEAR]
}

function leapMonth(year: number): number {
  return infoOf(year) & 0xf
}

function leapDays(year: number): number {
  if (leapMonth(year) === 0) return 0
  return infoOf(year) & 0x10000 ? 30 : 29
}

function monthDays(year: number, month: number): number {
  if (month < 1 || month > 12) throw new RangeError('invalid_lunar_month')
  return infoOf(year) & (0x10000 >> month) ? 30 : 29
}

function yearDays(year: number): number {
  let total = 348
  for (let mask = 0x8000; mask > 0x8; mask >>= 1) if (infoOf(year) & mask) total += 1
  return total + leapDays(year)
}

/** Gregorian date (Beijing calendar date) to lunar year/month/day. */
export function solarToLunar(year: number, month: number, day: number): { year: number; month: number; day: number; leap: boolean } {
  if (Number.isSafeInteger(year) === false || Number.isSafeInteger(month) === false || Number.isSafeInteger(day) === false) {
    throw new RangeError('invalid_solar_date')
  }
  if (year < MIN_YEAR || year > MAX_YEAR) throw new RangeError('lunar_year_out_of_range')
  const utc = Date.UTC(year, month - 1, day)
  const check = new Date(utc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError('invalid_solar_date')
  }
  let offset = Math.floor((utc - LUNAR_BASE_UTC) / DAY_MS)
  if (offset < 0) throw new RangeError('lunar_year_out_of_range')

  let lunarYear = MIN_YEAR
  let temp = 0
  for (; lunarYear <= MAX_YEAR && offset > 0; lunarYear++) {
    temp = yearDays(lunarYear)
    offset -= temp
  }
  if (offset < 0) {
    offset += temp
    lunarYear--
  }
  if (lunarYear > MAX_YEAR) throw new RangeError('lunar_year_out_of_range')

  const leap = leapMonth(lunarYear)
  let isLeap = false
  let lunarMonth = 1
  for (; lunarMonth < 13 && offset > 0; lunarMonth++) {
    if (leap > 0 && lunarMonth === leap + 1 && isLeap === false) {
      --lunarMonth
      isLeap = true
      temp = leapDays(lunarYear)
    } else {
      temp = monthDays(lunarYear, lunarMonth)
    }
    if (isLeap === true && lunarMonth === leap + 1) isLeap = false
    offset -= temp
  }
  if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
    if (isLeap) {
      isLeap = false
    } else {
      isLeap = true
      --lunarMonth
    }
  }
  if (offset < 0) {
    offset += temp
    --lunarMonth
  }
  return { year: lunarYear, month: lunarMonth, day: offset + 1, leap: isLeap }
}

// 1900-2100 is the table's range. The UI still accepts older dates for historical play, so
// those fall back to the platform Chinese calendar instead of rejecting the whole day.
const INTL_LUNAR = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  month: 'long',
  day: 'numeric',
  timeZone: 'Asia/Shanghai',
})

function intlLunarText(date: Date): string {
  let month = ''
  let day = 0
  for (const part of INTL_LUNAR.formatToParts(date)) {
    if (part.type === 'month') month = part.value
    else if (part.type === 'day') {
      day = Number(part.value)
      if (Number.isSafeInteger(day) === false) day = DAY_NAMES.indexOf(part.value as (typeof DAY_NAMES)[number]) + 1
    }
  }
  const name = DAY_NAMES[day - 1]
  if (month === '' || name === undefined) throw new RangeError('invalid_lunar_date')
  return month + name
}

/** The lunar date of a Beijing-time calendar day, e.g. 十月十一 or 闰六月初一. */
export function lunarDateText(date: Date): string {
  const instant = date instanceof Date ? date.getTime() : Number.NaN
  if (Number.isNaN(instant)) throw new RangeError('invalid_date')
  const china = new Date(instant + CHINA_OFFSET_MS)
  try {
    const lunar = solarToLunar(china.getUTCFullYear(), china.getUTCMonth() + 1, china.getUTCDate())
    const name = DAY_NAMES[lunar.day - 1]
    if (name === undefined) throw new RangeError('invalid_lunar_date')
    return (lunar.leap ? '闰' : '') + MONTH_NAMES[lunar.month - 1] + name
  } catch (error) {
    if (error instanceof RangeError && error.message === 'lunar_year_out_of_range') return intlLunarText(china)
    throw error
  }
}
