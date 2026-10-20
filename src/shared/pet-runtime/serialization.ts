import { RUNTIME_SCHEMA_VERSION, type JsonObject, type JsonValue } from './types'

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/

function fail(message: string): never {
  throw new Error(message)
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isCanonicalArrayIndex(name: string): boolean {
  if (ARRAY_INDEX.test(name) === false) return false
  const index = Number(name)
  return Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff
}

/** Reads a data descriptor without ever invoking a getter or setter. */
function dataDescriptor(value: object, name: string, path: string, allowNonEnumerable = false): PropertyDescriptor & { value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined) fail(path + ' is missing')
  if (allowNonEnumerable === false && descriptor.enumerable === false) fail(path + ' must be enumerable')
  if (Object.prototype.hasOwnProperty.call(descriptor, 'value') === false) fail(path + ' must not use accessors')
  return descriptor as PropertyDescriptor & { value: unknown }
}

function assertNoSymbolProperties(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) fail(path + ' contains symbol properties')
}

/**
 * Validates and snapshots one JSON value from own data descriptors. Accessors,
 * non-enumerable properties, sparse arrays and extra array properties are
 * rejected because JSON serialization would invoke, omit or reorder them.
 */
function snapshotJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value) === false) fail(path + ' must be a finite JSON number')
    if (Object.is(value, -0)) fail(path + ' must not be negative zero')
    return value
  }
  if (typeof value !== 'object') fail(path + ' is not JSON-safe')
  if (ancestors.has(value)) fail(path + ' contains a cycle')
  ancestors.add(value)
  assertNoSymbolProperties(value, path)

  let snapshot: JsonValue
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value)
    for (const name of names) {
      if (name === 'length') continue
      if (isCanonicalArrayIndex(name) === false) fail(path + ' has an extra non-index array property ' + name)
    }
    const lengthDescriptor = dataDescriptor(value, 'length', path + '.length', true)
    const length = lengthDescriptor.value
    if (typeof length !== 'number' || Number.isSafeInteger(length) === false || length < 0) {
      fail(path + '.length must be a non-negative safe integer')
    }
    const entries: JsonValue[] = []
    for (let index = 0; index < length; index++) {
      const entry = dataDescriptor(value, String(index), path + '[' + index + ']')
      entries.push(snapshotJson(entry.value, path + '[' + index + ']', ancestors))
    }
    snapshot = entries
  } else {
    if (isPlainObject(value) === false) fail(path + ' must be a plain JSON object')
    const result: JsonObject = {}
    for (const name of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = dataDescriptor(value, name, path + '.' + name)
      Object.defineProperty(result, name, {
        value: snapshotJson(descriptor.value, path + '.' + name, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    snapshot = result
  }

  ancestors.delete(value)
  return snapshot
}

/** Validates and returns an independent plain-JSON snapshot. */
export function snapshotJsonValue(value: unknown): JsonValue {
  return snapshotJson(value, '$', new Set<object>())
}

/** Rejects values that JSON would silently alter, drop, invoke or turn into a different kind. */
export function assertJsonSafe(value: unknown): void {
  snapshotJsonValue(value)
}

function stringifyJsonValue(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stringifyJsonValue).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stringifyJsonValue(value[key])).join(',') + '}'
}

/** Deterministic JSON bytes: object keys are sorted recursively. */
export function stableStringify(value: unknown): string {
  return stringifyJsonValue(snapshotJsonValue(value))
}

/** Deep JSON copy without relying on structuredClone (unsupported on old mobile hosts). */
export function cloneJsonState<T>(value: T): T {
  return snapshotJsonValue(value) as T
}

export interface RuntimeStateEnvelope<T> {
  schemaVersion: number
  state: T
}

export interface RuntimeStateCodec<T> {
  readonly schemaVersion: number
  encode(state: T): string
  decode(serialized: string): T
}

export function serializeRuntimeState<T>(state: T, schemaVersion: number = RUNTIME_SCHEMA_VERSION): string {
  if (Number.isSafeInteger(schemaVersion) === false || schemaVersion <= 0) fail('schemaVersion must be a positive safe integer')
  return stableStringify({ schemaVersion, state } satisfies RuntimeStateEnvelope<T>)
}

export function deserializeRuntimeState<T>(
  serialized: string,
  schemaVersion: number,
  validate: (value: unknown) => value is T,
): T {
  if (Number.isSafeInteger(schemaVersion) === false || schemaVersion <= 0) fail('schemaVersion must be a positive safe integer')
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    fail('runtime state is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('runtime state must be a JSON object')
  const envelope = parsed as Record<string, unknown>
  if (envelope.schemaVersion !== schemaVersion) {
    fail('runtime state schema version mismatch: expected ' + schemaVersion + ', received ' + String(envelope.schemaVersion))
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'state') === false) fail('runtime state envelope has no state field')
  const state = envelope.state
  assertJsonSafe(state)
  if (validate(state) === false) fail('runtime state failed its validator')
  return state
}

/** Creates the schema-versioned codec used by local documents and portable bundles. */
export function createRuntimeStateCodec<T>(
  schemaVersion: number,
  validate: (value: unknown) => value is T,
): RuntimeStateCodec<T> {
  if (Number.isSafeInteger(schemaVersion) === false || schemaVersion <= 0) fail('schemaVersion must be a positive safe integer')
  return {
    schemaVersion,
    encode: (state: T): string => serializeRuntimeState(state, schemaVersion),
    decode: (serialized: string): T => deserializeRuntimeState(serialized, schemaVersion, validate),
  }
}
