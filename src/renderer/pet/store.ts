import type { TrayState } from '../../shared/ipc'
import type { PetInfo, SaveData, SavePatch, Settings } from '../../shared/save'
import type { OrderedEvent } from '../../shared/pet-runtime/events'
import type { CommandResult } from '../../shared/sync/protocol'
import type { DeviceLocalOverlayPatch } from '../../shared/sync/data-boundary'
import { classifyProjectionDelivery, type ProjectionCursor, type RendererProjection, type RendererRepositoryStatus } from '../../shared/renderer-api'
import { applyLocalOverlayInPlace, applyPresentationInPlace, assertDeviceLocalSavePatch, hydrateSaveProjection, type InfoChange, type SaveHydrationResult } from '../../shared/renderer-projection'
import { invalidateProjectionCaches } from './projection-cache'
import { petSizeFor } from '../../shared/layout'
import { goodOf, type TimedType } from './data/goods'
import { levelOf, stageOf, type Stage } from './level'
import type { Mood } from './router'
import { touch } from '../ui/dom'
import { pageZoom, viewportSize } from '../ui/viewport'

if (!window.__qqpetInitialSave) throw new Error('QQPet store must be loaded through bootstrap.ts')
export const save: SaveData = window.__qqpetInitialSave
export const info: PetInfo = save.petInfo

/** True only for the explicit C6 local-runtime-v2 authority; legacy is untouched when false. */
export const runtimeProjectionMode = window.__qqpetRuntimeV2 === true

let patch: Record<string, unknown> = {}
let flushTimer = 0
const settlers = new Set<() => void>()
const settingsListeners = new Set<(change: Partial<Settings>) => void>()
const projectionListeners = new Set<(projection: RendererProjection, events: OrderedEvent[]) => void>()
const eventListeners = new Set<(event: OrderedEvent) => void>()
const commandResultListeners = new Set<(result: CommandResult) => void>()
const syncStatusListeners = new Set<(status: RendererRepositoryStatus) => void>()
let projectionCursor: ProjectionCursor | null = window.__qqpetInitialProjectionCursor ?? null
let localSettingsQueue: Promise<void> = Promise.resolve()
let pendingLocalSettings: DeviceLocalOverlayPatch | null = null
let localSettingsTimer = 0

/** Settings-dependent views can refit without waiting for a viewport resize. */
export function onSettingsChange(listener: (change: Partial<Settings>) => void): () => void {
  settingsListeners.add(listener)
  return () => { settingsListeners.delete(listener) }
}

/** Farm and other embedded state can settle immediately before the renderer/file barrier. */
export function onSaveFlush(settle: () => void): () => void {
  settlers.add(settle)
  return () => settlers.delete(settle)
}

/** Fires after an authoritative projection has been hydrated in place. */
export function onProjectionApplied(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): () => void {
  projectionListeners.add(listener)
  return () => { projectionListeners.delete(listener) }
}

/** Fires for each ordered event after its projection; never mutates canonical state itself. */
export function onStoreEvent(listener: (event: OrderedEvent) => void): () => void {
  eventListeners.add(listener)
  return () => { eventListeners.delete(listener) }
}

/** Command results are notifications only; canonical changes arrive via projections. */
export function onStoreCommandResult(listener: (result: CommandResult) => void): () => void {
  commandResultListeners.add(listener)
  return () => { commandResultListeners.delete(listener) }
}

export function onStoreSyncStatus(listener: (status: RendererRepositoryStatus) => void): () => void {
  syncStatusListeners.add(listener)
  return () => { syncStatusListeners.delete(listener) }
}

function notifyInfoChanges(changes: readonly InfoChange[]): void {
  for (const change of changes) {
    for (const listener of listeners) listener(change.key, change.previous)
  }
}

function notifySettingsChanges(changes: Partial<Settings>): void {
  if (Object.keys(changes).length === 0) return
  for (const listener of settingsListeners) listener(changes)
}

function dispatchOrderedEvents(events: readonly OrderedEvent[]): void {
  for (const event of events) {
    for (const listener of eventListeners) listener(event)
  }
}

function applyDevicePatch(patch: DeviceLocalOverlayPatch): void {
  const result = applyLocalOverlayInPlace(save, {
    ...(patch.petInfo === undefined ? {} : { petInfo: patch.petInfo }),
    ...(patch.settings === undefined ? {} : { settings: patch.settings }),
  })
  if (patch.presentation !== undefined) applyPresentationInPlace(save, patch.presentation)
  notifyInfoChanges(result.infoChanges)
  notifySettingsChanges(result.settingsChanges)
}

function mergeLocalSettingsPatch(patch: DeviceLocalOverlayPatch): void {
  const pending = pendingLocalSettings ?? {}
  if (patch.petInfo !== undefined) pending.petInfo = { ...(pending.petInfo ?? {}), ...patch.petInfo }
  if (patch.settings !== undefined) pending.settings = { ...(pending.settings ?? {}), ...patch.settings }
  if (patch.presentation !== undefined) pending.presentation = { ...(pending.presentation ?? {}), ...patch.presentation }
  pendingLocalSettings = pending
}

function flushLocalSettings(): Promise<void> {
  if (localSettingsTimer) window.clearTimeout(localSettingsTimer)
  localSettingsTimer = 0
  const patch = pendingLocalSettings
  pendingLocalSettings = null
  if (patch === null) return localSettingsQueue
  const run = localSettingsQueue.catch(() => undefined).then(async () => {
    const writeSettings = window.qqpet.localSettings.update
    const overlay = await writeSettings(patch)
    const result = applyLocalOverlayInPlace(save, overlay)
    if (overlay.presentation !== undefined) applyPresentationInPlace(save, overlay.presentation)
    notifyInfoChanges(result.infoChanges)
    notifySettingsChanges(result.settingsChanges)
  })
  localSettingsQueue = run
  run.catch((error: unknown) => console.error('Local settings persistence failed:', error))
  return run
}

function queueLocalSettings(patch: DeviceLocalOverlayPatch): void {
  mergeLocalSettingsPatch(patch)
  if (localSettingsTimer) return
  localSettingsTimer = window.setTimeout(() => { void flushLocalSettings() }, 200)
}

function receiveProjection(projection: RendererProjection, events: OrderedEvent[], requestedResync: boolean): void {
  if (runtimeProjectionMode === false) return
  const classification = classifyProjectionDelivery(projectionCursor, projection, events)
  if (classification.kind === 'stale') return
  // A gap on the ordered channel is not applied speculatively; the repository
  // must deliver a full resync through onResync first.
  if (requestedResync === false && classification.kind === 'resync') return
  const full = requestedResync || classification.kind === 'resync'
  const result: SaveHydrationResult = hydrateSaveProjection(save, projection)
  projectionCursor = {
    revision: projection.revision,
    eventSeq: projection.eventSeq,
    owner: projection.authority.owner,
    authorityId: projection.authority.authorityId,
    authorityEpoch: projection.authority.epoch,
    restoreGeneration: projection.authority.restoreGeneration,
  }
  notifyInfoChanges(result.infoChanges)
  notifySettingsChanges(result.settingsChanges)
  invalidateProjectionCaches({
    full,
    changedJsonKeys: result.changedJsonKeys,
    eventTypes: events.map(event => event.type),
  })
  dispatchOrderedEvents(events)
  for (const listener of projectionListeners) listener(projection, events)
}

function flushPatch(): void {
  if (flushTimer) window.clearTimeout(flushTimer)
  flushTimer = 0
  if (runtimeProjectionMode || Object.keys(patch).length === 0) return
  window.qqpet.save(patch as SavePatch)
  patch = {}
}

export async function flushSave(): Promise<void> {
  for (const settle of settlers) settle()
  flushPatch()
  await flushLocalSettings()
  await localSettingsQueue
  await window.qqpet.flush()
}
window.__qqpetFlush = flushSave
addEventListener('pagehide', () => { void flushSave().catch((error: unknown) => console.error('Save flush failed:', error)) })

/** Applies a change to `save` and writes it to disk, batched like the original (200 ms). */
export function update<K extends keyof SaveData>(key: K, value: SavePatch[K]): void {
  if (runtimeProjectionMode) {
    const classification = assertDeviceLocalSavePatch({ [key]: value } as SavePatch)
    const localPatch: DeviceLocalOverlayPatch = {
      ...(Object.keys(classification.localPetInfo).length === 0 ? {} : { petInfo: classification.localPetInfo }),
      ...(Object.keys(classification.localSettings).length === 0 ? {} : { settings: classification.localSettings }),
      ...(Object.keys(classification.presentation).length === 0 ? {} : { presentation: classification.presentation }),
    }
    applyDevicePatch(localPatch)
    queueLocalSettings(localPatch)
    return
  }
  const target = save as unknown as Record<string, unknown>
  const isGroup = typeof value === 'object' && value !== null && !Array.isArray(value)
  if (isGroup) {
    Object.assign(target[key] as object, value)
    patch[key] = { ...(patch[key] as object), ...value }
  } else {
    target[key] = value
    patch[key] = value
  }
  flushTimer ||= window.setTimeout(flushPatch, 200)
  if (key === 'settings' && isGroup) {
    for (const listener of settingsListeners) listener(value as Partial<Settings>)
  }
}

type NumKey = { [K in keyof PetInfo]: PetInfo[K] extends number ? K : never }[keyof PetInfo]
type Listener = (key: keyof PetInfo, prev: unknown) => void
const listeners: Listener[] = []

export const onInfoChange = (l: Listener): void => void listeners.push(l)

export function setInfo<K extends keyof PetInfo>(key: K, value: PetInfo[K]): void {
  const prev = info[key]
  if (prev === value) return
  update('petInfo', { [key]: value })
  if (runtimeProjectionMode) return
  for (const l of listeners) l(key, prev)
}

/** 元宝 income of a normal source; standard difficulty pays 40%, at least 1. Cheats and refunds use addInfo. */
export const scaleYb = (n: number): number => (n > 0 && save.settings.difficulty === 'standard' ? Math.max(1, Math.round(n * 0.4)) : n)
export const earnYb = (n: number): number => {
  const got = scaleYb(n)
  setInfo('yb', info.yb + got)
  return got
}

export const addInfo = (key: NumKey, delta: number): void => setInfo(key, info[key] + delta)

type Activity = 'work' | 'study' | 'trip' | 'ill' | 'die'
export const activity = (k: Activity): string | null => save.activeOption[k] as string | null
export const setActivity = (k: Activity, v: string | null): void => update('activeOption', { [k]: v })

const MOODS: [number, Mood, number][] = [
  [800, 'happy', 1],
  [500, 'peaceful', 0.9],
  [200, 'upset', 0.7],
  [-Infinity, 'sad', 0.5],
]
export const mood = (): Mood => MOODS.find(([min]) => info.mood >= min)![1]
export const stage = (): Stage => stageOf(save.petComputedlInfo.level)
/** The first frame of the pet's Stand.swf, framed like the original pet/info/*.svg portraits. */
export const avatar = (): string => `pet/avatar/${info.sex}${stage()}.png`

/**
 * Native iPad hosts keep the asset's 146–164 px size from level 1 onward.
 * Other touch hosts use the short side; desktop hosts use the active display width.
 */
export const petSize = (): number =>
  petSizeFor(save.petComputedlInfo.level, touch ? { width: innerWidth, height: innerHeight } : viewportSize(), touch, window.qqpet.deviceKind) *
  (pageZoom() ?? 1)

/** How close to a side counts as peeking. Hide_left/right SWFs assume the box sits on that edge. */
export const EDGE_NEAR = 36

export function edgeSide(): 'hideleft' | 'hideright' | null {
  const s = petSize()
  if (info.lastX <= EDGE_NEAR) return 'hideleft'
  if (info.lastX + s >= viewportSize().width - EDGE_NEAR) return 'hideright'
  return null
}

/** Snaps X onto the side it is already on. */
export function applyEdge(): 'hideleft' | 'hideright' | null {
  const edge = edgeSide()
  if (edge === 'hideleft') setInfo('lastX', 0)
  else if (edge === 'hideright') setInfo('lastX', viewportSize().width - petSize())
  return edge
}

export function growthPerMinute(): number {
  if (info.mood <= 0) return 10 / 60
  const rate = MOODS.find(([min]) => info.mood >= min)![2]
  let perHour = 80 * rate + (info.pinkDiamond ? 10 : 0)
  for (const [type, t] of Object.entries(save.selfGoodUseOption)) if (t) perHour += goodOf(type as TimedType, t.id).group ?? 0
  return (perHour * (info.sweetHeartOverTime ? 1.1 : 1)) / 60
}

export const busy = (): boolean => Boolean(activity('work') || activity('study') || activity('trip'))

/** Session-only desktop minigame name. Not saved. */
let deskGame = ''
export const playingDesk = (): string => deskGame
export const setDeskGame = (name: string): void => {
  deskGame = name
}

/** 0 (fresh) and up; drives random illness and health loss. */
export function fatigue(): number {
  const c = save.petComputedlInfo
  const m = info.mood / c.moodMax
  const cl = info.clean / c.cleanMax
  const h = info.hunger / c.hungerMax
  let f = (info.health !== 5 ? 2 : 0) + (m < 0.2 ? 3 : m < 0.5 ? 2 : 0) + (cl < 0.2 ? 2 : cl < 0.5 ? 1 : 0) + (h < 0.2 ? 2 : h < 0.5 ? 1 : 0)
  if (!f) return 0
  if (busy()) f += 2
  const strong = info.strong
  const relief = c.level < 10 ? (strong > 500 ? 2 : 0) : strong > 50000 ? 4 : strong > 5000 ? 2 : 0
  return Math.max(0, f - relief)
}

/** 0..20: VIP flags, charm and intelligence help; fatigue hurts. */
export function luck(): number {
  let l = 1 + (info.pinkDiamond ? info.PDiamondLevel * 2 : 0) + (info.sweetHeart ? 2 : 0)
  l += [500, 5000, 50000].filter((v) => info.charm > v).length + [800, 8000, 80000].filter((v) => info.intel > v).length
  return Math.min(Math.max(0, l - (fatigue() >> 1)), 20)
}

/** Recomputes level and stat caps from growth; returns the previous level. */
export function syncLevel(): number {
  const c = save.petComputedlInfo
  const prev = c.level
  const l = levelOf(info.growth)
  const max = 1000 + Math.min(l.level, 70) * 100
  if (l.level !== prev || max !== c.hungerMax) update('petComputedlInfo', { ...l, hungerMax: max, cleanMax: max })
  return prev
}

let tray: TrayState | null = null

export function setTray(s: TrayState): void {
  // Hunger and dirt never replace the more urgent ill/dead icons.
  if (s === tray || ((s === 'hungry' || s === 'dirty') && (tray === 'ill' || tray === 'dead'))) return
  tray = s
  window.qqpet.setTrayState(s)
}

export function setPaused(on: boolean): void {
  update('settings', { paused: on })
  refreshTray()
}

export function refreshTray(): void {
  if (save.isBury || info.health === 0) setTray('dead')
  else if (save.settings.paused) setTray('pause')
  else if (info.health !== 5) setTray('ill')
  else if (activity('work')) setTray('work')
  else if (activity('study')) setTray('study')
  else if (activity('trip')) setTray('travel')
  else if (info.clean < 300) setTray('dirty')
  else if (info.hunger < 300) setTray('hungry')
  else setTray('normal')
}

// Load-time fixups from the original setDefaultPetInfoData: a sick pet always
// has an illness line. Unlike the original, activities survive a restart (resumeTask).
update('petInfo', { lastX: info.lastX | 0, lastY: info.lastY | 0 })
if (runtimeProjectionMode === false) {
  if (info.health < 5 && !activity('ill')) setActivity('ill', '1-')
  syncLevel()
}

if (runtimeProjectionMode) {
  window.qqpet.onProjection((projection, events) => receiveProjection(projection, events, false))
  window.qqpet.onResync((projection, events) => receiveProjection(projection, events, true))
  window.qqpet.onCommandResult((result) => {
    for (const listener of commandResultListeners) listener(result)
  })
  window.qqpet.onSyncStatus((status) => {
    for (const listener of syncStatusListeners) listener(status)
  })
}
