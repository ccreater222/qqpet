import type { DeviceInfo, DeviceRole } from './sync/protocol'
import type { PortablePetBundleV1, WireAuthority } from './sync/protocol'
import type { RendererRepositoryStatus } from './renderer-api'

/**
 * C11 storage/admin surface shared by the Electron main controller, the
 * preload bridge and the renderer storage pane. Everything here is
 * presentation/validation data: bundles and tokens never appear in a status.
 */

export type StorageMode = 'local' | 'server'
export type StorageInitialSource = 'upload-local' | 'use-server'

export const STORAGE_CONFIG_FILE = 'storage-config.json'
export const STORAGE_CONFIG_FORMAT = 'qqpet-storage-config' as const
export const STORAGE_CONFIG_SCHEMA_VERSION = 1 as const

export interface StorageConfigFile {
  format: typeof STORAGE_CONFIG_FORMAT
  schemaVersion: typeof STORAGE_CONFIG_SCHEMA_VERSION
  mode: StorageMode
  serverUrl?: string
  deviceLabel?: string
}

export function defaultStorageConfig(): StorageConfigFile {
  return { format: STORAGE_CONFIG_FORMAT, schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION, mode: 'local' }
}

/** Parses the non-secret storage config; malformed files fall back to local. */
export function parseStorageConfig(value: unknown): StorageConfigFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultStorageConfig()
  const record = value as Record<string, unknown>
  const mode: StorageMode = record.mode === 'server' ? 'server' : 'local'
  return {
    format: STORAGE_CONFIG_FORMAT,
    schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION,
    mode,
    ...(typeof record.serverUrl === 'string' && record.serverUrl.length > 0 ? { serverUrl: record.serverUrl } : {}),
    ...(typeof record.deviceLabel === 'string' && record.deviceLabel.length > 0 ? { deviceLabel: record.deviceLabel } : {}),
  }
}

export interface StorageMigrationStatus {
  state: 'native_v2' | 'migrated_v2' | 'migrated_legacy' | 'fresh' | 'unavailable'
  source?: 'save.json' | 'config.json' | 'save.v2.json'
  backupPath?: string
  notice?: string
  migratedAtWallMs?: number
}

export interface StorageBackupStatus {
  available: boolean
  path?: string
  reason?: string
  createdAtWallMs?: number
}

export interface StorageAuthorityView extends WireAuthority {
  revision: number
  eventSeq: number
  handoffId?: string
  detachedAtWallMs?: number
  localDeviceId?: string
}

export type StorageHandoffDirection = 'local_to_server' | 'server_to_local' | 'none'
export type StorageHandoffState = 'idle' | 'pending' | 'applied' | 'rolled_back' | 'frozen' | 'failed'

export interface StorageHandoffReport {
  direction: StorageHandoffDirection
  state: StorageHandoffState
  /** Short operator-facing status; never contains bundle bytes. */
  message?: string
  reason?: string
  atWallMs?: number
  /** Owner asked the server to rebind local-actor sessions during upload. */
  requestedRebind?: boolean
  rebindReported?: boolean
  cancelledSessionKinds?: string[]
  importClamped?: boolean
  clockSkippedMs?: number
  nextEpoch?: number
  restoreGenerationBefore?: number
  restoreGenerationAfter?: number
  retryable?: boolean
}

export interface StorageStatusView {
  /** Requested mode (what the user picked). */
  mode: StorageMode
  /** Repository that can currently mutate canonical state. */
  activeMode: StorageMode
  serverModeAvailable: boolean
  serverModeReason?: string
  connection: RendererRepositoryStatus['connection']
  serverUrl?: string
  paired: boolean
  petId?: string
  deviceId?: string
  deviceRole?: DeviceRole
  deviceLabel?: string
  authority: StorageAuthorityView
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  weatherCity: string
  advanceWhileEmpty: boolean
  readOnly: boolean
  catchingUp: boolean
  lastError?: string
  notice?: string
  migration: StorageMigrationStatus
  backup: StorageBackupStatus
  handoff: StorageHandoffReport
}

export interface StorageDeviceListView {
  devices: DeviceInfo[]
  owner: boolean
  canRevoke: boolean
  error?: string
}

export interface StorageSetModeInput {
  mode: StorageMode
  serverUrl?: string
  pairingCode?: string
  deviceLabel?: string
  initialSource?: StorageInitialSource
  allowClamp?: boolean
  rebindLocalSessions?: boolean
  /** Owner-selected epoch for `admin.resumeServer`; defaults to the bundle epoch. */
  expectedEpoch?: number
}

export interface StoragePairInput {
  serverUrl: string
  code: string
  deviceLabel: string
}

export interface StorageImportInput {
  json: string
  allowClamp?: boolean
  rebindLocalSessions?: boolean
  expectedEpoch?: number
}

export interface StorageImportReport {
  status: 'applied' | 'rejected' | 'invalid'
  mode: StorageMode
  message?: string
  errorCode?: string
  backupPath?: string
  importClamped?: boolean
  clockSkippedMs?: number
  effectiveAnchorWallMs?: number
  restoreGenerationBefore?: number
  restoreGenerationAfter?: number
  /** True when the incoming bundle carries a newer operator restore generation. */
  restoreGenerationReset: boolean
  rebindRequested?: boolean
  cancelledSessionKinds?: string[]
  nextEpoch?: number
}

export interface StorageExportReport {
  json: string
  fileName: string
  mode: StorageMode
}

export interface StorageApi {
  status(): Promise<StorageStatusView>
  setMode(input: StorageSetModeInput): Promise<StorageStatusView>
  pair(input: StoragePairInput): Promise<StorageStatusView>
  unpair(): Promise<StorageStatusView>
  listDevices(): Promise<StorageDeviceListView>
  revokeDevice(deviceId: string): Promise<StorageDeviceListView>
  setAdvanceWhileEmpty(enabled: boolean): Promise<StorageStatusView>
  setTimeZone(timeZone: string): Promise<StorageStatusView>
  setWeatherCity(city: string): Promise<StorageStatusView>
  exportBundle(): Promise<StorageExportReport>
  importBundle(input: StorageImportInput): Promise<StorageImportReport>
  /** Opens the file picker and imports through the same validated path. */
  importBundleDialog(options?: { allowClamp?: boolean; rebindLocalSessions?: boolean }): Promise<StorageImportReport | null>
  /** Retries a frozen handoff (upload or local import) without requesting a new epoch. */
  retryHandoff(): Promise<StorageStatusView>
  /** Owner rollback: unfreezes local after a rejected/uncertain local->server handoff. */
  rollbackHandoff(): Promise<StorageStatusView>
  createBackup(): Promise<StorageStatusView>
  onStatus(listener: (status: StorageStatusView) => void): void
  onDevices(listener: (view: StorageDeviceListView) => void): void
}

export function emptyHandoffReport(): StorageHandoffReport {
  return { direction: 'none', state: 'idle' }
}

export interface StorageStatusRow {
  key: string
  label: string
  value: string
}

const MODE_LABEL: Record<StorageMode, string> = { local: '本机', server: '服务器' }
const CONNECTION_LABEL: Record<RendererRepositoryStatus['connection'], string> = {
  local: '本机',
  connecting: '连接中',
  online: '在线',
  offline: '离线',
  catching_up: '追赶中',
  error: '错误',
}

/** Display rows for the storage pane; keeps the renderer free of repository branching. */
export function storageStatusRows(status: StorageStatusView): StorageStatusRow[] {
  const authorityState = status.authority.state === 'active'
    ? '活动'
    : status.authority.state === 'archived' ? '已归档' : '已重置'
  return [
    { key: 'mode', label: '存储模式', value: MODE_LABEL[status.mode] },
    { key: 'connection', label: '连接', value: CONNECTION_LABEL[status.connection] },
    { key: 'authority', label: '权威', value: `${status.authority.owner === 'local' ? '本机' : '服务器'} / ${authorityState}` },
    { key: 'authorityId', label: '权威标识', value: status.authority.authorityId || '—' },
    { key: 'epoch', label: '权威代次', value: String(status.authority.epoch) },
    { key: 'restoreGeneration', label: '恢复代次', value: String(status.authority.restoreGeneration) },
    { key: 'revision', label: 'revision', value: String(status.revision) },
    { key: 'eventSeq', label: 'eventSeq', value: String(status.eventSeq) },
    { key: 'gameTime', label: '游戏时间', value: new Date(status.gameTimeMs).toISOString() },
    { key: 'timeZone', label: '时区', value: status.timeZone },
    { key: 'advanceWhileEmpty', label: '无人时推进', value: status.advanceWhileEmpty ? '开' : '关' },
    { key: 'weatherCity', label: '天气城市', value: status.weatherCity || '自动' },
    { key: 'localDevice', label: '本机设备', value: status.authority.localDeviceId ?? '—' },
    ...(status.lastError === undefined ? [] : [{ key: 'lastError', label: '最近错误', value: status.lastError }]),
  ]
}

/**
 * Operator warnings shown above the storage controls. `knownRestoreGeneration`
 * is the generation the UI last observed; a higher value means an operator
 * restored a backup and the authority lineage was reset.
 */
export function storageWarnings(
  status: StorageStatusView,
  options: { knownRestoreGeneration?: number; devices?: DeviceInfo[] } = {},
): string[] {
  const warnings: string[] = []
  const known = options.knownRestoreGeneration
  if (status.notice === 'authority_reset_required') {
    warnings.push('服务器权威已被操作员重置：缓存已丢弃，正在重新同步快照。')
  }
  if (known !== undefined && status.authority.restoreGeneration > known) {
    warnings.push(`检测到权威恢复代次从 ${known} 变为 ${status.authority.restoreGeneration}：这是操作员备份恢复/回滚，旧缓存与旧代次已失效。`)
  }
  if (status.handoff.state === 'frozen') {
    warnings.push('权威交接处于冻结状态：' + (status.handoff.message ?? '来源已冻结，目标尚未确认；请在存储面板重试或回滚。'))
  }
  if (status.handoff.state === 'failed') {
    warnings.push('权威交接失败：' + (status.handoff.message ?? '已保持只读，未产生双权威。'))
  }
  if (status.readOnly && status.handoff.state !== 'frozen' && status.handoff.state !== 'failed') {
    warnings.push('当前投影为只读：权威未处于活动状态，命令不可用。')
  }
  if (status.lastError) warnings.push('最近错误：' + status.lastError)
  if (status.migration.state === 'migrated_legacy') {
    warnings.push('本地旧存档已迁移到 v2（原文件已备份）。')
  }
  if (status.backup.available === false) {
    warnings.push('尚未创建导入前备份。')
  }
  if (options.devices !== undefined && options.devices.every(device => device.revokedAtMs !== undefined || device.role !== 'owner')) {
    warnings.push('没有其他可用的 owner 设备，撤销最后一个 owner 会被服务器拒绝。')
  }
  return warnings
}

export interface StoragePairingView {
  required: boolean
  paired: boolean
  canPair: boolean
  canRevoke: boolean
  owner: boolean
  serverUrl: string
  deviceLabel: string
  deviceId?: string
  role?: DeviceRole
  petId?: string
}

/** Pairing/revoke control state; the renderer only renders this. */
export function storagePairingView(
  status: StorageStatusView,
  draft: { serverUrl?: string; pairingCode?: string; deviceLabel?: string } = {},
): StoragePairingView {
  const serverUrl = draft.serverUrl ?? status.serverUrl ?? ''
  const paired = status.paired
  return {
    required: status.mode === 'server' && paired === false,
    paired,
    canPair: serverUrl.length > 0 && (draft.pairingCode ?? '').length > 0,
    canRevoke: paired && status.mode === 'local',
    owner: status.deviceRole === 'owner',
    serverUrl,
    deviceLabel: draft.deviceLabel ?? status.deviceLabel ?? '',
    ...(status.deviceId === undefined ? {} : { deviceId: status.deviceId }),
    ...(status.deviceRole === undefined ? {} : { role: status.deviceRole }),
    ...(status.petId === undefined ? {} : { petId: status.petId }),
  }
}

export interface StoragePanelModel {
  rows: StorageStatusRow[]
  warnings: string[]
  pairing: StoragePairingView
  mode: StorageMode
  devices: DeviceInfo[]
  canRevokeDevices: boolean
  owner: boolean
}

/** One pure view-model builder used by the renderer and behavior tests. */
export function buildStoragePanelModel(
  status: StorageStatusView,
  devices: DeviceInfo[] = [],
  options: { knownRestoreGeneration?: number; pairingDraft?: { serverUrl?: string; pairingCode?: string; deviceLabel?: string } } = {},
): StoragePanelModel {
  return {
    rows: storageStatusRows(status),
    warnings: storageWarnings(status, {
      ...(options.knownRestoreGeneration === undefined ? {} : { knownRestoreGeneration: options.knownRestoreGeneration }),
      devices,
    }),
    pairing: storagePairingView(status, options.pairingDraft ?? {}),
    mode: status.mode,
    devices,
    canRevokeDevices: status.paired && status.deviceRole === 'owner',
    owner: status.deviceRole === 'owner',
  }
}

export type { DeviceInfo, DeviceRole, PortablePetBundleV1, WireAuthority }
