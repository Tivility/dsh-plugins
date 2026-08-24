# 混动模式

An agent preset: the shipped `standard` composition with one change — the
delegation tools let each call pick the model, the provider, and the reasoning
effort the subagent runs at.

The tool itself is
[`@tivility/dsh-tool-subagent-model`](../../packages/tool-subagent-model); this
directory is only the two files that make a preset.

## What it is for

The main agent runs on whatever model the session is routed to. That model is a
compromise: good enough at everything the conversation might need. A delegated
subtask is not a compromise — it is one known shape of work, and the best model
for it is usually not the one you happen to be running.

```
subagent(description: "audit the auth flow",
         prompt: "…",
         model: "<a reasoning model>", effort: "high")

subagent(description: "rename 40 call sites",
         prompt: "…",
         model: "<something small and cheap>")
```

The main agent's own route never changes.

## Installing

Two steps, because the tool is a package and the preset is a directory.

```sh
dsh plugin --profile web add @tivility/dsh-tool-subagent-model
cp -R standard-subagent-model "$DSH_HOME/.agent-presets/"
```

Then pick it in the session's preset selector. Presets are re-read per call, so
a new one appears without restarting the host — but the package install needs a
host restart, since that is a profile dependency.

To develop against a working copy instead of the registry:

```sh
dsh plugin --profile web add /path/to/dsh-plugins/packages/tool-subagent-model
```

## Fill in the routing guide

`routingGuide` in `agent.cordis.yml` is empty on purpose. It is appended to the
delegation prompt verbatim, and what belongs there is *your* fleet: which models
are reachable, which are good at what, which efforts each accepts, which do not
honor tool schemas, what each costs.

Those are facts about one deployment, and a wrong table is worse than no table
because the model will follow it. Something like:

```yaml
        routingGuide: |
          ## Subagent model routing

          | Task shape | Model | Effort | Notes |
          | --- | --- | --- | --- |
          | Deep reasoning, tricky debugging | <id> | high | slow; worth it when correctness dominates |
          | Implementation, refactors | <id> | medium | |
          | Bulk mechanical work | <id> | — | cheap; fan out several |

          - <id> does not reliably honor tool schemas; do not send it
            structured-output work.
          - Anything not listed is untested. Inherit instead of guessing.
```

## Three things worth knowing

**Name `provider` alongside `model` when they differ from the default.** A
child inherits the route its parent agent was *created* with, not the one the
session was later switched to — so `model` alone can land on a provider that
has never heard of it. Put the pairing in `routingGuide`; that is the text the
model reads while choosing.

**Effort applies to one delegation.** The harness copies only `provider`,
`model`, and `maxTokens` from a parent's options to a child's, so a subagent
that delegates further does not inherit its own effort — it names one or gets
the model's default. Model and provider *are* inherited down the chain.

**A nested subagent can still choose.** A child joins its parent's preset mount,
so it gets this same tool and can pick a model for its own subagents, down to
the `maxDepth` cap (3 by default: you → child → grandchild, and the fourth level
is refused).

**An unsupported effort fails loudly.** The harness rejects it before the
request is made, naming the efforts that model does offer. It does not silently
fall back.

## After a harness upgrade

`agent.cordis.yml` is a **snapshot** of the shipped `standard` composition, and
nothing updates it for you. A release that adds or changes a row in `standard`
leaves this preset on the old set:

```sh
diff <path-to-dsh>/apps/cli/config/agent-presets/standard/agent.cordis.yml agent.cordis.yml
```

Re-copy and redo the two-row swap. The tool package updates on its own through
npm — that is the point of it not living here.
