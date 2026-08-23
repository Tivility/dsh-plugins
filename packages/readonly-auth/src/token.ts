/**
 * The token comparison and the cookie that carries a successful one.
 * @module @tivility/dsh-readonly-auth/token
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * The comparison key for one token.
 *
 * Hashing before comparing is not about storage — the token is in this
 * process either way. It is what makes the comparison safe to run in constant
 * time: `timingSafeEqual` throws on length-mismatched inputs, so comparing raw
 * tokens would leak the secret's length through that exception and force a
 * length check whose own timing leaks the same thing. Two digests are always
 * 32 bytes.
 * @param token - the secret, verbatim.
 * @returns its SHA-256 digest.
 */
export function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * Whether a presented secret is the configured one.
 * @param presented - the value from the request.
 * @param expected - the digest of the configured token.
 * @returns true when they match.
 */
export function matches(presented: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(presented), expected)
}

/**
 * Read one cookie from a request's header bag.
 *
 * Parsed here rather than with a library because the grammar this needs is
 * one line, and the value is compared against a digest rather than
 * interpreted — a lenient parse cannot widen what it accepts.
 * @param headers - the request headers.
 * @param name - the cookie name.
 * @returns the raw cookie value, or undefined when absent.
 */
export function readCookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  const header = headers.cookie
  if (typeof header !== 'string') return undefined
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=')
    if (at === -1) continue
    if (pair.slice(0, at).trim() !== name) continue
    return decodeURIComponent(pair.slice(at + 1).trim())
  }
  return undefined
}

/** How the owner cookie is written. */
export interface CookieOptions {
  readonly name: string
  readonly maxAgeSeconds: number
  /** Add `Secure`, for a deployment reached over TLS. */
  readonly secure: boolean
}

/**
 * Serialize the owner cookie.
 *
 * `HttpOnly` keeps it out of `document.cookie`, so a script that ever runs in
 * this origin cannot read the key out. `SameSite=Strict` means a cross-site
 * navigation does not carry it, which is what stops another page from driving
 * the agent through the reader's own unlocked browser. `Path=/` is explicit
 * because the default would scope the cookie to the unlock route it was set
 * from and nothing else would ever see it.
 * @param value - the token to store.
 * @param options - cookie name, lifetime, and TLS flag.
 * @returns the `Set-Cookie` value.
 */
export function serializeCookie(value: string, options: CookieOptions): string {
  const parts = [
    `${options.name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Serialize the cookie that clears the owner grant.
 * @param options - cookie name and TLS flag.
 * @returns the `Set-Cookie` value that expires it.
 */
export function clearCookie(options: CookieOptions): string {
  return serializeCookie('', { ...options, maxAgeSeconds: 0 })
}
