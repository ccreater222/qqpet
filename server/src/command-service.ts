import { randomUUID } from 'node:crypto'
import {
  commandRole,
  PORTABLE_BUNDLE_FORMAT,
  PORTABLE_BUNDLE_SCHEMA_VERSION,
  type CommandPayloadMap,
  type PetCommand,
  type PortablePetBundleV1,
  type WireCommandResult,
} from '../../src/shared/sync/index'
import type { OrderedEvent } from '../../src/shared/pet-runtime/events'
import { stableStringify, type CoverageSurvivor, type EngineState } from '../../src/shared/pet-runtime/index'
import { PROTOCOL_VERSION } from '../../src/shared/sync/protocol'
import { AuthService } from './auth'
import type { AuthorityRecord, CommandRecord, DatabaseStore, PetRecord } from './db'
import type { Logger } from './logging'
import { MetricsRegistry } from './metrics'
import { planPortableImport } from './portable-import'
import { RuntimeHost } from './runtime-host'

export interface CommitContext {
  petId: string
  deviceId: string
  role: 'owner' | 'player'
}

export interface CommandExecutionOptions {
  /**
   * Runs after all import authorization, catch-up, idempotency and plan
   * validation checks succeed, while still occupying this pet's command queue.
   * The callback runs exactly once for the command attempt and before mutation.
   */
  beforePortableImportCommit?: () => Promise<void>
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

function sameCommandIdentity(row: CommandRecord, command: PetCommand): boolean {
  if (row.commandType !== command.type) return false
  try {
    return stableStringify(JSON.parse(row.payloadJson)) === stableStringify(command.payload)
  } catch {
    return false
  }
}

export class CommandService {
  private readonly queues = new Map<string, Promise<unknown>>()
  private coverageSource: CoverageSource | undefined
  private catchingUpGate: ((petId: string) => boolean) | undefined

  constructor(
    private readonly store: DatabaseStore,
    private readonly auth: AuthService,
    private readonly runtime: RuntimeHost,
    private readonly logger: Logger,
    readonly metrics: MetricsRegistry = new MetricsRegistry(),
    private readonly now: () => number = Date.now,
  ) {}

  setCoverageSource(source: CoverageSource): void {
    this.coverageSource = source
  }

  setCatchingUpGate(gate: (petId: string) => boolean): void {
    this.catchingUpGate = gate
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
    options: CommandExecutionOptions = {},
  ): Promise<CommandCommit> {
    return this.enqueue(
      context.petId,
      () => this.executeSerialized(context, requestId, opId, command, observedRevision, options),
    )
  }

  private async executeSerialized(
    context: CommitContext,
    requestId: string,
    opId: string,
    command: PetCommand,
    observedRevision?: number,
    options: CommandExecutionOptions = {},
  ): Promise<CommandCommit> {
    this.auth.recheck(context.petId, context.deviceId)
    const duplicate = this.store.commandByOpId(context.petId, context.deviceId, opId)
    if (duplicate !== undefined) {
      if (sameCommandIdentity(duplicate, command) === false) {
        const snapshot = this.store.loadCanonical(context.petId)
        this.metrics.increment('commands.rejected')
        this.metrics.increment('commands.by_type.' + command.type + '.rejected')
        return {
          result: {
            t: 'commandResult',
            v: PROTOCOL_VERSION,
            requestId,
            opId,
            commandType: command.type,
            status: 'rejected',
            commandSeq: snapshot.pet.commandSeq + 1,
            revision: snapshot.pet.revision,
            eventSeq: snapshot.pet.eventSeq,
            error: {
              code: 'op_id_conflict',
              message: 'opId was already used for a different command',
              refreshProjection: false,
            },
          },
        }
      }
      this.metrics.increment('commands.duplicate')
      return { result: duplicateResult(duplicate, requestId) }
    }
    const snapshot = this.store.loadCanonical(context.petId)
    if (commandRole(command.type) === 'owner' && context.role !== 'owner') {
      return this.rejectWithoutMutation(context, requestId, opId, command, snapshot.pet, {
        code: 'unauthorized',
        message: 'owner authority is required',
        refreshProjection: false,
      })
    }
    if (this.catchingUpGate?.(context.petId) === true) {
      return this.rejectWithoutMutation(context, requestId, opId, command, snapshot.pet, {
        code: 'server_catching_up',
        message: 'the server is catching up historical time; retry after the final snapshot',
        refreshProjection: true,
      })
    }
    if (command.type === 'admin.exportForDetach') {
      return this.executeExportForDetach(context, requestId, opId, snapshot.authority, snapshot.pet, snapshot.engine)
    }
    if (command.type === 'admin.importPortableBundle') {
      return this.executePortableImport(
        context,
        requestId,
        opId,
        command,
        snapshot.pet,
        snapshot.authority,
        false,
        options.beforePortableImportCommit,
      )
    }
    if (command.type === 'admin.resumeServer') {
      return this.executePortableImport(
        context,
        requestId,
        opId,
        command,
        snapshot.pet,
        snapshot.authority,
        true,
        options.beforePortableImportCommit,
      )
    }
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
      this.metrics.increment('commands.rejected')
      this.metrics.increment('commands.by_type.' + command.type + '.rejected')
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
      this.metrics.increment('commands.applied')
      this.metrics.increment('commands.by_type.' + command.type + '.applied')
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

  private detachBundle(
    authority: AuthorityRecord,
    pet: PetRecord,
    engine: EngineState,
    at: number,
  ): PortablePetBundleV1 {
    const closedCoverage = engine.sessionCoverage.map(interval => interval.disconnectedAtWallMs === undefined
      ? { ...interval, disconnectedAtWallMs: at, closeReason: 'authority_handoff' as const }
      : interval)
    return {
      format: PORTABLE_BUNDLE_FORMAT,
      schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
      exportedAtWallMs: at,
      authority: {
        owner: 'server',
        authorityId: authority.authorityId,
        epoch: authority.epoch,
        restoreGeneration: authority.restoreGeneration,
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        handoffId: authority.handoffId,
        detachedAtWallMs: authority.detachedAtMs ?? at,
      },
      shared: engine.save,
      engine: { ...engine, sessionCoverage: closedCoverage },
    }
  }

  private executeExportForDetach(
    context: CommitContext,
    requestId: string,
    opId: string,
    authority: AuthorityRecord,
    pet: PetRecord,
    engine: EngineState,
  ): CommandCommit {
    if (authority.state === 'reset') {
      return this.rejectWithoutMutation(context, requestId, opId, { type: 'admin.exportForDetach', payload: {} }, pet, {
        code: 'authority_not_active',
        message: 'pet authority is not active',
        refreshProjection: true,
      })
    }
    const at = this.now()
    if (authority.state === 'archived') {
      // Idempotent re-send for the same recorded handoff; no epoch or state mutation.
      const bundle = this.detachBundle(authority, pet, engine, at)
      return this.store.transaction(() => {
        const commandSeq = this.bumpCommandSequence(context.petId, pet.commandSeq, at)
        this.store.insertCommand(context.petId, {
          commandSeq,
          opId,
          deviceId: context.deviceId,
          commandType: 'admin.exportForDetach',
          payload: {},
          status: 'applied',
          result: { authority: bundle.authority, bundle },
          revision: pet.revision,
          eventSeq: pet.eventSeq,
          createdAtMs: at,
        })
        this.metrics.increment('commands.applied')
        this.metrics.increment('commands.by_type.admin.exportForDetach.applied')
        this.metrics.increment('authority.detach_resends')
        return {
          result: {
            t: 'commandResult',
            v: PROTOCOL_VERSION,
            requestId,
            opId,
            commandType: 'admin.exportForDetach',
            status: 'applied',
            commandSeq,
            revision: pet.revision,
            eventSeq: pet.eventSeq,
            result: { authority: bundle.authority, bundle } as never,
          },
        }
      })
    }
    const survivors = this.coverageSource === undefined ? [] : this.coverageSource.currentSurvivors(context.petId)
    const nextEpoch = authority.epoch + 1
    const operationId = randomUUID()
    const bundle = this.detachBundle(authority, pet, engine, at)
    return this.store.transaction(() => {
      this.store.applyAuthorityArchive({
        petId: context.petId,
        nextEpoch,
        handoffId: authority.handoffId,
        operationId,
        at,
        survivors,
      })
      const commandSeq = this.bumpCommandSequence(context.petId, pet.commandSeq, at)
      this.store.insertCommand(context.petId, {
        commandSeq,
        opId,
        deviceId: context.deviceId,
        commandType: 'admin.exportForDetach',
        payload: {},
        status: 'applied',
        result: { authority: bundle.authority, bundle },
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        createdAtMs: at,
      })
      this.metrics.increment('commands.applied')
      this.metrics.increment('commands.by_type.admin.exportForDetach.applied')
      this.metrics.increment('authority.archived')
      return {
        result: {
          t: 'commandResult',
          v: PROTOCOL_VERSION,
          requestId,
          opId,
          commandType: 'admin.exportForDetach',
          status: 'applied',
          commandSeq,
          revision: pet.revision,
          eventSeq: pet.eventSeq,
          result: { authority: bundle.authority, bundle } as never,
        },
      }
    })
  }

  private async executePortableImport(
    context: CommitContext,
    requestId: string,
    opId: string,
    command:
      | Extract<PetCommand, { type: 'admin.importPortableBundle' }>
      | Extract<PetCommand, { type: 'admin.resumeServer' }>,
    pet: PetRecord,
    authority: AuthorityRecord,
    resumeMode: boolean,
    beforeCommit?: () => Promise<void>,
  ): Promise<CommandCommit> {
    const at = this.now()
    // Device administration does not claim canonical pet authority. Any other
    // applied command means the destination has already chosen a canonical
    // lineage, so an independent local lineage is a fork rather than migration.
    const appliedCommand = this.store.db.prepare(
      `SELECT 1 AS found FROM commands
       WHERE pet_id = ? AND status = 'applied'
         AND command_type NOT IN ('device.list', 'device.revoke')
       LIMIT 1`,
    ).get(context.petId) as { found: number } | undefined
    const planned = planPortableImport({
      bundle: command.payload.bundle,
      current: authority,
      wallNowMs: at,
      allowClamp: command.payload.allowClamp === true,
      resumeMode,
      uploaderDeviceId: context.deviceId,
      rebindLocalSessions: command.payload.rebindLocalSessions === true,
      destinationHasNoAppliedCommands: appliedCommand === undefined,
      ...(resumeMode ? { expectedEpoch: (command.payload as { expectedEpoch: number }).expectedEpoch } : {}),
    })
    if (planned.ok === false) {
      return this.rejectWithoutMutation(context, requestId, opId, command, pet, {
        code: planned.code,
        message: planned.message,
        refreshProjection: true,
      })
    }
    if (beforeCommit !== undefined) await beforeCommit()
    const survivors = this.coverageSource === undefined ? [] : this.coverageSource.currentSurvivors(context.petId)
    const operationId = randomUUID()
    const handoffId = randomUUID()
    return this.store.transaction(() => {
      const nextPet = this.store.applyCanonicalImport({
        petId: context.petId,
        engine: planned.plan.engine,
        authorityId: planned.plan.authorityId,
        restoreGeneration: planned.plan.restoreGeneration,
        nextEpoch: planned.plan.nextEpoch,
        handoffId,
        sourceRevision: command.payload.bundle.authority.revision,
        sourceEventSeq: command.payload.bundle.authority.eventSeq,
        importedCoverage: planned.plan.importedCoverage,
        operationId,
        commitWallMs: at,
        survivors,
        baseRevision: command.payload.bundle.authority.revision,
        baseEventSeq: command.payload.bundle.authority.eventSeq,
        at,
      })
      const commandSeq = this.bumpCommandSequence(context.petId, pet.commandSeq, at)
      const importedSessions = new Map(planned.plan.engine.gameSessions.map(session => [session.sessionToken, session]))
      let eventSeq = nextPet.eventSeq
      const orderedEvents: OrderedEvent[] = []
      for (const before of command.payload.bundle.engine.gameSessions) {
        if (before.status !== 'active') continue
        const after = importedSessions.get(before.sessionToken)
        if (after !== undefined && after.status === 'active') continue
        eventSeq += 1
        const orderedEvent: OrderedEvent = {
          eventSeq,
          revision: nextPet.revision,
          commandSeq,
          gameTimeMs: planned.plan.engine.gameTimeMs,
          type: 'game.sessionSettled',
          payload: {
            kind: before.payload.kind,
            status: after === undefined ? 'abandoned' : after.status,
            cancelReason: after?.cancelReason ?? 'actor_rebind_failed',
          },
        }
        orderedEvents.push(orderedEvent)
        this.store.insertEvent(context.petId, { ...orderedEvent, commandSeq, createdAtMs: at })
      }
      if (eventSeq !== nextPet.eventSeq) {
        this.store.db.prepare('UPDATE pets SET event_seq = ? WHERE id = ?').run(eventSeq, context.petId)
      }
      const committedPet = { ...nextPet, commandSeq, eventSeq }
      const result = {
        imported: true,
        resumed: resumeMode,
        epoch: planned.plan.nextEpoch,
        effectiveAnchorWallMs: planned.plan.effectiveAnchorWallMs,
        clockSkippedMs: planned.plan.clockSkippedMs,
        importClamped: planned.plan.importClamped,
      }
      this.store.insertCommand(context.petId, {
        commandSeq,
        opId,
        deviceId: context.deviceId,
        commandType: command.type,
        payload: command.payload as unknown as Record<string, unknown>,
        status: 'applied',
        result,
        revision: committedPet.revision,
        eventSeq,
        createdAtMs: at,
      })
      this.metrics.increment('commands.applied')
      this.metrics.increment('commands.by_type.' + command.type + '.applied')
      this.metrics.increment('authority.imported')
      if (planned.plan.importClamped) this.metrics.increment('authority.import_clamped')
      return {
        result: {
          t: 'commandResult',
          v: PROTOCOL_VERSION,
          requestId,
          opId,
          commandType: command.type,
          status: 'applied',
          commandSeq,
          revision: committedPet.revision,
          eventSeq,
          result: result as never,
        },
        projection: { pet: committedPet, events: orderedEvents },
        coverageReopen: { operationId, commitWallMs: at, survivors },
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
      this.metrics.increment('commands.applied')
      this.metrics.increment('commands.by_type.device.list.applied')
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
      this.metrics.increment('commands.applied')
      this.metrics.increment('commands.by_type.device.revoke.applied')
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
    this.metrics.increment('commands.rejected')
    this.metrics.increment('commands.by_type.' + command.type + '.rejected')
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
