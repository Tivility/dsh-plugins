# @tivility/dsh-session-share

A link that opens one session.

## The gap this fills

The harness's GUI opens wherever it was left. There is no URL that means *this
conversation* — the client carries **no routing at all** (search it for
`pushState`, `location.hash`, or `searchParams` and you find nothing), and the
selected session is restored from persisted state on load.

So a session cannot be pointed at. Not in a message, not in a ticket, not by
the agent describing its own work. "It's the third one down, from Tuesday" is
the state of the art.

This adds the one missing step:

```
http://127.0.0.1:3080/?session=<id>     ← opens that session
http://127.0.0.1:3080/s/<id>            ← redirects to the same place
```

The agent is taught the format, so it can hand out a link to the conversation
you are in, to a subagent it started, or to a session it forked.

## What it does not do

**It shares nothing and hides nothing.** The sidebar, the other sessions, and
the composer are exactly as they would be. The link decides where a visitor
lands, not what they can see.

That is a deliberate limit rather than an oversight. Hiding the sidebar would
*look* like isolation while `/api` went on answering every question about every
other session — visual privacy, which is the kind that gets people in trouble.
Restricting what a visitor can reach is
[`@tivility/dsh-readonly-auth`](../readonly-auth)'s job, and it does it at the
API rather than in the DOM.

## Getting a link

A **Copy link** control in the session header, beside the session log. Its
hover text is the URL itself — which is also how someone discovers the format
exists.

That control is the difference between a feature and a convention. Without it
the link format reaches only the *model*, through the system prompt, and a
person looking at the GUI is left to assemble a URL from a session id the
interface never shows them.

The origin comes from `window.location`, so the link is always the address this
browser reached the harness at — loopback when that is how you opened it, the
LAN address when it is not. Nothing to configure, and nothing that can drift
from where the server actually answers.

A refused clipboard write (denied permission, insecure context) leaves the
button idle rather than claiming a copy that did not happen. The URL is in the
hover text either way.

## How it works

Two halves, which is what the harness's client-module system is for.

**The browser half** reads `?session=`, waits for the session list, calls
`sessions.open(id)`, then strips the parameter from the address bar. It also
registers the header control into `conversation.session.header.utilities`.

Two details carry their weight:

- **The wait is on the list's phase, not a timeout.** `open()` fails loud on an
  id the list does not carry, and the list arrives asynchronously — so `phase:
  'ready'` is what separates "not loaded yet" from "no such session". A timeout
  would be guessing.
- **The parameter is consumed once.** The selection is persisted, so leaving it
  in the URL would make every later reload jump back to the linked session,
  fighting the user each time they navigate away and refresh. Consuming it
  makes the link mean "start here", which is what a link means.

**The node half** serves the `/s/<id>` redirect and registers the prompt
section. The short form has to be a redirect rather than a page: the GUI is
served only at the root — the harness's static fallback answers `/` and
`/index.html` and 404s everything else, with no SPA rewrite — so `/s/<id>`
would otherwise be a 404. The id is validated before it becomes a `Location`,
because an unconstrained value in a response header is where header injection
lives.

## Building the browser bundle

This is the only package here with a browser half, so it is the only one that
needs a bundler:

```sh
pnpm --filter @tivility/dsh-session-share run bundle
```

after the usual `pnpm run build`. The bundle must exist before the harness
loads the plugin; without it the client-module scanner reports a missing
bundle at startup.

`tsdown.config.ts` restates the harness's loader contract — CJS on a browser
platform, the `__ModuleLoader__.load` handoff, externals limited to the
loader's module table, source maps. The harness ships a preset for this, but it
is repository-bound (it locates packages by globbing inside the harness
checkout), so the four rules are written out instead. They are short, and they
are the whole of what makes a bundle loadable.

## Profile scope, and links behind a proxy

**This row is safe in any profile.** It activates without `webServer` and
simply serves nothing, so a suite installed once in `$DSH_HOME/cordis.patch.yml`
does not turn a Web feature into a headless startup failure.

**`publicBaseUrl` is the origin browsers actually reach.** The local bind is
not the public origin behind a reverse proxy, tunnel, port forwarder, or TLS
terminator, and no inference recovers one — so a deployment that has one says
so:

```yaml
    publicBaseUrl: https://dsh.example.com
```

Origin only: scheme, host, optional port. Credentials, queries, fragments, and
path prefixes are refused at activation rather than half-supported — every
route is appended whole, so a prefix would vanish from the middle of each link.
`DSH_PUBLIC_BASE_URL` sets it process-wide; explicit configuration outranks it.

Forwarded headers are deliberately never consulted: `Host` and `X-Forwarded-*`
are attacker-controlled on any request that reaches the server, so trusting
them would let a visitor choose the origin the model puts in front of a user.

With no `webServer` **and** no `publicBaseUrl`, the prompt section renders
nothing rather than naming a loopback address — in a headless profile that
would point at a server which is not running. Configure the origin of the Web
profile serving the same data and headless agents can link into it.

## Configuration

```yaml
- id: session-share
  name: '@tivility/dsh-session-share'
  config:
    route: /s              # empty mounts no redirect, leaving the query form
    prompt: true           # teach the model the link format
    trustedHosts: []
```

The `?session=` parameter name is a constant, not configuration: the two halves
cannot share a configured value — the browser bundle is fetched outside the
loader's config tree — and a constant is the honest form of something that has
to match in two places.

## License

MIT
