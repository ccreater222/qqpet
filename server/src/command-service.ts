import { randomUUID } from 'node:crypto'
import {
  commandRole,
  type CommandPayloadMap,
  type PetCommand,
  type WireCommandResult,
} from '../../src/shared/sync/index'
import type { OrderedEvent } from '../../src/shared/pet-runtime/events'
import type { CoverageSurvivor } from '../../src/shared/pet-runtime/index'
import { PROTOCOL_VERSION } from '../../src/shared/sync/protocol'
import { AuthService } from './auth'
import type { CommandRecord, DatabaseStore, PetRecord } from './db'
import type { Logger } from './logging'
import { RuntimeHost } from './runtime-host'

export interface CommitContext {
  petId: string
  deviceId: string
  role: 'owner' | 'player'
}

export interface CommandCommit {
  result: WireCommandResult
  projection?: {
    pet: PetRecord
    events: OrderedEvent[]
  }
  /** Present when a pet.reset committed a pending close-and-reopen coverage operation. */
  coverageReopen?: {
    operationId: string
    commitWallMs: number
    survivors: CoverageSurvivor[]
  }
}

export interface CoverageSource {
  currentSurvivors(petId: string): CoverageSurvivor[]
}

function storedResult(row: CommandRecord, requestId: string): WireCommandResult {
  const commandType = row.commandType as keyof CommandPayloadMap
  const result = row.resultJson === null ? undefined : JSON.parse(row.resultJson) as unknown
  const error = row.errorJson === null ? undefined : JSON.parse(row.errorJson) as WireCommandResult['error']
  return {
    t: 'commandResult',
    v: PROTOCOL_VERSION,
    requestId,
    opId: row.opId,
    commandType,
    status: row.status,
    commandSeq: row.commandSeq,
    revision: row.revision,
    eventSeq: row.eventSeq,
    ...(result === undefined ? {} : { result: result as never }),
    ...(error === undefined ? {} : { error }),
  }
}

function duplicateResult(row: CommandRecord, requestId: string): WireCommandResult {
  return {
    ...storedResult(row, requestId),
    status: 'duplicate',
    original: row.status,
  } as WireCommandResult & { original: 'applied' | 'rejected' }
}

export class CommandService {
  private readonly queues = new Map<string, Promise<unknown>>()
  private coverageSource: CoverageSource | undefined

  constructor(
    private readonly store: DatabaseStore,
    private readonly auth: AuthService,
    private readonly runtime: RuntimeHost,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  setCoverageSource(source: CoverageSource): void {
    this.coverageSource = source
  }

  async enqueue<T>(petId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(petId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.queues.set(petId, next)
    try {
      return await next
    } finally {
      if (this.queues.get(petId) === next) this.queues.delete(petId)
    }
  }

  execute(
    context: CommitContext,
    requestId: string,
    opId: string,
    command: PetCommand,
    observedRevision?: number,
  ): Promise<CommandCommit> {
    return this.enqueue(context.petId, () => this.executeSerialized(context, requestId, opId, command, observedRevision))
  }

  private executeSerialized(
    context: CommitContext,
    requestId: string,
    opId: string,
    command: PetCommand,
    observedRevision?: number,
  ): CommandCommit {
    this.auth.recheck(context.petId, context.deviceId)
    const duplicate = this.store.commandByOpId(context.petId, context.deviceId, opId)
    if (duplicate !== undefined) {
      return { result: duplicateResult(duplicate, requestId) }
    }
    const snapshot = this.store.loadCanonical(context.petId)
    if (snapshot.authority.state !== 'active') {
      return this.rejectWithoutMutation(context, requestId, opId, command, snapshot.pet, {
        code: 'authority_not_active',
        message: 'pet authority is not active',
        refreshProjection: true,
      })
    }
    if (observedRevision !== undefined && observedRevision > snapshot.pet.revision) {
      return this.rejectWithoutMutation(context, requestId, opId, command, snapshot.pet, {
        code: 'invalid_payload',
        message: 'observed revision is newer than the server',
        refreshProjection: true,
      })
    }
    if (commandRole(command.type) === 'owner' && context.role !== 'owner') {
      return this.rejectWithoutMutation(context, requestId, opId, command, snapshot.pet, {
        code: 'unauthorized',
        message: 'owner authority is required',
        refreshProjection: false,
      })
    }
    // Device administration is server authority: it mutates the device registry,
    // not canonical gameplay state, and must not be routed through the gameplay runtime.
    if (command.type === 'device.list') {
      return this.executeDeviceList(context, requestId, opId, snapshot.pet)
    }
    if (command.type === 'device.revoke') {
      return this.executeDeviceRevoke(context, requestId, opId, command, snapshot.pet)
    }
    const at = this.now()
    const computed = this.runtime.execute(snapshot.engine, {
      command,
      deviceId: context.deviceId,
      role: context.role,
      gameTimeMs: snapshot.pet.gameTimeMs,
    })
    const commandSeq = snapshot.pet.commandSeq + 1
    if (computed.outcome.ok === false) {
      const rejection = computed.outcome
      if (observedRevision !== undefined && observedRevision < snapshot.pet.revision) {
        rejection.error.refreshProjection = true
      }
      return this.store.transaction(() => {
        const nextCommand = this.store.db.prepare(
          'UPDATE pets SET command_seq = ?, updated_at_ms = ? WHERE id = ? AND command_seq = ?',
        ).run(commandSeq, at, context.petId, snapshot.pet.commandSeq)
        if (Number(nextCommand.changes) !== 1) throw new Error('command_sequence_conflict')
        this.store.insertCommand(context.petId, {
          commandSeq,
          opId,
          deviceId: context.deviceId,
          commandType: command.type,
          payload: command.payload as Record<string, unknown>,
          status: 'rejected',
          error: rejection.error,
          revision: snapshot.pet.revision,
          eventSeq: snapshot.pet.eventSeq,
          createdAtMs: at,
        })
        const result = storedResult({
          petId: context.petId,
          commandSeq,
          opId,
          deviceId: context.deviceId,
          commandType: command.type,
          payloadJson: JSON.stringify(command.payload),
          status: 'rejected',
          resultJson: null,
          errorJson: JSON.stringify(rejection.error),
          revision: snapshot.pet.revision,
          eventSeq: snapshot.pet.eventSeq,
          createdAtMs: at,
        }, requestId)
        return { result }
      })
    }
    const applied = computed.outcome
    const resetSurvivors = command.type === 'pet.reset'
      ? (this.coverageSource === undefined ? [] : this.coverageSource.currentSurvivors(context.petId))
      : undefined
    const coverageOperationId = resetSurvivors === undefined ? undefined : randomUUID()
    return this.store.transaction(() => {
      const nextPet = this.store.replaceEngineAndRevision(context.petId, computed.engine, snapshot.pet.revision, true, at)
      const nextCommand = this.store.db.prepare(
        'UPDATE pets SET command_seq = ? WHERE id = ? AND command_seq = ?',
      ).run(commandSeq, context.petId, snapshot.pet.commandSeq)
      if (Number(nextCommand.changes) !== 1) throw new Error('command_sequence_conflict')
      let eventSeq = snapshot.pet.eventSeq
      const events: OrderedEvent[] = []
      for (const event of applied.events) {
        eventSeq += 1
        const ordered = {
          eventSeq,
          revision: nextPet.revision,
          commandSeq,
          gameTimeMs: computed.engine.gameTimeMs,
          type: event.type,
          payload: event.payload,
        }
        events.push(ordered)
        this.store.insertEvent(context.petId, { ...ordered, createdAtMs: at })
      }
      this.store.db.prepare('UPDATE pets SET event_seq = ? WHERE id = ?').run(eventSeq, context.petId)
      this.store.insertCommand(context.petId, {
        commandSeq,
        opId,
        deviceId: context.deviceId,
        commandType: command.type,
        payload: command.payload as Record<string, unknown>,
        status: 'applied',
        result: applied.result,
        revision: nextPet.revision,
        eventSeq,
        createdAtMs: at,
      })
      if (coverageOperationId !== undefined && resetSurvivors !== undefined) {
        this.store.closeAndCreateCoverageOperation(
          context.petId,
          coverageOperationId,
          at,
          resetSurvivors,
          'pet_reset',
        )
      }
      const committedPet = { ...nextPet, commandSeq, eventSeq }
      const result: WireCommandResult = {
        t: 'commandResult',
        v: PROTOCOL_VERSION,
        requestId,
        opId,
        commandType: command.type,
        status: 'applied',
        commandSeq,
        revision: committedPet.revision,
        eventSeq,
        ...(applied.result === undefined ? {} : { result: applied.result as never }),
      }
      this.logger.info('command.committed', {
        petId: context.petId,
        deviceId: context.deviceId,
        commandType: command.type,
        commandSeq,
        revision: committedPet.revision,
        eventSeq,
      })
      return {
        result,
        projection: { pet: committedPet, events },
        ...(coverageOperationId === undefined || resetSurvivors === undefined
          ? {}
          : { coverageReopen: { operationId: coverageOperationId, commitWallMs: at, survivors: resetSurvivors } }),
      }
    })
  }

  private bumpCommandSequence(petId: string, expected: number, at: number): number {
    const commandSeq = expected + 1
    const changed = this.store.db.prepare(
      'UPDATE pets SET command_seq = ?, updated_at_ms = ? WHERE id = ? AND command_seq = ?',
    ).run(commandSeq, at, petId, expected)
    if (Number(changed.changes) !== 1) throw new Error('command_sequence_conflict')
    return commandSeq
  }

  private executeDeviceList(
    context: CommitContext,
    requestId: string,
    opId: string,
    pet: PetRecord,
  ): CommandCommit {
    const at = this.now()
    const devices = this.store.listDevices(context.petId).map(device => ({
      deviceId: device.deviceId,
      label: device.label,
      role: device.role,
      createdAtMs: device.createdAtMs,
      ...(device.lastSeenAtMs === null ? {} : { lastSeenAtMs: device.lastSeenAtMs }),
      ...(device.revokedAtMs === null ? {} : { revokedAtMs: device.revokedAtMs }),
    }))
    return this.store.transaction(() => {
      const commandSeq = this.bumpCommandSequence(context.petId, pet.commandSeq, at)
      const result = { devices }
      this.store.insertCommand(context.petId, {
        commandSeq,
        opId,
        deviceId: context.deviceId,
        commandType: 'device.list',
        payload: {},
        status: 'applied',
        result,
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        createdAtMs: at,
      })
      return {
        result: {
          t: 'commandResult',
          v: PROTOCOL_VERSION,
          requestId,
          opId,
          commandType: 'device.list',
          status: 'applied',
          commandSeq,
          revision: pet.revision,
          eventSeq: pet.eventSeq,
          result: result as never,
        },
      }
    })
  }

  private executeDeviceRevoke(
    context: CommitContext,
    requestId: string,
    opId: string,
    command: Extract<PetCommand, { type: 'device.revoke' }>,
    pet: PetRecord,
  ): CommandCommit {
    const at = this.now()
    const target = this.store.getDevice(context.petId, command.payload.deviceId)
    if (target === undefined) {
      return this.rejectWithoutMutation(context, requestId, opId, command, pet, {
        code: 'invalid_payload',
        message: 'device not found',
        refreshProjection: false,
      })
    }
    if (target.role === 'owner' && target.revokedAtMs === null) {
      const activeOwners = this.store.listDevices(context.petId)
        .filter(device => device.role === 'owner' && device.revokedAtMs === null).length
      if (activeOwners <= 1) {
        return this.rejectWithoutMutation(context, requestId, opId, command, pet, {
          code: 'unauthorized',
          message: 'cannot revoke the last active owner',
          refreshProjection: false,
        })
      }
    }
    return this.store.transaction(() => {
      const commandSeq = this.bumpCommandSequence(context.petId, pet.commandSeq, at)
      const revokedAtMs = target.revokedAtMs ?? at
      if (target.revokedAtMs === null) {
        this.store.db.prepare(
          'UPDATE devices SET revoked_at_ms = ? WHERE pet_id = ? AND device_id = ? AND revoked_at_ms IS NULL',
        ).run(revokedAtMs, context.petId, target.deviceId)
      }
      const result = { deviceId: target.deviceId, revokedAtMs }
      this.store.insertCommand(context.petId, {
        commandSeq,
        opId,
        deviceId: context.deviceId,
        commandType: 'device.revoke',
        payload: { deviceId: target.deviceId },
        status: 'applied',
        result,
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        createdAtMs: at,
      })
      return {
        result: {
          t: 'commandResult',
          v: PROTOCOL_VERSION,
          requestId,
          opId,
          commandType: 'device.revoke',
          status: 'applied',
          commandSeq,
          revision: pet.revision,
          eventSeq: pet.eventSeq,
          result: result as never,
        },
      }
    })
  }

  private rejectWithoutMutation(
    context: CommitContext,
    requestId: string,
    opId: string,
    command: PetCommand,
    pet: PetRecord,
    error: { code: string; message: string; refreshProjection: boolean },
  ): CommandCommit {
    const at = this.now()
    return this.store.transaction(() => {
      const commandSeq = pet.commandSeq + 1
      const change = this.store.db.prepare(
        'UPDATE pets SET command_seq = ?, updated_at_ms = ? WHERE id = ? AND command_seq = ?',
      ).run(commandSeq, at, context.petId, pet.commandSeq)
      if (Number(change.changes) !== 1) throw new Error('command_sequence_conflict')
      this.store.insertCommand(context.petId, {
        commandSeq,
        opId,
        deviceId: context.deviceId,
        commandType: command.type,
        payload: command.payload as Record<string, unknown>,
        status: 'rejected',
        error,
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        createdAtMs: at,
      })
      return {
        result: {
          t: 'commandResult',
          v: PROTOCOL_VERSION,
          requestId,
          opId,
          commandType: command.type,
          status: 'rejected',
          commandSeq,
          revision: pet.revision,
          eventSeq: pet.eventSeq,
          error,
        },
      }
    })
  }

  commandStatus(context: CommitContext, requestId: string, opId: string): {
    t: 'commandStatusResult'
    v: 1
    requestId: string
    opId: string
    status: 'applied' | 'rejected' | 'not_applied'
    result?: WireCommandResult
  } {
    this.auth.recheck(context.petId, context.deviceId)
    const row = this.store.commandStatus(context.petId, context.deviceId, opId)
    if (row === undefined) {
      return { t: 'commandStatusResult', v: PROTOCOL_VERSION, requestId, opId, status: 'not_applied' }
    }
    return {
      t: 'commandStatusResult',
      v: PROTOCOL_VERSION,
      requestId,
      opId,
      status: row.status,
      result: storedResult(row, requestId),
    }
  }
}
