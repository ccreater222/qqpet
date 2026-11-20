import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../../src/renderer/ui/css/phone-panels.css', import.meta.url), 'utf8')
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].split(',').map((selector) => selector.trim()).filter(Boolean),
  body: match[2],
}))
const rule = (fragment) => {
  const exact = `body.qp-phone ${fragment}`
  const exactMatches = rules.filter((entry) => entry.selectors.includes(exact))
  if (exactMatches.length) return exactMatches.map((entry) => entry.body).join('\n')
  const found = rules.find((entry) => entry.selectors.some((selector) => selector.includes(fragment) && selector.startsWith('body.qp-phone')))
  assert.ok(found, `missing phone rule ${fragment}`)
  return found.body
}

test('every phone panel rule is scoped to body.qp-phone', () => {
  assert.ok(rules.length > 20, 'phone panel stylesheet is missing')
  for (const entry of rules) {
    for (const selector of entry.selectors) {
      assert.ok(selector.startsWith('body.qp-phone'), `${selector} is not scoped to the phone body`)
    }
  }
})

test('phone dialogs, status, chat and settings get finger-sized geometry', () => {
  const dialog = rule('.ui-window .windowView:not(.sweetHeart)')
  assert.match(dialog, /width:\s*min\(340px,\s*92vw\)/)
  assert.match(dialog, /font-size:\s*15px/)
  assert.match(rule('.windowView:not(.sweetHeart) .windowViewButSubmit'), /height:\s*48px/)

  const state = rule('.ui-state .PetStateInfo')
  assert.match(state, /width:\s*min\(360px,\s*92vw\)/)
  assert.match(state, /font-size:\s*14px/)
  assert.match(rule('.ui-state .slotMain .onceInfo'), /min-height:\s*28px/)
  assert.match(rule('.ui-state .close'), /width:\s*var\(--qp-tap-sm\)/)

  const chat = rule('.ui-chat .chatMain')
  assert.match(chat, /width:\s*92vw/)
  assert.match(chat, /height:\s*60vh/)
  assert.match(rule('.ui-chat .chatInput'), /height:\s*var\(--qp-tap-sm\)/)
  assert.match(rule('.ui-chat .chatSend'), /height:\s*var\(--qp-tap-sm\)/)

  const setup = rule('.ui-setup2 .spanel')
  assert.match(setup, /width:\s*92vw/)
  assert.match(rule('.ui-setup2 .sinput'), /height:\s*var\(--qp-tap-sm\)/)
  assert.match(rule('.ui-setup2 .scheck'), /min-height:\s*48px/)
})

test('the phone goods sheet keeps 56 dp rows and 44 dp paging', () => {
  assert.match(rule('.qp-goods-row'), /min-height:\s*64px/)
  assert.match(rule('.qp-goods-pager .qp-btn'), /min-height:\s*var\(--qp-tap-sm\)/)
  assert.match(rule('.qp-goods-stat-value'), /font-size:\s*13px/)
})
