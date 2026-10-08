import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  createMessage,
  createSystemMessage,
  createUserMessage,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionWindowService } from '../src/index.js'

const MODEL = 'test-model'

class Mock1MAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 8_192,
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Summary of past events.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Summary of past events.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createHarness(modelWindow = 1_000_000, pluginConfig = {}) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)

  ctx.llm.registerAdapter([MODEL, 'test-provider'], new Mock1MAdapter())

  const service = new CompactionWindowService(ctx, pluginConfig)
  return { ctx, service }
}

function createAgent(session: Session, provider = 'test-provider', model = MODEL): Agent {
  return {
    session,
    options: { provider, model },
  } as Agent
}

function appendTurn(session: Session, turn: number, userText: string, assistantText: string, system?: string, closeTurn = true) {
  session.append('turn/start', { turn })
  if (turn === 1 && system !== undefined) {
    session.append('system/message', {
      turn,
      step: 1,
      message: createSystemMessage(system),
    }, { surfaceOp: 'append' })
  }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', {
      header: { config: { provider: 'test-provider', model: MODEL } },
      reason: 'initial',
    })
  }
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      source: { kind: 'model', provider: 'test-provider', model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  if (closeTurn) {
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

describe('CompactionWindowService', () => {
  it('no settings behaves like compaction-basic (defaults)', async () => {
    const { ctx, service } = createHarness()
    const session = ctx.sessions.create(SessionId('s-default'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    const effective = await service.effectiveSettings(session)
    expect(effective.realContextWindow).toBe(1_000_000)
    expect(effective.contextWindow.value).toBe(1_000_000)
    expect(effective.contextWindow.source).toBe('default')
    expect(effective.thresholdRatio.value).toBe(0.8)
    expect(effective.thresholdRatio.source).toBe('default')
    expect(effective.headroomTokens.value).toBe(65_536)
    expect(effective.headroomTokens.source).toBe('default')
    expect(effective.retainRatio?.value).toBe(0.16)
    expect(effective.retainRatio?.source).toBe('default')
  })

  it('1M model + 272k working window compacts at DSH threshold and retains default ratio', async () => {
    const { ctx, service } = createHarness(1_000_000, { contextWindow: 272_000 })
    const session = ctx.sessions.create(SessionId('s-272k'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    const effective = await service.effectiveSettings(session)
    expect(effective.realContextWindow).toBe(1_000_000)
    expect(effective.contextWindow.value).toBe(272_000)
    expect(effective.contextWindow.source).toBe('config')

    // DSH math verification on 272k:
    // messageBudget = 272_000 - 8_192 = 263_808
    // pressureBudget = 263_808 - 65_536 = 198_272
    // thresholdTokens = min(272_000 * 0.8 = 217_600, 198_272) = 198_272
    // retainTokens = floor(263_808 * 0.16) = 42_209
    expect(effective.thresholdTokens).toBe(198_272)
    expect(effective.effectiveRetainTokens).toBe(42_209)
  })

  it('session override changes contextWindow and policy settings', async () => {
    const { ctx, service } = createHarness(1_000_000)
    const session = ctx.sessions.create(SessionId('s-override'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    await service.setSessionSettings(session, {
      contextWindow: 128_000,
      thresholdRatio: 0.75,
      retainTokens: 10_000,
      headroomTokens: 20_000,
    })

    const effective = await service.effectiveSettings(session)
    expect(effective.contextWindow.value).toBe(128_000)
    expect(effective.contextWindow.source).toBe('session')
    expect(effective.thresholdRatio.value).toBe(0.75)
    expect(effective.thresholdRatio.source).toBe('session')
    expect(effective.headroomTokens.value).toBe(20_000)
    expect(effective.headroomTokens.source).toBe('session')
    expect(effective.retainTokens?.value).toBe(10_000)
    expect(effective.retainTokens?.source).toBe('session')
    expect(effective.effectiveRetainTokens).toBe(10_000)
  })

  it('clamps contextWindow to real model context window', async () => {
    const { ctx, service } = createHarness(1_000_000)
    const session = ctx.sessions.create(SessionId('s-clamp'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    // Setting 2M on a 1M model
    await service.setSessionSettings(session, {
      contextWindow: 2_000_000,
    })

    const effective = await service.effectiveSettings(session)
    expect(effective.contextWindow.value).toBe(1_000_000)
    expect(effective.contextWindow.source).toBe('session')
  })

  it('reload/projection preserves session settings across log replay', async () => {
    const { ctx: ctx1, service: service1 } = createHarness(1_000_000)
    const session1 = ctx1.sessions.create(SessionId('s-persist'))
    appendTurn(session1, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    await service1.setSessionSettings(session1, {
      contextWindow: 64_000,
      thresholdRatio: 0.7,
    })

    // Create a new context and load the same session events (simulating reload)
    const { ctx: ctx2, service: service2 } = createHarness(1_000_000)
    const session2 = ctx2.sessions.prepare(session1.id, {
      seed: session1.snapshotEvents(),
      meta: session1.header,
    })

    const effective = await service2.effectiveSettings(session2)
    expect(effective.contextWindow.value).toBe(64_000)
    expect(effective.contextWindow.source).toBe('session')
    expect(effective.thresholdRatio.value).toBe(0.7)
    expect(effective.thresholdRatio.source).toBe('session')

    // Clear session settings and verify
    await service2.clearSessionSettings(session2)
    const cleared = await service2.effectiveSettings(session2)
    expect(cleared.contextWindow.value).toBe(1_000_000)
    expect(cleared.contextWindow.source).toBe('default')
  })

  it('performs compaction at 272k threshold when tokens exceed budget', async () => {
    const { ctx, service } = createHarness(1_000_000, { contextWindow: 272_000 })
    const session = ctx.sessions.create(SessionId('s-compact-exec'))

    // Append 3 completed turns and 1 open turn to simulate open-turn step compaction
    for (let turn = 1; turn <= 3; turn += 1) {
      appendTurn(session, turn, 'A'.repeat(250_000), 'B'.repeat(10_000), turn === 1 ? 'System prompt' : undefined, true)
    }
    // Turn 4 is currently open (waiting at pre-step / step)
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'A'.repeat(250_000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 4, step: 1 })

    const agent = createAgent(session)
    const result = await service.compactIfNeeded(agent, 'pressure')
    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs.length).toBeGreaterThan(0)
  })
})
