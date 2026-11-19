import type { RemoteTransport } from './repository'
import { assertRemoteServerUrl } from './endpoint'

export interface WebSocketMessageEventLike {
  data: unknown
}

export interface WebSocketCloseEventLike {
  code?: number
  reason?: string
}

export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: WebSocketMessageEventLike) => void) | null
  onclose: ((event: WebSocketCloseEventLike) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface WebSocketFactoryLike {
  new (url: string): WebSocketLike
}

/**
 * Host-neutral WSS adapter for the injectable RemoteTransport seam. It uses the
 * runtime's global WebSocket (Node 22, Electron main, Chromium/WebView) and never
 * imports ws, so each host keeps its own transport binding.
 */
export function createWebSocketTransport(factory?: WebSocketFactoryLike): RemoteTransport {
  const Constructor = factory ?? (globalThis as { WebSocket?: WebSocketFactoryLike }).WebSocket
  if (Constructor === undefined) throw new Error('WebSocket is unavailable in this runtime')
  return {
    connect(url: string, _token: string | null, handlers): { send: (data: string) => void; close: () => void } {
      assertRemoteServerUrl(url)
      const socket = new Constructor(url)
      let closed = false
      socket.onopen = () => {
        if (!closed) handlers.onOpen()
      }
      socket.onmessage = event => {
        if (!closed) handlers.onMessage(event.data)
      }
      socket.onclose = event => {
        if (closed) return
        closed = true
        handlers.onClose({
          code: typeof event.code === 'number' ? event.code : 1006,
          reason: typeof event.reason === 'string' ? event.reason : '',
        })
      }
      socket.onerror = () => {
        // The DOM Event has no useful message; keep the stored status readable.
        if (!closed) handlers.onError?.(new Error('websocket_error'))
      }
      return {
        send: (data: string) => {
          if (closed) throw new Error('WebSocket is closed')
          socket.send(data)
        },
        close: () => {
          if (closed) return
          closed = true
          try {
            socket.close()
          } catch {
            // closing is best effort
          }
        },
      }
    },
  }
}
