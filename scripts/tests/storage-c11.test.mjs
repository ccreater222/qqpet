import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.')
      && context.parentURL
      && /\.[cm]?[jt]s$/.test(specifier) === false
      && specifier.endsWith('.json') === false
    ) {
      return nextResolve(specifier + '.ts')
    }
    return nextResolve(specifier)
  },
})

const {
  DesktopStorageController,
} = await import('../../src/main/storage-controller.ts')
const {
  buildStoragePanelModel,
  storagePairingView,
  storageStatusRows,
  storageWarnings,
} = await import('../../src/shared/storage.ts')
const {
  desktopServerModeCapability,
} = await import('../../src/main/renderer-runtime-flags.ts')
const {
  createLocalRepository,
} = await import('../../src/main/local-repository.ts')
const {
  createSyncFixtures,
  LOCAL_DEVICE_ID,
  GAME_TIME_MS,
} = await import('./sync-fixtures.mjs')
const {
  dayKeyAt,
  nextDailyBoundaryMs,
} = await import('../../src/shared/pet-runtime/index.ts')

const fixtures = createSyncFixtures()
const ACTIVATION_ENV = { QQPET_LOCAL_REPOSITORY_V2: '1', QQPET_LOCAL_V2_ACTIVE: '1' }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'qqpet-storage-c11-'))
}

function memoryTokenStore() {
  return {
    token: 'token-c11',
    config: {
      serverUrl: 'wss://server.test/v1/sync',
      petId: 'pet-c11',
      deviceId: 'device-c11',
      lastRevision: 3,
      lastEventSeq: 4,
    },
    async loadToken() { return this.token },
    async saveToken(token) { this.token = token },
    async loadConfig() { return this.config === null ? null : clone(this.config) },
    async saveConfig(config) { this.config = clone(config) },
    async clear() { this.token = null; this.config = null },
  }
}

function serverAuthority() {
  return {
    owner: 'server',
    authorityId: fixtures.authority.authorityId,
    restoreGeneration: fixtures.authority.restoreGeneration,
    epoch: 2,
    state: 'active',
  }
}

function serverBundle(overrides = {}) {
  const bundle = clone(fixtures.bundle)
  bundle.authority = {
    ...bundle.authority,
    owner: 'server',
    epoch: 2,
    detachedAtWallMs: GAME_TIME_MS,
  }
  delete bundle.originLocalDeviceId
  return Object.assign(bundle, overrides)
}

class FakeLocalAuthority {
  constructor(options = {}) {
    this.calls = []
    this.commands = []
    this.commandResults = []
    this.failImport = options.failImport === true
    this.deviceOverlay = clone(options.deviceOverlay ?? fixtures.device)
    const authority = {
      owner: 'local',
      authorityId: fixtures.authority.authorityId,
      restoreGeneration: 1,
      epoch: 1,
      state: 'active',
    }
    this.projection = {
      save: clone(fixtures.save),
      shared: clone(fixtures.shared),
      device: clone(fixtures.device),
      revision: 3,
      eventSeq: 4,
      gameTimeMs: GAME_TIME_MS,
      timeZone: 'Asia/Shanghai',
      advanceWhileEmpty: true,
      authority,
    }
    this.status = {
      mode: 'local',
      connection: 'local',
      serverMode: false,
      role: 'owner',
      readOnly: false,
      catchingUp: false,
      authorityState: 'active',
      revision: 3,
      eventSeq: 4,
      gameTimeMs: GAME_TIME_MS,
      timeZone: 'Asia/Shanghai',
      advanceWhileEmpty: true,
      authority,
      state: 'ready',
      localDeviceId: LOCAL_DEVICE_ID,
    }
  }

  getStatus() { return clone(this.status) }
  getProjection() { return this.projection === null ? null : clone(this.projection) }
  async start() { this.calls.push('start') }
  async loadFenced() { this.calls.push('loadFenced') }
  async stop() { this.calls.push('stop') }
  async flush() { this.calls.push('flush') }
  async load() { return clone(this.projection.save) }

  async command(command, options = {}) {
    this.commands.push({ type: command.type, payload: clone(command.payload), options: clone(options) })
    if (this.commandResults.length > 0) return this.commandResults.shift()
    return {
      status: 'applied',
      commandType: command.type,
      opId: options.opId ?? 'op-local',
      commandSeq: 1,
      revision: this.projection.revision,
      eventSeq: this.projection.eventSeq,
    }
  }

  async setAdvanceWhileEmpty(enabled) {
    this.calls.push('setAdvanceWhileEmpty:' + String(enabled))
    this.projection.advanceWhileEmpty = enabled
    this.status.advanceWhileEmpty = enabled
  }

  async exportForDetach(incomingEpoch) {
    this.calls.push('exportForDetach:' + String(incomingEpoch))
    const bundle = clone(fixtures.bundle)
    bundle.authority = { ...bundle.authority, epoch: Math.max(bundle.authority.epoch, incomingEpoch) + 1 }
    this.status.authorityState = 'handoff_pending'
    this.status.readOnly = true
    return bundle
  }

  async rollbackDetach() {
    this.calls.push('rollbackDetach')
    this.status.authorityState = 'active'
    this.status.readOnly = false
  }

  async archiveAuthority() {
    this.calls.push('archiveAuthority')
    this.status.authorityState = 'archived'
    this.status.readOnly = true
  }

  async importPortableBundle(bundle, options = {}) {
    this.calls.push('importPortableBundle')
    if (this.failImport) {
      this.status.readOnly = true
      this.status.lastError = 'anchor_out_of_bounds'
      return null
    }
    const authority = {
      owner: 'local',
      authorityId: bundle.authority.authorityId,
      restoreGeneration: bundle.authority.restoreGeneration,
      epoch: bundle.authority.epoch + 1,
      state: 'active',
    }
    this.projection = { ...this.projection, authority, revision: bundle.authority.revision, eventSeq: bundle.authority.eventSeq }
    this.status.authorityState = 'active'
    this.status.readOnly = false
    this.status.authority = authority
    this.status.revision = bundle.authority.revision
    this.status.eventSeq = bundle.authority.eventSeq
    this.lastImport = { bundle: clone(bundle), options: clone(options) }
    return clone(this.projection)
  }

  createBackup(reason) {
    this.calls.push('createBackup:' + reason)
    return join('/tmp', 'fake-local-backup.bak')
  }

  getMigrationStatus() { return { state: 'native_v2', source: 'save.v2.json' } }
  getBackupStatus() { return { available: true, path: join('/tmp', 'fake-local-backup.bak') } }
  exportPortableBundle() { return clone(fixtures.bundle) }
  getWeatherCity() { return '上海' }
  setSendEnabled(enabled) { this.calls.push('setSendEnabled:' + String(enabled)); this.sendEnabled = enabled }
  info() { return { localRepositoryV2: true, serverMode: false } }
  requestResync() { this.calls.push('requestResync') }
  loadLocalSettings() { return clone(this.deviceOverlay) }
  async updateLocalSettings(value) {
    this.calls.push('updateLocalSettings')
    this.deviceOverlay = {
      ...this.deviceOverlay,
      petInfo: { ...this.deviceOverlay.petInfo, ...(value.petInfo ?? {}) },
      settings: { ...this.deviceOverlay.settings, ...(value.settings ?? {}) },
      ...(value.presentation === undefined
        ? {}
        : { presentation: { ...(this.deviceOverlay.presentation ?? {}), ...value.presentation } }),
    }
    return clone(this.deviceOverlay)
  }
}

class FakeRemoteAuthority {
  constructor(options = {}) {
    this.options = options
    this.calls = []
    this.commands = []
    this.commandResults = []
    this.role = options.role ?? 'owner'
    this.weatherCity = options.weatherCity ?? '杭州'
    this.deviceOverlay = clone(options.deviceOverlay ?? fixtures.device)
    this.projectionCacheRestored = options.hasProjectionCache === true
    this.projection = {
      save: clone(fixtures.save),
      shared: clone(fixtures.shared),
      revision: 3,
      eventSeq: 4,
      gameTimeMs: GAME_TIME_MS,
      timeZone: 'Asia/Shanghai',
      advanceWhileEmpty: true,
      weatherLocation: this.weatherCity,
      authority: serverAuthority(),
    }
    this.status = {
      mode: 'server',
      connection: 'online',
      serverMode: true,
      role: this.role,
      readOnly: false,
      catchingUp: false,
      authority: serverAuthority(),
      revision: 3,
      eventSeq: 4,
      gameTimeMs: GAME_TIME_MS,
      timeZone: 'Asia/Shanghai',
      advanceWhileEmpty: true,
      weatherCity: this.weatherCity,
      state: 'online',
    }
  }

  async start() { this.calls.push('start'); return this.getProjection() }
  async stop() { this.calls.push('stop') }
  async flush() { this.calls.push('flush') }
  async load() { return clone(this.projection.save) }
  getStatus() { return clone(this.status) }
  getProjection() { return clone(this.projection) }
  getWeatherCity() { return this.weatherCity }

  async command(command, options = {}) {
    this.commands.push({ type: command.type, payload: clone(command.payload), options: clone(options) })
    if (this.commandResults.length > 0) return this.commandResults.shift()
    return {
      status: 'applied',
      commandType: command.type,
      opId: options.opId ?? 'op-remote',
      commandSeq: 1,
      revision: this.projection.revision,
      eventSeq: this.projection.eventSeq,
      result: {},
    }
  }

  async setAdvanceWhileEmpty(enabled) {
    this.calls.push('setAdvanceWhileEmpty:' + String(enabled))
    this.projection.advanceWhileEmpty = enabled
    this.status.advanceWhileEmpty = enabled
  }

  async exportBundle() { this.calls.push('exportBundle'); return serverBundle() }
  requestResync() { this.calls.push('requestResync') }
  hasProjectionCache() { return this.projectionCacheRestored }
  async loadLocalSettings() { return clone(this.deviceOverlay) }
  async updateLocalSettings(value) {
    this.calls.push('updateLocalSettings')
    this.deviceOverlay = {
      ...this.deviceOverlay,
      petInfo: { ...this.deviceOverlay.petInfo, ...(value.petInfo ?? {}) },
      settings: { ...this.deviceOverlay.settings, ...(value.settings ?? {}) },
      ...(value.presentation === undefined
        ? {}
        : { presentation: { ...(this.deviceOverlay.presentation ?? {}), ...value.presentation } }),
    }
    return clone(this.deviceOverlay)
  }
  onProjection(listener) { this.projectionListener = listener; return () => {} }
  onResync(listener) { this.resyncListener = listener; return () => {} }
  onCommandResult(listener) { this.commandResultListener = listener; return () => {} }
  onSyncStatus(listener) { this.statusListener = listener; return () => {} }
}

function makeController(options = {}) {
  const dir = options.dir ?? tempDir()
  const local = options.local ?? new FakeLocalAuthority(options.localOptions ?? {})
  const remote = options.remote ?? new FakeRemoteAuthority(options.remoteOptions ?? {})
  const store = memoryTokenStore()
  const created = []
  const controller = new DesktopStorageController({
    userDataPath: dir,
    appVersion: '0.1.0-test',
    local,
    createRemote: (remoteOptions) => {
      created.push(remoteOptions)
      if (remoteOptions.deviceOverlay !== undefined) remote.deviceOverlay = clone(remoteOptions.deviceOverlay)
      return remote
    },
    createTokenStore: () => store,
    nowMs: () => GAME_TIME_MS,
    platform: options.platform ?? 'linux',
    env: {},
  })
  return { controller, local, remote, store, created, dir }
}

function applied(commandType, result) {
  return {
    status: 'applied',
    commandType,
    opId: 'op-result',
    commandSeq: 1,
    revision: 4,
    eventSeq: 5,
    ...(result === undefined ? {} : { result }),
  }
}

function rejected(commandType, code, message) {
  return {
    status: 'rejected',
    commandType,
    opId: 'op-result',
    commandSeq: 0,
    revision: 3,
    eventSeq: 4,
    error: { code, message, refreshProjection: true },
  }
}

function duplicateRejected(commandType, code, message) {
  return {
    status: 'duplicate',
    commandType,
    opId: 'op-result',
    commandSeq: 0,
    revision: 3,
    eventSeq: 4,
    original: 'rejected',
    error: { code, message, refreshProjection: true },
  }
}

function duplicateApplied(commandType, result) {
  return {
    status: 'duplicate',
    commandType,
    opId: 'op-result',
    commandSeq: 1,
    revision: 4,
    eventSeq: 5,
    original: 'applied',
    ...(result === undefined ? {} : { result }),
  }
}

test('local to server handoff freezes local before upload and applies the owner import', async () => {
  const harness = makeController()
  harness.remote.commandResults.push(applied('admin.importPortableBundle', { importClamped: false, clockSkippedMs: 0, epoch: 5 }))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local', rebindLocalSessions: true })
  assert.ok(harness.local.calls.includes('exportForDetach:2'))
  assert.equal(harness.remote.commands.length, 1)
  assert.equal(harness.remote.commands[0].type, 'admin.importPortableBundle')
  assert.equal(harness.remote.commands[0].options.opId, 'handoff-handoff-0001')
  assert.equal(harness.remote.commands[0].payload.rebindLocalSessions, true)
  assert.equal(harness.local.sendEnabled, false)
  const status = harness.controller.status()
  assert.equal(status.mode, 'server')
  assert.equal(status.activeMode, 'server')
  assert.equal(status.paired, true)
  assert.equal(status.handoff.state, 'applied')
  assert.equal(status.handoff.direction, 'local_to_server')
  assert.equal(status.handoff.requestedRebind, true)
  assert.ok(harness.local.calls.includes('archiveAuthority'))
  assert.equal(harness.local.status.authorityState, 'archived')
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), false)
  harness.remote.projectionListener(
    { ...harness.remote.getProjection(), revision: 4, eventSeq: 5 },
    [{
      eventSeq: 5,
      revision: 4,
      commandSeq: 1,
      gameTimeMs: GAME_TIME_MS,
      type: 'game.sessionSettled',
      payload: { status: 'abandoned', cancelReason: 'actor_rebind_failed', kind: 'exam' },
    }],
  )
  assert.equal(harness.controller.status().handoff.cancelledSessionKinds.includes('exam'), true)
})

test('a rejected local to server upload unfreezes local and keeps the epoch rollback snapshot', async () => {
  const harness = makeController()
  harness.remote.commandResults.push(rejected('admin.importPortableBundle', 'authority_fork_risk', 'bundle lineage does not match'))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  assert.ok(harness.local.calls.includes('rollbackDetach'))
  const status = harness.controller.status()
  assert.equal(status.mode, 'local')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.handoff.state, 'rolled_back')
  assert.equal(status.handoff.reason, 'authority_fork_risk')
  assert.equal(harness.local.sendEnabled, true)
})

test('an uncertain upload stays frozen, then the same opId reconciles and rolls back only on rejection', async () => {
  const harness = makeController()
  harness.remote.command = async function command(command, options = {}) {
    this.commands.push({ type: command.type, payload: clone(command.payload), options: clone(options) })
    if (this.commandResults.length > 0) return this.commandResults.shift()
    throw new Error('offline: result unknown')
  }
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  let status = harness.controller.status()
  assert.equal(status.handoff.state, 'frozen')
  assert.equal(status.handoff.retryable, true)
  const firstOpts = harness.remote.commands[0].options.opId
  harness.remote.commandResults.push(rejected('admin.importPortableBundle', 'authority_fork_risk', 'stale bundle'))
  await harness.controller.rollbackHandoff()
  assert.equal(harness.remote.commands[1].options.opId, firstOpts)
  status = harness.controller.status()
  assert.equal(status.handoff.state, 'rolled_back')
  assert.ok(harness.local.calls.includes('rollbackDetach'))
})

test('a lost-upload retry that finds a stored rejection stays rejected and unfreezes local', async () => {
  const harness = makeController()
  harness.remote.command = async function command(command, options = {}) {
    this.commands.push({ type: command.type, payload: clone(command.payload), options: clone(options) })
    if (this.commandResults.length > 0) return this.commandResults.shift()
    throw new Error('offline: result unknown')
  }
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  assert.equal(harness.controller.status().handoff.state, 'frozen')
  const opId = harness.remote.commands[0].options.opId
  harness.remote.commandResults.push(duplicateRejected('admin.importPortableBundle', 'authority_fork_risk', 'stale bundle'))
  await harness.controller.retryHandoff()
  assert.equal(harness.remote.commands[1].options.opId, opId)
  const status = harness.controller.status()
  assert.equal(status.mode, 'local')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.handoff.state, 'rolled_back')
  assert.equal(status.handoff.reason, 'authority_fork_risk')
  assert.equal(status.readOnly, false)
  assert.ok(harness.local.calls.includes('rollbackDetach'))
})

test('use-server against an archived server resumes with the current local bundle before archiving local', async () => {
  const harness = makeController()
  harness.remote.status.authority.state = 'archived'
  harness.remote.projection.authority.state = 'archived'
  harness.remote.commandResults.push(applied('admin.resumeServer', {
    imported: true,
    epoch: 5,
    importClamped: false,
    clockSkippedMs: 0,
  }))
  await harness.controller.setMode({ mode: 'server', initialSource: 'use-server' })
  assert.equal(harness.remote.commands.length, 1)
  assert.equal(harness.remote.commands[0].type, 'admin.resumeServer')
  assert.equal(harness.remote.commands[0].payload.bundle.authority.owner, 'local')
  assert.equal(harness.remote.commands[0].payload.expectedEpoch, harness.remote.commands[0].payload.bundle.authority.epoch)
  assert.equal(harness.local.calls.includes('exportForDetach:2'), true)
  assert.ok(harness.local.calls.indexOf('exportForDetach:2') < harness.local.calls.indexOf('archiveAuthority'))
  const status = harness.controller.status()
  assert.equal(status.mode, 'server')
  assert.equal(status.activeMode, 'server')
  assert.equal(harness.local.status.authorityState, 'archived')
  assert.equal(status.handoff.state, 'applied')
})

test('a rejected archived-server resume rolls the frozen local authority back', async () => {
  const harness = makeController()
  harness.remote.status.authority.state = 'archived'
  harness.remote.projection.authority.state = 'archived'
  harness.remote.commandResults.push(rejected('admin.resumeServer', 'authority_fork_risk', 'stale archive lineage'))
  await harness.controller.setMode({ mode: 'server', initialSource: 'use-server' })
  assert.equal(harness.remote.commands.length, 1)
  assert.equal(harness.remote.commands[0].type, 'admin.resumeServer')
  assert.equal(harness.local.calls.includes('rollbackDetach'), true)
  assert.equal(harness.local.calls.includes('archiveAuthority'), false)
  const status = harness.controller.status()
  assert.equal(status.mode, 'local')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.readOnly, false)
  assert.equal(status.handoff.state, 'rolled_back')
  assert.equal(harness.local.status.authorityState, 'active')
})

test('server to local detach validates the exact stamp before local import and lets local tick', async () => {
  const harness = makeController()
  harness.remote.commandResults.push(applied('admin.importPortableBundle', {}))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local', rebindLocalSessions: true })
  const bundle = serverBundle()
  harness.remote.commandResults.push(applied('admin.exportForDetach', { authority: bundle.authority, bundle }))
  await harness.controller.setMode({ mode: 'local' })
  assert.equal(harness.remote.commands[1].type, 'admin.exportForDetach')
  assert.ok(harness.local.calls.includes('loadFenced'))
  assert.ok(harness.local.calls.includes('createBackup:import'))
  assert.ok(harness.local.calls.includes('importPortableBundle'))
  assert.equal(harness.local.lastImport.options.expectedAuthorityId, bundle.authority.authorityId)
  assert.equal(harness.local.lastImport.options.expectedRestoreGeneration, bundle.authority.restoreGeneration)
  assert.equal(harness.local.lastImport.options.expectedEpoch, 2)
  assert.equal(harness.local.lastImport.options.expectedRevision, bundle.authority.revision)
  assert.equal(harness.local.lastImport.options.expectedEventSeq, bundle.authority.eventSeq)
  assert.ok(harness.remote.calls.includes('stop'))
  const status = harness.controller.status()
  assert.equal(status.mode, 'local')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.handoff.state, 'applied')
  assert.equal(harness.local.sendEnabled, true)
})

test('a failed server to local import leaves local read-only with a retryable frozen handoff', async () => {
  const local = new FakeLocalAuthority({ failImport: true })
  const harness = makeController({ local })
  harness.remote.commandResults.push(applied('admin.importPortableBundle', {}))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  const bundle = serverBundle()
  harness.remote.commandResults.push(applied('admin.exportForDetach', { authority: bundle.authority, bundle }))
  await harness.controller.setMode({ mode: 'local' })
  const status = harness.controller.status()
  assert.equal(status.mode, 'server')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.readOnly, true)
  assert.equal(status.handoff.state, 'frozen')
  assert.equal(status.handoff.retryable, true)
  assert.equal(status.handoff.reason, 'local_import_failed')
})

test('a successful retry of a failed server-detach import persists local mode and clears the journal', async () => {
  const local = new FakeLocalAuthority({ failImport: true })
  const harness = makeController({ local })
  harness.remote.commandResults.push(applied('admin.importPortableBundle', {}))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  const bundle = serverBundle()
  harness.remote.commandResults.push(applied('admin.exportForDetach', { authority: bundle.authority, bundle }))
  await harness.controller.setMode({ mode: 'local' })
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), true)
  assert.equal(JSON.parse(readFileSync(join(harness.dir, 'storage-config.json'), 'utf8')).mode, 'server')

  local.failImport = false
  const status = await harness.controller.retryHandoff()
  assert.equal(status.mode, 'local')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.handoff.state, 'applied')
  assert.equal(local.status.authorityState, 'active')
  assert.equal(JSON.parse(readFileSync(join(harness.dir, 'storage-config.json'), 'utf8')).mode, 'local')
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), false)
})

test('startup reconciles a frozen local-to-server upload with the persisted opId and archives local', async () => {
  const harness = makeController()
  const originalCommand = FakeRemoteAuthority.prototype.command
  harness.remote.command = async function command(command, options = {}) {
    this.commands.push({ type: command.type, payload: clone(command.payload), options: clone(options) })
    throw new Error('offline: result unknown')
  }
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  assert.equal(harness.controller.status().handoff.state, 'frozen')
  const opId = harness.remote.commands[0].options.opId
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), true)

  harness.remote.command = originalCommand
  harness.remote.commandResults.push(applied('admin.importPortableBundle', { epoch: 6 }))
  const restarted = makeController({ dir: harness.dir, local: harness.local, remote: harness.remote })
  const status = await restarted.controller.initialize()
  assert.equal(harness.remote.commands.length, 2)
  assert.equal(harness.remote.commands[1].options.opId, opId)
  assert.equal(harness.local.status.authorityState, 'archived')
  assert.equal(status.mode, 'server')
  assert.equal(status.activeMode, 'server')
  assert.equal(status.handoff.state, 'applied')
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), false)
})

test('startup reconciles a persisted server-to-local detach bundle and keeps local as requested mode', async () => {
  const local = new FakeLocalAuthority({ failImport: true })
  const harness = makeController({ local })
  harness.remote.commandResults.push(applied('admin.importPortableBundle', {}))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  const bundle = serverBundle()
  harness.remote.commandResults.push(applied('admin.exportForDetach', { authority: bundle.authority, bundle }))
  await harness.controller.setMode({ mode: 'local' })
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), true)
  assert.equal(JSON.parse(readFileSync(join(harness.dir, 'storage-config.json'), 'utf8')).mode, 'server')

  local.failImport = false
  const restarted = makeController({ dir: harness.dir, local, remote: harness.remote })
  const status = await restarted.controller.initialize()
  assert.equal(status.mode, 'local')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.handoff.state, 'applied')
  assert.equal(local.status.authorityState, 'active')
  assert.equal(JSON.parse(readFileSync(join(harness.dir, 'storage-config.json'), 'utf8')).mode, 'local')
  assert.equal(existsSync(join(harness.dir, 'storage-handoff.json')), false)
})

test('device-local zoom, display and AI credentials survive local to server to local', async () => {
  const harness = makeController()
  harness.local.deviceOverlay.settings.zoom = 1.75
  harness.local.deviceOverlay.settings.petDisplayId = 2
  harness.local.deviceOverlay.settings.aiKey = 'sk-local-overlay'
  harness.local.deviceOverlay.petInfo.lastX = 123

  harness.remote.commandResults.push(applied('admin.importPortableBundle', {}))
  await harness.controller.setMode({ mode: 'server', initialSource: 'upload-local' })
  assert.equal(harness.created.length, 1)
  assert.equal(harness.created[0].deviceOverlay.settings.zoom, 1.75)
  assert.equal(harness.created[0].deviceOverlay.settings.petDisplayId, 2)
  assert.equal(harness.created[0].deviceOverlay.settings.aiKey, 'sk-local-overlay')
  assert.equal(harness.remote.deviceOverlay.settings.zoom, 1.75)
  assert.ok(harness.remote.calls.includes('updateLocalSettings'))

  await harness.controller.updateLocalSettings({
    settings: { zoom: 2.25, petDisplayId: 3, aiKey: 'sk-server-overlay' },
    petInfo: { lastX: 456 },
  })
  const bundle = serverBundle()
  harness.remote.commandResults.push(applied('admin.exportForDetach', { authority: bundle.authority, bundle }))
  await harness.controller.setMode({ mode: 'local' })
  assert.equal(harness.controller.status().mode, 'local')
  assert.equal(harness.local.deviceOverlay.settings.zoom, 2.25)
  assert.equal(harness.local.deviceOverlay.settings.petDisplayId, 3)
  assert.equal(harness.local.deviceOverlay.settings.aiKey, 'sk-server-overlay')
  assert.equal(harness.local.deviceOverlay.petInfo.lastX, 456)
  assert.ok(harness.local.calls.includes('updateLocalSettings'))
})

function adaptLocal(repo) {
  return {
    getStatus() {
      const status = repo.getStatus()
      const projection = repo.getProjection()
      const authority = projection === null
        ? { owner: 'local', authorityId: '', restoreGeneration: 0, epoch: 0, state: 'archived' }
        : projection.authority
      return {
        ...status,
        connection: 'local',
        serverMode: false,
        authority,
        revision: projection === null ? status.revision : projection.revision,
        eventSeq: projection === null ? status.eventSeq : projection.eventSeq,
        gameTimeMs: projection === null ? 0 : projection.gameTimeMs,
        timeZone: projection === null ? 'UTC' : projection.timeZone,
        advanceWhileEmpty: projection === null ? true : projection.advanceWhileEmpty,
        lastError: status.error,
      }
    },
    getProjection: () => repo.getProjection(),
    start: () => repo.start(),
    loadFenced: () => repo.loadFenced(),
    stop: () => repo.stop(),
    flush: () => repo.flush(),
    load: () => repo.load(),
    command: async (command) => ({ status: 'applied', commandType: command.type, opId: 'adapter', commandSeq: 1, revision: 1, eventSeq: 1 }),
    setAdvanceWhileEmpty: (enabled) => repo.setAdvanceWhileEmpty(enabled),
    exportForDetach: (incomingEpoch) => repo.exportForDetach(incomingEpoch),
    rollbackDetach: () => repo.rollbackDetach(),
    archiveAuthority: (reason) => repo.archiveAuthority(reason),
    importPortableBundle: (bundle, options) => repo.importPortableBundle(bundle, options),
    createBackup: (reason) => repo.createBackup(reason),
    getMigrationStatus: () => repo.getMigrationStatus(),
    getBackupStatus: () => repo.getBackupStatus(),
    exportPortableBundle: () => repo.exportPortableBundle(),
    getWeatherCity: () => repo.getDocument() === null ? '' : repo.getDocument().bundle.engine.weatherLocation,
    setSendEnabled: () => {},
    info: () => ({ localRepositoryV2: true, serverMode: false }),
    requestResync: () => {},
    loadLocalSettings: () => repo.getDeviceOverlay(),
    updateLocalSettings: (value) => repo.updateDeviceOverlay(value),
    reset: () => repo.reset(),
  }
}

function realLocalController(dir) {
  const repo = createLocalRepository({
    documentPath: join(dir, 'save.v2.json'),
    legacySavePath: join(dir, 'save.json'),
    legacyBackupPath: join(dir, 'save.json.bak'),
    documentBackupPath: join(dir, 'save.v2.json.bak'),
    localDeviceId: LOCAL_DEVICE_ID,
    seedHex: '000102030405060708090a0b0c0d0e0f',
    timeZone: 'Asia/Shanghai',
    autoScheduler: false,
  }, { authorityState: 'local-v2-active', rendererCapability: true, env: ACTIVATION_ENV })
  const store = memoryTokenStore()
  const controller = new DesktopStorageController({
    userDataPath: dir,
    appVersion: '0.1.0-test',
    local: adaptLocal(repo),
    createRemote: () => { throw new Error('remote factory is not used in local import tests') },
    createTokenStore: () => store,
    nowMs: () => Date.now(),
    platform: 'linux',
    env: {},
  })
  return { repo, controller }
}

test('portable import rejects never-upload secrets and device-local fields before any local mutation', async () => {
  const harness = makeController()
  const secretBundle = clone(fixtures.bundle)
  secretBundle.engine.save.settings.aiKey = 'sk-secret'
  const secretReport = await harness.controller.importBundle({ json: JSON.stringify(secretBundle) })
  assert.equal(secretReport.status, 'invalid')
  assert.equal(harness.local.calls.includes('importPortableBundle'), false)
  assert.equal(harness.local.calls.includes('createBackup:import'), false)
  const deviceBundle = clone(fixtures.bundle)
  deviceBundle.engine.save.petInfo.lastX = 42
  const deviceReport = await harness.controller.importBundle({ json: JSON.stringify(deviceBundle) })
  assert.equal(deviceReport.status, 'invalid')
  assert.equal(harness.local.calls.includes('importPortableBundle'), false)
})

test('local portable import backs up the v2 document before overwriting it', async () => {
  const dir = tempDir()
  const { repo, controller } = realLocalController(dir)
  await repo.start()
  const exported = repo.exportPortableBundle()
  assert.ok(exported)
  const report = await controller.importBundle({ json: JSON.stringify(exported) })
  assert.equal(report.status, 'applied')
  assert.ok(report.backupPath)
  assert.equal(existsSync(join(dir, 'save.v2.json.bak')), true)
  assert.equal(controller.status().migration.state, 'fresh')
  await repo.stop()
})

test('local portable import rejects stale authority epochs before backup or mutation', async () => {
  const harness = makeController()
  const stale = clone(fixtures.bundle)
  stale.authority.epoch = 0
  const report = await harness.controller.importBundle({ json: JSON.stringify(stale) })
  assert.equal(report.status, 'rejected')
  assert.equal(report.errorCode, 'authority_fork_risk')
  assert.equal(harness.local.calls.includes('createBackup:import'), false)
  assert.equal(harness.local.calls.includes('importPortableBundle'), false)

  const wrongLineage = clone(fixtures.bundle)
  wrongLineage.authority.authorityId = 'authority-foreign-0001'
  const lineageReport = await harness.controller.importBundle({ json: JSON.stringify(wrongLineage) })
  assert.equal(lineageReport.status, 'rejected')
  assert.equal(lineageReport.errorCode, 'authority_fork_risk')
  assert.equal(harness.local.calls.includes('importPortableBundle'), false)
})

test('local portable import rejects a seven-day-old anchor and reports explicit clamp shifts', async () => {
  const day = 24 * 60 * 60_000
  const harness = makeController()
  const bundle = clone(fixtures.bundle)
  bundle.engine.lastSchedulerWallMs = GAME_TIME_MS - 7 * day
  bundle.engine.gameSessions[0] = { ...bundle.engine.gameSessions[0], actorDeviceId: 'foreign-device' }
  const json = JSON.stringify(bundle)

  const rejected = await harness.controller.importBundle({ json })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.errorCode, 'anchor_out_of_bounds')
  assert.equal(harness.local.calls.includes('createBackup:import'), false)
  assert.equal(harness.local.calls.includes('importPortableBundle'), false)

  const skippedMs = 5 * day
  const effectiveAnchorWallMs = GAME_TIME_MS - 48 * 60 * 60_000
  const applied = await harness.controller.importBundle({ json, allowClamp: true, rebindLocalSessions: true })
  assert.equal(applied.status, 'applied')
  assert.equal(applied.importClamped, true)
  assert.equal(applied.clockSkippedMs, skippedMs)
  assert.equal(applied.effectiveAnchorWallMs, effectiveAnchorWallMs)
  assert.equal(applied.rebindRequested, true)
  assert.equal(applied.cancelledSessionKinds.includes('game'), true)
  assert.equal(applied.nextEpoch, 2)

  const planned = harness.local.lastImport.bundle
  assert.equal(planned.engine.lastSchedulerWallMs, effectiveAnchorWallMs)
  assert.equal(planned.engine.importClamped, true)
  assert.equal(planned.engine.clockSkippedMs, skippedMs)
  assert.equal(planned.engine.gameTimeMs, fixtures.engine.gameTimeMs + skippedMs)
  assert.equal(planned.engine.scheduledJobs[0].dueAtGameMs, fixtures.engine.scheduledJobs[0].dueAtGameMs + skippedMs)
  assert.equal(planned.engine.scheduledJobs[0].status, 'pending')
  assert.equal(planned.engine.gameSessions.find(session => session.sessionToken === 'exam-token-0001').expiresAtGameMs, fixtures.examSession.expiresAtGameMs + skippedMs)
  assert.equal(planned.engine.lastProcessedDayBoundaryKey, dayKeyAt(planned.engine.gameTimeMs, planned.engine.timeZone))
  assert.equal(planned.engine.nextDailyBoundaryMs, nextDailyBoundaryMs(planned.engine.gameTimeMs, planned.engine.timeZone))
  const foreign = planned.engine.gameSessions.find(session => session.sessionToken === 'game-token-0001')
  assert.equal(foreign.status, 'abandoned')
  assert.equal(foreign.cancelReason, 'actor_rebind_failed')
})

test('local portable import rebinds source-actor sessions when explicitly allowed and cancels them otherwise', async () => {
  const run = async (rebindLocalSessions) => {
    const harness = makeController()
    const bundle = clone(fixtures.bundle)
    bundle.originLocalDeviceId = 'source-local-device'
    bundle.engine.gameSessions[0] = { ...bundle.engine.gameSessions[0], actorDeviceId: 'source-local-device' }
    const report = await harness.controller.importBundle({
      json: JSON.stringify(bundle),
      rebindLocalSessions,
    })
    assert.equal(report.status, 'applied')
    return { report, imported: harness.local.lastImport.bundle }
  }

  const rebound = await run(true)
  const reboundSession = rebound.imported.engine.gameSessions.find(session => session.sessionToken === 'game-token-0001')
  assert.equal(reboundSession.actorDeviceId, LOCAL_DEVICE_ID)
  assert.equal(reboundSession.status, 'active')
  assert.equal(rebound.report.cancelledSessionKinds.includes('game'), false)

  const cancelled = await run(false)
  const cancelledSession = cancelled.imported.engine.gameSessions.find(session => session.sessionToken === 'game-token-0001')
  assert.equal(cancelledSession.status, 'abandoned')
  assert.equal(cancelledSession.cancelReason, 'actor_rebind_failed')
  assert.equal(cancelled.report.cancelledSessionKinds.includes('game'), true)
})

function statusView(overrides = {}) {
  const base = {
    mode: 'local',
    activeMode: 'local',
    serverModeAvailable: true,
    connection: 'local',
    paired: false,
    authority: {
      owner: 'local',
      authorityId: 'authority-local-0001',
      restoreGeneration: 1,
      epoch: 2,
      state: 'active',
      revision: 5,
      eventSeq: 6,
    },
    revision: 5,
    eventSeq: 6,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    weatherCity: '上海',
    advanceWhileEmpty: true,
    readOnly: false,
    catchingUp: false,
    migration: { state: 'native_v2', source: 'save.v2.json' },
    backup: { available: true, path: 'save.v2.json.bak' },
    handoff: { direction: 'none', state: 'idle' },
  }
  return { ...base, ...overrides }
}

const ownerDevice = { deviceId: 'device-owner-1', label: 'desktop', role: 'owner', createdAtMs: 1 }
const playerDevice = { deviceId: 'device-player-1', label: 'phone', role: 'player', createdAtMs: 2 }

test('storage rows expose mode/authority epoch/restore generation/game time/timezone/advance policy', () => {
  const rows = storageStatusRows(statusView())
  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  assert.equal(byKey.get('mode'), '本机')
  assert.equal(byKey.get('epoch'), '2')
  assert.equal(byKey.get('authorityId'), 'authority-local-0001')
  assert.equal(byKey.get('restoreGeneration'), '1')
  assert.equal(byKey.get('revision'), '5')
  assert.equal(byKey.get('eventSeq'), '6')
  assert.equal(byKey.get('timeZone'), 'Asia/Shanghai')
  assert.equal(byKey.get('advanceWhileEmpty'), '开')
})

test('newer restore generation and frozen handoffs surface operator warnings', () => {
  const reset = statusView({ authority: { ...statusView().authority, restoreGeneration: 5 } })
  const resetWarnings = storageWarnings(reset, { knownRestoreGeneration: 3 })
  assert.equal(resetWarnings.some((warning) => warning.includes('恢复代次')), true)
  const frozen = statusView({ handoff: { direction: 'server_to_local', state: 'frozen', message: 'local import failed', retryable: true } })
  const frozenWarnings = storageWarnings(frozen, {})
  assert.equal(frozenWarnings.some((warning) => warning.includes('冻结')), true)
  const resetNotice = statusView({ notice: 'authority_reset_required', readOnly: true })
  assert.equal(storageWarnings(resetNotice, {}).some((warning) => warning.includes('重置')), true)
})

test('pairing/revoke UI state follows paired role and owner list', () => {
  const unpaired = storagePairingView(statusView({ mode: 'server', serverUrl: 'ws://server.test' }), { serverUrl: 'ws://server.test' })
  assert.equal(unpaired.required, true)
  assert.equal(unpaired.canPair, false)
  const ready = storagePairingView(statusView({ mode: 'server' }), { serverUrl: 'ws://server.test', pairingCode: 'code-123' })
  assert.equal(ready.canPair, true)
  const ownerModel = buildStoragePanelModel(statusView({ paired: true, deviceRole: 'owner', deviceId: 'device-owner-1' }), [ownerDevice, playerDevice])
  assert.equal(ownerModel.canRevokeDevices, true)
  const playerModel = buildStoragePanelModel(statusView({ paired: true, deviceRole: 'player', deviceId: 'device-player-1' }), [playerDevice])
  assert.equal(playerModel.canRevokeDevices, false)
  const lastOwner = storageWarnings(statusView({ paired: true }), { devices: [{ ...ownerDevice, revokedAtMs: 10 }] })
  assert.equal(lastOwner.some((warning) => warning.includes('撤销最后一个 owner')), true)
})

test('pairing IPC requires wss except explicit loopback and validates setMode serverUrl', async () => {
  const insecure = makeController()
  await assert.rejects(
    insecure.controller.pair({
      serverUrl: 'ws://pet.example/v1/sync',
      code: 'pair-code',
      deviceLabel: 'Desktop',
    }),
    /loopback|wss/i,
  )
  assert.equal(insecure.created.length, 0)
  await assert.rejects(
    insecure.controller.setMode({
      mode: 'server',
      serverUrl: 'ws://pet.example/v1/sync',
      pairingCode: 'pair-code',
      deviceLabel: 'Desktop',
    }),
    /loopback|wss/i,
  )
  assert.equal(insecure.created.length, 0)

  for (const serverUrl of [
    'wss://user:pass@pet.example/v1/sync',
    'ws://user:pass@127.0.0.1:8080/v1/sync',
    'wss://token@pet.example/v1/sync',
  ]) {
    await assert.rejects(
      insecure.controller.pair({ serverUrl, code: 'pair-code', deviceLabel: 'Desktop' }),
      /credentials/i,
    )
    await assert.rejects(
      insecure.controller.setMode({
        mode: 'server',
        serverUrl,
        pairingCode: 'pair-code',
        deviceLabel: 'Desktop',
      }),
      /credentials/i,
    )
  }
  assert.equal(insecure.created.length, 0)

  for (const serverUrl of ['wss://pet.example/v1/sync', 'ws://127.0.0.1:8080/v1/sync', 'ws://[::1]:8080/v1/sync']) {
    const harness = makeController()
    await harness.controller.pair({ serverUrl, code: 'pair-code', deviceLabel: 'Desktop' })
    assert.equal(harness.created.length, 1)
    assert.equal(harness.created[0].serverUrl, serverUrl)
    await harness.controller.unpair()
  }
})

test('server-mode startup keeps the newer projection-cache overlay instead of stale archived local values', async () => {
  const local = new FakeLocalAuthority()
  local.deviceOverlay.settings.zoom = 1.25
  local.loadLocalSettings = () => { throw new Error('local runtime is not loaded yet') }
  const remote = new FakeRemoteAuthority({ hasProjectionCache: true })
  remote.deviceOverlay.settings.zoom = 2.5
  remote.deviceOverlay.settings.petDisplayId = 3
  remote.deviceOverlay.settings.aiKey = 'sk-cache-new'
  const harness = makeController({ local, remote })
  harness.store.token = 'stored-token'
  writeFileSync(join(harness.dir, 'storage-config.json'), JSON.stringify({
    format: 'qqpet-storage-config',
    schemaVersion: 1,
    mode: 'server',
    serverUrl: 'wss://server.test/v1/sync',
    deviceLabel: 'Desktop',
  }))
  const status = await harness.controller.initialize()
  assert.equal(status.activeMode, 'server')
  assert.equal(harness.remote.deviceOverlay.settings.zoom, 2.5)
  assert.equal(harness.remote.deviceOverlay.settings.aiKey, 'sk-cache-new')
  assert.equal(harness.remote.calls.includes('updateLocalSettings'), false)
})

test('startup never dials an unsafe persisted ws endpoint', async () => {
  const harness = makeController()
  harness.store.token = 'stored-token'
  writeFileSync(join(harness.dir, 'storage-config.json'), JSON.stringify({
    format: 'qqpet-storage-config',
    schemaVersion: 1,
    mode: 'server',
    serverUrl: 'ws://pet.example/v1/sync',
    deviceLabel: 'Desktop',
  }))
  const status = await harness.controller.initialize()
  assert.equal(harness.created.length, 0)
  assert.equal(status.mode, 'server')
  assert.equal(status.activeMode, 'local')
  assert.equal(status.paired, false)
})

test('desktop exposes server mode by default while android/ios remain hidden and local-only', () => {
  assert.equal(desktopServerModeCapability({}, 'linux').canActivate, true)
  assert.equal(desktopServerModeCapability({}, 'darwin').serverMode, true)
  const android = desktopServerModeCapability({}, 'android')
  assert.equal(android.canActivate, false)
  assert.equal(android.serverMode, false)
  assert.equal(android.reason, 'mobile_server_mode_forbidden')
  const ios = desktopServerModeCapability({}, 'ios')
  assert.equal(ios.canActivate, false)
  assert.equal(ios.serverMode, false)
})

test('owner device list/revoke stays routed and players are rejected', async () => {
  const harness = makeController()
  await harness.controller.setMode({ mode: 'server', initialSource: 'use-server' })
  harness.remote.commandResults.push(applied('device.list', { devices: [playerDevice] }))
  const view = await harness.controller.listDevices()
  assert.equal(view.owner, true)
  assert.equal(view.canRevoke, true)
  assert.equal(view.devices.length, 1)
  harness.remote.commandResults.push(applied('device.revoke', { deviceId: playerDevice.deviceId, revokedAtMs: 10 }))
  harness.remote.commandResults.push(applied('device.list', { devices: [{ ...playerDevice, revokedAtMs: 10 }] }))
  const after = await harness.controller.revokeDevice(playerDevice.deviceId)
  assert.equal(after.devices[0].revokedAtMs, 10)
  assert.equal(harness.remote.commands.map((entry) => entry.type).join(','), 'device.list,device.revoke,device.list')

  const playerHarness = makeController({ remote: new FakeRemoteAuthority({ role: 'player' }) })
  await playerHarness.controller.setMode({ mode: 'server', initialSource: 'use-server' })
  const playerView = await playerHarness.controller.listDevices()
  assert.equal(playerView.canRevoke, false)
  assert.equal(playerView.error.includes('unauthorized'), true)
})

test('duplicate rejected device, setting and import results take the stored error path', async () => {
  const harness = makeController()
  await harness.controller.setMode({ mode: 'server', initialSource: 'use-server' })

  harness.remote.commandResults.push(duplicateRejected('device.list', 'unauthorized', 'revoked device'))
  const devices = await harness.controller.listDevices()
  assert.equal(devices.error, 'revoked device')
  assert.equal(devices.devices.length, 0)

  harness.remote.commandResults.push(duplicateRejected('device.revoke', 'unauthorized', 'not an owner'))
  await assert.rejects(harness.controller.revokeDevice(playerDevice.deviceId), /unauthorized: not an owner/)

  harness.remote.commandResults.push(duplicateRejected('server.setTimeZone', 'invalid_payload', 'bad zone'))
  await assert.rejects(harness.controller.setTimeZone('Asia/Tokyo'), /invalid_payload: bad zone/)

  harness.remote.commandResults.push(duplicateRejected('server.setWeatherCity', 'invalid_payload', 'bad city'))
  await assert.rejects(harness.controller.setWeatherCity('北京'), /invalid_payload: bad city/)

  harness.remote.commandResults.push(duplicateRejected('admin.importPortableBundle', 'authority_fork_risk', 'stored fork'))
  const rejectedImport = await harness.controller.importBundle({ json: JSON.stringify(fixtures.bundle) })
  assert.equal(rejectedImport.status, 'rejected')
  assert.equal(rejectedImport.errorCode, 'authority_fork_risk')
  assert.equal(rejectedImport.message, 'stored fork')

  harness.remote.commandResults.push(duplicateApplied('admin.importPortableBundle', {
    imported: true,
    epoch: 12,
    effectiveAnchorWallMs: GAME_TIME_MS,
    clockSkippedMs: 0,
    importClamped: true,
  }))
  const appliedImport = await harness.controller.importBundle({ json: JSON.stringify(fixtures.bundle) })
  assert.equal(appliedImport.status, 'applied')
  assert.equal(appliedImport.nextEpoch, 12)
  assert.equal(appliedImport.importClamped, true)
})

test('storage status reports the server canonical weather city across restart', async () => {
  const harness = makeController({ remoteOptions: { weatherCity: '广州' } })
  await harness.controller.setMode({ mode: 'server', initialSource: 'use-server' })
  assert.equal(harness.controller.status().weatherCity, '广州')
  assert.equal(harness.remote.getWeatherCity(), '广州')

  const restarted = makeController({ dir: harness.dir, local: harness.local, remote: harness.remote })
  const status = await restarted.controller.initialize()
  assert.equal(status.activeMode, 'server')
  assert.equal(status.weatherCity, '广州')
})

test('timezone, weather city and advance policy route through the active command surface', async () => {
  const harness = makeController()
  await harness.controller.setTimeZone('Asia/Tokyo')
  await harness.controller.setWeatherCity('北京')
  await harness.controller.setAdvanceWhileEmpty(false)
  assert.equal(harness.local.commands.map((entry) => entry.type).join(','), 'server.setTimeZone,server.setWeatherCity')
  assert.equal(harness.local.commands[1].payload.city, '北京')
  assert.equal(harness.local.calls.includes('setAdvanceWhileEmpty:false'), true)
  await assert.rejects(harness.controller.setTimeZone('Not/AZone'), /invalid IANA timeZone|invalid timezone/)
})

test('legacy v1 save migrates to v2 once, keeps a backup, and reports migration status', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'legacy.json'), JSON.stringify(fixtures.save))
  const repo = createLocalRepository({
    documentPath: join(dir, 'save.v2.json'),
    legacySavePath: join(dir, 'legacy.json'),
    legacyBackupPath: join(dir, 'legacy.json.bak'),
    documentBackupPath: join(dir, 'save.v2.json.bak'),
    localDeviceId: LOCAL_DEVICE_ID,
    seedHex: '000102030405060708090a0b0c0d0e0f',
    timeZone: 'Asia/Shanghai',
    autoScheduler: false,
  }, { authorityState: 'local-v2-active', rendererCapability: true, env: ACTIVATION_ENV })
  const projection = await repo.start()
  assert.ok(projection)
  assert.equal(projection.save.havePet, true)
  assert.equal(repo.getMigrationStatus().state, 'migrated_legacy')
  assert.equal(repo.getMigrationStatus().source, 'save.json')
  assert.ok(repo.getMigrationStatus().backupPath)
  assert.equal(existsSync(join(dir, 'legacy.json.bak')), true)
  assert.equal(existsSync(join(dir, 'save.v2.json')), true)
  await repo.stop()
})

test('local repository fences to read-only, rolls back detach, and archives on demand', async () => {
  const dir = tempDir()
  const repo = createLocalRepository({
    documentPath: join(dir, 'save.v2.json'),
    localDeviceId: LOCAL_DEVICE_ID,
    seedHex: '000102030405060708090a0b0c0d0e0f',
    timeZone: 'Asia/Shanghai',
    autoScheduler: false,
  }, { authorityState: 'local-v2-active', rendererCapability: true, env: ACTIVATION_ENV })
  await repo.start()
  const bundle = await repo.exportForDetach(0)
  assert.equal(bundle.authority.owner, 'local')
  assert.equal(repo.getStatus().authorityState, 'handoff_pending')
  assert.equal(repo.getStatus().readOnly, true)
  await repo.rollbackDetach()
  assert.equal(repo.getStatus().authorityState, 'active')
  assert.equal(repo.getStatus().readOnly, false)
  await repo.archiveAuthority('use_server')
  assert.equal(repo.getStatus().authorityState, 'archived')
  assert.equal(repo.getStatus().readOnly, true)
  const fenced = await repo.loadFenced()
  assert.ok(fenced)
  assert.equal(repo.getStatus().readOnly, true)
  await repo.stop()
})

test('server portable import reports clamp, authority and restore-generation reset fields', async () => {
  const harness = makeController()
  await harness.controller.setMode({ mode: 'server', initialSource: 'use-server' })
  const bundle = clone(fixtures.bundle)
  bundle.authority.restoreGeneration = 4
  harness.remote.commandResults.push(applied('admin.importPortableBundle', {
    imported: true,
    epoch: 9,
    effectiveAnchorWallMs: GAME_TIME_MS,
    clockSkippedMs: 3_600_000,
    importClamped: true,
  }))
  const report = await harness.controller.importBundle({ json: JSON.stringify(bundle), allowClamp: true })
  assert.equal(report.status, 'applied')
  assert.equal(report.mode, 'server')
  assert.equal(report.importClamped, true)
  assert.equal(report.clockSkippedMs, 3_600_000)
  assert.equal(report.nextEpoch, 9)
  assert.equal(report.restoreGenerationReset, true)
  assert.equal(report.restoreGenerationBefore, 1)
  assert.equal(report.restoreGenerationAfter, 4)
  assert.equal(harness.remote.commands[0].payload.allowClamp, true)
})
