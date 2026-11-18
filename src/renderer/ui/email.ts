import { give } from '../pet/items'
import { speak } from '../pet/pet'
import { readMails, writeMails, type Live } from '../pet/mail'
import { onStoreEvent, runtimeProjectionMode } from '../pet/store'
import { uiCommands } from '../pet/command-map'
import { commandSucceeded, dispatchRuntimeCommand } from '../pet/runtime-command'
import { photoUrl } from '../pet/album'
import { openPhoto } from './album'
import { openFrame } from './box'
import './css/email.css'
import { formatDate } from './date'
import { button, div, img } from './dom'
import { frame } from './frame'

const BG = ['bg_01.png', 'bg_02.bmp', 'bg_03.png', 'bg_04.bmp', 'bg_05.bmp', 'bg_06.bmp', 'bg_8.png', 'bg_09.png', 'bg_10.png']

const PAGE = 3

let open = false

/** Mail from the save: the original's, and the welcome, birthday and holiday mails. */
export function openEmail(): void {
  if (open) return
  open = true
  const mails = readMails()
  // Newest first: keys are send times, and new mail must not land on the last page.
  const live = (): Live[] => Object.values(runtimeProjectionMode ? readMails() : mails)
    .filter((m): m is Live => m.e === undefined)
    .reverse()
  const act = (list: Live[]): void => {
    if (runtimeProjectionMode) {
      if (list.length === 0) return
      const claiming = list.some(m => m.r !== true)
      const allClaimed = list.every(m => m.r === true)
      const allUnclaimed = list.every(m => m.r === undefined || m.r === false)
      const commands = list.length > 1 && allClaimed
        ? [uiCommands.mailDeleteAll()]
        : list.length > 1 && allUnclaimed
          ? [uiCommands.mailClaimAll()]
          : list.map(m => m.r === true ? uiCommands.mailDelete(String(m.d)) : uiCommands.mailClaim(String(m.d)))
      void Promise.all(commands.map(command => dispatchRuntimeCommand(command))).then((results) => {
        if (results.every(commandSucceeded) === false) return
        if (claiming) speak({ s: '[host]，邮箱奖励领取成功！~', now: true }, 'speak')
        window.setTimeout(render, 0)
      })
      return
    }
    for (const m of list) {
      if (m.r) mails[m.d] = { d: m.d, e: true, k: m.k }
      else {
        give(m.glb, m.m || '邮箱领取成功！')
        m.r = true
      }
    }
    writeMails(mails)
    render()
  }

  let page = 0
  const emails = div('emails f1')
  const at = div('e_at tc')
  const prev = button('e_prev', () => render(page - 1))
  const next = button('e_next', () => render(page + 1))
  const render = (to = page): void => {
    const all = live()
    const last = Math.max(0, Math.ceil(all.length / PAGE) - 1)
    page = Math.min(Math.max(to, 0), last)
    prev.classList.toggle('off', page === 0)
    next.classList.toggle('off', page === last)
    at.textContent = `${page + 1}/${last + 1}`
    emails.replaceChildren(
      ...all.slice(page * PAGE, (page + 1) * PAGE).map((m) =>
        div(
          'email fc',
          div(m.r ? 'leftType yjImg' : 'leftType uyjImg'),
          div(
            'rightMain f1 fC w0',
            div('e_title', m.l),
            div('e_time', formatDate(m.d, 'YYYY-MM-DD HH:mm')),
            div(
              'e_icons f1 mt2',
              m.p
                ? button('e_photo', () => openPhoto(m.p!), img('e_photoImg', photoUrl(m.p)))
                : div('e_goodImgsBox', ...m.glb.map((g) => Object.assign(img('e_goodImgs', g.url), { title: `${g.name}*${g.num}` }))),
            ),
          ),
          button(m.r ? 'fcc rgetEmail' : 'fcc getEmail', () => act([m]), m.r ? '删除' : '领取'),
        ),
      ),
    )
  }
  render()

  let stopProjection = (): void => {}
  const close = (): void => {
    stopProjection()
    closeFrame()
    open = false
  }
  const content = div(
    'Email fC',
    div('titleBox por fcc', div('title fcc', '邮箱'), button('close', close)),
    emails,
    div(
      'e_foot fcc',
      div('e_pager fcc', prev, at, next),
      button('fcc wsnw getEmail getEmails', () => act(live().filter((m) => !m.r)), ' 一键领取 '),
      button('fcc wsnw rgetEmail rgetEmails', () => act(live().filter((m) => m.r)), ' 一键删除 '),
    ),
  )
  const closeFrame = openFrame(
    div(
      'ui-email',
      frame(content, (n) => `pet/email/${BG[n - 1]}`, [12, 12]),
    ),
  )
  stopProjection = onStoreEvent((event) => {
    if (event.type === 'mail.claimed' && open) window.setTimeout(() => render(), 0)
  })
}
