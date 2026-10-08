# @tivility/dsh-compaction-window

Per-session working context window and compaction settings for DeepSeek Harness.

Targets DeepSeek Harness **0.2.x** (`@deepseek-ai/dsh-* >=0.2.0-rc.2`).

Provides the `compaction` service as a drop-in replacement for `@deepseek-ai/dsh-compaction-basic`. It reuses `BasicCompactionEngine` and the harness's native pressure and retention budget arithmetic while adding working context window caps and per-session dynamic configuration.

## The gap this fills

Large-context models (such as 1M models) have high context limits, but practical agent workflows often benefit from compacting much earlier (e.g. at a 272k working window) to keep response latency, reasoning attention, and prompt cache performance optimal. Upstream `dsh-compaction-basic` calculates compaction pressure strictly against the model's physical window declared by the LLM adapter.

`@tivility/dsh-compaction-window` allows:
1. Setting a global default or model-specific `contextWindow` working budget in plugin configuration.
2. Dynamically overriding `contextWindow`, `thresholdRatio`, `retainRatio`, `retainTokens`, and `headroomTokens` on individual sessions via service methods.
3. Automatically persisting session settings via session projections so they survive reload and replay.
4. Guaranteeing that the effective working window is clamped to the model's actual physical capacity: `effective = min(working, model's real window)`.

## Installation

```sh
dsh plugin add @tivility/dsh-compaction-window
```

Replace `@deepseek-ai/dsh-compaction-basic` in your profile or agent preset configuration with `@tivility/dsh-compaction-window`.

## Configuration

Accepts everything `@deepseek-ai/dsh-compaction-basic` accepts, plus `contextWindow`:

```yaml
- id: compaction
  name: '@tivility/dsh-compaction-window'
  config:
    contextWindow: 272000
    thresholdRatio: 0.8
    headroomTokens: 65536
    retainRatio: 0.16
    auto: true
    modelPolicies:
      - provider: deepseek
        model: deepseek-chat
        contextWindow: 64000
```

| Field | Default | Description |
| --- | --- | --- |
| `contextWindow` | unset (model's real window) | Working context window cap; clamped to model's real window. Positive integer. |
| `thresholdRatio` | `0.8` | Fraction of effective window triggering compaction. |
| `headroomTokens` | `65536` | Additional pressure headroom beyond reserved completion tokens. |
| `retainRatio` | `0.16` | Verbatim recent context fraction retained. Mutually exclusive with `retainTokens`. |
| `retainTokens` | unset | Absolute recent token budget retained verbatim. |
| `summarizationProvider` | conversation's | LLM provider for summarization. |
| `summarizationModel` | conversation's | LLM model for summarization. |
| `maxTokens` | resolved `headroomTokens` | Completion token cap for summarization calls. |
| `compactionRetries` | `1` | Extra attempts after initial compaction when pressure remains above threshold. |
| `maxOverflowRetries`| `1` | Recovery attempts on context overflow. |
| `modelPolicies` | `[]` | Exact provider/model overrides. |
| `auto` | `true` | Enable automatic step-boundary and overflow compaction listeners. |

## Service API

When mounted, `ctx.compaction` exposes the standard `CompactionEngine` methods along with session-level settings:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

// Set per-session working window and retention/pressure settings
await ctx.compaction.setSessionSettings(session, {
  contextWindow: 128_000,
  thresholdRatio: 0.75,
  retainTokens: 10_000,
  headroomTokens: 20_000,
})

// Clear session overrides
await ctx.compaction.clearSessionSettings(session)

// Inspect effective settings with source provenance ('session' | 'modelPolicy' | 'config' | 'default')
const effective = await ctx.compaction.effectiveSettings(session)
console.log(effective.contextWindow) // { value: 128000, source: 'session' }
console.log(effective.realContextWindow) // 1000000
```

### Precedence

Settings resolve in the following order:
1. **Session settings** (via `setSessionSettings`)
2. **Model policies** (`modelPolicies` matching `provider/model`)
3. **Plugin config** (top-level `contextWindow`, `thresholdRatio`, etc.)
4. **Model real window / DSH defaults**

With no configuration or session overrides, the service behaves identically to `@deepseek-ai/dsh-compaction-basic`.

## License

MIT
