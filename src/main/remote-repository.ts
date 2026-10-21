import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { startSave } from '../shared/save-logic'
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
  PROTOCOL_VERSION,
  type ClientHello,
  type CommandErrorCode,
  type CommandKey,
  type CommandRequest,
  type CommandResult,
  type CommandStatusRequest,
  type DeviceRole,
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
  private startWaiters: Array<() => void> = []

  private pendingCommand: PendingCommand | null = null
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
    this.serverUrl = options.serverUrl
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
      readOnly: authority.state !== 'active',
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
    if (this.token === null && this.pair === undefined) {
      this.lastError = 'a device token or pairing code is required before connecting'
      this.setState('error')
      throw new Error(this.lastError)
    }
    const waiter = new Promise<void>(resolve => { this.startWaiters.push(resolve) })
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
    for (const resolve of waiters) resolve()
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
    this.reconnectAttempt = 0
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
    const cached = this.projection
    const hello: ClientHello = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      requestId: this.newRequestId(),
      appVersion: this.appVersion,
      ...(this.config?.petId === undefined || this.config.petId.length === 0 ? {} : { petId: this.config.petId }),
      ...(this.config?.deviceId === undefined || this.config.deviceId.length === 0 ? {} : { deviceId: this.config.deviceId }),
      ...(this.cursor.revision > 0 ? { lastRevision: this.cursor.revision } : {}),
      ...(this.cursor.eventSeq > 0 ? { lastEventSeq: this.cursor.eventSeq } : {}),
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
        this.handleError(frame.code, frame.message)
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
      this.setState('error')
      this.disconnect()
      return
    }
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
    const sameState = this.projection !== null
      && frame.revision === this.cursor.revision
      && frame.eventSeq === this.cursor.eventSeq
    if (kind === 'initial' && sameState) {
      this.authority = frame.authority
      this.timeZone = frame.timeZone
      this.advanceWhileEmpty = frame.advanceWhileEmpty
      this.gameTimeMs = frame.gameTimeMs
      this.persistConfig()
      this.emitStatus()
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
      this.notice = undefined
      this.emitResync(projection, replayEvents)
    }
    this.syncMode = 'initial'
    this.expectedSnapshot = false
    this.emitStatus()
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
    this.timeZone = frame.timeZone
    this.advanceWhileEmpty = frame.advanceWhileEmpty
    this.gameTimeMs = frame.gameTimeMs
    this.authority = frame.authority
    if (this.expectedSnapshot && this.snapshotSeen === false && frame.catchingUp === false) {
      this.lastError = 'server sent ready without the required full snapshot'
      this.requestResyncInternal(false)
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
    this.flushReconciliation()
  }

  private handleProjection(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'projection' }>): void {
    if (this.pendingResync) return
    if (this.projection !== null && frame.revision === this.cursor.revision && frame.eventSeq === this.cursor.eventSeq) {
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

  private handleCommandResult(frame: WireCommandResult): void {
    const result = toCommandResult(frame)
    this.lastCommandSeq = frame.commandSeq
    const pending = this.pendingCommand
    if (pending !== null && pending.opId === frame.opId) {
      this.pendingCommand = null
      this.emitCommandResult(result)
      pending.settle()
      pending.resolve(result)
      this.emitStatus()
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
      this.pendingCommand = null
      this.emitCommandResult(result)
      pending.settle()
      pending.resolve(result)
      this.emitStatus()
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
    this.pendingCommand = null
    this.emitCommandResult(result)
    pending.settle()
    pending.resolve(result)
    this.emitStatus()
  }

  private handlePortableBundle(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'portableBundle' }>): void {
    const pending = this.pendingExports.get(frame.requestId)
    if (pending === undefined) return
    this.pendingExports.delete(frame.requestId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.resolve(clone(frame.bundle))
  }

  private handleAuthorityResetRequired(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'authorityResetRequired' }>): void {
    this.notice = 'authority_reset_required'
    this.authority = {
      owner: frame.authority.owner,
      authorityId: frame.authority.authorityId,
      restoreGeneration: frame.authority.restoreGeneration,
      epoch: frame.authority.epoch,
      state: 'active',
    }
    this.projection = null
    this.cursor = { revision: 0, eventSeq: 0 }
    this.replayEvents = []
    this.pendingResync = false
    this.setState('catching_up')
    this.requestResyncInternal(true)
  }

  private handleError(code: string, message: string): void {
    this.lastError = message
    if (code === 'auth_failed' || code === 'protocol_mismatch' || code === 'unauthorized') {
      this.reconnectBlocked = true
      this.setState('error')
      this.disconnect()
      return
    }
    if (code === 'server_catching_up') {
      this.setState('catching_up')
      return
    }
    if (code === 'authority_reset_required') {
      this.notice = 'authority_reset_required'
      this.projection = null
      this.cursor = { revision: 0, eventSeq: 0 }
      this.pendingResync = false
      this.requestResyncInternal(true)
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
    if (info.code === 4002) {
      this.reconnectBlocked = true
      this.notice = 'device_revoked'
      this.lastError = info.reason.length > 0 ? info.reason : 'the server closed this device session'
      this.setState('error')
      return
    }
    this.setState('offline')
    this.scheduleReconnect()
  }
}
