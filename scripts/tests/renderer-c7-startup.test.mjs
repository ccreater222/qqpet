import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  createLocalRepository,
  readLocalDeviceOverlayPreview,
} = await import('../../src/main/local-repository.ts')
const { provisionalSaveView } = await import('../../src/main/startup-view.ts')
const { startSave } = await import('../../src/shared/save-logic.ts')
const {
  desktopRendererRuntimeCapability,
  desktopStartupAuthority,
} = await import('../../src/main/renderer-runtime-flags.ts')
const {
  REMOTE_PROJECTION_CACHE_FORMAT,
  REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
  toDeviceLocalOverlay,
  toSharedSaveData,
  validateRemoteProjectionCacheV2,
} = await import('../../src/shared/sync/index.ts')

test('startup preview hydrates hd and petDisplayId before the window is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-startup-overlay-'))
  const legacyPath = join(dir, 'save.json')
  const documentPath = join(dir, 'save.v2.json')
  const legacy = startSave(null)
  legacy.havePet = true
  legacy.settings.hd = true
  legacy.settings.petDisplayId = 42
  legacy.settings.zoom = 1.5
  legacy.petInfo.lastX = 123
  legacy.petInfo.lastY = 456
  writeFileSync(legacyPath, JSON.stringify(legacy))

  const preview = readLocalDeviceOverlayPreview({ documentPath, legacySavePath: legacyPath })
  assert.ok(preview)
  assert.equal(preview.settings.hd, true)
  assert.equal(preview.settings.petDisplayId, 42)
  const view = provisionalSaveView(preview)
  assert.equal(view.settings.hd, true)
  assert.equal(view.settings.petDisplayId, 42)
  assert.equal(view.settings.zoom, 1.5)
  assert.equal(view.petInfo.lastX, 123)
  assert.equal(view.petInfo.lastY, 456)

  const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const previewIndex = mainSource.indexOf('previewDeviceOverlay()')
  const windowIndex = mainSource.indexOf('const win = createPetWindow()')
  const headerIndex = mainSource.indexOf('onBeforeSendHeaders')
  assert.ok(previewIndex >= 0 && headerIndex >= 0 && windowIndex > previewIndex)
  assert.ok(headerIndex > previewIndex)
  assert.match(mainSource, /if \(getSave\(\)\.settings\.hd\) requestHeaders\['X-HD'\] = '1'/)
})

test('startup preview reads the device overlay from an existing v2 document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-startup-v2-'))
  const documentPath = join(dir, 'save.v2.json')
  const initial = startSave(null)
  initial.havePet = true
  initial.settings.hd = true
  initial.settings.petDisplayId = 77
  initial.petInfo.lastX = 321
  initial.petInfo.lastY = 654
  const repository = createLocalRepository({
    documentPath,
    initialSave: initial,
    nowMs: () => 1_700_000_000_000,
    pollIntervalMs: 1_000_000,
    autoScheduler: false,
  }, {
    authorityState: 'local-v2-active',
    rendererCapability: true,
    env: {},
  })
  await repository.load()
  await repository.stop()

  const preview = readLocalDeviceOverlayPreview({ documentPath })
  assert.ok(preview)
  assert.equal(preview.settings.hd, true)
  assert.equal(preview.settings.petDisplayId, 77)
  assert.equal(preview.petInfo.lastX, 321)
  assert.equal(preview.petInfo.lastY, 654)
  assert.notEqual(preview.localDeviceId, 'startup-preview')
})

test('server-mode startup preview reads the active remote cache without a local v2 document', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-startup-server-cache-'))
  const legacyPath = join(dir, 'save.json')
  const documentPath = join(dir, 'save.v2.json')
  const storageConfigPath = join(dir, 'storage-config.json')
  const cacheSave = startSave(null)
  cacheSave.havePet = true
  cacheSave.settings.hd = true
  cacheSave.settings.petDisplayId = 73
  cacheSave.settings.zoom = 1.75
  cacheSave.petInfo.lastX = 456
  cacheSave.petInfo.lastY = 789
  const device = toDeviceLocalOverlay(cacheSave, 'server-cache-device')
  const cache = {
    format: REMOTE_PROJECTION_CACHE_FORMAT,
    schemaVersion: REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
    petId: 'pet-server-cache',
    deviceId: 'device-server-cache',
    revision: 4,
    eventSeq: 5,
    gameTimeMs: 1_700_000_000_000,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: {
      owner: 'server',
      authorityId: 'authority-server-cache',
      restoreGeneration: 1,
      epoch: 2,
      state: 'active',
    },
    shared: toSharedSaveData(cacheSave),
    device,
  }
  assert.equal(validateRemoteProjectionCacheV2(cache), true)
  writeFileSync(legacyPath, JSON.stringify(cache))
  writeFileSync(storageConfigPath, JSON.stringify({
    format: 'qqpet-storage-config',
    schemaVersion: 1,
    mode: 'server',
    serverUrl: 'wss://server.test/v1/sync',
    deviceLabel: 'Desktop',
  }))
  assert.equal(existsSync(documentPath), false)

  const preview = readLocalDeviceOverlayPreview({ documentPath, legacySavePath: legacyPath })
  assert.ok(preview)
  assert.equal(preview.localDeviceId, 'server-cache-device')
  assert.equal(preview.settings.hd, true)
  assert.equal(preview.settings.petDisplayId, 73)
  const view = provisionalSaveView(preview)
  assert.equal(view.settings.hd, true)
  assert.equal(view.settings.petDisplayId, 73)
  assert.equal(view.settings.zoom, 1.75)
  assert.equal(view.petInfo.lastX, 456)
  assert.equal(view.petInfo.lastY, 789)

  const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(mainSource, /viewHost\?\.onView\(\(view\) => \{\n\s*setSaveView\(view\)/)
})

test('runtime disable switch selects legacy or blocked startup consistently', () => {
  const disabled = { QQPET_LOCAL_REPOSITORY_V2: '0' }
  const capability = desktopRendererRuntimeCapability(disabled)
  assert.equal(capability.flagEnabled, false)
  assert.equal(capability.canActivate, false)
  assert.equal(capability.reason, 'flag_disabled')
  assert.equal(desktopStartupAuthority(false, disabled), 'legacy')
  assert.equal(desktopStartupAuthority(true, disabled), 'blocked')

  const dir = mkdtempSync(join(tmpdir(), 'qqpet-runtime-disabled-'))
  assert.throws(() => createLocalRepository({
    documentPath: join(dir, 'save.v2.json'),
  }, {
    authorityState: 'local-v2-active',
    rendererCapability: true,
    env: disabled,
  }), /flag_disabled/)
})
