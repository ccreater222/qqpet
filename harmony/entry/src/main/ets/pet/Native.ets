import { fileIo as fs } from '@kit.CoreFileKit'
import { http } from '@kit.NetworkKit'
import { BusinessError, pasteboard } from '@kit.BasicServicesKit'
import { picker } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'
import { PetHost } from './PetHost'

function host(): PetHost {
  return PetHost.inst as PetHost
}

function num(v: number | string): number {
  return typeof v === 'number' ? v : Number(v)
}

function flag(v: boolean | string | number): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

export class Native {
  static readonly METHODS: string[] = [
    'read', 'write', 'readStateFile', 'readLegacySave', 'writeAtomic', 'http', 'exportSave', 'importSave',
    'openGame', 'quit', 'copyText', 'openUrl', 'setFocusable', 'setAutoStart',
    'setTray', 'setHidden', 'setBounds', 'safeArea'
  ]

  read(name: string): string {
    const path = `${host().context.filesDir}/${name}`
    try {
      return fs.readTextSync(path)
    } catch (_e) {
      return ''
    }
  }

  write(name: string, text: string): void {
    const dir = host().context.filesDir
    const tmp = `${dir}/${name}.tmp`
    const file = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC)
    fs.writeSync(file.fd, text)
    fs.closeSync(file)
    fs.renameSync(tmp, `${dir}/${name}`)
  }

  /** Exact v2 state writes only; save.json and arbitrary app-private paths are rejected. */
  private validStateName(name: string): boolean {
    if (name === 'save.v2.json' || name === 'save.v2.json.bak' || name === 'save.json.bak') return true
    const prefix = 'save.v2.json.corrupt-'
    if (name.startsWith(prefix) === false) return false
    const suffix = name.substring(prefix.length)
    if (suffix.length === 0) return false
    for (let index = 0; index < suffix.length; index++) {
      const code = suffix.charCodeAt(index)
      if (code < 48 || code > 57) return false
    }
    return true
  }

  private okRead(text: string | null): string {
    return JSON.stringify({ status: 'ok', text: text })
  }

  private errorRead(message: string): string {
    return JSON.stringify({ status: 'error', error: message })
  }

  private isMissing(error: BusinessError): boolean {
    const code = `${error.code ?? ''}`
    const message = error.message ?? ''
    return code === '13900002' || code === '2' || message.toLowerCase().includes('no such file')
  }

  private readFileResult(path: string): string {
    try {
      if (fs.accessSync(path) === false) return this.okRead(null)
      return this.okRead(fs.readTextSync(path))
    } catch (error) {
      const failure = error as BusinessError
      if (this.isMissing(failure)) return this.okRead(null)
      return this.errorRead(failure.message ?? 'native state read failed')
    }
  }

  /** Missing is ok+null; read failures are errors that the host must not migrate over. */
  readStateFile(name: string): string {
    if (this.validStateName(name) === false) return this.errorRead('Invalid local state filename')
    return this.readFileResult(`${host().context.filesDir}/${name}`)
  }

  /** save.json is intentionally outside the state allowlist; only this read-only legacy bridge may read it. */
  readLegacySave(): string {
    return this.readFileResult(`${host().context.filesDir}/save.json`)
  }

  /** fsync temp and parent before acknowledging the atomic rename. */
  writeAtomic(name: string, text: string): boolean {
    if (this.validStateName(name) === false) return false
    const dir = host().context.filesDir
    const tmp = `${dir}/.${name}.${Date.now()}.tmp`
    try {
      const file = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC)
      try {
        fs.writeSync(file.fd, text)
        fs.fsyncSync(file.fd)
      } finally {
        fs.closeSync(file)
      }
      fs.renameSync(tmp, `${dir}/${name}`)
      try {
        const parent = fs.openSync(dir, fs.OpenMode.READ_ONLY)
        try {
          fs.fsyncSync(parent.fd)
        } finally {
          fs.closeSync(parent)
        }
      } catch (_e) {
      }
      return true
    } catch (_e) {
      try { fs.unlinkSync(tmp) } catch (_ignored) {}
      return false
    }
  }
  http(id: number | string, method: string, url: string, headers: string, body: string): void {
    const hid = num(id)
    const client = http.createHttp()
    const extra: Record<string, string> = {}
    try {
      const h = JSON.parse(headers) as Record<string, string>
      const keys = Object.keys(h)
      for (let i = 0; i < keys.length; i++) {
        extra[keys[i]] = h[keys[i]]
      }
    } catch (_e) {
    }
    const opts: http.HttpRequestOptions = {
      method: method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
      header: extra,
      connectTimeout: 60000,
      readTimeout: 60000
    }
    if (body.length > 0) {
      opts.extraData = body
    }
    client.request(url, opts).then((res: http.HttpResponse) => {
      const text = typeof res.result === 'string' ? res.result : JSON.stringify(res.result)
      host().resolve(hid, JSON.stringify({ status: res.responseCode, body: text }))
      client.destroy()
    }).catch((e: Error) => {
      host().resolve(hid, null, e.toString())
      client.destroy()
    })
  }

  exportSave(id: number | string, name: string, text: string): void {
    const hid = num(id)
    const doc = new picker.DocumentViewPicker(host().context)
    doc.save({ newFileNames: [name] }).then((uris: string[]) => {
      if (!uris || uris.length === 0) {
        host().resolve(hid, null)
        return
      }
      const f = fs.openSync(uris[0], fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.TRUNC)
      fs.writeSync(f.fd, text)
      fs.closeSync(f)
      host().resolve(hid, 'true')
    }).catch((_e: Error) => {
      host().resolve(hid, null)
    })
  }

  importSave(id: number | string): void {
    const hid = num(id)
    const doc = new picker.DocumentViewPicker(host().context)
    doc.select({ maxSelectNumber: 1 }).then((uris: string[]) => {
      if (!uris || uris.length === 0) {
        host().resolve(hid, null)
        return
      }
      // readTextSync takes sandbox paths only; picker results are URIs.
      const f = fs.openSync(uris[0], fs.OpenMode.READ_ONLY)
      const buf = new ArrayBuffer(fs.statSync(f.fd).size)
      fs.readSync(f.fd, buf)
      fs.closeSync(f)
      host().resolve(hid, util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf)))
    }).catch((_e: Error) => {
      host().resolve(hid, null)
    })
  }

  openGame(swf: string, windowId?: number): void {
    host().openGame(swf, windowId ?? -1)
  }

  quit(): void {
    host().quit()
  }

  copyText(text: string): void {
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text)
    pasteboard.getSystemPasteboard().setData(data)
  }

  openUrl(url: string): void {
    host().start({
      bundleName: host().context.abilityInfo.bundleName,
      abilityName: 'EntryAbility',
      parameters: { kind: 'url', url: url }
    })
  }

  setFocusable(on: boolean | string | number): void {
    host().setFocusable(flag(on))
  }

  setAutoStart(on: boolean | string | number): void {
    host().setAutoStart(flag(on))
  }

  setTray(icon: string, tip: string): void {
    host().setTray(icon, tip === 'null' ? '' : tip)
  }

  setHidden(on: boolean | string | number): void {
    host().setHidden(flag(on))
  }

  setBounds(rect: string): void {
    const p = rect.split(',')
    host().setBounds(num(p[0]), num(p[1]), num(p[2]), num(p[3]), num(p[4]))
  }

  safeArea(viewport: number | string): string {
    return host().safeArea(num(viewport))
  }
}
