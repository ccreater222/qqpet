import type { IncomingMessage } from 'node:http'
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

const CLOSE_AUTH_FAILED = 4000
const CLOSE_PROTOCOL_MISMATCH = 4001
const CLOSE_SUPERSEDED = 4002
const CLOSE_INVALID_FRAME = 4004
const CLOSE_PAYLOAD_TOO_LARGE = 4005
const CLOSE_SERVER_ERROR = 4006

class RateWindow {
  private tokens: number
  private updatedAt: number

  constructor(
    private readonly perSecond: number,
    burst: number,
    at: number,
  ) {
    this.tokens = burst
    this.updatedAt = at
  }

  take(at: number): boolean {
    this.tokens = Math.min(this.tokens + (at - this.updatedAt) / 1000 * this.perSecond, this.perSecond * 2)
    this.updatedAt = at
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export class SessionService {
  readonly hub: SocketHub
  private nextConnection = 1
  private heartbeatTimer: NodeJS.Timeout | undefined
  private pingTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly config: ServerConfig,
    private readonly store: DatabaseStore,
    private readonly auth: AuthService,
    private readonly commands: CommandService,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.hub = new SocketHub(store, logger, now, config.maxFrameBytes)
    this.commands.setCoverageSource({ currentSurvivors: petId => this.currentSurvivors(petId) })
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

  attach(socket: WebSocket, _request: IncomingMessage): void {
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
    let rate: RateWindow | undefined
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
      const before = initialized
      void this.onMessage(socket, connection, data, isBinary, rate).then(nextRate => {
        if (connection.authenticated && !before && nextRate !== undefined) {
          initialized = true
          rate = nextRate
          clearTimeout(helloDeadline)
        }
      })
    })
  }

  private async onMessage(
    socket: WebSocket,
    connection: LiveConnection,
    data: RawData,
    isBinary: boolean,
    rate: RateWindow | undefined,
  ): Promise<RateWindow | undefined> {
    if (isBinary) {
      this.close(socket, CLOSE_INVALID_FRAME, 'invalid_frame')
      return rate
    }
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (bytes.byteLength > this.config.maxFrameBytes) {
      this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
      return rate
    }
    if (!connection.authenticated) {
      if (bytes.byteLength > 16 * 1024) {
        this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
        return rate
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        this.close(socket, CLOSE_INVALID_FRAME, 'invalid_frame')
        return rate
      }
      await this.hello(socket, connection, parsed)
      return connection.authenticated
        ? new RateWindow(this.config.commandRatePerSecond, this.config.commandRateBurst, this.now())
        : rate
    }
    if (bytes.byteLength > this.config.maxCommandBytes && this.looksLikeCommand(bytes)) {
      this.close(socket, CLOSE_PAYLOAD_TOO_LARGE, 'payload_too_large')
      return rate
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      this.send(socket, this.error('invalid_frame', 'invalid JSON frame', false, this.requestIdOf(bytes)))
      return rate
    }
    const validated = parseClientMessage(parsed)
    if (validated.ok === false) {
      if (validated.error.code === 'invalid_protocol_version') {
        this.close(socket, CLOSE_PROTOCOL_MISMATCH, 'protocol_mismatch')
      } else {
        this.send(socket, this.error('invalid_frame', validated.error.message, false, this.requestIdFromUnknown(parsed)))
      }
      return rate
    }
    if (validated.value.t === 'hello') {
      this.send(socket, this.error('invalid_frame', 'connection is already authenticated', false, validated.value.requestId))
      return rate
    }
    if (validated.value.t === 'ping') {
      this.send(socket, {
        t: 'pong',
        v: PROTOCOL_VERSION,
        nonce: validated.value.nonce,
        serverTimeMs: this.now(),
      })
      return rate
    }
    if (validated.value.t === 'resync') {
      this.resync(connection, validated.value)
      return rate
    }
    if (validated.value.t === 'exportBundle') {
      this.exportBundle(connection, validated.value)
      return rate
    }
    if (validated.value.t === 'commandStatus') {
      this.commandStatus(socket, connection, validated.value)
      return rate
    }
    if (validated.value.t === 'command') {
      const nextRate = rate ?? new RateWindow(this.config.commandRatePerSecond, this.config.commandRateBurst, this.now())
      if (nextRate.take(this.now()) === false) {
        this.close(socket, CLOSE_AUTH_FAILED + 3, 'rate_limited')
        return nextRate
      }
      await this.command(socket, connection, validated.value)
      return nextRate
    }
    return rate
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
    let authenticated
    try {
      authenticated = this.auth.authenticate(hello)
    } catch (error) {
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
      return
    }
    const snapshot = this.store.loadCanonical(authenticated.petId)
    const authorityProblem = this.authorityProblem(hello, snapshot)
    if (authorityProblem !== undefined) {
      this.authorityReset(socket, hello, authenticated.issuedToken, authorityProblem)
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
    if (this.hub.count(authenticated.petId) > this.config.maxConnectionsPerPet) {
      this.hub.remove(connection, 'disconnect')
      this.close(socket, CLOSE_SUPERSEDED, 'too_many_connections')
      return
    }

    const delivery = this.delivery(hello, snapshot.pet, authenticated.petId)
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
      catchingUp: false,
      delivery,
      ...(authenticated.issuedToken === undefined ? {} : { issuedToken: authenticated.issuedToken }),
    }
    this.send(socket, welcome)
    if (delivery === 'replay' || delivery === 'replay+snapshot') {
      this.send(socket, {
        t: 'replay',
        v: PROTOCOL_VERSION,
        fromEventSeq: hello.lastEventSeq ?? 0,
        toEventSeq: snapshot.pet.eventSeq,
        events: this.replayEvents(authenticated.petId, hello.lastEventSeq ?? 0, snapshot.pet.eventSeq),
      })
    }
    if (delivery === 'snapshot' || delivery === 'replay+snapshot') {
      this.send(socket, this.snapshot(snapshot.pet, authenticated.petId, snapshot.engine.save))
    }
    this.send(socket, {
      t: 'ready',
      v: PROTOCOL_VERSION,
      revision: snapshot.pet.revision,
      eventSeq: snapshot.pet.eventSeq,
      gameTimeMs: snapshot.pet.gameTimeMs,
      timeZone: snapshot.settings.timeZone,
      advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
      authority: this.hub.authority(authenticated.petId),
      catchingUp: false,
    })
  }

  private delivery(hello: ClientHello, pet: PetRecord, petId: string): Welcome['delivery'] {
    const revision = hello.lastRevision
    const eventSeq = hello.lastEventSeq
    if (revision === undefined || eventSeq === undefined) return 'snapshot'
    if (revision === pet.revision && eventSeq === pet.eventSeq) return 'none'
    const next = eventSeq >= pet.eventSeq ? undefined : this.store.getEvent(petId, eventSeq + 1)
    if (next === undefined) return 'snapshot'
    return revision === pet.revision ? 'replay' : 'replay+snapshot'
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

  private resync(connection: LiveConnection, _request: ResyncRequest): void {
    const snapshot = this.store.loadCanonical(connection.petId)
    this.hub.send(connection, this.snapshot(snapshot.pet, connection.petId, snapshot.engine.save))
    this.hub.send(connection, {
      t: 'ready',
      v: PROTOCOL_VERSION,
      revision: snapshot.pet.revision,
      eventSeq: snapshot.pet.eventSeq,
      gameTimeMs: snapshot.pet.gameTimeMs,
      timeZone: snapshot.settings.timeZone,
      advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
      authority: this.hub.authority(connection.petId),
      catchingUp: false,
    })
  }

  private async command(socket: WebSocket, connection: LiveConnection, request: CommandRequest): Promise<void> {
    try {
      const committed = await this.commands.execute({
        petId: connection.petId,
        deviceId: connection.deviceId,
        role: connection.role,
      }, request.requestId, request.opId, request.command, request.observedRevision)
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
    } catch (error) {
      if (error instanceof AuthenticationError) {
        this.close(socket, CLOSE_SUPERSEDED, 'revoked')
      } else {
        this.logger.error('command.failed', { error })
        this.send(socket, this.error('internal', 'command failed', false, request.requestId))
      }
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
    issuedToken: string | undefined,
    reason: 'restore_rollback' | 'authority_mismatch' | 'cache_newer',
  ): void {
    const pet = hello.petId === undefined ? this.store.listPets()[0] : this.store.getPet(hello.petId)
    const authority = pet === undefined ? undefined : this.store.getAuthority(pet.id)
    if (pet === undefined || authority === undefined || issuedToken !== undefined) {
      this.close(socket, CLOSE_AUTH_FAILED, 'auth_failed')
      return
    }
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

  private looksLikeCommand(bytes: Buffer): boolean {
    return bytes.toString('utf8').includes('"t":"command"')
  }
}
