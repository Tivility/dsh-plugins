# @tivility/dsh-tool-subagent-model

Delegation with per-call **model**, **provider**, and **reasoning effort**. A
drop-in replacement for `@deepseek-ai/dsh-tool-subagent`.

Paired with the [`standard-subagent-model`](../../presets/standard-subagent-model)
preset, which is the shipped `standard` composition with its two delegation rows
pointed here.

## The gap this fills

The main agent runs on whatever model the session is routed to — a compromise
that has to be good enough at everything the conversation might need. A
delegated subtask is not a compromise: it is one known shape of work, and the
best model for it is usually not the one you happen to be running.

The packaged tool routes every child to the parent's model. This one takes the
route per call:

```
subagent(description: "audit the auth flow",
         prompt: "…", model: "<reasoning model>", effort: "high")

subagent(description: "rename 40 call sites",
         prompt: "…", model: "<small and cheap>")
```

The main agent's own route never changes.

## How the three selectors compose

`model` and `provider` ride `AgentOptions`, which the harness merges field by
field onto the parent's:

| Call | Child provider | Child model |
| --- | --- | --- |
| neither given | parent's | parent's |
| `model` only | **parent's** | given |
| both given | given | given |

So naming a model is normally enough; `provider` matters only when the model
lives on a route the parent is not using.

## `effort` needed its own seam

`AgentOptions` is `provider`, `model`, `maxTokens` — there is no effort field,
**and adding one to the object is not enough**: the loop builds its first
request config from *named* fields, never by spreading the options, so an
unknown key is dropped in silence. The harness's own error text names the way
in — *"supply both via the agent/request waterfall"* — and that is what this
package uses.

The listener has to know which child an effort belongs to, and the child's id
does not exist until the delegation has started. Correlating afterwards is a
race: the default run mode is background, and a continuable child may take its
first turn as soon as it is accepted.

So the effort travels **on the child itself**, as an extra `AgentOptions` field
present from the moment the agent is created. That is the harness's own pattern
rather than a trick played on it: `AgentOptions` is documented as
merge-extensible, and `@deepseek-ai/dsh-subagent` already augments it with
`subagentDepth` and reads it back off `agent.options`.

Nothing is needed after the first request. That request logs a header carrying
the effort, and the loop restores an effort from the header on later steps
whenever the route still matches — so the child keeps it for the rest of its
life, cold resume included.

### Effort is per-delegation; model is inherited

The harness copies only `provider`, `model`, and `maxTokens` from a parent's
options to a child's. A subagent that delegates further therefore inherits the
model but **not** the effort — it names its own, or gets the model's default.
The asymmetry is the harness's; this package does not paper over it, and the
prompt section says so.

### An unsupported effort fails loudly

The harness rejects it at `prepareCall`, before any request goes out, naming the
efforts that model does offer. There is no silent fallback. Which efforts a
model accepts is exactly what `routingGuide` is for.

## Runtime coupling: none

Every harness import is `import type`, which TypeScript erases — the built
JavaScript imports nothing from the harness and reaches everything through
`ctx`. That matters because this plugin is driven from an agent preset, and a
preset is a snapshot nobody updates for you: a value import would turn a harness
upgrade into a broken agent found at runtime instead of a diff to review.

Types still bind to a pinned version, so the same upgrade surfaces where it
belongs — as a compile error here. That is the half the previous
self-contained-`.mjs` shape gave up; keeping the runtime property while getting
the types back is why this is a package.

It also means no `defineTool`: the tool definition is a plain object with
hand-written JSON Schema and the argument validator in `validateArgs`.

The one runtime dependency is `@deepseek-ai/schemastery`, the standalone schema
library used for plugin configuration. It is versioned independently of the
harness and carries none of its contracts.

## Configuration

Same as the packaged tool, plus `routingGuide`:

```yaml
- id: tool-subagent
  name: '@tivility/dsh-tool-subagent-model'
  config:
    provider: spawn            # required: the ctx.subagents provider
    toolName: subagent
    backgroundMode: continuable
    maxDepth: 3
    routingGuide: |
      ## Subagent model routing
      | Task shape | Model | Effort |
      | --- | --- | --- |
      | Deep reasoning | <id> | high |
```

`routingGuide` is appended to the delegation prompt section verbatim. Leave it
empty and the tool still works; the model just chooses on its own.

`agentOptions` sets row-level child defaults, which a per-call `model` overrides
field by field. A row-level *effort* is deliberately not offered — effort is a
per-subtask decision, and a default would quietly apply to delegations that
never asked for one.

## License

MIT
