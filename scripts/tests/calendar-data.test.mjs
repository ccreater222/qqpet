import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

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
const {
  HOLIDAY_DATA_YEARS,
  MAX_CALENDAR_DAYS,
  computeCalendarDays,
  holidayOf,
  lunarDateText,
  solarTerm,
} = await import('../../src/shared/calendar-data.ts')

// The locally computed calendar must stand on its own: desktop local mode and qqpet-server both
// use it when no upstream is configured. Every value below was checked against the Hong Kong
// Observatory Gregorian/Lunar tables (T2025c/T2026c/T2027c), which publish Beijing-time lunar
// dates and solar terms.

/** Noon in Beijing on a YYYY-MM-DD date, so the day is unambiguous in any host time zone. */
const noonCst = (date) => new Date(date + 'T04:00:00.000Z')

test('31 days from 2026-11-19 lock the documented lunar date and stay consecutive', () => {
  const days = computeCalendarDays('2026-11-19', 31)
  assert.equal(MAX_CALENDAR_DAYS, 31)
  assert.equal(days.length, 31)
  assert.deepEqual(days[0], { date: '2026-11-19', lunar: '十月十一', term: null, holiday: null })
  assert.equal(days[30].date, '2026-12-19')
  assert.equal(days[30].lunar, '十一月十一')
  assert.equal(new Set(days.map((day) => day.date)).size, 31)
  for (let index = 1; index < days.length; index++) {
    assert.equal(Date.parse(days[index].date) - Date.parse(days[index - 1].date), 86_400_000, days[index].date)
    assert.equal(typeof days[index].lunar, 'string')
    assert.notEqual(days[index].lunar, '')
  }
  assert.deepEqual(
    days.filter((day) => day.term !== null),
    [
      { date: '2026-11-22', lunar: '十月十四', term: '小雪', holiday: null },
      { date: '2026-12-07', lunar: '十月廿九', term: '大雪', holiday: null },
    ],
  )
})

test('lunar dates match the published calendar, including a leap month', () => {
  const anchors = {
    '2025-01-29': '正月初一',
    '2025-02-28': '二月初一',
    '2025-07-24': '六月三十',
    '2025-07-25': '闰六月初一',
    '2025-07-26': '闰六月初二',
    '2025-08-23': '七月初一',
    '2025-12-20': '十一月初一',
    '2026-02-17': '正月初一',
    '2026-09-25': '八月十五',
    '2026-10-10': '九月初一',
    '2026-11-19': '十月十一',
    '2026-12-08': '十月三十',
    '2026-12-09': '十一月初一',
    '2027-01-15': '腊月初八',
    '2027-02-05': '腊月廿九',
    '2027-02-06': '正月初一',
    '2027-02-07': '正月初二',
    '2027-03-07': '正月三十',
    '2027-03-08': '二月初一',
  }
  for (const [date, lunar] of Object.entries(anchors)) {
    assert.equal(computeCalendarDays(date, 1)[0].lunar, lunar, date)
    assert.equal(lunarDateText(noonCst(date)), lunar, date)
  }
  // The leap month is day 1 of 闰六月, not a repeat of 六月.
  assert.equal(computeCalendarDays('2025-06-25', 1)[0].lunar, '六月初一')
})

test('the 24 solar terms of 2026 fall on the published days and nowhere else', () => {
  const terms2026 = {
    '2026-01-05': '小寒', '2026-01-20': '大寒', '2026-02-04': '立春', '2026-02-18': '雨水',
    '2026-03-05': '惊蛰', '2026-03-20': '春分', '2026-04-05': '清明', '2026-04-20': '谷雨',
    '2026-05-05': '立夏', '2026-05-21': '小满', '2026-06-05': '芒种', '2026-06-21': '夏至',
    '2026-07-07': '小暑', '2026-07-23': '大暑', '2026-08-07': '立秋', '2026-08-23': '处暑',
    '2026-09-07': '白露', '2026-09-23': '秋分', '2026-10-08': '寒露', '2026-10-23': '霜降',
    '2026-11-07': '立冬', '2026-11-22': '小雪', '2026-12-07': '大雪', '2026-12-22': '冬至',
  }
  const seen = new Map()
  for (let month = 1; month <= 12; month++) {
    const label = `2026-${String(month).padStart(2, '0')}-01`
    const count = new Date(Date.UTC(2026, month, 0)).getUTCDate()
    for (const day of computeCalendarDays(label, count)) if (day.term !== null) seen.set(day.date, day.term)
  }
  assert.deepEqual(Object.fromEntries(seen), terms2026)
  for (const [date, term] of Object.entries(terms2026)) assert.equal(solarTerm(noonCst(date)), term, date)
})

test('terms published in different years stay on their day, including the 2027 shift', () => {
  // 2025 立春 is Feb 3, 2027 雨水 Feb 19 and 2027 立夏 May 6: a year-blind "day is fixed" rule gets these wrong.
  assert.equal(solarTerm(noonCst('2025-02-03')), '立春')
  assert.equal(solarTerm(noonCst('2025-12-21')), '冬至')
  assert.equal(solarTerm(noonCst('2027-02-19')), '雨水')
  assert.equal(solarTerm(noonCst('2027-05-06')), '立夏')
  assert.equal(solarTerm(noonCst('2027-08-23')), '处暑')
  assert.equal(solarTerm(noonCst('2027-12-22')), '冬至')
  // Neither the day before nor the day after reports the term.
  assert.equal(solarTerm(noonCst('2025-02-02')), null)
  assert.equal(solarTerm(noonCst('2025-02-04')), null)
  assert.equal(solarTerm(noonCst('2027-02-18')), null)
  assert.equal(solarTerm(noonCst('2027-05-05')), null)
})

test('a term turns over at Beijing midnight, not at the host clock', () => {
  // 2026 立冬 is 2026-11-07 17:51 CST; 2026 冬至 is 2026-12-22 04:49 CST; 2027 立冬 23:38 CST.
  assert.equal(solarTerm(new Date('2026-11-06T15:59:59.000Z')), null) // 11-06 23:59:59 CST
  assert.equal(solarTerm(new Date('2026-11-06T16:00:00.000Z')), '立冬') // 11-07 00:00 CST
  assert.equal(solarTerm(new Date('2026-11-07T15:59:59.000Z')), '立冬') // 11-07 23:59:59 CST
  assert.equal(solarTerm(new Date('2026-11-07T16:00:00.000Z')), null) // 11-08 00:00 CST
  assert.equal(solarTerm(new Date('2026-12-21T15:59:59.000Z')), null) // 12-21 23:59:59 CST
  assert.equal(solarTerm(new Date('2026-12-21T16:00:00.000Z')), '冬至') // 12-22 04:49 CST falls that day
  assert.equal(solarTerm(new Date('2027-11-07T15:00:00.000Z')), '立冬') // 11-07 23:00 CST
  assert.equal(solarTerm(new Date('2027-11-07T16:00:00.000Z')), null) // 11-08 00:00 CST
})

test('holidays, make-up working days and years without data', () => {
  assert.deepEqual([...HOLIDAY_DATA_YEARS], [2025, 2026, 2027])
  assert.deepEqual(holidayOf('2025-01-01'), { name: '元旦', off: true })
  assert.deepEqual(holidayOf('2025-01-26'), { name: '春节', off: false })
  assert.deepEqual(holidayOf('2025-10-01'), { name: '国庆节、中秋节', off: true })
  assert.deepEqual(holidayOf('2026-02-16'), { name: '春节', off: true })
  assert.deepEqual(holidayOf('2026-10-01'), { name: '国庆节', off: true })
  assert.deepEqual(holidayOf('2026-10-10'), { name: '国庆节', off: false })
  assert.deepEqual(holidayOf('2027-02-06'), { name: '春节', off: true })
  assert.deepEqual(holidayOf('2027-01-31'), { name: '春节', off: false })

  // Outside the table a day is ordinary, never an error and never a guess (2028 is not covered).
  assert.equal(holidayOf('2028-10-01'), null)
  assert.equal(holidayOf('2030-01-01'), null)
  assert.equal(holidayOf('not-a-date'), null)
  const uncovered = computeCalendarDays('2028-09-30', 3)
  assert.deepEqual(uncovered.map((day) => day.holiday), [null, null, null])
  assert.equal(uncovered.every((day) => day.lunar !== ''), true)

  // Callers may keep or mutate the object: every lookup returns its own copy.
  const holiday = holidayOf('2026-10-01')
  holiday.off = false
  assert.deepEqual(holidayOf('2026-10-01'), { name: '国庆节', off: true })

  const window = computeCalendarDays('2026-09-30', 4)
  assert.deepEqual(window.map((day) => day.holiday?.off ?? null), [null, true, true, true])
})

test('month, year and leap-day boundaries roll over correctly', () => {
  assert.deepEqual(
    computeCalendarDays('2026-12-28', 6).map((day) => day.date),
    ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
  )
  assert.deepEqual(computeCalendarDays('2026-12-31', 2)[1].holiday, { name: '元旦', off: true })
  assert.deepEqual(
    computeCalendarDays('2028-02-28', 3).map((day) => day.date),
    ['2028-02-28', '2028-02-29', '2028-03-01'],
  )
  assert.notEqual(computeCalendarDays('2028-02-29', 1)[0].lunar, '')
  assert.deepEqual(
    computeCalendarDays('2027-02-28', 2).map((day) => day.date),
    ['2027-02-28', '2027-03-01'],
  )
})

test('the calendar day does not depend on the host time zone', () => {
  const original = process.env.TZ
  try {
    for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Tokyo']) {
      process.env.TZ = zone
      assert.equal(computeCalendarDays('2026-11-19', 31)[0].lunar, '十月十一', zone)
      assert.equal(lunarDateText(new Date('2026-11-19T04:00:00.000Z')), '十月十一', zone)
      assert.equal(solarTerm(new Date('2026-11-06T16:00:00.000Z')), '立冬', zone)
      assert.equal(solarTerm(new Date('2026-11-06T15:59:59.000Z')), null, zone)
      assert.deepEqual(holidayOf('2026-10-01'), { name: '国庆节', off: true }, zone)
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('malformed dates, ranges and day counts are rejected', () => {
  for (const bad of ['2026-13-01', '2026-00-10', '2026-02-30', '2027-02-29', '2026-1-1', '26-01-01', '', ' 2026-01-01', '2026-01-01 ', '20260101', null, undefined, 20260101]) {
    assert.throws(() => computeCalendarDays(bad, 1), RangeError, String(bad))
  }
  for (const days of [0, -1, 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '31', null]) {
    assert.throws(() => computeCalendarDays('2026-01-01', days), RangeError, String(days))
  }
  assert.throws(() => lunarDateText(new Date('nope')), RangeError)
  assert.throws(() => lunarDateText(null), RangeError)
  assert.throws(() => solarTerm(new Date(Number.NaN)), RangeError)
  assert.equal(computeCalendarDays('2026-01-01', 1).length, 1)
  // A valid date outside the term table still works: no term, never a throw.
  const ancient = computeCalendarDays('1899-06-01', 7)
  assert.equal(ancient.length, 7)
  assert.equal(ancient.every((day) => day.term === null), true)
  assert.equal(ancient.every((day) => day.lunar !== ''), true)
})

test('the module carries its holiday and lunar sources and licences', () => {
  const source = readFileSync(new URL('../../src/shared/calendar-data.ts', import.meta.url), 'utf8')
  const lunar = readFileSync(new URL('../../src/shared/lunar.ts', import.meta.url), 'utf8')
  assert.match(source, /NateScarlet\/holiday-cn/)
  assert.match(source, /MIT/)
  assert.match(lunar, /solarlunar/)
  assert.match(lunar, /ISC/)
  assert.equal(/from\s+'electron'/.test(source), false)
  assert.equal(/from\s+'electron'/.test(lunar), false)
})
