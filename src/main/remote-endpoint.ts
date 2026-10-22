const LOOPBACK_HOST = /^localhost$/i
const LOOPBACK_SUFFIX = /\.localhost$/i
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:127(?:\.\d{1,3}){3}\]$/i
const IPV6_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i

/**
 * True only for address literals/names that are guaranteed to resolve to the
 * local machine. Plain WebSocket is a development/self-test transport, never a
 * remote production transport.
 */
export function isLoopbackRemoteHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (LOOPBACK_HOST.test(host) || LOOPBACK_SUFFIX.test(host)) return true
  if (host === '[::1]' || host === '::1') return true
  if (IPV4_LOOPBACK.test(host)) {
    return host.split('.').every(part => Number(part) >= 0 && Number(part) <= 255)
  }
  return IPV4_MAPPED_LOOPBACK.test(host) || IPV6_MAPPED_LOOPBACK.test(host)
}

/**
 * Validates the server endpoint at every trust boundary. `wss://` is required
 * for remote hosts; `ws://` is accepted only for explicit loopback/self-test
 * hosts (localhost, 127.0.0.0/8 and ::1).
 */
export function assertRemoteServerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  if (parsed.hostname.length === 0) {
    throw new Error('invalid_payload: serverUrl must include a host')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('invalid_payload: serverUrl must not contain credentials')
  }
  if (parsed.protocol === 'ws:' && isLoopbackRemoteHost(parsed.hostname) === false) {
    throw new Error('invalid_payload: ws:// is allowed only for loopback/self-test hosts; use wss://')
  }
  return value
}
