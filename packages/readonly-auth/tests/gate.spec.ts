/**
 * Coverage against the real `webServer` service rather than a double.
 *
 * The gate reaches into that service's private route tables, so a test with a
 * hand-written stand-in would only prove the stand-in matches the stand-in.
 * These boot the harness's own webserver package and assert over the HTTP
 * surface it actually serves.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import OwnerAuthService from '../src/index.ts'

const TOKEN = 'correct-horse-battery-staple'

let ctx: Context
let port: number
let disposeApi: (() => void) | undefined

/** Echo handler standing in for the harness's own `/api` owner. */
function echo(req: { url?: string, method?: string }, res: {
  writeHead(code: number, headers: Record<string, string>): void
  end(body?: string): void
}): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ reached: true, path: req.url, method: req.method }))
}

/** POST one API call, optionally as the owner. */
async function post(path: string, cookie?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie === undefined ? {} : { cookie } },
    body: '{}',
  })
}

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  port = ctx.webServer.port
  // Registered before the lock, which is the normal order: the harness's own
  // rows load ahead of the rows a profile patch inserts.
  disposeApi = ctx.webServer.register({ kind: 'prefix', path: '/api', handler: echo as never })
  ctx.webServer.register({ kind: 'exact', path: '/elsewhere', handler: echo as never })
})

afterAll(async () => {
  disposeApi?.()
  await ctx.fiber.dispose()
})

/**
 * Mount the lock and wait for it to be active.
 *
 * Each block owns its own lock and disposes it: a shared one torn down
 * between tests would leave later assertions running against an ungated
 * server, where "allowed" and "not gated at all" look identical.
 * @returns the disposer for this lock.
 */
async function mountLock(config: Record<string, unknown> = {}): Promise<() => Promise<void>> {
  const fiber = ctx.plugin(OwnerAuthService, { token: TOKEN, ...config })
  await fiber
  const handle = fiber as unknown as { dispose(): Promise<void> }
  return () => handle.dispose()
}

describe('gating a route registered before the lock', () => {
  let unmount: () => Promise<void>
  beforeAll(async () => { unmount = await mountLock() })
  afterAll(async () => { await unmount() })

  it('lets a visitor through to an allowlisted read', async () => {
    const response = await post('/api/session.list')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ reached: true })
  })

  it('refuses a write with a body the browser client can parse', async () => {
    const response = await post('/api/session.prompt')
    expect(response.status).toBe(403)
    const body = await response.json() as {
      type: string
      result: { ok: boolean, error: { code: string, message: string, details: object } }
    }
    expect(body.type).toBe('server-response')
    expect(body.result.ok).toBe(false)
    // The code has to be one the harness's own closed union carries, or the
    // client's parse fails and the message never reaches a human.
    expect(body.result.error.code).toBe('internal')
    expect(body.result.error.message).toContain('session.prompt')
    expect(body.result.error.message).toContain('/unlock')
    expect(body.result.error.details).toEqual({})
  })

  it('refuses the prompt-answering channel', async () => {
    expect((await post('/api/respond')).status).toBe(403)
  })

  it('leaves routes outside the API prefix alone', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/elsewhere`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ reached: true })
  })
})

describe('gating a route registered after the lock', () => {
  it('guards it on the way in', async () => {
    const unmount = await mountLock({ apiPath: '/late' })
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/late', handler: echo as never })
    try {
      expect((await post('/late/session.prompt')).status).toBe(403)
      expect((await post('/late/session.list')).status).toBe(200)
    } finally {
      dispose()
      await unmount()
    }
  })
})

describe('the owner grant', () => {
  let unmount: () => Promise<void>
  beforeAll(async () => { unmount = await mountLock() })
  afterAll(async () => { await unmount() })

  it('serves an unlock form to a visitor', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('<form method="post"')
    expect(html).toContain('name="token"')
  })

  it('refuses a wrong token, and makes the attempt cost time', async () => {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=nope',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    // The backoff is what makes guessing expensive; without it the lock is a
    // string comparison an attacker can run as fast as the network allows.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  }, 20_000)

  it('accepts the right token and hands back a locked-down cookie', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
  }, 20_000)

  it('lets the owner do everything a visitor cannot', async () => {
    const cookie = `dsh_owner=${encodeURIComponent(TOKEN)}`
    for (const endpoint of ['session.prompt', 'settings.update', 'respond', 'commands/execute']) {
      const response = await post(`/api/${endpoint}`, cookie)
      expect(response.status, endpoint).toBe(200)
    }
  })

  it('ignores a cookie carrying the wrong token', async () => {
    expect((await post('/api/session.prompt', 'dsh_owner=guess')).status).toBe(403)
  })

  it('accepts a JSON submission as well as a form', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
  }, 20_000)
})

describe('a fully locked deployment', () => {
  it('refuses even the reads', async () => {
    const unmount = await mountLock({ allowGuests: false })
    try {
      expect((await post('/api/session.list')).status).toBe(403)
      expect((await post('/api/session.list', `dsh_owner=${encodeURIComponent(TOKEN)}`)).status).toBe(200)
    } finally {
      await unmount()
    }
  })
})

describe('disposal', () => {
  it('puts the route back exactly as it found it', async () => {
    const unmount = await mountLock()
    expect((await post('/api/session.prompt')).status).toBe(403)
    await unmount()
    const response = await post('/api/session.prompt')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ reached: true })
  })
})

describe('configuration', () => {
  it('refuses to start without a token, rather than locking open or shut', async () => {
    const fiber = ctx.plugin(OwnerAuthService, {})
    await expect(fiber).rejects.toThrow(/no owner token configured/)
  })

  it('says so when tokenEnv names a variable this process does not have', async () => {
    const fiber = ctx.plugin(OwnerAuthService, { tokenEnv: 'DSH_READONLY_AUTH_ABSENT' })
    await expect(fiber).rejects.toThrow(/not set in this process/)
  })
})

describe('a profile with no HTTP server (issue #1)', () => {
  it('activates instead of holding the tree pending', async () => {
    // Softening the requirement is only safe because it cannot produce a
    // deployment that LOOKS locked and is not: with no webServer there is no
    // /api to reach and no route left open.
    const bare = new Context()
    const fiber = bare.plugin(OwnerAuthService, { token: TOKEN })
    await expect(fiber).resolves.toBeDefined()
    expect(bare.get('ownerAuth')).toBeDefined()
    await bare.fiber.dispose()
  })

  it('still refuses to start without a token, web server or not', async () => {
    const bare = new Context()
    await expect(bare.plugin(OwnerAuthService, {})).rejects.toThrow(/no owner token configured/)
    await bare.fiber.dispose()
  })

  it('still gates when a web server is present', async () => {
    // The fail-closed half: presence of a carrier means the gate installs, or
    // activation throws. It never installs silently doing nothing.
    const unmount = await mountLock()
    try {
      expect((await post('/api/session.prompt')).status).toBe(403)
    } finally {
      await unmount()
    }
  })
})
