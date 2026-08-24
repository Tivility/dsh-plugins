import { createServer, request } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalize } from '@tivility/dsh-web-kit'
import { apply, type Config } from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Stand in for the parts of `Context` this plugin touches, and capture the
 * route it registers.
 */
async function mount(
  config: Config,
  workspaces: readonly string[],
  options: MountOptions = {},
): Promise<Handler> {
  const handler = await mountMaybe(config, workspaces, options)
  if (handler === undefined) throw new Error('the plugin registered no route')
  return handler
}

/** Mount and return the text of the prompt section the plugin registered. */
async function promptFor(
  config: Config,
  options: MountOptions = {},
  workspaces: readonly string[] = [],
): Promise<string> {
  let text = ''
  await mountMaybe(config, workspaces, options, (render) => { text = render })
  return text
}

/** What the harness varies between mounts. */
interface MountOptions {
  /** Whether a `webServer` is present; a headless profile has none. */
  readonly webServer?: boolean
  /** The assembling agent's session working directory, when the assembly has an agent. */
  readonly cwd?: string
}

/** Mount without requiring a route: a headless composition registers none. */
async function mountMaybe(
  config: Config,
  workspaces: readonly string[],
  options: MountOptions = {},
  onPrompt?: (text: string) => void,
): Promise<Handler | undefined> {
  const settled: Promise<unknown>[] = []
  let handler: Handler | undefined
  const server = {
    host: '127.0.0.1',
    port: 3080,
    register(route: { handler: Handler }) {
      handler = route.handler
      return () => {}
    },
  }
  const webServer = options.webServer === false ? undefined : server
  const systemPrompt = {
    section(spec: { text(context: unknown): string }) {
      // `agent` is absent on a diagnostic assembly, which is why the plugin
      // treats it as optional rather than assuming a session is present.
      const agent = options.cwd === undefined
        ? undefined
        : { session: { header: { cwd: options.cwd } } }
      onPrompt?.(spec.text({ scope: {}, agent }))
      return () => {}
    },
  }
  const ctx = {
    webServer,
    systemPrompt,
    get(nameString: string) {
      if (nameString === 'webServer') return webServer
      if (nameString === 'systemPrompt') return systemPrompt
      if (nameString === 'workspaceRegistry') return { list: () => workspaces.map(path => ({ path })) }
      return undefined
    },
    effect(run: () => unknown) {
      settled.push(Promise.resolve(run()))
      return () => {}
    },
    // Mirrors cordis: the callback runs only once every named service is
    // present, which is exactly what a headless profile does not do.
    inject(names: string[], run: (scope: unknown) => void) {
      if (names.every(n => ctx.get(n) !== undefined)) run(ctx)
      return {}
    },
  }
  apply(ctx as never, config)
  await Promise.all(settled)
  return handler
}

let base: string
let workspace: string
let outside: string
let server: Server
let origin: string

/** Fetch one viewer URL. */
async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, { headers })
}

/** One raw response, for assertions `fetch` cannot reach. */
interface RawResponse {
  readonly status: number
  readonly body: string
}

/**
 * Issue a request through node:http rather than fetch.
 *
 * `fetch` treats `Host` as a forbidden header and silently drops any attempt
 * to set it — which is exactly the header the rebinding fence reads, so a
 * fetch-based test of that fence would pass no matter what the fence did.
 */
async function rawGet(port: number, path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    call.on('error', reject)
    call.end()
  })
}

beforeAll(async () => {
  base = await canonicalize(await mkdtemp(join(tmpdir(), 'file-viewer-')))
  workspace = join(base, 'project')
  outside = join(base, 'private')
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# Project\n\nSee [docs](./docs/guide.md).\n')
  await writeFile(join(workspace, 'docs', 'guide.md'), '# Guide\n')
  await writeFile(join(workspace, 'notes.txt'), 'plain notes')
  await writeFile(join(workspace, 'page.html'), '<script>alert(1)</script>')
  await writeFile(join(workspace, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]))
  await writeFile(join(outside, 'secret.txt'), 'do not read')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'leak'))

  const handler = await mount({ route: '/files' }, [workspace])
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(base, { recursive: true, force: true })
})

describe('containment', () => {
  it('refuses a path outside every root', async () => {
    const response = await get(`/files${outside}/secret.txt`)
    expect(response.status).toBe(403)
  })

  it('refuses a symlink that leaves the workspace', async () => {
    const response = await get(`/files${workspace}/leak`)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('do not read')
  })

  it('refuses a traversal spelled with ..', async () => {
    const response = await get(`/files${workspace}/../private/secret.txt`)
    expect(response.status).toBe(403)
  })

  it('answers a missing file inside a root with 404', async () => {
    const response = await get(`/files${workspace}/nope.txt`)
    expect(response.status).toBe(404)
  })

  it('refuses a path carrying an encoded NUL', async () => {
    const response = await get(`/files${workspace}/notes.txt%00.png`)
    expect(response.status).toBe(400)
  })
})

describe('browser-trust fence', () => {
  it('refuses a rebound Host', async () => {
    const port = (server.address() as AddressInfo).port
    const response = await rawGet(port, '/files', { host: 'attacker.test' })
    expect(response.status).toBe(403)
    expect(response.body).not.toContain('project')
  })

  it('accepts a LAN authority the deployment declared', async () => {
    const fenced = await mount({ route: '/files', trustedHosts: ['harness.lan'] }, [workspace])
    const listener = createServer((req, res) => { void fenced(req, res) })
    await new Promise<void>((resolve) => { listener.listen(0, '127.0.0.1', resolve) })
    const port = (listener.address() as AddressInfo).port
    expect((await rawGet(port, '/files', { host: 'harness.lan' })).status).toBe(200)
    expect((await rawGet(port, '/files', { host: 'other.lan' })).status).toBe(403)
    await new Promise<void>((resolve) => { listener.close(() => { resolve() }) })
  })

  it('refuses a cross-site initiator', async () => {
    const response = await get('/files', { 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
  })

  it('can be turned off by configuration', async () => {
    const open = await mount({ route: '/files', fence: false }, [workspace])
    const unfenced = createServer((req, res) => { void open(req, res) })
    await new Promise<void>((resolve) => { unfenced.listen(0, '127.0.0.1', resolve) })
    const port = (unfenced.address() as AddressInfo).port
    expect((await rawGet(port, '/files', { host: 'attacker.test' })).status).toBe(200)
    await new Promise<void>((resolve) => { unfenced.close(() => { resolve() }) })
  })
})

describe('method gate', () => {
  it('refuses anything that is not a read', async () => {
    const response = await fetch(`${origin}/files`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })
})

describe('browsing', () => {
  it('lists the roots at the route itself', async () => {
    const response = await get('/files')
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('project')
    expect(html).toContain(workspace)
  })

  it('lists a directory with its entries', async () => {
    const html = await (await get(`/files${workspace}`)).text()
    expect(html).toContain('README.md')
    expect(html).toContain('docs/')
    expect(html).toContain('notes.txt')
  })

  it('renders Markdown and rewrites its relative links back into the route', async () => {
    const html = await (await get(`/files${workspace}/README.md`)).text()
    expect(html).toContain('<h1>Project</h1>')
    expect(html).toContain(`href="/files${workspace}/docs/guide.md"`)
  })

  it('shows a text file as source', async () => {
    const html = await (await get(`/files${workspace}/notes.txt`)).text()
    expect(html).toContain('<pre><code>plain notes</code></pre>')
  })

  it('describes a binary file instead of dumping it', async () => {
    const html = await (await get(`/files${workspace}/blob.bin`)).text()
    expect(html).toContain('not shown inline')
  })
})

describe('raw and download', () => {
  it('serves text as text/plain under a sandbox policy', async () => {
    const response = await get(`/files${workspace}/notes.txt?raw=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(await response.text()).toBe('plain notes')
  })

  it('never serves a workspace HTML file as HTML', async () => {
    const response = await get(`/files${workspace}/page.html?raw=1`)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves opaque bytes as an attachment', async () => {
    const response = await get(`/files${workspace}/blob.bin?raw=1`)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment')
  })

  it('offers a download under the file name', async () => {
    const response = await get(`/files${workspace}/notes.txt?download=1`)
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''notes.txt")
    expect(await response.text()).toBe('plain notes')
  })

  it('supports byte ranges on the raw route', async () => {
    const response = await get(`/files${workspace}/notes.txt?raw=1`, { range: 'bytes=0-4' })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('plain')
  })
})

describe('roots', () => {
  it('exposes nothing when workspaces are excluded and no roots are configured', async () => {
    const empty = await mount({ route: '/files', workspaces: false }, [workspace])
    const closed = createServer((req, res) => { void empty(req, res) })
    await new Promise<void>((resolve) => { closed.listen(0, '127.0.0.1', resolve) })
    const port = (closed.address() as AddressInfo).port
    const index = await fetch(`http://127.0.0.1:${String(port)}/files`)
    expect(await index.text()).toContain('nothing to browse')
    const denied = await fetch(`http://127.0.0.1:${String(port)}/files${workspace}/notes.txt`)
    expect(denied.status).toBe(403)
    await new Promise<void>((resolve) => { closed.close(() => { resolve() }) })
  })

  it('exposes a configured root that is not a workspace', async () => {
    const extra = await mount({ route: '/files', workspaces: false, roots: [outside] }, [])
    const served = createServer((req, res) => { void extra(req, res) })
    await new Promise<void>((resolve) => { served.listen(0, '127.0.0.1', resolve) })
    const port = (served.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${String(port)}/files${outside}/secret.txt?raw=1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('do not read')
    await new Promise<void>((resolve) => { served.close(() => { resolve() }) })
  })
})

describe('a profile with no HTTP server (issues #1 and #2)', () => {
  it('activates and registers no route, instead of holding the tree pending', async () => {
    // A web-only row in the home overlay used to make every headless profile
    // fail to boot: the entry stayed pending on `webServer` forever.
    await expect(mountMaybe({ route: '/files' }, [workspace], { webServer: false }))
      .resolves.toBeUndefined()
  })

  it('teaches no link format without an origin to name', async () => {
    const text = await promptFor({ route: '/files' }, { webServer: false })
    // A guessed loopback link points at a server that is not running.
    expect(text).toBe('')
  })

  it('teaches the configured public origin when given one', async () => {
    const text = await promptFor(
      { route: '/files', publicBaseUrl: 'https://dsh.example.com' }, { webServer: false })
    expect(text).toContain('https://dsh.example.com/files')
    expect(text).not.toContain('127.0.0.1')
  })

  it('refuses a malformed public origin at activation', async () => {
    await expect(mountMaybe({ publicBaseUrl: 'not-a-url' }, [workspace], { webServer: false }))
      .rejects.toThrow(/publicBaseUrl/)
  })
})

describe('a per-session example rooted at the session cwd (issue #4)', () => {
  it('names the session working directory instead of a placeholder', async () => {
    const text = await promptFor({ route: '/files' }, { cwd: workspace }, [workspace])
    expect(text).toContain(`http://127.0.0.1:3080/files${workspace}/report.md`)
    expect(text).not.toContain('/path/to/report.md')
  })

  it('gives two sessions different examples', async () => {
    const other = join(base, 'second-project')
    await mkdir(other, { recursive: true })
    const first = await promptFor({ route: '/files' }, { cwd: workspace }, [workspace, other])
    const second = await promptFor({ route: '/files' }, { cwd: other }, [workspace, other])
    expect(first).toContain(`${workspace}/report.md`)
    expect(second).toContain(`${other}/report.md`)
    expect(first).not.toBe(second)
  })

  it('encodes spaces and non-ASCII segments', async () => {
    const odd = join(base, 'my project', '\u6587\u6863')
    const text = await promptFor({ route: '/files' }, { cwd: odd }, [base])
    // The sentence pairs the literal path with its URL, so both spellings
    // appear: the raw one inside backticks, the encoded one as the link.
    expect(text).toContain('`' + odd + '/report.md`')
    // Segment-wise encoding: the separators stay separators.
    expect(text).toContain('/files' + base + '/my%20project/%E6%96%87%E6%A1%A3/report.md')
    // No unencoded space survives into the link itself.
    const link = /is (http\S+)\./.exec(text)?.[1]
    expect(link).toBeDefined()
    expect(link).not.toMatch(/[ \u4e00-\u9fff]/)
  })

  it('falls back to the generic example when the assembly has no agent', async () => {
    // Diagnostic assemblies carry no agent, so there is no session to root at.
    const text = await promptFor({ route: '/files' }, {}, [workspace])
    expect(text).toContain('/path/to/report.md')
  })

  it('falls back when the session cwd is outside every root', async () => {
    // A concrete example under an unreadable directory would teach a link
    // that answers 403 — worse than a placeholder the model has to combine.
    const text = await promptFor({ route: '/files' }, { cwd: outside }, [workspace])
    expect(text).toContain('/path/to/report.md')
    expect(text).not.toContain(outside)
  })

  it('falls back when the cwd is relative rather than absolute', async () => {
    const text = await promptFor({ route: '/files' }, { cwd: 'relative/dir' }, [workspace])
    expect(text).toContain('/path/to/report.md')
  })

  it('roots the example at a configured root, not only a workspace', async () => {
    const text = await promptFor(
      { route: '/files', roots: [base], workspaces: false }, { cwd: workspace }, [])
    expect(text).toContain(`${workspace}/report.md`)
  })

  it('ignores a workspace the config told it not to serve', async () => {
    // `workspaces: false` means the registry is not a root, so a cwd inside
    // one is not reachable and must not become the example.
    const text = await promptFor({ route: '/files', workspaces: false }, { cwd: workspace }, [workspace])
    expect(text).toContain('/path/to/report.md')
  })

  it('uses the public origin for the concrete example, never the bind', async () => {
    const text = await promptFor(
      { route: '/files', publicBaseUrl: 'http://10.37.245.206:3081' }, { cwd: workspace }, [workspace])
    expect(text).toContain(`http://10.37.245.206:3081/files${workspace}/report.md`)
    expect(text).not.toContain('127.0.0.1')
  })

  it('does the same from the environment, with no webServer at all', async () => {
    process.env.DSH_PUBLIC_BASE_URL = 'https://dsh.example.com'
    try {
      const text = await promptFor(
        { route: '/files' }, { cwd: workspace, webServer: false }, [workspace])
      expect(text).toContain(`https://dsh.example.com/files${workspace}/report.md`)
      expect(text).not.toContain('127.0.0.1')
    } finally {
      delete process.env.DSH_PUBLIC_BASE_URL
    }
  })

  it('tells the model to rebuild links rather than quote old ones', async () => {
    // The behavioral half of issue #4: a resumed session's history can carry
    // concrete links minted before the deployment had a public origin.
    const text = await promptFor({ route: '/files' }, { cwd: workspace }, [workspace])
    expect(text).toContain('earlier in the history')
  })
})

describe('a public origin in front of the local bind (issue #3)', () => {
  it('outranks the bind for the links the model is taught', async () => {
    const text = await promptFor({ route: '/files', publicBaseUrl: 'http://10.37.245.206:3081' })
    expect(text).toContain('http://10.37.245.206:3081/files')
    expect(text).not.toContain('127.0.0.1:3080')
  })

  it('still uses the bind when nothing is configured', async () => {
    expect(await promptFor({ route: '/files' })).toContain('http://127.0.0.1:3080/files')
  })
})
