import { activity, refreshTray, runtimeProjectionMode, setActivity, update } from './store'
import { uiCommands } from './command-map'
import { commandSucceeded, dispatchRuntimeCommand } from './runtime-command'

type Key = 'work' | 'study' | 'trip'

export interface Task {
  key: Key
  minutes: number
  /** Asked every tick with the minutes done; true ends the task right away. */
  early?: (done: number) => boolean
  end: (early: boolean) => void
}

// Work, study and travel exclude each other, so one slot is enough. Its minutes
// are saved in saveJsonData.activity so it survives a restart (resumeTask).
let task: (Task & { done: number }) | null = null

export const elapsed = (): number => task?.done ?? 0

const started: (() => void)[] = []
/** Called whenever a task starts (custody notes that its launch took). */
export const onTaskStart = (l: () => void): void => void started.push(l)

let runtimeStopRequest: Promise<boolean> | null = null
let runtimeStopPending = false
const stopPendingListeners = new Set<(pending: boolean) => void>()

/** True while a runtime `activity.stop` command is awaiting its result. */
export const stopTaskPending = (): boolean => runtimeStopPending

/** Both the status and travel buttons observe this shared pending transition. */
export function onStopTaskPending(listener: (pending: boolean) => void): () => void {
  stopPendingListeners.add(listener)
  return () => { stopPendingListeners.delete(listener) }
}

function publishStopPending(pending: boolean): void {
  if (runtimeStopPending === pending) return
  runtimeStopPending = pending
  for (const listener of stopPendingListeners) listener(pending)
}

/** Resolves when the pending runtime stop settles; true when no stop is pending. */
export const stopTaskResult = (): Promise<boolean> => runtimeStopRequest ?? Promise.resolve(true)

/** Starts a task; `value` is what activeOption shows (job id, city). */
export function startTask(t: Task, value: string, done = 0): void {
  if (runtimeProjectionMode) return
  task = { ...t, done }
  update('saveJsonData', { activity: String(done) })
  setActivity(t.key, value)
  refreshTray()
  for (const l of started) l()
}

/** Drops the running task without its end; returns its key. */
export function stopTask(): Key | null {
  if (runtimeProjectionMode) {
    const key = (['work', 'study', 'trip'] as const).find(k => activity(k) !== null) ?? null
    if (key === null) return null
    // One in-flight stop per renderer; a second click must not emit a second
    // command that the host would reject as busy after the first succeeded.
    if (runtimeStopRequest === null) {
      const request = dispatchRuntimeCommand(uiCommands.stopActivity())
        .then((result) => commandSucceeded(result), () => false)
      runtimeStopRequest = request
      publishStopPending(true)
      void request.then(() => {
        if (runtimeStopRequest === request) {
          runtimeStopRequest = null
          publishStopPending(false)
        }
      })
    }
    return key
  }
  if (!task) return null
  const { key } = task
  task = null
  setActivity(key, null)
  refreshTray()
  return key
}

/** Counts growing minutes; ends the task when it is due or ends early. */
export function advanceTask(minutes: number): void {
  if (runtimeProjectionMode) return
  if (!task) return
  const t = task
  t.done = Math.min(t.done + minutes, t.minutes)
  update('saveJsonData', { activity: String(t.done) })
  const early = Boolean(t.early?.(t.done))
  if (!early && t.done < t.minutes) return
  stopTask()
  t.end(early)
}

/** Cheat: ends the running task now, as if its time were up. */
export function finishTask(): boolean {
  if (!task) return false
  advanceTask(task.minutes - task.done)
  return true
}
