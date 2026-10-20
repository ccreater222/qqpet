/**
 * Runtime projection mode owns gameplay and hides the renderer voice bridge
 * until C7. The main process must not start the global hotkey watcher or
 * preload ASR in that mode; the user's setting is left untouched for later.
 */
export function shouldStartVoice(runtimeProjectionMode: boolean, voiceEnabled: boolean): boolean {
  return runtimeProjectionMode === false && voiceEnabled
}
