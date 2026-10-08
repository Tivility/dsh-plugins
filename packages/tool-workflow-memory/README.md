# @tivility/dsh-tool-workflow-memory

> Target line: **DeepSeek Harness 0.2** (`>=0.2.0-rc.2`)

Model-facing workflow tool and PTC workflow engine for DeepSeek Harness 0.2 with per-call global memory control.

This plugin is a drop-in replacement for `@deepseek-ai/dsh-tool-workflow` and `@deepseek-ai/dsh-workflow-ptc` (0.2 line). It adds a `globalMemory` option to the guest workflow `agent(prompt, opts)` function, allowing individual subagents spawned within a workflow script to request the caller's global memory.

## Behavior

- **`agent(prompt, { globalMemory: true })`**: Passes `globalMemory: true` in the child's `AgentOptions` (`agentOptions.globalMemory = true`). A memory plugin observing agent creation can inspect `agent.options.globalMemory` to decide whether to inject global memory into the child subagent.
- **`globalMemory: false` or omitted**: `globalMemory` is `false`. The child subagent does not receive global memory.
- **`run_in_background`**: Defaults to `true` (as in background-enabled configurations), allowing long-running workflows to return a job ID immediately.
- Includes `PtcWorkflowEngine`, an enhanced TypeScript/Node PTC workflow runtime engine that parses and forwards `globalMemory` from workflow scripts to subagent invocations.

## Contract for Memory Plugins

This package establishes a product-neutral contract between workflow execution and memory plugins:

1. **Option Propagation**: When a workflow script calls `agent(prompt, { globalMemory: true })`, the guest runner validates `opts.globalMemory` (must be a boolean) and forwards it to the host engine bindings, which passes `{ globalMemory: true }` in `agentOptions` to `subagents.start()`.
2. **Consumption**: Any memory plugin (or system prompt provider) can inspect `agent.options.globalMemory` on the newly created subagent.

### Example: Memory Plugin Consuming `globalMemory`

```typescript
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'memory:global',
    text: async (promptContext) => {
      const agent = promptContext.scope as Agent;

      // Check if this is a child subagent spawned by a workflow or subagent tool
      const isChild = agent.session.header.origin === 'subagent';
      const wantsGlobalMemory = agent.options?.globalMemory === true;

      if (isChild && !wantsGlobalMemory) {
        // Child subagent without explicit globalMemory flag: omit global memory
        return '';
      }

      // Inject global memory content
      return '<global_memory>\n...\n</global_memory>';
    },
  });
}
```

## Upstream Lineage

- Upstream packages: `@deepseek-ai/dsh-tool-workflow@0.2.0-rc.2`, `@deepseek-ai/dsh-workflow-ptc@0.2.0-rc.2`
- Modified source files: `src/index.ts` (tool definition), `src/engine.ts` (`PtcWorkflowEngine` and `PtcWorkflowRun`), `src/guest-source.ts` (guest script allowing `globalMemory` in `SUPPORTED_AGENT_OPTIONS`), `src/record.ts` (workflow recorder mirror).
