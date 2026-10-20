import type { JsonObject, JsonValue } from '../pet-runtime/types'

export type SchemaErrorCode =
  | 'invalid_schema'
  | 'unsupported_schema_version'
  | 'unsupported_format'
  | 'forbidden_field'
  | 'missing_field'

export class SchemaError extends Error {
  readonly code: SchemaErrorCode
  readonly path: string

  constructor(code: SchemaErrorCode, path: string, message: string) {
    super(message)
    this.name = 'SchemaError'
    this.code = code
    this.path = path
  }
}

export type Validator<T> = (value: unknown) => value is T

export function failSchema(code: SchemaErrorCode, path: string, message: string): never {
  throw new SchemaError(code, path, message)
}

export function assertSchema(condition: unknown, path: string, message: string): asserts condition {
  if (condition === false) failSchema('invalid_schema', path, message)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

export function requireRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (isRecord(value) === false) failSchema('invalid_schema', path, 'expected an object')
}

export function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>()
  const visit = (current: unknown): boolean => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return true
    if (typeof current === 'number') return Number.isFinite(current)
    if (typeof current !== 'object') return false
    if (ancestors.has(current)) return false
    ancestors.add(current)
    const valid = Array.isArray(current)
      ? current.every(entry => visit(entry))
      : Object.keys(current).every(key => visit((current as Record<string, unknown>)[key]))
    ancestors.delete(current)
    return valid
  }
  return visit(value)
}

export function requireJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (isJsonValue(value) === false) failSchema('invalid_schema', path, 'expected a finite JSON value')
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value)
}

export function requireJsonObject(value: unknown, path: string): asserts value is JsonObject {
  if (isJsonObject(value) === false) failSchema('invalid_schema', path, 'expected a JSON object')
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function requireString(value: unknown, path: string, nonEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    failSchema('invalid_schema', path, nonEmpty ? 'expected a non-empty string' : 'expected a string')
  }
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function requireBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') failSchema('invalid_schema', path, 'expected a boolean')
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function requireFiniteNumber(value: unknown, path: string): asserts value is number {
  if (isFiniteNumber(value) === false) failSchema('invalid_schema', path, 'expected a finite number')
}

export function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function requireSafeInteger(value: unknown, path: string): asserts value is number {
  if (Number.isSafeInteger(value) === false) failSchema('invalid_schema', path, 'expected a safe integer')
}

export function requireNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (isNonNegativeInteger(value) === false) failSchema('invalid_schema', path, 'expected a non-negative safe integer')
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string' && entry.length > 0)
}

export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

export function isNonNegativeIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(entry => isNonNegativeInteger(entry))
}

export function isEnum<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

export function isOneOf<const T extends readonly unknown[]>(value: unknown, allowed: T): value is T[number] {
  return allowed.includes(value)
}

export function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key) === false) failSchema('forbidden_field', path + '.' + key, 'field is not allowed')
  }
}

export function assertRequiredKeys(record: Record<string, unknown>, required: readonly string[], path: string): void {
  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(record, key) === false) {
      failSchema('missing_field', path + '.' + key, 'required field is missing')
    }
  }
}

export function assertSchemaVersion(value: unknown, expected: number, path: string, label = 'schema'): void {
  if (value !== expected) {
    failSchema(
      'unsupported_schema_version',
      path,
      label + ' version mismatch: expected ' + expected + ', received ' + String(value),
    )
  }
}
