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

let runtimeStopRequest: Promise<boolean> | null = null

/** True while a runtime `activity.stop` command is awaiting its result. */
export const stopTaskPending = (): boolean => runtimeStopRequest !== null

/** Resolves when the pending runtime stop settles; true when no stop is pending. */
export const stopTaskResult = (): Promise<boolean> => runtimeStopRequest ?? Promise.resolve(true)

/** Starts a task; `value` is what activeOption shows (job id, city). */
export function startTask(t: Task, value: string, done = 0): void {
  if (runtimeProjectionMode) return
  task = { ...t, done }
  update('saveJsonData', { activity: String(done) })
  setActivity(t.key, value)
  refreshTray()
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
      void request.then(() => {
        if (runtimeStopRequest === request) runtimeStopRequest = null
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
