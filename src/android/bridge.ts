// window.qqpet on Android. The page runs in a WebView that fills the screen but
// sits inside an overlay window cut down to the visible content: Android cannot
// pass touches through transparent pixels, so everything outside the window
// reaches the apps below.
import { aiChat, aiModels } from '../shared/ai'
import { webSearch } from '../shared/websearch'
import { calendar } from '../shared/calendar'
import { abortReason, cloneJson } from '../shared/compat'
import { normalizeUpstreamUrl } from '../shared/upstream'
import { nextBounds } from '../mobile/bounds'
import { cover } from '../mobile/overlay'
import type { Fetch, Point, QQPetApi, TrayClick, TrayState } from '../shared/ipc'
import { legacyRendererStatus, type RendererProjection } from '../shared/renderer-api'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import type { SaveData } from '../shared/save'
import { applyPatch, buried, petOf, startSave } from '../shared/save-logic'
import { TRAY_STATES, trayTip } from '../shared/tray'
import { latestRelease } from '../shared/update'
import { weather } from '../shared/weather'
import { androidLocalRepositoryStorage } from './local-repository-storage'
import {
  createMobileLocalRepositoryBridge,
  resolveMobileLegacyAuthority,
  webCryptoAvailable,
  type MobileLocalRepositoryBridge,
} from '../mobile/local-repository-bridge'
import { forwardGamePlayed, forwardOpenGame } from '../mobile/game-played'
import { createMobileServerRuntime, type MobileServerNative, type MobileServerRuntime } from '../mobile/server-mode'
import { APP_VERSION } from '../shared/version'

/** The `QQPetNative` JavaScript interface of PetService. Async calls answer through `__qqpet.resolve(id, value, error)`. */
interface Native {
  /** Both screen orientations are supported; absent on older shells. */
  rotatableScreen?(): boolean
  /** A file in the app's private storage. Missing is undefined: the WebView bridge turns Kotlin's null into undefined. */
  read(name: string): string | undefined
  write(name: string, text: string): void
  /** Explicit atomic v2 state capability; absent on shells without the C5b native update. */
  /** Encoded discriminated read result; state reads reject save.json. */
  readStateFile?(name: string): string
  /** Separate legacy save.json read with missing/error discrimination. */
  readLegacySave?(): string
  writeAtomic?(name: string, text: string): boolean
  /** Removes one allowlisted state file; absent on shells without the server-mode update. */
  removeStateFile?(name: string): boolean
  /** Keystore-wrapped device token; the plaintext never reaches a file or a log. */
  saveRemoteToken?(token: string): boolean
  /** Encoded `{"status":"ok","text":string|null}` or `{"status":"error","error":string}`. */
  loadRemoteToken?(): string
  clearRemoteToken?(): boolean
  /** Resolves to `{"status": n, "body": "…"}` JSON. */
  http(id: number, method: string, url: string, headers: string, body: string | null): void
  /** Resolves to "true" once written, null when cancelled. */
  exportSave(id: number, name: string, text: string): void
  /** Resolves to the picked file's text, null when cancelled. */
  importSave(id: number): void
  openGame(swf: string, windowId: number): void
  /** Trusted arrow-key injection while a small game owns the overlay; absent on older shells. */
  sendGameKey?(code: string, phase: string): boolean
  quit(): void
  copyText(text: string): void
  openUrl(url: string): void
  setFocusable(on: boolean): void
  /** The page has a modal open and wants the back key; absent on older shells. */
  setBackHandler?(on: boolean): void
  setAutoStart(on: boolean): void
  /** The notification standing in for the tray: an icon under pet/img_res/Tray/, and its text unless null. */
  setTray(icon: string, tip: string | null): void
  /** The pet is hidden: the notification offers 显示宠物. Absent on older shells. */
  setHidden?(on: boolean): void
  /** The overlay window's rectangle, in CSS pixels of a page `viewport` pixels wide. */
  setBounds(x: number, y: number, w: number, h: number, viewport: number): void
  /** "left,top,right,bottom" of the system bars and cutout, in CSS pixels of a page `viewport` pixels wide. */
  safeArea(viewport: number): string
}

interface Events {
  trayClick: TrayClick
  gamePlayed: number | { minutes: number; windowId?: number }
  /** A touch landed outside the overlay window. */
  outside: void
  /** Text picked from another app's selection menu or share sheet. */
  clipboard: string
  /** Screen off, or the user unlocked it. */
  presence: boolean
}

declare global {
  interface Window {
    QQPetNative: Native
    __qqpet: {
      resolve(id: number, value: string | null, error: string | null): void
      emit<K extends keyof Events>(type: K, payload: Events[K]): void
    }
  }
}

const native = window.QQPetNative
/** A down delayed for cloud start must finish before its up, or a quick tap could leave a key held. */
const pendingGameDown = new Map<string, Promise<boolean>>()

// A phone sheet takes the back key while it is up: the sheet tells the host through this hook,
// and the host calls `__qqpetBack` to close it. The desktop and the other mobile hosts have no
// such hook, so their sheets simply close by the backdrop or the close button.
window.__qqpetSetBackHandler = (on: boolean): void => native.setBackHandler?.(on)
// The real frame clock: the SWF player holds page animation frames while the host is paused (#119), and the window
// must still follow a menu or panel opened from the notification while the pet is hidden.
const frame = window.requestAnimationFrame.bind(window)

// Local v2 is the default authority. Packaged builds can set
// VITE_QQPET_LOCAL_RUNTIME_V2_ROLLBACK=1; dev rollback is qqpet-local-runtime-v2=0.
const LOCAL_RUNTIME_V2_ROLLBACK = import.meta.env.VITE_QQPET_LOCAL_RUNTIME_V2_ROLLBACK === '1'
  || (import.meta.env.DEV && new URLSearchParams(location.search).get('qqpet-local-runtime-v2') === '0')
const LOCAL_RUNTIME_V2_FLAG = LOCAL_RUNTIME_V2_ROLLBACK === false
let localRuntimeFailure: string | undefined
let localRuntime: MobileLocalRepositoryBridge | null = null
const legacyAuthorityProbe = resolveMobileLegacyAuthority({
  devRuntimeFlag: LOCAL_RUNTIME_V2_FLAG,
  readCapability: typeof native.readStateFile === 'function',
  readResult: LOCAL_RUNTIME_V2_FLAG === false && typeof native.readStateFile === 'function'
    ? native.readStateFile('save.v2.json')
    : undefined,
  encoding: 'encoded-json',
})
const legacyV2DocumentPresent = legacyAuthorityProbe.v2DocumentPresent
const legacyV2PresenceError = legacyAuthorityProbe.error
if (legacyAuthorityProbe.failure !== undefined) localRuntimeFailure = legacyAuthorityProbe.failure
if (LOCAL_RUNTIME_V2_FLAG) {
  const readStateFile = native.readStateFile?.bind(native)
  const readLegacySave = native.readLegacySave?.bind(native)
  const writeAtomic = native.writeAtomic?.bind(native)
  if (typeof readStateFile !== 'function' || typeof readLegacySave !== 'function' || typeof writeAtomic !== 'function') {
    localRuntimeFailure = 'native atomic state storage capability is missing'
  } else if (webCryptoAvailable() === false) {
    localRuntimeFailure = 'Web Crypto getRandomValues is unavailable'
  } else {
    try {
      localRuntime = createMobileLocalRepositoryBridge({
        storage: androidLocalRepositoryStorage({ readStateFile, readLegacySave, writeAtomic }),
        devRuntimeFlag: true,
        rendererCapability: true,
        autoScheduler: true,
      })
    } catch (error) {
      localRuntimeFailure = error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Android server mode needs the native atomic-state methods plus the Keystore
 * token methods. A shell that lacks any of them keeps the local-only bridge
 * unchanged and reports an explicit capability reason instead of faking it.
 */
const nativeServerIo: MobileServerNative = {
  read: (name) => native.read(name),
  readStateFile: (name) => {
    const read = native.readStateFile?.bind(native)
    if (typeof read !== 'function') throw new Error('native_server_mode_capability_missing: readStateFile')
    return read(name)
  },
  writeAtomic: (name, text) => {
    const write = native.writeAtomic?.bind(native)
    if (typeof write !== 'function') throw new Error('native_server_mode_capability_missing: writeAtomic')
    return write(name, text)
  },
  ...(typeof native.removeStateFile === 'function' ? { removeStateFile: native.removeStateFile.bind(native) } : {}),
  ...(typeof native.saveRemoteToken === 'function' ? { saveRemoteToken: native.saveRemoteToken.bind(native) } : {}),
  ...(typeof native.loadRemoteToken === 'function' ? { loadRemoteToken: native.loadRemoteToken.bind(native) } : {}),
  ...(typeof native.clearRemoteToken === 'function' ? { clearRemoteToken: native.clearRemoteToken.bind(native) } : {}),
}
let serverRuntime: MobileServerRuntime | null = null
let serverRuntimeFailure: string | undefined
if (localRuntime !== null) {
  if (
    typeof native.readStateFile !== 'function'
    || typeof native.writeAtomic !== 'function'
    || typeof native.removeStateFile !== 'function'
    || typeof native.saveRemoteToken !== 'function'
    || typeof native.loadRemoteToken !== 'function'
    || typeof native.clearRemoteToken !== 'function'
  ) {
    serverRuntimeFailure = 'native_server_mode_capability_missing'
  } else {
    try {
      serverRuntime = createMobileServerRuntime({
        local: localRuntime,
        native: nativeServerIo,
        appVersion: APP_VERSION,
      })
    } catch (error) {
      serverRuntimeFailure = error instanceof Error ? error.message : String(error)
    }
  }
}

const pending = new Map<number, { resolve: (v: string | null) => void; reject: (e: Error) => void }>()
let seq = 0
const call = (start: (id: number) => void): Promise<string | null> =>
  new Promise((resolve, reject) => {
    pending.set(++seq, { resolve, reject })
    start(seq)
  })

const listeners: { [K in keyof Events]: ((p: Events[K]) => void)[] } = { trayClick: [], gamePlayed: [], outside: [], clipboard: [], presence: [] }

window.__qqpet = {
  resolve(id, value, error) {
    const p = pending.get(id)!
    pending.delete(id)
    if (error === null) p.resolve(value)
    else p.reject(new Error(error))
  },
  emit(type, payload) {
    for (const l of listeners[type]) l(payload)
  },
}

const nativeFetch: Fetch = (url, init = {}) =>
  new Promise((resolve, reject) => {
    const { signal } = init
    if (signal?.aborted) return reject(abortReason(signal))
    const abort = (): void => reject(abortReason(signal!))
    signal?.addEventListener('abort', abort, { once: true })
    call((id) => native.http(id, init.method ?? 'GET', url, JSON.stringify(init.headers ?? {}), (init.body as string | undefined) ?? null)).then((r) => {
      signal?.removeEventListener('abort', abort)
      try {
        const { status, body } = JSON.parse(r!)
        resolve(new Response(body, { status }))
      } catch (error) { reject(error) }
    }, (error) => { signal?.removeEventListener('abort', abort); reject(error) })
  })

const FILE = 'save.json'

function readSave(): Record<string, any> | null {
  const text = native.read(FILE)
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch (e) {
    // Keep the broken file for manual recovery instead of silently losing the pet.
    native.write(`${FILE}.corrupt-${Date.now()}`, text)
    console.error('save file is corrupt, kept a copy:', e)
    return null
  }
}

let save: SaveData = startSave(legacyAuthorityProbe.canUseLegacy ? readSave() : null)
// Set while reloading into another save: the renderer's pending write must not land on it.
let leaving = false
const legacyAuthorityDisabled = (): boolean => legacyAuthorityProbe.legacyDisabled

/** The device-local qqpet-server address; each shared data module reports upstream_not_configured without one. */
const upstreamBase = (): string | null => normalizeUpstreamUrl(save.settings.upstreamUrl)

const write = (): void => {
  if (legacyAuthorityDisabled()) return
  native.write(FILE, JSON.stringify(save))
}
if (legacyAuthorityProbe.canUseLegacy) write()

// The notification shows the first frame only: reposting it for every frame of the animation would be throttled.
let tray: TrayState = 'leave'
let posted = ''
function showTray(): void {
  const pet = save.petInfo
  const icon = `${pet.sex}/${TRAY_STATES[tray].frames ? `${tray}/1` : tray}.png`
  const tip = trayTip(tray, pet) ?? null
  if (posted === icon + tip) return
  posted = icon + tip
  native.setTray(icon, tip)
}

function relaunch(): void {
  leaving = true
  location.reload()
}

const cursorListeners: ((p: Point) => void)[] = []
const cursor = (p: Point): void => {
  for (const l of cursorListeners) l(p)
}
for (const type of ['pointerdown', 'pointermove'] as const) document.addEventListener(type, (e) => cursor({ x: e.clientX, y: e.clientY }), true)

// While a finger drags, the window covers the screen so the dragged pet or frame is never cut off.
// A tap leaves the window alone: every resize risks a frame where the page and window disagree.
const DRAG_PX = 6
let press: Point | null = null
let dragging = false
document.addEventListener('pointerdown', (e) => (press = { x: e.clientX, y: e.clientY }), true)
document.addEventListener('pointermove', (e) => (dragging ||= press !== null && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX), true)
for (const type of ['pointerup', 'pointercancel'] as const)
  document.addEventListener(
    type,
    () => {
      press = null
      dragging = false
    },
    true,
  )

let bounds = { x: 0, y: 0, w: 0, h: 0 }
// Measuring every element each frame kept the phone busy while nothing changed (#119): right after a touch or a
// window change the window follows every frame, otherwise a few times a second (a bubble or an animation that
// outgrows the window catches up within IDLE_MS).
const BUSY_MS = 2000
const IDLE_MS = 200
const PAUSED_MS = 1000
let busyUntil = 0
let measured = 0
for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) document.addEventListener(type, () => (busyUntil = performance.now() + BUSY_MS), true)
// A bubble, menu or panel appearing changes the page: the window follows it in the next frame, not IDLE_MS later.
// The notification offers 显示宠物 while the pet is hidden.
let hiddenSent: boolean | undefined
const sendHidden = (): void => {
  const on = document.body.classList.contains('petHidden')
  if (on !== hiddenSent) native.setHidden?.((hiddenSent = on))
}
new MutationObserver(sendHidden).observe(document.body, { attributes: true, attributeFilter: ['class'] })
sendHidden()
new MutationObserver(() => (busyUntil = performance.now() + BUSY_MS)).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
function track(now: number): void {
  frame(track)
  // A resize under a resting finger skews the next events (a long press reads as a drag); it waits for the lift.
  if (press && !dragging) return
  // Paused (pet hidden, or the owner away) the page rarely changes: measure seldom, but at once after a change.
  if (!dragging && now >= busyUntil && now - measured < (window.__qqpetHostPaused ? PAUSED_MS : IDLE_MS)) return
  measured = now
  let x = innerWidth
  let y = innerHeight
  let r = 0
  let b = 0
  if (dragging) [x, y, r, b] = [0, 0, innerWidth, innerHeight]
  else
    for (const el of document.body.querySelectorAll('*')) {
      const box = cover(el)
      if (!box) continue
      x = Math.min(x, box.left)
      y = Math.min(y, box.top)
      r = Math.max(r, box.right)
      b = Math.max(b, box.bottom)
    }
  const next = nextBounds(bounds, r > x && b > y ? { left: x, top: y, right: r, bottom: b } : null, innerWidth, innerHeight)
  if (next.x !== bounds.x || next.y !== bounds.y || next.w !== bounds.w || next.h !== bounds.h) {
    native.setBounds(next.x, next.y, next.w, next.h, innerWidth)
    busyUntil = now + BUSY_MS
  }
  bounds = next
}
frame(track)

// The page spans the whole screen, under the status and navigation bars; frames keep clear of them (box.ts).
function safeArea(): void {
  const [left, top, right, bottom] = native.safeArea(innerWidth).split(',')
  const s = document.documentElement.style
  for (const [side, v] of Object.entries({ left, top, right, bottom })) s.setProperty(`--safe-${side}`, `${v}px`)
}
safeArea()
addEventListener('resize', safeArea)

// A touch outside the window means the cursor rests on the desktop: report a viewport corner the window does not cover.
listeners.outside.push(() => {
  const corners = [
    { x: 0, y: 0 },
    { x: innerWidth - 1, y: 0 },
    { x: 0, y: innerHeight - 1 },
    { x: innerWidth - 1, y: innerHeight - 1 },
  ]
  const free = corners.find((p) => p.x < bounds.x || p.y < bounds.y || p.x >= bounds.x + bounds.w || p.y >= bounds.y + bounds.h)
  if (free) cursor(free)
})

const api: QQPetApi = {
  capabilities: {
    rotatableScreen: native.rotatableScreen?.() ?? false,
    serverMode: serverRuntime !== null,
    serverModeClientOnly: serverRuntime !== null,
    localRepositoryV2: localRuntime !== null,
    ...(localRuntimeFailure === undefined ? {} : { localRepositoryV2Reason: localRuntimeFailure }),
  },
  runtimeInfo: async () => ({
    localRepositoryV2: localRuntime !== null,
    serverMode: serverRuntime?.runtimeInfo().serverMode ?? false,
    ...(localRuntimeFailure === undefined && serverRuntimeFailure === undefined ? {} : { reason: localRuntimeFailure ?? serverRuntimeFailure }),
  }),
  async command() {
    throw new Error('local runtime v2 is not active')
  },
  async setAdvanceWhileEmpty() {
    throw new Error('local runtime v2 is not active')
  },
  localSettings: {
    async load() { throw new Error('local runtime v2 is not active') },
    async update() { throw new Error('local runtime v2 is not active') },
  },
  onProjection() {},
  onCommandResult() {},
  onSyncStatus() {},
  onResync() {},
  async requestResync() {},
  getProjection: () => null,
  getStatus: () => legacyRendererStatus(),
  async load() {
    if (legacyV2PresenceError !== undefined) {
      throw new Error('local runtime v2 unavailable: ' + (localRuntimeFailure ?? legacyV2PresenceError))
    }
    if (legacyV2DocumentPresent) throw new Error('local runtime v2 unavailable: ' + (localRuntimeFailure ?? 'local-v2 document exists'))
    if (LOCAL_RUNTIME_V2_FLAG) {
      if (localRuntime === null) throw new Error('local runtime v2 unavailable: ' + (localRuntimeFailure ?? 'unknown'))
      try {
        return await localRuntime.load()
      } catch (error) {
        localRuntimeFailure = error instanceof Error ? error.message : String(error)
        if (api.capabilities) {
          api.capabilities.localRepositoryV2 = false
          api.capabilities.localRepositoryV2Reason = localRuntimeFailure
        }
        throw error
      }
    }
    return cloneJson(save)
  },
  save(patch) {
    if (legacyAuthorityDisabled()) throw new Error('legacy save(patch) is disabled while local runtime v2 is enabled')
    if (leaving) return
    applyPatch(save, cloneJson(patch))
    write()
    if (patch.petInfo) showTray()
  },
  async flush() {
    if (localRuntime !== null) await localRuntime.flush()
  },
  resetPet(sex) {
    if (legacyAuthorityDisabled()) throw new Error('resetPet must use the command API while local runtime v2 is enabled')
    save = buried(save, sex)
    write()
    relaunch()
  },
  async exportSave() {
    const day = new Date().toISOString().slice(0, 10)
    if (localRuntime !== null) {
      const text = await localRuntime.exportPortableBundleJson()
      return (await call((id) => native.exportSave(id, `QQPet-portable-${day}.json`, text))) !== null
    }
    if (legacyAuthorityDisabled()) throw new Error('local runtime v2 unavailable: ' + (localRuntimeFailure ?? 'unknown'))
    return (await call((id) => native.exportSave(id, `QQPet-${day}.json`, JSON.stringify(save, null, 2)))) !== null
  },
  async importSave() {
    if (localRuntime !== null) {
      const text = await call((id) => native.importSave(id))
      if (text === null) return
      await localRuntime.importPortableBundleJson(text)
      relaunch()
      return
    }
    if (legacyAuthorityDisabled()) throw new Error('local runtime v2 unavailable: ' + (localRuntimeFailure ?? 'unknown'))
    const text = await call((id) => native.importSave(id))
    if (text === null) return
    const pet = petOf(JSON.parse(text))
    if (pet.havePet !== true) throw new Error('no pet in this file')
    native.write(`${FILE}.bak`, JSON.stringify(save))
    native.write(FILE, JSON.stringify(pet))
    relaunch()
  },
  openGame: (swf, windowId) => forwardOpenGame(native, swf, windowId),
  // Small games only: a trusted KeyEvent reaches Ruffle's AS listener; false falls back to DOM.
  sendGameKey: (code, phase) => {
    if (code !== 'ArrowLeft' && code !== 'ArrowRight') return Promise.resolve(false)
    if (phase !== 'down' && phase !== 'up') return Promise.resolve(false)
    // A direct native call may bypass the D-pad's focus/start click; prepare the cloud first.
    try { (window as Window & { __qqpetSmallGameKeyPrepare?: () => void }).__qqpetSmallGameKeyPrepare?.() } catch { /* old page */ }
    const inject = (): boolean => {
      try { return native.sendGameKey?.(code, phase) === true } catch { return false }
    }
    // Let Ruffle process the start click and install CloudControl's KEY_DOWN listener before
    // the first native key. A quick up waits for the pending down, so ordering cannot invert.
    if (phase === 'down') {
      const pending = pendingGameDown.get(code)
      if (pending) return pending
      const down = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          pendingGameDown.delete(code)
          resolve(inject())
        }, 80)
      })
      pendingGameDown.set(code, down)
      return down
    }
    const pending = pendingGameDown.get(code)
    return pending ? pending.then(() => inject()) : Promise.resolve(inject())
  },
  calendar: () => calendar(nativeFetch, upstreamBase()),
  aiModels: (c) => aiModels(nativeFetch, c),
  aiChat: (c, messages) => aiChat(nativeFetch, c, messages),
  webSearch: (query) => webSearch(nativeFetch, query),
  weather: (city) => weather(nativeFetch, upstreamBase(), city),
  latestRelease: () => latestRelease(nativeFetch, upstreamBase()),
  quit() {
    if (localRuntime === null) { native.quit(); return }
    const runtime = localRuntime
    void runtime.flush().then(() => runtime.stop()).finally(() => native.quit())
  },
  copyText: (text) => native.copyText(text),
  openUrl: (url) => native.openUrl(url),
  // The overlay window follows the content instead.
  setClickThrough() {},
  // Overlay windows are always on top.
  setAlwaysOnTop() {},
  setFocusable: (on) => native.setFocusable(on),
  setAutoStart: (on) => native.setAutoStart(on),
  setTrayState(state) {
    tray = state
    showTray()
  },
  onCursor: (l) => void cursorListeners.push(l),
  // The notification has no position; its panels open mid-screen, not under the status bar.
  onTrayClick: (l) => void listeners.trayClick.push((c) => l({ ...c, x: innerWidth / 2, y: innerHeight / 2 })),
  onGamePlayed: (l) => void listeners.gamePlayed.push((payload) => forwardGamePlayed(l, payload)),
  // Android only lets the focused app read the clipboard; text arrives through the selection menu and share sheet instead.
  onClipboard: (l) => void listeners.clipboard.push(l),
  onPresence: (l) => void listeners.presence.push((away) => {
    if (localRuntime !== null) void (away ? localRuntime.suspend() : localRuntime.resume())
    l(away)
  }),
  onFront() {},
}

window.qqpet = api

// Ruffle's "复制错误详情" calls navigator.clipboard.writeText and ticks without waiting for it; the overlay
// WebView is not focused, so the web clipboard refuses and nothing is copied (#18). Copy natively instead.
{
  const writeText = (text: string): Promise<void> => {
    native.copyText(String(text))
    return Promise.resolve()
  }
  if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText })
  else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

if (serverRuntime !== null) {
  const runtime = serverRuntime
  const localSave = api.save
  const localExportSave = api.exportSave
  const localImportSave = api.importSave
  const localResetPet = api.resetPet
  let rendererProjectionListener: ((projection: RendererProjection, events: OrderedEvent[]) => void) | null = null
  let rendererResyncListener: ((projection: RendererProjection, events: OrderedEvent[]) => void) | null = null

  api.runtimeInfo = async () => runtime.runtimeInfo()
  api.storage = runtime.storage
  api.load = () => runtime.load()
  api.command = (command, options) => runtime.command(command, options)
  api.setAdvanceWhileEmpty = async (enabled) => { await runtime.setAdvanceWhileEmpty(enabled) }
  api.localSettings = {
    load: () => runtime.localSettings.load(),
    update: patch => runtime.localSettings.update(patch),
  }
  api.onProjection = listener => { rendererProjectionListener = listener }
  api.onResync = listener => { rendererResyncListener = listener }
  api.requestResync = async () => { runtime.requestResync() }
  api.onCommandResult = listener => runtime.onCommandResult(listener)
  api.onSyncStatus = listener => runtime.onSyncStatus(listener)
  api.getProjection = () => runtime.getProjection()
  api.getStatus = () => runtime.getStatus()
  api.flush = async () => { await runtime.flush() }
  api.save = (patch) => {
    if (runtime.isServerActive()) throw new Error('canonical_mutation_blocked: server mode never accepts a save patch')
    localSave(patch)
  }
  api.exportSave = async () => {
    if (runtime.isServerActive() === false) return localExportSave()
    const report = await runtime.storage.exportBundle()
    return (await call((id) => native.exportSave(id, report.fileName, report.json))) !== null
  }
  api.importSave = async () => {
    if (runtime.isServerActive()) throw new Error('unsupported: server mode does not import a local save on Android（服务器模式不支持导入本机存档）')
    return localImportSave()
  }
  api.resetPet = (sex) => {
    if (runtime.isServerActive() === false) {
      localResetPet(sex)
      return
    }
    void runtime.command({ type: 'pet.reset', payload: {} }).then(
      (result) => {
        if (result.status === 'applied' || result.status === 'duplicate') relaunch()
        else console.error('pet.reset rejected:', result)
      },
      (error) => console.error('pet.reset failed:', error),
    )
  }
  api.quit = () => {
    void runtime.stop().catch(() => undefined).finally(() => native.quit())
  }
  api.onPresence = (listener) => {
    listeners.presence.push((away) => {
      void runtime.handlePresence(away)
      listener(away)
    })
  }
  runtime.onProjection((projection, events) => {
    save = projection.save
    showTray()
    rendererProjectionListener?.(projection, events)
  })
  runtime.onResync((projection, events) => {
    save = projection.save
    showTray()
    rendererResyncListener?.(projection, events)
  })
} else if (localRuntime !== null) {
  const runtime = localRuntime
  api.runtimeInfo = async () => runtime.runtimeInfo()
  api.command = runtime.command.bind(runtime)
  api.setAdvanceWhileEmpty = async (enabled) => { await runtime.setAdvanceWhileEmpty(enabled) }
  api.localSettings = {
    load: () => runtime.localSettings.load(),
    update: patch => runtime.localSettings.update(patch),
  }
  api.onProjection = listener => runtime.onProjection(listener)
  api.onResync = listener => runtime.onResync(listener)
  api.requestResync = async () => runtime.requestResync()
  api.onCommandResult = listener => runtime.onCommandResult(listener)
  api.onSyncStatus = listener => runtime.onSyncStatus(listener)
  api.getProjection = () => runtime.getProjection()
  api.getStatus = () => runtime.getStatus()
  runtime.onProjection((projection) => {
    save = projection.save
    showTray()
  })
}
if (LOCAL_RUNTIME_V2_FLAG) {
  addEventListener('pagehide', () => {
    if (leaving) return
    if (serverRuntime !== null) {
      void serverRuntime.handlePresence(true)
      return
    }
    if (localRuntime !== null) void localRuntime.suspend()
  })
  document.addEventListener('visibilitychange', () => {
    if (leaving) return
    if (serverRuntime !== null) {
      void serverRuntime.handlePresence(document.visibilityState === 'hidden')
      return
    }
    if (localRuntime === null) return
    if (document.visibilityState === 'hidden') void localRuntime.suspend()
    else void localRuntime.resume()
  })
}
