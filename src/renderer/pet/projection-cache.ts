export type ProjectionFeature = 'tasks' | 'signin' | 'fishing' | 'island' | 'farm'

export interface ProjectionCacheInvalidation {
  /** A full snapshot/resync: every feature cache is stale. */
  full?: boolean
  changedJsonKeys?: readonly string[]
  eventTypes?: readonly string[]
}

const FEATURES: readonly ProjectionFeature[] = ['tasks', 'signin', 'fishing', 'island', 'farm']

const JSON_KEYS: Record<string, ProjectionFeature> = {
  task: 'tasks',
  signin: 'signin',
  fishs: 'fishing',
  island: 'island',
  farm: 'farm',
}

const EVENT_PREFIXES: readonly [string, ProjectionFeature][] = [
  ['task.', 'tasks'],
  ['signin.', 'signin'],
  ['fishing.', 'fishing'],
  ['island.', 'island'],
  ['farm.', 'farm'],
]

const invalidators = new Map<ProjectionFeature, Set<() => void>>()

/** Registers a module-local parsed-cache reset hook. Returns an unsubscribe function. */
export function registerProjectionCacheInvalidator(feature: ProjectionFeature, invalidate: () => void): () => void {
  const set = invalidators.get(feature) ?? new Set<() => void>()
  set.add(invalidate)
  invalidators.set(feature, set)
  return () => {
    set.delete(invalidate)
    if (set.size === 0) invalidators.delete(feature)
  }
}

function featuresFor(input: ProjectionCacheInvalidation): Set<ProjectionFeature> {
  const features = new Set<ProjectionFeature>()
  if (input.full === true) {
    for (const feature of FEATURES) features.add(feature)
    return features
  }
  for (const key of input.changedJsonKeys ?? []) {
    const feature = JSON_KEYS[key]
    if (feature !== undefined) features.add(feature)
  }
  for (const type of input.eventTypes ?? []) {
    const feature = EVENT_PREFIXES.find(([prefix]) => type.startsWith(prefix))?.[1]
    if (feature !== undefined) features.add(feature)
  }
  return features
}

/** Invalidates only affected parsed-game caches and returns the features that fired. */
export function invalidateProjectionCaches(input: ProjectionCacheInvalidation): ProjectionFeature[] {
  const features = [...featuresFor(input)]
  for (const feature of features) {
    for (const invalidate of invalidators.get(feature) ?? []) invalidate()
  }
  return features
}

/** Test/static helper: number of registered hooks for a feature. */
export function projectionCacheHookCount(feature: ProjectionFeature): number {
  return invalidators.get(feature)?.size ?? 0
}
