# Iris Router — Plugin Interface

This is the exact contract other Obsidian plugins use to talk to `obsidian-iris-router`. The router exposes itself on the Obsidian `App` object as `app.irisRelay`. It is not a published npm package — there are no imports, just structural typing against this surface.

## Detection

```ts
const relay = (this.app as any).irisRelay;
if (!relay) {
  new Notice("Iris Router plugin is not enabled.");
  return;
}
```

The router sets `app.irisRelay` in `onload` and deletes it in `onunload`. If the user disables the router, the property disappears — re-check before each call rather than caching the reference for long.

If your plugin can load before the router does, also handle the case where `relay` exists but `anthropicApiKey` is unset; `request()` will throw `Iris Relay: no API key configured.` Surface that as a Notice telling the user to fill in the router settings.

## Two modes

| | **Sync** (`request`) | **Batch** (`enqueueBatch` + `flushBatch`) |
|---|---|---|
| Latency | seconds | up to 24h |
| Cost | full price | 50% discount |
| Promise? | yes — `await` it | no — register a handler |
| Survives Obsidian restart? | no | yes (queued + in-flight) |
| Good for | interactive UI, anything blocking the user | bulk indexing, background tagging, summaries |

Use sync for anything the user is actively waiting on. Use batch for everything else.

## Sync requests

### Method

```ts
relay.request(body: object, options?: RequestOptions): Promise<Record<string, unknown>>
```

`body` is a standard Anthropic `/v1/messages` request body. The router validates it and strips unknown keys. **Required fields:** `model`, `max_tokens`, `messages`. **Allowed:** `system`, `temperature`, `tools`, `tool_choice`, `top_p`, `top_k`, `stop_sequences`. Anything else is silently dropped. `stream: true` is dropped with a console warning — streaming is not supported.

`max_tokens` is capped at 32768. The router automatically adds prompt-caching `cache_control` markers to the last `system` block and the last `tool` (so you do not need to set them yourself).

### `RequestOptions`

```ts
interface RequestOptions {
  callerId?: string;        // your plugin id, e.g. "iris-tagger". REQUIRED IN PRACTICE
                            // — defaults to "?" but you'll be invisible in the live
                            // modal and per-caller stats. Always set it.
  priority?: number;        // 0 (highest) to 10 (lowest). Default 5.
                            // Lower priority entries jump ahead in the queue.
  trivial?: boolean;        // true → use the user's "trivial" API key if set.
                            // For cheap, high-volume calls (e.g. nickname generation).
                            // Falls back to the main key if no trivial key configured.
  signal?: AbortSignal;     // standard abort. If aborted while queued, the entry is
                            // removed and the promise rejects with "request aborted".
                            // If aborted while in-flight, the HTTP call still
                            // completes (Obsidian's requestUrl can't be torn down)
                            // but the promise rejects.
  batch?: false;            // setting this to true throws — use enqueueBatch instead
}
```

### Return value

The full Anthropic response JSON. Notable fields you'll usually want:

```ts
const resp = await relay.request(body, { callerId: "iris-tagger" });
const text = (resp.content as any[])
  .filter(b => b.type === "text")
  .map(b => b.text)
  .join("");
const inputTokens = (resp.usage as any).input_tokens;
const outputTokens = (resp.usage as any).output_tokens;
```

### Errors

Always wrap in try/catch. Possible error messages (all start with `Iris Relay:`):

- `no API key configured.` — user has not filled in settings
- `queue full, try again later.` — 64 entries queued; back off and retry later
- `missing or invalid 'model' field.` / `missing or invalid 'max_tokens' field.` / `missing or empty 'messages' field.` — body validation failed
- `request aborted.` — your `signal` fired
- `request cancelled.` — user clicked the ✕ in the live modal
- `request timed out after Ns` — exceeded the user's configured timeout
- `rate limited (429), backing off Ns` / `overloaded (529), ...` — surfaced after retries are exhausted; the router will already have backed off and retried twice
- `<api error message>` — anything 4xx other than 429 (these are not retried)
- `server error 5xx` — surfaced after retries exhausted
- `all retries exhausted` — fallback when something pathological happened

### Built-in features (free)

- **Response cache**: 60s, 64 entries, in-memory. Identical requests within the window return immediately.
- **Prompt caching**: `cache_control` is auto-injected on `system` and `tools`.
- **Retry**: 2 retries with exponential backoff for 429/529 and 5xx and timeouts.
- **Concurrency**: derived from the rate-limit headers, capped at 8 per key.

### Minimal example

```ts
async function summarize(text: string): Promise<string> {
  const relay = (this.app as any).irisRelay;
  if (!relay) throw new Error("Iris Router not enabled");
  const resp = await relay.request({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: "You are a terse summarizer.",
    messages: [{ role: "user", content: text }],
  }, {
    callerId: "iris-summarizer",
    priority: 5,
    trivial: true,   // it's a small cheap call
  });
  return (resp.content as any[]).filter(b => b.type === "text").map(b => b.text).join("");
}
```

## Batch requests

Batch mode is async. Promises do not survive an Obsidian restart, so the API is not promise-based — instead you register a handler keyed on your plugin id, and the router calls it whenever results arrive.

### Methods

```ts
relay.enqueueBatch(body: object, opts: BatchEnqueueOptions): void
relay.flushBatch(opts?: { trivial?: boolean }): Promise<string | null>
relay.onBatchResult(callerId: string, handler: BatchResultHandler): () => void
```

### `BatchEnqueueOptions`

```ts
interface BatchEnqueueOptions {
  customId: string;      // YOUR id for this request — must be unique within
                         // your callerId namespace. You'll get this back in
                         // the result handler so you know which note/task
                         // it corresponds to. Anthropic-allowed: alphanumeric,
                         // underscore, dash, up to 64 chars.
  callerId: string;      // your plugin id — same one you'll register a handler under
  trivial?: boolean;     // use trivial key. Note: each flush submits ONE batch,
                         // so trivial and main entries become two separate batches.
}
```

### Lifecycle

1. **Enqueue** — `relay.enqueueBatch(body, { customId, callerId })`. The body is validated immediately (so bad bodies throw synchronously). Entry is persisted to disk.
2. **Register handler** — call `relay.onBatchResult(callerId, handler)` once per Obsidian session, ideally during your plugin's `onload`. Handlers are not persisted; you must re-register on every load.
3. **Flush** — call `relay.flushBatch()` (or `flushBatch({ trivial: true })`) to submit. This is the *only* way to submit — the router will never auto-flush. Returns the Anthropic batch id, or `null` if the queue was empty for that key. Throws on submit failure (network, auth, etc.); the queue is preserved so you can retry.
4. **Polling** — the router polls every 30s for the first 5 minutes, then every 2 minutes. State is persisted, so polling resumes after a restart.
5. **Dispatch** — when a batch ends, results are parsed and your handler is called once per `customId`. Pending state is cleared from disk.

### Handler signature

```ts
type BatchResult =
  | { ok: true; response: Record<string, unknown> }   // full Anthropic message
  | { ok: false; error: string };

type BatchResultHandler = (customId: string, result: BatchResult) => void;
```

`onBatchResult` returns a disposer:

```ts
const dispose = relay.onBatchResult("iris-tagger", (customId, result) => {
  if (result.ok) {
    const text = (result.response.content as any[])
      .filter(b => b.type === "text").map(b => b.text).join("");
    // ... look up the note this customId corresponds to and apply
  } else {
    console.warn(`tag batch ${customId} failed: ${result.error}`);
  }
});
this.register(dispose);   // Plugin.register cleans this up on unload
```

### Late results

If a result arrives before any handler is registered (e.g. router polled immediately on load, your plugin loaded after the router), the result is **buffered in memory** under `callerId` and replayed when you call `onBatchResult`. The buffer is *not* persisted — it only survives within a single Obsidian session. If results land while no handler is registered AND Obsidian then quits, they are lost.

**Practical rule:** register your handler in your plugin's `onload`, before doing anything else. Don't wait until the user triggers something.

### Restart semantics

| Event | Survives restart? |
|---|---|
| `enqueueBatch` entry (not yet flushed) | ✅ persisted in plugin data.json |
| Batch id submitted via `flushBatch` | ✅ persisted; polling resumes on next load |
| Buffered result waiting for handler | ❌ in-memory only |
| `onBatchResult` handler registration | ❌ must re-register every load |
| Token usage / per-caller stats / history | ❌ in-memory only |

### Re-issuing custom ids

The router treats `customId` as opaque. It's your job to ensure uniqueness within your `callerId`. If you re-use a customId across two different enqueues in the same batch, Anthropic will reject the submission. Across separate batches (different `flushBatch` calls), it's fine.

### Errors per result

The handler distinguishes succeeded / errored / canceled / expired by mapping all non-success cases into `{ ok: false, error }`. The error string is one of:
- the API error message (errored)
- `"canceled"` — batch was cancelled (e.g. via the live modal)
- `"expired"` — Anthropic dropped the batch after 24h
- `"unknown result type"` — should never happen, but defensive

### Minimal example

```ts
class MyTagger extends Plugin {
  async onload() {
    const relay = (this.app as any).irisRelay;
    if (!relay) return;

    // 1. Re-register the handler every load.
    this.register(relay.onBatchResult("iris-tagger", (customId, result) => {
      const file = this.app.vault.getAbstractFileByPath(customId);
      if (!file || !result.ok) return;
      const text = (result.response.content as any[])
        .filter(b => b.type === "text").map(b => b.text).join("");
      // apply tags to the file...
    }));

    // 2. Command: queue all untagged notes.
    this.addCommand({
      id: "queue-tag-batch",
      name: "Queue untagged notes for batch tagging",
      callback: async () => {
        for (const file of this.untaggedNotes()) {
          relay.enqueueBatch({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 100,
            messages: [{ role: "user", content: await this.app.vault.read(file) }],
          }, {
            customId: file.path,           // path is unique within my plugin
            callerId: "iris-tagger",
          });
        }
        new Notice("Queued. Open Iris settings → Batch mode → Flush to submit.");
      },
    });
  }

  untaggedNotes(): TFile[] { return []; /* ... */ }
}
```

In this design the plugin author hands flushing off to the user via the router's settings UI. You can also call `relay.flushBatch()` yourself from a command if you'd rather bundle queuing + submission together.

## Settling on `callerId`

- Pick one stable string per plugin and never change it. It is the join key for stats, history, batch handlers, and the live modal.
- Convention: same as the Obsidian plugin id (e.g. `"iris-tagger"`, `"iris-summarizer"`). Lowercase, hyphenated.
- A single plugin can use multiple `callerId`s if it has cleanly distinct workloads (e.g. `"iris-tagger:bulk"` vs `"iris-tagger:interactive"`) — the router treats them as independent, including for batch handler routing.

## Inspecting state (optional, for debugging)

If you ever need to look at router state from your own plugin:

```ts
relay.getLiveSnapshot()
// → { active, queued, batchQueued, batchPending, history, callerStats, stats }
```

This is the same data the live modal renders. You generally do not need it — the modal is sufficient — but it's the right way to build a status indicator inside your own plugin if you ever want one.

## Quick reference

```ts
// Sync — anything the user is actively waiting on
const resp = await relay.request(body, {
  callerId: "iris-x",
  priority: 3,           // optional, 0-10
  trivial: false,        // optional
  signal: ac.signal,     // optional
});

// Batch — register once in onload, then enqueue freely
this.register(relay.onBatchResult("iris-x", (customId, result) => { ... }));
relay.enqueueBatch(body, { customId: "note-42", callerId: "iris-x" });
// later, you or the user triggers:
const batchId = await relay.flushBatch();
```

That's the entire surface. Three sync features (`request`), three batch features (`enqueueBatch`, `flushBatch`, `onBatchResult`), one optional inspection method (`getLiveSnapshot`). Everything else — caching, retry, rate limiting, prompt caching, persistence, polling, history, stats — happens for you.
