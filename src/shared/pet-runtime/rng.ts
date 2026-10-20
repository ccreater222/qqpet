import type { RngState } from './types'

export const RNG_SEED_HEX_LENGTH = 32
export const RNG_STATE_HEX_LENGTH = 32
export const RNG_UINT32_RANGE = 0x1_0000_0000

const HEX_32 = /^[0-9a-fA-F]{32}$/

/** One random transition: the candidate state and its value. */
export interface RngStep<T> {
  state: RngState
  value: T
}

function fail(message: string): never {
  throw new Error(message)
}

const requireSafeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value)) fail(name + ' must be a safe integer')
}

function parseHexWords(hex: string, name: string): [number, number, number, number] {
  if (!HEX_32.test(hex)) fail(name + ' must be exactly 32 hexadecimal characters')
  return [
    Number.parseInt(hex.slice(0, 8), 16) >>> 0,
    Number.parseInt(hex.slice(8, 16), 16) >>> 0,
    Number.parseInt(hex.slice(16, 24), 16) >>> 0,
    Number.parseInt(hex.slice(24, 32), 16) >>> 0,
  ]
}

const wordHex = (value: number): string => (value >>> 0).toString(16).padStart(8, '0')
const wordsHex = (words: readonly [number, number, number, number]): string => words.map(wordHex).join('')

const rotl = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) >>> 0

/** Rehydrates and validates persisted RNG metadata. */
export function rngStateFromParts(seedHex: string, stateHex: string, draws = 0): RngState {
  parseHexWords(seedHex, 'seedHex')
  const words = parseHexWords(stateHex, 'stateHex')
  if ((words[0] | words[1] | words[2] | words[3]) === 0) fail('stateHex must not be the all-zero xoshiro state')
  if (!Number.isSafeInteger(draws) || draws < 0) fail('draws must be a non-negative safe integer')
  return {
    algorithm: 'xoshiro128**',
    seedHex: seedHex.toLowerCase(),
    stateHex: stateHex.toLowerCase(),
    draws,
  }
}

/**
 * Creates the initial state from host-generated entropy. Hosts must obtain
 * `seedHex` from their CSPRNG; the runtime never generates seeds itself.
 */
export function createRngState(seedHex: string): RngState {
  return rngStateFromParts(seedHex, seedHex, 0)
}

/** Validates a state object and returns an independent plain-JSON copy. */
export function cloneRngState(state: RngState): RngState {
  if (state.algorithm !== 'xoshiro128**') fail('unsupported RNG algorithm')
  return rngStateFromParts(state.seedHex, state.stateHex, state.draws)
}

/** Advances xoshiro128** once and returns a uint32 sample. */
export function nextRngWord(state: RngState): RngStep<number> {
  const current = cloneRngState(state)
  const words = parseHexWords(current.stateHex, 'stateHex')
  let [s0, s1, s2, s3] = words
  const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0)
  const t = (s1 << 9) >>> 0
  s2 = (s2 ^ s0) >>> 0
  s3 = (s3 ^ s1) >>> 0
  s1 = (s1 ^ s2) >>> 0
  s0 = (s0 ^ s3) >>> 0
  s2 = (s2 ^ t) >>> 0
  s3 = rotl(s3, 11)

  const next: RngState = {
    algorithm: 'xoshiro128**',
    seedHex: current.seedHex,
    stateHex: wordsHex([s0, s1, s2, s3]),
    draws: current.draws + 1,
  }
  return { state: next, value: result }
}

/** Uniform double in [0, 1), with 32 bits of resolution. */
export function randomUnit(state: RngState): RngStep<number> {
  const step = nextRngWord(state)
  return { state: step.state, value: step.value / RNG_UINT32_RANGE }
}

/** Integer in [min, max] using the same rounded distribution as the legacy rand helper. */
export function randIntInclusive(state: RngState, min: number, max: number): RngStep<number> {
  requireSafeInteger(min, 'min')
  requireSafeInteger(max, 'max')
  if (max < min) fail('max must be greater than or equal to min')
  if (!Number.isSafeInteger(max - min)) fail('the inclusive range must be a safe integer')
  const step = randomUnit(state)
  return { state: step.state, value: Math.round(step.value * (max - min) + min) }
}

/** Uniform index in [0, count), or null for an empty input. */
export function randomIndex(state: RngState, count: number): RngStep<number | null> {
  requireSafeInteger(count, 'count')
  if (count < 0) fail('count must not be negative')
  if (count === 0) return { state: cloneRngState(state), value: null }
  const step = randIntInclusive(state, 0, count - 1)
  return { state: step.state, value: step.value }
}

export function pickOne<T>(state: RngState, items: readonly T[]): RngStep<T | null> {
  const step = randomIndex(state, items.length)
  return { state: step.state, value: step.value === null ? null : items[step.value] }
}

/** Fisher-Yates without mutating the input array. */
export function shuffle<T>(state: RngState, items: readonly T[]): RngStep<T[]> {
  const value = items.slice()
  let rng = cloneRngState(state)
  for (let index = value.length - 1; index > 0; index--) {
    const step = randIntInclusive(rng, 0, index)
    rng = step.state
    const swap = value[index]
    value[index] = value[step.value]
    value[step.value] = swap
  }
  return { state: rng, value }
}

/** Chooses a non-negative weight by cumulative probability. At least one weight must be positive. */
export function weightedIndex(state: RngState, weights: readonly number[]): RngStep<number> {
  if (weights.length === 0) fail('weights must not be empty')
  let total = 0
  let lastPositive = -1
  for (let index = 0; index < weights.length; index++) {
    const weight = weights[index]
    if (!Number.isFinite(weight) || weight < 0) fail('weights must be finite and non-negative')
    if (weight > 0) {
      lastPositive = index
      total += weight
    }
  }
  if (!(total > 0) || !Number.isFinite(total)) fail('at least one weight must be positive and finite')
  const unit = randomUnit(state)
  const target = unit.value * total
  let cumulative = 0
  for (let index = 0; index < weights.length; index++) {
    cumulative += weights[index]
    if (target < cumulative) return { state: unit.state, value: index }
  }
  return { state: unit.state, value: lastPositive }
}

/**
 * Selects a pool (uniformly, or by `weights`) and then an item from that pool.
 * Callers own the content-specific pool tables and weights.
 */
export function loot<T>(
  state: RngState,
  pools: readonly (readonly T[])[],
  weights?: readonly number[],
): RngStep<T> {
  if (pools.length === 0) fail('pools must not be empty')
  if (weights && weights.length !== pools.length) fail('weights must match the number of pools')
  const poolStep = weights ? weightedIndex(state, weights) : randomIndex(state, pools.length)
  const poolIndex = poolStep.value
  if (poolIndex === null) fail('cannot loot from an empty pool list')
  const pool = pools[poolIndex]
  if (!pool || pool.length === 0) fail('cannot loot from an empty pool')
  const itemStep = pickOne(poolStep.state, pool)
  const item = itemStep.value
  if (item === null) fail('cannot loot from an empty pool')
  return { state: itemStep.state, value: item }
}

/** Bernoulli draw; zero consumes a draw, one always succeeds but still consumes one. */
export function chance(state: RngState, probability: number): RngStep<boolean> {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) fail('probability must be between 0 and 1')
  const step = randomUnit(state)
  return { state: step.state, value: step.value < probability }
}
