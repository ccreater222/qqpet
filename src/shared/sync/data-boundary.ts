import type { PetInfo, SaveData, Settings } from '../save'
import type { JsonObject } from '../pet-runtime/types'
import { assertJsonSafe, stableStringify } from '../pet-runtime/serialization'
import {
  assertOnlyKeys,
  assertRequiredKeys,
  failSchema,
  isEnum,
  isNonEmptyString,
  isNonNegativeIntegerArray,
  isNumberArray,
  isStringArray,
  requireBoolean,
  requireFiniteNumber,
  requireJsonObject,
  requireJsonValue,
  requireNonNegativeInteger,
  requireRecord,
  requireString,
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
  const saveJsonData = filterSharedSaveJsonData(save.saveJsonData)
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

/** Defense-in-depth projection filter: recursively removes never-upload keys, including inside nested JSON strings. */
export function filterNeverUpload<T>(value: T): T {
  const filter = (current: unknown, jsonDepth: number): unknown => {
    if (typeof current === 'string') {
      const parsed = parseEmbeddedJsonString(current)
      if (parsed === NO_EMBEDDED_JSON) return current
      const hit = findForbiddenJsonKey(parsed, { includeSessionAnswerKeys: false })
      if (hit === null) return current
      if (hit.kind === 'nested_json_depth' || jsonDepth >= MAX_NESTED_JSON_DEPTH) {
        failSchema('invalid_schema', '$', 'nested JSON string exceeds the maximum filtering depth')
      }
      return JSON.stringify(filter(parsed, jsonDepth + 1))
    }
    if (current === null || typeof current !== 'object') return current
    if (Array.isArray(current)) return current.map(entry => filter(entry, jsonDepth))
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(current)) {
      if (isNeverUploadKey(key)) continue
      Object.defineProperty(output, key, {
        value: filter((current as Record<string, unknown>)[key], jsonDepth),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return output
  }
  return filter(value, 0) as T
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
  assertNoForbiddenJsonKey(value, '$.shared')
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
    assertCanonicalSaveJsonBlob(key, blob, '$.shared.saveJsonData.' + key)
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

export type SharedSaveJsonKey = (typeof SHARED_SAVE_JSON_KEYS)[number]
export type ForbiddenJsonKeyKind = 'never_upload' | 'session_answer_key' | 'nested_json_depth'

export interface ForbiddenJsonKeyHit {
  kind: ForbiddenJsonKeyKind
  path: string
  key?: string
}

export interface ForbiddenJsonKeyScanOptions {
  includeNeverUpload?: boolean
  includeSessionAnswerKeys?: boolean
  maxNestedJsonDepth?: number
}

export const MAX_NESTED_JSON_DEPTH = 4

const NO_EMBEDDED_JSON = Symbol('no-embedded-json')
const SESSION_ANSWER_KEY_SET = new Set<string>(SESSION_ANSWER_KEY_FIELDS)
const SHARED_SAVE_JSON_KEY_SET = new Set<string>(SHARED_SAVE_JSON_KEYS)
const PRESENTATION_SAVE_JSON_KEY_SET = new Set<string>(PRESENTATION_ONLY_SAVE_JSON_KEYS)
const GOOD_BLOB_KEYS = [
  'PD', 'charm', 'classNum', 'classNumUp', 'clean', 'desc', 'education', 'group', 'hunger',
  'id', 'intel', 'mood', 'name', 'needLevel', 'num', 'object', 'outOfPrint', 'price', 'rectype',
  'school', 'strong', 'tolkName', 'type', 'url', 'useArtt', 'useId', 'useTime', 'useTimeing',
  'value', 'yb',
] as const
const GOOD_BLOB_NUMBER_KEYS = [
  'charm', 'classNum', 'classNumUp', 'clean', 'group', 'hunger', 'intel', 'mood', 'needLevel',
  'num', 'price', 'strong', 'useTimeing', 'value', 'yb',
] as const
const GOOD_BLOB_STRING_KEYS = ['desc', 'id', 'name', 'object', 'rectype', 'school', 'tolkName', 'type', 'url', 'useId', 'useTime'] as const
const GOOD_BLOB_BOOLEAN_KEYS = ['PD', 'outOfPrint'] as const
const EDUCATION_KEYS = ['chinese', 'mathematics', 'politics', 'music', 'art', 'manner', 'pe', 'labouring', 'wushu'] as const
const USE_ARTT_KEYS = ['intel', 'strong', 'charm'] as const
const TASK_COUNTERS = ['Amusing', 'Travel1', 'Eat', 'Clean', 'Toy', 'Work', 'Study', 'GameRound', 'Game', 'Travel2'] as const
const TASK_TABS = ['daily', 'ddw', 'growth', 'travel'] as const
const FISH_KEYS = [
  'id', 'fryid', 'name', 'stage', 'time', 'interval', 'costyb', 'YB', 'quantity', 'basequantity',
  'avatar', 'AIXIN', 'growth', 'strong', 'iq', 'charm', 'born', 'siLiao',
] as const
const FISH_NUMBER_KEYS = [
  'id', 'fryid', 'stage', 'time', 'interval', 'costyb', 'YB', 'quantity', 'basequantity',
  'avatar', 'AIXIN', 'growth', 'strong', 'iq', 'charm', 'born', 'siLiao',
] as const
const FARM_KEYS = ['house', 'kennel', 'fence', 'experience', 'rank', 'burden', 'warehouse', 'farmland', 'weather', 'username', 'wealth', 'checked'] as const
/** Mirrors UserInfo/farm writes in tools/qqfarm FarmMain, MyStore, FarmlandControl and InstallFace. */
const FARM_LAND_KEYS = [
  'farmland', 'crop', 'time', 'harvest', 'state', 'growth', 'progress', 'yield', 'grass', 'worm',
] as const
const FARM_BURDEN_KEYS = ['name', 'Items', 'number'] as const
const FARM_WAREHOUSE_KEYS = ['fruit', 'number', 'name', 'price'] as const
const ISLAND_CANONICAL_FIELDS = [
  'day', 'sent', 'letter', 'lit', 'lamps', 'tier', 'pieces', 'piece', 'want', 'loved',
  'errands', 'fought', 'wins',
] as const
const ISLAND_PRESENTATION_FIELDS = ['news', 'note'] as const
const ISLAND_ERRAND_FIELDS = ['from', 'kind', 'to', 'got', 'took'] as const
const ISLAND_ERRAND_PRESENTATION_FIELDS = ['ask'] as const
const ISLAND_ERRAND_KINDS = [
  'talk', 'bring', 'visit', 'chat', 'quiz', 'seek', 'play', 'care', 'time', 'spot', 'fight', 'tour',
  'chore', 'gift',
] as const

function isSharedSaveJsonKey(key: string): key is SharedSaveJsonKey {
  return SHARED_SAVE_JSON_KEY_SET.has(key)
}

function isPresentationOnlySaveJsonKey(key: string): boolean {
  return PRESENTATION_SAVE_JSON_KEY_SET.has(key)
}

function parseEmbeddedJsonString(value: string): unknown | typeof NO_EMBEDDED_JSON {
  const trimmed = value.trim()
  const first = trimmed[0]
  if (first !== '{' && first !== '[' && first !== '"') return NO_EMBEDDED_JSON
  try {
    return JSON.parse(trimmed)
  } catch {
    return NO_EMBEDDED_JSON
  }
}

/** Finds forbidden keys and answer keys in JSON data, including bounded nested JSON strings. */
export function findForbiddenJsonKey(
  value: unknown,
  options: ForbiddenJsonKeyScanOptions = {},
  path = '$',
  depth = 0,
): ForbiddenJsonKeyHit | null {
  const includeNeverUpload = options.includeNeverUpload ?? true
  const includeSessionAnswerKeys = options.includeSessionAnswerKeys ?? true
  const maxDepth = options.maxNestedJsonDepth ?? MAX_NESTED_JSON_DEPTH
  if (typeof value === 'string') {
    const parsed = parseEmbeddedJsonString(value)
    if (parsed === NO_EMBEDDED_JSON) return null
    if (depth >= maxDepth) return { kind: 'nested_json_depth', path }
    return findForbiddenJsonKey(parsed, options, path, depth + 1)
  }
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const hit = findForbiddenJsonKey(value[index], options, path + '[' + index + ']', depth)
      if (hit !== null) return hit
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (includeNeverUpload && isNeverUploadKey(key)) return { kind: 'never_upload', key, path: path + '.' + key }
    if (includeSessionAnswerKeys && SESSION_ANSWER_KEY_SET.has(key)) {
      return { kind: 'session_answer_key', key, path: path + '.' + key }
    }
    const hit = findForbiddenJsonKey(record[key], options, path + '.' + key, depth)
    if (hit !== null) return hit
  }
  return null
}

export function hasForbiddenJsonKey(value: unknown, options: ForbiddenJsonKeyScanOptions = {}): boolean {
  return findForbiddenJsonKey(value, options) !== null
}

export function assertNoForbiddenJsonKey(value: unknown, path = '$', options: ForbiddenJsonKeyScanOptions = {}): void {
  const hit = findForbiddenJsonKey(value, options, path)
  if (hit === null) return
  if (hit.kind === 'nested_json_depth') {
    failSchema('invalid_schema', hit.path, 'nested JSON string exceeds the maximum parsing depth')
  }
  failSchema('forbidden_field', hit.path, hit.kind + ' field is forbidden in canonical data')
}

function assertBlobObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): asserts value is Record<string, unknown> {
  requireRecord(value, path)
  assertRequiredKeys(value, requiredKeys, path)
  assertOnlyKeys(value, allowedKeys, path)
}

function assertBlobArray(value: unknown, path: string): asserts value is unknown[] {
  if (Array.isArray(value) === false) failSchema('invalid_schema', path, 'expected an array')
}

function assertOptionalStringField(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) requireString(record[key], path + '.' + key)
}

function assertOptionalFiniteNumberField(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) requireFiniteNumber(record[key], path + '.' + key)
}

function assertOptionalBooleanField(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) requireBoolean(record[key], path + '.' + key)
}

function assertOptionalNonNegativeIntegerField(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) requireNonNegativeInteger(record[key], path + '.' + key)
}

function assertNumericStringOrFiniteNumber(value: unknown, path: string): void {
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return
  failSchema('invalid_schema', path, 'expected a finite number or numeric string')
}

function assertSharedGoodBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, GOOD_BLOB_KEYS, ['id', 'name', 'type', 'url', 'num'])
  for (const key of GOOD_BLOB_STRING_KEYS) assertOptionalStringField(value, key, path)
  for (const key of GOOD_BLOB_NUMBER_KEYS) assertOptionalFiniteNumberField(value, key, path)
  for (const key of GOOD_BLOB_BOOLEAN_KEYS) assertOptionalBooleanField(value, key, path)
  requireNonNegativeInteger(value.num, path + '.num')
  if (value.education !== undefined) {
    assertBlobObject(value.education, path + '.education', EDUCATION_KEYS)
    for (const key of EDUCATION_KEYS) {
      if (value.education[key] !== undefined) requireFiniteNumber(value.education[key], path + '.education.' + key)
    }
  }
  if (value.useArtt !== undefined) {
    assertBlobObject(value.useArtt, path + '.useArtt', USE_ARTT_KEYS)
    for (const key of USE_ARTT_KEYS) {
      if (value.useArtt[key] !== undefined) requireFiniteNumber(value.useArtt[key], path + '.useArtt.' + key)
    }
  }
}

function assertSharedGoodArray(value: unknown, path: string): asserts value is unknown[] {
  assertBlobArray(value, path)
  value.forEach((good, index) => assertSharedGoodBlob(good, path + '[' + index + ']'))
}

function assertTaskDefinitionBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, ['label', 'msg', 'obj', 'num', 'keep', 'reroll', 'good'], ['label', 'msg', 'obj', 'num'])
  requireString(value.label, path + '.label')
  requireString(value.msg, path + '.msg')
  if (isEnum(value.obj, TASK_COUNTERS) === false) failSchema('invalid_schema', path + '.obj', 'unknown task counter')
  requireNonNegativeInteger(value.num, path + '.num')
  assertOptionalBooleanField(value, 'keep', path)
  assertOptionalNonNegativeIntegerField(value, 'reroll', path)
  if (value.good !== undefined) {
    if (isStringArray(value.good) === false) failSchema('invalid_schema', path + '.good', 'expected good strings')
  }
}

function assertTaskListEntryBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, ['take', 'good'], ['take', 'good'])
  requireBoolean(value.take, path + '.take')
  assertSharedGoodArray(value.good, path + '.good')
}

function assertTaskBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, ['doNums', 'taskList', 'daily', 'dailyDay'])
  if (value.doNums !== undefined) {
    assertBlobObject(value.doNums, path + '.doNums', TASK_COUNTERS)
    for (const [counter, count] of Object.entries(value.doNums)) {
      if (isEnum(counter, TASK_COUNTERS) === false) failSchema('forbidden_field', path + '.doNums.' + counter, 'unknown task counter')
      requireFiniteNumber(count, path + '.doNums.' + counter)
    }
  }
  if (value.taskList !== undefined) {
    assertBlobObject(value.taskList, path + '.taskList', TASK_TABS)
    for (const tab of TASK_TABS) {
      const entries = value.taskList[tab]
      if (entries === undefined) continue
      assertBlobArray(entries, path + '.taskList.' + tab)
      entries.forEach((entry, index) => assertTaskListEntryBlob(entry, path + '.taskList.' + tab + '[' + index + ']'))
    }
  }
  if (value.daily !== undefined) {
    assertBlobArray(value.daily, path + '.daily')
    value.daily.forEach((task, index) => assertTaskDefinitionBlob(task, path + '.daily[' + index + ']'))
  }
  assertOptionalFiniteNumberField(value, 'dailyDay', path)
}

function assertSigninBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, ['collectionList', 'getGrowth', 'onlineGiftNum', 'isOnlineLastTime', 'getBirthDayGift'])
  if (value.collectionList !== undefined) {
    requireRecord(value.collectionList, path + '.collectionList')
    for (const [year, months] of Object.entries(value.collectionList)) {
      if (/^\d{4}$/.test(year) === false) failSchema('forbidden_field', path + '.collectionList.' + year, 'invalid sign-in year key')
      requireRecord(months, path + '.collectionList.' + year)
      for (const [month, days] of Object.entries(months)) {
        if (/^(?:[1-9]|1[0-2])$/.test(month) === false) {
          failSchema('forbidden_field', path + '.collectionList.' + year + '.' + month, 'invalid sign-in month key')
        }
        if (isNonNegativeIntegerArray(days) === false) {
          failSchema('invalid_schema', path + '.collectionList.' + year + '.' + month, 'expected sign-in timestamps')
        }
      }
    }
  }
  if (value.getGrowth !== undefined && value.getGrowth !== null) {
    assertBlobArray(value.getGrowth, path + '.getGrowth')
    if (value.getGrowth.length !== 2) failSchema('invalid_schema', path + '.getGrowth', 'expected two growth draw slots')
    if (isNumberArray(value.getGrowth[0]) === false) failSchema('invalid_schema', path + '.getGrowth[0]', 'expected draw digits')
    const extra = value.getGrowth[1]
    if (extra !== null && isNumberArray(extra) === false) failSchema('invalid_schema', path + '.getGrowth[1]', 'expected draw digits or null')
  }
  assertOptionalNonNegativeIntegerField(value, 'onlineGiftNum', path)
  assertOptionalFiniteNumberField(value, 'isOnlineLastTime', path)
  assertOptionalBooleanField(value, 'getBirthDayGift', path)
}

function assertFishBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, FISH_KEYS, FISH_KEYS)
  requireString(value.name, path + '.name')
  for (const key of FISH_NUMBER_KEYS) requireFiniteNumber(value[key], path + '.' + key)
}

function assertPondBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, ['PD', 'fishs'])
  if (value.PD !== undefined) {
    assertBlobObject(value.PD, path + '.PD', ['allvipcnt', 'canusecnt'], ['allvipcnt', 'canusecnt'])
    requireNonNegativeInteger(value.PD.allvipcnt, path + '.PD.allvipcnt')
    requireNonNegativeInteger(value.PD.canusecnt, path + '.PD.canusecnt')
  }
  if (value.fishs !== undefined) {
    assertBlobArray(value.fishs, path + '.fishs')
    value.fishs.forEach((fish, index) => assertFishBlob(fish, path + '.fishs[' + index + ']'))
  }
}

function assertFarmLandBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, FARM_LAND_KEYS, ['farmland'])
  requireString(value.farmland, path + '.farmland')
  assertOptionalStringField(value, 'crop', path)
  assertOptionalFiniteNumberField(value, 'time', path)
  assertOptionalStringField(value, 'harvest', path)
  assertOptionalNonNegativeIntegerField(value, 'state', path)
  assertOptionalStringField(value, 'growth', path)
  assertOptionalFiniteNumberField(value, 'progress', path)
  assertOptionalFiniteNumberField(value, 'yield', path)
  assertOptionalFiniteNumberField(value, 'grass', path)
  assertOptionalFiniteNumberField(value, 'worm', path)
}

function assertFarmBurdenItem(value: unknown, path: string): void {
  assertBlobObject(value, path, FARM_BURDEN_KEYS, ['Items', 'number'])
  assertOptionalStringField(value, 'name', path)
  requireString(value.Items, path + '.Items')
  requireFiniteNumber(value.number, path + '.number')
}

function assertFarmWarehouseItem(value: unknown, path: string): void {
  assertBlobObject(value, path, FARM_WAREHOUSE_KEYS, ['fruit', 'number'])
  requireString(value.fruit, path + '.fruit')
  requireFiniteNumber(value.number, path + '.number')
  assertOptionalStringField(value, 'name', path)
  assertOptionalFiniteNumberField(value, 'price', path)
}

function assertFarmBlob(value: unknown, path: string): void {
  assertBlobObject(value, path, FARM_KEYS)
  for (const key of ['house', 'kennel', 'fence', 'weather', 'username'] as const) {
    assertOptionalStringField(value, key, path)
  }
  for (const key of ['experience', 'rank', 'wealth'] as const) {
    if (value[key] !== undefined) assertNumericStringOrFiniteNumber(value[key], path + '.' + key)
  }
  assertOptionalFiniteNumberField(value, 'checked', path)
  if (value.burden !== undefined) {
    assertBlobArray(value.burden, path + '.burden')
    value.burden.forEach((item, index) => assertFarmBurdenItem(item, path + '.burden[' + index + ']'))
  }
  if (value.warehouse !== undefined) {
    assertBlobArray(value.warehouse, path + '.warehouse')
    value.warehouse.forEach((item, index) => assertFarmWarehouseItem(item, path + '.warehouse[' + index + ']'))
  }
  if (value.farmland !== undefined) {
    assertBlobArray(value.farmland, path + '.farmland')
    value.farmland.forEach((land, index) => assertFarmLandBlob(land, path + '.farmland[' + index + ']'))
  }
}

function assertAlbumBlob(value: unknown, path: string): void {
  assertBlobArray(value, path)
  value.forEach((shot, index) => {
    const shotPath = path + '[' + index + ']'
    assertBlobObject(shot, shotPath, ['id', 'city', 'd'], ['id', 'city', 'd'])
    requireString(shot.id, shotPath + '.id')
    requireString(shot.city, shotPath + '.city')
    requireNonNegativeInteger(shot.d, shotPath + '.d')
  })
}

function assertMailBlob(value: unknown, path: string): void {
  requireRecord(value, path)
  if (value.e === true) {
    assertBlobObject(value, path, ['d', 'e', 'k'], ['d', 'e'])
    requireNonNegativeInteger(value.d, path + '.d')
    assertOptionalStringField(value, 'k', path)
    return
  }
  assertBlobObject(value, path, ['d', 'l', 'glb', 'r', 'm', 'k', 'p'], ['d', 'l', 'glb'])
  requireNonNegativeInteger(value.d, path + '.d')
  requireString(value.l, path + '.l')
  assertSharedGoodArray(value.glb, path + '.glb')
  assertOptionalBooleanField(value, 'r', path)
  assertOptionalStringField(value, 'm', path)
  assertOptionalStringField(value, 'k', path)
  assertOptionalStringField(value, 'p', path)
}

function assertEmailBlob(value: unknown, path: string): void {
  requireRecord(value, path)
  for (const [key, mail] of Object.entries(value)) {
    if (/^(0|[1-9]\d*)$/.test(key) === false) failSchema('forbidden_field', path + '.' + key, 'invalid mail key')
    assertMailBlob(mail, path + '.' + key)
  }
}

function assertActivityBlob(value: unknown, path: string): void {
  requireFiniteNumber(value, path)
  if ((value as number) < 0) failSchema('invalid_schema', path, 'activity minutes must not be negative')
}

function assertIslandErrandCanonical(value: unknown, path: string): void {
  assertBlobObject(value, path, ISLAND_ERRAND_FIELDS, ISLAND_ERRAND_FIELDS)
  requireString(value.from, path + '.from')
  if (isEnum(value.kind, ISLAND_ERRAND_KINDS) === false) failSchema('invalid_schema', path + '.kind', 'invalid island errand kind')
  requireString(value.to, path + '.to')
  requireNonNegativeInteger(value.got, path + '.got')
  requireBoolean(value.took, path + '.took')
}

function assertIslandCanonical(value: unknown, path: string): void {
  assertBlobObject(value, path, ISLAND_CANONICAL_FIELDS)
  assertOptionalFiniteNumberField(value, 'day', path)
  assertOptionalNonNegativeIntegerField(value, 'sent', path)
  assertOptionalStringField(value, 'letter', path)
  assertOptionalStringField(value, 'want', path)
  assertOptionalBooleanField(value, 'piece', path)
  assertOptionalBooleanField(value, 'loved', path)
  assertOptionalNonNegativeIntegerField(value, 'tier', path)
  assertOptionalNonNegativeIntegerField(value, 'pieces', path)
  assertOptionalNonNegativeIntegerField(value, 'wins', path)
  if (value.lit !== undefined && isStringArray(value.lit) === false) failSchema('invalid_schema', path + '.lit', 'expected string list')
  if (value.fought !== undefined && isStringArray(value.fought) === false) failSchema('invalid_schema', path + '.fought', 'expected string list')
  if (value.lamps !== undefined && isNonNegativeIntegerArray(value.lamps) === false) {
    failSchema('invalid_schema', path + '.lamps', 'expected lamp scene indexes')
  }
  if (value.errands !== undefined) {
    assertBlobArray(value.errands, path + '.errands')
    value.errands.forEach((errand, index) => assertIslandErrandCanonical(errand, path + '.errands[' + index + ']'))
  }
}

/**
 * Migration filter for island: keeps the canonical decision/counter/flag
 * subset and strips AI-created news/note prose plus per-errand `ask` wording.
 */
export function filterIslandCanonicalState(value: unknown, path = '$.island'): JsonObject {
  requireRecord(value, path)
  assertOnlyKeys(value, [...ISLAND_CANONICAL_FIELDS, ...ISLAND_PRESENTATION_FIELDS], path)
  const output: Record<string, unknown> = {}
  for (const key of ISLAND_CANONICAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key]
  }
  if (value.errands !== undefined) {
    assertBlobArray(value.errands, path + '.errands')
    output.errands = value.errands.map((errand, index) => {
      const errandPath = path + '.errands[' + index + ']'
      requireRecord(errand, errandPath)
      assertOnlyKeys(errand, [...ISLAND_ERRAND_FIELDS, ...ISLAND_ERRAND_PRESENTATION_FIELDS], errandPath)
      const canonical: Record<string, unknown> = {}
      for (const key of ISLAND_ERRAND_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(errand, key)) canonical[key] = errand[key]
      }
      return canonical
    })
  }
  assertIslandCanonical(output, path)
  return output as JsonObject
}

export const SHARED_SAVE_JSON_BLOB_VALIDATORS: Record<SharedSaveJsonKey, (value: unknown, path: string) => void> = {
  email: assertEmailBlob,
  task: assertTaskBlob,
  signin: assertSigninBlob,
  fishs: assertPondBlob,
  farm: assertFarmBlob,
  activity: assertActivityBlob,
  album: assertAlbumBlob,
  island: assertIslandCanonical,
}

function parseCanonicalSaveJsonBlob(text: unknown, path: string): unknown {
  if (typeof text !== 'string') failSchema('invalid_schema', path, 'expected a JSON string')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    failSchema('invalid_schema', path, 'expected valid JSON text')
  }
  try {
    assertJsonSafe(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'blob is not JSON-safe'
    failSchema('invalid_schema', path, message)
  }
  assertNoForbiddenJsonKey(parsed, path)
  return parsed
}

export function assertCanonicalSaveJsonBlob(key: string, text: unknown, path = '$'): void {
  if (isSharedSaveJsonKey(key) === false) failSchema('forbidden_field', path, 'unknown saveJsonData blob')
  const parsed = parseCanonicalSaveJsonBlob(text, path)
  SHARED_SAVE_JSON_BLOB_VALIDATORS[key](parsed, path)
}

export function validateSharedSaveJsonBlob(key: string, text: unknown): boolean {
  try {
    assertCanonicalSaveJsonBlob(key, text)
    return true
  } catch {
    return false
  }
}

function canonicalizeSaveJsonBlob(key: SharedSaveJsonKey, text: unknown, path: string): string {
  const parsed = parseCanonicalSaveJsonBlob(text, path)
  const canonical = key === 'island'
    ? filterIslandCanonicalState(parsed, path)
    : parsed
  if (key !== 'island') SHARED_SAVE_JSON_BLOB_VALIDATORS[key](canonical, path)
  return stableStringify(canonical)
}

/** Filters legacy SaveData blobs to canonical shared content, dropping known presentation-only blobs. */
export function filterSharedSaveJsonData(
  saveJsonData: Record<string, string>,
): Partial<Record<SharedSaveJsonKey, string>> {
  requireRecord(saveJsonData, '$.shared.saveJsonData')
  const output: Partial<Record<SharedSaveJsonKey, string>> = {}
  for (const [key, text] of Object.entries(saveJsonData)) {
    if (isPresentationOnlySaveJsonKey(key)) continue
    if (isSharedSaveJsonKey(key) === false) {
      failSchema('forbidden_field', '$.shared.saveJsonData.' + key, 'unknown saveJsonData blob')
    }
    if (typeof text !== 'string') failSchema('invalid_schema', '$.shared.saveJsonData.' + key, 'expected a JSON string')
    output[key] = canonicalizeSaveJsonBlob(key, text, '$.shared.saveJsonData.' + key)
  }
  return output
}
