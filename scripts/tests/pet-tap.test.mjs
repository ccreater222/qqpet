import assert from 'node:assert/strict'
import test from 'node:test'
import { createPetInput } from '../../src/renderer/pet/input.ts'

// The shared gesture recognizer decides whether a press was a click, a drag or
// a long press. These tests drive it with a fake clock and record every action,
// so they pin the phone click rule without a browser or a native host.
function gesture(options = {}) {
  const taps = []
  const holds = []
  const moves = []
  const ends = []
  const active = []
  let now = 0
  const input = createPetInput({
    clock: () => now,
    requestFrame: () => 0,
    cancelFrame: () => {},
    position: () => ({ x: 100, y: 100, size: 100 }),
    begin: () => {},
    lift: () => null,
    move: (x, y, lifted) => moves.push([x, y, lifted]),
    end: (lifted, vx, vy, cancelled) => ends.push([lifted, vx, vy, cancelled]),
    hold: (x, y) => holds.push([x, y]),
    active: (on) => active.push(on),
    ...(options.tap === false ? {} : { tap: (x, y) => taps.push([x, y]) }),
  }, options.holdMilliseconds ?? 500)
  const send = (phase, x, y) => input.send({ phase, id: 1, x, y, time: now })
  return {
    input, taps, holds, moves, ends, active, send,
    at: (time) => { now = time },
    advance: (ms) => { now += ms },
  }
}

test('a short press with no movement is a tap at the release point', () => {
  const g = gesture()
  g.send('begin', 500, 300)
  g.at(120)
  g.send('end', 500, 300)
  assert.deepEqual(g.taps, [[500, 300]])
  assert.deepEqual(g.moves, [], 'a tap must not move the pet')
  assert.deepEqual(g.holds, [])
  assert.deepEqual(g.ends, [[false, 0, 0, false]])
})

test('thumb jitter under the lift threshold is a tap, not a drag', () => {
  const g = gesture()
  g.send('begin', 500, 300)
  g.advance(40)
  g.send('move', 504, 303)
  g.advance(40)
  g.send('move', 496, 298)
  g.advance(40)
  g.send('end', 496, 298)
  assert.deepEqual(g.taps, [[496, 298]], 'the menu opens where the finger lifted')
  assert.deepEqual(g.moves, [], 'under 8 px the pet must not be nudged (#113)')
})

test('a press that passes the 8 px lift threshold is a drag and never a tap', () => {
  const g = gesture()
  g.send('begin', 500, 300)
  g.advance(60)
  g.send('move', 520, 300)
  assert.equal(g.moves.length, 1)
  assert.equal(g.moves[0][2], true, 'the pet follows the finger once lifted')
  g.advance(40)
  g.send('end', 520, 300)
  assert.deepEqual(g.taps, [])
  assert.equal(g.ends.at(-1)[0], true)
  assert.equal(g.ends.at(-1)[3], false)
})

test('pointercancel never turns into a tap', () => {
  const g = gesture()
  g.send('begin', 500, 300)
  g.advance(50)
  g.send('move', 503, 301)
  g.send('cancel', 503, 301)
  assert.deepEqual(g.taps, [])
  assert.deepEqual(g.ends.at(-1), [false, 0, 0, true])
})

test('a host cancel (pause, hide) never turns into a tap', () => {
  const g = gesture()
  g.send('begin', 500, 300)
  g.advance(50)
  g.input.cancel()
  assert.deepEqual(g.taps, [])
  assert.deepEqual(g.ends.at(-1), [false, 0, 0, true])
})

test('a long press opens the menu through hold and is not repeated as a tap', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const g = gesture({ holdMilliseconds: 500 })
  g.send('begin', 500, 300)
  t.mock.timers.tick(500)
  assert.deepEqual(g.holds, [[500, 300]])
  g.at(520)
  g.send('end', 500, 300)
  assert.deepEqual(g.taps, [])
})

test('the tap window closes at 300 ms', () => {
  const quick = gesture()
  quick.send('begin', 500, 300)
  quick.at(299)
  quick.send('end', 500, 300)
  assert.equal(quick.taps.length, 1)

  const slow = gesture()
  slow.send('begin', 500, 300)
  slow.at(300)
  slow.send('end', 500, 300)
  assert.deepEqual(slow.taps, [], 'from 300 ms the press is no longer a click')
})

test('a tap reports page coordinates, not the native global ones', () => {
  const g = gesture()
  // A cropped/native host supplies global coordinates for velocity and flings.
  g.input.send({ phase: 'begin', id: 1, x: 550, y: 340, globalX: 100, globalY: 100, time: 0 })
  g.input.send({ phase: 'move', id: 1, x: 551, y: 341, globalX: 101, globalY: 101, time: 60 })
  g.input.send({ phase: 'end', id: 1, x: 551, y: 341, globalX: 101, globalY: 101, time: 120 })
  assert.deepEqual(g.taps, [[551, 341]], 'the menu is positioned in page space')
})

test('desktop callers without a tap callback see only the old press behaviour', () => {
  const g = gesture({ tap: false, holdMilliseconds: 0 })
  g.send('begin', 500, 300)
  g.at(100)
  g.send('end', 500, 300)
  assert.deepEqual(g.ends, [[false, 0, 0, false]])
  assert.deepEqual(g.moves, [])
  assert.deepEqual(g.holds, [])
})
