import type { CommandPayloadMap } from '../sync/protocol'
import type { SharedSaveData } from '../sync/data-boundary'
import { DEAD, illOf, type Ill } from './content/ills'
import { TRAVEL_PROVINCES, goodOf, goodMatchesType, type GoodType, type RuntimeGood } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import {
  addGood,
  addTaskCount,
  applyGood,
  assertGoodType,
  currentBoundarySeconds,
  inventoryCount,
  isBusy,
  payYb,
  readPond,
  readTaskProgress,
  reject,
  requireLivingPet,
  requirePet,
  startTimedGood,
  takeGood,
  writePond,
  writeTaskProgress,
} from './runtime-helpers'
import type { HandlerContext, HandlerResult } from './handler-types'
import type { JsonValue } from './types'

const PD_LEVELS = [0, 100, 300, 800, 1200, 2800, 5800, 99_999_999]
const DAY_SECONDS = 86_400
const PD_DAY_PRICE = 300
const SWEETHEART_DAY_PRICE = 300

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function goodSummary(good: RuntimeGood): Record<string, JsonValue> {
  return { id: good.id, type: good.type, name: good.name, num: good.num }
}

function memberPrice(save: SharedSaveData, good: RuntimeGood): number {
  if (good.price === undefined || good.price < 0) return -1
  return save.petInfo.pinkDiamond ? Math.round(good.price * 0.8) : good.price
}

export function buyInventoryItem(context: HandlerContext, payload: CommandPayloadMap['inventory.buy']): HandlerResult {
  requireLivingPet(context.state)
  assertGoodType(payload.type)
  if (goodMatchesType(payload.type, payload.itemId) === false) reject('not_available', 'unknown good for that inventory type')
  const good = goodOf(payload.type as GoodType, payload.itemId)
  if ((good.needLevel ?? 0) > context.state.save.petComputedlInfo.level) reject('not_available', 'pet level is too low')
  if (good.PD === true && context.state.save.petInfo.pinkDiamond === false) reject('not_available', 'pink diamond membership required')
  const unit = memberPrice(context.state.save, good)
  if (unit < 0) reject('not_available', 'this good is not for sale')
  payYb(context.state.save, unit * payload.quantity)
  addGood(context.state.save, good, payload.quantity)
  return {
    result: json({ itemId: good.id, quantity: payload.quantity, paid: unit * payload.quantity }),
    events: [domainEvent('inventory.changed', { itemId: good.id, type: good.type, quantity: payload.quantity, purchased: true })],
  }
}

function useMedicine(context: HandlerContext, good: RuntimeGood, quantity: number): HandlerResult {
  const save = context.state.save
  const currentIll = typeof save.activeOption.ill === 'string' ? save.activeOption.ill : null
  let effectGood: Ill
  if (good.id === DEAD.cure.id) {
    if (save.petInfo.health !== 0) reject('wrong_phase', 'the revive medicine is only used after death')
    effectGood = DEAD
    save.petInfo.health = 5
    save.activeOption.ill = null
  } else {
    if (save.petInfo.health === 0) reject('pet_dead', 'this medicine cannot revive the pet')
    if (save.petInfo.health === 5) reject('not_available', 'the pet is not ill')
    effectGood = illOf((currentIll ?? '1-') + save.petInfo.health)
    if (good.id === effectGood.cure.id) {
      save.petInfo.health = 5
      save.activeOption.ill = null
    } else {
      save.petInfo.health = Math.max(0, save.petInfo.health - 1)
    }
  }
  takeGood(save, 'medicine', good.id, quantity)
  applyGood(save, good)
  return {
    result: json({ itemId: good.id, health: save.petInfo.health, correct: effectGood.cure.id === good.id }),
    events: [
      domainEvent('item.consumed', { itemId: good.id, type: 'medicine' }),
      domainEvent('pet.illnessChanged', { health: save.petInfo.health, cured: save.petInfo.health === 5 }),
    ],
  }
}

export function useInventoryItem(context: HandlerContext, payload: CommandPayloadMap['inventory.use']): HandlerResult {
  requirePet(context.state)
  assertGoodType(payload.type)
  if (goodMatchesType(payload.type, payload.itemId) === false) reject('not_available', 'unknown good for that inventory type')
  const quantity = payload.quantity ?? 1
  if (Number.isSafeInteger(quantity) === false || quantity <= 0) reject('invalid_payload', 'quantity must be positive')
  if (inventoryCount(context.state.save, payload.type as GoodType, payload.itemId) < quantity) {
    reject('insufficient_item', 'not enough goods in inventory')
  }
  const good = goodOf(payload.type as GoodType, payload.itemId, quantity)
  if (good.type === 'medicine') {
    if (quantity !== 1) reject('invalid_payload', 'medicine is used one at a time')
    return useMedicine(context, good, quantity)
  }
  if (context.state.save.petInfo.health === 0) reject('pet_dead', 'the pet is dead')
  if (good.type === 'nums') {
    const key = (good.useId ?? good.id) as 'yb' | 'growth' | 'health'
    if (key !== 'yb' && key !== 'growth' && key !== 'health') reject('not_available', 'unknown numeric good target')
    takeGood(context.state.save, good.type, good.id, quantity)
    const delta = (typeof good.value === 'number' ? good.value : 0) * quantity
    if (key === 'yb') context.state.save.petInfo.yb = Math.max(0, context.state.save.petInfo.yb + delta)
    else if (key === 'growth') context.state.save.petInfo.growth = Math.max(0, context.state.save.petInfo.growth + delta)
    else {
      context.state.save.petInfo.health = Math.max(0, Math.min(5, context.state.save.petInfo.health + delta))
      if (context.state.save.petInfo.health === 5) context.state.save.activeOption.ill = null
    }
    return {
      result: json({ itemId: good.id, quantity, [key]: context.state.save.petInfo[key] }),
      events: [domainEvent('item.consumed', { itemId: good.id, type: good.type, quantity }), domainEvent('pet.statsChanged', { [key]: context.state.save.petInfo[key] })],
    }
  }
  if (good.type !== 'food' && good.type !== 'clean' && good.type !== 'toy' && good.type !== 'background') {
    reject('not_available', 'this good cannot be used directly')
  }
  if (context.state.save.settings.paused && good.type !== 'background') reject('paused', 'the pet is paused')
  if (quantity !== 1) reject('invalid_payload', 'this good is used one at a time')
  takeGood(context.state.save, good.type, good.id, 1)
  const extraMood = good.type === 'food' || good.type === 'clean' ? 20 : 0
  applyGood(context.state.save, good, extraMood)
  if (good.useTimeing && (good.type === 'food' || good.type === 'clean' || good.type === 'toy' || good.type === 'background')) {
    startTimedGood(context.state.save, good, good.useTimeing)
  }
  const events: DomainEvent[] = [domainEvent('item.consumed', { itemId: good.id, type: good.type, quantity: 1 })]
  if (good.type === 'food') {
    addTaskCount(context.state.save, 'Eat', 1)
    events.push(domainEvent('task.progress', { counter: 'Eat', amount: 1 }))
  } else if (good.type === 'clean') {
    addTaskCount(context.state.save, 'Clean', 1)
    events.push(domainEvent('task.progress', { counter: 'Clean', amount: 1 }))
  } else if (good.type === 'toy') {
    addTaskCount(context.state.save, 'Toy', 1)
    events.push(domainEvent('task.progress', { counter: 'Toy', amount: 1 }))
  }
  events.push(domainEvent('pet.statsChanged', { hunger: context.state.save.petInfo.hunger, clean: context.state.save.petInfo.clean, mood: context.state.save.petInfo.mood }))
  return { result: json({ itemId: good.id, quantity: 1, ...goodSummary(good) }), events }
}

function cureForHealth(save: SharedSaveData): Ill {
  if (save.petInfo.health === 0) return DEAD
  const line = typeof save.activeOption.ill === 'string' ? save.activeOption.ill : '1-'
  return illOf(line + save.petInfo.health)
}

export function medicalTreat(context: HandlerContext, payload: CommandPayloadMap['medical.treat']): HandlerResult {
  requirePet(context.state)
  const save = context.state.save
  if (save.petInfo.health === 5) reject('not_available', 'the pet is healthy')
  const cure = cureForHealth(save)
  let medicine: RuntimeGood
  try {
    medicine = goodOf('medicine', cure.cure.id)
  } catch {
    reject('not_available', 'the required medicine is unavailable')
  }
  if (payload.mode === 'doctor') {
    if (save.petInfo.health > 0) {
      const fee = (5 - save.petInfo.health) * 10
      payYb(save, fee)
    }
    if (inventoryCount(save, 'medicine', medicine.id) > 0) {
      takeGood(save, 'medicine', medicine.id, 1)
    } else {
      const price = medicine.price === undefined ? 50 : medicine.price
      payYb(save, Math.round(price * 1.2))
    }
    applyGood(save, medicine)
    save.petInfo.health = 5
    save.activeOption.ill = null
    return {
      result: json({ cured: true, medicineId: medicine.id, health: 5 }),
      events: [
        domainEvent('item.consumed', { itemId: medicine.id, type: 'medicine', source: 'doctor' }),
        domainEvent('pet.illnessChanged', { health: 5, cured: true }),
      ],
    }
  }
  if (payload.itemId === undefined) reject('invalid_payload', 'itemId is required for owned treatment')
  if (inventoryCount(save, 'medicine', payload.itemId) === 0) reject('insufficient_item', 'the selected medicine is not owned')
  let owned: RuntimeGood
  try {
    owned = goodOf('medicine', payload.itemId)
  } catch {
    reject('invalid_payload', 'unknown medicine')
  }
  return useMedicine(context, owned, 1)
}

export function settlePinkDiamond(save: SharedSaveData, todaySec: number): void {
  const active = save.petInfo.PDiamondExpirationDate > todaySec
  save.petInfo.pinkDiamond = active
  if (active === false) {
    save.petInfo.PDiamondBeginDate = 0
    save.petInfo.PDiamondExpirationDate = 0
    save.petInfo.PDiamondYear = false
  }
  const level = Math.max(PD_LEVELS.filter(threshold => save.petInfo.PDgrowth >= threshold).length, 1)
  save.petInfo.PDiamondLevel = level
  save.petInfo.PDgrowthValue_next = PD_LEVELS[level] ?? PD_LEVELS[PD_LEVELS.length - 1]
}

export function resetFishLimits(save: SharedSaveData): void {
  const pond = readPond(save)
  pond.PD.allvipcnt = (save.petInfo.PDiamondLevel || 1) * 2
  pond.PD.canusecnt = save.petInfo.pinkDiamond ? pond.PD.allvipcnt : 0
  writePond(save, pond)
}

export function buyPinkDiamond(context: HandlerContext, payload: CommandPayloadMap['vip.buyPinkDiamond']): HandlerResult {
  requirePet(context.state)
  const save = context.state.save
  const today = currentBoundarySeconds(context.ctx.gameTimeMs, context.state.timeZone)
  payYb(save, payload.days * PD_DAY_PRICE)
  const extending = save.petInfo.pinkDiamond
  if (extending) {
    save.petInfo.PDiamondExpirationDate += payload.days * DAY_SECONDS
  } else {
    save.petInfo.PDiamondExpirationDate = today + payload.days * DAY_SECONDS
    save.petInfo.PDiamondBeginDate = today
  }
  if (payload.days >= 365) save.petInfo.PDiamondYear = true
  save.petInfo.PDgrowthValue = 20
  settlePinkDiamond(save, today)
  if (extending === false) resetFishLimits(save)
  return {
    result: json({ days: payload.days, expiration: save.petInfo.PDiamondExpirationDate, level: save.petInfo.PDiamondLevel }),
    events: [domainEvent('vip.changed', { kind: 'pink_diamond', active: save.petInfo.pinkDiamond, expiration: save.petInfo.PDiamondExpirationDate })],
  }
}

export function clearPinkDiamond(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const save = context.state.save
  const today = currentBoundarySeconds(context.ctx.gameTimeMs, context.state.timeZone)
  save.petInfo.PDiamondExpirationDate = 0
  save.petInfo.PDiamondBeginDate = 0
  settlePinkDiamond(save, today)
  return {
    result: json({ active: false }),
    events: [domainEvent('vip.changed', { kind: 'pink_diamond', active: false })],
  }
}

export function buySweetheart(context: HandlerContext, payload: CommandPayloadMap['vip.buySweetheart']): HandlerResult {
  requirePet(context.state)
  const save = context.state.save
  const now = currentBoundarySeconds(context.ctx.gameTimeMs, context.state.timeZone)
  payYb(save, payload.days * SWEETHEART_DAY_PRICE)
  const base = save.petInfo.sweetHeartOverTime > now ? save.petInfo.sweetHeartOverTime : now
  save.petInfo.sweetHeartOverTime = base + payload.days * DAY_SECONDS
  save.petInfo.sweetHeart = true
  return {
    result: json({ expiration: save.petInfo.sweetHeartOverTime }),
    events: [domainEvent('vip.changed', { kind: 'sweetheart', active: true, expiration: save.petInfo.sweetHeartOverTime })],
  }
}

export function setSweetheart(context: HandlerContext, payload: CommandPayloadMap['vip.setSweetheart']): HandlerResult {
  requirePet(context.state)
  const now = currentBoundarySeconds(context.ctx.gameTimeMs, context.state.timeZone)
  if (context.state.save.petInfo.sweetHeartOverTime <= now) reject('not_available', 'sweetheart membership is not active')
  context.state.save.petInfo.sweetHeart = payload.enabled
  return {
    result: json({ enabled: payload.enabled }),
    events: [domainEvent('vip.changed', { kind: 'sweetheart', active: payload.enabled })],
  }
}

export function completeTravelCollection(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const save = context.state.save
  if (save.gameSaveDatas.travel_china.length !== TRAVEL_PROVINCES.length) reject('not_available', 'not every province has been visited')
  if (isBusy(save)) reject('busy', 'the pet is busy')
  payYb(save, 8888)
  save.gameSaveDatas.travel_china_num += 1
  save.gameSaveDatas.travel_china = []
  const task = readTaskProgress(save)
  for (const entry of task.taskList.travel.slice(2)) entry.take = false
  writeTaskProgress(save, task)
  return {
    result: json({ travelCount: save.gameSaveDatas.travel_china_num, spent: 8888 }),
    events: [domainEvent('reward.granted', { source: 'travel_collection', travelCount: save.gameSaveDatas.travel_china_num })],
  }
}
