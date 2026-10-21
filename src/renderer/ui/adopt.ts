import { onProjectionApplied, runtimeProjectionMode, save, setInfo, update } from '../pet/store'
import type { Sex } from '../../shared/save'
import { SwfPlayer } from '../swf/player'
import { openBox } from './box'
import { button, div } from './dom'
import { windowView } from './window-view'

let open = false

type CommitAdoption = (sex: Sex, done: () => void, fail: (message: string) => void) => void

/** The pet is usable only after the adopted snapshot has been hydrated into the store. */
interface ProjectionWaiter {
  promise: Promise<boolean>
  cancel(): void
}

function waitForPetProjection(timeoutMs = 5000): ProjectionWaiter {
  if (save.havePet) return { promise: Promise.resolve(true), cancel() {} }
  let cancel = (): void => {}
  const promise = new Promise<boolean>((resolve) => {
    let settled = false
    let timer = 0
    const stop = (value: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      off()
      resolve(value)
    }
    const off = onProjectionApplied(() => {
      if (save.havePet) stop(true)
    })
    timer = setTimeout(() => stop(false), timeoutMs)
    cancel = () => stop(false)
  })
  return { promise, cancel }
}

function openAdoption(done: () => void, commit: CommitAdoption): void {
  if (open) return
  open = true
  // No pet to replace yet, so unlike the setup page's import this needs no confirmation.
  const host = div('adopt', button('but_small import', () => void window.qqpet.importSave().catch(() => windowView({ title: '导入存档', msg: '这不是有效的QQ宠物存档~' })), '导入存档'))
  const close = openBox(host, { onClose: () => (open = false) })
  void new SwfPlayer(host).load('pet/reset/Adopt.swf')
  // Keep this per-window latch set after a choice, even after close; reopening creates a fresh one.
  let choosing = false
  window.ChooseAPI = {
    ChooseSex: (n) => {
      if (choosing) return
      choosing = true
      // The SWF owns the current call. Dispose it after ExternalInterface returns,
      // as for the other SWF windows that close themselves from a callback.
      setTimeout(() => {
        if (host.isConnected === false) return
        commit(n === 0 ? 'GG' : 'MM', () => {
          close()
          open = false
          done()
        }, (message) => {
          choosing = false
          close()
          open = false
          windowView({ title: '领养失败', msg: message })
        })
      })
    },
  }
}

/** Legacy local adoption writes SaveData directly; only valid while the runtime flag is off. */
export function adopt(done: () => void): void {
  // Defensive: the boot path only calls this with the flag off, but never let
  // a stray call fall back to legacy canonical writes under the runtime flag.
  if (runtimeProjectionMode) return adoptProjection(done)
  openAdoption(done, (sex, finish) => {
    setInfo('sex', sex)
    update('havePet', true)
    finish()
  })
}

/**
 * C6a projection boot path: adopt through the semantic command, then start
 * presentation only after the repository projection has created the pet.
 */
export function adoptProjection(done: () => void): void {
  openAdoption(done, (sex, finish, fail) => {
    // Subscribe before issuing the command: the projection may arrive before
    // the command promise resolves, and presentation must not start early.
    const adopted = waitForPetProjection()
    void window.qqpet.command({ type: 'pet.adopt', payload: { sex } }).then(async (result) => {
      if (result.status === 'applied' || (result.status === 'duplicate' && result.original === 'applied')) {
        if (await adopted.promise) finish()
        else fail('领养投影超时，请重试')
        return
      }
      adopted.cancel()
      const message = result.status === 'rejected' ? result.error.message : '领养命令未生效'
      fail(message)
    }, (error: unknown) => {
      adopted.cancel()
      fail(error instanceof Error ? error.message : String(error))
    })
  })
}
