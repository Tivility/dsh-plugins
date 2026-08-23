import { describe, expect, it } from 'vitest'
import { DEFAULT_READ_METHODS, judge, readMethodSet } from '../src/policy.ts'
import { clearCookie, digest, matches, readCookie, serializeCookie } from '../src/token.ts'

const allowed = readMethodSet()

/** Judge one request against the default allowlist. */
function verdict(method: string, pathname: string) {
  return judge({ method, pathname, apiPath: '/api' }, allowed)
}

describe('judge — the GUI dot-form surface', () => {
  it('allows the reads a transcript view needs', () => {
    for (const endpoint of ['session.list', 'session.history', 'session.models', 'workspace.list']) {
      expect(verdict('POST', `/api/${endpoint}`).allow, endpoint).toBe(true)
    }
  })

  it('refuses everything that drives the agent', () => {
    for (const endpoint of [
      'session.prompt', 'session.create', 'session.cancel', 'session.fork',
      'subagent.prompt', 'subagent.interrupt',
      'workspace.create', 'workspace.delete',
      'goal.create', 'settings.update', 'settings.mutate',
      'credentials.set', 'credentials.describe',
      'host.openPath', 'host.createDirectory', 'host.listDirectory',
      'agentPreset.select', 'llm.discoverModels',
    ]) {
      expect(verdict('POST', `/api/${endpoint}`).allow, endpoint).toBe(false)
    }
  })

  it('refuses the prompt-answering channel, which is not an RPC method', () => {
    // /api/respond is how permission requests and user questions get answered;
    // a visitor able to post here could approve a tool call.
    expect(verdict('POST', '/api/respond').allow).toBe(false)
  })

  it('reports the refused endpoint so the message can name it', () => {
    const decision = verdict('POST', '/api/session.prompt')
    expect(decision).toEqual({ allow: false, method: 'session.prompt' })
  })
})

describe('judge — the Typert slash-form surface', () => {
  it('allows an allowlisted two-segment endpoint', () => {
    expect(verdict('POST', '/api/pluginInventory/list').allow).toBe(true)
    expect(verdict('POST', '/api/messageFeedback/list').allow).toBe(true)
  })

  it('refuses the ones that execute', () => {
    for (const endpoint of [
      'commands/execute',
      'dynamicCordisRunner/invoke',
      'dynamicCordisRunner/runHostHalf',
      'goals/create',
      'messageFeedback/put',
    ]) {
      expect(verdict('POST', `/api/${endpoint}`).allow, endpoint).toBe(false)
    }
  })
})

describe('judge — reads that are not POSTs', () => {
  it('allows the live event downlinks', () => {
    expect(verdict('GET', '/api/events.mux').allow).toBe(true)
    expect(verdict('GET', '/api/events.host').allow).toBe(true)
  })

  it('allows the transcript export, which returns what session.history already does', () => {
    expect(verdict('GET', '/api/session.export').allow).toBe(true)
    expect(verdict('HEAD', '/api/session.export').allow).toBe(true)
  })

  it('refuses an unlisted GET', () => {
    expect(verdict('GET', '/api/session.list').allow).toBe(false)
    expect(verdict('DELETE', '/api/session.list').allow).toBe(false)
  })

  it('refuses the bare API path, which names no method', () => {
    expect(verdict('POST', '/api').allow).toBe(false)
  })
})

describe('readMethodSet', () => {
  it('extends the built-in list without replacing it', () => {
    const extended = readMethodSet(['host.listDirectory'])
    expect(extended.has('host.listDirectory')).toBe(true)
    for (const endpoint of DEFAULT_READ_METHODS) expect(extended.has(endpoint), endpoint).toBe(true)
  })

  it('does not ship a write on the default list', () => {
    for (const endpoint of DEFAULT_READ_METHODS) {
      expect(endpoint, endpoint).not.toMatch(/\.(create|prompt|update|delete|set|remove|select|cancel|fork|rename)$/)
    }
  })
})

describe('token comparison', () => {
  it('accepts the configured token and nothing else', () => {
    const expected = digest('correct horse')
    expect(matches('correct horse', expected)).toBe(true)
    expect(matches('wrong horse', expected)).toBe(false)
  })

  it('compares tokens of different lengths without throwing', () => {
    // timingSafeEqual rejects length-mismatched buffers; hashing first is what
    // keeps a short guess from raising instead of returning false.
    const expected = digest('a-long-owner-token')
    expect(() => matches('x', expected)).not.toThrow()
    expect(matches('x', expected)).toBe(false)
  })
})

describe('cookies', () => {
  const options = { name: 'dsh_owner', maxAgeSeconds: 60, secure: false }

  it('carries the flags that make the grant unusable from elsewhere', () => {
    const cookie = serializeCookie('secret value', options)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=60')
    expect(cookie).not.toContain('Secure')
  })

  it('adds Secure when the deployment is served over TLS', () => {
    expect(serializeCookie('v', { ...options, secure: true })).toContain('Secure')
  })

  it('expires the grant when clearing', () => {
    expect(clearCookie(options)).toContain('Max-Age=0')
  })

  it('round-trips a value that needs escaping', () => {
    const cookie = serializeCookie('a b;c=d', options)
    const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
    expect(readCookie({ cookie: `dsh_owner=${value}` }, 'dsh_owner')).toBe('a b;c=d')
  })

  it('picks its cookie out of a crowded header', () => {
    const headers = { cookie: 'theme=dark; dsh_owner=token123; other=x' }
    expect(readCookie(headers, 'dsh_owner')).toBe('token123')
    expect(readCookie(headers, 'absent')).toBeUndefined()
    expect(readCookie({}, 'dsh_owner')).toBeUndefined()
  })
})
