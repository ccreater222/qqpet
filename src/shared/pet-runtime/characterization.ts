import { resolveWeatherForDay } from './environment'
import {
  chance as rngChance,
  cloneRngState,
  createRngState,
  loot as rngLoot,
  nextRngWord as rngNextWord,
  pickOne as rngPickOne,
  randIntInclusive as rngRandIntInclusive,
  randomIndex as rngRandomIndex,
  randomUnit as rngRandomUnit,
  shuffle as rngShuffle,
  weightedIndex as rngWeightedIndex,
} from './rng'
import { cloneJsonState } from './serialization'
import { addFixedTicks, assertEpochMs, assertTimeZone, dayKeyAt, type RuntimeClock } from './time'
import type { EnvironmentInputs, RngState, WeatherDayRecord } from './types'

export interface CharacterizationRng {
  nextRngWord(): number
  randomUnit(): number
  randIntInclusive(min: number, max: number): number
  randomIndex(count: number): number | null
  pickOne<T>(items: readonly T[]): T | null
  shuffle<T>(items: readonly T[]): T[]
  weightedIndex(weights: readonly number[]): number
  loot<T>(pools: readonly (readonly T[])[], weights?: readonly number[]): T
  chance(probability: number): boolean
  snapshot(): RngState
}

export interface CharacterizationOptions {
  seedHex: string
  initialWallMs: number
  initialGameTimeMs: number
  timeZone: string
  boundaryHour?: number
  environment?: EnvironmentInputs
}

export interface CharacterizationContext {
  readonly wallTimeMs: number
  readonly gameTimeMs: number
  readonly timeZone: string
  readonly dayKey: string
  readonly environment: EnvironmentInputs
  readonly clock: RuntimeClock
  readonly rng: CharacterizationRng
  weatherForDay(dayKey?: string): WeatherDayRecord
}

export interface CharacterizationStep<T> {
  id: string
  /** Advance the injected wall clock before running this step. */
  advanceWallMs?: number
  /** Advance canonical game time by whole ticks before running this step. */
  advanceGameTicks?: number
  run(context: CharacterizationContext): T
}

export interface CharacterizationFrame<T> {
  stepId: string
  wallTimeMs: number
  gameTimeMs: number
  dayKey: string
  rngAfter: RngState
  output: T
}

export interface CharacterizationReplay<T> {
  frames: CharacterizationFrame<T>[]
  final: {
    wallTimeMs: number
    gameTimeMs: number
    dayKey: string
    rng: RngState
    environment: EnvironmentInputs
  }
}

function assertAdvance(value: number | undefined, name: string): number {
  if (value === undefined) return 0
  if (Number.isSafeInteger(value) === false || value < 0) throw new Error(name + ' must be a non-negative safe integer')
  return value
}

/**
 * Replays a scenario through explicit wall-clock and RNG adapters. The same
 * options and steps must produce byte-identical frames; no ambient time or
 * randomness is consulted.
 */
export function replayCharacterization<T>(
  options: CharacterizationOptions,
  steps: readonly CharacterizationStep<T>[],
): CharacterizationReplay<T> {
  assertEpochMs(options.initialWallMs, 'initialWallMs')
  assertEpochMs(options.initialGameTimeMs, 'initialGameTimeMs')
  assertTimeZone(options.timeZone)
  const boundaryHour = options.boundaryHour ?? 6
  const environment = cloneJsonState(options.environment ?? { weatherByDay: {} })
  let wallTimeMs = options.initialWallMs
  let gameTimeMs = options.initialGameTimeMs
  let rngState = createRngState(options.seedHex)
  const seenIds = new Set<string>()

  const clock: RuntimeClock = { nowMs: () => wallTimeMs }
  const rng: CharacterizationRng = {
    nextRngWord: (): number => {
      const step = rngNextWord(rngState)
      rngState = step.state
      return step.value
    },
    randomUnit: (): number => {
      const step = rngRandomUnit(rngState)
      rngState = step.state
      return step.value
    },
    randIntInclusive: (min: number, max: number): number => {
      const step = rngRandIntInclusive(rngState, min, max)
      rngState = step.state
      return step.value
    },
    randomIndex: (count: number): number | null => {
      const step = rngRandomIndex(rngState, count)
      rngState = step.state
      return step.value
    },
    pickOne: <T>(items: readonly T[]): T | null => {
      const step = rngPickOne(rngState, items)
      rngState = step.state
      return step.value
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const step = rngShuffle(rngState, items)
      rngState = step.state
      return step.value
    },
    weightedIndex: (weights: readonly number[]): number => {
      const step = rngWeightedIndex(rngState, weights)
      rngState = step.state
      return step.value
    },
    loot: <T>(pools: readonly (readonly T[])[], weights?: readonly number[]): T => {
      const step = rngLoot(rngState, pools, weights)
      rngState = step.state
      return step.value
    },
    chance: (probability: number): boolean => {
      const step = rngChance(rngState, probability)
      rngState = step.state
      return step.value
    },
    snapshot: (): RngState => cloneRngState(rngState),
  }

  const frames: CharacterizationFrame<T>[] = []
  for (const step of steps) {
    if (typeof step.id !== 'string' || step.id.length === 0) throw new Error('characterization step ids must be non-empty')
    if (seenIds.has(step.id)) throw new Error('duplicate characterization step id: ' + step.id)
    seenIds.add(step.id)
    const advanceWallMs = assertAdvance(step.advanceWallMs, 'advanceWallMs')
    const advanceGameTicks = assertAdvance(step.advanceGameTicks, 'advanceGameTicks')
    wallTimeMs += advanceWallMs
    assertEpochMs(wallTimeMs, 'wallTimeMs')
    gameTimeMs = addFixedTicks(gameTimeMs, advanceGameTicks)
    const frameWallMs = wallTimeMs
    const frameGameMs = gameTimeMs
    const frameDayKey = dayKeyAt(frameGameMs, options.timeZone, boundaryHour)
    const context: CharacterizationContext = {
      wallTimeMs: frameWallMs,
      gameTimeMs: frameGameMs,
      timeZone: options.timeZone,
      dayKey: frameDayKey,
      environment,
      clock,
      rng,
      weatherForDay: (requestedDayKey = frameDayKey): WeatherDayRecord =>
        resolveWeatherForDay(environment, options.seedHex, requestedDayKey, frameGameMs),
    }
    const output = step.run(context)
    frames.push({
      stepId: step.id,
      wallTimeMs: frameWallMs,
      gameTimeMs: frameGameMs,
      dayKey: frameDayKey,
      rngAfter: cloneRngState(rngState),
      output,
    })
  }

  return {
    frames,
    final: {
      wallTimeMs,
      gameTimeMs,
      dayKey: dayKeyAt(gameTimeMs, options.timeZone, boundaryHour),
      rng: cloneRngState(rngState),
      environment: cloneJsonState(environment),
    },
  }
}
