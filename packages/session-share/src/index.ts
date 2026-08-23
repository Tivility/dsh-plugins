/**
 * Link straight to one session.
 *
 * The harness's GUI opens wherever it was left. There is no URL that means
 * "this conversation" — the whole client carries no routing at all, and the
 * selected session is restored from persisted state. So a session cannot be
 * pointed at: not in a message, not in a ticket, not by the agent describing
 * its own work.
 *
 * This plugin adds the one missing step. The browser half reads a `?session=`
 * parameter and selects that session; this half serves a short redirect route
 * and teaches the model the link format so it can hand out links to the
 * conversations it starts.
 *
 * **It shares nothing.** Every session stays visible and the GUI is otherwise
 * untouched — the link decides where a visitor lands, not what they can see.
 * Restricting that is what `@tivility/dsh-readonly-auth` is for, and this
 * plugin deliberately does not pretend to do it: hiding the sidebar would look
 * like isolation while `/api` still answered every question about every other
 * session.
 * @module @tivility/dsh-session-share
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: contributes the `agent` field on the prompt assembly context.
import type {} from '@deepseek-ai/dsh-agent'
import { absoluteUrl, isTrustedRequest, sendStatus } from '@tivility/dsh-web-kit'
import { SESSION_PARAM, shareQuery } from './param.js'

export { SESSION_PARAM, shareQuery } from './param.js'

/** Stable Cordis plugin name. */
export const name = 'session-share'

/** The HTTP carrier this plugin mounts its redirect on. */
export const inject = ['webServer']

/** Plugin configuration. */
export interface Config {
  /**
   * Prefix for the short link form, `<route>/<session-id>`. Empty mounts no
   * route, leaving only the query form.
   */
  route?: string
  /** Teach the model the link format so it can hand out links to its own sessions. */
  prompt?: boolean
  /** Non-loopback authorities this deployment serves, as `host` or `host:port`. */
  trustedHosts?: string[]
}

export const Config: z<Config> = z.object({
  route: z.string().default('/s'),
  prompt: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** A session id as it may appear in a URL: the harness mints uuids. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Build the redirect handler for the short link form.
 *
 * A redirect rather than a page, because the GUI is a single-page app served
 * only at the root: the harness's static fallback serves `index.html` for `/`
 * and `/index.html` and 404s everything else, with no SPA rewrite. `/s/<id>`
 * would therefore be a 404, so the short form bounces to the query form the
 * browser half reads.
 * @param route - the configured prefix.
 * @param trustedHosts - authorities the fence accepts.
 * @returns the route handler.
 */
function createHandler(
  route: string,
  trustedHosts: readonly string[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendStatus(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    if (!isTrustedRequest(req, trustedHosts)) {
      sendStatus(res, 403, 'forbidden')
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    let id: string
    try {
      id = decodeURIComponent(pathname.slice(route.length).replace(/^\//, ''))
    } catch {
      sendStatus(res, 400, 'malformed session id')
      return
    }
    // Validated before it becomes a Location: the value lands in a header, and
    // an unconstrained one is where header injection lives.
    if (!SESSION_ID.test(id)) {
      sendStatus(res, 400, 'malformed session id')
      return
    }
    res.writeHead(302, { location: `/${shareQuery(id)}` })
    res.end()
  }
}

/**
 * The system prompt section teaching the model this link format.
 * @param ctx - a context carrying the `webServer` service.
 * @param route - the configured short-link prefix.
 * @param sessionId - the session the calling agent belongs to.
 * @returns the prompt text.
 */
function promptSection(ctx: Context, route: string, sessionId: string): string {
  const base = absoluteUrl(ctx, '/')
  const link = `${base}${shareQuery(sessionId)}`
  const shortForm = route === ''
    ? ''
    : ` The shorter ${absoluteUrl(ctx, route)}/${sessionId} redirects to the same place.`
  return [
    `This conversation has a direct link: ${link}`,
    `Opening it in a browser selects this session instead of whatever was last open.${shortForm}`,
    'Give it to the user when they need to come back to this conversation, point someone at it,',
    'or file it somewhere. Any session id works in the same shape — a subagent you started,',
    'a session you forked — so a link can point at that one instead of this one.',
    'The link decides which session opens, not who may read it: everyone who can reach the',
    'harness sees the same thing they would see without it.',
  ].join(' ')
}

/**
 * Mount the redirect route and the prompt section.
 * @param ctx - plugin context carrying the injected `webServer` service.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const route = config.route ?? '/s'
  const trustedHosts = config.trustedHosts ?? []
  if (route !== '') {
    if (!route.startsWith('/') || route.endsWith('/')) {
      throw new Error(`session-share: route ${JSON.stringify(route)} must be an absolute path without a trailing slash`)
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: route,
      handler: createHandler(route, trustedHosts),
    }), `session-share: ${route} route`)
  }

  if (config.prompt === false) return
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'session-share',
      order: 91,
      text: (context) => {
        // Resolved per assembly: the port is known only after the server binds,
        // and the session id is whichever agent this prompt is being built for.
        const sessionId = context.agent?.session.id
        return sessionId === undefined ? '' : promptSection(scope, route, String(sessionId))
      },
    })
  })
}
