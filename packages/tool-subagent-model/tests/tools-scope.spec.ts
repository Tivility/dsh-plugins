import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

/**
 * This plugin keeps its tool disposer in a local and never hands it to
 * `ctx.effect`, which is only correct because `ctx.tools.register` binds to
 * the calling scope and unregisters itself when that plugin is disposed.
 *
 * That is an assumption about the harness, not about this package, so it is
 * pinned against the real service rather than the fake context the delegation
 * tests use. If a harness release ever changed it, this plugin would leave a
 * live tool behind on every disable — the same shape as issue #12, in a
 * package that never patched anything.
 */
describe('the harness contract this plugin relies on', () => {
  it('drops a tool when the plugin that registered it is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt as never, {})
    await ctx.plugin(Tools as never, {})

    const definition = {
      name: 'probe-tool',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => '' },
      execute: () => ({}),
    }

    const fiber = (ctx as never as { plugin(p: unknown, c: unknown): Promise<unknown> })
      .plugin({
        inject: ['tools'],
        apply(inner: { tools: { register(d: unknown): () => void } }) {
          // Exactly what tool-subagent-model does: keep the disposer in a
          // local, never hand it to ctx.effect.
          inner.tools.register(definition)
        },
      }, {})
    await fiber

    const tools = (ctx as never as { tools: { get(n: string): unknown } }).tools
    expect(tools.get('probe-tool'), 'registered').toBeDefined()

    await (fiber as never as { dispose(): Promise<void> }).dispose()
    expect(tools.get('probe-tool'), 'gone after the plugin is disposed').toBeUndefined()
  })
})
