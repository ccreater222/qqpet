import type { JsonObject } from './types'

/** Stable semantic event identifiers from the C2 MVP catalog. */
export const DOMAIN_EVENT_TYPES = [
  'pet.statsChanged',
  'pet.levelChanged',
  'pet.illnessChanged',
  'pet.died',
  'inventory.changed',
  'item.consumed',
  'reward.granted',
  'activity.started',
  'activity.completed',
  'task.progress',
  'task.claimed',
  'mail.arrived',
  'mail.claimed',
  'signin.changed',
  'vip.changed',
  'game.sessionStarted',
  'game.sessionSettled',
  'island.errandChanged',
  'island.combatSettled',
  'island.rewardGranted',
  'farm.changed',
  'fishing.changed',
  'system.snapshotBoundary',
  'system.catchUpCompleted',
] as const

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number]

/** Ordered event types emitted by runtime hosts, including host/administration events. */
export const ORDERED_EVENT_TYPES = [
  ...DOMAIN_EVENT_TYPES,
  'admin.grant',
  'achievement.unlocked',
  'island.letterAccepted',
  'island.letterDelivered',
  'island.newsRefreshed',
  'server.changed',
  'settings.changed',
  'social.visitCompleted',
] as const

/** A domain event ordered by the committing host for wire/projection delivery. */
export interface OrderedEvent<
  TType extends string = string,
  TPayload extends JsonObject = JsonObject,
> {
  eventSeq: number
  revision: number
  commandSeq?: number
  gameTimeMs: number
  type: TType
  payload: TPayload
}

/** A deterministic domain event before a host assigns its global sequence. */
export interface DomainEvent<
  TType extends string = string,
  TPayload extends JsonObject = JsonObject,
> {
  type: TType
  payload: TPayload
}

/** A domain event after the committing host assigned an ordered event sequence. */
export interface OrderedDomainEvent<
  TType extends string = string,
  TPayload extends JsonObject = JsonObject,
> extends DomainEvent<TType, TPayload> {
  eventSeq: number
}

export function domainEvent<TType extends string, TPayload extends JsonObject>(
  type: TType,
  payload: TPayload,
): DomainEvent<TType, TPayload> {
  return { type, payload }
}

export function orderedDomainEvent<TType extends string, TPayload extends JsonObject>(
  eventSeq: number,
  event: DomainEvent<TType, TPayload>,
): OrderedDomainEvent<TType, TPayload> {
  if (Number.isSafeInteger(eventSeq) === false || eventSeq <= 0) throw new Error('eventSeq must be a positive safe integer')
  return { eventSeq, type: event.type, payload: event.payload }
}

/** Asserts that an event list is in strictly increasing host sequence order. */
export function assertOrderedEvents(events: readonly OrderedDomainEvent[]): void {
  let previous = 0
  for (const event of events) {
    if (Number.isSafeInteger(event.eventSeq) === false || event.eventSeq <= previous) {
      throw new Error('ordered events must have strictly increasing positive eventSeq values')
    }
    previous = event.eventSeq
  }
}

/** Asserts that wire events are strictly ordered and carry non-negative revisions. */
export function assertOrderedEventStream(events: readonly OrderedEvent[]): void {
  let previousEventSeq = 0
  let previousRevision = -1
  for (const event of events) {
    if (Number.isSafeInteger(event.eventSeq) === false || event.eventSeq <= previousEventSeq) {
      throw new Error('ordered events must have strictly increasing positive eventSeq values')
    }
    if (Number.isSafeInteger(event.revision) === false || event.revision < 0 || event.revision < previousRevision) {
      throw new Error('ordered events must have non-decreasing non-negative revisions')
    }
    if (event.commandSeq !== undefined && (Number.isSafeInteger(event.commandSeq) === false || event.commandSeq < 0)) {
      throw new Error('commandSeq must be a non-negative safe integer')
    }
    if (Number.isSafeInteger(event.gameTimeMs) === false) throw new Error('event gameTimeMs must be a safe integer')
    previousEventSeq = event.eventSeq
    previousRevision = event.revision
  }
}
