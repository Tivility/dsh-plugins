/**
 * The locale namespace this bundle registers, and the key union its copy
 * satisfies.
 *
 * Kept in its own module because the declaration merge below has to be visible
 * to both the registration site and the component, and importing the component
 * from the registration site (or the reverse) would make that a cycle.
 * @module @tivility/dsh-session-share/client/namespace
 */

import type { ShareKey } from './locales.js'

/** Locale namespace for the session-header share control. */
export const SHARE_NS = 'session.share'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The share control's copy. */
    'session.share': ShareKey
  }
}
