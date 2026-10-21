import {
  assertNoNeverUpload,
  assertSharedSaveData,
  type SharedSaveData,
} from '../../src/shared/sync/data-boundary'
import type { OrderedEvent } from '../../src/shared/pet-runtime/events'
import { assertJsonSafe } from '../../src/shared/pet-runtime/serialization'

/** Final projection boundary. It rejects device-only or never-uploaded data at any depth. */
export function assertPublicSave(value: unknown): asserts value is SharedSaveData {
  assertJsonSafe(value)
  assertNoNeverUpload(value)
  assertSharedSaveData(value)
}

export function assertPublicEvent(value: unknown): asserts value is OrderedEvent {
  assertJsonSafe(value)
  assertNoNeverUpload(value)
}
