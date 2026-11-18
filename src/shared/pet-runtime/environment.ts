import { createRngState, randIntInclusive } from './rng'
import { assertEpochMs, parseDayKey } from './time'
import type { EnvironmentInputs, WeatherDayRecord, WeatherHour, WeatherProvenance } from './types'

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const WEATHER_CONDITIONS: readonly { condition: string; conditionCode: number }[] = [
  { condition: '晴', conditionCode: 113 },
  { condition: '多云', conditionCode: 116 },
  { condition: '阴', conditionCode: 119 },
  { condition: '薄雾', conditionCode: 143 },
  { condition: '小雨', conditionCode: 296 },
  { condition: '中雨', conditionCode: 302 },
  { condition: '雷阵雨', conditionCode: 200 },
  { condition: '小雪', conditionCode: 326 },
  { condition: '中雪', conditionCode: 329 },
]

function fnv1a(text: string, initial: number): number {
  let hash = initial >>> 0
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

function fallbackSeedHex(seedHex: string, dayKey: string): string {
  const domain = 'qqpet-weather-fallback|' + seedHex.toLowerCase() + '|' + dayKey
  const words = [
    fnv1a(domain, FNV_OFFSET),
    fnv1a(domain + '|1', 0x9e3779b9),
    fnv1a(domain + '|2', 0x85ebca6b),
    fnv1a(domain + '|3', 0xc2b2ae35),
  ]
  words[0] = (words[0] | 0x80000000) >>> 0
  return words.map(word => word.toString(16).padStart(8, '0')).join('')
}

interface SeasonTemperatures {
  min: number
  max: number
}

function seasonForMonth(month: number): SeasonTemperatures {
  if (month === 12 || month <= 2) return { min: -8, max: 14 }
  if (month <= 5) return { min: 5, max: 24 }
  if (month <= 8) return { min: 18, max: 36 }
  return { min: 7, max: 23 }
}

export interface WeatherFallbackOptions {
  /** Explicit generation instant, normally the canonical game time. */
  fetchedAtMs: number
  sourceLabel?: string
}

/**
 * Seeded fallback for one game day. It is derived only from the immutable RNG
 * seed and the day key, so other RNG draws cannot change it.
 */
export function fallbackWeatherForDay(seedHex: string, dayKey: string, options: WeatherFallbackOptions): WeatherDayRecord {
  assertEpochMs(options.fetchedAtMs, 'fetchedAtMs')
  const month = parseDayKey(dayKey).month
  let rng = createRngState(fallbackSeedHex(seedHex, dayKey))
  const conditionStep = randIntInclusive(rng, 0, WEATHER_CONDITIONS.length - 1)
  rng = conditionStep.state
  const selected = WEATHER_CONDITIONS[conditionStep.value]
  const season = seasonForMonth(month)
  const minStep = randIntInclusive(rng, season.min - 2, season.min + 3)
  rng = minStep.state
  const maxFloor = Math.max(minStep.value + 3, season.max - 4)
  const maxStep = randIntInclusive(rng, maxFloor, season.max + 4)
  rng = maxStep.state
  const tomorrowStep = randIntInclusive(rng, -4, 4)
  rng = tomorrowStep.state
  const hours: WeatherHour[] = []
  for (let index = 0; index < 8; index++) {
    const windStep = randIntInclusive(rng, 4, 32)
    rng = windStep.state
    hours.push({ hour: index * 3, code: selected.conditionCode, wind: windStep.value })
  }
  const record: WeatherDayRecord = {
    dayKey,
    condition: selected.condition,
    conditionCode: selected.conditionCode,
    minC: minStep.value,
    maxC: Math.max(maxStep.value, minStep.value + 3),
    tomorrowMax: maxStep.value + tomorrowStep.value,
    hours,
    provenance: 'fallback',
    fetchedAtMs: options.fetchedAtMs,
  }
  if (options.sourceLabel !== undefined) record.sourceLabel = options.sourceLabel
  return record
}

/**
 * Returns the persisted day record when present, otherwise a stable fallback.
 * The host persists fallback records before committing ticks that consume them.
 */
export function resolveWeatherForDay(
  environment: EnvironmentInputs,
  seedHex: string,
  dayKey: string,
  fetchedAtMs: number,
): WeatherDayRecord {
  const stored = environment.weatherByDay[dayKey]
  if (stored !== undefined) {
    if (stored.dayKey !== dayKey) throw new Error('weather record dayKey does not match its environment key')
    return stored
  }
  return fallbackWeatherForDay(seedHex, dayKey, { fetchedAtMs, sourceLabel: 'seed+day-key' })
}

export function withWeatherDay(environment: EnvironmentInputs, record: WeatherDayRecord): EnvironmentInputs {
  return {
    ...environment,
    weatherByDay: { ...environment.weatherByDay, [record.dayKey]: record },
  }
}

export function withWeatherProvenance(record: WeatherDayRecord, provenance: WeatherProvenance): WeatherDayRecord {
  return { ...record, provenance }
}

/** 0..3 legacy weather strain: temperature extreme, wet/foggy weather, or a sharp drop tomorrow. */
export function weatherStrain(weather: Pick<WeatherDayRecord, 'minC' | 'maxC' | 'tomorrowMax' | 'condition'>): number {
  const temperature = weather.minC <= 5 || weather.maxC >= 35
  const wetOrFoggy = /雨|雪|雾|霾|冰/.test(weather.condition)
  const sharpDrop = weather.maxC - weather.tomorrowMax >= 8
  return Number(temperature) + Number(wetOrFoggy) + Number(sharpDrop)
}
