import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalize } from '@tivility/dsh-web-kit'
import { apply, type Config } from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** The optional lock, as this plugin sees it. */
interface FakeAuth {
  isOwner(request: { headers: Record<string, unknown> }): boolean
  unlockPath: string
}

/** A mounted plugin plus the origin it answers on. */
interface Mounted {
  origin: string
  close(): Promise<void>
}

/**
 * Stand in for the parts of `Context` this plugin touches.
 *
 * `auth` is read through a live getter rather than captured, so a test can
 * install the lock after the route is already mounted — which is the ordering
 * the plugin claims to survive.
 */
async function mount(
  config: Config,
  workspaces: readonly string[],
  auth: { current: FakeAuth | undefined },
): Promise<Mounted> {
  const settled: Promise<unknown>[] = []
  let handler: Handler | undefined
  const webServer = {
    host: '127.0.0.1',
    port: 3080,
    register(route: { handler: Handler }) {
      handler = route.handler
      return () => {}
    },
  }
  const ctx = {
    webServer,
    get(nameString: string) {
      if (nameString === 'webServer') return webServer
      if (nameString === 'ownerAuth') return auth.current
      if (nameString === 'workspaceRegistry') return { list: () => workspaces.map(path => ({ path })) }
      return undefined
    },
    effect(run: () => unknown) {
      settled.push(Promise.resolve(run()))
      return () => {}
    },
  }
  apply(ctx as never, config)
  await Promise.all(settled)
  if (handler === undefined) throw new Error('the plugin registered no route')
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

let base: string
let workspace: string
let outside: string
let open: Mounted
const auth: { current: FakeAuth | undefined } = { current: undefined }

/** PUT one body to a destination path. */
async function put(origin: string, path: string, body: string | Uint8Array, query = ''): Promise<Response> {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return fetch(`${origin}/upload${encoded}${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
}

beforeAll(async () => {
  base = await canonicalize(await mkdtemp(join(tmpdir(), 'file-upload-')))
  workspace = join(base, 'project')
  outside = join(base, 'private')
  await mkdir(join(workspace, 'inbox'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(workspace, 'escape-dir'))
  await writeFile(join(workspace, 'existing.txt'), 'original')
  open = await mount({ route: '/upload' }, [workspace], auth)
})

afterAll(async () => {
  await open.close()
  await rm(base, { recursive: true, force: true })
})

describe('writing a file', () => {
  it('accepts an upload into a workspace and reports where it landed', async () => {
    const response = await put(open.origin, `${workspace}/inbox/notes.txt`, 'hello')
    expect(response.status).toBe(200)
    const body = await response.json() as { path: string, bytes: number, url: string }
    expect(body.path).toBe(join(workspace, 'inbox', 'notes.txt'))
    expect(body.bytes).toBe(5)
    expect(body.url).toContain('/files')
    await expect(readFile(body.path, 'utf8')).resolves.toBe('hello')
  })

  it('leaves no partial file behind, and never publishes one', async () => {
    // The write goes to a sibling `.part` and is renamed; after a successful
    // upload the directory holds the file and nothing else.
    const names = readdirSync(join(workspace, 'inbox'))
    expect(names.filter(entry => entry.endsWith('.part'))).toEqual([])
  })

  it('refuses to overwrite unless asked', async () => {
    const refused = await put(open.origin, `${workspace}/existing.txt`, 'replacement')
    expect(refused.status).toBe(409)
    await expect(readFile(join(workspace, 'existing.txt'), 'utf8')).resolves.toBe('original')

    const allowed = await put(open.origin, `${workspace}/existing.txt`, 'replacement', '?overwrite=1')
    expect(allowed.status).toBe(200)
    await expect(readFile(join(workspace, 'existing.txt'), 'utf8')).resolves.toBe('replacement')
  })

  it('requires the destination directory to already exist', async () => {
    const response = await put(open.origin, `${workspace}/nope/deep/file.txt`, 'x')
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toContain('does not exist')
  })
})

describe('containment', () => {
  it('refuses a destination outside every root', async () => {
    const response = await put(open.origin, `${outside}/planted.txt`, 'x')
    expect(response.status).toBe(403)
    await expect(readFile(join(outside, 'planted.txt'), 'utf8')).rejects.toThrow()
  })

  it('refuses a destination behind a symlinked directory', async () => {
    const response = await put(open.origin, `${workspace}/escape-dir/planted.txt`, 'x')
    expect(response.status).toBe(403)
    await expect(readFile(join(outside, 'planted.txt'), 'utf8')).rejects.toThrow()
  })

  it('refuses a traversal out of the root', async () => {
    const response = await put(open.origin, `${workspace}/../private/planted.txt`, 'x')
    expect(response.status).toBe(403)
  })

  it('refuses a relative destination', async () => {
    const response = await fetch(`${open.origin}/upload/not-absolute.txt`, { method: 'PUT', body: 'x' })
    expect(response.status).toBe(403)
  })
})

describe('limits', () => {
  it('stops a body past the cap and leaves nothing on disk', async () => {
    const small = await mount({ route: '/upload', maxBytes: 8 }, [workspace], auth)
    try {
      const response = await put(small.origin, `${workspace}/inbox/big.bin`, new Uint8Array(64))
      expect(response.status).toBe(413)
      await expect(readFile(join(workspace, 'inbox', 'big.bin'))).rejects.toThrow()
      expect(readdirSync(join(workspace, 'inbox')).filter(entry => entry.includes('.part'))).toEqual([])
    } finally {
      await small.close()
    }
  })
})

describe('methods and pages', () => {
  it('serves the drop page', async () => {
    const html = await (await fetch(`${open.origin}/upload`)).text()
    expect(html).toContain('id="zone"')
    expect(html).toContain(workspace)
  })

  it('refuses anything but GET, HEAD, and PUT', async () => {
    const response = await fetch(`${open.origin}/upload`, { method: 'POST', body: 'x' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD, PUT')
  })
})

describe('the optional lock', () => {
  it('applies a lock that appears after the route was mounted', async () => {
    // The plugin resolves ownerAuth per request, so this ordering — the lock
    // loading later — must still gate. Reading it once at activation would
    // leave the write route open for the life of the process.
    expect((await put(open.origin, `${workspace}/inbox/before.txt`, 'x')).status).toBe(200)

    auth.current = { isOwner: request => request.headers.cookie === 'owner=yes', unlockPath: '/unlock' }
    try {
      const refused = await put(open.origin, `${workspace}/inbox/locked.txt`, 'x')
      expect(refused.status).toBe(403)
      expect((await refused.json() as { error: string }).error).toContain('/unlock')
      await expect(readFile(join(workspace, 'inbox', 'locked.txt'))).rejects.toThrow()

      const encoded = `${workspace}/inbox/locked.txt`.split('/').map(encodeURIComponent).join('/')
      const allowed = await fetch(`${open.origin}/upload${encoded}`, {
        method: 'PUT',
        headers: { cookie: 'owner=yes' },
        body: 'x',
      })
      expect(allowed.status).toBe(200)
    } finally {
      auth.current = undefined
    }
  })

  it('says on the page that the deployment is locked', async () => {
    auth.current = { isOwner: () => false, unlockPath: '/unlock' }
    try {
      const html = await (await fetch(`${open.origin}/upload`)).text()
      expect(html).toContain('owner grant')
    } finally {
      auth.current = undefined
    }
  })
})
