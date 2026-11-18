import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, type DesktopRemoteStatus } from '../shared/ipc'
import {
  type DesktopStorageController,
  validateStorageDeviceId,
  validateStorageImportDialogOptions,
  validateStorageImportInput,
  validateStoragePairInput,
  validateStorageSetModeInput,
  validateStorageTimeZone,
  validateStorageWeatherCity,
} from './storage-controller'

function unavailable(reason: string): never {
  throw new Error('storage_unavailable: ' + reason)
}

/**
 * Every storage/admin handler must originate from the trusted BrowserWindow's
 * main frame. Comparing the WebContents alone would still allow an in-window
 * subframe to drive owner-only authority changes.
 */
export function assertTrustedStorageIpcSender(
  controller: DesktopStorageController,
  event: IpcMainInvokeEvent,
): void {
  if (controller.acceptsSenderFrame(event.sender, event.senderFrame) === false) {
    throw new Error('unauthorized: unknown renderer')
  }
}

function trustedController(
  controller: DesktopStorageController | null,
  event: IpcMainInvokeEvent,
): DesktopStorageController {
  if (controller === null) unavailable('local runtime v2 is not active')
  assertTrustedStorageIpcSender(controller, event)
  return controller
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

export { validateStorageImportDialogOptions }

/** C11 storage/admin IPC surface. A null controller fails closed on legacy startup. */
export function installStorageIpc(controller: DesktopStorageController | null): void {
  ipcMain.handle(IPC.storageStatus, (event) => trustedController(controller, event).status())
  ipcMain.handle(IPC.storageSetMode, (event, input: unknown) => {
    const target = trustedController(controller, event)
    return target.setMode(validateStorageSetModeInput(input))
  })
  ipcMain.handle(IPC.storagePair, (event, input: unknown) => {
    const target = trustedController(controller, event)
    return target.pair(validateStoragePairInput(input))
  })
  ipcMain.handle(IPC.storageUnpair, (event) => trustedController(controller, event).unpair())
  ipcMain.handle(IPC.storageDeviceList, (event) => trustedController(controller, event).listDevices())
  ipcMain.handle(IPC.storageDeviceRevoke, (event, deviceId: unknown) => {
    const target = trustedController(controller, event)
    return target.revokeDevice(validateStorageDeviceId(deviceId))
  })
  ipcMain.handle(IPC.storageSetTimeZone, (event, timeZone: unknown) => {
    const target = trustedController(controller, event)
    return target.setTimeZone(validateStorageTimeZone(timeZone))
  })
  ipcMain.handle(IPC.storageSetWeatherCity, (event, city: unknown) => {
    const target = trustedController(controller, event)
    return target.setWeatherCity(validateStorageWeatherCity(city))
  })
  ipcMain.handle(IPC.storageExportBundle, (event) => trustedController(controller, event).exportBundle())
  ipcMain.handle(IPC.storageImportBundle, (event, input: unknown) => {
    const target = trustedController(controller, event)
    return target.importBundle(validateStorageImportInput(input))
  })
  ipcMain.handle(IPC.storageRetryHandoff, (event) => trustedController(controller, event).retryHandoff())
  ipcMain.handle(IPC.storageRollbackHandoff, (event) => trustedController(controller, event).rollbackHandoff())
  ipcMain.handle(IPC.storageCreateBackup, (event) => trustedController(controller, event).createBackup())

  // C10 compatibility surface: same controller, same pairing/status state.
  ipcMain.handle(IPC.remoteStatus, (event): DesktopRemoteStatus => {
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
    assertTrustedStorageIpcSender(controller, event)
    return remoteStatusOf(controller)
  })
  ipcMain.handle(IPC.remotePair, (event, input: unknown) => {
    const target = trustedController(controller, event)
    return target.pair(validateStoragePairInput(input))
  })
  ipcMain.handle(IPC.remoteRevoke, (event) => trustedController(controller, event).unpair())
}
