import { afterEach, describe, expect, it } from 'vitest'
import {
  absoluteUrl, normalizePublicBaseUrl, PUBLIC_BASE_URL_ENV, resolveBaseUrl, resolvePublicBaseUrl,
} from '../src/base-url.ts'

/** Stand in for the services this resolver reads. */
function ctx(services: { webServer?: { host: string, port: number }, webRuntime?: unknown } = {}) {
  return { get: (name: string) => (services as Record<string, unknown>)[name] } as never
}

afterEach(() => { delete process.env[PUBLIC_BASE_URL_ENV] })

describe('normalizePublicBaseUrl', () => {
  it('keeps an origin and drops a default port', () => {
    expect(normalizePublicBaseUrl('https://dsh.example.com')).toBe('https://dsh.example.com')
    expect(normalizePublicBaseUrl('https://dsh.example.com:443')).toBe('https://dsh.example.com')
    expect(normalizePublicBaseUrl('http://10.37.245.206:3081')).toBe('http://10.37.245.206:3081')
  })

  it('normalizes case, whitespace, and a trailing slash', () => {
    expect(normalizePublicBaseUrl('  HTTPS://DSH.Example.COM/  ')).toBe('https://dsh.example.com')
  })

  it('refuses anything that is not a bare absolute http(s) origin', () => {
    for (const [value, reason] of [
      ['dsh.example.com', /not an absolute URL/],
      ['ftp://dsh.example.com', /must use http/],
      ['ws://dsh.example.com', /must use http/],
      ['https://user:pw@dsh.example.com', /must not carry credentials/],
      ['https://dsh.example.com?a=1', /query or fragment/],
      ['https://dsh.example.com#x', /query or fragment/],
      // A prefix would be dropped from the middle of every link, because each
      // consumer appends its own absolute route.
      ['https://dsh.example.com/dsh', /without a path/],
    ] as const) {
      expect(() => normalizePublicBaseUrl(value), value).toThrow(reason)
    }
  })
})

describe('resolvePublicBaseUrl — precedence', () => {
  it('prefers the configured origin over the local bind', () => {
    const c = ctx({ webServer: { host: '127.0.0.1', port: 3080 } })
    expect(resolvePublicBaseUrl(c, 'https://dsh.example.com')).toBe('https://dsh.example.com')
  })

  it('falls back to the process override', () => {
    process.env[PUBLIC_BASE_URL_ENV] = 'http://10.37.245.206:3081'
    const c = ctx({ webServer: { host: '127.0.0.1', port: 3080 } })
    expect(resolvePublicBaseUrl(c)).toBe('http://10.37.245.206:3081')
  })

  it('lets plugin configuration outrank the process override', () => {
    process.env[PUBLIC_BASE_URL_ENV] = 'http://from-env.test'
    expect(resolvePublicBaseUrl(ctx(), 'https://from-config.test')).toBe('https://from-config.test')
  })

  it('ignores an empty configured value rather than treating it as a choice', () => {
    const c = ctx({ webServer: { host: '127.0.0.1', port: 3080 } })
    expect(resolvePublicBaseUrl(c, '')).toBe('http://127.0.0.1:3080')
  })
})

describe('resolvePublicBaseUrl — the local bind', () => {
  it('uses the loopback literal for a loopback bind', () => {
    expect(resolvePublicBaseUrl(ctx({ webServer: { host: '127.0.0.1', port: 3080 } })))
      .toBe('http://127.0.0.1:3080')
  })

  it('uses the sampled LAN address when bound to all interfaces', () => {
    const c = ctx({ webServer: { host: '0.0.0.0', port: 8080 }, webRuntime: { lanAddresses: ['192.168.1.9'] } })
    expect(resolvePublicBaseUrl(c)).toBe('http://192.168.1.9:8080')
  })

  it('still answers when all-interfaces sampled no LAN address', () => {
    expect(resolvePublicBaseUrl(ctx({ webServer: { host: '0.0.0.0', port: 8080 } })))
      .toBe('http://127.0.0.1:8080')
  })

  it('has no answer without a webServer, rather than guessing loopback', () => {
    // A headless profile serves nothing; a loopback link there points at a
    // server that is not running, which is worse than no link.
    expect(resolvePublicBaseUrl(ctx())).toBeUndefined()
  })
})

describe('resolveBaseUrl and absoluteUrl', () => {
  it('build a link onto the resolved origin', () => {
    const c = ctx({ webServer: { host: '127.0.0.1', port: 3080 } })
    expect(resolveBaseUrl(c)).toBe('http://127.0.0.1:3080')
    expect(absoluteUrl(c, '/files/a b')).toBe('http://127.0.0.1:3080/files/a b')
    expect(absoluteUrl(c, '/files', 'https://dsh.example.com')).toBe('https://dsh.example.com/files')
  })

  it('fails with a message naming the fix when nothing can answer', () => {
    expect(() => resolveBaseUrl(ctx())).toThrow(/set publicBaseUrl/)
    expect(() => resolveBaseUrl(ctx())).toThrow(new RegExp(PUBLIC_BASE_URL_ENV))
  })
})
