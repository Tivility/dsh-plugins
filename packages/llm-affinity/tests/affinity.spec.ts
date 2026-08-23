import { describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'

/** One captured outgoing request. */
interface Captured { url: string; headers: Headers; body: unknown }

/**
 * Stand-in for the parts of `Context` this plugin touches, plus a stream driver
 * that makes its request from inside the generator body — the position a real
 * adapter makes it from, and the one a scope entered at creation time misses.
 */
function harness(config: Config = {}) {
  const listeners: Array<(options: any, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>> = []
  const disposers: Array<() => void> = []
  const ctx = {
    on(event: string, listener: any) { if (event === 'llm/stream') listeners.push(listener); return () => {} },
    effect(install: () => () => void) { disposers.push(install()); return () => {} },
  } as any

  const original = globalThis.fetch
  const seen: Captured[] = []
  globalThis.fetch = (async (input: any, init: any) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers ?? {}), body: init?.body })
    return new Response('{}')
  }) as any

  apply(ctx, config)

  return {
    seen,
    /** Drive one wrapped stream whose body fetches, exactly like an adapter. */
    async run(options: any, url = 'https://gw.example/v1/chat/completions', body?: string) {
      const inner = (async function* () {
        await globalThis.fetch(url, { method: 'POST', ...body === undefined ? {} : { body } })
        yield 'chunk'
      })()
      const out: unknown[] = []
      for await (const c of listeners[0]!(options, () => inner)) out.push(c)
      return out
    },
    dispose() { for (const d of disposers) d(); globalThis.fetch = original },
  }
}

describe('llm-affinity', () => {
  it('puts the session id on a request the stream body makes', async () => {
    const h = harness()
    const out = await h.run({ sessionId: 'sess-abc', provider: 'p' })
    h.dispose()
    expect(out).toEqual(['chunk'])
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBe('sess-abc')
  })

  it('honours a configured header name', async () => {
    const h = harness({ header: 'X-Conversation' })
    await h.run({ sessionId: 'sess-abc', provider: 'p' })
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Conversation')).toBe('sess-abc')
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('separates an auxiliary request from its conversation', async () => {
    const h = harness()
    await h.run({ sessionId: 'sess-abc', provider: 'p', purpose: 'compaction' })
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBe('sess-abc:compaction')
  })

  it('shares one value when separateAuxiliary is off', async () => {
    const h = harness({ separateAuxiliary: false })
    await h.run({ sessionId: 'sess-abc', provider: 'p', purpose: 'compaction' })
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBe('sess-abc')
  })

  it('adds the body field when configured', async () => {
    const h = harness({ bodyField: 'prompt_cache_key' })
    await h.run({ sessionId: 'sess-abc', provider: 'p' }, 'https://gw.example/v1/x', '{"model":"m"}')
    h.dispose()
    expect(JSON.parse(String(h.seen[0]!.body))).toEqual({ model: 'm', prompt_cache_key: 'sess-abc' })
  })

  it('restricts to configured providers', async () => {
    const h = harness({ providers: ['only-this'] })
    await h.run({ sessionId: 'sess-abc', provider: 'other' })
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('restricts to configured origins', async () => {
    const h = harness({ origins: ['allowed.example'] })
    await h.run({ sessionId: 'sess-abc', provider: 'p' }, 'https://other.example/v1/x')
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('drops a session id that cannot be a header value', async () => {
    const h = harness()
    await h.run({ sessionId: 'bad\nvalue', provider: 'p' })
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('leaves a request made outside a stream untouched', async () => {
    const h = harness()
    await globalThis.fetch('https://gw.example/v1/models')
    h.dispose()
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('passes a request with no session id straight through', async () => {
    const h = harness()
    const out = await h.run({ provider: 'p' })
    h.dispose()
    expect(out).toEqual(['chunk'])
    expect(h.seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('propagates consumer teardown to the adapter', async () => {
    const h = harness()
    let returned = false
    const listeners: any[] = []
    const ctx = { on: (e: string, l: any) => { if (e === 'llm/stream') listeners.push(l); return () => {} },
                  effect: (i: () => () => void) => { i(); return () => {} } } as any
    apply(ctx, {})
    const inner = { [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: 'x' }),
      return: async () => { returned = true; return { done: true, value: undefined } },
    }) } as AsyncIterable<string>
    for await (const _ of listeners[0]({ sessionId: 's', provider: 'p' }, () => inner)) break
    h.dispose()
    expect(returned).toBe(true)
  })

  it('restores the previous fetch on disposal', () => {
    const before = globalThis.fetch
    const h = harness()
    expect(globalThis.fetch).not.toBe(before)
    h.dispose()
    expect(globalThis.fetch).toBe(before)
  })
})
