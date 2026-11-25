import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * Minimal DOM used by the activity-list window. It models exactly the two
 * operations that matter here: append() adds a sibling, replaceChildren()
 * detaches every previous child. A reward result is appended to the window
 * root while a projection-triggered redraw replaces the window content.
 */
function element(className = '', ...children) {
  const el = {
    className,
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    textContent: '',
    disabled: false,
    type: '',
    listeners: new Map(),
    append(...next) {
      for (const child of next) {
        if (child !== null && typeof child === 'object') child.parentElement = el
        el.children.push(child)
      }
    },
    replaceChildren(...next) {
      el.children = []
      el.append(...next)
    },
    remove() {
      if (el.parentElement === null) return
      el.parentElement.children = el.parentElement.children.filter(child => child !== el)
      el.parentElement = null
    },
    addEventListener(type, listener) {
      el.listeners.set(type, listener)
    },
    setAttribute() {},
    click() {
      el.listeners.get('click')?.()
    },
  }
  el.append(...children)
  return el
}

function byText(root, text) {
  if (root === null || typeof root !== 'object') return null
  if (root.textContent === text) return root
  for (const child of root.children) {
    const found = byText(child, text)
    if (found !== null) return found
  }
  return null
}

function loadTaskWindow() {
  const state = {
    storeListener: null,
    opened: null,
    results: [],
    resolveClaim: null,
  }
  const reward = { id: '100010001', type: 'food', name: '食物', num: 1, url: 'good.svg' }
  const source = stripTypeScriptTypes(
    readFileSync(new URL('../../src/renderer/ui/task.ts', import.meta.url), 'utf8'),
  )
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const scope = {
    phoneUI: () => false,
    openPhoneTask: () => {},
    runtimeProjectionMode: true,
    TABS: { daily: '今日任务', ddw: '逗逗我', growth: '成长', travel: '旅游' },
    tasks: () => [
      { label: '喂我吃东西', msg: '肚子饿了', num: 2, done: 2, take: false, good: [reward] },
    ],
    claim: () => false,
    claimRuntime: () => new Promise(resolve => { state.resolveClaim = resolve }),
    onStoreEvent: listener => {
      state.storeListener = listener
      return () => {}
    },
    openBox: (root, options) => {
      state.opened = { root, options }
      return () => {}
    },
    showResult: (host, goods, msg = '') => {
      const mark = element('markFull')
      mark.result = { goods, msg }
      host.append(mark)
      state.results.push(mark)
    },
    div: element,
    img: () => element('goodImg'),
    button: (cls, run, ...children) => {
      const el = element(cls, ...children)
      if (run) el.addEventListener('click', run)
      return el
    },
    document: { createElement: () => element() },
    setTimeout,
    clearTimeout,
    Promise,
  }
  runInNewContext(source + '\nthis.__taskUi = { openTask }', scope)
  return Object.assign(state, scope.__taskUi)
}

test('a task reward overlay survives the projection redraw that follows the claim', async () => {
  const ui = loadTaskWindow()
  ui.openTask()
  assert.notEqual(ui.opened, null, 'the activity window must open')
  const root = ui.opened.root

  const claimButton = byText(root, '领取奖励')
  assert.notEqual(claimButton, null, 'a completed task must offer 领取奖励')
  claimButton.click()

  const reward = { id: '100010001', type: 'food', name: '食物', num: 1, url: 'good.svg' }
  ui.resolveClaim([reward])
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(ui.results.length, 1, 'the claim result dialog must be shown')
  assert.ok(root.children.includes(ui.results[0]), 'the result dialog must be attached to the window')

  // Server mode sends commandResult before the projection: the command promise
  // resolves, showResult() appends the dialog, and only then does task.claimed
  // arrive and trigger render(). The redraw must not remove the dialog.
  ui.storeListener({ type: 'task.claimed', payload: { tab: 'daily', index: 0 } })
  assert.ok(root.children.includes(ui.results[0]), 'a projection redraw must not remove the open reward dialog')

  ui.storeListener({ type: 'task.progress', payload: {} })
  assert.ok(root.children.includes(ui.results[0]), 'a progress redraw must not remove the open reward dialog')
})
