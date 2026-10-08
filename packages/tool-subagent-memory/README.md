# @tivility/dsh-tool-subagent-memory

Targets the DeepSeek Harness **0.2** line — `0.2.0-rc.2` and every later 0.2 prerelease or release, below 0.3.

Model-facing delegation tool for DeepSeek Harness 0.2 with per-call global memory control.

This plugin is a drop-in replacement for `@deepseek-ai/dsh-tool-subagent` (0.2 line). It adds a `global_memory` parameter to the `subagent` tool, allowing the caller to decide whether the child subagent should receive the user's global memory.

## Installation

```sh
dsh plugin add @tivility/dsh-tool-subagent-memory
```

On DeepSeek Harness 0.2 the row this package replaces lives **inside each agent preset** — in `dsh web` the host-level copy is disabled. Two things that look like they should install it do not:

- a profile patch with the same `id` and this package's `name` is skipped (`patch: name mismatch … skipping`, logged once at boot);
- a profile patch cannot address a row inside a preset at all.

So it is installed by declaring a preset: a shipped one, with its `tool-subagent` row renamed to this package. [`scripts/derive-preset.mjs`](../../scripts/derive-preset.mjs) derives it from the composition the host is running, so nothing is copied that could fall behind a harness release:

```sh
dsh --profile web --dump-config \
  | node scripts/derive-preset.mjs --dsh <dsh install dir> --id memory --name 记忆模式 --with tool-subagent-memory \
  > /tmp/memory-preset.yml
```

Add the generated row to `~/.dsh/profiles/web/cordis.patch.yml` (replacing the file if it holds only `[]`) and restart. The preset appears in the picker; one that cannot mount shows its reason there instead of silently falling back.

## Behavior

- **`global_memory: true`** sets `agentOptions.globalMemory = true` on the child. A memory plugin decides what that means — see the contract below.
- **Omitted or `false`** sends no `agentOptions` at all, exactly as upstream does for an ordinary delegation. The child's `agent.options.globalMemory` is absent; consumers should test `=== true`.
- **The parameter appears only where it can be honored.** A provider without the `agentOptions` capability — the ACP provider, for one — refuses any request carrying `agentOptions`, so the tool does not offer `global_memory` there instead of offering a way to fail every call.
- Everything else is upstream's: foreground and continuable background runs, model selection (`provider`, `model`, `reasoning_effort`), and the recursion limit, which falls back to the deployment-wide `subagents.maxDepth` when the tool configures none.

## Contract for Memory Plugins

This package establishes a product-neutral contract between delegation tools and memory plugins:

1. **Option Propagation**: When the model calls `subagent` with `global_memory: true`, the tool attaches `{ globalMemory: true }` to `AgentOptions` passed to `subagents.start()` or `subagents.startContinuable()`.
2. **Consumption**: Any memory plugin (or system prompt provider) can inspect `agent.options.globalMemory` on the newly created subagent.

### Example: Memory Plugin Consuming `globalMemory`

```typescript
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'memory:global',
    order: 50,
    // A section provider returns its text synchronously — an async provider
    // would put a Promise where the prompt text belongs.
    text: (promptContext) => {
      const agent = promptContext.agent
      if (agent === undefined) return ''

      // A top-level session always gets global memory; a delegated child only
      // when the delegation asked for it.
      const isChild = agent.session.header.origin === 'subagent'
      if (isChild && agent.options.globalMemory !== true) return ''

      return '<global_memory>\n...\n</global_memory>'
    },
  })
}
```

## Upstream Lineage

Forked from `@deepseek-ai/dsh-tool-subagent@0.2.1-alpha.1` (MIT).

`src/index.ts` is upstream with one patch, every hunk marked `tivility:` — a module augmentation adding `AgentOptions.globalMemory`, the `global_memory` parameter, and the line that adds `globalMemory` to a request that asked for it. `src/list-models.ts`, `src/model-selection.ts` and `src/model-selection-state.ts` are upstream verbatim; `src/model-selection-settings.ts` re-exports upstream's, so the settings service is the host's own.

Keeping the fork that narrow is what makes it forward-compatible: on a new harness release, take upstream's `src/` and re-apply the marked hunks. Anything else that differs is drift, and drift is where this fork's earlier bugs came from.
