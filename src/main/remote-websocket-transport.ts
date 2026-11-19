/**
 * Compatibility shim. The implementation lives in
 * `src/shared/remote/websocket-transport` so non-Electron hosts can bind the
 * same adapter to their runtime's global WebSocket.
 */
export * from '../shared/remote/websocket-transport'
