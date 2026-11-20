// paopao2 (吹泡泡) decides where it may move or blow bubbles with the desktop
// margins hard-coded in resources/pet/smallGamec1/.../core/MainWindow.as
// (left x<200, up y<200, right x>W-350, down y>H-365). On a 412x892 phone the
// left/right margins cover nearly the whole screen. The host cannot patch the
// deployed SWF, so smallgame-geometry.ts gives the root a virtual desktop-sized
// game area and clamps the real window; these tests pin the arithmetic and show
// the SWF's own filter recovers its candidates.
import assert from 'node:assert/strict'
import test from 'node:test'
import { clampRoot, paopaoGameArea } from '../../src/renderer/ui/smallgame-geometry.ts'

const MAIN = 140

/** MainWindow.checkScreenPosition() with the deployed SWF's API.GetScreenWidth/Height patch. */
const screenFlags = (x, y, screenWidth, screenHeight) => ({
  left: x < 200,
  up: y < 200,
  right: x > screenWidth - 300 - 50,
  down: y > screenHeight - 300 - 65,
})

// Kid branch (currentLabel != "adult") clip tables from Main.as:344-383.
const SIMPLE = ['b3', 'b6', 'b8', 'b9', 'b10', 'b11']
const CENTER = ['b1', 'b2', 'b6', 'b7', 'b8', 'upMove', 'downMove']
const CAN_NOT = {
  right: ['b1', 'runRight', 'b6', 'b7', 'b9'],
  left: ['b3', 'b5', 'b10', 'b11', 'runLeft'],
  up: ['upMove', 'b1', 'b2', 'runRight', 'b6', 'b10', 'runLeft'],
  down: ['downMove', 'b8', 'b9', 'b11'],
}

/** Main.checkPosition(): drop every clip blocked by a true edge flag. */
const filterCandidates = (candidates, flags) => {
  let out = candidates.slice()
  for (const edge of ['up', 'down', 'left', 'right']) {
    if (!flags[edge]) continue
    for (const clip of CAN_NOT[edge]) out = out.filter((candidate) => candidate !== clip)
  }
  return out
}

/** The root's SWF-visible rect and screen once the host maps its real position. */
const mapped = (area, x, y) => ({
  flags: screenFlags(area.offset + x, area.offset + y, area.width, area.height),
})

test('a phone viewport gets the virtual game area derived from the desktop margins', () => {
  assert.deepEqual(paopaoGameArea(412, 892), { offset: 180, width: 782, height: 1277 })
})

test('desktop and large-tablet viewports keep real coordinates at the exact boundary', () => {
  assert.equal(paopaoGameArea(1440, 900), null)
  // 200+350+140 = 690 wide and 200+365+140 = 705 high fit the desktop margins exactly.
  assert.equal(paopaoGameArea(690, 705), null)
  assert.notEqual(paopaoGameArea(689, 705), null)
  assert.notEqual(paopaoGameArea(690, 704), null)
})

test('the virtual area restores the SWF edge flags for a 412x892 root', () => {
  const area = paopaoGameArea(412, 892)
  assert.ok(area)

  // Real (136,400) becomes (316,580) — comfortably inside every desktop margin.
  assert.deepEqual(mapped(area, 136, 400).flags, { left: false, up: false, right: false, down: false })
  assert.deepEqual(filterCandidates(SIMPLE, mapped(area, 136, 400).flags), SIMPLE)

  // The edges stay 20 px away from the real bezel: 19 triggers, 20 does not; 252 does not, 253 does.
  assert.equal(mapped(area, 19, 400).flags.left, true)
  assert.equal(mapped(area, 20, 400).flags.left, false)
  assert.equal(mapped(area, 252, 400).flags.right, false)
  assert.equal(mapped(area, 253, 400).flags.right, true)
  assert.equal(mapped(area, 136, 19).flags.up, true)
  assert.equal(mapped(area, 136, 20).flags.up, false)
  assert.equal(mapped(area, 136, 732).flags.down, false)
  assert.equal(mapped(area, 136, 733).flags.down, true)

  // Only the flag that reaches its own edge flips; the other three stay false.
  assert.deepEqual(mapped(area, 19, 400).flags, { left: true, up: false, right: false, down: false })
  assert.deepEqual(mapped(area, 253, 400).flags, { left: false, up: false, right: true, down: false })
  assert.deepEqual(mapped(area, 136, 19).flags, { left: false, up: true, right: false, down: false })
  assert.deepEqual(mapped(area, 136, 733).flags, { left: false, up: false, right: false, down: true })
})

test('the unmapped phone collapses paopao2 candidates to one bubble; the mapped root does not', () => {
  // The device-measured start (136,400) under the raw 412x892 screen: left and right are both true.
  const raw = screenFlags(136, 400, 412, 892)
  assert.deepEqual(raw, { left: true, up: false, right: true, down: false })
  assert.deepEqual(filterCandidates(SIMPLE, raw), ['b8'], 'raw thresholds leave only the same down bubble')
  assert.deepEqual(filterCandidates(CENTER, raw), ['b2', 'b8', 'upMove', 'downMove'])

  const area = paopaoGameArea(412, 892)
  const flags = mapped(area, 136, 400).flags
  const simple = filterCandidates(SIMPLE, flags)
  assert.deepEqual(simple, SIMPLE)
  for (const clip of ['b6', 'b9', 'b10', 'b11']) assert.ok(simple.includes(clip), `${clip} must stay available`)
  assert.deepEqual(filterCandidates(CENTER, flags), CENTER)
})

test('clampRoot keeps the 140x140 window inside the 412x892 viewport', () => {
  assert.deepEqual(clampRoot(-30, 800, MAIN, MAIN, 412, 892), { x: 0, y: 752 })
  assert.deepEqual(clampRoot(300, -20, MAIN, MAIN, 412, 892), { x: 272, y: 0 })
  assert.deepEqual(clampRoot(136, 400, MAIN, MAIN, 412, 892), { x: 136, y: 400 })
  // A window larger than the viewport pins to the top-left instead of going negative.
  assert.deepEqual(clampRoot(10, 10, 500, 900, 412, 892), { x: 0, y: 0 })
})
