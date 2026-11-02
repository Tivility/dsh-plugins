# @tivility/dsh-tool-workflow-memory

Targets DeepSeek Harness **0.2.1 and 0.2.2** — from `0.2.1-rc.5` through the 0.2.2 release. dsh refuses to install or activate it on any other harness version; see [Harness Versions](#harness-versions).

Model-facing workflow tool and PTC workflow engine for DeepSeek Harness 0.2 with per-call global memory control.

This plugin is a drop-in replacement for `@deepseek-ai/dsh-tool-workflow` and `@deepseek-ai/dsh-workflow-ptc` (0.2 line). It adds a `globalMemory` option to the guest workflow `agent(prompt, opts)` function, allowing individual subagents spawned within a workflow script to request the caller's global memory.

## Installation

```sh
dsh plugin add @tivility/dsh-tool-workflow-memory
```

On DeepSeek Harness 0.2 the row this package replaces lives **inside each agent preset** — in `dsh web` the host-level copy is disabled. Two things that look like they should install it do not:

- a profile patch with the same `id` and this package's `name` is skipped (`patch: name mismatch … skipping`, logged once at boot);
- a profile patch cannot address a row inside a preset at all.

So it is installed by declaring a preset: a shipped one, with its `workflow-ptc` row renamed to `@tivility/dsh-tool-workflow-memory/engine` and its `tool-workflow` row to this package. [`scripts/derive-preset.mjs`](../../scripts/derive-preset.mjs) derives it from the composition the host is running, so nothing is copied that could fall behind a harness release:

```sh
dsh --profile web --dump-config \
  | node scripts/derive-preset.mjs --dsh <dsh install dir> --id memory --name 记忆模式 --with tool-workflow-memory \
  > /tmp/memory-preset.yml
```

Add the generated row to `~/.dsh/profiles/web/cordis.patch.yml` (replacing the file if it holds only `[]`) and restart. The preset appears in the picker; one that cannot mount shows its reason there instead of silently falling back.

## Behavior

- **`agent(prompt, { globalMemory: true })`** sets `agentOptions.globalMemory = true` on that child. A memory plugin decides what that means — see the contract below.
- **Omitted or `false`** sends no `agentOptions` for that child unless `provider`/`model` were given, exactly as upstream does. A non-boolean value ends the script with `INVALID_ARGUMENT`, like every other malformed option.
- **Providers without the `agentOptions` capability** still run ordinary `agent()` calls. Asking for `globalMemory` through one is refused by the harness, as asking for `provider`/`model` already is.
- **`run_in_background` defaults to `false`**, as upstream: the call waits for the workflow unless the model asks otherwise. `enableRunInBackground` only decides whether the parameter is offered.

## Contract for Memory Plugins

This package establishes a product-neutral contract between workflow execution and memory plugins:

1. **Option Propagation**: When a workflow script calls `agent(prompt, { globalMemory: true })`, the guest runner validates `opts.globalMemory` (must be a boolean) and forwards it to the host engine bindings, which add `globalMemory: true` to the `agentOptions` of the request passed to `subagents.startActivation()`.
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
| 0.2.x | `0.2.1-rc.5` – `0.2.2` | `@deepseek-ai/dsh-workflow-ptc@0.2.1-rc.5`, `@deepseek-ai/dsh-tool-workflow@0.2.1-rc.5` | `0.2.1-rc.5`, `0.2.2-alpha.2` (including `executionMode: vm-script`) |
| 0.1.x | `0.2.0-rc.2` – `0.2.1-alpha.1` | `@deepseek-ai/dsh-workflow-ptc@0.2.1-alpha.1`, `@deepseek-ai/dsh-tool-workflow@0.2.1-alpha.1` | — |

0.1.0 declares every 0.2 version below 0.3, but from harness `0.2.1-alpha.2` on every `agent()` call fails: that release removed the `subagents.start()` the engine calls.

Harness 0.2.2 adds a `script` PTC program format, used by the Node runtime's `executionMode: vm-script`, which rejects the engine's top-level `return`. The engine carries upstream 0.2.2's program-format mapping as a marked hunk, so it runs under every 0.2.2 program format, and a format it does not know fails the workflow with an error that names it.

### Upgrading from 0.1.x

The tool's configuration and the `agent()` options are unchanged. The engine now:

- **Requires the `workingDirectory` service.** Every harness composition that provides `subagents` also provides it.
- **Runs the workflow script in the calling agent's working directory**, and starts each `agent()` child there, instead of in the workspace root.
- **Refuses to run under a PTC runtime that cannot enforce the file policy**, unless the policy is `danger-full-access`.

## Upstream Lineage

Forked from `@deepseek-ai/dsh-workflow-ptc@0.2.1-rc.5` and `@deepseek-ai/dsh-tool-workflow@0.2.1-rc.5` (MIT), every hunk marked `tivility:`.

- `src/ptc/` is the engine, upstream file for file. `host.ts` and `types.ts` carry `globalMemory` from the guest's request into `agentOptions`, and `host.ts` also carries upstream 0.2.2's program-format mapping, which a re-fork from 0.2.2 or later drops; `guest-source.ts` is upstream's guest with `globalMemory` accepted by `agent()` — patched in decoded form and re-encoded, so the diff against upstream's guest is exactly those lines. Upstream's `guest.ts`, the guest's TypeScript source, is not carried: only the generated string runs.
- `src/` is the tool, upstream file for file; `index.ts` differs in its name and in the one line of the description that lists `agent()` options.

Narrow on purpose. For a new harness line, take upstream's two `src/` directories from that line, re-apply the marked hunks, test it end to end, regenerate the peer range with [`scripts/harness-range.mjs`](../../scripts/harness-range.mjs) (the current one is `node scripts/harness-range.mjs 0.2.2 0.2.1-rc.5 packages/tool-workflow-memory/package.json`), and publish a new minor version; anything else that differs is drift.
