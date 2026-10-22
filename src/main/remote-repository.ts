import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { startSave } from '../shared/save-logic'
import { assertRemoteServerUrl } from './remote-endpoint'
import type { SaveData } from '../shared/save'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import {
  composeSaveWithOverlay,
  mergeDeviceLocalOverlay,
  sanitizeDeviceLocalOverlayPatch,
  toDeviceLocalOverlay,
  type DeviceLocalOverlay,
  type SharedSaveData,
} from '../shared/sync/data-boundary'
import { isOwnerCommand, parsePetCommand } from '../shared/sync/command-validation'
import { parseClientMessage, parseServerMessage } from '../shared/sync/protocol-validation'
import {
  COMMAND_ERROR_CODES,
  PROTOCOL_VERSION,
  type ClientHello,
  type CommandErrorCode,
  type CommandKey,
  type CommandRequest,
  type CommandResult,
  type CommandStatusRequest,
  type DeviceRole,
  type ErrorMessage,
  type PetCommand,
  type ResyncRequest,
  type WireAuthority,
  type WireCommandResult,
} from '../shared/sync/protocol'
import type { PortablePetBundleV1 } from '../shared/sync/portable'
import {
  classifyProjectionDelivery,
  type ProjectionCursor,
  type RendererProjection,
  type RendererRepositoryStatus,
} from '../shared/renderer-api'

export const REMOTE_RECONNECT_BASE_MS = 500
export const REMOTE_RECONNECT_MAX_MS = 30_000
export const REMOTE_EXPORT_TIMEOUT_MS = 15_000

export interface RemoteTransportCloseInfo {
  code: number
  reason: string
}

export interface RemoteTransportHandlers {
  onOpen(): void
  onMessage(data: unknown): void
  onClose(info: RemoteTransportCloseInfo): void
  onError?(error: unknown): void
}

export interface RemoteTransportConnection {
  send(data: string): void
  close(): void
}

/** Injectable WSS data plane. The desktop host supplies a WebSocket adapter; tests inject a fake. */
export interface RemoteTransport {
  connect(url: string, token: string | null, handlers: RemoteTransportHandlers): RemoteTransportConnection
}

/** Non-secret sync metadata. Tokens live only in the injected token store. */
export interface RemoteSyncConfig {
  serverUrl: string
  petId: string
  deviceId: string
  lastRevision: number
  lastEventSeq: number
}

/** Injectable secret store; PairingStore is the desktop implementation. */
export interface RemoteTokenStore {
  loadToken(): Promise<string | null>
  saveToken(token: string): Promise<void>
  loadConfig(): Promise<RemoteSyncConfig | null>
  saveConfig(config: RemoteSyncConfig): Promise<void>
  clear(): Promise<void>
}

export interface RemoteBackoffOptions {
  baseMs?: number
  maxMs?: number
  random?: () => number
}

export interface RemotePairingOptions {
  code: string
  deviceLabel: string
}

export interface RemoteRepositoryOptions {
  serverUrl: string
  appVersion: string
  tokenStore: RemoteTokenStore
  transport: RemoteTransport
  pair?: RemotePairingOptions
  backoff?: RemoteBackoffOptions
  sleep?: (ms: number) => Promise<void>
  randomUUID?: () => string
  exportRequestTimeoutMs?: number
  deviceOverlay?: DeviceLocalOverlay
}

type RemoteConnectionState = 'idle' | 'connecting' | 'online' | 'catching_up' | 'offline' | 'error' | 'stopped'
type ProjectionListener = (projection: RendererProjection, events: OrderedEvent[]) => void
type CommandResultListener = (result: CommandResult) => void
type SyncStatusListener = (status: RendererRepositoryStatus) => void

interface PendingCommand {
  opId: string
  requestId: string
  command: PetCommand
  resolve: (result: CommandResult) => void
  reject: (error: Error) => void
  settle: () => void
  settled: Promise<void>
}

interface PendingExport {
  resolve: (bundle: PortablePetBundleV1) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface StartWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

interface PendingCommandRefresh {
  pending: PendingCommand
  result: CommandResult
}

interface ProjectionStateSource {
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: WireAuthority
  save: SharedSaveData
}

const EMPTY_AUTHORITY: WireAuthority = {
  owner: 'server',
  authorityId: '',
  restoreGeneration: 0,
  epoch: 0,
  state: 'archived',
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const COMMAND_ERROR_CODE_SET = new Set<string>(COMMAND_ERROR_CODES)

function commandErrorCodeOf(code: string): CommandErrorCode {
  return COMMAND_ERROR_CODE_SET.has(code) ? code as CommandErrorCode : 'internal'
}

function toCommandResult(frame: WireCommandResult): CommandResult {
  const base = {
    commandType: frame.commandType,
    opId: frame.opId,
    commandSeq: frame.commandSeq,
    revision: frame.revision,
    eventSeq: frame.eventSeq,
  }
  if (frame.status === 'applied') {
    return {
      ...base,
      status: 'applied',
      ...(frame.result === undefined ? {} : { result: frame.result }),
    } as CommandResult
  }
  if (frame.status === 'rejected') {
    return {
      ...base,
      status: 'rejected',
      error: frame.error ?? { code: 'internal', message: 'the server rejected the command', refreshProjection: true },
    } as CommandResult
  }
  const original: 'applied' | 'rejected' = frame.error === undefined ? 'applied' : 'rejected'
  return {
    ...base,
    status: 'duplicate',
    original,
    ...(frame.result === undefined ? {} : { result: frame.result }),
    ...(frame.error === undefined ? {} : { error: frame.error }),
  } as CommandResult
}

/**
 * Desktop-only server-authoritative repository. It never applies a command or a
 * SavePatch locally: canonical state changes only through server projections.
 */
export class RemoteRepository {
  private readonly serverUrl: string
  private readonly appVersion: string
  private readonly tokenStore: RemoteTokenStore
  private readonly transport: RemoteTransport
  private pair: RemotePairingOptions | undefined
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly newUuid: () => string
  private readonly exportRequestTimeoutMs: number

  private deviceOverlay: DeviceLocalOverlay
  private config: RemoteSyncConfig | null = null
  private token: string | null = null
  private loaded = false
  private stopped = false
  private state: RemoteConnectionState = 'idle'
  private role: DeviceRole = 'player'
  private projection: RendererProjection | null = null
  private authority: WireAuthority | null = null
  private cursor = { revision: 0, eventSeq: 0 }
  private gameTimeMs = 0
  private timeZone = 'UTC'
  private advanceWhileEmpty = true
  private lastError: string | undefined
  private notice: string | undefined
  private lastCommandSeq: number | undefined

  private connection: RemoteTransportConnection | null = null
  private connectionGeneration = 0
  private closedConnectionGeneration = 0
  private reconnectAttempt = 0
  private reconnectSleeping = false
  private reconnectBlocked = false
  private startWaiters: StartWaiter[] = []

  private pendingCommand: PendingCommand | null = null
  private pendingCommandRefresh: PendingCommandRefresh | null = null
  private projectionRefreshPending = false
  private authorityResetPending = false
  private reconciledOnConnection = false
  private readonly pendingExports = new Map<string, PendingExport>()

  private syncMode: 'initial' | 'resync' | 'authority_reset' = 'initial'
  private expectedSnapshot = false
  private expectedReplay = false
  private snapshotSeen = false
  private replaySeen = false
  private replayEvents: OrderedEvent[] = []
  private pendingResync = false

  private persistence: Promise<void> = Promise.resolve()

  private readonly projectionListeners = new Set<ProjectionListener>()
  private readonly resyncListeners = new Set<ProjectionListener>()
  private readonly commandResultListeners = new Set<CommandResultListener>()
  private readonly syncStatusListeners = new Set<SyncStatusListener>()

  constructor(options: RemoteRepositoryOptions) {
    if (typeof options.serverUrl !== 'string' || options.serverUrl.length === 0) {
      throw new Error('RemoteRepository serverUrl is required')
    }
    if (typeof options.appVersion !== 'string' || options.appVersion.length === 0) {
      throw new Error('RemoteRepository appVersion is required')
    }
    this.serverUrl = assertRemoteServerUrl(options.serverUrl)
    this.appVersion = options.appVersion
    this.tokenStore = options.tokenStore
    this.transport = options.transport
    this.pair = options.pair
    const backoff = options.backoff ?? {}
    this.backoffBaseMs = backoff.baseMs ?? REMOTE_RECONNECT_BASE_MS
    this.backoffMaxMs = Math.max(this.backoffBaseMs, backoff.maxMs ?? REMOTE_RECONNECT_MAX_MS)
    this.random = backoff.random ?? Math.random
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    }))
    this.newUuid = options.randomUUID ?? nodeRandomUUID
    this.exportRequestTimeoutMs = options.exportRequestTimeoutMs ?? REMOTE_EXPORT_TIMEOUT_MS
    this.deviceOverlay = options.deviceOverlay ?? toDeviceLocalOverlay(startSave(null), 'remote-device')
  }

  get roleValue(): DeviceRole {
    return this.role
  }

  onProjection(listener: ProjectionListener): () => void {
    this.projectionListeners.add(listener)
    return () => { this.projectionListeners.delete(listener) }
  }

  onResync(listener: ProjectionListener): () => void {
    this.resyncListeners.add(listener)
    return () => { this.resyncListeners.delete(listener) }
  }

  onCommandResult(listener: CommandResultListener): () => void {
    this.commandResultListeners.add(listener)
    return () => { this.commandResultListeners.delete(listener) }
  }

  onSyncStatus(listener: SyncStatusListener): () => void {
    this.syncStatusListeners.add(listener)
    return () => { this.syncStatusListeners.delete(listener) }
  }

  getStatus(): RendererRepositoryStatus {
    const authority = this.projection?.authority ?? this.authority ?? EMPTY_AUTHORITY
    return {
      mode: 'server',
      connection: this.connectionStatus(),
      serverMode: true,
      revision: this.projection?.revision ?? this.cursor.revision,
      eventSeq: this.projection?.eventSeq ?? this.cursor.eventSeq,
      gameTimeMs: this.projection?.gameTimeMs ?? this.gameTimeMs,
      timeZone: this.projection?.timeZone ?? this.timeZone,
      advanceWhileEmpty: this.projection?.advanceWhileEmpty ?? this.advanceWhileEmpty,
      authority,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError, error: this.lastError }),
      state: this.state,
      role: this.role,
      readOnly: authority.state !== 'active' || this.projection === null || this.projectionRefreshPending || this.state !== 'online',
      catchingUp: this.state === 'catching_up',
      ...(this.lastCommandSeq === undefined ? {} : { commandSeq: this.lastCommandSeq }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  getProjection(): RendererProjection | null {
    return this.projection === null ? null : clone(this.projection)
  }

  getDeviceOverlay(): DeviceLocalOverlay {
    return clone(this.deviceOverlay)
  }

  async loadLocalSettings(): Promise<DeviceLocalOverlay> {
    if (this.loaded === false) await this.start()
    return clone(this.deviceOverlay)
  }

  async updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay> {
    const patch = sanitizeDeviceLocalOverlayPatch(value)
    this.deviceOverlay = mergeDeviceLocalOverlay(this.deviceOverlay, patch)
    if (this.projection !== null) {
      const shared = this.projection.shared
      this.projection = {
        ...this.projection,
        save: composeSaveWithOverlay(shared, this.deviceOverlay),
        device: clone(this.deviceOverlay),
      }
    }
    return clone(this.deviceOverlay)
  }

  async start(): Promise<RendererProjection | null> {
    if (this.stopped) throw new Error('remote repository is stopped')
    if (this.loaded === false) {
      this.config = await this.tokenStore.loadConfig()
      this.token = await this.tokenStore.loadToken()
      this.loaded = true
      const deviceId = this.config?.deviceId
      if (typeof deviceId === 'string' && deviceId.length > 0) {
        this.deviceOverlay = { ...this.deviceOverlay, localDeviceId: deviceId }
      }
    }
    if (this.projection !== null && this.state === 'online') return this.getProjection()
    if (this.reconnectBlocked) {
      throw new Error(this.lastError ?? 'remote connection cannot be restarted')
    }
    if (this.token === null && this.pair === undefined) {
      this.lastError = 'a device token or pairing code is required before connecting'
      this.setState('error')
      throw new Error(this.lastError)
    }
    const waiter = new Promise<void>((resolve, reject) => { this.startWaiters.push({ resolve, reject }) })
    if (this.connection === null && this.state !== 'catching_up') {
      this.setState('connecting')
      this.connect()
    }
    await waiter
    return this.getProjection()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.connectionGeneration += 1
    this.reconnectSleeping = false
    const connection = this.connection
    this.connection = null
    try {
      connection?.close()
    } catch {
      // closing is best effort
    }
    this.pendingCommandRefresh = null
    this.projectionRefreshPending = false
    if (this.pendingCommand !== null) {
      const pending = this.pendingCommand
      this.pendingCommand = null
      pending.settle()
      pending.reject(new Error('remote repository stopped'))
    }
    for (const pending of this.pendingExports.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.reject(new Error('remote repository stopped'))
    }
    this.pendingExports.clear()
    this.resolveStartWaiters()
    this.setState('stopped')
    await this.persistence.catch(() => {})
  }

  async load(): Promise<SaveData> {
    if (this.projection === null) await this.start()
    if (this.projection === null) throw new Error('remote projection is unavailable')
    return clone(this.projection.save)
  }

  async flush(): Promise<void> {
    const pending = this.pendingCommand
    if (pending !== null) await pending.settled
    await this.persistence.catch(() => {})
  }

  requestResync(): void {
    this.requestResyncInternal(false)
  }

  async command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options: { opId?: string } = {},
  ): Promise<CommandResult<K>> {
    const parsed = parsePetCommand(command)
    if (parsed.ok === false) throw new Error(parsed.error.code + ': ' + parsed.error.message)
    const opId = options.opId ?? this.newUuid()
    if (this.projectionRefreshPending) {
      return this.rejected(command, opId, 'server_catching_up', 'the repository is waiting for the refreshed projection') as CommandResult<K>
    }
    if (this.pendingCommand !== null) {
      return this.rejected(command, opId, 'busy', 'another command is already in flight') as CommandResult<K>
    }
    if (this.connection === null || this.state !== 'online') {
      const code: CommandErrorCode = this.state === 'catching_up' ? 'server_catching_up' : 'offline'
      return this.rejected(command, opId, code, 'the server connection is not ready for commands') as CommandResult<K>
    }
    if (isOwnerCommand(parsed.command.type) && this.role !== 'owner') {
      return this.rejected(command, opId, 'unauthorized', 'this command requires the owner device role') as CommandResult<K>
    }
    const requestId = this.newRequestId()
    const frame: CommandRequest = {
      t: 'command',
      v: PROTOCOL_VERSION,
      requestId,
      opId,
      command: parsed.command,
      observedRevision: this.cursor.revision,
    }
    let settle: () => void = () => {}
    const settled = new Promise<void>(resolve => { settle = resolve })
    const promise = new Promise<CommandResult>((resolve, reject) => {
      this.pendingCommand = { opId, requestId, command: parsed.command, resolve, reject, settle, settled }
    })
    if (this.sendJson(frame) === false) {
      const pending = this.pendingCommand as PendingCommand | null
      this.pendingCommand = null
      pending?.settle()
      return this.rejected(command, opId, 'offline', 'the server connection closed before the command was sent') as CommandResult<K>
    }
    return promise as Promise<CommandResult<K>>
  }

  async setAdvanceWhileEmpty(enabled: boolean): Promise<void> {
    const result = await this.command({ type: 'server.setAdvanceWhileEmpty', payload: { enabled } })
    if (result.status === 'rejected') throw new Error(result.error.message)
  }

  async exportBundle(): Promise<PortablePetBundleV1> {
    if (this.role !== 'owner') throw new Error('unauthorized: owner export requires the owner device role')
    if (this.connection === null || this.state !== 'online') throw new Error('offline: cannot export while disconnected')
    const requestId = this.newRequestId()
    const promise = new Promise<PortablePetBundleV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExports.delete(requestId)
        reject(new Error('timed out waiting for the server export bundle'))
      }, this.exportRequestTimeoutMs)
      this.pendingExports.set(requestId, { resolve, reject, timer })
    })
    if (this.sendJson({ t: 'exportBundle', v: PROTOCOL_VERSION, requestId }) === false) {
      const pending = this.pendingExports.get(requestId)
      if (pending !== undefined) {
        if (pending.timer !== null) clearTimeout(pending.timer)
        this.pendingExports.delete(requestId)
      }
      throw new Error('offline: cannot export while disconnected')
    }
    return promise
  }

  private rejected<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    opId: string,
    code: CommandErrorCode,
    message: string,
  ): CommandResult<K> {
    return {
      status: 'rejected',
      commandType: command.type,
      opId,
      commandSeq: 0,
      revision: this.cursor.revision,
      eventSeq: this.cursor.eventSeq,
      error: { code, message, refreshProjection: code !== 'busy' },
    } as CommandResult<K>
  }

  private connectionStatus(): RendererRepositoryStatus['connection'] {
    if (this.state === 'online') return 'online'
    if (this.state === 'catching_up') return 'catching_up'
    if (this.state === 'error') return 'error'
    if (this.state === 'offline' || this.state === 'stopped') return 'offline'
    return 'connecting'
  }

  private setState(state: RemoteConnectionState): void {
    if (this.state === state) {
      this.emitStatus()
      return
    }
    this.state = state
    this.emitStatus()
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.syncStatusListeners) listener(clone(status))
  }

  private emitProjection(projection: RendererProjection, events: OrderedEvent[]): void {
    for (const listener of this.projectionListeners) listener(clone(projection), clone(events))
  }

  private emitResync(projection: RendererProjection, events: OrderedEvent[]): void {
    for (const listener of this.resyncListeners) listener(clone(projection), clone(events))
  }

  private emitCommandResult(result: CommandResult): void {
    for (const listener of this.commandResultListeners) listener(clone(result))
  }

  private resolveStartWaiters(): void {
    const waiters = this.startWaiters
    this.startWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  private rejectStartWaiters(error: Error): void {
    const waiters = this.startWaiters
    this.startWaiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  private queuePersistence(write: () => Promise<void>): void {
    this.persistence = this.persistence.then(write).catch(error => {
      this.lastError = messageOf(error)
    })
  }

  private newRequestId(): string {
    return this.newUuid()
  }

  private sendJson(frame: unknown): boolean {
    if (this.connection === null) return false
    try {
      this.connection.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.lastError = messageOf(error)
      return false
    }
  }

  private connect(): void {
    if (this.stopped || this.connection !== null) return
    const generation = this.connectionGeneration + 1
    this.connectionGeneration = generation
    const pairing = this.pair !== undefined && this.token === null
    try {
      const connection = this.transport.connect(this.serverUrl, pairing ? null : this.token, {
        onOpen: () => {
          const open = (): void => {
            if (generation !== this.connectionGeneration || generation === this.closedConnectionGeneration || this.stopped) return
            // Some transports call onOpen synchronously from connect(); wait until
            // this.connection exists before the hello frame is written.
            if (this.connection === null) {
              queueMicrotask(open)
              return
            }
            this.handleOpen()
          }
          open()
        },
        onMessage: data => {
          if (generation !== this.connectionGeneration) return
          this.handleMessage(data)
        },
        onClose: info => {
          if (generation !== this.connectionGeneration) return
          this.closedConnectionGeneration = generation
          this.handleClose(info)
        },
        onError: error => {
          if (generation !== this.connectionGeneration) return
          this.lastError = messageOf(error)
          this.emitStatus()
        },
      })
      if (this.stopped === false && generation === this.connectionGeneration && generation !== this.closedConnectionGeneration) {
        this.connection = connection
      }
    } catch (error) {
      this.connection = null
      this.lastError = messageOf(error)
      this.setState('offline')
      this.scheduleReconnect()
    }
  }

  private handleOpen(): void {
    if (this.stopped) return
    // A successful socket open only proves the transport is reachable. Keep the
    // reconnect attempt counter until the server has accepted the hello.
    this.reconnectSleeping = false
    this.reconciledOnConnection = false
    this.snapshotSeen = false
    this.replaySeen = false
    this.replayEvents = []
    this.pendingResync = false
    this.syncMode = 'initial'
    this.expectedSnapshot = false
    this.expectedReplay = false
    this.setState('connecting')
    this.sendHello()
  }

  private sendHello(): void {
    const auth = this.token !== null
      ? { kind: 'token' as const, token: this.token }
      : this.pair !== undefined
        ? { kind: 'pairing' as const, code: this.pair.code, deviceLabel: this.pair.deviceLabel }
        : null
    if (auth === null) {
      this.lastError = 'a device token or pairing code is required before connecting'
      this.setState('error')
      this.disconnect()
      return
    }
    const cached = this.authorityResetPending ? null : this.projection
    const hello: ClientHello = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      requestId: this.newRequestId(),
      appVersion: this.appVersion,
      ...(this.config?.petId === undefined || this.config.petId.length === 0 ? {} : { petId: this.config.petId }),
      ...(this.config?.deviceId === undefined || this.config.deviceId.length === 0 ? {} : { deviceId: this.config.deviceId }),
      ...(this.authorityResetPending || this.cursor.revision === 0 ? {} : { lastRevision: this.cursor.revision }),
      ...(this.authorityResetPending || this.cursor.eventSeq === 0 ? {} : { lastEventSeq: this.cursor.eventSeq }),
      ...(cached === null ? {} : {
        cachedAuthority: {
          authorityId: cached.authority.authorityId,
          restoreGeneration: cached.authority.restoreGeneration,
          epoch: cached.authority.epoch,
        },
      }),
      auth,
    }
    const parsed = parseClientMessage(hello)
    if (parsed.ok === false) {
      this.lastError = 'invalid hello frame: ' + parsed.error.message
      this.setState('error')
      this.disconnect()
      return
    }
    this.sendJson(hello)
  }

  private decodeIncoming(data: unknown): unknown {
    if (typeof data === 'string') {
      try {
        return JSON.parse(data)
      } catch {
        return null
      }
    }
    if (data instanceof Uint8Array) {
      try {
        return JSON.parse(new TextDecoder().decode(data))
      } catch {
        return null
      }
    }
    return data
  }

  private handleMessage(data: unknown): void {
    const value = this.decodeIncoming(data)
    if (value === null) {
      this.lastError = 'received a malformed protocol frame'
      this.emitStatus()
      return
    }
    const parsed = parseServerMessage(value)
    if (parsed.ok === false) {
      this.lastError = 'invalid server frame: ' + parsed.error.message
      this.setState('error')
      return
    }
    const frame = parsed.value
    switch (frame.t) {
      case 'welcome':
        this.handleWelcome(frame)
        break
      case 'snapshot':
        this.handleSnapshot(frame)
        break
      case 'replay':
        this.handleReplay(frame)
        break
      case 'ready':
        this.handleReady(frame)
        break
      case 'projection':
        this.handleProjection(frame)
        break
      case 'commandResult':
        this.handleCommandResult(frame)
        break
      case 'commandStatusResult':
        this.handleCommandStatusResult(frame)
        break
      case 'portableBundle':
        this.handlePortableBundle(frame)
        break
      case 'deviceRevoked':
        this.notice = 'device_revoked'
        this.lastError = 'the server revoked device ' + frame.deviceId
        this.emitStatus()
        break
      case 'authorityResetRequired':
        this.handleAuthorityResetRequired(frame)
        break
      case 'error':
        this.handleError(frame)
        break
      case 'pong':
        break
      default:
        break
    }
  }

  private handleWelcome(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'welcome' }>): void {
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      this.lastError = 'unsupported server protocol version ' + String(frame.protocolVersion)
      this.reconnectBlocked = true
      this.setState('error')
      this.rejectStartWaiters(new Error(this.lastError))
      this.disconnect()
      return
    }
    this.reconnectAttempt = 0
    this.role = frame.deviceRole
    this.authority = frame.authority
    this.timeZone = frame.timeZone
    this.advanceWhileEmpty = frame.advanceWhileEmpty
    this.gameTimeMs = frame.gameTimeMs
    const wasDevice = this.deviceOverlay.localDeviceId
    if (wasDevice === 'remote-device' || wasDevice.length === 0) {
      this.deviceOverlay = { ...this.deviceOverlay, localDeviceId: frame.deviceId }
    }
    this.config = {
      serverUrl: this.serverUrl,
      petId: frame.petId,
      deviceId: frame.deviceId,
      lastRevision: this.cursor.revision,
      lastEventSeq: this.cursor.eventSeq,
    }
    if (frame.issuedToken !== undefined) {
      const issuedToken = frame.issuedToken
      this.token = issuedToken
      this.pair = undefined
      this.queuePersistence(() => this.tokenStore.saveToken(issuedToken))
    }
    this.queuePersistence(() => this.tokenStore.saveConfig(this.buildConfig()))
    this.expectedSnapshot = frame.delivery === 'snapshot' || frame.delivery === 'replay+snapshot'
    this.expectedReplay = frame.delivery === 'replay' || frame.delivery === 'replay+snapshot'
    if (frame.delivery === 'none' || frame.delivery === 'replay') {
      if (this.authorityResetPending) {
        // Authentication succeeded but the server planned a cached/replay-only
        // delivery. A reset lineage must still recover from a full snapshot.
        this.setState('catching_up')
        this.expectedSnapshot = false
        this.expectedReplay = false
        this.requestResyncInternal(true)
        return
      }
      this.setState('online')
      this.expectedSnapshot = false
      this.resolveStartWaiters()
      if (frame.delivery === 'none') {
        this.markOnline()
      }
    } else {
      this.setState(frame.catchingUp ? 'catching_up' : 'connecting')
    }
  }

  private buildConfig(): RemoteSyncConfig {
    return {
      serverUrl: this.serverUrl,
      petId: this.config?.petId ?? '',
      deviceId: this.config?.deviceId ?? '',
      lastRevision: this.cursor.revision,
      lastEventSeq: this.cursor.eventSeq,
    }
  }

  private persistConfig(): void {
    if (this.config === null) return
    this.config = { ...this.config, lastRevision: this.cursor.revision, lastEventSeq: this.cursor.eventSeq }
    const config = this.config
    this.queuePersistence(() => this.tokenStore.saveConfig(config))
  }

  private projectionStateSource(frame: ProjectionStateSource): ProjectionStateSource {
    return {
      revision: frame.revision,
      eventSeq: frame.eventSeq,
      gameTimeMs: frame.gameTimeMs,
      timeZone: frame.timeZone,
      advanceWhileEmpty: frame.advanceWhileEmpty,
      authority: frame.authority,
      save: frame.save,
    }
  }

  private materialize(source: ProjectionStateSource): RendererProjection {
    return {
      save: composeSaveWithOverlay(source.save, this.deviceOverlay),
      shared: source.save,
      revision: source.revision,
      eventSeq: source.eventSeq,
      gameTimeMs: source.gameTimeMs,
      timeZone: source.timeZone,
      advanceWhileEmpty: source.advanceWhileEmpty,
      authority: source.authority,
      device: clone(this.deviceOverlay),
    }
  }

  private acceptState(source: ProjectionStateSource): RendererProjection {
    const projection = this.materialize(source)
    this.projection = projection
    this.authority = source.authority
    this.cursor = { revision: source.revision, eventSeq: source.eventSeq }
    this.gameTimeMs = source.gameTimeMs
    this.timeZone = source.timeZone
    this.advanceWhileEmpty = source.advanceWhileEmpty
    this.persistConfig()
    return projection
  }

  private handleSnapshot(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'snapshot' }>): void {
    this.snapshotSeen = true
    const kind = this.syncMode
    const recoveredAuthorityReset = this.authorityResetPending
    const sameState = this.projection !== null
      && frame.revision === this.cursor.revision
      && frame.eventSeq === this.cursor.eventSeq
    if (kind === 'initial' && sameState) {
      this.authority = frame.authority
      this.timeZone = frame.timeZone
      this.advanceWhileEmpty = frame.advanceWhileEmpty
      this.gameTimeMs = frame.gameTimeMs
      this.authorityResetPending = false
      if (recoveredAuthorityReset) this.notice = undefined
      this.persistConfig()
      this.emitStatus()
      if (this.projectionRefreshPending) this.finishProjectionRefresh(false)
      return
    }
    if (kind === 'initial' && this.projection !== null && frame.revision < this.cursor.revision) {
      this.requestResyncInternal(false)
      return
    }
    const replayEvents = this.replayEvents
    this.replayEvents = []
    const projection = this.acceptState(this.projectionStateSource(frame))
    if (kind === 'initial') {
      this.emitProjection(projection, replayEvents)
    } else {
      this.emitResync(projection, replayEvents)
    }
    if (kind !== 'initial' || recoveredAuthorityReset) this.notice = undefined
    this.syncMode = 'initial'
    this.expectedSnapshot = false
    this.authorityResetPending = false
    this.emitStatus()
    if (this.projectionRefreshPending) this.finishProjectionRefresh(false)
  }

  private handleReplay(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'replay' }>): void {
    this.replaySeen = true
    if (frame.fromEventSeq > this.cursor.eventSeq + 1) {
      this.requestResyncInternal(false)
      return
    }
    const novel = frame.events.filter(event => event.eventSeq > this.cursor.eventSeq)
    this.replayEvents.push(...novel)
    this.cursor = { revision: this.cursor.revision, eventSeq: Math.max(this.cursor.eventSeq, frame.toEventSeq) }
    this.persistConfig()
  }

  private handleReady(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'ready' }>): void {
    this.reconnectAttempt = 0
    this.timeZone = frame.timeZone
    this.advanceWhileEmpty = frame.advanceWhileEmpty
    this.gameTimeMs = frame.gameTimeMs
    this.authority = frame.authority
    if (
      (this.expectedSnapshot || this.authorityResetPending)
      && this.snapshotSeen === false
      && frame.catchingUp === false
    ) {
      this.lastError = 'server sent ready without the required full snapshot'
      this.requestResyncInternal(this.authorityResetPending)
      return
    }
    if (this.expectedReplay && this.snapshotSeen === false) {
      if (this.projection === null) {
        this.requestResyncInternal(false)
        return
      }
      if (this.replaySeen) {
        const shared = this.projection.shared
        const updated: RendererProjection = {
          ...this.projection,
          revision: Math.max(this.projection.revision, frame.revision),
          eventSeq: Math.max(this.projection.eventSeq, frame.eventSeq),
          gameTimeMs: frame.gameTimeMs,
          timeZone: frame.timeZone,
          advanceWhileEmpty: frame.advanceWhileEmpty,
          authority: frame.authority,
          save: composeSaveWithOverlay(shared, this.deviceOverlay),
          device: clone(this.deviceOverlay),
        }
        this.projection = updated
        this.cursor = { revision: updated.revision, eventSeq: updated.eventSeq }
        this.authority = frame.authority
        this.emitResync(updated, this.replayEvents)
        this.replayEvents = []
      } else {
        this.requestResyncInternal(false)
        return
      }
    }
    this.expectedSnapshot = false
    this.expectedReplay = false
    this.pendingResync = false
    this.setState('online')
    this.resolveStartWaiters()
    this.persistConfig()
    if (this.projectionRefreshPending) {
      this.finishProjectionRefresh(true)
    } else {
      this.flushReconciliation()
    }
  }

  private handleProjection(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'projection' }>): void {
    if (this.pendingResync) return
    if (this.projection !== null && frame.revision === this.cursor.revision && frame.eventSeq === this.cursor.eventSeq) {
      if (this.projectionRefreshPending) this.finishProjectionRefresh(true)
      return
    }
    const cursor = this.projectionCursor()
    const classification = classifyProjectionDelivery(cursor, frame, frame.events)
    if (classification.kind === 'stale') return
    if (classification.kind === 'resync') {
      this.requestResyncInternal(false)
      return
    }
    const projection = this.acceptState(this.projectionStateSource(frame))
    this.emitProjection(projection, frame.events)
    this.emitStatus()
    if (this.projectionRefreshPending) this.finishProjectionRefresh(true)
  }

  private projectionCursor(): ProjectionCursor | null {
    if (this.projection === null) return null
    const authority = this.projection.authority
    return {
      revision: this.projection.revision,
      eventSeq: this.projection.eventSeq,
      owner: authority.owner,
      authorityId: authority.authorityId,
      authorityEpoch: authority.epoch,
      restoreGeneration: authority.restoreGeneration,
    }
  }

  private settlePendingCommand(pending: PendingCommand, result: CommandResult): void {
    if (this.pendingCommand === pending) this.pendingCommand = null
    this.emitCommandResult(result)
    pending.settle()
    pending.resolve(result)
    this.emitStatus()
  }

  private commandResultNeedsRefresh(result: CommandResult): boolean {
    return result.status !== 'applied' && result.error?.refreshProjection === true
  }

  private rejectedFromError(
    pending: PendingCommand,
    frame: ErrorMessage,
  ): CommandResult {
    return {
      status: 'rejected',
      commandType: pending.command.type,
      opId: pending.opId,
      commandSeq: this.lastCommandSeq ?? 0,
      revision: frame.revision ?? this.cursor.revision,
      eventSeq: this.cursor.eventSeq,
      error: {
        code: commandErrorCodeOf(frame.code),
        message: frame.message,
        refreshProjection: frame.refreshProjection,
      },
    } as CommandResult
  }

  private rejectMatchingExport(frame: ErrorMessage): boolean {
    if (frame.requestId === undefined) return false
    const pending = this.pendingExports.get(frame.requestId)
    if (pending === undefined) return false
    this.pendingExports.delete(frame.requestId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.reject(new Error(frame.code + ': ' + frame.message))
    return true
  }

  /**
   * Keep a command/refresh gate closed until the server has delivered the
   * projection (or full snapshot + ready) requested by refreshProjection.
   */
  private beginProjectionRefresh(
    pending: PendingCommand | null,
    result: CommandResult | null,
    resync: 'none' | 'cache' | 'authority',
  ): void {
    if (pending !== null && result !== null) {
      this.pendingCommandRefresh = { pending, result }
    }
    this.projectionRefreshPending = true
    this.setState('catching_up')
    if (resync === 'authority') this.requestResyncInternal(true)
    else if (resync === 'cache') this.requestResyncInternal(false)
    this.emitStatus()
  }

  private finishProjectionRefresh(onlineAfter: boolean): void {
    this.projectionRefreshPending = false
    const refresh = this.pendingCommandRefresh
    this.pendingCommandRefresh = null
    if (refresh !== null && this.pendingCommand === refresh.pending) {
      this.pendingCommand = null
      this.emitCommandResult(refresh.result)
      refresh.pending.settle()
      refresh.pending.resolve(refresh.result)
    }
    if (onlineAfter && this.stopped === false) {
      this.setState('online')
      this.resolveStartWaiters()
    } else {
      this.emitStatus()
    }
  }

  private prepareAuthorityReset(authority?: WireAuthority): void {
    this.authorityResetPending = true
    this.notice = 'authority_reset_required'
    if (authority !== undefined) this.authority = authority
    this.projection = null
    this.cursor = { revision: 0, eventSeq: 0 }
    this.replayEvents = []
    this.pendingResync = false
    this.setState('catching_up')
  }

  private handleCommandResult(frame: WireCommandResult): void {
    const result = toCommandResult(frame)
    this.lastCommandSeq = frame.commandSeq
    const pending = this.pendingCommand
    if (
      pending !== null
      && pending.opId === frame.opId
      && pending.requestId === frame.requestId
    ) {
      if (this.commandResultNeedsRefresh(result)) {
        this.beginProjectionRefresh(pending, result, 'none')
        return
      }
      this.settlePendingCommand(pending, result)
      return
    }
    // Preserve the refresh barrier even when the late/duplicate result no longer
    // has a pending waiter: no new command may race the authoritative projection.
    if (this.commandResultNeedsRefresh(result)) {
      this.beginProjectionRefresh(null, null, 'none')
      return
    }
    this.emitCommandResult(result)
    this.emitStatus()
  }

  private handleCommandStatusResult(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'commandStatusResult' }>): void {
    const pending = this.pendingCommand
    if (pending === null || pending.opId !== frame.opId) return
    if (frame.status === 'not_applied') {
      const result = this.rejected(pending.command as Extract<PetCommand, { type: CommandKey }>, pending.opId, 'not_available', 'the server did not apply the command; retry with a fresh opId')
      this.settlePendingCommand(pending, result)
      return
    }
    const source = frame.result ?? {
      t: 'commandResult',
      v: PROTOCOL_VERSION,
      requestId: pending.requestId,
      opId: pending.opId,
      commandType: pending.command.type,
      status: frame.status,
      commandSeq: this.lastCommandSeq ?? 0,
      revision: this.cursor.revision,
      eventSeq: this.cursor.eventSeq,
    }
    const result = toCommandResult(source)
    if (this.commandResultNeedsRefresh(result)) {
      this.beginProjectionRefresh(pending, result, 'cache')
      return
    }
    this.settlePendingCommand(pending, result)
  }

  private handlePortableBundle(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'portableBundle' }>): void {
    const pending = this.pendingExports.get(frame.requestId)
    if (pending === undefined) return
    this.pendingExports.delete(frame.requestId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.resolve(clone(frame.bundle))
  }

  private handleAuthorityResetRequired(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'authorityResetRequired' }>): void {
    const authority: WireAuthority = {
      owner: frame.authority.owner,
      authorityId: frame.authority.authorityId,
      restoreGeneration: frame.authority.restoreGeneration,
      epoch: frame.authority.epoch,
      state: 'active',
    }
    this.prepareAuthorityReset(authority)
    this.requestResyncInternal(true)
  }

  private terminalFailure(message: string, notice?: string): void {
    this.reconnectBlocked = true
    this.lastError = message
    if (notice !== undefined) this.notice = notice
    this.rejectPendingWork(new Error(message))
    this.setState('error')
    this.rejectStartWaiters(new Error(message))
  }

  private rejectPendingWork(error: Error): void {
    this.pendingCommandRefresh = null
    this.projectionRefreshPending = false
    if (this.pendingCommand !== null) {
      const pending = this.pendingCommand
      this.pendingCommand = null
      pending.settle()
      pending.reject(error)
    }
    for (const pending of this.pendingExports.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingExports.clear()
  }

  private handleError(frame: ErrorMessage): void {
    this.lastError = frame.message
    const pending = this.pendingCommand
    const commandMatched = pending !== null
      && frame.requestId !== undefined
      && pending.requestId === frame.requestId
    const exportMatched = this.rejectMatchingExport(frame)

    if (frame.code === 'authority_reset_required') this.prepareAuthorityReset()

    if (commandMatched) {
      const result = this.rejectedFromError(pending, frame)
      if (frame.refreshProjection) {
        this.beginProjectionRefresh(
          pending,
          result,
          frame.code === 'authority_reset_required' ? 'authority' : 'none',
        )
      } else {
        this.settlePendingCommand(pending, result)
        if (frame.code === 'authority_reset_required') this.requestResyncInternal(true)
      }
      if (frame.code !== 'authority_reset_required' && (frame.code === 'auth_failed' || frame.code === 'protocol_mismatch')) {
        this.terminalFailure(frame.message)
        this.disconnect()
      }
      return
    }

    if (frame.refreshProjection) {
      this.beginProjectionRefresh(
        null,
        null,
        frame.code === 'authority_reset_required' ? 'authority' : 'none',
      )
      return
    }

    if (
      frame.code === 'auth_failed'
      || frame.code === 'protocol_mismatch'
      || (frame.code === 'unauthorized' && exportMatched === false)
    ) {
      this.terminalFailure(frame.message)
      this.disconnect()
      return
    }
    if (frame.code === 'server_catching_up') {
      this.setState('catching_up')
      return
    }
    if (frame.code === 'authority_reset_required') {
      this.requestResyncInternal(true)
      return
    }
    if (exportMatched) {
      this.emitStatus()
      return
    }
    this.emitStatus()
  }

  private disconnect(): void {
    const connection = this.connection
    this.connection = null
    try {
      connection?.close()
    } catch {
      // best effort
    }
  }

  private requestResyncInternal(discardCachedAuthority: boolean): void {
    if (this.stopped || this.connection === null || this.pendingResync) return
    this.pendingResync = true
    this.syncMode = discardCachedAuthority ? 'authority_reset' : 'resync'
    if (discardCachedAuthority) {
      this.projection = null
      this.cursor = { revision: 0, eventSeq: 0 }
      this.replayEvents = []
    }
    this.setState('catching_up')
    const frame: ResyncRequest = {
      t: 'resync',
      v: PROTOCOL_VERSION,
      requestId: this.newRequestId(),
      ...(discardCachedAuthority
        ? { discardCachedAuthority: true }
        : { lastRevision: this.cursor.revision, lastEventSeq: this.cursor.eventSeq }),
    }
    this.sendJson(frame)
  }

  private flushReconciliation(): void {
    const pending = this.pendingCommand
    if (pending === null || this.reconciledOnConnection) return
    this.reconciledOnConnection = true
    const frame: CommandStatusRequest = {
      t: 'commandStatus',
      v: PROTOCOL_VERSION,
      requestId: this.newRequestId(),
      opId: pending.opId,
    }
    this.sendJson(frame)
  }

  private markOnline(): void {
    this.setState('online')
    this.resolveStartWaiters()
    this.flushReconciliation()
  }

  private backoffDelay(attempt: number): number {
    const capped = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt)
    const unit = Math.min(1, Math.max(0, this.random()))
    return Math.max(1, Math.round(capped / 2 + unit * (capped / 2)))
  }

  private yieldToMacrotask(): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, 0)
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectBlocked || this.reconnectSleeping) return
    if (this.token === null && this.pair === undefined) return
    this.reconnectSleeping = true
    const attempt = this.reconnectAttempt
    this.reconnectAttempt += 1
    const delay = this.backoffDelay(attempt)
    void this.sleep(delay).then(async () => {
      this.reconnectSleeping = false
      if (this.stopped || this.reconnectBlocked) return
      // A test/transport may supply an immediately-resolving sleep; yield to the
      // macrotask queue so a synchronously throwing connect cannot starve timers.
      await this.yieldToMacrotask()
      if (this.stopped || this.reconnectBlocked) return
      this.connect()
    }, () => {
      this.reconnectSleeping = false
    })
  }

  private handleClose(info: RemoteTransportCloseInfo): void {
    this.connection = null
    if (this.stopped) return
    if (this.reconnectBlocked) {
      this.setState('error')
      return
    }
    const closeReason = typeof info.reason === 'string' ? info.reason : ''
    const reason = closeReason.trim().toLowerCase()
    if (info.code === 4000 || info.code === 4001) {
      // Auth/protocol mismatches happen before welcome and are permanent for
      // this start attempt. Never retry them in a tight loop.
      const message = closeReason.length > 0
        ? closeReason
        : info.code === 4000
          ? 'auth_failed'
          : 'protocol_mismatch'
      this.terminalFailure(message)
      return
    }
    if (info.code === 4002 && reason === 'revoked') {
      this.terminalFailure(
        closeReason.length > 0 ? closeReason : 'the server revoked this device session',
        'device_revoked',
      )
      return
    }
    if (info.code === 4002 && (reason === 'authority_reset_required' || reason === 'superseded')) {
      // The server sends authorityResetRequired and then closes with one of
      // these reasons. The reset intent must survive the socket so the next
      // hello omits cachedAuthority and receives a full snapshot.
      this.prepareAuthorityReset()
    }
    this.setState('offline')
    this.scheduleReconnect()
  }
}
