/**
 * The browser half: open the session a link names, and offer a way to get one.
 *
 * The harness's GUI has no routing — the whole client is searched in vain for
 * `pushState`, `location.hash`, or `searchParams`. The selected session lives
 * in the sessions manager and is restored from persisted state on load, so a
 * URL naming one has nowhere to be read. This adds that step, and the control
 * that makes it reachable by a person rather than only by the model.
 *
 * It deliberately hides nothing. The sidebar, the other sessions, and the
 * composer are all exactly as they would be — the link decides where you land,
 * not what you can see.
 *
 * ## Why the context is typed here
 *
 * The two halves of this package compile in one TypeScript program, and the
 * node half pulls in the harness's HOST augmentations of `Context` — where
 * `sessions` is a different service with the same name. Importing
 * `ClientContext` would therefore resolve `ctx.sessions` to the host's shape.
 * The harness avoids this with separate client and host programs; this package
 * states the members it uses instead.
 * @module @tivility/dsh-session-share/client
 */

import { SESSION_PARAM } from '../param.js'
import { en, zh } from './locales.js'
import { SHARE_NS } from './namespace.js'
import { ShareLink } from './ShareLink.js'

export { ShareLink } from './ShareLink.js'
export { SHARE_NS } from './namespace.js'

/** The session-list snapshot this plugin reads. */
interface SessionListSnapshot {
  /** Every listed session, keyed by id. */
  readonly byId: Readonly<Record<string, unknown>>
  /** Whether the list has finished arriving. */
  readonly phase: 'pending' | 'ready'
}

/** The part of the client sessions service this plugin drives. */
interface SessionsFace {
  readonly list: {
    getSnapshot(): SessionListSnapshot
    subscribe(listener: () => void): () => void
  }
  /**
   * Select a session as current. Fails loud on an id the list does not carry,
   * which is why the phase below is consulted first.
   */
  open(id: string): void
}

/** The slot registry, narrowed to the one registration this plugin makes. */
interface SlotsFace {
  register(spec: { name: string, id?: string, order?: number, locale?: string }, component: unknown): () => void
}

/** The locale registry, narrowed to the one bundle this plugin adds. */
interface LocaleFace {
  register(namespace: string, dictionaries: Record<string, unknown>): () => void
}

/** The client context members this plugin uses. */
interface ShareContext {
  readonly sessions: SessionsFace
  readonly slots: SlotsFace
  readonly locale: LocaleFace
  effect(run: () => () => void): unknown
  readonly logger?: { warn?(message: string): void }
}

/** Client-side services this plugin drives. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Remove the parameter from the address bar once it has been acted on.
 *
 * The selection is persisted by the runtime, so leaving the parameter in place
 * would make every later reload jump back to the linked session — fighting the
 * user each time they navigate away and refresh. Consuming it once makes the
 * link mean "start here", which is what a link means.
 */
function stripParam(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(SESSION_PARAM)) return
  url.searchParams.delete(SESSION_PARAM)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

/**
 * Open the session a `?session=` parameter names, once the list can carry it.
 * @param ctx - the client root context.
 */
function openRequestedSession(ctx: ShareContext): void {
  const requested = new URL(window.location.href).searchParams.get(SESSION_PARAM)
  // No parameter is the overwhelmingly common case — every ordinary visit — so
  // this costs nothing at all when it has nothing to do.
  if (requested === null || requested === '') return

  ctx.effect(() => {
    let done = false
    const attempt = (): void => {
      if (done) return
      const state = ctx.sessions.list.getSnapshot()
      if (state.byId[requested] !== undefined) {
        done = true
        ctx.sessions.open(requested)
        stripParam()
        return
      }
      // The list arrives asynchronously, so an id that is absent right now may
      // simply not have loaded. The phase is what separates "not yet" from "no
      // such session" — a timeout would guess at it.
      if (state.phase === 'ready') {
        done = true
        stripParam()
        ctx.logger?.warn?.(`session-share: no session ${requested} in this harness`)
      }
    }
    const unsubscribe = ctx.sessions.list.subscribe(attempt)
    // The list may already be ready before this plugin activates, in which case
    // no change is ever published and the subscription alone would wait forever.
    attempt()
    return unsubscribe
  })
}

/**
 * Read the link, and offer one.
 * @param ctx - the client root context.
 */
export function apply(ctx: ShareContext): void {
  openRequestedSession(ctx)

  ctx.effect(() => ctx.locale.register(SHARE_NS, { zh, en }))
  ctx.effect(() => ctx.slots.register({
    // The header's utility band, not the title row: this is a control, and the
    // band beside the breadcrumb is where static session context belongs.
    name: 'conversation.session.header.utilities',
    id: 'session-share',
    locale: SHARE_NS,
  }, ShareLink))
}
