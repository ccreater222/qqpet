import { ipcMain } from 'electron'
import { IPC, type DesktopRemoteStatus } from '../shared/ipc'
import type { DesktopStorageController } from './storage-controller'

function unavailable(reason: string): never {
  throw new Error('storage_unavailable: ' + reason)
}

function remoteStatusOf(controller: DesktopStorageController): DesktopRemoteStatus {
  const status = controller.getStatus()
  const storage = controller.status()
  return {
    ...status,
    enabled: true,
    serverMode: true,
    ...(storage.serverUrl === undefined ? {} : { serverUrl: storage.serverUrl }),
    ...(storage.petId === undefined ? {} : { petId: storage.petId }),
    ...(storage.deviceId === undefined ? {} : { deviceId: storage.deviceId }),
  }
}

/** C11 storage/admin IPC surface. A null controller fails closed on legacy startup. */
export function installStorageIpc(controller: DesktopStorageController | null): void {
  ipcMain.handle(IPC.storageStatus, () => controller === null ? unavailable('local runtime v2 is not active') : controller.status())
  ipcMain.handle(IPC.storageSetMode, (_event, input: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.setMode(input))
  ipcMain.handle(IPC.storagePair, (_event, input: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.pair(input))
  ipcMain.handle(IPC.storageUnpair, () => controller === null ? unavailable('local runtime v2 is not active') : controller.unpair())
  ipcMain.handle(IPC.storageDeviceList, () => controller === null ? unavailable('local runtime v2 is not active') : controller.listDevices())
  ipcMain.handle(IPC.storageDeviceRevoke, (_event, deviceId: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.revokeDevice(deviceId))
  ipcMain.handle(IPC.storageSetTimeZone, (_event, timeZone: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.setTimeZone(timeZone))
  ipcMain.handle(IPC.storageSetWeatherCity, (_event, city: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.setWeatherCity(city))
  ipcMain.handle(IPC.storageExportBundle, () => controller === null ? unavailable('local runtime v2 is not active') : controller.exportBundle())
  ipcMain.handle(IPC.storageImportBundle, (_event, input: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.importBundle(input))
  ipcMain.handle(IPC.storageRetryHandoff, () => controller === null ? unavailable('local runtime v2 is not active') : controller.retryHandoff())
  ipcMain.handle(IPC.storageRollbackHandoff, () => controller === null ? unavailable('local runtime v2 is not active') : controller.rollbackHandoff())
  ipcMain.handle(IPC.storageCreateBackup, () => controller === null ? unavailable('local runtime v2 is not active') : controller.createBackup())

  // C10 compatibility surface: same controller, same pairing/status state.
  ipcMain.handle(IPC.remoteStatus, (): DesktopRemoteStatus => {
    if (controller === null) {
      return {
        enabled: false,
        reason: 'local runtime v2 is not active',
        mode: 'server',
        connection: 'offline',
        serverMode: false,
        revision: 0,
        eventSeq: 0,
        gameTimeMs: 0,
        timeZone: 'UTC',
        advanceWhileEmpty: true,
        authority: { owner: 'server', authorityId: '', restoreGeneration: 0, epoch: 0, state: 'archived' },
        readOnly: true,
        role: 'player',
      }
    }
    return remoteStatusOf(controller)
  })
  ipcMain.handle(IPC.remotePair, (_event, input: unknown) => controller === null ? unavailable('local runtime v2 is not active') : controller.pair(input))
  ipcMain.handle(IPC.remoteRevoke, () => controller === null ? unavailable('local runtime v2 is not active') : controller.unpair())
}
