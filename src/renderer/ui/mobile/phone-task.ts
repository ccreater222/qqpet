// The phone task page. The desktop window (ui/task.ts) is 607x455: on a 412 dp
// phone box.ts shrinks it to 0.64 and the 76 px 领取奖励 button of every row ends
// at x~550-628, i.e. off the screen. This page keeps the same tabs, the same
// tasks() data and the same claim/claimRuntime rules, but renders one task per
// >=64 dp row at 1 CSS px = 1 dp: title 15, progress 13, a >=44 dp reward button
// on the right, and the tasks grouped claimable-first so the action a thumb
// wants is never below a screenful of progress. The desktop window is untouched.
import { claim, claimRuntime, TABS, tasks, type Tab } from '../../pet/tasks'
import { onStoreEvent, runtimeProjectionMode } from '../../pet/store'
import type { Good } from '../../pet/data/goods'
import { div, img } from '../dom'
import { showResult } from '../result'
import { taskRow, taskSections, taskTabs, type TaskRow } from './phone-pages-model'
import { openSheet, type SheetHandle } from './sheet'

/** The open phone task sheet, so a second request replaces it instead of stacking. */
let current: SheetHandle | null = null

const activate = (el: HTMLElement, run: () => void): void => {
  el.addEventListener('click', run)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    run()
  })
}

/**
 * Opens the phone task sheet. Claiming goes through the desktop's own
 * `claim()` / `claimRuntime()`, so the reward rules and the goods stay in one
 * place; only the layout is new.
 */
export function openPhoneTask(): void {
  current?.close()
  current = null

  let sheet: SheetHandle | null = null
  let alive = true
  let tab: Tab = 'daily'
  const body = div('qp-task')
  const tabsRow = div('qp-task-tabs')
  const list = div('qp-task-list')
  body.append(tabsRow, list)

  const rowsFor = (of: Tab): { row: TaskRow; goods: Good[] }[] =>
    tasks(of).map((task, index) => ({ row: taskRow({ ...task, festival: task.festivalId !== undefined }, index), goods: task.good }))

  function claimRow(row: TaskRow): void {
    if (!row.enabled) return
    const host = sheet?.card
    if (!host) return
    const options = row.festival ? { festival: true, shareText: row.msg } : undefined
    if (runtimeProjectionMode) {
      void claimRuntime(tab, row.index).then((goods) => {
        if (!alive) return
        draw()
        if (goods !== null) showResult(host, goods, '', options)
      })
      return
    }
    const goods = claim(tab, row.index)
    draw()
    showResult(host, goods || [], goods ? '' : '还没完成任务哦！~~', options)
  }

  function rowElement(row: TaskRow, goods: readonly Good[]): HTMLElement {
    const reward = div('qp-task-claim', row.action)
    reward.setAttribute('role', 'button')
    reward.setAttribute('aria-label', `${row.title}：${row.action}`)
    reward.setAttribute('aria-disabled', String(!row.enabled))
    if (row.enabled) {
      reward.tabIndex = 0
      activate(reward, () => claimRow(row))
    }
    const rewards = goods.length
      ? div('qp-task-goods', ...goods.map((good) => Object.assign(img('qp-task-good', good.url), { title: `${good.outOfPrint ? '绝版：' : ''}${good.name}*${good.num}` })))
      : div('qp-task-goods')
    const main = div(
      'qp-task-main',
      div('qp-task-title', row.title),
      div('qp-task-progress', `进度 ${row.progress}`),
      div('qp-task-msg', row.msg),
      rewards,
    )
    return div('qp-task-row', main, reward)
  }

  function draw(): void {
    const views = new Map<Tab, { row: TaskRow; goods: Good[] }[]>()
    for (const key of Object.keys(TABS) as Tab[]) views.set(key, rowsFor(key))
    const tabs = taskTabs(
      (Object.keys(TABS) as Tab[]).map((id) => ({ id, label: TABS[id] })),
      Object.fromEntries([...views.entries()].map(([id, rows]) => [id, rows.map((entry) => entry.row)])),
    )
    tabsRow.replaceChildren(
      ...tabs.map((entry) => {
        const chip = div('qp-task-tab', entry.label)
        chip.setAttribute('role', 'tab')
        chip.setAttribute('aria-selected', String(entry.id === tab))
        chip.setAttribute('aria-label', entry.ready > 0 ? `${entry.label}，${entry.ready} 个可领取` : entry.label)
        chip.tabIndex = 0
        if (entry.ready > 0) chip.append(div('qp-task-badge', String(entry.ready)))
        activate(chip, () => {
          if (tab === entry.id) return
          tab = entry.id as Tab
          draw()
        })
        return chip
      }),
    )
    const currentTab = views.get(tab) ?? []
    if (currentTab.length === 0) {
      list.replaceChildren(div('qp-task-empty', '这个分类暂时没有任务，明天再来看看吧'))
      return
    }
    const goodsByIndex = new Map(currentTab.map((entry) => [entry.row.index, entry.goods]))
    list.replaceChildren(
      ...taskSections(currentTab.map((entry) => entry.row)).map((section) =>
        div(
          'qp-task-section',
          div('qp-task-section-title', `${section.title}（${section.rows.length}）`),
          ...section.rows.map((row) => rowElement(row, goodsByIndex.get(row.index) ?? [])),
        ),
      ),
    )
  }

  draw()
  let stopProjection = (): void => {}
  sheet = openSheet({
    title: '任务',
    body,
    cardClass: 'qp-page-sheet qp-task-sheet',
    onClose: () => {
      alive = false
      stopProjection()
      if (current === sheet) current = null
    },
  })
  current = sheet
  stopProjection = onStoreEvent((event) => {
    if ((event.type === 'task.progress' || event.type === 'task.claimed') && alive) draw()
  })
}
