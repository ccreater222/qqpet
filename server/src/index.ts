import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { createServerConfig, type ServerConfig } from './config'
import { AuthService } from './auth'
import { CommandService } from './command-service'
import { DatabaseStore, openDatabase } from './db'
import { createLogger, type Logger } from './logging'
import { MetricsRegistry } from './metrics'
import { RuntimeHost } from './runtime-host'
import { SchedulerService, type SchedulerPetHealth } from './scheduler'
import { SessionService } from './session'

export interface ServerAddress {
  address: string
  port: number
}

export interface ServerHealth {
  ok: boolean
  service: 'qqpet-server'
  ready: boolean
  journalMode: string
  synchronous: string
  foreignKeys: number
  busyTimeoutMs: number
  pets: number
  connections: number
  revision: number
  eventSeq: number
  gameTimeMs: number
  catchingUp: boolean
  wallLagMs: number
  nextTickAtMs: number
  scheduledJobs: number
  activeClientCount: number
  authorityState: 'active' | 'archived' | 'reset'
  authorityEpoch: number
  advanceWhileEmpty: boolean
  timeZone: string
  metrics: Record<string, number>
  scheduler: SchedulerPetHealth[]
}

export interface SyncServerOptions {
  now?: () => number
}

export class SyncServer {
  private readonly logger: Logger
  private readonly http: HttpServer
  private readonly wss: WebSocketServer
  private readonly sessions: SessionService
  readonly metrics: MetricsRegistry
  readonly scheduler: SchedulerService
  private readonly now: () => number
  private started = false

  constructor(
    readonly config: ServerConfig,
    readonly store: DatabaseStore,
    options: SyncServerOptions = {},
  ) {
    const now = options.now ?? Date.now
    this.now = now
    this.logger = createLogger(config)
    this.metrics = new MetricsRegistry()
    const auth = new AuthService(store, now)
    const commands = new CommandService(store, auth, new RuntimeHost(), this.logger, this.metrics, now)
    this.sessions = new SessionService(config, store, auth, commands, this.logger, now)
    this.scheduler = new SchedulerService(config, store, commands, this.sessions.hub, this.logger, this.metrics, now)
    commands.setCatchingUpGate(petId => this.scheduler.isCatchUpBlocked(petId))
    this.sessions.setCatchingUpSource(petId => this.scheduler.isCatchUpBlocked(petId))
    this.http = createServer((request, response) => {
      void this.handleHttp(request, response)
    })
    // Keep ws' parser from racing us to a protocol 1009 close. Frames that
    // exceed the application limit are rejected in SessionService with 4005.
    const wsMaxPayload = Math.max(config.maxFrameBytes * 2, 64 * 1024 * 1024)
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: wsMaxPayload,
      perMessageDeflate: false,
    })
    this.http.on('upgrade', (request, socket, head) => {
      if (request.url !== '/sync' && request.url !== '/v1/sync') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, ws => {
        this.wss.emit('connection', ws, request)
      })
    })
    this.wss.on('connection', (socket, request) => {
      // ws rejects frames above its parser cap before emitting 'message'.
      // Remap that transport 1009 close to the protocol's 4005 contract.
      const close = socket.close.bind(socket)
      Object.defineProperty(socket, 'close', {
        configurable: true,
        value: (code?: number, reason?: string | Buffer): void => {
          if (code === 1009) {
            close(4005, 'payload_too_large')
            return
          }
          close(code, reason)
        },
      })
      this.sessions.attach(socket, request)
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    await mkdir(dirname(this.config.dbPath), { recursive: true })
    await mkdir(this.config.backupDir, { recursive: true })
    this.store.verifyRestoreGeneration(this.config.restoreGenerationFile)
    // Fail closed before accepting connections if any canonical pet is corrupt.
    for (const pet of this.store.listPets()) this.store.loadCanonical(pet.id)
    const startupAt = this.now()
    const repaired = this.store.repairCoverageOnStartup(startupAt)
    if (repaired > 0) this.logger.info('coverage.repaired', { intervals: repaired })
    this.sessions.start()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.http.once('error', onError)
      this.http.listen(this.config.port, this.config.bind, () => {
        this.http.off('error', onError)
        resolve()
      })
    })
    this.started = true
    this.scheduler.start()
    this.logger.info('server.started', {
      bind: this.address().address,
      port: this.address().port,
      wsPath: '/v1/sync',
    })
  }

  async stop(): Promise<void> {
    if (!this.started) {
      await this.scheduler.stop()
      this.store.close()
      return
    }
    this.started = false
    await this.scheduler.stop()
    this.store.finalizeCoverageOperationsOnShutdown(this.now())
    this.sessions.stop()
    await new Promise<void>(resolve => {
      this.wss.close(() => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      this.http.close(error => error === undefined ? resolve() : reject(error))
    })
    this.store.close()
    this.logger.info('server.stopped')
  }

  address(): ServerAddress {
    const address = this.http.address()
    if (address === null || typeof address === 'string') {
      if (address === null) throw new Error('server has not started')
      return { address: this.config.bind, port: 0 }
    }
    return { address: address.address, port: address.port }
  }

  health(): ServerHealth {
    const journal = this.store.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
    const synchronous = this.store.db.prepare('PRAGMA synchronous').get() as Record<string, unknown>
    const foreignKeys = this.store.db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>
    const busyTimeout = this.store.db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>
    const pets = this.store.listPets()
    const first = pets[0]
    const schedulerHealth = this.scheduler.healthAll()
    const firstHealth = schedulerHealth[0]
    const catchingUp = schedulerHealth.some(value => value.catchingUp)
    const schedulerReady = schedulerHealth.every(value => value.ready)
    const authority = first === undefined ? undefined : this.store.getAuthority(first.id)
    const settings = first === undefined ? undefined : this.store.getSettings(first.id)
    return {
      ok: true,
      service: 'qqpet-server',
      ready: this.started && schedulerReady && catchingUp === false && authority?.state === 'active',
      journalMode: String(Object.values(journal)[0] ?? '').toLowerCase(),
      synchronous: Number(Object.values(synchronous)[0]) === 2 ? 'full' : String(Object.values(synchronous)[0]),
      foreignKeys: Number(Object.values(foreignKeys)[0] ?? 0),
      busyTimeoutMs: Number(Object.values(busyTimeout)[0] ?? 0),
      pets: pets.length,
      connections: first === undefined ? 0 : this.sessions.hub.count(first.id),
      revision: first?.revision ?? 0,
      eventSeq: first?.eventSeq ?? 0,
      gameTimeMs: first?.gameTimeMs ?? 0,
      catchingUp,
      wallLagMs: firstHealth?.wallLagMs ?? 0,
      nextTickAtMs: firstHealth?.nextTickAtMs ?? 0,
      scheduledJobs: firstHealth?.scheduledJobs ?? 0,
      activeClientCount: firstHealth?.activeClientCount ?? 0,
      authorityState: authority?.state ?? 'reset',
      authorityEpoch: authority?.epoch ?? 0,
      advanceWhileEmpty: settings?.advanceWhileEmpty ?? false,
      timeZone: settings?.timeZone ?? '',
      metrics: this.metrics.snapshot(),
      scheduler: schedulerHealth,
    }
  }

  async backup(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await this.store.backup(path)
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    if (request.url === '/health' || request.url === '/healthz' || request.url === '/readyz') {
      this.json(response, 200, { ...this.health() })
      return
    }
    this.json(response, 404, { ok: false, error: 'not_found' })
  }

  private json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    response.end(text)
  }
}

export function startServer(config: ServerConfig = createServerConfig()): SyncServer {
  return new SyncServer(config, openDatabase(config.dbPath))
}

let activeServer: SyncServer | undefined

async function main(): Promise<void> {
  const config = createServerConfig()
  activeServer = startServer(config)
  await activeServer.start()
  const shutdown = async (signal: string): Promise<void> => {
    if (activeServer === undefined) return
    createLogger(config).info('server.signal', { signal })
    const server = activeServer
    activeServer = undefined
    await server.stop()
  }
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

export { createServerConfig } from './config'

const isEntryPoint = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))
if (isEntryPoint) {
  const command = process.argv[2]
  if (command !== undefined && command !== 'start') {
    void import('./cli').then(module => module.runCli(process.argv.slice(2)))
  } else {
    main().catch(error => {
      process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'server.start_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }) + '\n')
      process.exitCode = 1
    })
  }
}

export function createBackupPath(config: ServerConfig, petId: string): string {
  return join(config.backupDir, petId + '-' + new Date().toISOString().replaceAll(':', '-') + '.sqlite')
}

export function newOperationId(): string {
  return randomUUID()
}
