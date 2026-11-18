import type { Sex } from '../save'
import type { OrderedEvent } from '../pet-runtime/events'
import type { JsonValue } from '../pet-runtime/types'
import type { SharedSaveData } from './data-boundary'
import type { AuthorityStamp, PortablePetBundleV1, WireAuthority } from './portable'

export type { JsonObject, JsonValue } from '../pet-runtime/types'
export { DOMAIN_EVENT_TYPES, assertOrderedEventStream } from '../pet-runtime/events'
export type { DomainEvent, DomainEventType, OrderedDomainEvent, OrderedEvent } from '../pet-runtime/events'
export type { AuthorityStamp, PortablePetBundleV1, WireAuthority } from './portable'

export const PROTOCOL_VERSION = 1 as const
export const SAVE_SCHEMA_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION
export type SaveSchemaVersion = typeof SAVE_SCHEMA_VERSION
export type DeviceRole = 'owner' | 'player'
export type CommandRole = 'player' | 'owner'
export type CombatStat = 'yb' | 'growth' | 'mood' | 'hunger' | 'clean' | 'health'

export interface CommandPayloadMap {
  'pet.adopt': { sex: Sex }
  'pet.reset': Record<string, never>
  'pet.bury': Record<string, never>
  'pet.rename': { name?: string; host?: string }
  'pet.setPaused': { paused: boolean }
  'pet.pokeFace': { spotId: string }
  'pet.cheer': Record<string, never>
  'inventory.buy': { type: string; itemId: string; quantity: number }
  'inventory.use': { type: string; itemId: string; quantity?: number }
  'medical.treat': { mode: 'doctor' | 'owned'; itemId?: string }
  'vip.buyPinkDiamond': { days: number }
  'vip.clearPinkDiamond': Record<string, never>
  'vip.buySweetheart': { days: number }
  'vip.setSweetheart': { enabled: boolean }
  'travel.completeCollection': Record<string, never>
  'job.startWork': { jobId: string }
  'job.startStudy': { courseId: string }
  'job.startTravel': Record<string, never>
  'activity.stop': Record<string, never>
  'task.claim': { tab: 'daily' | 'ddw' | 'growth' | 'travel'; index: number }
  'exam.start': { subject: string }
  'exam.submit': { sessionToken: string; answers: number[] }
  'signin.sign': Record<string, never>
  'signin.drawGrowth': Record<string, never>
  'signin.claimOnlineGift': Record<string, never>
  'signin.claimBirthdayGift': Record<string, never>
  'mail.claim': { mailId: string }
  'mail.claimAll': Record<string, never>
  'mail.delete': { mailId: string }
  'mail.deleteAll': { scope: 'claimed' }
  'game.startSession': { gameId: string; kind: 'small' | 'flash' }
  'game.reward': { sessionToken: string }
  'diudiule.startSession': Record<string, never>
  'diudiule.reward': { sessionToken: string }
  'game.abandonSession': { sessionToken: string }
  'social.completeLanVisit': { peerId: string; direction: 'incoming' | 'outgoing' }
  'island.arriveScene': { sceneId: string }
  'island.acceptLetter': { fromNpcId: string; toNpcId: string }
  'island.deliverLetter': { toNpcId: string }
  'island.turnInErrand': { npcId: string; errandId: string; itemId?: string }
  'island.startQuiz': { npcId: string; errandId: string }
  'island.answerQuiz': { sessionToken: string; optionIndex: number }
  'island.fightMonster': { monsterId: string; tactic: string }
  'island.claimGrowthReward': Record<string, never>
  'island.claimTreasure': Record<string, never>
  'island.giftNpc': { npcId: string; itemId: string }
  'island.talkNpc': { npcId: string }
  'island.visitSpot': { spotId: string }
  'island.chat': { npcId: string }
  'island.playGame': { gameKey: string }
  'island.refreshNews': { dayKey: string }
  'fishing.buy': { fryId: number; quantity: number }
  'fishing.feed': { fishId: number }
  'fishing.harvest': { fishId: number }
  'fishing.harvestAll': Record<string, never>
  'fishing.speedUp': Record<string, never>
  'farm.plant': { seedId: string; plotIds: number[] }
  'farm.reclaim': { plotIds: number[] }
  'farm.harvest': { plotIds: number[] }
  'farm.care': { plotIds: number[]; action: 'water' | 'weed' | 'pest' | 'fertilize' }
  'farm.clear': { plotIds: number[] }
  'farm.buySeed': { seedId: string; quantity: number }
  'farm.buyFertilizer': { fertilizerId: string; quantity: number }
  'farm.sellProduce': { itemId: string; quantity: number }
  'settings.setShared': { key: 'difficulty' | 'undying'; value: boolean | 'easy' | 'standard' }
  'server.setAdvanceWhileEmpty': { enabled: boolean }
  'server.setTimeZone': { timeZone: string }
  'server.setWeatherCity': { city: string }
  'device.list': Record<string, never>
  'device.revoke': { deviceId: string }
  'admin.exportForDetach': Record<string, never>
  'admin.resumeServer': {
    expectedEpoch: number
    bundle: PortablePetBundleV1
    allowClamp?: boolean
    rebindLocalSessions?: boolean
  }
  'admin.importPortableBundle': { bundle: PortablePetBundleV1; allowClamp?: boolean; rebindLocalSessions?: boolean }
  'admin.grantCheat': { stat: CombatStat; amount: number }
  'admin.grantRandomGoods': { type: string; quantity: number }
}

export type CommandKey = keyof CommandPayloadMap
export type PetCommand = {
  [K in CommandKey]: { type: K; payload: CommandPayloadMap[K] }
}[CommandKey]

export interface IslandQuizProjection {
  recordId: string
  quizKind: string
  prompt: string
  options: string[]
}

export interface ExamQuestionProjection {
  questionId: string
  prompt: string
  options: string[]
}

export interface DeviceInfo {
  deviceId: string
  label: string
  role: DeviceRole
  createdAtMs: number
  lastSeenAtMs?: number
  revokedAtMs?: number
}

export interface ResultDataMap {
  'device.list': { devices: DeviceInfo[] }
  'device.revoke': { deviceId: string; revokedAtMs: number }
  'game.startSession': { sessionToken: string; gameId: string }
  'diudiule.startSession': { sessionToken: string }
  'exam.start': { sessionToken: string; questions: ExamQuestionProjection[] }
  'island.startQuiz': { sessionToken: string } & IslandQuizProjection
  'admin.exportForDetach': { authority: AuthorityStamp; bundle: PortablePetBundleV1 }
}

export type ResultDataFor<K extends CommandKey> = K extends keyof ResultDataMap ? ResultDataMap[K] : JsonValue

export const COMMAND_ERROR_CODES = [
  'invalid_payload',
  'op_id_conflict',
  'no_pet',
  'pet_dead',
  'paused',
  'busy',
  'insufficient_funds',
  'insufficient_item',
  'not_available',
  'wrong_phase',
  'already_claimed',
  'cooldown',
  'unauthorized',
  'offline',
  'server_catching_up',
  'authority_not_active',
  'authority_fork_risk',
  'authority_reset_required',
  'anchor_out_of_bounds',
  'internal',
] as const

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number]

export interface CommandError {
  code: CommandErrorCode
  message: string
  refreshProjection: boolean
}

export type CommandResult<K extends CommandKey = CommandKey> =
  | {
      status: 'applied'
      commandType: K
      opId: string
      commandSeq: number
      revision: number
      eventSeq: number
      result?: ResultDataFor<K>
    }
  | {
      status: 'rejected'
      commandType: K
      opId: string
      commandSeq: number
      revision: number
      eventSeq: number
      error: CommandError
    }
  | {
      status: 'duplicate'
      commandType: K
      opId: string
      commandSeq: number
      revision: number
      eventSeq: number
      original: 'applied' | 'rejected'
      result?: ResultDataFor<K>
      error?: CommandError
    }

export interface ClientHello {
  t: 'hello'
  v: ProtocolVersion
  requestId: string
  petId?: string
  deviceId?: string
  lastRevision?: number
  lastEventSeq?: number
  appVersion: string
  cachedAuthority?: { authorityId: string; restoreGeneration: number; epoch: number }
  auth:
    | { kind: 'token'; token: string }
    | { kind: 'pairing'; code: string; deviceLabel: string }
}

export interface Welcome {
  t: 'welcome'
  v: ProtocolVersion
  requestId: string
  connectionId: string
  petId: string
  deviceId: string
  deviceRole: DeviceRole
  protocolVersion: ProtocolVersion
  saveSchemaVersion: number
  serverTimeMs: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  /** Canonical owner-selected weather location; empty means automatic. */
  weatherLocation?: string
  authority: WireAuthority
  headRevision: number
  headEventSeq: number
  catchingUp: boolean
  delivery: 'none' | 'snapshot' | 'replay' | 'replay+snapshot'
  /** One-time field only when auth.kind === 'pairing'. Persist locally; never log. */
  issuedToken?: string
}

export interface SnapshotMessage {
  t: 'snapshot'
  v: ProtocolVersion
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  /** Canonical owner-selected weather location; empty means automatic. */
  weatherLocation?: string
  authority: WireAuthority
  save: SharedSaveData
}

export interface ReplayMessage {
  t: 'replay'
  v: ProtocolVersion
  fromEventSeq: number
  toEventSeq: number
  events: OrderedEvent[]
}

export interface ReadyMessage {
  t: 'ready'
  v: ProtocolVersion
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  /** Canonical owner-selected weather location; empty means automatic. */
  weatherLocation?: string
  authority: WireAuthority
  catchingUp: boolean
}

export interface ProjectionMessage {
  t: 'projection'
  v: ProtocolVersion
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  /** Canonical owner-selected weather location; empty means automatic. */
  weatherLocation?: string
  authority: WireAuthority
  save: SharedSaveData
  /** Ordered events introduced by this revision/batch. */
  events: OrderedEvent[]
}

export interface CommandRequest {
  t: 'command'
  v: ProtocolVersion
  requestId: string
  opId: string
  command: PetCommand
  observedRevision?: number
}

export interface WireCommandResult<K extends CommandKey = CommandKey> {
  t: 'commandResult'
  v: ProtocolVersion
  requestId: string
  opId: string
  commandType: K
  status: 'applied' | 'rejected' | 'duplicate'
  commandSeq: number
  revision: number
  eventSeq: number
  result?: ResultDataFor<K>
  error?: {
    code: string
    message: string
    refreshProjection: boolean
  }
}

export interface DeviceRevokedMessage {
  t: 'deviceRevoked'
  v: ProtocolVersion
  deviceId: string
  revokedAtMs: number
}

export interface AuthorityResetRequiredMessage {
  t: 'authorityResetRequired'
  code: 'authority_reset_required'
  v: ProtocolVersion
  requestId?: string
  authority: AuthorityStamp
  reason: 'restore_rollback' | 'authority_mismatch' | 'cache_newer'
  requireFullSnapshot: true
}

export interface CommandStatusRequest {
  t: 'commandStatus'
  v: ProtocolVersion
  requestId: string
  opId: string
}

export interface CommandStatusResult {
  t: 'commandStatusResult'
  v: ProtocolVersion
  requestId: string
  opId: string
  status: 'applied' | 'rejected' | 'not_applied'
  result?: WireCommandResult
}

export interface PortableBundleRequest {
  t: 'exportBundle'
  v: ProtocolVersion
  requestId: string
}

export interface PortableBundleMessage {
  t: 'portableBundle'
  v: ProtocolVersion
  requestId: string
  bundle: PortablePetBundleV1
}

export interface ResyncRequest {
  t: 'resync'
  v: ProtocolVersion
  requestId: string
  lastRevision?: number
  lastEventSeq?: number
  discardCachedAuthority?: boolean
}

export interface ErrorMessage {
  t: 'error'
  v: ProtocolVersion
  requestId?: string
  code:
    | 'auth_failed'
    | 'protocol_mismatch'
    | 'unauthorized'
    | 'rate_limited'
    | 'invalid_frame'
    | 'payload_too_large'
    | 'server_catching_up'
    | 'authority_not_active'
    | 'authority_fork_risk'
    | 'authority_reset_required'
    | 'anchor_out_of_bounds'
    | 'internal'
  message: string
  revision?: number
  refreshProjection: boolean
}

export interface PingMessage {
  t: 'ping'
  v: ProtocolVersion
  nonce: number
}

export interface PongMessage {
  t: 'pong'
  v: ProtocolVersion
  nonce: number
  serverTimeMs: number
}

export type ClientToServer =
  | ClientHello
  | CommandRequest
  | CommandStatusRequest
  | PortableBundleRequest
  | ResyncRequest
  | PingMessage

export type ServerToClient =
  | Welcome
  | SnapshotMessage
  | ReplayMessage
  | ReadyMessage
  | ProjectionMessage
  | WireCommandResult
  | CommandStatusResult
  | PortableBundleMessage
  | DeviceRevokedMessage
  | AuthorityResetRequiredMessage
  | ErrorMessage
  | PongMessage

export type ProtocolErrorMessage = ErrorMessage

export function isProtocolVersion(value: unknown): value is ProtocolVersion {
  return value === PROTOCOL_VERSION
}

export const CLIENT_MESSAGE_TYPES = ['hello', 'command', 'commandStatus', 'exportBundle', 'resync', 'ping'] as const
export const SERVER_MESSAGE_TYPES = [
  'welcome', 'snapshot', 'replay', 'ready', 'projection', 'commandResult', 'commandStatusResult',
  'portableBundle', 'deviceRevoked', 'authorityResetRequired', 'error', 'pong',
] as const
