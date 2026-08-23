# dsh-plugins

Out-of-tree plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Generic, reusable pieces — nothing here depends on any particular product or
deployment. Each package is published independently under `@tivility/dsh-*`.

Upstream does not accept external pull requests
([CONTRIBUTING](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)),
and says so alongside the reason this repository exists:

> We do not believe that packages in the official repository are inherently more
> important than packages created by the community.

## Packages

| Package | What it does |
| ------- | ------------ |
| [`@tivility/dsh-llm-affinity`](packages/llm-affinity) | Puts the harness session id on the wire so a gateway can key per-conversation state (prompt cache, account stickiness, Gemini `thoughtSignature` replay) |
| [`@tivility/dsh-file-viewer`](packages/file-viewer) | Read-only browser preview of workspace files: listings, rendered Markdown, inline media, raw bytes |
| [`@tivility/dsh-readonly-auth`](packages/readonly-auth) | Owner lock for a deployment more than one person can reach; provides the `ownerAuth` service |
| [`@tivility/dsh-file-upload`](packages/file-upload) | Drag-and-drop upload into a workspace, gated by `ownerAuth` when it is installed |
| [`@tivility/dsh-session-share`](packages/session-share) | A link that opens one session instead of wherever the GUI was left |
| [`@tivility/dsh-tool-subagent-model`](packages/tool-subagent-model) | Delegation with per-call `model` / `provider` / `effort`, so one conversation can dispatch subtasks across a fleet |
| [`@tivility/dsh-web-kit`](packages/web-kit) | **Library, not a plugin.** The browser-trust fence, path containment, and static-response plumbing the four web plugins share |

The four web plugins solve one problem between them: the harness's GUI is
reachable from another machine, and nothing that machine can see is a file, a
lock, or a link. Each is useful alone; installed together, `readonly-auth`
becomes the lock the other two consult.

### Presets

`presets/` holds agent presets rather than packages — a preset is a directory
the harness reads from `$DSH_HOME/.agent-presets`, not something npm installs.

| Preset | What it does |
| ------ | ------------ |
| [`standard-subagent-model`](presets/standard-subagent-model) | The shipped `standard` preset, with its two delegation rows pointed at `@tivility/dsh-tool-subagent-model` |

## Install into a profile

```sh
dsh plugin --profile web add @tivility/dsh-llm-affinity
```

Then add its row to `$DSH_HOME/profiles/<name>/cordis.patch.yml`. Each package's
README carries its own configuration.

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

`build` runs `tsc -b` and then each package's own `bundle` script.
`@tivility/dsh-session-share` is the only one with a browser half, and its
bundle must exist before the harness loads it — the client-module scanner
reports a missing bundle at startup rather than degrading.

To use a working copy in a real profile without publishing:

```sh
dsh plugin --profile web add /path/to/dsh-plugins/packages/llm-affinity
```

## Conventions

These follow the harness's own rules, and getting them wrong fails in ways that
are hard to diagnose:

- **`dsh` and `cordis` packages are `peerDependencies` (plus `devDependencies`),
  never `dependencies`.** A second copy of `@deepseek-ai/cordis` in the tree gives
  you a second service registry, and injections silently resolve to nothing.
- **Do not mix plugin export forms.** A service package default-exports its
  service class; a function plugin named-exports `name` / `inject` / `Config` /
  `apply` and has no default export. Mixing them makes the Loader discard the
  function plugin's namespace.
- **Optional services are read with `ctx.get(name)`**, not the `ctx.<name>`
  property proxy, which is topology-sensitive.

## License

MIT
