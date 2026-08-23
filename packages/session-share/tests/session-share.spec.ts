import { createServer, request } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apply, SESSION_PARAM, shareQuery } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { apply as applyClient } from '../src/client/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/* ------------------------------------------------------------- node half */

let server: Server
let port: number
let promptText: (agent: unknown) => string

/** Stand in for the parts of `Context` the node half touches. */
function mount(config: Config): { handler: Handler | undefined, prompt: (agent: unknown) => string } {
  let handler: Handler | undefined
  let section: { text(context: unknown): string } | undefined
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
    get: (nameString: string) => nameString === 'webServer' ? webServer : undefined,
    effect(run: () => unknown) {
      run()
      return () => {}
    },
    inject(_names: string[], run: (scope: unknown) => void) {
      run(ctx)
      return {}
    },
    systemPrompt: {
      section(spec: { text(context: unknown): string }) {
        section = spec
        return () => {}
      },
    },
  }
  apply(ctx as never, config)
  return { handler, prompt: agent => section?.text({ agent }) ?? '' }
}

/** Issue a redirect request without following it. */
async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number, location?: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${String(port)}`, ...headers } },
      (response) => {
        response.resume()
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, location: response.headers.location })
        })
      },
    )
    call.on('error', reject)
    call.end()
  })
}

beforeAll(async () => {
  const mounted = mount({ route: '/s' })
  promptText = mounted.prompt
  const handler = mounted.handler
  if (handler === undefined) throw new Error('no route registered')
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

describe('the short link', () => {
  it('redirects to the query form the browser half reads', async () => {
    const response = await get('/s/abc-123')
    expect(response.status).toBe(302)
    expect(response.location).toBe(`/?${SESSION_PARAM}=abc-123`)
  })

  it('refuses an id that could inject a header', async () => {
    // The value lands in Location, so it is validated rather than escaped.
    expect((await get('/s/a%0d%0aX-Evil:%201')).status).toBe(400)
    expect((await get('/s/../../etc/passwd')).status).toBe(400)
    expect((await get('/s/')).status).toBe(400)
  })

  it('refuses a rebound Host', async () => {
    expect((await get('/s/abc-123', { host: 'attacker.test' })).status).toBe(403)
  })
})

describe('the prompt section', () => {
  it('gives the model the link for the session it is serving', () => {
    const text = promptText({ session: { id: 'sess-42' } })
    expect(text).toContain(`http://127.0.0.1:3080/?${SESSION_PARAM}=sess-42`)
    expect(text).toContain('http://127.0.0.1:3080/s/sess-42')
  })

  it('says plainly that a link grants nothing', () => {
    expect(promptText({ session: { id: 'sess-42' } })).toContain('not who may read it')
  })

  it('renders nothing without an agent, rather than a broken link', () => {
    expect(promptText(undefined)).toBe('')
  })
})

describe('shareQuery', () => {
  it('encodes an id that would otherwise break the query', () => {
    expect(shareQuery('a b&c')).toBe(`?${SESSION_PARAM}=a%20b%26c`)
  })
})

/* ----------------------------------------------------------- browser half */

/** The session-list snapshot the client half reads. */
interface Snapshot { byId: Record<string, unknown>, phase: 'pending' | 'ready' }

/** Install the two browser globals the client half touches. */
function browser(href: string): { href(): string } {
  let current = href
  const listeners: (() => void)[] = []
  void listeners
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = {
    location: { get href() { return current } },
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, next: string) { current = next },
    },
  }
  return { href: () => current }
}

/** Drive the client half against a controllable session list. */
function clientBench(href: string, initial: Snapshot) {
  const page = browser(href)
  let snapshot = initial
  const listeners = new Set<() => void>()
  const opened: string[] = []
  const warnings: string[] = []
  const registrations: { spec: Record<string, unknown>, component: unknown }[] = []
  const locales: { ns: string, dicts: Record<string, unknown> }[] = []
  const ctx = {
    slots: {
      register(spec: Record<string, unknown>, component: unknown) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    locale: {
      register(ns: string, dicts: Record<string, unknown>) {
        locales.push({ ns, dicts })
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      open(id: string) {
        if (snapshot.byId[id] === undefined) throw new Error(`sessions.open: unknown session ${id}`)
        opened.push(id)
      },
    },
    effect(run: () => () => void) {
      const dispose = run()
      return () => { dispose() }
    },
    logger: { warn: (message: string) => warnings.push(message) },
  }
  return {
    run: () => { applyClient(ctx as never) },
    publish(next: Snapshot) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    opened,
    warnings,
    href: page.href,
    subscribers: () => listeners.size,
    registrations,
    locales,
  }
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window
})

describe('the browser half', () => {
  it('does nothing at all without the parameter', () => {
    const bench = clientBench('http://127.0.0.1:3080/', { byId: { a: {} }, phase: 'ready' })
    bench.run()
    expect(bench.opened).toEqual([])
    expect(bench.subscribers()).toBe(0)
  })

  it('opens a session that is already listed', () => {
    const bench = clientBench(`http://127.0.0.1:3080/?${SESSION_PARAM}=a`, { byId: { a: {} }, phase: 'ready' })
    bench.run()
    expect(bench.opened).toEqual(['a'])
  })

  it('waits for a list that has not arrived yet', () => {
    const bench = clientBench(`http://127.0.0.1:3080/?${SESSION_PARAM}=a`, { byId: {}, phase: 'pending' })
    bench.run()
    expect(bench.opened).toEqual([])
    expect(bench.warnings).toEqual([])
    bench.publish({ byId: { a: {} }, phase: 'ready' })
    expect(bench.opened).toEqual(['a'])
  })

  it('gives up once the list is ready without the session', () => {
    const bench = clientBench(`http://127.0.0.1:3080/?${SESSION_PARAM}=ghost`, { byId: {}, phase: 'pending' })
    bench.run()
    bench.publish({ byId: { other: {} }, phase: 'ready' })
    expect(bench.opened).toEqual([])
    expect(bench.warnings[0]).toContain('ghost')
  })

  it('opens the session only once, however many updates arrive', () => {
    const bench = clientBench(`http://127.0.0.1:3080/?${SESSION_PARAM}=a`, { byId: {}, phase: 'pending' })
    bench.run()
    bench.publish({ byId: { a: {} }, phase: 'ready' })
    bench.publish({ byId: { a: {}, b: {} }, phase: 'ready' })
    expect(bench.opened).toEqual(['a'])
  })

  it('consumes the parameter, so a later reload does not jump back', () => {
    const bench = clientBench(`http://127.0.0.1:3080/?${SESSION_PARAM}=a&keep=1`, { byId: { a: {} }, phase: 'ready' })
    bench.run()
    expect(bench.href()).toBe('/?keep=1')
  })

  it('consumes the parameter even when the session was not found', () => {
    const bench = clientBench(`http://127.0.0.1:3080/?${SESSION_PARAM}=ghost`, { byId: {}, phase: 'ready' })
    bench.run()
    expect(bench.href()).toBe('/')
  })
})

describe('the header control', () => {
  it('registers into the session header utility band', () => {
    const bench = clientBench('http://127.0.0.1:3080/', { byId: {}, phase: 'ready' })
    bench.run()
    const seat = bench.registrations.find(r => r.spec.name === 'conversation.session.header.utilities')
    // Without this the feature is unreachable by a person: the link format
    // only ever reaches the model, through the system prompt.
    expect(seat).toBeDefined()
    expect(seat?.spec.id).toBe('session-share')
    expect(seat?.spec.locale).toBe('session.share')
    expect(typeof seat?.component).toBe('function')
  })

  it('registers the control even on an ordinary visit with no parameter', () => {
    const bench = clientBench('http://127.0.0.1:3080/', { byId: {}, phase: 'ready' })
    bench.run()
    expect(bench.registrations).toHaveLength(1)
    expect(bench.subscribers()).toBe(0)
  })

  it('ships both locales, with matching keys', () => {
    const bench = clientBench('http://127.0.0.1:3080/', { byId: {}, phase: 'ready' })
    bench.run()
    const bundle = bench.locales.find(l => l.ns === 'session.share')
    expect(bundle).toBeDefined()
    const en = bundle?.dicts.en as Record<string, string>
    const zh = bundle?.dicts.zh as Record<string, string>
    expect(Object.keys(en).sort()).toEqual(['copied', 'copy', 'hint'])
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) expect(value).not.toBe('')
  })
})

/* --------------------------------------------------------- bundle contract */

describe('the built browser bundle', () => {
  const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url))
  let source: string
  try {
    source = readFileSync(bundle, 'utf8')
  } catch {
    source = ''
  }

  it.skipIf(source === '')('hands the loader a factory under this package name', () => {
    // The loader fetches this file outside any module graph; a bundle that
    // exports instead of calling __ModuleLoader__.load is silently inert.
    expect(source.startsWith('window.__ModuleLoader__.load({ id: "@tivility/dsh-session-share"')).toBe(true)
    expect(source).toContain('var module = { exports: {} }')
    expect(source).toContain('return module.exports; } });')
  })

  it.skipIf(source === '')('leaves the module-table packages external', () => {
    // A require() the loader's table cannot answer throws at boot, and an
    // inlined one ships a second copy of React or the whole primitives
    // package into a plugin bundle.
    const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1])
    expect(required).toEqual(expect.arrayContaining(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']))
    expect(source).not.toContain('katex')
  })

  it.skipIf(source === '')('leaves no import the injected require cannot answer', () => {
    // Anything not in the loader's module table has to be inlined: a require()
    // the table cannot answer throws at boot.
    expect(/^\s*import[ {]/m.test(source)).toBe(false)
    expect(source).toContain('exports.apply')
  })
})
