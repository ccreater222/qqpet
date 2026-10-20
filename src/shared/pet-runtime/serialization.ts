import { RUNTIME_SCHEMA_VERSION } from './types'

function fail(message: string): never {
  throw new Error(message)
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Rejects values that JSON would silently alter, drop or turn into a different kind. */
export function assertJsonSafe(value: unknown): void {
  const ancestors = new Set<object>()
  const visit = (current: unknown, path: string): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (Number.isFinite(current) === false) fail(path + ' must be a finite JSON number')
      if (Object.is(current, -0)) fail(path + ' must not be negative zero')
      return
    }
    if (typeof current !== 'object') fail(path + ' is not JSON-safe')
    if (ancestors.has(current)) fail(path + ' contains a cycle')
    ancestors.add(current)
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (Object.prototype.hasOwnProperty.call(current, index) === false) fail(path + ' contains an array hole')
        visit(current[index], path + '[' + index + ']')
      }
      if (Object.getOwnPropertySymbols(current).length > 0) fail(path + ' contains symbol properties')
    } else {
      if (isPlainObject(current) === false) fail(path + ' must be a plain JSON object')
      if (Object.getOwnPropertySymbols(current).length > 0) fail(path + ' contains symbol properties')
      for (const key of Object.keys(current)) {
        visit((current as Record<string, unknown>)[key], path + '.' + key)
      }
    }
    ancestors.delete(current)
  }
  visit(value, '$')
}

function stringifyJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (Number.isFinite(value) === false) fail('JSON numbers must be finite')
    if (Object.is(value, -0)) fail('JSON numbers must not be negative zero')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') fail('value is not JSON-safe')
  if (ancestors.has(value)) fail('value contains a cycle')
  ancestors.add(value)
  let output: string
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (Object.prototype.hasOwnProperty.call(value, index) === false) fail('JSON arrays must not contain holes')
      parts.push(stringifyJson(value[index], ancestors))
    }
    if (Object.getOwnPropertySymbols(value).length > 0) fail('JSON arrays must not contain symbol properties')
    output = '[' + parts.join(',') + ']'
  } else {
    if (isPlainObject(value) === false) fail('JSON values must use plain objects')
    if (Object.getOwnPropertySymbols(value).length > 0) fail('JSON objects must not contain symbol properties')
    const record = value as Record<string, unknown>
    const parts = Object.keys(record)
      .sort()
      .map(key => JSON.stringify(key) + ':' + stringifyJson(record[key], ancestors))
    output = '{' + parts.join(',') + '}'
  }
  ancestors.delete(value)
  return output
}

/** Deterministic JSON bytes: object keys are sorted recursively. */
export function stableStringify(value: unknown): string {
  assertJsonSafe(value)
  return stringifyJson(value, new Set<object>())
}

/** Deep JSON copy without relying on structuredClone (unsupported on old mobile hosts). */
export function cloneJsonState<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T
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
