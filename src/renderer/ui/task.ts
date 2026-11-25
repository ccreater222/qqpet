import { claim, claimRuntime, TABS, tasks, type Tab } from '../pet/tasks'
import { onStoreEvent, runtimeProjectionMode } from '../pet/store'
import { openBox } from './box'
import './css/task.css'
import { button, div, img } from './dom'
import { openPhoneTask } from './mobile/phone-task'
import { phoneUI } from './mobile/sizing'
import { showResult } from './result'

let open = false

export function openTask(): void {
  if (phoneUI()) return openPhoneTask()
  if (open) return
  open = true
  const root = div('ui-task')
  // One stable child carries the task list; showResult() appends its overlay to
  // root as a sibling, so a projection redraw must not replace root's children.
  const body = div('task fC')
  root.append(body)
  let tab: Tab = 'daily'

  const render = (): void => {
    const items = tasks(tab).map((t, i) => {
      const ready = !t.take && t.done >= t.num
      const state = t.take ? 'claimed' : ready ? 'ready' : 'pending'
      const reward = document.createElement('button')
      reward.type = 'button'
      reward.className = `but_small task-reward task-reward--${state}`
      reward.disabled = !ready
      reward.textContent = t.take ? '✓ 已领取' : ready ? '领取奖励' : '未达成'
      reward.addEventListener('click', () => {
        if (!ready) return
        const options = t.festivalId !== undefined ? { festival: true, shareText: t.msg } : undefined
        if (runtimeProjectionMode) {
          void claimRuntime(tab, i).then((goods) => {
            render()
            if (goods !== null) showResult(root, goods, '', options)
          })
          return
        }
        const goods = claim(tab, i)
        render()
        showResult(root, goods || [], goods ? '' : '还没完成任务哦！~~', options)
      })
      return div(
        'taskOnce fc',
        div('to_left f1 fC w0', div('to_label', `${t.label}（${Math.min(t.done, t.num)}/${t.num}） `), div('to_msg', t.msg)),
        div(
          'to_right fc',
          ...t.good.map((g) => Object.assign(img('goodImg', g.url), { title: `${g.outOfPrint ? '绝版：' : ''}${g.name}*${g.num}` })),
          reward,
        ),
      )
    })
    const tabs = (Object.keys(TABS) as Tab[]).map((k) =>
      button(
        k === tab ? 't_tab mr8 active' : 't_tab mr8',
        () => {
          tab = k
          render()
        },
        TABS[k],
      ),
    )
    body.replaceChildren(div('t_top f1 fC h0', div('t_title', '活动列表'), div('t_tabs', ...tabs), div('tasks f1 mt8 h0', ...items)))
  }
  render()
  const stopProjection = onStoreEvent((event) => {
    if ((event.type === 'task.progress' || event.type === 'task.claimed') && open) render()
  })
  openBox(root, {
    onClose: () => {
      stopProjection()
      open = false
    },
  })
}
