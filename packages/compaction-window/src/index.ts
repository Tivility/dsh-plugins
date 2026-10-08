/**
 * Per-session working context window and compaction service.
 *
 * A drop-in `compaction` service that is `@deepseek-ai/dsh-compaction-basic`
 * with one more input: a working window, smaller than the model's physical one,
 * that pressure compaction is measured against.
 *
 * The pressure decision itself stays the base engine's. This class never
 * re-implements `compactIfNeeded`; it calls the inherited one through a view in
 * which the conversation target's context window is capped and that session's
 * policy overrides are expressed as an ordinary model policy. Everything else —
 * the compaction lock, tool-result pruning, retry, the warning dedupe keyed on
 * the base's own error class — is the harness's code at whatever version the
 * host runs, so a fix upstream reaches this plugin without a release of it.
 * @module @tivility/dsh-compaction-window
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ModelCompactPolicyConfig, ResolvedConfig, ResolvedTargetPolicy } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { resolveCompactSpec, resolveTargetPolicy } from './math.js'
import { compactionWindowProjectionDefinition, sessionCompactionSettingsSchema } from './projection.js'
import type {
  CompactionWindowConfig,
  CompactionWindowEngine,
  CompactionWindowModelPolicy,
  EffectiveCompactionSettings,
  SessionCompactionSettings,
  SettingSource,
} from './types.js'

export type * from './types.js'
export { compactionWindowProjectionDefinition } from './projection.js'

type Target = Pick<LlmCallConfig, 'provider' | 'model'>

/** The base engine's own target rule: the routed request header, nothing else. */
function routedTarget(session: Session): Target | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** The base engine's own reservation rule. */
function reservedCompletionTokens(session: Session, defaultMaxTokens: number | undefined): number {
  return session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0
}

/** The policy fields a session may override; the rest of a model policy stays the operator's. */
type PolicyOverride = Omit<SessionCompactionSettings, 'contextWindow'>

/**
 * A copy of `config` whose model policy for `target` carries `override`.
 *
 * This is how a session's settings reach the base engine: as the model policy
 * it already knows how to resolve. Retention is one setting with two spellings,
 * so a session that names one drops the other it would otherwise inherit.
 */
function withTargetPolicy(config: ResolvedConfig, target: Target, override: PolicyOverride): ResolvedConfig {
  const existing = config.modelPolicies.find(p => p.provider === target.provider && p.model === target.model)
  const merged: ModelCompactPolicyConfig = {
    ...existing ?? { provider: target.provider, model: target.model },
    ...override,
  }
  if (override.retainTokens !== undefined) delete merged.retainRatio
  if (override.retainRatio !== undefined) delete merged.retainTokens
  return {
    ...config,
    modelPolicies: [merged, ...config.modelPolicies.filter(p => p !== existing)],
  }
}

/** Only the defined fields, so an absent override never shadows a configured value. */
function definedOverride(settings: SessionCompactionSettings | null): PolicyOverride {
  const override: PolicyOverride = {}
  if (settings === null) return override
  if (settings.thresholdRatio !== undefined) override.thresholdRatio = settings.thresholdRatio
  if (settings.headroomTokens !== undefined) override.headroomTokens = settings.headroomTokens
  if (settings.retainRatio !== undefined) override.retainRatio = settings.retainRatio
  if (settings.retainTokens !== undefined) override.retainTokens = settings.retainTokens
  return override
}

/** A function value bound to its owner, anything else as is. */
function bound(owner: object, key: PropertyKey): unknown {
  const value: unknown = Reflect.get(owner, key, owner)
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
}

const contextWindowSchema = z.number().step(1).min(1)

const modelPolicy: z<CompactionWindowModelPolicy> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  contextWindow: contextWindowSchema,
  thresholdRatio: z.number(),
  headroomTokens: z.number().step(1).min(0),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
}) as z<CompactionWindowModelPolicy>

/**
 * `compaction` with a working window. See the module comment for why the
 * pressure decision is delegated rather than re-implemented.
 */
export class CompactionWindowService extends BasicCompactionEngine implements CompactionWindowEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']

  static override Config: z<CompactionWindowConfig> = z.object({
    contextWindow: contextWindowSchema,
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  }) as z<CompactionWindowConfig>

  private readonly configuredWindow: number | undefined
  private readonly modelWindows: ReadonlyMap<string, number>
  /** Top-level policy keys the operator set, as opposed to the base's defaults. */
  private readonly explicitKeys: ReadonlySet<string>

  constructor(ctx: Context, config: CompactionWindowConfig = {}) {
    const { contextWindow, modelPolicies, ...rest } = config
    // The base validates model policies strictly, so the one key it does not
    // know is lifted out here and kept beside it.
    const windows = new Map<string, number>()
    const basicPolicies = modelPolicies?.map(({ contextWindow: window, ...policy }) => {
      if (window !== undefined) windows.set(`${policy.provider}/${policy.model}`, window)
      return policy
    })
    super(ctx, { ...rest, ...basicPolicies === undefined ? {} : { modelPolicies: basicPolicies } })
    this.configuredWindow = contextWindow
    this.modelWindows = windows
    this.explicitKeys = new Set(Object.keys(rest).filter(key => rest[key as keyof typeof rest] !== undefined))
    this.assertConfiguredWindowsWork()
    ctx.sessionProjections.register(compactionWindowProjectionDefinition)
  }

  /**
   * Refuse, at activation, a configured window that can never leave a
   * pressure budget — even before any completion tokens are reserved.
   *
   * Headroom is an absolute token count, sized for physical windows in the
   * hundreds of thousands. Below roughly twice it a working window has no room
   * left to measure pressure in, and the base engine's response is a warning
   * the user never sees and a turn that continues uncompacted. Failing the load
   * is the only place this can be said out loud.
   */
  private assertConfiguredWindowsWork(): void {
    const check = (window: number, policy: ResolvedTargetPolicy, where: string): void => {
      try {
        resolveCompactSpec(policy, window, 0)
      } catch (error: unknown) {
        throw new Error(
          `compaction-window: ${where} contextWindow ${String(window)} cannot work with its compaction policy — `
          + `${(error as Error).message}. Raise contextWindow, or lower headroomTokens / retainRatio / retainTokens.`,
        )
      }
    }
    if (this.configuredWindow !== undefined) {
      // `*/*`: the default policy, the one every model without its own falls back to.
      check(this.configuredWindow, resolveTargetPolicy(this.config, { provider: '*', model: '*' }), 'the configured')
    }
    for (const [key, window] of this.modelWindows) {
      const [provider = '', model = ''] = key.split('/')
      check(window, resolveTargetPolicy(this.config, { provider, model }), `the ${key}`)
    }
  }

  /** Persist per-session overrides, after checking they leave compaction working. */
  async setSessionSettings(session: Session, settings: SessionCompactionSettings): Promise<void> {
    const parsed = sessionCompactionSettingsSchema.parse(settings)
    const effective = await this.resolveEffective(session, parsed)
    if (effective.problem !== undefined) {
      throw new Error(
        `compaction-window: these settings would leave pressure compaction unable to run — ${effective.problem}`,
      )
    }
    await session.append('compaction/settings', { settings: parsed })
  }

  /** Clear per-session overrides. */
  async clearSessionSettings(session: Session): Promise<void> {
    await session.append('compaction/settings', { settings: null })
  }

  /** Effective settings with where each came from, and why compaction cannot run if it cannot. */
  async effectiveSettings(session: Session, signal?: AbortSignal): Promise<EffectiveCompactionSettings> {
    return await this.resolveEffective(session, this.sessionSettings(session), signal)
  }

  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    const settings = this.sessionSettings(agent.session)
    const window = target === undefined ? undefined : this.workingWindow(settings, target).value
    const override = definedOverride(settings)
    if (target === undefined || (window === undefined && Object.keys(override).length === 0)) {
      return await super.compactIfNeeded(agent, trigger, signal)
    }
    const view = this.viewFor(target, window, override)
    return await BasicCompactionEngine.prototype.compactIfNeeded.call(view, agent, trigger, signal)
  }

  private sessionSettings(session: Session): SessionCompactionSettings | null {
    return this.ctx.sessionProjections.stateOf(session, 'compaction-window') ?? null
  }

  /** Session, then model policy, then the configured default; undefined means the physical window. */
  private workingWindow(
    settings: SessionCompactionSettings | null,
    target: Target,
  ): { value: number | undefined; source: SettingSource } {
    if (settings?.contextWindow !== undefined) return { value: settings.contextWindow, source: 'session' }
    const byModel = this.modelWindows.get(`${target.provider}/${target.model}`)
    if (byModel !== undefined) return { value: byModel, source: 'modelPolicy' }
    if (this.configuredWindow !== undefined) return { value: this.configuredWindow, source: 'config' }
    return { value: undefined, source: 'default' }
  }

  /**
   * This engine as the base sees it for one call: `config` carrying the
   * session's policy for `target`, and `ctx.llm` answering that one target's
   * context window with the working window.
   *
   * Only `resolveModelInfo` for the conversation target is changed. The base
   * reads it once, to size pressure; summarization asks the adapter for
   * nothing, so the cap cannot shrink what a summary is allowed to read.
   * Methods the base calls on `this` see the view, so the whole call — region
   * compaction included — runs against the same inputs.
   */
  private viewFor(target: Target, window: number | undefined, override: PolicyOverride): this {
    const config = Object.keys(override).length === 0 ? this.config : withTargetPolicy(this.config, target, override)
    const realCtx = this.ctx
    const llm = realCtx.llm
    const cappedLlm = window === undefined ? llm : new Proxy(llm, {
      get(owner, key) {
        if (key !== 'resolveModelInfo') return bound(owner, key)
        return async (provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> => {
          const info = await owner.resolveModelInfo(provider, model, signal)
          if (provider !== target.provider || model !== target.model) return info
          // An adapter that reports no window still has the one the operator
          // declared: effective = min(working, physical), and physical unknown.
          const physical = info.context?.contextWindow
          return {
            ...info,
            context: { ...info.context, contextWindow: physical === undefined ? window : Math.min(window, physical) },
          }
        }
      },
    })
    const ctx = new Proxy(realCtx, {
      get(owner, key) { return key === 'llm' ? cappedLlm : bound(owner, key) },
    })
    return new Proxy(this, {
      get(owner, key, receiver) {
        if (key === 'config') return config
        if (key === 'ctx') return ctx
        return Reflect.get(owner, key, receiver)
      },
    })
  }

  /**
   * One resolution shared by `effectiveSettings` and the check in
   * `setSessionSettings`, so what is displayed and what is accepted can never
   * disagree. The arithmetic mirrors the base engine's; the decision to compact
   * is still the base engine's own.
   */
  private async resolveEffective(
    session: Session,
    settings: SessionCompactionSettings | null,
    signal?: AbortSignal,
  ): Promise<EffectiveCompactionSettings> {
    const target = routedTarget(session)
    const info = target === undefined
      ? undefined
      : await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal).catch(() => undefined)
    const realContextWindow = info?.context?.contextWindow ?? 0
    const working = this.workingWindow(settings, target ?? { provider: '', model: '' })
    const contextWindow = working.value === undefined
      ? realContextWindow
      : realContextWindow > 0 ? Math.min(working.value, realContextWindow) : working.value

    const override = definedOverride(settings)
    const policyTarget = target ?? { provider: '', model: '' }
    const config = Object.keys(override).length === 0 ? this.config : withTargetPolicy(this.config, policyTarget, override)
    const policy = resolveTargetPolicy(config, policyTarget)
    const configured = this.config.modelPolicies.find(p => p.provider === policyTarget.provider && p.model === policyTarget.model)
    const sourceOf = (key: keyof PolicyOverride): SettingSource => {
      if (settings?.[key] !== undefined) return 'session'
      if (configured?.[key] !== undefined) return 'modelPolicy'
      return this.explicitKeys.has(key) ? 'config' : 'default'
    }

    let thresholdTokens = 0
    let effectiveRetainTokens = 0
    let problem: string | undefined
    if (contextWindow > 0) {
      // Without a target the reservation is unknown; zero is the most
      // permissive case, so a failure there is a failure everywhere.
      const reserved = target === undefined ? 0 : reservedCompletionTokens(session, info?.defaultMaxTokens)
      try {
        const spec = resolveCompactSpec(policy, contextWindow, reserved)
        thresholdTokens = spec.thresholdTokens
        effectiveRetainTokens = spec.retainTokens
      } catch (error: unknown) {
        problem = (error as Error).message
      }
    }

    return {
      contextWindow: { value: contextWindow, source: working.source },
      realContextWindow,
      thresholdRatio: { value: policy.thresholdRatio, source: sourceOf('thresholdRatio') },
      headroomTokens: { value: policy.headroomTokens, source: sourceOf('headroomTokens') },
      ...policy.retainTokens === undefined
        ? { retainRatio: { value: policy.retainRatio, source: sourceOf('retainRatio') } }
        : { retainTokens: { value: policy.retainTokens, source: sourceOf('retainTokens') } },
      thresholdTokens,
      effectiveRetainTokens,
      ...problem === undefined ? {} : { problem },
    }
  }
}

export default CompactionWindowService
