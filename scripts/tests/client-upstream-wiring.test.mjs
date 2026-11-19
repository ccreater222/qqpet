import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Client data upstream wiring: no hardcoded third-party host, and every data call passes the qqpet-server base the
// host resolved (paired server on desktop, else the device-local setting). Static, so the four hosts stay in step
// without booting Electron, a WebView or a native shell.

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('the desktop main process resolves one upstream base: paired server first, else the device setting', () => {
  const main = source('src/main/index.ts')
  assert.match(main, /status\.activeMode === 'server' && status\.serverUrl\) return httpBaseFromServerUrl\(status\.serverUrl\)/)
  assert.match(main, /normalizeUpstreamUrl\(getSave\(\)\.settings\.upstreamUrl\)/)
  // The three runtime data calls all go through it; the calendar computes locally when it is null.
  assert.match(main, /ipcMain\.handle\(IPC\.calendar, \(\) => calendar\(net\.fetch, clientUpstreamBase\(\)\)\)/)
  assert.match(main, /ipcMain\.handle\(IPC\.weather, \(_e, city: string\) => weather\(net\.fetch, clientUpstreamBase\(\), weatherCity\(city\)\)\)/)
  assert.match(main, /ipcMain\.handle\(IPC\.latestRelease, \(\) => latestRelease\(net\.fetch, clientUpstreamBase\(\)\)\)/)
  // Server storage mode asks for the pet's canonical city, not the renderer's copy.
  assert.match(main, /status\.activeMode === 'server' \? status\.weatherCity : requested/)
})

test('the three mobile bridges hand their device-local upstream to the shared data modules', () => {
  for (const file of ['src/android/bridge.ts', 'src/harmony/bridge.ts', 'src/ios/bridge.ts']) {
    const s = source(file)
    assert.match(s, /import \{ normalizeUpstreamUrl \} from '\.\.\/shared\/upstream'/, file)
    assert.match(s, /normalizeUpstreamUrl\((?:save\.settings|model\?\.settings)\.upstreamUrl\)/, file)
    assert.match(s, /calendar: \(\) => calendar\(nativeFetch, upstreamBase\(\)\)/, file)
    assert.match(s, /weather: \(city\) => weather\(nativeFetch, upstreamBase\(\), city\)/, file)
    assert.match(s, /latestRelease: \(\) => latestRelease\(nativeFetch, upstreamBase\(\)\)/, file)
    assert.doesNotMatch(s, /ankio\.net|api\.ankio/, file)
  }
})

test('the pack IPC takes the first-run address and keeps the base the index came from', () => {
  const firstRun = source('src/main/first-run.ts')
  const content = source('src/main/content.ts')
  assert.match(firstRun, /registerPackIpc\(getBase: \(\) => string \| null\)/)
  assert.match(firstRun, /normalizeUpstreamUrl\(value\)/)
  assert.match(firstRun, /findFullPack\(net\.fetch, offersFrom\)/)
  assert.match(firstRun, /downloadPack\(net\.fetch, offersFrom,/)
  assert.match(firstRun, /findPack\(net\.fetch, base\)/)
  // The GitHub index and the download mirror are gone: packs come from the upstream that served packs.json.
  assert.doesNotMatch(firstRun + content, /github\.com|mirror|ghfast/i)
  assert.match(content, /packsIndexUrl\(base\)/)
  assert.match(content, /base: base \|\| packsBase/)
})

test('preload forwards the address under the names PackApi documents', () => {
  const preload = source('src/preload/index.ts')
  assert.match(preload, /findFull: \(serverUrl\) => ipcRenderer\.invoke\(IPC\.findFullPack, serverUrl\)/)
  assert.match(preload, /download: \(serverUrl\) => ipcRenderer\.invoke\(IPC\.downloadPack, serverUrl\)/)
})

test('the renderer explains a missing upstream and adopts the first-run address', () => {
  const update = source('src/renderer/ui/update.ts')
  assert.match(update, /UPSTREAM_NOT_CONFIGURED/)
  assert.match(update, /未配置上游服务器，无法检查更新/)
  // Automatic checks stay silent; only a manual one speaks.
  assert.match(update, /if \(!manual\) return/)
  assert.match(update, /localStorage\.getItem\(FIRST_RUN_UPSTREAM_KEY\)/)
  assert.match(update, /update\('settings', \{ upstreamUrl: address \}\)/)
  assert.match(update, /adoptFirstRunUpstream\(\)/)

  const setup = source('src/renderer/ui/setup.ts')
  assert.match(setup, /label: '上游服务器（qqpet-server 地址）'/)
  assert.match(setup, /value: \(\) => s\.upstreamUrl/)
  assert.match(setup, /留空按上游服务器网络位置自动定位/)
  assert.match(setup, /upstreamMissing\(e\)/)

  const firstrun = source('src/renderer/firstrun.ts')
  assert.match(firstrun, /FIRST_RUN_UPSTREAM_KEY/)
  assert.match(firstrun, /flow\.download\(serverUrl\.value\)/)
  assert.doesNotMatch(firstrun, /ghfast|GitHub 加速|下载镜像/)
})
