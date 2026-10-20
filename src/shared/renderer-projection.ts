import type { PetInfo, SaveData, SavePatch, Settings } from './save'
import type { JsonObject } from './pet-runtime/types'
import type { RendererProjection } from './renderer-api'
import {
  DEVICE_LOCAL_SETTINGS_KEYS,
  DEVICE_ONLY_PET_INFO_KEYS,
  PRESENTATION_ONLY_SAVE_JSON_KEYS,
  SHARED_SAVE_JSON_KEYS,
  SHARED_SETTINGS_KEYS,
  type DeviceLocalOverlay,
  type DeviceLocalSettings,
} from './sync/data-boundary'

export interface InfoChange {
  key: keyof PetInfo
  previous: unknown
}

export interface SaveHydrationResult {
  infoChanges: InfoChange[]
  settingsChanges: Partial<Settings>
  changedJsonKeys: string[]
  sharedChanged: boolean
}

export interface LocalOverlayApplyResult {
  infoChanges: InfoChange[]
  settingsChanges: Partial<Settings>
}

export interface SavePatchClassification {
  canonicalKeys: (keyof SaveData)[]
  localPetInfo: Partial<Pick<PetInfo, 'lastX' | 'lastY'>>
  localSettings: Partial<DeviceLocalSettings>
  presentation: JsonObject
}

export class CanonicalMutationBlockedError extends Error {
  readonly keys: (keyof SaveData)[]
  constructor(keys: readonly (keyof SaveData)[]) {
    super('canonical gameplay mutation is blocked in runtime projection mode: ' + keys.join(', '))
    this.name = 'CanonicalMutationBlockedError'
    this.keys = [...keys]
  }
}

const SHARED_JSON = new Set<string>(SHARED_SAVE_JSON_KEYS)
const PRESENTATION_JSON = new Set<string>(PRESENTATION_ONLY_SAVE_JSON_KEYS)
const LOCAL_SETTINGS = new Set<string>(DEVICE_LOCAL_SETTINGS_KEYS)
const LOCAL_PET_INFO = new Set<string>(DEVICE_ONLY_PET_INFO_KEYS)
const SHARED_SETTINGS = new Set<string>(SHARED_SETTINGS_KEYS)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (isPlainRecord(value) === false) throw new Error(name + ' must be an object')
  return value
}

/** Deletes removed keys and merges plain objects recursively; arrays and scalars are replaced. */
function mergeGroupInPlace(target: Record<string, unknown>, source: Record<string, unknown>): boolean {
  let changed = false
  for (const key of Object.keys(target)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) continue
    delete target[key]
    changed = true
  }
  for (const [key, next] of Object.entries(source)) {
    const current = target[key]
    if (isPlainRecord(current) && isPlainRecord(next)) {
      if (mergeGroupInPlace(current, next)) changed = true
      continue
    }
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      target[key] = next
      changed = true
    }
  }
  return changed
}

/** Field-by-field assignment for partial device patches; unlike hydration it never deletes absent keys. */
function assignGroupInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, next] of Object.entries(source)) {
    const current = target[key]
    if (isPlainRecord(current) && isPlainRecord(next)) {
      assignGroupInPlace(current, next)
    } else {
      target[key] = next
    }
  }
}

function diffInfo(previous: PetInfo, next: PetInfo): InfoChange[] {
  const changes: InfoChange[] = []
  for (const key of Object.keys(next) as (keyof PetInfo)[]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      changes.push({ key, previous: previous[key] })
    }
  }
  return changes
}

function diffSettings(previous: Settings, next: Settings): Partial<Settings> {
  const changes: Record<string, unknown> = {}
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key]
  }
  return changes as Partial<Settings>
}

function diffJsonData(previous: Record<string, string>, next: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  return [...keys].filter(key => previous[key] !== next[key]).sort()
}

/**
 * Hydrates a renderer SaveData from an authoritative projection without
 * replacing the save, petInfo or settings object references. Canonical group
 * objects merge in place; arrays/scalars are replaced. Local-only
 * saveJsonData presentation caches survive a projection.
 */
export function hydrateSaveProjection(save: SaveData, projection: RendererProjection): SaveHydrationResult {
  const previousInfo = { ...save.petInfo }
  const previousSettings = { ...save.settings }
  const previousJson = { ...save.saveJsonData }
  const next = projection.save
  const target = save as unknown as Record<string, unknown>
  const source = next as unknown as Record<string, unknown>
  const localOnlyJson: Record<string, string> = {}
  for (const key of Object.keys(previousJson)) {
    if (SHARED_JSON.has(key) === false) localOnlyJson[key] = previousJson[key]
  }
  const nextJson: Record<string, string> = { ...localOnlyJson, ...next.saveJsonData }

  let sharedChanged = false
  const keys = new Set([...Object.keys(target), ...Object.keys(source)])
  for (const key of keys) {
    if (key === 'petInfo' || key === 'settings' || key === 'saveJsonData') continue
    const current = target[key]
    const incoming = source[key]
    if (incoming === undefined) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        delete target[key]
        sharedChanged = true
      }
      continue
    }
    if (isPlainRecord(current) && isPlainRecord(incoming)) {
      if (mergeGroupInPlace(current, incoming)) sharedChanged = true
      continue
    }
    if (JSON.stringify(current) !== JSON.stringify(incoming)) {
      target[key] = incoming
      sharedChanged = true
    }
  }

  mergeGroupInPlace(save.petInfo as unknown as Record<string, unknown>, next.petInfo as unknown as Record<string, unknown>)
  mergeGroupInPlace(save.settings as unknown as Record<string, unknown>, next.settings as unknown as Record<string, unknown>)
  mergeGroupInPlace(save.saveJsonData as unknown as Record<string, unknown>, nextJson)

  const infoChanges = diffInfo(previousInfo, save.petInfo)
  const settingsChanges = diffSettings(previousSettings, save.settings)
  const changedJsonKeys = diffJsonData(previousJson, save.saveJsonData)
  const canonicalInfoChanged = infoChanges.some(change => LOCAL_PET_INFO.has(change.key) === false)
  const canonicalSettingsChanged = Object.keys(settingsChanges).some(key => SHARED_SETTINGS.has(key))
  const canonicalJsonChanged = changedJsonKeys.some(key => SHARED_JSON.has(key))
  return {
    infoChanges,
    settingsChanges,
    changedJsonKeys,
    sharedChanged: sharedChanged || canonicalInfoChanged || canonicalSettingsChanged || canonicalJsonChanged,
  }
}

/** Applies the device-only portion of a projection after an overlay update. */
export function applyLocalOverlayInPlace(
  save: SaveData,
  overlay: { petInfo?: Partial<DeviceLocalOverlay['petInfo']>; settings?: Partial<DeviceLocalSettings> },
): LocalOverlayApplyResult {
  const previousInfo = { ...save.petInfo }
  const previousSettings = { ...save.settings }
  if (overlay.petInfo !== undefined) {
    assignGroupInPlace(save.petInfo as unknown as Record<string, unknown>, overlay.petInfo as Record<string, unknown>)
  }
  if (overlay.settings !== undefined) {
    assignGroupInPlace(save.settings as unknown as Record<string, unknown>, overlay.settings as Record<string, unknown>)
  }
  return {
    infoChanges: diffInfo(previousInfo, save.petInfo),
    settingsChanges: diffSettings(previousSettings, save.settings),
  }
}

/** Applies device-only presentation strings (community position, prose, ...) to the local cache. */
export function applyPresentationInPlace(save: SaveData, presentation: JsonObject): void {
  for (const [key, value] of Object.entries(presentation)) {
    if (typeof value === 'string') save.saveJsonData[key] = value
  }
}

/**
 * Splits a legacy SavePatch into device-only and canonical portions. Canonical
 * keys are returned for the caller to reject; they must never be applied in
 * runtime projection mode.
 */
export function classifySavePatch(patch: SavePatch): SavePatchClassification {
  const record = requireRecord(patch, 'save patch')
  const result: SavePatchClassification = {
    canonicalKeys: [],
    localPetInfo: {},
    localSettings: {},
    presentation: {},
  }
  const canonical = new Set<keyof SaveData>()
  for (const [key, value] of Object.entries(record)) {
    if (key === 'petInfo') {
      const group = requireRecord(value, 'save.petInfo')
      for (const [field, fieldValue] of Object.entries(group)) {
        if (LOCAL_PET_INFO.has(field)) {
          if (typeof fieldValue !== 'number' || Number.isFinite(fieldValue) === false) {
            throw new Error('save.petInfo.' + field + ' must be a finite number')
          }
          ;(result.localPetInfo as Record<string, number>)[field] = fieldValue
        } else {
          canonical.add('petInfo')
        }
      }
      continue
    }
    if (key === 'settings') {
      const group = requireRecord(value, 'save.settings')
      for (const [field, fieldValue] of Object.entries(group)) {
        if (LOCAL_SETTINGS.has(field) === false) {
          canonical.add('settings')
          continue
        }
        ;(result.localSettings as Record<string, unknown>)[field] = fieldValue
      }
      continue
    }
    if (key === 'saveJsonData') {
      const group = requireRecord(value, 'save.saveJsonData')
      for (const [field, fieldValue] of Object.entries(group)) {
        if (PRESENTATION_JSON.has(field) && typeof fieldValue === 'string') {
          result.presentation[field] = fieldValue
        } else {
          canonical.add('saveJsonData')
        }
      }
      continue
    }
    canonical.add(key as keyof SaveData)
  }
  result.canonicalKeys = [...canonical]
  return result
}

export function assertDeviceLocalSavePatch(patch: SavePatch): SavePatchClassification {
  const classification = classifySavePatch(patch)
  if (classification.canonicalKeys.length > 0) {
    throw new CanonicalMutationBlockedError(classification.canonicalKeys)
  }
  return classification
}
