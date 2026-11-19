const LOOPBACK_HOST = /^localhost$/i
const LOOPBACK_SUFFIX = /\.localhost$/i
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:127(?:\.\d{1,3}){3}\]$/i
const IPV6_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
// WHATWG URL keeps IPv6 literals bracketed. The first four-hex-digit hextet is
// enough to classify these ranges without expanding `::`.
const IPV6_UNIQUE_LOCAL = /^\[f[cd][0-9a-f]{2}(?::|$)/i
const IPV6_LINK_LOCAL = /^\[fe[89ab][0-9a-f](?::|$)/i

/**
 * True only for address literals/names that are guaranteed to resolve to the
 * local machine. Loopback endpoints are always eligible for plain `ws://`.
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

function isPrivateIpv4(host: string): boolean {
  const match = IPV4_LITERAL.exec(host)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  if (octets.some(part => part < 0 || part > 255)) return false
  const [a, b] = octets
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    // Carrier-grade NAT; Tailscale assigns device addresses from this block.
    || (a === 100 && b >= 64 && b <= 127)
}

/**
 * True for address literals that are only routable inside a private or local
 * network: RFC1918, IPv4 link-local, CGNAT (including Tailscale's
 * 100.64.0.0/10), IPv6 unique-local (fc00::/7, which includes Tailscale's
 * fd7a:115c:a1e0::/48) and IPv6 link-local. Hostnames are never resolved here,
 * so an intranet DNS name still requires `wss://`.
 */
export function isPrivateNetworkRemoteHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return isPrivateIpv4(host) || IPV6_UNIQUE_LOCAL.test(host) || IPV6_LINK_LOCAL.test(host)
}

/** Plain `ws://` is limited to loopback and private/local network addresses. */
export function isPlainWebSocketHostAllowed(hostname: string): boolean {
  return isLoopbackRemoteHost(hostname) || isPrivateNetworkRemoteHost(hostname)
}

/**
 * Validates the server endpoint at every trust boundary. `wss://` is required
 * for public hosts; `ws://` is accepted only for loopback and private/local
 * address literals (RFC1918, IPv4 link-local, CGNAT/Tailscale 100.64.0.0/10,
 * IPv6 unique-local and IPv6 link-local). Intranet hostnames are not resolved
 * and still require `wss://`.
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
  if (parsed.protocol === 'ws:' && isPlainWebSocketHostAllowed(parsed.hostname) === false) {
    throw new Error('invalid_payload: ws:// is allowed only for loopback or private-network hosts; use wss:// for public hosts')
  }
  return value
}
