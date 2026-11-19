import { APP_VERSION } from '../../shared/version'
import { UPSTREAM_NOT_CONFIGURED, normalizeUpstreamUrl } from '../../shared/upstream'
import type { Release } from '../../shared/ipc'
import { save, update } from '../pet/store'
import { FIRST_RUN_UPSTREAM_KEY } from '../first-run-flow'
import { windowView } from './window-view'

const DAY = 86400

/** The message of a rejected invoke, without Electron's channel prefix. */
const messageOf = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** x.y.z compared numerically; pre-release and build metadata are ignored. */
function newer(a: string, b: string): boolean {
  const pa = a.split(/[+-]/)[0].split('.').map(Number)
  const pb = b.split(/[+-]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/** Offers the download page of a newer release. Only a manual check reports "up to date" and failures. */
export async function checkUpdate(manual: boolean): Promise<void> {
  let r: Release
  try {
    r = await window.qqpet.latestRelease()
  } catch (e) {
    // Without an upstream the automatic check has nothing to ask: skip it quietly and try again later.
    if (!manual) return
    windowView(
      upstreamMissing(e)
        ? { title: '检查更新', msg: '未配置上游服务器，无法检查更新。可以在「关于」里填写 qqpet-server 地址后重试~' }
        : { title: '检查更新', msg: '检查更新失败，请检查网络后重试~' },
    )
    return
  }
  update('settings', { updateCheckedAt: Math.floor(Date.now() / 1000) })
  if (!newer(r.version, APP_VERSION)) {
    if (manual) windowView({ title: '检查更新', msg: `已经是最新版本 v${APP_VERSION}~` })
    return
  }
  const shell = (): void => windowView({
    title: '发现新版本',
    msg: `新版本 v${r.version}（当前 v${APP_VERSION}），点击确认前往 GitHub 下载~`,
    ok: (close) => {
      close()
      window.qqpet.openUrl(r.url)
    },
  })
  // Desktop: a release whose content comes as a small pack on top of ours can skip the full download (#28).
  const offer = await window.qqpet.packs?.find().catch(() => null)
  if (!offer || offer.version !== r.version) return shell()
  windowView({
    title: '发现内容更新',
    msg: `v${r.version} 带来了新的宠物素材，可以只下载 ${(offer.size / 1048576).toFixed(1)} MB 的内容包（v${offer.base} → v${offer.version}），不用重装程序。确认下载内容包，取消则查看完整新版本~`,
    ok: (close) => {
      close()
      void installOffer()
    },
    cancel: shell,
  })
}

/** Downloads the offered pack only after the user agreed; a reload makes the new content show. */
async function installOffer(): Promise<void> {
  const packs = window.qqpet.packs!
  windowView({ title: '内容更新', msg: '正在下载内容包，请稍候~' })
  try {
    const v = await packs.download()
    packReady(v)
  } catch (e) {
    windowView({ title: '内容更新', msg: `内容包安装失败：${ipcError(e)}` })
  }
}

/** Electron prefixes a rejected invoke with the channel name. */
export const ipcError = (e: unknown): string => messageOf(e)

/** True when the failure is "no qqpet-server configured", not a network or data error: the fix is a setting. */
export const upstreamMissing = (e: unknown): boolean => messageOf(e).includes(UPSTREAM_NOT_CONFIGURED)

export function packReady(version: string): void {
  windowView({
    title: '内容更新',
    msg: `内容已更新到 v${version}，重启后生效，现在重启吗？`,
    ok: () => window.qqpet.packs!.relaunch(),
  })
}

/**
 * The qqpet-server the pet takes weather, the calendar and update checks from; empty means offline (the calendar still
 * computes locally). Device-local: never uploaded, and server storage mode uses the paired server instead.
 */
export function setUpstreamUrl(v: string): void {
  const value = v.trim()
  update('settings', { upstreamUrl: value })
  if (value && normalizeUpstreamUrl(value) === null) {
    windowView({ title: '上游服务器', msg: '这个地址用不了：需要 https:// 或 wss:// 地址（例如 https://pet.example.com 或 wss://pet.example.com/v1/sync），公网服务器要用 https。天气、更新和内容包在填对之前都不可用。' })
  }
}

/**
 * The lite first-run window (#28) has no save yet and keeps the server address in localStorage; the pet takes it over
 * as the device-local setting, so weather, updates and content packs keep working after the restart.
 */
function adoptFirstRunUpstream(): void {
  if (save.settings.upstreamUrl) return
  const address = localStorage.getItem(FIRST_RUN_UPSTREAM_KEY)?.trim() ?? ''
  if (address) update('settings', { upstreamUrl: address })
}

/** Hourly look at the clock, so a machine that slept or was offline still checks once a day. */
export function startAutoUpdate(): void {
  adoptFirstRunUpstream()
  const due = (): void => {
    if (save.settings.autoUpdate && Date.now() / 1000 - save.settings.updateCheckedAt >= DAY) void checkUpdate(false)
  }
  due()
  setInterval(due, 3600_000)
}
