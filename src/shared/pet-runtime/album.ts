import type { SharedSaveData } from '../sync/data-boundary'
import { PHOTOS } from './content/index'
import { writeSharedBlob, type RuntimeRng } from './runtime-helpers'

export interface TravelShot { id: string; city: string; d: number }

/** saveJsonData.album, oldest first, in the renderer album.ts shape. */
export function readAlbumShots(save: SharedSaveData): TravelShot[] {
  const raw = save.saveJsonData.album
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as TravelShot[] : []
  } catch {
    return []
  }
}

export function isBuddyPhoto(photoId: string): boolean {
  return PHOTOS.some(photo => photo.id === photoId && photo.b)
}

/** Canonical album flow copied from renderer pet/album.ts takePhoto. */
export function appendTravelPhoto(
  save: SharedSaveData,
  city: string,
  gameTimeMs: number,
  rng: RuntimeRng,
): TravelShot | null {
  const shots = readAlbumShots(save)
  const taken = new Set(shots.map(shot => shot.id))
  const left = PHOTOS.filter(photo => taken.has(photo.id) === false)
  const buddy = rng.chance(0.4)
  const pool = [buddy, buddy === false].flatMap(kind =>
    [city, ''].map(place => left.filter(photo => photo.b === kind && photo.p === place)),
  ).find(entries => entries.length > 0)
  if (pool === undefined) return null
  const photo = pool[rng.randIntInclusive(0, pool.length - 1)]
  const shot: TravelShot = { id: photo.id, city, d: Math.floor(gameTimeMs / 1000) }
  writeSharedBlob(save, 'album', [...shots, shot])
  return shot
}
