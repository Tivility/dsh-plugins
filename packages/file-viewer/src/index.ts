/**
 * Read-only browser preview of the files the harness works with.
 *
 * The harness's Web GUI has no way to open a file on the machine it runs on.
 * That is invisible when the browser and the harness share a machine, and
 * total the moment they do not: the agent reports a path, and the path names
 * a file on a host the reader cannot reach. This plugin serves those files
 * over the same HTTP server the GUI is already on — directory listings,
 * rendered Markdown, inline media, original bytes — and registers a system
 * prompt section so the model hands out links instead of bare paths.
 *
 * What may be read is decided by roots, never by the URL: the harness's
 * registered workspaces, plus whatever a deployment adds by configuration.
 * A request's path is canonicalized through `realpath` before it is judged,
 * so a symlink pointing out of a workspace is refused on where it lands
 * rather than on how it is spelled.
 *
 * There is no authentication here by design — the roots are the boundary. The
 * browser-trust fence is still applied, because it is not an access-control
 * check: it answers whether the request really came from a page this server
 * served, which is what stands between a workspace and a rebound tab.
 * @module @tivility/dsh-file-viewer
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  absoluteUrl,
  assertReadMethod,
  canonicalizeRoots,
  collectRoots,
  isInlineSafe,
  isTrustedRequest,
  mimeFor,
  resolveUnderRoots,
  sendHtml,
  sendStatus,
  serveFile,
} from '@tivility/dsh-web-kit'
import { renderMarkdown } from './markdown.js'
import { collectEntries, embedBody, filePage, listingPage, opaqueBody, rootIndexPage, textBody } from './pages.js'
import { crumbsFor, fromRequestPath, toRequestPath } from './paths.js'

export { renderMarkdown, renderFallback } from './markdown.js'
export type { MarkdownLinks } from './markdown.js'

/** Stable Cordis plugin name. */
export const name = 'file-viewer'

/** The HTTP carrier this plugin mounts its route on. */
export const inject = ['webServer']

/** Plugin configuration. */
export interface Config {
  /** Route prefix, absolute and without a trailing slash. */
  route?: string
  /** Extra directories to expose, beyond the registered workspaces. */
  roots?: string[]
  /** Whether the harness's registered workspaces are browsable. */
  workspaces?: boolean
  /**
   * Apply the browser-trust fence. Leaving this on is strongly advised: it is
   * the same fence the harness puts in front of `/api`, and turning it off
   * exposes every root to any page that can rebind a hostname to this
   * server's address.
   */
  fence?: boolean
  /** Non-loopback authorities this deployment serves, as `host` or `host:port`. */
  trustedHosts?: string[]
  /** Register the system prompt section that teaches the model the link format. */
  prompt?: boolean
  /** Render Markdown documents; false shows their source instead. */
  markdown?: boolean
  /** Largest file shown as text; bigger ones offer a download instead. */
  maxTextBytes?: number
}

export const Config: z<Config> = z.object({
  route: z.string().default('/files'),
  roots: z.array(String).default([]),
  workspaces: z.boolean().default(true),
  fence: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  prompt: z.boolean().default(true),
  markdown: z.boolean().default(true),
  maxTextBytes: z.natural().default(2 * 1024 * 1024),
})

/** Configuration with every default already applied. */
interface Resolved {
  readonly route: string
  readonly roots: readonly string[]
  readonly workspaces: boolean
  readonly fence: boolean
  readonly trustedHosts: readonly string[]
  readonly prompt: boolean
  readonly markdown: boolean
  readonly maxTextBytes: number
}

/** Extensions rendered as documents rather than shown as source. */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdown', '.mkd'])

/** Bytes sniffed when deciding whether a file is text. */
const SNIFF_BYTES = 4096

/**
 * Apply defaults and reject a route the webserver could not match.
 * @param config - configuration as written by the deployment.
 * @returns the resolved configuration.
 * @throws {Error} when the route is not an absolute path without a trailing slash.
 */
function resolveConfig(config: Config): Resolved {
  const route = config.route ?? '/files'
  if (!route.startsWith('/') || route.endsWith('/') || route === '') {
    throw new Error(`file-viewer: route ${JSON.stringify(route)} must be an absolute path without a trailing slash`)
  }
  return {
    route,
    roots: config.roots ?? [],
    workspaces: config.workspaces ?? true,
    fence: config.fence ?? true,
    trustedHosts: config.trustedHosts ?? [],
    prompt: config.prompt ?? true,
    markdown: config.markdown ?? true,
    maxTextBytes: config.maxTextBytes ?? 2 * 1024 * 1024,
  }
}

/**
 * Whether a file's leading bytes look like text.
 *
 * A NUL byte is the discriminator: it cannot occur in valid UTF-8 text and is
 * ubiquitous in the binary formats this would otherwise dump into a `<pre>`.
 * Extensions are not consulted, so an extensionless `Makefile` or `LICENSE`
 * reads as the text it is.
 * @param file - absolute path of a regular file.
 * @returns true when the file should be shown as source.
 */
async function looksTextual(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    return !buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/** How the raw route should hand one file to the browser. */
interface RawPresentation {
  readonly type: string
  readonly inline: boolean
  readonly headers: Readonly<Record<string, string>>
}

/**
 * Decide the content type the raw route serves a file under.
 *
 * The declared type is honored only for media a browser renders without
 * executing it. Everything else is downgraded — readable files to
 * `text/plain`, the rest to opaque bytes — because these routes and the
 * harness's GUI share an origin, and a workspace `.html` served as HTML would
 * be script running with the GUI's access to `/api`. Text and opaque
 * responses additionally carry a sandbox policy, so a browser that ignores
 * the type still cannot make a document out of them.
 * @param file - absolute path of the file.
 * @returns the type, disposition, and extra headers to serve it with.
 */
async function rawPresentation(file: string): Promise<RawPresentation> {
  const declared = mimeFor(file, '')
  if (declared !== '' && isInlineSafe(declared)) {
    return { type: declared, inline: true, headers: {} }
  }
  const sandbox = { 'content-security-policy': 'sandbox' }
  return await looksTextual(file)
    ? { type: 'text/plain; charset=utf-8', inline: true, headers: sandbox }
    : { type: 'application/octet-stream', inline: false, headers: sandbox }
}

/**
 * Render the page for one file.
 * @param config - resolved configuration.
 * @param path - canonical file path.
 * @param root - the root containing it.
 * @param stats - its stat result.
 * @returns a complete HTML document.
 */
async function renderFileView(
  config: Resolved,
  path: string,
  root: string,
  stats: Stats,
): Promise<string> {
  const url = `${config.route}${toRequestPath(path)}`
  const actions = { raw: `${url}?raw=1`, download: `${url}?download=1` }
  const crumbs = crumbsFor(config.route, path, root)
  const type = mimeFor(path, '')

  if (config.markdown && MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase()) && stats.size <= config.maxTextBytes) {
    const source = await readFile(path, 'utf8')
    // A relative link in a document resolves against the document's own
    // directory, then re-enters this route — so a docs tree browses as a tree
    // instead of as a pile of dead links. Absolute and external URLs pass
    // through; the renderer has already refused every executable scheme.
    const html = await renderMarkdown(source, {
      resolve: (href) => {
        if (/^(https?:|mailto:|#)/i.test(href.trim())) return href
        const [target = '', hash = ''] = href.split('#', 2)
        if (target === '') return href
        const absolute = resolvePath(dirname(path), target)
        return `${config.route}${toRequestPath(absolute)}${hash === '' ? '' : `#${hash}`}`
      },
    })
    return filePage(path, crumbs, html, actions)
  }

  if (type !== '' && isInlineSafe(type)) {
    return filePage(path, crumbs, embedBody(type, actions.raw, basename(path)), actions)
  }

  if (stats.size <= config.maxTextBytes && await looksTextual(path)) {
    return filePage(path, crumbs, textBody(await readFile(path, 'utf8')), actions)
  }

  return filePage(
    path,
    crumbs,
    opaqueBody(stats, type === '' ? 'application/octet-stream' : type),
    actions,
    stats.size > config.maxTextBytes ? 'Larger than the configured preview limit.' : undefined,
  )
}

/**
 * Build the route handler.
 * @param ctx - the plugin context, read for the live workspace registry.
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
    if (!assertReadMethod(req, res)) return
    if (config.fence && !isTrustedRequest(req, config.trustedHosts)) {
      sendStatus(res, 403, 'forbidden')
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const url = new URL(req.url ?? '/', 'http://x')
    let relative: string
    try {
      relative = decodeURIComponent(url.pathname.slice(config.route.length))
    } catch {
      sendStatus(res, 400, 'malformed path')
      return
    }

    // Workspaces are read per request: the registry is live, and a workspace
    // added while the server runs must become browsable without a restart.
    const roots = config.workspaces
      ? collectRoots(ctx, staticRoots)
      : [...staticRoots]

    if (relative === '' || relative === '/') {
      sendHtml(res, rootIndexPage(config.route, roots))
      return
    }

    const target = fromRequestPath(relative)
    if (target === undefined) {
      sendStatus(res, 400, 'malformed path')
      return
    }

    const found = await resolveUnderRoots(target, roots)
    // One answer for "outside every root" and for "no such root": a
    // distinguishable 404 would report whether a path exists on a machine the
    // reader was never given access to.
    if (found === undefined) {
      sendStatus(res, 403, 'outside the browsable roots')
      return
    }

    let stats: Stats
    try {
      stats = await stat(found.path)
    } catch {
      sendStatus(res, 404, 'not found')
      return
    }

    if (stats.isDirectory()) {
      const entries = await collectEntries(found.path, await readdir(found.path, { withFileTypes: true }), stat)
      sendHtml(res, listingPage(config.route, found.path, crumbsFor(config.route, found.path, found.root), entries))
      return
    }

    if (!stats.isFile()) {
      sendStatus(res, 403, 'not a regular file')
      return
    }

    if (url.searchParams.has('download')) {
      await serveFile(req, res, found.path, { download: basename(found.path), stats })
      return
    }
    if (url.searchParams.has('raw')) {
      const presentation = await rawPresentation(found.path)
      await serveFile(req, res, found.path, { ...presentation, stats })
      return
    }
    sendHtml(res, await renderFileView(config, found.path, found.root, stats))
  }
}

/**
 * The system prompt section teaching the model this route's URL format.
 * @param ctx - a context carrying the `webServer` service.
 * @param config - resolved configuration.
 * @returns the prompt text.
 */
function promptSection(ctx: Context, config: Resolved): string {
  const base = absoluteUrl(ctx, config.route)
  const example = `${base}${toRequestPath(join('/path', 'to', 'report.md'))}`
  return [
    `Files inside the user's workspaces are readable in a browser at ${base}.`,
    'A file\'s URL is that prefix followed by its absolute path, percent-encoded one segment at a time —',
    `for example \`/path/to/report.md\` is ${example}.`,
    'Append `?raw=1` for the original bytes, or `?download=1` to download the file.',
    'Directories are browsable at the same kind of URL.',
    'When you refer to a file you have written or read, give this link alongside the path,',
    'so the user can open it from a browser even when it is not on their own machine.',
    'Only paths inside a registered workspace are reachable this way; anything else returns 403.',
  ].join(' ')
}

/**
 * Mount the viewer route and the prompt section.
 * @param ctx - plugin context carrying the injected `webServer` service.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  ctx.effect(async () => {
    // Configured roots are canonicalized before the route exists, so no
    // request can be answered against a half-built root set.
    const staticRoots = await canonicalizeRoots(resolved.roots)
    return ctx.webServer.register({
      kind: 'prefix',
      path: resolved.route,
      handler: createHandler(ctx, resolved, staticRoots),
    })
  }, `file-viewer: ${resolved.route} route`)

  if (!resolved.prompt) return
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'file-viewer',
      order: 90,
      // Resolved per assembly, not at registration: the port is only known
      // once the server has bound, which may be after this row is added.
      text: () => promptSection(scope, resolved),
    })
  })
}
