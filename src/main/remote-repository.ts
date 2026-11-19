/**
 * Compatibility shim. The implementation lives in `src/shared/remote/repository`
 * so non-Electron hosts can reuse the same protocol state machine; desktop
 * imports keep working through this path.
 */
export * from '../shared/remote/repository'
