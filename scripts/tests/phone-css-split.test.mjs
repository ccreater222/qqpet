import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rendererDir = fileURLToPath(new URL('../../src/renderer', import.meta.url))

/** Every stylesheet that only the phone layout is allowed to parse. */
const PHONE_CSS = [
  'ui/mobile/mobile.css',
  'ui/mobile/menu-phone.css',
  'ui/mobile/phone-shop.css',
  'ui/mobile/phone-games.css',
  'ui/css/phone-pages.css',
  'ui/css/phone-panels.css',
]

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})

test('the six phone stylesheets are imported only by the lazy phone-css module', () => {
  const phoneCssPath = resolve(rendererDir, 'ui/mobile/phone-css.ts')
  const phoneCss = readFileSync(phoneCssPath, 'utf8')
  for (const css of PHONE_CSS) {
    const relative = css.startsWith('ui/css/')
      ? `../css/${css.slice('ui/css/'.length)}`
      : `./${css.slice('ui/mobile/'.length)}`
    assert.ok(phoneCss.includes(`'${relative}'`), `phone-css.ts must import ${css}`)
  }

  const importers = new Map(PHONE_CSS.map((css) => [resolve(rendererDir, css), []]))
  for (const file of walk(rendererDir).filter((name) => name.endsWith('.ts'))) {
    if (file === phoneCssPath) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) {
      const target = resolve(dirname(file), match[1])
      if (importers.has(target)) importers.get(target).push(file)
    }
  }
  for (const [css, files] of importers) {
    assert.deepEqual(files, [], `${css} must not be imported eagerly: ${files.join(', ')}`)
  }
})

test('bootstrap loads the phone CSS before main whenever the phone layout is active', () => {
  const bootstrap = readFileSync(resolve(rendererDir, 'bootstrap.ts'), 'utf8')
  const gate = bootstrap.indexOf('if (phoneUI()) await import(')
  assert.ok(gate >= 0, 'bootstrap must gate the phone stylesheet on phoneUI()')
  const cssLoad = bootstrap.indexOf("import('./ui/mobile/phone-css')", gate)
  const mainLoad = bootstrap.indexOf("await import('./main')")
  assert.ok(cssLoad > gate, 'the phone stylesheet load must be the gated statement')
  assert.ok(mainLoad > cssLoad, 'the phone stylesheet must be loaded before the eager UI imports')
})

// When a desktop build exists, prove the split on the real artifact instead of only the source graph.
const assets = new URL('../../out/renderer/assets/', import.meta.url)
if (existsSync(assets)) {
  test('the built desktop CSS has no qp-phone rules; a phone stylesheet carries them', () => {
    const files = readdirSync(assets).filter((name) => name.endsWith('.css'))
    const main = files.find((name) => name.startsWith('main-'))
    assert.ok(main, 'desktop build must emit a main-*.css')
    const mainCss = readFileSync(new URL(main, assets), 'utf8')
    // Distinctive classes from the six moved stylesheets; shared feature sheets (smallgame/mstx)
    // may keep their own small body.qp-phone overrides.
    for (const marker of ['qp-sheet', 'qp-menu-card', 'qp-goods-row', 'qp-games-sheet', 'qp-email-row', 'qp-panel']) {
      assert.ok(!mainCss.includes(marker), `desktop main CSS must not contain ${marker}`)
    }
    const phone = files.filter((name) => name !== main).find((name) => readFileSync(new URL(name, assets), 'utf8').includes('qp-menu-card'))
    assert.ok(phone, 'the dynamic phone chunk must carry the phone rules')
  })
}
