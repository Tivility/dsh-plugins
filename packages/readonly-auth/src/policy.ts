/**
 * What an unlocked-but-not-owner visitor may call.
 *
 * The rule is default-deny: a method reaches the harness only by being on the
 * allowlist below. That direction is the whole point — a harness release that
 * adds a read method costs a visitor one missing feature until the list is
 * updated, while a release that adds a *write* method under a default-allow
 * rule would silently hand it out.
 *
 * The list is a judgment call about a surface this package does not own, so
 * `readMethods` in the configuration extends it without a fork.
 *
 * ## The two endpoint shapes
 *
 * `/api` carries two protocols, and a gate has to recognize both:
 *
 * - The GUI's own surface is `POST /api/<namespace>.<method>` — one path
 *   segment, dot-separated (`session.list`). The harness's RPC map says so in
 *   as many words: "map keys are the wire path segments (POST
 *   /api/session.list)".
 * - The Typert gateway claims `POST /api/<namespace>/<method>` — two
 *   segments, slash-separated (`pluginInventory/list`) — and the shared
 *   handler offers it every request first.
 *
 * @module @tivility/dsh-readonly-auth/policy
 */

/**
 * GUI methods that only read.
 *
 * Deliberately excluded, though they read something:
 *
 * - `host.listDirectory` walks the host filesystem outside any workspace.
 * - `credentials.describe` describes the deployment's secrets.
 * - `settings.describe` returns the configuration, provider routes included.
 * - `fileReferences/list`, `sessionReferenceResolver/candidates`,
 *   `commands/list` serve input affordances a visitor has no use for, since a
 *   visitor cannot send input.
 */
export const DEFAULT_READ_METHODS: readonly string[] = [
  // The conversation itself: the list, one session's transcript, and the
  // model labels the transcript renders with.
  'session.list',
  'session.search',
  'session.history',
  'session.models',
  'subagent.list',
  'subagent.history',
  // The sidebar's workspace column.
  'workspace.list',
  // Labels the transcript and the composer render: skills, presets, models.
  'skill.list',
  'agentPreset.list',
  'agentPreset.read',
  'llm.providers',
  'llm.models',
  // Host identity, for the window title and the "which machine is this" line.
  'host.describe',
  // Reactions already left on messages; putting or deleting one is a write.
  'messageFeedback/list',
  'pluginInventory/list',
]

/** Live event downlinks: server-to-browser only, and a visitor is meant to watch. */
const DOWNLINK_PATHS: ReadonlySet<string> = new Set(['/api/events.mux', '/api/events.host'])

/** Transcript download, the same bytes `session.history` already returns. */
const EXPORT_PATH = '/api/session.export'

/** What the gate decided about one request. */
export type Verdict =
  | { readonly allow: true }
  | { readonly allow: false, readonly method: string }

/** The facts the policy reads from a request. */
export interface RequestFacts {
  /** HTTP method, uppercase. */
  readonly method: string
  /** Request pathname, no query. */
  readonly pathname: string
  /** The API route prefix, normally `/api`. */
  readonly apiPath: string
}

/**
 * Decide whether a visitor may make one request.
 *
 * `POST /api/respond` is refused with everything else that writes, and it is
 * worth naming: it is not an RPC method but the channel that answers the
 * harness's own prompts — permission requests and user questions. A visitor
 * able to post there could approve a tool call.
 * @param facts - the request's method and path.
 * @param allowed - the read methods a visitor may call.
 * @returns the verdict, carrying the refused method name for the error body.
 */
export function judge(facts: RequestFacts, allowed: ReadonlySet<string>): Verdict {
  const isRead = facts.method === 'GET' || facts.method === 'HEAD'
  if (isRead && DOWNLINK_PATHS.has(facts.pathname)) return { allow: true }
  if (isRead && facts.pathname === EXPORT_PATH) return { allow: true }

  const prefix = `${facts.apiPath}/`
  if (!facts.pathname.startsWith(prefix)) {
    // The bare `/api` path is not a method; nothing legitimate posts there.
    return { allow: false, method: facts.pathname }
  }
  const endpoint = facts.pathname.slice(prefix.length)
  if (facts.method !== 'POST') {
    // Every remaining read shape was matched above; an unlisted GET on the API
    // is not something a visitor needs, and the harness answers it 404 anyway.
    return { allow: false, method: endpoint }
  }
  if (allowed.has(endpoint)) return { allow: true }
  return { allow: false, method: endpoint }
}

/**
 * Build the allowlist a gate runs with.
 * @param extra - additional endpoints from the configuration.
 * @returns the default read methods plus the configured ones.
 */
export function readMethodSet(extra: readonly string[] = []): ReadonlySet<string> {
  return new Set([...DEFAULT_READ_METHODS, ...extra])
}
