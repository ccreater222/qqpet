import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')

function strippedSource(relativePath) {
  return stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export \{.*\}$/gm, '')
    .replace(/^export /gm, '')
}

function loadConverted(relativePath, scope, expose) {
  const context = { ...scope }
  runInNewContext(strippedSource(relativePath) + '\nthis.__converted = { ' + expose + ' }', context)
  return context.__converted
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('Group E game/diudiule intents map to exact typed command payloads', () => {
  assert.deepEqual(uiCommands.gameStart('guess/main.swf', 'flash'), {
    type: 'game.startSession',
    payload: { gameId: 'guess/main.swf', kind: 'flash' },
  })
  assert.deepEqual(uiCommands.gameStart('guess', 'small'), {
    type: 'game.startSession',
    payload: { gameId: 'guess', kind: 'small' },
  })
  assert.deepEqual(uiCommands.gameReward('token-1'), { type: 'game.reward', payload: { sessionToken: 'token-1' } })
  assert.deepEqual(uiCommands.gameAbandon('token-1'), { type: 'game.abandonSession', payload: { sessionToken: 'token-1' } })
  assert.deepEqual(uiCommands.diudiuleStart(), { type: 'diudiule.startSession', payload: {} })
  assert.deepEqual(uiCommands.diudiuleReward('token-2'), { type: 'diudiule.reward', payload: { sessionToken: 'token-2' } })
})

test('runtime flash games start a session before opening and settle it when the window closes', async () => {
  const opened = []
  const dispatches = []
  let gamePlayed = null
  const games = loadConverted('../../src/renderer/ui/games.ts', {
    runtimeProjectionMode: true,
    window: {
      qqpet: {
        onGamePlayed: (listener) => { gamePlayed = listener },
        openGame: (gameId) => opened.push(gameId),
      },
    },
    GAMES: [],
    SMALL_GAMES: [],
    playDiudiule: () => {},
    playSmallGame: () => {},
    openBox: () => () => {},
    div: () => ({}),
    button: () => ({}),
    img: () => ({}),
    addCount: () => {},
    count: () => 0,
    earnYb: () => 0,
    growthPerMinute: () => 0,
    info: { mood: 100 },
    save: { petComputedlInfo: { moodMax: 1000 } },
    setInfo: () => {},
    speak: () => {},
    floatMood: () => {},
    uiCommands: {
      gameStart: (gameId, kind) => ({ type: 'game.startSession', payload: { gameId, kind } }),
      gameReward: (sessionToken) => ({ type: 'game.reward', payload: { sessionToken } }),
    },
    dispatchRuntimeCommand: (command) => {
      dispatches.push(command)
      return Promise.resolve(command.type === 'game.startSession'
        ? { status: 'applied', result: { sessionToken: 'flash-1' } }
        : { status: 'applied', result: { minutes: 5, yb: 25, mood: 10 } })
    },
    commandResultData: (result) => (result && result.result ? result.result : null),
  }, 'startFlashGame')
  await games.startFlashGame('guess/main.swf')
  assert.deepEqual(dispatches, [{ type: 'game.startSession', payload: { gameId: 'guess/main.swf', kind: 'flash' } }])
  assert.deepEqual(opened, ['guess/main.swf'])
  gamePlayed(5)
  await flush()
  assert.deepEqual(dispatches[1], { type: 'game.reward', payload: { sessionToken: 'flash-1' } })
})

test('runtime diudiule starts a session, rewards on land and abandons on quit', async () => {
  const dispatches = []
  const frames = []
  const appends = []
  let desk = ''
  let sessionSeq = 0
  const fakeQuit = { dataset: {}, addEventListener: () => {}, remove: () => {} }
  const diudiule = loadConverted('../../src/renderer/ui/diudiule.ts', {
    runtimeProjectionMode: true,
    stage: () => 'Kid',
    busy: () => false,
    info: { health: 5, mood: 100, lastX: 0, lastY: 0 },
    save: { petComputedlInfo: { moodMax: 1000 } },
    petSize: () => 100,
    playingDesk: () => desk,
    setDeskGame: (value) => { desk = value },
    setTray: () => {},
    refreshTray: () => {},
    setInfo: () => {},
    earnYb: () => 0,
    addCount: () => {},
    machine: { play: (pose) => frames.push(pose) },
    speak: () => {},
    floatMood: () => {},
    document: { getElementById: () => ({ append: (node) => appends.push(node) }) },
    button: () => fakeQuit,
    innerWidth: 1000,
    innerHeight: 800,
    uiCommands: {
      diudiuleStart: () => ({ type: 'diudiule.startSession', payload: {} }),
      diudiuleReward: (sessionToken) => ({ type: 'diudiule.reward', payload: { sessionToken } }),
      gameAbandon: (sessionToken) => ({ type: 'game.abandonSession', payload: { sessionToken } }),
    },
    dispatchRuntimeCommand: (command) => {
      dispatches.push(command)
      if (command.type === 'diudiule.startSession') return Promise.resolve({ status: 'applied', result: { sessionToken: 'dd-' + (++sessionSeq) } })
      if (command.type === 'diudiule.reward') return Promise.resolve({ status: 'applied', result: { mood: 55, yb: 1 } })
      return Promise.resolve({ status: 'applied', result: { sessionToken: 'dd-1', status: 'abandoned' } })
    },
    commandResultData: (result) => (result && result.result ? result.result : null),
  }, 'playDiudiule, stopDiudiule, land')
  diudiule.playDiudiule()
  await flush()
  assert.deepEqual(dispatches[0], { type: 'diudiule.startSession', payload: {} })
  assert.equal(desk, 'diudiule')
  assert.equal(appends.length, 1)
  diudiule.land(true)
  await flush()
  assert.deepEqual(dispatches[1], { type: 'diudiule.reward', payload: { sessionToken: 'dd-1' } })
  // The session already settled on land, so quitting is local-only.
  diudiule.stopDiudiule()
  await flush()
  assert.equal(dispatches.length, 2)
  diudiule.playDiudiule()
  await flush()
  assert.deepEqual(dispatches[2], { type: 'diudiule.startSession', payload: {} })
  diudiule.stopDiudiule()
  await flush()
  assert.deepEqual(dispatches[3], { type: 'game.abandonSession', payload: { sessionToken: 'dd-2' } })
})

test('runtime small games start a session and settle it exactly once when the window closes', async () => {
  const dispatches = []
  const appends = []
  let desk = ''
  const fakeFrame = { style: {}, classList: { toggle: () => {}, add: () => {}, remove: () => {} }, addEventListener: () => {}, contentWindow: {}, contentDocument: { body: {} } }
  const fakeBox = () => ({ className: '', dataset: {}, style: {}, classList: { toggle: () => {}, add: () => {}, remove: () => {} }, append: (node) => appends.push(node), hidden: false })
  const fakePet = {
    hidden: false,
    append: (node) => appends.push(node),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  }
  const smallgame = loadConverted('../../src/renderer/ui/smallgame.ts', {
    runtimeProjectionMode: true,
    stage: () => 'Kid',
    busy: () => false,
    info: { mood: 100, sex: 'GG', lastX: 0, lastY: 0 },
    save: { petComputedlInfo: { moodMax: 1000 } },
    playingDesk: () => desk,
    setDeskGame: (value) => { desk = value },
    setTray: () => {},
    refreshTray: () => {},
    setInfo: () => {},
    earnYb: () => 0,
    addCount: () => {},
    speak: () => {},
    floatMood: () => {},
    document: {
      getElementById: () => fakePet,
      createElement: () => fakeFrame,
      body: { append: (node) => appends.push(node) },
    },
    window: { qqpet: { setFocusable: () => {} } },
    button: () => ({ dataset: {}, addEventListener: () => {} }),
    div: () => fakeBox(),
    SwfPlayer: class { load() {} },
    uiCommands: {
      gameStart: (gameId, kind) => ({ type: 'game.startSession', payload: { gameId, kind } }),
      gameReward: (sessionToken) => ({ type: 'game.reward', payload: { sessionToken } }),
    },
    dispatchRuntimeCommand: (command) => {
      dispatches.push(command)
      return Promise.resolve(command.type === 'game.startSession'
        ? { status: 'applied', result: { sessionToken: 'small-1' } }
        : { status: 'applied', result: { minutes: 3, yb: 15, mood: 6 } })
    },
    commandResultData: (result) => (result && result.result ? result.result : null),
  }, 'playSmallGame, finish')
  smallgame.playSmallGame({ dir: 'guess', name: '猜动作' })
  await flush()
  assert.deepEqual(dispatches[0], { type: 'game.startSession', payload: { gameId: 'guess', kind: 'small' } })
  assert.equal(desk, 'guess')
  smallgame.finish()
  await flush()
  assert.deepEqual(dispatches[1], { type: 'game.reward', payload: { sessionToken: 'small-1' } })
  assert.equal(dispatches.length, 2)
})

test('converted Group E panels keep their runtime branches and legacy fallbacks', () => {
  const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
  const games = read('src/renderer/ui/games.ts')
  const diudiule = read('src/renderer/ui/diudiule.ts')
  const smallgame = read('src/renderer/ui/smallgame.ts')
  for (const source of [games, diudiule, smallgame]) {
    assert.match(source, /runtimeProjectionMode/)
    assert.match(source, /dispatchRuntimeCommand/)
    assert.match(source, /commandResultData/)
  }
  assert.match(games, /uiCommands\.gameReward/)
  assert.match(diudiule, /uiCommands\.diudiuleReward/)
  assert.match(diudiule, /uiCommands\.gameAbandon/)
  assert.match(smallgame, /uiCommands\.gameReward/)
  assert.match(smallgame, /function openSmallGame/)
  assert.match(smallgame, /function startRuntimeSmallGame/)
})

test('runtime navigation exposes converted panels and keeps unconverted E-F entries hidden', () => {
  const control = readFileSync(new URL('../../src/renderer/ui/control.ts', import.meta.url), 'utf8')
  assert.match(control, /visibleMenu/)
  assert.match(control, /child\.name === '池塘' \|\| child\.name === '游戏'/)
  assert.match(control, /runtimeProjectionMode/)
  const main = readFileSync(new URL('../../src/renderer/main.ts', import.meta.url), 'utf8')
  assert.match(main, /if \(save\.settings\.petBar\) showControl\(\)/)
  const menu = readFileSync(new URL('../../src/renderer/ui/runtime-menu.ts', import.meta.url), 'utf8')
  assert.match(menu, /openFishing/)
  assert.match(menu, /openGames/)
  assert.doesNotMatch(menu, /openFarm|openIsland|openCommunity|openMstx|visitFriend|sendLetter/)
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('flash game starts are single-flight and only a started session settles', async () => {
  const opened = []
  const dispatches = []
  const first = deferred()
  let gamePlayed = null
  const games = loadConverted('../../src/renderer/ui/games.ts', {
    runtimeProjectionMode: true,
    window: { qqpet: { onGamePlayed: (listener) => { gamePlayed = listener }, openGame: (id) => opened.push(id) } },
    GAMES: [],
    SMALL_GAMES: [],
    playDiudiule: () => {},
    playSmallGame: () => {},
    openBox: () => () => {},
    div: () => ({}),
    button: () => ({}),
    img: () => ({}),
    addCount: () => {},
    count: () => 0,
    earnYb: () => 0,
    growthPerMinute: () => 0,
    info: { mood: 100 },
    save: { petComputedlInfo: { moodMax: 1000 } },
    setInfo: () => {},
    speak: () => {},
    floatMood: () => {},
    uiCommands: {
      gameStart: (gameId, kind) => ({ type: 'game.startSession', payload: { gameId, kind } }),
      gameReward: (sessionToken) => ({ type: 'game.reward', payload: { sessionToken } }),
    },
    dispatchRuntimeCommand: (command) => { dispatches.push(command); return first.promise },
    commandResultData: (result) => (result && result.result ? result.result : null),
  }, 'startFlashGame')
  const starting = games.startFlashGame('guess/main.swf')
  games.startFlashGame('guess/main.swf')
  assert.equal(dispatches.length, 1, 'the second click must not start a second session')
  assert.deepEqual(opened, [])
  // A gamePlayed before the session token exists must not settle anything.
  gamePlayed(5)
  await flush()
  assert.equal(dispatches.length, 1)
  first.resolve({ status: 'applied', result: { sessionToken: 'flash-1' } })
  await starting
  assert.deepEqual(opened, ['guess/main.swf'])
  gamePlayed(5)
  await flush()
  assert.deepEqual(dispatches[1], { type: 'game.reward', payload: { sessionToken: 'flash-1' } })
})

test('diudiule quit during session start abandons the returned token instead of opening', async () => {
  const dispatches = []
  const first = deferred()
  const appends = []
  let desk = ''
  const diudiule = loadConverted('../../src/renderer/ui/diudiule.ts', {
    runtimeProjectionMode: true,
    stage: () => 'Kid',
    busy: () => false,
    info: { health: 5, mood: 100, lastX: 0, lastY: 0 },
    save: { petComputedlInfo: { moodMax: 1000 } },
    petSize: () => 100,
    playingDesk: () => desk,
    setDeskGame: (value) => { desk = value },
    setTray: () => {},
    refreshTray: () => {},
    setInfo: () => {},
    earnYb: () => 0,
    addCount: () => {},
    machine: { play: () => {} },
    speak: () => {},
    floatMood: () => {},
    document: { getElementById: () => ({ append: (node) => appends.push(node) }) },
    button: () => ({ dataset: {}, addEventListener: () => {}, remove: () => {} }),
    innerWidth: 1000,
    innerHeight: 800,
    uiCommands: {
      diudiuleStart: () => ({ type: 'diudiule.startSession', payload: {} }),
      diudiuleReward: (sessionToken) => ({ type: 'diudiule.reward', payload: { sessionToken } }),
      gameAbandon: (sessionToken) => ({ type: 'game.abandonSession', payload: { sessionToken } }),
    },
    dispatchRuntimeCommand: (command) => { dispatches.push(command); return first.promise },
    commandResultData: (result) => (result && result.result ? result.result : null),
  }, 'playDiudiule, stopDiudiule')
  diudiule.playDiudiule()
  diudiule.stopDiudiule()
  first.resolve({ status: 'applied', result: { sessionToken: 'dd-late' } })
  await flush()
  assert.deepEqual(dispatches, [
    { type: 'diudiule.startSession', payload: {} },
    { type: 'game.abandonSession', payload: { sessionToken: 'dd-late' } },
  ])
  assert.equal(desk, '')
  assert.deepEqual(appends, [])
})

test('small game starts are single-flight while the session command is pending', async () => {
  const dispatches = []
  const first = deferred()
  const smallgame = loadConverted('../../src/renderer/ui/smallgame.ts', {
    runtimeProjectionMode: true,
    stage: () => 'Kid',
    busy: () => false,
    info: { mood: 100, sex: 'GG', lastX: 0, lastY: 0 },
    save: { petComputedlInfo: { moodMax: 1000 } },
    playingDesk: () => '',
    setDeskGame: () => {},
    setTray: () => {},
    refreshTray: () => {},
    setInfo: () => {},
    earnYb: () => 0,
    addCount: () => {},
    speak: () => {},
    floatMood: () => {},
    document: { getElementById: () => ({ hidden: false, append: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }) },
    window: { qqpet: { setFocusable: () => {} } },
    uiCommands: { gameStart: (gameId, kind) => ({ type: 'game.startSession', payload: { gameId, kind } }) },
    dispatchRuntimeCommand: (command) => { dispatches.push(command); return first.promise },
    commandResultData: (result) => (result && result.result ? result.result : null),
  }, 'playSmallGame')
  smallgame.playSmallGame({ dir: 'guess', name: '猜动作' })
  smallgame.playSmallGame({ dir: 'guess', name: '猜动作' })
  assert.equal(dispatches.length, 1)
  first.resolve({ status: 'rejected', error: { code: 'busy', message: 'busy', refreshProjection: false } })
  await flush()
  assert.equal(dispatches.length, 1, 'a rejected start does not open a window')
})
