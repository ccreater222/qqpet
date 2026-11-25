import { createPetInput, type PetPointerInput } from './pet/input'
import { clipAsk, IDLE, note } from './pet/ai'
import { resumeTask } from './pet/jobs'
import { machine, speak, startPet, startProjectionPet } from './pet/pet'
import { applyEdge, info, onInfoChange, onStoreSyncStatus, petSize, petStaged, save, setInfo, stage, update } from './pet/store'
import { RuntimeReadinessBanner } from './pet/readiness'
import type { DesktopCursor } from '../shared/ipc'
import { pageZoom, setDesktopSize, viewportSize } from './ui/viewport'
import { adopt, adoptProjection } from './ui/adopt'
import { catchDiudiule, releaseDiudiule } from './ui/diudiule'
import { scheduleHide, showControl } from './ui/control'
import { div, pageX, pageY, touch } from './ui/dom'
import './ui/background'
import './host-pause'
import { clearFacePoints, showFacePointsAfterClick } from './ui/face'
import { closeMenu, openMenu, wantHidden } from './ui/menu'
import { closeState, openState } from './ui/state'
import { startAutoUpdate } from './ui/update'
import { windowView } from './ui/window-view'
import { initLanVisit } from './ui/lan-visit'
import { initWebhook } from './ui/webhook'
import { initMemory } from './ui/chat'
import { initVoice } from './ui/voice'
import { resizePetPosition } from '../shared/layout'
import { bootRenderer, mountLanVisits } from './pet/runtime-boot'
import { hitCover, type Box } from '../mobile/overlay'
import { onStageBox, stageBox } from './ui/mobile/pet-stage'
import type { PetStageBox } from './ui/mobile/pet-stage-model'
import { applyPhoneClass, phoneUI, safeInset } from './ui/mobile/sizing'

// Phone layout is keyed off the real viewport (1 CSS px = 1 dp, short side < 600dp): mark the body before
// anything measures the pet, and re-check on resize so a rotation or a phone/tablet boundary swaps layouts.
const refreshPhoneLayout = (): void => {
  if (typeof applyPhoneClass === 'function') applyPhoneClass()
}
refreshPhoneLayout()
addEventListener('resize', refreshPhoneLayout)
const phoneMode = (): boolean => typeof phoneUI === 'function' && phoneUI()
const phoneSafeInset = (side: 'top' | 'bottom'): number => (typeof safeInset === 'function' ? safeInset(side) : 0)

/** Mirrors the store flag; kept local so legacy source-level renderer tests can run without the full graph. */
const projectionMode = window.__qqpetRuntimeV2 === true

window.addEventListener('qqpet-command-error', (event) => {
  const detail = (event as CustomEvent<{ message?: unknown }>).detail
  if (detail === undefined || typeof detail.message !== 'string') return
  windowView({ title: '操作失败', msg: detail.message })
})

const readinessHost = document.body
const readiness = typeof document.createElement === 'function' && readinessHost !== undefined && readinessHost !== null
  ? document.createElement('div')
  : null
if (readiness !== null && typeof readinessHost.appendChild === 'function') {
  readiness.id = 'runtimeReadiness'
  readiness.hidden = true
  readinessHost.appendChild(readiness)
}
if (projectionMode && readiness !== null && typeof onStoreSyncStatus === 'function' && typeof window.qqpet.getStatus === 'function') {
  const getStatus = window.qqpet.getStatus
  new RuntimeReadinessBanner(readiness, {
    onSyncStatus: window.qqpet.onSyncStatus,
    getStatus,
  })
}

let lastPlatformError = ''
let lastPlatformErrorAt = -Infinity
// The native adapter reports errors before and after bootstrap; only the initialized UI opens dialogs.
window.addEventListener('qqpet-platform-error', (event) => {
  const detail = (event as CustomEvent<{ operation?: unknown; message?: unknown }>).detail
  if (!detail || typeof detail.message !== 'string') return
  const message = typeof detail.operation === 'string' ? `${detail.operation}：${detail.message}` : detail.message
  const now = performance.now()
  // A failed periodic save should leave one readable alert instead of replacing it on every tick.
  if (message === lastPlatformError && now - lastPlatformErrorAt < 10_000) return
  lastPlatformError = message
  lastPlatformErrorAt = now
  windowView({ title: '平台操作失败', msg: message })
})

const petEl = document.getElementById('pet')!
const HOLD_MS = 500
let dragging = false
let dragLifted = false
let desktopOffset = { x: 0, y: 0 }
let desktopSequence = 0
let dragMove: ((point: DesktopCursor) => void) | null = null

function clampOnScreen(): void {
  const s = petSize()
  const area = viewportSize()
  // On a phone the pet may not sit under the status bar or the navigation bar: the system bars are edges.
  const top = phoneMode() ? phoneSafeInset('top') : 0
  const bottom = phoneMode() ? phoneSafeInset('bottom') : 0
  setInfo('lastX', Math.min(Math.max(info.lastX, 0), Math.max(0, area.width - s)))
  setInfo('lastY', Math.min(Math.max(info.lastY, top), Math.max(top, area.height - bottom - s)))
}

/** Left/right: keep the box on-screen. Hide_left/right already peek from the sprite edge. */
function snapEdge(): 'hideleft' | 'hideright' | null {
  const edge = applyEdge()
  // A phone keeps clear of the system bars even while peeking from a side.
  if (!edge || phoneMode()) clampOnScreen()
  return edge
}

let size = petSize()
let previousViewport = { ...viewportSize(), size }

/** 舞台期间 #pet 的窗口就是舞台盒：尺寸取盒边长，图片按可视区裁掉上下滚出的部分。 */
function applyStage(box: PetStageBox): void {
  petEl.style.display = ''
  petEl.style.left = `${box.left}px`
  petEl.style.top = `${box.top}px`
  petEl.style.width = petEl.style.height = `${box.size}px`
  petEl.style.clipPath = `inset(${box.clipTop}px 0 ${box.clipBottom}px 0)`
}

/** 舞台会话还在、但整块已滚出 sheet 可视区：只藏视觉层，不碰 info。 */
function hideStage(): void {
  petEl.style.display = 'none'
}

function layout(): void {
  // 舞台期间 #pet 是菜单顶部的一块视觉层：只按舞台盒摆位置，不写 info.lastX/lastY，
  // 关闭菜单后由 pet-stage 还原内联样式，宠物回到打开前的位置与大小。
  if (petStaged()) {
    const box = stageBox()
    if (box) applyStage(box)
    else hideStage()
    return
  }
  // A pet that grows keeps its center.
  const shift = dragging ? 0 : (petSize() - size) / 2
  size = petSize()
  if (shift) {
    setInfo('lastX', info.lastX - shift)
    setInfo('lastY', info.lastY - shift)
    clampOnScreen()
  }
  petEl.style.width = petEl.style.height = `${size}px`
  petEl.style.left = `${info.lastX}px`
  petEl.style.top = `${info.lastY}px`
  const area = viewportSize()
  if (area.width === previousViewport.width && area.height === previousViewport.height) previousViewport.size = size
}

// 舞台盒变化（滚动、旋转、入场动画）只需要重跑一次布局；注册一次即可。
onStageBox(() => layout())

if (info.lastX === -1 && info.lastY === -1) {
  setInfo('lastX', (innerWidth - size) / 2)
  setInfo('lastY', (innerHeight - size) / 2)
}
// A save from another screen can leave the pet outside the current viewport.
clampOnScreen()
function resizeMobilePet(): void {
  const next = { ...viewportSize(), size: petSize() }
  if (next.width === previousViewport.width && next.height === previousViewport.height && next.size === previousViewport.size) return
  const pose = machine.pose.a
  const edge = pose === 'hideleft' || pose === 'hideright' ? pose : null
  const position = resizePetPosition({ x: info.lastX, y: info.lastY }, previousViewport, next, edge)
  // A pointer's grab point belongs to the previous viewport, even on hosts
  // which do not send an orientation cancellation themselves.
  if (dragging) petInput.cancel()
  previousViewport = next
  size = next.size
  setInfo('lastX', position.x)
  setInfo('lastY', position.y)
  // A rotation can shrink the reachable area under the system bars; the pet must stay visible.
  clampOnScreen()
  layout()
}
// Desktop transfers use native global coordinates, including mid-drag.
if (window.qqpet.setDragging) addEventListener('resize', () => { if (!dragging) clampOnScreen() })
else {
  let resizeFrame = 0
  const scheduleResize = (): void => {
    if (resizeFrame) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      resizeMobilePet()
    })
  }
  addEventListener('resize', scheduleResize)
  // The Android overlay can take longer than one frame to adopt a rotation: the
  // resize event fires while innerWidth/innerHeight are still the old values, the
  // move is skipped, and no further event arrives. Re-read once it has settled.
  let settleTimer = 0
  const settleResize = (): void => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(resizeMobilePet, 350)
  }
  addEventListener('orientationchange', settleResize)
  // WebKit can emit resize with an intermediate width, then settle the root
  // viewport without another window event. Read the final dimensions per frame.
  const viewportObserver = new ResizeObserver(scheduleResize)
  viewportObserver.observe(document.documentElement)
  addEventListener('resize', settleResize)
  addEventListener('pagehide', () => {
    viewportObserver.disconnect()
    if (resizeFrame) cancelAnimationFrame(resizeFrame)
    clearTimeout(settleTimer)
    removeEventListener('resize', scheduleResize)
    removeEventListener('resize', settleResize)
    removeEventListener('orientationchange', settleResize)
  })
}
layout()
onInfoChange((key) => {
  if (key === 'lastX' || key === 'lastY' || key === 'growth') layout()
})

const cursor = { x: 0, y: 0 }
window.API = {
  GetCursorPosition: () => `${cursor.x},${cursor.y},0`,
  // 舞台期间 SWF 的「窗口」就是舞台盒；滚出可视区时视觉层已隐藏，沿用一个不会
  // 让 SWF 算出非法坐标的盒子（此时没有可见像素，只有动作内部在量它）。
  GetWindowRect: () => {
    const box = stageBox()
    return box ? `${box.left},${box.top},${box.size},${box.size}` : `${info.lastX},${info.lastY},${size},${size}`
  },
  // No PetEden.ini: every key reads as its default, as the Windows call does for a missing file.
  GetPrivateProfileString: (_section, _key, fallback) => fallback,
  // Release positioning and flings belong to the host. An outgoing movie may
  // still run its drop frames while the replacement loads.
  MoveBy: () => {},
}
// The newer drag movies loop their nested timeline while this value is 1.
window.DataCenter_ReadInt32 = (key) => key === 'drag' && dragLifted ? 1 : 0

// The window is click-through except while the cursor is over a [data-hit]
// element (or a drag is in progress).
let interactive = false
/** A click stepped the pet out of its peek; it slips back once the cursor leaves it and its bar. */
let out = false
/** A cursor overshooting the menu edge, or crossing to a submenu, may come back before this. */
const MENU_LEAVE_MS = 300
let menuLeave = 0
/** Peek movies leave most of the pet box transparent (#74). */
function petHitBoxes(): Box[] {
  // 舞台期间宠物只是 sheet 上方的视觉层：触控交给菜单，不能把舞台像素当成宠物命中区。
  if (petStaged()) return []
  if (petEl.hidden || save.settings.hidden) return []
  if (machine.pose.a !== 'hideleft' && machine.pose.a !== 'hideright') {
    return [{ left: info.lastX, top: info.lastY, right: info.lastX + size, bottom: info.lastY + size }]
  }
  return [petEl, ...petEl.querySelectorAll('ruffle-player')].map((el) => hitCover(el)).filter((box): box is Box => box !== null)
}
const overPet = (x: number, y: number): boolean => petHitBoxes().some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)
/**
 * The pixels a touch host may take: the window stays the conservative visual crop, but only what is drawn now
 * (and the panels' DOM rects added later) should receive touches, so the transparent window margin passes through.
 * `petHitBoxes` keeps the whole box for a standing pet on purpose (desktop hover needs it); the touch region cannot.
 */
function visiblePetBoxes(): Box[] {
  // 舞台期间宠物由 sheet 的舞台容器接收点击；50ms 循环若上报舞台像素，原生触控区会
  // 盖住菜单行（而且舞台滚出可视区后那里根本没有像素），因此这里保持空。
  if (petStaged()) return []
  if (petEl.hidden || save.settings.hidden) return []
  const boxes: Box[] = []
  // An equipped scene is a background image on #pet > .petBg and covers the whole pet box. Older builds put it on #pet.
  const layer = typeof petEl.querySelector === 'function'
    ? (petEl.querySelector(':scope > .petBg') as HTMLElement | null)
    : null
  const image = layer?.style.backgroundImage || petEl.style.backgroundImage
  if (image && !layer?.classList.contains('hide')) {
    boxes.push({ left: info.lastX, top: info.lastY, right: info.lastX + size, bottom: info.lastY + size })
  }
  // hitCover returns null when the player is invisible or draws nothing; a failed readback keeps its last hit box.
  if (typeof petEl.querySelectorAll === 'function') {
    for (const player of petEl.querySelectorAll('ruffle-player')) {
      const box = hitCover(player)
      if (box) boxes.push(box)
    }
  }
  return boxes
}

const syncDesktop = (p: DesktopCursor): boolean => {
  const area = p.desktop
  if (!area) return true
  if (area.sequence <= desktopSequence) return false
  desktopSequence = area.sequence
  // A zoom change rescales every page length, the old offset included; what is left is a real display move.
  const k = (pageZoom() ?? area.zoom) / area.zoom
  const dx = area.offset.x - desktopOffset.x * k
  const dy = area.offset.y - desktopOffset.y * k
  desktopOffset = area.offset
  setDesktopSize(area)
  setInfo('lastX', info.lastX * k + dx)
  setInfo('lastY', info.lastY * k + dy)
  if (save.settings.petDisplayId !== area.id) update('settings', { petDisplayId: area.id })
  if (!dragging) clampOnScreen()
  layout()
  return true
}
function updateCursor(p: DesktopCursor): void {
  if (!syncDesktop(p)) return
  dragMove?.(p)
  cursor.x = p.x
  cursor.y = p.y
  // The cursor is in page coordinates; a cropped page (HarmonyOS) is shifted by the crop.
  const { cropX = 0, cropY = 0 } = document.documentElement.dataset
  const el = document.elementFromPoint(p.x - Number(cropX), p.y - Number(cropY))
  const root = el?.getRootNode()
  const host = root instanceof ShadowRoot ? root.host : el
  // The pet's data-hit ancestor must not restore its transparent SWF rectangle.
  const panelHit = host?.closest('[data-hit]') && (!host.closest('#pet') || host.closest('.point'))
  const hit = dragging || overPet(p.x, p.y) || !!panelHit
  // The menu closes once the cursor rests on the desktop; it may still be on the tray, outside the window.
  const inside = p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight
  if (!hit && inside) {
    menuLeave ||= setTimeout(() => {
      menuLeave = 0
      closeMenu()
    }, MENU_LEAVE_MS)
  } else if (menuLeave) {
    clearTimeout(menuLeave)
    menuLeave = 0
  }
  if (out && !hit) {
    out = false
    const edge = snapEdge()
    if (edge && machine.pose.a === 'normal') machine.play({ a: edge })
  }
  if (hit === interactive) return
  interactive = hit
  window.qqpet.setClickThrough(!hit)
}
window.qqpet.onCursor(updateCursor)

// Linux: the window takes the mouse only over the pet and the [data-hit] panels (#45). A hit root may be a
// zero-sized anchor with overflowing children (the pet toolbar), so the children count too.
/**
 * Element.checkVisibility is Chrome 105+; the Android WebView is older and runs this same page. A missing method
 * must not abort the whole hit-shape tick, so fall back to the plain style reads the gate actually needs.
 */
function hitTargetVisible(el: Element): boolean {
  // `visibilityProperty` alone still reports an opacity:0 subtree as visible, which would leave a
  // transparent panel in the native hit shape. The fallback keeps the old WebView's own semantics.
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
  const style = getComputedStyle(el)
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    && Number(style.opacity) !== 0
}
const setHitShape = window.qqpet.setHitShape
if (setHitShape || window.qqpet.setDragging) {
  let sent = ''
  setInterval(() => {
    // Nothing to hit while hidden or paused (#119); the hidden-change listener refreshes the cursor state.
    if (save.settings.hidden && !dragging && (!setHitShape || sent === '[]')) return
    // The movie can retract under a stationary cursor; native cursor IPC only sends changes.
    // A touch host has no hover: its pointer events already update the cursor, and replaying the last touch every
    // tick could close a panel that opened from the notification against a point the finger is not on.
    if (!dragging && !touch) updateCursor(cursor)
    if (!setHitShape) return
    const rects: { x: number; y: number; width: number; height: number }[] = []
    if (dragging) rects.push({ x: 0, y: 0, width: innerWidth, height: innerHeight })
    else if (!save.settings.hidden) {
      // A touch host takes the pet's pixels drawn now; a desktop keeps petHitBoxes (hover needs the whole box).
      for (const r of touch ? visiblePetBoxes() : petHitBoxes()) rects.push({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top })
      for (const el of document.querySelectorAll('#pet, [data-hit], [data-hit] *')) {
        if (el.closest('#pet') && !el.matches('.point')) continue
        // A phone sheet's root already reports the whole page; its rows are children of that same
        // rectangle. Scanning every row every 50 ms only makes the tick scale with the menu DOM.
        if (el.closest('.qp-sheet') && !el.matches('.qp-sheet')) continue
        // Check visibility first: reading computed style for every hidden [data-hit] descendant on every 50 ms
        // tick stalls the renderer on the desktop (the Linux window shape then lags the bubble and drag). Only an
        // element that actually paints needs its pointer-events read. The phone sheet is pointer-events:none only
        // for the tap that opened it; its full-page layer must still count.
        if (!hitTargetVisible(el)) continue
        if (getComputedStyle(el).pointerEvents === 'none' && !el.matches('.qp-sheet')) continue
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y, width: r.width, height: r.height })
      }
      // A tablet's desktop-style popup menu (`.ui-menu`) must catch a tap outside itself: the Android render window is
      // no longer touchable and gets no ACTION_OUTSIDE, so the whole page is one target while the menu is open.
      // Touch hosts only: the Linux desktop keeps its click-through shape and closes the menu on hover.
      if (touch && document.querySelector('.ui-menu') !== null) {
        rects.push({ x: 0, y: 0, width: innerWidth, height: innerHeight })
      }
    }
    const key = JSON.stringify(rects)
    if (key === sent) return
    sent = key
    setHitShape(rects)
  }, 50)
}
window.addEventListener('qqpet-hidden-change', () => {
  if (save.settings.hidden) petInput.cancel()
  updateCursor(cursor)
})
// The store's asynchronous load may finish after the initial cursor broadcast.
if (window.qqpet.setDragging) void window.qqpet.setDragging(false).then(syncDesktop)

petEl.addEventListener('contextmenu', (e) => {
  if (overPet(pageX(e), pageY(e))) openMenu({ x: pageX(e), y: pageY(e), pet: true }, startAdoption)
})

let releaseDomInput = (): void => {}
const petInput = createPetInput({
  clock: () => performance.now(),
  requestFrame: requestAnimationFrame,
  cancelFrame: cancelAnimationFrame,
  position: () => ({ x: info.lastX, y: info.lastY, size }),
  begin: () => {
    // 舞台期间 #pet 是视觉层，不属于宠物本体：不关菜单、不清热点、不接管拖动。
    if (petStaged()) return
    clearFacePoints()
    closeMenu()
    // The phone's entry point is the bottom action panel; the floating icon bar is desktop-only.
    if (save.settings.petBar && !phoneMode()) showControl()
    catchDiudiule()
  },
  active: (on) => {
    dragging = on
    if (!on) { dragLifted = false; releaseDomInput() }
  },
  hold: (x, y) => {
    // 长按舞台不是「打开菜单」：菜单已经开着，这一层由 sheet 自己处理。
    if (petStaged()) return
    openMenu({ x, y, pet: true }, startAdoption)
  },
  // A phone click (no drag, no long press) opens the menu: a thumb has no hover and the desktop's face
  // hotspots are not discoverable. It opens one task later on purpose: the tap's own click is hit-tested
  // after pointerup, so a panel built right here would receive that click on whichever row is under the
  // finger (observed on Android). Letting the click land on the pet first keeps menu rows inert.
  tap: (x, y) => {
    // 舞台期间的轻点由舞台容器的 click 处理（逗宠），不能重新打开/替换菜单。
    if (!phoneMode() || petStaged()) return
    // After the click, not during pointerup: the click the browser still dispatches would
    // otherwise land on the row the freshly opened sheet puts under the finger.
    setTimeout(() => openMenu({ x, y, pet: true }, startAdoption))
  },
  lift: (s, align) => {
    if (petStaged()) return null
    dragLifted = true
    if (stage() === 'Adult') {
      // Hold the upper-right rim of the head, so the finger lifts it from the side.
      // Keep following the original grab until the double-buffered SWF is on screen.
      machine.play({ a: 'drag', opt: { url: 'pet/Action/drag.swf', opt: {} },
        s: () => align({ dx: s * 0.58, dy: s * 0.30, duration: 120 }) })
      return null
    }
    machine.play({ a: 'drag' })
    return null
  },
  move: (x, y, lifted) => {
    if (petStaged()) return
    setInfo('lastX', x)
    setInfo('lastY', y)
    if (!lifted) clampOnScreen()
  },
  end: (lifted, vx, vy, cancelled) => {
    // 舞台期间不触发贴边/隐藏/热点复位：宠物位置只由舞台盒决定，关闭时原样恢复。
    if (petStaged()) return
    if (releaseDiudiule(cancelled ? false : lifted, vx, vy)) return scheduleHide()
    const edge = snapEdge()
    if (edge && !lifted && !cancelled && machine.pose.a === edge) {
      out = true
      machine.play({ a: 'normal' })
    } else if (edge) machine.play({ a: edge })
    else if (lifted || machine.pose.a === 'hideleft' || machine.pose.a === 'hideright') machine.play({ a: 'normal' })
    scheduleHide()
    // A plain click hid the spots on pointerdown; bring them back so the next click can land on one (#113).
    if (!lifted && !cancelled) showFacePointsAfterClick()
  },
}, touch ? HOLD_MS : 0)

window.__qqpetInput = (input) => {
  if ((window.__qqpetHostPaused || save.settings.hidden) && input.phase !== 'cancel') return
  cursor.x = input.x
  cursor.y = input.y
  petInput.send({ ...input, source: 'native' })
}
addEventListener('pagehide', () => petInput.cancel())

petEl.addEventListener('pointerdown', (e) => {
  if (save.settings.hidden || window.__qqpetNativePetInput || window.__qqpetHostPaused || e.button !== 0 || (e.target as HTMLElement).closest('.point')) return
  if (!overPet(pageX(e), pageY(e))) return
  if (petInput.active) return
  const nativeDrag = window.qqpet.setDragging
  let lastPoint: DesktopCursor = { x: pageX(e), y: pageY(e) }
  const sample = (phase: PetPointerInput['phase'], p: DesktopCursor): PetPointerInput => ({
    phase, id: e.pointerId, x: p.x, y: p.y, source: 'dom',
    ...(nativeDrag ? { globalX: p.x - desktopOffset.x, globalY: p.y - desktopOffset.y, scaleGrab: true } : {}),
  })
  petInput.send(sample('begin', lastPoint))
  if (!petInput.active) return
  let ending = false
  let disposed = false
  // The grab point comes from the DOM event, every later point from the native cursor. Where the two
  // disagree (Windows display scaling, mixed-DPI screens), the pet would jump off the cursor on the
  // first native sample; measure the gap once and keep it while the pointer stays on that display.
  const start = lastPoint
  let shift: { id: number | undefined; x: number; y: number } | null = null
  const fromDesktop = (p: DesktopCursor): void => {
    shift ??= { id: p.desktop?.id, x: p.x - start.x, y: p.y - start.y }
    lastPoint = shift.id === p.desktop?.id ? { ...p, x: p.x - shift.x, y: p.y - shift.y } : p
    petInput.send(sample('move', lastPoint))
  }
  const move = (m: PointerEvent): void => {
    if (nativeDrag || m.pointerId !== e.pointerId) return
    lastPoint = { x: pageX(m), y: pageY(m) }
    petInput.send(sample('move', lastPoint))
  }
  const failed = (error: unknown): void => {
    console.error('Native desktop drag failed:', error)
    if (!disposed) petInput.cancel()
  }
  const stopFollowing = (): void => {
    if (nativeDrag) void nativeDrag(false).then(syncDesktop).catch(failed)
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    petEl.removeEventListener('pointermove', move)
    petEl.removeEventListener('pointerup', end)
    petEl.removeEventListener('pointercancel', end)
    if (nativeDrag) {
      removeEventListener('pointerup', end)
      removeEventListener('pointercancel', end)
      if (dragMove === fromDesktop) dragMove = null
      if (!ending) { ending = true; stopFollowing() }
    }
    if (petEl.hasPointerCapture(e.pointerId)) petEl.releasePointerCapture(e.pointerId)
    releaseDomInput = () => {}
  }
  const end = (m: PointerEvent): void => {
    if (m.pointerId !== e.pointerId || ending || disposed) return
    ending = true
    if (m.type === 'pointercancel') {
      petInput.send(sample('cancel', lastPoint))
      stopFollowing()
      return
    }
    if (nativeDrag) {
      // Resolve the target display and final sample before releasing or clamping the pet.
      void nativeDrag(false).then((p) => {
        if (disposed) return
        if (syncDesktop(p)) fromDesktop(p)
        petInput.send(sample('end', lastPoint))
      }).catch(failed)
    } else {
      lastPoint = { x: pageX(m), y: pageY(m) }
      petInput.send(sample('end', lastPoint))
    }
  }
  releaseDomInput = dispose
  if (nativeDrag) {
    dragMove = fromDesktop
    // Native cursor updates survive losing pointer capture during a display/DPI transfer.
    void nativeDrag(true).then((p) => { if (!disposed && !ending && syncDesktop(p)) fromDesktop(p) }).catch(failed)
  }
  petEl.setPointerCapture(e.pointerId)
  petEl.addEventListener('pointermove', move)
  petEl.addEventListener('pointerup', end)
  petEl.addEventListener('pointercancel', end)
  if (nativeDrag) {
    addEventListener('pointerup', end)
    addEventListener('pointercancel', end)
  }
})

// Touch has no hover to show a tooltip by: a long press shows it, and the lift is not a tap.
if (touch) {
  const tip = div('touchTip')
  const eat = (c: MouseEvent): void => c.stopPropagation()
  document.addEventListener(
    'pointerdown',
    (e) => {
      tip.remove()
      const text = (e.target as Element).closest('[title]')?.getAttribute('title')
      if (!text) return
      const hold = setTimeout(() => {
        tip.textContent = text
        tip.style.left = `${Math.min(Math.max(e.clientX, 110), innerWidth - 110)}px`
        tip.style.top = `${e.clientY}px`
        document.body.append(tip)
      }, HOLD_MS)
      const move = (m: PointerEvent): void => {
        if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) > 8) end()
      }
      const end = (): void => {
        clearTimeout(hold)
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointercancel', end)
        document.removeEventListener('pointerup', up)
      }
      const up = (): void => {
        end()
        if (!tip.isConnected) return
        document.addEventListener('click', eat, true)
        setTimeout(() => document.removeEventListener('click', eat, true))
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointercancel', end)
      document.addEventListener('pointerup', up)
    },
    true,
  )
}

const begin = (): void => {
  petEl.hidden = false
  startPet()
}

/** Projection mode owns all game rules; only the SWF pose/clock runs locally. */
const beginProjectionWith = (first: boolean): void => {
  petEl.hidden = false
  // Show the authoritative dead/buried state before the first projection update.
  if (save.isBury) machine.play({ a: 'bury' })
  else if (info.health === 0) machine.play({ a: 'dying', s: () => machine.add({ a: 'die' }) })
  startProjectionPet(first)
  machine.start()
}
const beginProjection = (): void => {
  beginProjectionWith(false)
}
const adoptPet = (): void => adopt(begin)
const adoptProjectionPet = (): void => adoptProjection(() => beginProjectionWith(true))
const startAdoption = (): void => {
  if (projectionMode) adoptProjectionPet()
  else adoptPet()
}

// Linux trays report no position; open at the top right, under the menu bar.
window.qqpet.onTrayClick((c) => {
  // A manager/tray press may have scheduled a leave before opening this panel.
  // That older pointer event must not dismiss the newly requested menu.
  if (menuLeave) { clearTimeout(menuLeave); menuLeave = 0 }
  const x = c.x ?? innerWidth - 60
  const y = c.y ?? 0
  if (c.kind === 'show' || c.kind === 'hide') {
    closeMenu()
    closeState()
    if (save.havePet) wantHidden(c.kind === 'hide')
  } else if (c.kind === 'menu') {
    closeState()
    openMenu({ x, y, pet: false }, startAdoption)
  } else if (save.havePet) {
    closeMenu()
    if (projectionMode) openMenu({ x, y, pet: false }, startAdoption)
    else openState(x, y, c.autoClose, c.focusTaken)
  } else startAdoption()
})

const CLIP_MAX = 60
window.qqpet.onClipboard((text) => {
  if (!save.havePet) return
  note('主人刚复制了一段文字')
  speak({ s: text.length > CLIP_MAX ? `${text.slice(0, CLIP_MAX)}…` : text, b: '当前复制的文字', now: true, ai: clipAsk(text) }, 'speak')
})

// Friend LAN presence moved into initLanVisit (one registration per channel).
// Runtime projection mode has no converted social/visit commands yet, so do
// not mount an unsolicited LAN action path that could attempt canonical writes.
if (mountLanVisits(projectionMode)) initLanVisit()
if (projectionMode === false) initWebhook()
initMemory()
if (projectionMode === false) initVoice()

window.qqpet.onPresence((gone) => {
  if (!save.havePet) return
  if (gone) {
    note('主人离开了一会儿')
    return
  }
  note('主人回来了')
  speak({ s: '[host]，你回来啦~', now: true, ai: IDLE }, 'appear')
})

const DWELL = 10 * 60 * 1000
let front = ''
let frontSince = 0
let frontNoted = ''
window.qqpet.onFront((name) => {
  front = name
  frontSince = Date.now()
})
setInterval(() => {
  if (!save.settings.watchApp || !save.havePet || !front || front === frontNoted || Date.now() - frontSince < DWELL) return
  frontNoted = front
  note(/[A-Za-z]/.test(front) ? `主人在用「${front}」` : `主人在${front}`)
}, 15_000)

bootRenderer(projectionMode, save.havePet, {
  startProjectionPresentation: beginProjection,
  startLegacy: () => {
    resumeTask()
    begin()
  },
  startProjectionAdoption: adoptProjectionPet,
  startAdoption: adoptPet,
})
startAutoUpdate()
