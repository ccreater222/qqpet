import { speak } from '../pet/pet'
import { busy, earnYb, info, playingDesk, refreshTray, runtimeProjectionMode, save, setDeskGame, setInfo, setTray, stage } from '../pet/store'
import { addCount } from '../pet/tasks'
import { SwfPlayer } from '../swf/player'
import { uiCommands } from '../pet/command-map'
import { commandResultData, dispatchRuntimeCommand } from '../pet/runtime-command'
import './css/smallgame.css'
import { button, div, touch } from './dom'
import { floatMood } from './float'
import { clampRoot, paopaoGameArea, type PaopaoGameArea } from './smallgame-geometry'
import type { GameKeyCode, GameKeyPhase } from '../../shared/renderer-api'

/**
 * The original client's desktop games (pet/smallGame). Each SWF is its own
 * borderless window, driven through ExternalInterface: "API.*" manages the
 * windows and calls between them, "TICKLE_*" reads and rewards the pet.
 * Every window is an iframe with its own Ruffle, so "API" knows its caller.
 */
export interface SmallGame {
  dir: string
  name: string
  icon?: string
  kidOnly?: boolean
  /** Shells reserved for the root plus this game's fixed base windows (status/prompt/cloud…). */
  baseWindows: number
  /** Extra shells for object/action windows beyond the base reserve. */
  maxDynamicWindows: number
  /** Prompt SWFs that can wait for their first Show/RemoteCall on a touch host. */
  lazyWindows?: string[]
  /** On-screen keys rendered for touch hosts (only small games that need a keyboard). */
  keyboard?: ('left' | 'right')[]
}

const ARROW_KEYS: ('left' | 'right')[] = ['left', 'right']

export const SMALL_GAMES = [
  // Icons: the original TickleSystem quick bar (pet/quickBar/TickleSystem/*00.png).
  // guess has six base SWFs (two status + four prompts) plus its root, then three actions.
  { dir: 'guess', name: '猜动作', baseWindows: 7, maxDynamicWindows: 3, icon: 'guess' },
  // paopao2: root + four base, and difficult can spawn six bubbles in one cluster.
  // Prompts stay eager: 0.13 deferred them and the root's onWindowCreate waitList never completed.
  { dir: 'paopao2', name: '吹泡泡', baseWindows: 5, maxDynamicWindows: 6, icon: 'paopao' },
  { dir: 'rope', name: '跳绳', baseWindows: 5, maxDynamicWindows: 0, icon: 'tiaosheng' },
  // One rat window is reused; the probe will confirm if it ever opens more.
  { dir: 'mouse', name: '捉老鼠', baseWindows: 5, maxDynamicWindows: 1, icon: 'duolaoshu' },
  // ball can build left/right base sets: root + seven base variants, then three balls.
  { dir: 'ball', name: '颠球', baseWindows: 8, maxDynamicWindows: 3, icon: 'tanliqiu' },
  // 100ceng: root + cloud + player + two prompts; it only accepts arrow keys after the start.
  { dir: '100ceng', name: '下一百层', baseWindows: 5, maxDynamicWindows: 0, keyboard: ARROW_KEYS, kidOnly: true, icon: undefined },
] satisfies SmallGame[]
/** Same table with the optional budget widened, for lookups that may miss an entry. */
const GAMES: SmallGame[] = SMALL_GAMES

/** Every main_*.swf stage is 140×140. */
const MAIN = 140
/** Per Tickle.sendAction (the games send one every 5 hits); guess's offline defaults. */
const REWARD = { mood: 55, yb: 1 }
/**
 * SWFs that never listen to the mouse. Native layered windows let clicks through
 * their transparent pixels; an iframe swallows its whole rect, so these must not.
 */
const PASSIVE = /^(prompt_(money|mood|timer)|status_count|shadow|player_|rat\.)/
/**
 * Each shell is a separate iframe with its own Ruffle WASM heap (~84MB on the
 * Android WebView). The browser does not return that memory after the iframe is
 * removed, so shells are pooled between games and their number is capped.
 */
/** Fallback cap while no game directory is active (the paopao2-era budget). */
const DEFAULT_SHELL_CAP = 9

type Kind = 'root' | 'base' | 'bubble'

interface Win {
  name: string
  parent: Win | null
  box: HTMLDivElement
  frame: HTMLIFrameElement
  player?: SwfPlayer
  x: number
  y: number
  w: number
  h: number
  drag: boolean
  /** SWF file the shell last loaded; the pool key is this plus the window size. */
  swf: string
  key: string
  /** Game directory that last used the shell; idle shells from another game are evictable. */
  dir: string
  kind: Kind
  /** Creation order inside the current game; the oldest bubble is evicted first. */
  seq: number
  /** Set by Show(SW_SHOW): provisional (never shown) windows are never evicted. */
  everShown: boolean
  /** The iframe's one-time load event has run (API/draggable/player are bound). */
  bound: boolean
  loading: boolean
  loadToken: number
  pooled: boolean
  /** Prompt overlays wait for their first Show/RemoteCall before a Ruffle player is built. */
  lazy: boolean
  demanded: boolean
  /** Visibility the SWF asked for while a lazy prompt is still unloaded. */
  pendingVisible: boolean
  /** RemoteCalls that arrived before a lazy prompt's movie was ready. */
  pending: { fn: string; args: unknown[] }[]
  /** The shell's quit button; only root shells own one, and a reused shell must keep exactly one. */
  quit: HTMLElement | null
}

type Fn = (...a: never[]) => unknown

const wins = new Map<string, Win>()
/**
 * Idle shells kept alive between games. A pooled iframe must stay connected:
 * player.ts destroys any SwfPlayer whose element/frame leaves the document.
 */
const pools = new Map<string, Win[]>()
/** Every allocated shell, pooled or live. Bounded by shellCap() on touch hosts. */
const shells = new Set<Win>()
/**
 * `touch` is the primary-pointer-is-a-finger flag. It decides shell pooling, root clamping and
 * prompt laziness. This module is also loaded by converted-source tests that strip imports, so
 * the lookup tolerates a missing binding instead of failing at module scope.
 */
const touchHost = (): boolean => typeof touch === 'boolean' && touch
/** A touch host builds prompt overlays only when the SWF first shows or calls them. */
const currentGame = (): SmallGame | undefined => GAMES.find((entry) => entry.dir === dir)

/** Only prompts declared by the current game are lazy; 100ceng/guess prompts must appear at create. */
const isLazyPrompt = (swf: string): boolean => touchHost() && (currentGame()?.lazyWindows?.includes(swf) ?? false)

/** On-screen keys the current game needs; empty for mouse/touch-only games. */
const keyboardKeys = (): ('left' | 'right')[] => currentGame()?.keyboard ?? []

/** Per-game shell budget: fixed base windows plus the game's own dynamic-window allowance. */
const shellCap = (): number => {
  const game = currentGame()
  return game ? game.baseWindows + game.maxDynamicWindows : DEFAULT_SHELL_CAP
}

/**
 * Lazy prompts that have never been demanded cost an iframe but no Ruffle/WASM heap, so the
 * cap only counts shells that are demanded or already own a player. Demanding one re-runs
 * trimPool() to reclaim the space its base allowance reserved.
 */
const activeShells = (): number => {
  let count = 0
  for (const w of shells) if (!w.lazy || w.demanded || w.player) count++
  return count
}
/** Windows inside an ExternalInterface call; Ruffle cannot be re-entered, so calls to them wait. */
const inCall = new Set<Win>()
let root: Win | null = null
let dir = ''
let seq = 0
/** Active runtime game session; settled when the game window closes. */
let runtimeSessionToken: string | null = null
let runtimeStarting = false
/** Above .smallGameWin's own z-index, or "topmost" would sink below every other window. */
let top = 50

const poolKey = (swf: string, w: number, h: number): string => `${swf}|${w}x${h}`

const kindOf = (swf: string, parent: Win | null): Kind =>
  parent === null ? 'root' : /status_|prompt_/.test(swf) ? 'base' : 'bubble'

const place = (w: Win): void => {
  // A move clip can shift a root by hundreds of pixels (paopao2's MoveUp is 42 frames of 10 px);
  // on a touch viewport that is enough to lose the pet and its quit button. Clamp every root;
  // paopao2 additionally gets the virtual game area below, other games keep real coordinates.
  if (touchHost() && w.kind === 'root') {
    const clamped = clampRoot(w.x, w.y, w.w, w.h, innerWidth, innerHeight)
    w.x = clamped.x
    w.y = clamped.y
  }
  Object.assign(w.box.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px` })
}

const guard =
  (w: Win, f: Fn): Fn =>
  (...a) => {
    inCall.add(w)
    try {
      return f(...a)
    } finally {
      inCall.delete(w)
    }
  }

function call(w: Win | undefined, fn: string, args: unknown[]): unknown {
  if (!w?.player || wins.get(w.name) !== w) return undefined
  if (inCall.has(w)) return void setTimeout(() => call(w, fn, args))
  return w.player.el.ruffle().callExternalInterface(fn, ...args)
}

/** Last primary pointer position in CSS client px; small-game coordinates are derived from it. */
let lastPointer: { x: number; y: number } | null = null
/** Only the primary finger drives the bridge; a second finger must not move the hit point. */
let activePointer: number | null = null

interface BoxRect {
  left: number
  top: number
  width: number
  height: number
}

const boxRect = (w: Win): BoxRect => {
  const box = w.box as HTMLElement & { getBoundingClientRect?: () => DOMRect }
  if (typeof box.getBoundingClientRect === 'function') {
    const r = box.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  return { left: w.x, top: w.y, width: w.w, height: w.h }
}

const localPoint = (w: Win, x: number, y: number): { x: number; y: number } => {
  const r = boxRect(w)
  return { x: x - r.left, y: y - r.top }
}

const isPadTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  return !!el && typeof el.closest === 'function' && !!el.closest('.smallGameKeys, .smallGameKey, .quit')
}

/** Visible shells whose box contains the point; passive windows (rat/shadow/player_) are included. */
const windowsAt = (x: number, y: number): Win[] => {
  const out: Win[] = []
  for (const w of wins.values()) {
    if (!w.player || w.loading || w.pooled || w.box.hidden) continue
    const r = boxRect(w)
    if (x < r.left || y < r.top || x >= r.left + r.width || y >= r.top + r.height) continue
    out.push(w)
  }
  return out
}

/** A real tap on a passive rat window is forwarded to the mouse game's pet, which owns the jump. */
function ratAt(x: number, y: number): boolean {
  if (dir !== 'mouse') return false
  for (const w of wins.values()) {
    if (!/^rat\./.test(w.swf) || !w.player || w.loading || w.pooled || w.box.hidden) continue
    const r = boxRect(w)
    if (x >= r.left && y >= r.top && x < r.left + r.width && y < r.top + r.height) return true
  }
  return false
}

function forwardMouseTapToPet(rootWin: Win): void {
  if (dir !== 'mouse' || !rootWin.player) return
  const el = rootWin.player.el as HTMLElement & { shadowRoot?: ShadowRoot }
  const canvas = el.shadowRoot?.querySelector('#container canvas') as HTMLElement | null
  const target = canvas ?? el
  const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null
  // The pet sprite sits slightly left of the 140x140 root's centre in the original layout.
  const x = rect ? rect.left + rect.width * 0.4 : 0
  const y = rect ? rect.top + rect.height * 0.47 : 0
  focusGame(rootWin)
  const view = rootWin.frame.contentWindow
  let P: typeof PointerEvent | undefined
  let M: typeof MouseEvent | undefined
  try {
    const w = view as (Window & { PointerEvent?: typeof PointerEvent; MouseEvent?: typeof MouseEvent }) | null
    P = w?.PointerEvent ?? PointerEvent
    M = w?.MouseEvent ?? MouseEvent
  } catch { return }
  for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
    if (!P) break
    try { target.dispatchEvent(new P(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 })) } catch { /* iframe gone */ }
  }
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    if (!M) break
    try { target.dispatchEvent(new M(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 })) } catch { /* iframe gone */ }
  }
  gameKeyDebug.mouseForwards += 1
}

/**
 * Native desktop windows get real mouse events; on a touch host the passive rat/shadow/player
 * iframes never do. The bridge records the primary pointer and feeds the same coordinates to
 * every visible window under it; `call` is a safe no-op for SWFs that did not register a callback.
 */
const pointerHit = (e: PointerEvent, phase: 'move' | 'down'): void => {
  if (!touchHost() || e.isPrimary === false || isPadTarget(e.target)) return
  if (activePointer !== null && e.pointerId !== activePointer) return
  const x = e.clientX
  const y = e.clientY
  lastPointer = { x, y }
  for (const w of windowsAt(x, y)) {
    const p = localPoint(w, x, y)
    call(w, 'APIEvent.OnMouseMove', [Math.round(p.x), Math.round(p.y)])
    if (phase === 'down') call(w, 'APIEvent.OnHitWindow', [Math.round(p.x), Math.round(p.y)])
  }
}

const pointerMove = (e: PointerEvent): void => pointerHit(e, 'move')
const pointerDown = (e: PointerEvent): void => {
  if (e.isPrimary === false) return
  activePointer = e.pointerId
  pointerHit(e, 'down')
  // The rat is PASSIVE and has no click handler; on touch the pet's jump lives in the root.
  // Forward rat taps to the root pet so the verifier's rat-tap sequence is playable.
  if (!isPadTarget(e.target) && root && ratAt(e.clientX, e.clientY)) forwardMouseTapToPet(root)
}
const pointerUp = (e: PointerEvent): void => {
  if (activePointer !== null && e.pointerId !== activePointer) return
  if (activePointer === e.pointerId) activePointer = null
  if (!isPadTarget(e.target)) lastPointer = { x: e.clientX, y: e.clientY }
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointermove', pointerMove, true)
  document.addEventListener('pointerdown', pointerDown, true)
  document.addEventListener('pointerup', pointerUp, true)
  document.addEventListener('pointercancel', pointerUp, true)
}

function removeFromPool(w: Win): void {
  for (const [key, list] of pools) {
    const index = list.indexOf(w)
    if (index < 0) continue
    list.splice(index, 1)
    if (list.length === 0) pools.delete(key)
    return
  }
}

function takePooled(key: string): Win | undefined {
  const list = pools.get(key)
  const win = list?.pop()
  if (list && list.length === 0) pools.delete(key)
  return win
}

/** Removes a shell for good: its player is destroyed and its iframe leaves the document. */
function dropShell(w: Win): void {
  removeFromPool(w)
  shells.delete(w)
  w.player?.destroy()
  w.player = undefined
  w.box.remove()
}

/**
 * Frees one shell slot. Idle pooled shells are cheapest (bubbles first, then base/root left by
 * another game); a live bubble only after the SWF has shown it. A live base/root or an unshown
 * provisional window is never evicted, so a game switch cannot starve the next game's windows.
 */
function evictOne(keepRootKey?: string): boolean {
  // The root is always the oldest shell, so a trim before open() would evict the exact shell the
  // next game is about to claim. Keep one root shell matching the upcoming root's pool key.
  const keep = (w: Win): boolean => w.kind === 'root' && w.key === keepRootKey
  const pooledBubbles: Win[] = []
  const pooledOther: Win[] = []
  for (const list of pools.values()) {
    for (const w of list) (w.kind === 'bubble' ? pooledBubbles : pooledOther).push(w)
  }
  const byAge = (a: Win, b: Win): number => a.seq - b.seq
  pooledBubbles.sort(byAge)
  pooledOther.sort(byAge)
  const foreign = pooledOther.filter((w) => w.dir !== dir && !keep(w))
  const liveBubbles = [...wins.values()].filter((w) => w.kind === 'bubble' && w.everShown).sort(byAge)
  const victim = pooledBubbles[0] ?? foreign[0] ?? liveBubbles[0] ?? pooledOther.find((w) => !keep(w))
  if (!victim) return false
  if (wins.get(victim.name) === victim) wins.delete(victim.name)
  dropShell(victim)
  return true
}

function trimPool(keepRootKey?: string): void {
  while (touchHost() && activeShells() > shellCap() && evictOne(keepRootKey)) { /* keep trimming */ }
}

/**
 * At the cap, an old bubble shell of the same size is repurposed for the new bubble instead of
 * allocating another iframe: the browser does not return a removed iframe's WASM heap, so
 * destroy-then-create would leak again inside a long game. The old window name disappears
 * (its SWF sees a null-safe API); the shell is reloaded with the new SWF.
 */
function reclaim(name: string, parent: Win | null, swf: string, x: number, y: number, width: number, height: number): Win | undefined {
  const asRoot = parent === null
  let victim: Win | undefined
  const consider = (w: Win): void => {
    if (w.loading || w.w !== width || w.h !== height) return
    // Only a root shell may become a root again, and a root shell may never be repurposed as a
    // base/bubble. A 140x140 prompt/base has no quit button; promoting it to root used to leave
    // mobile players with no way to quit, while a root demoted to a child kept a stray quit.
    if (asRoot !== (w.kind === 'root')) return
    if (!victim || w.seq < victim.seq) victim = w
  }
  // Idle shells of any kind may be repurposed; a live window only if it is a shown bubble.
  for (const list of pools.values()) for (const w of list) consider(w)
  for (const w of wins.values()) if (w.kind === 'bubble' && w.everShown) consider(w)
  if (!victim) return undefined
  if (wins.get(victim.name) === victim) wins.delete(victim.name)
  removeFromPool(victim)
  activate(victim, name, parent, swf, x, y, width, height)
  return victim
}

/** Hides a finished window and keeps its iframe + Ruffle instance for the next game. */
function recycle(w: Win): void {
  if (!touchHost()) {
    shells.delete(w)
    setTimeout(() => w.box.remove())
    return
  }
  // A half-built or still-loading player cannot be reloaded; SwfPlayer.load rejects while busy.
  if (!w.bound || w.loading) {
    dropShell(w)
    return
  }
  w.box.hidden = true
  w.box.style.display = 'none'
  w.box.dataset.pooled = '1'
  w.player?.setIdle(true)
  w.parent = null
  w.pooled = true
  const list = pools.get(w.key)
  if (list) list.push(w)
  else pools.set(w.key, [w])
  trimPool()
}

/** A window may destroy itself from its own call, so its iframe goes after the call returns. */
function destroy(w: Win | null | undefined): void {
  if (!w || wins.get(w.name) !== w) return
  for (const c of [...wins.values()]) if (c.parent === w) destroy(c)
  wins.delete(w.name)
  // Recycle while the game directory is still active: finish() clears `dir`, and trimPool() would
  // then fall back to DEFAULT_SHELL_CAP=9 instead of the game's real budget (paopao2: 11 → 9,
  // destroying two WASM shells after every full round).
  recycle(w)
  if (w === root) finish()
}

/** A failed load must not leave an empty iframe (or a dead player) behind. */
function discard(w: Win): void {
  if (wins.get(w.name) === w) wins.delete(w.name)
  dropShell(w)
  if (w === root) finish()
}

function finish(): void {
  removeKeypad()
  setNativeGameKeyActive(false)
  root = null
  dir = ''
  cloudStarted = false
  setDeskGame('')
  document.getElementById('pet')!.hidden = false
  window.qqpet.setFocusable(false)
  if (runtimeProjectionMode) {
    const token = runtimeSessionToken
    runtimeSessionToken = null
    if (token !== null) {
      void dispatchRuntimeCommand(uiCommands.gameReward(token)).then((result) => {
        const data = commandResultData<{ minutes: number; yb: number; mood: number }>(result)
        if (data === null || data.minutes <= 0) return
        void floatMood(data.mood)
        speak({ s: `[host]，陪我玩了${data.minutes}分钟小游戏，好开心！获得${data.yb}元宝~`, now: true }, 'speak')
      })
    }
    refreshTray()
    return
  }
  addCount('GameRound')
  refreshTray()
}

function reward(w: Win): void {
  const mood = Math.min(REWARD.mood, save.petComputedlInfo.moodMax - info.mood)
  if (runtimeProjectionMode) {
    // Presentation only: the host settles the session once when the window closes.
    call(w, 'TICKLE_OnResult', [mood, REWARD.yb])
    return
  }
  setInfo('mood', info.mood + mood)
  const yb = earnYb(REWARD.yb)
  call(w, 'TICKLE_OnResult', [mood, yb])
}

/** The "API" object one window's SWF sees; a missing window name means the caller. */
function api(self: Win): Record<string, Fn> {
  const of = (name?: string): Win | undefined => (name ? wins.get(name) : self)
  // paopao2's SWF only knows the desktop 200/350/365 margins; on a phone viewport the root is
  // mapped onto a virtual desktop-sized game area so those margins stop covering the whole
  // screen. Recomputed per call, so rotation/resize is picked up. Children keep real coordinates.
  const area = (): PaopaoGameArea | null =>
    self.kind === 'root' && dir === 'paopao2' ? paopaoGameArea(innerWidth, innerHeight) : null
  /** What this caller's SWF sees for a window: virtual only for the mapped root itself. */
  const view = (w: Win): { x: number; y: number } => {
    const a = area()
    return a !== null && w === self ? { x: w.x + a.offset, y: w.y + a.offset } : { x: w.x, y: w.y }
  }
  /** A root caller passes virtual coordinates; windows are stored in real pixels. */
  const real = (x: number, y: number): { x: number; y: number } => {
    const a = area()
    return a !== null ? { x: x - a.offset, y: y - a.offset } : { x, y }
  }
  const move = (w: Win, x: number, y: number): number => {
    w.x = x
    w.y = y
    place(w)
    return 1
  }
  // Every lookup is null-safe: a SWF keeps window names long after the host pooled or dropped
  // them (provisional bubble arrays), and a TypeError would kill its ExternalInterface call.
  const methods: Record<string, Fn> = {
    IsVisible: (n?: string) => {
      const t = of(n)
      return t ? +!t.box.hidden : 0
    },
    IsEnableDrag: (n?: string) => {
      const t = of(n)
      return t ? +t.drag : 0
    },
    EnableDrag: (on: number, n?: string) => {
      const t = of(n)
      if (!t) return 0
      t.drag = on === 1
      return 1
    },
    DestroyWindow: (n?: string) => {
      const t = of(n)
      if (!t) return 0
      destroy(t)
      return 1
    },
    ResizeWindow: (width: number, height: number, n?: string) => {
      const t = of(n)
      if (!t) return 0
      Object.assign(t, { w: width, h: height })
      place(t)
      return 1
    },
    MoveTo: (x: number, y: number, n?: string) => {
      const t = of(n)
      if (!t) return 0
      const p = real(x, y)
      return move(t, p.x, p.y)
    },
    // Relative in both spaces: no conversion needed.
    MoveBy: (dx: number, dy: number, n?: string) => {
      const t = of(n)
      if (!t) return 0
      return move(t, t.x + dx, t.y + dy)
    },
    GetWindowRect: (n?: string) => {
      const t = of(n)
      if (!t) return '0,0,0,0'
      const p = view(t)
      return `${p.x},${p.y},${t.w},${t.h}`
    },
    GetWindowPosition: () => {
      const p = view(self)
      return `${p.x},${p.y}`
    },
    GetScalable: () => 1,
    SetScalable: () => 1,
    CreateWindow: (name: string, x: number, y: number, width: number, height: number, hidden: number, swf: string) => {
      const old = wins.get(name)
      if (old) destroy(old)
      const p = real(x, y)
      const win = open(name, self, swf, p.x, p.y, width, height)
      if (!win) return 0
      win.pendingVisible = hidden === 0
      win.box.hidden = hidden === 1
      return 1
    },
    // 0 self, -1 parent, 1 children.
    GetWindowName: (opt: number) =>
      opt === 0 ? self.name : opt === -1 ? (self.parent?.name ?? '') : [...wins.values()].filter((c) => c.parent === self).map((c) => c.name),
    SetWindow: (op: string, n?: string) => {
      const t = of(n)
      if (t && op === 'topmost') t.box.style.zIndex = String(++top)
    },
    Show: (cmd: number, n?: string) => {
      const t = of(n)
      if (!t) return 0
      // 100ceng and ball call ShowWindow with Windows semantics (SW_SHOW=1 / SW_HIDE=0):
      // 100ceng reveals its player with Show(1); ball reveals the thrown ball with Show(1) and
      // hides it again with Show(0). Every other small game historically uses 0=show here, and
      // the bubble tests depend on that; keep their semantics and special-case these two games.
      const show = self.dir === '100ceng' || self.dir === 'ball' ? cmd === 1 : cmd === 0
      t.pendingVisible = show
      if (show) {
        if (t.lazy) demand(t)
        t.box.hidden = false
        t.everShown = true
      } else {
        t.box.hidden = true
        if (t.lazy) t.player?.setIdle(true)
      }
      return 1
    },
    GetCursorPosition: () => {
      if (!touchHost() || !lastPointer) return window.API.GetCursorPosition()
      const p = localPoint(self, lastPointer.x, lastPointer.y)
      return `${Math.round(p.x)},${Math.round(p.y)},0`
    },
    // Ruffle's Capabilities.screenResolution is the player's own size; the patched SWFs ask these instead.
    GetScreenWidth: () => area()?.width ?? innerWidth,
    GetScreenHeight: () => area()?.height ?? innerHeight,
    RemoteCall: (n: string, fn: string, ...args: never[]) => {
      const t = wins.get(n)
      if (!t) return undefined
      if (t.lazy && (!t.demanded || t.loading || !t.player)) {
        demand(t)
        t.pending.push({ fn, args })
        return undefined
      }
      return call(t, fn, args)
    },
  }
  for (const [k, f] of Object.entries(methods)) methods[k] = guard(self, f)
  return methods
}

/** Drags a window whose SWF enabled it, reporting each step like a moved native window. */
function draggable(w: Win, doc: Document): void {
  doc.addEventListener(
    'pointerdown',
    (e) => {
      if (!w.drag || e.button !== 0) return
      let sx = e.screenX
      let sy = e.screenY
      const move = (m: PointerEvent): void => {
        w.x += m.screenX - sx
        w.y += m.screenY - sy
        sx = m.screenX
        sy = m.screenY
        place(w)
        call(w, 'APIEvent.OnWindowMove', [w.x, w.y, w.w, w.h])
      }
      doc.addEventListener('pointermove', move, true)
      doc.addEventListener('pointerup', () => doc.removeEventListener('pointermove', move, true), { once: true, capture: true })
    },
    true,
  )
}

interface Keypad {
  root: HTMLDivElement
  left: HTMLDivElement | null
  right: HTMLDivElement | null
  /** Releases both buttons' native/DOM keys when the game ends or the page hides. */
  releaseAll: () => void
}

let keypad: Keypad | null = null

const KEY_CODES = {
  left: { key: 'ArrowLeft', code: 37 },
  right: { key: 'ArrowRight', code: 39 },
} as const

/** Ruffle only forwards keys while its player owns focus. Mirror gamepad.ts: player first. */
function focusGame(w: Win): void {
  try { w.player?.el.focus() } catch { /* the player may have gone */ }
  const frame = w.frame as HTMLIFrameElement & { focus?: () => void }
  try { if (typeof frame.focus === 'function') frame.focus() } catch { /* the iframe may have gone */ }
  try { w.frame.contentWindow?.focus() } catch { /* the iframe may have gone */ }
}

/** Dispatches into the iframe realm, but constructs the event exactly like gamepad.ts (host realm). */
function sendKeyTo(w: Win, type: 'keydown' | 'keyup', side: 'left' | 'right'): void {
  const view = w.frame.contentWindow
  const doc: Document | null = view?.document ?? w.frame.contentDocument ?? null
  const player = w.player
  if (!doc && !player) return
  const spec = KEY_CODES[side]
  const init = {
    key: spec.key,
    code: spec.key,
    keyCode: spec.code,
    which: spec.code,
    bubbles: true,
    composed: true,
    cancelable: true,
  } as KeyboardEventInit & { keyCode: number; which: number }
  const make = (): KeyboardEvent => {
    try {
      return new KeyboardEvent(type, init)
    } catch {
      const Ctor = (view as (Window & { KeyboardEvent?: typeof KeyboardEvent }) | null)?.KeyboardEvent ?? KeyboardEvent
      return new Ctor(type, init)
    }
  }
  focusGame(w)
  // gamepad.ts dispatches on the Ruffle player; do that first so its input path sees it, then
  // also give the iframe window/document a bubbling copy for verifiers and any document listeners.
  if (player) {
    try { player.el.dispatchEvent(make()) } catch { /* the player may have gone */ }
  }
  if (view && typeof view.dispatchEvent === 'function') {
    try { view.dispatchEvent(make()) } catch { /* the iframe may have gone */ }
  }
  if (doc) {
    try { doc.dispatchEvent(make()) } catch { /* the iframe may have gone */ }
  }
}

/**
 * 100ceng's intro only installs its KeyboardEvent listeners after the cloud is clicked. The
 * verifier's synthetic MouseEvents on the canvas did not start it, so send real pointer events
 * to the cloud's Ruffle canvas before the first arrow of every press; after start the click
 * listener is gone, making repeats harmless.
 */
function focusCloudWindow(rootWin: Win): Win | null {
  for (const child of wins.values()) {
    if (child.parent !== rootWin || !child.player || child.box.hidden || !/^cloud_/.test(child.swf)) continue
    focusGame(child)
    gameKeyDebug.cloudFocus += 1
    const player = [...wins.values()].find((c) => c.parent === rootWin && /^player_/.test(c.swf))
    gameKeyDebug.playerHidden = player ? player.box.hidden === true : null
    return child
  }
  return null
}

/**
 * The intro click only has to happen once per 100ceng round: the first down starts the cloud,
 * every repeat tick and every native `sendGameKey` (which also calls the prepare hook) must not
 * synthesize the pointer/mouse sequence again. Reset in finish() for the next round.
 */
let cloudStarted = false

function clickCloudStart(rootWin: Win): void {
  if (dir !== '100ceng' || cloudStarted) return
  const cloud = focusCloudWindow(rootWin)
  if (!cloud) return
  cloudStarted = true
  gameKeyDebug.cloudClicks += 1
  const el = cloud.player!.el as HTMLElement & { shadowRoot?: ShadowRoot }
  const canvas = el.shadowRoot?.querySelector('#container canvas') as HTMLElement | null
  const targets = canvas ? [canvas] : [el]
  const view = cloud.frame.contentWindow
  let P: typeof PointerEvent | undefined
  let M: typeof MouseEvent | undefined
  try {
    const w = view as (Window & { PointerEvent?: typeof PointerEvent; MouseEvent?: typeof MouseEvent }) | null
    P = w?.PointerEvent ?? PointerEvent
    M = w?.MouseEvent ?? MouseEvent
  } catch { return }
  const rect = typeof targets[0].getBoundingClientRect === 'function' ? targets[0].getBoundingClientRect() : null
  const bx = rect ? rect.left : 0
  const by = rect ? rect.top : 0
  const bw = rect ? rect.width : 350
  const bh = rect ? rect.height : 500
  // The instruction frame covers most of the cloud; click its centre and text line, and send
  // both pointer and mouse sequence because Ruffle versions differ in which one they consume.
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.28]] as const) {
    const x = bx + bw * fx
    const y = by + bh * fy
    for (const target of targets) {
      for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
        if (!P) continue
        try {
          target.dispatchEvent(new P(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 }))
        } catch { /* iframe gone */ }
      }
      if (!M) continue
      for (const type of ['mousedown', 'mouseup', 'click'] as const) {
        try {
          target.dispatchEvent(new M(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 }))
        } catch { /* iframe gone */ }
      }
    }
  }
}

/** Non-sensitive diagnostics for the verifier: why a native arrow did or did not move the cloud. */
interface GameKeyDebug {
  active: boolean
  cloudFocus: number
  cloudClicks: number
  nativeDown: number
  nativeUp: number
  nativeTrue: number
  nativeFalse: number
  fallbackDown: number
  playerHidden: boolean | null
  mouseForwards: number
}
const gameKeyDebug: GameKeyDebug = {
  active: false, cloudFocus: 0, cloudClicks: 0, nativeDown: 0, nativeUp: 0, nativeTrue: 0, nativeFalse: 0, fallbackDown: 0, playerHidden: null, mouseForwards: 0,
}
try { (window as Window & { __qqpetSmallGameKeys?: GameKeyDebug }).__qqpetSmallGameKeys = gameKeyDebug } catch { /* tests/old shells */ }

/** Native gate: Android only injects while the renderer says a small game is running. */
const setNativeGameKeyActive = (on: boolean): void => {
  gameKeyDebug.active = on
  try {
    const native = (window as Window & { QQPetNative?: { setGameKeyActive?: (on: boolean) => void } }).QQPetNative
    native?.setGameKeyActive?.(on)
  } catch { /* desktop/older shells */ }
}

/** Android's trusted KeyEvent path; absent/false keeps the DOM fallback. */
const nativeGameKey = (code: GameKeyCode, phase: GameKeyPhase): Promise<boolean> => {
  if (phase === 'down') gameKeyDebug.nativeDown += 1
  else gameKeyDebug.nativeUp += 1
  try {
    const api = window.qqpet as typeof window.qqpet & { sendGameKey?: (code: GameKeyCode, phase: GameKeyPhase) => Promise<boolean> }
    const send = api.sendGameKey
    if (typeof send !== 'function') return Promise.resolve(false)
    return Promise.resolve(send.call(api, code, phase)).then((ok) => {
      if (ok === true) gameKeyDebug.nativeTrue += 1
      else gameKeyDebug.nativeFalse += 1
      return ok === true
    }, () => {
      gameKeyDebug.nativeFalse += 1
      return false
    })
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * Direct native-bridge calls (the verifier's sendGameKey probe) do not pass through the D-pad
 * press handler, so they would otherwise inject keys into an unstarted/unfocused cloud.
 */
function prepareNativeGameKey(): void {
  if (!root || dir !== '100ceng') return
  clickCloudStart(root)
}
try { (window as Window & { __qqpetSmallGameKeyPrepare?: () => void }).__qqpetSmallGameKeyPrepare = prepareNativeGameKey } catch { /* tests/old shells */ }

/**
 * 100ceng installs its stage listener inside cloud_*.swf, not the root, so keys go to the root
 * and every visible child window (hidden player_*.swf windows are skipped).
 */
function sendKey(w: Win, type: 'keydown' | 'keyup', side: 'left' | 'right'): void {
  if (type === 'keydown') clickCloudStart(w)
  sendKeyTo(w, type, side)
  for (const child of wins.values()) {
    if (child === w || child.parent !== w || !child.player || child.box.hidden) continue
    sendKeyTo(child, type, side)
  }
}

function keypadButton(w: Win, side: 'left' | 'right', releases: Set<() => void>): HTMLDivElement {
  const el = div('smallGameKey')
  el.textContent = side === 'left' ? '◀' : '▶'
  el.title = side === 'left' ? '左移' : '右移'
  Object.assign(el.style, {
    width: '56px',
    height: '56px',
    borderRadius: '28px',
    border: '1px solid rgba(255,255,255,.6)',
    background: 'rgba(0,0,0,.45)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '24px',
    lineHeight: '1',
    userSelect: 'none',
    touchAction: 'none',
    pointerEvents: 'auto',
  })
  const code: GameKeyCode = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
  let timer: ReturnType<typeof setInterval> | null = null
  let down = false
  let domDown = false
  let token = 0
  const fallbackDown = (): void => {
    if (!domDown) domDown = true
    gameKeyDebug.fallbackDown += 1
    sendKey(w, 'keydown', side)
  }
  const release = (): void => {
    if (!down) return
    down = false
    token += 1
    releases.delete(release)
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    void nativeGameKey(code, 'up')
    if (domDown) {
      domDown = false
      sendKey(w, 'keyup', side)
    }
  }
  const press = (e: Event): void => {
    e.preventDefault?.()
    e.stopPropagation?.()
    if (down) return
    down = true
    const mine = ++token
    releases.add(release)
    focusGame(w)
    // The intro only installs CloudControl's key listeners after the cloud is clicked; do this
    // before both the native and DOM paths so a not-yet-started round can still open.
    clickCloudStart(w)
    void nativeGameKey(code, 'down').then((ok) => {
      if (!ok && down && token === mine) fallbackDown()
    })
    // The SWF reads a held flag; native suppresses duplicate downs, DOM repeats as before.
    timer = setInterval(() => {
      if (!down) return
      clickCloudStart(w)
      void nativeGameKey(code, 'down').then((ok) => {
        if (!ok && down && token === mine) fallbackDown()
      })
    }, 140)
  }
  // CDP/WebView mouse input may skip pointerdown; accept mousedown as the same press.
  el.addEventListener('pointerdown', press)
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) press(e)
  })
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'mouseup', 'mouseleave'] as const) el.addEventListener(type, release)
  return el
}

function removeKeypad(): void {
  keypad?.releaseAll()
  keypad?.root.remove()
  keypad = null
}

/** A touch D-pad on the host page, above every small-game window; only declared keyboard games get it. */
function showKeypad(w: Win): void {
  if (!touchHost() || keypad) return
  const sides = keyboardKeys()
  if (!sides.length) return
  const rootPad = div('smallGameKeys')
  Object.assign(rootPad.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: 'calc(18px + env(safe-area-inset-bottom))',
    display: 'flex',
    justifyContent: 'center',
    gap: '24px',
    zIndex: '100000',
    pointerEvents: 'none',
  })
  const releases = new Set<() => void>()
  const pad: Keypad = { root: rootPad, left: null, right: null, releaseAll: () => { for (const release of [...releases]) release() } }
  for (const side of sides) {
    const button = keypadButton(w, side, releases)
    pad[side] = button
    rootPad.append(button)
  }
  document.body.append(rootPad)
  keypad = pad
}

// Hidden/closed pages must not leave a native key held down.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) keypad?.releaseAll() }, true)
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => keypad?.releaseAll())
}

/** Rebinds the ExternalInterface globals after a shell is reused under a new name/parent. */
function bind(w: Win): void {
  Object.assign(w.frame.contentWindow!, {
    API: api(w),
    TICKLE_GetFeeling: guard(w, () => ({ feelNow: info.mood, feelTotal: save.petComputedlInfo.moodMax })),
    TICKLE_SendAction: guard(w, () => reward(w)),
  })
}

/** Reloads the shell's SWF; a timeout/failure discards the whole shell instead of leaving a blank iframe. */
function reload(w: Win): void {
  const player = w.player
  if (!player) return
  const token = ++w.loadToken
  w.loading = true
  // One iframe + Ruffle per shell: touch hosts lost whole games to wgpu OOM with 7-8 webgl
  // players, so they render with Canvas2D. Desktop keeps Ruffle's default renderer.
  void player.load(
    `pet/smallGame/${dir}/${w.swf}`,
    `pet/smallGame/${dir}/`,
    touch ? { preferredRenderer: 'canvas' } : undefined,
  ).then(
    () => {
      if (w.loadToken !== token || w.pooled || !shells.has(w)) return
      w.loading = false
      player.setIdle(false)
      if (!w.lazy) return
      w.box.hidden = !w.pendingVisible
      const pending = w.pending.splice(0)
      if (!pending.length) return
      // The prompt registers its ExternalInterface callbacks on its first frames, so deliver
      // the queued RemoteCall after two paints instead of dropping the first popup.
      void player.nextPaint().then(() => {
        if (w.pooled || !shells.has(w) || wins.get(w.name) !== w) return
        for (const { fn, args } of pending) call(w, fn, args)
      }).catch(() => {})
    },
    () => {
      if (w.loadToken !== token || w.pooled || !shells.has(w)) return
      w.loading = false
      discard(w)
    },
  )
}

/** Builds the shell's one Ruffle player; lazy prompts defer this until their first use. */
function startPlayer(w: Win): void {
  if (w.player) return
  w.player = new SwfPlayer(w.frame.contentDocument!.body)
  w.player.el.ruffle().addFSCommandHandler((cmd) => {
    if (cmd === 'quit' && root) destroy(root)
  })
}

/** Starts a lazy prompt's movie on its first Show/RemoteCall. */
function demand(w: Win): void {
  if (!w.lazy || w.demanded) return
  w.demanded = true
  // The shell now counts against the cap; the base budget already reserved its slot.
  trimPool()
  // The iframe load handler starts it once the frame document exists.
  if (!w.bound) return
  startPlayer(w)
  w.box.hidden = !w.pendingVisible
  reload(w)
}

/** Root shells own exactly one quit button; a shell reused as a child must not keep one. */
function syncQuit(w: Win): void {
  if (w.kind === 'root') {
    if (w.quit) return
    w.quit = button('quit', () => { if (root) destroy(root) })
    w.box.append(w.quit)
    return
  }
  if (!w.quit) return
  w.quit.remove()
  w.quit = null
}

function createShell(name: string, parent: Win | null, swf: string, x: number, y: number, width: number, height: number): Win {
  const frame = document.createElement('iframe')
  frame.src = 'swf.html'
  const box = div('smallGameWin', frame)
  box.dataset.hit = ''
  box.classList.toggle('passive', PASSIVE.test(swf))
  const win: Win = {
    name,
    parent,
    box,
    frame,
    x,
    y,
    w: width,
    h: height,
    drag: false,
    swf,
    key: poolKey(swf, width, height),
    dir,
    kind: kindOf(swf, parent),
    seq: ++seq,
    everShown: false,
    bound: false,
    loading: false,
    loadToken: 0,
    pooled: false,
    lazy: isLazyPrompt(swf),
    demanded: false,
    pendingVisible: parent !== null,
    pending: [],
    quit: null,
  }
  wins.set(name, win)
  shells.add(win)
  place(win)
  document.body.append(box)
  frame.addEventListener(
    'load',
    () => {
      // The shell may have been destroyed while its iframe was loading.
      if (win.pooled || !shells.has(win)) return
      win.bound = true
      bind(win)
      draggable(win, frame.contentDocument!)
      // Root shells own the quit button; it stays on the shell across games.
      syncQuit(win)
      if (win.lazy && !win.demanded) {
        // Prompt overlays stay cheap until their SWF first shows or remote-calls them, but the
        // CreateWindow visibility is honored: hidden=0 keeps the empty iframe visible.
        return
      }
      startPlayer(win)
      if (win.lazy) win.box.hidden = !win.pendingVisible
      reload(win)
    },
    { once: true },
  )
  return win
}

/** Takes a pooled shell for this name/parent and reloads its SWF in place. */
function activate(w: Win, name: string, parent: Win | null, swf: string, x: number, y: number, width: number, height: number): void {
  w.name = name
  w.parent = parent
  w.swf = swf
  w.key = poolKey(swf, width, height)
  w.dir = dir
  w.kind = kindOf(swf, parent)
  w.x = x
  w.y = y
  w.w = width
  w.h = height
  w.drag = false
  w.everShown = false
  w.seq = ++seq
  w.pooled = false
  w.lazy = isLazyPrompt(swf)
  w.demanded = false
  w.pendingVisible = false
  w.pending = []
  w.box.hidden = false
  w.box.style.display = ''
  delete w.box.dataset.pooled
  w.box.classList.toggle('passive', PASSIVE.test(swf))
  // A shell can change roles between games: roots need their quit back, children must lose it.
  syncQuit(w)
  // A live bubble repurposed at the cap keeps its old movie running until reload starts.
  w.player?.setIdle(true)
  wins.set(name, w)
  place(w)
  // The iframe load event fired for the shell's first game only; rebind the globals now.
  bind(w)
  if (!w.lazy) reload(w)
}

function open(name: string, parent: Win | null, swf: string, x: number, y: number, width: number, height: number): Win | null {
  if (touchHost()) {
    const reused = takePooled(poolKey(swf, width, height))
    if (reused) {
      activate(reused, name, parent, swf, x, y, width, height)
      return reused
    }
    // At the cap, reclaim/evict the oldest bubble first; never evict a provisional (unshown) window.
    if (activeShells() >= shellCap()) {
      const repurposed = reclaim(name, parent, swf, x, y, width, height)
      if (repurposed) return repurposed
      if (!evictOne()) return null
    }
  }
  return createShell(name, parent, swf, x, y, width, height)
}

export function playSmallGame(g: SmallGame): void {
  if (root || playingDesk()) return
  const st = stage()
  if (st === 'Egg') return speak({ s: '[host]，我还是个蛋呢，等破壳了再陪你玩~', now: true }, 'speak')
  if (busy()) return speak({ s: '[host]，我正忙着呢，忙完再陪你玩~', now: true }, 'speak')
  if (runtimeProjectionMode) {
    void startRuntimeSmallGame(g)
    return
  }
  openSmallGame(g)
}

async function startRuntimeSmallGame(g: SmallGame): Promise<void> {
  if (runtimeStarting || root || playingDesk()) return
  runtimeStarting = true
  const result = await dispatchRuntimeCommand(uiCommands.gameStart(g.dir, 'small'))
  const data = commandResultData<{ sessionToken: string }>(result)
  runtimeStarting = false
  if (data === null || root) return
  runtimeSessionToken = data.sessionToken
  openSmallGame(g)
}

function openSmallGame(g: SmallGame): void {
  const st = stage()
  dir = g.dir
  const variant = `1${g.kidOnly || st !== 'Adult' ? 0 : 2}${info.sex === 'GG' ? 2 : 3}`
  // A game with a smaller dynamic budget must not inherit the previous game's pool over cap, but
  // the upcoming root's shell must survive the trim: it is the oldest shell and open() is about
  // to claim it by pool key.
  trimPool(poolKey(`main_${variant}.swf`, MAIN, MAIN))
  setDeskGame(g.dir)
  const pet = document.getElementById('pet')!
  const r = pet.getBoundingClientRect()
  pet.hidden = true
  setTray('game')
  // 100ceng moves with the arrow keys.
  window.qqpet.setFocusable(true)
  setNativeGameKeyActive(keyboardKeys().length > 0)
  // A leaked finish() leaves #pet hidden, so its rect is 0×0 and the old formula put the whole
  // game at (-70,-140). Dock it to the viewport instead; the paopao2 clamp keeps it on screen.
  const docked = r.width <= 0 || r.height <= 0
  const x = docked ? Math.round((innerWidth - MAIN) / 2) : Math.round(r.left + (r.width - MAIN) / 2)
  const y = docked ? innerHeight - MAIN : Math.round(r.bottom - MAIN)
  const win = open('main', null, `main_${variant}.swf`, x, y, MAIN, MAIN)
  if (!win) {
    // No shell could be allocated; undo the game-mode state instead of leaving the pet hidden.
    dir = ''
    setDeskGame('')
    setNativeGameKeyActive(false)
    pet.hidden = false
    refreshTray()
    return
  }
  root = win
  showKeypad(win)
}
