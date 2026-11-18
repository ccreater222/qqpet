import type { SaveData } from '../shared/save'
import type { CommandKey, CommandResult, PetCommand } from '../shared/sync/protocol'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import {
  classifyProjectionDelivery,
  createRendererProjection,
  createRendererStatus,
  type ProjectionCursor,
  type RendererProjection,
  type RendererRepositoryStatus,
  type RendererRuntimeInfo,
} from '../shared/renderer-api'
import type { DeviceLocalOverlay, DeviceLocalOverlayPatch } from '../shared/sync/data-boundary'
import { decodeEncodedReadResult, type LocalRepositoryFileReadResult } from '../shared/local-repository/storage'
import {
  createLocalRepositoryHost,
  localRepositoryHostCapability,
  type LocalRepositoryHost,
  type LocalRepositoryHostEvent,
  type LocalRepositoryHostProjection,
  type LocalRepositoryHostStorage,
  type LocalRepositoryHostTimerRuntime,
} from '../shared/local-repository/host'

export type MobileNativeReadEncoding = 'encoded-json' | 'object'

export interface MobileLegacyAuthorityInput {
  devRuntimeFlag: boolean
  readCapability: boolean
  /** Raw return value from the native v2-presence read. */
  readResult?: unknown
  encoding: MobileNativeReadEncoding
}

export interface MobileLegacyAuthorityGate {
  v2DocumentPresent: boolean
  canUseLegacy: boolean
  legacyDisabled: boolean
  /** Set for a read/error/invalid-native-result path; bridges must fail closed. */
  error?: string
  failure?: string
}

function decodeObjectReadResult(raw: unknown): LocalRepositoryFileReadResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'error', error: 'native read returned an invalid result object' }
  }
  const result = raw as Record<string, unknown>
  if (result.status === 'error' && typeof result.error === 'string') {
    return { status: 'error', error: result.error }
  }
  if (result.status === 'ok' && (result.text === null || typeof result.text === 'string')) {
    return { status: 'ok', text: result.text }
  }
  return { status: 'error', error: 'native read returned an invalid result payload' }
}

/** Decodes the two native bridge shapes without conflating missing with read failure. */
export function decodeMobileNativeReadResult(
  raw: unknown,
  encoding: MobileNativeReadEncoding,
): LocalRepositoryFileReadResult {
  return encoding === 'encoded-json' ? decodeEncodedReadResult(raw) : decodeObjectReadResult(raw)
}

/**
 * One bridge-level decision for flag-off legacy coexistence:
 * - ok+null is truly missing -> legacy is allowed;
 * - ok+text is an existing v2 document -> legacy is disabled;
 * - error/invalid native reply -> fail closed and never write legacy state.
 */
export function resolveMobileLegacyAuthority(input: MobileLegacyAuthorityInput): MobileLegacyAuthorityGate {
  if (input.devRuntimeFlag) {
    return { v2DocumentPresent: false, canUseLegacy: false, legacyDisabled: true }
  }
  if (input.readCapability === false) {
    return { v2DocumentPresent: false, canUseLegacy: true, legacyDisabled: false }
  }
  const result = decodeMobileNativeReadResult(input.readResult, input.encoding)
  if (result.status === 'error') {
    return {
      v2DocumentPresent: false,
      canUseLegacy: false,
      legacyDisabled: true,
      error: result.error,
      failure: 'local-v2 presence check failed: ' + result.error,
    }
  }
  if (result.text === null) {
    return { v2DocumentPresent: false, canUseLegacy: true, legacyDisabled: false }
  }
  return {
    v2DocumentPresent: true,
    canUseLegacy: false,
    legacyDisabled: true,
    failure: 'local-v2 document exists; enable the explicit v2 flag',
  }
}

export interface MobileLocalRepositoryBridgeCapability {
  enabled: true
  serverMode: false
  storageKind: string
  atomicDocument: true
  backup: true
}

export interface MobileLocalRepositoryBridgeOptions {
  storage: LocalRepositoryHostStorage
  devRuntimeFlag: boolean
  /** The bridge only installs this adapter when it replaces the legacy writer; defaults false. */
  rendererCapability?: boolean
  nowMs?: () => number
  randomUUID?: () => string
  randomSeedHex?: () => string
  seedHex?: string
  timeZone?: string
  localDeviceId?: string
  appInstanceId?: string
  advanceWhileEmpty?: boolean
  initialSave?: unknown
  pollIntervalMs?: number
  maxChunkTicks?: number
  autoScheduler?: boolean
  timer?: LocalRepositoryHostTimerRuntime
  yieldToEventLoop?: () => Promise<void>
}

export interface MobileLocalRepositoryBridge {
  readonly capability: MobileLocalRepositoryBridgeCapability
  load(): Promise<SaveData>
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  /** Stable portable-bundle JSON, never a bare SaveData/save-patch document. */
  exportPortableBundleJson(): Promise<string>
  /** Validates/migrates the portable document, backs up the v2 file, and atomically replaces it. */
  importPortableBundleJson(text: string): Promise<SaveData>
  flush(): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  pump(): Promise<void>
  runtimeInfo(): RendererRuntimeInfo
  localSettings: {
    load(): Promise<DeviceLocalOverlay>
    update(patch: DeviceLocalOverlayPatch): Promise<DeviceLocalOverlay>
  }
  getProjection(): RendererProjection | null
  getStatus(): RendererRepositoryStatus
  getRecentEvents(): LocalRepositoryHostEvent[]
  onProjection(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): void
  onResync(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): void
  onCommandResult(listener: (result: CommandResult) => void): void
  onSyncStatus(listener: (status: RendererRepositoryStatus) => void): void
  requestResync(): void
}

export function webCryptoAvailable(): boolean {
  const cryptoObject = globalThis.crypto as Crypto | undefined
  return typeof cryptoObject?.getRandomValues === 'function'
}

export function randomUuid(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID()
  if (typeof cryptoObject?.getRandomValues !== 'function') throw new Error('Web Crypto getRandomValues is unavailable')
  const bytes = new Uint8Array(16)
  cryptoObject.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
    + hex.slice(16, 20) + '-' + hex.slice(20)
}

export function randomSeedHex(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined
  if (typeof cryptoObject?.getRandomValues !== 'function') throw new Error('Web Crypto getRandomValues is unavailable')
  const bytes = new Uint8Array(16)
  cryptoObject.getRandomValues(bytes)
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

export function defaultMobileTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
}

export const mobileTimerRuntime: LocalRepositoryHostTimerRuntime = {
  start(tick, intervalMs) {
    return globalThis.setInterval(tick, intervalMs)
  },
  clear(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>)
  },
}

export interface MobileLocalRepositoryCapabilityResult {
  enabled: boolean
  canActivate: boolean
  serverMode: false
  reason?: string
}

export function mobileLocalRepositoryCapability(
  options: Pick<MobileLocalRepositoryBridgeOptions, 'storage' | 'devRuntimeFlag' | 'rendererCapability'>,
): MobileLocalRepositoryCapabilityResult {
  const result = localRepositoryHostCapability({
    devRuntimeFlag: options.devRuntimeFlag,
    rendererCapability: options.rendererCapability ?? false,
    storage: options.storage.capability,
  })
  return {
    enabled: result.enabled,
    canActivate: result.canActivate,
    serverMode: false,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  }
}

export function createMobileLocalRepositoryBridge(
  options: MobileLocalRepositoryBridgeOptions,
): MobileLocalRepositoryBridge {
  const capability = mobileLocalRepositoryCapability(options)
  if (capability.canActivate === false) {
    throw new Error('local runtime v2 unavailable: ' + (capability.reason ?? 'capability_missing'))
  }
  const projectionListeners: ((projection: RendererProjection, events: OrderedEvent[]) => void)[] = []
  const resyncListeners: ((projection: RendererProjection, events: OrderedEvent[]) => void)[] = []
  const resultListeners: ((result: CommandResult) => void)[] = []
  const statusListeners: ((status: RendererRepositoryStatus) => void)[] = []
  let cursor: ProjectionCursor | null = null
  const toRenderer = (projection: LocalRepositoryHostProjection): RendererProjection => {
    const base = createRendererProjection({
      save: projection.save,
      shared: projection.shared,
      device: projection.device,
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      gameTimeMs: projection.gameTimeMs,
      timeZone: projection.timeZone,
      advanceWhileEmpty: projection.advanceWhileEmpty,
      authority: projection.authority,
    })
    return { ...base, status: createRendererStatus(projection.status, base) }
  }
  const repository: LocalRepositoryHost = createLocalRepositoryHost({
    storage: options.storage,
    nowMs: options.nowMs ?? (() => Date.now()),
    randomUUID: options.randomUUID ?? randomUuid,
    randomSeedHex: options.randomSeedHex ?? randomSeedHex,
    ...(options.seedHex === undefined ? {} : { seedHex: options.seedHex }),
    timeZone: options.timeZone ?? defaultMobileTimeZone(),
    ...(options.localDeviceId === undefined ? {} : { localDeviceId: options.localDeviceId }),
    ...(options.appInstanceId === undefined ? {} : { appInstanceId: options.appInstanceId }),
    ...(options.advanceWhileEmpty === undefined ? {} : { advanceWhileEmpty: options.advanceWhileEmpty }),
    ...(options.initialSave === undefined ? {} : { initialSave: options.initialSave }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.maxChunkTicks === undefined ? {} : { maxChunkTicks: options.maxChunkTicks }),
    autoScheduler: options.autoScheduler ?? true,
    timer: options.timer ?? mobileTimerRuntime,
    yieldToEventLoop: options.yieldToEventLoop ?? (() => new Promise<void>(resolve => {
      globalThis.setTimeout(resolve, 0)
    })),
    onProjection: (projection, events) => {
      const renderer = toRenderer(projection)
      const delivery = classifyProjectionDelivery(cursor, renderer, events)
      if (delivery.kind === 'stale') return
      cursor = {
        revision: renderer.revision,
        eventSeq: renderer.eventSeq,
        owner: renderer.authority.owner,
        authorityId: renderer.authority.authorityId,
        authorityEpoch: renderer.authority.epoch,
        restoreGeneration: renderer.authority.restoreGeneration,
      }
      if (delivery.kind === 'resync') {
        for (const listener of resyncListeners) listener(renderer, events)
        return
      }
      for (const listener of projectionListeners) listener(renderer, events)
    },
    onCommandResult: result => {
      for (const listener of resultListeners) listener(result)
    },
    onStatus: status => {
      const current = repository.getProjection()
      const renderer = current === null ? null : toRenderer(current)
      const publicStatus = createRendererStatus(status, renderer)
      for (const listener of statusListeners) listener(publicStatus)
    },
  }, {
    devRuntimeFlag: options.devRuntimeFlag,
    rendererCapability: options.rendererCapability ?? false,
    storage: options.storage.capability,
  })

  let starting: Promise<void> | null = null
  const start = (): Promise<void> => {
    if (starting === null) {
      starting = repository.start().then(projection => {
        if (projection === null || repository.getStatus().state !== 'ready') {
          throw new Error(repository.getStatus().error ?? 'local runtime v2 failed to start')
        }
      })
    }
    return starting
  }
  const requireProjection = (): LocalRepositoryHostProjection => {
    const projection = repository.getProjection()
    if (projection === null) throw new Error(repository.getStatus().error ?? 'local runtime v2 projection is unavailable')
    return projection
  }
  return {
    capability: {
      enabled: true,
      serverMode: false,
      storageKind: options.storage.capability.kind,
      atomicDocument: true,
      backup: true,
    },
    async load() {
      await start()
      return JSON.parse(JSON.stringify(requireProjection().save)) as SaveData
    },
    async command(command, commandOptions = {}) {
      await start()
      return repository.command(command, {
        ...(commandOptions.opId === undefined ? {} : { opId: commandOptions.opId }),
      })
    },
    async setAdvanceWhileEmpty(enabled) {
      await start()
      await repository.setAdvanceWhileEmpty(enabled)
    },
    async exportPortableBundleJson() {
      await start()
      const text = repository.exportPortableBundleJson()
      if (text === null) throw new Error('local runtime v2 portable export is unavailable')
      return text
    },
    async importPortableBundleJson(text) {
      await start()
      await repository.importPortableBundle(text)
      return JSON.parse(JSON.stringify(requireProjection().save)) as SaveData
    },
    async flush() {
      await repository.flush()
    },
    async suspend() {
      if (starting !== null) await repository.suspend()
    },
    async resume() {
      if (starting !== null) await repository.resume()
    },
    async stop() {
      await repository.stop()
    },
    async pump() {
      await repository.pump()
    },
    runtimeInfo() {
      return { localRepositoryV2: true, serverMode: false }
    },
    localSettings: {
      async load() {
        await start()
        const projection = requireProjection()
        return JSON.parse(JSON.stringify(projection.device)) as DeviceLocalOverlay
      },
      async update(patch) {
        await start()
        const projection = await repository.updateDeviceOverlay(patch)
        if (projection === null) throw new Error('local settings update did not produce a projection')
        return JSON.parse(JSON.stringify(projection.device)) as DeviceLocalOverlay
      },
    },
    getProjection() {
      const projection = repository.getProjection()
      return projection === null ? null : toRenderer(projection)
    },
    getStatus() {
      const projection = repository.getProjection()
      return createRendererStatus(repository.getStatus(), projection === null ? null : toRenderer(projection))
    },
    getRecentEvents: () => repository.getRecentEvents(),
    onProjection(listener) { projectionListeners.length = 0; projectionListeners.push(listener) },
    onResync(listener) { resyncListeners.length = 0; resyncListeners.push(listener) },
    onCommandResult(listener) { resultListeners.length = 0; resultListeners.push(listener) },
    onSyncStatus(listener) { statusListeners.length = 0; statusListeners.push(listener) },
    requestResync() {
      const current = repository.getProjection()
      if (current === null) return
      const renderer = toRenderer(current)
      for (const listener of resyncListeners) listener(renderer, [])
    },
  }
}
