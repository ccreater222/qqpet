import type { SharedSaveData } from '../sync/data-boundary'
import { PHOTOS, TRAVEL_PROVINCES, type RuntimeGood } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import {
  addTaskCount,
  grantGoods,
  lootGoods,
  mailSlot,
  readMails,
  readTaskProgress,
  writeMails,
  writeSharedBlob,
  type RuntimeRng,
} from './runtime-helpers'
import type { EngineState, JsonObject } from './types'

export interface TravelShot { id: string; city: string; d: number }

function readShots(save: SharedSaveData): TravelShot[] {
  const raw = save.saveJsonData.album
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as TravelShot[] : []
  } catch {
    return []
  }
}

function isBuddy(photoId: string): boolean {
  return PHOTOS.some(photo => photo.id === photoId && photo.b)
}

/** Canonical travel photo: one unused photo, preferring the rolled buddy/province grouping. */
export function takeTravelPhoto(
  save: SharedSaveData,
  city: string,
  gameTimeMs: number,
  rng: RuntimeRng,
): TravelShot | null {
  const taken = new Set(readShots(save).map(shot => shot.id))
  const left = PHOTOS.filter(photo => taken.has(photo.id) === false)
  const buddy = rng.chance(0.4)
  const pool = [buddy, buddy === false].flatMap(kind =>
    [city, ''].map(place => left.filter(photo => photo.b === kind && photo.p === place)),
  ).find(entries => entries.length > 0)
  if (pool === undefined) return null
  const photo = pool[rng.randIntInclusive(0, pool.length - 1)]
  const shot: TravelShot = { id: photo.id, city, d: Math.floor(gameTimeMs / 1000) }
  writeSharedBlob(save, 'album', [...readShots(save), shot])
  return shot
}

/** Canonical travel postcard mail, linked to the photo by album id. */
export function mailTravelPhoto(save: SharedSaveData, shot: TravelShot, gameTimeMs: number): string {
  const mails = readMails(save)
  const slot = mailSlot(mails, gameTimeMs)
  mails[String(slot)] = {
    d: slot,
    l: isBuddy(shot.id) ? '在' + shot.city + '遇到了旅游搭子！' : '来自' + shot.city + '的明信片',
    p: shot.id,
    m: '[host]，照片我收进「旅游-相簿」啦，随时可以翻看哦~',
    glb: [],
  }
  writeMails(save, mails)
  return String(slot)
}

function inventoryTotal(save: SharedSaveData): number {
  let total = 0
  for (const entries of Object.values(save.selfGoodDatas)) {
    for (const entry of entries) total += Number(entry.split('*')[1] ?? 0) || 0
  }
  return total
}

function visitProvince(save: SharedSaveData, name: string): boolean {
  const existing = save.gameSaveDatas.travel_china.find(entry => entry.name === name)
  if (existing === undefined) {
    save.gameSaveDatas.travel_china.push({ name, value: 1 })
    return true
  }
  existing.value += 1
  return false
}

/** Applies the renderer's travel-return branch: souvenir only when the early roll succeeded; photo/mail always. */
export function applyTravelCompletion(
  state: EngineState,
  destination: string,
  early: boolean,
  gameTimeMs: number,
  rng: RuntimeRng,
): DomainEvent[] {
  const save = state.save
  const province = TRAVEL_PROVINCES.find(candidate => candidate.name === destination)
  if (province === undefined) return []
  const isNew = visitProvince(save, province.name)
  addTaskCount(save, 'Travel1', 1)
  save.petInfo.mood = Math.min(save.petInfo.mood + 20, 1000)
  const events: DomainEvent[] = []
  let souvenirs: RuntimeGood[] = []
  if (early) {
    souvenirs = lootGoods(rng, 1, isNew ? 1 : 2)
    grantGoods(save, souvenirs)
  }
  const shot = takeTravelPhoto(save, province.name, gameTimeMs, rng)
  let mailId: string | null = null
  if (shot !== null) mailId = mailTravelPhoto(save, shot, gameTimeMs)
  save.activeOption.trip = null
  writeSharedBlob(save, 'activity', 0)
  const payload: JsonObject = {
    kind: 'travel',
    activityId: province.name,
    early,
    destination: province.name,
    isNew,
    souvenirs: souvenirs.length,
    photoId: shot?.id ?? '',
    mailId: mailId ?? '',
  }
  events.push(domainEvent('activity.completed', payload))
  if (souvenirs.length > 0) events.push(domainEvent('reward.granted', { source: 'travel-souvenir', destination: province.name, count: souvenirs.length, inventoryTotal: inventoryTotal(save) }))
  if (shot !== null && mailId !== null) {
    events.push(domainEvent('mail.arrived', { mailId, title: isBuddy(shot.id) ? '在' + shot.city + '遇到了旅游搭子！' : '来自' + shot.city + '的明信片' }))
  }
  return events
}

/** Used by tests/characterization to observe the normal-branch invariant without UI side effects. */
export function travelInventoryTotal(save: SharedSaveData): number {
  return inventoryTotal(save)
}

export function travelTaskState(save: SharedSaveData): ReturnType<typeof readTaskProgress> {
  return readTaskProgress(save)
}
