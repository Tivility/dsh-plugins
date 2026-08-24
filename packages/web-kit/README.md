# @tivility/dsh-web-kit

Shared HTTP building blocks for out-of-tree DeepSeek Harness web plugins.

**This is a library, not a plugin.** Nothing here is installed into a profile or
listed in `cordis.patch.yml`; the plugins that need it depend on it.

## The gap this fills

The harness applies its browser-trust fence *inside* its own `/api` handler, not
at the webserver. A route registered through `webServer.register` therefore
receives none of it — no Host fence, no cross-site check, no Origin check — and
there is no seam to inherit them from.

That matters more than "we only bind to loopback" suggests. The fence exists
because **DNS rebinding targets `127.0.0.1` precisely because it is reachable**:
an attacker's page re-points its own hostname at the loopback address and reads
whatever answers. The harness's own source says so in as many words, and it is
why the Host header — the one thing rebinding cannot forge — is checked on every
request, browser-looking or not.

Path containment has the same shape. `path.resolve` plus `startsWith` is not
containment: it misses symlink escapes, and on a case-insensitive filesystem it
*rejects* spellings that name the very same directory. The harness solves this
in `@deepseek-ai/dsh-fs-sandbox`, but does not export the function.

So every plugin opening a route has to restate the same three things. This
package is that restatement, written once.

## What it is not

It is not authentication. The fence answers *"did this request really come from
a page this server served"*, never *"who is asking"* — the harness carries the
same disclaimer on its own copy. Access control belongs to a lock such as
`ownerAuth` (`@tivility/dsh-readonly-auth`).

## What's in it

| | |
| --- | --- |
| `isTrustedRequest(req, trustedHosts?)` | The Host / cross-site / Origin fence, ported from the harness |
| `isSameOrigin(req)` | The Origin relationship alone |
| `assertTrustedAuthority(entry)` | Reject a configured host that isn't a bare canonical `host[:port]` |
| `canonicalize(path)` | `realpath` every existing component, append only what genuinely doesn't exist |
| `isPathUnder(path, root)` | Lexical fast path, filesystem-identity fallback for alias spellings |
| `isLexicallyUnder(path, root)` | The textual half alone, for a **synchronous** caller — guidance only, never authorization |
| `resolveUnderRoots(target, roots)` | The two above, composed into the check a route actually makes |
| `canonicalizeRoots` / `workspaceRoots` / `collectRoots` | Configured roots resolved once; workspaces read live |
| `resolvePublicBaseUrl(ctx, configured?)` | The public origin: explicit config, then `DSH_PUBLIC_BASE_URL`, then the local bind; `undefined` when nothing can answer |
| `normalizePublicBaseUrl(value)` | Validate a configured origin — absolute http(s), no credentials/query/fragment/path |
| `resolveBaseUrl(ctx, configured?)` / `absoluteUrl(ctx, path, configured?)` | The same, but failing loudly instead of returning `undefined` |
| `serveFile(req, res, file, opts)` | ETag/304, `Range`/206/416, `If-Range`, HEAD, `Content-Disposition` |
| `mimeFor` / `isInlineSafe` / `etagFor` / `isFresh` / `parseRange` | The pieces `serveFile` is built from |
| `sendStatus` / `sendBody` / `sendHtml` / `sendJson` / `assertReadMethod` | Small senders, with `nosniff` and `no-referrer` on every response |
| `page` / `escapeHtml` / `encodeSegment` / `formatBytes` | The minimal HTML shell the plugin pages share |

### Why `isLexicallyUnder` is exported at all

Because a system prompt section provider must return a string synchronously,
and `isPathUnder` resolves symlinks, which is asynchronous. A caller in that
position can accept a conservative answer when the answer only shapes an
example — file-viewer uses it to decide whether a session's directory is worth
naming in its prompt.

It resolves nothing, so a path that reaches the roots through a symlink reads
as outside them. That failure direction is the safe one for guidance and the
wrong one for access, which is why the table says never authorization: the
route re-judges every real request with `resolveUnderRoots`.

## Notes on two decisions

**`canonicalize` never collapses `..` lexically.** The whole path, `..` segments
included, is handed to `realpath`, which resolves symlinks *first* and only then
walks up. Collapsing `a/link/..` to `a` textually would silently step over
wherever `link` actually points.

**`isInlineSafe` excludes SVG.** An SVG is an image that executes script. Served
inline from a workspace it would run in this origin, so it is sent as an
attachment like any other opaque file.

## Versioning

**`1.x` is additive.** New helpers appear in minor releases; a signature or a
behaviour that plugins already depend on does not change inside a major. A
break gets `2.0.0`, and the plugins that need it say so.

That promise is what makes the range worth stating. Every plugin here depends
on `^1.0.0`, so one installed copy serves all of them and a new release reaches
each without republishing any. Under `0.x` that was impossible: `^0.2.0` stops
before `0.3.0`, because a `0.x` minor is a breaking boundary by convention — so
each release of this package stranded its consumers on a private copy of the
previous one. Two copies of a pure-function library cost nothing but disk, and
the version everyone reads is still the version everyone gets, which is why
this is a packaging fix and not a correctness one.

The security-shaped helpers are the reason the promise is narrow rather than
generous: `isTrustedRequest`, `resolveUnderRoots`, and `isPathUnder` decide what
a route will answer, and a plugin that pinned a stricter version must never be
loosened by an upgrade it did not ask for.

## License

MIT
