/**
 * Delegation with per-call model, provider, and reasoning-effort selection.
 *
 * A drop-in replacement for `@deepseek-ai/dsh-tool-subagent`. The main agent
 * keeps its own route; each delegation may name a different one. That is what
 * makes a mixed fleet possible from one conversation: deep reasoning to a
 * reasoning model at high effort, implementation to a coding model, a pile of
 * small mechanical subtasks to something cheap and fast.
 *
 * ## Runtime coupling
 *
 * Every harness import here is `import type`, which TypeScript erases — so the
 * built JavaScript imports nothing from the harness and reaches everything
 * through `ctx`. That matters because this plugin is driven from an agent
 * preset, and a preset is a snapshot nobody updates for you: a value import
 * would turn a harness upgrade into a broken agent found at runtime instead of
 * a diff to review. Types still bind to a pinned version, so the same upgrade
 * shows up where it belongs — as a compile error here.
 *
 * The one runtime dependency is `@deepseek-ai/schemastery`, the standalone
 * schema library the harness uses for plugin configuration. It is versioned
 * independently of the harness and carries none of its contracts.
 * @module @tivility/dsh-tool-subagent-model
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { EFFORT_OPTION, installEffortBridge } from './effort.js'

export { EFFORT_OPTION, installEffortBridge } from './effort.js'

/** Stable Cordis plugin name. */
export const name = 'tool-subagent-model'

/** Services this tool drives; all three must be present before it registers. */
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order, matching the packaged delegation tool's slot. */
const SECTION_ORDER = 116.5

/** Plugin configuration. */
export interface Config {
  /** The `ctx.subagents` provider to start runs on (`spawn`, `fork`, …). */
  provider: string
  /** Model-facing tool name; each loaded instance needs a distinct one. */
  toolName?: string
  /** Expose `run_in_background`. */
  enableRunInBackground?: boolean
  /** `continuable` defaults calls to background and returns a durable child id. */
  backgroundMode?: 'one-shot' | 'continuable'
  /** Row-level child defaults; a per-call `model` overrides them field by field. */
  agentOptions?: AgentOptions
  /** Per-child persona shadowing the deployment's. */
  persona?: string
  /** Tool filter applied to every child. */
  toolFilter?: { allow?: string[], deny?: string[] }
  /** Delegation depth cap, or `provider-managed` to send none. */
  maxDepth?: number | 'provider-managed'
  /**
   * Deployment-authored routing guidance appended to the prompt section: which
   * model suits what, which efforts each accepts, what to avoid. Empty leaves
   * the model to choose on its own.
   */
  routingGuide?: string
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Cast mirrors the packaged tool's: Schemastery would otherwise materialize
  // an omitted `agentOptions` as `{}`, which is not the same as absent.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string, model: string, maxTokens: number }),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[], deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  routingGuide: z.string().default(''),
})

/** The model's arguments, after validation. */
interface DelegationArgs {
  description: string
  prompt: string
  model?: string
  provider?: string
  effort?: string
  run_in_background?: boolean
}

/**
 * Validate the model's arguments.
 *
 * Hand-written because this package does not use `defineTool` — which would
 * compile a validator, and would also be a value import of the harness. The
 * surface is six fields, so the check is shorter than the reasons for it.
 * @param args - the model's arguments, however malformed.
 * @returns violations in declaration order; empty means valid.
 */
export function validateArgs(args: unknown): string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return ['arguments must be an object']
  }
  const record = args as Record<string, unknown>
  const violations: string[] = []
  for (const key of ['description', 'prompt'] as const) {
    const value = record[key]
    if (typeof value !== 'string') violations.push(`${key} is required and must be a string`)
    else if (value.trim() === '') violations.push(`${key} must not be empty`)
  }
  for (const key of ['model', 'provider', 'effort'] as const) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string') violations.push(`${key} must be a string`)
    else if (value.trim() === '') violations.push(`${key} must not be empty`)
  }
  if (record.run_in_background !== undefined && typeof record.run_in_background !== 'boolean') {
    violations.push('run_in_background must be a boolean')
  }
  return violations
}

/**
 * Render the text blocks of a canonical output value.
 * @param values - the child's output blocks as lossless JSON.
 * @returns the concatenated text.
 */
function outputText(values: readonly unknown[]): string {
  return values
    .filter((value): value is { type: 'text', text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as { type?: unknown }).type === 'text'
      && typeof (value as { text?: unknown }).text === 'string')
    .map(value => value.text)
    .join('')
}

/**
 * The headline for a run that did not finish cleanly.
 * @param result - the child's terminal result.
 * @returns the headline, or undefined when it completed.
 */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    // The stop-reason union is merge-extensible: a backend may add one. An
    // unknown terminal reason is a failure, not partial output called success.
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Attach the provider's diagnostic and the child's partial answer to a failure.
 *
 * The partial text earns its place: a child that hit its token limit halfway
 * through an analysis produced something worth reading, and discarding it
 * because the run failed wastes the tokens that produced it.
 * @param headline - the stop-reason headline.
 * @param result - the terminal result.
 * @returns headline, diagnostic, and partial text, as present.
 */
function withDetail(headline: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = outputText(result.output as readonly unknown[])
  const partial = text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`
  return `${headline}${diagnostic}${partial}`
}

/**
 * Collect one foreground run and release it, without letting disposal mask a
 * result failure or the reverse.
 * @param run - the live run.
 * @returns the foreground tool value.
 */
async function settleForeground(run: SubagentRun): Promise<{ kind: 'foreground', runId: string, output: unknown[] }> {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withDetail(error, result))
      return { kind: 'foreground' as const, runId: String(run.id), output: result.output as unknown[] }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** A background job outcome, as `ctx.jobs` models it. */
interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  output?: string
  detail?: string
}

/**
 * Map a child result onto a background job outcome.
 * @param result - the terminal result.
 * @returns the outcome.
 */
function jobOutcome(result: SubagentResult): JobOutcome {
  if (result.stopReason === 'completed') {
    return { status: 'completed', output: outputText(result.output as readonly unknown[]) }
  }
  if (result.stopReason === 'aborted') return { status: 'killed' }
  const detail = result.diagnostic === undefined
    ? String(result.stopReason)
    : `${String(result.stopReason)}; diagnostic: ${result.diagnostic}`
  return { status: 'failed', detail }
}

/**
 * Await a one-shot background run, dispose it, and report its outcome.
 * @param start - the pending run.
 * @param signal - the job's cancellation signal.
 * @returns the job outcome.
 */
async function settleJob(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  let run: SubagentRun
  try {
    run = await start
  } catch (error: unknown) {
    // Providers aggregate startup and rollback failures; cancellation must not
    // turn a failed cleanup into a cleanly killed job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
  let outcome: JobOutcome
  try {
    outcome = jobOutcome(await run.result)
  } catch (error: unknown) {
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await run.dispose()
  } catch (error: unknown) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}

/**
 * Model-facing wording, which depends on what the child can already see.
 *
 * A forked child is seeded with the parent's completed turns; a spawned one is
 * not. Telling the model to restate everything would be false for a fork, and
 * telling it the child sees this conversation would be false for a spawn.
 * @param inherits - whether the child inherits the conversation.
 * @returns the tool and prompt-parameter descriptions.
 */
export function wordingFor(inherits: boolean): { description: string, promptDescription: string } {
  if (inherits) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, a review, a continuation — '
        + 'without consuming this conversation\'s context for the work itself. You receive its result, '
        + 'not its intermediate steps. You may run it on a different model, and at a different reasoning '
        + 'effort, than your own.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) to '
      + 'offload focused, independent work — research, a scoped implementation, an analysis — so it does '
      + 'not consume this conversation\'s context. The subagent returns its result, not its intermediate '
      + 'steps. Give it a complete, standalone prompt: it does not see this conversation. You may run it '
      + 'on a different model, and at a different reasoning effort, than your own.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this conversation\'s context, '
      + 'so include everything it needs.',
  }
}

/**
 * Build the tool's argument schema.
 * @param promptDescription - provider-derived wording for the prompt field.
 * @param backgroundEnabled - whether `run_in_background` is offered.
 * @param continuable - whether background runs are continuable.
 * @returns the JSON Schema the registry validates against.
 */
function parameterSchema(
  promptDescription: string,
  backgroundEnabled: boolean,
  continuable: boolean,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: { type: 'string', description: promptDescription },
      model: {
        type: 'string',
        description:
          'Model id for this subagent only, overriding the model you are running on. Omit to inherit it. '
          + 'Match the model to the subtask rather than defaulting to your own.',
      },
      provider: {
        type: 'string',
        description:
          'Provider route for this subagent only. Omit to keep the current route, which is usually right: '
          + 'a model id is normally enough, and the route only needs naming when the model lives on a '
          + 'different one.',
      },
      effort: {
        type: 'string',
        description:
          'Reasoning effort for this subagent only, as the chosen model names it (commonly `low`, '
          + '`medium`, `high`). Omit for that model\'s own default. It applies to this delegation alone — '
          + 'a subagent that delegates further must name its own. An effort the model does not offer '
          + 'fails the run with the list it does.',
      },
      ...backgroundEnabled
        ? {
            run_in_background: {
              type: 'boolean',
              description: continuable
                ? 'Whether to run in the background and return a durable subagent id immediately. Defaults '
                  + 'to true. Set false to wait for the result when your next action depends on it.'
                : 'Whether to run as a background job and return its id. Defaults to false; collect with '
                  + 'job_output or stop with job_kill.',
            },
          }
        : {},
    },
    required: ['description', 'prompt'],
  }
}

/** The tool's canonical output schema: one of three shapes, by run mode. */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', const: 'background' }, jobId: { type: 'string' } },
      required: ['kind', 'jobId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', const: 'continuable' }, subagentId: { type: 'string' } },
      required: ['kind', 'subagentId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'foreground' },
        runId: { type: 'string' },
        output: { type: 'array', items: {} },
      },
      required: ['kind', 'runId', 'output'],
    },
  ],
}

/** The tool's value, in each of its three shapes. */
type DelegationValue =
  | { kind: 'background', jobId: string }
  | { kind: 'continuable', subagentId: string }
  | { kind: 'foreground', runId: string, output: unknown[] }

/**
 * Merge a call's route selection over the row's defaults.
 *
 * The harness merges the result field by field onto the parent's own options,
 * so naming only `model` keeps the parent's provider and naming neither is
 * exactly the stock behavior.
 * @param configured - the row's `agentOptions`, if any.
 * @param args - the validated call arguments.
 * @returns the options to send, or undefined when there is nothing to send.
 */
export function childOptions(
  configured: AgentOptions | undefined,
  args: Pick<DelegationArgs, 'model' | 'provider' | 'effort'>,
): AgentOptions | undefined {
  const merged: AgentOptions = {
    ...configured ?? {},
    ...args.provider === undefined ? {} : { provider: args.provider },
    ...args.model === undefined ? {} : { model: args.model },
    ...args.effort === undefined ? {} : { [EFFORT_OPTION]: args.effort },
  }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/**
 * Mount the delegation tool, its prompt section, and the effort bridge.
 * @param ctx - plugin context carrying tools, subagents, and systemPrompt.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const providerName = config.provider
  if (typeof providerName !== 'string' || providerName === '') {
    throw new Error('tool-subagent-model: `provider` is required (the ctx.subagents provider to delegate on)')
  }
  const toolName = config.toolName ?? 'subagent'
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const maxDepth = config.maxDepth ?? 3
  if (maxDepth !== 'provider-managed' && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) {
    throw new Error(`tool-subagent-model: maxDepth must be a non-negative integer or 'provider-managed', got ${String(maxDepth)}`)
  }
  const routingGuide = (config.routingGuide ?? '').trim()

  // One registration covers every descendant: a subagent joins its parent's
  // preset mount, so a listener here sees the whole delegation tree.
  ctx.effect(() => installEffortBridge(ctx), 'tool-subagent-model: effort bridge')

  let disposeTool: (() => void) | undefined

  const mount = (provider: SubagentProvider): void => {
    if (typeof maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent-model: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + "set maxDepth: 'provider-managed' to leave the recursion budget to the provider",
      )
    }
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error(`tool-subagent-model: provider "${provider.name}" does not support backgroundMode: continuable`)
    }
    const wording = wordingFor(provider.inheritsParentContext)

    const definition: ToolDefinition = {
      name: toolName,
      description: wording.description + (backgroundEnabled
        ? continuable
          ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends you a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
          : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
        : ' This call waits for the subagent and returns its result.'),
      parameters: parameterSchema(wording.promptDescription, backgroundEnabled, continuable),
      output: {
        schema: OUTPUT_SCHEMA as never,
        render: (_args, value) => {
          const shaped = value as unknown as DelegationValue
          return [{
            type: 'text',
            text: shaped.kind === 'background'
              ? `started background subagent job ${shaped.jobId}`
              : shaped.kind === 'continuable'
                ? `started subagent ${shaped.subagentId}`
                : outputText(shaped.output),
          }]
        },
      },
      // A child never mutates the parent session, and the one parent-owned
      // write (starting a job) is a commutative insertion.
      isConcurrencySafe: () => true,

      async execute(rawArgs, exec) {
        const violations = validateArgs(rawArgs)
        if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
        const args = rawArgs as DelegationArgs
        const parent = exec.agent as Agent | undefined
        if (!parent) throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')

        if (!backgroundEnabled && args.run_in_background === true) {
          throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
        }

        const agentOptions = childOptions(config.agentOptions, args)
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...agentOptions === undefined ? {} : { agentOptions },
          ...config.persona === undefined ? {} : { persona: config.persona },
          ...config.toolFilter === undefined ? {} : { toolFilter: config.toolFilter },
          ...typeof maxDepth === 'number' ? { maxDepth } : {},
        }

        const runInBackground = backgroundEnabled ? args.run_in_background ?? continuable : false

        if (runInBackground && continuable) {
          // Resolves at inbox acceptance: the child owns its turns from there,
          // so this call neither waits for nor collects a result.
          const started = await ctx.subagents.startContinuable({
            provider: providerName,
            label: args.description,
            request,
            signal: exec.signal,
          })
          return { kind: 'continuable', subagentId: String(started.childId) }
        }

        if (runInBackground) {
          const jobs = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          const id = jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              const start = ctx.subagents.start(providerName, { ...request, signal: controller.signal })
              return {
                cancel: (reason?: string) => { controller.abort(reason ?? 'background subagent task killed') },
                done: settleJob(start, controller.signal),
              }
            },
          })
          return { kind: 'background', jobId: String(id) }
        }

        return settleForeground(await ctx.subagents.start(providerName, { ...request, signal: exec.signal }))
      },
    }
    disposeTool = ctx.tools.register(definition)
  }

  // Listeners first, so a provider appearing between the check and the
  // registration is not missed.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === providerName && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== providerName || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(providerName)
  if (present !== undefined) mount(present)
  else ctx.logger.info(`tool-subagent-model: provider "${providerName}" not registered yet; "${toolName}" will register when it appears`)

  if (!backgroundEnabled || !continuable) return
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: SECTION_ORDER,
    // Empty while the tool is absent: an empty section is omitted from the
    // rendered prompt, so this follows provider availability with no lifecycle
    // of its own.
    text: (context) => {
      if (disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined) return ''
      const base = `Use ${toolName} in the background by default. Start independent delegations together in one `
        + 'assistant message and continue useful work while they run. Set `run_in_background: false` only when '
        + `your next action depends on that subagent's result. When a background run settles, the runtime sends `
        + 'you a notice containing its outcome and any final assistant message.\n\n'
        + `${toolName} also takes \`model\`, \`provider\`, and \`effort\` for one call only: pick the model and `
        + 'the reasoning effort that fit the subtask rather than defaulting to your own, and omit them when '
        + 'your own are right. Your own route never changes, and `effort` applies to that one delegation — '
        + 'a subagent that delegates further names its own.'
      return routingGuide === '' ? base : `${base}\n\n${routingGuide}`
    },
  })
}
