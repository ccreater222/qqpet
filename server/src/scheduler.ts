import {
  advanceSchedulerChunk,
  dueFixedTicks,
  GAME_TICK_MS,
  type SchedulerAdvanceOutcome,
} from '../../src/shared/pet-runtime/index'
import type { ServerConfig } from './config'
import type { CommandService } from './command-service'
import type { DatabaseStore } from './db'
import type { SocketHub } from './hub'
import type { Logger } from './logging'
import type { MetricsRegistry } from './metrics'

export interface SchedulerPetHealth {
  petId: string
  ready: boolean
  catchingUp: boolean
  gameTimeMs: number
  wallLagMs: number
  nextTickAtMs: number
  scheduledJobs: number
  nextScheduledJobAtMs: number | null
  activeClientCount: number
  activeSessionCount: number
  authorityState: 'active' | 'archived' | 'reset'
  authorityEpoch: number
  authorityId: string
  restoreGeneration: number
  revision: number
  commandSeq: number
  eventSeq: number
  commandLogSize: number
  eventLogSize: number
  lastSchedulerWallMs: number
  lastRunAtMs: number | null
  stuck: boolean
  openCoverageIntervals: number
  lastCoverageHeartbeatMs: number | null
}

interface ChunkResult {
  catchingUp: boolean
  ticks: number
}

function immediate(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve))
}

/**
 * One serialized scheduler per pet. Tick chunks and commands share the
 * CommandService queue so the canonical order is exactly the queue order.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private pass: Promise<void> | undefined
  private readonly inflight = new Set<Promise<unknown>>()
  /** Pets whose last observed authenticated-client count was zero (restart counts as zero). */
  private readonly empty = new Set<string>()
  private readonly catchingUp = new Set<string>()
  /** Failed catch-up target; the pet stays not-ready until its anchor reaches it. */
  private readonly catchUpFailures = new Map<string, number>()
  private started = false
  private startedAtMs: number | null = null
  private lastRunAtMs: number | null = null

  constructor(
    private readonly config: ServerConfig,
    private readonly store: DatabaseStore,
    private readonly commands: CommandService,
    private readonly hub: SocketHub,
    private readonly logger: Logger,
    readonly metrics: MetricsRegistry,
    private readonly now: () => number = Date.now,
  ) {
    for (const pet of this.store.listPets()) this.empty.add(pet.id)
  }

  start(): void {
    if (this.stopped || this.timer !== undefined) return
    this.started = true
    this.startedAtMs ??= this.now()
    if (this.config.schedulerEnabled === false) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.config.schedulerPollMs)
    this.timer.unref()
    void this.runOnce()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (this.pass !== undefined) await this.pass.catch(() => undefined)
    await Promise.allSettled([...this.inflight])
  }

  isCatchingUp(petId: string): boolean {
    return this.catchingUp.has(petId)
  }

  /** Catch-up in progress or the last catch-up failed and has not reached its target. */
  isCatchUpBlocked(petId: string): boolean {
    return this.catchingUp.has(petId) || this.catchUpFailures.has(petId)
  }

  isReady(petId: string): boolean {
    if (this.stopped) return false
    if (this.isCatchUpBlocked(petId)) return false
    const authority = this.store.getAuthority(petId)
    return authority?.state === 'active' && this.isStuck(petId) === false
  }

  private isStuck(petId: string): boolean {
    if (this.config.schedulerEnabled === false || this.started === false || this.stopped) return false
    if (this.catchingUp.has(petId) || this.catchUpFailures.has(petId)) return false
    const now = this.now()
    const passReference = this.lastRunAtMs ?? this.startedAtMs
    const passStaleAfterMs = Math.max(this.config.schedulerPollMs * 5, 30_000)
    if (passReference !== null && now - passReference > passStaleAfterMs) return true
    const pet = this.store.getPet(petId)
    const authority = this.store.getAuthority(petId)
    const settings = this.store.getSettings(petId)
    if (pet === undefined || authority === undefined || authority.state !== 'active') return false
    // A live or advance-while-empty pet should advance at least one tick while
    // the scheduler remains healthy. A frozen zero-client pet legitimately
    // leaves its anchor behind until the next connection.
    const shouldAdvance = settings?.advanceWhileEmpty === true || this.hub.count(petId) > 0
    const anchorStaleAfterMs = Math.max(GAME_TICK_MS * 2, this.config.schedulerPollMs * 5)
    return shouldAdvance && now - pet.lastSchedulerWallMs > anchorStaleAfterMs
  }

  private clearCatchUpFailureIfReached(petId: string, anchorMs: number): void {
    const target = this.catchUpFailures.get(petId)
    if (target !== undefined && anchorMs >= target) this.catchUpFailures.delete(petId)
  }

  /** Runs one scheduler pass over every pet; used by the 1s timer and deterministic tests. */
  async runOnce(): Promise<void> {
    if (this.stopped) return
    if (this.pass !== undefined) return this.pass
    const pass = this.runPass()
    this.pass = pass
    try {
      await pass
    } finally {
      if (this.pass === pass) this.pass = undefined
    }
  }

  private async runPass(): Promise<void> {
    this.lastRunAtMs = this.now()
    for (const pet of this.store.listPets()) {
      if (this.stopped) return
      try {
        await this.tickPet(pet.id)
      } catch (error) {
        this.logger.error('scheduler.tick_failed', { petId: pet.id, error })
        this.metrics.increment('scheduler.errors')
      }
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise)
    void promise.finally(() => this.inflight.delete(promise)).catch(() => undefined)
    return promise
  }

  private async setAnchor(petId: string, anchorMs: number): Promise<void> {
    const promise = this.commands.enqueue(petId, () => {
      const pet = this.store.getPet(petId)
      if (pet === undefined || pet.lastSchedulerWallMs === anchorMs) return
      this.store.setSchedulerAnchor(petId, anchorMs, this.now())
    })
    await this.track(promise)
  }

  private async tickPet(petId: string): Promise<void> {
    if (this.stopped) return
    const snapshot = this.store.loadCanonical(petId)
    if (snapshot.authority.state !== 'active') {
      this.catchingUp.delete(petId)
      this.catchUpFailures.delete(petId)
      this.empty.delete(petId)
      return
    }
    const target = this.now()
    const liveCount = this.hub.count(petId)

    let anchor = snapshot.pet.lastSchedulerWallMs
    if (snapshot.settings.advanceWhileEmpty === false) {
      if (liveCount === 0) {
        this.empty.add(petId)
        this.catchingUp.delete(petId)
        await this.setAnchor(petId, target)
        this.clearCatchUpFailureIfReached(petId, target)
        this.metrics.increment('scheduler.frozen_anchor_updates')
        return
      }
      if (this.empty.has(petId)) {
        // First session after a frozen/empty interval: resume at the actual
        // connection wall and never credit the gap before it.
        this.empty.delete(petId)
        const resumeWall = this.firstActiveCoverageWall(snapshot)
        anchor = Math.max(anchor, resumeWall === undefined ? target : Math.min(target, Math.max(anchor, resumeWall)))
        await this.setAnchor(petId, anchor)
        this.metrics.increment('scheduler.resume_anchor_resets')
      }
    } else {
      this.empty.delete(petId)
    }

    if (anchor > target) {
      await this.setAnchor(petId, target)
      this.clearCatchUpFailureIfReached(petId, target)
      return
    }
    const due = dueFixedTicks(anchor, target)
    if (due <= 0) {
      this.clearCatchUpFailureIfReached(petId, anchor)
      return
    }

    this.catchingUp.add(petId)
    const startedAt = Date.now()
    try {
      let result = await this.runChunk(petId, target)
      this.metrics.increment('scheduler.catchup_chunks')
      while (result.catchingUp && this.stopped === false) {
        await immediate()
        result = await this.runChunk(petId, target)
        this.metrics.increment('scheduler.catchup_chunks')
      }
      const committedAnchor = this.store.getPet(petId)?.lastSchedulerWallMs
      if (committedAnchor !== undefined && committedAnchor >= target) {
        this.catchUpFailures.delete(petId)
      } else {
        this.catchUpFailures.set(petId, target)
      }
      this.metrics.increment('scheduler.catchup_runs')
      this.metrics.increment('scheduler.catchup_duration_ms', Date.now() - startedAt)
    } catch (error) {
      // Commands must stay fenced at the last committed game time. A later
      // scheduler pass retries the original target and only then clears this.
      this.catchUpFailures.set(petId, target)
      throw error
    } finally {
      this.catchingUp.delete(petId)
    }
    if (this.catchUpFailures.has(petId) === false) this.broadcastReady(petId)
  }

  private firstActiveCoverageWall(snapshot: ReturnType<DatabaseStore['loadCanonical']>): number | undefined {
    let earliest: number | undefined
    for (const interval of snapshot.engine.sessionCoverage) {
      if (interval.disconnectedAtWallMs !== undefined) continue
      if (earliest === undefined || interval.connectedAtWallMs < earliest) earliest = interval.connectedAtWallMs
    }
    return earliest
  }

  private async runChunk(petId: string, target: number): Promise<ChunkResult> {
    const promise = this.commands.enqueue(petId, () => this.runChunkSerialized(petId, target))
    return this.track(promise)
  }

  private runChunkSerialized(petId: string, target: number): ChunkResult {
    const snapshot = this.store.loadCanonical(petId)
    if (snapshot.authority.state !== 'active') return { catchingUp: false, ticks: 0 }
    const tickEvents: Array<{ gameTimeMs: number; events: SchedulerAdvanceOutcome['events'] }> = []
    const outcome = advanceSchedulerChunk(
      snapshot.engine,
      {
        gameTimeMs: snapshot.engine.gameTimeMs,
        environment: snapshot.engine.environment,
        activeClientCount: 0,
        sessionActive: false,
        actorDeviceId: null,
      },
      target,
      {
        maxChunkTicks: this.config.catchupChunkTicks,
        onTick: (gameTimeMs, events) => {
          tickEvents.push({ gameTimeMs, events })
        },
      },
    )
    if (outcome.ticks > 0) {
      const committed = this.store.commitSchedulerBatch(
        petId,
        snapshot.pet.revision,
        outcome.state,
        tickEvents,
        this.now(),
      )
      this.metrics.increment('scheduler.ticks', outcome.ticks)
      this.metrics.increment('scheduler.committed_batches')
      if (this.hub.count(petId) > 0) {
        this.hub.broadcastProjection(petId, committed.pet, committed.events)
        this.metrics.increment('scheduler.projections')
      }
    } else if (outcome.state.lastSchedulerWallMs !== snapshot.pet.lastSchedulerWallMs) {
      this.store.setSchedulerAnchor(petId, outcome.state.lastSchedulerWallMs, this.now())
      this.metrics.increment('scheduler.anchor_updates')
    }
    if (outcome.frozen) {
      this.empty.add(petId)
      this.metrics.increment('scheduler.freeze_events')
    }
    return { catchingUp: outcome.catchingUp, ticks: outcome.ticks }
  }

  private broadcastReady(petId: string): void {
    if (this.hub.count(petId) === 0) return
    const snapshot = this.store.loadCanonical(petId)
    this.hub.broadcast(petId, {
      t: 'snapshot',
      v: 1,
      revision: snapshot.pet.revision,
      eventSeq: snapshot.pet.eventSeq,
      gameTimeMs: snapshot.pet.gameTimeMs,
      timeZone: snapshot.settings.timeZone,
      advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
      authority: this.hub.authority(petId),
      save: snapshot.engine.save,
    })
    this.hub.broadcast(petId, {
      t: 'ready',
      v: 1,
      revision: snapshot.pet.revision,
      eventSeq: snapshot.pet.eventSeq,
      gameTimeMs: snapshot.pet.gameTimeMs,
      timeZone: snapshot.settings.timeZone,
      advanceWhileEmpty: snapshot.settings.advanceWhileEmpty,
      authority: this.hub.authority(petId),
      catchingUp: false,
    })
  }

  health(petId: string): SchedulerPetHealth | undefined {
    const pet = this.store.getPet(petId)
    const authority = this.store.getAuthority(petId)
    if (pet === undefined || authority === undefined) return undefined
    const pending = this.store.listScheduledJobs(petId).filter(job => job.status === 'pending')
    let nextScheduledJobAtMs: number | null = null
    for (const job of pending) {
      if (nextScheduledJobAtMs === null || job.dueAtGameMs < nextScheduledJobAtMs) nextScheduledJobAtMs = job.dueAtGameMs
    }
    const now = this.now()
    const stuck = this.isStuck(petId)
    const coverage = this.store.listSessionCoverage(petId)
    let openCoverageIntervals = 0
    let lastCoverageHeartbeatMs: number | null = null
    for (const interval of coverage) {
      if (interval.disconnectedAtWallMs === undefined) openCoverageIntervals += 1
      if (lastCoverageHeartbeatMs === null || interval.lastHeartbeatWallMs > lastCoverageHeartbeatMs) {
        lastCoverageHeartbeatMs = interval.lastHeartbeatWallMs
      }
    }
    return {
      petId,
      ready: this.isReady(petId),
      catchingUp: this.isCatchUpBlocked(petId),
      gameTimeMs: pet.gameTimeMs,
      wallLagMs: Math.max(0, now - pet.lastSchedulerWallMs),
      nextTickAtMs: pet.lastSchedulerWallMs + GAME_TICK_MS,
      scheduledJobs: pending.length,
      nextScheduledJobAtMs,
      activeClientCount: this.hub.count(petId),
      activeSessionCount: this.hub.count(petId),
      authorityState: authority.state,
      authorityEpoch: authority.epoch,
      authorityId: authority.authorityId,
      restoreGeneration: authority.restoreGeneration,
      revision: pet.revision,
      commandSeq: pet.commandSeq,
      eventSeq: pet.eventSeq,
      commandLogSize: this.store.countCommands(petId),
      eventLogSize: this.store.countEvents(petId),
      lastSchedulerWallMs: pet.lastSchedulerWallMs,
      lastRunAtMs: this.lastRunAtMs,
      stuck,
      openCoverageIntervals,
      lastCoverageHeartbeatMs,
    }
  }

  healthAll(): SchedulerPetHealth[] {
    return this.store.listPets().map(pet => this.health(pet.id)).filter((value): value is SchedulerPetHealth => value !== undefined)
  }
}
