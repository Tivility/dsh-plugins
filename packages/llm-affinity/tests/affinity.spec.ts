import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

/** Minimal stand-in for the parts of `Context` this plugin touches. */
function fakeCtx() {
  const listeners: Array<(options: any, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>> = []
  const disposers: Array<() => void> = []
  return {
    ctx: {
      on(event: string, listener: any) {
        if (event === 'llm/stream') listeners.push(listener)
        return () => {}
      },
      effect(install: () => () => void) {
        disposers.push(install())
        return () => {}
      },
    } as any,
    stream(options: any, chunks: unknown[]) {
      const inner = (async function* () { for (const c of chunks) yield c })()
      return listeners[0]!(options, () => inner)
    },
    dispose() { for (const d of disposers) d() },
  }
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of it) out.push(c)
  return out
}

function install(config?: Config) {
  const original = globalThis.fetch
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = []
  globalThis.fetch = (async (input: any, init: any) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers ?? {}),
      body: init?.body,
    })
    return new Response('{}')
  }) as any
  const harness = fakeCtx()
  apply(harness.ctx, config ?? {})
  return { harness, seen, restore: () => { harness.dispose(); globalThis.fetch = original } }
}

describe('llm-affinity', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('sends the session id while the stream is pulled', async () => {
    const { harness, seen, restore } = install()
    const chunks = await drain(harness.stream(
      { sessionId: 'sess-abc', provider: 'cpa-gemini' },
      [(await globalThis.fetch('https://gw.example/v1/chat/completions', { method: 'POST' }), 'a')],
    ))
    expect(chunks).toEqual(['a'])
    restore()
    expect(seen).toHaveLength(1)
  })

  it('adds the header to a request made from inside the stream', async () => {
    const { harness, seen, restore } = install()
    const inner = harness.stream({ sessionId: 'sess-abc', provider: 'p' }, [])
    const it = inner[Symbol.asyncIterator]()
    // The generator body — and any request it makes — runs on this pull.
    const pulled = it.next().then(async () => {
      await globalThis.fetch('https://gw.example/v1/messages', { method: 'POST', body: '{"model":"m"}' })
    })
    await pulled
    restore()
  })

  it('leaves requests outside a stream untouched', async () => {
    const { seen, restore } = install()
    await globalThis.fetch('https://gw.example/v1/models')
    restore()
    expect(seen[0]!.headers.get('X-Session-ID')).toBeNull()
  })

  it('passes through a request with no session id', async () => {
    const { harness, restore } = install()
    const out = await drain(harness.stream({ provider: 'p' }, ['x']))
    restore()
    expect(out).toEqual(['x'])
  })

  it('restores the previous fetch on disposal', () => {
    const before = globalThis.fetch
    const harness = fakeCtx()
    apply(harness.ctx, {})
    expect(globalThis.fetch).not.toBe(before)
    harness.dispose()
    expect(globalThis.fetch).toBe(before)
  })
})
