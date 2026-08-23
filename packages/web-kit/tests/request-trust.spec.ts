import { describe, expect, it } from 'vitest'
import { assertTrustedAuthority, isLoopbackHostname, isSameOrigin, isTrustedRequest } from '../src/request-trust.ts'

/** Build the header-only request shape the fence reads. */
function req(headers: Record<string, string>) {
  return { headers }
}

describe('isLoopbackHostname', () => {
  it('accepts every spelling of the local authority', () => {
    for (const host of ['localhost', '[::1]', '127.0.0.1', '127.1.2.3', '127.255.255.255']) {
      expect(isLoopbackHostname(host), host).toBe(true)
    }
  })

  it('rejects addresses outside 127/8 and octet-overflowing lookalikes', () => {
    for (const host of ['128.0.0.1', '10.0.0.1', 'evil.test', '127.0.0.256', '0x7f.0.0.1', '127.0.0']) {
      expect(isLoopbackHostname(host), host).toBe(false)
    }
  })
})

describe('isTrustedRequest — Host fence', () => {
  it('accepts a loopback Host on any port', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedRequest(req({ host: 'localhost' }))).toBe(true)
  })

  it('rejects a rebound Host even though the socket reached this server', () => {
    expect(isTrustedRequest(req({ host: 'attacker.test:3080' }))).toBe(false)
  })

  it('rejects a request with no Host at all', () => {
    expect(isTrustedRequest(req({}))).toBe(false)
  })

  it('accepts a configured authority, matching the port only when one was declared', () => {
    expect(isTrustedRequest(req({ host: '192.168.1.9:3080' }), ['192.168.1.9'])).toBe(true)
    expect(isTrustedRequest(req({ host: '192.168.1.9:9999' }), ['192.168.1.9'])).toBe(true)
    expect(isTrustedRequest(req({ host: '192.168.1.9:9999' }), ['192.168.1.9:3080'])).toBe(false)
    expect(isTrustedRequest(req({ host: '192.168.1.9:3080' }), ['192.168.1.9:3080'])).toBe(true)
  })

  it('compares authorities through WHATWG normalization', () => {
    expect(isTrustedRequest(req({ host: 'HARNESS.local:80' }), ['harness.local:80'])).toBe(true)
  })
})

describe('isTrustedRequest — browser markers', () => {
  it('refuses an explicit cross-site initiator regardless of Host', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  it('requires an attached Origin to be this exact authority', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }))).toBe(false)
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'https://evil.test' }))).toBe(false)
  })

  it('refuses the opaque origin of a sandboxed document', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080', origin: 'null' }))).toBe(false)
  })

  it('accepts an absent Origin, which the Host fence has already bound', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('reads Fetch Headers as well as the node:http bag', () => {
    const headers = new Headers({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })
    expect(isTrustedRequest({ headers })).toBe(true)
  })
})

describe('isSameOrigin', () => {
  it('judges the Origin relationship alone', () => {
    expect(isSameOrigin(req({ host: 'harness.test', origin: 'http://harness.test' }))).toBe(true)
    expect(isSameOrigin(req({ host: 'harness.test', origin: 'http://evil.test' }))).toBe(false)
    expect(isSameOrigin(req({ host: 'harness.test' }))).toBe(true)
    expect(isSameOrigin(req({ origin: 'http://harness.test' }))).toBe(false)
  })
})

describe('assertTrustedAuthority', () => {
  it('accepts bare canonical authorities', () => {
    for (const entry of ['harness.local', 'harness.local:3080', '192.168.1.9', '[::1]:3080']) {
      expect(() => { assertTrustedAuthority(entry) }, entry).not.toThrow()
    }
  })

  it('refuses anything parsing would silently rewrite', () => {
    for (const entry of [
      'http://harness.local',
      'harness.local/path',
      'user@harness.local',
      'harness.local:',
      'harness.local:0080',
      ' harness.local',
      '0x7f.0.0.1',
      '::1',
    ]) {
      expect(() => { assertTrustedAuthority(entry) }, entry).toThrow(/not a bare host/)
    }
  })
})
