import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { SaveData, SavePatch } from '../shared/save'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import {
  assertBooleanIpcInput,
  assertCommandIpcInput,
  classifyProjectionDelivery,
  createRendererProjection,
  createRendererStatus,
  legacyRendererStatus,
  orderedEventsFromHistory,
  rejectedCommandResult,
  requirePortableImportProjection,
  toCommandResult,
  type ProjectionCursor,
  type RendererProjection,
  type RendererRepositoryStatus,
  type RendererRuntimeInfo,
} from '../shared/renderer-api'
import {
  CanonicalMutationBlockedError,
  classifySavePatch,
} from '../shared/renderer-projection'
import {
  sanitizeDeviceLocalOverlayPatch,
  type DeviceLocalOverlay,
  type DeviceLocalOverlayPatch,
} from '../shared/sync/data-boundary'
import type { CommandKey, CommandResult, PetCommand } from '../shared/sync/protocol'
import type { PortablePetBundleV1 } from '../shared/sync/portable'
import type { StorageBackupStatus, StorageMigrationStatus } from '../shared/storage'
import {
  createLocalRepository,
  readLocalDeviceOverlayPreview,
  type LocalPetProjection,
  type LocalRepository,
} from './local-repository'
import { desktopRendererRuntimeCapability, LOCAL_V2_DOCUMENT_NAME } from './renderer-runtime-flags'
import { flushSave, setSaveView } from './save'

export interface DesktopRendererRuntimeOptions {
  env?: NodeJS.ProcessEnv
  userDataPath: string
  timeZone?: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasLocalPatch(patch: DeviceLocalOverlayPatch): boolean {
  return Object.keys(patch.petInfo ?? {}).length > 0
    || Object.keys(patch.settings ?? {}).length > 0
    || Object.keys(patch.presentation ?? {}).length > 0
}

/**
 * Desktop host adapter for the C6 renderer contract. Constructing it is already
 * the explicit assertion that local v2 is the selected authority; rollback and
 * the QQPET_LOCAL_REPOSITORY_V2=0 disable switch keep legacy startup away.
 */
export class DesktopRendererRuntime {
  readonly repository: LocalRepository
  private readonly documentPath: string
  private readonly legacySavePath: string
  private window: BrowserWindow | null = null
  private currentProjection: RendererProjection | null = null
  private sendEnabled = true
  private cursor: ProjectionCursor | null = null
  private readonly viewListeners = new Set<(save: SaveData) => void>()

  constructor(options: DesktopRendererRuntimeOptions) {
    const env = options.env ?? process.env
    const capability = desktopRendererRuntimeCapability(env)
    if (capability.canActivate === false) {
      throw new Error('desktop renderer runtime v2 unavailable: ' + (capability.reason ?? 'capability_missing'))
    }
    this.documentPath = join(options.userDataPath, LOCAL_V2_DOCUMENT_NAME)
    this.legacySavePath = join(options.userDataPath, 'save.json')
    this.repository = createLocalRepository({
      documentPath: this.documentPath,
      legacySavePath: this.legacySavePath,
      legacyBackupPath: this.legacySavePath + '.bak',
      documentBackupPath: this.documentPath + '.bak',
      rollbackSnapshotPath: this.documentPath + '.rollback',
      seedHex: randomBytes(16).toString('hex'),
      timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai',
      autoScheduler: true,
      onProjection: projection => this.onRepositoryProjection(projection),
      onStatus: status => this.onRepositoryStatus(status),
    }, {
      authorityState: 'local-v2-active',
      rendererCapability: true,
      env,
    })
  }

  info(): RendererRuntimeInfo {
    return { localRepositoryV2: true, serverMode: false }
  }

  async start(): Promise<SaveData> {
    const projection = await this.repository.start()
    if (projection === null) {
      throw new Error(this.repository.getStatus().error ?? 'local runtime v2 failed to start')
    }
    if (this.currentProjection === null) this.acceptProjection(projection)
    return clone(this.requireProjection().save)
  }

  /** Synchronous device-local overlay for the pre-load window/header setup. */
  previewDeviceOverlay(): DeviceLocalOverlay | null {
    return readLocalDeviceOverlayPreview({
      documentPath: this.documentPath,
      legacySavePath: this.legacySavePath,
    })
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window
    window.on('closed', () => { this.window = null })
  }

  acceptsSender(sender: unknown): boolean {
    return this.window !== null && sender === this.window.webContents
  }

  onView(listener: (save: SaveData) => void): () => void {
    this.viewListeners.add(listener)
    return () => this.viewListeners.delete(listener)
  }

  async load(): Promise<SaveData> {
    if (this.currentProjection === null) await this.start()
    return clone(this.requireProjection().save)
  }

  getProjection(): RendererProjection | null {
    return this.currentProjection === null ? null : clone(this.currentProjection)
  }

  getStatus(): RendererRepositoryStatus {
    return createRendererStatus(this.repository.getStatus(), this.currentProjection)
  }

  /** Forces a full snapshot through the resync channel after a renderer gap. */
  requestResync(): void {
    if (this.currentProjection === null) return
    this.send(IPC.resync, clone(this.currentProjection), [])
  }

  /** Replays the exact current status after a renderer subscribes or reloads. */
  replayStatus(): void {
    this.send(IPC.syncStatus, this.getStatus())
  }

  /**
   * C11 mode fencing: while server mode owns canonical state the local runtime
   * must not push projections, command results or status into the renderer.
   */
  setSendEnabled(enabled: boolean): void {
    this.sendEnabled = enabled
  }

  async loadFenced(): Promise<SaveData> {
    const projection = await this.repository.loadFenced()
    if (projection === null) {
      throw new Error(this.repository.getStatus().error ?? 'local runtime v2 could not be loaded for fencing')
    }
    if (this.currentProjection === null) this.acceptProjection(projection)
    return clone(this.requireProjection().save)
  }

  async archiveAuthority(reason: 'use_server' | 'mode_switch' = 'use_server'): Promise<void> {
    const projection = await this.repository.archiveAuthority(reason)
    if (projection === null) throw new Error('local authority could not be archived')
  }

  exportForDetach(incomingEpoch: number): Promise<PortablePetBundleV1> {
    return this.repository.exportForDetach(incomingEpoch)
  }

  rollbackDetach(): Promise<unknown> {
    return this.repository.rollbackDetach()
  }

  importPortableBundle(bundle: PortablePetBundleV1 | string, options: Parameters<LocalRepository['importPortableBundle']>[1] = {}): ReturnType<LocalRepository['importPortableBundle']> {
    return this.repository.importPortableBundle(bundle, options)
  }

  createBackup(reason: 'import' | 'manual' | 'mode_switch'): string | null {
    return this.repository.createBackup(reason)
  }

  getMigrationStatus(): StorageMigrationStatus {
    return this.repository.getMigrationStatus()
  }

  getBackupStatus(): StorageBackupStatus {
    return this.repository.getBackupStatus()
  }

  exportPortableBundle(): PortablePetBundleV1 | null {
    return this.repository.exportPortableBundle()
  }

  getLocalStatus(): RendererRepositoryStatus {
    return createRendererStatus(this.repository.getStatus(), this.currentProjection)
  }

  getDeviceOverlay(): DeviceLocalOverlay | null {
    return this.repository.getDeviceOverlay()
  }

  getWeatherCity(): string {
    return this.repository.getDocument()?.bundle.engine.weatherLocation ?? ''
  }

  loadLocalSettings(): DeviceLocalOverlay {
    const overlay = this.currentProjection?.device ?? this.repository.getDeviceOverlay()
    if (overlay === null) throw new Error('local settings are unavailable before the runtime loads')
    return clone(overlay)
  }

  async updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay> {
    const patch = sanitizeDeviceLocalOverlayPatch(value)
    const projection = await this.repository.updateDeviceOverlay(patch)
    if (projection === null || projection.device === undefined) throw new Error('local settings update did not produce a projection')
    return clone(projection.device)
  }

  async command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options: { opId?: string } = {},
  ): Promise<CommandResult<K>> {
    const opId = options.opId ?? randomUUID()
    const result = await this.repository.command(command as PetCommand, opId)
    const projection = result.projection
    const document = this.repository.getDocument()
    const records = document?.idempotency?.records ?? []
    const recordIndex = records.findIndex(record => record.opId === opId)
    const commandResult = toCommandResult({
      command,
      opId,
      commandSeq: recordIndex + 1,
      revision: projection?.revision ?? 0,
      eventSeq: projection?.eventSeq ?? 0,
      outcome: result.outcome,
      duplicate: result.duplicate,
    })
    this.send(IPC.commandResult, commandResult)
    return commandResult
  }

  async setAdvanceWhileEmpty(enabled: boolean): Promise<void> {
    await this.repository.setAdvanceWhileEmpty(enabled)
  }

  async savePatch(patch: SavePatch): Promise<void> {
    const classification = classifySavePatch(patch)
    if (classification.canonicalKeys.length > 0) {
      throw new CanonicalMutationBlockedError(classification.canonicalKeys)
    }
    const localPatch: DeviceLocalOverlayPatch = {
      ...(Object.keys(classification.localPetInfo).length === 0 ? {} : { petInfo: classification.localPetInfo }),
      ...(Object.keys(classification.localSettings).length === 0 ? {} : { settings: classification.localSettings }),
      ...(Object.keys(classification.presentation).length === 0 ? {} : { presentation: classification.presentation }),
    }
    if (hasLocalPatch(localPatch) === false) return
    await this.repository.updateDeviceOverlay(localPatch)
  }

  async flush(): Promise<void> {
    await this.repository.flush()
  }

  async stop(): Promise<void> {
    await this.repository.flush()
    await this.repository.stop()
  }

  async exportPortableBundleJson(): Promise<string> {
    await this.repository.flush()
    const bundle = this.repository.exportPortableBundle()
    if (bundle === null) throw new Error('portable bundle is unavailable')
    return JSON.stringify(bundle)
  }

  async importPortableBundleJson(text: string): Promise<void> {
    requirePortableImportProjection(
      await this.repository.importPortableBundle(text),
      this.repository.getStatus().error,
    )
  }

  async reset(): Promise<void> {
    const result = await this.repository.reset()
    if (result.outcome.ok === false) throw new Error(result.outcome.error.message)
  }

  private requireProjection(): RendererProjection {
    if (this.currentProjection === null) throw new Error('renderer projection is unavailable')
    return this.currentProjection
  }

  private toProjection(projection: LocalPetProjection): RendererProjection {
    return createRendererProjection({
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
  }

  private acceptProjection(projection: LocalPetProjection): RendererProjection {
    const next = this.toProjection(projection)
    this.currentProjection = next
    this.cursor = {
      revision: next.revision,
      eventSeq: next.eventSeq,
      owner: next.authority.owner,
      authorityId: next.authority.authorityId,
      authorityEpoch: next.authority.epoch,
      restoreGeneration: next.authority.restoreGeneration,
    }
    setSaveView(next.save)
    for (const listener of this.viewListeners) listener(next.save)
    return next
  }

  private deltaEvents(projection: LocalPetProjection): OrderedEvent[] {
    const after = this.cursor?.eventSeq ?? 0
    return orderedEventsFromHistory(
      this.repository.getRecentEvents().filter(event => event.eventSeq > after),
      { revision: projection.revision, gameTimeMs: projection.gameTimeMs },
    )
  }

  private onRepositoryProjection(projection: LocalPetProjection): void {
    if (this.sendEnabled === false) return
    const next = this.toProjection(projection)
    const events = this.deltaEvents(projection)
    const delivery = classifyProjectionDelivery(this.cursor, next, events)
    if (delivery.kind === 'stale') return
    this.acceptProjection(projection)
    const channel = delivery.kind === 'resync' ? IPC.resync : IPC.projection
    this.send(channel, next, events)
  }

  private onRepositoryStatus(status: Parameters<typeof createRendererStatus>[0]): void {
    if (this.sendEnabled === false) return
    const projection = this.repository.getProjection()
    const current = projection === null ? this.currentProjection : this.toProjection(projection)
    this.send(IPC.syncStatus, createRendererStatus(status, current))
  }

  private send(channel: string, ...payload: unknown[]): void {
    if (this.sendEnabled === false) return
    if (this.window === null || this.window.isDestroyed()) return
    this.window.webContents.send(channel, ...payload)
  }
}

/** The narrow runtime host surface the unified renderer IPC needs; server mode can supply its own. */
export interface RendererRuntimeHost {
  info(): RendererRuntimeInfo
  acceptsSender(sender: unknown): boolean
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<unknown>
  loadLocalSettings(): DeviceLocalOverlay | Promise<DeviceLocalOverlay>
  updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay>
  flush(): Promise<void>
  getProjection(): RendererProjection | null
  getStatus(): RendererRepositoryStatus
  requestResync(): void
  replayStatus?(): void
}

/** Registers the unified renderer IPC handlers, including fail-closed legacy stubs. */
export function installRendererRuntimeIpc(runtime: RendererRuntimeHost | null): void {
  const requireTrustedSender = (event: IpcMainInvokeEvent): void => {
    if (runtime !== null && runtime.acceptsSender(event.sender) === false) {
      throw new Error('unauthorized: unknown renderer')
    }
  }
  ipcMain.handle(IPC.runtimeInfo, (event) => {
    requireTrustedSender(event)
    return runtime?.info() ?? {
      localRepositoryV2: false,
      serverMode: false,
      reason: 'local_runtime_v2_disabled',
    } satisfies RendererRuntimeInfo
  })
  ipcMain.handle(IPC.command, (event, command: unknown, options?: unknown) => {
    requireTrustedSender(event)
    assertCommandIpcInput(command, options)
    const typedOptions = options as { opId?: string } | undefined
    if (runtime === null) return rejectedCommandResult(command, typedOptions?.opId ?? randomUUID())
    return runtime.command(command, typedOptions)
  })
  ipcMain.handle(IPC.setAdvanceWhileEmpty, async (event, enabled: unknown) => {
    requireTrustedSender(event)
    assertBooleanIpcInput(enabled, 'advanceWhileEmpty')
    if (runtime === null) throw new Error('local runtime v2 is not active')
    await runtime.setAdvanceWhileEmpty(enabled)
  })
  ipcMain.handle(IPC.localSettingsLoad, (event) => {
    requireTrustedSender(event)
    if (runtime === null) throw new Error('local runtime v2 is not active')
    return runtime.loadLocalSettings()
  })
  ipcMain.handle(IPC.localSettingsUpdate, async (event, patch: unknown) => {
    requireTrustedSender(event)
    if (runtime === null) throw new Error('local runtime v2 is not active')
    return runtime.updateLocalSettings(patch)
  })
  ipcMain.handle(IPC.flush, async (event) => {
    requireTrustedSender(event)
    if (runtime !== null) return runtime.flush()
    flushSave()
  })
  ipcMain.handle(IPC.getProjection, (event) => {
    requireTrustedSender(event)
    return runtime?.getProjection() ?? null
  })
  ipcMain.handle(IPC.getStatus, (event) => {
    requireTrustedSender(event)
    return runtime?.getStatus() ?? legacyRendererStatus()
  })
  ipcMain.handle(IPC.requestResync, (event) => {
    requireTrustedSender(event)
    if (runtime === null) return
    runtime.requestResync()
    runtime.replayStatus?.()
  })
}
