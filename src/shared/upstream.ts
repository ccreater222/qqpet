// Client data upstream addressing: the one place that turns a paired sync address
// (`wss://host/v1/sync`) or a typed-in address into the http(s) origin that the
// qqpet-server `/v1/client/*` GETs hang off. Pure and dependency-free, so the main
// process, the mobile bridges and the server (which imports `src/shared/**`) share it.
//
// Addresses are strict on purpose: an unusable value returns null / throws
// `upstream_not_configured` instead of silently falling back to a third-party service.
// Plaintext http/ws is limited to loopback and private-network literals, the same rule
// the desktop applies when pairing a server (src/main/remote-endpoint.ts); public hosts
// must use https/wss.

/** Error message every data module throws when no upstream is configured. */
export const UPSTREAM_NOT_CONFIGURED = 'upstream_not_configured'

/** Only a bare origin is a base: the sync endpoint may be named, any deeper path is a mistake. */
const BASE_PATHS = new Set(['', '/', '/v1/sync', '/v1/sync/', '/sync', '/sync/'])

const LOOPBACK_HOST = /^localhost$/i
const LOOPBACK_SUFFIX = /\.localhost$/i
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
// WHATWG URL keeps IPv6 literals bracketed. The first hextets are enough to classify
// these ranges without expanding `::`.
const IPV6_UNIQUE_LOCAL = /^\[f[cd][0-9a-f]{2}(?::|$)/i
const IPV6_LINK_LOCAL = /^\[fe[89ab][0-9a-f](?::|$)/i

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (LOOPBACK_HOST.test(host) || LOOPBACK_SUFFIX.test(host)) return true
  if (host === '[::1]' || host === '::1') return true
  if (IPV4_LOOPBACK.test(host)) {
    return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  // IPv4-mapped loopback kept as a literal by the URL parser.
  return /^\[::ffff:127(?:\.\d{1,3}){3}\]$/i.test(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i.test(host)
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (IPV6_UNIQUE_LOCAL.test(host) || IPV6_LINK_LOCAL.test(host)) return true
  const match = IPV4_LITERAL.exec(host)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((part) => part < 0 || part > 255)) return false
  const [a, b] = octets
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    // Carrier-grade NAT; Tailscale assigns device addresses from this block.
    || (a === 100 && b >= 64 && b <= 127)
}

/** Plaintext http/ws is limited to loopback and private-network address literals. */
export function isPlainUpstreamHostAllowed(hostname: string): boolean {
  return isLoopbackHost(hostname) || isPrivateNetworkHost(hostname)
}

function toHttpOrigin(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  // Credentials, queries and fragments have no meaning for an origin and would leak into requests.
  if (url.username !== '' || url.password !== '') return null
  if (url.search !== '' || url.hash !== '') return null
  // Host and scheme are lowercased by the URL parser; a hand-typed endpoint path may not be.
  if (BASE_PATHS.has(url.pathname.toLowerCase()) === false) return null
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  // A public host reached in the clear is refused, never silently downgraded or upgraded.
  if (secure === false && isPlainUpstreamHostAllowed(url.hostname) === false) return null
  return (secure ? 'https://' : 'http://') + url.host
}

/**
 * The http(s) origin behind a qqpet-server sync address (`wss://pet.example.com/v1/sync`)
 * or a plain http(s) origin. Null when the value is not one of those, or when it is
 * plaintext to a public host.
 */
export function httpBaseFromServerUrl(value: string | null | undefined): string | null {
  return toHttpOrigin(value)
}

/**
 * An upstream address typed into the settings hint. Same acceptance rules as
 * `httpBaseFromServerUrl`: https/wss anywhere, http/ws only for loopback or private
 * address literals; trimmed and normalized to a trailing-slash-free http(s) origin.
 * Null for anything else, so a bad hint fails loudly as `upstream_not_configured`.
 */
export function normalizeUpstreamUrl(value: string | null | undefined): string | null {
  return toHttpOrigin(value)
}

/**
 * One qqpet-server GET URL under `base`. Throws `upstream_not_configured` when the base is
 * empty or unusable (callers surface that instead of contacting anything else) and a
 * TypeError when the path would smuggle a second line into the request.
 */
export function clientUrl(base: string | null | undefined, path: string): string {
  const origin = toHttpOrigin(base)
  if (origin === null) throw new Error(UPSTREAM_NOT_CONFIGURED)
  if (typeof path !== 'string' || /[\r\n]/.test(path)) throw new TypeError('invalid upstream path')
  if (path === '') return origin
  return origin + (path.startsWith('/') ? path : '/' + path)
}
