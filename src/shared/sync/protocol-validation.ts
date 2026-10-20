import type { OrderedEvent } from '../pet-runtime/events'
import { assertOrderedEventStream } from '../pet-runtime/events'
import { assertJsonSafe } from '../pet-runtime/serialization'
import { isCommandKey, parsePetCommand } from './command-validation'
import { SESSION_ANSWER_KEY_FIELDS, validateSharedSaveData } from './data-boundary'
import { validateAuthorityStamp, validatePortablePetBundle, validateWireAuthority } from './portable'
import type { ClientToServer, ServerToClient, WireCommandResult } from './protocol'
import { CLIENT_MESSAGE_TYPES, PROTOCOL_VERSION, SAVE_SCHEMA_VERSION, SERVER_MESSAGE_TYPES } from './protocol'
import {
  isJsonObject,
  isJsonValue,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSafeInteger,
} from './schema'

export type ProtocolValidationErrorCode =
  | 'invalid_protocol_version'
  | 'invalid_frame'
  | 'unknown_message_type'
  | 'missing_request_id'
  | 'invalid_command'

export interface ProtocolValidationError {
  code: ProtocolValidationErrorCode
  message: string
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolValidationError }

const CLIENT_MESSAGE_TYPE_SET = new Set<string>(CLIENT_MESSAGE_TYPES)
const SERVER_MESSAGE_TYPE_SET = new Set<string>(SERVER_MESSAGE_TYPES)
const REQUEST_CORRELATED = new Set([
  'hello', 'command', 'commandStatus', 'exportBundle', 'resync',
  'welcome', 'commandResult', 'commandStatusResult', 'portableBundle',
])
const SESSION_ANSWER_KEY_SET = new Set<string>(SESSION_ANSWER_KEY_FIELDS)
const CLOSE_ERROR_CODES = new Set([
  'auth_failed', 'protocol_mismatch', 'unauthorized', 'rate_limited', 'invalid_frame',
  'payload_too_large', 'server_catching_up', 'authority_not_active', 'authority_fork_risk',
  'authority_reset_required', 'anchor_out_of_bounds', 'internal',
])

function invalid(code: ProtocolValidationErrorCode, message: string): { ok: false; error: ProtocolValidationError } {
  return { ok: false, error: { code, message } }
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return value === undefined || typeof value === 'string'
}

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return value === undefined || isNonNegativeInteger(value)
}

function orderedEvents(value: unknown): value is OrderedEvent[] {
  if (Array.isArray(value) === false) return false
  for (const event of value) {
    if (isRecord(event) === false) return false
    if (isNonNegativeInteger(event.eventSeq) === false || event.eventSeq <= 0) return false
    if (isNonNegativeInteger(event.revision) === false) return false
    if (event.commandSeq !== undefined && isNonNegativeInteger(event.commandSeq) === false) return false
    if (isSafeInteger(event.gameTimeMs) === false) return false
    if (typeof event.type !== 'string' || event.type.length === 0) return false
    if (isJsonObject(event.payload) === false || containsSessionAnswerKey(event.payload)) return false
  }
  try {
    assertOrderedEventStream(value as OrderedEvent[])
    return true
  } catch {
    return false
  }
}

export function validateOrderedEvent(value: unknown): value is OrderedEvent {
  return orderedEvents([value])
}

export function validateOrderedEvents(value: unknown): value is OrderedEvent[] {
  return orderedEvents(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function containsSessionAnswerKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSessionAnswerKey)
  for (const [key, child] of Object.entries(value)) {
    if (SESSION_ANSWER_KEY_SET.has(key)) return true
    if (containsSessionAnswerKey(child)) return true
  }
  return false
}

function validDeviceInfo(value: unknown): boolean {
  if (isRecord(value) === false) return false
  if (Object.keys(value).some(key => ['deviceId', 'label', 'role', 'createdAtMs', 'lastSeenAtMs', 'revokedAtMs'].includes(key) === false)) {
    return false
  }
  if (isNonEmptyString(value.deviceId) === false || isNonEmptyString(value.label) === false) return false
  if (value.role !== 'owner' && value.role !== 'player') return false
  if (isNonNegativeInteger(value.createdAtMs) === false) return false
  if (value.lastSeenAtMs !== undefined && isNonNegativeInteger(value.lastSeenAtMs) === false) return false
  if (value.revokedAtMs !== undefined && isNonNegativeInteger(value.revokedAtMs) === false) return false
  return true
}

function validExamQuestionProjection(value: unknown): boolean {
  if (isRecord(value) === false || exactKeys(value, ['questionId', 'prompt', 'options']) === false) return false
  if (isNonEmptyString(value.questionId) === false || typeof value.prompt !== 'string') return false
  return Array.isArray(value.options) && value.options.every(option => typeof option === 'string') && containsSessionAnswerKey(value) === false
}

function validExamStartResult(value: Record<string, unknown>): boolean {
  if (exactKeys(value, ['sessionToken', 'questions']) === false) return false
  if (isNonEmptyString(value.sessionToken) === false || Array.isArray(value.questions) === false) return false
  return value.questions.every(validExamQuestionProjection)
}

function validIslandQuizResult(value: Record<string, unknown>): boolean {
  if (exactKeys(value, ['sessionToken', 'recordId', 'quizKind', 'prompt', 'options']) === false) return false
  if (isNonEmptyString(value.sessionToken) === false || isNonEmptyString(value.recordId) === false) return false
  if (isNonEmptyString(value.quizKind) === false || typeof value.prompt !== 'string') return false
  return Array.isArray(value.options) && value.options.every(option => typeof option === 'string') && containsSessionAnswerKey(value) === false
}

/** Validates typed command result data and blocks answer-key leakage outside the owner export bundle. */
export function validateCommandResultData(commandType: string, value: unknown): boolean {
  if (value === undefined) return true
  if (isJsonValue(value) === false) return false
  if (isRecord(value) === false) return containsSessionAnswerKey(value) === false
  if (commandType === 'device.list') {
    if (exactKeys(value, ['devices']) === false || Array.isArray(value.devices) === false) return false
    return value.devices.every(validDeviceInfo)
  }
  if (commandType === 'device.revoke') {
    return exactKeys(value, ['deviceId', 'revokedAtMs']) && isNonEmptyString(value.deviceId) && isNonNegativeInteger(value.revokedAtMs)
  }
  if (commandType === 'game.startSession') {
    return exactKeys(value, ['sessionToken', 'gameId']) && isNonEmptyString(value.sessionToken) && isNonEmptyString(value.gameId)
  }
  if (commandType === 'diudiule.startSession') {
    return exactKeys(value, ['sessionToken']) && isNonEmptyString(value.sessionToken)
  }
  if (commandType === 'exam.start') return validExamStartResult(value)
  if (commandType === 'island.startQuiz') return validIslandQuizResult(value)
  if (commandType === 'admin.exportForDetach') {
    if (exactKeys(value, ['authority', 'bundle']) === false) return false
    return validateAuthorityStamp(value.authority) && validatePortablePetBundle(value.bundle)
  }
  return containsSessionAnswerKey(value) === false
}

export function validateWireCommandResult(value: unknown): value is WireCommandResult {
  if (isRecord(value) === false) return false
  if (value.t !== 'commandResult' || value.v !== PROTOCOL_VERSION) return false
  if (isNonEmptyString(value.requestId) === false || isNonEmptyString(value.opId) === false) return false
  if (isCommandKey(value.commandType) === false) return false
  if (value.status !== 'applied' && value.status !== 'rejected' && value.status !== 'duplicate') return false
  if (isNonNegativeInteger(value.commandSeq) === false) return false
  if (isNonNegativeInteger(value.revision) === false) return false
  if (isNonNegativeInteger(value.eventSeq) === false) return false
  if (validateCommandResultData(value.commandType, value.result) === false) return false
  if (value.error !== undefined) {
    if (isRecord(value.error) === false || exactKeys(value.error, ['code', 'message', 'refreshProjection']) === false) return false
    if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return false
    if (typeof value.error.refreshProjection !== 'boolean') return false
  }
  return true
}

function hello(value: Record<string, unknown>): boolean {
  if (isNonEmptyString(value.appVersion) === false) return false
  if (isRecord(value.auth) === false) return false
  if (value.auth.kind === 'token') {
    if (isNonEmptyString(value.auth.token) === false) return false
  } else if (value.auth.kind === 'pairing') {
    if (isNonEmptyString(value.auth.code) === false || isNonEmptyString(value.auth.deviceLabel) === false) return false
  } else {
    return false
  }
  if (optionalString(value, 'petId') === false || optionalString(value, 'deviceId') === false) return false
  if (optionalNonNegativeInteger(value, 'lastRevision') === false) return false
  if (optionalNonNegativeInteger(value, 'lastEventSeq') === false) return false
  if (value.cachedAuthority !== undefined) {
    if (isRecord(value.cachedAuthority) === false) return false
    if (isNonEmptyString(value.cachedAuthority.authorityId) === false) return false
    if (isNonNegativeInteger(value.cachedAuthority.restoreGeneration) === false) return false
    if (isNonNegativeInteger(value.cachedAuthority.epoch) === false) return false
  }
  return true
}

function welcome(value: Record<string, unknown>): boolean {
  if (isNonEmptyString(value.connectionId) === false || isNonEmptyString(value.petId) === false) return false
  if (isNonEmptyString(value.deviceId) === false) return false
  if (value.deviceRole !== 'owner' && value.deviceRole !== 'player') return false
  if (value.protocolVersion !== PROTOCOL_VERSION || value.saveSchemaVersion !== SAVE_SCHEMA_VERSION) return false
  if (isSafeInteger(value.serverTimeMs) === false || isSafeInteger(value.gameTimeMs) === false) return false
  if (isNonEmptyString(value.timeZone) === false || typeof value.advanceWhileEmpty !== 'boolean') return false
  if (validateWireAuthority(value.authority) === false) return false
  if (isNonNegativeInteger(value.headRevision) === false || isNonNegativeInteger(value.headEventSeq) === false) return false
  if (typeof value.catchingUp !== 'boolean') return false
  if (value.delivery !== 'none' && value.delivery !== 'snapshot' && value.delivery !== 'replay' && value.delivery !== 'replay+snapshot') return false
  if (optionalString(value, 'issuedToken') === false) return false
  return true
}

function snapshotLike(value: Record<string, unknown>, withEvents: boolean): boolean {
  if (isNonNegativeInteger(value.revision) === false || isNonNegativeInteger(value.eventSeq) === false) return false
  if (isSafeInteger(value.gameTimeMs) === false) return false
  if (isNonEmptyString(value.timeZone) === false || typeof value.advanceWhileEmpty !== 'boolean') return false
  if (validateWireAuthority(value.authority) === false) return false
  if (validateSharedSaveData(value.save) === false) return false
  if (withEvents && orderedEvents(value.events) === false) return false
  return true
}

function commandResult(value: Record<string, unknown>): boolean {
  if (isNonEmptyString(value.opId) === false || isCommandKey(value.commandType) === false) return false
  if (value.status !== 'applied' && value.status !== 'rejected' && value.status !== 'duplicate') return false
  if (isNonNegativeInteger(value.commandSeq) === false) return false
  if (isNonNegativeInteger(value.revision) === false || isNonNegativeInteger(value.eventSeq) === false) return false
  if (validateCommandResultData(value.commandType, value.result) === false) return false
  if (value.error !== undefined) {
    if (isRecord(value.error) === false || exactKeys(value.error, ['code', 'message', 'refreshProjection']) === false) return false
    if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return false
    if (typeof value.error.refreshProjection !== 'boolean') return false
  }
  return true
}

function commandStatusResult(value: Record<string, unknown>): boolean {
  if (isNonEmptyString(value.opId) === false) return false
  if (value.status !== 'applied' && value.status !== 'rejected' && value.status !== 'not_applied') return false
  if (value.result !== undefined) {
    if (validateWireCommandResult(value.result) === false) return false
    if (value.result.opId !== value.opId) return false
  }
  return true
}

function protocolError(value: Record<string, unknown>): boolean {
  if (typeof value.code !== 'string' || CLOSE_ERROR_CODES.has(value.code) === false) return false
  if (typeof value.message !== 'string' || typeof value.refreshProjection !== 'boolean') return false
  if (value.revision !== undefined && isNonNegativeInteger(value.revision) === false) return false
  return true
}

function parseCore(value: unknown, direction: 'client' | 'server'): ProtocolValidationResult<Record<string, unknown>> {
  try {
    assertJsonSafe(value)
  } catch {
    return invalid('invalid_frame', 'protocol frame must be JSON-safe data')
  }
  if (isRecord(value) === false) return invalid('invalid_frame', 'protocol frame must be an object')
  if (typeof value.v !== 'number') return invalid('invalid_frame', 'protocol frame has no numeric version')
  if (value.v !== PROTOCOL_VERSION) {
    return invalid('invalid_protocol_version', 'unsupported protocol version: ' + String(value.v))
  }
  if (typeof value.t !== 'string' || value.t.length === 0) return invalid('invalid_frame', 'protocol frame has no type')
  const allowed = direction === 'client' ? CLIENT_MESSAGE_TYPE_SET : SERVER_MESSAGE_TYPE_SET
  if (allowed.has(value.t) === false) return invalid('unknown_message_type', 'message type is not valid for this direction')
  if (REQUEST_CORRELATED.has(value.t) && isNonEmptyString(value.requestId) === false) {
    return invalid('missing_request_id', 'message requires a non-empty requestId')
  }
  if (value.requestId !== undefined && isNonEmptyString(value.requestId) === false) {
    return invalid('invalid_frame', 'requestId must be a non-empty string')
  }
  return { ok: true, value }
}

export function parseClientMessage(value: unknown): ProtocolValidationResult<ClientToServer> {
  const core = parseCore(value, 'client')
  if (core.ok === false) return core
  const message = core.value
  switch (message.t) {
    case 'hello':
      if (hello(message) === false) return invalid('invalid_frame', 'invalid hello frame')
      break
    case 'command': {
      if (isNonEmptyString(message.opId) === false) return invalid('invalid_frame', 'command requires opId')
      if (message.observedRevision !== undefined && isNonNegativeInteger(message.observedRevision) === false) {
        return invalid('invalid_frame', 'observedRevision must be a non-negative integer')
      }
      const parsed = parsePetCommand(message.command)
      if (parsed.ok === false) return invalid('invalid_command', parsed.error.message)
      break
    }
    case 'commandStatus':
      if (isNonEmptyString(message.opId) === false) return invalid('invalid_frame', 'commandStatus requires opId')
      break
    case 'exportBundle':
      break
    case 'resync':
      if (optionalNonNegativeInteger(message, 'lastRevision') === false) return invalid('invalid_frame', 'invalid lastRevision')
      if (optionalNonNegativeInteger(message, 'lastEventSeq') === false) return invalid('invalid_frame', 'invalid lastEventSeq')
      if (message.discardCachedAuthority !== undefined && typeof message.discardCachedAuthority !== 'boolean') {
        return invalid('invalid_frame', 'discardCachedAuthority must be boolean')
      }
      break
    case 'ping':
      if (isSafeInteger(message.nonce) === false) return invalid('invalid_frame', 'ping nonce must be a safe integer')
      break
    default:
      return invalid('unknown_message_type', 'unknown client message')
  }
  return { ok: true, value: message as unknown as ClientToServer }
}

export function parseServerMessage(value: unknown): ProtocolValidationResult<ServerToClient> {
  const core = parseCore(value, 'server')
  if (core.ok === false) return core
  const message = core.value
  switch (message.t) {
    case 'welcome':
      if (welcome(message) === false) return invalid('invalid_frame', 'invalid welcome frame')
      break
    case 'snapshot':
      if (snapshotLike(message, false) === false) return invalid('invalid_frame', 'invalid snapshot frame')
      break
    case 'replay':
      if (isNonNegativeInteger(message.fromEventSeq) === false || isNonNegativeInteger(message.toEventSeq) === false) {
        return invalid('invalid_frame', 'invalid replay bounds')
      }
      if (orderedEvents(message.events) === false) return invalid('invalid_frame', 'invalid replay events')
      break
    case 'ready':
      if (isNonNegativeInteger(message.revision) === false || isNonNegativeInteger(message.eventSeq) === false) {
        return invalid('invalid_frame', 'invalid ready revision/eventSeq')
      }
      if (isSafeInteger(message.gameTimeMs) === false) return invalid('invalid_frame', 'invalid ready gameTimeMs')
      if (isNonEmptyString(message.timeZone) === false || typeof message.advanceWhileEmpty !== 'boolean') {
        return invalid('invalid_frame', 'invalid ready settings')
      }
      if (validateWireAuthority(message.authority) === false || typeof message.catchingUp !== 'boolean') {
        return invalid('invalid_frame', 'invalid ready authority/catch-up state')
      }
      break
    case 'projection':
      if (snapshotLike(message, true) === false) return invalid('invalid_frame', 'invalid projection frame')
      break
    case 'commandResult':
      if (commandResult(message) === false) return invalid('invalid_frame', 'invalid commandResult frame')
      break
    case 'commandStatusResult':
      if (commandStatusResult(message) === false) return invalid('invalid_frame', 'invalid commandStatusResult frame')
      break
    case 'portableBundle':
      if (validatePortablePetBundle(message.bundle) === false) return invalid('invalid_frame', 'invalid portable bundle')
      break
    case 'deviceRevoked':
      if (isNonEmptyString(message.deviceId) === false || isNonNegativeInteger(message.revokedAtMs) === false) {
        return invalid('invalid_frame', 'invalid deviceRevoked frame')
      }
      break
    case 'authorityResetRequired':
      if (message.code !== 'authority_reset_required') return invalid('invalid_frame', 'invalid authority reset code')
      if (validateAuthorityStamp(message.authority) === false) return invalid('invalid_frame', 'invalid authority stamp')
      if (message.reason !== 'restore_rollback' && message.reason !== 'authority_mismatch' && message.reason !== 'cache_newer') {
        return invalid('invalid_frame', 'invalid authority reset reason')
      }
      if (message.requireFullSnapshot !== true) return invalid('invalid_frame', 'authority reset requires a full snapshot')
      break
    case 'error':
      if (protocolError(message) === false) return invalid('invalid_frame', 'invalid error frame')
      break
    case 'pong':
      if (isSafeInteger(message.nonce) === false || isSafeInteger(message.serverTimeMs) === false) {
        return invalid('invalid_frame', 'invalid pong frame')
      }
      break
    default:
      return invalid('unknown_message_type', 'unknown server message')
  }
  return { ok: true, value: message as unknown as ServerToClient }
}

export function validateClientMessage(value: unknown): value is ClientToServer {
  return parseClientMessage(value).ok
}

export function validateServerMessage(value: unknown): value is ServerToClient {
  return parseServerMessage(value).ok
}
