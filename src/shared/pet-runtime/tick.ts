import type { SharedSaveData } from '../sync/data-boundary'
import type { DomainEvent } from './events'
import { domainEvent } from './events'
import {
  applyGood,
  addTaskCount,
  cancelPendingJobs,
  cloneEngine,
  createRuntimeRng,
  currentGrowthPerMinute,
  earnYb,
  findSession,
  isBusy,
  localDate,
  mailGoods,
  mailSlot,
  readMails,
  readSignIn,
  recomputePetComputed,
  reject,
  writeMails,
  writeSharedBlob,
  writeSignIn,
  type RuntimeRng,
} from './runtime-helpers'
import { fatigue } from './stats'
import { resolveWeatherForDay, weatherStrain, withWeatherDay } from './environment'
import { dayKeyAt, nextDailyBoundaryMs } from './time'
import { STUDY_GOODS, WORK_GOODS } from './content/index'
import { applyTravelCompletion, travelEarlyRoll } from './travel'
import { selfCare } from './self-care'
import { resetDailyTasks } from './runtime-tasks'
import { resetFishLimits, settlePinkDiamond } from './handlers-b'
import type { EngineState, JsonObject, RuntimeContext } from './types'
import type { RuntimeBatchOutcome } from './runtime-types'
import { GAME_MINUTE_MS } from './time'

const DAY_SECONDS = 86_400
const MAX_DAILY_BOUNDARIES_PER_TICK = 4

function event(type: string, payload: JsonObject): DomainEvent {
  return domainEvent(type, payload)
}

function mergeEnvironment(state: EngineState, ctx: RuntimeContext): void {
  const calendarByDay = { ...state.environment.calendarByDay, ...ctx.environment.calendarByDay }
  const weatherByDay = { ...state.environment.weatherByDay, ...ctx.environment.weatherByDay }
  state.environment = { calendarByDay, weatherByDay }
}

function resolveWeather(state: EngineState, gameTimeMs: number): ReturnType<typeof resolveWeatherForDay> {
  const dayKey = dayKeyAt(gameTimeMs, state.timeZone)
  const existing = state.environment.weatherByDay[dayKey]
  if (existing !== undefined) return existing
  const fallback = resolveWeatherForDay(state.environment, state.rng.seedHex, dayKey, gameTimeMs)
  state.environment = withWeatherDay(state.environment, fallback)
  return fallback
}

function resetSignInAtBoundary(save: SharedSaveData): void {
  const signin = readSignIn(save)
  signin.getGrowth = null
  if (save.petInfo.onLineTime > 10) signin.getBirthDayGift = false
  signin.isOnlineLastTime = 20
  signin.onlineGiftNum = 0
  writeSignIn(save, signin)
}

function deliverMails(state: EngineState, boundaryMs: number, dayKey: string, rng: RuntimeRng): DomainEvent[] {
  const save = state.save
  const mails = readMails(save)
  const due: { key: string; title: string; moodMessage: string; yb: number }[] = []
  const liveUnclaimed = Object.values(mails).some(mail => ('e' in mail) === false)
  if (liveUnclaimed === false) due.push({ key: 'welcome', title: '欢迎来到QQ宠物~', moodMessage: '欢迎回家', yb: 100 })
  const local = localDate(boundaryMs, state.timeZone)
  const born = localDate(save.petInfo.birthDay * 1000, state.timeZone)
  const years = local.year - born.year
  if (years > 0 && local.month === born.month && local.day === born.day) {
    due.push({ key: 'birthday-' + String(local.year), title: save.petInfo.name + '的' + String(years) + '周岁生日快乐！', moodMessage: '生日快乐', yb: 300 })
  }
  const holiday = state.environment.calendarByDay?.[dayKey]?.holiday
  if (holiday?.off) {
    due.push({ key: String(local.year) + '-' + holiday.name, title: holiday.name + '快乐！', moodMessage: holiday.name + '快乐', yb: 200 })
  }
  const arrivals: DomainEvent[] = []
  let changed = false
  for (const mail of due) {
    if (Object.values(mails).some(existing => 'e' in existing ? existing.k === mail.key : existing.k === mail.key)) continue
    const slot = mailSlot(mails, boundaryMs)
    mails[String(slot)] = {
      d: slot,
      k: mail.key,
      l: mail.title,
      m: mail.moodMessage,
      glb: mailGoods(save, mail.yb, rng),
    }
    changed = true
    arrivals.push(event('mail.arrived', { mailId: String(slot), title: mail.title }))
  }
  if (changed) writeMails(save, mails)
  return arrivals
}

function settleVipAtBoundary(save: SharedSaveData, boundaryMs: number): void {
  const today = Math.floor(boundaryMs / 1000)
  if (save.petInfo.pinkDiamond) {
    save.petInfo.PDgrowth += (save.petInfo.PDgrowthValue * (Math.min(today, save.petInfo.PDiamondExpirationDate) - save.petInfo.PDiamondBeginDate)) / DAY_SECONDS
    save.petInfo.PDiamondBeginDate = today
    settlePinkDiamond(save, today)
  }
  if (save.petInfo.sweetHeartOverTime <= today) {
    save.petInfo.sweetHeartOverTime = 0
    save.petInfo.sweetHeart = false
  }
}

function runDailyBoundary(state: EngineState, boundaryMs: number, dayKey: string, rng: RuntimeRng): DomainEvent[] {
  const events: DomainEvent[] = []
  settleVipAtBoundary(state.save, boundaryMs)
  resetDailyTasks(state.save, boundaryMs, state.timeZone, rng, state.environment.calendarByDay?.[dayKey])
  resetSignInAtBoundary(state.save)
  resetFishLimits(state.save)
  events.push(event('task.progress', { dailyReset: true, dayKey }))
  events.push(event('signin.changed', { dailyReset: true, dayKey }))
  events.push(event('fishing.changed', { dailyReset: true, dayKey }))
  events.push(event('vip.changed', { kind: 'daily_settlement', dayKey }))
  events.push(...deliverMails(state, boundaryMs, dayKey, rng))
  state.lastProcessedDayBoundaryKey = dayKey
  return events
}

function completeActivityJob(state: EngineState, job: EngineState['scheduledJobs'][number]): DomainEvent[] {
  const save = state.save
  const events: DomainEvent[] = []
  const kind = job.payload.activityKind
  const activityId = job.payload.activityId
  if (kind === 'work' && typeof activityId === 'string') {
    const good = WORK_GOODS.find(candidate => candidate.id === activityId)
    if (good !== undefined) {
      const yb = earnYb(save, good.yb ?? 0)
      applyGood(save, good)
      addTaskCount(save, 'Work', 1)
      events.push(event('reward.granted', { source: 'work', yb }))
    }
    save.activeOption.work = null
    events.push(event('activity.completed', { kind: 'work', activityId }))
  } else if (kind === 'study' && typeof activityId === 'string') {
    const good = STUDY_GOODS.find(candidate => candidate.id === activityId)
    if (good !== undefined) {
      const subject = typeof good.value === 'string' ? good.value as keyof typeof save.studyInfo : undefined
      if (subject !== undefined) save.studyInfo[subject] += 1
      applyGood(save, good)
      addTaskCount(save, 'Study', 1)
      events.push(event('reward.granted', { source: 'study', subject: subject ?? '' }))
    }
    save.activeOption.study = null
    events.push(event('activity.completed', { kind: 'study', activityId, early: job.payload.early === 1 }))
  }
  writeSharedBlob(save, 'activity', 0)
  return events
}

function processDueJobs(state: EngineState, nowMs: number, rng: RuntimeRng): DomainEvent[] {
  const events: DomainEvent[] = []
  const due = state.scheduledJobs
    .filter(job => job.status === 'pending' && job.dueAtGameMs <= nowMs)
    .sort((a, b) => a.dueAtGameMs - b.dueAtGameMs || a.id - b.id)
  for (const job of due) {
    if (job.type === 'game-session') {
      job.status = 'completed'
      const token = typeof job.payload.sessionToken === 'string' ? job.payload.sessionToken : ''
      const session = findSession(state, token)
      if (session !== undefined && session.status === 'active') {
        session.status = 'expired'
        session.cancelReason = 'deadline_expired'
        events.push(event('game.sessionSettled', { kind: session.payload.kind, status: 'expired' }))
      }
      continue
    }
    if (job.type === 'travel') {
      const startedAt = typeof job.payload.startedAtGameMs === 'number' ? job.payload.startedAtGameMs : job.dueAtGameMs - 60 * 60_000
      const elapsed = (nowMs - startedAt) / 60_000
      if (elapsed > 60) {
        job.status = 'completed'
        const destination = typeof job.payload.activityId === 'string' ? job.payload.activityId : ''
        events.push(...applyTravelCompletion(state, destination, false, nowMs, rng))
      }
      continue
    }
    if (job.type === 'work' || job.type === 'study') {
      job.status = 'completed'
      events.push(...completeActivityJob(state, job))
      continue
    }
    job.status = 'completed'
  }
  return events
}

function syncActivityProjection(state: EngineState): number | null {
  const save = state.save
  const pending = state.scheduledJobs
    .filter(job => job.status === 'pending' && (job.type === 'work' || job.type === 'study' || job.type === 'travel'))
    .sort((a, b) => a.id - b.id)
  const job = pending[0]
  if (job === undefined) {
    if (save.activeOption.work !== null) save.activeOption.work = null
    if (save.activeOption.study !== null) save.activeOption.study = null
    if (save.activeOption.trip !== null) save.activeOption.trip = null
    if (save.saveJsonData.activity !== undefined && save.saveJsonData.activity !== '0') {
      writeSharedBlob(save, 'activity', 0)
    }
    return null
  }
  const kind = job.payload.activityKind
  const activityId = typeof job.payload.activityId === 'string' ? job.payload.activityId : ''
  if (kind === 'work') {
    save.activeOption.work = activityId
    save.activeOption.study = null
    save.activeOption.trip = null
  } else if (kind === 'study') {
    save.activeOption.study = activityId
    save.activeOption.work = null
    save.activeOption.trip = null
  } else if (kind === 'travel') {
    save.activeOption.trip = activityId
    save.activeOption.work = null
    save.activeOption.study = null
  }
  const startedAtGameMs = typeof job.payload.startedAtGameMs === 'number' ? job.payload.startedAtGameMs : state.gameTimeMs
  const planned = Math.max(0, (job.dueAtGameMs - startedAtGameMs) / 60_000)
  const elapsed = Math.max(0, Math.min(planned, (state.gameTimeMs - startedAtGameMs) / 60_000))
  const value = Number(elapsed.toFixed(5))
  writeSharedBlob(save, 'activity', value)
  return value
}

function tickTimedGoods(save: SharedSaveData, elapsed: number, events: DomainEvent[]): void {
  for (const type of ['background', 'food', 'clean', 'toy'] as const) {
    const timed = save.selfGoodUseOption[type]
    if (timed === null) continue
    const left = timed.left - elapsed
    if (left <= 0) {
      save.selfGoodUseOption[type] = null
      events.push(event('item.consumed', { type, id: timed.id, expired: true }))
    } else {
      save.selfGoodUseOption[type] = { id: timed.id, left }
    }
  }
}

function sessionClockTick(state: EngineState, ctx: RuntimeContext): DomainEvent[] {
  if (ctx.sessionActive === false || ctx.activeClientCount <= 0) return []
  state.save.petInfo.onLineTime += 1
  state.save.petInfo.onlineDataTime += 1
  const signin = readSignIn(state.save)
  signin.isOnlineLastTime = Math.max(0, signin.isOnlineLastTime - 1)
  writeSignIn(state.save, signin)
  return []
}

function illnessTick(state: EngineState, weather: ReturnType<typeof resolveWeatherForDay>, rng: RuntimeRng): DomainEvent[] {
  const save = state.save
  const busy = isBusy(save)
  const tired = fatigue({
    health: save.petInfo.health,
    mood: save.petInfo.mood,
    moodMax: save.petComputedlInfo.moodMax,
    clean: save.petInfo.clean,
    cleanMax: save.petComputedlInfo.cleanMax,
    hunger: save.petInfo.hunger,
    hungerMax: save.petComputedlInfo.hungerMax,
    busy,
    strong: save.petInfo.strong,
    level: save.petComputedlInfo.level,
  })
  const events: DomainEvent[] = []
  if (tired > 0) {
    if (save.petInfo.health !== 5) {
      if (rng.randIntInclusive(0, Math.max(1, (700 - tired * 50) * 8)) < 5) {
        const previousHealth = save.petInfo.health
        save.petInfo.health = Math.max(0, save.petInfo.health - 1)
        events.push(event('pet.illnessChanged', { health: save.petInfo.health }))
        if (previousHealth > 0 && save.petInfo.health === 0) events.push(event('pet.died', { reason: 'illness' }))
      }
    } else {
      const harsh = weatherStrain(weather)
      if (rng.chance(tired * tired * (1 + harsh) * 1e-5)) {
        save.activeOption.ill = String(harsh ? 1 : rng.randIntInclusive(0, 2)) + '-'
        save.petInfo.health = 4
        events.push(event('pet.illnessChanged', { health: 4, weatherStrain: harsh }))
      }
    }
  }
  if (save.petInfo.health === 0 && save.settings.undying) {
    save.petInfo.health = 5
    save.activeOption.ill = null
    events.push(event('pet.illnessChanged', { health: 5, undying: true }))
  }
  return events
}

function passiveMinute(state: EngineState, ctx: RuntimeContext, weather: ReturnType<typeof resolveWeatherForDay>, rng: RuntimeRng): DomainEvent[] {
  const save = state.save
  const events: DomainEvent[] = []
  const busy = isBusy(save)
  const moodRate = rng.randIntInclusive(1, 2) + (busy ? 1 : 0)
  const hungerRate = rng.randIntInclusive(2, 3) + (busy ? 1 : 0)
  const cleanRate = rng.randIntInclusive(2, 3) + (busy ? 1 : 0)
  const grown = save.petInfo.mood <= 0 ? 0 : Math.min(1, save.petInfo.mood / moodRate)
  if (grown < 1 && busy) {
    cancelPendingJobs(state, job => job.payload.activityKind === 'work' || job.payload.activityKind === 'study' || job.payload.activityKind === 'travel')
    save.activeOption.work = null
    save.activeOption.study = null
    save.activeOption.trip = null
    writeSharedBlob(save, 'activity', 0)
    events.push(event('activity.completed', { kind: 'all', cancelled: true, reason: 'mood_empty' }))
  }
  save.petInfo.mood = Math.max(save.petInfo.mood - moodRate, 0)
  save.petInfo.hunger = Math.max(save.petInfo.hunger - hungerRate, 0)
  save.petInfo.clean = Math.max(save.petInfo.clean - cleanRate, 0)
  save.petInfo.growth = Number((save.petInfo.growth + currentGrowthPerMinute(save) * grown).toFixed(8))
  const levels = recomputePetComputed(save)
  if (levels.level !== levels.previousLevel) {
    events.push(event('pet.levelChanged', { previousLevel: levels.previousLevel, level: levels.level }))
  }
  events.push(...selfCare(state))
  syncActivityProjection(state)
  const travelJob = state.scheduledJobs.find(job =>
    job.status === 'pending' && job.type === 'travel',
  )
  if (travelJob !== undefined) {
    const destination = typeof travelJob.payload.activityId === 'string' ? travelJob.payload.activityId : ''
    const startedAt = typeof travelJob.payload.startedAtGameMs === 'number'
      ? travelJob.payload.startedAtGameMs
      : travelJob.dueAtGameMs - 60 * 60_000
    const elapsed = (state.gameTimeMs - startedAt) / 60_000
    const early = elapsed > 55 ? travelEarlyRoll(save, rng) : false
    if (early || elapsed >= 60 || state.gameTimeMs >= travelJob.dueAtGameMs) {
      travelJob.status = 'completed'
      events.push(...applyTravelCompletion(state, destination, early, state.gameTimeMs, rng))
    }
  }
  tickTimedGoods(save, grown, events)
  events.push(...sessionClockTick(state, ctx))
  events.push(...illnessTick(state, weather, rng))
  events.push(event('pet.statsChanged', {
    hunger: save.petInfo.hunger,
    clean: save.petInfo.clean,
    health: save.petInfo.health,
    mood: save.petInfo.mood,
    growth: save.petInfo.growth,
    onLineTime: save.petInfo.onLineTime,
  }))
  return events
}

export function advanceMinuteInPlace(state: EngineState, ctx: RuntimeContext): DomainEvent[] {
  mergeEnvironment(state, ctx)
  const nextGameTimeMs = state.gameTimeMs + GAME_MINUTE_MS
  state.gameTimeMs = nextGameTimeMs
  state.save.nowTimeLine = Math.floor(nextGameTimeMs / 1000)
  if (state.save.settings.paused || state.save.petInfo.health <= 0 || state.save.isBury) {
    for (const job of state.scheduledJobs) {
      if (job.status === 'pending') {
        job.dueAtGameMs += GAME_MINUTE_MS
        if (typeof job.payload.startedAtGameMs === 'number') job.payload.startedAtGameMs += GAME_MINUTE_MS
      }
    }
    for (const session of state.gameSessions) {
      if (session.status === 'active') session.expiresAtGameMs += GAME_MINUTE_MS
    }
    state.nextDailyBoundaryMs += GAME_MINUTE_MS
    syncActivityProjection(state)
    return []
  }
  const rng = createRuntimeRng(state.rng)
  const events: DomainEvent[] = []
  const weather = resolveWeather(state, nextGameTimeMs)
  let boundaries = 0
  while (nextGameTimeMs >= state.nextDailyBoundaryMs) {
    boundaries++
    if (boundaries > MAX_DAILY_BOUNDARIES_PER_TICK) reject('internal', 'too many daily boundaries in one tick')
    const boundaryKey = dayKeyAt(state.nextDailyBoundaryMs, state.timeZone)
    if (boundaryKey !== state.lastProcessedDayBoundaryKey) {
      events.push(...runDailyBoundary(state, state.nextDailyBoundaryMs, boundaryKey, rng))
    }
    state.nextDailyBoundaryMs = nextDailyBoundaryMs(state.nextDailyBoundaryMs, state.timeZone)
  }
  events.push(...processDueJobs(state, nextGameTimeMs, rng))
  events.push(...passiveMinute(state, ctx, weather, rng))
  state.rng = rng.state
  return events
}

export function advanceMinute(state: EngineState, ctx: RuntimeContext): RuntimeBatchOutcome {
  const candidate = cloneEngine(state)
  const events = advanceMinuteInPlace(candidate, ctx)
  return { ok: true, state: candidate, events, ticks: 1 }
}

export function advanceRuntimeMinutes(
  state: EngineState,
  ctx: RuntimeContext,
  minutes: number,
  maxBatchMinutes = 1440,
): RuntimeBatchOutcome {
  if (Number.isSafeInteger(minutes) === false || minutes < 0) reject('invalid_payload', 'minutes must be a non-negative integer')
  if (minutes > maxBatchMinutes) reject('invalid_payload', 'batch exceeds the bounded tick limit')
  let candidate = cloneEngine(state)
  const events: DomainEvent[] = []
  for (let tick = 0; tick < minutes; tick++) {
    events.push(...advanceMinuteInPlace(candidate, ctx))
  }
  return { ok: true, state: candidate, events, ticks: minutes }
}
