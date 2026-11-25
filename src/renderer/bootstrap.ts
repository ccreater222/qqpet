import type { SaveData } from '../shared/save'
import { phoneUI } from './ui/mobile/sizing'

/** All eager UI modules receive an initialized store, without top-level await in the module graph. */
export async function bootstrap(): Promise<void> {
  await window.__qqpetReady
  try {
    const runtime = await window.qqpet.runtimeInfo()
    window.__qqpetRuntimeV2 = runtime.localRepositoryV2
  } catch (error) {
    // A bridge that cannot describe its authority is never treated as runtime mode.
    console.error('QQPet runtime capability query failed:', error)
    window.__qqpetRuntimeV2 = window.qqpet.capabilities?.localRepositoryV2 === true
  }
  if (window.__qqpetRuntimeV2) {
    // Subscribe before load/import so a tick or command committed while the
    // eager module graph is initializing cannot fall between the initial
    // snapshot and store listener registration.
    const buffered: NonNullable<Window['__qqpetBufferedProjections']> = []
    window.__qqpetBufferedProjections = buffered
    window.qqpet.onProjection((projection, events) => buffered.push({ kind: 'projection', projection, events }))
    window.qqpet.onResync((projection, events) => buffered.push({ kind: 'resync', projection, events }))
  }
  const loaded: SaveData = await window.qqpet.load()
  const initialProjection = await window.qqpet.getProjection?.() ?? null
  // If the scheduler advanced between load() and getProjection(), the head
  // snapshot and cursor must describe the same state.
  const initial: SaveData = initialProjection?.save ?? loaded
  window.__qqpetInitialProjectionCursor = initialProjection === null
    ? null
    : {
        revision: initialProjection.revision,
        eventSeq: initialProjection.eventSeq,
        owner: initialProjection.authority.owner,
        authorityId: initialProjection.authority.authorityId,
        authorityEpoch: initialProjection.authority.epoch,
        restoreGeneration: initialProjection.authority.restoreGeneration,
      }
  window.__qqpetInitialSave = initial
  // Phone styles are a separate chunk: load them before the first phone paint so a
  // sheet or menu never flashes the desktop styling. Non-phone hosts skip this load.
  if (phoneUI()) await import('./ui/mobile/phone-css')
  await import('./main')
}

void bootstrap().catch((error: unknown) => {
  console.error('QQPet startup failed:', error)
  const message = document.createElement('div')
  message.setAttribute('role', 'alert')
  message.style.cssText = 'padding:16px;background:white;color:#900;font:14px sans-serif'
  message.textContent = `QQPet: ${error instanceof Error ? error.message : String(error)}`
  document.body.appendChild(message)
})
