# @tivility/dsh-compaction-window

Per-session working context window and compaction settings for DeepSeek Harness.

Targets the DeepSeek Harness **0.2** line — `0.2.0-rc.2` and every later 0.2 prerelease or release, below 0.3.

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

On DeepSeek Harness 0.2 the row this package replaces lives **inside each agent preset** — in `dsh web` the host-level copy is disabled. Two things that look like they should install it do not:

- a profile patch with the same `id` and this package's `name` is skipped (`patch: name mismatch … skipping`, logged once at boot);
- a profile patch cannot address a row inside a preset at all.

So it is installed by declaring a preset: a shipped one, with its `compaction-basic` row renamed to this package. [`scripts/derive-preset.mjs`](../../scripts/derive-preset.mjs) derives it from the composition the host is running, so nothing is copied that could fall behind a harness release:

```sh
dsh --profile web --dump-config \
  | node scripts/derive-preset.mjs --dsh <dsh install dir> --id memory --name 记忆模式 --with compaction-window \
  > /tmp/memory-preset.yml
```

Add the generated row to `~/.dsh/profiles/web/cordis.patch.yml` (replacing the file if it holds only `[]`) and restart. The preset appears in the picker; one that cannot mount shows its reason there instead of silently falling back.

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
        headroomTokens: 8000   # see "Headroom is absolute" — required at this size
```

| Field | Default | Description |
| --- | --- | --- |
| `contextWindow` | unset (model's real window) | Working context window cap; clamped to model's real window. Positive integer. Also accepted on each `modelPolicies` entry. |
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

## Headroom is absolute

`headroomTokens` is a token count, not a fraction, and its default of 65,536 is sized for physical windows in the hundreds of thousands. A working window has to leave room for it **and** for the request's completion reservation before any pressure can be measured. With a 32k reservation and the default headroom, a working window needs to exceed roughly 110k; at 128k the threshold is only about 30k.

The base engine's answer to a window that cannot work is a log warning and a turn that continues uncompacted — compaction silently stops. So this plugin refuses such settings where they are made instead:

- **At activation**, a configured `contextWindow` (top-level or per model) that cannot work even with no completion reservation fails the load, naming the setting.
- **`setSessionSettings`** checks the merged settings against the session's own model and reservation, and rejects them without writing anything.
- **`effectiveSettings`** returns a `problem` when the current combination cannot work — the one case neither check above can see in advance, a configured window that only fails for a particular model's reservation.

Lower `headroomTokens` (and retention) along with the window: `contextWindow: 64000, headroomTokens: 8000` works where `contextWindow: 64000` alone never can.

## How it relates to `compaction-basic`

It is `BasicCompactionEngine`, not a copy of it. `compactIfNeeded` calls the base engine's own implementation with two inputs adjusted for that call: the conversation model's context window capped at the working window, and the session's overrides expressed as an ordinary model policy. The compaction lock, tool-result pruning, retries, and the warning dedupe all stay the harness's code, at whatever version the host runs.

That is the forward-compatibility property worth having. A fix to the base engine reaches this plugin without a release of it; a re-implementation would have to be re-copied by hand, and an earlier version of this package that did exactly that had already drifted — it lost the base engine's compaction-lock recheck.

The arithmetic in `src/math.ts` mirrors the base engine's and is used only to validate settings and report `effectiveSettings`; the decision to compact is never made by it.

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

Every setting, `contextWindow` included, resolves in the same order:
1. **Session settings** (via `setSessionSettings`)
2. **Model policies** (`modelPolicies` matching `provider/model`)
3. **Plugin config** (top-level `contextWindow`, `thresholdRatio`, etc.)
4. **Model real window / DSH defaults**

The working window is then clamped to the model's real one. An adapter that reports no window uses the working window as is.

With no configuration or session overrides, the service behaves identically to `@deepseek-ai/dsh-compaction-basic`.

## License

MIT
