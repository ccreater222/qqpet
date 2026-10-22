import { mkdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import type { RawData, WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientHello,
  type CommandRequest,
  type CommandStatusRequest,
  type ErrorMessage,
  type OrderedEvent,
  type PortableBundleRequest,
  type ReplayMessage,
  type ResyncRequest,
  type ServerToClient,
  type SnapshotMessage,
  type Welcome,
} from '../../src/shared/sync/index'
import { PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_SCHEMA_VERSION } from '../../src/shared/sync/portable'
import type { CoverageSurvivor } from '../../src/shared/pet-runtime/index'
import { assertPublicEvent, assertPublicSave } from './validation'
import { AuthenticationError, RevokedDeviceError, type AuthService } from './auth'
import type { CommandService } from './command-service'
import type { ServerConfig } from './config'
import type { DatabaseStore, PetRecord } from './db'
import { SocketHub, type LiveConnection } from './hub'
import type { Logger } from './logging'
import { MetricsRegistry } from './metrics'

const CLOSE_AUTH_FAILED = 4000
const CLOSE_PROTOCOL_MISMATCH = 4001
const CLOSE_SUPERSEDED = 4002
const CLOSE_RATE_LIMITED = 4003
const CLOSE_INVALID_FRAME = 4004
const CLOSE_PAYLOAD_TOO_LARGE = 4005
const CLOSE_SERVER_ERROR = 4006
const PRE_AUTH_RATE_PER_SECOND = 5
const PRE_AUTH_BURST = 10
const EXPENSIVE_RATE_PER_SECOND = 2
const EXPENSIVE_BURST = 4

class RateWindow {
  private tokens: number
  private updatedAt: number
  private readonly capacity: number

  constructor(
    private readonly perSecond: number,
    burst: number,
    at: number,
  ) {
    this.capacity = Math.max(1, burst)
    this.tokens = this.capacity
    this.updatedAt = at
  }

  take(at: number): boolean {
    this.tokens = Math.min(this.tokens + (at - this.updatedAt) / 1000 * this.perSecond, this.capacity)
    this.updatedAt = at
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  refund(): void {
    this.tokens = Math.min(this.capacity, this.tokens + 1)
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

interface DeliveryPlan {
  delivery: Welcome['delivery']
  replay?: ReplayMessage
}

export class SessionService {
  readonly hub: SocketHub
  private nextConnection = 1
  private heartbeatTimer: NodeJS.Timeout | undefined
  private pingTimer: NodeJS.Timeout | undefined
  private catchingUpSource: ((petId: string) => boolean) | undefined
  private readonly preAuthRates = new Map<string, RateWindow>()
  private readonly deviceCommandRates = new Map<string, RateWindow>()
  private readonly deviceExpensiveRates = new Map<string, RateWindow>()

  constructor(
    private readonly config: ServerConfig,
    private readonly store: DatabaseStore,
    private readonly auth: AuthService,
    private readonly commands: CommandService,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
    private readonly now: () => number = Date.now,
  ) {
    this.hub = new SocketHub(store, logger, now, config.maxFrameBytes)
    this.commands.setCoverageSource({ currentSurvivors: petId => this.currentSurvivors(petId) })
  }

  setCatchingUpSource(source: (petId: string) => boolean): void {
    this.catchingUpSource = source
  }

  private isCatchingUp(petId: string): boolean {
    return this.catchingUpSource?.(petId) === true
  }

  private currentSurvivors(petId: string): CoverageSurvivor[] {
    const at = this.now()
    return this.hub.listConnections(petId)
      .filter(connection => connection.authenticated)
      .map(connection => ({
        kind: 'server_connection' as const,
        connectionId: connection.connectionId,
        deviceId: connection.deviceId,
        lastHeartbeatWallMs: at,
        eligible: true,
      }))
  }

  start(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const pet of this.store.listPets()) {
        for (const connection of this.hub.listConnections(pet.id)) {
          this.store.heartbeatCoverage(pet.id, connection.coverageId, this.now())
        }
      }
    }, 10_000)
    this.heartbeatTimer.unref()
    this.pingTimer = setInterval(() => {
      for (const pet of this.store.listPets()) {
        for (const connection of this.hub.listConnections(pet.id)) {
          if (this.now() - connection.lastActivityMs > this.config.idleTimeoutMs) {
            this.hub.remove(connection, 'disconnect')
            connection.socket.close(CLOSE_SUPERSEDED, 'idle_timeout')
            continue
          }
          if (connection.alive === false) {
            this.hub.remove(connection, 'disconnect')
            connection.socket.terminate()
            continue
          }
          connection.alive = false
          connection.socket.ping()
        }
      }
    }, this.config.pingIntervalMs)
    this.pingTimer.unref()
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.heartbeatTimer = undefined
    this.pingTimer = undefined
    this.hub.closeAll('shutdown')
  }

  private rateFor(
    rates: Map<string, RateWindow>,
    key: string,
    perSecond: number,
    burst: number,
    at: number,
  ): RateWindow {
    let rate = rates.get(key)
    if (rate === undefined) {
      rate = new RateWindow(perSecond, burst, at)
      rates.set(key, rate)
    }
    return rate
  }

  private deviceRateKey(connection: LiveConnection): string {
    return connection.petId + ':' + connection.deviceId
  }

  private takeExpensiveRate(connection: LiveConnection): boolean {
    const at = this.now()
    return this.rateFor(
      this.deviceExpensiveRates,
      this.deviceRateKey(connection),
      EXPENSIVE_RATE_PER_SECOND,
      EXPENSIVE_BURST,
      at,
    ).take(at)
  }

  attach(socket: WebSocket, request: IncomingMessage): void {
    const preAuthKey = request.socket.remoteAddress ?? 'unknown'
    const connection: LiveConnection = {
      socket,
      connectionId: 'c-' + this.nextConnection++,
      petId: '',
      deviceId: '',
      role: 'player',
      coverageId: '',
      authenticated: false,
      alive: true,
      lastActivityMs: this.now(),
    }
    let initialized = false
    let closeRecorded = false
    const helloDeadline = setTimeout(() => {
      if (!initialized) this.close(socket, CLOSE_AUTH_FAILED, 'auth_failed')
    }, this.config.helloTimeoutMs)
    helloDeadline.unref()

    socket.on('pong', () => {
      connection.alive = true
      connection.lastActivityMs = this.now()
    })
    socket.on('close', () => {
      if (closeRecorded) return
      closeRecorded = true
      if (connection.authenticated) this.hub.remove(connection, 'socket_closed')
    })
    socket.on('error', error => {
      this.logger.warn('socket.error', { connectionId: connection.connectionId, error })
    })
    socket.on('message', (data: RawData, isBinary: boolean) => {
      connection.lastActivityMs = this.now()
      void this.onMessage(socket, connection, data, isBinary, preAuthKey)
        .then(() => {
          if (connection.authenticated === false) return
          initialized = true
          clearTimeout(helloDeadline)
        })
        .catch(error => {
          this.logger.error('socket.message_failed', { connectionId: connection.connectionId, error })
          this.close(socket, CLOSE_SERVER_ERROR, 'server_error')
        })
    })
  }

  private async onMessage(
    socket: WebSocket,
    connection: LiveConnection,
    data: RawData,
    isBinary: boolean,
    preAuthKey: string,
  ): Promise<void> {
    if (isBinary) {
      this.close(socket, CLOSE_INVALID_FRAME, 'invalid_frame')
      return
    }
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (bytes.byteLength > this.config.maxFrameBytes) {
      this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
      return
    }
    if (!connection.authenticated) {
      if (bytes.byteLength > 16 * 1024) {
        this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
        return
      }
      const at = this.now()
      const preAuthRate = this.rateFor(
        this.preAuthRates,
        preAuthKey,
        PRE_AUTH_RATE_PER_SECOND,
        PRE_AUTH_BURST,
        at,
      )
      if (preAuthRate.take(at) === false) {
        this.metrics.increment('rate_limits.hits')
        this.metrics.increment('rate_limits.pre_auth')
        this.close(socket, CLOSE_RATE_LIMITED, 'rate_limited')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        this.close(socket, CLOSE_INVALID_FRAME, 'invalid_frame')
        return
      }
      await this.hello(socket, connection, parsed)
      if (connection.authenticated) preAuthRate.refund()
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      this.send(socket, this.error('invalid_frame', 'invalid JSON frame', false, this.requestIdOf(bytes)))
      return
    }
    // Parse before enforcing the command limit. Matching raw substrings lets
    // pretty-printed or escaped JSON bypass maxCommandBytes.
    if (asObject(parsed)?.t === 'command' && bytes.byteLength > this.config.maxCommandBytes) {
      this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
      return
    }
    const validated = parseClientMessage(parsed)
    if (validated.ok === false) {
      if (validated.error.code === 'invalid_protocol_version') {
        this.close(socket, CLOSE_PROTOCOL_MISMATCH, 'protocol_mismatch')
      } else {
        this.send(socket, this.error('invalid_frame', validated.error.message, false, this.requestIdFromUnknown(parsed)))
      }
      return
    }
    if (validated.value.t === 'hello') {
      this.send(socket, this.error('invalid_frame', 'connection is already authenticated', false, validated.value.requestId))
      return
    }
    if (validated.value.t === 'ping') {
      this.send(socket, {
        t: 'pong',
        v: PROTOCOL_VERSION,
        nonce: validated.value.nonce,
        serverTimeMs: this.now(),
      })
      return
    }
    if (validated.value.t === 'resync') {
      if (this.takeExpensiveRate(connection) === false) {
        this.metrics.increment('rate_limits.hits')
        this.metrics.increment('rate_limits.expensive')
        this.close(socket, CLOSE_RATE_LIMITED, 'rate_limited')
        return
      }
      this.resync(connection, validated.value)
      return
    }
    if (validated.value.t === 'exportBundle') {
      if (this.takeExpensiveRate(connection) === false) {
        this.metrics.increment('rate_limits.hits')
        this.metrics.increment('rate_limits.expensive')
        this.close(socket, CLOSE_RATE_LIMITED, 'rate_limited')
        return
      }
      this.exportBundle(connection, validated.value)
      return
    }
    if (validated.value.t === 'commandStatus') {
      this.commandStatus(socket, connection, validated.value)
      return
    }
    if (validated.value.t === 'command') {
      const at = this.now()
      const commandRate = this.rateFor(
        this.deviceCommandRates,
        this.deviceRateKey(connection),
        this.config.commandRatePerSecond,
        this.config.commandRateBurst,
        at,
      )
      if (commandRate.take(at) === false) {
        this.metrics.increment('rate_limits.hits')
        this.metrics.increment('rate_limits.commands')
        this.close(socket, CLOSE_RATE_LIMITED, 'rate_limited')
        return
      }
      await this.command(socket, connection, validated.value)
    }
  }

  private closeForAuthError(socket: WebSocket, error: unknown): void {
    if (error instanceof RevokedDeviceError) {
      this.close(socket, CLOSE_SUPERSEDED, 'revoked')
      return
    }
    if (error instanceof AuthenticationError) {
      this.close(socket, CLOSE_AUTH_FAILED, 'auth_failed')
      return
    }
    this.logger.error('auth.internal_error', { error })
    this.close(socket, CLOSE_SERVER_ERROR, 'server_error')
  }

  private async hello(socket: WebSocket, connection: LiveConnection, value: unknown): Promise<void> {
    const object = asObject(value)
    if (object === undefined || object.t !== 'hello' || object.v !== PROTOCOL_VERSION) {
      const protocolMismatch = object?.v !== undefined && object.v !== PROTOCOL_VERSION
      this.close(socket, protocolMismatch ? CLOSE_PROTOCOL_MISMATCH : CLOSE_AUTH_FAILED, protocolMismatch ? 'protocol_mismatch' : 'auth_failed')
      return
    }
    const validated = parseClientMessage(value)
    if (validated.ok === false || validated.value.t !== 'hello') {
      this.close(socket, CLOSE_INVALID_FRAME, 'invalid_frame')
      return
    }
    const hello = validated.value
    let identified: ReturnType<AuthService['identify']>
    try {
      identified = this.auth.identify(hello)
    } catch (error) {
      this.closeForAuthError(socket, error)
      return
    }
    if (this.hub.count(identified.petId) >= this.config.maxConnectionsPerPet) {
      this.close(socket, CLOSE_SUPERSEDED, 'too_many_connections')
      return
    }
    let snapshot: ReturnType<DatabaseStore['loadCanonical']>
    try {
      snapshot = this.store.loadCanonical(identified.petId)
    } catch (error) {
      this.logger.error('auth.snapshot_failed', { petId: identified.petId, error })
      this.close(socket, CLOSE_SERVER_ERROR, 'server_error')
      return
    }
    const authorityProblem = this.authorityProblem(hello, snapshot)
    if (authorityProblem !== undefined) {
      this.authorityReset(socket, hello, snapshot, authorityProblem)
      return
    }
    let authenticated: ReturnType<AuthService['authenticate']>
    try {
      authenticated = this.auth.authenticate(hello)
    } catch (error) {
      this.closeForAuthError(socket, error)
      return
    }
    const at = this.now()
    const coverageId = this.store.beginCoverage(
      authenticated.petId,
      authenticated.device.deviceId,
      connection.connectionId,
      at,
    )
    connection.petId = authenticated.petId
    connection.deviceId = authenticated.device.deviceId
    connection.role = authenticated.device.role
    connection.coverageId = coverageId
    connection.authenticated = true
    this.hub.add(connection)
    this.metrics.increment('sessions.connected')

    const plan = this.deliveryPlan(hello, snapshot.pet, authenticated.petId, snapshot.authority.state)
    const welcome: Welcome = {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      requestId: hello.requestId,
      connectionId: connection.connectionId,
      petId: authenticated.petId,
      deviceId: authenticated.device.deviceId,
      deviceRole: authenticated.device.role,
      protocolVersion: PROTOCOL_VERSION,
      saveSchemaVersion: snapshot.pet.schemaVersion,
      serverTimeMs: at,
      gameTimeMs: snapshot.pet.gameTimeMs,
      timeZone: snapshot.settings.timeZone,
      advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
      authority: this.hub.authority(authenticated.petId),
      headRevision: snapshot.pet.revision,
      headEventSeq: snapshot.pet.eventSeq,
      catchingUp: this.isCatchingUp(authenticated.petId),
      delivery: plan.delivery,
      ...(authenticated.issuedToken === undefined ? {} : { issuedToken: authenticated.issuedToken }),
    }
    this.send(socket, welcome)
    if (plan.replay !== undefined) this.send(socket, plan.replay)
    if (plan.delivery === 'snapshot' || plan.delivery === 'replay+snapshot') {
      this.send(socket, this.snapshot(snapshot.pet, authenticated.petId, snapshot.engine.save))
    }
    this.sendReady(connection, snapshot)
  }

  /**
   * Only plan a replay when every event between the client cursor and the
   * current head can be delivered in one contiguous, frame-sized replay.
   * Otherwise the caller must send a full snapshot: ready must never advance a
   * client past events that were left out of a truncated replay.
   */
  private deliveryPlan(
    hello: ClientHello,
    pet: PetRecord,
    petId: string,
    authorityState: 'active' | 'archived' | 'reset',
  ): DeliveryPlan {
    // Archived authority may expose authority status but never the save,
    // events, or runtime internals. A reset authority may only recover via a
    // full snapshot; it must not replay events from the previous lineage.
    if (authorityState === 'archived') return { delivery: 'none' }
    if (authorityState === 'reset') return { delivery: 'snapshot' }
    const revision = hello.lastRevision
    const fromEventSeq = hello.lastEventSeq
    if (revision === undefined || fromEventSeq === undefined) return { delivery: 'snapshot' }
    if (revision === pet.revision && fromEventSeq === pet.eventSeq) return { delivery: 'none' }
    if (fromEventSeq >= pet.eventSeq) return { delivery: 'snapshot' }

    const missingEvents = pet.eventSeq - fromEventSeq
    if (missingEvents > this.config.maxReplayEvents) return { delivery: 'snapshot' }
    const events = this.replayEvents(petId, fromEventSeq, pet.eventSeq)
    if (events.length !== missingEvents) return { delivery: 'snapshot' }
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].eventSeq !== fromEventSeq + index + 1) return { delivery: 'snapshot' }
    }

    const replay: ReplayMessage = {
      t: 'replay',
      v: PROTOCOL_VERSION,
      fromEventSeq,
      toEventSeq: pet.eventSeq,
      events,
    }
    if (this.fitsFrame(replay) === false) return { delivery: 'snapshot' }
    return {
      delivery: revision === pet.revision ? 'replay' : 'replay+snapshot',
      replay,
    }
  }

  private replayEvents(petId: string, after: number, to: number): OrderedEvent[] {
    return this.store.getEvents(petId, after, this.config.maxReplayEvents)
      .filter(row => row.eventSeq <= to)
      .map(row => ({
        eventSeq: row.eventSeq,
        revision: row.revision,
        ...(row.commandSeq === null ? {} : { commandSeq: row.commandSeq }),
        gameTimeMs: row.gameTimeMs,
        type: row.type,
        payload: JSON.parse(row.payloadJson) as OrderedEvent['payload'],
      }))
      .map(event => {
        assertPublicEvent(event)
        return event
      })
  }

  private snapshot(pet: PetRecord, petId: string, save: unknown): SnapshotMessage {
    const settings = this.store.getSettings(petId)
    if (settings === undefined) throw new Error('settings missing')
    assertPublicSave(save)
    return {
      t: 'snapshot',
      v: PROTOCOL_VERSION,
      revision: pet.revision,
      eventSeq: pet.eventSeq,
      gameTimeMs: pet.gameTimeMs,
      timeZone: settings.timeZone,
      advanceWhileEmpty: settings.advanceWhileEmpty,
      authority: this.hub.authority(petId),
      save: save as SnapshotMessage['save'],
    }
  }

  private sendReady(
    connection: LiveConnection,
    snapshot: ReturnType<DatabaseStore['loadCanonical']>,
  ): void {
    this.hub.send(connection, {
      t: 'ready',
      v: PROTOCOL_VERSION,
      revision: snapshot.pet.revision,
      eventSeq: snapshot.pet.eventSeq,
      gameTimeMs: snapshot.pet.gameTimeMs,
      timeZone: snapshot.settings.timeZone,
      advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
      authority: this.hub.authority(connection.petId),
      catchingUp: this.isCatchingUp(connection.petId),
    })
  }

  private resync(connection: LiveConnection, _request: ResyncRequest): void {
    const snapshot = this.store.loadCanonical(connection.petId)
    if (snapshot.authority.state === 'archived') {
      // Archived resync is a status-only operation. Never use it to bypass the
      // handshake projection gate.
      this.sendReady(connection, snapshot)
      return
    }
    this.hub.send(connection, this.snapshot(snapshot.pet, connection.petId, snapshot.engine.save))
    this.sendReady(connection, snapshot)
  }

  private async command(socket: WebSocket, connection: LiveConnection, request: CommandRequest): Promise<void> {
    try {
      const isPortableImport = request.command.type === 'admin.importPortableBundle'
        || request.command.type === 'admin.resumeServer'
      const committed = await this.commands.execute({
        petId: connection.petId,
        deviceId: connection.deviceId,
        role: connection.role,
      }, request.requestId, request.opId, request.command, request.observedRevision, {
        ...(isPortableImport
          ? { beforePortableImportCommit: () => this.backupBeforeImport(connection.petId, request.opId) }
          : {}),
      })
      if (committed.coverageReopen !== undefined) {
        const live = new Map(
          this.hub.listConnections(connection.petId)
            .filter(candidate => candidate.authenticated)
            .map(candidate => [candidate.connectionId, candidate.deviceId]),
        )
        this.store.completeCoverageReopen(
          connection.petId,
          committed.coverageReopen.operationId,
          committed.coverageReopen.commitWallMs,
          live,
          this.now(),
        )
        const reopenedSurvivors = new Set(committed.coverageReopen.survivors.map(survivor =>
          survivor.kind === 'server_connection' ? survivor.connectionId : survivor.appInstanceId,
        ))
        for (const candidate of this.hub.listConnections(connection.petId)) {
          if (candidate.authenticated === false || reopenedSurvivors.has(candidate.connectionId) === false) continue
          candidate.coverageId = committed.coverageReopen.operationId + ':' + candidate.connectionId
        }
      }
      this.hub.send(connection, committed.result)
      if (committed.authorityArchived === true) {
        // Deliver the detach result first, then give every live client an
        // explicit archived authority status before clearing the socket hub.
        const snapshot = this.store.loadCanonical(connection.petId)
        for (const candidate of this.hub.listConnections(connection.petId)) {
          if (candidate.authenticated) this.sendReady(candidate, snapshot)
        }
        this.hub.closePet(connection.petId)
        return
      }
      if (request.command.type === 'device.revoke' && committed.result.status === 'applied') {
        const target = request.command.payload.deviceId
        const revokedAt = (committed.result.result as { revokedAtMs?: number } | undefined)?.revokedAtMs ?? this.now()
        // Close the revoked device's live sockets first, then notify the survivors.
        this.hub.revokeDevice(connection.petId, target)
        this.hub.broadcastRevoked(connection.petId, target, revokedAt)
        return
      }
      if (committed.projection !== undefined && request.command.type !== 'device.list') {
        this.hub.broadcastProjection(connection.petId, committed.projection.pet, committed.projection.events)
      }
      if (committed.result.status === 'rejected' && committed.result.error?.refreshProjection === true) {
        const snapshot = this.store.loadCanonical(connection.petId)
        if (snapshot.authority.state === 'archived') {
          // A rejected command while archived is authority status only. Sending
          // a projection here would leak the save through the refresh path.
          this.sendReady(connection, snapshot)
        } else {
          this.hub.send(connection, {
            t: 'projection',
            v: PROTOCOL_VERSION,
            revision: snapshot.pet.revision,
            eventSeq: snapshot.pet.eventSeq,
            gameTimeMs: snapshot.pet.gameTimeMs,
            timeZone: snapshot.settings.timeZone,
            advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
            authority: this.hub.authority(connection.petId),
            save: snapshot.engine.save,
            events: [],
          })
        }
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        this.close(socket, CLOSE_SUPERSEDED, 'revoked')
      } else {
        this.logger.error('command.failed', { error })
        this.send(socket, this.error('internal', 'command failed', false, request.requestId))
      }
    }
  }

  private async backupBeforeImport(petId: string, opId: string): Promise<void> {
    try {
      const path = join(
        this.config.backupDir,
        petId + '-pre-import-' + this.now() + '-' + opId.replaceAll(/[^a-zA-Z0-9_-]/g, '_') + '.sqlite',
      )
      await mkdir(dirname(path), { recursive: true })
      await this.store.backup(path)
      this.metrics.increment('backup.success')
      this.metrics.increment('backup.pre_import.success')
    } catch (error) {
      this.logger.error('import.backup_failed', { petId, error })
      this.metrics.increment('backup.failure')
      this.metrics.increment('backup.pre_import.failure')
      throw error instanceof Error ? error : new Error('pre-import backup failed')
    }
  }

  private commandStatus(socket: WebSocket, connection: LiveConnection, request: CommandStatusRequest): void {
    try {
      this.hub.send(connection, this.commands.commandStatus({
        petId: connection.petId,
        deviceId: connection.deviceId,
        role: connection.role,
      }, request.requestId, request.opId))
    } catch (error) {
      if (error instanceof AuthenticationError) this.close(socket, CLOSE_SUPERSEDED, 'revoked')
      else this.send(socket, this.error('internal', 'status lookup failed', false, request.requestId))
    }
  }

  private exportBundle(connection: LiveConnection, request: PortableBundleRequest): void {
    if (connection.role !== 'owner') {
      this.hub.send(connection, this.error('authority_not_active', 'owner authority is required', false, request.requestId))
      return
    }
    const snapshot = this.store.loadCanonical(connection.petId)
    this.hub.send(connection, {
      t: 'portableBundle',
      v: PROTOCOL_VERSION,
      requestId: request.requestId,
      bundle: {
        format: PORTABLE_BUNDLE_FORMAT,
        schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
        exportedAtWallMs: this.now(),
        authority: {
          owner: 'server',
          authorityId: snapshot.authority.authorityId,
          epoch: snapshot.authority.epoch,
          restoreGeneration: snapshot.authority.restoreGeneration,
          revision: snapshot.pet.revision,
          eventSeq: snapshot.pet.eventSeq,
          handoffId: snapshot.authority.handoffId,
          detachedAtWallMs: snapshot.authority.detachedAtMs ?? 0,
        },
        shared: snapshot.engine.save,
        engine: snapshot.engine,
      },
    })
  }

  private authorityProblem(
    hello: ClientHello,
    snapshot: ReturnType<DatabaseStore['loadCanonical']>,
  ): 'restore_rollback' | 'authority_mismatch' | 'cache_newer' | undefined {
    const cached = hello.cachedAuthority
    // Archived authority is gated after authentication by deliveryPlan, which
    // permits only status frames. Reset recovery still requires a full snapshot.
    if (cached === undefined || snapshot.authority.state === 'archived') return undefined
    if (cached.epoch > snapshot.authority.epoch) return 'cache_newer'
    if (cached.restoreGeneration !== snapshot.authority.restoreGeneration) return 'restore_rollback'
    if (snapshot.authority.state === 'reset') return 'restore_rollback'
    if (cached.authorityId !== snapshot.authority.authorityId) return 'authority_mismatch'
    return undefined
  }

  private authorityReset(
    socket: WebSocket,
    hello: ClientHello,
    snapshot: ReturnType<DatabaseStore['loadCanonical']>,
    reason: 'restore_rollback' | 'authority_mismatch' | 'cache_newer',
  ): void {
    const pet = snapshot.pet
    const authority = snapshot.authority
    this.send(socket, {
      t: 'authorityResetRequired',
      code: 'authority_reset_required',
      v: PROTOCOL_VERSION,
      requestId: hello.requestId,
      authority: {
        owner: authority.owner,
        authorityId: authority.authorityId,
        epoch: authority.epoch,
        restoreGeneration: authority.restoreGeneration,
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        handoffId: authority.handoffId,
        detachedAtWallMs: authority.detachedAtMs ?? 0,
      },
      reason,
      requireFullSnapshot: true,
    })
    this.close(socket, CLOSE_SUPERSEDED, 'authority_reset_required')
  }

  private error(code: ErrorMessage['code'], message: string, refreshProjection: boolean, requestId?: string): ErrorMessage {
    return { t: 'error', v: PROTOCOL_VERSION, ...(requestId === undefined ? {} : { requestId }), code, message, refreshProjection }
  }

  private send(socket: WebSocket, message: ServerToClient): void {
    if (socket.readyState !== socket.OPEN) return
    const text = JSON.stringify(message)
    if (Buffer.byteLength(text) > this.config.maxFrameBytes) {
      this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
      return
    }
    socket.send(text)
  }

  private fitsFrame(message: ServerToClient): boolean {
    return Buffer.byteLength(JSON.stringify(message)) <= this.config.maxFrameBytes
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason)
  }

  private requestIdOf(bytes: Buffer): string | undefined {
    try {
      return this.requestIdFromUnknown(JSON.parse(bytes.toString('utf8')))
    } catch {
      return undefined
    }
  }

  private requestIdFromUnknown(value: unknown): string | undefined {
    const object = asObject(value)
    return typeof object?.requestId === 'string' && object.requestId.length > 0 ? object.requestId : undefined
  }


}
