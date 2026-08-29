# Adapter Authoring

## Minimal Contract

```js
import { defineAdapter, probeCommand } from "@orbtex-ai/orbtex-adapter-sdk";

export const adapter = defineAdapter({
  metadata: {
    type: "my-provider",
    capabilities: ["session.serialize", "tool.canonical"]
  },
  probe: () => probeCommand("my-provider"),
  async *invoke(request) {
    yield { type: "session.update", payload: { providerSession: { sessionId: "..." } } };
    yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { type: "message.delta", payload: { text: "result" } };
    yield { type: "message.update", payload: { role: "assistant", status: "completed" } };
    yield { type: "run.finished", payload: {} };
  }
});
```

Register it in `config/adapters.json` with module and export name. The host verifies manifest type against `metadata.type`。

## Rules

1. Native protocol parsing stays in adapter; core never imports provider packages.
2. Report provider session through `session.update`, not terminal payload or workdir file.
3. Never emit provider raw event names as canonical event types.
4. Emit create before delta when possible；host only supplies a safety fallback.
5. Yield one terminal event；host delays it until generator cleanup completes.
6. Respect `request.signal` and terminate the provider process tree on abort.
7. Put control instructions in provider-native system/developer/config channels when possible.
8. Do not put token values in argv, prompt, event payload or workdir。
9. Declare only capabilities actually implemented。

## Required Tests

- probe found/not found。
- native session ID -> session.update。
- text, analysis, tool, usage and provider error fixtures。
- success, nonzero exit, missing terminal, cleanup error and cancel。
- new session + resume session command shape。
- private prompt carrier is mode 0600 and removed after invoke。
- live read-only smoke test against a pinned provider version。

`test/adapters.test.js` and `test/host.test.js` are the reference contract suite。
