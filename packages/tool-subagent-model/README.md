# @tivility/dsh-tool-subagent-model

Delegation with per-call **model**, **provider**, and **reasoning effort**. A
drop-in replacement for `@deepseek-ai/dsh-tool-subagent`.

Paired with the [`standard-subagent-model`](presets/standard-subagent-model)
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

### Naming only `model` inherits a *creation-time* route

The harness builds a child's options from `parent.options`, which is the route
the parent agent was **created** with. Switching a session's model afterwards —
the model picker, `session.selectModel` — overrides the request through a
waterfall and does not rewrite `parent.options`. So a parent visibly running on
one provider can hand its child a different one.

Live, that looks like a child failing with `UNKNOWN_MODEL`: the call named
`model` alone, the child inherited a provider that has never heard of it, and
nothing in the parent's own display hinted at the mismatch.

This is the packaged delegation tool's behaviour too — it reads the same
options. The practical rule: **when a model lives on a route other than the
deployment default, name `provider` with it.** Saying so in `routingGuide` is
the cheapest fix, because that is the text the model reads while choosing.

## Seeing what a subagent ran on

A delegation that names a model is only useful if you can tell, afterwards,
which one it named. Three surfaces carry it:

- **The subagent catalog** — a child's persisted label becomes
  `deep audit · claude-fable-5 · effort low`. This is the place a person goes
  to look at subagents, and it is where the route was missing.
- **The started-run line** — `started subagent <id> on claude-fable-5 · effort low`,
  which is the only record of where a background run went until it settles.
- **`presentCall`** — a generic tool-call card titled with the route, for
  clients that render tool-owned call views.

A call that names nothing keeps its plain description: absence of a suffix
reads as *inherited*, and appending that to every label would be noise on the
common case.

### What the Web GUI does not show

The shipped Web client reads a tool-owned call view only for `terminal` and
`diff` cards; a `generic` one is ignored, and its collapsed tool row is titled
from the tool name plus the first string in the arguments. Changing that row
would mean registering a keyed `tool.call.toolview` renderer — which cannot
reuse the client's own `ToolRow`, so the row would lose the chrome (expand,
running sweep, state dot) every neighbouring row has. Carrying the route in the
label and the result line reaches the same reader without a row that looks
foreign.

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

## The preset travels in this package

`presets/standard-subagent-model/` ships inside the tarball, so the preset and
the tool it composes move together — a version of one is never paired with a
version of the other it was not written against.

Presets are discovered by **path**, not by package, so point a root at the
directory this package installs into:

```yaml
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    roots:
      - path: ~/.dsh/profiles/<profile>/node_modules/@tivility/dsh-tool-subagent-model/presets
```

`~` is expanded. From then on `pnpm update` carries every preset change — a
renamed label, a corrected description, a reworked composition — the same way
it carries a code change, and nothing has to be copied by hand.

Three details worth knowing before you rely on it:

**The root is `presets/`, never the package directory.** A root's subdirectories
*are* its presets, and `lib` and `src` are valid preset ids — pointed at the
package root, the picker would grow two entries reported as broken for missing
a composition file.

**A missing root is silent.** `scanRoot` treats `ENOENT` as an empty root, not
an error, so a path typo or an uninstalled package produces no diagnostic
anywhere: the preset simply never appears. Check the picker, not the log.

**Copying still works, and stays behind.** `cp -R` into `$DSH_HOME/.agent-presets/`
is still a preset, and the user root is scanned last — so a copy under the same
id is shadowed by this one rather than overriding it. A hand-copied preset that
predates this package will not receive updates, and will look identical while
not receiving them; delete it once the root is configured.

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
