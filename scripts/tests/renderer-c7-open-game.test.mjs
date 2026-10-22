import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { IPC } from '../../src/shared/ipc.ts'
import { forwardGamePlayed, forwardOpenGame, normalizeGamePlayed } from '../../src/mobile/game-played.ts'
import { gameRewards } from '../../src/ios/game-rewards.ts'
import { openGameRequest } from '../../src/ios/game-open.ts'

function strippedSource(relativePath) {
  return stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
}

test('desktop preload forwards both openGame arguments and the played correlation id', () => {
  const sends = []
  const handlers = new Map()
  const context = {
    contextBridge: {
      exposeInMainWorld(_name, value) { context.exposed = value },
    },
    ipcRenderer: {
      send(...args) { sends.push(args) },
      invoke: async () => null,
      on(channel, listener) { handlers.set(channel, listener) },
      removeAllListeners() {},
    },
    IPC,
    createRendererRuntimePreload: () => ({}),
    process: { platform: 'linux' },
  }
  runInNewContext(strippedSource('../../src/preload/index.ts') + '\nthis.__api = api', context)
  const api = context.exposed
  assert.ok(api)

  api.openGame('guess/main.swf', 7)
  assert.deepEqual(sends.at(-1), [IPC.openGame, 'guess/main.swf', 7])

  let played = null
  api.onGamePlayed((minutes, windowId) => { played = [minutes, windowId] })
  handlers.get(IPC.gamePlayed)({}, 5, 9)
  assert.deepEqual(played, [5, 9])
})

test('mobile game-play bridge keeps correlation ids and backward-compatible minutes', () => {
  assert.deepEqual(normalizeGamePlayed({ minutes: 2.5, windowId: 6 }), { minutes: 2.5, windowId: 6 })
  assert.deepEqual(normalizeGamePlayed(3), { minutes: 3, windowId: -1 })
  assert.equal(normalizeGamePlayed({ minutes: 'x', windowId: 6 }), null)

  const hostCalls = []
  const host = { openGame(swf, windowId) { hostCalls.push([swf, windowId]) } }
  forwardOpenGame(host, 'guess/main.swf', 7)
  forwardOpenGame(host, 'legacy.swf')
  assert.deepEqual(hostCalls, [['guess/main.swf', 7], ['legacy.swf', -1]])
  let forwarded = null
  forwardGamePlayed((minutes, windowId) => { forwarded = [minutes, windowId] }, { minutes: 2.5, windowId: 7 })
  assert.deepEqual(forwarded, [2.5, 7])
  assert.deepEqual(openGameRequest('guess/main.swf', 7, 'generation-1'), {
    swf: 'guess/main.swf', windowId: 7, generation: 'generation-1',
  })
  assert.equal(openGameRequest('legacy.swf', undefined, 'generation-1').windowId, -1)

  for (const relative of ['src/android/bridge.ts', 'src/harmony/bridge.ts']) {
    const source = readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
    assert.match(source, /openGame: \(swf, windowId\) => forwardOpenGame\(native, swf, windowId\)/)
    assert.match(source, /forwardGamePlayed\(l, payload\)/)
  }

  const iosBridge = readFileSync(new URL('../../src/ios/bridge.ts', import.meta.url), 'utf8')
  assert.match(iosBridge, /rpc\.request\('openGame', openGameRequest\(swf, windowId, persistence\.generation\)\)/)
  assert.match(iosBridge, /onGamePlayed: \(listener\) => listen\('gamePlayed', \(played\) => listener\(played\.minutes, played\.windowId\)\)/)

  const androidService = readFileSync(new URL('../../android/app/src/main/java/net/ankio/qqpet/PetService.kt', import.meta.url), 'utf8')
  const androidGame = readFileSync(new URL('../../android/app/src/main/java/net/ankio/qqpet/GameActivity.kt', import.meta.url), 'utf8')
  assert.match(androidService, /fun openGame\(swf: String, windowId: Int\)/)
  assert.match(androidService, /putExtra\("windowId", windowId\)/)
  assert.match(androidGame, /getIntExtra\("windowId", -1\)/)
  assert.match(androidGame, /put\("windowId", windowId\)/)

  const harmonyNative = readFileSync(new URL('../../harmony/entry/src/main/ets/pet/Native.ets', import.meta.url), 'utf8')
  const harmonyGame = readFileSync(new URL('../../harmony/entry/src/main/ets/gameability/GameAbility.ets', import.meta.url), 'utf8')
  assert.match(harmonyNative, /openGame\(swf: string, windowId\?: number\)/)
  assert.match(harmonyGame, /JSON\.stringify\(\{ minutes: minutes, windowId: this\.windowId \}\)/)

  const iosManager = readFileSync(new URL('../../ios/native/QPManagerController.m', import.meta.url), 'utf8')
  assert.match(iosManager, /@"windowId":windowId/)
})

test('iOS reward parser carries windowId while keeping legacy events valid', async () => {
  const played = []
  const accept = gameRewards(async () => {}, () => 'generation-1', (minutes, windowId) => {
    played.push([minutes, windowId])
  })
  await accept({ sessionId: 'session-1', generation: 'generation-1', minutes: 2, windowId: 11 })
  await accept({ sessionId: 'session-2', generation: 'generation-1', minutes: 3 })
  assert.deepEqual(played, [[2, 11], [3, -1]])
})
