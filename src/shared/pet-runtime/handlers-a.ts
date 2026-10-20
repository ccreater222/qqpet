import type { CommandPayloadMap } from '../sync/protocol'
import type { Sex } from '../save'
import type { SharedSaveData } from '../sync/data-boundary'
import { createRngState } from './rng'
import { dayKeyAt, nextDailyBoundaryMs } from './time'
import { levelAndCapsOf } from './level'
import { domainEvent } from './events'
import {
  addTaskCount,
  assertOwnerRole,
  parseRewardCodes,
  reject,
  requirePet,
  requireLivingPet,
  grantGoods,
  type RuntimeRng,
} from './runtime-helpers'
import type { HandlerContext, HandlerResult } from './handler-types'
import type { EngineState, JsonValue } from './types'

const STARTER_GOODS = [
  '_10013006*2', '_102010001*3', '_10021008*2', '_10021005*2', '_60001*2', '_50001*1',
  '_b0000000*1', '_b0000001*1', '_t0002*1',
]

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function zeroStudyInfo(): SharedSaveData['studyInfo'] {
  return { chinese: 0, mathematics: 0, politics: 0, music: 0, art: 0, manner: 0, pe: 0, labouring: 0, wushu: 0 }
}

function emptyJsonData(): Record<string, string> {
  return {
    email: '{}', task: '{}', signin: '{}', fishs: '{}', farm: '{}', activity: '0', album: '[]', island: '{}',
  }
}

export function emptyEggSave(previous: SharedSaveData): SharedSaveData {
  return {
    havePet: false,
    isBury: false,
    saveNum: 0,
    nowTimeLine: 0,
    petInfo: {
      name: '宠宝~', host: '主人~', sex: 'GG', growth: 0, hunger: 0, clean: 0, health: 0, mood: 0,
      birthDay: 1, intel: 0, charm: 0, strong: 0, onLineTime: 0, yb: 0, lastLoginTime: 0,
      onlineDataTime: 0, pinkDiamond: false, PDgrowth: 0, PDgrowthValue: 0, PDgrowthValue_next: 0,
      PDiamondLevel: 0, PDiamondBeginDate: 0, PDiamondExpirationDate: 0, PDiamondYear: false,
      sweetHeart: false, sweetHeartOverTime: 0,
    },
    petComputedlInfo: { level: 1, upGrowth: 0, nextGrowth: 125, hungerMax: 1100, cleanMax: 1100, healthMax: 5, moodMax: 1000 },
    studyInfo: zeroStudyInfo(),
    activeOption: { work: null, study: null, trip: null, ill: null, die: null },
    selfGoodDatas: {
      food: [], clean: [], medicine: [], background: [], toy: [], nums: [], service: [], work: [], study: [], trip: [],
    },
    selfGoodUseOption: { background: null, food: null, clean: null, toy: null },
    gameSaveDatas: { fishing_harvestfish: 0, travel_china: [], travel_china_num: 0, ddw: 0, yyds: 0 },
    illustrated: [],
    saveJsonData: emptyJsonData(),
    settings: { ...previous.settings },
  }
}

function newbornSave(previous: SharedSaveData, sex: Sex, gameTimeMs: number, rng: RuntimeRng): SharedSaveData {
  const save = emptyEggSave(previous)
  const nowTimeLine = Math.floor(gameTimeMs / 1000)
  save.havePet = true
  save.saveNum = previous.saveNum + 1
  save.nowTimeLine = nowTimeLine
  save.petInfo = {
    ...save.petInfo,
    sex,
    growth: 1,
    hunger: 1100,
    clean: 1100,
    health: 5,
    mood: 1000,
    birthDay: nowTimeLine,
    intel: rng.randIntInclusive(5, 50),
    charm: rng.randIntInclusive(5, 50),
    strong: rng.randIntInclusive(5, 50),
    yb: 5000,
  }
  const levels = levelAndCapsOf(save.petInfo.growth)
  save.petComputedlInfo = {
    level: levels.level,
    upGrowth: levels.upGrowth,
    nextGrowth: levels.nextGrowth,
    hungerMax: levels.hungerMax,
    cleanMax: levels.cleanMax,
    healthMax: 5,
    moodMax: 1000,
  }
  save.illustrated = []
  grantGoods(save, parseRewardCodes(STARTER_GOODS))
  return save
}

function resetEngineForNewPet(state: EngineState, resetRng = true): void {
  const wall = state.lastSchedulerWallMs
  for (const interval of state.sessionCoverage) {
    if (interval.disconnectedAtWallMs === undefined) {
      interval.disconnectedAtWallMs = wall
      interval.lastHeartbeatWallMs = wall
      interval.closeReason = 'pet_reset'
    }
  }
  state.sessionCoverage = []
  delete state.coverageReopen
  state.scheduledJobs = []
  state.gameSessions = []
  state.nextScheduledJobId = 1
  if (resetRng) state.rng = createRngState(state.rng.seedHex)
  state.lastProcessedDayBoundaryKey = dayKeyAt(state.gameTimeMs, state.timeZone)
  state.nextDailyBoundaryMs = nextDailyBoundaryMs(state.gameTimeMs, state.timeZone)
}

export function adoptPet(context: HandlerContext, payload: CommandPayloadMap['pet.adopt']): HandlerResult {
  assertOwnerRole(context.ctx.actorRole)
  if (context.state.save.havePet) reject('wrong_phase', 'a pet already exists')
  context.state.save = newbornSave(context.state.save, payload.sex, context.ctx.gameTimeMs, context.rng)
  resetEngineForNewPet(context.state, false)
  return {
    result: json({ sex: payload.sex }),
    events: [
      domainEvent('pet.statsChanged', { adopted: true, sex: payload.sex, growth: 1 }),
      domainEvent('reward.granted', { source: 'starter-kit', count: STARTER_GOODS.length }),
    ],
  }
}

export function resetPet(context: HandlerContext): HandlerResult {
  assertOwnerRole(context.ctx.actorRole)
  const settings = context.state.save.settings
  context.state.save = emptyEggSave(context.state.save)
  context.state.save.settings = settings
  resetEngineForNewPet(context.state)
  return {
    result: json({ havePet: false }),
    events: [domainEvent('system.snapshotBoundary', { reason: 'pet_reset' })],
  }
}

export function buryPet(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  if (context.state.save.isBury) reject('already_claimed', 'the pet is already buried')
  if (context.state.save.petInfo.health > 0) reject('wrong_phase', 'only a dead pet may be buried')
  context.state.save.isBury = true
  return { events: [domainEvent('pet.died', { reason: 'buried' })] }
}

export function renamePet(context: HandlerContext, payload: CommandPayloadMap['pet.rename']): HandlerResult {
  requirePet(context.state)
  if (payload.name === undefined && payload.host === undefined) reject('invalid_payload', 'at least one name is required')
  if (payload.name !== undefined) {
    const name = payload.name.trim()
    if (name.length === 0 || name.length > 20 || /[\u0000-\u001F\u007F]/.test(name)) reject('invalid_payload', 'invalid pet name')
    context.state.save.petInfo.name = name
  }
  if (payload.host !== undefined) {
    const host = payload.host.trim()
    if (host.length === 0 || host.length > 20 || /[\u0000-\u001F\u007F]/.test(host)) reject('invalid_payload', 'invalid host name')
    context.state.save.petInfo.host = host
  }
  return {
    result: json({ name: context.state.save.petInfo.name, host: context.state.save.petInfo.host }),
    events: [domainEvent('pet.statsChanged', { renamed: true })],
  }
}

export function setPetPaused(context: HandlerContext, payload: CommandPayloadMap['pet.setPaused']): HandlerResult {
  requirePet(context.state)
  context.state.save.settings.paused = payload.paused
  return {
    result: json({ paused: payload.paused }),
    events: [domainEvent('system.snapshotBoundary', { paused: payload.paused })],
  }
}

export function pokeFace(context: HandlerContext, payload: CommandPayloadMap['pet.pokeFace']): HandlerResult {
  requireLivingPet(context.state)
  if (payload.spotId.trim().length === 0) reject('invalid_payload', 'spotId must not be empty')
  const mood = context.rng.randIntInclusive(5, 15)
  context.state.save.petInfo.mood = Math.min(context.state.save.petComputedlInfo.moodMax, context.state.save.petInfo.mood + mood)
  context.state.save.gameSaveDatas.ddw += 1
  const task = addTaskCount(context.state.save, 'Amusing', 1)
  return {
    result: json({ mood, ddw: context.state.save.gameSaveDatas.ddw, amusing: task.doNums.Amusing ?? 0 }),
    events: [
      domainEvent('pet.statsChanged', { mood: context.state.save.petInfo.mood }),
      domainEvent('task.progress', { counter: 'Amusing', amount: 1 }),
    ],
  }
}

export function cheerPet(context: HandlerContext): HandlerResult {
  requireLivingPet(context.state)
  const mood = context.rng.randIntInclusive(5, 15)
  context.state.save.petInfo.mood = Math.min(context.state.save.petComputedlInfo.moodMax, context.state.save.petInfo.mood + mood)
  return {
    result: json({ mood }),
    events: [domainEvent('pet.statsChanged', { mood: context.state.save.petInfo.mood })],
  }
}
