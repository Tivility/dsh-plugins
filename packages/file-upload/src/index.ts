/**
 * Drag-and-drop upload into a harness workspace.
 *
 * The harness can read any file the agent is pointed at, but there is no way
 * to *put* a file where the agent can see it from a browser on another
 * machine. This opens one: drop a file on the page, get back its absolute
 * path, paste that path to the agent.
 *
 * Where a file may land is the same boundary the viewer reads from — the
 * registered workspaces plus configured roots — resolved the same way, so
 * anything uploaded here is immediately readable there and nothing can be
 * written outside.
 *
 * ## The lock
 *
 * `ownerAuth` is consulted per request rather than injected. That is a
 * deliberate choice about failure modes:
 *
 * - As a hard `inject`, the route would not exist at all without the lock
 *   plugin, which is fail-closed but also means an unlocked deployment (the
 *   ordinary loopback case) loses the feature for no reason.
 * - Read once at activation, the answer would be frozen: a lock loading after
 *   this plugin would never be seen, and the write route would stay open while
 *   the rest of the deployment was locked.
 *
 * Reading it per request has neither problem. No lock installed means no lock
 * applied — the deployment's own decision, matching the viewer. A lock present
 * means every upload needs the owner grant, whichever order the two plugins
 * happened to load in.
 * @module @tivility/dsh-file-upload
 */

import { createWriteStream } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  absoluteUrl,
  canonicalize,
  canonicalizeRoots,
  collectRoots,
  escapeHtml,
  isPathUnder,
  isTrustedRequest,
  normalizePublicBaseUrl,
  page,
  sendHtml,
  sendJson,
  sendStatus,
} from '@tivility/dsh-web-kit'

/** Stable Cordis plugin name. */
export const name = 'file-upload'

/**
 * Nothing hard. The route needs `webServer`, but requiring it here would make
 * this row a startup failure in every profile that serves no HTTP — and a
 * plugin suite installed once in the home overlay is exactly how that happens.
 * The route mounts through a nested injection instead.
 */
export const inject: string[] = []

/** Plugin configuration. */
export interface Config {
  /** Route prefix, absolute and without a trailing slash. */
  route?: string
  /** Extra directories files may be written into, beyond the registered workspaces. */
  roots?: string[]
  /** Whether the harness's registered workspaces accept uploads. */
  workspaces?: boolean
  /** Largest single upload, in bytes. */
  maxBytes?: number
  /** Apply the browser-trust fence. Leave this on. */
  fence?: boolean
  /** Non-loopback authorities this deployment serves, as `host` or `host:port`. */
  trustedHosts?: string[]
  /**
   * Route `@tivility/dsh-file-viewer` serves on, used to build a preview link
   * in the upload response. Empty means no link is offered.
   */
  viewerRoute?: string
  /**
   * The origin browsers actually reach this deployment at, when that is not
   * the local bind — behind a reverse proxy, tunnel, or port forwarder. The
   * preview link in the upload response is built on it. Origin only.
   */
  publicBaseUrl?: string
}

export const Config: z<Config> = z.object({
  route: z.string().default('/upload'),
  roots: z.array(String).default([]),
  workspaces: z.boolean().default(true),
  maxBytes: z.natural().default(200 * 1024 * 1024),
  fence: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  viewerRoute: z.string().default('/files'),
  publicBaseUrl: z.string().default(''),
})

/** Configuration with every default applied. */
interface Resolved {
  readonly route: string
  readonly roots: readonly string[]
  readonly workspaces: boolean
  readonly maxBytes: number
  readonly fence: boolean
  readonly trustedHosts: readonly string[]
  readonly viewerRoute: string
  readonly publicBaseUrl: string
}

/** The one method this plugin calls on the optional lock. */
interface OwnerAuthLike {
  isOwner(request: { headers: IncomingMessage['headers'] }): boolean
  readonly unlockPath?: string
}

/**
 * Apply defaults and reject a route the webserver could not match.
 * @param config - configuration as written by the deployment.
 * @returns the resolved configuration.
 * @throws {Error} when the route is not an absolute path without a trailing slash.
 */
function resolveConfig(config: Config): Resolved {
  const route = config.route ?? '/upload'
  if (!route.startsWith('/') || route.endsWith('/') || route === '') {
    throw new Error(`file-upload: route ${JSON.stringify(route)} must be an absolute path without a trailing slash`)
  }
  return {
    route,
    roots: config.roots ?? [],
    workspaces: config.workspaces ?? true,
    maxBytes: config.maxBytes ?? 200 * 1024 * 1024,
    fence: config.fence ?? true,
    trustedHosts: config.trustedHosts ?? [],
    viewerRoute: config.viewerRoute ?? '/files',
    publicBaseUrl: config.publicBaseUrl ?? '',
  }
}

/**
 * Resolve a destination that does not exist yet, and place it inside a root.
 *
 * The file itself is absent by definition, so containment is judged on its
 * canonicalized path — every existing component resolved through `realpath`,
 * which is what catches a parent directory that is a symlink out of the
 * workspace. The parent must already exist: creating directories on the way
 * would let one upload build a tree nobody asked for.
 * @param target - the requested absolute file path.
 * @param roots - the canonical roots writes are confined to.
 * @returns the canonical destination, or a reason it was refused.
 */
async function resolveDestination(
  target: string,
  roots: readonly string[],
): Promise<{ readonly path: string } | { readonly refusal: string, readonly status: number }> {
  const path = await canonicalize(target)
  const parent = dirname(path)
  let contained = false
  for (const root of roots) {
    if (await isPathUnder(path, root)) {
      contained = true
      break
    }
  }
  if (!contained) return { refusal: 'outside the writable roots', status: 403 }
  try {
    if (!(await stat(parent)).isDirectory()) {
      return { refusal: 'the destination directory is not a directory', status: 409 }
    }
  } catch {
    return { refusal: 'the destination directory does not exist', status: 409 }
  }
  return { path }
}

/**
 * Stream a request body to disk under a byte cap.
 *
 * Written to a sibling `.part` file and renamed on success, so a reader — the
 * viewer, or the agent — never opens a half-written file, and a failed upload
 * leaves nothing behind. The rename is within one directory, which also keeps
 * it off the cross-device path where rename is not atomic and would fail.
 * @param req - the incoming request, read as a stream.
 * @param destination - the final path.
 * @param maxBytes - the cap; exceeding it aborts the write.
 * @returns the bytes written, or a refusal.
 */
async function writeBody(
  req: IncomingMessage,
  destination: string,
  maxBytes: number,
): Promise<{ readonly bytes: number } | { readonly refusal: string, readonly status: number }> {
  const temporary = join(dirname(destination), `.${basename(destination)}.${String(process.pid)}.part`)
  const sink = createWriteStream(temporary, { flags: 'wx' })
  // `createWriteStream` opens lazily, so a body rejected on its very first
  // chunk can reach the cleanup below before the file exists at all. Unlinking
  // then fails with ENOENT and the pending open creates the leftover a moment
  // later — a `.part` file nobody deletes, in a directory a reader browses.
  // Waiting for the stream to close is what makes the cleanup land after the
  // open, whichever order they started in.
  const closed = new Promise<void>((resolve) => { sink.once('close', () => { resolve() }) })
  let bytes = 0
  let overflowed = false
  try {
    await pipeline(
      async function* count() {
        for await (const chunk of req) {
          const buffer = chunk as Buffer
          bytes += buffer.byteLength
          // Counted before yielding, so the cap bounds what reaches the disk
          // rather than what has already been written to it.
          if (bytes > maxBytes) {
            overflowed = true
            throw new Error('upload exceeds the configured limit')
          }
          yield buffer
        }
      },
      sink,
    )
  } catch (error: unknown) {
    await closed
    await unlink(temporary).catch(() => {})
    if (overflowed) return { refusal: `upload exceeds the ${String(maxBytes)} byte limit`, status: 413 }
    return { refusal: `upload failed: ${error instanceof Error ? error.message : String(error)}`, status: 500 }
  }
  try {
    await rename(temporary, destination)
  } catch (error: unknown) {
    await unlink(temporary).catch(() => {})
    return { refusal: `could not place the file: ${error instanceof Error ? error.message : String(error)}`, status: 500 }
  }
  return { bytes }
}

/** The drag-and-drop page. */
function uploadPage(route: string, roots: readonly string[], locked: boolean): string {
  if (roots.length === 0) {
    return page('Upload', '<h1>Upload</h1><p class="empty">No workspaces are registered and no roots are '
      + 'configured, so there is nowhere to put a file.</p>')
  }
  const options = roots
    .map(root => `<option value="${escapeHtml(root)}">${escapeHtml(root)}</option>`)
    .join('')
  const notice = locked
    ? '<p class="note">This deployment is locked; uploading needs the owner grant.</p>'
    : ''
  // The script is inline because these pages are served without a bundler and
  // a second route just to carry one file would be more moving parts than the
  // feature has.
  const script = `
const zone = document.getElementById('zone')
const log = document.getElementById('log')
const dir = document.getElementById('dir')
function line(text, ok) {
  const row = document.createElement('div')
  row.textContent = text
  row.style.color = ok === false ? '#c0392b' : 'inherit'
  log.prepend(row)
  return row
}
async function send(file) {
  const target = dir.value.replace(/\\/+$/, '') + '/' + file.name
  const row = line('uploading ' + file.name + ' …')
  const response = await fetch(${JSON.stringify(route)} + '/' + target.split('/').map(encodeURIComponent).join('/'), {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) { row.textContent = file.name + ' — ' + (body.error || response.status); row.style.color = '#c0392b'; return }
  row.textContent = ''
  const path = document.createElement('code')
  path.textContent = body.path
  row.append(path)
  if (body.url) {
    row.append(' ')
    const link = document.createElement('a')
    link.href = body.url
    link.textContent = 'view'
    row.append(link)
  }
}
for (const event of ['dragenter', 'dragover']) {
  zone.addEventListener(event, e => { e.preventDefault(); zone.classList.add('over') })
}
for (const event of ['dragleave', 'drop']) {
  zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove('over') })
}
zone.addEventListener('drop', e => { for (const file of e.dataTransfer.files) void send(file) })
zone.addEventListener('click', () => document.getElementById('pick').click())
document.getElementById('pick').addEventListener('change', e => {
  for (const file of e.target.files) void send(file)
})
`.trim()
  const style = `
#zone { border: 2px dashed var(--line); border-radius: 8px; padding: 3rem 1rem; text-align: center; cursor: pointer; color: var(--muted); }
#zone.over { border-color: var(--accent); color: var(--fg); }
#log { margin-top: 1.25rem; display: flex; flex-direction: column; gap: .4rem; font-size: .9em; }
#log code { word-break: break-all; }
select { font: inherit; padding: .35rem; max-width: 100%; }
`.trim()
  return page('Upload', [
    '<h1>Upload</h1>',
    notice,
    `<p>Destination <select id="dir">${options}</select></p>`,
    '<div id="zone">Drop files here, or click to choose</div>',
    '<input id="pick" type="file" multiple hidden>',
    '<div id="log"></div>',
    `<script>${script}</script>`,
  ].join(''), style)
}

/**
 * Build the route handler.
 * @param ctx - the plugin context, read for the workspace registry and the optional lock.
 * @param config - resolved configuration.
 * @param staticRoots - configured roots, already canonicalized.
 * @returns the handler to register.
 */
function createHandler(
  ctx: Context,
  config: Resolved,
  staticRoots: readonly string[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (config.fence && !isTrustedRequest(req, config.trustedHosts)) {
      sendStatus(res, 403, 'forbidden')
      return
    }
    // Resolved per request: a lock installed after this plugin still applies,
    // and a deployment without one is simply not locked.
    const auth = ctx.get('ownerAuth') as OwnerAuthLike | undefined
    const roots = config.workspaces ? collectRoots(ctx, staticRoots) : [...staticRoots]

    if (req.method === 'GET' || req.method === 'HEAD') {
      sendHtml(res, uploadPage(config.route, roots, auth !== undefined))
      return
    }
    if (req.method !== 'PUT') {
      sendStatus(res, 405, 'method not allowed', { allow: 'GET, HEAD, PUT' })
      return
    }
    if (auth !== undefined && !auth.isOwner(req)) {
      sendJson(res, { error: `uploading needs the owner grant — unlock at ${auth.unlockPath ?? '/unlock'}` }, 403)
      return
    }

    /* v8 ignore next -- node:http always sets url on server requests */
    const url = new URL(req.url ?? '/', 'http://x')
    let target: string
    try {
      target = decodeURIComponent(url.pathname.slice(config.route.length))
    } catch {
      sendJson(res, { error: 'malformed destination path' }, 400)
      return
    }
    if (target === '' || target === '/' || target.includes('\u0000') || target.endsWith('/')) {
      sendJson(res, { error: 'the destination must be an absolute file path' }, 400)
      return
    }

    const destination = await resolveDestination(target, roots)
    if ('refusal' in destination) {
      sendJson(res, { error: destination.refusal }, destination.status)
      return
    }
    // Overwriting is opt-in: a dropped file that silently replaces a source
    // file the agent is working on is a worse outcome than a refusal.
    if (!url.searchParams.has('overwrite')) {
      try {
        await stat(destination.path)
        sendJson(res, { error: 'a file is already there; retry with ?overwrite=1' }, 409)
        return
      } catch {
        // Absent, which is what an upload without ?overwrite=1 requires.
      }
    }

    const written = await writeBody(req, destination.path, config.maxBytes)
    if ('refusal' in written) {
      sendJson(res, { error: written.refusal }, written.status)
      return
    }
    sendJson(res, {
      path: destination.path,
      bytes: written.bytes,
      ...config.viewerRoute === ''
        ? {}
        : { url: `${absoluteUrl(ctx, config.viewerRoute, config.publicBaseUrl)}${destination.path.split('/').map(encodeURIComponent).join('/')}` },
    })
  }
}

/**
 * Mount the upload route.
 * @param ctx - plugin context carrying the injected `webServer` service.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  // Validate a configured origin at activation: a typo should stop the load,
  // not quietly hand back preview links nobody can open.
  if (resolved.publicBaseUrl !== '') normalizePublicBaseUrl(resolved.publicBaseUrl)

  // Nested, so a profile with no HTTP server activates this row and simply
  // offers no upload route.
  ctx.inject(['webServer'], (web) => {
    web.effect(async () => {
      const staticRoots = await canonicalizeRoots(resolved.roots)
      return web.webServer.register({
        kind: 'prefix',
        path: resolved.route,
        handler: createHandler(web, resolved, staticRoots),
      })
    }, `file-upload: ${resolved.route} route`)
  })
}
