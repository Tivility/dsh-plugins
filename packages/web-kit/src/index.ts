/**
 * Shared HTTP building blocks for out-of-tree DeepSeek Harness web plugins.
 *
 * A plugin route registered through `webServer.register` gets none of the
 * protections the harness applies inside its own `/api` handler, and there is
 * no seam to inherit them from — so every plugin that opens a route has to
 * restate the browser-trust fence, path containment, and the static response
 * rules for itself. This package is that restatement, written once.
 *
 * It is a plain library, not a Cordis plugin: everything here is a pure
 * function over its arguments, with no state to share and no lifecycle to
 * own. Making it a service would buy nothing and cost a load-order dependency
 * on a fence that must never be optional — an absent security check has to be
 * a build error, not a runtime `undefined`.
 * @module @tivility/dsh-web-kit
 */

export { isTrustedRequest, isSameOrigin, isLoopbackHostname, assertTrustedAuthority } from './request-trust.js'
export type { TrustRequest } from './request-trust.js'

export { isPathUnder, canonicalize, resolveUnderRoots } from './containment.js'

export { canonicalizeRoots, workspaceRoots, collectRoots } from './roots.js'

export {
  resolveBaseUrl, resolvePublicBaseUrl, normalizePublicBaseUrl, absoluteUrl, PUBLIC_BASE_URL_ENV,
} from './base-url.js'

export {
  MIME, mimeFor, isInlineSafe, etagFor, isFresh, parseRange,
  sendStatus, sendBody, sendHtml, sendJson, serveFile, assertReadMethod,
} from './http.js'
export type { ByteRange, ServeFileOptions } from './http.js'

export { escapeHtml, encodeSegment, page, formatBytes } from './html.js'
