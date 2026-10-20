import type { CommandPayloadMap } from '../sync/protocol'
import { FRIES, type FryDefinition } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import type { HandlerContext, HandlerResult } from './handler-types'
import {
  earnYb,
  payYb,
  readPond,
  reject,
  requireLivingPet,
  writePond,
  type FishState,
  type PondState,
} from './runtime-helpers'
import { stableStringify } from './serialization'
import type { JsonObject, JsonValue } from './types'

const FEED_PRICE = 10
const MASTER = 1000
const INT_MAX = 0x7fffffff

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function event(type: string, payload: JsonObject): DomainEvent {
  return domainEvent(type, payload)
}

function nowSeconds(context: HandlerContext): number {
  return Math.floor(context.ctx.gameTimeMs / 1000)
}

function ripe(fish: FishState): boolean {
  return fish.stage >= 3
}

function grow(fish: FishState, now: number): void {
  if (ripe(fish)) return
  const age = now - fish.born + 3600 * fish.siLiao
  const stageCount = Math.min(Math.floor(age / fish.interval), 2)
  fish.stage = stageCount + 1
  fish.time = stageCount === 2 ? 0 : age - stageCount * fish.interval
}

function normalizeIds(pond: PondState): void {
  let next = Math.max(0, ...pond.fishs.map(fish => fish.id > INT_MAX ? 0 : fish.id))
  for (const fish of pond.fishs) {
    if (fish.id > INT_MAX) fish.id = ++next
  }
}

function settle(pond: PondState, now: number): void {
  normalizeIds(pond)
  for (const fish of pond.fishs) grow(fish, now)
}

function requirePondReady(context: HandlerContext): PondState {
  requireLivingPet(context.state)
  if (context.ctx.actorDeviceId === null) reject('unauthorized', 'an authenticated actor is required')
  if (context.state.save.settings.paused) reject('paused', 'the pet is paused')
  const pond = readPond(context.state.save)
  settle(pond, nowSeconds(context))
  return pond
}

function changed(context: HandlerContext, pond: PondState, action: string, extra: JsonObject = {}): DomainEvent {
  writePond(context.state.save, pond)
  return event('fishing.changed', { action, yb: context.state.save.petInfo.yb, fishCount: pond.fishs.length, ...extra })
}

function harvestAchievement(context: HandlerContext, count: number): DomainEvent[] {
  const total = context.state.save.gameSaveDatas.fishing_harvestfish + count
  if (total < MASTER) {
    context.state.save.gameSaveDatas.fishing_harvestfish = total
    return []
  }
  context.state.save.gameSaveDatas.fishing_harvestfish = total - MASTER
  context.state.save.gameSaveDatas.yyds += 1
  return [event('achievement.unlocked', { achievement: 'fish-master', total: context.state.save.gameSaveDatas.yyds })]
}

function findFry(fryId: number): FryDefinition | null {
  return FRIES.find(fry => fry.fryid === fryId) ?? null
}

function pondCap(context: HandlerContext): number {
  return context.state.save.petInfo.pinkDiamond ? 5 : 3
}

export function fishingBuy(context: HandlerContext, payload: CommandPayloadMap['fishing.buy']): HandlerResult {
  const pond = requirePondReady(context)
  const fry = findFry(payload.fryId)
  if (fry === null) reject('not_available', 'unknown fry')
  const room = pondCap(context) - pond.fishs.length
  if (room <= 0) reject('busy', 'the pond is full')
  const quantity = Math.min(payload.quantity, room)
  const cost = fry.price_yb * quantity
  payYb(context.state.save, cost)
  const now = nowSeconds(context)
  let base = Math.max(now, ...pond.fishs.map(fish => fish.id + 1))
  const ids: number[] = []
  for (let index = 0; index < quantity; index++) {
    const id = base++
    ids.push(id)
    pond.fishs.push({
      id, fryid: fry.fryid, name: fry.name, stage: 1, time: 0, interval: fry.interval,
      costyb: fry.price_yb, YB: fry.sell_price, quantity: fry.quantity, basequantity: fry.quantity,
      avatar: fry.avator, AIXIN: 0, growth: 0, strong: 0, iq: 0, charm: 0, born: now, siLiao: 0,
    })
  }
  return {
    result: json({ fryId: payload.fryId, quantity, cost, fishIds: ids }),
    events: [changed(context, pond, 'buy', { fryId: payload.fryId, quantity, cost })],
  }
}

export function fishingFeed(context: HandlerContext, payload: CommandPayloadMap['fishing.feed']): HandlerResult {
  const pond = requirePondReady(context)
  const fish = pond.fishs.find(candidate => candidate.id === payload.fishId)
  if (fish === undefined) reject('not_available', 'fish was not found')
  if (ripe(fish)) reject('already_claimed', 'the fish is already ripe')
  payYb(context.state.save, FEED_PRICE)
  fish.siLiao++
  grow(fish, nowSeconds(context))
  return {
    result: json({ fishId: fish.id, stage: fish.stage, time: fish.time, feed: fish.siLiao }),
    events: [changed(context, pond, 'feed', { fishId: fish.id, cost: FEED_PRICE })],
  }
}

export function fishingHarvest(context: HandlerContext, payload: CommandPayloadMap['fishing.harvest']): HandlerResult {
  const pond = requirePondReady(context)
  const index = pond.fishs.findIndex(candidate => candidate.id === payload.fishId)
  if (index < 0) reject('not_available', 'fish was not found')
  const fish = pond.fishs[index]
  const fishRipe = ripe(fish)
  const amount = fishRipe ? fish.YB * fish.quantity : Math.floor(fish.costyb / 2)
  if (amount <= 0) reject('not_available', 'fish has no harvest value')
  pond.fishs.splice(index, 1)
  const yb = earnYb(context.state.save, amount)
  const achievement = fishRipe ? harvestAchievement(context, 1) : []
  return {
    result: json({ fishId: payload.fishId, ripe: fishRipe, yb }),
    events: [changed(context, pond, 'harvest', { fishId: payload.fishId, ripe: fishRipe, yb }), ...achievement],
  }
}

export function fishingHarvestAll(context: HandlerContext): HandlerResult {
  const pond = requirePondReady(context)
  if (pond.fishs.length === 0) reject('not_available', 'the pond is empty')
  const sold = pond.fishs.filter(ripe)
  if (sold.length === 0) reject('not_available', 'there are no ripe fish')
  const amount = sold.reduce((sum, fish) => sum + fish.YB * fish.quantity, 0)
  pond.fishs = pond.fishs.filter(fish => ripe(fish) === false)
  const yb = earnYb(context.state.save, amount)
  const achievement = harvestAchievement(context, sold.length)
  return {
    result: json({ harvested: sold.length, yb }),
    events: [changed(context, pond, 'harvestAll', { harvested: sold.length, yb }), ...achievement],
  }
}

export function fishingSpeedUp(context: HandlerContext): HandlerResult {
  const pond = requirePondReady(context)
  if (pond.PD.canusecnt <= 0) reject('not_available', 'no pink-diamond speed-ups remain')
  if (pond.fishs.length === 0) reject('not_available', 'the pond is empty')
  const now = nowSeconds(context)
  for (const fish of pond.fishs) {
    fish.siLiao++
    grow(fish, now)
  }
  pond.PD.canusecnt--
  return {
    result: json({ used: pond.PD.allvipcnt - pond.PD.canusecnt, remaining: pond.PD.canusecnt }),
    events: [changed(context, pond, 'speedUp', { remaining: pond.PD.canusecnt })],
  }
}

/** Minute-scheduler hook for pond maturity; no-op until a canonical pond blob exists. */
export function tickFishingState(state: import('./types').EngineState, nowMs: number): DomainEvent[] {
  const raw = state.save.saveJsonData.fishs
  if (raw === undefined || raw === '{}') return []
  const pond = readPond(state.save)
  if (pond.fishs.length === 0) return []
  const before = stableStringify(pond)
  settle(pond, Math.floor(nowMs / 1000))
  writePond(state.save, pond)
  if (stableStringify(pond) === before) return []
  return [event('fishing.changed', { action: 'tick', fishCount: pond.fishs.length })]
}
