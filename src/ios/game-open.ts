export interface IOSOpenGameRequest extends Record<string, unknown> {
  swf: string
  windowId: number
  generation: string
}

/** iOS manager RPC arguments; the native manager echoes windowId in gamePlayed. */
export function openGameRequest(swf: string, windowId: number | undefined, generation: string): IOSOpenGameRequest {
  return { swf, windowId: windowId ?? -1, generation }
}
