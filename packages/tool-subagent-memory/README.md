# @tivility/dsh-tool-subagent-memory

> Target line: **DeepSeek Harness 0.2** (`>=0.2.0-rc.2`)

Model-facing delegation tool for DeepSeek Harness 0.2 with per-call global memory control.

This plugin is a drop-in replacement for `@deepseek-ai/dsh-tool-subagent` (0.2 line). It adds a `global_memory` parameter to the `subagent` tool, allowing the caller to decide whether the child subagent should receive the user's global memory.

## Behavior

- **`global_memory: true`**: Passes `globalMemory: true` in the child's `AgentOptions` (`request.agentOptions.globalMemory = true`). A memory plugin observing agent creation can inspect `agent.options.globalMemory` to decide whether to inject global memory into the child subagent.
- **`global_memory: false` or omitted**: `globalMemory` is `false`. The child subagent does not receive global memory.
- Supports all standard features of `@deepseek-ai/dsh-tool-subagent` 0.2.0-rc.2, including continuable background executions, foreground execution, and optional model selection (`provider`, `model`, `reasoning_effort`).

## Contract for Memory Plugins

This package establishes a product-neutral contract between delegation tools and memory plugins:

1. **Option Propagation**: When the model calls `subagent` with `global_memory: true`, the tool attaches `{ globalMemory: true }` to `AgentOptions` passed to `subagents.start()` or `subagents.startContinuable()`.
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
      
      // Top-level sessions always get global memory
      const isChild = agent.session.header.origin === 'subagent';
      const wantsGlobalMemory = agent.options?.globalMemory === true;

      if (isChild && !wantsGlobalMemory) {
        // Child subagent without explicit global_memory flag: omit global memory
        return '';
      }

      // Inject global memory content
      return '<global_memory>\n...\n</global_memory>';
    },
  });
}
```

## Upstream Lineage

- Upstream package: `@deepseek-ai/dsh-tool-subagent@0.2.0-rc.2`
- Modified source files: `src/index.ts` (added `global_memory` parameter and passed `globalMemory` to `agentOptions`), `src/list-models.ts`, `src/model-selection.ts`, `src/model-selection-state.ts`, `src/model-selection-settings.ts`.
