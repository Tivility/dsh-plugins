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

## Pairing

Install alongside [`@tivility/dsh-readonly-auth`](../readonly-auth) to put the
whole GUI behind a lock; this plugin's roots stay the read boundary either way.

## License

MIT
