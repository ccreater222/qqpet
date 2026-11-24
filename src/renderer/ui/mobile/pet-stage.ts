// 手机菜单顶部的「宠物舞台」：把真实的 #pet 视觉层按几何模型搬进 sheet 顶部的
// slot，不新增第二个 SWF/播放器，也不改写存档里的宠物位置与大小。
//
// 为什么放在手机作用域模块：phoneUI() 命中的宿主都是触屏手机（Android/iOS/
// HarmonyOS），舞台只是菜单里的一块视觉层，桌面/平板不会创建它。控制器只做三件
// 事：量 slot 与 sheet body、把 petStageBox() 的结果通知订阅者（main.ts 负责把
// #pet 摆过去）、关闭时原样恢复 #pet 打开前的内联样式。互动逻辑不在这里，由
// phone-menu.ts 调用 face.ts 的共享 poke 路径。
import { setPetStaged } from '../../pet/store'
import { petStageBox, type PetStageBox } from './pet-stage-model'

/** #pet 在舞台期间会被改写的内联样式；关闭时逐项还原。 */
type StagedProperty = 'left' | 'top' | 'width' | 'height' | 'clipPath' | 'display'
const STAGED_PROPERTIES: readonly StagedProperty[] = ['left', 'top', 'width', 'height', 'clipPath', 'display']

/** sheet 入场动画约 220ms；打开后这 300ms 内逐帧重算，之后只跟 scroll/resize。 */
const BURST_MS = 300

interface SavedStyle {
  property: StagedProperty
  value: string
}

interface StageState {
  slot: HTMLElement
  body: HTMLElement
  pet: HTMLElement
  saved: SavedStyle[]
  scrollFrame: number
  burstFrame: number
  burstUntil: number
  detach: () => void
  closed: boolean
}

export interface PetStageHandle {
  close(): void
}

let active: StageState | null = null
let current: PetStageBox | null = null
const listeners = new Set<() => void>()

/** 当前舞台盒；未开启或已滚出可视区时为 null（宠物应隐藏）。 */
export function stageBox(): PetStageBox | null {
  return current
}

/** 订阅舞台盒变化；返回取消订阅函数。 */
export function onStageBox(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

const sameBox = (a: PetStageBox, b: PetStageBox): boolean =>
  a.left === b.left && a.top === b.top && a.size === b.size && a.clipTop === b.clipTop && a.clipBottom === b.clipBottom

/** slot 在视口里的位置 + sheet body 的可视区 → 舞台盒。 */
function measure(state: StageState): PetStageBox | null {
  const slot = state.slot.getBoundingClientRect()
  const body = state.body.getBoundingClientRect()
  return petStageBox(
    { left: slot.left, top: slot.top, width: slot.width, height: slot.height },
    { top: body.top, bottom: body.bottom },
  )
}

function recompute(state: StageState): void {
  if (state.closed) return
  const next = measure(state)
  const changed = next === null ? current !== null : current === null || !sameBox(current, next)
  if (!changed) return
  current = next
  notify()
}

/**
 * 清空会话并恢复 #pet 的原始内联样式。不在这里通知订阅者：打开新舞台时新旧交接
 * 在同一帧完成，关闭时由调用方决定通知时机。
 */
function release(state: StageState): void {
  state.closed = true
  cancelAnimationFrame(state.scrollFrame)
  cancelAnimationFrame(state.burstFrame)
  state.scrollFrame = 0
  state.burstFrame = 0
  state.detach()
  for (const { property, value } of state.saved) state.pet.style[property] = value
  state.pet.classList.remove('qp-pet-stage')
  if (active === state) {
    active = null
    current = null
    // store 的 petStaged() 是单一事实源：舞台一关，applyEdge() 立刻恢复躲边逻辑。
    setPetStaged(false)
  }
}

/**
 * 打开舞台。`slot` 必须已经挂在 .qp-sheet-body 里（openSheet 返回后即可）。
 * 同一时刻只有一个舞台：上一个还没等到 onClose 就被新菜单替换时，先还原再记录。
 */
export function openPetStage(slot: HTMLElement): PetStageHandle {
  const pet = document.getElementById('pet')
  if (!pet) throw new Error('宠物舞台缺少 #pet 节点')
  const body = slot.closest<HTMLElement>('.qp-sheet-body')
  if (!body) throw new Error('宠物舞台需要 .qp-sheet-body 滚动容器')
  if (active) release(active)

  const state: StageState = {
    slot,
    body,
    pet,
    saved: STAGED_PROPERTIES.map((property) => ({ property, value: pet.style[property] })),
    scrollFrame: 0,
    burstFrame: 0,
    burstUntil: 0,
    detach: () => {},
    closed: false,
  }
  active = state
  setPetStaged(true)
  pet.classList.add('qp-pet-stage')

  // 滚动/旋转按帧节流：一帧只量一次、只通知一次，避免滚动时反复写样式。
  const schedule = (): void => {
    if (state.closed || state.scrollFrame) return
    state.scrollFrame = requestAnimationFrame(() => {
      state.scrollFrame = 0
      recompute(state)
    })
  }
  const onScroll = (): void => schedule()
  body.addEventListener('scroll', onScroll, { passive: true })
  addEventListener('resize', schedule)
  addEventListener('orientationchange', schedule)
  // 入场动画（qp-rise）在低端机/掉帧时可能晚于 300ms 结束；只听固定时长的 burst
  // 会把宠物永久停在动画中间的位置。卡片自身的动画/位移动画结束时再量一次。
  const card = slot.closest<HTMLElement>('.qp-sheet-card')
  const onCardSettled = (event: Event): void => {
    if (event.target === card) schedule()
  }
  card?.addEventListener('animationend', onCardSettled)
  card?.addEventListener('transitionend', onCardSettled)
  state.detach = (): void => {
    body.removeEventListener('scroll', onScroll)
    removeEventListener('resize', schedule)
    removeEventListener('orientationchange', schedule)
    card?.removeEventListener('animationend', onCardSettled)
    card?.removeEventListener('transitionend', onCardSettled)
  }

  // sheet 入场动画和安全区变化会让 slot 在头几帧里移动；逐帧重算约 300ms。
  state.burstUntil = performance.now() + BURST_MS
  const burst = (): void => {
    state.burstFrame = 0
    if (state.closed) return
    recompute(state)
    if (performance.now() < state.burstUntil) state.burstFrame = requestAnimationFrame(burst)
  }
  burst()

  return {
    close: () => {
      if (state.closed) return
      release(state)
      notify()
    },
  }
}
