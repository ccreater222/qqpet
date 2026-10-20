import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = stripTypeScriptTypes(readFileSync(new URL('../../src/renderer/ui/adopt.ts', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')

function fixture(options = {}) {
  const host = { isConnected: true }, tasks = [], writes = []
  const save = { havePet: false }
  const projectionListeners = []
  let inFlash = false, started = 0, close
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  const scope = {
    window: options.command === undefined ? {} : { qqpet: { command: options.command } },
    div: () => host, button: () => ({}), windowView() {},
    SwfPlayer: class { load() { return Promise.resolve() } },
    setInfo: (key, value) => writes.push([key, value]),
    update: (key, value) => writes.push([key, value]),
    save,
    onProjectionApplied(listener) {
      projectionListeners.push(listener)
      return () => {
        const index = projectionListeners.indexOf(listener)
        if (index >= 0) projectionListeners.splice(index, 1)
      }
    },
    setTimeout: callback => tasks.push(callback),
    clearTimeout() {},
    openBox(_host, options) {
      close = () => {
        assert.equal(inFlash, false, 'the calling Flash instance must not destroy itself')
        host.isConnected = false
        options.onClose()
      }
      return close
    },
  }
  runInNewContext(source + '\nthis.adopt = adopt; this.adoptProjection = adoptProjection', scope)
  const done = () => { assert.equal(inFlash, false); started++ }
  if (options.projection === true) scope.adoptProjection(done)
  else scope.adopt(done)
  return {
    writes, host,
    choose(value) { inFlash = true; try { scope.window.ChooseAPI.ChooseSex(value) } finally { inFlash = false } },
    async finish() {
      for (const task of tasks.splice(0)) task()
      await settle()
    },
    settle,
    applyProjection() {
      save.havePet = true
      for (const listener of projectionListeners.splice(0)) listener()
    },
    close() { close() },
    started: () => started,
  }
}

test('adoption leaves the Flash call before disposing its player and starting the pet', () => {
  const f = fixture()
  f.choose(0)
  assert.equal(f.host.isConnected, true)
  assert.equal(f.started(), 0)
  f.finish()
  assert.equal(f.host.isConnected, false)
  assert.deepEqual(f.writes, [['sex', 'GG'], ['havePet', true]])
  assert.equal(f.started(), 1)
})

test('repeated Flash callbacks commit only the first choice', () => {
  const f = fixture()
  f.choose(1)
  f.choose(0)
  f.finish()
  assert.deepEqual(f.writes, [['sex', 'MM'], ['havePet', true]])
  assert.equal(f.started(), 1)
})

test('closing the adoption window cancels a queued choice', () => {
  const f = fixture()
  f.choose(0)
  f.close()
  f.finish()
  assert.deepEqual(f.writes, [])
  assert.equal(f.started(), 0)
})

test('runtime adoption commits through pet.adopt and starts presentation without legacy writes', async () => {
  const commands = []
  const f = fixture({
    projection: true,
    async command(command) {
      commands.push(command)
      return { status: 'applied' }
    },
  })
  f.choose(0)
  await f.finish()
  assert.equal(commands.length, 1)
  assert.equal(commands[0].type, 'pet.adopt')
  assert.equal(commands[0].payload.sex, 'GG')
  assert.deepEqual(f.writes, [])
  assert.equal(f.started(), 0, 'presentation waits for the adopted projection')
  f.applyProjection()
  await f.settle()
  assert.equal(f.started(), 1)
})

test('runtime adoption rejection does not start the legacy or presentation clock', async () => {
  const f = fixture({
    projection: true,
    async command() {
      return { status: 'rejected', error: { code: 'invalid_payload', message: 'nope', refreshProjection: true } }
    },
  })
  f.choose(1)
  await f.finish()
  assert.deepEqual(f.writes, [])
  assert.equal(f.started(), 0)
})

test('a delayed command result cannot start presentation before the adopted projection', async () => {
  let resolveCommand
  const commandPromise = new Promise((resolve) => { resolveCommand = resolve })
  const f = fixture({
    projection: true,
    command: () => commandPromise,
  })
  f.choose(0)
  await f.finish()
  f.applyProjection()
  assert.equal(f.started(), 0, 'projection alone cannot complete an unresolved adoption command')
  resolveCommand({ status: 'applied' })
  await f.settle()
  assert.equal(f.started(), 1)
})
