import type { DeviceInfo, StorageDeviceListView, StorageStatusView } from '../../shared/storage'
import { buildStoragePanelModel, storageStatusRows } from '../../shared/storage'
import type { Option } from './setup'
import { windowView } from './window-view'

/**
 * C11 storage/admin pane. It renders the pure `buildStoragePanelModel` view
 * of the main-process storage controller and never branches gameplay on mode.
 */

let statusValue: StorageStatusView | null = null
let devicesValue: DeviceInfo[] = []
let message = ''
let busy = false
let loaded = false
let knownRestoreGeneration: number | undefined
let redraw = (): void => {}
let subscribed = false
const draft = { serverUrl: '', pairingCode: '', deviceLabel: '我的宠物' }
/** Android pairs as a server-pet client only; the local pet is paused, never uploaded. */
const mobileModeHint = '服务器模式下本机宠物会暂停（不上传、不删除）；切回本机存储后恢复本机宠物。'
const mobileStatusKeys: readonly string[] = ['mode', 'connection', 'authority', 'revision', 'eventSeq']

/**
 * Whether this host is the Android client-only server-mode host. The
 * capability is declared on `QQPetApi.capabilities` by the mobile bridge, so it
 * is read structurally: this pane does not depend on that type landing first.
 */
function serverModeClientOnlyHost(): boolean {
  const capabilities: unknown = window.qqpet.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return false
  return (capabilities as { serverModeClientOnly?: boolean }).serverModeClientOnly === true
}

const reason = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const api = () => window.qqpet.storage

function ensureSubscription(): void {
  const storage = api()
  if (subscribed) return
  if (storage === undefined) return
  subscribed = true
  storage.onStatus((next) => {
    statusValue = next
    redraw()
  })
  storage.onDevices((view) => {
    devicesValue = view.devices
    redraw()
  })
}

export interface StorageRefreshPlan {
  /** Whether this status has a live server session to ask for a device list. */
  listDevices: boolean
  devices: DeviceInfo[]
  message: string
}

/**
 * Pure state merge for one storage-panel refresh. A paired device running on
 * the local authority has no live server session, so it must neither request
 * `listDevices()` nor surface the mobile host's canned
 * `offline: pair a server first` reply as a storage error.
 */
export function planStorageRefresh(
  status: Pick<StorageStatusView, 'paired' | 'activeMode'>,
  view: StorageDeviceListView | null = null,
): StorageRefreshPlan {
  const listDevices = status.paired === true && status.activeMode === 'server'
  if (listDevices === false) return { listDevices: false, devices: [], message: '' }
  if (view === null) return { listDevices: true, devices: [], message: '' }
  const error = view.error
  return {
    listDevices: true,
    devices: view.devices,
    message: error !== undefined && error.startsWith('unauthorized') === false ? error : '',
  }
}

async function refresh(): Promise<void> {
  const storage = api()
  if (storage === undefined) return
  ensureSubscription()
  try {
    statusValue = await storage.status()
    if (statusValue.serverUrl) draft.serverUrl = statusValue.serverUrl
    if (statusValue.deviceLabel) draft.deviceLabel = statusValue.deviceLabel
    if (knownRestoreGeneration === undefined) knownRestoreGeneration = statusValue.authority.restoreGeneration
    const plan = planStorageRefresh(statusValue)
    if (plan.listDevices) {
      const merged = planStorageRefresh(statusValue, await storage.listDevices())
      devicesValue = merged.devices
      message = merged.message
    } else {
      devicesValue = plan.devices
      message = plan.message
    }
  } catch (e) {
    message = '读取存储状态失败：' + reason(e)
  }
  loaded = true
}

/** Called by the setup pane on open, after every action and on pushed status events. */
export function refreshStorage(): void {
  void refresh().finally(() => redraw())
}

function run(label: string, action: () => Promise<unknown>, done?: () => void): void {
  const storage = api()
  if (storage === undefined) {
    message = '此宿主不提供存储管理（移动端仅本机存储）。'
    redraw()
    return
  }
  busy = true
  message = label + '…'
  redraw()
  void action()
    .then(() => {
      done?.()
      return refresh()
    })
    .then(() => { message = label + '完成' })
    .catch((e) => { message = label + '失败：' + reason(e) })
    .finally(() => {
      busy = false
      redraw()
    })
}

function pairAndSwitch(): void {
  const storage = api()
  if (storage === undefined) return
  run('配对并切换到服务器', async () => {
    await storage.pair({ serverUrl: draft.serverUrl, code: draft.pairingCode, deviceLabel: draft.deviceLabel || '我的宠物' })
    await storage.setMode({ mode: 'server', rebindLocalSessions: true })
  })
}

function setServerMode(): void {
  if (statusValue === null) return
  if (statusValue.mode === 'server') return
  if (statusValue.paired === false) {
    if (draft.serverUrl.length === 0) {
      message = '请先填写服务器地址与配对码，然后点「配对」。'
      redraw()
      return
    }
    if (draft.pairingCode.length === 0) {
      message = '请先填写服务器地址与配对码，然后点「配对」。'
      redraw()
      return
    }
    pairAndSwitch()
    return
  }
  const storage = api()
  if (storage === undefined) return
  windowView({
    title: '切换到服务器存储',
    msg: '本机会先冻结并上传权威包，服务器校验导入后才接管；失败会回滚本机，不会出现双权威。确定吗？',
    ok: (close) => {
      close()
      run('切换到服务器', () => storage.setMode({ mode: 'server', rebindLocalSessions: true }))
    },
  })
}

function switchToLocal(): void {
  if (statusValue === null) return
  if (statusValue.mode === 'local') return
  const storage = api()
  if (storage === undefined) return
  windowView({
    title: '切换回本机存储',
    msg: '服务器会归档并导出带代次的权威包；本机校验导入成功后才开始计时。失败时本机只读、服务器保持归档，可重试。确定吗？',
    ok: (close) => {
      close()
      run('切换回本机', () => storage.setMode({ mode: 'local' }))
    },
  })
}

function importBundle(allowClamp: boolean): void {
  run(allowClamp ? '强制对时导入' : '导入存档', async () => {
    const storage = api()
    if (storage === undefined) return
    const report = await storage.importBundleDialog({ allowClamp })
    if (report === null) return
    if (report.status === 'applied') {
      if (report.restoreGenerationReset) {
        message = '导入完成：检测到操作员恢复代次变化，旧缓存已失效。'
      } else if (report.importClamped) {
        message = '导入完成：锚点已按 allowClamp 对时 ' + Math.round((report.clockSkippedMs ?? 0) / 1000) + ' 秒。'
      } else {
        message = '导入完成：引擎状态/RNG/计划/锚点已保留。'
      }
      return
    }
    throw new Error(report.message ?? report.errorCode ?? '导入失败')
  })
}

function storageOptions(): Option[] {
  const storage = api()
  if (storage === undefined) {
    return [{ type: 'see', label: '存储管理', value: '此宿主不提供服务器模式，仅本机存储。' }]
  }
  if (loaded === false) {
    void refresh().finally(() => redraw())
    return [{ type: 'see', label: '状态', value: '正在读取存储状态…' }]
  }
  const status = statusValue
  if (status === null) return [{ type: 'see', label: '状态', value: message || '存储状态不可用。' }]
  if (serverModeClientOnlyHost()) return mobileServerModeOptions(status)
  const model = buildStoragePanelModel(status, devicesValue, { knownRestoreGeneration, pairingDraft: draft })
  const options: Option[] = []

  for (const warning of model.warnings) options.push({ type: 'see', label: '注意', value: warning })
  for (const row of model.rows) options.push({ type: 'see', label: row.label, value: row.value })
  options.push({ type: 'see', label: '状态', value: busy ? '处理中…' : (message || '就绪') })

  if (status.serverModeAvailable === false) {
    options.push({ type: 'see', label: '服务器模式', value: status.serverModeReason === 'mobile_server_mode_forbidden' ? '移动端不可用（仅本机存储）' : '此平台不可用' })
    return options
  }

  options.push({ type: 'radio', label: '存储模式：本机（离线，本机权威）', on: () => status.mode === 'local', run: switchToLocal })
  options.push({ type: 'radio', label: '存储模式：服务器（服务器权威）', on: () => status.mode === 'server', run: setServerMode })

  if (status.paired === false) {
    options.push({ type: 'input', label: '服务器地址（ws:// 或 wss://）', value: () => draft.serverUrl, set: (v) => { draft.serverUrl = v.trim(); redraw() } })
    options.push({ type: 'input', label: '配对码（一次性，10 分钟有效）', value: () => draft.pairingCode, set: (v) => { draft.pairingCode = v.trim(); redraw() } })
    options.push({ type: 'input', label: '本机设备名', value: () => draft.deviceLabel, set: (v) => { draft.deviceLabel = v.trim(); redraw() } })
    options.push({ type: 'button', label: '配对服务器', run: pairAndSwitch })
  } else {
    options.push({ type: 'see', label: '配对设备', value: (status.deviceRole ?? 'player') + ' / ' + (status.deviceId ?? '—') })
    if (status.petId) options.push({ type: 'see', label: '宠物 ID', value: status.petId })
    if (status.mode === 'local') options.push({ type: 'button', label: '解除配对（令牌作废）', run: unpairNow })
    if (model.canRevokeDevices) {
      for (const device of devicesValue) {
        const revoked = device.revokedAtMs === undefined ? '' : '（已撤销）'
        options.push({ type: 'see', label: '设备', value: device.role + ' / ' + device.label + revoked + ' ' + device.deviceId })
        if (device.revokedAtMs === undefined) {
          options.push({ type: 'button', label: '撤销设备 ' + device.label, run: () => revokeNow(device.deviceId) })
        }
      }
      options.push({ type: 'button', label: '刷新设备列表', run: () => run('刷新设备列表', () => listNow()) })
    }
  }

  options.push({ type: 'button', label: '上传本机宠物到服务器', run: () => uploadNow('upload-local') })
  options.push({ type: 'button', label: '使用服务器宠物（归档本机）', run: () => uploadNow('use-server') })

  let showHandoff = status.handoff.state === 'frozen'
  if (status.handoff.state === 'failed') showHandoff = true
  if (status.handoff.retryable === true) showHandoff = true
  if (showHandoff) {
    options.push({ type: 'see', label: '交接', value: status.handoff.direction + ' / ' + status.handoff.state + ' / ' + (status.handoff.message ?? '') })
    if (status.handoff.retryable === true) options.push({ type: 'button', label: '重试交接（同一 opId，不换代次）', run: retryNow })
    options.push({ type: 'button', label: '回滚交接（仅确认被拒绝时解冻）', run: rollbackNow })
  }
  if (status.handoff.cancelledSessionKinds && status.handoff.cancelledSessionKinds.length > 0) {
    options.push({ type: 'see', label: '会话重绑', value: '未重绑并已取消：' + status.handoff.cancelledSessionKinds.join('、') + '（无奖励）' })
  } else if (status.handoff.rebindReported) {
    options.push({ type: 'see', label: '会话重绑', value: '已请求把本机发起中的会话重绑到当前服务器设备。' })
  }

  options.push({ type: 'radio', label: '无人时推进（服务器零客户端 / 本机关闭）', on: () => status.advanceWhileEmpty, run: toggleAdvance })
  options.push({ type: 'input', label: '时区（IANA，如 Asia/Shanghai）', value: () => status.timeZone, set: (v) => run('设置时区', () => setTimeZoneNow(v.trim())) })
  options.push({ type: 'input', label: '天气城市（留空自动定位）', value: () => status.weatherCity, set: (v) => run('设置天气城市', () => setWeatherNow(v)) })
  options.push({ type: 'button', label: '导出便携存档（含引擎/RNG/计划）', run: exportNow })
  options.push({ type: 'button', label: '导入便携存档（默认拒绝越界锚点）', run: () => importBundle(false) })
  options.push({ type: 'button', label: '既导入又可强制对时（allowClamp）', title: '仅当锚点超出 48 小时 / 5 分钟窗口且你明确接受对时；会平移所有剩余期限，不补发跳过的事件。', run: () => importBundle(true) })
  options.push({ type: 'button', label: '创建导入前备份', run: backupNow })
  return options
}

/**
 * Android's server-mode client pane: pairing, mode switching and unpair only.
 * Upload-to-server, server-pet handoff, handoff retry/rollback, bundle import,
 * backups and owner device revocation are desktop storage-controller concepts
 * the mobile host rejects, so this pane never renders or calls them.
 */
function mobileServerModeOptions(status: StorageStatusView): Option[] {
  const options: Option[] = []
  if (status.serverModeAvailable === false) {
    options.push({ type: 'see', label: '注意', value: '服务器模式当前不可用：' + (status.serverModeReason ?? '宿主未报告原因') + '（本机存储不受影响）' })
  }
  if (status.notice === 'authority_reset_required') {
    options.push({ type: 'see', label: '注意', value: '服务器权威已被操作员重置：缓存已丢弃，正在重新同步快照。' })
  } else if (status.notice === 'device_revoked') {
    options.push({ type: 'see', label: '注意', value: '这台设备已被服务器撤销，请解除配对后重新配对。' })
  } else if (status.notice) {
    options.push({ type: 'see', label: '注意', value: status.notice })
  }
  if (status.readOnly) options.push({ type: 'see', label: '注意', value: '当前投影只读：服务器权威尚未活动，游戏命令暂不可用。' })
  if (status.lastError) options.push({ type: 'see', label: '最近错误', value: status.lastError })
  for (const row of storageStatusRows(status)) {
    if (mobileStatusKeys.includes(row.key)) options.push({ type: 'see', label: row.label, value: row.value })
  }
  if (status.serverUrl) options.push({ type: 'see', label: '服务器', value: status.serverUrl })
  options.push({ type: 'see', label: '状态', value: busy ? '处理中…' : (message || '就绪') })
  options.push({ type: 'see', label: '说明', value: mobileModeHint })

  if (status.paired === false) {
    options.push({ type: 'see', label: '本机测试', value: '电脑执行 adb reverse tcp:8787 tcp:8787 后填 ws://127.0.0.1:8787/v1/sync；其余场景一律用 wss://，不要用明文 ws://。' })
    options.push({ type: 'input', label: '服务器地址（ws:// 或 wss://）', value: () => draft.serverUrl, set: (v) => { draft.serverUrl = v.trim(); redraw() } })
    options.push({ type: 'input', label: '配对码（一次性，10 分钟有效）', value: () => draft.pairingCode, set: (v) => { draft.pairingCode = v.trim(); redraw() } })
    options.push({ type: 'input', label: '设备名', value: () => draft.deviceLabel, set: (v) => { draft.deviceLabel = v.trim(); redraw() } })
    options.push({ type: 'button', label: '配对并使用服务器宠物', run: pairAndUseServerPet })
    return options
  }

  options.push({ type: 'see', label: '设备角色', value: status.deviceRole ?? 'player' })
  options.push({ type: 'see', label: '设备 ID', value: status.deviceId ?? '—' })
  options.push({ type: 'see', label: '宠物 ID', value: status.petId ?? '—' })
  // Owner devices are displayed read-only; revocation stays on the desktop owner.
  if (status.deviceRole === 'owner') {
    for (const device of devicesValue) {
      const revoked = device.revokedAtMs === undefined ? '' : '（已撤销）'
      options.push({ type: 'see', label: '设备', value: device.role + ' / ' + device.label + revoked + ' ' + device.deviceId })
    }
  }
  options.push({ type: 'button', label: '使用服务器宠物', run: useServerPet })
  options.push({ type: 'button', label: '回到本机存储', run: backToLocal })
  options.push({ type: 'button', label: '解除配对', run: unpairFromMobile })
  return options
}

function pairAndUseServerPet(): void {
  const storage = api()
  if (storage === undefined) return
  if (draft.serverUrl.length === 0 || draft.pairingCode.length === 0) {
    message = '请先填写服务器地址与一次性配对码。'
    redraw()
    return
  }
  run('配对并切换到服务器', async () => {
    await storage.pair({ serverUrl: draft.serverUrl, code: draft.pairingCode, deviceLabel: draft.deviceLabel || '我的宠物' })
    draft.pairingCode = ''
    await storage.setMode({ mode: 'server' })
  })
}

function useServerPet(): void {
  const storage = api()
  const status = statusValue
  if (storage === undefined || status === null) return
  if (status.mode === 'server') {
    message = '当前已在使用服务器宠物。'
    redraw()
    return
  }
  windowView({
    title: '使用服务器宠物',
    msg: '本机宠物会暂停（不上传、不删除），游戏改由服务器权威推进；切回本机存储后恢复本机宠物。确定吗？',
    ok: (close) => {
      close()
      run('使用服务器宠物', () => storage.setMode({ mode: 'server' }))
    },
  })
}

function backToLocal(): void {
  const storage = api()
  const status = statusValue
  if (storage === undefined || status === null) return
  if (status.mode === 'local') {
    message = '当前已回到本机存储。'
    redraw()
    return
  }
  windowView({
    title: '回到本机存储',
    msg: '切回本机后恢复本机宠物；服务器宠物仍由服务器管理，本机令牌保留，可随时再切回。确定吗？',
    ok: (close) => {
      close()
      run('回到本机存储', () => storage.setMode({ mode: 'local' }))
    },
  })
}

function unpairFromMobile(): void {
  const storage = api()
  if (storage === undefined) return
  windowView({
    title: '解除配对',
    msg: '会清除本机保存的服务器设备令牌与投影缓存，服务器上的宠物不受影响；本机宠物恢复可用。确定吗？',
    ok: (close) => {
      close()
      run('解除配对', () => storage.unpair())
    },
  })
}

function unpairNow(): void {
  const storage = api()
  if (storage === undefined) return
  run('解除配对', () => storage.unpair())
}

function revokeNow(deviceId: string): void {
  const storage = api()
  if (storage === undefined) return
  run('撤销设备', () => storage.revokeDevice(deviceId))
}

function listNow(): Promise<unknown> {
  const storage = api()
  if (storage === undefined) return Promise.resolve()
  return storage.listDevices()
}

function uploadNow(source: 'upload-local' | 'use-server'): void {
  const storage = api()
  if (storage === undefined) return
  run('切换存储模式', () => storage.setMode({ mode: 'server', initialSource: source, rebindLocalSessions: source === 'upload-local' }))
}

function retryNow(): void {
  const storage = api()
  if (storage === undefined) return
  run('重试交接', () => storage.retryHandoff())
}

function rollbackNow(): void {
  const storage = api()
  if (storage === undefined) return
  run('回滚交接', () => storage.rollbackHandoff())
}

function toggleAdvance(): void {
  const storage = api()
  if (storage === undefined) return
  const status = statusValue
  if (status === null) return
  run('切换无人时推进', () => storage.setAdvanceWhileEmpty(status.advanceWhileEmpty === false))
}

function setTimeZoneNow(timeZone: string): Promise<unknown> {
  const storage = api()
  if (storage === undefined) return Promise.resolve()
  return storage.setTimeZone(timeZone)
}

function setWeatherNow(city: string): Promise<unknown> {
  const storage = api()
  if (storage === undefined) return Promise.resolve()
  return storage.setWeatherCity(city)
}

function backupNow(): void {
  const storage = api()
  if (storage === undefined) return
  run('创建备份', () => storage.createBackup())
}

function exportNow(): void {
  const storage = api()
  if (storage === undefined) return
  run('导出便携存档', () => window.qqpet.exportSave())
}

/** The setup tab; `redraw` receives setup's repaint callback while the pane is open. */
export function storageTab(draw: () => void): { label: string; get options(): Option[] } {
  redraw = draw
  return { label: '存储', get options() { return storageOptions() } }
}
