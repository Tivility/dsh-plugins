/**
 * The absolute URL this server is reachable at, for links a plugin hands to
 * the model or writes into a response body.
 *
 * Derived, never configured. The harness's own Web bundle solves the same
 * problem the same way for its `app:web-surface` prompt section and its
 * `DSH_WEB_URL` shell variable: the loopback literal plus the bound port. A
 * configured base URL would be one more thing to keep in sync with the actual
 * bind, and wrong the moment the port is OS-assigned.
 * @module @tivility/dsh-web-kit/base-url
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The all-interfaces bind literal, mirrored from the webserver's config schema. */
const ALL_INTERFACES = '0.0.0.0'

/** The address a loopback bind is reachable at. */
const LOOPBACK = '127.0.0.1'

/**
 * The LAN snapshot the harness's Web bundle publishes after binding. Declared
 * structurally: the service is provided under a plain string key with no
 * exported type, and it is absent in compositions that are not `dsh web`.
 */
interface WebRuntimeLike {
  readonly lanAddresses?: readonly string[]
}

/**
 * Resolve the origin this server answers on.
 *
 * A loopback bind yields the loopback literal. An all-interfaces bind has no
 * single answer, so the first LAN address the harness derived at bind time is
 * used — the same snapshot its own `/api` trust fence was configured from, so
 * a link built here is one the fence will accept. With no LAN address
 * available the loopback literal is still returned: it is correct for anyone
 * on the host, and wrong in exactly the case where no correct answer exists.
 * @param ctx - a context carrying the `webServer` service.
 * @returns the origin, with no trailing slash.
 * @throws {Error} when `webServer` is not visible from this context.
 */
export function resolveBaseUrl(ctx: Context): string {
  const server = ctx.get('webServer')
  if (server === undefined) throw new Error('web-kit: webServer is unavailable while resolving the base URL')
  const runtime = ctx.get('webRuntime') as WebRuntimeLike | undefined
  const lan = server.host === ALL_INTERFACES ? runtime?.lanAddresses?.[0] : undefined
  return `http://${lan ?? LOOPBACK}:${String(server.port)}`
}

/**
 * Build an absolute URL onto this server for one path.
 * @param ctx - a context carrying the `webServer` service.
 * @param pathname - absolute pathname, already percent-encoded by the caller.
 * @returns the absolute URL.
 */
export function absoluteUrl(ctx: Context, pathname: string): string {
  return `${resolveBaseUrl(ctx)}${pathname}`
}
