/**
 * Behaviour of the `globalMemory` patch through the real engine host.
 *
 * The PTC runtime is faked — it calls the host's `workflowHost` bindings the
 * way the guest does — but the host is upstream's own `host.ts`, so a child
 * request is built by the code that ships. The subagent service enforces
 * `SubagentRuntime.assertCapabilities`: a request carrying `agentOptions` is
 * refused by a provider without that capability. An earlier version of this
 * fork sent `agentOptions` on every child, and a fake that skipped this rule is
 * how that went unnoticed.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PtcWorkflowEngine from '../src/engine.js'
import { apply as applyWorkflowTool } from '../src/index.js'
import { WORKFLOW_GUEST_SOURCE } from '../src/ptc/guest-source.js'

/** What one agent() call passes to the host, as the guest would. */
type ChildArgs = Record<string, unknown>

function createEngine(options: { agentOptionsCapable?: boolean } = {}) {
  const requests: Record<string, unknown>[] = []
  const capable = options.agentOptionsCapable ?? true
  const ctx = new Context() as Context & Record<string, unknown>
  for (const name of ['subagents', 'ptcRuntime', 'sandboxPolicy']) ctx.provide(name)

  ctx.subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: capable } }),
    start: (_provider: string, request: Record<string, unknown>) => {
      // SubagentRuntime.assertCapabilities, for the capability under test.
      if (request.agentOptions !== undefined && !capable) {
        return Promise.reject(new Error('subagent provider "spawn" does not support the "agentOptions" capability'))
      }
      requests.push(request)
      return Promise.resolve({
        id: `child-${String(requests.length)}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
        dispose: () => Promise.resolve(),
      })
    },
  }

  let childArgs: ChildArgs = {}
  ctx.ptcRuntime = {
    language: 'typescript',
    resolve: (spec: unknown) => spec,
    async run(spec: { bindings: { global: string; functions: Record<string, (value?: unknown) => Promise<unknown>> }[] }) {
      const host = spec.bindings.find(binding => binding.global === 'workflowHost')!.functions
      await host.begin!()
      const child = await host.startChild!({ prompt: 'probe', ...childArgs }) as { callId: number }
      await host.childResult!({ callId: child.callId })
      await host.disposeChild!({ callId: child.callId })
      return { value: { value: null, stopReason: 'completed', agentsStarted: 1 } }
    },
  }
  ctx.sandboxPolicy = { resolve: () => ({ workspaceRoot: '/tmp' }) }

  // Through the schema, as the loader would: it is what fills the limits.
  const config = (PtcWorkflowEngine as unknown as { Config(value: unknown): unknown }).Config({ provider: 'spawn' })
  const engine = new PtcWorkflowEngine(ctx as never, config as never)
  const runOnce = async (args: ChildArgs) => {
    childArgs = args
    const run = engine.start({
      meta: { name: 'probe-workflow', description: 'probe' },
      script: 'return null',
      parent: { id: 'parent', session: { id: 's', header: {} } } as never,
    } as never)
    const result = await run.result
    await run.dispose()
    return { result, request: requests.at(-1) }
  }
  return { runOnce }
}

describe('what an agent() child sends', () => {
  it('sets agentOptions.globalMemory when the call asks for it', async () => {
    const { request } = await createEngine().runOnce({ globalMemory: true })
    expect(request?.agentOptions).toEqual({ globalMemory: true })
  })

  it('sends no agentOptions for an ordinary child, exactly as upstream does', async () => {
    const { request } = await createEngine().runOnce({})
    expect(request).not.toHaveProperty('agentOptions')
  })

  it('treats globalMemory: false as not asking', async () => {
    const { request } = await createEngine().runOnce({ globalMemory: false })
    expect(request).not.toHaveProperty('agentOptions')
  })

  it('keeps provider and model alongside globalMemory', async () => {
    const { request } = await createEngine().runOnce({ provider: 'p', model: 'm', globalMemory: true })
    expect(request?.agentOptions).toEqual({ provider: 'p', model: 'm', globalMemory: true })
  })

  it('still runs an ordinary child through a provider without agentOptions', async () => {
    const { result } = await createEngine({ agentOptionsCapable: false }).runOnce({})
    expect(result.stopReason).toBe('completed')
  })
})

describe('the guest the engine ships', () => {
  it('accepts globalMemory as an agent() option and checks it is a boolean', () => {
    expect(WORKFLOW_GUEST_SOURCE).toContain('\t"model",\n\t"globalMemory"\n]);')
    expect(WORKFLOW_GUEST_SOURCE).toContain('agent() option \\"globalMemory\\" must be a boolean')
    expect(WORKFLOW_GUEST_SOURCE).toContain('...opts.globalMemory !== void 0 ? { globalMemory: opts.globalMemory } : {}')
  })

  it('names globalMemory where it lists the supported options', () => {
    expect(WORKFLOW_GUEST_SOURCE.match(/supported: label, phase, schema, provider, model, globalMemory\)/g)).toHaveLength(2)
  })
})

describe('the tool description', () => {
  it('documents globalMemory alongside the other agent() options', () => {
    let description = ''
    const ctx = {
      tools: { register: (tool: { description: string }) => { description = tool.description; return () => {} } },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
      on: () => () => {},
      get: () => undefined,
      effect(run: () => unknown) { run(); return () => {} },
    }
    applyWorkflowTool(ctx as never, {} as never)
    expect(description).toContain('`globalMemory: true`')
  })
})
