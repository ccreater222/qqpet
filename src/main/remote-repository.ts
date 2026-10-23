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
import { commandResultError } from '../shared/sync/command-result'
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
import {
  REMOTE_PROJECTION_CACHE_FORMAT,
  REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
  validateRemoteProjectionCacheV2,
  type PortablePetBundleV1,
  type RemoteProjectionCacheV2,
} from '../shared/sync/portable'
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
  /** Optional for older injected stores; PairingStore implements the durable v2 cache. */
  loadProjectionCache?(): Promise<RemoteProjectionCacheV2 | null>
  /** Must validate and atomically replace the cache file before resolving. */
  saveProjectionCache?(cache: RemoteProjectionCacheV2): Promise<void>
  clearProjectionCache?(): Promise<void>
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
  weatherLocation?: string
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
  private weatherLocation = ''
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
  private projectionRefreshAwaitingReady = false
  private authorityResetPending = false
  private reconciledOnConnection = false
  private readonly pendingExports = new Map<string, PendingExport>()
  private restoredProjectionCache = false

  private syncMode: 'initial' | 'resync' | 'authority_reset' = 'initial'
  private expectedSnapshot = false
  private expectedReplay = false
  private snapshotSeen = false
  private catchingUpSeen = false
  private replaySeen = false
  private replayEvents: OrderedEvent[] = []
  private replayInvalid = false
  private replayFromEventSeq = 0
  private replayToEventSeq = 0
  private welcomeHeadRevision = 0
  private welcomeHeadEventSeq = 0
  private welcomeAuthority: WireAuthority | null = null
  private welcomeDelivery: 'none' | 'snapshot' | 'replay' | 'replay+snapshot' | null = null
  private preWelcomeAuthority: WireAuthority | null = null
  private expectedSnapshotAuthority: WireAuthority | null = null
  private expectedSnapshotMinRevision = 0
  private expectedSnapshotMinEventSeq = 0
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
    this.deviceOverlay = options.deviceOverlay === undefined
      ? toDeviceLocalOverlay(startSave(null), 'remote-device')
      : clone(options.deviceOverlay)
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
    const authority = this.authority ?? this.projection?.authority ?? EMPTY_AUTHORITY
    const projectionAuthority = this.projection?.authority
    return {
      mode: 'server',
      connection: this.connectionStatus(),
      serverMode: true,
      revision: this.projection?.revision ?? this.cursor.revision,
      eventSeq: this.projection?.eventSeq ?? this.cursor.eventSeq,
      gameTimeMs: this.projection?.gameTimeMs ?? this.gameTimeMs,
      timeZone: this.projection?.timeZone ?? this.timeZone,
      advanceWhileEmpty: this.projection?.advanceWhileEmpty ?? this.advanceWhileEmpty,
      weatherCity: this.getWeatherCity(),
      authority,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError, error: this.lastError }),
      state: this.state,
      role: this.role,
      readOnly: authority.state !== 'active'
        || projectionAuthority?.state !== 'active'
        || this.projection === null
        || this.projectionRefreshPending
        || this.state !== 'online',
      catchingUp: this.state === 'catching_up',
      ...(this.lastCommandSeq === undefined ? {} : { commandSeq: this.lastCommandSeq }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  getProjection(): RendererProjection | null {
    return this.projection === null ? null : clone(this.projection)
  }

  /** Canonical owner-selected weather location ('' means automatic). */
  getWeatherCity(): string {
    return this.projection?.weatherLocation ?? this.weatherLocation
  }

  getDeviceOverlay(): DeviceLocalOverlay {
    return clone(this.deviceOverlay)
  }

  hasProjectionCache(): boolean {
    return this.restoredProjectionCache
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
      this.persistProjectionCache()
      await this.persistence.catch(() => {})
    }
    return clone(this.deviceOverlay)
  }

  async start(): Promise<RendererProjection | null> {
    if (this.stopped) throw new Error('remote repository is stopped')
    if (this.loaded === false) {
      this.config = await this.tokenStore.loadConfig()
      this.token = await this.tokenStore.loadToken()
      await this.loadProjectionCache(this.config)
      this.loaded = true
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
    this.projectionRefreshAwaitingReady = false
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
    const authority = this.authority ?? this.projection?.authority
    const activeAuthority = this.projection !== null
      && authority !== undefined
      && authority.state === 'active'
      && this.projection.authority.state === 'active'
    // Archived server authority still accepts the owner-only detach/resume
    // handoff pair. All ordinary gameplay commands stay fenced.
    const archivedHandoffCommand = this.projection !== null
      && authority !== undefined
      && authority.state === 'archived'
      && this.projection.authority.state === 'archived'
      && this.role === 'owner'
      && (parsed.command.type === 'admin.exportForDetach' || parsed.command.type === 'admin.resumeServer')
    if (activeAuthority === false && archivedHandoffCommand === false) {
      return this.rejected(command, opId, 'authority_not_active', 'the server authority is not active for commands') as CommandResult<K>
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
    const error = commandResultError(result)
    if (error !== null) throw new Error(error.code + ': ' + error.message)
  }

  async exportBundle(): Promise<PortablePetBundleV1> {
    if (this.role !== 'owner') throw new Error('unauthorized: owner export requires the owner device role')
    if (this.connection === null || this.state !== 'online') throw new Error('offline: cannot export while disconnected')
    const authority = this.authority ?? this.projection?.authority
    if (this.projection === null || authority === undefined || authority.state !== 'active' || this.projection.authority.state !== 'active') {
      throw new Error('authority_not_active: the server authority is not active for export')
    }
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
    this.catchingUpSeen = false
    this.replaySeen = false
    this.replayEvents = []
    this.replayInvalid = false
    this.replayFromEventSeq = 0
    this.replayToEventSeq = 0
    this.clearWelcomeHandshake()
    this.clearExpectedSnapshot()
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
    const advertiseCursor = cached !== null
    const hello: ClientHello = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      requestId: this.newRequestId(),
      appVersion: this.appVersion,
      ...(this.config?.petId === undefined || this.config.petId.length === 0 ? {} : { petId: this.config.petId }),
      ...(this.config?.deviceId === undefined || this.config.deviceId.length === 0 ? {} : { deviceId: this.config.deviceId }),
      ...(advertiseCursor && this.cursor.revision > 0 ? { lastRevision: this.cursor.revision } : {}),
      ...(advertiseCursor && this.cursor.eventSeq > 0 ? { lastEventSeq: this.cursor.eventSeq } : {}),
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
        // The server broadcasts revocations to the surviving sessions. Only a
        // frame naming this authenticated device revokes this repository;
        // treating every broadcast as self-revocation would blank every other
        // client's live projection.
        if (this.config?.deviceId !== frame.deviceId) {
          this.emitStatus()
          break
        }
        this.notice = 'device_revoked'
        this.lastError = 'the server revoked device ' + frame.deviceId
        this.discardProjectionForRevocation()
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
    this.preWelcomeAuthority = this.projection !== null
      ? clone(this.projection.authority)
      : this.authority === null
        ? null
        : clone(this.authority)
    this.welcomeHeadRevision = frame.headRevision
    this.welcomeHeadEventSeq = frame.headEventSeq
    this.welcomeAuthority = clone(frame.authority)
    this.welcomeDelivery = frame.delivery
    // Preserve the handshake bounds before any cache/authority mutation so the
    // snapshot and ready frames can be checked against the same lineage.
    this.expectedSnapshotAuthority = clone(frame.authority)
    this.expectedSnapshotMinRevision = Math.max(this.cursor.revision, frame.headRevision)
    this.expectedSnapshotMinEventSeq = Math.max(this.cursor.eventSeq, frame.headEventSeq)
    this.timeZone = frame.timeZone
    this.advanceWhileEmpty = frame.advanceWhileEmpty
    if (frame.weatherLocation !== undefined) this.weatherLocation = frame.weatherLocation
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
    const welcomeChangesAuthority = this.preWelcomeAuthority !== null
      && this.sameAuthorityLineage(this.preWelcomeAuthority, frame.authority) === false
    if (this.authorityResetPending || welcomeChangesAuthority) {
      // The welcome authority cannot be applied over a cached save from another
      // lineage. Discard both and recover from a new full snapshot.
      this.expectedSnapshot = false
      this.expectedReplay = false
      this.authority = clone(frame.authority)
      this.requestResyncInternal(true, frame.authority)
      return
    }
    this.applyAuthority(frame.authority)
    // A welcome only opens the exchange. start() and commands stay gated until
    // a non-catching-up ready completes the replay/snapshot delivery.
    this.setState(frame.catchingUp ? 'catching_up' : 'connecting')
  }

  private async loadProjectionCache(config: RemoteSyncConfig | null): Promise<void> {
    this.restoredProjectionCache = false
    const load = this.tokenStore.loadProjectionCache
    if (load === undefined) return
    let raw: unknown
    try {
      raw = await load.call(this.tokenStore)
    } catch {
      await this.discardProjectionCacheFile()
      return
    }
    if (
      validateRemoteProjectionCacheV2(raw) === false
      || raw.authority.state === 'reset'
      || config === null
      || raw.petId !== config.petId
      || raw.deviceId !== config.deviceId
    ) {
      if (raw !== null) await this.discardProjectionCacheFile()
      return
    }
    const cache = raw
    // A validated cache is the device's last accepted local overlay. The
    // archived local repository may still be available as a bootstrap seed,
    // but it must never replace fresher cache-backed settings after restore.
    this.deviceOverlay = clone(cache.device)
    this.projection = this.materialize({
      revision: cache.revision,
      eventSeq: cache.eventSeq,
      gameTimeMs: cache.gameTimeMs,
      timeZone: cache.timeZone,
      advanceWhileEmpty: cache.advanceWhileEmpty,
      weatherLocation: cache.weatherLocation,
      authority: cache.authority,
      save: cache.shared,
    })
    this.authority = clone(cache.authority)
    this.cursor = { revision: cache.revision, eventSeq: cache.eventSeq }
    this.gameTimeMs = cache.gameTimeMs
    this.timeZone = cache.timeZone
    this.advanceWhileEmpty = cache.advanceWhileEmpty
    this.weatherLocation = cache.weatherLocation ?? ''
    this.restoredProjectionCache = true
  }

  private async discardProjectionCacheFile(): Promise<void> {
    this.restoredProjectionCache = false
    const clear = this.tokenStore.clearProjectionCache
    if (clear === undefined) return
    try {
      await clear.call(this.tokenStore)
    } catch {
      // A stale cache is never authoritative; failure to remove it must not block startup.
    }
  }

  private queueProjectionCacheClear(): void {
    this.restoredProjectionCache = false
    const clear = this.tokenStore.clearProjectionCache
    if (clear === undefined) return
    this.queuePersistence(() => clear.call(this.tokenStore))
  }

  private projectionCache(projection: RendererProjection): RemoteProjectionCacheV2 | null {
    if (this.config === null || this.config.petId.length === 0 || this.config.deviceId.length === 0) return null
    const cache: RemoteProjectionCacheV2 = {
      format: REMOTE_PROJECTION_CACHE_FORMAT,
      schemaVersion: REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
      petId: this.config.petId,
      deviceId: this.config.deviceId,
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      gameTimeMs: projection.gameTimeMs,
      timeZone: projection.timeZone,
      advanceWhileEmpty: projection.advanceWhileEmpty,
      weatherLocation: projection.weatherLocation ?? this.weatherLocation,
      authority: clone(projection.authority),
      shared: clone(projection.shared),
      device: clone(projection.device ?? this.deviceOverlay),
    }
    return validateRemoteProjectionCacheV2(cache) ? cache : null
  }

  private persistProjectionCache(projection: RendererProjection | null = this.projection): void {
    const save = this.tokenStore.saveProjectionCache
    if (save === undefined || projection === null) return
    const cache = this.projectionCache(projection)
    if (cache === null) return
    this.queuePersistence(() => save.call(this.tokenStore, cache))
  }

  private applyAuthority(authority: WireAuthority): void {
    this.authority = clone(authority)
    if (this.projection === null) return
    this.projection = { ...this.projection, authority: clone(authority) }
  }

  private applyReadyState(
    frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'ready' }>,
    advanceCursor: boolean,
  ): void {
    this.timeZone = frame.timeZone
    this.advanceWhileEmpty = frame.advanceWhileEmpty
    if (frame.weatherLocation !== undefined) this.weatherLocation = frame.weatherLocation
    this.gameTimeMs = frame.gameTimeMs
    this.authority = clone(frame.authority)
    if (advanceCursor) this.cursor = { revision: frame.revision, eventSeq: frame.eventSeq }
    if (this.projection === null) return
    const shared = this.projection.shared
    this.projection = {
      ...this.projection,
      ...(advanceCursor ? { revision: frame.revision, eventSeq: frame.eventSeq } : {}),
      gameTimeMs: frame.gameTimeMs,
      timeZone: frame.timeZone,
      advanceWhileEmpty: frame.advanceWhileEmpty,
      weatherLocation: frame.weatherLocation ?? this.weatherLocation,
      authority: clone(frame.authority),
      save: composeSaveWithOverlay(shared, this.deviceOverlay),
      device: clone(this.deviceOverlay),
    }
  }

  private sameAuthorityLineage(left: WireAuthority, right: WireAuthority): boolean {
    return left.owner === right.owner
      && left.authorityId === right.authorityId
      && left.restoreGeneration === right.restoreGeneration
      && left.epoch === right.epoch
  }

  private clearWelcomeHandshake(): void {
    this.welcomeDelivery = null
    this.welcomeHeadRevision = 0
    this.welcomeHeadEventSeq = 0
    this.welcomeAuthority = null
    this.preWelcomeAuthority = null
  }

  private clearExpectedSnapshot(): void {
    this.expectedSnapshotAuthority = null
    this.expectedSnapshotMinRevision = 0
    this.expectedSnapshotMinEventSeq = 0
  }

  private armExpectedSnapshot(
    authority: WireAuthority | null,
    minRevision: number,
    minEventSeq: number,
  ): void {
    this.expectedSnapshot = true
    this.expectedReplay = false
    this.expectedSnapshotAuthority = authority === null ? null : clone(authority)
    this.expectedSnapshotMinRevision = minRevision
    this.expectedSnapshotMinEventSeq = minEventSeq
    this.snapshotSeen = false
  }

  private readyAuthorityChanged(authority: WireAuthority): boolean {
    const expected = this.welcomeAuthority
      ?? this.expectedSnapshotAuthority
      ?? (this.snapshotSeen ? this.authority : null)
    return expected !== null && this.sameAuthorityLineage(expected, authority) === false
  }

  private retryExpectedSnapshot(reason: string, discardCachedAuthority: boolean): void {
    this.lastError = reason
    this.snapshotSeen = false
    // The rejected frame belongs to the in-flight resync. Re-arm it so the
    // replacement request is not suppressed by the pending-resync guard.
    this.pendingResync = false
    this.requestResyncInternal(discardCachedAuthority)
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
      ...(frame.weatherLocation === undefined ? {} : { weatherLocation: frame.weatherLocation }),
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
      weatherLocation: source.weatherLocation ?? this.weatherLocation,
      authority: source.authority,
      device: clone(this.deviceOverlay),
    }
  }

  private acceptState(source: ProjectionStateSource): RendererProjection {
    const projection = this.materialize(source)
    this.projection = projection
    this.cursor = { revision: source.revision, eventSeq: source.eventSeq }
    this.gameTimeMs = source.gameTimeMs
    this.timeZone = source.timeZone
    this.advanceWhileEmpty = source.advanceWhileEmpty
    if (source.weatherLocation !== undefined) this.weatherLocation = source.weatherLocation
    this.authority = clone(source.authority)
    this.persistConfig()
    this.persistProjectionCache(projection)
    return projection
  }

  private handleSnapshot(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'snapshot' }>): void {
    const kind = this.syncMode
    const recoveredAuthorityReset = this.authorityResetPending
    const handshakeSnapshot = this.welcomeDelivery !== null
      && this.syncMode === 'initial'
      && this.pendingResync === false
    const validateSnapshot = this.expectedSnapshot || handshakeSnapshot
    if (validateSnapshot) {
      if (
        this.expectedSnapshotAuthority !== null
        && this.sameAuthorityLineage(this.expectedSnapshotAuthority, frame.authority) === false
      ) {
        this.retryExpectedSnapshot(
          'server sent a snapshot from an unexpected authority lineage',
          true,
        )
        return
      }
      if (
        frame.revision < this.expectedSnapshotMinRevision
        || frame.eventSeq < this.expectedSnapshotMinEventSeq
      ) {
        this.retryExpectedSnapshot(
          'server sent a snapshot below the required cursor or welcome head',
          false,
        )
        return
      }
    }
    this.snapshotSeen = true
    const replayEvents = this.replayEvents
    this.replayEvents = []
    const projection = this.acceptState(this.projectionStateSource(frame))
    if (validateSnapshot) this.expectedSnapshotAuthority = clone(frame.authority)
    if (kind === 'initial') {
      this.emitProjection(projection, replayEvents)
    } else {
      this.emitResync(projection, replayEvents)
    }
    if (kind !== 'initial' || recoveredAuthorityReset) this.notice = undefined
    this.syncMode = 'initial'
    this.authorityResetPending = false
    this.pendingResync = false
    this.emitStatus()
    if (this.projectionRefreshPending && this.projectionRefreshAwaitingReady === false) {
      this.finishProjectionRefresh(false)
    }
  }

  private rejectReplay(reason: string): void {
    this.replayInvalid = true
    this.replaySeen = false
    this.replayEvents = []
    this.lastError = 'server sent an invalid replay: ' + reason
    this.requestResyncInternal(false)
  }

  private handleReplay(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'replay' }>): void {
    if (this.pendingResync) return
    if (this.expectedReplay === false) {
      this.rejectReplay('a replay was not expected for this delivery')
      return
    }
    if (this.replaySeen) {
      this.rejectReplay('the replay frame was duplicated')
      return
    }
    if (this.projection === null) {
      this.rejectReplay('there is no validated cached projection to extend')
      return
    }
    if (this.projection.revision !== this.cursor.revision || this.projection.eventSeq !== this.cursor.eventSeq) {
      this.rejectReplay('the cached projection does not match the advertised cursor')
      return
    }
    const expectedFrom = this.cursor.eventSeq + 1
    if (frame.fromEventSeq !== expectedFrom || frame.toEventSeq < expectedFrom) {
      this.rejectReplay('the replay bounds do not start immediately after the cached cursor')
      return
    }
    const expectedCount = frame.toEventSeq - frame.fromEventSeq + 1
    if (frame.events.length === 0 || frame.events.length !== expectedCount) {
      this.rejectReplay('the replay range is empty or has a missing interior')
      return
    }
    for (let index = 0; index < expectedCount; index += 1) {
      if (frame.events[index].eventSeq !== frame.fromEventSeq + index) {
        this.rejectReplay('the replay events are not exactly contiguous')
        return
      }
    }
    if (this.welcomeHeadEventSeq > 0 && frame.toEventSeq > this.welcomeHeadEventSeq) {
      this.rejectReplay('the replay extends beyond the advertised head')
      return
    }
    this.replaySeen = true
    this.replayInvalid = false
    this.replayFromEventSeq = frame.fromEventSeq
    this.replayToEventSeq = frame.toEventSeq
    this.replayEvents = clone(frame.events)
  }

  private handleReady(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'ready' }>): void {
    this.reconnectAttempt = 0
    const previousAuthority = this.projection === null ? null : clone(this.projection.authority)
    if (this.readyAuthorityChanged(frame.authority)) {
      this.retryExpectedSnapshot('server ready changed the handshake authority lineage', true)
      return
    }
    const handshakeActive = this.welcomeDelivery !== null
      && this.syncMode === 'initial'
      && this.pendingResync === false
    this.applyAuthority(frame.authority)
    this.timeZone = frame.timeZone
    this.advanceWhileEmpty = frame.advanceWhileEmpty
    if (frame.weatherLocation !== undefined) this.weatherLocation = frame.weatherLocation
    this.gameTimeMs = frame.gameTimeMs
    if (frame.catchingUp) {
      // A catch-up ready is a progress marker, not readiness. Require the
      // final post-catch-up snapshot before this connection becomes writable.
      this.catchingUpSeen = true
      this.snapshotSeen = false
      this.setState('catching_up')
      return
    }

    const authority = frame.authority
    if (this.catchingUpSeen && this.snapshotSeen === false && authority.state === 'active') {
      this.retryExpectedSnapshot('server sent a final ready without the catch-up snapshot', false)
      return
    }
    if (
      (this.expectedSnapshot || this.authorityResetPending || this.pendingResync)
      && this.snapshotSeen === false
      && authority.state !== 'archived'
    ) {
      this.retryExpectedSnapshot(
        'server sent ready without the required full snapshot',
        this.authorityResetPending || authority.state === 'reset',
      )
      return
    }
    if (authority.state === 'reset') {
      this.retryExpectedSnapshot('server ready reported a reset authority lineage', true)
      return
    }

    if (handshakeActive && this.expectedReplay && this.snapshotSeen === false) {
      if (this.projection === null) {
        this.retryExpectedSnapshot('replay arrived without a cached projection', false)
        return
      }
      if (this.replayInvalid || this.replaySeen === false) {
        this.retryExpectedSnapshot('replay delivery was invalid or incomplete', false)
        return
      }
      const welcomeAuthority = this.welcomeAuthority
      const authorityLineageChanged = welcomeAuthority === null
        || !this.sameAuthorityLineage(this.projection.authority, welcomeAuthority)
        || !this.sameAuthorityLineage(welcomeAuthority, authority)
      const authorityStateChanged = welcomeAuthority === null
        || this.projection.authority.state !== welcomeAuthority.state
        || welcomeAuthority.state !== authority.state
      const replayHeadMismatch = this.projection.revision !== this.welcomeHeadRevision
        || this.replayFromEventSeq !== this.cursor.eventSeq + 1
        || this.replayToEventSeq !== this.welcomeHeadEventSeq
        || frame.revision !== this.welcomeHeadRevision
        || frame.eventSeq !== this.welcomeHeadEventSeq
      if (authorityLineageChanged) {
        this.retryExpectedSnapshot('replay projection changed the handshake authority lineage', true)
        return
      }
      if (authorityStateChanged || replayHeadMismatch) {
        this.retryExpectedSnapshot('replay ready did not match the advertised handshake head', false)
        return
      }
      this.applyReadyState(frame, true)
      const updated = this.projection
      const replayEvents = this.replayEvents
      this.replayEvents = []
      if (updated !== null) this.emitResync(updated, replayEvents)
      this.finishReady()
      return
    }

    if (handshakeActive && this.welcomeDelivery === 'none') {
      const welcomeAuthority = this.welcomeAuthority ?? authority
      if (authority.state === 'active') {
        const projection = this.projection
        if (
          projection === null
          || projection.revision !== this.welcomeHeadRevision
          || projection.eventSeq !== this.welcomeHeadEventSeq
          || projection.authority.state !== 'active'
          || welcomeAuthority.state !== 'active'
          || !this.sameAuthorityLineage(projection.authority, welcomeAuthority)
          || !this.sameAuthorityLineage(welcomeAuthority, authority)
          || frame.revision !== this.welcomeHeadRevision
          || frame.eventSeq !== this.welcomeHeadEventSeq
        ) {
          this.retryExpectedSnapshot('cached projection did not match the handshake head', false)
          return
        }
      }
    }

    if (authority.state === 'active') {
      if (this.projection === null) {
        this.retryExpectedSnapshot('active ready arrived without a projection', false)
        return
      }
      if (frame.revision !== this.cursor.revision || frame.eventSeq !== this.cursor.eventSeq) {
        this.retryExpectedSnapshot('active ready did not match the projection cursor', false)
        return
      }
    }

    const advanceCursor = this.projection !== null
      && frame.revision === this.projection.revision
      && frame.eventSeq === this.projection.eventSeq
    this.applyReadyState(frame, advanceCursor)
    const authorityChanged = previousAuthority !== null
      && (previousAuthority.owner !== frame.authority.owner
        || previousAuthority.authorityId !== frame.authority.authorityId
        || previousAuthority.restoreGeneration !== frame.authority.restoreGeneration
        || previousAuthority.epoch !== frame.authority.epoch
        || previousAuthority.state !== frame.authority.state)
    if (this.projection !== null && ((handshakeActive && this.welcomeDelivery === 'none') || authorityChanged)) {
      this.emitResync(this.projection, [])
    }
    this.finishReady()
  }

  private finishReady(): void {
    this.expectedSnapshot = false
    this.expectedReplay = false
    this.pendingResync = false
    this.catchingUpSeen = false
    this.snapshotSeen = false
    this.replaySeen = false
    this.replayInvalid = false
    this.replayEvents = []
    this.syncMode = 'initial'
    this.clearWelcomeHandshake()
    this.clearExpectedSnapshot()
    this.persistConfig()
    this.persistProjectionCache()
    if (this.projectionRefreshPending) {
      this.finishProjectionRefresh(true)
    } else {
      this.projectionRefreshAwaitingReady = false
      this.markOnline()
    }
  }

  private handleProjection(frame: Extract<import('../shared/sync/protocol').ServerToClient, { t: 'projection' }>): void {
    if (this.pendingResync) return
    const sameCursor = this.projection !== null
      && frame.revision === this.cursor.revision
      && frame.eventSeq === this.cursor.eventSeq
    if (this.projection !== null && sameCursor) {
      const currentProjection = this.projection
      const currentAuthority = this.authority ?? currentProjection.authority
      const projectionAuthority = currentProjection.authority
      if (
        this.sameAuthorityLineage(currentAuthority, frame.authority) === false
        || currentAuthority.state !== frame.authority.state
        || this.sameAuthorityLineage(projectionAuthority, frame.authority) === false
        || projectionAuthority.state !== frame.authority.state
      ) {
        // An equal cursor does not make a changed authority safe to apply over
        // the already materialized save. Only a full snapshot may establish a
        // different lineage or state.
        this.requestResyncInternal(true)
        return
      }
      if (frame.weatherLocation !== undefined) {
        this.weatherLocation = frame.weatherLocation
        this.projection = { ...currentProjection, weatherLocation: frame.weatherLocation }
      }
      this.applyAuthority(frame.authority)
      this.persistProjectionCache()
      this.emitStatus()
      if (this.projectionRefreshPending && this.projectionRefreshAwaitingReady === false) {
        this.finishProjectionRefresh(true)
      }
      return
    }
    const cursor = this.projectionCursor()
    const classification = classifyProjectionDelivery(cursor, frame, frame.events)
    if (classification.kind === 'stale') return
    const currentAuthority = this.authority ?? this.projection?.authority
    const authorityChanged = this.projection !== null
      && currentAuthority !== undefined
      && (
        this.sameAuthorityLineage(currentAuthority, frame.authority) === false
        || currentAuthority.state !== frame.authority.state
        || this.sameAuthorityLineage(this.projection.authority, frame.authority) === false
        || this.projection.authority.state !== frame.authority.state
      )
    if (classification.kind === 'resync') {
      this.requestResyncInternal(authorityChanged || classification.reason === 'authority_changed')
      return
    }
    if (authorityChanged) {
      this.requestResyncInternal(true)
      return
    }
    const projection = this.acceptState(this.projectionStateSource(frame))
    this.emitProjection(projection, frame.events)
    this.emitStatus()
    if (this.projectionRefreshPending && this.projectionRefreshAwaitingReady === false) {
      this.finishProjectionRefresh(true)
    }
  }

  private projectionCursor(): ProjectionCursor | null {
    if (this.projection === null) return null
    const authority = this.authority ?? this.projection.authority
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

  private commandResultIsCatchingUp(result: CommandResult): boolean {
    return result.status !== 'applied' && result.error?.code === 'server_catching_up'
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
    awaitFinalReady = false,
  ): void {
    if (pending !== null && result !== null) {
      this.pendingCommandRefresh = { pending, result }
    }
    this.projectionRefreshPending = true
    this.projectionRefreshAwaitingReady = awaitFinalReady
    if (awaitFinalReady) {
      const authority = this.authority ?? this.projection?.authority ?? null
      this.armExpectedSnapshot(authority, this.cursor.revision, this.cursor.eventSeq)
      this.catchingUpSeen = true
    }
    this.setState('catching_up')
    if (resync === 'authority') this.requestResyncInternal(true)
    else if (resync === 'cache') this.requestResyncInternal(false)
    this.emitStatus()
  }

  private finishProjectionRefresh(onlineAfter: boolean): void {
    this.projectionRefreshPending = false
    this.projectionRefreshAwaitingReady = false
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
    this.authority = clone(authority ?? EMPTY_AUTHORITY)
    this.projection = null
    this.cursor = { revision: 0, eventSeq: 0 }
    this.replayEvents = []
    this.replaySeen = false
    this.replayInvalid = false
    this.pendingResync = false
    this.expectedSnapshot = false
    this.expectedReplay = false
    this.clearWelcomeHandshake()
    this.clearExpectedSnapshot()
    this.queueProjectionCacheClear()
    this.setState('catching_up')
  }

  private discardProjectionForRevocation(): void {
    this.projection = null
    this.authority = clone(EMPTY_AUTHORITY)
    this.cursor = { revision: 0, eventSeq: 0 }
    this.replayEvents = []
    this.replaySeen = false
    this.replayInvalid = false
    this.expectedSnapshot = false
    this.expectedReplay = false
    this.pendingResync = false
    this.clearWelcomeHandshake()
    this.clearExpectedSnapshot()
    this.queueProjectionCacheClear()
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
        this.beginProjectionRefresh(
          pending,
          result,
          'none',
          this.commandResultIsCatchingUp(result),
        )
        return
      }
      this.settlePendingCommand(pending, result)
      return
    }
    // Preserve the refresh barrier even when the late/duplicate result no longer
    // has a pending waiter: no new command may race the authoritative projection.
    if (this.commandResultNeedsRefresh(result)) {
      this.beginProjectionRefresh(
        null,
        null,
        'none',
        this.commandResultIsCatchingUp(result),
      )
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
      this.beginProjectionRefresh(
        pending,
        result,
        'cache',
        this.commandResultIsCatchingUp(result),
      )
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
    this.requestResyncInternal(true, authority)
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
    this.projectionRefreshAwaitingReady = false
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

    // Authentication/protocol failures are terminal regardless of the
    // refreshProjection hint. Opening the refresh gate first would hide the
    // permanent failure behind a connection that can never become ready.
    if (frame.code === 'auth_failed' || frame.code === 'protocol_mismatch') {
      this.terminalFailure(frame.message)
      this.disconnect()
      return
    }

    const exportMatched = this.rejectMatchingExport(frame)
    if (frame.code === 'unauthorized' && commandMatched === false && exportMatched === false) {
      this.terminalFailure(frame.message)
      this.disconnect()
      return
    }

    if (frame.code === 'authority_reset_required') this.prepareAuthorityReset()

    if (commandMatched) {
      const result = this.rejectedFromError(pending, frame)
      if (frame.refreshProjection) {
        this.beginProjectionRefresh(
          pending,
          result,
          frame.code === 'authority_reset_required' ? 'authority' : 'none',
          frame.code === 'server_catching_up',
        )
      } else {
        this.settlePendingCommand(pending, result)
        if (frame.code === 'authority_reset_required') this.requestResyncInternal(true)
      }
      return
    }

    if (frame.refreshProjection) {
      this.beginProjectionRefresh(
        null,
        null,
        frame.code === 'authority_reset_required' ? 'authority' : 'none',
        frame.code === 'server_catching_up',
      )
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

  private requestResyncInternal(
    discardCachedAuthority: boolean,
    expectedAuthority?: WireAuthority | null,
  ): void {
    if (this.stopped || this.connection === null || this.pendingResync) return
    const preservedRevision = this.cursor.revision
    const preservedEventSeq = this.cursor.eventSeq
    const snapshotAuthority = expectedAuthority !== undefined
      ? expectedAuthority
      : discardCachedAuthority
        ? null
        : this.authority ?? this.projection?.authority ?? null
    this.pendingResync = true
    this.syncMode = discardCachedAuthority ? 'authority_reset' : 'resync'
    this.expectedReplay = false
    this.replaySeen = false
    this.replayInvalid = false
    this.replayEvents = []
    this.clearWelcomeHandshake()
    if (discardCachedAuthority) {
      this.projection = null
      this.cursor = { revision: 0, eventSeq: 0 }
      this.queueProjectionCacheClear()
    }
    this.armExpectedSnapshot(
      snapshotAuthority,
      discardCachedAuthority ? 0 : preservedRevision,
      discardCachedAuthority ? 0 : preservedEventSeq,
    )
    this.setState('catching_up')
    const frame: ResyncRequest = {
      t: 'resync',
      v: PROTOCOL_VERSION,
      requestId: this.newRequestId(),
      ...(discardCachedAuthority
        ? { discardCachedAuthority: true }
        : { lastRevision: preservedRevision, lastEventSeq: preservedEventSeq }),
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
      this.discardProjectionForRevocation()
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
