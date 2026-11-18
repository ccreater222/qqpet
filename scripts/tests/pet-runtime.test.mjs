import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { RUNTIME_SCHEMA_VERSION } from '../../src/shared/pet-runtime/types.ts'
import { levelOf as rendererLevelOf, stageOf as rendererStageOf } from '../../src/renderer/pet/level.ts'
import { createLegacyGoodApplyAdapter, createLegacyStoreAdapter } from './pet-runtime-legacy-adapters.mjs'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/shared/pet-runtime/') && /\.[cm]?[jt]s$/.test(specifier) === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const { replayCharacterization } = await import('../../src/shared/pet-runtime/characterization.ts')
const {
  fallbackWeatherForDay,
  resolveWeatherForDay,
  weatherStrain,
  withWeatherDay,
  withWeatherProvenance,
} = await import('../../src/shared/pet-runtime/environment.ts')
const { levelAndCapsOf, levelOf, stageOf, statCapForLevel } = await import('../../src/shared/pet-runtime/level.ts')
const { assertOrderedEvents, domainEvent, orderedDomainEvent } = await import('../../src/shared/pet-runtime/events.ts')
const {
  chance,
  createRngState,
  loot,
  nextRngWord,
  pickOne,
  randIntInclusive,
  randomIndex,
  randomUnit,
  shuffle,
  weightedIndex,
} = await import('../../src/shared/pet-runtime/rng.ts')
const {
  cloneJsonState,
  createRuntimeStateCodec,
  serializeRuntimeState,
  stableStringify,
} = await import('../../src/shared/pet-runtime/serialization.ts')
const {
  applyGoodStats,
  clampHealth,
  decayStat,
  fatigue,
  growthDelta,
  growthPerMinute,
  luck,
  sumTimedGoodGroupBonuses,
} = await import('../../src/shared/pet-runtime/stats.ts')
const {
  FIXED_TICK_MS,
  addDaysToDayKey,
  advanceFixedTicks,
  assertTimeZone,
  dailyBoundaryMs,
  dayKeyAt,
  dueFixedTicks,
  floorToFixedTick,
  nextDailyBoundary,
  nextDailyBoundaryMs,
  reconcileTimeZone,
  wholeFixedTicksBetween,
  zonedTimeToEpochMs,
} = await import('../../src/shared/pet-runtime/time.ts')

const LEGACY_STORE = createLegacyStoreAdapter()
const LEGACY_APPLY = createLegacyGoodApplyAdapter()
const GOODS = JSON.parse(readFileSync(new URL('../../src/renderer/pet/data/goods.json', import.meta.url), 'utf8'))
const legacyGoodOf = (type, id) => GOODS[type]?.['_' + id]

const SEED = '000102030405060708090a0b0c0d0e0f'
const OTHER_SEED = 'ffeeddccbbaa99887766554433221100'

test('xoshiro128** state evolution, rounded integers and collection helpers are reproducible', () => {
  const expected = [
    { word: 0x71079dda, state: '08090a0b0c0d0e0f0204060840404040' },
    { word: 0x25bc528e, state: '444444440600020c101112036a727a62' },
    { word: 0x002e0e87, state: '28363c2a5255544b54514e4793c37363' },
    { word: 0x7fe89a35, state: 'e9a01b022e322626d6cfe46db139460c' },
    { word: 0x685a5b0b, state: '76ab7b28115dd9495b23b36f5b0154f8' },
    { word: 0xbf98ec03, state: '3cf7f6993cd5110e963a5a47e46d8a52' },
  ]
  const initial = createRngState(SEED)
  assert.deepEqual(initial, { algorithm: 'xoshiro128**', seedHex: SEED, stateHex: SEED, draws: 0 })
  let state = initial
  for (let index = 0; index < expected.length; index++) {
    const step = nextRngWord(state)
    assert.equal(step.value, expected[index].word)
    assert.equal(step.state.stateHex, expected[index].state)
    assert.equal(step.state.draws, index + 1)
    state = step.state
  }
  assert.deepEqual(initial, { algorithm: 'xoshiro128**', seedHex: SEED, stateHex: SEED, draws: 0 })
  assert.equal(randomUnit(initial).value, 0x71079dda / 0x1_0000_0000)

  let roundingState = initial
  for (let index = 0; index < 64; index++) {
    const unit = randomUnit(roundingState)
    const integer = randIntInclusive(roundingState, -7, 11)
    assert.equal(integer.value, Math.round(unit.value * 18 - 7))
    assert.equal(integer.state.stateHex, unit.state.stateHex)
    roundingState = integer.state
  }

  assert.deepEqual(shuffle(initial, ['a', 'b', 'c', 'd']), {
    state: {
      algorithm: 'xoshiro128**',
      seedHex: SEED,
      stateHex: '28363c2a5255544b54514e4793c37363',
      draws: 3,
    },
    value: ['d', 'c', 'a', 'b'],
  })
  assert.equal(weightedIndex(initial, [0.02, 0.25, 0.75]).value, 2)
  assert.equal(loot(initial, [['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1', 'c2', 'c3', 'c4']], [0.02, 0.25, 0.75]).value, 'c1')
  const boundarySeed = '000000000002d82e0000000000000000'
  const boundaryInitial = createRngState(boundarySeed)
  const boundaryUnit = randomUnit(boundaryInitial).value
  assert.ok(boundaryUnit >= 0.25 && boundaryUnit < 1 / 3)
  assert.equal(randIntInclusive(boundaryInitial, 0, 2).value, 1)
  assert.equal(randomIndex(boundaryInitial, 3).value, 0)
  assert.equal(pickOne(boundaryInitial, ['a', 'b', 'c']).value, 'a')
  assert.deepEqual(shuffle(boundaryInitial, ['a', 'b', 'c']).value, ['b', 'c', 'a'])
  assert.equal(loot(boundaryInitial, [['a'], ['b'], ['c']]).value, 'a')
  assert.equal(randomIndex(boundaryInitial, 0).value, null)
  assert.deepEqual(randomIndex(boundaryInitial, 0).state, boundaryInitial)

  for (const count of [1, 2, 3, 4, 7, 8, 10]) {
    let unitState = initial
    let indexState = initial
    for (let draw = 0; draw < 64; draw++) {
      const unit = randomUnit(unitState)
      const index = randomIndex(indexState, count)
      assert.equal(index.value, Math.floor(unit.value * count))
      assert.equal(index.state.stateHex, unit.state.stateHex)
      unitState = unit.state
      indexState = index.state
    }
  }

  let uniformState = initial
  const counts = [0, 0, 0]
  for (let draw = 0; draw < 12_000; draw++) {
    const step = randomIndex(uniformState, 3)
    assert.ok(step.value !== null)
    counts[step.value]++
    uniformState = step.state
  }
  assert.ok(counts.every(count => count > 3500 && count < 4500), 'three-way index counts were not uniform: ' + counts.join(','))

  assert.equal(chance(initial, 0.5).value, true)
  assert.throws(() => createRngState('0'.repeat(32)), /all-zero/)
  assert.throws(() => createRngState('xyz'), /32 hexadecimal/)
  assert.throws(() => randIntInclusive(initial, 5, 4), /greater than or equal/)
})

test('domain event bases assign ordered host sequence numbers and reject regressions', () => {
  const draft = domainEvent('pet.fed', { amount: 1 })
  assert.deepEqual(draft, { type: 'pet.fed', payload: { amount: 1 } })
  const first = orderedDomainEvent(3, draft)
  const second = orderedDomainEvent(4, domainEvent('pet.cleaned', { amount: 2 }))
  assert.deepEqual(first, { eventSeq: 3, type: 'pet.fed', payload: { amount: 1 } })
  assert.doesNotThrow(() => assertOrderedEvents([first, second]))
  assert.throws(() => orderedDomainEvent(0, draft), /positive safe integer/)
  assert.throws(() => assertOrderedEvents([first, orderedDomainEvent(3, draft)]), /strictly increasing/)
})

test('level, stage and cap selectors match the current renderer behavior', () => {
  const samples = [-1000, -1, 0, 1, 124, 124.999, 125, 324.999, 325, 649.999, 650, 10_000, 1_000_000]
  for (const growth of samples) {
    assert.deepEqual(levelOf(growth), rendererLevelOf(growth))
    assert.equal(stageOf(levelOf(growth).level), rendererStageOf(rendererLevelOf(growth).level))
  }
  assert.deepEqual(levelOf(125), { level: 2, upGrowth: 125, nextGrowth: 325 })
  assert.deepEqual(levelAndCapsOf(0), { level: 1, upGrowth: 0, nextGrowth: 125, hungerMax: 1100, cleanMax: 1100 })
  assert.equal(statCapForLevel(10), 2000)
  assert.equal(statCapForLevel(70), 8000)
  assert.equal(statCapForLevel(71), 8000)
  assert.equal(stageOf(4), 'Egg')
  assert.equal(stageOf(5), 'Kid')
  assert.equal(stageOf(16), 'Adult')
})

function timedGoodEntry(type) {
  const good = Object.values(GOODS[type]).find(entry => (entry.group ?? 0) > 0 && entry.useTimeing)
  if (good === undefined) throw new Error('no grouped timed good for ' + type)
  return { id: good.id, left: good.useTimeing }
}

const ACTIVE_TIMED_GOODS = {
  food: timedGoodEntry('food'),
  clean: timedGoodEntry('clean'),
  toy: timedGoodEntry('toy'),
  background: timedGoodEntry('background'),
}
const BACKGROUND_ONLY = { food: null, clean: null, toy: null, background: ACTIVE_TIMED_GOODS.background }
const EMPTY_TIMED_GOODS = { food: null, clean: null, toy: null, background: null }
const ACTIVE_TIMED_BONUS = sumTimedGoodGroupBonuses(ACTIVE_TIMED_GOODS, (type, id) => legacyGoodOf(type, id)?.group)
const BACKGROUND_ONLY_BONUS = sumTimedGoodGroupBonuses(BACKGROUND_ONLY, (type, id) => legacyGoodOf(type, id)?.group)

test('stat math matches executable legacy renderer adapters including real timed-good groups', () => {
  assert.ok(ACTIVE_TIMED_BONUS > 0)
  assert.equal(ACTIVE_TIMED_BONUS, Object.entries(ACTIVE_TIMED_GOODS).reduce((sum, [type, good]) =>
    sum + (legacyGoodOf(type, good.id)?.group ?? 0), 0))
  assert.equal(BACKGROUND_ONLY_BONUS, legacyGoodOf('background', ACTIVE_TIMED_GOODS.background.id)?.group)

  const timedVariants = [
    { selfGoodUseOption: EMPTY_TIMED_GOODS, bonus: 0 },
    { selfGoodUseOption: BACKGROUND_ONLY, bonus: BACKGROUND_ONLY_BONUS },
    { selfGoodUseOption: ACTIVE_TIMED_GOODS, bonus: ACTIVE_TIMED_BONUS },
  ]
  for (const mood of [-10, 0, 1, 199, 200, 499, 500, 799, 800, 1000]) {
    for (const pinkDiamond of [false, true]) {
      for (const sweetHeartOverTime of [false, true]) {
        for (const variant of timedVariants) {
          const info = { mood, pinkDiamond, sweetHeartOverTime }
          const actual = LEGACY_STORE.growthPerMinute({
            info,
            save: { selfGoodUseOption: variant.selfGoodUseOption },
            goodOf: legacyGoodOf,
          })
          assert.equal(growthPerMinute({ ...info, timedGoodGroupBonus: variant.bonus }), actual)
        }
      }
    }
  }

  for (const health of [0, 4, 5]) {
    for (const mood of [0, 100, 400, 900]) {
      for (const clean of [50, 300, 900]) {
        for (const hunger of [50, 300, 900]) {
          for (const busy of [false, true]) {
            const level = health === 5 ? 20 : 5
            const strong = health === 5 ? 6000 : 600
            const info = { health, mood, clean, hunger, strong }
            const save = { petComputedlInfo: { level, moodMax: 1000, cleanMax: 1100, hungerMax: 1100 } }
            const input = {
              health, mood, moodMax: 1000, clean, cleanMax: 1100, hunger, hungerMax: 1100,
              busy, strong, level,
            }
            assert.equal(fatigue(input), LEGACY_STORE.fatigue({ info, save, busy }))
          }
        }
      }
    }
  }

  for (const pinkDiamond of [false, true]) {
    for (const sweetHeart of [false, true]) {
      for (const charm of [0, 501, 5001, 50001]) {
        for (const intel of [0, 801, 8001, 80001]) {
          const info = {
            health: 5, mood: 900, clean: 900, hunger: 900, strong: 6000,
            pinkDiamond, PDiamondLevel: 6, sweetHeart, charm, intel,
          }
          const save = { petComputedlInfo: { level: 20, moodMax: 1000, cleanMax: 1100, hungerMax: 1100 } }
          const sharedFatigue = fatigue({
            health: 5, mood: 900, moodMax: 1000, clean: 900, cleanMax: 1100,
            hunger: 900, hungerMax: 1100, busy: false, strong: 6000, level: 20,
          })
          const expected = luck({ pinkDiamond, PDiamondLevel: 6, sweetHeart, charm, intel, fatigue: sharedFatigue })
          assert.equal(expected, LEGACY_STORE.luck({ info, save, busy: false }))
        }
      }
    }
  }

  const current = { hunger: 1000, clean: 1050, mood: 950, intel: 10, charm: 20, strong: 30 }
  const caps = { hungerMax: 1100, cleanMax: 1100, moodMax: 1000 }
  const effect = { hunger: 300, clean: 200, mood: 100, intel: 5, charm: 7, strong: 11 }
  assert.deepEqual(applyGoodStats(current, caps, effect, 20), LEGACY_APPLY.apply(current, caps, effect, 20))
  assert.deepEqual(applyGoodStats(current, caps, {}, 20), LEGACY_APPLY.apply(current, caps, {}, 20))
  assert.equal(growthDelta(1.234567891, 0.5), Number((1.234567891 * 0.5).toFixed(8)))
  assert.equal(decayStat(10, 3, 4), 0)
  assert.equal(decayStat(100, 2.5, 4), 90)
  assert.equal(clampHealth(Number.NaN), 0)
  assert.equal(clampHealth(-1), 0)
  assert.equal(clampHealth(7), 5)
  assert.equal(clampHealth(3), 3)
})

test('fixed ticks and deterministic day keys honor 06:00, timezone changes and DST', () => {
  assert.equal(FIXED_TICK_MS, 60_000)
  assert.equal(advanceFixedTicks(1000, 2), 121_000)
  assert.equal(wholeFixedTicksBetween(0, 119_999), 1)
  assert.equal(wholeFixedTicksBetween(5000, 1000), 0)
  assert.equal(floorToFixedTick(125_999), 120_000)
  assert.equal(dueFixedTicks(1_000, 181_000), 3)
  assert.throws(() => advanceFixedTicks(0, -1), /non-negative/)
  assert.equal(addDaysToDayKey('2026-12-31', 1), '2027-01-01')
  assert.equal(addDaysToDayKey('2024-02-29', -1), '2024-02-28')
  assert.throws(() => addDaysToDayKey('2026-02-30', 0), /valid Gregorian/)

  const shanghai = 'Asia/Shanghai'
  const before = Date.UTC(2026, 9, 19, 21, 59, 0)
  const boundary = Date.UTC(2026, 9, 19, 22, 0, 0)
  assert.equal(dayKeyAt(before, shanghai), '2026-10-19')
  assert.equal(dayKeyAt(boundary, shanghai), '2026-10-20')
  assert.equal(nextDailyBoundaryMs(before, shanghai), boundary)
  assert.equal(nextDailyBoundaryMs(boundary, shanghai), Date.UTC(2026, 9, 20, 22, 0, 0))
  assert.deepEqual(nextDailyBoundary(boundary, shanghai), {
    dayKey: '2026-10-21',
    boundaryMs: Date.UTC(2026, 9, 20, 22, 0, 0),
  })

  const newYork = 'America/New_York'
  assert.equal(dailyBoundaryMs('2024-03-10', newYork), Date.UTC(2024, 2, 10, 10, 0, 0))
  assert.equal(dailyBoundaryMs('2024-11-03', newYork), Date.UTC(2024, 10, 3, 11, 0, 0))
  assert.equal(dayKeyAt(Date.UTC(2024, 2, 10, 9, 59, 59), newYork), '2024-03-09')
  assert.equal(dayKeyAt(Date.UTC(2024, 2, 10, 10, 0, 0), newYork), '2024-03-10')
  assert.equal(nextDailyBoundaryMs(Date.UTC(2024, 2, 10, 9, 59, 0), newYork), Date.UTC(2024, 2, 10, 10, 0, 0))
  assert.equal(nextDailyBoundaryMs(Date.UTC(2024, 2, 10, 10, 0, 0), newYork), Date.UTC(2024, 2, 11, 10, 0, 0))
  assert.equal(nextDailyBoundaryMs(Date.UTC(2024, 10, 3, 10, 59, 0), newYork), Date.UTC(2024, 10, 3, 11, 0, 0))
  assert.equal(nextDailyBoundaryMs(Date.UTC(2024, 10, 3, 11, 0, 0), newYork), Date.UTC(2024, 10, 4, 11, 0, 0))

  assert.equal(zonedTimeToEpochMs(newYork, 2024, 3, 10, 2, 30), Date.UTC(2024, 2, 10, 7, 0, 0))
  assert.equal(zonedTimeToEpochMs(newYork, 2024, 11, 3, 1, 30), Date.UTC(2024, 10, 3, 5, 30, 0))
  assert.equal(dailyBoundaryMs('2024-03-10', newYork, 2), Date.UTC(2024, 2, 10, 7, 0, 0))
  assert.equal(dayKeyAt(Date.UTC(2024, 2, 10, 6, 59, 0), newYork, 2), '2024-03-09')
  assert.equal(dayKeyAt(Date.UTC(2024, 2, 10, 7, 0, 0), newYork, 2), '2024-03-10')
  assert.equal(nextDailyBoundaryMs(Date.UTC(2024, 2, 10, 7, 0, 0), newYork, 2), Date.UTC(2024, 2, 11, 6, 0, 0))

  const firstRepeatedOne = Date.UTC(2024, 10, 3, 5, 0, 0)
  const afterFallBack = Date.UTC(2024, 10, 3, 6, 30, 0)
  assert.equal(dailyBoundaryMs('2024-11-03', newYork, 1), firstRepeatedOne)
  assert.equal(dayKeyAt(firstRepeatedOne - 1, newYork, 1), '2024-11-02')
  assert.equal(dayKeyAt(firstRepeatedOne, newYork, 1), '2024-11-03')
  assert.equal(dayKeyAt(afterFallBack, newYork, 1), '2024-11-03')
  assert.equal(nextDailyBoundaryMs(firstRepeatedOne, newYork, 1), Date.UTC(2024, 10, 4, 6, 0, 0))
  assert.equal(nextDailyBoundaryMs(afterFallBack, newYork, 1), Date.UTC(2024, 10, 4, 6, 0, 0))

  assert.deepEqual(reconcileTimeZone(Date.UTC(2026, 9, 20, 8, 0, 0), shanghai), {
    lastProcessedDayBoundaryKey: '2026-10-20',
    nextDailyBoundaryMs: Date.UTC(2026, 9, 20, 22, 0, 0),
  })
  assert.deepEqual(reconcileTimeZone(Date.UTC(2026, 9, 20, 8, 0, 0), newYork), {
    lastProcessedDayBoundaryKey: '2026-10-19',
    nextDailyBoundaryMs: Date.UTC(2026, 9, 20, 10, 0, 0),
  })
  const firstReconcile = reconcileTimeZone(Date.UTC(2026, 9, 20, 8, 0, 0), newYork)
  const secondReconcile = reconcileTimeZone(Date.UTC(2026, 9, 20, 8, 0, 0), newYork)
  assert.deepEqual(secondReconcile, firstReconcile)
  assert.throws(() => assertTimeZone('Mars/Olympus_Mons'), /invalid IANA/)
})

test('runtime-state serialization is canonical, lossless and schema checked', () => {
  const state = { z: 1, a: { beta: '企鹅', alpha: [3, 2, 1] }, hidden: null, flag: true }
  assert.equal(stableStringify({ z: 1, a: 2 }), '{"a":2,"z":1}')
  assert.equal(stableStringify(state), stableStringify({ flag: true, hidden: null, a: { alpha: [3, 2, 1], beta: '企鹅' }, z: 1 }))

  const isState = value =>
    value !== null && typeof value === 'object' && value.z === 1 && typeof value.a === 'object'
  const codec = createRuntimeStateCodec(RUNTIME_SCHEMA_VERSION, isState)
  const encoded = codec.encode(state)
  const decoded = codec.decode(encoded)
  assert.deepEqual(decoded, state)
  assert.equal(codec.schemaVersion, RUNTIME_SCHEMA_VERSION)
  assert.deepEqual(codec.decode(serializeRuntimeState(state)), state)

  const copy = cloneJsonState(state)
  copy.a.alpha.push(4)
  assert.deepEqual(state.a.alpha, [3, 2, 1])

  assert.equal(stableStringify(state), stableStringify(state))
  assert.equal(codec.encode(state), codec.encode(state))

  let getterReads = 0
  const accessor = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      getterReads++
      return 1
    },
  })
  assert.throws(() => stableStringify(accessor), /accessors/)
  assert.throws(() => stableStringify({ nested: accessor }), /accessors/)
  assert.equal(getterReads, 0)

  const nonEnumerable = { visible: 1 }
  Object.defineProperty(nonEnumerable, 'hidden', { value: 2, enumerable: false })
  assert.throws(() => stableStringify(nonEnumerable), /enumerable/)

  const extraArrayProperty = [1, 2]
  extraArrayProperty.extra = 3
  assert.throws(() => stableStringify(extraArrayProperty), /extra non-index array property/)

  const nonEnumerableIndex = [1, 2]
  Object.defineProperty(nonEnumerableIndex, '0', { value: 1, enumerable: false, writable: true, configurable: true })
  assert.throws(() => stableStringify(nonEnumerableIndex), /enumerable/)

  let indexGetterReads = 0
  const accessorIndex = [1]
  Object.defineProperty(accessorIndex, '0', {
    enumerable: true,
    get() {
      indexGetterReads++
      return 1
    },
  })
  assert.throws(() => stableStringify(accessorIndex), /accessors/)
  assert.equal(indexGetterReads, 0)

  const symbolValue = { visible: 1 }
  Object.defineProperty(symbolValue, Symbol('hidden'), { value: 2, enumerable: true })
  assert.throws(() => stableStringify(symbolValue), /symbol/)

  assert.throws(() => stableStringify({ value: Number.NaN }), /finite/)
  assert.throws(() => stableStringify({ value: undefined }), /JSON-safe/)
  assert.throws(() => stableStringify({ value: () => 1 }), /JSON-safe/)
  assert.throws(() => stableStringify({ toJSON: () => 1 }), /JSON-safe/)
  assert.throws(() => stableStringify(new Date(0)), /plain JSON object/)
  assert.throws(() => stableStringify({ value: -0 }), /negative zero/)
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => stableStringify(cyclic), /cycle/)
  assert.throws(() => codec.decode(JSON.stringify({ schemaVersion: 2, state })), /schema version mismatch/)
  assert.throws(() => codec.decode(JSON.stringify({ schemaVersion: 1, state: { z: 2 } })), /validator/)
  assert.throws(() => codec.decode('{bad json'), /valid JSON/)
  assert.throws(() => serializeRuntimeState(state, 0), /positive safe integer/)
})

test('per-day weather fallback is stable, seed/day-derived and never consumes mutable RNG state', () => {
  const day = '2026-10-20'
  const fetchedAtMs = Date.UTC(2026, 9, 20, 0, 0, 0)
  const first = fallbackWeatherForDay(SEED, day, { fetchedAtMs, sourceLabel: 'test-fallback' })
  const second = fallbackWeatherForDay(SEED, day, { fetchedAtMs, sourceLabel: 'test-fallback' })
  assert.deepEqual(second, first)
  assert.equal(first.dayKey, day)
  assert.equal(first.provenance, 'fallback')
  assert.equal(first.fetchedAtMs, fetchedAtMs)
  assert.equal(first.sourceLabel, 'test-fallback')
  assert.ok(first.minC <= first.maxC)
  assert.equal(first.hours.length, 8)

  let state = createRngState(SEED)
  for (let index = 0; index < 50; index++) state = randomUnit(state).state
  assert.deepEqual(fallbackWeatherForDay(SEED, day, { fetchedAtMs, sourceLabel: 'test-fallback' }), first)
  const differentDay = fallbackWeatherForDay(SEED, '2026-10-21', { fetchedAtMs: fetchedAtMs + 86_400_000 })
  assert.notDeepEqual({ ...differentDay, dayKey: '', fetchedAtMs: 0 }, { ...first, dayKey: '', fetchedAtMs: 0 })
  const differentSeed = fallbackWeatherForDay(OTHER_SEED, day, { fetchedAtMs })
  assert.notDeepEqual({ ...differentSeed, dayKey: '', fetchedAtMs: 0 }, { ...first, dayKey: '', fetchedAtMs: 0 })

  const empty = { weatherByDay: {} }
  const resolved = resolveWeatherForDay(empty, SEED, day, fetchedAtMs)
  assert.equal(resolved.provenance, 'fallback')
  assert.equal(resolved.sourceLabel, 'seed+day-key')
  const stored = withWeatherDay(empty, first)
  assert.equal(empty.weatherByDay[day], undefined)
  assert.equal(resolveWeatherForDay(stored, OTHER_SEED, day, 1), first)
  assert.equal(withWeatherProvenance(first, 'cache').provenance, 'cache')

  assert.equal(weatherStrain({ minC: 10, maxC: 20, tomorrowMax: 19, condition: '晴' }), 0)
  assert.equal(weatherStrain({ minC: 5, maxC: 20, tomorrowMax: 19, condition: '小雨' }), 2)
  assert.equal(weatherStrain({ minC: -10, maxC: 36, tomorrowMax: 20, condition: '暴雨' }), 3)
})

test('characterization harness replays injected time and RNG byte-for-byte', () => {
  const options = {
    seedHex: SEED,
    initialWallMs: Date.UTC(2026, 9, 19, 21, 59, 0),
    initialGameTimeMs: Date.UTC(2026, 9, 19, 21, 59, 0),
    timeZone: 'Asia/Shanghai',
    environment: { weatherByDay: {} },
  }
  const makeSteps = () => [
    {
      id: 'start',
      run: context => ({
        wallTimeMs: context.wallTimeMs,
        clockMs: context.clock.nowMs(),
        gameTimeMs: context.gameTimeMs,
        dayKey: context.dayKey,
        roll: context.rng.randomUnit(),
        weather: context.weatherForDay(),
      }),
    },
    {
      id: 'one-tick',
      advanceWallMs: 60_000,
      advanceGameTicks: 1,
      run: context => ({
        wallTimeMs: context.wallTimeMs,
        gameTimeMs: context.gameTimeMs,
        dayKey: context.dayKey,
        integer: context.rng.randIntInclusive(5, 9),
        shuffled: context.rng.shuffle(['a', 'b', 'c', 'd']),
        weatherDayKey: context.weatherForDay().dayKey,
      }),
    },
  ]
  const first = replayCharacterization(options, makeSteps())
  const second = replayCharacterization(options, makeSteps())
  assert.deepEqual(second, first)
  assert.equal(first.frames[0].wallTimeMs, options.initialWallMs)
  assert.equal(first.frames[0].output.clockMs, options.initialWallMs)
  assert.equal(first.frames[0].dayKey, '2026-10-19')
  assert.equal(first.frames[0].rngAfter.draws, 1)
  assert.equal(first.frames[1].gameTimeMs, options.initialGameTimeMs + FIXED_TICK_MS)
  assert.equal(first.frames[1].wallTimeMs, options.initialWallMs + 60_000)
  assert.equal(first.frames[1].dayKey, '2026-10-20')
  assert.equal(first.frames[1].output.dayKey, '2026-10-20')
  assert.equal(first.frames[1].rngAfter.draws, 5)
  assert.equal(first.final.gameTimeMs, options.initialGameTimeMs + FIXED_TICK_MS)
  assert.equal(first.final.dayKey, '2026-10-20')
  assert.deepEqual(first.final.environment, { weatherByDay: {} })

  const different = replayCharacterization({ ...options, seedHex: OTHER_SEED }, makeSteps())
  assert.notEqual(different.frames[0].output.roll, first.frames[0].output.roll)
  assert.notDeepEqual(different.frames[1].output.shuffled, first.frames[1].output.shuffled)
})

test('characterization RNG adapter exposes the full stateful surface', () => {
  const pools = [['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1', 'c2', 'c3', 'c4']]
  const weights = [0.02, 0.25, 0.75]
  let direct = createRngState(SEED)
  const expected = {}
  const word = nextRngWord(direct)
  direct = word.state
  expected.word = word.value
  const unit = randomUnit(direct)
  direct = unit.state
  expected.unit = unit.value
  const integer = randIntInclusive(direct, 5, 9)
  direct = integer.state
  expected.integer = integer.value
  const index = randomIndex(direct, 3)
  direct = index.state
  expected.index = index.value
  const picked = pickOne(direct, ['x', 'y', 'z'])
  direct = picked.state
  expected.picked = picked.value
  const shuffled = shuffle(direct, ['a', 'b', 'c', 'd'])
  direct = shuffled.state
  expected.shuffled = shuffled.value
  const weighted = weightedIndex(direct, weights)
  direct = weighted.state
  expected.weighted = weighted.value
  const looted = loot(direct, pools, weights)
  direct = looted.state
  expected.looted = looted.value
  const chanced = chance(direct, 0.5)
  direct = chanced.state
  expected.chanced = chanced.value

  assert.equal(direct.draws, 12)
  const steps = [{
    id: 'all-rng-methods',
    run: context => {
      const initialSnapshot = context.rng.snapshot()
      const values = {
        word: context.rng.nextRngWord(),
        unit: context.rng.randomUnit(),
        integer: context.rng.randIntInclusive(5, 9),
        index: context.rng.randomIndex(3),
        picked: context.rng.pickOne(['x', 'y', 'z']),
        shuffled: context.rng.shuffle(['a', 'b', 'c', 'd']),
        weighted: context.rng.weightedIndex(weights),
        looted: context.rng.loot(pools, weights),
        chanced: context.rng.chance(0.5),
      }
      return { initialSnapshot, values, finalSnapshot: context.rng.snapshot() }
    },
  }]
  const run = replayCharacterization({
    seedHex: SEED,
    initialWallMs: Date.UTC(2026, 9, 19, 21, 59, 0),
    initialGameTimeMs: Date.UTC(2026, 9, 19, 21, 59, 0),
    timeZone: 'Asia/Shanghai',
    environment: { weatherByDay: {} },
  }, steps)
  const output = run.frames[0].output
  assert.deepEqual(output.initialSnapshot, createRngState(SEED))
  assert.deepEqual(output.values, expected)
  assert.deepEqual(output.finalSnapshot, direct)
  assert.deepEqual(run.frames[0].rngAfter, direct)
  assert.deepEqual(replayCharacterization({
    seedHex: SEED,
    initialWallMs: Date.UTC(2026, 9, 19, 21, 59, 0),
    initialGameTimeMs: Date.UTC(2026, 9, 19, 21, 59, 0),
    timeZone: 'Asia/Shanghai',
    environment: { weatherByDay: {} },
  }, steps), run)
})
