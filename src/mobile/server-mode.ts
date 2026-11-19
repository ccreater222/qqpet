// Android host for qqpet-server mode. The protocol state machine lives in
// src/shared/remote/repository; this file only owns the mobile lifecycle:
// local-vs-server authority selection, the Keystore-backed token store, the
// atomic config/projection-cache files, and the StorageApi surface.
import type { SaveData } from '../shared/save'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import type { DeviceLocalOverlay, DeviceLocalOverlayPatch } from '../shared/sync/data-boundary'
import type { CommandKey, CommandResult, DeviceInfo, PetCommand } from '../shared/sync/protocol'
import { commandResultData, commandResultError } from '../shared/sync/command-result'
import type { RendererProjection, RendererRepositoryStatus, RendererRuntimeInfo } from '../shared/renderer-api'
import { assertTimeZone } from '../shared/pet-runtime/time'
import {
  defaultStorageConfig,
  emptyHandoffReport,
  parseStorageConfig,
  STORAGE_CONFIG_FILE,
  type StorageApi,
  type StorageConfigFile,
  type StorageDeviceListView,
  type StorageExportReport,
  type StorageImportInput,
  type StorageImportReport,
  type StorageMode,
  type StoragePairInput,
  type StorageSetModeInput,
  type StorageStatusView,
} from '../shared/storage'
import { assertRemoteServerUrl } from '../shared/remote/endpoint'
import { RemoteRepository, type RemoteTransport, type RemoteSyncConfig } from '../shared/remote/repository'
import { createWebSocketTransport } from '../shared/remote/websocket-transport'
import { decodeEncodedReadResult } from '../shared/local-repository/storage'
import type { MobileLocalRepositoryBridge } from './local-repository-bridge'
import {
  createMobileRemoteTokenStore,
  MOBILE_SYNC_CONFIG_FILE,
  parseMobileRemoteTokenReply,
  parseMobileSyncConfig,
  type MobileRemoteTokenNative,
  type MobileRemoteTokenStore,
} from './remote-token-store'

/** The native surface the mobile server host needs; test seams pass a memory fake. */
export interface MobileServerNative extends MobileRemoteTokenNative {
  /** Raw app-private file read; used only for the sync-safe storage config at construction. */
  read(name: string): string | undefined
}

export interface MobileServerRuntimeOptions {
  local: MobileLocalRepositoryBridge
  native: MobileServerNative
  appVersion: string
  transport?: RemoteTransport
  now?: () => number
  /** No-cache startup wait; a cached projection returns immediately. */
  connectTimeoutMs?: number
  /** Explicit pairing handshake budget. */
  pairTimeoutMs?: number
  deviceLabel?: string
}

export interface MobileServerRuntime {
  readonly storage: StorageApi
  isServerActive(): boolean
  runtimeInfo(): RendererRuntimeInfo
  load(): Promise<SaveData>
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  localSettings: {
    load(): Promise<DeviceLocalOverlay>
    update(patch: DeviceLocalOverlayPatch): Promise<DeviceLocalOverlay>
  }
  onProjection(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): void
  onResync(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): void
  onCommandResult(listener: (result: CommandResult) => void): void
  onSyncStatus(listener: (status: RendererRepositoryStatus) => void): void
  getProjection(): RendererProjection | null
  getStatus(): RendererRepositoryStatus
  requestResync(): void
  flush(): Promise<void>
  stop(): Promise<void>
  /** pagehide/visibility: local suspends; server keeps the socket and resyncs on return. */
  handlePresence(away: boolean): Promise<void>
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_PAIR_TIMEOUT_MS = 15_000

type ProjectionListener = (projection: RendererProjection, events: OrderedEvent[]) => void
type CommandResultListener = (result: CommandResult) => void
type SyncStatusListener = (status: RendererRepositoryStatus) => void
type StatusListener = (status: StorageStatusView) => void
type DevicesListener = (view: StorageDeviceListView) => void

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_payload: ' + label + ' must be an object')
  }
  return value as Record<string, unknown>
}

function validatePairInput(value: unknown): StoragePairInput {
  const record = requireObject(value, 'pairing input')
  if (typeof record.serverUrl !== 'string' || record.serverUrl.length === 0) {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  assertAndroidServerUrl(record.serverUrl)
  if (typeof record.code !== 'string' || record.code.length === 0) {
    throw new Error('invalid_payload: pairing code is required')
  }
  if (typeof record.deviceLabel !== 'string' || record.deviceLabel.length === 0) {
    throw new Error('invalid_payload: device label is required')
  }
  return { serverUrl: record.serverUrl, code: record.code, deviceLabel: record.deviceLabel }
}

function validateSetModeInput(value: unknown): StorageSetModeInput {
  const record = requireObject(value, 'mode input')
  if (record.mode !== 'local' && record.mode !== 'server') {
    throw new Error('invalid_payload: mode must be local or server')
  }
  if (record.serverUrl !== undefined) {
    if (typeof record.serverUrl !== 'string' || record.serverUrl.length === 0) {
      throw new Error('invalid_payload: serverUrl must be a non-empty string')
    }
    assertAndroidServerUrl(record.serverUrl)
  }
  if (record.pairingCode !== undefined && (typeof record.pairingCode !== 'string' || record.pairingCode.length === 0)) {
    throw new Error('invalid_payload: pairingCode must be a non-empty string')
  }
  if (record.deviceLabel !== undefined && (typeof record.deviceLabel !== 'string' || record.deviceLabel.length === 0)) {
    throw new Error('invalid_payload: deviceLabel must be a non-empty string')
  }
  return {
    mode: record.mode,
    ...(record.serverUrl === undefined ? {} : { serverUrl: record.serverUrl }),
    ...(record.pairingCode === undefined ? {} : { pairingCode: record.pairingCode }),
    ...(record.deviceLabel === undefined ? {} : { deviceLabel: record.deviceLabel }),
  }
}

/**
 * Android's WebView is a secure context: a page loaded over https may only
 * open wss:// sockets, except loopback, which is a trustworthy origin. A plain
 * ws:// private-IP endpoint would pass the shared validator and then be
 * rejected by the browser, so fail early with an actionable message.
 */
function assertAndroidServerUrl(value: string): string {
  const url = assertRemoteServerUrl(value)
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:') return url
  const host = parsed.hostname.toLowerCase()
  const loopback = host === '127.0.0.1'
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || host === '[::1]'
  if (loopback === false) {
    throw new Error('android_transport_unsupported: Android can only use ws://127.0.0.1 (adb reverse) or wss://; use wss:// for a real server')
  }
  return url
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + '_timeout')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function validateImportInput(value: unknown): StorageImportInput {
  const record = requireObject(value, 'import input')
  if (typeof record.json !== 'string' || record.json.length === 0) {
    throw new Error('invalid_payload: bundle json is required')
  }
  return { json: record.json }
}

export function createMobileServerRuntime(options: MobileServerRuntimeOptions): MobileServerRuntime {
  const { local, native, appVersion } = options
  const now = options.now ?? (() => Date.now())
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const pairTimeoutMs = options.pairTimeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS
  const transport = options.transport ?? createWebSocketTransport()
  const tokenStore: MobileRemoteTokenStore = createMobileRemoteTokenStore(native)

  let config: StorageConfigFile = readStorageConfig()
  let activeMode: StorageMode = 'local'
  let remote: RemoteRepository | null = null
  let syncConfig: RemoteSyncConfig | null = readSyncConfig()
  let notice: string | undefined
  let lastError: string | undefined
  let pairedFlag = syncConfig !== null && readTokenSilently() !== null
  let localStarted = false
  let localSuspended = false
  let initialized: Promise<void> | null = null
  let stopped = false

  let projectionListener: ProjectionListener | null = null
  let resyncListener: ProjectionListener | null = null
  let commandResultListener: CommandResultListener | null = null
  let syncStatusListener: SyncStatusListener | null = null
  const statusListeners = new Set<StatusListener>()
  const devicesListeners = new Set<DevicesListener>()

  function readStorageConfig(): StorageConfigFile {
    try {
      const text = native.read(STORAGE_CONFIG_FILE)
      if (typeof text !== 'string' || text.length === 0) return defaultStorageConfig()
      return parseStorageConfig(JSON.parse(text) as unknown)
    } catch {
      return defaultStorageConfig()
    }
  }

  function readSyncConfig(): RemoteSyncConfig | null {
    try {
      const result = decodeEncodedReadResult(native.readStateFile(MOBILE_SYNC_CONFIG_FILE))
      if (result.status === 'error' || result.text === null) return null
      return parseMobileSyncConfig(JSON.parse(result.text) as unknown)
    } catch {
      return null
    }
  }

  function readTokenSilently(): string | null {
    try {
      return parseMobileRemoteTokenReply(native.loadRemoteToken?.())
    } catch (error) {
      lastError = messageOf(error)
      return null
    }
  }

  function writeConfig(): void {
    const text = JSON.stringify(config, null, 2)
    if (native.writeAtomic(STORAGE_CONFIG_FILE, text) !== true) {
      throw new Error('state_write_failed: ' + STORAGE_CONFIG_FILE)
    }
  }

  function createRemote(serverUrl: string, pair?: { code: string; deviceLabel: string }): RemoteRepository {
    return new RemoteRepository({
      serverUrl,
      appVersion,
      tokenStore,
      transport,
      ...(pair === undefined ? {} : { pair }),
    })
  }

  function emitStatus(): void {
    if (statusListeners.size === 0) return
    const view = statusView()
    for (const listener of statusListeners) listener(view)
  }

  function emitProjection(projection: RendererProjection, events: OrderedEvent[]): void {
    projectionListener?.(projection, events)
  }

  /** A mode switch is a full replacement from the renderer's point of view. */
  function emitCurrentProjection(): void {
    const projection = activeMode === 'server' && remote !== null ? remote.getProjection() : local.getProjection()
    if (projection !== null) emitResync(projection, [])
    syncStatusListener?.(activeMode === 'server' && remote !== null ? remote.getStatus() : local.getStatus())
    emitStatus()
  }

  function emitResync(projection: RendererProjection, events: OrderedEvent[]): void {
    resyncListener?.(projection, events)
  }

  function emitCommandResult(result: CommandResult): void {
    commandResultListener?.(result)
  }

  function bindRemote(repository: RemoteRepository): void {
    repository.onProjection((projection, events) => {
      if (activeMode === 'server' && remote === repository) emitProjection(projection, events)
    })
    repository.onResync((projection, events) => {
      if (activeMode === 'server' && remote === repository) emitResync(projection, events)
    })
    repository.onCommandResult(result => {
      if (activeMode === 'server' && remote === repository) emitCommandResult(result)
    })
    repository.onSyncStatus(status => {
      if (activeMode !== 'server' || remote !== repository) return
      lastError = status.lastError
      syncStatusListener?.(status)
      emitStatus()
    })
  }

  function subscribeLocal(): void {
    local.onProjection((projection, events) => {
      if (activeMode === 'local') emitProjection(projection, events)
    })
    local.onResync((projection, events) => {
      if (activeMode === 'local') emitResync(projection, events)
    })
    local.onCommandResult(result => {
      if (activeMode === 'local') emitCommandResult(result)
    })
    local.onSyncStatus(status => {
      if (activeMode !== 'local') return
      lastError = status.lastError
      syncStatusListener?.(status)
      emitStatus()
    })
  }

  async function ensureLocalLoaded(): Promise<SaveData> {
    if (localStarted === false) {
      localStarted = true
      const save = await local.load()
      localSuspended = false
      return save
    }
    if (localSuspended) {
      await local.resume()
      localSuspended = false
    }
    return local.load()
  }

  async function suspendLocalIfStarted(): Promise<void> {
    if (localStarted === false || localSuspended) return
    // Failing closed is mandatory here: a local scheduler that keeps ticking
    // while the server owns canonical state would create a second writer.
    await local.suspend()
    localSuspended = true
  }

  async function resumeLocalIfNeeded(): Promise<void> {
    if (localStarted === false) {
      await ensureLocalLoaded()
      return
    }
    if (localSuspended) {
      await local.resume()
      localSuspended = false
      return
    }
    await local.load()
  }

  async function stopRemote(): Promise<void> {
    const repository = remote
    remote = null
    if (repository !== null) {
      try { await repository.stop() } catch { /* best effort */ }
    }
  }

  async function initializeNow(): Promise<void> {
    if (config.mode !== 'server') {
      activeMode = 'local'
      return
    }
    let token: string | null = null
    let stored: RemoteSyncConfig | null = null
    try {
      token = await tokenStore.loadToken()
      stored = await tokenStore.loadConfig()
    } catch (error) {
      lastError = messageOf(error)
      notice = '服务器配对信息不可读，已回到本机存储；请重新配对。'
      config = { ...defaultStorageConfig() }
      pairedFlag = false
      activeMode = 'local'
      try { writeConfig() } catch { /* the local fallback still works */ }
      emitStatus()
      return
    }
    if (token === null || stored === null) {
      notice = '服务器模式尚未配对，已回到本机存储。'
      config = { ...config, mode: 'local' }
      pairedFlag = false
      activeMode = 'local'
      try { writeConfig() } catch { /* the local fallback still works */ }
      emitStatus()
      return
    }
    syncConfig = stored
    pairedFlag = true
    try {
      const repository = createRemote(assertAndroidServerUrl(stored.serverUrl))
      remote = repository
      bindRemote(repository)
      const projection = await withTimeout(repository.start(), connectTimeoutMs, 'server_connect')
      if (projection === null) throw new Error('offline: the server did not return a projection')
      await suspendLocalIfStarted()
      activeMode = 'server'
      notice = undefined
      lastError = undefined
      emitCurrentProjection()
    } catch (error) {
      lastError = messageOf(error)
      const message = messageOf(error)
      notice = message.startsWith('android_transport_unsupported')
        ? '服务器地址在 Android 上不可用（仅 wss:// 或 ws://127.0.0.1），已回到本机存储；请重新配对。'
        : message.includes('suspend')
          ? '本机存档无法暂停，服务器模式未激活；已保持本机存储。'
          : '服务器离线，已回到本机存储；配对信息保留，可稍后重试。'
      await stopRemote()
      config = { ...config, mode: 'local' }
      activeMode = 'local'
      try { writeConfig() } catch { /* the local fallback still works */ }
    }
    emitStatus()
  }

  function initialize(): Promise<void> {
    if (initialized === null) initialized = initializeNow()
    return initialized
  }

  async function connectStored(): Promise<void> {
    const token = await tokenStore.loadToken()
    const stored = await tokenStore.loadConfig()
    if (token === null || stored === null) {
      throw new Error('pairing_required: pair this device with a server before switching to server mode')
    }
    syncConfig = stored
    pairedFlag = true
    await stopRemote()
    const repository = createRemote(assertAndroidServerUrl(stored.serverUrl))
    remote = repository
    bindRemote(repository)
    try {
      const projection = await withTimeout(repository.start(), connectTimeoutMs, 'server_connect')
      if (projection === null) throw new Error('offline: the server did not return a projection')
      await suspendLocalIfStarted()
    } catch (error) {
      await stopRemote()
      const message = messageOf(error)
      throw new Error(message.startsWith('offline:') ? message : 'offline: ' + message)
    }
    activeMode = 'server'
    config = {
      ...config,
      mode: 'server',
      serverUrl: stored.serverUrl,
      ...(config.deviceLabel === undefined ? {} : { deviceLabel: config.deviceLabel }),
    }
    notice = undefined
    writeConfig()
    emitCurrentProjection()
  }

  async function switchLocal(): Promise<void> {
    await stopRemote()
    activeMode = 'local'
    config = { ...config, mode: 'local' }
    await resumeLocalIfNeeded()
    notice = undefined
    writeConfig()
    emitCurrentProjection()
  }

  function authorityView(status: RendererRepositoryStatus): StorageStatusView['authority'] {
    return {
      ...status.authority,
      revision: status.revision,
      eventSeq: status.eventSeq,
      ...(status.localDeviceId === undefined ? {} : { localDeviceId: status.localDeviceId }),
    }
  }

  function statusView(): StorageStatusView {
    const serverActive = activeMode === 'server' && remote !== null
    const status = serverActive
      ? (remote as RemoteRepository).getStatus()
      : local.getStatus()
    const connection = serverActive ? status.connection : 'local'
    // A recovered connection must not keep the previous socket error pinned in
    // the panel; command rejections still surface through command results.
    const effectiveError = connection === 'online' ? undefined : (status.lastError ?? lastError)
    return {
      mode: config.mode,
      activeMode,
      serverModeAvailable: true,
      connection,
      ...(config.serverUrl === undefined && syncConfig === null ? {} : { serverUrl: config.serverUrl ?? syncConfig?.serverUrl }),
      paired: pairedFlag,
      ...(syncConfig === null ? {} : { petId: syncConfig.petId, deviceId: syncConfig.deviceId }),
      ...(serverActive && status.role !== undefined ? { deviceRole: status.role as StorageStatusView['deviceRole'] } : {}),
      ...(config.deviceLabel === undefined ? {} : { deviceLabel: config.deviceLabel }),
      authority: authorityView(status),
      revision: status.revision,
      eventSeq: status.eventSeq,
      gameTimeMs: status.gameTimeMs,
      timeZone: status.timeZone,
      weatherCity: status.weatherCity ?? '',
      advanceWhileEmpty: status.advanceWhileEmpty,
      readOnly: status.readOnly ?? false,
      catchingUp: status.catchingUp ?? false,
      ...(effectiveError === undefined ? {} : { lastError: effectiveError }),
      ...(status.notice === undefined && notice === undefined ? {} : { notice: status.notice ?? notice }),
      migration: { state: 'native_v2' },
      backup: { available: false, reason: 'mobile_no_backup' },
      handoff: emptyHandoffReport(),
    }
  }

  async function pair(input: unknown): Promise<StorageStatusView> {
    const parsed = validatePairInput(input)
    await initialize()
    const existing = await tokenStore.loadToken().catch(() => null)
    const existingConfig = existing === null ? null : await tokenStore.loadConfig().catch(() => null)
    if (existing !== null && existingConfig !== null) {
      throw new Error('already_paired: unpair this device before pairing a different server')
    }
    if (existing !== null || existingConfig !== null) {
      // A token without a config (or the reverse) is a half-persisted pairing.
      // RemoteRepository would authenticate with that stale token instead of
      // the fresh pairing code, so clear both before starting the handshake.
      try {
        await tokenStore.clear()
      } catch (error) {
        throw new Error('pairing_failed: could not clear the previous pairing: ' + messageOf(error))
      }
      pairedFlag = false
      syncConfig = null
    }
    await stopRemote()
    const repository = createRemote(parsed.serverUrl, { code: parsed.code, deviceLabel: parsed.deviceLabel })
    remote = repository
    bindRemote(repository)
    try {
      const projection = await withTimeout(repository.start(), pairTimeoutMs, 'server_pair')
      if (projection === null) throw new Error('pairing_failed: the server did not return a projection')
      await repository.flush()
      const token = await tokenStore.loadToken()
      const stored = await tokenStore.loadConfig()
      if (token === null || stored === null) {
        throw new Error('pairing_failed: the device token was not persisted')
      }
      syncConfig = stored
      pairedFlag = true
      await suspendLocalIfStarted()
      config = {
        ...config,
        mode: 'server',
        serverUrl: parsed.serverUrl,
        deviceLabel: parsed.deviceLabel,
      }
      writeConfig()
      activeMode = 'server'
      notice = undefined
      lastError = undefined
      emitCurrentProjection()
      return statusView()
    } catch (error) {
      await stopRemote()
      // The pairing did not commit: never leave a token/cache that a later
      // start could mistake for a completed pairing.
      try { await tokenStore.clear() } catch { /* best effort */ }
      syncConfig = null
      pairedFlag = false
      activeMode = 'local'
      if (localSuspended) {
        try { await resumeLocalIfNeeded() } catch { /* local stays read-only; the pairing still failed closed */ }
      }
      lastError = messageOf(error)
      emitStatus()
      throw error
    }
  }

  async function unpair(): Promise<StorageStatusView> {
    await initialize()
    await stopRemote()
    let failure: Error | null = null
    try {
      await tokenStore.clear()
    } catch (error) {
      failure = new Error('unpair_failed: ' + messageOf(error))
    }
    pairedFlag = false
    syncConfig = null
    activeMode = 'local'
    config = { ...defaultStorageConfig(), mode: 'local' }
    await resumeLocalIfNeeded()
    notice = undefined
    lastError = failure === null ? undefined : messageOf(failure)
    writeConfig()
    emitStatus()
    if (failure !== null) throw failure
    return statusView()
  }

  async function setMode(input: unknown): Promise<StorageStatusView> {
    const parsed = validateSetModeInput(input)
    if ((input as { initialSource?: unknown }).initialSource === 'upload-local') {
      throw new Error('unsupported: mobile hosts do not upload the local pet to the server')
    }
    await initialize()
    if (parsed.mode === 'local') {
      if (activeMode === 'local') {
        config = { ...config, mode: 'local' }
        writeConfig()
        emitStatus()
        return statusView()
      }
      await switchLocal()
      return statusView()
    }
    if (activeMode === 'server') {
      config = { ...config, mode: 'server' }
      writeConfig()
      emitStatus()
      return statusView()
    }
    if (parsed.serverUrl !== undefined && parsed.pairingCode !== undefined && parsed.deviceLabel !== undefined) {
      return pair({ serverUrl: parsed.serverUrl, code: parsed.pairingCode, deviceLabel: parsed.deviceLabel })
    }
    await connectStored()
    return statusView()
  }

  async function listDevices(): Promise<StorageDeviceListView> {
    const empty: StorageDeviceListView = { devices: [], owner: false, canRevoke: false }
    await initialize()
    if (activeMode !== 'server' || remote === null) return { ...empty, error: 'offline: pair a server first' }
    if (remote.getStatus().role !== 'owner') {
      return { ...empty, error: 'unauthorized: only an owner device can list devices' }
    }
    try {
      const result = await remote.command({ type: 'device.list', payload: {} })
      const error = commandResultError(result)
      if (error !== null) return { ...empty, error: error.message }
      const devices = (commandResultData(result) as { devices?: DeviceInfo[] } | undefined)?.devices ?? []
      const view: StorageDeviceListView = {
        devices: [...devices].sort((a, b) => a.createdAtMs - b.createdAtMs || a.deviceId.localeCompare(b.deviceId)),
        owner: true,
        canRevoke: true,
      }
      for (const listener of devicesListeners) listener(view)
      return view
    } catch (error) {
      return { ...empty, error: messageOf(error) }
    }
  }

  async function revokeDevice(deviceId: string): Promise<StorageDeviceListView> {
    await initialize()
    if (activeMode !== 'server' || remote === null) throw new Error('offline: pair a server first')
    if (remote.getStatus().role !== 'owner') throw new Error('unauthorized: only an owner device can revoke devices')
    const result = await remote.command({ type: 'device.revoke', payload: { deviceId } })
    const error = commandResultError(result)
    if (error !== null) throw new Error(error.code + ': ' + error.message)
    return listDevices()
  }

  async function commandActive(command: PetCommand): Promise<CommandResult> {
    await initialize()
    if (activeMode === 'server' && remote !== null) return remote.command(command)
    await ensureLocalLoaded()
    return local.command(command)
  }

  const storage: StorageApi = {
    async status() {
      await initialize()
      return statusView()
    },
    pair,
    unpair,
    setMode,
    listDevices,
    revokeDevice,
    async setAdvanceWhileEmpty(enabled: boolean) {
      await initialize()
      if (activeMode === 'server' && remote !== null) {
        await remote.setAdvanceWhileEmpty(enabled)
      } else {
        await ensureLocalLoaded()
        await local.setAdvanceWhileEmpty(enabled)
      }
      emitStatus()
      return statusView()
    },
    async setTimeZone(timeZone: string) {
      if (typeof timeZone !== 'string' || timeZone.length === 0) throw new Error('invalid_payload: timeZone is required')
      assertTimeZone(timeZone)
      const result = await commandActive({ type: 'server.setTimeZone', payload: { timeZone } })
      const error = commandResultError(result)
      if (error !== null) throw new Error(error.code + ': ' + error.message)
      emitStatus()
      return statusView()
    },
    async setWeatherCity(city: string) {
      if (typeof city !== 'string') throw new Error('invalid_payload: city must be a string')
      const result = await commandActive({ type: 'server.setWeatherCity', payload: { city: city.trim() } })
      const error = commandResultError(result)
      if (error !== null) throw new Error(error.code + ': ' + error.message)
      emitStatus()
      return statusView()
    },
    async exportBundle() {
      await initialize()
      const mode = activeMode
      const json = mode === 'server' && remote !== null
        ? JSON.stringify(await remote.exportBundle())
        : await (async () => {
          await ensureLocalLoaded()
          return local.exportPortableBundleJson()
        })()
      const day = new Date(now()).toISOString().slice(0, 10)
      return { json, fileName: `QQPet-portable-${day}.json`, mode } satisfies StorageExportReport
    },
    async importBundle(input: unknown) {
      await initialize()
      if (activeMode === 'server') {
        throw new Error('unsupported: server mode import is desktop-only')
      }
      const parsed = validateImportInput(input)
      await ensureLocalLoaded()
      await local.importPortableBundleJson(parsed.json)
      return {
        status: 'applied',
        mode: 'local',
        restoreGenerationReset: false,
      } satisfies StorageImportReport
    },
    async importBundleDialog() {
      return null
    },
    async retryHandoff() {
      return { ...statusView(), notice: '移动端不支持交接重试；服务器模式请直接重新配对或切换。' }
    },
    async rollbackHandoff() {
      return { ...statusView(), notice: '移动端不支持交接回滚；本机宠物不会因服务器模式被归档。' }
    },
    async createBackup() {
      return { ...statusView(), notice: '移动端不提供本机备份；服务器备份请在 qqpet-server 侧执行。' }
    },
    onStatus(listener) {
      statusListeners.add(listener)
    },
    onDevices(listener) {
      devicesListeners.add(listener)
    },
  }

  subscribeLocal()

  const runtime: MobileServerRuntime = {
    storage,
    isServerActive: () => activeMode === 'server',
    runtimeInfo: () => ({ localRepositoryV2: true, serverMode: activeMode === 'server' }),
    async load() {
      await initialize()
      if (activeMode === 'server' && remote !== null) return clone(await remote.load())
      return clone(await ensureLocalLoaded())
    },
    async command(command, commandOptions = {}) {
      await initialize()
      if (activeMode === 'server' && remote !== null) return remote.command(command, commandOptions)
      await ensureLocalLoaded()
      return local.command(command, commandOptions)
    },
    async setAdvanceWhileEmpty(enabled) {
      await initialize()
      if (activeMode === 'server' && remote !== null) await remote.setAdvanceWhileEmpty(enabled)
      else {
        await ensureLocalLoaded()
        await local.setAdvanceWhileEmpty(enabled)
      }
    },
    localSettings: {
      async load() {
        await initialize()
        if (activeMode === 'server' && remote !== null) return remote.loadLocalSettings()
        await ensureLocalLoaded()
        return local.localSettings.load()
      },
      async update(patch) {
        await initialize()
        if (activeMode === 'server' && remote !== null) return remote.updateLocalSettings(patch)
        await ensureLocalLoaded()
        return local.localSettings.update(patch)
      },
    },
    onProjection(listener) { projectionListener = listener },
    onResync(listener) { resyncListener = listener },
    onCommandResult(listener) { commandResultListener = listener },
    onSyncStatus(listener) { syncStatusListener = listener },
    getProjection() {
      return activeMode === 'server' && remote !== null ? remote.getProjection() : local.getProjection()
    },
    getStatus() {
      return activeMode === 'server' && remote !== null ? remote.getStatus() : local.getStatus()
    },
    requestResync() {
      if (activeMode === 'server' && remote !== null) remote.requestResync()
      else if (localStarted) local.requestResync()
    },
    async flush() {
      if (activeMode === 'server' && remote !== null) await remote.flush()
      else if (localStarted) await local.flush()
    },
    async stop() {
      if (stopped) return
      stopped = true
      try { await initialize() } catch { /* initializeNow records its own failures */ }
      await stopRemote()
      if (localStarted) await local.stop()
    },
    async handlePresence(away) {
      if (activeMode === 'local') {
        if (localStarted === false) return
        if (away) {
          if (localSuspended) return
          try {
            await local.suspend()
            localSuspended = true
          } catch (error) {
            lastError = messageOf(error)
          }
        } else if (localSuspended) {
          await local.resume()
          localSuspended = false
        }
        return
      }
      if (away) {
        try {
          await remote?.flush()
        } catch (error) {
          lastError = messageOf(error)
        }
        return
      }
      remote?.requestResync()
      emitStatus()
    },
  }
  return runtime
}
