import './firstrun.css'
import { FIRST_RUN_UPSTREAM_KEY, firstRunFlow, mb, type FirstRunState } from './first-run-flow'

// The lite installer's first run (#28): no pet content yet, so this page downloads it from a qqpet-server or imports it.
const api = window.qqpet.packs!
const app = document.getElementById('app')!

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

const serverUrl = el('input', { placeholder: '例如 https://pet.example.com 或 wss://pet.example.com/v1/sync', value: localStorage.getItem(FIRST_RUN_UPSTREAM_KEY) ?? '' })
const status = el('div')
const downloadBtn = el('button', { className: 'primary', textContent: '下载宠物内容' })
const importBtn = el('button', { textContent: '导入本地内容包…' })

const flow = firstRunFlow(api, render)

downloadBtn.onclick = () => {
  localStorage.setItem(FIRST_RUN_UPSTREAM_KEY, serverUrl.value.trim())
  void flow.download(serverUrl.value)
}
importBtn.onclick = () => void flow.importPack()

app.append(
  el('h1', {}, '欢迎使用 QQ宠物（精简版）'),
  el('p', {}, '精简版安装包不带宠物素材。第一次使用需要从 qqpet-server 下载完整内容包（约 360 MB），或导入已经下载好的 .qqpetpack 文件。完成后会自动启动宠物。'),
  el('p', { className: 'muted' }, '内容包由 qqpet-server 的 /v1/client/packs.json 提供；文件会按清单公布的校验值检查。还没有服务器？可以先把 .qqpetpack 下载到本地再导入。'),
  el('div', { className: 'row' }, el('span', {}, 'qqpet-server'), serverUrl),
  status,
  el('div', { className: 'spacer' }),
  el('div', { className: 'row' }, downloadBtn, importBtn),
)

function render(s: FirstRunState): void {
  const busy = s.kind === 'finding' || s.kind === 'downloading' || s.kind === 'installing' || s.kind === 'done'
  downloadBtn.disabled = importBtn.disabled = serverUrl.disabled = busy
  downloadBtn.textContent = s.kind === 'error' ? '重试下载' : '下载宠物内容'
  switch (s.kind) {
    case 'idle':
      return status.replaceChildren()
    case 'finding':
      return status.replaceChildren(el('p', {}, '正在查找最新的内容包…'))
    case 'downloading':
      return status.replaceChildren(
        el('p', {}, `正在下载 v${s.version} 内容包：${mb(s.received)} / ${mb(s.total)}（${Math.floor((s.received / s.total) * 100)}%）`),
        el('progress', { max: s.total, value: s.received }),
      )
    case 'installing':
      return status.replaceChildren(el('p', {}, s.version ? `正在校验并安装 v${s.version} 内容包…` : '请选择 .qqpetpack 文件，选好后会校验并安装（需要几十秒）…'), el('progress'))
    case 'done':
      return status.replaceChildren(el('p', {}, `v${s.version} 内容已安装，正在启动宠物~`))
    case 'error':
      return status.replaceChildren(el('p', { className: 'error' }, `失败：${s.message}`), el('p', { className: 'muted' }, '可以检查网络和服务器地址后重试，或者先把内容包下载到本地再导入。'))
  }
}
