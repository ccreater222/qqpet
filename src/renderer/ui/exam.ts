import EXAM from '../pet/data/exam.json'
import type { ExamQuestionProjection } from '../../shared/sync/protocol'
import { runtimeProjectionMode } from '../pet/store'
import { uiCommands } from '../pet/command-map'
import { commandResultData, commandSucceeded, dispatchRuntimeCommand } from '../pet/runtime-command'
import { openFrame } from './box'
import './css/exam.css'
import { button, div } from './dom'
import { windowView } from './window-view'

const shuffle = <T>(a: T[]): T[] => {
  const b = [...a]
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[b[i], b[j]] = [b[j], b[i]]
  }
  return b
}

/**
 * The exam on screen, whichever path opened it: a box removed by something else (closing all windows) no
 * longer counts as open (#106). The runtime exam tracks its own frame too, so both paths close the same way.
 */
let open: HTMLElement | undefined
/** A runtime exam is waiting for its questions; keeps a second start from opening a duplicate session. */
let examStarting = false

async function startRuntimeExam(topic: string, pass: () => void): Promise<void> {
  if (open?.isConnected || examStarting) return
  examStarting = true
  const result = await dispatchRuntimeCommand(uiCommands.examStart(topic))
  const data = commandResultData<{ sessionToken: string; questions: ExamQuestionProjection[] }>(result)
  examStarting = false
  if (data === null || commandSucceeded(result) === false) return
  renderRuntimeExam(data.questions, data.sessionToken, pass)
}

function renderRuntimeExam(questions: ExamQuestionProjection[], sessionToken: string, pass: () => void): void {
  const picked = questions.map(() => -1)
  let at = 0
  const box = div('answerQuestions fC por')
  open = box
  const remove = openFrame(div('ui-exam', box))
  let submitting = false
  const close = (): void => {
    remove()
    open = undefined
  }
  const submit = (): void => {
    if (submitting || picked.some(index => index < 0)) return
    submitting = true
    void dispatchRuntimeCommand(uiCommands.examSubmit(sessionToken, picked)).then((result) => {
      const data = commandResultData<{ passed: boolean }>(result)
      close()
      submitting = false
      if (data === null) return
      if (data.passed) pass()
      else windowView({ title: '升学结果', msg: '抱歉未通过！' })
    })
  }
  const go = (d: number) => (): void => {
    if (d < 0 || picked[at] >= 0) at += d
    render()
  }
  function render(): void {
    const q = questions[at]
    if (q === undefined) return
    const last = at === questions.length - 1
    const options = q.options.map((o, i) =>
      button(
        'aq_option fc',
        () => {
          picked[at] = i
          render()
        },
        div(i === picked[at] ? 'choose chooseAQ' : 'choose'),
        div('w0 f1', o),
      ),
    )
    box.replaceChildren(
      button('close', close),
      div('a_title', '升学考试：'),
      div(
        'a_Question fC f1',
        div('aq_title', q.prompt),
        div('aq_options fccw f1', ...options),
        div(
          'aq_buts fca',
          ...(at ? [button('fcc wsnw aqb', go(-1), ' 上一题 ')] : []),
          last ? button('fcc wsnw aqb', submit, ' 提交 ') : button('fcc wsnw aqb', go(1), ' 下一题 '),
        ),
      ),
    )
  }
  render()
}

/** The promotion exam of study topic `topic`: three random questions of its bank, all must be right. */
export function openExam(topic: string, pass: () => void): void {
  if (runtimeProjectionMode) {
    void startRuntimeExam(topic, pass)
    return
  }
  const bank = EXAM[topic as keyof typeof EXAM] as (typeof EXAM)[keyof typeof EXAM] | undefined
  if (open?.isConnected || !bank?.length) return
  // The bank lists most answers first.
  const questions = shuffle(bank)
    .slice(0, 3)
    .map((q) => ({ ...q, options: shuffle(q.options) }))
  const picked = questions.map(() => -1)
  let at = 0
  const box = div('answerQuestions fC por')
  open = box
  const remove = openFrame(div('ui-exam', box))
  const close = (): void => {
    remove()
    open = undefined
  }

  const go = (d: number) => (): void => {
    if (d < 0 || picked[at] >= 0) at += d
    render()
  }
  const submit = (): void => {
    if (picked[at] < 0) return
    const wrong = questions.flatMap((q, i) => (q.options[picked[i]] === q.answer ? [] : [{ q, mine: q.options[picked[i]] }]))
    if (!wrong.length) {
      close()
      return pass()
    }
    // 失败时在考卷里列出答错的题和正确答案，而不是只弹一句「未通过」(#114)
    box.replaceChildren(
      button('close', close),
      div('a_title', `抱歉未通过！答错 ${wrong.length} 题：`),
      div(
        'a_Question fC f1',
        div(
          'aq_options fC f1 exam-review',
          ...wrong.map(({ q, mine }) => div('aq_title', q.title, div('exam-yours', `你的答案：${mine}`), div('exam-right', `正确答案：${q.answer}`))),
        ),
        div('aq_buts fca', button('fcc wsnw aqb', close, ' 知道了 ')),
      ),
    )
  }

  function render(): void {
    const q = questions[at]
    const last = at === questions.length - 1
    const options = q.options.map((o, i) =>
      button(
        'aq_option fc',
        () => {
          picked[at] = i
          render()
        },
        div(i === picked[at] ? 'choose chooseAQ' : 'choose'),
        div('w0 f1', o),
      ),
    )
    box.replaceChildren(
      button('close', close),
      div('a_title', '升学考试：'),
      div(
        'a_Question fC f1',
        div('aq_title', q.title),
        div('aq_options fccw f1', ...options),
        div(
          'aq_buts fca',
          ...(at ? [button('fcc wsnw aqb', go(-1), ' 上一题 ')] : []),
          last ? button('fcc wsnw aqb', submit, ' 提交 ') : button('fcc wsnw aqb', go(1), ' 下一题 '),
        ),
      ),
    )
  }
  render()
}
