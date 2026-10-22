import type { CommandPayloadMap } from '../sync/protocol'
import { FARM_CROPS, FARM_FERTILIZERS, FARM_SEEDS, type FarmCropDefinition, type FarmSeedDefinition } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import type { HandlerContext, HandlerResult } from './handler-types'
import { earnYb, payYb, readSharedBlob, reject, requireLivingPet, writeSharedBlob } from './runtime-helpers'
import { stableStringify } from './serialization'
import type { EngineState, JsonObject, JsonValue } from './types'
import type { RuntimeRng } from './runtime-helpers'

const PEST_TIME = 14400
const PEST_LOSS = 2
const CARE_EXP = 2
const EXP_PER_RANK = 100

interface FarmLand {
  farmland: string
  crop?: string
  time?: number
  harvest?: string
  state?: number
  growth?: string
  progress?: number
  yield?: number
  grass?: number
  worm?: number
}
interface FarmBurden { name?: string; Items: string; number: number }
interface FarmWarehouse { fruit: string; number: number; name?: string; price?: number }
interface FarmState {
  house: string
  kennel: string
  fence: string
  experience: string | number
  rank: string | number
  burden: FarmBurden[]
  warehouse: FarmWarehouse[]
  farmland: FarmLand[]
  weather: string
  username?: string
  wealth?: string | number
  checked?: number
}

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function event(type: string, payload: JsonObject): DomainEvent {
  return domainEvent(type, payload)
}

function freshFarm(): FarmState {
  return {
    house: 'house', kennel: 'kennel', fence: 'fence', experience: '1', rank: '01',
    burden: [], warehouse: [], weather: 'Sunny',
    farmland: Array.from({ length: 18 }, (_, index) => ({ farmland: index < 6 ? 'FarmlandS' : 'Wasteland' })),
  }
}

function cropFor(seedId: string): FarmCropDefinition | null {
  return FARM_CROPS.find(crop => crop.seed === seedId) ?? null
}

function seedFor(seedId: string): FarmSeedDefinition | null {
  return FARM_SEEDS.find(seed => seed.seed === seedId) ?? null
}

function nowSeconds(context: HandlerContext): number {
  return Math.floor(context.ctx.gameTimeMs / 1000)
}

function readFarmFromState(state: EngineState): FarmState {
  const parsed = readSharedBlob<Partial<FarmState>>(state.save, 'farm', {})
  const fresh = freshFarm()
  return {
    ...fresh,
    ...parsed,
    burden: parsed.burden ?? [],
    warehouse: parsed.warehouse ?? [],
    farmland: parsed.farmland ?? fresh.farmland,
  }
}

function readFarm(context: HandlerContext): FarmState {
  return readFarmFromState(context.state)
}

function writeFarmToState(state: EngineState, farm: FarmState): void {
  farm.wealth = String(state.save.petInfo.yb)
  farm.username = state.save.petInfo.name
  writeSharedBlob(state.save, 'farm', farm)
}

function writeFarm(context: HandlerContext, farm: FarmState): void {
  writeFarmToState(context.state, farm)
}

function pests(land: FarmLand): number {
  return (land.grass === undefined ? 0 : 1) + (land.worm === undefined ? 0 : 1) + (land.farmland === 'FarmlandG' ? 1 : 0)
}

function growLand(land: FarmLand, now: number, rng: HandlerContext['rng']): void {
  if (land.crop === undefined || land.harvest !== undefined) return
  const crop = cropFor(land.crop)
  if (crop === null) return
  const age = now - Number(land.time ?? now)
  if (age >= crop.time) {
    land.state = 5
    land.progress = 1
    if (land.yield === undefined) {
      land.yield = Math.max(1, crop.yield - 3 + rng.randIntInclusive(0, 5) - PEST_LOSS * pests(land))
    }
    land.growth = '收获果实' + String(land.yield) + '个,还剩' + String(land.yield) + '个'
  } else {
    land.state = Math.floor(age * 5 / crop.time)
    land.progress = age / crop.time
    land.growth = '距离成熟还有' + String(crop.time - age)
  }
}

function settleFarm(rng: RuntimeRng, farm: FarmState, now: number): void {
  const previous = farm.checked === undefined ? now : Number(farm.checked)
  const chance = 1 - Math.exp(-(now - previous) / PEST_TIME)
  for (let index = 0; index < farm.farmland.length; index++) {
    const land = farm.farmland[index]
    if (land.crop === undefined || land.harvest !== undefined) continue
    if (Number(land.state ?? 0) < 5) {
      if (land.grass === undefined && rng.chance(chance)) land.grass = 1
      if (land.worm === undefined && rng.chance(chance)) land.worm = 1
      if (land.farmland === 'FarmlandS' && rng.chance(chance)) land.farmland = 'FarmlandG'
    }
    growLand(land, now, rng)
  }
  farm.checked = now
}

function requireFarmReady(context: HandlerContext): FarmState {
  requireLivingPet(context.state)
  if (context.ctx.actorDeviceId === null) reject('unauthorized', 'an authenticated actor is required')
  if (context.state.save.settings.paused) reject('paused', 'the pet is paused')
  const farm = readFarm(context)
  settleFarm(context.rng, farm, nowSeconds(context))
  return farm
}

function farmChanged(context: HandlerContext, farm: FarmState, action: string, extra: JsonObject = {}): DomainEvent {
  writeFarm(context, farm)
  return event('farm.changed', { action, experience: Number(farm.experience), rank: Number(farm.rank), ...extra })
}

function uniquePlots(plotIds: number[]): number[] {
  const seen = new Set<number>()
  for (const plotId of plotIds) {
    if (seen.has(plotId)) reject('invalid_payload', 'duplicate farm plot id')
    seen.add(plotId)
  }
  return plotIds
}

function landAt(farm: FarmState, plotId: number): FarmLand {
  const land = farm.farmland[plotId]
  if (land === undefined) reject('not_available', 'farm plot does not exist')
  return land
}

function burdenCount(farm: FarmState, item: string): number {
  return farm.burden.find(entry => entry.Items === item)?.number ?? 0
}

function consumeBurden(farm: FarmState, item: string, count = 1): boolean {
  const index = farm.burden.findIndex(entry => entry.Items === item)
  if (index < 0 || farm.burden[index].number < count) return false
  farm.burden[index].number -= count
  if (farm.burden[index].number === 0) farm.burden.splice(index, 1)
  return true
}

function addExperience(farm: FarmState, amount: number): void {
  let experience = Number(farm.experience) + amount
  let rank = Number(farm.rank)
  while (experience >= rank * EXP_PER_RANK) {
    experience -= rank * EXP_PER_RANK
    rank++
  }
  farm.experience = String(experience)
  farm.rank = String(rank)
}

function addWarehouse(farm: FarmState, crop: FarmCropDefinition, count: number): void {
  const entry = farm.warehouse.find(item => item.fruit === crop.crop)
  if (entry !== undefined) entry.number += count
  else farm.warehouse.push({ fruit: crop.crop, number: count, name: crop.name, price: crop.price })
}

export function farmPlant(context: HandlerContext, payload: CommandPayloadMap['farm.plant']): HandlerResult {
  const farm = requireFarmReady(context)
  const seed = seedFor(payload.seedId)
  const crop = cropFor(payload.seedId)
  if (seed === null || crop === null) reject('not_available', 'unknown farm seed')
  const plots = uniquePlots(payload.plotIds)
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    if (land.farmland === 'Wasteland') reject('not_available', 'wasteland must be reclaimed first')
    if (land.crop !== undefined || land.harvest !== undefined) reject('not_available', 'farm plot is not empty')
  }
  if (burdenCount(farm, payload.seedId) < plots.length) reject('insufficient_item', 'not enough seeds')
  consumeBurden(farm, payload.seedId, plots.length)
  const now = nowSeconds(context)
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    land.crop = payload.seedId
    land.time = now
    land.state = 0
    land.progress = 0
    delete land.harvest
    delete land.grass
    delete land.worm
    delete land.yield
    growLand(land, now, context.rng)
  }
  return {
    result: json({ seedId: payload.seedId, planted: plots.length, remainingSeeds: burdenCount(farm, payload.seedId) }),
    events: [farmChanged(context, farm, 'plant', { seedId: payload.seedId, plots })],
  }
}

export function farmReclaim(context: HandlerContext, payload: CommandPayloadMap['farm.reclaim']): HandlerResult {
  const farm = requireFarmReady(context)
  const plots = uniquePlots(payload.plotIds)
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    if (land.farmland !== 'Wasteland') reject('not_available', 'farm plot is not wasteland')
  }
  for (const plotId of plots) landAt(farm, plotId).farmland = 'FarmlandS'
  return {
    result: json({ reclaimed: plots.length }),
    events: [farmChanged(context, farm, 'reclaim', { plots })],
  }
}

export function farmHarvest(context: HandlerContext, payload: CommandPayloadMap['farm.harvest']): HandlerResult {
  const farm = requireFarmReady(context)
  const plots = uniquePlots(payload.plotIds)
  let total = 0
  let experience = 0
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    const crop = land.crop === undefined ? null : cropFor(land.crop)
    if (crop === null || land.harvest !== undefined || Number(land.state ?? 0) < 5) {
      reject('not_available', 'farm plot is not ready to harvest')
    }
    const count = Math.max(1, Number(land.yield ?? crop.yield))
    addWarehouse(farm, crop, count)
    total += count
    experience += crop.experience
    land.harvest = 'xx'
    delete land.progress
    delete land.grass
    delete land.worm
  }
  addExperience(farm, experience)
  return {
    result: json({ harvested: total, experience, rank: Number(farm.rank) }),
    events: [farmChanged(context, farm, 'harvest', { plots, harvested: total, experience })],
  }
}

export function farmCare(context: HandlerContext, payload: CommandPayloadMap['farm.care']): HandlerResult {
  const farm = requireFarmReady(context)
  const plots = uniquePlots(payload.plotIds)
  let done = 0
  let experience = 0
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    if (payload.action === 'water') {
      if (land.farmland !== 'FarmlandG') continue
      land.farmland = 'FarmlandS'
      done++
      experience += CARE_EXP
      continue
    }
    if (payload.action === 'weed') {
      if (land.grass === undefined) continue
      delete land.grass
      done++
      experience += CARE_EXP
      continue
    }
    if (payload.action === 'pest') {
      if (land.worm === undefined) continue
      delete land.worm
      done++
      experience += CARE_EXP
      continue
    }
    if (land.crop === undefined || land.harvest !== undefined || Number(land.state ?? 0) >= 5) continue
    const fertilizer = FARM_FERTILIZERS.find(item => burdenCount(farm, item.item) > 0)
    if (fertilizer === undefined) break
    consumeBurden(farm, fertilizer.item, 1)
    land.time = Number(land.time ?? 0) - fertilizer.duration
    growLand(land, nowSeconds(context), context.rng)
    done++
  }
  if (done === 0) reject('not_available', 'no selected farm plot needs that care action')
  addExperience(farm, experience)
  return {
    result: json({ action: payload.action, cared: done, experience }),
    events: [farmChanged(context, farm, 'care', { action: payload.action, plots, cared: done, experience })],
  }
}

export function farmClear(context: HandlerContext, payload: CommandPayloadMap['farm.clear']): HandlerResult {
  const farm = requireFarmReady(context)
  const plots = uniquePlots(payload.plotIds)
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    if (land.harvest === undefined) reject('not_available', 'farm plot has no harvested crop to clear')
  }
  for (const plotId of plots) {
    const land = landAt(farm, plotId)
    delete land.crop
    delete land.time
    delete land.state
    delete land.growth
    delete land.progress
    delete land.yield
    delete land.harvest
    delete land.grass
    delete land.worm
  }
  return {
    result: json({ cleared: plots.length }),
    events: [farmChanged(context, farm, 'clear', { plots })],
  }
}

export function farmBuySeed(context: HandlerContext, payload: CommandPayloadMap['farm.buySeed']): HandlerResult {
  const farm = requireFarmReady(context)
  const seed = seedFor(payload.seedId)
  if (seed === null) reject('not_available', 'unknown farm seed')
  if (seed.rank > Number(farm.rank)) reject('not_available', 'farm rank is too low for this seed')
  const cost = seed.price * payload.quantity
  payYb(context.state.save, cost)
  const entry = farm.burden.find(item => item.Items === payload.seedId)
  if (entry !== undefined) entry.number += payload.quantity
  else farm.burden.push({ name: seed.name, Items: seed.seed, number: payload.quantity })
  return {
    result: json({ seedId: payload.seedId, quantity: payload.quantity, cost }),
    events: [farmChanged(context, farm, 'buySeed', { seedId: payload.seedId, quantity: payload.quantity, cost })],
  }
}

export function farmSellProduce(context: HandlerContext, payload: CommandPayloadMap['farm.sellProduce']): HandlerResult {
  const farm = requireFarmReady(context)
  const index = farm.warehouse.findIndex(item => item.fruit === payload.itemId)
  if (index < 0) reject('not_available', 'produce was not found in the warehouse')
  const entry = farm.warehouse[index]
  if (entry.number < payload.quantity) reject('insufficient_item', 'not enough produce in the warehouse')
  const produce = FARM_CROPS.find(crop => crop.crop === entry.fruit)
  const value = Number(entry.price ?? produce?.price ?? 0) * payload.quantity
  if (value <= 0) reject('not_available', 'produce has no sale value')
  entry.number -= payload.quantity
  if (entry.number === 0) farm.warehouse.splice(index, 1)
  const yb = earnYb(context.state.save, value)
  return {
    result: json({ itemId: payload.itemId, quantity: payload.quantity, yb }),
    events: [farmChanged(context, farm, 'sellProduce', { itemId: payload.itemId, quantity: payload.quantity, yb })],
  }
}

/** Minute-scheduler hook for farm growth/pests; no-op until a canonical farm blob exists. */
export function tickFarmState(state: EngineState, rng: RuntimeRng, nowMs: number): DomainEvent[] {
  const raw = state.save.saveJsonData.farm
  if (raw === undefined || raw === '{}') return []
  const farm = readFarmFromState(state)
  const before = stableStringify(farm)
  settleFarm(rng, farm, Math.floor(nowMs / 1000))
  writeFarmToState(state, farm)
  if (stableStringify(farm) === before) return []
  return [event('farm.changed', { action: 'tick', checked: farm.checked ?? 0 })]
}

export function farmStateForTest(context: HandlerContext): FarmState {
  return requireFarmReady(context)
}
