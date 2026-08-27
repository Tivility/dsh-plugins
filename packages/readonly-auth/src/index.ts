/**
 * An owner lock for a harness deployment that more than one person can reach.
 *
 * The harness has no authentication of any kind. Its `/api` fence says so in
 * its own source — it defends against DNS rebinding and cross-site requests,
 * and states that "authentication stay out of scope". Once the server is
 * bound to anything but loopback, or reached through a tunnel, everyone who
 * can open the page can drive the agent: send prompts, edit settings, read
 * credentials, run commands.
 *
 * This plugin puts a lock in front of that. Without the token you may watch —
 * the session list, transcripts, the live event stream. With it you are the
 * owner and nothing is different from an unlocked harness. The split is
 * default-deny: a method is callable by a visitor only by being on an
 * allowlist.
 *
 * It also publishes `ownerAuth`, so a plugin that opens its own route can ask
 * this one lock rather than growing a second key.
 * @module @tivility/dsh-readonly-auth
 */

import { readFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  escapeHtml, FORM_PAGE_HEADERS, isTrustedRequest, page, sendBody, sendHtml, sendStatus,
} from '@tivility/dsh-web-kit'
import { installGate } from './gate.js'
import { judge, readMethodSet, DEFAULT_READ_METHODS } from './policy.js'
import { clearCookie, digest, matches, readCookie, serializeCookie } from './token.js'
import type { CookieOptions } from './token.js'

export { DEFAULT_READ_METHODS } from './policy.js'

/** The request facts `ownerAuth` reads. */
export interface AuthRequest {
  headers: IncomingHttpHeaders | Headers
}

/** The service this plugin publishes for other plugins to reuse. */
export interface OwnerAuth {
  /**
   * Whether this request carries the owner grant.
   * @param request - the incoming request.
   * @returns true when the owner cookie holds the configured token.
   */
  isOwner(request: AuthRequest): boolean
  /**
   * Whether this request passes the harness's browser-trust fence.
   * @param request - the incoming request.
   * @returns true when the Host is ours and any browser markers are same-origin.
   */
  sameOrigin(request: AuthRequest): boolean
  /**
   * Refuse a request that is not the owner's, answering it in the process.
   * @param request - the incoming request.
   * @param response - the response to refuse with.
   * @returns true when the caller may proceed.
   */
  requireOwner(request: IncomingMessage, response: ServerResponse): boolean
  /** Where a visitor goes to unlock. */
  readonly unlockPath: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The deployment's owner lock (provided by `@tivility/dsh-readonly-auth`). */
    ownerAuth: OwnerAuth
  }
}

/** Plugin configuration. */
export interface Config {
  /** The owner token, written in the configuration. Prefer `tokenEnv` or `tokenFile`. */
  token?: string
  /** Environment variable holding the owner token. */
  tokenEnv?: string
  /** File whose entire contents (trimmed) are the owner token. */
  tokenFile?: string
  /** Route serving the unlock page. */
  route?: string
  /** The API prefix to gate. */
  apiPath?: string
  /** Name of the cookie carrying the grant. */
  cookieName?: string
  /** How long a grant lasts. */
  maxAgeSeconds?: number
  /** Add `Secure` to the cookie, for a deployment reached over TLS. */
  secure?: boolean
  /**
   * Whether a visitor without the token may read at all. False locks the
   * deployment completely, live event streams included.
   */
  allowGuests?: boolean
  /** Endpoints a visitor may call, added to the built-in read allowlist. */
  readMethods?: string[]
  /** Non-loopback authorities this deployment serves, as `host` or `host:port`. */
  trustedHosts?: string[]
}

export const Config: z<Config> = z.object({
  token: z.string(),
  tokenEnv: z.string(),
  tokenFile: z.string(),
  route: z.string().default('/unlock'),
  apiPath: z.string().default('/api'),
  cookieName: z.string().default('dsh_owner'),
  maxAgeSeconds: z.natural().default(30 * 24 * 60 * 60),
  secure: z.boolean().default(false),
  allowGuests: z.boolean().default(true),
  readMethods: z.array(String).default([]),
  trustedHosts: z.array(String).default([]),
})

/** Largest unlock body accepted, in bytes. */
const MAX_UNLOCK_BODY = 4096

/** First delay after a failed attempt, doubling per consecutive failure. */
const BACKOFF_BASE_MS = 1000

/** Ceiling for the failure backoff. */
const BACKOFF_MAX_MS = 30_000

/**
 * Resolve the owner token from whichever source the deployment configured.
 *
 * A lock with no key is refused outright rather than defaulted, because both
 * defaults are wrong: an empty token would let everyone in, and a random one
 * would let nobody in while reporting success.
 *
 * `$DSH_HOME/.env` is deliberately not consulted. That file is a fallback
 * store for the harness's *credentials* service and is never loaded into the
 * process environment, so a `tokenEnv` naming a variable that only lives
 * there would silently resolve to nothing.
 * @param config - the plugin configuration.
 * @returns the token.
 * @throws {Error} when no source yields a non-empty token.
 */
function resolveToken(config: Config): string {
  if (config.token !== undefined && config.token !== '') return config.token
  if (config.tokenFile !== undefined && config.tokenFile !== '') {
    const contents = readFileSync(config.tokenFile, 'utf8').trim()
    if (contents === '') {
      throw new Error(`readonly-auth: tokenFile ${JSON.stringify(config.tokenFile)} is empty`)
    }
    return contents
  }
  if (config.tokenEnv !== undefined && config.tokenEnv !== '') {
    const value = process.env[config.tokenEnv]
    if (value === undefined || value === '') {
      throw new Error(
        `readonly-auth: tokenEnv names ${JSON.stringify(config.tokenEnv)}, which is not set in this process. `
        + 'Export it where the harness is launched — $DSH_HOME/.env is a credentials-store fallback and does '
        + 'not reach process.env.',
      )
    }
    return value
  }
  throw new Error(
    'readonly-auth: no owner token configured. Set one of token, tokenEnv, or tokenFile — '
    + 'a lock with no key would either admit everyone or nobody.',
  )
}

/** Read a bounded request body. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    // Bounded before appending: an unbounded read is a memory exhaustion
    // primitive available to anyone who can reach the unlock page.
    if (total > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Pull the token out of an unlock submission.
 * @param body - the raw request body.
 * @param contentType - the request's content type.
 * @returns the submitted token, or undefined when the body carries none.
 */
function submittedToken(body: string, contentType: string | undefined): string | undefined {
  const essence = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (essence === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const value = (parsed as Record<string, unknown>).token
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
  return new URLSearchParams(body).get('token') ?? undefined
}

/** The unlock page, with an optional failure line. */
function unlockPage(route: string, failed: boolean): string {
  const notice = failed
    ? '<p class="note" style="color:#c0392b">That token was not accepted.</p>'
    : ''
  return page('Unlock', [
    '<h1>Unlock</h1>',
    '<p class="note">Reading is open. Enter the owner token to send prompts and change settings.</p>',
    notice,
    `<form method="post" action="${escapeHtml(route)}">`,
    '<p><input type="password" name="token" autocomplete="current-password" autofocus ',
    'style="width:100%;max-width:24rem;padding:.5rem;font:inherit"></p>',
    '<p><button type="submit" style="padding:.45rem 1.1rem;font:inherit">Unlock</button></p>',
    '</form>',
  ].join(''))
}

/** The page shown to an owner who is already unlocked. */
function lockedPage(route: string): string {
  return page('Unlock', [
    '<h1>Unlocked</h1>',
    '<p class="note">This browser holds the owner grant.</p>',
    `<form method="post" action="${escapeHtml(route)}?lock=1">`,
    '<p><button type="submit" style="padding:.45rem 1.1rem;font:inherit">Lock again</button></p>',
    '</form>',
  ].join(''))
}

/**
 * The owner lock.
 *
 * A Service rather than a function plugin because it publishes `ownerAuth`,
 * and the repository's convention is that a service package default-exports
 * its service class.
 */
export class OwnerAuthService extends Service implements OwnerAuth {
  /**
   * Nothing hard.
   *
   * Requiring `webServer` here makes this row a startup failure in every
   * profile that serves no HTTP — and a plugin suite installed once in the
   * home overlay is exactly how that happens. The gate mounts through a nested
   * injection instead.
   *
   * That is safe to soften only because the softening cannot produce a
   * deployment that *looks* locked and is not. Without a web server there is
   * no `/api` to reach and no route to leave open; with one, the gate installs
   * or throws. The failure mode this service refuses to have — installed,
   * reporting success, gating nothing — is still impossible.
   */
  static inject: string[] = []

  static Config: z<Config> = Config

  /** Comparison key for the configured token. */
  private readonly expected: Buffer

  /** Cookie shape, fixed at activation. */
  private readonly cookie: CookieOptions

  /** Endpoints a visitor may call. */
  private readonly allowed: ReadonlySet<string>

  /** Consecutive failed unlock attempts, for the backoff. */
  private failures = 0

  /**
   * Serializes unlock attempts.
   *
   * A fixed per-attempt delay does nothing against a hundred parallel
   * guesses, so attempts queue: each one waits for the previous to finish,
   * and a failure holds the queue for its backoff. Concurrency buys an
   * attacker nothing, and the owner pays a delay only after a wrong entry.
   */
  private queue: Promise<void> = Promise.resolve()

  private readonly route: string
  private readonly apiPath: string
  private readonly allowGuests: boolean
  private readonly trustedHosts: readonly string[]

  /**
   * Install the lock.
   * @param ctx - owning context, carrying the injected `webServer`.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'ownerAuth')
    this.expected = digest(resolveToken(config))
    this.route = config.route ?? '/unlock'
    this.apiPath = config.apiPath ?? '/api'
    this.allowGuests = config.allowGuests ?? true
    this.trustedHosts = config.trustedHosts ?? []
    this.allowed = readMethodSet(config.readMethods)
    this.cookie = {
      name: config.cookieName ?? 'dsh_owner',
      maxAgeSeconds: config.maxAgeSeconds ?? 30 * 24 * 60 * 60,
      secure: config.secure ?? false,
    }

    // Both the gate and the unlock page belong to the HTTP surface: where
    // there is none, there is nothing to gate and nothing to unlock.
    ctx.inject(['webServer'], (web) => {
      web.effect(() => installGate(web.webServer, {
        covers: path => path === this.apiPath || path.startsWith(`${this.apiPath}/`),
        intercept: (req, res) => this.gate(req, res),
        // Upgrades are gated only in a fully locked deployment. With guests
        // allowed the downlink is exactly what they are meant to see, and it
        // carries no upstream: the harness closes the socket on the first
        // client message.
        ...this.allowGuests ? {} : { allowUpgrade: (req: IncomingMessage) => this.isOwner(req) },
      }), 'readonly-auth: /api gate')

      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: this.route,
        handler: (req, res) => this.unlock(req, res),
      }), `readonly-auth: ${this.route} route`)
    })
  }

  /** Where a visitor goes to unlock. */
  get unlockPath(): string {
    return this.route
  }

  /**
   * Whether this request carries the owner grant.
   * @param request - the incoming request.
   * @returns true when the owner cookie holds the configured token.
   */
  isOwner(request: AuthRequest): boolean {
    const headers = request.headers instanceof Headers
      ? { cookie: request.headers.get('cookie') ?? undefined }
      : request.headers
    const presented = readCookie(headers, this.cookie.name)
    if (presented === undefined || presented === '') return false
    return matches(presented, this.expected)
  }

  /**
   * Whether this request passes the harness's browser-trust fence.
   * @param request - the incoming request.
   * @returns true when the Host is ours and any browser markers are same-origin.
   */
  sameOrigin(request: AuthRequest): boolean {
    return isTrustedRequest(request, this.trustedHosts)
  }

  /**
   * Refuse a request that is not the owner's.
   * @param request - the incoming request.
   * @param response - the response to refuse with.
   * @returns true when the caller may proceed.
   */
  requireOwner(request: IncomingMessage, response: ServerResponse): boolean {
    if (this.isOwner(request)) return true
    sendStatus(response, 403, `forbidden: unlock at ${this.route}`)
    return false
  }

  /**
   * Decide one `/api` request.
   * @param req - the incoming request.
   * @param res - the response.
   * @returns true when the gate answered and the wrapped handler must not run.
   */
  private gate(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.isOwner(req)) return false
    /* v8 ignore next -- node:http always sets url on server requests */
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (!this.allowGuests) {
      this.refuse(res, pathname, 'this deployment is locked')
      return true
    }
    const verdict = judge(
      { method: (req.method ?? 'GET').toUpperCase(), pathname, apiPath: this.apiPath },
      this.allowed,
    )
    if (verdict.allow) return false
    this.refuse(res, verdict.method, 'read-only')
    return true
  }

  /**
   * Answer a refused `/api` call in the shape the browser client parses.
   *
   * The error code is `internal` rather than something that reads like
   * "forbidden" because the harness's error codes are a closed union owned by
   * its own schema: an invented code fails the client's parse and surfaces as
   * a transport fault instead of the message written here.
   * @param res - the response.
   * @param method - the refused endpoint, for the message.
   * @param reason - the leading words of the message.
   */
  private refuse(res: ServerResponse, method: string, reason: string): void {
    const body = {
      type: 'server-response',
      rpcId: 'readonly-auth',
      result: {
        ok: false,
        error: {
          code: 'internal',
          message: `${reason}: ${method} needs the owner grant — unlock at ${this.route}`,
          details: {},
        },
      },
    }
    sendBody(res, JSON.stringify(body), 'application/json; charset=utf-8', {}, 403)
  }

  /**
   * Serve the unlock page and handle its submissions.
   * @param req - the incoming request.
   * @param res - the response.
   */
  private async unlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The unlock route is the one place a token crosses the wire, so it takes
    // the same browser-trust fence the harness puts on /api.
    if (!isTrustedRequest(req, this.trustedHosts)) {
      sendStatus(res, 403, 'forbidden')
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const url = new URL(req.url ?? '/', 'http://x')

    if (req.method === 'GET' || req.method === 'HEAD') {
      // Both pages carry a form, so both need the policy that lets it post.
      sendHtml(res, this.isOwner(req) ? lockedPage(this.route) : unlockPage(this.route, false), FORM_PAGE_HEADERS)
      return
    }
    if (req.method !== 'POST') {
      sendStatus(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST' })
      return
    }
    if (url.searchParams.has('lock')) {
      res.writeHead(303, { location: '/', 'set-cookie': clearCookie(this.cookie) })
      res.end()
      return
    }

    const body = await readBody(req, MAX_UNLOCK_BODY)
    if (body === undefined) {
      sendStatus(res, 413, 'unlock body too large')
      return
    }
    const presented = submittedToken(body, req.headers['content-type'])
    const accepted = await this.attempt(presented)
    if (!accepted) {
      sendBody(res, unlockPage(this.route, true), 'text/html; charset=utf-8', FORM_PAGE_HEADERS, 401)
      return
    }
    res.writeHead(303, {
      location: '/',
      'set-cookie': serializeCookie(presented ?? '', this.cookie),
    })
    res.end()
  }

  /**
   * Test one submitted token, serialized behind every other attempt.
   * @param presented - the submitted value, if any.
   * @returns whether the token was accepted.
   */
  private attempt(presented: string | undefined): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (presented === undefined || presented === '' || !matches(presented, this.expected)) {
        this.failures += 1
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS)
        await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
        return false
      }
      this.failures = 0
      return true
    })
    // The queue advances whatever the outcome, so one rejected attempt cannot
    // wedge the lock shut for the owner.
    this.queue = run.then(() => {}, () => {})
    return run
  }
}

export default OwnerAuthService
