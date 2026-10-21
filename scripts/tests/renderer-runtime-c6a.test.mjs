import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

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
  assertBooleanIpcInput,
  assertCommandIpcInput,
  classifyProjectionDelivery,
  createRendererProjection,
  legacyRendererStatus,
  orderedEventsFromHistory,
  rejectedCommandResult,
  requirePortableImportProjection,
  toCommandResult,
  wireAuthorityFromLocal,
} = await import('../../src/shared/renderer-api.ts')
const {
  applyLocalOverlayInPlace,
  applyPresentationInPlace,
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
const {
  desktopRendererRuntimeCapability,
  desktopStartupAuthority,
  LOCAL_V2_DOCUMENT_NAME,
  LOCAL_V2_ROLLBACK_ENV_FLAG,
} = await import('../../src/main/renderer-runtime-flags.ts')
const {
  createMobileLocalRepositoryBridge,
  mobileLocalRepositoryCapability,
} = await import('../../src/mobile/local-repository-bridge.ts')
const { createLocalRepository } = await import('../../src/main/local-repository.ts')
const { shouldStartVoice } = await import('../../src/main/voice-startup.ts')
const { bootRenderer, mountLanVisits } = await import('../../src/renderer/pet/runtime-boot.ts')
const { runtimeMenuItems } = await import('../../src/renderer/ui/runtime-menu.ts')

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
  await api.requestResync()
  await api.getProjection()
  await api.getStatus()
  assert.deepEqual(invokes.map(([channel]) => channel), [
    'pet:runtime-info',
    'pet:command',
    'pet:set-advance-while-empty',
    'pet:local-settings-load',
    'pet:local-settings-update',
    'pet:flush',
    'pet:request-resync',
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

test('store replays projections buffered between initial load and listener registration', () => {
  const initialSave = structuredClone(fixtures.save)
  const initialYb = initialSave.petInfo.yb
  const buffered = projection({
    revision: 4,
    eventSeq: 3,
    sharedPetInfo: { yb: initialYb + 9 },
  })
  const bufferedEvent = { ...event(3), revision: 4, gameTimeMs: WALL_TIME_MS }
  const bufferedGap = projection({
    revision: 6,
    eventSeq: 5,
    sharedPetInfo: { yb: initialYb + 20 },
  })
  const bufferedGapEvent = { ...event(5), revision: 6, gameTimeMs: WALL_TIME_MS }
  const resyncSnapshot = projection({
    revision: 7,
    eventSeq: 5,
    sharedPetInfo: { yb: initialYb + 30 },
  })
  const storeSource = readFileSync(new URL('../../src/renderer/pet/store.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(storeSource)
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const callbacks = {}
  let resyncRequests = 0
  let legacySaves = 0
  let resyncSnapshotForRequest = resyncSnapshot
  const window = {
    __qqpetInitialSave: initialSave,
    __qqpetRuntimeV2: true,
    __qqpetInitialProjectionCursor: {
      revision: 3,
      eventSeq: 2,
      owner: 'local',
      authorityId: buffered.authority.authorityId,
      authorityEpoch: buffered.authority.epoch,
      restoreGeneration: buffered.authority.restoreGeneration,
    },
    __qqpetBufferedProjections: [
      { kind: 'projection', projection: buffered, events: [bufferedEvent] },
      { kind: 'projection', projection: bufferedGap, events: [bufferedGapEvent] },
    ],
    qqpet: {
      onProjection(callback) { callbacks.projection = callback },
      onResync(callback) { callbacks.resync = callback },
      onCommandResult() {},
      onSyncStatus() {},
      requestResync: async () => {
        resyncRequests++
        if (resyncSnapshotForRequest !== null) callbacks.resync(resyncSnapshotForRequest, [])
      },
      localSettings: { update: async () => ({ petInfo: {}, settings: {} }) },
      flush: async () => {},
      save() { legacySaves++ },
      setTrayState() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
  }
  const store = runInNewContext(code + '\n;({ save, runtimeProjectionMode, getProjectionCursor: () => projectionCursor })', {
    window,
    addEventListener() {},
    classifyProjectionDelivery,
    hydrateSaveProjection,
    invalidateProjectionCaches,
    applyLocalOverlayInPlace,
    applyPresentationInPlace,
    assertDeviceLocalSavePatch,
  })
  assert.equal(store.runtimeProjectionMode, true)
  assert.equal(store.save.havePet, true)
  assert.equal(legacySaves, 0, 'projection boot must never forward a legacy save patch')
  assert.equal(store.save.petInfo.yb, initialYb + 30, 'a reentrant resync during handoff is not lost')
  assert.equal(resyncRequests, 1)
  assert.equal(store.getProjectionCursor().revision, 7)
  assert.equal(store.getProjectionCursor().eventSeq, 5)

  const beforeGapYb = store.save.petInfo.yb
  resyncSnapshotForRequest = null
  const gap = projection({ revision: 9, eventSeq: 7, sharedPetInfo: { yb: beforeGapYb + 20 } })
  callbacks.projection(gap, [{ ...event(7), revision: 9, gameTimeMs: WALL_TIME_MS }])
  assert.equal(resyncRequests, 2, 'a gap requests a full resync')
  assert.equal(store.save.petInfo.yb, beforeGapYb, 'a gap is not applied speculatively')
  callbacks.resync(gap, [])
  assert.equal(store.save.petInfo.yb, beforeGapYb + 20, 'the requested resync applies the full snapshot')
  assert.equal(store.getProjectionCursor().revision, 9)
  assert.equal(store.getProjectionCursor().eventSeq, 7)
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
  const historical = orderedEventsFromHistory([
    { eventSeq: 1, revision: 2, commandSeq: 1, gameTimeMs: WALL_TIME_MS, type: 'admin.grant', payload: {} },
    { eventSeq: 2, revision: 4, gameTimeMs: WALL_TIME_MS + 60_000, type: 'pet.statsChanged', payload: {} },
  ], { revision: 99, gameTimeMs: 99 })
  assert.equal(historical[0].revision, 2)
  assert.equal(historical[0].commandSeq, 1)
  assert.equal(historical[1].revision, 4)
  assert.equal(historical[1].gameTimeMs, WALL_TIME_MS + 60_000)
  assert.doesNotThrow(() => assertCommandIpcInput(command, { opId: 'op-safe' }))
  assert.throws(() => assertCommandIpcInput({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 'x' } }), /invalid_payload/)
  assert.throws(() => assertCommandIpcInput({ type: 'unknown.command', payload: {} }), /invalid_payload/)
  assert.throws(() => assertCommandIpcInput(command, { opId: 'x'.repeat(129) }), /invalid_payload/)
  assert.throws(
    () => assertBooleanIpcInput('yes', 'advanceWhileEmpty'),
    error => error.code === 'invalid_payload' && /invalid_payload/.test(error.message),
  )

  const storeSource = readFileSync(new URL('../../src/renderer/pet/store.ts', import.meta.url), 'utf8')
  assert.equal((storeSource.match(/hydrateSaveProjection\(/g) ?? []).length, 1)
  assert.match(storeSource, /onCommandResult\(\(result\) => \{[\s\S]*?commandResultListeners[\s\S]*?\}\)/)
  assert.doesNotMatch(storeSource, /onCommandResult\([\s\S]{0,200}?hydrateSaveProjection/)
})

test('runtime capability defaults on and rollback restores the legacy path', () => {
  assert.equal(desktopRendererRuntimeCapability({}).canActivate, true)
  const rollback = { [LOCAL_V2_ROLLBACK_ENV_FLAG]: '1' }
  assert.equal(desktopRendererRuntimeCapability(rollback).canActivate, false)
  assert.equal(desktopRendererRuntimeCapability(rollback).reason, 'rollback_flag')
  assert.equal(LOCAL_V2_DOCUMENT_NAME, 'save.v2.json')
  assert.equal(desktopStartupAuthority(true, {}), 'runtime')
  assert.equal(desktopStartupAuthority(false, {}), 'runtime')
  assert.equal(desktopStartupAuthority(true, { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }), 'runtime')
  assert.equal(desktopStartupAuthority(true, rollback), 'blocked')
  assert.equal(desktopStartupAuthority(false, rollback), 'legacy')
  const writers = []
  const runStartup = authority => {
    if (authority === 'legacy') writers.push('legacy')
    if (authority === 'runtime') writers.push('runtime')
  }
  runStartup(desktopStartupAuthority(true, {}))
  assert.deepEqual(writers, ['runtime'], 'the default runtime reuses an existing v2 document')
  runStartup(desktopStartupAuthority(true, rollback))
  assert.deepEqual(writers, ['runtime'], 'rollback never writes beside an existing v2 document')
  const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(mainSource, /desktopStartupAuthority\(existsSync\(v2Document\)\)/)
  assert.ok(mainSource.indexOf('desktopStartupAuthority(existsSync(v2Document))') < mainSource.indexOf('loadSave()', mainSource.indexOf('desktopStartupAuthority(existsSync(v2Document))')))
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
  let failWrites = false
  const storage = {
    capability: { kind: 'c6a-test', atomicDocument: true, backup: true },
    async readDocument() { return files.get('save.v2.json') ?? null },
    async writeDocumentAtomic(text) {
      if (failWrites) throw new Error('disk full')
      files.set('save.v2.json', text)
    },
    async readLegacySave() { return files.get('save.json') ?? null },
    async backupLegacySave() {},
    async backupDocument() {},
    async preserveCorruptDocument() {},
  }
  return { storage, files, failWrites(value) { failWrites = value } }
}

test('runtime mode leaves the main-process voice watcher and ASR preload off; legacy still honors settings.voice', () => {
  assert.equal(shouldStartVoice(true, true), false)
  assert.equal(shouldStartVoice(true, false), false)
  assert.equal(shouldStartVoice(false, false), false)
  assert.equal(shouldStartVoice(false, true), true)
  const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const startVoice = mainSource.slice(mainSource.indexOf('const startVoice ='), mainSource.indexOf('const stopVoice ='))
  assert.ok(startVoice.indexOf('shouldStartVoice(rendererRuntime !== null, getSave().settings.voice)') < startVoice.indexOf('parseHotkey'))
  assert.ok(startVoice.indexOf('shouldStartVoice(rendererRuntime !== null, getSave().settings.voice)') < startVoice.indexOf('watchHotkey'))
  assert.ok(startVoice.indexOf('shouldStartVoice(rendererRuntime !== null, getSave().settings.voice)') < startVoice.indexOf('preloadAsr'))
  assert.match(mainSource, /if \(shouldStartVoice\(rendererRuntime !== null, getSave\(\)\.settings\.voice\)\) startVoice\(\)/)
})

test('runtime boot with an existing pet starts presentation only, never the legacy loop or LAN visits', () => {
  const calls = []
  assert.equal(bootRenderer(true, true, {
    startProjectionPresentation: () => calls.push('projection'),
    startLegacy: () => calls.push('legacy'),
    startProjectionAdoption: () => calls.push('projection-adopt'),
    startAdoption: () => calls.push('adopt'),
  }), 'projection')
  assert.deepEqual(calls, ['projection'])
  assert.equal(mountLanVisits(true), false)
  assert.equal(mountLanVisits(false), true)

  calls.length = 0
  assert.equal(bootRenderer(false, true, {
    startProjectionPresentation: () => calls.push('projection'),
    startLegacy: () => calls.push('legacy'),
    startProjectionAdoption: () => calls.push('projection-adopt'),
    startAdoption: () => calls.push('adopt'),
  }), 'legacy')
  assert.deepEqual(calls, ['legacy'])

  calls.length = 0
  assert.equal(bootRenderer(true, false, {
    startProjectionPresentation: () => calls.push('projection'),
    startLegacy: () => calls.push('legacy'),
    startProjectionAdoption: () => calls.push('projection-adopt'),
    startAdoption: () => calls.push('adopt'),
  }), 'projection-adopt')
  assert.deepEqual(calls, ['projection-adopt'])

  calls.length = 0
  assert.equal(bootRenderer(false, false, {
    startProjectionPresentation: () => calls.push('projection'),
    startLegacy: () => calls.push('legacy'),
    startProjectionAdoption: () => calls.push('projection-adopt'),
    startAdoption: () => calls.push('adopt'),
  }), 'adopt')
  assert.deepEqual(calls, ['adopt'])

  const menuCalls = []
  const menuActions = {
    adopt: () => menuCalls.push('adopt'),
    leave: () => menuCalls.push('leave'),
    openState: () => menuCalls.push('state'),
    openShop: () => menuCalls.push('shop'),
    openGoods: (type) => menuCalls.push('goods:' + type),
    openPetInfo: () => menuCalls.push('info'),
    openSetup: () => menuCalls.push('setup'),
    openFishing: () => menuCalls.push('fishing'),
    openGames: () => menuCalls.push('games'),
    openIsland: () => menuCalls.push('island'),
    readopt: () => menuCalls.push('readopt'),
    bury: () => menuCalls.push('bury'),
    togglePaused: () => menuCalls.push('pause'),
    paused: false,
    dead: false,
    buried: false,
  }
  const petMenu = runtimeMenuItems(true, menuActions)
  assert.deepEqual(petMenu.map(item => item.label), ['打开商城', '喂养宠物', '设置帮助', '宠物状态', '活动', '停止成长', '重新领养宠物', '退出宠物'])
  const activity = petMenu.find(item => item.label === '活动')
  assert.deepEqual(activity.children.map(item => item.label), ['池塘', '游戏', '企鹅岛'])
  assert.equal(petMenu.some(item => ['农场', '密室', '社区'].includes(item.label)), false)
  activity.children.at(-1).run()
  assert.deepEqual(menuCalls, ['island'])
  menuCalls.length = 0
  petMenu.at(-1).run()
  assert.deepEqual(menuCalls, ['leave'])
  const emptyMenu = runtimeMenuItems(false, menuActions)
  assert.deepEqual(emptyMenu.map(item => item.label), ['选择宠物', '退出宠物'])
})

test('failed desktop import with an active authority restores ready instead of freezing the repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-c6a-import-'))
  const legacy = join(dir, 'save.json')
  writeFileSync(legacy, JSON.stringify(fixtures.save))
  let failWrites = false
  let id = 0
  const repo = createLocalRepository({
    documentPath: join(dir, 'save.v2.json'),
    legacySavePath: legacy,
    nowMs: () => WALL_TIME_MS,
    randomUUID: () => 'c6a-desktop-' + String(++id).padStart(4, '0'),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    pollIntervalMs: 1_000_000,
    autoScheduler: false,
    writeDocument: (file, text) => {
      if (failWrites) throw new Error('disk full')
      writeFileSync(file, text)
    },
  }, {
    authorityState: 'local-v2-active',
    rendererCapability: true,
    env: { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' },
  })
  await repo.load()
  const first = await repo.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 3 } },
    'op-c6a-meta-1',
  )
  const second = await repo.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 4 } },
    'op-c6a-meta-2',
  )
  const recent = repo.getRecentEvents()
  assert.ok(recent.length >= 2)
  assert.equal(recent[0].revision, first.projection.revision)
  assert.equal(recent.at(-1).revision, second.projection.revision)
  assert.notEqual(recent[0].revision, recent.at(-1).revision)
  assert.equal(typeof recent[0].gameTimeMs, 'number')
  assert.equal(recent[0].commandSeq, 1)
  assert.equal(recent.at(-1).commandSeq, 2)
  const persisted = JSON.parse(readFileSync(join(dir, 'save.v2.json'), 'utf8'))
  assert.ok(persisted.eventHistory.some(event =>
    event.revision === second.projection.revision && event.commandSeq === 2 && Number.isSafeInteger(event.gameTimeMs)))
  const bundle = repo.exportPortableBundle()
  failWrites = true
  assert.equal(await repo.importPortableBundle(bundle, 'op-c6a-failed-import'), null)
  assert.equal(repo.getStatus().state, 'ready')
  assert.equal(repo.getStatus().readOnly, false)
  failWrites = false
  assert.equal(await repo.importPortableBundle('{not-json', 'op-c6a-malformed-import'), null)
  assert.equal(repo.getStatus().state, 'ready')
  const runtimeSource = readFileSync(new URL('../../src/main/renderer-runtime.ts', import.meta.url), 'utf8')
  assert.match(runtimeSource, /requirePortableImportProjection\(/)
  assert.throws(() => requirePortableImportProjection(null, 'malformed import rejected'), /malformed import rejected/)
  await repo.stop()
})

test('desktop backs up and rewrites v2 event history that predates per-event metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqpet-c6a-event-history-'))
  const legacy = join(dir, 'save.json')
  writeFileSync(legacy, JSON.stringify(fixtures.save))
  let id = 0
  const makeRepo = () => createLocalRepository({
    documentPath: join(dir, 'save.v2.json'),
    legacySavePath: legacy,
    nowMs: () => WALL_TIME_MS,
    randomUUID: () => 'c6a-event-' + String(++id).padStart(4, '0'),
    seedHex: SEED,
    timeZone: 'Asia/Shanghai',
    pollIntervalMs: 1_000_000,
    autoScheduler: false,
  }, {
    authorityState: 'local-v2-active',
    rendererCapability: true,
    env: { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' },
  })
  const first = makeRepo()
  await first.load()
  await first.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 1 } }, 'op-event-1')
  await first.command({ type: 'admin.grantCheat', payload: { stat: 'yb', amount: 2 } }, 'op-event-2')
  await first.stop()
  const documentPath = join(dir, 'save.v2.json')
  const document = JSON.parse(readFileSync(documentPath, 'utf8'))
  assert.ok(document.eventHistory.length >= 2)
  for (const event of document.eventHistory) {
    delete event.revision
    delete event.gameTimeMs
  }
  writeFileSync(documentPath, JSON.stringify(document))
  const second = makeRepo()
  await second.load()
  assert.equal(second.getStatus().state, 'ready')
  assert.equal(existsSync(documentPath + '.bak'), true)
  const migrated = second.getRecentEvents()
  assert.ok(migrated.length >= 2)
  assert.ok(migrated.every(event => Number.isSafeInteger(event.revision) && Number.isSafeInteger(event.gameTimeMs)))
  await second.stop()
})

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
  const replacedProjection = []
  const replacedResync = []
  bridge.onProjection((value, events) => replacedProjection.push([value, events]))
  bridge.onResync((value, events) => replacedResync.push([value, events]))
  bridge.onProjection((value, events) => projections.push([value, events]))
  bridge.onResync((value, events) => resyncs.push([value, events]))
  bridge.onSyncStatus(status => statuses.push(status))
  const loaded = await bridge.load()
  assert.ok(loaded.havePet)
  assert.ok(resyncs.length >= 1)
  assert.equal(replacedProjection.length, 0)
  assert.equal(replacedResync.length, 0)
  assert.equal(bridge.getStatus().serverMode, false)
  const resyncsBefore = resyncs.length
  bridge.requestResync()
  assert.equal(resyncs.length, resyncsBefore + 1)
  assert.equal((await bridge.runtimeInfo()).localRepositoryV2, true)
  const before = bridge.getProjection().shared.petInfo.yb
  const command = await bridge.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 5 } },
    { opId: 'c6a-mobile-op' },
  )
  assert.equal(command.status, 'applied')
  assert.ok(projections.length >= 1)
  const secondCommand = await bridge.command(
    { type: 'admin.grantCheat', payload: { stat: 'yb', amount: 7 } },
    { opId: 'c6a-mobile-op-2' },
  )
  assert.equal(secondCommand.status, 'applied')
  const latestEvents = projections.at(-1)[1]
  assert.equal(latestEvents.length, 1)
  assert.equal(latestEvents[0].revision, secondCommand.revision)
  assert.equal(latestEvents[0].commandSeq, secondCommand.commandSeq)
  assert.ok(Number.isSafeInteger(latestEvents[0].gameTimeMs))
  const recentEvents = bridge.getRecentEvents()
  assert.equal(recentEvents.at(-1).revision, secondCommand.revision)
  assert.equal(recentEvents.at(-1).commandSeq, secondCommand.commandSeq)
  const afterCommand = bridge.getProjection().shared.petInfo.yb
  const overlay = await bridge.localSettings.update({
    petInfo: { lastX: 123, lastY: 45 },
    settings: { zoom: 1.3 },
  })
  assert.equal(overlay.petInfo.lastX, 123)
  assert.equal(bridge.getProjection().save.petInfo.lastX, 123)
  assert.equal(bridge.getProjection().shared.petInfo.yb, afterCommand)
  assert.ok(statuses.length >= 1)
  const portable = await bridge.exportPortableBundleJson()
  memory.failWrites(true)
  await assert.rejects(bridge.importPortableBundleJson(portable), /disk full/)
  assert.equal(bridge.getStatus().state, 'ready')
  assert.equal(bridge.getStatus().readOnly, false)
  memory.failWrites(false)
  await bridge.stop()
})
