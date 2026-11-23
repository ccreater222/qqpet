// The small-game host opens one iframe + one Ruffle instance per window. On a
// touch host each such player defaults to wgpu-webgl, and the Android WebView
// runs out of memory at 7-8 players (repro run5: "wgpu error: Out of Memory"),
// killing that player's renderer with no recovery path. Canvas2D keeps the
// windows' pixels alive; desktop keeps Ruffle's own choice. This test drives the
// real open() path and records what SwfPlayer.load receives.
//
// Round two exposed the second half: destroying a game removed its iframes but
// the renderer never returned the ~84MB WASM heaps, so a second game added five
// more players on top of the first (985MB → lowmemorykiller). The host therefore
// pools shells/players across games (mobile only) and caps the live instances.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { clampRoot, paopaoGameArea } from '../../src/renderer/ui/smallgame-geometry.ts'

function strippedSource() {
  return stripTypeScriptTypes(readFileSync(new URL('../../src/renderer/ui/smallgame.ts', import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export \{.*\}$/gm, '')
    .replace(/^export /gm, '')
}

/** Run smallgame.ts in a fake DOM and return open(); FakeSwfPlayer records every load call. */
function hostFixture(touchHost) {
  const players = []
  const appended = []
  let onLoad = null

  // FakeSwfPlayer is constructed from inside the vm but defined in this realm,
  // so pushing here is visible to the test.
  class FakeSwfPlayer {
    constructor(body) {
      this.body = body
      this.loads = []
      this.el = { ruffle: () => ({ addFSCommandHandler: () => {} }) }
      players.push(this)
    }

    load(...args) {
      this.loads.push(args)
      return Promise.resolve()
    }

    setIdle() {}
  }

  const frame = {
    contentWindow: {},
    contentDocument: { body: {}, addEventListener: () => {} },
    addEventListener(type, callback) {
      if (type === 'load') onLoad = callback
    },
  }
  const box = {
    style: {},
    dataset: {},
    classList: { toggle: () => {} },
    append: () => {},
    remove: () => {},
  }
  const document = {
    body: { append: (node) => appended.push(node) },
    createElement: () => frame,
  }
  const context = {
    touch: touchHost,
    document,
    SwfPlayer: FakeSwfPlayer,
    div: () => box,
    button: () => ({ remove: () => {} }),
    clampRoot,
    innerWidth: 412,
    innerHeight: 892,
    window: {
      qqpet: {
        setFocusable: () => {},
        get sendGameKey() { return nativeGameKeyPresent ? (code, phase) => { nativeGameKeys.push([code, phase]); return Promise.resolve(nativeGameKeyResult) } : undefined },
      },
      API: { GetCursorPosition: () => '0,0' },
      QQPetNative: { setGameKeyActive: (on) => { nativeGameActive.push(on) } },
    },
  }
  runInNewContext(strippedSource() + '\nthis.__smallgame = { open }', context)

  return {
    open(name, swf, x, y, w, h) {
      players.length = 0
      context.__smallgame.open(name, null, swf, x, y, w, h)
      assert.equal(typeof onLoad, 'function', 'open() must wait for the iframe load')
      onLoad()
      assert.equal(players.length, 1, 'open() must create exactly one SwfPlayer')
      return { loads: players[0].loads, appended }
    },
  }
}

test('touch small-game iframes ask Ruffle for Canvas2D', () => {
  const host = hostFixture(true)
  const { loads } = host.open('main', 'main_122.swf', 136, 400, 140, 140)
  assert.equal(loads.length, 1)
  // The options object is created inside the vm realm, so compare its fields, not its prototype.
  assert.deepEqual(Object.keys(loads[0][2]), ['preferredRenderer'])
  assert.equal(loads[0][2].preferredRenderer, 'canvas')
})

test('desktop small-game iframes keep Ruffle\'s default renderer', () => {
  const host = hostFixture(false)
  const { loads } = host.open('main', 'main_122.swf', 136, 400, 140, 140)
  assert.equal(loads.length, 1)
  assert.equal(loads[0][2], undefined, 'no renderer option may be injected on a desktop host')
})

const PAOPAO = { dir: 'paopao2', name: '吹泡泡', icon: 'paopao' }
const GUESS = { dir: 'guess', name: '猜动作', icon: 'guess' }
const ROPE = { dir: 'rope', name: '跳绳', icon: 'tiaosheng' }
const CENG = { dir: '100ceng', name: '下一百层', icon: undefined }
const MOUSE = { dir: 'mouse', name: '捉老鼠', icon: 'duolaoshu' }
const BALL = { dir: 'ball', name: '颠球', icon: 'tanliqiu' }

/**
 * The full paopao2 start path: #pet rect → root window → its ExternalInterface API.
 * The fake DOM keeps every iframe, box and SwfPlayer so pooling can be asserted
 * by identity (same iframe/player, not a new one).
 */
function paopaoHostFixture({ touchHost = true } = {}) {
  const frames = []
  const boxes = []
  const players = []
  const intervals = []
  const nativeGameKeys = []
  const nativeGameActive = []
  let nativeGameKeyResult = false
  let nativeGameKeyPresent = false
  let loadBehavior = () => 'resolve'
  const pet = {
    hidden: false,
    rect: { left: 112, top: 352, width: 187.7, height: 187.7, bottom: 539.7 },
    getBoundingClientRect() {
      return this.rect
    },
  }

  class FakeSwfPlayer {
    constructor(frame) {
      this.frame = frame
      this.loads = []
      this.calls = []
      this.events = []
      this.idle = false
      this.destroyed = false
      this.el = {
        focus: () => {},
        dispatchEvent: (event) => { this.events.push({ type: event.type, key: event.key, keyCode: event.keyCode }) },
        ruffle: () => ({
          addFSCommandHandler: () => {},
          callExternalInterface: (fn, ...args) => { this.calls.push([fn, ...args]) },
        }),
      }
      players.push(this)
    }

    load(url, base, options) {
      this.loads.push({ url, base, options })
      if (loadBehavior(url) === 'reject') return Promise.reject(new Error('SWF load timed out'))
      return Promise.resolve()
    }

    setIdle(idle) {
      this.idle = idle
    }

    nextPaint() {
      return Promise.resolve()
    }

    destroy() {
      this.destroyed = true
    }
  }

  function createFrame() {
    const frame = {
      focused: false,
      contentWindow: {},
      contentDocument: {
        body: {},
        events: [],
        addEventListener: () => {},
        dispatchEvent(event) {
          this.events.push(event)
          return true
        },
      },
      listeners: {},
      addEventListener(type, callback) {
        this.listeners[type] = callback
      },
    }
    frame.contentWindow.focus = () => { frame.focused = true }
    frame.contentWindow.document = frame.contentDocument
    frames.push(frame)
    return frame
  }

  function createBox() {
    const box = {
      style: {},
      dataset: {},
      hidden: false,
      removed: false,
      textContent: '',
      title: '',
      handlers: {},
      classList: {
        values: new Set(),
        toggle(name, on) {
          if (on === undefined ? !this.values.has(name) : on) this.values.add(name)
          else this.values.delete(name)
        },
        contains(name) { return this.values.has(name) },
      },
      append: () => {},
      addEventListener(type, callback) {
        ;(this.handlers[type] ??= []).push(callback)
      },
      remove() {
        this.removed = true
      },
    }
    boxes.push(box)
    return box
  }

  const context = {
    touch: touchHost,
    document: {
      listeners: {},
      body: { append: () => {} },
      createElement: () => createFrame(),
      getElementById: () => pet,
      addEventListener(type, callback) {
        ;(this.listeners[type] ??= []).push(callback)
      },
      removeEventListener() {},
    },
    SwfPlayer: FakeSwfPlayer,
    div: () => createBox(),
    button: () => ({ remove: () => {} }),
    clampRoot,
    paopaoGameArea,
    setTimeout: (run) => { run(); return 0 },
    clearTimeout: () => {},
    setInterval: (run) => { intervals.push(run); return intervals.length },
    clearInterval: () => {},
    KeyboardEvent: class FakeKeyboardEvent {
      constructor(type, init) {
        this.type = type
        Object.assign(this, init)
      }
    },
    PointerEvent: class FakePointerEvent {
      constructor(type, init) {
        this.type = type
        Object.assign(this, init)
      }
    },
    MouseEvent: class FakeMouseEvent {
      constructor(type, init) {
        this.type = type
        Object.assign(this, init)
      }
    },
    innerWidth: 412,
    innerHeight: 892,
    window: {
      qqpet: {
        setFocusable: () => {},
        get sendGameKey() { return nativeGameKeyPresent ? (code, phase) => { nativeGameKeys.push([code, phase]); return Promise.resolve(nativeGameKeyResult) } : undefined },
      },
      API: { GetCursorPosition: () => '0,0' },
      QQPetNative: { setGameKeyActive: (on) => { nativeGameActive.push(on) } },
    },
    playingDesk: () => false,
    runtimeProjectionMode: false,
    stage: () => 'Kid',
    busy: () => false,
    speak: () => {},
    info: { sex: 'GG' },
    save: { petComputedlInfo: { moodMax: 1000 } },
    setDeskGame: () => {},
    setTray: () => {},
    refreshTray: () => {},
    addCount: () => {},
    earnYb: () => 0,
    setInfo: () => {},
    floatMood: () => {},
  }
  runInNewContext(
    strippedSource() + '\nthis.__smallgame = { playSmallGame, games: SMALL_GAMES, state: () => ({ root, dir, wins, pools, shells, keypad, lastPointer, activePointer }) }',
    context,
  )

  const smallgame = () => context.__smallgame
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const host = {
    context,
    frames,
    boxes,
    players,
    pet,
    intervals,
    nativeGameKeys,
    nativeGameActive,
    setNativeGameKey(result) { nativeGameKeyPresent = true; nativeGameKeyResult = result },
    removeNativeGameKey() { nativeGameKeyPresent = false },
    settle,
    pointer(type, x, y, extra = {}) {
      const event = { clientX: x, clientY: y, pointerId: 1, isPrimary: true, target: null, ...extra }
      for (const listener of context.document.listeners[type] ?? []) listener(event)
    },
    state: () => smallgame().state(),
    games: () => smallgame().games,
    setLoadBehavior(behavior) {
      loadBehavior = behavior
    },
    /** Fire the iframe load events created since `before` (reused shells do not fire one). */
    loadFrames(before) {
      for (let i = before; i < frames.length; i++) {
        assert.equal(typeof frames[i].listeners.load, 'function', 'new iframe must wait for load')
        frames[i].listeners.load()
      }
    },
    play(game = PAOPAO) {
      const before = frames.length
      smallgame().playSmallGame(game)
      host.loadFrames(before)
      const rootWin = host.state().root
      assert.ok(rootWin, 'playSmallGame must create a root window')
      host.rootApi = rootWin.frame.contentWindow.API
      return { rootApi: host.rootApi, frames }
    },
    /** MainWindow.createAllChildrenWindow/createBubbleWindow use virtual root coordinates. */
    createWindow(name, swf, x, y, w, h, { hidden = false, show = true } = {}) {
      const before = frames.length
      const result = host.rootApi.CreateWindow(name, x, y, w, h, hidden ? 1 : 0, swf)
      assert.equal(result, 1, `CreateWindow(${name}) must succeed`)
      host.loadFrames(before)
      // 100ceng/ball SWFs use Windows Show semantics (1=show); other games use 0=show.
      const windowsShow = host.state().dir === '100ceng' || host.state().dir === 'ball'
      if (show) host.rootApi.Show(windowsShow ? 1 : 0, name)
      return result
    },
  }
  return host
}

test('paopao2 maps only the root onto the virtual game area; children keep real coordinates', () => {
  const host = paopaoHostFixture()
  const { rootApi, frames } = host.play()

  // Device baseline: #pet [112,352,187.7,187.7] puts the root at real (136,400).
  assert.equal(rootApi.GetWindowPosition(), '316,580', 'root reports +180 offset')
  assert.equal(rootApi.GetWindowRect(), '316,580,140,140')
  assert.equal(rootApi.GetScreenWidth(), 782)
  assert.equal(rootApi.GetScreenHeight(), 1277)

  // MainWindow.createAllChildrenWindow passes the root's virtual wx/wy to CreateWindow.
  rootApi.CreateWindow('wnd_name_status_mood', 316, 720, 140, 20, 0, 'status_mood.swf')
  assert.equal(frames.length, 2)
  frames[1].listeners.load()
  const childApi = frames[1].contentWindow.API
  assert.equal(childApi.GetWindowRect(), '136,540,140,20', 'child window keeps real coordinates')
  assert.equal(childApi.GetScreenWidth(), 412, 'child SWFs keep the real screen')
  assert.equal(rootApi.GetWindowRect('wnd_name_status_mood'), '136,540,140,20', 'root reads children in real coordinates')

  // setBubbleWindow: moveTo(virtual root + relative) must land at the same real relative offset.
  rootApi.MoveTo(326, 590, 'wnd_name_status_mood')
  assert.equal(childApi.GetWindowRect(), '146,410,140,20')

  // MoveBy stays relative in both spaces; the real root is clamped, and the SWF sees the clamp.
  rootApi.MoveBy(0, -1000)
  assert.equal(rootApi.GetWindowRect(), '316,180,140,140', 'top clamp: real y=0 → virtual y=180')
  rootApi.MoveBy(1000, 1000)
  assert.equal(rootApi.GetWindowRect(), '452,932,140,140', 'bottom-right clamp: real (272,752)')
})

test('every touch small-game root is clamped, including non-paopao2 games', async () => {
  const host = paopaoHostFixture()
  host.play(GUESS)
  await host.settle()
  // guess has no virtual game area: the SWF still sees real screen coordinates.
  assert.equal(host.rootApi.GetWindowPosition(), '136,400')
  host.rootApi.MoveBy(-10000, -10000)
  assert.equal(host.rootApi.GetWindowRect(), '0,0,140,140', 'touch root pinned to the top-left')
  assert.equal(host.boxes[0].style.left, '0px')
  assert.equal(host.boxes[0].style.top, '0px')
  host.rootApi.MoveBy(10000, 10000)
  assert.equal(host.rootApi.GetWindowRect(), '272,752,140,140', 'touch root pinned to the bottom-right')
  assert.equal(host.boxes[0].style.left, '272px')
  assert.equal(host.boxes[0].style.top, '752px')
})

test('desktop roots keep the legacy unclamped movement', async () => {
  const host = paopaoHostFixture({ touchHost: false })
  host.play(GUESS)
  await host.settle()
  host.rootApi.MoveBy(-10000, -10000)
  assert.equal(host.rootApi.GetWindowRect(), '-9864,-9600,140,140')
})

test('the shell budget is baseWindows + maxDynamicWindows per game', async () => {
  const guess = paopaoHostFixture()
  guess.play(GUESS)
  await guess.settle()
  for (let i = 0; i < 14; i++) guess.createWindow(`g${i}`, 'BubbleGreen.swf', 316, 580, 70, 70)
  await guess.settle()
  assert.equal(guess.state().shells.size, 10, 'guess baseWindows(7) + maxDynamicWindows(3)')

  const rope = paopaoHostFixture()
  rope.play(ROPE)
  await rope.settle()
  for (let i = 0; i < 10; i++) rope.createWindow(`r${i}`, 'BubbleGreen.swf', 316, 580, 70, 70)
  await rope.settle()
  assert.equal(rope.state().shells.size, 5, 'rope baseWindows(5) + maxDynamicWindows(0)')

  const ball = paopaoHostFixture()
  ball.play({ dir: 'ball', name: '颠球', icon: 'tanliqiu' })
  await ball.settle()
  for (let i = 0; i < 14; i++) ball.createWindow(`b${i}`, 'BubbleGreen.swf', 316, 580, 70, 70)
  await ball.settle()
  assert.equal(ball.state().shells.size, 11, 'ball baseWindows(8) + maxDynamicWindows(3)')

  const budgets = Object.fromEntries(guess.games().map((game) => [game.dir, { base: game.baseWindows, max: game.maxDynamicWindows }]))
  assert.deepEqual(budgets, {
    guess: { base: 7, max: 3 },
    paopao2: { base: 5, max: 6 },
    rope: { base: 5, max: 0 },
    mouse: { base: 5, max: 1 },
    ball: { base: 8, max: 3 },
    '100ceng': { base: 5, max: 0 },
  })
})

test('paopao2 prompts load eagerly so the root waitList can complete', async () => {
  const host = paopaoHostFixture()
  host.play()
  await host.settle()
  const before = host.players.length
  host.createWindow('wnd_name_prompt_mood', 'prompt_mood.swf', 291, 568, 180, 90, { show: false })
  await host.settle()
  assert.equal(host.players.length, before + 1, 'CreateWindow starts the prompt immediately')
  const mood = host.players[before]
  assert.match(mood.loads[0].url, /prompt_mood\.swf$/)
  assert.equal(host.state().wins.get('wnd_name_prompt_mood').box.hidden, false, 'hidden=0 creation stays visible')

  host.rootApi.Show(1, 'wnd_name_prompt_mood')
  assert.equal(host.state().wins.get('wnd_name_prompt_mood').box.hidden, true)
  host.rootApi.Show(0, 'wnd_name_prompt_mood')
  assert.equal(host.state().wins.get('wnd_name_prompt_mood').box.hidden, false)

  const beforeMoney = host.players.length
  host.createWindow('wnd_name_prompt_money', 'prompt_money.swf', 241, 581, 300, 180, { show: false })
  await host.settle()
  assert.equal(host.players.length, beforeMoney + 1)
  host.rootApi.RemoteCall('wnd_name_prompt_money', 'MoneyPrompt.onMoneyPrompt')
  assert.deepEqual(host.players[beforeMoney].calls.at(-1), ['MoneyPrompt.onMoneyPrompt'], 'eager prompt answers immediately')

  // A reused shell reloads the prompt when it is activated, before the root waits on it.
  const moodLoads = mood.loads.length
  host.rootApi.DestroyWindow()
  assert.equal(host.state().wins.size, 0)
  host.play()
  await host.settle()
  host.createWindow('wnd_name_prompt_mood', 'prompt_mood.swf', 291, 568, 180, 90, { show: false })
  await host.settle()
  assert.equal(mood.loads.length, moodLoads + 1, 'reused eager prompt reloads at activation')
})

test('a second game reuses the pooled root and base shells instead of allocating new Ruffle instances', async () => {
  const host = paopaoHostFixture()
  const first = host.play()
  await host.settle()
  host.createWindow('wnd_name_status_mood', 'status_mood.swf', 316, 720, 140, 20)
  host.createWindow('wnd_name_status_count', 'status_count.swf', 236, 650, 60, 55)
  await host.settle()
  assert.equal(host.frames.length, 3)
  assert.equal(host.players.length, 3)
  const players = host.players.slice()

  first.rootApi.DestroyWindow('wnd_name_status_mood')
  first.rootApi.DestroyWindow('wnd_name_status_count')
  first.rootApi.DestroyWindow() // root: finish() must restore the pet, not rebuild next time
  assert.equal(host.state().wins.size, 0)
  assert.equal(host.state().shells.size, 3, 'pooled shells stay alive between games')
  assert.equal(host.pet.hidden, false, 'finish() still restores the pet')
  for (const box of host.boxes) {
    assert.equal(box.removed, false, 'pooled boxes must stay connected (MutationObserver would destroy the player)')
    assert.equal(box.style.display, 'none')
    assert.equal(box.dataset.pooled, '1')
  }

  const second = host.play()
  host.createWindow('wnd_name_status_mood', 'status_mood.swf', 316, 720, 140, 20)
  host.createWindow('wnd_name_status_count', 'status_count.swf', 236, 650, 60, 55)
  await host.settle()

  assert.equal(host.frames.length, 3, 'same iframes reused')
  assert.equal(host.players.length, 3, 'same SwfPlayer instances reused')
  for (const box of host.boxes) assert.equal(box.dataset.pooled, undefined, 'claimed shells leave the pool state')
  for (const player of players) assert.equal(player.loads.length, 2, 'the pooled player is reloaded, never recreated')
  assert.equal(players[1].loads[1].url, 'pet/smallGame/paopao2/status_mood.swf')
  assert.notEqual(second.rootApi, first.rootApi, 'API is rebound to the new Win on reuse')
  assert.equal(second.rootApi.GetWindowRect(), '316,580,140,140')
  assert.equal(host.state().pools.size, 0, 'every pooled shell was claimed back')
})

test('bubble shells are pooled by swf+size and reused', async () => {
  const host = paopaoHostFixture()
  host.play()
  await host.settle()
  host.createWindow('rank,Green', 'BubbleGreen.swf', 316, 580, 70, 70)
  await host.settle()
  assert.equal(host.frames.length, 2)
  const bubblePlayer = host.players[1]

  host.rootApi.DestroyWindow('rank,Green')
  assert.equal(host.state().wins.has('rank,Green'), false)
  assert.equal(host.state().pools.get('BubbleGreen.swf|70x70')?.length, 1)

  host.createWindow('rank,Green', 'BubbleGreen.swf', 326, 590, 70, 70)
  await host.settle()
  assert.equal(host.frames.length, 2, 'same bubble iframe reused')
  assert.equal(host.players.length, 2, 'same bubble SwfPlayer reused')
  assert.equal(bubblePlayer.loads.length, 2)
  assert.equal(bubblePlayer.loads[1].url, 'pet/smallGame/paopao2/BubbleGreen.swf')
  assert.equal(host.rootApi.GetWindowRect('rank,Green'), '146,410,70,70', 'reused shell takes the new real position')
})

test('the paopao2 pool caps at 11 and evicts the oldest shown bubble, never a provisional window', async () => {
  const host = paopaoHostFixture()
  host.play()
  await host.settle()
  host.createWindow('wnd_name_status_mood', 'status_mood.swf', 316, 720, 140, 20)
  host.createWindow('wnd_name_status_count', 'status_count.swf', 236, 650, 60, 55)
  host.createWindow('wnd_name_prompt_mood', 'prompt_mood.swf', 291, 568, 180, 90, { show: false })
  host.createWindow('wnd_name_prompt_money', 'prompt_money.swf', 241, 581, 300, 180, { show: false })
  await host.settle()
  host.createWindow('b1', 'BubbleGreen.swf', 316, 580, 70, 70, { show: false })
  host.rootApi.Show(1, 'b1') // createBubbleWindow hides it until setBubbleWindow
  for (let i = 2; i <= 6; i++) host.createWindow(`b${i}`, 'BubbleGreen.swf', 316, 580, 70, 70)
  await host.settle()
  assert.equal(host.state().shells.size, 11, 'root + 4 base + 6 bubbles')

  host.createWindow('b7', 'BubbleGreen.swf', 316, 580, 70, 70)
  await host.settle()
  assert.equal(host.state().shells.size, 11, 'the cap holds at 11')
  assert.equal(host.state().wins.has('b2'), false, 'oldest shown bubble gave up its window name')
  assert.equal(host.state().wins.has('b1'), true, 'an unshown provisional window must survive')
  assert.equal(host.state().wins.has('b7'), true)
  assert.equal(host.state().wins.has('wnd_name_status_mood'), true)
  assert.equal(host.state().wins.has('wnd_name_prompt_mood'), true, 'base windows are never reclaimed')

  // A request that cannot share a bubble shell's size falls back to destroying the oldest bubble.
  const liveBefore = host.players.length
  host.createWindow('big', 'BubbleBlue.swf', 316, 580, 80, 80, { show: false })
  await host.settle()
  assert.equal(host.state().shells.size, 11)
  assert.equal(host.players.length, liveBefore + 1, 'a differing size needs one new shell')
  assert.equal(host.players.filter((player) => player.destroyed).length, 1)
  assert.equal(host.state().wins.has('b1'), true, 'provisional windows are still protected')
  assert.equal(host.state().wins.has('b3'), false, 'the next oldest shown bubble was destroyed')
})

test('a failed SWF load discards the iframe and player instead of leaving an empty window', async () => {
  const host = paopaoHostFixture()
  host.play()
  await host.settle()
  host.setLoadBehavior((url) => (url.includes('BubblePink') ? 'reject' : 'resolve'))
  const before = host.players.length

  host.createWindow('rank,Pink', 'BubblePink.swf', 316, 580, 70, 70, { show: false })
  await host.settle()

  assert.equal(host.state().wins.has('rank,Pink'), false)
  assert.equal(host.state().shells.size, 1, 'only the root shell remains')
  assert.equal(host.state().pools.size, 0, 'a failed shell is discarded, not pooled')
  assert.equal(host.players[before].destroyed, true)
  assert.equal(host.boxes[host.boxes.length - 1].removed, true, 'its iframe/box is removed from the DOM')
})

test('a failed root load restores the pet and leaves no game window or pooled shell', async () => {
  const host = paopaoHostFixture()
  host.setLoadBehavior((url) => (url.includes('main_') ? 'reject' : 'resolve'))
  host.play()
  await host.settle()

  assert.equal(host.state().root, null)
  assert.equal(host.state().wins.size, 0)
  assert.equal(host.state().shells.size, 0)
  assert.equal(host.pet.hidden, false)
})

test('API calls naming a destroyed or pooled window are safe no-ops', () => {
  const host = paopaoHostFixture()
  const { rootApi } = host.play()
  rootApi.CreateWindow('gone', 316, 580, 70, 70, 0, 'BubbleGreen.swf')
  const temporary = host.frames[1]
  temporary.listeners.load()
  rootApi.DestroyWindow('gone')

  for (const name of ['gone', 'never-existed']) {
    assert.equal(rootApi.MoveTo(10, 20, name), 0)
    assert.equal(rootApi.MoveBy(1, 1, name), 0)
    assert.equal(rootApi.ResizeWindow(10, 10, name), 0)
    assert.equal(rootApi.DestroyWindow(name), 0)
    assert.equal(rootApi.Show(0, name), 0)
    assert.equal(rootApi.EnableDrag(1, name), 0)
    assert.equal(rootApi.IsVisible(name), 0)
    assert.equal(rootApi.IsEnableDrag(name), 0)
    assert.equal(rootApi.GetWindowRect(name), '0,0,0,0')
    assert.equal(rootApi.RemoteCall(name, 'anything'), undefined)
  }
  assert.doesNotThrow(() => rootApi.SetWindow('topmost', 'gone'))
})

test('switching games evicts idle pooled shells from the previous game so base windows still fit', async () => {
  const host = paopaoHostFixture()
  host.play()
  await host.settle()
  host.createWindow('wnd_name_status_mood', 'status_mood.swf', 316, 720, 140, 20)
  host.createWindow('wnd_name_status_count', 'status_count.swf', 236, 650, 60, 55)
  host.createWindow('wnd_name_prompt_mood', 'prompt_mood.swf', 291, 568, 180, 90)
  host.createWindow('wnd_name_prompt_money', 'prompt_money.swf', 241, 581, 300, 180)
  for (let i = 0; i < 4; i++) host.createWindow(`rank,Green${i}`, 'BubbleGreen.swf', 316, 580, 70, 70)
  await host.settle()
  assert.equal(host.state().shells.size, 9)
  host.rootApi.DestroyWindow()
  assert.equal(host.state().wins.size, 0)
  assert.equal(host.state().shells.size, 9, 'the whole previous game is parked in the pool')

  // Game B's base windows use different SWF names/sizes, so takePooled() cannot claim game A's.
  host.play({ dir: 'guess', name: '猜动作', icon: 'guess' })
  await host.settle()
  const bases = [
    ['guess_status', 'guess_status.swf', 100, 20],
    ['guess_count', 'guess_count.swf', 60, 40],
    ['guess_prompt', 'guess_prompt.swf', 160, 60],
    ['guess_money', 'guess_money.swf', 200, 100],
    ['guess_extra', 'guess_extra.swf', 120, 40],
  ]
  for (const [name, swf, width, height] of bases) host.createWindow(name, swf, 316, 580, width, height)
  await host.settle()
  for (const [name] of bases) assert.equal(host.state().wins.has(name), true, `${name} must be created`)
  assert.equal(host.state().shells.size, 10, 'game A idle shells made room; guess cap = 7+3 holds')
  assert.ok(host.state().wins.has('guess_money'), 'prompt/money windows are not starved of shell slots')
})

test('guess fits six base windows and three action windows in its budget', async () => {
  const host = paopaoHostFixture()
  host.play(GUESS)
  await host.settle()
  const bases = [
    ['wnd_name_status_mood', 'status_mood.swf', 316, 720, 140, 20],
    ['wnd_name_status_count', 'status_count.swf', 236, 650, 60, 25],
    ['wnd_name_prompt_mood', 'prompt_mood.swf', 291, 568, 180, 90],
    ['wnd_name_prompt_money', 'prompt_money.swf', 241, 581, 300, 180],
    ['wnd_name_prompt_text', 'prompt_text.swf', 266, 495, 150, 65],
    ['wnd_name_prompt_timer', 'prompt_timer.swf', 271, 480, 140, 140],
  ]
  for (const [name, swf, x, y, width, height] of bases) host.createWindow(name, swf, x, y, width, height)
  for (let i = 1; i <= 3; i++) host.createWindow(`WND_NAME_ACTION_${i}`, 'action_102.swf', 316, 580, 80, 80)
  await host.settle()

  assert.equal(host.state().shells.size, 10, 'root + 6 base + 3 action')
  for (const [name] of bases) assert.equal(host.state().wins.has(name), true, `${name} must be created`)
  for (let i = 1; i <= 3; i++) assert.equal(host.state().wins.has(`WND_NAME_ACTION_${i}`), true)
  assert.equal(host.players.filter((player) => !player.destroyed).length, 10, 'no base window was reclaimed for an action')
})

test('mouse rat stays passive; a rat tap is forwarded to the root pet jump', async () => {
  const host = paopaoHostFixture()
  host.play(MOUSE)
  await host.settle()
  host.createWindow('wnd_name_rat_1', 'rat.swf', 20, 30, 35, 30)
  await host.settle()
  const rat = host.state().wins.get('wnd_name_rat_1')
  assert.equal(rat.box.classList.contains('passive'), true, 'rat remains pointer-events:none')

  const rootPlayer = host.players[0]
  const before = rootPlayer.events.length
  host.pointer('pointerdown', 25, 35)
  await host.settle()
  const forwarded = rootPlayer.events.slice(before)
  assert.ok(forwarded.some((event) => event.type === 'pointerdown'), 'rat tap becomes a root pointerdown')
  assert.ok(forwarded.some((event) => event.type === 'mousedown'), 'rat tap becomes a root mousedown')
  assert.equal(host.context.window.__qqpetSmallGameKeys.mouseForwards, 1)
})

test('touch pointermove feeds GetCursorPosition in window-local CSS px', async () => {
  const host = paopaoHostFixture()
  host.play()
  await host.settle()
  const root = host.state().root
  host.pointer('pointermove', root.x + 12, root.y + 34)
  assert.equal(host.state().lastPointer.x, root.x + 12)
  assert.equal(host.state().lastPointer.y, root.y + 34)
  assert.equal(host.rootApi.GetCursorPosition(), '12,34,0')

  host.pointer('pointermove', 0, 0, { pointerId: 2, isPrimary: false })
  assert.equal(host.rootApi.GetCursorPosition(), '12,34,0', 'a second finger cannot move the cursor')

  const desktop = paopaoHostFixture({ touchHost: false })
  desktop.play()
  await desktop.settle()
  desktop.pointer('pointermove', 10, 20)
  assert.equal(desktop.rootApi.GetCursorPosition(), '0,0', 'desktop keeps the native cursor')
})

test('touch bridge sends passive/hidden hit calls only to visible windows under the pointer', async () => {
  const host = paopaoHostFixture()
  host.play(MOUSE)
  await host.settle()
  host.createWindow('wnd_name_rat_1', 'rat.swf', 20, 30, 35, 30)
  host.createWindow('wnd_name_rat_2', 'rat.swf', 100, 100, 35, 30, { hidden: true, show: false })
  await host.settle()
  const rat = host.players[1]
  const hidden = host.players[2]

  host.pointer('pointermove', 25, 35)
  assert.deepEqual(rat.calls.at(-1), ['APIEvent.OnMouseMove', 5, 5])
  host.pointer('pointerdown', 25, 35)
  assert.deepEqual(rat.calls.at(-1), ['APIEvent.OnHitWindow', 5, 5])

  host.pointer('pointermove', 110, 110)
  assert.equal(hidden.calls.length, 0, 'hidden windows receive nothing')

  host.pointer('pointercancel', 25, 35)
  assert.equal(host.state().activePointer, null, 'pointercancel releases the active pointer')
  host.pointer('pointermove', 26, 36)
  assert.deepEqual(rat.calls.at(-1), ['APIEvent.OnMouseMove', 6, 6], 'a new pointer can move afterwards')

  const beforePool = rat.calls.length
  host.rootApi.DestroyWindow()
  host.pointer('pointermove', 25, 35)
  assert.equal(rat.calls.length, beforePool, 'pooled shells are not hit targets')
})

test('ball uses Windows Show semantics and keeps ball/shadow/base across quit and reopen', async () => {
  const host = paopaoHostFixture()
  host.play(BALL)
  await host.settle()
  host.createWindow('WND_NAME_BALL', 'ball.swf', 0, 0, 50, 50, { hidden: true, show: false })
  await host.settle()
  const ball = host.state().wins.get('WND_NAME_BALL')
  assert.equal(ball.box.hidden, true, 'ball starts hidden before the throw')
  host.rootApi.Show(1, 'WND_NAME_BALL')
  assert.equal(ball.box.hidden, false, 'letballMove uses Show(1) to reveal the ball')
  host.rootApi.Show(0, 'WND_NAME_BALL')
  assert.equal(ball.box.hidden, true, 'onBallWinRemove uses Show(0) to hide it')

  // Throw: ball + shadow + base windows are all visible; DOM/shell count stays bounded.
  host.rootApi.Show(1, 'WND_NAME_BALL')
  host.createWindow('WND_NAME_SHADOW', 'shadow.swf', 81, 130, 55, 15)
  host.createWindow('WND_NAME_STATUS_MOOD', 'status_mood.swf', 50, 50, 140, 20)
  host.createWindow('WND_NAME_STATUS_COUNT', 'status_count.swf', 50, 80, 60, 25)
  host.createWindow('WND_NAME_PROMPT_MOOD', 'prompt_mood.swf', 50, 100, 180, 90)
  host.createWindow('WND_NAME_PROMPT_MONEY', 'prompt_money.swf', 50, 120, 300, 180)
  await host.settle()
  assert.equal(ball.box.hidden, false)
  assert.equal(host.state().wins.get('WND_NAME_SHADOW').box.hidden, false)
  for (const name of ['WND_NAME_STATUS_MOOD', 'WND_NAME_STATUS_COUNT', 'WND_NAME_PROMPT_MOOD', 'WND_NAME_PROMPT_MONEY']) {
    assert.equal(host.state().wins.get(name).box.hidden, false, `${name} must be visible`)
  }
  assert.ok(host.state().shells.size <= 11, 'ball 8+3 budget')

  // Quit returns every shell to the pool; a reopen reuses it instead of allocating another game.
  const shells = host.state().shells.size
  host.rootApi.DestroyWindow()
  assert.equal(host.state().wins.size, 0)
  assert.equal(host.state().shells.size, shells)
  assert.ok(host.state().pools.size > 0)
  host.play(BALL)
  await host.settle()
  assert.ok(host.state().root, 'ball can be reopened')
  assert.equal(host.state().wins.get('WND_NAME_BALL')?.swf ?? 'ball.swf', 'ball.swf')
})

test('100ceng uses Windows Show semantics: Show(1) reveals the player, Show(0) hides it', async () => {
  const host = paopaoHostFixture()
  host.play(CENG)
  await host.settle()
  host.createWindow('w_name_player', 'player_boy.swf', 316, 580, 140, 140, { hidden: true, show: false })
  await host.settle()
  const player = host.state().wins.get('w_name_player')
  assert.equal(player.box.hidden, true, 'createWindow(...,1) starts hidden')

  host.rootApi.Show(1, 'w_name_player')
  assert.equal(player.box.hidden, false, '100ceng playerShow uses Show(1) to reveal')
  host.rootApi.Show(0, 'w_name_player')
  assert.equal(player.box.hidden, true, 'Show(0) hides it again')

  // Paopao2 keeps its legacy 0=show/1=hide contract (the bubble tests rely on it).
  const pao = paopaoHostFixture()
  pao.play()
  await pao.settle()
  const previous = pao.players.length
  pao.createWindow('b1', 'BubbleGreen.swf', 316, 580, 70, 70, { show: false })
  await pao.settle()
  const bubble = pao.state().wins.get('b1')
  pao.rootApi.Show(1, 'b1')
  assert.equal(bubble.box.hidden, true)
  pao.rootApi.Show(0, 'b1')
  assert.equal(bubble.box.hidden, false)
  assert.equal(pao.players.length, previous + 1)
})

test('100ceng gets a hold-to-move touch pad that sends arrow keys into its iframe', async () => {
  const host = paopaoHostFixture()
  host.setNativeGameKey(false)
  host.play(CENG)
  await host.settle()
  const pad = host.state().keypad
  assert.ok(pad, 'touch 100ceng must get a D-pad')
  const player = host.players[0]
  const press = { preventDefault: () => {}, stopPropagation: () => {} }

  // 100ceng's stage listener is inside cloud_*.swf, so visible child windows must receive keys;
  // the hidden player_*.swf window must not.
  host.createWindow('w_name_cloud', 'cloud_boy.swf', 105, 310, 350, 500)
  host.createWindow('w_name_player', 'player_boy.swf', 316, 580, 140, 140, { hidden: true, show: false })
  await host.settle()
  const cloud = host.players[1]
  const hiddenPlayer = host.players[2]
  const rootDoc = host.frames[0].contentDocument
  const cloudDoc = host.frames[1].contentDocument
  const hiddenDoc = host.frames[2].contentDocument

  pad.left.handlers.pointerdown[0](press)
  await host.settle()
  assert.deepEqual(player.events.at(-1), { type: 'keydown', key: 'ArrowLeft', keyCode: 37 })
  assert.deepEqual(cloud.events.at(-1), { type: 'keydown', key: 'ArrowLeft', keyCode: 37 }, 'cloud player receives the key')
  assert.ok(cloud.events.some((event) => event.type === 'pointerdown'), 'the first key also clicks the cloud start frame')
  assert.equal(host.frames[1].focused, true, 'cloud iframe is focused before the event')
  const cloudKeydown = cloudDoc.events.at(-1)
  assert.equal(cloudKeydown.type, 'keydown')
  assert.equal(cloudKeydown.key, 'ArrowLeft')
  assert.equal(cloudKeydown.keyCode, 37)
  assert.equal(cloudKeydown.which, 37)
  assert.equal(cloudKeydown.bubbles, true, 'the iframe document receives a real bubbling KeyboardEvent')
  assert.equal(rootDoc.events.at(-1).type, 'keydown')
  assert.equal(hiddenDoc.events.length, 0, 'hidden windows are not keyboard targets')
  assert.equal(hiddenPlayer.events.length, 0, 'hidden windows are not keyboard targets')
  assert.equal(host.intervals.length, 1, 'holding starts a repeat timer')
  host.intervals[0]()
  await host.settle()
  assert.equal(player.events.filter((event) => event.type === 'keydown' && event.keyCode === 37).length, 2)
  pad.left.handlers.pointerup[0]()
  assert.deepEqual(player.events.at(-1), { type: 'keyup', key: 'ArrowLeft', keyCode: 37 })
  assert.deepEqual(cloud.events.at(-1), { type: 'keyup', key: 'ArrowLeft', keyCode: 37 })
  assert.equal(cloudDoc.events.at(-1).type, 'keyup')
  assert.equal(cloudDoc.events.at(-1).keyCode, 37)

  // CDP sends mousePressed; WebView may emit mousedown without a pointerdown.
  pad.left.handlers.mousedown[0]({ button: 0, preventDefault: () => {}, stopPropagation: () => {} })
  await host.settle()
  assert.deepEqual(player.events.at(-1), { type: 'keydown', key: 'ArrowLeft', keyCode: 37 })
  pad.left.handlers.mouseup[0]()
  assert.deepEqual(player.events.at(-1), { type: 'keyup', key: 'ArrowLeft', keyCode: 37 })

  pad.right.handlers.pointerdown[0](press)
  await host.settle()
  assert.deepEqual(player.events.at(-1), { type: 'keydown', key: 'ArrowRight', keyCode: 39 })
  pad.right.handlers.pointerleave[0]()
  assert.deepEqual(player.events.at(-1), { type: 'keyup', key: 'ArrowRight', keyCode: 39 })

  host.rootApi.DestroyWindow()
  assert.equal(host.state().keypad, null, 'the pad disappears with the game')
})

test('native game keys replace the DOM fallback and are released when the game ends', async () => {
  const host = paopaoHostFixture()
  host.setNativeGameKey(true)
  host.play(CENG)
  await host.settle()
  const pad = host.state().keypad
  const player = host.players[0]
  const press = { preventDefault: () => {}, stopPropagation: () => {} }

  pad.left.handlers.pointerdown[0](press)
  await host.settle()
  assert.deepEqual(host.nativeGameKeys, [['ArrowLeft', 'down']])
  assert.equal(player.events.filter((event) => event.type === 'keydown').length, 0, 'native path does not also send DOM keys')

  host.intervals[0]()
  await host.settle()
  assert.deepEqual(host.nativeGameKeys.at(-1), ['ArrowLeft', 'down'], 'holding repeats the native down')
  assert.equal(player.events.filter((event) => event.type === 'keydown').length, 0)

  pad.left.handlers.pointerup[0]()
  await host.settle()
  assert.deepEqual(host.nativeGameKeys.at(-1), ['ArrowLeft', 'up'])

  pad.right.handlers.pointerdown[0](press)
  await host.settle()
  assert.deepEqual(host.nativeGameKeys.at(-1), ['ArrowRight', 'down'])
  host.rootApi.DestroyWindow()
  await host.settle()
  assert.deepEqual(host.nativeGameKeys.at(-1), ['ArrowRight', 'up'], 'finish releases every held native key')
  assert.equal(host.state().keypad, null)
  assert.deepEqual(host.nativeGameActive, [true, false], 'native gate opens on open and closes on finish')
})

test('no native keys are sent before a game (or for a game without keyboard)', async () => {
  const host = paopaoHostFixture()
  host.setNativeGameKey(true)
  host.play(GUESS)
  await host.settle()
  assert.equal(host.state().keypad, null, 'guess has no D-pad')
  assert.deepEqual(host.nativeGameKeys, [])
  assert.deepEqual(host.nativeGameActive, [false], 'no keyboard game keeps the native gate closed')
})

test('the direct native bridge can focus/start the cloud before injecting keys', async () => {
  const host = paopaoHostFixture()
  host.setNativeGameKey(true)
  host.play(CENG)
  await host.settle()
  host.createWindow('w_name_cloud', 'cloud_boy.swf', 105, 310, 350, 500)
  await host.settle()
  const cloud = host.players[1]
  const prepare = host.context.window.__qqpetSmallGameKeyPrepare
  assert.equal(typeof prepare, 'function')
  prepare()
  assert.equal(host.frames[1].focused, true, 'prepare focuses the cloud iframe')
  assert.ok(cloud.events.some((event) => event.type === 'pointerdown'), 'prepare clicks the cloud start frame')
  const debug = host.context.window.__qqpetSmallGameKeys
  assert.equal(debug.active, true)
  assert.ok(debug.cloudFocus >= 1)
  assert.ok(debug.cloudClicks >= 1)

  const before = cloud.events.length
  host.rootApi.DestroyWindow()
  prepare()
  assert.equal(cloud.events.length, before, 'prepare is a no-op after the game ends')
  assert.equal(host.context.window.__qqpetSmallGameKeys.active, false)
  assert.deepEqual(host.nativeGameActive.at(-1), false)
})

test('the touch pad only appears for keyboard games on touch hosts', async () => {
  const guess = paopaoHostFixture()
  guess.play(GUESS)
  await guess.settle()
  assert.equal(guess.state().keypad, null, 'guess needs no keyboard')

  const desktop = paopaoHostFixture({ touchHost: false })
  desktop.play(CENG)
  await desktop.settle()
  assert.equal(desktop.state().keypad, null, 'desktop keeps keyboard input to the real keyboard')
})

test('desktop hosts keep the old lifecycle: no pooling and a fresh iframe/player per game', async () => {
  const host = paopaoHostFixture({ touchHost: false })
  host.play()
  await host.settle()
  host.rootApi.DestroyWindow()
  assert.equal(host.state().pools.size, 0, 'desktop must not pool shells')
  assert.equal(host.state().shells.size, 0)

  host.play()
  await host.settle()
  assert.equal(host.frames.length, 2)
  assert.equal(host.players.length, 2)
})
