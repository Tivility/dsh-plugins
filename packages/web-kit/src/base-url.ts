/**
 * The absolute URL this deployment is reachable at, for links a plugin hands
 * to the model or writes into a response body.
 *
 * Two sources, in this order:
 *
 * 1. **A configured public origin.** The local bind is not the public origin
 *    whenever a reverse proxy, tunnel, port forwarder, or TLS terminator sits
 *    in front — and no amount of inference recovers a proxy hostname or a
 *    public port mapping. Only the operator knows it, so only the operator can
 *    say it.
 * 2. **The local bind**, derived the way the harness's own Web bundle derives
 *    it for its `app:web-surface` prompt: the loopback literal plus the bound
 *    port, or the LAN address it sampled when bound to all interfaces.
 *
 * Forwarded headers are deliberately not consulted. `Host` and `X-Forwarded-*`
 * are attacker-controlled on any request that reaches the server, so trusting
 * them would let a visitor choose the origin the model puts in front of a user
 * — and would undo the request-trust fence in the same stroke.
 *
 * With neither source available — a headless profile with no configured origin
 * — there is no answer, and this says so instead of guessing loopback. A link
 * to a server that is not running is worse than no link.
 * @module @tivility/dsh-web-kit/base-url
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The all-interfaces bind literal, mirrored from the webserver's config schema. */
const ALL_INTERFACES = '0.0.0.0'

/** The address a loopback bind is reachable at. */
const LOOPBACK = '127.0.0.1'

/** Process-level override, for a deployment that configures its proxy once. */
export const PUBLIC_BASE_URL_ENV = 'DSH_PUBLIC_BASE_URL'

/**
 * The LAN snapshot the harness's Web bundle publishes after binding. Declared
 * structurally: the service is provided under a plain string key with no
 * exported type, and it is absent in compositions that are not `dsh web`.
 */
interface WebRuntimeLike {
  readonly lanAddresses?: readonly string[]
}

/**
 * Validate and normalize a configured public origin.
 *
 * An origin-only contract: scheme, host, and optional port. A path prefix is
 * refused rather than half-supported, because every consumer appends its own
 * absolute route and a prefix would silently produce `/prefix` + `/files/…`
 * with no prefix in the middle. Credentials, queries, and fragments are
 * refused because a value that carries them is a mistake, and a link built by
 * concatenating onto one is a worse mistake.
 * @param value - the configured origin, verbatim.
 * @returns the origin with no trailing slash.
 * @throws {Error} when the value is not a bare absolute http(s) origin.
 */
export function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`web-kit: publicBaseUrl ${JSON.stringify(value)} is not an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`web-kit: publicBaseUrl ${JSON.stringify(value)} must use http: or https:`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`web-kit: publicBaseUrl ${JSON.stringify(value)} must not carry credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`web-kit: publicBaseUrl ${JSON.stringify(value)} must not carry a query or fragment`)
  }
  if (url.pathname !== '/') {
    throw new Error(
      `web-kit: publicBaseUrl ${JSON.stringify(value)} must be an origin without a path — `
      + 'each route is appended whole, so a path prefix would be dropped from the middle of every link',
    )
  }
  // `url.origin` drops a default port and normalizes case, which is exactly
  // the spelling every consumer should concatenate onto.
  return url.origin
}

/**
 * Resolve the origin this deployment answers on.
 * @param ctx - a context that may carry the `webServer` service.
 * @param configured - the plugin's own `publicBaseUrl`, when it has one.
 * @returns the origin with no trailing slash, or undefined when neither source can answer.
 * @throws {Error} when a configured origin is not a bare absolute http(s) origin.
 */
export function resolvePublicBaseUrl(ctx: Context, configured?: string): string | undefined {
  if (configured !== undefined && configured !== '') return normalizePublicBaseUrl(configured)
  const fromEnv = process.env[PUBLIC_BASE_URL_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return normalizePublicBaseUrl(fromEnv)

  const server = ctx.get('webServer')
  if (server === undefined) return undefined
  const runtime = ctx.get('webRuntime') as WebRuntimeLike | undefined
  const lan = server.host === ALL_INTERFACES ? runtime?.lanAddresses?.[0] : undefined
  return `http://${lan ?? LOOPBACK}:${String(server.port)}`
}

/**
 * Resolve the origin, or fail loudly.
 *
 * For a caller that cannot produce a useful answer without one — a route
 * handler building an absolute link into its response.
 * @param ctx - a context carrying the `webServer` service.
 * @param configured - the plugin's own `publicBaseUrl`, when it has one.
 * @returns the origin, with no trailing slash.
 * @throws {Error} when nothing can answer.
 */
export function resolveBaseUrl(ctx: Context, configured?: string): string {
  const base = resolvePublicBaseUrl(ctx, configured)
  if (base === undefined) {
    throw new Error(
      'web-kit: no public base URL — this composition has no webServer, so set publicBaseUrl '
      + `(or ${PUBLIC_BASE_URL_ENV}) to the origin browsers actually reach`,
    )
  }
  return base
}

/**
 * Build an absolute URL onto this deployment for one path.
 * @param ctx - a context carrying the `webServer` service.
 * @param pathname - absolute pathname, already percent-encoded by the caller.
 * @param configured - the plugin's own `publicBaseUrl`, when it has one.
 * @returns the absolute URL.
 * @throws {Error} when no origin can be resolved.
 */
export function absoluteUrl(ctx: Context, pathname: string, configured?: string): string {
  return `${resolveBaseUrl(ctx, configured)}${pathname}`
}
