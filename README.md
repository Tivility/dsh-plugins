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
| [`@tivility/dsh-web-kit`](packages/web-kit) | **Library, not a plugin.** The browser-trust fence, path containment, and static-response plumbing the four web plugins share |
| [`@tivility/dsh-file-viewer`](packages/file-viewer) | Read-only browser preview of workspace files: listings, rendered Markdown, inline media, raw bytes |

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
