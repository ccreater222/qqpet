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

const { createSyncFixtures, SEED, WALL_TIME_MS } = await import('./sync-fixtures.mjs')
const {
  classifyProjectionDelivery,
  createRendererProjection,
  legacyRendererStatus,
  rejectedCommandResult,
  toCommandResult,
  wireAuthorityFromLocal,
} = await import('../../src/shared/renderer-api.ts')
const {
  applyLocalOverlayInPlace,
  assertDeviceLocalSavePatch,
  CanonicalMutationBlockedError,
  classifySavePatch,
  hydrateSaveProjection,
} = await import('../../src/shared/renderer-projection.ts')
const {
  mergeDeviceLocalOverlay,
  sanitizeDeviceLocalOverlayPatch,
  toDeviceLocalOverlay,
} = await import('../../src/shared/sync/data-boundary.ts')
const {
  invalidateProjectionCaches,
  projectionCacheHookCount,
  registerProjectionCacheInvalidator,
} = await import('../../src/renderer/pet/projection-cache.ts')
const { createRendererRuntimePreload } = await import('../../src/preload/renderer-api.ts')
const { desktopRendererRuntimeCapability } = await import('../../src/main/renderer-runtime-flags.ts')
const {
  createMobileLocalRepositoryBridge,
  mobileLocalRepositoryCapability,
} = await import('../../src/mobile/local-repository-bridge.ts')

const fixtures = createSyncFixtures()
const AUTHORITY = {
  owner: 'local',
  authorityId: 'authority-c6a',
  restoreGeneration: 1,
  epoch: 1,
  state: 'active',
}

function projection(overrides = {}) {
  const shared = structuredClone(fixtures.shared)
  const device = structuredClone(fixtures.device)
  Object.assign(shared.petInfo, overrides.sharedPetInfo ?? {})
  Object.assign(shared.saveJsonData, overrides.sharedJson ?? {})
  Object.assign(device.petInfo, overrides.devicePetInfo ?? {})
  Object.assign(device.settings, overrides.deviceSettings ?? {})
  return createRendererProjection({
    shared,
    device,
    revision: overrides.revision ?? 3,
    eventSeq: overrides.eventSeq ?? 2,
    gameTimeMs: WALL_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: overrides.authority ?? AUTHORITY,
  })
}

function event(eventSeq, type = 'task.progress') {
  return { eventSeq, revision: 3, gameTimeMs: WALL_TIME_MS, type, payload: {} }
}

test('preload command surface forwards the unified typed IPC channels', async () => {
  const invokes = []
  const listeners = new Map()
  const removed = []
  const ipc = {
    async invoke(channel, ...args) { invokes.push([channel, ...args]); return null },
    on(channel, listener) { listeners.set(channel, listener) },
    removeAllListeners(channel) { removed.push(channel) },
  }
  const api = createRendererRuntimePreload(ipc)
  await api.runtimeInfo()
  await api.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 1 } }, { opId: 'op-c6a' })
  await api.setAdvanceWhileEmpty(false)
  await api.localSettings.load()
  await api.localSettings.update({ petInfo: { lastX: 12 }, settings: { zoom: 1.25 } })
  await api.flush()
  await api.getProjection()
  await api.getStatus()
  assert.deepEqual(invokes.map(([channel]) => channel), [
    'pet:runtime-info',
    'pet:command',
    'pet:set-advance-while-empty',
    'pet:local-settings-load',
    'pet:local-settings-update',
    'pet:flush',
    'pet:get-projection',
    'pet:get-status',
  ])
  assert.deepEqual(invokes[1][1], { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 1 } })
  assert.deepEqual(invokes[1][2], { opId: 'op-c6a' })
  assert.deepEqual(invokes[4][1], { petInfo: { lastX: 12 }, settings: { zoom: 1.25 } })

  const deliveries = []
  api.onProjection((value, events) => deliveries.push([value, events]))
  assert.deepEqual(removed, ['pet:projection'])
  const projectionValue = projection()
  listeners.get('pet:projection')({}, projectionValue, [event(1)])
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0][0], projectionValue)
  assert.equal(deliveries[0][1][0].eventSeq, 1)

  api.onResync(() => {})
  assert.ok(removed.includes('pet:resync'))
})

test('projection hydration preserves petInfo/settings identities and local presentation caches', () => {
  const save = structuredClone(fixtures.save)
  save.saveJsonData.task = '{"old":true}'
  save.saveJsonData.community = '{"x":9,"y":8}'
  const infoRef = save.petInfo
  const settingsRef = save.settings
  const oldIllustrated = save.illustrated
  const next = projection({
    sharedPetInfo: { yb: fixtures.shared.petInfo.yb + 77, growth: 1234 },
    sharedJson: { task: '{"fresh":true}' },
    devicePetInfo: { lastX: 71, lastY: 72 },
    deviceSettings: { zoom: 1.4 },
    eventSeq: 0,
    revision: 4,
  })
  const result = hydrateSaveProjection(save, next)
  assert.equal(save.petInfo, infoRef)
  assert.equal(save.settings, settingsRef)
  assert.equal(save.petInfo.yb, fixtures.shared.petInfo.yb + 77)
  assert.equal(save.petInfo.lastX, 71)
  assert.equal(save.petInfo.lastY, 72)
  assert.equal(save.settings.zoom, 1.4)
  assert.equal(save.settings.paused, fixtures.shared.settings.paused)
  assert.equal(save.saveJsonData.task, '{"fresh":true}')
  assert.equal(save.saveJsonData.community, '{"x":9,"y":8}')
  if (JSON.stringify(oldIllustrated) !== JSON.stringify(next.save.illustrated)) {
    assert.notEqual(save.illustrated, oldIllustrated)
  }
  assert.ok(result.infoChanges.some(change => change.key === 'yb'))
  assert.ok(Object.hasOwn(result.settingsChanges, 'zoom'))
  assert.ok(result.changedJsonKeys.includes('task'))
  assert.equal(result.sharedChanged, true)
})

test('projection delivery stops on gaps and never applies stale snapshots', () => {
  assert.equal(classifyProjectionDelivery(null, { revision: 1, eventSeq: 1 }, []).kind, 'resync')
  assert.equal(classifyProjectionDelivery(
    { revision: 1, eventSeq: 1 },
    { revision: 2, eventSeq: 3 },
    [event(2), event(3)],
  ).kind, 'projection')
  assert.equal(classifyProjectionDelivery(
    { revision: 1, eventSeq: 1 },
    { revision: 2, eventSeq: 4 },
    [event(3), event(4)],
  ).kind, 'resync')
  assert.equal(classifyProjectionDelivery(
    { revision: 3, eventSeq: 4 },
    { revision: 2, eventSeq: 3 },
    [],
  ).kind, 'stale')
  assert.equal(classifyProjectionDelivery(
    { revision: 1, eventSeq: 1 },
    { revision: 2, eventSeq: 3 },
    [event(3), event(2)],
  ).kind, 'resync')
  assert.equal(classifyProjectionDelivery(
    { revision: 2, eventSeq: 2 },
    { revision: 2, eventSeq: 2 },
    [],
  ).kind, 'projection')
  assert.equal(classifyProjectionDelivery(
    { revision: 5, eventSeq: 9, owner: 'local', authorityId: 'a', authorityEpoch: 1, restoreGeneration: 1 },
    { revision: 1, eventSeq: 1, authority: { owner: 'local', authorityId: 'a', epoch: 2, restoreGeneration: 1 } },
    [],
  ).kind, 'resync')
  assert.equal(classifyProjectionDelivery(
    { revision: 5, eventSeq: 9, owner: 'local', authorityId: 'a', authorityEpoch: 2, restoreGeneration: 1 },
    { revision: 1, eventSeq: 1, authority: { owner: 'local', authorityId: 'a', epoch: 1, restoreGeneration: 1 } },
    [],
  ).kind, 'stale')
})

test('feature-cache invalidation hooks fire for relevant events/json blobs and full resync', () => {
  const fired = []
  const unsubscribers = [
    registerProjectionCacheInvalidator('tasks', () => fired.push('tasks')),
    registerProjectionCacheInvalidator('signin', () => fired.push('signin')),
    registerProjectionCacheInvalidator('fishing', () => fired.push('fishing')),
    registerProjectionCacheInvalidator('island', () => fired.push('island')),
    registerProjectionCacheInvalidator('farm', () => fired.push('farm')),
  ]
  assert.equal(projectionCacheHookCount('tasks'), 1)
  assert.deepEqual(
    invalidateProjectionCaches({ eventTypes: ['task.progress', 'signin.changed'] }).sort(),
    ['signin', 'tasks'],
  )
  assert.deepEqual(invalidateProjectionCaches({ changedJsonKeys: ['fishs'] }), ['fishing'])
  assert.deepEqual(invalidateProjectionCaches({ full: true }).sort(), ['farm', 'fishing', 'island', 'signin', 'tasks'])
  for (const unsubscribe of unsubscribers) unsubscribe()
  assert.equal(projectionCacheHookCount('tasks'), 0)

  const files = [
    ['src/renderer/pet/tasks.ts', 'tasks'],
    ['src/renderer/pet/signin.ts', 'signin'],
    ['src/renderer/pet/fishing.ts', 'fishing'],
    ['src/renderer/ui/island.ts', 'island'],
    ['src/renderer/ui/farm.ts', 'farm'],
  ]
  for (const [file, feature] of files) {
    assert.match(readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), new RegExp("registerProjectionCacheInvalidator\\('" + feature + "'"))
  }
})

test('runtime localSettings writes never touch canonical gameplay; legacy patches fail closed', () => {
  const save = structuredClone(fixtures.save)
  const infoRef = save.petInfo
  const settingsRef = save.settings
  const canonicalYb = save.petInfo.yb
  const classified = classifySavePatch({
    petInfo: { lastX: 33, lastY: 44 },
    settings: { zoom: 1.2, hd: true },
    saveJsonData: { community: '{"x":1}' },
  })
  assert.deepEqual(classified.canonicalKeys, [])
  assert.deepEqual(classified.localPetInfo, { lastX: 33, lastY: 44 })
  assert.equal(classified.localSettings.zoom, 1.2)
  assert.equal(classified.presentation.community, '{"x":1}')

  for (const patch of [
    { petInfo: { yb: 999 } },
    { settings: { paused: true } },
    { activeOption: { work: 'x' } },
    { saveJsonData: { task: '{}' } },
  ]) {
    assert.throws(() => assertDeviceLocalSavePatch(patch), CanonicalMutationBlockedError)
  }

  const overlay = mergeDeviceLocalOverlay(toDeviceLocalOverlay(save, 'device-c6a'), {
    petInfo: { lastX: 33, lastY: 44 },
    settings: { zoom: 1.2, hd: true },
  })
  const result = applyLocalOverlayInPlace(save, { petInfo: overlay.petInfo, settings: overlay.settings })
  assert.equal(save.petInfo, infoRef)
  assert.equal(save.settings, settingsRef)
  assert.equal(save.petInfo.yb, canonicalYb)
  assert.equal(save.petInfo.lastX, 33)
  assert.equal(save.settings.zoom, 1.2)
  assert.ok(result.infoChanges.some(change => change.key === 'lastX'))
  assert.equal(result.settingsChanges.zoom, 1.2)

  assert.throws(() => sanitizeDeviceLocalOverlayPatch({ localDeviceId: 'other' }), /not allowed|unknown|unexpected|only/i)
  assert.throws(() => sanitizeDeviceLocalOverlayPatch({ settings: { notASetting: true } }), /not allowed|unknown|unexpected|only/i)
  assert.throws(() => sanitizeDeviceLocalOverlayPatch({ presentation: { task: '{}' } }), /canonical|forbidden/i)
})

test('command result conversion is notification-only and keeps all wire statuses', () => {
  const command = { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 5 } }
  const applied = toCommandResult({
    command,
    opId: 'op-applied',
    commandSeq: 2,
    revision: 7,
    eventSeq: 9,
    duplicate: false,
    outcome: { ok: true, state: {}, events: [], result: { granted: 5 } },
  })
  assert.equal(applied.status, 'applied')
  assert.deepEqual(applied.result, { granted: 5 })
  const duplicate = toCommandResult({
    command,
    opId: 'op-applied',
    commandSeq: 2,
    revision: 7,
    eventSeq: 9,
    duplicate: true,
    outcome: { ok: true, state: {}, events: [], result: { granted: 5 } },
  })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.original, 'applied')
  const rejected = rejectedCommandResult(command, 'op-legacy')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.error.code, 'authority_not_active')
  assert.equal(legacyRendererStatus().connection, 'local')

  const storeSource = readFileSync(new URL('../../src/renderer/pet/store.ts', import.meta.url), 'utf8')
  assert.equal((storeSource.match(/hydrateSaveProjection\(/g) ?? []).length, 1)
  assert.match(storeSource, /onCommandResult\(\(result\) => \{[\s\S]*?commandResultListeners[\s\S]*?\}\)/)
  assert.doesNotMatch(storeSource, /onCommandResult\([\s\S]{0,200}?hydrateSaveProjection/)
})

test('flag-off legacy capability never activates the renderer runtime', () => {
  assert.equal(desktopRendererRuntimeCapability({}).canActivate, false)
  assert.equal(desktopRendererRuntimeCapability({}).reason, 'flag_disabled')
  assert.equal(desktopRendererRuntimeCapability({ QQPET_LOCAL_REPOSITORY_V2: '1' }).reason, 'c6_activation_missing')
  const enabled = desktopRendererRuntimeCapability({
    QQPET_LOCAL_REPOSITORY_V2: '1',
    QQPET_LOCAL_V2_ACTIVE: '1',
  })
  assert.equal(enabled.canActivate, true)
  assert.equal(wireAuthorityFromLocal({
    state: 'active',
    stamp: {
      owner: 'local', authorityId: 'a', epoch: 2, restoreGeneration: 1,
      revision: 4, eventSeq: 5, handoffId: 'h', detachedAtWallMs: 0,
    },
  }).state, 'active')
})

function memoryStorage(initial = {}) {
  const files = new Map(Object.entries(initial))
  const storage = {
    capability: { kind: 'c6a-test', atomicDocument: true, backup: true },
    async readDocument() { return files.get('save.v2.json') ?? null },
    async writeDocumentAtomic(text) { files.set('save.v2.json', text) },
    async readLegacySave() { return files.get('save.json') ?? null },
    async backupLegacySave() {},
    async backupDocument() {},
    async preserveCorruptDocument() {},
  }
  return { storage, files }
}

test('mobile host exposes the same surface and fails closed without capability', async () => {
  const memory = memoryStorage({ 'save.json': JSON.stringify(fixtures.save) })
  assert.equal(mobileLocalRepositoryCapability({
    storage: memory.storage,
    devRuntimeFlag: true,
    rendererCapability: false,
  }).canActivate, false)
  assert.throws(() => createMobileLocalRepositoryBridge({
    storage: memory.storage,
    devRuntimeFlag: true,
    rendererCapability: false,
  }), /renderer_capability_missing/)

  const projections = []
  const resyncs = []
  const statuses = []
  const bridge = createMobileLocalRepositoryBridge({
    storage: memory.storage,
    devRuntimeFlag: true,
    rendererCapability: true,
    nowMs: () => WALL_TIME_MS,
    randomUUID: (() => { let n = 0; return () => 'c6a-mobile-' + String(++n).padStart(4, '0') })(),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    localDeviceId: 'c6a-mobile-device',
    appInstanceId: 'c6a-mobile-app',
    autoScheduler: false,
    pollIntervalMs: 1_000_000,
  })
  bridge.onProjection((value, events) => projections.push([value, events]))
  bridge.onResync((value, events) => resyncs.push([value, events]))
  bridge.onSyncStatus(status => statuses.push(status))
  const loaded = await bridge.load()
  assert.ok(loaded.havePet)
  assert.ok(resyncs.length >= 1)
  assert.equal(bridge.getStatus().serverMode, false)
  assert.equal((await bridge.runtimeInfo()).localRepositoryV2, true)
  const before = bridge.getProjection().shared.petInfo.yb
  const command = await bridge.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 5 } },
    { opId: 'c6a-mobile-op' },
  )
  assert.equal(command.status, 'applied')
  assert.ok(projections.length >= 1)
  const afterCommand = bridge.getProjection().shared.petInfo.yb
  const overlay = await bridge.localSettings.update({
    petInfo: { lastX: 123, lastY: 45 },
    settings: { zoom: 1.3 },
  })
  assert.equal(overlay.petInfo.lastX, 123)
  assert.equal(bridge.getProjection().save.petInfo.lastX, 123)
  assert.equal(bridge.getProjection().shared.petInfo.yb, afterCommand)
  assert.ok(statuses.length >= 1)
  await bridge.stop()
})
