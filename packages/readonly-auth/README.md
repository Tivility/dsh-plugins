# @tivility/dsh-readonly-auth

An owner lock for a harness deployment more than one person can reach. Without
the token you watch; with it, nothing is different from an unlocked harness.

Publishes the `ownerAuth` service, so other plugins reuse this one key instead
of growing their own.

## The gap this fills

**The harness has no authentication.** Not a weak one — none. Its `/api` fence
says so in its own source: it defends against DNS rebinding and cross-site
requests, and states that authentication *"stay out of scope"*.

That is the right call for a loopback tool. The moment the server is bound to
`0.0.0.0`, put behind a tunnel, or reached from a phone on the same Wi-Fi,
everyone who can open the page can send prompts, approve tool calls, read
credentials, change settings, and run commands.

## What a visitor can do

Default-deny. A method is callable by a visitor only by being on the allowlist:
the session list and search, transcripts, subagent transcripts, the workspace
list, the skill/preset/model labels the UI renders, and the live event
downlinks. Everything else returns a structured refusal.

Deliberately **not** on the list, though they read something:

| | |
| --- | --- |
| `host.listDirectory` | walks the host filesystem outside any workspace |
| `credentials.describe` | describes the deployment's secrets |
| `settings.describe` | returns the configuration, provider routes included |
| `fileReferences/list`, `commands/list` | input affordances, and a visitor cannot send input |

`readMethods` extends the list without a fork.

**`POST /api/respond` is refused with the writes**, and it is worth naming
separately: it is not an RPC method but the channel that answers the harness's
own prompts — permission requests and user questions. A visitor able to post
there could approve a tool call.

## What it does not need to gate

The WebSocket event downlinks carry no upstream. The harness closes the socket
on the first client message — `close(1008, 'downlink only')`, with
*"Client messages are a protocol violation"* in the source. So gating `/api`
over HTTP covers every write. Upgrades are gated only when `allowGuests: false`,
where the point is that a visitor should not see the stream at all.

## How the gate gets installed

By patching `webServer`, because there is no seam. All three candidates are
taken or closed:

- `connection.rpc.intercept('/api', …)` is the designed extension point, but a
  channel accepts one interceptor and `typertGateway` claims it in its own
  constructor.
- `webServer.register` refuses a duplicate `(kind, path)`, so `/api` cannot be
  claimed again and shadowed.
- Matching is longest-prefix-wins, so no more specific prefix covers every
  endpoint.

What is left is wrapping the handler already installed. Both directions are
covered — routes registered before this plugin and after it — and the *before*
case is the normal one, since bundle rows load ahead of the rows a profile
patch inserts.

**This means reading the service's private route tables.** A harness release
could move them, so every assumption is checked and a failed check **throws at
activation**: the deployment does not start, with a message saying what
changed. The failure this package refuses to have is the quiet one, where the
lock installs, reports success, and gates nothing.

## Unlocking

`GET /unlock` serves a form. A correct token sets a cookie with `HttpOnly`,
`SameSite=Strict`, `Path=/`, and `Max-Age`; `Secure` is added when `secure` is
set. `POST /unlock?lock=1` clears it.

**Wrong attempts queue.** A fixed per-attempt delay does nothing against a
hundred parallel guesses, so attempts are serialized: each waits for the
previous, and a failure holds the queue for a backoff that doubles to 30s.
Concurrency buys an attacker nothing. The owner pays only after a wrong entry.

Tokens are compared as SHA-256 digests under `timingSafeEqual`. Hashing is not
about storage — the token is in the process either way. It is what makes the
comparison constant-time at all: `timingSafeEqual` throws on length-mismatched
inputs, so comparing raw tokens would leak the secret's length.

## Profile scope

**This row is safe in any profile.** It activates without `webServer` and gates
nothing there — which is not a hole: with no web server there is no `/api` to
reach and no route left open. Where a carrier *is* present the gate installs or
activation throws, so the failure this service refuses to have — installed,
reporting success, gating nothing — is still impossible.

## Configuration

```yaml
- id: readonly-auth
  name: '@tivility/dsh-readonly-auth'
  config:
    tokenEnv: DSH_OWNER_TOKEN   # or token: / tokenFile:
    route: /unlock
    apiPath: /api
    cookieName: dsh_owner
    maxAgeSeconds: 2592000      # 30 days
    secure: false               # true when served over TLS
    allowGuests: true           # false locks it completely
    readMethods: []             # extends the built-in allowlist
    trustedHosts: []            # non-loopback authorities, host or host:port
```

With no token configured the plugin **refuses to start**. Both defaults would
be wrong: an empty token admits everyone, a random one admits nobody while
reporting success.

### Where to put the token

`$DSH_HOME/.env` will *not* work with `tokenEnv`. That file is a fallback store
for the harness's own credentials service and is never loaded into the process
environment — so a variable that only lives there resolves to nothing. Use
`tokenFile`, or export the variable where the harness is launched (for a
launchd job, `EnvironmentVariables` in the plist).

## For other plugins

```ts
export const inject = ['webServer', 'ownerAuth']

export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: '/something',
    handler: (req, res) => {
      if (!ctx.ownerAuth.requireOwner(req, res)) return
      // …owner only
    },
  })
}
```

`isOwner(req)`, `sameOrigin(req)`, `requireOwner(req, res)`, and `unlockPath`.
[`@tivility/dsh-file-upload`](../file-upload) uses it this way.

## License

MIT
