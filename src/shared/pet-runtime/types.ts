/** The first portable runtime state schema. Hosts own migration between versions. */
export const RUNTIME_SCHEMA_VERSION = 1 as const

export type RuntimeSchemaVersion = typeof RUNTIME_SCHEMA_VERSION

/** JSON values are the only values allowed in canonical runtime state. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

/**
 * Deterministic runtime RNG metadata. `seedHex` is the immutable creation seed;
 * `stateHex` is the current xoshiro128** state; `draws` is an audit counter.
 */
export interface RngState {
  algorithm: 'xoshiro128**'
  /** 16 bytes, lowercase hexadecimal. */
  seedHex: string
  /** 16 bytes, lowercase hexadecimal. */
  stateHex: string
  draws: number
}

/** A calendar day normalized by the host for one game-day key. */
export interface CalendarInput {
  /** YYYY-MM-DD in the canonical pet timezone. */
  date: string
  lunar: string
  term: string | null
  holiday: { name: string; off: boolean } | null
}

export type WeatherProvenance = 'live' | 'cache' | 'fallback' | 'imported'

export interface WeatherHour {
  /** Local hour 0..23. */
  hour: number
  /** wttr.in-compatible weather code. */
  code: number
  /** Wind speed in km/h. */
  wind: number
}

/** One persisted forecast, keyed by the pet's 06:00 game-day boundary. */
export interface WeatherDayRecord {
  /** YYYY-MM-DD for the 06:00 game day in the pet's timezone. */
  dayKey: string
  condition: string
  conditionCode: number
  minC: number
  maxC: number
  /** Tomorrow's maximum, normalized into this game day. */
  tomorrowMax: number
  hours: WeatherHour[]
  provenance: WeatherProvenance
  fetchedAtMs: number
  sourceLabel?: string
}

/** Host-normalized external inputs. Missing weather days resolve deterministically. */
export interface EnvironmentInputs {
  /** Persisted normalized calendar keyed by game-day key. */
  calendarByDay?: Record<string, CalendarInput>
  /** Persisted normalized weather keyed by game-day key. */
  weatherByDay: Record<string, WeatherDayRecord>
}

/** The common shape of every semantic command. C2 adds the full command catalog. */
export interface CommandBase<TType extends string = string> {
  type: TType
}

/** A controlled command rejection. */
export interface CommandErrorBase {
  code: string
  message: string
  retryable?: boolean
  details?: JsonValue
}

export interface CommandSuccessBase<TType extends string = string, TData = unknown> {
  ok: true
  type: TType
  data: TData
}

export interface CommandFailureBase<TType extends string = string> {
  ok: false
  type: TType
  error: CommandErrorBase
}

/** Result envelope shared by local and server command transports. */
export type CommandResultBase<TType extends string = string, TData = unknown> =
  | CommandSuccessBase<TType, TData>
  | CommandFailureBase<TType>

/** Inputs every runtime command or tick receives from its host. */
export interface RuntimeContextBase {
  /** Canonical game time resolved by the scheduler. */
  gameTimeMs: number
  environment: EnvironmentInputs
  activeClientCount: number
  sessionActive: boolean
  actorDeviceId: string | null
}
