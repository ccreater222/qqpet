/**
 * C12 E2E-only Electron main harness.
 *
 * This is deliberately not the GUI entry point. It runs in a real Electron
 * main process (one OS process per instance), with a distinct userData
 * directory, and exercises the production RemoteRepository and WebSocket
 * transport against a real standalone server. It has no BrowserWindow and no
 * renderer, so it proves the main-process repository/process boundary but not
 * renderer/GUI integration. See docs/superpowers/acceptance/ for the exact
 * claim boundary.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  RemoteRepository,
  type RemoteSyncConfig,
  type RemoteTokenStore,
  type RemoteTransport,
  type RemoteTransportConnection,
  type RemoteTransportHandlers,
} from '../../src/main/remote-repository'
import {
  createWebSocketTransport,
  type WebSocketLike,
  type WebSocketMessageEventLike,
  type WebSocketCloseEventLike,
} from '../../src/main/remote-websocket-transport'
import type { RemoteProjectionCacheV2 } from '../../src/shared/sync/portable'

const USER_DATA_ENV = process.env.QQPET_E2E_USER_DATA
if (USER_DATA_ENV === undefined || USER_DATA_ENV.length === 0) {
  throw new Error('QQPET_E2E_USER_DATA is required')
}
const USER_DATA: string = USER_DATA_ENV
app.setPath('userData', USER_DATA)

class HarnessTokenStore implements RemoteTokenStore {
  private readonly tokenPath = join(USER_DATA, 'e2e-device-token.txt')
  private readonly configPath = join(USER_DATA, 'e2e-sync-config.json')
  private readonly cachePath = join(USER_DATA, 'e2e-projection-cache.json')
  config: RemoteSyncConfig | null = null

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = path + '.tmp-' + process.pid
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, path)
  }

  async loadToken(): Promise<string | null> {
    try {
      const value = (await readFile(this.tokenPath, 'utf8')).trim()
      return value.length === 0 ? null : value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async saveToken(token: string): Promise<void> {
    // Test-only temp profile. Production uses PairingStore/safeStorage.
    await this.writeAtomic(this.tokenPath, token)
  }

  async loadConfig(): Promise<RemoteSyncConfig | null> {
    this.config = await this.readJson<RemoteSyncConfig>(this.configPath)
    return this.config === null ? null : structuredClone(this.config)
  }

  async saveConfig(config: RemoteSyncConfig): Promise<void> {
    this.config = structuredClone(config)
    await this.writeAtomic(this.configPath, JSON.stringify(config))
  }

  async loadProjectionCache(): Promise<RemoteProjectionCacheV2 | null> {
    return await this.readJson<RemoteProjectionCacheV2>(this.cachePath)
  }

  async saveProjectionCache(cache: RemoteProjectionCacheV2): Promise<void> {
    await this.writeAtomic(this.cachePath, JSON.stringify(cache))
  }

  async clearProjectionCache(): Promise<void> {
    await rm(this.cachePath, { force: true })
  }

  async clear(): Promise<void> {
    this.config = null
    await Promise.all([
      rm(this.tokenPath, { force: true }),
      rm(this.configPath, { force: true }),
      rm(this.cachePath, { force: true }),
    ])
  }
}

interface FramedConnection {
  real: RemoteTransportConnection | null
  raw: TrackingWebSocket | null
}

class TrackingWebSocket implements WebSocketLike {
  static latest: TrackingWebSocket | null = null
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: WebSocketMessageEventLike) => void) | null = null
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private readonly socket: WebSocket

  constructor(url: string) {
    this.socket = new WebSocket(url)
    TrackingWebSocket.latest = this
    this.socket.onopen = () => this.onopen?.()
    this.socket.onmessage = event => this.onmessage?.({ data: event.data })
    this.socket.onclose = event => this.onclose?.({ code: event.code, reason: event.reason })
    this.socket.onerror = event => this.onerror?.(event)
  }

  send(data: string): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }
}

interface FaultState {
  dropNextCommandResult: boolean
  dropNextProjection: boolean
  droppedCommandResults: number
  droppedProjections: number
}

interface ProtocolStats {
  sentCommands: Array<{ opId: string; type: string }>
  commandStatuses: string[]
  resyncs: number
  commandResultsReceived: number
  projectionsReceived: number
  snapshotsReceived: number
  authorityResetFrames: number
  welcomeDeliveries: string[]
  resyncsQueued: number
}

function parseJsonFrame(data: unknown): Record<string, unknown> | null {
  try {
    if (typeof data === 'string') return JSON.parse(data) as Record<string, unknown>
    if (data instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>
  } catch {
    return null
  }
  return null
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function createInstrumentedTransport(
  framed: FramedConnection,
  faults: FaultState,
  stats: ProtocolStats,
): RemoteTransport {
  const realTransport = createWebSocketTransport(TrackingWebSocket)
  return {
    connect(url, token, handlers): RemoteTransportConnection {
      const wrapped: RemoteTransportHandlers = {
        onOpen: handlers.onOpen,
        onError: handlers.onError,
        onClose: info => {
          framed.real = null
          framed.raw = null
          handlers.onClose(info)
        },
        onMessage: data => {
          const frame = parseJsonFrame(data)
          if (frame?.t === 'welcome') {
            stats.welcomeDeliveries.push(String(frame.delivery ?? 'unknown'))
          } else if (frame?.t === 'snapshot') {
            stats.snapshotsReceived += 1
          } else if (frame?.t === 'authorityResetRequired') {
            stats.authorityResetFrames += 1
          }
          if (frame?.t === 'commandResult') {
            stats.commandResultsReceived += 1
            if (faults.dropNextCommandResult) {
              faults.dropNextCommandResult = false
              faults.droppedCommandResults += 1
              emit({ event: 'frameDropped', kind: 'commandResult', count: faults.droppedCommandResults })
              return
            }
          }
          if (frame?.t === 'projection') {
            stats.projectionsReceived += 1
            if (faults.dropNextProjection) {
              faults.dropNextProjection = false
              faults.droppedProjections += 1
              emit({
                event: 'frameDropped',
                kind: 'projection',
                revision: frame.revision,
                count: faults.droppedProjections,
              })
              return
            }
          } else if (frame?.t === 'resync') {
            stats.resyncsQueued += 1
          }
          handlers.onMessage(data)
        },
      }
      const connection = realTransport.connect(url, token, wrapped)
      framed.real = connection
      framed.raw = TrackingWebSocket.latest
      return {
        send(data: string): void {
          const frame = parseJsonFrame(data)
          if (frame?.t === 'command') {
            const command = frame.command as Record<string, unknown> | undefined
            stats.sentCommands.push({
              opId: String(frame.opId),
              type: String(command?.type ?? 'unknown'),
            })
          } else if (frame?.t === 'commandStatus') {
            stats.commandStatuses.push(String(frame.opId))
          } else if (frame?.t === 'resync') {
            stats.resyncs += 1
          }
          connection.send(data)
        },
        close(): void {
          if (framed.real === connection) framed.real = null
          connection.close()
        },
      }
    },
  }
}

interface ProjectionSummary {
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: unknown
  hash: string
  shared: unknown
}

function projectionSummary(repository: RemoteRepository): ProjectionSummary | null {
  const projection = repository.getProjection()
  if (projection === null) return null
  return {
    revision: projection.revision,
    eventSeq: projection.eventSeq,
    gameTimeMs: projection.gameTimeMs,
    timeZone: projection.timeZone,
    advanceWhileEmpty: projection.advanceWhileEmpty,
    authority: projection.authority,
    hash: sha256(projection.shared),
    shared: projection.shared,
  }
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const framed: FramedConnection = { real: null, raw: null }
const faults: FaultState = {
  dropNextCommandResult: false,
  dropNextProjection: false,
  droppedCommandResults: 0,
  droppedProjections: 0,
}
const stats: ProtocolStats = {
  sentCommands: [],
  commandStatuses: [],
  resyncs: 0,
  commandResultsReceived: 0,
  projectionsReceived: 0,
  snapshotsReceived: 0,
  authorityResetFrames: 0,
  welcomeDeliveries: [],
  resyncsQueued: 0,
}
const tokenStore = new HarnessTokenStore()

app.commandLine.appendSwitch('disable-gpu')

function startHarness(): void {
  const serverUrl = process.env.QQPET_E2E_SERVER_URL
  const pairingCode = process.env.QQPET_E2E_PAIRING_CODE
  if (serverUrl === undefined || serverUrl.length === 0
    || pairingCode === undefined || pairingCode.length === 0) {
    throw new Error('QQPET_E2E_SERVER_URL and QQPET_E2E_PAIRING_CODE are required')
  }
  const transport = createInstrumentedTransport(framed, faults, stats)
  const repository = new RemoteRepository({
    serverUrl,
    appVersion: '0.1.0-c12-e2e',
    tokenStore,
    transport,
    pair: { code: pairingCode, deviceLabel: process.env.QQPET_E2E_DEVICE_LABEL ?? 'C12 E2E Electron' },
    backoff: { baseMs: 25, maxMs: 1000, random: () => 0.5 },
  })

  repository.onProjection((projection, events) => {
    emit({
      event: 'projection',
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      gameTimeMs: projection.gameTimeMs,
      eventCount: events.length,
    })
  })
  repository.onResync((projection, events) => {
    emit({
      event: 'resync',
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      eventCount: events.length,
      authority: projection.authority,
    })
  })
  repository.onSyncStatus(status => {
    emit({
      event: 'status',
      state: status.state,
      connection: status.connection,
      revision: status.revision,
      eventSeq: status.eventSeq,
      authority: status.authority,
      readOnly: status.readOnly,
      ...(status.notice === undefined ? {} : { notice: status.notice }),
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
    })
  })
  repository.onCommandResult(result => {
    emit({ event: 'commandResultEvent', opId: result.opId, status: result.status })
  })

  let startPromise: Promise<ProjectionSummary | null> | null = null
  const ensureStarted = (): Promise<ProjectionSummary | null> => {
    if (startPromise === null) {
      startPromise = repository.start().then(() => projectionSummary(repository))
    }
    return startPromise
  }

  const handle = async (request: Record<string, unknown>): Promise<unknown> => {
    const cmd = String(request.cmd ?? '')
    switch (cmd) {
      case 'start': {
        const projection = await ensureStarted()
        await repository.flush()
        return {
          projection,
          status: repository.getStatus(),
          deviceId: tokenStore.config?.deviceId ?? null,
          userData: app.getPath('userData'),
        }
      }
      case 'status':
        return {
          status: repository.getStatus(),
          deviceId: tokenStore.config?.deviceId ?? null,
          projectionPresent: repository.getProjection() !== null,
          hasProjectionCache: repository.hasProjectionCache(),
        }
      case 'projection': {
        const projection = projectionSummary(repository)
        if (projection === null) throw new Error('projection is unavailable')
        return projection
      }
      case 'command': {
        await ensureStarted()
        const command = request.command
        if (command === null || typeof command !== 'object') throw new Error('command object is required')
        const options = typeof request.opId === 'string' ? { opId: request.opId } : {}
        return await repository.command(command as never, options)
      }
      case 'identity':
        return {
          deviceId: tokenStore.config?.deviceId ?? null,
          petId: tokenStore.config?.petId ?? null,
          lastRevision: tokenStore.config?.lastRevision ?? null,
          lastEventSeq: tokenStore.config?.lastEventSeq ?? null,
        }
      case 'waitOnline':
        await waitUntil(() => repository.getStatus().state === 'online', 'repository online', Number(request.timeoutMs ?? 15_000))
        return repository.getStatus()
      case 'waitStatus': {
        const state = typeof request.state === 'string' ? request.state : undefined
        const notice = typeof request.notice === 'string' ? request.notice : undefined
        const authorityState = typeof request.authorityState === 'string' ? request.authorityState : undefined
        const stableMs = Math.max(0, Number(request.stableMs ?? 0))
        const matches = (): boolean => {
          const status = repository.getStatus()
          return (state === undefined || status.state === state)
            && (notice === undefined || status.notice === notice)
            && (authorityState === undefined || status.authority.state === authorityState)
        }
        await waitUntil(matches, 'repository status', Number(request.timeoutMs ?? 15_000))
        if (stableMs > 0) {
          const stableUntil = Date.now() + stableMs
          while (Date.now() < stableUntil) {
            await new Promise(resolve => setTimeout(resolve, 25))
            if (matches() === false) {
              await waitUntil(matches, 'stable repository status', Number(request.timeoutMs ?? 15_000))
            }
          }
        }
        return repository.getStatus()
      }
      case 'waitRevision':
        await waitUntil(
          () => (repository.getProjection()?.revision ?? -1) >= Number(request.revision),
          'projection revision ' + String(request.revision),
          Number(request.timeoutMs ?? 15_000),
        )
        return projectionSummary(repository)
      case 'stats':
        return {
          faults,
          stats,
          status: repository.getStatus(),
          projectionPresent: repository.getProjection() !== null,
        }
      case 'armFault': {
        const kind = String(request.kind ?? '')
        if (kind === 'commandResult') faults.dropNextCommandResult = true
        else if (kind === 'projection') faults.dropNextProjection = true
        else throw new Error('unknown fault kind: ' + kind)
        return faults
      }
      case 'forceClose': {
        if (framed.raw === null) throw new Error('no live raw WebSocket to drop')
        // Simulate a real network loss. Do not call the production transport
        // adapter's close() here: that intentional API suppresses onclose for
        // repository shutdown. Closing the underlying WebSocket exercises the
        // same unexpected-close path as a dropped network.
        framed.raw.close(4006, 'e2e_network_loss')
        return { closed: true }
      }
      case 'requestResync':
        repository.requestResync()
        return { requested: true }
      case 'projectionCachePresent':
        return { present: repository.hasProjectionCache() }
      case 'flush':
        await repository.flush()
        return { flushed: true }
      case 'stop':
        await repository.stop()
        return { stopped: true }
      case 'quit':
        await repository.stop()
        return { stopped: true, quit: true }
      default:
        throw new Error('unknown harness command: ' + cmd)
    }
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let quitting = false
  input.on('line', line => {
    if (line.trim().length === 0) return
    let request: Record<string, unknown>
    try {
      request = JSON.parse(line) as Record<string, unknown>
    } catch (error) {
      emit({ event: 'protocolError', message: errorText(error) })
      return
    }
    const id = request.id
    void handle(request).then(result => {
      emit({ id, ok: true, result })
      if (request.cmd === 'quit' && quitting === false) {
        quitting = true
        setTimeout(() => app.exit(0), 10)
      }
    }, error => {
      emit({ id, ok: false, error: errorText(error) })
    })
  })
  input.on('close', () => {
    if (quitting === false) {
      quitting = true
      void repository.stop().finally(() => app.exit(0))
    }
  })
  process.on('SIGTERM', () => {
    void repository.stop().finally(() => app.exit(0))
  })

  emit({
    event: 'boot',
    pid: process.pid,
    userData: app.getPath('userData'),
    wsAvailable: typeof WebSocket === 'function',
  })
  void ensureStarted().then(() => {
    emit({ event: 'ready', pid: process.pid, userData: app.getPath('userData') })
  }, error => {
    emit({ event: 'startupError', message: errorText(error) })
  })
}

app.whenReady().then(() => {
  try {
    startHarness()
  } catch (error) {
    emit({ event: 'startupError', message: errorText(error) })
    app.exit(1)
  }
})
