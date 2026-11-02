# @tivility/dsh-tool-subagent-memory

Targets DeepSeek Harness **0.2.1 and 0.2.2** — from `0.2.1-rc.5` through the 0.2.2 release. dsh refuses to install or activate it on any other harness version; see [Harness Versions](#harness-versions).

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
- Everything else is upstream's: managed activations (the tool returns the child id and the completion arrives as a notice), model selection (`provider`, `model`, `reasoning_effort`), and the recursion limit, which falls back to the deployment-wide `subagents.maxDepth` when the tool configures none.

## Contract for Memory Plugins

This package establishes a product-neutral contract between delegation tools and memory plugins:

1. **Option Propagation**: When the model calls `subagent` with `global_memory: true`, the tool adds `globalMemory: true` to the `agentOptions` of the request it passes to `subagents.startActivation()`.
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

## Harness Versions

The peer range admits only the harness lines this version was tested on end to end. dsh checks it against the running harness version, prereleases included, and blocks installation and activation when it is unmet.

| Package | Harness | Forked from | Tested end to end on |
| ------- | ------- | ----------- | -------------------- |
| 0.2.x | `0.2.1-rc.5` – `0.2.2` | `@deepseek-ai/dsh-tool-subagent@0.2.1-rc.5` | `0.2.1-rc.5`, `0.2.2-alpha.2` |
| 0.1.x | `0.2.0-rc.2` – `0.2.1-alpha.1` | `@deepseek-ai/dsh-tool-subagent@0.2.1-alpha.1` | — |

0.1.0 declares every 0.2 version below 0.3, but it fails to load from harness `0.2.1-alpha.2` on: that release removed `subagents.start()`, `subagents.startContinuable()`, and the `settleRun` export it imports.

### On Harness 0.2.2

The code is upstream 0.2.1's, so on 0.2.2 it keeps 0.2.1's configuration. Upstream 0.2.2 replaced `modelSelectionSettings` with `modelSelection` and `modelDiscovery`, and the 0.2.2 `standard` preset sets the new keys. This fork does not read them: a preset derived from a 0.2.2 host offers no child `provider`/`model`/`reasoning_effort` selection and no `list_subagent_models`, and [`derive-preset.mjs`](../../scripts/derive-preset.mjs) warns when it copies them. `modelSelectionSettings: true` was not exercised on 0.2.2; on that line it reads its projection through the deprecated `sessionProjections.stateOf(session, key)`, which logs one warning.

## Known Limitations and Deferred Work

- **`globalMemory` does not survive a harness restart.** The flag lives in the child's in-memory `AgentOptions`; the child's Session log records its provider, model, and effort, not `globalMemory`. A child resumed with `send_message` after the harness restarts runs without it, so a memory plugin stops giving it global memory.
- **Each fork module lists only its own delegation tools in the system prompt.** Upstream renders one sentence naming every visible delegation tool; with this fork beside upstream's `subagent_fork`, the prompt carries one sentence for `subagent` and another for `subagent_fork`.

### Upgrading from 0.1.x

- **Every delegation is a managed activation.** The tool returns `{ kind: 'activation', subagentId }` at once, and the child's result arrives as a completion notice. The `run_in_background` parameter and the foreground, background, and continuable results are gone.
- **`enableRunInBackground` and `backgroundMode` no longer exist.** Configuration validation keeps unknown keys, so a configuration that still sets them loads and they have no effect; `enableRunInBackground: false` no longer makes calls wait for the result. Remove them.
- **`persona` and `toolFilter` fail activation.** Configure the persona and tool plugins in an Agent Preset and select it with `agentPreset` (spawn provider only). `allowedAgentPresets` offers the model an `agent_preset` parameter.
- **The model may pass `cwd`**, the child's initial working directory.
- **`global_memory` is unchanged**, and so is the [contract for memory plugins](#contract-for-memory-plugins).

## Upstream Lineage

Forked from `@deepseek-ai/dsh-tool-subagent@0.2.1-rc.5` (MIT).

`src/index.ts` is upstream with one patch, every hunk marked `tivility:` — a module augmentation adding `AgentOptions.globalMemory`, the `global_memory` parameter, and the line that adds `globalMemory` to a request that asked for it. `src/list-models.ts`, `src/model-selection.ts` and `src/model-selection-state.ts` are upstream verbatim; `src/model-selection-settings.ts` re-exports upstream's, so the settings service is the host's own.

Keeping the fork that narrow is what makes porting it mechanical: for a new harness line, take upstream's `src/` from that line, re-apply the marked hunks, test it end to end, regenerate the peer range with [`scripts/harness-range.mjs`](../../scripts/harness-range.mjs) (the current one is `node scripts/harness-range.mjs 0.2.2 0.2.1-rc.5 packages/tool-subagent-memory/package.json`), and publish a new minor version. Anything else that differs is drift, and drift is where this fork's earlier bugs came from.
