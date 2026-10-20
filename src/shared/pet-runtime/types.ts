import type { SharedSaveData } from '../sync/data-boundary'

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

export type ScheduledJobType = 'work' | 'study' | 'travel' | 'game-session' | 'farm' | 'fishing' | 'mail' | 'other'

export interface ScheduledJob {
  id: number
  type: ScheduledJobType
  dueAtGameMs: number
  payload: JsonObject
  status: 'pending' | 'completed' | 'cancelled'
}

export interface ExamQuestion {
  questionId: string
  prompt: string
  options: string[]
  answerIndex: number
}

export type GameSessionPayload =
  | { kind: 'game'; gameId: string; gameKind: 'small' | 'flash'; presentationSeed: string }
  | { kind: 'diudiule' }
  | {
      kind: 'exam'
      subject: string
      questions: ExamQuestion[]
      examMetadata: { lesson: number; school: string }
    }
  | {
      kind: 'island_quiz'
      quizKind: string
      recordId: string
      prompt: string
      options: string[]
      answerIndex: number
      metadata: JsonObject
    }

export interface GameSessionState {
  sessionToken: string
  /** Authenticated device that created the session; every settle/list check must match. */
  actorDeviceId: string
  payload: GameSessionPayload
  startedAtGameMs: number
  expiresAtGameMs: number
  status: 'active' | 'settled' | 'abandoned' | 'expired'
  settledCommandSeq?: number
  rewardKey?: string
  cancelReason?: string
}

export type CoverageEndProvenance =
  | 'disconnect'
  | 'shutdown'
  | 'suspend'
  | 'crash_repaired'
  | 'pet_reset'
  | 'import_replaced'
  | 'authority_handoff'
  | 'graceful'
  | 'socket_closed'
  | 'app_shutdown'

export type CoverageSurvivor =
  | {
      kind: 'server_connection'
      connectionId: string
      deviceId: string
      authenticatedSessionId?: string
      lastHeartbeatWallMs: number
      eligible: boolean
      activeEndWallMs?: number
      activeEndProvenance?: CoverageEndProvenance
    }
  | {
      kind: 'local_app'
      appInstanceId: string
      localDeviceId: string
      lastHeartbeatWallMs: number
      eligible: boolean
      activeEndWallMs?: number
      activeEndProvenance?: CoverageEndProvenance
    }

export interface SessionCoverageInterval {
  coverageId: string
  deviceId: string
  connectedAtWallMs: number
  disconnectedAtWallMs?: number
  lastHeartbeatWallMs: number
  closeReason?: CoverageEndProvenance
}

export interface CoverageReopen {
  operationId: string
  commitWallMs: number
  survivors: CoverageSurvivor[]
  state: 'pending' | 'suspended'
  suspendedAtWallMs?: number
}

export interface EngineState {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  save: SharedSaveData
  gameTimeMs: number
  lastSchedulerWallMs: number
  timeZone: string
  /** Canonical owner weather city; local-only presentation weatherCity is separate. */
  weatherLocation: string
  advanceWhileEmpty: boolean
  rng: RngState
  scheduledJobs: ScheduledJob[]
  nextScheduledJobId: number
  gameSessions: GameSessionState[]
  /** Historical connected intervals used to derive session-clock coverage during catch-up. */
  sessionCoverage: SessionCoverageInterval[]
  /** Durable marker for a reset/import that must reopen survivor coverage after commit. */
  coverageReopen?: CoverageReopen
  /** Last daily boundary that actually ran, in the current timezone's day-key form. */
  lastProcessedDayBoundaryKey: string
  /** Next 06:00 boundary in current canonical game time; recomputed on timezone changes. */
  nextDailyBoundaryMs: number
  /** Set only by an explicitly allowed import clamp; audit metadata, never replayed. */
  importClamped: boolean
  /** Signed wall-time amount removed from/added to gameTime during clamp realignment. */
  clockSkippedMs: number
  environment: EnvironmentInputs
}

/** Inputs every runtime command or tick receives from its host. */
export interface RuntimeContext {
  /** Server/local host resolves this before invoking the runtime. */
  gameTimeMs: number
  /** Calendar/weather records already normalized and persisted by the host. */
  environment: EnvironmentInputs
  /** Server client count derived from persisted coverage for a historical tick, or live sockets for a live tick. */
  activeClientCount: number
  /** True when coverage/session count is positive for that tick; false for zero-client/closed intervals. */
  sessionActive: boolean
  /** Authenticated device for command execution; null for scheduler-only ticks. */
  actorDeviceId: string | null
}
