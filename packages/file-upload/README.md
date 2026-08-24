# @tivility/dsh-file-upload

Drop a file on a page, get back its absolute path, paste that path to the
agent.

## The gap this fills

The harness reads any file the agent is pointed at, but there is no way to
*put* a file where the agent can see it. That is fine when the browser and the
harness share a machine and invisible otherwise: from a phone, or a laptop
talking to a server, there is no path that names a file both ends can reach.

The counterpart to [`@tivility/dsh-file-viewer`](../file-viewer), which solves
the same problem in the other direction.

## How it works

`PUT /upload/<absolute-file-path>` with the file as the raw body. The response
is JSON:

```json
{ "path": "/srv/work/inbox/report.pdf", "bytes": 184320,
  "url": "http://127.0.0.1:3080/files/srv/work/inbox/report.pdf" }
```

`GET /upload` serves a drag-and-drop page that does this for you.

**Raw `PUT`, not `multipart/form-data`** — the body *is* the file, so there is
no multipart parser here, and nothing that has to be told the difference
between a boundary and file content.

**Written to a sibling `.part` and renamed on success.** A reader — the viewer,
or the agent — never opens a half-written file, and a failed upload leaves
nothing behind. The rename stays within one directory, which also keeps it off
the cross-device path where rename is not atomic.

**The cap is counted before bytes reach the disk**, not after, so a 200 MB
limit bounds what gets written rather than what has already been written.

**Overwriting is opt-in** (`?overwrite=1`). A dropped file that silently
replaces a source file the agent is working on is a worse outcome than a
refusal.

**The destination directory must already exist.** Creating directories on the
way would let one upload build a tree nobody asked for.

## Where files may land

The registered workspaces plus any configured `roots` — the same boundary the
viewer reads from, resolved the same way, so anything uploaded here is
immediately readable there.

The destination does not exist yet, so containment is judged on its
canonicalized path: every existing component resolved through `realpath`, which
is what catches a parent directory that is a symlink out of the workspace.

## The lock

If [`@tivility/dsh-readonly-auth`](../readonly-auth) is installed, every upload
needs the owner grant. If it is not, uploads are open — the same rule the
viewer follows.

`ownerAuth` is resolved **per request**, not injected, and that is about
failure modes rather than convenience:

- As a hard `inject`, the route would not exist without the lock plugin —
  fail-closed, but it also costs an ordinary loopback deployment the feature
  for no reason.
- Read once at activation, the answer would be frozen: a lock loading *after*
  this plugin would never be seen, and the write route would stay open while
  the rest of the deployment was locked.

Per-request has neither problem, and works whichever order the two plugins
load in.

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

**`publicBaseUrl` says where links point; `trustedHosts` says who is let in.**
They are two halves of one deployment, and configuring either alone fails in a
way that reads as a bug in this package. A browser that reached a forwarded
origin sends `Host: dsh.example.com`, and the browser-trust fence refuses an
authority it was never told about — so `publicBaseUrl` on its own produces
links that look correct and answer `403`. Behind a proxy, set both:

```yaml
    publicBaseUrl: https://dsh.example.com
    trustedHosts: ['dsh.example.com']
```

That the fence still refuses an undeclared authority is the point, not a
leftover: `publicBaseUrl` changes what a link says, and is deliberately unable
to widen what the server answers.

## Configuration

```yaml
- id: file-upload
  name: '@tivility/dsh-file-upload'
  config:
    route: /upload
    roots: []                 # extra directories, beyond the workspaces
    workspaces: true
    maxBytes: 209715200       # 200 MB
    fence: true               # see file-viewer's README
    trustedHosts: []
    viewerRoute: /files       # empty to omit the preview link
```

`fence` is the browser-trust check, not authentication — see
[file-viewer's README](../file-viewer#fence) for what it does and why leaving
it on matters. On a write route it matters more.

## License

MIT
