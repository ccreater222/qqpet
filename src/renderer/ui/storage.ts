import type { DeviceInfo, StorageStatusView } from '../../shared/storage'
import { buildStoragePanelModel } from '../../shared/storage'
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

async function refresh(): Promise<void> {
  const storage = api()
  if (storage === undefined) return
  ensureSubscription()
  try {
    statusValue = await storage.status()
    if (statusValue.serverUrl) draft.serverUrl = statusValue.serverUrl
    if (statusValue.deviceLabel) draft.deviceLabel = statusValue.deviceLabel
    if (knownRestoreGeneration === undefined) knownRestoreGeneration = statusValue.authority.restoreGeneration
    if (statusValue.paired) {
      const view = await storage.listDevices()
      devicesValue = view.devices
      if (view.error && view.error.startsWith('unauthorized') === false) message = view.error
    } else {
      devicesValue = []
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
