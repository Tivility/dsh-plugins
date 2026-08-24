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
| `resolveUnderRoots(target, roots)` | The two above, composed into the check a route actually makes |
| `canonicalizeRoots` / `workspaceRoots` / `collectRoots` | Configured roots resolved once; workspaces read live |
| `resolvePublicBaseUrl(ctx, configured?)` | The public origin: explicit config, then `DSH_PUBLIC_BASE_URL`, then the local bind; `undefined` when nothing can answer |
| `normalizePublicBaseUrl(value)` | Validate a configured origin — absolute http(s), no credentials/query/fragment/path |
| `resolveBaseUrl(ctx, configured?)` / `absoluteUrl(ctx, path, configured?)` | The same, but failing loudly instead of returning `undefined` |
| `serveFile(req, res, file, opts)` | ETag/304, `Range`/206/416, `If-Range`, HEAD, `Content-Disposition` |
| `mimeFor` / `isInlineSafe` / `etagFor` / `isFresh` / `parseRange` | The pieces `serveFile` is built from |
| `sendStatus` / `sendBody` / `sendHtml` / `sendJson` / `assertReadMethod` | Small senders, with `nosniff` and `no-referrer` on every response |
| `page` / `escapeHtml` / `encodeSegment` / `formatBytes` | The minimal HTML shell the plugin pages share |

## Notes on two decisions

**`canonicalize` never collapses `..` lexically.** The whole path, `..` segments
included, is handed to `realpath`, which resolves symlinks *first* and only then
walks up. Collapsing `a/link/..` to `a` textually would silently step over
wherever `link` actually points.

**`isInlineSafe` excludes SVG.** An SVG is an image that executes script. Served
inline from a workspace it would run in this origin, so it is sent as an
attachment like any other opaque file.

## License

MIT
