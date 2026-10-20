export interface PetStatCaps {
  hungerMax: number
  cleanMax: number
  moodMax: number
}

export interface PetStatValues {
  hunger: number
  clean: number
  mood: number
  intel: number
  charm: number
  strong: number
}

export interface GoodStatEffect {
  hunger?: number
  clean?: number
  mood?: number
  intel?: number
  charm?: number
  strong?: number
}

export interface GrowthRateInput {
  mood: number
  pinkDiamond: boolean
  sweetHeartOverTime: boolean
  /** Sum of active timed-good `group` bonuses. */
  timedGoodGroupBonus?: number
}

export interface FatigueInput {
  health: number
  mood: number
  moodMax: number
  clean: number
  cleanMax: number
  hunger: number
  hungerMax: number
  busy: boolean
  strong: number
  level: number
}

export interface LuckInput {
  pinkDiamond: boolean
  PDiamondLevel: number
  sweetHeart: boolean
  charm: number
  intel: number
  fatigue: number
}

/** Mood thresholds and their legacy growth multipliers, highest first. */
export const MOOD_GROWTH_BANDS: readonly { minimum: number; rate: number }[] = [
  { minimum: 800, rate: 1 },
  { minimum: 500, rate: 0.9 },
  { minimum: 200, rate: 0.7 },
  { minimum: Number.NEGATIVE_INFINITY, rate: 0.5 },
]

export function moodGrowthRate(mood: number): number {
  for (const band of MOOD_GROWTH_BANDS) if (mood >= band.minimum) return band.rate
  return 0.5
}

/** Growth per minute, including mood, VIP and active timed-good bonuses. */
export function growthPerMinute(input: GrowthRateInput): number {
  if (input.mood <= 0) return 10 / 60
  const rate = moodGrowthRate(input.mood)
  let perHour = 80 * rate + (input.pinkDiamond ? 10 : 0) + (input.timedGoodGroupBonus ?? 0)
  if (input.sweetHeartOverTime) perHour *= 1.1
  return perHour / 60
}

/** Growth added in one tick, rounded exactly like the legacy growth accumulator. */
export function growthDelta(perMinute: number, elapsedMinutes: number): number {
  return Number((perMinute * elapsedMinutes).toFixed(8))
}

/** Applies the legacy good-stat formula and cap clamps without mutating the input. */
export function applyGoodStats(
  current: PetStatValues,
  caps: PetStatCaps,
  effect: GoodStatEffect,
  extraMood = 0,
): PetStatValues {
  let hunger = current.hunger
  let clean = current.clean
  let mood = current.mood
  if (effect.hunger) hunger = Math.min(hunger + effect.hunger, caps.hungerMax)
  if (effect.clean) clean = Math.min(clean + effect.clean, caps.cleanMax)
  const moodDelta = (effect.mood ?? 0) + extraMood
  if (moodDelta) mood = Math.min(mood + moodDelta, caps.moodMax)
  return {
    hunger,
    clean,
    mood,
    intel: current.intel + (effect.intel ?? 0),
    charm: current.charm + (effect.charm ?? 0),
    strong: current.strong + (effect.strong ?? 0),
  }
}

/** Per-minute hunger/clean/mood decay, floored at zero. */
export function decayStat(value: number, rate: number, elapsedMinutes: number): number {
  return Math.max(value - rate * elapsedMinutes, 0)
}

/** 0 (fresh) and up; drives illness and health-loss rolls. */
export function fatigue(input: FatigueInput): number {
  const moodRatio = input.mood / input.moodMax
  const cleanRatio = input.clean / input.cleanMax
  const hungerRatio = input.hunger / input.hungerMax
  let value =
    (input.health === 5 ? 0 : 2) +
    (moodRatio < 0.2 ? 3 : moodRatio < 0.5 ? 2 : 0) +
    (cleanRatio < 0.2 ? 2 : cleanRatio < 0.5 ? 1 : 0) +
    (hungerRatio < 0.2 ? 2 : hungerRatio < 0.5 ? 1 : 0)
  if (value === 0) return 0
  if (input.busy) value += 2
  const relief =
    input.level < 10
      ? input.strong > 500
        ? 2
        : 0
      : input.strong > 50000
        ? 4
        : input.strong > 5000
          ? 2
          : 0
  return Math.max(0, value - relief)
}

/** 0..20 luck derived from VIP, charm, intelligence and fatigue. */
export function luck(input: LuckInput): number {
  let value = 1 + (input.pinkDiamond ? input.PDiamondLevel * 2 : 0) + (input.sweetHeart ? 2 : 0)
  value += [500, 5000, 50000].filter(threshold => input.charm > threshold).length
  value += [800, 8000, 80000].filter(threshold => input.intel > threshold).length
  return Math.min(Math.max(0, value - (input.fatigue >> 1)), 20)
}

/** Health repair rules from the renderer's health-change guard. */
export function clampHealth(health: number): number {
  if (Number.isNaN(health) || health < 0) return 0
  if (health > 5) return 5
  return health
}
