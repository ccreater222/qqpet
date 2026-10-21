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

const { runtimeReadinessNotice, runtimeReady } = await import('../../src/renderer/pet/readiness.ts')
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

test('renderer installs the readiness banner from sync status', () => {
  const main = readFileSync(new URL('../../src/renderer/main.ts', import.meta.url), 'utf8')
  assert.match(main, /runtimeReadinessNotice/)
  assert.match(main, /onStoreSyncStatus/)
  assert.match(main, /runtimeReadiness/)
  const css = readFileSync(new URL('../../src/renderer/base.css', import.meta.url), 'utf8')
  assert.match(css, /#runtimeReadiness/)
})
