import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts')
    }
    return nextResolve(specifier)
  },
  // Node ESM needs an import attribute for JSON; the renderer's Vite build does
  // not. The harness supplies the attribute-equivalent loader for source imports.
  load(url, context, nextLoad) {
    if (typeof url === 'string' && url.endsWith('.json')) {
      return { format: 'json', shortCircuit: true, source: readFileSync(new URL(url), 'utf8') }
    }
    return nextLoad(url, context)
  },
})

const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')
const {
  commandResultData,
  commandResultGoods,
  commandSucceeded,
  dispatchRuntimeCommand,
  runtimeCommandMode,
} = await import('../../src/renderer/pet/runtime-command.ts')
const { allGoods } = await import('../../src/renderer/pet/data/goods.ts')

function fullResult(overrides = {}) {
  return {
    status: 'applied',
    commandType: 'pet.cheer',
    opId: 'op-c6b',
    commandSeq: 1,
    revision: 1,
    eventSeq: 0,
    ...overrides,
  }
}

test('Group A–D UI intents map to exact typed command payloads', () => {
  // A: lifecycle/core
  assert.deepEqual(uiCommands.adopt('GG'), { type: 'pet.adopt', payload: { sex: 'GG' } })
  assert.deepEqual(uiCommands.reset(), { type: 'pet.reset', payload: {} })
  assert.deepEqual(uiCommands.bury(), { type: 'pet.bury', payload: {} })
  assert.deepEqual(uiCommands.rename({ name: '小企鹅' }), { type: 'pet.rename', payload: { name: '小企鹅' } })
  assert.deepEqual(uiCommands.setPaused(true), { type: 'pet.setPaused', payload: { paused: true } })
  assert.deepEqual(uiCommands.pokeFace('face-1'), { type: 'pet.pokeFace', payload: { spotId: 'face-1' } })
  assert.deepEqual(uiCommands.cheer(), { type: 'pet.cheer', payload: {} })

  // B: inventory/economy/VIP
  assert.deepEqual(uiCommands.buy('food', '1001', 2), { type: 'inventory.buy', payload: { type: 'food', itemId: '1001', quantity: 2 } })
  assert.deepEqual(uiCommands.use('clean', '2001'), { type: 'inventory.use', payload: { type: 'clean', itemId: '2001' } })
  assert.deepEqual(uiCommands.treatDoctor(), { type: 'medical.treat', payload: { mode: 'doctor' } })
  assert.deepEqual(uiCommands.treatOwned('3001'), { type: 'medical.treat', payload: { mode: 'owned', itemId: '3001' } })
  assert.deepEqual(uiCommands.buyPinkDiamond(30), { type: 'vip.buyPinkDiamond', payload: { days: 30 } })
  assert.deepEqual(uiCommands.clearPinkDiamond(), { type: 'vip.clearPinkDiamond', payload: {} })
  assert.deepEqual(uiCommands.buySweetheart(7), { type: 'vip.buySweetheart', payload: { days: 7 } })
  assert.deepEqual(uiCommands.setSweetheart(false), { type: 'vip.setSweetheart', payload: { enabled: false } })

  // C: jobs/study/travel/exams/tasks
  assert.deepEqual(uiCommands.startWork('job-1'), { type: 'job.startWork', payload: { jobId: 'job-1' } })
  assert.deepEqual(uiCommands.startStudy('xx-chinese'), { type: 'job.startStudy', payload: { courseId: 'xx-chinese' } })
  assert.deepEqual(uiCommands.startTravel(), { type: 'job.startTravel', payload: {} })
  assert.deepEqual(uiCommands.stopActivity(), { type: 'activity.stop', payload: {} })
  assert.deepEqual(uiCommands.claimTask('daily', 2), { type: 'task.claim', payload: { tab: 'daily', index: 2 } })
  assert.deepEqual(uiCommands.examStart('xx-chinese'), { type: 'exam.start', payload: { subject: 'xx-chinese' } })
  assert.deepEqual(uiCommands.examSubmit('token-1', [0, 2, 1]), { type: 'exam.submit', payload: { sessionToken: 'token-1', answers: [0, 2, 1] } })
  assert.deepEqual(uiCommands.completeTravelCollection(), { type: 'travel.completeCollection', payload: {} })

  // D: daily/sign-in/mail
  assert.deepEqual(uiCommands.signIn(), { type: 'signin.sign', payload: {} })
  assert.deepEqual(uiCommands.drawGrowth(), { type: 'signin.drawGrowth', payload: {} })
  assert.deepEqual(uiCommands.claimOnlineGift(), { type: 'signin.claimOnlineGift', payload: {} })
  assert.deepEqual(uiCommands.claimBirthdayGift(), { type: 'signin.claimBirthdayGift', payload: {} })
  assert.deepEqual(uiCommands.mailClaim('mail-1'), { type: 'mail.claim', payload: { mailId: 'mail-1' } })
  assert.deepEqual(uiCommands.mailClaimAll(), { type: 'mail.claimAll', payload: {} })
  assert.deepEqual(uiCommands.mailDelete('mail-1'), { type: 'mail.delete', payload: { mailId: 'mail-1' } })
  assert.deepEqual(uiCommands.mailDeleteAll(), { type: 'mail.deleteAll', payload: { scope: 'claimed' } })

  // Shared settings/admin actions reached from converted Group A–D UI.
  assert.deepEqual(uiCommands.setShared('difficulty', 'standard'), { type: 'settings.setShared', payload: { key: 'difficulty', value: 'standard' } })
  assert.deepEqual(uiCommands.grantCheat('yb', 1000), { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 1000 } })
  assert.deepEqual(uiCommands.grantRandomGoods('food', 10), { type: 'admin.grantRandomGoods', payload: { type: 'food', quantity: 10 } })
})

test('runtime command dispatch keeps legacy path closed and surfaces duplicate/error results', async (t) => {
  const calls = []
  const events = []
  const previousWindow = globalThis.window
  const previousCustomEvent = globalThis.CustomEvent
  globalThis.CustomEvent = class {
    constructor(type, init = {}) {
      this.type = type
      this.detail = init.detail
    }
  }
  t.after(() => {
    globalThis.window = previousWindow
    globalThis.CustomEvent = previousCustomEvent
  })

  globalThis.window = {
    __qqpetRuntimeV2: false,
    qqpet: { async command(...args) { calls.push(args); return fullResult() } },
    dispatchEvent(event) { events.push(event) },
  }
  assert.equal(runtimeCommandMode(), false)
  assert.equal(await dispatchRuntimeCommand(uiCommands.cheer()), null)
  assert.equal(calls.length, 0, 'legacy mode must not dispatch commands')

  globalThis.window.__qqpetRuntimeV2 = true
  const applied = await dispatchRuntimeCommand(uiCommands.cheer(), { opId: 'op-runtime' })
  assert.equal(applied.status, 'applied')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][0], { type: 'pet.cheer', payload: {} })
  assert.deepEqual(calls[0][1], { opId: 'op-runtime' })
  assert.equal(commandSucceeded(applied), true)

  globalThis.window.qqpet.command = async () => fullResult({
    status: 'duplicate',
    original: 'applied',
  })
  const duplicate = await dispatchRuntimeCommand(uiCommands.cheer())
  assert.equal(commandSucceeded(duplicate), true)
  assert.equal(events.length, 0)

  globalThis.window.qqpet.command = async () => fullResult({
    status: 'rejected',
    error: { code: 'insufficient_funds', message: 'no money', refreshProjection: false },
  })
  const rejected = await dispatchRuntimeCommand(uiCommands.cheer())
  assert.equal(commandSucceeded(rejected), false)
  assert.equal(events.at(-1).type, 'qqpet-command-error')
  assert.equal(events.at(-1).detail.code, 'insufficient_funds')

  globalThis.window.qqpet.command = async () => { throw new Error('ipc down') }
  assert.equal(await dispatchRuntimeCommand(uiCommands.cheer()), null)
  assert.equal(events.at(-1).detail.code, 'internal')
})

test('command result presentation helpers never derive canonical state and preserve goods payloads', () => {
  const food = allGoods('food')[0]
  const result = fullResult({ result: { goods: [{ id: food.id, type: 'food', num: 3 }] } })
  assert.deepEqual(commandResultData(result), { goods: [{ id: food.id, type: 'food', num: 3 }] })
  const goods = commandResultGoods(result)
  assert.equal(goods.length, 1)
  assert.equal(goods[0].id, food.id)
  assert.equal(goods[0].num, 3)
  assert.deepEqual(commandResultGoods(fullResult({ status: 'rejected', error: { code: 'internal', message: 'x', refreshProjection: false } })), [])
  assert.deepEqual(commandResultGoods(fullResult({ result: { goods: [{ id: 'missing', type: 'food', num: 1 }] } })), [])
})

test('converted Group A–D files route actions through commands and freeze legacy mutation sites', () => {
  const expectedLegacyMutationSites = {
    'src/renderer/pet/store.ts': 11,
    // Upstream main's 钻石 payment (#75): payDiamond() spends one diamond via setInfo('diamond').
    'src/renderer/pet/items.ts': 19,
    'src/renderer/pet/vip.ts': 19,
    // Upstream main's setup cheat `setSubject` writes studyInfo through update().
    'src/renderer/pet/jobs.ts': 7,
    'src/renderer/pet/tasks.ts': 7,
    'src/renderer/pet/activity.ts': 4,
    // Upstream main's #75 sign-in reward: addInfo('diamond', 1) next to the goods.
    'src/renderer/pet/signin.ts': 12,
    'src/renderer/pet/mail.ts': 3,
    'src/renderer/pet/goods.ts': 8,
    'src/renderer/ui/adopt.ts': 2,
    'src/renderer/ui/petinfo.ts': 1,
    'src/renderer/ui/face.ts': 3,
    'src/renderer/ui/state.ts': 1,
    'src/renderer/ui/menu.ts': 1,
    'src/renderer/ui/setup.ts': 39,
    'src/renderer/ui/shop.ts': 0,
    'src/renderer/ui/control.ts': 0,
    'src/renderer/ui/travel.ts': 1,
    'src/renderer/ui/exam.ts': 0,
    'src/renderer/ui/signin.ts': 0,
    'src/renderer/ui/email.ts': 2,
    'src/renderer/ui/task.ts': 0,
  }
  const mutationPattern = /\b(update|setInfo|setActivity|addInfo|earnYb|takeGood|give|addGood|startTimed|startTimedGood|writeMails|writeSol|store)\s*\(|window\.qqpet\.save\s*\(/g
  const commandFiles = new Set([
    'src/renderer/pet/store.ts', 'src/renderer/pet/items.ts', 'src/renderer/pet/vip.ts',
    'src/renderer/pet/jobs.ts', 'src/renderer/pet/tasks.ts', 'src/renderer/pet/activity.ts',
    'src/renderer/pet/signin.ts', 'src/renderer/ui/petinfo.ts',
    'src/renderer/ui/face.ts', 'src/renderer/ui/state.ts', 'src/renderer/ui/menu.ts',
    'src/renderer/ui/setup.ts', 'src/renderer/ui/travel.ts', 'src/renderer/ui/exam.ts',
    'src/renderer/ui/signin.ts', 'src/renderer/ui/email.ts',
  ])
  for (const [file, expected] of Object.entries(expectedLegacyMutationSites)) {
    const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
    const actual = (source.match(mutationPattern) ?? []).length
    assert.equal(actual, expected, file + ' gained or lost a direct canonical mutation site; convert it or update the reviewed legacy baseline')
    if (expected > 0) {
      assert.match(source, /runtimeProjectionMode|runtimeCommandMode/, file + ' has no runtime-mode branch')
    }
    if (commandFiles.has(file)) {
      assert.match(source, /dispatchRuntimeCommand/, file + ' must dispatch through the runtime command bridge')
    }
  }

  // Adopt is the C6a direct typed command bridge; its own focused test asserts
  // the exact window.qqpet.command payload and projection-gated presentation.
  const adoptSource = readFileSync(new URL('../../src/renderer/ui/adopt.ts', import.meta.url), 'utf8')
  assert.match(adoptSource, /window\.qqpet\.command\(/)
  assert.match(adoptSource, /runtimeProjectionMode/)

  const commandMapSource = readFileSync(new URL('../../src/renderer/pet/command-map.ts', import.meta.url), 'utf8')
  const runtimeCommandSource = readFileSync(new URL('../../src/renderer/pet/runtime-command.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(commandMapSource, /from ['"]\.\/store['"]|window\.qqpet\.save\s*\(/)
  assert.doesNotMatch(runtimeCommandSource, /from ['"]\.\/store['"]|window\.qqpet\.save\s*\(/)

  const taskUi = readFileSync(new URL('../../src/renderer/ui/task.ts', import.meta.url), 'utf8')
  const signinUi = readFileSync(new URL('../../src/renderer/ui/signin.ts', import.meta.url), 'utf8')
  const emailUi = readFileSync(new URL('../../src/renderer/ui/email.ts', import.meta.url), 'utf8')
  const goodsSource = readFileSync(new URL('../../src/renderer/pet/goods.ts', import.meta.url), 'utf8')
  assert.match(taskUi, /onStoreEvent[\s\S]*task\.progress[\s\S]*task\.claimed/)
  assert.match(signinUi, /onStoreEvent[\s\S]*signin\.changed/)
  assert.match(emailUi, /onStoreEvent[\s\S]*mail\.claimed/)
  assert.match(goodsSource, /onStoreEvent[\s\S]*inventory\.changed[\s\S]*item\.consumed[\s\S]*reward\.granted/)
})

// ---------------------------------------------------------------------------
// Runtime conversion behavior: each converted group must dispatch a typed
// command and leave canonical state to the host projection. The module sources
// are evaluated in a VM with the store and UI replaced by spies, so any legacy
// canonical write is observable instead of silently succeeding.
// ---------------------------------------------------------------------------

const { stripTypeScriptTypes } = await import('node:module')
const { runInNewContext } = await import('node:vm')

function strippedSource(relativePath) {
  return stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export \{.*\}$/gm, '')
    .replace(/^export /gm, '')
}

function loadConvertedModule(relativePath, scope, expose) {
  const context = { ...scope }
  runInNewContext(strippedSource(relativePath) + '\nthis.__converted = { ' + expose + ' }', context)
  return context.__converted
}

function appliedResult(command, result) {
  return {
    status: 'applied',
    commandType: command.type,
    opId: 'op-test',
    commandSeq: 1,
    revision: 1,
    eventSeq: 1,
    ...(result === undefined ? {} : { result }),
  }
}

test('Group C activity.stop dispatches in runtime mode and never writes legacy activity state', async () => {
  const runtimeCalls = []
  const runtimeWrites = []
  const runtime = loadConvertedModule('../../src/renderer/pet/activity.ts', {
    runtimeProjectionMode: true,
    activity: (key) => (key === 'work' ? 'job-1' : null),
    dispatchRuntimeCommand: (command) => { runtimeCalls.push(command); return Promise.resolve(null) },
    commandSucceeded: (result) => result !== null && result.status === 'applied',
    uiCommands: { stopActivity: () => ({ type: 'activity.stop', payload: {} }) },
    setActivity: (...args) => runtimeWrites.push(['setActivity', ...args]),
    update: (...args) => runtimeWrites.push(['update', ...args]),
    refreshTray: () => {},
  }, 'startTask, stopTask, advanceTask')
  assert.equal(runtime.stopTask(), 'work')
  assert.deepEqual(runtimeCalls, [{ type: 'activity.stop', payload: {} }])
  assert.deepEqual(runtimeWrites, [])
  runtime.startTask({ key: 'work', minutes: 10, end: () => {} }, 'job-1')
  runtime.advanceTask(3)
  assert.deepEqual(runtimeWrites, [], 'start/advance must be inert in runtime mode')

  const legacyWrites = []
  const legacy = loadConvertedModule('../../src/renderer/pet/activity.ts', {
    runtimeProjectionMode: false,
    activity: () => null,
    dispatchRuntimeCommand: () => { throw new Error('legacy mode must not dispatch commands') },
    uiCommands: {},
    setActivity: (key, value) => legacyWrites.push(['setActivity', key, value]),
    update: (key, value) => legacyWrites.push(['update', key, value]),
    refreshTray: () => {},
  }, 'startTask, stopTask, advanceTask')
  legacy.startTask({ key: 'work', minutes: 10, end: () => {} }, 'job-1')
  assert.equal(legacy.stopTask(), 'work')
  assert.deepEqual(JSON.parse(JSON.stringify(legacyWrites)), [
    ['update', 'saveJsonData', { activity: '0' }],
    ['setActivity', 'work', 'job-1'],
    ['setActivity', 'work', null],
  ])
})

test('Group B useItem dispatches typed inventory/medical commands without touching legacy goods state', async () => {
  const calls = { dispatch: [], setInfo: [], takeGood: [], addGood: [], dialogs: [], speaks: [] }
  const info = { health: 5, yb: 100, hunger: 100, clean: 100, mood: 100, intel: 0, charm: 0, strong: 0 }
  const save = {
    petComputedlInfo: { hungerMax: 1100, cleanMax: 1100, moodMax: 1000 },
    settings: { paused: false },
    selfGoodDatas: {},
    selfGoodUseOption: {},
  }
  const runtime = loadConvertedModule('../../src/renderer/pet/items.ts', {
    runtimeProjectionMode: true,
    info,
    save,
    windowView: (dialog) => calls.dialogs.push(dialog),
    goodOf: (type, id, num = 1) => ({ id, type, name: id, num, url: 'good.svg', value: 100, useTimeing: 60, useId: id }),
    DEAD: { cure: { id: 'dead-cure' }, tolk: 'dead' },
    illOf: () => ({ cure: { id: 'cure-1' } }),
    addGood: (...args) => calls.addGood.push(args),
    hasGood: () => true,
    startTimed: (...args) => calls.addGood.push(['startTimed', ...args]),
    takeGood: (...args) => { calls.takeGood.push(args); return true },
    speak: (...args) => calls.speaks.push(args),
    emitEvent: () => {},
    activity: () => '1-',
    addInfo: (...args) => calls.setInfo.push(['addInfo', ...args]),
    setInfo: (...args) => calls.setInfo.push(['setInfo', ...args]),
    floatMood: () => {},
    uiCommands: {
      use: (type, itemId, quantity) => ({ type: 'inventory.use', payload: quantity === undefined ? { type, itemId } : { type, itemId, quantity } }),
      treatOwned: (itemId) => ({ type: 'medical.treat', payload: { mode: 'owned', itemId } }),
      treatDoctor: () => ({ type: 'medical.treat', payload: { mode: 'doctor' } }),
      buy: (type, itemId, quantity) => ({ type: 'inventory.buy', payload: { type, itemId, quantity } }),
    },
    dispatchRuntimeCommand: (command) => { calls.dispatch.push(command); return Promise.resolve(appliedResult(command)) },
    commandResultData: (result) => (result === null || result === undefined ? null : result.result ?? null),
    commandSucceeded: (result) => result !== null && result !== undefined && result.status === 'applied',
    addCount: () => {},
  }, 'useItem, buy, doctor, give, pay, apply')

  runtime.useItem({ id: 'yb', type: 'nums', name: '元宝', num: 3, url: 'good.svg', useId: 'yb', value: 100 })
  assert.equal(calls.dialogs.length, 1)
  assert.deepEqual(calls.dispatch, [], 'choosing a quantity must not dispatch yet')
  calls.dialogs[0].ok(() => {}, 2)
  assert.deepEqual(calls.dispatch, [{ type: 'inventory.use', payload: { type: 'nums', itemId: 'yb', quantity: 2 } }])
  assert.deepEqual(calls.setInfo, [])
  assert.deepEqual(calls.takeGood, [])

  calls.dispatch.length = 0
  runtime.useItem({ id: 'food1', type: 'food', name: 'food', num: 1, url: 'good.svg', useTimeing: 60 })
  await Promise.resolve()
  assert.deepEqual(calls.dispatch, [{ type: 'inventory.use', payload: { type: 'food', itemId: 'food1' } }])
  assert.equal(calls.speaks.length, 1)
  assert.deepEqual(calls.takeGood, [])
  assert.deepEqual(calls.addGood, [])
  assert.deepEqual(calls.setInfo, [])

  calls.dispatch.length = 0
  runtime.useItem({ id: 'med1', type: 'medicine', name: 'med', num: 1, url: 'good.svg' })
  await Promise.resolve()
  assert.deepEqual(calls.dispatch, [{ type: 'medical.treat', payload: { mode: 'owned', itemId: 'med1' } }])
  assert.deepEqual(calls.takeGood, [])
  assert.deepEqual(calls.setInfo, [])

  const legacyCalls = { dispatch: [], speaks: [] }
  const legacy = loadConvertedModule('../../src/renderer/pet/items.ts', {
    runtimeProjectionMode: false,
    info,
    save,
    windowView: () => {},
    goodOf: () => ({ id: 'food1', type: 'food', name: 'food', num: 1, url: 'good.svg' }),
    DEAD: { cure: { id: 'dead-cure' }, tolk: 'dead' },
    illOf: () => ({ cure: { id: 'cure-1' } }),
    addGood: () => {},
    hasGood: () => true,
    startTimed: () => {},
    takeGood: () => true,
    speak: (...args) => legacyCalls.speaks.push(args),
    emitEvent: () => {},
    activity: () => null,
    addInfo: () => {},
    setInfo: () => {},
    floatMood: () => {},
    uiCommands: {},
    dispatchRuntimeCommand: () => { throw new Error('legacy mode must not dispatch commands') },
    commandResultData: () => null,
    commandSucceeded: () => false,
    addCount: () => {},
  }, 'useItem')
  legacy.useItem({ id: 'food1', type: 'food', name: 'food', num: 1, url: 'good.svg' })
  assert.equal(legacyCalls.speaks.length, 1, 'legacy food use still speaks')
  assert.equal(legacyCalls.dispatch.length, 0)
})

test('Group C work/study/travel dispatch semantic commands and leave the legacy task clock idle', async () => {
  const calls = { dispatch: [], speaks: [], startTask: [] }
  const scope = {
    runtimeProjectionMode: true,
    save: { studyInfo: { chinese: 0 }, gameSaveDatas: {}, settings: {} },
    info: { health: 5, mood: 1000, intel: 100, charm: 0, strong: 0 },
    PROVINCES: [],
    uiCommands: {
      startWork: (jobId) => ({ type: 'job.startWork', payload: { jobId } }),
      startStudy: (courseId) => ({ type: 'job.startStudy', payload: { courseId } }),
      startTravel: () => ({ type: 'job.startTravel', payload: {} }),
    },
    dispatchRuntimeCommand: (command) => { calls.dispatch.push(command); return Promise.resolve(appliedResult(command)) },
    commandSucceeded: (result) => result !== null && result.status === 'applied',
    speak: (...args) => calls.speaks.push(args),
    startTask: (...args) => calls.startTask.push(args),
    lessons: () => 0,
    examPrompt: () => { throw new Error('exam prompt must not open for an unfinished course') },
  }
  const jobs = loadConvertedModule('../../src/renderer/pet/jobs.ts', scope, 'work, study, travel')
  assert.equal(jobs.work({ id: 'w1', name: 'work', type: 'work', num: 1, url: 'x', needLevel: 0 }), true)
  assert.deepEqual(calls.dispatch, [{ type: 'job.startWork', payload: { jobId: 'w1' } }])
  assert.deepEqual(calls.startTask, [])
  await Promise.resolve()
  assert.equal(calls.speaks.length, 1)

  calls.dispatch.length = 0
  assert.equal(jobs.study({ id: 'xx-chinese', name: '语文', object: '语文', type: 'study', num: 1, url: 'x', classNum: 1, classNumUp: 0 }), true)
  assert.deepEqual(calls.dispatch, [{ type: 'job.startStudy', payload: { courseId: 'xx-chinese' } }])
  assert.deepEqual(calls.startTask, [])

  calls.dispatch.length = 0
  jobs.travel()
  assert.deepEqual(calls.dispatch, [{ type: 'job.startTravel', payload: {} }])
  assert.deepEqual(calls.startTask, [])

  const legacyCalls = { dispatch: [], startTask: [] }
  const legacy = loadConvertedModule('../../src/renderer/pet/jobs.ts', {
    ...scope,
    runtimeProjectionMode: false,
    save: { studyInfo: { chinese: 0 }, gameSaveDatas: {}, settings: {}, petComputedlInfo: { level: 1 } },
    activity: () => null,
    dispatchRuntimeCommand: () => { legacyCalls.dispatch.push('called'); return Promise.resolve(null) },
    speak: (_say, _action, hooks) => { hooks?.start?.() },
    startTask: (...args) => legacyCalls.startTask.push(args),
  }, 'work, study, travel')
  legacy.work({ id: 'w1', name: 'work', type: 'work', num: 1, url: 'x', needLevel: 0, useTime: 10, yb: 5 })
  assert.deepEqual(legacyCalls.dispatch, [])
  assert.equal(legacyCalls.startTask.length, 1, 'legacy work still starts the local task')
})

test('Group C task.claim dispatches in runtime mode and only returns projected reward goods', async () => {
  const calls = { dispatch: [], give: [], update: [], loot: 0 }
  const reward = { id: '100010001', type: 'food', name: 'food', num: 1, url: 'good.svg' }
  const scope = {
    runtimeProjectionMode: true,
    save: { saveJsonData: { task: '{"doNums":{"Amusing":5}}' }, gameSaveDatas: {}, selfGoodDatas: {}, selfGoodUseOption: {}, petComputedlInfo: {} },
    info: { yb: 0 },
    parseGood: code => ({ ...reward, id: code }),
    loot: () => {
      calls.loot++
      return [reward]
    },
    rand: () => 0,
    update: (key, value) => calls.update.push([key, value]),
    give: (...args) => calls.give.push(args),
    registerProjectionCacheInvalidator: () => () => {},
    dayStart: () => 0,
    uiCommands: { claimTask: (tab, index) => ({ type: 'task.claim', payload: { tab, index } }) },
    dispatchRuntimeCommand: (command) => {
      calls.dispatch.push(command)
      return Promise.resolve(appliedResult(command, { tab: 'ddw', index: 0, goods: [reward] }))
    },
    commandSucceeded: (result) => result !== null && result.status === 'applied',
    commandResultGoods: (result) => (result === null || result.result === undefined ? [] : result.result.goods),
  }
  // tasks.ts now resolves reroll previews through the real preview helper; give its
  // VM scope the goods parser instead of reimplementing the projection rule here.
  const preview = loadConvertedModule('../../src/renderer/pet/task-preview.ts', { parseGood: scope.parseGood }, 'previewTaskGoods')
  scope.previewTaskGoods = preview.previewTaskGoods
  const tasks = loadConvertedModule('../../src/renderer/pet/tasks.ts', scope, 'claim, claimRuntime, count, tasks')
  const claimed = tasks.claim('ddw', 0)
  assert.deepEqual(calls.dispatch, [{ type: 'task.claim', payload: { tab: 'ddw', index: 0 } }])
  assert.deepEqual(calls.give, [], 'runtime claim must not grant goods locally')
  assert.deepEqual(calls.update, [], 'runtime claim must not write task progress locally')
  assert.deepEqual([...claimed].map(good => good.id), ['_102010001*1'], 'projection preview keeps only fixed rewards')
  const previews = tasks.tasks('ddw')
  assert.deepEqual([...previews[0].good].map(good => good.id), ['_102010001*1'])
  assert.equal(previews[4].good.length, 0, 'a reroll-only entry shows no locally guessed icons in projection mode')
  assert.equal(calls.loot, 0, 'projection mode must not draw reroll goods locally')
  const runtimeGoods = await tasks.claimRuntime('ddw', 0)
  assert.deepEqual(runtimeGoods, [reward])
  assert.deepEqual(calls.give, [])
})

test('Group B VIP commands dispatch and never call legacy setInfo in runtime mode', () => {
  const calls = { dispatch: [], setInfo: [], resetFish: [] }
  const vip = loadConvertedModule('../../src/renderer/pet/vip.ts', {
    runtimeProjectionMode: true,
    info: { pinkDiamond: false, PDiamondExpirationDate: 0, PDiamondBeginDate: 0, PDiamondYear: false, PDgrowth: 0, PDgrowthValue: 0, PDiamondLevel: 0, PDgrowthValue_next: 0, sweetHeart: false, sweetHeartOverTime: 0 },
    setInfo: (...args) => calls.setInfo.push(args),
    resetFish: () => calls.resetFish.push('reset'),
    uiCommands: {
      clearPinkDiamond: () => ({ type: 'vip.clearPinkDiamond', payload: {} }),
      buyPinkDiamond: (days) => ({ type: 'vip.buyPinkDiamond', payload: { days } }),
      buySweetheart: (days) => ({ type: 'vip.buySweetheart', payload: { days } }),
    },
    dispatchRuntimeCommand: (command) => { calls.dispatch.push(command); return Promise.resolve(null) },
  }, 'openPinkDiamond, clearPinkDiamond, addSweetHeart, newDay, dayStart')
  vip.openPinkDiamond(30)
  vip.clearPinkDiamond()
  vip.addSweetHeart(7)
  vip.newDay(100)
  assert.deepEqual(calls.dispatch, [
    { type: 'vip.buyPinkDiamond', payload: { days: 30 } },
    { type: 'vip.clearPinkDiamond', payload: {} },
    { type: 'vip.buySweetheart', payload: { days: 7 } },
  ])
  assert.deepEqual(calls.setInfo, [], 'VIP runtime paths must not mutate canonical stats locally')
  assert.deepEqual(calls.resetFish, [])
})

test('Group D signin paths dispatch and never grant or store canonical data locally in runtime mode', () => {
  const calls = { dispatch: [], give: [], update: [] }
  const signin = loadConvertedModule('../../src/renderer/pet/signin.ts', {
    runtimeProjectionMode: true,
    info: { pinkDiamond: false, birthDay: 0, onLineTime: 0 },
    save: { saveJsonData: { signin: '{}' } },
    goodOf: (type, id, num = 1) => ({ id, type, name: id, num, url: 'good.svg' }),
    parseGood: (code) => ({ id: code, type: 'nums', name: code, num: 1, url: 'good.svg' }),
    give: (...args) => calls.give.push(args),
    loot: () => [],
    rand: () => 0,
    update: (key, value) => calls.update.push([key, value]),
    dayStart: () => 0,
    registerProjectionCacheInvalidator: () => () => {},
    uiCommands: {
      signIn: () => ({ type: 'signin.sign', payload: {} }),
      drawGrowth: () => ({ type: 'signin.drawGrowth', payload: {} }),
      claimOnlineGift: () => ({ type: 'signin.claimOnlineGift', payload: {} }),
      claimBirthdayGift: () => ({ type: 'signin.claimBirthdayGift', payload: {} }),
    },
    dispatchRuntimeCommand: (command) => { calls.dispatch.push(command); return Promise.resolve(null) },
  }, 'signToday, drawGrowth, takeOnlineGift, birthdayGift, resetSignIn, tickGift')
  assert.deepEqual(JSON.parse(JSON.stringify(signin.signToday())), [])
  signin.drawGrowth()
  signin.takeOnlineGift()
  signin.birthdayGift()
  signin.resetSignIn()
  signin.tickGift(5)
  assert.deepEqual(calls.dispatch, [
    { type: 'signin.sign', payload: {} },
    { type: 'signin.drawGrowth', payload: {} },
    { type: 'signin.claimOnlineGift', payload: {} },
    { type: 'signin.claimBirthdayGift', payload: {} },
  ])
  assert.deepEqual(calls.give, [])
  assert.deepEqual(calls.update, [])
})

test('Group D mail writes are host-owned in runtime mode and legacy writes stay available', () => {
  const runtimeCalls = { update: [] }
  const runtime = loadConvertedModule('../../src/renderer/pet/mail.ts', {
    runtimeProjectionMode: true,
    info: { birthDay: 0, name: 'pet' },
    save: { saveJsonData: { email: '{}' } },
    update: (key, value) => runtimeCalls.update.push([key, value]),
    isBuddy: () => false,
    allGoods: () => [],
    goodOf: () => ({ id: 'x', type: 'nums', name: 'x', num: 1, url: 'good.svg' }),
    rand: () => 0,
    scaleYb: (n) => n,
  }, 'readMails, writeMails, mailPhoto, deliverMails')
  runtime.writeMails({ 1: { d: 1, l: 'x', glb: [] } })
  assert.equal(runtime.deliverMails(), false)
  runtime.mailPhoto({ id: 'shot', city: 'x' })
  assert.deepEqual(runtimeCalls.update, [])

  const legacyCalls = { update: [] }
  const legacy = loadConvertedModule('../../src/renderer/pet/mail.ts', {
    ...runtime,
    runtimeProjectionMode: false,
    save: { saveJsonData: { email: '{}' } },
    update: (key, value) => legacyCalls.update.push([key, value]),
    isBuddy: () => false,
    allGoods: () => [],
    goodOf: () => ({ id: 'x', type: 'nums', name: 'x', num: 1, url: 'good.svg' }),
    rand: () => 0,
    scaleYb: (n) => n,
  }, 'writeMails')
  legacy.writeMails({ 1: { d: 1, l: 'x', glb: [] } })
  assert.equal(legacyCalls.update.length, 1)
  assert.equal(legacyCalls.update[0][0], 'saveJsonData')
})

test('converted panels render from projection events, not optimistic canonical writes', () => {
  const root = new URL('../../', import.meta.url)
  const read = (path) => readFileSync(new URL(path, root), 'utf8')
  const contracts = {
    'src/renderer/ui/task.ts': /onStoreEvent\([\s\S]*task\.progress[\s\S]*task\.claimed/,
    'src/renderer/ui/signin.ts': /onStoreEvent\([\s\S]*signin\.changed/,
    'src/renderer/ui/email.ts': /onStoreEvent\([\s\S]*mail\.claimed/,
    'src/renderer/ui/state.ts': /onStoreEvent\([\s\S]*activity\.started[\s\S]*activity\.completed/,
    'src/renderer/pet/goods.ts': /onStoreEvent\([\s\S]*inventory\.changed[\s\S]*item\.consumed[\s\S]*reward\.granted/,
    'src/renderer/ui/travel.ts': /createActivityClock[\s\S]*elapsedMinutes\('trip'\)/,
  }
  for (const [file, pattern] of Object.entries(contracts)) {
    assert.match(read(file), pattern, file + ' must repaint from its ordered projection events')
  }
  // Canonical SavePatch writes stay in the one guarded legacy flusher.
  // The busy-state stop guard observes the shared pending state.
  assert.match(read('src/renderer/ui/state.ts'), /onStopTaskPending/)

  const store = read('src/renderer/pet/store.ts')
  assert.match(store, /if \(runtimeProjectionMode \|\| Object\.keys\(patch\)\.length === 0\) return[\s\S]*window\.qqpet\.save\(patch as SavePatch\)/)
  for (const file of [
    'src/renderer/pet/items.ts', 'src/renderer/pet/jobs.ts', 'src/renderer/pet/tasks.ts',
    'src/renderer/pet/activity.ts', 'src/renderer/pet/signin.ts', 'src/renderer/pet/mail.ts',
    'src/renderer/pet/goods.ts', 'src/renderer/pet/vip.ts', 'src/renderer/ui/signin.ts',
    'src/renderer/ui/email.ts', 'src/renderer/ui/task.ts', 'src/renderer/ui/travel.ts',
    'src/renderer/ui/exam.ts', 'src/renderer/ui/setup.ts', 'src/renderer/ui/state.ts',
    'src/renderer/ui/menu.ts', 'src/renderer/ui/petinfo.ts', 'src/renderer/ui/face.ts',
  ]) {
    assert.doesNotMatch(read(file), /window\.qqpet\.save\s*\(/, file + ' must not bypass the repository with a SavePatch write')
  }
})

test('command errors are user friendly and duplicate rejections still surface them', async (t) => {
  const { commandErrorText, dispatchRuntimeCommand } = await import('../../src/renderer/pet/runtime-command.ts')
  const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')
  assert.equal(commandErrorText({ code: 'insufficient_funds', message: 'not enough yb', refreshProjection: false }), '元宝不足')
  assert.equal(commandErrorText({ code: 'cooldown', message: 'too soon', refreshProjection: false }), '还没到时间，请稍后再试')
  assert.equal(commandErrorText({ code: 'invalid_payload', message: 'bad payload', refreshProjection: false }), '操作参数无效')

  const events = []
  const previousWindow = globalThis.window
  const previousCustomEvent = globalThis.CustomEvent
  globalThis.CustomEvent = class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail }
  }
  t.after(() => {
    globalThis.window = previousWindow
    globalThis.CustomEvent = previousCustomEvent
  })
  globalThis.window = {
    __qqpetRuntimeV2: true,
    qqpet: {
      async command() {
        return {
          status: 'duplicate',
          commandType: 'vip.buyPinkDiamond',
          opId: 'op-dup',
          commandSeq: 2,
          revision: 2,
          eventSeq: 2,
          original: 'rejected',
          error: { code: 'insufficient_funds', message: 'not enough yb', refreshProjection: false },
        }
      },
    },
    dispatchEvent(event) { events.push(event) },
  }
  const result = await dispatchRuntimeCommand(uiCommands.buyPinkDiamond(30))
  assert.equal(result.status, 'duplicate')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'qqpet-command-error')
  assert.equal(events[0].detail.message, '元宝不足')
})

// ---------------------------------------------------------------------------
// Follow-up audit fixes: authoritative travel elapsed, single-flight stop
// commands, and runtime-safe chat cheats.
// ---------------------------------------------------------------------------

test('runtime travel clock derives elapsed minutes from live projections and ordered events', async () => {
  const { createActivityClock, activityElapsedMinutes } = await import('../../src/renderer/pet/activity-clock.ts')
  const projectionListeners = []
  const eventListeners = []
  const clock = createActivityClock({
    onProjection: (listener) => { projectionListeners.push(listener); return () => {} },
    onEvent: (listener) => { eventListeners.push(listener); return () => {} },
  })
  const startedAt = 1_700_000_000_000
  const activeOption = { work: null, study: null, trip: '北京', ill: null, die: null }
  const projection = (gameTimeMs, trip = '北京') => ({
    gameTimeMs,
    save: { activeOption: { ...activeOption, trip } },
  })
  eventListeners[0]({
    eventSeq: 1,
    revision: 1,
    gameTimeMs: startedAt,
    type: 'activity.started',
    payload: { kind: 'travel', activityId: '北京', dueAtGameMs: startedAt + 3_600_000 },
  })
  assert.equal(clock.elapsedMinutes('trip'), null, 'no projection yet means no fake elapsed')
  projectionListeners[0](projection(startedAt + 12 * 60_000), [])
  assert.equal(clock.elapsedMinutes('trip'), 12)
  projectionListeners[0](projection(startedAt + 20 * 60_000), [])
  assert.equal(clock.elapsedMinutes('trip'), 20)
  assert.equal(clock.elapsedMinutes('work'), null, 'only the running kind is reported')
  assert.deepEqual(clock.sample('trip'), { kind: 'trip', startedAtGameMs: startedAt, dueAtGameMs: startedAt + 3_600_000 })
  projectionListeners[0](projection(startedAt + 21 * 60_000, null), [])
  assert.equal(clock.elapsedMinutes('trip'), null, 'a projection without the trip clears the sample')
  assert.equal(activityElapsedMinutes({ kind: 'trip', startedAtGameMs: 0, dueAtGameMs: 3_600_000 }, 90 * 60_000), 60)
  assert.equal(activityElapsedMinutes(null, 1000), null)
})

test('runtime activity.stop is single-flight and settles exactly once', async () => {
  const dispatches = []
  let resolveRequest
  const runtime = loadConvertedModule('../../src/renderer/pet/activity.ts', {
    runtimeProjectionMode: true,
    activity: (key) => (key === 'work' ? 'job-1' : null),
    dispatchRuntimeCommand: (command) => {
      dispatches.push(command)
      return new Promise((resolve) => { resolveRequest = resolve })
    },
    commandSucceeded: (result) => Boolean(result && result.status === 'applied'),
    uiCommands: { stopActivity: () => ({ type: 'activity.stop', payload: {} }) },
    setActivity: () => {},
    update: () => {},
    refreshTray: () => {},
  }, 'stopTask, stopTaskPending, stopTaskResult, onStopTaskPending')
  const pendingEvents = []
  runtime.onStopTaskPending((pending) => pendingEvents.push(pending))
  assert.equal(runtime.stopTask(), 'work')
  assert.equal(runtime.stopTask(), 'work')
  assert.equal(dispatches.length, 1, 'the second click must not dispatch while the first is pending')
  assert.equal(runtime.stopTaskPending(), true)
  assert.deepEqual(pendingEvents, [true], 'every surface observes the shared pending transition')
  resolveRequest({ status: 'applied' })
  assert.equal(await runtime.stopTaskResult(), true)
  assert.equal(runtime.stopTaskPending(), false)
  assert.deepEqual(pendingEvents, [true, false])
  assert.equal(runtime.stopTask(), 'work')
  assert.equal(dispatches.length, 2, 'a new stop is allowed after the first settles')
  resolveRequest(null)
  assert.equal(await runtime.stopTaskResult(), false)
  assert.equal(runtime.stopTaskPending(), false)
})

test('runtime busy-state stop guard releases when the shared pending command settles', () => {
  let pending = false
  const listeners = []
  const calls = { stopTask: 0, speak: 0 }
  const state = loadConvertedModule('../../src/renderer/ui/state.ts', {
    window: { qqpet: {}, addEventListener: () => {} },
    onSettingsChange: () => {},
    onStoreEvent: () => {},
    onInfoChange: () => {},
    onStopTaskPending: (listener) => { listeners.push(listener); return () => {} },
    runtimeProjectionMode: true,
    stopTaskPending: () => pending,
    stopTask: () => { calls.stopTask += 1; pending = true; listeners.forEach((listener) => listener(true)); return 'work' },
    speak: () => { calls.speak += 1 },
    info: { health: 5 },
    save: { settings: { paused: false }, petComputedlInfo: {} },
  }, 'stop')
  state.stop()
  state.stop()
  assert.equal(calls.stopTask, 1, 'the second click must not issue another stop while shared pending is set')
  assert.equal(calls.speak, 1, 'the stop line is spoken once')
  pending = false
  listeners.forEach((listener) => listener(false))
  state.stop()
  assert.equal(calls.stopTask, 2, 'the guard releases when the shared pending state clears')
})

async function extractTopLevelSnippets(relativePath, names) {
  const { parse } = await import('@babel/parser')
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const snippets = []
  for (const entry of ast.program.body) {
    const declaration = entry.type === 'ExportNamedDeclaration' || entry.type === 'ExportDefaultDeclaration' ? entry.declaration : entry
    if (declaration === null || declaration === undefined) continue
    if (declaration.type === 'FunctionDeclaration' && names.includes(declaration.id?.name)) {
      snippets.push(source.slice(declaration.start, declaration.end))
    }
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier' && names.includes(declarator.id.name)) {
          snippets.push(source.slice(declaration.start, declaration.end))
          break
        }
      }
    }
  }
  return snippets.join('\n')
}

test('runtime chat cheats await the applied command result and legacy chat cheats stay unchanged', async () => {
  const snippets = await extractTopLevelSnippets('../../src/renderer/ui/chat.ts', ['cheat', 'CHEAT', 'STATS'])
  const runtimeCalls = { dispatch: [], update: [], addInfo: [], setInfo: [] }
  const runtimeContext = {
    runtimeProjectionMode: true,
    info: { host: '主人', name: '宠宝', mood: 100, yb: 100, growth: 100 },
    save: { petComputedlInfo: { moodMax: 1000, ybMax: 9999, growthMax: 99999 } },
    update: (...args) => runtimeCalls.update.push(args),
    addInfo: (...args) => runtimeCalls.addInfo.push(args),
    setInfo: (...args) => runtimeCalls.setInfo.push(args),
    dispatchRuntimeCommand: (command) => { runtimeCalls.dispatch.push(command); return Promise.resolve({ status: 'applied' }) },
    commandSucceeded: (result) => Boolean(result && result.status === 'applied'),
    uiCommands: {
      setShared: (key, value) => ({ type: 'settings.setShared', payload: { key, value } }),
      grantCheat: (stat, amount) => ({ type: 'admin.grantCheat', payload: { stat, amount } }),
    },
  }
  runInNewContext(stripTypeScriptTypes(snippets, { mode: 'transform' }) + '\nthis.__cheat = cheat', runtimeContext)
  const cheat = runtimeContext.__cheat
  assert.equal(await cheat('不要死'), '好的主人，宠宝以后再也不会死啦！')
  assert.equal(await cheat('元宝+100000'), '主人，元宝+100000，宠宝收到啦！')
  assert.equal(await cheat('心情+50'), '主人，心情+50，宠宝收到啦！')
  assert.deepEqual(runtimeCalls.dispatch, [
    { type: 'settings.setShared', payload: { key: 'undying', value: true } },
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 100000 } },
    { type: 'admin.grantCheat', payload: { stat: 'mood', amount: 50 } },
  ])
  assert.deepEqual(runtimeCalls.update, [])
  assert.deepEqual(runtimeCalls.addInfo, [])
  assert.deepEqual(runtimeCalls.setInfo, [])

  const rejectedCalls = { dispatch: [] }
  const rejectedContext = {
    runtimeProjectionMode: true,
    info: { host: '主人', name: '宠宝', mood: 100, yb: 100, growth: 100 },
    save: { petComputedlInfo: { moodMax: 1000, ybMax: 9999, growthMax: 99999 } },
    update: () => {},
    addInfo: () => {},
    setInfo: () => {},
    dispatchRuntimeCommand: (command) => { rejectedCalls.dispatch.push(command); return Promise.resolve({ status: 'rejected', error: { code: 'invalid_payload', message: 'too large', refreshProjection: false } }) },
    commandSucceeded: () => false,
    uiCommands: { grantCheat: (stat, amount) => ({ type: 'admin.grantCheat', payload: { stat, amount } }) },
  }
  runInNewContext(stripTypeScriptTypes(snippets, { mode: 'transform' }) + '\nthis.__cheat = cheat', rejectedContext)
  assert.equal(await rejectedContext.__cheat('元宝+999999999'), null, 'a rejected cheat must not report success')
  assert.deepEqual(rejectedCalls.dispatch, [{ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 999999999 } }])

  const legacyCalls = { dispatch: [], update: [], addInfo: [], setInfo: [] }
  const legacyContext = {
    runtimeProjectionMode: false,
    info: { host: '主人', name: '宠宝', mood: 100, yb: 100, growth: 100 },
    save: { petComputedlInfo: { moodMax: 1000, ybMax: 9999, growthMax: 99999 } },
    update: (...args) => legacyCalls.update.push(args),
    addInfo: (...args) => legacyCalls.addInfo.push(args),
    setInfo: (...args) => legacyCalls.setInfo.push(args),
    dispatchRuntimeCommand: () => { legacyCalls.dispatch.push('called'); return Promise.resolve(null) },
    uiCommands: {},
  }
  runInNewContext(stripTypeScriptTypes(snippets, { mode: 'transform' }) + '\nthis.__cheat = cheat', legacyContext)
  const legacyCheat = legacyContext.__cheat
  await legacyCheat('不要死')
  await legacyCheat('元宝+5')
  await legacyCheat('心情+5')
  assert.deepEqual(legacyCalls.dispatch, [])
  assert.equal(legacyCalls.update.length, 1)
  assert.equal(legacyCalls.addInfo.length, 1)
  assert.equal(legacyCalls.setInfo.length, 1)
})

test('a rejected runtime chat cheat surfaces an error line instead of speaking success', async () => {
  const talkSource = await extractTopLevelSnippets('../../src/renderer/ui/chat.ts', ['talkToPet'])
  const calls = { speak: [] }
  const context = {
    save: { settings: { chatCheat: true } },
    noteUserSpoke: () => {},
    cheat: async () => null,
    aiOn: () => true,
    SILLY: [],
    info: { name: '宠宝' },
    speak: (...args) => calls.speak.push(args),
  }
  runInNewContext(stripTypeScriptTypes(talkSource, { mode: 'transform' }) + '\nthis.__talk = talkToPet', context)
  assert.equal(await context.__talk('元宝+999999999'), '这个操作没有生效哦~')
  assert.deepEqual(calls.speak, [], 'the error dialog is the surface; no success bubble is spoken')
})

test('shared stop-pending state disables the status stop button with a real attribute and style class', () => {
  let pending = false
  const buttons = []
  const state = loadConvertedModule('../../src/renderer/ui/state.ts', {
    window: { qqpet: {}, addEventListener: () => {} },
    onSettingsChange: () => {},
    onStoreEvent: () => {},
    onInfoChange: () => {},
    onStopTaskPending: () => () => {},
    runtimeProjectionMode: true,
    stopTaskPending: () => pending,
    stopTask: () => null,
    speak: () => {},
    info: { health: 5 },
    save: { settings: { paused: false }, petComputedlInfo: {} },
    activity: (key) => (key === 'work' ? 'job-1' : null),
    elapsed: () => 0,
    button: (cls, click, ...children) => {
      const classes = new Set(cls.split(' ').filter(Boolean))
      const attrs = {}
      const element = {
        className: cls,
        children,
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
          toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        },
        setAttribute: (name, value) => { attrs[name] = value },
        getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
        removeAttribute: (name) => { delete attrs[name] },
        addEventListener: () => {},
      }
      buttons.push(element)
      return element
    },
    div: (cls, ...children) => ({
      className: cls,
      children,
      classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
      setAttribute: () => {},
      getAttribute: () => null,
      removeAttribute: () => {},
    }),
  }, 'status')
  assert.ok(state.status().length > 0)
  const idle = buttons.at(-1)
  assert.equal(idle.classList.contains('disable'), false)
  assert.equal(idle.getAttribute('disabled'), null)
  pending = true
  state.status()
  const disabled = buttons.at(-1)
  assert.equal(disabled.classList.contains('disable'), true)
  assert.equal(disabled.getAttribute('disabled'), '')
  assert.equal(disabled.getAttribute('aria-disabled'), 'true')
})

test('travel and status stop buttons share one pending disabled rule', async () => {
  const travelSource = await extractTopLevelSnippets('../../src/renderer/ui/travel.ts', ['travelStopDisabled'])
  const context = {}
  runInNewContext(stripTypeScriptTypes(travelSource, { mode: 'transform' }) + '\nthis.__travelStopDisabled = travelStopDisabled', context)
  const disabled = context.__travelStopDisabled
  assert.equal(disabled('北京', false), false)
  assert.equal(disabled('北京', true), true, 'a stop initiated from the status panel disables the travel button')
  assert.equal(disabled(null, false), true)
  const travel = readFileSync(new URL('../../src/renderer/ui/travel.ts', import.meta.url), 'utf8')
  const status = readFileSync(new URL('../../src/renderer/ui/state.ts', import.meta.url), 'utf8')
  assert.match(travel, /onStopTaskPending/)
  assert.match(status, /onStopTaskPending/)
  assert.match(travel, /stop\.setAttribute\('disabled'/)
  assert.match(status, /stopButton\.setAttribute\('disabled'/)
})
