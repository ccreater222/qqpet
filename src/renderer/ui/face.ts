import { FACE } from '../pet/data/face'
import { machine } from '../pet/pet'
import type { Pose } from '../pet/machine'
import { rand } from '../pet/rand'
import { pokeMoodGain } from '../pet/mood'
import { uiCommands } from '../pet/command-map'
import { commandResultData, dispatchRuntimeCommand } from '../pet/runtime-command'
import { info, mood, runtimeProjectionMode, save, setInfo, stage, update } from '../pet/store'
import { addCount } from '../pet/tasks'
import { touch } from './dom'
import { floatMood } from './float'
import { windowView } from './window-view'

const HOVER_MS = 300
/** Distinct rapid clicks are queued; this cap keeps a stuck connection from growing an unbounded intent list. */
const MAX_PENDING_POKES = 24

const layer = document.createElement('div')
layer.className = 'face'
const petEl = document.getElementById('pet')!
petEl.appendChild(layer)

interface PokeIntent {
  key: string
  dir: string
  s: number
  e: number
}

const pendingPokes: PokeIntent[] = []
let sendingPokes = false

/** Shows the authoritative outcome for one accepted poke, once. */
function showPokeResult(result: Awaited<ReturnType<typeof dispatchRuntimeCommand>>): void {
  const data = commandResultData<{ mood: number; ddw?: number }>(result)
  if (data === null) return
  // The command owns the achievement counter; the unlock dialog stays local.
  if (data.ddw === 1) windowView({ title: '逗逗我~~', msg: '恭喜成功开启逗宠成就~~', goods: [{ url: 'pet/achievement/ddw.svg', name: '逗宠成就' }] })
  void floatMood(data.mood)
}

/**
 * Sends one distinct user intent at a time. This is a renderer-side queue, not
 * an offline command queue or an automatic retry: every click has its own
 * opId, and a rejected intent stops the batch instead of replaying a command
 * whose send provenance is unknown.
 */
async function sendPokes(): Promise<void> {
  if (sendingPokes) return
  sendingPokes = true
  try {
    while (pendingPokes.length > 0) {
      const intent = pendingPokes.shift()!
      const result = await dispatchRuntimeCommand(uiCommands.pokeFace(intent.key))
      if (result?.status === 'rejected') {
        pendingPokes.length = 0
        break
      }
      showPokeResult(result)
    }
  } finally {
    sendingPokes = false
  }
}

function enqueuePoke(intent: PokeIntent): void {
  if (pendingPokes.length >= MAX_PENDING_POKES) pendingPokes.shift()
  pendingPokes.push(intent)
  void sendPokes()
}

/**
 * `dir` is captured when the spots are drawn: the points belong to that mood band.
 * A later projection, tick decay or poke gain may move the pet to another band,
 * where the same key can name a missing interact clip; using the old band keeps
 * the animation loadable (and is also correct for an egg/kid's fixed directory).
 */
function poke(key: string, dir: string, s = 1, e = s): void {
  layer.replaceChildren()
  const faceActive: Pose = { a: 'faceActive', opt: { url: `pet/Action/${info.sex}/${dir}/interact/${key}${rand(s, e)}.swf`, opt: {} } }
  if (runtimeProjectionMode) {
    // Presentation first: the touch response is local UI, not a canonical state
    // change. machine.add keeps rapid clicks in order instead of replacing the
    // next pose, so every click has a visible response while data is serialized
    // separately below.
    machine.add(faceActive)
    enqueuePoke({ key, dir, s, e })
    return
  }
  addCount('Amusing')
  if (!save.gameSaveDatas.ddw) windowView({ title: '逗逗我~~', msg: '恭喜成功开启逗宠成就~~', goods: [{ url: 'pet/achievement/ddw.svg', name: '逗宠成就' }] })
  update('gameSaveDatas', { ddw: save.gameSaveDatas.ddw + 1 })
  const v = pokeMoodGain(info.mood)
  void floatMood(v)
  setInfo('mood', Math.min(info.mood + v, 1000))
  machine.play(faceActive)
}

/** 0 off, 1 invisible spots, 2 marked spots. */
export function setFaceClick(v: 0 | 1 | 2): void {
  update('settings', { faceClick: v })
  document.body.classList.toggle('faceHint', v === 2)
}
document.body.classList.toggle('faceHint', save.settings.faceClick === 2)

export function showFacePoints(): void {
  if (!save.settings.faceClick || machine.pose.a !== 'normal') return
  const st = stage()
  const band = st === 'Adult' ? mood() : null
  const dir = band === null ? st : `Adult/${band}`
  const points = band === null ? FACE[info.sex][st] : FACE[info.sex].Adult[band]
  layer.replaceChildren(
    ...Object.entries(points).map(([key, p]) => {
      const d = document.createElement('div')
      d.className = 'point'
      d.style.left = p.left
      d.style.top = p.top
      d.addEventListener('click', () => poke(key, dir, p.s, p.e ?? p.s))
      return d
    }),
  )
}

// Spots appear after hovering an idle pet without a button held.
let timer = 0
export function clearFacePoints(): void {
  clearTimeout(timer)
  layer.replaceChildren()
}
if (!touch) petEl.addEventListener('pointerenter', () => {
  timer = window.setTimeout(showFacePoints, HOVER_MS)
})
/**
 * A press on the pet that did not lift it is a click on the pet, so the cursor is still on it: bring back the spots
 * pointerdown hid, on touch and desktop alike (#113). Hover events cannot tell: on Windows the desktop drag fires a
 * pointerleave right after pointerdown although the cursor never left, and no pointerenter follows.
 */
export function showFacePointsAfterClick(): void {
  showFacePoints()
}
const inside = (e: PointerEvent): boolean => {
  if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return false
  const r = petEl.getBoundingClientRect()
  return e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom
}
// Touch taps are handled by the shared pet gesture path, including native hosts.
for (const ev of touch ? (['pointerdown'] as const) : (['pointerleave', 'pointerdown'] as const)) {
  petEl.addEventListener(ev, (e) => {
    if (layer.contains(e.target as Node)) return
    // On Windows a click ends with a pointerleave while the cursor is still on the pet (the window's hit test
    // changing under it); only a leave that is really off the pet hides the spots (#113).
    if (e.type === 'pointerleave' && inside(e as PointerEvent)) return
    clearFacePoints()
  })
}
