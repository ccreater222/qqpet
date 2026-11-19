import { join } from 'node:path'
import { BrowserWindow, ipcMain, net } from 'electron'
import { IPC } from '../shared/ipc'
import { UPSTREAM_NOT_CONFIGURED, normalizeUpstreamUrl } from '../shared/upstream'
import { APP_VERSION } from '../shared/version'
import { downloadPack, findFullPack, findPack, hasBundledContent, importPack, installedContent, resetPacks } from './content'
import { APP_ORIGIN } from './protocol'
import { relaunch } from './relaunch'
import { e2eWindowsHidden } from './window'

const PAGES = process.env.ELECTRON_RENDERER_URL ?? APP_ORIGIN

/**
 * The HTTP origin behind the address typed on the first-run page: an https:// origin (http:// for a local server) or
 * a wss://…/v1/sync address. Anything else is a configuration error, never a fallback to a third-party host.
 */
function requestedBase(address: string | undefined): string {
  const value = (address ?? '').trim()
  if (!value) throw new Error('请先填写 qqpet-server 地址（https:// 或 wss://）')
  const base = normalizeUpstreamUrl(value)
  if (base === null) throw new Error('服务器地址需要以 https:// 或 wss:// 开头，例如 https://pet.example.com')
  return base
}

/** The base findFull used in this window: the pack's relative url resolves against it, not against a later page edit. */
let offersFrom = ''

/** Content pack calls (#28), for the settings panel and the lite installer's first-run window alike. */
export function registerPackIpc(getBase: () => string | null): void {
  ipcMain.handle(IPC.packInfo, () => ({ content: installedContent(), shell: APP_VERSION, bundled: hasBundledContent }))
  ipcMain.handle(IPC.importPack, (e) => importPack(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(IPC.resetPacks, () => resetPacks())
  ipcMain.handle(IPC.findPack, () => {
    // The pet's own content update: the upstream main resolved (paired server, else the device setting).
    const base = getBase()
    if (base === null) throw new Error(`${UPSTREAM_NOT_CONFIGURED}: 未配置上游服务器，无法获取内容包列表`)
    return findPack(net.fetch, base)
  })
  ipcMain.handle(IPC.findFullPack, (_e, serverUrl?: string) => {
    offersFrom = requestedBase(serverUrl)
    return findFullPack(net.fetch, offersFrom)
  })
  // The address passed back is informational: the pack offered by findFull/findPack keeps the base it came from.
  ipcMain.handle(IPC.downloadPack, (e, _serverUrl?: string) =>
    downloadPack(net.fetch, offersFrom, (p) => e.sender.isDestroyed() || e.sender.send(IPC.packProgress, p)),
  )
  ipcMain.on(IPC.relaunch, () => relaunch())
}

/**
 * A lite installer (#28) starts without pet content: a plain window offers to download the latest full pack from a
 * qqpet-server or import one, then relaunches into the pet. Closing it quits.
 */
export function openFirstRun(): BrowserWindow {
  const hidden = e2eWindowsHidden()
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'QQ宠物 - 准备宠物内容',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      // Hidden E2E windows must not have their renderer throttled.
      ...(hidden ? { backgroundThrottling: false } : {}),
    },
  })
  win.setMenu(null)
  win.once('ready-to-show', () => {
    if (!hidden) win.show()
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void win.loadURL(`${PAGES}/firstrun.html`)
  return win
}
