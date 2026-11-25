// The phone mail page. The desktop window (ui/email.ts) renders at 355x500 with
// a 1.25 zoom: it fits a 412 dp phone, but its 领取/删除 keys are 35x20 (25 dp),
// its pager 16x20 and its close 25 dp, and the rows are 12 px text. This page
// keeps the same save data (readMails/writeMails) and the same claim/delete
// rules — including the runtime projection's bulk commands — but renders it at
// 1 CSS px = 1 dp: a >=64 dp row per mail (sender 15, subject 13, time 12) that
// opens a scrolling detail, with every action (领取/删除/翻页/一键领取/一键删除)
// at least 44 dp and the sheet's own close at 48. The desktop window is untouched.
import { give } from '../../pet/items'
import { speak } from '../../pet/pet'
import { readMails, writeMails, type Live } from '../../pet/mail'
import { photoUrl } from '../../pet/album'
import { onStoreEvent, runtimeProjectionMode } from '../../pet/store'
import { uiCommands } from '../../pet/command-map'
import { commandResultGoods, commandSucceeded, dispatchRuntimeCommand } from '../../pet/runtime-command'
import '../css/phone-pages.css'
import { formatDate } from '../date'
import { div, img } from '../dom'
import { isFestivalActiveMailKey, showResult } from '../result'
import { MAIL_PAGE_SIZE, mailPage, mailRows, mailTotals, type MailPage, type MailRow } from './phone-pages-model'
import { openSheet, type SheetHandle } from './sheet'

/** The open phone mail sheet, so a second request replaces it instead of stacking. */
let current: SheetHandle | null = null

const activate = (el: HTMLElement, run: () => void): void => {
  el.addEventListener('click', run)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    run()
  })
}

/** `领取`/`删除` as a 48 dp row action, disabled when the mail cannot take it. */
function actionButton(label: string, danger: boolean, run: () => void): HTMLElement {
  const el = div(danger ? 'qp-email-claim qp-email-delete' : 'qp-email-claim', label)
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', label)
  el.tabIndex = 0
  activate(el, run)
  return el
}

/**
 * Opens the phone mail sheet. The claim/delete path is the desktop window's:
 * local mode grants goods and rewrites the save, runtime mode dispatches the
 * same `mailClaim*` / `mailDelete*` commands, and a one-item action stays a
 * single command so the host can report its own errors.
 */
export function openPhoneEmail(): void {
  current?.close()
  current = null

  const mails = readMails()
  // The desktop's snapshot: runtime mode re-reads the projection on every render.
  const liveRows = (): MailRow[] => mailRows(Object.values(runtimeProjectionMode ? readMails() : mails))

  let sheet: SheetHandle | null = null
  let alive = true
  /** The open mail's key (`d`), or null while the list is showing. */
  let selected: number | null = null
  let page = 1

  const body = div('qp-email')
  const footer = div('qp-email-footer')

  function act(list: readonly MailRow[], fromBulk = false): void {
    if (list.length === 0) return
    if (runtimeProjectionMode) {
      const claiming = list.some((mail) => !mail.claimed)
      const allClaimed = list.every((mail) => mail.claimed)
      const allUnclaimed = list.every((mail) => !mail.claimed)
      // 单封领取才展示结果面板；一键领取/删除保持原样，避免逐个弹窗。
      const singleClaim = !fromBulk && list.length === 1 && !list[0].claimed ? list[0] : null
      const commands =
        list.length > 1 && allClaimed
          ? [uiCommands.mailDeleteAll()]
          : list.length > 1 && allUnclaimed
            ? [uiCommands.mailClaimAll()]
            : list.map((mail) => (mail.claimed ? uiCommands.mailDelete(String(mail.key)) : uiCommands.mailClaim(String(mail.key))))
      void Promise.all(commands.map((command) => dispatchRuntimeCommand(command))).then((results) => {
        if (results.every(commandSucceeded) === false) return
        if (claiming) speak({ s: '[host]，邮箱奖励领取成功！~', now: true }, 'speak')
        if (singleClaim !== null) {
          const mail = readMails()[singleClaim.key]
          const host = sheet?.card
          if (host && mail !== undefined && 'l' in mail && isFestivalActiveMailKey(mail.k))
            showResult(host, commandResultGoods(results[0] ?? null), '', { festival: true, shareText: mail.m || 'V我50！' })
        }
        window.setTimeout(() => {
          if (alive) render()
        }, 0)
      })
      return
    }
    const single = !fromBulk && list.length === 1 ? list[0] : null
    let singleFestival: Live | null = null
    for (const row of list) {
      const mail = mails[row.key]
      // New mail may have arrived since the render; a stale row must not resurrect.
      if (mail === undefined || !('l' in mail)) continue
      const live = mail as Live
      if (live.r) mails[live.d] = { d: live.d, e: true, k: live.k }
      else {
        give(live.glb, live.m || '邮箱领取成功！')
        live.r = true
        if (single !== null && row.key === single.key && isFestivalActiveMailKey(live.k)) singleFestival = live
      }
    }
    writeMails(mails)
    render()
    const host = sheet?.card
    if (host && singleFestival !== null)
      showResult(host, singleFestival.glb, '', { festival: true, shareText: singleFestival.m || 'V我50！' })
  }

  function rowElement(row: MailRow): HTMLElement {
    const el = div(
      'qp-email-row',
      img('qp-email-badge', row.claimed ? 'pet/email/yj.png' : 'pet/email/uyj.png'),
      div(
        'qp-email-main',
        div('qp-email-sender', row.sender),
        div('qp-email-subject', row.subject || row.preview),
        div('qp-email-time', `${formatDate(row.time, 'YYYY-MM-DD HH:mm')} · ${row.preview}`),
      ),
      div('qp-email-go', '›'),
    )
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', `${row.sender}，${row.subject || row.preview}，${row.claimed ? '已领取' : '未领取'}`)
    el.tabIndex = 0
    activate(el, () => {
      selected = row.key
      render()
    })
    return el
  }

  function detailElement(row: MailRow): HTMLElement {
    const back = div('qp-email-back', '‹ 返回')
    back.setAttribute('role', 'button')
    back.setAttribute('aria-label', '返回邮件列表')
    back.tabIndex = 0
    activate(back, () => {
      selected = null
      render()
    })
    const photo = row.photoId ? Object.assign(img('qp-email-photo', photoUrl(row.photoId)), { alt: '旅行明信片' }) : null
    const goods = row.goods.length
      ? div(
          'qp-email-detail-goods',
          ...row.goods.map((good) =>
            div('qp-email-good', img('qp-email-good-icon', good.url), div('', `${good.name}*${good.num}`)),
          ),
        )
      : null
    const claim = row.claimed
      ? actionButton('删除', true, () => act([row]))
      : actionButton('领取', false, () => act([row]))
    return div(
      'qp-email-detail',
      div('qp-email-head', back),
      div('qp-email-detail-subject', row.subject || '（无主题）'),
      div('qp-email-detail-meta', `${row.sender} · ${formatDate(row.time, 'YYYY-MM-DD HH:mm')}${row.claimed ? ' · 已领取' : ' · 未领取'}`),
      div('qp-email-detail-body', row.body || (row.photo ? '这是一张旅行明信片，照片就在下面。' : '这封邮件没有附言。')),
      ...(photo ? [photo] : []),
      ...(goods ? [goods] : []),
      div('qp-email-detail-actions', claim),
    )
  }

  function pageButton(label: string, enabled: boolean, run: () => void): HTMLElement {
    const el = div('qp-email-page', label)
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', label)
    el.setAttribute('aria-disabled', String(!enabled))
    if (enabled) {
      el.tabIndex = 0
      activate(el, run)
    }
    return el
  }

  function drawFooter(rows: readonly MailRow[], info: MailPage): void {
    const totals = mailTotals(rows)
    const prev = pageButton('‹ 上一页', info.hasPrev, () => {
      page = info.page - 1
      render()
    })
    const next = pageButton('下一页 ›', info.hasNext, () => {
      page = info.page + 1
      render()
    })
    const claimAll = div('qp-email-bulk-act', `一键领取${totals.claimable ? `（${totals.claimable}）` : ''}`)
    const deleteAll = div('qp-email-bulk-act', `一键删除${totals.deletable ? `（${totals.deletable}）` : ''}`)
    for (const [el, label, enabled, run] of [
      [claimAll, '一键领取全部未领取邮件', totals.claimable > 0, () => act(rows.filter((row) => !row.claimed), true)],
      [deleteAll, '一键删除全部已领取邮件', totals.deletable > 0, () => act(rows.filter((row) => row.claimed), true)],
    ] as const) {
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', label)
      el.setAttribute('aria-disabled', String(!enabled))
      if (enabled) {
        el.tabIndex = 0
        activate(el, run)
      }
    }
    footer.replaceChildren(
      div('qp-email-pager', prev, div('qp-email-pageno', `${info.page} / ${info.totalPage}`), next),
      div('qp-email-bulk', claimAll, deleteAll),
    )
  }

  function render(): void {
    const rows = liveRows()
    const detail = selected === null ? undefined : rows.find((row) => row.key === selected)
    if (detail) {
      body.replaceChildren(detailElement(detail))
      footer.hidden = true
      footer.style.display = 'none'
      return
    }
    // The open mail was deleted (or claimed into deletion): fall back to the list.
    selected = null
    footer.hidden = false
    footer.style.display = ''
    if (rows.length === 0) {
      const info = mailPage(rows, 1, MAIL_PAGE_SIZE)
      page = info.page
      body.replaceChildren(div('qp-email-empty', '邮箱里没有邮件啦~'))
      drawFooter(rows, info)
      return
    }
    const info = mailPage(rows, page, MAIL_PAGE_SIZE)
    page = info.page
    body.replaceChildren(div('qp-email-list', ...info.rows.map(rowElement)))
    drawFooter(rows, info)
  }

  render()
  let stopProjection = (): void => {}
  sheet = openSheet({
    title: '邮箱',
    body,
    footer,
    cardClass: 'qp-page-sheet qp-email-sheet',
    onClose: () => {
      alive = false
      stopProjection()
      if (current === sheet) current = null
    },
  })
  current = sheet
  stopProjection = onStoreEvent((event) => {
    if (event.type === 'mail.claimed' && alive) window.setTimeout(() => {
      if (alive) render()
    }, 0)
  })}
