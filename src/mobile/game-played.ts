/** One closed game window, correlated with the renderer's per-window session map. */
export interface GamePlayedEvent {
  minutes: number
  windowId: number
}

/**
 * Native hosts used to emit only the minutes as a bare number. New hosts echo
 * the renderer's window correlation id; keep accepting the old shape so a
 * bridge update never strands an already-installed shell.
 */
export function normalizeGamePlayed(payload: unknown): GamePlayedEvent | null {
  if (typeof payload === 'number' && Number.isFinite(payload)) {
    return { minutes: payload, windowId: -1 }
  }
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.minutes !== 'number' || Number.isFinite(record.minutes) === false) return null
  const windowId = Number.isSafeInteger(record.windowId) ? record.windowId as number : -1
  return { minutes: record.minutes, windowId }
}

export interface NativeGameHost {
  openGame(swf: string, windowId: number): void
}

export type GamePlayedListener = (minutes: number, windowId: number) => void

/** Forwards the renderer's correlation id to the native game host, using -1 for legacy callers. */
export function forwardOpenGame(host: NativeGameHost, swf: string, windowId?: number): void {
  host.openGame(swf, windowId ?? -1)
}

/** Normalizes a native host event and forwards both values to the renderer contract. */
export function forwardGamePlayed(listener: GamePlayedListener, payload: unknown): void {
  const played = normalizeGamePlayed(payload)
  if (played !== null) listener(played.minutes, played.windowId)
}
