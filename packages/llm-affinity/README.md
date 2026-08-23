# @tivility/dsh-llm-affinity

Puts the DeepSeek Harness session id on the wire, so a gateway in front of the
model can key per-conversation state.

## The gap this fills

The harness stamps every loop-built request with `GenerateOptions.sessionId`, and
its own contract says an adapter *"may map it to model-hidden transport
metadata"*. `dsh-llm-deepseek` does that — it sends
`x-deepseek-harness-session-id`. `dsh-llm-pi-ai` accepts the field and forwards
it to pi-ai, where it is used only for local resource cleanup, so it never
reaches the wire.

A gateway therefore sees every pi-ai request as one anonymous conversation. Three
things break, in increasing severity:

1. **Prompt caches miss.** Caches are per-account; without affinity a session
   scatters across the account pool and every read misses.
2. **Account stickiness is lost.** Consecutive turns of one conversation land on
   different upstream accounts.
3. **Gemini tool calling fails outright.** Gemini 3 requires the `thoughtSignature`
   attached to a `functionCall` to be echoed in later turns, and neither the
   OpenAI chat-completions nor the Anthropic messages wire format has a field to
   carry it. Gateways work around this by stashing the signed parts server-side,
   keyed by conversation — with no key, the second step of every tool loop is
   rejected as an invalid request.

Observed against a CLIProxyAPI-style gateway, same account and model, one
variable changed:

| request | result |
| --- | --- |
| plain chat | 200 |
| tools declared, no call history | 200 |
| history containing an assistant `tool_calls` message | **400 `invalid_request`** |
| the same, with an affinity key on the request | **200** |

## What it does

Wraps the `llm/stream` waterfall. While a wrapped stream is being pulled, it adds
a header carrying `options.sessionId` to outgoing requests. It does not replace
or subclass any adapter, so it keeps working across adapter changes.

The scope is entered per pull rather than once around the iterator: an async
generator body runs on the consumer's context, so a scope entered at creation
time is already gone when the first chunk — and the HTTP request behind it — is
requested.

Outside a wrapped stream the interceptor is a no-op, and it restores the previous
`fetch` on disposal.

## Configuration

```yaml
- id: llm-affinity
  name: '@tivility/dsh-llm-affinity'
  config:
    header: X-Session-ID
```

| field | default | meaning |
| --- | --- | --- |
| `header` | `X-Session-ID` | Header carrying the session id. This name is accepted by every provider branch of a CLIProxyAPI-style affinity resolver, which is why it is the default. |
| `bodyField` | unset | Also carry the value as a JSON body field — use `prompt_cache_key` for a gateway that reads affinity from the body. Costs a parse and re-serialize per call. |
| `providers` | every route | Restrict to named provider routes. |
| `origins` | every origin | Allowlist of `host` or `host:port` the header may be sent to. Set this if the process also talks to an endpoint that must not see the session id. |
| `separateAuxiliary` | `true` | Give a compaction or session-title request its own value instead of the conversation's. It carries the same session id but a completely different prompt, so sharing the value pollutes a prompt cache keyed on it and lets an auxiliary turn disturb the conversation's turn state. Turn off for a gateway that must see one value per session. |

Order the row **after** the adapter it should cover; the waterfall runs
regardless of adapter identity, so only the `llm` service has to exist first.

## Scope and limits

- The value is the harness session id, which is opaque and carries no user
  content. It still reaches the gateway operator — set `origins` if that matters.
- Requests made outside a loop-built stream (a health probe, model discovery) are
  untouched: they carry no session id.
- `bodyField` rewrites only a string JSON body. A stream or typed-array body is
  passed through with the header alone.

## Gateway expectations

The value is stable for one conversation and unique across conversations — the two properties a gateway needs, whether it uses the key for prompt-cache routing, account stickiness, or per-conversation turn state.

What the plugin deliberately does not do is guess what the gateway wants beyond that. It sends an identity; the gateway decides what to key on it. A gateway that reads none of the configured fields is unaffected — the header is inert.

One caveat worth knowing before you enable this against a gateway that keys durable state on the value: a stable key is what *activates* per-conversation state, so a gateway whose per-conversation state handling is buggy will start failing on the second turn of a conversation where it previously never kept state at all. That is not a fault in this plugin, but it is a change in exposure. Verify a two-turn tool loop before rolling out.

## Known Limitations and Deferred Work

- The transport hook replaces `globalThis.fetch` for the process. It is inert
  outside a wrapped stream and restores the previous value on disposal, but a
  plugin that captures `fetch` by value before this one loads will not see it.
  A per-adapter transport seam upstream would remove the need.
- If `dsh-llm-pi-ai` ever forwards `sessionId` itself, this package becomes
  redundant for that adapter and should be retired rather than kept in parallel.

## License

MIT
