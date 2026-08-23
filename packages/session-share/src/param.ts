/**
 * The one fact both halves of this plugin have to agree on.
 *
 * The query parameter is a constant rather than configuration because the two
 * halves cannot share a configuration value: the browser bundle is fetched
 * outside the loader's config tree and receives only what its own `apply`
 * is handed, while the link the host writes into the system prompt is built
 * on the other side of the wire. A constant is the honest form of a value
 * that must match in two places.
 * @module @tivility/dsh-session-share/param
 */

/** Query parameter naming the session to open on load. */
export const SESSION_PARAM = 'session'

/**
 * Build the query a share link carries.
 * @param sessionId - the session to open.
 * @returns the query string, question mark included.
 */
export function shareQuery(sessionId: string): string {
  return `?${SESSION_PARAM}=${encodeURIComponent(sessionId)}`
}
