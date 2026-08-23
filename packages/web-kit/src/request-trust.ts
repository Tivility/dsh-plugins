/**
 * Browser-trust fence for plugin-registered HTTP routes.
 *
 * The harness applies this fence inside its own `/api` handler
 * (`@deepseek-ai/dsh-client-connection`'s `isTrustedApiRequest`), not at the
 * webserver, so a route registered through `webServer.register` receives none
 * of it. A plugin route that reads workspace bytes or accepts writes is
 * exactly as reachable from a rebound page as `/api` would be without it, and
 * loopback binding is no defense: DNS rebinding targets 127.0.0.1 precisely
 * because it is reachable. This is a verbatim port of the harness's rules so
 * out-of-tree routes sit on the same baseline.
 *
 * This is not authentication. It answers "did this request really come from a
 * page served by this server", never "who is asking" — the harness's own
 * fence carries the same disclaimer. Access control belongs to a lock such as
 * `ownerAuth`.
 * @module @tivility/dsh-web-kit/request-trust
 */

import type { IncomingHttpHeaders } from 'node:http'

/** The request facts the fence reads from either HTTP representation. */
export interface TrustRequest {
  headers: IncomingHttpHeaders | Headers
}

/**
 * Read one header from either the node:http bag or a Fetch `Headers`.
 * @param headers - the request's header collection.
 * @param name - lowercase header name.
 * @returns the single value, or undefined when absent or multi-valued.
 */
function header(headers: IncomingHttpHeaders | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Normalized URL of a Host-header authority, or undefined when unparsable.
 * @param authority - a bare `host` or `host:port` string.
 * @returns the parsed URL (hostname lowercased, IPv6 bracketed).
 */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Canonical form of a parsed authority: `hostname` when no port was written,
 * else `hostname:port`. The port is judged from URL parses under both special
 * schemes (their default ports differ, so `:80` and `:443` still count as
 * explicit), never from the raw string, where WHATWG trimming would misread
 * shapes like `host:port ` as port-less.
 * @param entry - the authority as written.
 * @param entryUrl - the same authority, already parsed.
 * @returns the canonical authority spelling.
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  // An authority that parsed under http cannot fail under https.
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Assert one configured trusted-host entry is a bare authority in canonical
 * form. Anything WHATWG parsing would silently rewrite is refused as a typo
 * that must fail the load loudly rather than quietly change the grant: URL
 * parts beyond the authority (`host/path`, `user@host` — which would
 * authorize the embedded hostname), stripped whitespace, a dangling colon or
 * zero-padded port (which would broaden an intended exact-port grant to every
 * port), and non-canonical host spellings (`0x7f.0.0.1`, percent-encoding,
 * unbracketed IPv6; IDN hosts are declared in punycode, the form the wire
 * carries).
 * @param entry - the configured value, verbatim.
 * @throws {Error} when the entry is not a bare canonical `host[:port]`.
 */
export function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`web-kit: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/**
 * Whether the request authority matches a trusted-host entry. An entry with an
 * explicit port matches that exact authority; a port-less entry matches the
 * hostname on any port (the shape the harness derives for IP-literal LAN
 * serving, where the bound port may be OS-assigned). Both sides compare
 * through WHATWG normalization, so case and a redundant `:80` never decide
 * trust.
 * @param hostUrl - the request's parsed Host authority.
 * @param trustedHosts - configured authorities.
 * @returns whether the Host is one of them.
 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach a plugin route.
 *
 * Three fences, in the harness's order:
 *
 * 1. Host (DNS-rebinding defense), applied to every request browser-looking or
 *    not: the browser fills Host from the URL it believes it is talking to, so
 *    a rebound page carries the attacker's domain even though the socket lands
 *    here. There is no marker shortcut — over plain HTTP a browser read
 *    (images, navigations) arrives with neither Origin nor Fetch-Metadata,
 *    indistinguishable from curl, and its response is readable by the rebound
 *    page.
 * 2. Cross-site: an explicit `Sec-Fetch-Site: cross-site` is refused
 *    regardless of Origin.
 * 3. Origin: when a browser attaches one it must be exactly this authority.
 *    Absent Origin is fine — fence 1 already bound the request. The literal
 *    `null` (sandboxed iframes, `file:` pages) is an opaque origin, refused.
 * @param request - node:http or Fetch request facts (headers only).
 * @param trustedHosts - non-loopback authorities this deployment serves: exact `host:port`, or port-less `host` matching any port.
 * @returns true when the Host is ours and any attached browser markers are same-origin.
 */
export function isTrustedRequest(request: TrustRequest, trustedHosts: readonly string[] = []): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Whether a request carries a same-origin browser marker, for callers that
 * want the Origin relationship alone without the Host fence.
 * @param request - node:http or Fetch request facts (headers only).
 * @returns true when Origin is absent or exactly the request's own authority.
 */
export function isSameOrigin(request: TrustRequest): boolean {
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
