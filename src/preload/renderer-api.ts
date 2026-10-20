import { IPC } from '../shared/ipc'
import type {
  CommandKey,
  CommandResult,
  PetCommand,
} from '../shared/sync/protocol'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import type {
  OrderedProjectionDelivery,
  RendererProjection,
  RendererRepositoryStatus,
  RendererRuntimeInfo,
} from '../shared/renderer-api'
import type { DeviceLocalOverlay, DeviceLocalOverlayPatch } from '../shared/sync/data-boundary'

type Listener<T extends unknown[]> = (...args: T) => void

/** The narrow Electron IPC surface used by the renderer runtime preload. */
export interface ElectronIpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeAllListeners(channel: string): unknown
}

export interface RendererRuntimePreloadSurface {
  runtimeInfo(): Promise<RendererRuntimeInfo>
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  localSettings: {
    load(): Promise<DeviceLocalOverlay>
    update(patch: DeviceLocalOverlayPatch): Promise<DeviceLocalOverlay>
  }
  flush(): Promise<void>
  getProjection(): Promise<RendererProjection | null>
  getStatus(): Promise<RendererRepositoryStatus>
  onProjection(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): void
  onCommandResult(listener: (result: CommandResult) => void): void
  onSyncStatus(listener: (status: RendererRepositoryStatus) => void): void
  onResync(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): void
}

function replaceListener<T extends unknown[]>(
  ipc: ElectronIpcLike,
  channel: string,
  listener: Listener<T>,
): void {
  ipc.removeAllListeners(channel)
  ipc.on(channel, (_event, ...args) => listener(...args as T))
}

/**
 * The unified command/projection surface shared by the Electron preload and
 * (structurally) mobile bridges. Channels are fixed here so tests and all hosts
 * agree on one renderer contract.
 */
export function createRendererRuntimePreload(ipc: ElectronIpcLike): RendererRuntimePreloadSurface {
  return {
    runtimeInfo: () => ipc.invoke(IPC.runtimeInfo) as Promise<RendererRuntimeInfo>,
    command: <K extends CommandKey>(
      command: Extract<PetCommand, { type: K }>,
      options?: { opId?: string },
    ) => ipc.invoke(IPC.command, command, options) as Promise<CommandResult<K>>,
    setAdvanceWhileEmpty: (enabled) => ipc.invoke(IPC.setAdvanceWhileEmpty, enabled) as Promise<void>,
    localSettings: {
      load: () => ipc.invoke(IPC.localSettingsLoad) as Promise<DeviceLocalOverlay>,
      update: (patch) => ipc.invoke(IPC.localSettingsUpdate, patch) as Promise<DeviceLocalOverlay>,
    },
    flush: () => ipc.invoke(IPC.flush) as Promise<void>,
    getProjection: () => ipc.invoke(IPC.getProjection) as Promise<RendererProjection | null>,
    getStatus: () => ipc.invoke(IPC.getStatus) as Promise<RendererRepositoryStatus>,
    onProjection: (listener) => replaceListener<[RendererProjection, OrderedEvent[]]>(
      ipc, IPC.projection, listener,
    ),
    onCommandResult: (listener) => replaceListener<[CommandResult]>(ipc, IPC.commandResult, listener),
    onSyncStatus: (listener) => replaceListener<[RendererRepositoryStatus]>(ipc, IPC.syncStatus, listener),
    onResync: (listener) => replaceListener<[RendererProjection, OrderedEvent[]]>(ipc, IPC.resync, listener),
  }
}

export type ProjectionDeliveryListener = (delivery: OrderedProjectionDelivery) => void
