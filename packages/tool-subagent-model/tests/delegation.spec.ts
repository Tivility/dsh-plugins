import { describe, expect, it } from 'vitest'
import { apply, childOptions, EFFORT_OPTION, installEffortBridge, validateArgs, wordingFor } from '../src/index.ts'

/** A registered tool, as the registry receives it. */
interface Tool {
  name: string
  description: string
  parameters: { properties: Record<string, { type: string, description?: string }>, required: string[] }
  output: { schema: object, render(args: unknown, value: never): { type: string, text: string }[] }
  isConcurrencySafe(args: unknown): boolean
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
}

/** What one delegation asked the subagent registry for. */
interface StartCall { provider: string, request: Record<string, unknown> }

/** An `agent/request` listener, as the effort bridge registers one. */
type RequestListener = (
  payload: { agent: { options: Record<string, unknown> } },
  next: () => Promise<Record<string, unknown>>,
) => Promise<Record<string, unknown>>

interface Bench {
  tool: Tool
  starts: StartCall[]
  continuables: StartCall[]
  jobs: { label: string }[]
  promptText(): string
  requestListeners: RequestListener[]
  result: { stopReason: string, output: unknown[], diagnostic?: string }
}

/** Build a bench with one provider already registered. */
function bench(options: {
  config?: Record<string, unknown>
  inheritsParentContext?: boolean
  depthLimit?: boolean
  continuableSupport?: boolean
} = {}): Bench {
  const starts: StartCall[] = []
  const continuables: StartCall[] = []
  const jobs: { label: string }[] = []
  const requestListeners: RequestListener[] = []
  let tool: Tool | undefined
  let section: { text(context: unknown): string } | undefined
  const state: Bench['result'] = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }

  const provider = {
    name: 'spawn',
    capabilities: { depthLimit: options.depthLimit ?? true },
    inheritsParentContext: options.inheritsParentContext ?? false,
    ...(options.continuableSupport ?? true) ? { prepareContinuable: () => {} } : {},
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
      getProvider: (nameString: string) => nameString === 'spawn' ? provider : undefined,
      start(providerName: string, request: Record<string, unknown>) {
        starts.push({ provider: providerName, request })
        return Promise.resolve({ id: 'run-1', result: Promise.resolve(state), dispose: () => {} })
      },
      startContinuable(request: { provider: string, request: Record<string, unknown> }) {
        continuables.push({ provider: request.provider, request: request.request })
        return Promise.resolve({ childId: 'child-1' })
      },
    },
    systemPrompt: {
      section(spec: { text(context: unknown): string }) {
        section = spec
        return () => {}
      },
    },
    get: (nameString: string) => nameString === 'jobs'
      ? { start(spec: { label: string }) { jobs.push(spec); return 'job-1' } }
      : undefined,
    on(event: string, listener: unknown) {
      if (event === 'agent/request') requestListeners.push(listener as RequestListener)
      return () => {}
    },
    effect(run: () => unknown) {
      run()
      return () => {}
    },
    logger: { info: () => {} },
  }

  apply(ctx as never, { provider: 'spawn', backgroundMode: 'continuable', ...options.config } as never)
  if (tool === undefined) throw new Error('no tool registered')
  return { tool, starts, continuables, jobs, promptText: () => section?.text({ scope: {} }) ?? '', requestListeners, result: state }
}

/** Execute the tool with a parent agent stand-in. */
async function call(tool: Tool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return tool.execute(args, { agent: { id: 'parent' }, signal: new AbortController().signal })
}

describe('registration', () => {
  it('registers under the configured tool name', () => {
    expect(bench({ config: { toolName: 'subagent_fork' } }).tool.name).toBe('subagent_fork')
  })

  it('exposes model, provider, and effort as optional parameters', () => {
    const { tool } = bench()
    expect(Object.keys(tool.parameters.properties)).toEqual(
      expect.arrayContaining(['model', 'provider', 'effort']),
    )
    expect(tool.parameters.required).toEqual(['description', 'prompt'])
  })

  it('refuses a numeric depth cap the provider cannot enforce', () => {
    expect(() => bench({ depthLimit: false, config: { maxDepth: 3 } })).toThrow(/cannot enforce maxDepth/)
    expect(() => bench({ depthLimit: false, config: { maxDepth: 'provider-managed' } })).not.toThrow()
  })

  it('refuses continuable mode on a provider without it', () => {
    expect(() => bench({ continuableSupport: false })).toThrow(/does not support backgroundMode: continuable/)
  })

  it('refuses a malformed depth cap', () => {
    expect(() => bench({ config: { maxDepth: -1 } })).toThrow(/maxDepth/)
    expect(() => bench({ config: { maxDepth: 1.5 } })).toThrow(/maxDepth/)
  })
})

describe('wordingFor', () => {
  it('tells the truth about what the child can see', () => {
    expect(wordingFor(false).description).toContain('does not see this conversation')
    expect(wordingFor(true).description).toContain('inherits this conversation')
  })

  it('mentions that the effort is selectable too', () => {
    expect(wordingFor(false).description).toContain('reasoning effort')
  })
})

describe('childOptions', () => {
  it('sends only what the call named', () => {
    expect(childOptions(undefined, { model: 'fast-1' })).toEqual({ model: 'fast-1' })
    expect(childOptions(undefined, { model: 'm', provider: 'other' })).toEqual({ model: 'm', provider: 'other' })
    expect(childOptions(undefined, {})).toBeUndefined()
  })

  it('carries an effort under the namespaced option', () => {
    expect(childOptions(undefined, { effort: 'high' })).toEqual({ [EFFORT_OPTION]: 'high' })
  })

  it('accepts an effort with no model, keeping the inherited route', () => {
    const options = childOptions(undefined, { effort: 'low' })
    expect(options).not.toHaveProperty('model')
    expect(options).not.toHaveProperty('provider')
  })

  it('lets a per-call value override the row default field by field', () => {
    const row = { provider: 'base', model: 'base-model', maxTokens: 4096 }
    expect(childOptions(row, { model: 'special' }))
      .toEqual({ provider: 'base', model: 'special', maxTokens: 4096 })
    expect(childOptions(row, {})).toEqual(row)
  })
})

describe('per-call selection reaches the delegation', () => {
  it('sends model, provider, and effort together', async () => {
    const b = bench()
    await call(b.tool, { description: 'd', prompt: 'p', model: 'deep-1', provider: 'other', effort: 'high', run_in_background: false })
    expect(b.starts[0]?.request.agentOptions).toEqual({
      model: 'deep-1',
      provider: 'other',
      [EFFORT_OPTION]: 'high',
    })
  })

  it('sends nothing when the call named nothing', async () => {
    const b = bench()
    await call(b.tool, { description: 'd', prompt: 'p', run_in_background: false })
    expect(b.starts[0]?.request).not.toHaveProperty('agentOptions')
  })

  it('carries the selection into a background run too', async () => {
    const b = bench()
    await call(b.tool, { description: 'd', prompt: 'p', model: 'deep-1', effort: 'high' })
    expect(b.continuables[0]?.request.agentOptions).toEqual({ model: 'deep-1', [EFFORT_OPTION]: 'high' })
  })
})

describe('the effort bridge', () => {
  /** Run the installed listener over one agent's options. */
  async function bridged(
    listener: RequestListener,
    options: Record<string, unknown>,
    seed: Record<string, unknown> = { provider: 'p', model: 'm' },
  ): Promise<Record<string, unknown>> {
    return listener({ agent: { options } }, () => Promise.resolve(seed))
  }

  it('is installed once by apply', () => {
    expect(bench().requestListeners).toHaveLength(1)
  })

  it('turns a carried effort into request configuration', async () => {
    const listener = bench().requestListeners[0]
    expect(listener).toBeDefined()
    // AgentOptions has no reasoningEffort field and the loop builds its first
    // request from named fields, so this waterfall is the only way in.
    await expect(bridged(listener as RequestListener, { [EFFORT_OPTION]: 'high' }))
      .resolves.toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('leaves a request alone when no effort was carried', async () => {
    const listener = bench().requestListeners[0] as RequestListener
    await expect(bridged(listener, {})).resolves.toEqual({ provider: 'p', model: 'm' })
    await expect(bridged(listener, { [EFFORT_OPTION]: '' })).resolves.toEqual({ provider: 'p', model: 'm' })
  })

  it('does not disturb an effort the request already resolved', async () => {
    const listener = bench().requestListeners[0] as RequestListener
    const seed = { provider: 'p', model: 'm', reasoningEffort: 'medium' }
    await expect(bridged(listener, {}, seed)).resolves.toEqual(seed)
  })

  it('can be installed on its own', () => {
    const listeners: RequestListener[] = []
    const ctx = { on: (_event: string, listener: RequestListener) => { listeners.push(listener); return () => {} } }
    installEffortBridge(ctx as never)
    expect(listeners).toHaveLength(1)
  })
})

describe('run modes', () => {
  it('defaults to a continuable background run and returns its durable id', async () => {
    const value = await call(bench().tool, { description: 'd', prompt: 'p' })
    expect(value).toEqual({ kind: 'continuable', subagentId: 'child-1' })
  })

  it('waits and returns the output when asked to', async () => {
    const b = bench()
    const value = await call(b.tool, { description: 'd', prompt: 'p', run_in_background: false })
    expect(value).toMatchObject({ kind: 'foreground', runId: 'run-1' })
    expect(b.tool.output.render({}, value as never)[0]?.text).toBe('done')
  })

  it('uses a background job when the row is one-shot', async () => {
    const b = bench({ config: { backgroundMode: 'one-shot' } })
    const value = await call(b.tool, { description: 'batch', prompt: 'p', run_in_background: true })
    expect(value).toEqual({ kind: 'background', jobId: 'job-1' })
    expect(b.jobs[0]?.label).toBe('batch')
  })

  it('refuses a forced background call when the instance disables it', async () => {
    const b = bench({ config: { enableRunInBackground: false, backgroundMode: 'one-shot' } })
    await expect(call(b.tool, { description: 'd', prompt: 'p', run_in_background: true }))
      .rejects.toThrow(/run_in_background is disabled/)
  })
})

describe('failure reporting', () => {
  it('reports a stop reason and keeps the partial answer', async () => {
    const b = bench()
    b.result.stopReason = 'max-tokens'
    b.result.output = [{ type: 'text', text: 'half an answer' }]
    b.result.diagnostic = 'ran out at 8k'
    await expect(call(b.tool, { description: 'd', prompt: 'p', run_in_background: false }))
      .rejects.toThrow(/hit its token limit[\s\S]*ran out at 8k[\s\S]*half an answer/)
  })

  it('treats an unknown terminal reason as a failure rather than success', async () => {
    const b = bench()
    b.result.stopReason = 'something-new'
    await expect(call(b.tool, { description: 'd', prompt: 'p', run_in_background: false }))
      .rejects.toThrow(/ended abnormally \(something-new\)/)
  })

  it('reports a cancelled run', async () => {
    const b = bench()
    b.result.stopReason = 'aborted'
    await expect(call(b.tool, { description: 'd', prompt: 'p', run_in_background: false }))
      .rejects.toThrow(/was cancelled/)
  })
})

describe('validateArgs', () => {
  it('requires a description and a prompt', () => {
    expect(validateArgs({ description: 'd' })).toContain('prompt is required and must be a string')
    expect(validateArgs({ description: 'd', prompt: '  ' })).toContain('prompt must not be empty')
  })

  it('type-checks the optional selectors', () => {
    expect(validateArgs({ description: 'd', prompt: 'p', effort: 7 })).toContain('effort must be a string')
    expect(validateArgs({ description: 'd', prompt: 'p', model: '' })).toContain('model must not be empty')
    expect(validateArgs({ description: 'd', prompt: 'p', run_in_background: 'yes' }))
      .toContain('run_in_background must be a boolean')
  })

  it('accepts a well-formed call', () => {
    expect(validateArgs({ description: 'd', prompt: 'p', model: 'm', effort: 'high' })).toEqual([])
  })

  it('rejects anything that is not an object', () => {
    expect(validateArgs(null)).toEqual(['arguments must be an object'])
    expect(validateArgs([])).toEqual(['arguments must be an object'])
  })
})

describe('execution guards', () => {
  it('rejects malformed arguments before starting anything', async () => {
    const b = bench()
    await expect(call(b.tool, { description: 'd' })).rejects.toThrow(/invalid arguments/)
    expect(b.starts).toEqual([])
    expect(b.continuables).toEqual([])
  })

  it('requires a calling agent', async () => {
    const { tool } = bench()
    await expect(tool.execute({ description: 'd', prompt: 'p' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/requires a calling agent/)
  })
})

describe('the prompt section', () => {
  it('steers toward background dispatch and per-call selection', () => {
    const text = bench().promptText()
    expect(text).toContain('in the background by default')
    expect(text).toContain('`effort`')
    expect(text).toContain('Your own route never changes')
  })

  it('says an effort applies to one delegation only', () => {
    expect(bench().promptText()).toContain('names its own')
  })

  it('appends the deployment routing guidance when configured', () => {
    const text = bench({ config: { routingGuide: 'FIXTURE ROUTING TABLE' } }).promptText()
    expect(text).toContain('FIXTURE ROUTING TABLE')
  })

  it('works without any routing guidance', () => {
    expect(bench().promptText()).toContain('in the background by default')
  })
})
