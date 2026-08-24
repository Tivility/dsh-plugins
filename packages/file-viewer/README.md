# @tivility/dsh-file-viewer

Read-only browser preview of the files the harness works with, on the same HTTP
server the Web GUI is already on.

## The gap this fills

The Web GUI has no way to open a file on the machine the harness runs on. That
is invisible when the browser and the harness share a machine, and total the
moment they do not: the agent reports `/srv/work/report.md`, and that path names
a file on a host the reader cannot reach. Copying it out means a shell, an
`scp`, and a second window.

This plugin serves those files over the URL the GUI is already open at, and
registers a system prompt section so the model hands out **links** instead of
bare paths:

> …I wrote the summary to `/srv/work/report.md`
> (http://127.0.0.1:3080/files/srv/work/report.md).

### The example is this session's own directory

The prompt's worked example is built from the session's working directory
whenever that directory is one the route would serve — so a session in
`/srv/work` is taught `…/files/srv/work/report.md`, not a placeholder.

That is not cosmetic. A generic `/path/to/report.md` has to be combined with a
prefix before it is worth anything, and in a long or resumed session it
competes with concrete links already sitting in the history — including ones
minted before the deployment had a public origin, which is exactly when they
name an address nobody else can reach. A concrete example rooted where the
session actually works is directly reusable, which is what makes it win.

A session whose directory sits outside every root falls back to the
placeholder: a concrete example under an unreadable directory would teach a
link that answers 403. Containment is judged textually here, because a prompt
section must answer synchronously; the route still re-judges every real
request through `realpath`, so nothing about what may be read depends on it.

## What it serves

`/files` — the roots. `/files` + a file's absolute path — that file.

| | |
| --- | --- |
| a directory | listing, directories first, with sizes and times |
| `.md` | rendered, with relative links rewritten back into the route so a docs tree browses as a tree |
| image / audio / video / PDF | inline |
| anything textual | source in a `<pre>`, extension or not (`Makefile`, `LICENSE`) |
| anything else | size, type, and a download link |
| `?raw=1` | the original bytes |
| `?download=1` | the same, as a download |

`GET` and `HEAD` only. ETag/304 and `Range` are supported, so a video scrubs and
an interrupted download resumes.

## What may be read

The registered workspaces, plus any `roots` configured here. Nothing else.

A request's path is canonicalized through `realpath` **before** it is judged, so
a symlink is refused on where it lands rather than on how it is spelled. `..` is
resolved by the filesystem, not collapsed textually. A path outside every root
and a path that does not exist get the same 403, because a distinguishable 404
would report whether a file exists on a machine the reader was never given
access to.

## Two things that are not obvious

**Raw bytes are never served under their own type unless that type is inert.**
This route and the GUI share an origin. A workspace `page.html` served as
`text/html` would be script running with the GUI's access to `/api` — so
anything that isn't image/audio/video/PDF is downgraded to `text/plain` or opaque
bytes, and carries `Content-Security-Policy: sandbox` on top. SVG counts as
executable here and is downgraded with the rest.

**Markdown never emits the HTML it contains.** Raw HTML blocks are escaped and
shown as code, and `javascript:`/`data:` URLs are dropped from links and images.

## Markdown rendering

Parsed with the harness's own stack — `mdast-util-from-markdown` plus the GFM
extensions — reached through a runtime `import()` rather than a declared
dependency, because declaring it would install a second copy of a parser the
harness already ships. HTML is emitted here, which is what keeps escaping under
this package's control.

When a profile's layout does not put that stack on the resolution path, a
built-in renderer takes over: no tables and no reference links, but never
absent.

## Configuration

```yaml
- id: file-viewer
  name: '@tivility/dsh-file-viewer'
  config:
    route: /files          # route prefix
    roots: []              # extra directories, beyond the workspaces
    workspaces: true       # expose the registered workspaces
    fence: true            # see below — leave this on
    trustedHosts: []       # non-loopback authorities, as host or host:port
    prompt: true           # teach the model the link format
    markdown: true         # render .md; false shows source
    maxTextBytes: 2097152  # largest file shown as text
```

### `fence`

On by default, and worth leaving on.

There is no authentication here — that was the design decision, and the roots
are the boundary. `fence` is a different thing: it is the same browser-trust
check the harness puts in front of `/api`, which answers *"did this request
really come from a page this server served"*, never *"who is asking"*. Turning
it off exposes every root to **DNS rebinding**, which works against
`127.0.0.1` precisely because loopback is reachable — an attacker's page
re-points its own hostname at this address and reads whatever answers.

Serving on a LAN address needs the authority declared, the same way the harness
needs it for `/api`:

```yaml
    trustedHosts: ['192.168.1.9']
```

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

With no `webServer` **and** no `publicBaseUrl`, the prompt section renders
nothing rather than naming a loopback address — in a headless profile that
would point at a server which is not running. Configure the origin of the Web
profile serving the same data and headless agents can link into it.

## Pairing

Install alongside [`@tivility/dsh-readonly-auth`](../readonly-auth) to put the
whole GUI behind a lock; this plugin's roots stay the read boundary either way.

## License

MIT
