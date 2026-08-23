/**
 * Session affinity for HTTP LLM gateways.
 *
 * The harness stamps every loop-built request with `GenerateOptions.sessionId`,
 * and its own contract says adapters "may map it to model-hidden transport
 * metadata" — `@deepseek-ai/dsh-llm-deepseek` does exactly that, sending
 * `x-deepseek-harness-session-id`. `@deepseek-ai/dsh-llm-pi-ai` accepts the
 * field and forwards it to pi-ai, which uses it only for local resource
 * cleanup, so it never reaches the wire. Any gateway that keys per-conversation
 * state therefore sees every request as one anonymous conversation.
 *
 * This plugin closes that gap without touching the adapter: it wraps the
 * `llm/stream` waterfall, and while that stream is being pulled it adds the
 * configured header to outgoing requests.
 *
 * @module @tivility/dsh-llm-affinity
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'

/** The resource argument of the platform `fetch`, whatever this runtime names it. */
type FetchInput = Parameters<typeof globalThis.fetch>[0]

/** What one wrapped `llm/stream` call publishes to the fetch interceptor. */
interface AffinityScope {
  /** The harness session id, already string-encoded. */
  readonly sessionId: string
  /** The provider route the request was routed to; used only for diagnostics. */
  readonly provider: string
}

const scopes = new AsyncLocalStorage<AffinityScope>()

/** Defaults applied to an absent or partial {@link Config}. */
const DEFAULT_HEADER = 'X-Session-ID'

/** Cordis plugin name. */
export const name = 'llm-affinity'

/**
 * `llm` is the waterfall this plugin attaches to. Nothing else is required: the
 * interception happens at the transport, not at the adapter.
 */
export const inject = ['llm']

/** Plugin configuration. */
export interface Config {
  /**
   * Header carrying the session id. `X-Session-ID` is the one name accepted by
   * every provider branch of a CLIProxyAPI-style gateway's affinity resolver,
   * so it is the default; a deployment whose gateway reads another name sets it
   * here rather than patching this package.
   */
  header?: string
  /**
   * Body field to carry the same value, for a gateway that reads affinity from
   * the request body instead of a header (`prompt_cache_key` is the field
   * OpenAI defines for cache routing, and the one such gateways reuse). Unset
   * leaves the body untouched — the default, because rewriting a request body
   * costs a parse and re-serialize per call.
   */
  bodyField?: string
  /**
   * Provider routes this applies to. Empty means every route: the header is
   * inert for a provider that does not read it, and restricting the set is only
   * needed when one route's upstream rejects unknown headers.
   */
  providers?: string[]
  /**
   * Request origins the header may be sent to, as `host` or `host:port`. Empty
   * means every origin reached from inside a wrapped stream. Set this when the
   * process also talks to an endpoint that must not see the session id.
   */
  origins?: string[]
  /**
   * Whether an auxiliary request — compaction, session-title — gets its own
   * affinity value rather than sharing the conversation's. It carries the same
   * session id but a completely different prompt, so sharing the value pollutes
   * a prompt cache keyed on it and, on a gateway that keys per-conversation turn
   * state, lets an auxiliary turn disturb the conversation's. On by default;
   * turn it off for a gateway that must see one value per session.
   */
  separateAuxiliary?: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  header: z.string().default(DEFAULT_HEADER),
  bodyField: z.string(),
  providers: z.array(z.string()).default([]),
  origins: z.array(z.string()).default([]),
  separateAuxiliary: z.boolean().default(true),
})

/**
 * Whether a value is safe to place in an HTTP header. A session id is an opaque
 * branded id, but it crosses a wire boundary here: `Headers.set` throws on a
 * control character, and a throw inside the interceptor would fail the whole
 * model request instead of merely losing affinity.
 * @param value - the candidate header value.
 * @returns whether it can be sent verbatim.
 */
function wireSafeValue(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Whether one request URL is allowed to receive the affinity header.
 * @param url - the outgoing request URL.
 * @param origins - configured allowlist; empty allows every origin.
 * @returns whether the header may be added.
 */
function originAllowed(url: string, origins: readonly string[]): boolean {
  if (origins.length === 0) return true
  let host: string
  try {
    host = new URL(url).host
  } catch {
    // A relative or malformed URL never matches a configured origin, and an
    // allowlist that cannot be evaluated must not open.
    return false
  }
  return origins.includes(host)
}

/**
 * Add the affinity header — and optionally the body field — to one outgoing
 * request while a wrapped stream is being pulled.
 * @param input - the `fetch` resource argument, verbatim.
 * @param init - the `fetch` init argument, verbatim.
 * @param scope - the active session scope.
 * @param config - resolved plugin configuration.
 * @returns the init to call the original `fetch` with.
 */
function decorate(
  input: FetchInput,
  init: RequestInit | undefined,
  scope: AffinityScope,
  config: Required<Pick<Config, 'header'>> & Config,
): RequestInit | undefined {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!originAllowed(url, config.origins ?? [])) return init
  if (!wireSafeValue(scope.sessionId)) return init
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set(config.header, scope.sessionId)
  const next: RequestInit = { ...init, headers }
  const field = config.bodyField
  if (field === undefined || field === '') return next
  const body = init?.body
  // Only a string body is rewritten. A stream or a typed array is either not
  // JSON or not replayable, and guessing would corrupt the request.
  if (typeof body !== 'string') return next
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return next
    next.body = JSON.stringify({ ...parsed as Record<string, unknown>, [field]: scope.sessionId })
  } catch {
    // A non-JSON string body belongs to a protocol this plugin does not model;
    // the header alone still carries the identity.
    return next
  }
  return next
}

/**
 * Pull one inner stream with the affinity scope active for every `next()`.
 *
 * The scope has to be entered per pull rather than around the call that creates
 * the iterator: an async generator body runs on the consumer's context, so a
 * scope entered only at creation is gone by the time the first chunk — and the
 * HTTP request that produces it — is requested.
 * @param inner - the downstream stream from the waterfall's `next()`.
 * @param scope - the session scope to publish while pulling.
 * @returns the same chunks, pulled inside the scope.
 */
async function* pullInScope<T>(
  inner: AsyncIterable<T>,
  scope: AffinityScope,
): AsyncIterable<T> {
  const iterator = inner[Symbol.asyncIterator]()
  try {
    while (true) {
      const result = await scopes.run(scope, () => iterator.next())
      if (result.done === true) return
      yield result.value
    }
  } finally {
    // Consumer teardown (cancel, error, break) must reach the adapter, or a
    // provider stream stays open for the rest of the process's life.
    await scopes.run(scope, async () => {
      await iterator.return?.(undefined)
    })
  }
}

/**
 * Install the waterfall wrapper and the transport interceptor.
 * @param ctx - cordis context carrying the injected `llm` service.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = { ...config, header: config.header ?? DEFAULT_HEADER }
  const routes = new Set(config.providers ?? [])

  // The interceptor is a no-op outside a wrapped stream, so a request this
  // plugin knows nothing about is passed through untouched.
  const original = globalThis.fetch
  const patched: typeof globalThis.fetch = (input, init) => {
    const scope = scopes.getStore()
    if (scope === undefined) return original(input, init)
    return original(input, decorate(input, init, scope, resolved))
  }
  ctx.effect(() => {
    globalThis.fetch = patched
    return () => {
      // Restore only our own patch: another plugin may have wrapped fetch after
      // us, and clobbering its wrapper would silently disable it.
      if (globalThis.fetch === patched) globalThis.fetch = original
    }
  })

  ctx.on('llm/stream', (options, next) => {
    const sessionId = options.sessionId
    if (sessionId === undefined) return next()
    if (routes.size > 0 && !routes.has(options.provider)) return next()
    // An auxiliary request shares the conversation's session id but not its
    // prompt, so by default it gets a distinct value; see `separateAuxiliary`.
    const suffix = resolved.separateAuxiliary !== false && options.purpose !== undefined
      ? `:${options.purpose}`
      : ''
    return pullInScope(next(), { sessionId: `${String(sessionId)}${suffix}`, provider: options.provider })
  })
}
