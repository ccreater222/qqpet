import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { createServerConfig, type ServerConfig } from './config'
import { AuthService } from './auth'
import { CommandService } from './command-service'
import { DatabaseStore, openDatabase, type DatabaseOperationalHealth } from './db'
import { acquireDatabaseLifetimeLock, type DatabaseLifetimeLock } from './db-lock'
import { createLogger, type Logger } from './logging'
import { MetricsRegistry } from './metrics'
import { RuntimeHost } from './runtime-host'
import { SchedulerService, type SchedulerPetHealth } from './scheduler'
import { SessionService } from './session'

export interface ServerAddress {
  address: string
  port: number
}

export type PetOperationalHealth = SchedulerPetHealth & {
  canonicalOk: boolean
  canonicalError: string | null
  dbWritable: boolean
  quickCheck: string
  lastError: string | null
  lastErrorAtMs: number | null
  lastErrorEvent: string | null
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
  petHealth: PetOperationalHealth[]
  connections: number
  revision: number
  commandSeq: number
  eventSeq: number
  commandLogSize: number
  eventLogSize: number
  gameTimeMs: number
  catchingUp: boolean
  wallLagMs: number
  nextTickAtMs: number
  scheduledJobs: number
  activeClientCount: number
  authorityState: 'active' | 'archived' | 'reset'
  authorityEpoch: number
  authorityId: string
  restoreGeneration: number
  advanceWhileEmpty: boolean
  timeZone: string
  dbWritable: boolean
  quickCheck: string
  database: DatabaseOperationalHealth
  lastError: string | null
  lastErrorAtMs: number | null
  lastErrorEvent: string | null
  authMetrics: Record<string, number>
  rateMetrics: Record<string, number>
  rateLimitMetrics: Record<string, number>
  backupMetrics: Record<string, number>
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
  private databaseLock: DatabaseLifetimeLock | undefined
  private lastError: { atMs: number; event: string; message: string } | null = null

  constructor(
    readonly config: ServerConfig,
    readonly store: DatabaseStore,
    options: SyncServerOptions = {},
  ) {
    const now = options.now ?? Date.now
    this.now = now
    const baseLogger = createLogger(config)
    this.logger = {
      debug: baseLogger.debug,
      info: baseLogger.info,
      warn: baseLogger.warn,
      error: (event, fields) => {
        const raw = fields?.error
        const message = raw instanceof Error
          ? raw.message
          : typeof raw === 'string' ? raw : 'internal_error'
        this.lastError = { atMs: this.now(), event, message }
        baseLogger.error(event, fields)
      },
    }
    this.metrics = new MetricsRegistry()
    const auth = new AuthService(store, now, this.metrics)
    const commands = new CommandService(store, auth, new RuntimeHost(), this.logger, this.metrics, now)
    this.sessions = new SessionService(config, store, auth, commands, this.logger, this.metrics, now)
    this.scheduler = new SchedulerService(config, store, commands, this.sessions.hub, this.logger, this.metrics, now)
    commands.setCatchingUpGate(petId => this.scheduler.isCommandBlocked(petId))
    this.sessions.setCatchingUpSource(petId => this.scheduler.isCatchUpBlocked(petId))
    this.http = createServer((request, response) => {
      void this.handleHttp(request, response)
    })
    // Allow one byte beyond the application ceiling so SessionService can emit
    // the protocol 4005 close, while the parser still bounds pre-auth memory.
    // Frames much larger than this are remapped from ws 1009 to 4005 below.
    const wsMaxPayload = Math.min(2 ** 31 - 1, config.maxFrameBytes + 1)
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
      if (this.sessions.hasPreAuthCapacity() === false) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
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
    this.databaseLock = acquireDatabaseLifetimeLock(this.config.dbPath)
    try {
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
    } catch (error) {
      this.databaseLock?.release()
      this.databaseLock = undefined
      throw error
    }
  }

  async stop(): Promise<void> {
    try {
      if (!this.started) {
        await this.scheduler.stop()
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
      this.logger.info('server.stopped')
    } finally {
      this.store.close()
      this.databaseLock?.release()
      this.databaseLock = undefined
    }
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
    let database: DatabaseOperationalHealth
    try {
      database = this.store.operationalHealth()
    } catch (error) {
      database = {
        writable: false,
        quickCheck: 'error',
        error: error instanceof Error ? error.message : 'database health check failed',
      }
    }

    let journalMode = 'unknown'
    let synchronous = 'unknown'
    let foreignKeys = 0
    let busyTimeoutMs = 0
    try {
      const journal = this.store.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
      const sync = this.store.db.prepare('PRAGMA synchronous').get() as Record<string, unknown>
      const fk = this.store.db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>
      const busyTimeout = this.store.db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>
      journalMode = String(Object.values(journal)[0] ?? '').toLowerCase()
      synchronous = Number(Object.values(sync)[0]) === 2 ? 'full' : String(Object.values(sync)[0])
      foreignKeys = Number(Object.values(fk)[0] ?? 0)
      busyTimeoutMs = Number(Object.values(busyTimeout)[0] ?? 0)
    } catch (error) {
      database.error ??= error instanceof Error ? error.message : 'database pragma read failed'
      database.writable = false
    }

    let pets: ReturnType<DatabaseStore['listPets']> = []
    let listError: string | null = null
    try {
      pets = this.store.listPets()
    } catch (error) {
      listError = error instanceof Error ? error.message : 'database pet listing failed'
    }

    let schedulerHealth: SchedulerPetHealth[] = []
    let schedulerError: string | null = null
    try {
      schedulerHealth = this.scheduler.healthAll()
    } catch (error) {
      schedulerError = error instanceof Error ? error.message : 'scheduler health failed'
    }

    let firstCanonicalError: string | null = null
    const petHealth: PetOperationalHealth[] = schedulerHealth.map(value => {
      let canonicalOk = true
      let canonicalError: string | null = null
      try {
        this.store.loadCanonical(value.petId)
      } catch (error) {
        canonicalOk = false
        canonicalError = error instanceof Error ? error.message : 'canonical state is corrupt'
        firstCanonicalError ??= canonicalError
      }
      const lastError = canonicalError ?? this.lastError?.message ?? database.error
      return {
        ...value,
        canonicalOk,
        canonicalError,
        dbWritable: database.writable,
        quickCheck: database.quickCheck,
        lastError,
        lastErrorAtMs: canonicalError !== null
          ? this.now()
          : this.lastError?.atMs ?? (lastError === null ? null : this.now()),
        lastErrorEvent: canonicalError !== null
          ? 'canonical.health_failed'
          : this.lastError?.event ?? (lastError === null ? null : 'database.health_failed'),
      }
    })

    const first = pets[0]
    const firstHealth = petHealth[0]
    const catchingUp = petHealth.some(value => value.catchingUp)
    const allPetsReady = pets.length > 0
      && schedulerHealth.length === pets.length
      && petHealth.length === pets.length
      && petHealth.every(value => value.ready && value.stuck === false && value.canonicalOk)
    let authority: ReturnType<DatabaseStore['getAuthority']>
    let settings: ReturnType<DatabaseStore['getSettings']>
    try {
      authority = first === undefined ? undefined : this.store.getAuthority(first.id)
      settings = first === undefined ? undefined : this.store.getSettings(first.id)
    } catch (error) {
      firstCanonicalError ??= error instanceof Error ? error.message : 'canonical settings read failed'
      authority = undefined
      settings = undefined
    }

    const metrics = this.metrics.snapshot()
    const metricGroup = (prefix: string): Record<string, number> => Object.fromEntries(
      Object.entries(metrics).filter(([key]) => key.startsWith(prefix)),
    )
    const databaseReady = database.writable && database.quickCheck === 'ok'
    const derivedError = listError ?? schedulerError ?? firstCanonicalError ?? database.error
    const lastError = this.lastError?.message ?? derivedError
    const lastErrorAtMs = this.lastError?.atMs ?? (lastError === null ? null : this.now())
    const lastErrorEvent = this.lastError?.event ?? (
      listError !== null ? 'database.list_pets_failed'
        : schedulerError !== null ? 'scheduler.health_failed'
          : firstCanonicalError !== null ? 'canonical.health_failed'
            : database.error !== null ? 'database.health_failed'
              : null
    )

    return {
      ok: true,
      service: 'qqpet-server',
      ready: this.started && databaseReady && allPetsReady && catchingUp === false && authority?.state === 'active',
      journalMode,
      synchronous,
      foreignKeys,
      busyTimeoutMs,
      pets: pets.length,
      petHealth,
      connections: first === undefined ? 0 : this.sessions.hub.count(first.id),
      revision: first?.revision ?? 0,
      commandSeq: first?.commandSeq ?? 0,
      eventSeq: first?.eventSeq ?? 0,
      commandLogSize: petHealth.reduce((sum, value) => sum + value.commandLogSize, 0),
      eventLogSize: petHealth.reduce((sum, value) => sum + value.eventLogSize, 0),
      gameTimeMs: first?.gameTimeMs ?? 0,
      catchingUp,
      wallLagMs: firstHealth?.wallLagMs ?? 0,
      nextTickAtMs: firstHealth?.nextTickAtMs ?? 0,
      scheduledJobs: firstHealth?.scheduledJobs ?? 0,
      activeClientCount: firstHealth?.activeClientCount ?? 0,
      authorityState: authority?.state ?? 'reset',
      authorityEpoch: authority?.epoch ?? 0,
      authorityId: authority?.authorityId ?? '',
      restoreGeneration: authority?.restoreGeneration ?? 0,
      advanceWhileEmpty: settings?.advanceWhileEmpty ?? false,
      timeZone: settings?.timeZone ?? '',
      dbWritable: database.writable,
      quickCheck: database.quickCheck,
      database,
      lastError,
      lastErrorAtMs,
      lastErrorEvent,
      authMetrics: metricGroup('auth.'),
      rateMetrics: metricGroup('rate_limits.'),
      rateLimitMetrics: metricGroup('rate_limits.'),
      backupMetrics: metricGroup('backup.'),
      metrics,
      scheduler: schedulerHealth,
    }
  }

  async backup(path: string): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true })
      await this.store.backup(path)
      this.metrics.increment('backup.success')
    } catch (error) {
      this.metrics.increment('backup.failure')
      this.logger.error('backup.failed', { error })
      throw error
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    if (request.url === '/health') {
      this.json(response, 200, { ...this.health() })
      return
    }
    if (request.url === '/healthz') {
      // Liveness must stay 200 while the process can serve HTTP. Readiness is
      // reported separately by /readyz and in the body's ready field.
      this.json(response, 200, { ...this.health(), ok: true })
      return
    }
    if (request.url === '/readyz') {
      const health = this.health()
      this.json(response, health.ready ? 200 : 503, { ...health, ok: health.ready })
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
