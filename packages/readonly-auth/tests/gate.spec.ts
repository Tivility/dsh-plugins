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

describe('disposal must actually ungate (issue #12)', () => {
  it('restores a route that existed before the gate', async () => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/early', handler: echo as never })
    const unmount = await mountLock({ apiPath: '/early' })
    expect((await post('/early/session.prompt')).status).toBe(403)
    await unmount()
    expect((await post('/early/session.prompt')).status).toBe(200)
    dispose()
  })

  it('restores a route registered while the gate was active', async () => {
    // The reported case: the handler is wrapped on the way in, and nothing
    // records how to put it back — so the closure over the disposed service
    // keeps answering.
    const unmount = await mountLock({ apiPath: '/late-restore' })
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/late-restore', handler: echo as never })
    expect((await post('/late-restore/session.prompt')).status).toBe(403)
    await unmount()
    expect((await post('/late-restore/session.prompt')).status).toBe(200)
    dispose()
  })

  it('restores the latest handler when a covered route is replaced', async () => {
    const unmount = await mountLock({ apiPath: '/replaced' })
    const first = ctx.webServer.register({ kind: 'prefix', path: '/replaced', handler: echo as never })
    first()
    const second = ctx.webServer.register({ kind: 'prefix', path: '/replaced', handler: echo as never })
    expect((await post('/replaced/session.prompt')).status).toBe(403)
    await unmount()
    expect((await post('/replaced/session.prompt')).status).toBe(200)
    second()
  })

  it('leaves nothing gated after two enable/disable cycles', async () => {
    // Each cycle registers its route while that cycle's gate is active, which
    // is the shape HMR actually produces: the transport reloads under a live
    // lock. A wrapper left behind by cycle one gates cycle two's traffic with
    // a disposed service.
    for (const cycle of [1, 2]) {
      const unmount = await mountLock({ apiPath: '/cycles' })
      const dispose = ctx.webServer.register({ kind: 'prefix', path: '/cycles', handler: echo as never })
      expect((await post('/cycles/session.prompt')).status, `cycle ${String(cycle)} gated`).toBe(403)
      await unmount()
      expect((await post('/cycles/session.prompt')).status, `cycle ${String(cycle)} ungated`).toBe(200)
      dispose()
    }
  })

  it('lets a second lock gate with its own token, not the disposed one', async () => {
    // The compound failure the report warns about: a surviving wrapper is
    // marked wrapped, so the next installation declines to wrap and never
    // installs hooks — the deployment stays locked to a token nobody
    // configured any more, and the token that is configured is refused.
    const first = await mountLock({ apiPath: '/second' })
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/second', handler: echo as never })
    await first()
    const second = await mountLock({ apiPath: '/second', token: 'a-different-token' })
    try {
      expect((await post('/second/session.prompt', 'dsh_owner=a-different-token')).status).toBe(200)
      expect((await post('/second/session.prompt', `dsh_owner=${encodeURIComponent(TOKEN)}`)).status).toBe(403)
    } finally {
      await second()
      dispose()
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

describe('the form the lock serves must be able to post to it (issue #11)', () => {
  let unmount: () => Promise<void>
  beforeAll(async () => { unmount = await mountLock() })
  afterAll(async () => { await unmount() })

  /** One page this route serves, with its referrer policy. */
  async function pageAt(path: string, init: RequestInit = {}): Promise<{ policy: string | null, status: number }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
    await response.text()
    return { policy: response.headers.get('referrer-policy'), status: response.status }
  }

  it('serves the unlock form under same-origin, not no-referrer', async () => {
    // Under `no-referrer`, Fetch serializes a navigation-mode POST's Origin as
    // the literal `null`, which this route's own fence then refuses.
    expect(await pageAt('/unlock')).toEqual({ policy: 'same-origin', status: 200 })
  })

  it('serves the retry form the same way', async () => {
    expect(await pageAt('/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=wrong',
    })).toEqual({ policy: 'same-origin', status: 401 })
  }, 20_000)

  it('serves the lock-again form the same way', async () => {
    expect(await pageAt('/unlock', { headers: { cookie: `dsh_owner=${encodeURIComponent(TOKEN)}` } }))
      .toEqual({ policy: 'same-origin', status: 200 })
  })

  it('accepts the submission a browser makes from that page', async () => {
    // What Chrome sends for a same-origin HTML form POST under `same-origin`:
    // the real origin, and `sec-fetch-site: same-origin`.
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: `http://127.0.0.1:${String(port)}`,
        'sec-fetch-site': 'same-origin',
      },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie') ?? '').toContain('HttpOnly')
  }, 20_000)

  it('still refuses an opaque origin', async () => {
    // The fix must not have widened the fence: `null` is what a cross-origin
    // form, a sandboxed frame, and a redirected POST all present.
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('leaves the file-serving default alone elsewhere', async () => {
    // web-kit's `no-referrer` is right for routes that serve workspace bytes;
    // this fix is scoped to the pages that carry a form.
    const response = await fetch(`http://127.0.0.1:${String(port)}/unlock`, { method: 'DELETE' })
    await response.text()
    expect(response.status).toBe(405)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })
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
