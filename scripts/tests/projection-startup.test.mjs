import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const petSource = readFileSync(new URL('../../src/renderer/pet/pet.ts', import.meta.url), 'utf8')

function startup({ health = 5, growth = 1, buried = false, first = false } = {}) {
  const start = petSource.indexOf('let projectionStarted')
  const end = petSource.indexOf('let growthTimer')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const block = petSource.slice(start, end)
  const plays = []
  const speaks = []
  let dailyCalls = 0
  const timers = []
  const context = vm.createContext({
    save: { isBury: buried, settings: { hidden: false } },
    info: { health, growth },
    machine: { play: (pose) => plays.push(pose) },
    speak: (say, action) => speaks.push({ say, action }),
    refreshTray: () => {},
    setTray: () => {},
    greeting: () => ({ tolk: '早上好', submitText: '好呀' }),
    DEAD: { tolk: '不要死' },
    daily: () => { dailyCalls += 1 },
    announceStartupMail: () => {},
    setInterval: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    window: {},
    Math: { random: () => 0.9 },
  })
  const script = stripTypeScriptTypes(block).replace('export function startProjectionPet', 'function startProjectionPet')
  vm.runInContext(script + '\nthis.startProjectionPet = startProjectionPet', context)
  return { context, plays, speaks, timers, dailyCalls: () => dailyCalls, first }
}

test('projection startup plays entrance once, then starts daily presentation', () => {
  const app = startup()
  app.context.startProjectionPet()
  assert.equal(app.plays.length, 1)
  assert.equal(app.plays[0].a, 'enter')
  assert.equal(app.dailyCalls(), 0, 'daily starts only after the entrance callback')
  app.plays[0].s()
  assert.equal(app.dailyCalls(), 1)
  assert.equal(app.speaks.length, 1)
  assert.equal(app.speaks[0].say.c, 'enter')
  app.context.startProjectionPet()
  assert.equal(app.plays.length, 1, 'startup is one-shot')
  assert.equal(app.timers.length, 1)
})

test('adoption startup uses the First clip and dead pets get a bubble only', () => {
  const adopted = startup({ first: true })
  adopted.context.startProjectionPet(true)
  assert.equal(adopted.plays[0].a, 'first')
  const dead = startup({ health: 0 })
  dead.context.startProjectionPet()
  assert.equal(dead.plays.length, 0)
  assert.equal(dead.speaks.length, 1)
  assert.equal(dead.dailyCalls(), 0)
})

test('projection startup block never calls legacy canonical mutation or growth paths', () => {
  const start = petSource.indexOf('let projectionStarted')
  const end = petSource.indexOf('let growthTimer')
  const block = petSource.slice(start, end)
  for (const call of ['setInfo(', 'update(', 'addInfo(', 'tick(', 'grow(', 'startGrowth(', 'startPet(', 'rollDaily(', 'deliverMails(', 'writeMails(']) {
    assert.equal(block.includes(call), false, `startup must not call ${call}`)
  }
})
