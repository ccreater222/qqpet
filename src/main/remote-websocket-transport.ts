import type { RemoteTransport } from './remote-repository'
import { assertRemoteServerUrl } from './remote-endpoint'

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
 * Desktop-only WSS adapter for the injectable RemoteTransport seam. It uses the
 * runtime's global WebSocket (Electron main on Node 22) and never imports ws,
 * so mobile bundles can tree-shake every remote path out.
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
      socket.onerror = event => {
        if (!closed) handlers.onError?.(event)
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
