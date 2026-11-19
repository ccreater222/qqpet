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
})

const {
  RuntimeReadinessBanner,
  runtimeReadinessNotice,
  runtimeReady,
} = await import('../../src/renderer/pet/readiness.ts')
const {
  desktopRendererRuntimeCapability,
  desktopRuntimeRollbackRequested,
  desktopStartupAuthority,
  LOCAL_V2_ROLLBACK_ENV_FLAG,
} = await import('../../src/main/renderer-runtime-flags.ts')
const { mobileLocalRepositoryCapability } = await import('../../src/mobile/local-repository-bridge.ts')

test('runtime readiness explains catch-up, handoff and read-only states', () => {
  assert.equal(runtimeReadinessNotice(null), null)
  assert.equal(runtimeReadinessNotice({ connection: 'local' }), null)
  assert.equal(runtimeReadinessNotice({ connection: 'catching_up' }), '宠物数据同步中，请稍候…')
  assert.equal(runtimeReadinessNotice({ connection: 'local', catchingUp: true }), '宠物数据同步中，请稍候…')
  assert.equal(runtimeReadinessNotice({ connection: 'offline' }), '宠物数据暂时只读，同步完成后可继续操作')
  assert.equal(runtimeReadinessNotice({ connection: 'local', readOnly: true }), '宠物数据暂时只读，同步完成后可继续操作')
  assert.equal(runtimeReadinessNotice({ connection: 'local', state: 'read_only' }), '宠物数据暂时只读，同步完成后可继续操作')
  assert.equal(runtimeReadinessNotice({ connection: 'local', authorityState: 'handoff_pending' }), '宠物数据正在交接，请稍候…')
  assert.equal(runtimeReady({ connection: 'local' }), true)
  assert.equal(runtimeReady({ connection: 'catching_up' }), false)
})

test('rollback flag forces the legacy writer even with runtime activation flags set', () => {
  assert.equal(desktopRendererRuntimeCapability({}).canActivate, true, 'local runtime is the default authority')
  const active = { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }
  assert.equal(desktopRuntimeRollbackRequested(active), false)
  assert.equal(desktopRendererRuntimeCapability(active).canActivate, true)
  const rollback = { ...active, [LOCAL_V2_ROLLBACK_ENV_FLAG]: '1' }
  assert.equal(desktopRuntimeRollbackRequested(rollback), true)
  const capability = desktopRendererRuntimeCapability(rollback)
  assert.equal(capability.canActivate, false)
  assert.equal(capability.reason, 'rollback_flag')
  // An existing v2 authority document still blocks legacy writes after rollback.
  assert.equal(desktopStartupAuthority(true, rollback), 'blocked')
  assert.equal(desktopStartupAuthority(false, rollback), 'legacy')
})

test('mobile capability never advertises server mode', () => {
  const capability = mobileLocalRepositoryCapability({
    storage: { capability: { available: true, atomic: true, backup: true } },
    devRuntimeFlag: true,
    rendererCapability: true,
  })
  assert.equal(capability.serverMode, false)
})

test('readiness stays visible when startup catch-up completes before the listener and replays after replacement', async () => {
  const statusListeners = []
  const status = { connection: 'catching_up', catchingUp: true }
  const source = {
    onSyncStatus(listener) {
      statusListeners.splice(0, statusListeners.length, listener)
    },
    async getStatus() {
      return status
    },
  }
  const element = { hidden: true, textContent: '' }
  new RuntimeReadinessBanner(element, source)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(element.hidden, false)
  assert.equal(element.textContent, '宠物数据同步中，请稍候…')

  statusListeners[0]({ connection: 'local' })
  assert.equal(element.hidden, true)
  statusListeners[0]({ connection: 'offline', readOnly: true })
  assert.equal(element.hidden, false)
  assert.equal(element.textContent, '宠物数据暂时只读，同步完成后可继续操作')

  source.getStatus = () => ({ connection: 'catching_up', catchingUp: true })
  new RuntimeReadinessBanner(element, source)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(element.hidden, false)
  assert.equal(element.textContent, '宠物数据同步中，请稍候…')
  const css = readFileSync(new URL('../../src/renderer/base.css', import.meta.url), 'utf8')
  assert.match(css, /#runtimeReadiness/)
})

test('mobile bridges default to local runtime and expose the rollback build flag', () => {
  for (const relative of ['src/android/bridge.ts', 'src/harmony/bridge.ts', 'src/ios/bridge.ts']) {
    const source = readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
    assert.match(source, /VITE_QQPET_LOCAL_RUNTIME_V2_ROLLBACK/)
    assert.match(source, /LOCAL_RUNTIME_V2_FLAG = LOCAL_RUNTIME_V2_ROLLBACK === false/)
  }
  // Android bundles the client-only server host; iOS/Harmony stay local-only.
  const android = readFileSync(new URL('../../src/android/bridge.ts', import.meta.url), 'utf8')
  assert.match(android, /serverMode: serverRuntime !== null/)
  assert.match(android, /serverModeClientOnly: serverRuntime !== null/)
  for (const relative of ['src/harmony/bridge.ts', 'src/ios/bridge.ts']) {
    const source = readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
    assert.match(source, /serverMode:\s*false/)
  }
})

test('legacy migration keeps the host backup/readiness path', () => {
  const host = readFileSync(new URL('../../src/shared/local-repository/host.ts', import.meta.url), 'utf8')
  assert.match(host, /migrateLegacy/)
  assert.match(host, /backup/)
})
