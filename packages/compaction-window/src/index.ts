/**
 * Per-session working context window and compaction service.
 *
 * @module @tivility/dsh-compaction-window
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BasicCompactionEngine,
  type BasicCompactionConfig,
  type ModelCompactPolicyConfig,
  type ResolvedConfig,
  type ResolvedTargetPolicy,
} from '@deepseek-ai/dsh-compaction-basic'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './math.js'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-projection'
import { compactionWindowProjectionDefinition, sessionCompactionSettingsSchema } from './projection.js'
import type {
  CompactionWindowConfig,
  CompactionWindowEngine,
  EffectiveCompactionSettings,
  SessionCompactionSettings,
  SettingSource,
} from './types.js'

export type * from './types.js'
export { compactionWindowProjectionDefinition } from './projection.js'

function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (
    agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0
  ) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/**
 * System head check matching DSH compaction-basic.
 */
function systemHead(session: Session, headSeq: SessionSeq) {
  const head = session.eventAt(headSeq)
  return head?.type === 'system/message' ? head : undefined
}

/**
 * Select compactable range matching DSH compaction-basic logic.
 */
function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: SessionSeq; end: SessionSeq } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }
  const firstIdx = systemHead(session, surfaceNodes[0]!) === undefined ? 0 : 1
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return {
    start: surfaceNodes[firstIdx]!,
    end: surfaceNodes[keepFromIdx - 1]!,
  }
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const contextWindowSchema = z.number().step(1).min(1)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
}) as z<ModelCompactPolicyConfig>

/**
 * CompactionWindowService replaces `@deepseek-ai/dsh-compaction-basic`, providing
 * the `compaction` service with support for per-session contextWindow and policy overrides.
 */
export class CompactionWindowService extends BasicCompactionEngine implements CompactionWindowEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']

  static override Config: z<CompactionWindowConfig> = z.object({
    contextWindow: contextWindowSchema,
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  }) as z<CompactionWindowConfig>

  private readonly rawPluginConfig: CompactionWindowConfig
  private readonly configuredContextWindow?: number

  constructor(ctx: Context, config: CompactionWindowConfig = {}) {
    const { contextWindow, ...basicConfig } = config
    super(ctx, basicConfig)
    this.rawPluginConfig = config
    this.configuredContextWindow = contextWindow
    ctx.sessionProjections.register(compactionWindowProjectionDefinition)
  }

  /**
   * Set per-session compaction settings overrides.
   * Persisted as a `compaction/settings` event on the session log.
   */
  async setSessionSettings(session: Session, settings: SessionCompactionSettings): Promise<void> {
    const parsed = sessionCompactionSettingsSchema.parse(settings)
    await session.append('compaction/settings', { settings: parsed })
  }

  /**
   * Clear per-session compaction settings overrides.
   */
  async clearSessionSettings(session: Session): Promise<void> {
    await session.append('compaction/settings', { settings: null })
  }

  /**
   * Resolve effective settings with source annotations for a session.
   */
  async effectiveSettings(session: Session, signal?: AbortSignal): Promise<EffectiveCompactionSettings> {
    const target = routedTarget(session) ?? { provider: '', model: '' }
    const modelInfo = (target.provider && target.model)
      ? await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal).catch(() => undefined)
      : undefined

    const realContextWindow = modelInfo?.context?.contextWindow ?? 0
    const sessionSettings = this.getSessionSettings(session)

    // Precedence for modelPolicy
    const matchingPolicy = target.provider && target.model
      ? this.config.modelPolicies.find(p => p.provider === target.provider && p.model === target.model)
      : undefined

    // 1. contextWindow
    let contextWindowVal = realContextWindow
    let contextWindowSource: SettingSource = 'default'

    if (sessionSettings?.contextWindow !== undefined) {
      contextWindowVal = realContextWindow > 0
        ? Math.min(sessionSettings.contextWindow, realContextWindow)
        : sessionSettings.contextWindow
      contextWindowSource = 'session'
    } else if (this.configuredContextWindow !== undefined) {
      contextWindowVal = realContextWindow > 0
        ? Math.min(this.configuredContextWindow, realContextWindow)
        : this.configuredContextWindow
      contextWindowSource = 'config'
    }

    // 2. thresholdRatio
    let thresholdRatioVal = 0.8
    let thresholdRatioSource: SettingSource = 'default'
    if (sessionSettings?.thresholdRatio !== undefined) {
      thresholdRatioVal = sessionSettings.thresholdRatio
      thresholdRatioSource = 'session'
    } else if (matchingPolicy?.thresholdRatio !== undefined) {
      thresholdRatioVal = matchingPolicy.thresholdRatio
      thresholdRatioSource = 'modelPolicy'
    } else if (this.rawPluginConfig.thresholdRatio !== undefined) {
      thresholdRatioVal = this.rawPluginConfig.thresholdRatio
      thresholdRatioSource = 'config'
    }

    // 3. headroomTokens
    let headroomTokensVal = 65_536
    let headroomTokensSource: SettingSource = 'default'
    if (sessionSettings?.headroomTokens !== undefined) {
      headroomTokensVal = sessionSettings.headroomTokens
      headroomTokensSource = 'session'
    } else if (matchingPolicy?.headroomTokens !== undefined) {
      headroomTokensVal = matchingPolicy.headroomTokens
      headroomTokensSource = 'modelPolicy'
    } else if (this.rawPluginConfig.headroomTokens !== undefined) {
      headroomTokensVal = this.rawPluginConfig.headroomTokens
      headroomTokensSource = 'config'
    }

    // 4. retention
    let retainRatioEntry: { value: number; source: SettingSource } | undefined
    let retainTokensEntry: { value: number; source: SettingSource } | undefined

    if (sessionSettings?.retainTokens !== undefined) {
      retainTokensEntry = { value: sessionSettings.retainTokens, source: 'session' }
    } else if (sessionSettings?.retainRatio !== undefined) {
      retainRatioEntry = { value: sessionSettings.retainRatio, source: 'session' }
    } else if (matchingPolicy?.retainTokens !== undefined) {
      retainTokensEntry = { value: matchingPolicy.retainTokens, source: 'modelPolicy' }
    } else if (matchingPolicy?.retainRatio !== undefined) {
      retainRatioEntry = { value: matchingPolicy.retainRatio, source: 'modelPolicy' }
    } else if (this.rawPluginConfig.retainTokens !== undefined) {
      retainTokensEntry = { value: this.rawPluginConfig.retainTokens, source: 'config' }
    } else if (this.rawPluginConfig.retainRatio !== undefined) {
      retainRatioEntry = { value: this.rawPluginConfig.retainRatio, source: 'config' }
    } else {
      retainRatioEntry = { value: 0.16, source: 'default' }
    }

    const defaultMaxTokens = modelInfo?.defaultMaxTokens
    const headerMaxTokens = session.requestHeader()?.config?.maxTokens
    const reservedTokens = headerMaxTokens ?? defaultMaxTokens ?? 0
    const messageBudgetTokens = Math.max(0, contextWindowVal - reservedTokens)
    const pressureBudgetTokens = Math.max(0, messageBudgetTokens - headroomTokensVal)
    const thresholdTokens = Math.floor(Math.min(contextWindowVal * thresholdRatioVal, pressureBudgetTokens))

    let effectiveRetainTokens = 0
    if (retainTokensEntry !== undefined) {
      effectiveRetainTokens = retainTokensEntry.value
    } else if (retainRatioEntry !== undefined) {
      effectiveRetainTokens = Math.floor(messageBudgetTokens * retainRatioEntry.value)
    }

    return {
      contextWindow: { value: contextWindowVal, source: contextWindowSource },
      realContextWindow,
      thresholdRatio: { value: thresholdRatioVal, source: thresholdRatioSource },
      headroomTokens: { value: headroomTokensVal, source: headroomTokensSource },
      ...(retainRatioEntry ? { retainRatio: retainRatioEntry } : {}),
      ...(retainTokensEntry ? { retainTokens: retainTokensEntry } : {}),
      thresholdTokens,
      effectiveRetainTokens,
    }
  }

  private getSessionSettings(session: Session): SessionCompactionSettings | null {
    return this.ctx.sessionProjections.stateOf(session, 'compaction-window') ?? null
  }

  /**
   * Intercept compactIfNeeded to use session/config contextWindow & policy overrides.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    const sessionSettings = this.getSessionSettings(agent.session)
    const hasSessionSettings = sessionSettings !== null && Object.keys(sessionSettings).length > 0

    // If no session overrides and no top-level contextWindow configured, delegate directly to super
    if (!hasSessionSettings && this.configuredContextWindow === undefined) {
      return super.compactIfNeeded(agent, trigger, signal ?? new AbortController().signal)
    }

    const target = conversationTarget(agent)
    if (target === undefined) return null

    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)

    if (trigger === 'context-overflow') {
      const prune = this.ctx.get('toolResultPruner')
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-window: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }

    const realContextWindow = info.context.contextWindow
    let effectiveContextWindow = realContextWindow

    if (sessionSettings?.contextWindow !== undefined) {
      effectiveContextWindow = Math.min(sessionSettings.contextWindow, realContextWindow)
    } else if (this.configuredContextWindow !== undefined) {
      effectiveContextWindow = Math.min(this.configuredContextWindow, realContextWindow)
    }

    // Resolve base policy from config + modelPolicies
    const basePolicy = resolveTargetPolicy(this.config, target)

    // Apply session overrides if any
    let retentionFields: { readonly retainTokens: number } | { readonly retainRatio: number }
    if (sessionSettings?.retainTokens !== undefined) {
      retentionFields = { retainTokens: sessionSettings.retainTokens }
    } else if (sessionSettings?.retainRatio !== undefined) {
      retentionFields = { retainRatio: sessionSettings.retainRatio }
    } else if (basePolicy.retainTokens !== undefined) {
      retentionFields = { retainTokens: basePolicy.retainTokens }
    } else {
      retentionFields = { retainRatio: basePolicy.retainRatio }
    }

    const mergedPolicy: ResolvedTargetPolicy = {
      target: basePolicy.target,
      thresholdRatio: sessionSettings?.thresholdRatio ?? basePolicy.thresholdRatio,
      headroomTokens: sessionSettings?.headroomTokens ?? basePolicy.headroomTokens,
      summarizationProvider: basePolicy.summarizationProvider,
      summarizationModel: basePolicy.summarizationModel,
      maxTokens: basePolicy.maxTokens,
      compactionRetries: basePolicy.compactionRetries,
      maxOverflowRetries: basePolicy.maxOverflowRetries,
      ...retentionFields,
    }

    const spec = resolveCompactSpec(
      mergedPolicy,
      effectiveContextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )

    if (measurement.totalTokens < spec.thresholdTokens) return null

    const prune = this.ctx.get('toolResultPruner')
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        if (result === null) return null
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }
}

export default CompactionWindowService
