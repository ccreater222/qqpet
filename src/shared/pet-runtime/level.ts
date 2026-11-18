export type Stage = 'Egg' | 'Kid' | 'Adult'

export interface LevelProgress {
  level: number
  upGrowth: number
  nextGrowth: number
}

export interface LevelAndCaps extends LevelProgress {
  hungerMax: number
  cleanMax: number
}

/**
 * Growth required to leave level `level`, matching the original
 * getLevelRequirement curve.
 */
export function growthNeededForLevel(level: number): number {
  return 100 * level + (25 * level * (level + 1) * (2 * level + 1)) / 6
}

/** Pure parity extraction of the renderer's level selector. */
export function levelOf(growth: number): LevelProgress {
  let level = 1
  while (growth >= growthNeededForLevel(level)) {
    level++
    if (level > 1_000_000) throw new RangeError('growth is too large to resolve a level')
  }
  return { level, upGrowth: growthNeededForLevel(level - 1), nextGrowth: growthNeededForLevel(level) }
}

/** Hunger and clean caps at a level. */
export function statCapForLevel(level: number): number {
  return 1000 + Math.min(level, 70) * 100
}

/** Combined selector used when a runtime recomputes level and stat caps. */
export function levelAndCapsOf(growth: number): LevelAndCaps {
  const progress = levelOf(growth)
  const cap = statCapForLevel(progress.level)
  return { ...progress, hungerMax: cap, cleanMax: cap }
}

export function stageOf(level: number): Stage {
  return level >= 16 ? 'Adult' : level >= 5 ? 'Kid' : 'Egg'
}
