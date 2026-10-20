import type { PetInfo, SaveData, Settings } from '../save'
import type { JsonObject } from '../pet-runtime/types'
import { assertJsonSafe } from '../pet-runtime/serialization'
import {
  assertOnlyKeys,
  assertRequiredKeys,
  failSchema,
  isEnum,
  isNonEmptyString,
  requireJsonObject,
  requireJsonValue,
  requireRecord,
} from './schema'

export const SHARED_SETTINGS_KEYS = ['paused', 'difficulty', 'undying'] as const
export type SharedSettings = Pick<Settings, (typeof SHARED_SETTINGS_KEYS)[number]>
export type SharedPetInfo = Omit<PetInfo, 'lastX' | 'lastY'>

export interface SharedSaveData extends Omit<SaveData, 'petInfo' | 'settings'> {
  petInfo: SharedPetInfo
  settings: SharedSettings
}

export type DeviceLocalSettings = Omit<Settings, keyof SharedSettings>

export interface DeviceLocalOverlay {
  /** Stable local UUID; provenance/rebinding only, never server command authority. */
  localDeviceId: string
  petInfo: Pick<PetInfo, 'lastX' | 'lastY'>
  settings: DeviceLocalSettings
  /** Local-only presentation caches, e.g. community position, not canonical. */
  presentation?: JsonObject
}

export const SHARED_PET_INFO_KEYS = [
  'name', 'host', 'sex', 'growth', 'hunger', 'clean', 'health', 'mood', 'birthDay',
  'intel', 'charm', 'strong', 'onLineTime', 'yb', 'lastLoginTime', 'onlineDataTime',
  'pinkDiamond', 'PDgrowth', 'PDgrowthValue', 'PDgrowthValue_next', 'PDiamondLevel',
  'PDiamondBeginDate', 'PDiamondExpirationDate', 'PDiamondYear', 'sweetHeart',
  'sweetHeartOverTime',
] as const
export const DEVICE_ONLY_PET_INFO_KEYS = ['lastX', 'lastY'] as const

export const DEVICE_LOCAL_SETTINGS_KEYS = [
  'opacity', 'music', 'sound', 'faceClick', 'quiet', 'autoStart', 'hidden', 'hd', 'zoom',
  'windowDirection', 'clip', 'watchApp', 'roam', 'lan', 'webhook', 'webhookPort',
  'webhookToken', 'voice', 'memory', 'polish', 'search', 'searchBackend', 'searchKey',
  'petBar', 'chatCheat', 'cheatTab', 'aiUrl', 'aiKey', 'aiModel', 'weatherCity',
  'autoUpdate', 'updateCheckedAt', 'petDisplayId',
] as const satisfies readonly (keyof DeviceLocalSettings)[]

export const SESSION_ANSWER_KEY_FIELDS = ['answerIndex', 'answerKey', 'answerKeys'] as const

export const NEVER_UPLOAD_SETTING_KEYS = ['aiKey', 'searchKey', 'webhookToken'] as const
export const NEVER_UPLOAD_KEYS = [
  ...NEVER_UPLOAD_SETTING_KEYS,
  'token', 'tokenHash', 'pairingCode', 'privateKey', 'tlsPrivateKey', 'credential', 'credentials',
  'machineId', 'oId', 'filePath', 'serverToken', 'deviceToken', 'authToken', 'refreshToken',
] as const

export const SHARED_SAVE_JSON_KEYS = [
  'email', 'task', 'signin', 'fishs', 'farm', 'activity', 'album', 'island',
] as const

export const PRESENTATION_ONLY_SAVE_JSON_KEYS = ['community', 'weather'] as const

export const SHARED_SAVE_KEYS = [
  'havePet', 'isBury', 'saveNum', 'nowTimeLine', 'petInfo', 'petComputedlInfo',
  'studyInfo', 'activeOption', 'selfGoodDatas', 'selfGoodUseOption', 'gameSaveDatas',
  'illustrated', 'saveJsonData', 'settings',
] as const

type AssertNoRemainingKeys<T extends never> = T

export type SharedPetInfoAllowlistComplete =
  AssertNoRemainingKeys<Exclude<keyof SharedPetInfo, (typeof SHARED_PET_INFO_KEYS)[number]>>
export type SharedSaveAllowlistComplete =
  AssertNoRemainingKeys<Exclude<keyof SharedSaveData, (typeof SHARED_SAVE_KEYS)[number]>>
export type DeviceLocalSettingsAllowlistComplete =
  AssertNoRemainingKeys<Exclude<keyof DeviceLocalSettings, (typeof DEVICE_LOCAL_SETTINGS_KEYS)[number]>>

export const SHARED_ALLOWLIST = {
  petInfo: SHARED_PET_INFO_KEYS,
  settings: SHARED_SETTINGS_KEYS,
  saveJsonData: SHARED_SAVE_JSON_KEYS,
} as const

export const DEVICE_LOCAL_ALLOWLIST = {
  petInfo: DEVICE_ONLY_PET_INFO_KEYS,
  settings: DEVICE_LOCAL_SETTINGS_KEYS,
} as const

const DEVICE_LOCAL_BOOLEAN_KEYS = [
  'sound', 'quiet', 'autoStart', 'hidden', 'hd', 'clip', 'watchApp', 'roam', 'lan',
  'webhook', 'voice', 'memory', 'polish', 'search', 'petBar', 'chatCheat', 'cheatTab', 'autoUpdate',
] as const
const DEVICE_LOCAL_NUMBER_KEYS = ['opacity', 'music', 'zoom', 'webhookPort', 'updateCheckedAt'] as const
const DEVICE_LOCAL_STRING_KEYS = ['webhookToken', 'searchKey', 'aiUrl', 'aiKey', 'aiModel', 'weatherCity'] as const

const PET_INFO_NUMBER_KEYS = [
  'growth', 'hunger', 'clean', 'health', 'mood', 'birthDay', 'intel', 'charm', 'strong',
  'onLineTime', 'yb', 'lastLoginTime', 'onlineDataTime', 'PDgrowth', 'PDgrowthValue',
  'PDgrowthValue_next', 'PDiamondLevel', 'PDiamondBeginDate', 'PDiamondExpirationDate',
  'sweetHeartOverTime',
] as const
const PET_INFO_BOOLEAN_KEYS = ['pinkDiamond', 'PDiamondYear', 'sweetHeart'] as const
const NEVER_UPLOAD_SET = new Set<string>(NEVER_UPLOAD_KEYS)

export function isNeverUploadKey(key: string): boolean {
  return NEVER_UPLOAD_SET.has(key)
}

export function pickSharedSettings(settings: Settings): SharedSettings {
  return {
    paused: settings.paused,
    difficulty: settings.difficulty,
    undying: settings.undying,
  }
}

export function pickDeviceLocalSettings(settings: Settings): DeviceLocalSettings {
  const local: Record<string, unknown> = {}
  for (const key of DEVICE_LOCAL_SETTINGS_KEYS) local[key] = settings[key]
  return local as DeviceLocalSettings
}

export function toSharedSaveData(save: SaveData): SharedSaveData {
  const petInfo: Record<string, unknown> = { ...save.petInfo }
  delete petInfo.lastX
  delete petInfo.lastY
  const saveJsonData: Record<string, string> = {}
  for (const key of SHARED_SAVE_JSON_KEYS) {
    const value = save.saveJsonData[key]
    if (value !== undefined) saveJsonData[key] = value
  }
  const shared = {
    ...save,
    petInfo: petInfo as unknown as SharedPetInfo,
    settings: pickSharedSettings(save.settings),
    saveJsonData,
  }
  assertSharedSaveData(shared)
  return shared
}

export function toDeviceLocalOverlay(
  save: SaveData,
  localDeviceId: string,
  presentation?: JsonObject,
): DeviceLocalOverlay {
  const overlay: DeviceLocalOverlay = {
    localDeviceId,
    petInfo: { lastX: save.petInfo.lastX, lastY: save.petInfo.lastY },
    settings: pickDeviceLocalSettings(save.settings),
  }
  if (presentation !== undefined) overlay.presentation = presentation
  assertDeviceLocalOverlay(overlay)
  return overlay
}

function assertPetInfo(value: unknown, path: string): asserts value is SharedPetInfo {
  requireRecord(value, path)
  assertRequiredKeys(value, SHARED_PET_INFO_KEYS, path)
  assertOnlyKeys(value, SHARED_PET_INFO_KEYS, path)
  if (typeof value.name !== 'string' || typeof value.host !== 'string') failSchema('invalid_schema', path, 'invalid pet name')
  if (isEnum(value.sex, ['GG', 'MM'] as const) === false) failSchema('invalid_schema', path + '.sex', 'invalid sex')
  for (const key of PET_INFO_NUMBER_KEYS) {
    if (typeof value[key] !== 'number' || Number.isFinite(value[key] as number) === false) {
      failSchema('invalid_schema', path + '.' + key, 'expected a finite number')
    }
  }
  for (const key of PET_INFO_BOOLEAN_KEYS) {
    if (typeof value[key] !== 'boolean') failSchema('invalid_schema', path + '.' + key, 'expected a boolean')
  }
}

function assertSharedSettings(value: unknown, path: string): asserts value is SharedSettings {
  requireRecord(value, path)
  assertRequiredKeys(value, SHARED_SETTINGS_KEYS, path)
  assertOnlyKeys(value, SHARED_SETTINGS_KEYS, path)
  if (typeof value.paused !== 'boolean') failSchema('invalid_schema', path + '.paused', 'expected a boolean')
  if (isEnum(value.difficulty, ['easy', 'standard'] as const) === false) {
    failSchema('invalid_schema', path + '.difficulty', 'invalid difficulty')
  }
  if (typeof value.undying !== 'boolean') failSchema('invalid_schema', path + '.undying', 'expected a boolean')
}

/** Rejects answer-key material from canonical shared snapshots and wire projections. */
export function assertNoSessionAnswerKeys(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertNoSessionAnswerKeys(value[index], path + '[' + index + ']')
    return
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if ((SESSION_ANSWER_KEY_FIELDS as readonly string[]).includes(key)) {
      failSchema('forbidden_field', path + '.' + key, 'session answer keys are forbidden in shared projections')
    }
    assertNoSessionAnswerKeys(record[key], path + '.' + key)
  }
}

/** Rejects any key that must never leave the device, at any nesting depth. */
export function assertNoNeverUpload(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertNoNeverUpload(value[index], path + '[' + index + ']')
    return
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (isNeverUploadKey(key)) failSchema('forbidden_field', path + '.' + key, 'never-upload field is forbidden')
    assertNoNeverUpload(record[key], path + '.' + key)
  }
}

/** Defense-in-depth projection filter for values crossing the wire boundary. */
export function filterNeverUpload<T>(value: T): T {
  const filter = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current
    if (Array.isArray(current)) return current.map(filter)
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(current)) {
      if (isNeverUploadKey(key)) continue
      Object.defineProperty(output, key, {
        value: filter((current as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return output
  }
  return filter(value) as T
}

export function assertSharedSaveData(value: unknown): asserts value is SharedSaveData {
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'shared save is not JSON-safe'
    failSchema('invalid_schema', '$.shared', message)
  }
  requireJsonValue(value, '$.shared')
  requireRecord(value, '$.shared')
  assertRequiredKeys(value, SHARED_SAVE_KEYS, '$.shared')
  assertOnlyKeys(value, SHARED_SAVE_KEYS, '$.shared')
  assertNoNeverUpload(value, '$.shared')
  assertNoSessionAnswerKeys(value, '$.shared')
  assertPetInfo(value.petInfo, '$.shared.petInfo')
  assertSharedSettings(value.settings, '$.shared.settings')
  requireRecord(value.saveJsonData, '$.shared.saveJsonData')
  assertOnlyKeys(value.saveJsonData, SHARED_SAVE_JSON_KEYS, '$.shared.saveJsonData')
  for (const [key, blob] of Object.entries(value.saveJsonData)) {
    if (typeof blob !== 'string') failSchema('invalid_schema', '$.shared.saveJsonData.' + key, 'expected a JSON string')
    try {
      JSON.parse(blob)
    } catch {
      failSchema('invalid_schema', '$.shared.saveJsonData.' + key, 'expected valid JSON text')
    }
  }
}

export function isSharedSaveData(value: unknown): value is SharedSaveData {
  try {
    assertSharedSaveData(value)
    return true
  } catch {
    return false
  }
}

export const validateSharedSaveData = isSharedSaveData

export function assertDeviceLocalOverlay(value: unknown): asserts value is DeviceLocalOverlay {
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'device overlay is not JSON-safe'
    failSchema('invalid_schema', '$.device', message)
  }
  requireJsonValue(value, '$.device')
  requireRecord(value, '$.device')
  assertRequiredKeys(value, ['localDeviceId', 'petInfo', 'settings'], '$.device')
  assertOnlyKeys(value, ['localDeviceId', 'petInfo', 'settings', 'presentation'], '$.device')
  if (isNonEmptyString(value.localDeviceId) === false) {
    failSchema('invalid_schema', '$.device.localDeviceId', 'expected a non-empty local device id')
  }
  requireRecord(value.petInfo, '$.device.petInfo')
  assertRequiredKeys(value.petInfo, DEVICE_ONLY_PET_INFO_KEYS, '$.device.petInfo')
  assertOnlyKeys(value.petInfo, DEVICE_ONLY_PET_INFO_KEYS, '$.device.petInfo')
  for (const key of DEVICE_ONLY_PET_INFO_KEYS) {
    if (typeof value.petInfo[key] !== 'number' || Number.isFinite(value.petInfo[key] as number) === false) {
      failSchema('invalid_schema', '$.device.petInfo.' + key, 'expected a finite number')
    }
  }
  requireRecord(value.settings, '$.device.settings')
  assertRequiredKeys(value.settings, DEVICE_LOCAL_SETTINGS_KEYS, '$.device.settings')
  assertOnlyKeys(value.settings, DEVICE_LOCAL_SETTINGS_KEYS, '$.device.settings')
  for (const key of DEVICE_LOCAL_BOOLEAN_KEYS) {
    if (typeof value.settings[key] !== 'boolean') failSchema('invalid_schema', '$.device.settings.' + key, 'expected a boolean')
  }
  for (const key of DEVICE_LOCAL_NUMBER_KEYS) {
    if (typeof value.settings[key] !== 'number' || Number.isFinite(value.settings[key] as number) === false) {
      failSchema('invalid_schema', '$.device.settings.' + key, 'expected a finite number')
    }
  }
  for (const key of DEVICE_LOCAL_STRING_KEYS) {
    if (typeof value.settings[key] !== 'string') failSchema('invalid_schema', '$.device.settings.' + key, 'expected a string')
  }
  if (value.settings.faceClick !== 0 && value.settings.faceClick !== 1 && value.settings.faceClick !== 2) {
    failSchema('invalid_schema', '$.device.settings.faceClick', 'expected 0, 1 or 2')
  }
  if (value.settings.windowDirection !== 'auto' && value.settings.windowDirection !== 'screen') {
    failSchema('invalid_schema', '$.device.settings.windowDirection', 'invalid window direction')
  }
  if (value.settings.searchBackend !== 'auto' && value.settings.searchBackend !== 'tavily' && value.settings.searchBackend !== 'brave') {
    failSchema('invalid_schema', '$.device.settings.searchBackend', 'invalid search backend')
  }
  if (value.settings.petDisplayId !== null && typeof value.settings.petDisplayId !== 'number') {
    failSchema('invalid_schema', '$.device.settings.petDisplayId', 'expected a number or null')
  }
  if (value.presentation !== undefined) requireJsonObject(value.presentation, '$.device.presentation')
}

export function isDeviceLocalOverlay(value: unknown): value is DeviceLocalOverlay {
  try {
    assertDeviceLocalOverlay(value)
    return true
  } catch {
    return false
  }
}

export const validateDeviceLocalOverlay = isDeviceLocalOverlay
