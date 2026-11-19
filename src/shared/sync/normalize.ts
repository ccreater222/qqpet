import { isRecord } from './schema'

/**
 * Canonical group defaults an older save or a third-party bundle may predate.
 * Values mirror `emptyEggSave` (handlers-a) and `save-logic`'s repair rules so a
 * normalized snapshot behaves exactly like a freshly written one.
 */
const PET_COMPUTED_INFO_DEFAULTS: Record<string, unknown> = {
  level: 1, upGrowth: 0, nextGrowth: 125, hungerMax: 1100, cleanMax: 1100, healthMax: 5, moodMax: 1000,
}
const STUDY_INFO_DEFAULTS: Record<string, unknown> = {
  chinese: 0, mathematics: 0, politics: 0, music: 0, art: 0, manner: 0, pe: 0, labouring: 0, wushu: 0,
}
const ACTIVE_OPTION_DEFAULTS: Record<string, unknown> = {
  work: null, study: null, trip: null, ill: null, die: null,
}
const SELF_GOOD_DATAS_DEFAULTS: Record<string, unknown> = {
  food: [], clean: [], medicine: [], background: [], toy: [], nums: [], service: [], work: [], study: [], trip: [],
}
const SELF_GOOD_USE_OPTION_DEFAULTS: Record<string, unknown> = {
  background: null, food: null, clean: null, toy: null,
}
const GAME_SAVE_DATAS_DEFAULTS: Record<string, unknown> = {
  fishing_harvestfish: 0, travel_china: [], travel_china_num: 0, ddw: 0, yyds: 0,
}

function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => cloneDefault(entry))
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneDefault(entry)
    return copy
  }
  return value
}

/**
 * Fills a canonical group member by member. A missing (undefined) member is restored to its
 * default; a member present as null is restored only when the default is not itself null.
 * Existing non-null values are never rewritten, and a non-object group is left untouched so the
 * shared schema still rejects it.
 */
function fillGroup(
  target: Record<string, unknown>,
  group: string,
  defaults: Record<string, unknown>,
  filled: string[],
): void {
  const current = target[group]
  if (current === undefined || current === null) {
    target[group] = cloneDefault(defaults)
    filled.push(group)
    return
  }
  if (isRecord(current) === false) return
  for (const [member, defaultValue] of Object.entries(defaults)) {
    const entry = current[member]
    if (entry === undefined) {
      current[member] = cloneDefault(defaultValue)
      filled.push(group + '.' + member)
    } else if (entry === null && defaultValue !== null) {
      current[member] = cloneDefault(defaultValue)
      filled.push(group + '.' + member)
    }
  }
}

function fillArrayGroup(target: Record<string, unknown>, group: string, filled: string[]): void {
  const current = target[group]
  if (current === undefined || current === null) {
    target[group] = []
    filled.push(group)
  }
}

/**
 * In-place canonical default fill for a shared save snapshot (legacy save or bundle payload).
 * Only absent/null nested group members are created: `petInfo`, `settings`, the top-level required
 * keys and `saveJsonData` are never touched, so migration/import validation still rejects a save
 * whose required structure is missing. Missing blob keys are deliberately left alone: every
 * runtime reader falls back on them, and filling them would change byte-identical round-trips.
 * Returns the dotted paths that were filled (for tests/logs).
 */
export function normalizeSharedSaveDefaults(value: unknown): string[] {
  if (isRecord(value) === false) return []
  const filled: string[] = []
  fillGroup(value, 'petComputedlInfo', PET_COMPUTED_INFO_DEFAULTS, filled)
  fillGroup(value, 'studyInfo', STUDY_INFO_DEFAULTS, filled)
  fillGroup(value, 'activeOption', ACTIVE_OPTION_DEFAULTS, filled)
  fillGroup(value, 'selfGoodDatas', SELF_GOOD_DATAS_DEFAULTS, filled)
  fillGroup(value, 'selfGoodUseOption', SELF_GOOD_USE_OPTION_DEFAULTS, filled)
  fillGroup(value, 'gameSaveDatas', GAME_SAVE_DATAS_DEFAULTS, filled)
  fillArrayGroup(value, 'illustrated', filled)
  return filled
}
