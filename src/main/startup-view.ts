import type { SaveData } from '../shared/save'
import { startSave } from '../shared/save-logic'
import { composeSaveWithOverlay, toSharedSaveData, type DeviceLocalOverlay } from '../shared/sync/data-boundary'

/**
 * C7 startup view. The runtime loads catch-up asynchronously, but the window
 * placement, page zoom and X-HD decision must be correct before the renderer
 * starts requesting assets. A device-local overlay preview supplies them.
 */
export function provisionalSaveView(overlay: DeviceLocalOverlay | null = null): SaveData {
  const view = startSave(null)
  if (overlay === null) return view
  return composeSaveWithOverlay(toSharedSaveData(view), overlay)
}
