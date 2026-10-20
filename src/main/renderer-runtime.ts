import { ipcMain, type BrowserWindow } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { SaveData, SavePatch } from '../shared/save'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import {
  classifyProjectionDelivery,
  createRendererProjection,
  createRendererStatus,
  legacyRendererStatus,
  rejectedCommandResult,
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
import {
  createLocalRepository,
  type LocalPetProjection,
  type LocalRepository,
} from './local-repository'
import { desktopRendererRuntimeCapability } from './renderer-runtime-flags'
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
 * the explicit C6 assertion: the capability check requires both runtime env
 * flags plus a renderer-capable host, so legacy startup never reaches here.
 */
export class DesktopRendererRuntime {
  readonly repository: LocalRepository
  private readonly documentPath: string
  private readonly legacySavePath: string
  private window: BrowserWindow | null = null
  private currentProjection: RendererProjection | null = null
  private cursor: ProjectionCursor | null = null
  private readonly viewListeners = new Set<(save: SaveData) => void>()

  constructor(options: DesktopRendererRuntimeOptions) {
    const env = options.env ?? process.env
    const capability = desktopRendererRuntimeCapability(env)
    if (capability.canActivate === false) {
      throw new Error('desktop renderer runtime v2 unavailable: ' + (capability.reason ?? 'capability_missing'))
    }
    this.documentPath = join(options.userDataPath, 'save.v2.json')
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

  attachWindow(window: BrowserWindow): void {
    this.window = window
    window.on('closed', () => { this.window = null })
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
    await this.repository.importPortableBundle(text)
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
    return this.repository.getRecentEvents()
      .filter(event => event.eventSeq > after)
      .map(event => ({
        eventSeq: event.eventSeq,
        revision: projection.revision,
        gameTimeMs: projection.gameTimeMs,
        type: event.type,
        payload: event.payload,
      }))
  }

  private onRepositoryProjection(projection: LocalPetProjection): void {
    const next = this.toProjection(projection)
    const events = this.deltaEvents(projection)
    const delivery = classifyProjectionDelivery(this.cursor, next, events)
    if (delivery.kind === 'stale') return
    this.acceptProjection(projection)
    const channel = delivery.kind === 'resync' ? IPC.resync : IPC.projection
    this.send(channel, next, events)
  }

  private onRepositoryStatus(status: Parameters<typeof createRendererStatus>[0]): void {
    const projection = this.repository.getProjection()
    const current = projection === null ? this.currentProjection : this.toProjection(projection)
    this.send(IPC.syncStatus, createRendererStatus(status, current))
  }

  private send(channel: string, ...payload: unknown[]): void {
    if (this.window === null || this.window.isDestroyed()) return
    this.window.webContents.send(channel, ...payload)
  }
}

/** Registers the unified renderer IPC handlers, including fail-closed legacy stubs. */
export function installRendererRuntimeIpc(runtime: DesktopRendererRuntime | null): void {
  ipcMain.handle(IPC.runtimeInfo, () => runtime?.info() ?? {
    localRepositoryV2: false,
    serverMode: false,
    reason: 'local_runtime_v2_disabled',
  } satisfies RendererRuntimeInfo)
  ipcMain.handle(IPC.command, (_event, command: PetCommand, options?: { opId?: string }) => {
    if (runtime === null) return rejectedCommandResult(command, options?.opId ?? randomUUID())
    return runtime.command(command, options)
  })
  ipcMain.handle(IPC.setAdvanceWhileEmpty, async (_event, enabled: boolean) => {
    if (runtime === null) throw new Error('local runtime v2 is not active')
    await runtime.setAdvanceWhileEmpty(enabled)
  })
  ipcMain.handle(IPC.localSettingsLoad, () => {
    if (runtime === null) throw new Error('local runtime v2 is not active')
    return runtime.loadLocalSettings()
  })
  ipcMain.handle(IPC.localSettingsUpdate, async (_event, patch: unknown) => {
    if (runtime === null) throw new Error('local runtime v2 is not active')
    return runtime.updateLocalSettings(patch)
  })
  ipcMain.handle(IPC.flush, async () => {
    if (runtime !== null) return runtime.flush()
    flushSave()
  })
  ipcMain.handle(IPC.getProjection, () => runtime?.getProjection() ?? null)
  ipcMain.handle(IPC.getStatus, () => runtime?.getStatus() ?? legacyRendererStatus())
}
