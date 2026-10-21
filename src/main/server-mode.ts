import { app, ipcMain, safeStorage } from 'electron'
import { IPC, type DesktopRemoteStatus, type RemotePairingInput } from '../shared/ipc'
import type { WireAuthority } from '../shared/sync/protocol'
import { PairingStore, type SafeStorageLike } from './pairing-store'
import { RemoteRepository, type RemoteTransport } from './remote-repository'
import { createWebSocketTransport } from './remote-websocket-transport'
import { desktopServerModeCapability } from './renderer-runtime-flags'

const OFFLINE_AUTHORITY: WireAuthority = {
  owner: 'server',
  authorityId: '',
  restoreGeneration: 0,
  epoch: 0,
  state: 'archived',
}

function disabledStatus(reason: string): DesktopRemoteStatus {
  return {
    enabled: false,
    reason,
    mode: 'server',
    connection: 'offline',
    serverMode: false,
    revision: 0,
    eventSeq: 0,
    gameTimeMs: 0,
    timeZone: 'UTC',
    advanceWhileEmpty: true,
    authority: OFFLINE_AUTHORITY,
    readOnly: true,
    role: 'player',
  }
}

function idleStatus(): DesktopRemoteStatus {
  return {
    enabled: true,
    mode: 'server',
    connection: 'offline',
    serverMode: true,
    revision: 0,
    eventSeq: 0,
    gameTimeMs: 0,
    timeZone: 'UTC',
    advanceWhileEmpty: true,
    authority: OFFLINE_AUTHORITY,
    readOnly: true,
    role: 'player',
  }
}

function validatePairInput(value: unknown): RemotePairingInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_payload: pairing input must be an object')
  }
  const record = value as Record<string, unknown>
  const serverUrl = record.serverUrl
  const code = record.code
  const deviceLabel = record.deviceLabel
  if (typeof serverUrl !== 'string' || (serverUrl.startsWith('wss://') === false && serverUrl.startsWith('ws://') === false)) {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  if (typeof code !== 'string' || code.length === 0) throw new Error('invalid_payload: pairing code is required')
  if (typeof deviceLabel !== 'string' || deviceLabel.length === 0) throw new Error('invalid_payload: device label is required')
  return { serverUrl, code, deviceLabel }
}

export interface DesktopServerModeOptions {
  userDataPath: string
  env?: NodeJS.ProcessEnv
  platform?: string
  appVersion?: string
  safeStorage?: SafeStorageLike
  createTransport?: () => RemoteTransport
}

/**
 * Desktop-only server-mode controller for C10. It is created only when the
 * explicit QQPET_SERVER_MODE=1 flag is enabled and never reaches mobile builds.
 */
export class DesktopServerModeController {
  readonly capability: ReturnType<typeof desktopServerModeCapability>
  private readonly userDataPath: string
  private readonly appVersion: string
  private readonly secretStorage: SafeStorageLike
  private readonly createTransport: () => RemoteTransport
  private repository: RemoteRepository | null = null
  private store: PairingStore | null = null
  private serverUrl: string | undefined

  constructor(options: DesktopServerModeOptions) {
    this.capability = desktopServerModeCapability(options.env, options.platform)
    this.userDataPath = options.userDataPath
    this.appVersion = options.appVersion ?? app.getVersion()
    this.secretStorage = options.safeStorage ?? safeStorage
    this.createTransport = options.createTransport ?? (() => createWebSocketTransport())
  }

  get enabled(): boolean {
    return this.capability.canActivate
  }

  status(): DesktopRemoteStatus {
    if (this.capability.canActivate === false) {
      return disabledStatus(this.capability.reason ?? 'flag_disabled')
    }
    if (this.repository === null) {
      const base = idleStatus()
      return this.serverUrl === undefined ? base : { ...base, serverUrl: this.serverUrl }
    }
    const status = this.repository.getStatus()
    return {
      ...status,
      enabled: true,
      ...(this.serverUrl === undefined ? {} : { serverUrl: this.serverUrl }),
    }
  }

  async pair(input: unknown): Promise<DesktopRemoteStatus> {
    if (this.capability.canActivate === false) {
      throw new Error('server mode is disabled: ' + (this.capability.reason ?? 'flag_disabled'))
    }
    const pairing = validatePairInput(input)
    await this.revoke()
    const store = new PairingStore({
      userDataPath: this.userDataPath,
      safeStorage: this.secretStorage,
    })
    const repository = new RemoteRepository({
      serverUrl: pairing.serverUrl,
      appVersion: this.appVersion,
      tokenStore: store,
      transport: this.createTransport(),
      pair: { code: pairing.code, deviceLabel: pairing.deviceLabel },
    })
    this.store = store
    this.repository = repository
    this.serverUrl = pairing.serverUrl
    try {
      await repository.start()
    } catch (error) {
      this.repository = null
      this.store = null
      throw error
    }
    return this.status()
  }

  async revoke(): Promise<void> {
    const repository = this.repository
    const store = this.store
    this.repository = null
    this.store = null
    this.serverUrl = undefined
    if (repository !== null) await repository.stop()
    if (store !== null) await store.clear()
  }

  async dispose(): Promise<void> {
    await this.revoke()
  }
}

/** Registers the desktop-only server-mode IPC surface; a null controller fails closed. */
export function installServerModeIpc(controller: DesktopServerModeController | null): void {
  ipcMain.handle(IPC.remoteStatus, () => controller?.status() ?? disabledStatus('flag_disabled'))
  ipcMain.handle(IPC.remotePair, async (_event, input: unknown) => {
    if (controller === null || controller.enabled === false) {
      throw new Error('server mode is disabled; set QQPET_SERVER_MODE=1 on a desktop build')
    }
    return controller.pair(input)
  })
  ipcMain.handle(IPC.remoteRevoke, async () => {
    if (controller === null || controller.enabled === false) {
      throw new Error('server mode is disabled; set QQPET_SERVER_MODE=1 on a desktop build')
    }
    await controller.revoke()
  })
}
