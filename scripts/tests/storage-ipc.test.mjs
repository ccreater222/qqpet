import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const handlers = new Map()
globalThis.__storageIpcHandlers = handlers

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      const source = `const handlers = globalThis.__storageIpcHandlers
export const ipcMain = {
  handle(channel, handler) { handlers.set(channel, handler) },
}`
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
    }
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

const { installStorageIpc, assertTrustedStorageIpcSender } = await import('../../src/main/storage-ipc.ts')
const { DesktopStorageController } = await import('../../src/main/storage-controller.ts')
const { IPC } = await import('../../src/shared/ipc.ts')

function makeController() {
  const calls = []
  const mainFrame = { parent: null, url: 'file:///app/index.html' }
  const sender = {
    mainFrame,
    getURL: () => 'file:///app/index.html',
    send() {},
  }
  const controller = {
    calls,
    acceptsSender(value) { return value === sender },
    acceptsSenderFrame(value, frame) { return value === sender && frame === mainFrame },
    status() { calls.push('status'); return { mode: 'local' } },
    setMode(input) { calls.push(['setMode', input]); return { mode: input.mode } },
    pair(input) { calls.push(['pair', input]); return { paired: true } },
    unpair() { calls.push('unpair'); return {} },
    listDevices() { calls.push('listDevices'); return { devices: [] } },
    revokeDevice(deviceId) { calls.push(['revokeDevice', deviceId]); return { devices: [] } },
    setTimeZone(timeZone) { calls.push(['setTimeZone', timeZone]); return {} },
    setWeatherCity(city) { calls.push(['setWeatherCity', city]); return {} },
    exportBundle() { calls.push('exportBundle'); return { json: '{}' } },
    importBundle(input) { calls.push(['importBundle', input]); return { status: 'applied' } },
    retryHandoff() { calls.push('retryHandoff'); return {} },
    rollbackHandoff() { calls.push('rollbackHandoff'); return {} },
    createBackup() { calls.push('createBackup'); return {} },
    getStatus() { calls.push('getStatus'); return { mode: 'server' } },
  }
  return { controller, sender, mainFrame }
}

function invoke(channel, event, ...args) {
  const handler = handlers.get(channel)
  assert.ok(handler, 'registered handler for ' + channel)
  return handler(event, ...args)
}

test('storage admin IPC rejects untrusted main frames for pair/switch/revoke/import/export', async () => {
  handlers.clear()
  const { controller, sender } = makeController()
  installStorageIpc(controller)
  const untrustedEvent = {
    sender: {},
    senderFrame: { parent: null, url: 'file:///evil/index.html' },
  }
  const subframeEvent = {
    sender,
    senderFrame: { parent: {}, url: 'file:///app/index.html' },
  }
  const cases = [
    [IPC.storagePair, [{ serverUrl: 'wss://server.test/v1/sync', code: 'pair-code', deviceLabel: 'Desktop' }]],
    [IPC.storageSetMode, [{ mode: 'server' }]],
    [IPC.storageDeviceRevoke, ['device-player-1']],
    [IPC.storageImportBundle, [{ json: '{"format":"x"}' }]],
    [IPC.storageExportBundle, []],
  ]
  for (const [channel, args] of cases) {
    for (const event of [untrustedEvent, subframeEvent]) {
      await assert.rejects(async () => invoke(channel, event, ...args), /unauthorized: unknown renderer/)
    }
  }
  assert.deepEqual(controller.calls, [])
})

test('storage admin IPC validates arguments before dispatching to the controller', async () => {
  handlers.clear()
  const { controller, sender, mainFrame } = makeController()
  installStorageIpc(controller)
  const trustedEvent = { sender, senderFrame: mainFrame }

  await assert.rejects(async () => invoke(IPC.storagePair, trustedEvent, {}), /invalid_payload: serverUrl/)
  await assert.rejects(async () => invoke(IPC.storagePair, trustedEvent, {
    serverUrl: 'ws://pet.example/v1/sync',
    code: 'pair-code',
    deviceLabel: 'Desktop',
  }), /loopback|wss/i)
  await assert.rejects(async () => invoke(IPC.storageSetMode, trustedEvent, { mode: 'server', allowClamp: 'yes' }), /allowClamp must be a boolean/)
  await assert.rejects(async () => invoke(IPC.storageDeviceRevoke, trustedEvent, ''), /deviceId is required/)
  await assert.rejects(async () => invoke(IPC.storageImportBundle, trustedEvent, { json: '' }), /bundle json is required/)
  await assert.rejects(async () => invoke(IPC.storageImportBundle, trustedEvent, { json: '{}', rebindLocalSessions: 1 }), /rebindLocalSessions must be a boolean/)
  await assert.rejects(async () => invoke(IPC.storageSetTimeZone, trustedEvent, 'Not/AZone'), /timeZone/i)
  assert.deepEqual(controller.calls, [])

  const paired = await invoke(IPC.storagePair, trustedEvent, {
    serverUrl: 'wss://pet.example/v1/sync',
    code: 'pair-code',
    deviceLabel: 'Desktop',
  })
  assert.equal(paired.paired, true)
  const imported = await invoke(IPC.storageImportBundle, trustedEvent, { json: '{"format":"x"}', allowClamp: true })
  assert.equal(imported.status, 'applied')
  await invoke(IPC.storageExportBundle, trustedEvent)
  assert.equal(controller.calls.length, 3)
  assert.equal(controller.calls[0][0], 'pair')
  assert.equal(controller.calls[1][0], 'importBundle')
  assert.equal(controller.calls[1][1].allowClamp, true)
  assert.equal(controller.calls[2], 'exportBundle')
})

test('trusted sender helper is exported for the file-dialog storage path', () => {
  handlers.clear()
  const { controller, sender, mainFrame } = makeController()
  assert.doesNotThrow(() => assertTrustedStorageIpcSender(controller, { sender, senderFrame: mainFrame }))
  assert.throws(
    () => assertTrustedStorageIpcSender(controller, { sender, senderFrame: { parent: {}, url: 'file:///app/index.html' } }),
    /unauthorized: unknown renderer/,
  )
})


test('controller trusted-frame check requires the window main frame and matching origin', () => {
  const mainFrame = { parent: null, url: 'file:///app/index.html' }
  const sender = {
    mainFrame,
    getURL: () => 'file:///app/index.html',
    send() {},
  }
  const controller = new DesktopStorageController({
    userDataPath: '/tmp/qqpet-storage-ipc-test',
    appVersion: 'test',
    local: {},
    createRemote: () => { throw new Error('unused') },
    createTokenStore: () => { throw new Error('unused') },
  })
  controller.attachWindow({ isDestroyed: () => false, webContents: sender })
  assert.equal(controller.acceptsSenderFrame(sender, mainFrame), true)
  assert.equal(controller.acceptsSenderFrame(sender, { parent: {}, url: 'file:///app/index.html' }), false)
  assert.equal(controller.acceptsSenderFrame(sender, { parent: null, url: 'file:///evil/index.html' }), false)
  assert.equal(controller.acceptsSenderFrame({}, mainFrame), false)
  assert.equal(controller.acceptsSenderFrame(sender, undefined), false)
})
