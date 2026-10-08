/**
 * Behaviour of the `global_memory` patch, against a subagent service that
 * enforces the two harness rules the patch has to live with.
 *
 * The fake reproduces `SubagentRuntime.assertCapabilities` — a request carrying
 * `agentOptions` is refused by a provider without that capability — and
 * `resolveMaxDepth`, which falls back to the deployment-wide depth when the tool
 * configures none. A fake that skipped either would pass the very regressions
 * these tests exist to catch: an earlier version of this fork sent
 * `agentOptions` on every call and hard-coded a depth of 3, and its suite only
 * ever built a provider that supported both.
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

interface Tool {
  name: string
  parameters: { properties: Record<string, { type?: string; description?: string }> }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

interface Capabilities {
  agentOptions: boolean
  depthLimit: boolean
}

/** The deployment-wide depth `resolveMaxDepth` falls back to. */
const DEPLOYMENT_MAX_DEPTH = 1

function createBench(options: {
  capabilities?: Partial<Capabilities>
  config?: Record<string, unknown>
} = {}) {
  const requests: Record<string, unknown>[] = []
  let tool: Tool | undefined

  const provider = {
    name: 'spawn',
    capabilities: {
      agentOptions: true,
      depthLimit: true,
      outputSchema: false,
      toolFilter: false,
      persona: false,
      ...options.capabilities,
    },
    inheritsParentContext: false,
  }

  /** `SubagentRuntime.assertCapabilities`, rule for rule. */
  const assertCapabilities = (request: Record<string, unknown>): void => {
    const needs: [boolean, keyof typeof provider.capabilities][] = [
      [request.agentOptions !== undefined, 'agentOptions'],
      [request.maxDepth !== undefined, 'depthLimit'],
    ]
    for (const [when, cap] of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new Error(`subagent provider "${provider.name}" does not support the "${cap}" capability`)
      }
    }
  }

  const ctx = {
    tools: {
      register(definition: Tool) {
        tool = definition
        return () => { tool = undefined }
      },
      get: () => tool,
    },
    subagents: {
      getProvider: (name: string) => (name === 'spawn' ? provider : undefined),
      /** `SubagentRuntime.resolveMaxDepth`. */
      resolveMaxDepth(configured?: number | 'provider-managed') {
        if (configured === 'provider-managed') return undefined
        return configured ?? DEPLOYMENT_MAX_DEPTH
      },
      start(_provider: string, request: Record<string, unknown>) {
        assertCapabilities(request)
        requests.push(request)
        return Promise.resolve({
          id: 'run-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
          dispose: () => {},
        })
      },
    },
    systemPrompt: { section: () => () => {} },
    sessionProjections: { register: () => {}, stateOf: () => null },
    get: () => undefined,
    on: () => () => {},
    effect(run: () => unknown) { run(); return () => {} },
    inject(_names: string[], run: (inner: unknown) => void) { run(ctx); return {} },
    logger: { info: () => {}, warn: () => {} },
  }

  apply(ctx as never, { provider: 'spawn', enableRunInBackground: false, ...options.config } as never)
  if (tool === undefined) throw new Error('no tool registered')
  const registered: Tool = tool

  const call = async (args: Record<string, unknown>) => {
    await registered.execute(
      { description: 'probe', prompt: 'do the thing', ...args },
      {
        signal: new AbortController().signal,
        agent: { id: 'parent', options: {}, session: { id: 's', requestHeader: () => undefined } },
      },
    )
    return requests.at(-1)!
  }
  return { tool: registered, call, requests }
}

describe('the global_memory parameter', () => {
  it('is offered when the provider can carry agentOptions', () => {
    expect(createBench().tool.parameters.properties.global_memory?.type).toBe('boolean')
  })

  it('is absent where the provider cannot honor it', () => {
    // Offering it there would make the parameter a way to fail every call.
    expect(createBench({ capabilities: { agentOptions: false } }).tool.parameters.properties.global_memory).toBeUndefined()
  })
})

describe('what a delegation sends', () => {
  it('sets agentOptions.globalMemory when the call asks for it', async () => {
    const request = await createBench().call({ global_memory: true })
    expect(request.agentOptions).toEqual({ globalMemory: true })
  })

  it('sends no agentOptions at all for an ordinary call, exactly as upstream does', async () => {
    const request = await createBench().call({})
    expect(request).not.toHaveProperty('agentOptions')
  })

  it('treats global_memory: false as not asking', async () => {
    expect(await createBench().call({ global_memory: false })).not.toHaveProperty('agentOptions')
  })

  it('still delegates through a provider without the agentOptions capability', async () => {
    // The ACP provider declares agentOptions: false. Sending an empty or
    // false-valued agentOptions there is refused before the child starts.
    const bench = createBench({ capabilities: { agentOptions: false }, config: { maxDepth: 'provider-managed' } })
    await expect(bench.call({})).resolves.toBeDefined()
  })
})

describe('recursion depth', () => {
  it('takes the deployment-wide depth when the tool configures none', async () => {
    // A hard-coded default here would quietly override the operator's limit.
    expect((await createBench().call({})).maxDepth).toBe(DEPLOYMENT_MAX_DEPTH)
  })

  it('uses the tool\'s own depth when it configures one', async () => {
    expect((await createBench({ config: { maxDepth: 4 } }).call({})).maxDepth).toBe(4)
  })

  it('leaves depth to the provider when configured provider-managed', async () => {
    const request = await createBench({ config: { maxDepth: 'provider-managed' } }).call({})
    expect(request).not.toHaveProperty('maxDepth')
  })
})
