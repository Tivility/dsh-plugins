/**
 * Carrying a reasoning effort onto a delegated child.
 *
 * ## Why this needs its own seam
 *
 * `AgentOptions` — the only per-child configuration the delegation API
 * accepts — is `provider`, `model`, and `maxTokens`. There is no effort field,
 * and adding one to the object is not enough: the loop builds its first
 * request config from *named* fields (`{ ...route, reasoningEffort?, maxTokens? }`),
 * never by spreading the options, so an unknown key is silently dropped. Its
 * own error text names the alternative — *"supply both via the agent/request
 * waterfall"* — and that waterfall is what this module uses.
 *
 * ## Why the value rides on `AgentOptions` anyway
 *
 * The listener has to know *which* child an effort belongs to, and the child's
 * id does not exist until the delegation has already started. Correlating
 * afterwards is a race: the default run mode is background, and a continuable
 * child may take its first turn as soon as it is accepted.
 *
 * So the effort travels **on the child itself**, as an extra `AgentOptions`
 * field that is present from the moment the agent is created. This is the
 * harness's own pattern rather than a trick played on it: `AgentOptions` is
 * documented as merge-extensible, and `@deepseek-ai/dsh-subagent` already
 * augments it with `subagentDepth` and reads it back off `agent.options` at
 * runtime. Extra keys survive because the child's options are built by
 * spreading the request over the parent's.
 *
 * ## What happens after the first request
 *
 * Nothing further is needed. The first request logs a header carrying the
 * effort, and the loop restores an effort from that header on later steps
 * whenever the route still matches — so the child keeps it for the rest of its
 * life, including across a cold resume, without this listener doing anything
 * more.
 * @module @tivility/dsh-tool-subagent-model/effort
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /**
     * Reasoning effort this delegation asked for, read back by the
     * `agent/request` listener this package installs.
     *
     * Namespaced because it lands on a shared, merge-extensible interface.
     * Deliberately NOT inherited by a grandchild: the harness copies only
     * `provider`, `model`, and `maxTokens` from a parent's options, so a
     * nested delegation names its own effort or gets the model's default.
     */
    tivilitySubagentEffort?: string
  }
}

/** The field name, exported so the tool and its tests agree on one spelling. */
export const EFFORT_OPTION = 'tivilitySubagentEffort'

/**
 * Install the listener that turns a child's carried effort into its request
 * configuration.
 *
 * Registered once per plugin instance on the context the delegation tool is
 * mounted in. A subagent joins its parent's preset mount, so one registration
 * covers every descendant as well as the parent.
 * @param ctx - the plugin context.
 * @returns a disposer removing the listener.
 */
export function installEffortBridge(ctx: Context): () => void {
  return ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const effort = payload.agent.options[EFFORT_OPTION]
    if (effort === undefined || effort === '') return config
    // A later step already carries the effort through the logged header, so
    // re-applying the same value is a no-op rather than a second policy.
    return { ...config, reasoningEffort: effort as never }
  })
}
