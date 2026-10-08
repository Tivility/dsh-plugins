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

class MockAdapter extends LlmAdapter {
  constructor(private readonly window: number | undefined, private readonly defaultMaxTokens: number) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.window === undefined ? {} : { context: { contextWindow: this.window } },
      defaultMaxTokens: this.defaultMaxTokens,
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Summary of past events.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Summary of past events.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createHarness(modelWindow: number | undefined = 1_000_000, pluginConfig = {}, defaultMaxTokens = 8_192) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)

  ctx.llm.registerAdapter([MODEL, 'test-provider'], new MockAdapter(modelWindow, defaultMaxTokens))

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

    // A setting that works: 64k against the default 65,536 headroom would be
    // refused before it ever reached the log.
    await service1.setSessionSettings(session1, {
      contextWindow: 64_000,
      thresholdRatio: 0.7,
      headroomTokens: 8_000,
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
    const result = await service.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs.length).toBeGreaterThan(0)
  })
})

/** A session whose context is well past any threshold, mid-turn, ready for a pressure check. */
function heavySession(ctx: ReturnType<typeof createHarness>['ctx'], id: string): Session {
  const session = ctx.sessions.create(SessionId(id))
  for (let turn = 1; turn <= 3; turn += 1) {
    appendTurn(session, turn, 'A'.repeat(250_000), 'B'.repeat(10_000), turn === 1 ? 'System prompt' : undefined, true)
  }
  session.append('turn/start', { turn: 4 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'A'.repeat(250_000) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 4, step: 1 })
  return session
}

describe('settings that would leave compaction unable to run are refused (decision A)', () => {
  it('refuses at activation a configured window smaller than the headroom it must leave', () => {
    // 32k against the default 65,536-token headroom: no pressure budget at all,
    // even before a single completion token is reserved.
    expect(() => createHarness(1_000_000, { contextWindow: 32_000 })).toThrow(/contextWindow 32000 cannot work/)
  })

  it('refuses a model policy window the same way', () => {
    expect(() => createHarness(1_000_000, {
      modelPolicies: [{ provider: 'test-provider', model: MODEL, contextWindow: 64_000 }],
    })).toThrow(/test-provider\/test-model contextWindow 64000 cannot work/)
  })

  it('accepts a small window once headroom is sized for it', () => {
    expect(() => createHarness(1_000_000, { contextWindow: 32_000, headroomTokens: 8_000 })).not.toThrow()
  })

  it('refuses session settings that fail against the session\'s own model, and keeps none of them', async () => {
    // The deployment this was found on: 32k completion reservation, default
    // headroom. A 64k working window leaves no message budget there.
    const { ctx, service } = createHarness(1_000_000, {}, 32_000)
    const session = ctx.sessions.create(SessionId('s-refused'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    await expect(service.setSessionSettings(session, { contextWindow: 64_000 }))
      .rejects.toThrow(/would leave pressure compaction unable to run/)
    expect((await service.effectiveSettings(session)).contextWindow.source).toBe('default')
  })

  it('accepts the same window with headroom that fits it', async () => {
    const { ctx, service } = createHarness(1_000_000, {}, 32_000)
    const session = ctx.sessions.create(SessionId('s-accepted'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    await service.setSessionSettings(session, { contextWindow: 64_000, headroomTokens: 8_000, retainTokens: 4_000 })
    const effective = await service.effectiveSettings(session)
    expect(effective.problem).toBeUndefined()
    expect(effective.thresholdTokens).toBe(24_000)
  })

  it('names the problem in effectiveSettings when a configured window cannot work for one model', async () => {
    // Passes the activation check (it works with no reservation) but not with
    // this model's 32k reservation — the case only the session's target shows.
    const { ctx, service } = createHarness(1_000_000, { contextWindow: 100_000 }, 32_000)
    const session = ctx.sessions.create(SessionId('s-problem'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')

    const effective = await service.effectiveSettings(session)
    expect(effective.problem).toMatch(/retainTokens/)
    expect(effective.thresholdTokens).toBe(0)
  })
})

describe('where the working window comes from', () => {
  it('takes a model policy window over the configured default', async () => {
    const { ctx, service } = createHarness(1_000_000, {
      contextWindow: 272_000,
      modelPolicies: [{ provider: 'test-provider', model: MODEL, contextWindow: 200_000 }],
    })
    const session = ctx.sessions.create(SessionId('s-model-window'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')
    expect((await service.effectiveSettings(session)).contextWindow).toEqual({ value: 200_000, source: 'modelPolicy' })
  })

  it('takes a session window over a model policy window', async () => {
    const { ctx, service } = createHarness(1_000_000, {
      modelPolicies: [{ provider: 'test-provider', model: MODEL, contextWindow: 200_000 }],
    })
    const session = ctx.sessions.create(SessionId('s-session-window'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')
    await service.setSessionSettings(session, { contextWindow: 150_000 })
    expect((await service.effectiveSettings(session)).contextWindow).toEqual({ value: 150_000, source: 'session' })
  })

  it('uses the configured window when the adapter reports none', async () => {
    // The base engine refuses pressure compaction without a reported window;
    // a window the operator declared is enough to measure against.
    const { ctx, service } = createHarness(undefined, { contextWindow: 272_000 })
    const session = heavySession(ctx, 's-no-adapter-window')
    const result = await service.compactIfNeeded(createAgent(session), 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
  })
})

describe('the pressure decision is the base engine\'s', () => {
  it('compacts at the working window, not the physical one', async () => {
    // 650k estimated tokens: far under 80% of 1M, far over the 272k threshold.
    const { ctx, service } = createHarness(1_000_000, { contextWindow: 272_000 })
    const result = await service.compactIfNeeded(
      createAgent(heavySession(ctx, 's-working')), 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()

    const { ctx: plainCtx, service: plain } = createHarness(1_000_000)
    const untouched = await plain.compactIfNeeded(
      createAgent(heavySession(plainCtx, 's-physical')), 'pressure', new AbortController().signal)
    expect(untouched).toBeNull()
  })

  it('leaves the engine untouched for a session with no window and no overrides', async () => {
    const { ctx, service } = createHarness(1_000_000)
    const session = ctx.sessions.create(SessionId('s-plain'))
    appendTurn(session, 1, 'Hello', 'Hi there!', 'You are a test agent.')
    expect(await service.compactIfNeeded(createAgent(session), 'pressure', new AbortController().signal)).toBeNull()
  })
})
