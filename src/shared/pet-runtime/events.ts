import type { JsonObject } from './types'

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
