# Iris Router — Caller Plugin Guide

How-to for plugin authors routing Anthropic calls through `obsidian-iris-router`. For the full API, see [INTERFACE.md](INTERFACE.md).

## What you get for free

API key storage, rate-limit coordination, response cache, prompt caching, retries, concurrency cap, live modal + cancel UI, batch polling that survives restart, per-caller stats. You write ~10 lines of glue.

## Mental model

You are one tenant among many. Always:

- **Identify yourself** with a stable `callerId` (your plugin id, lowercase-hyphenated).
- **Re-read `app.irisRelay` on every call** — don't cache. User can disable the router mid-session.
- **Let the router own the API key.** If it's missing, `request` throws `no Anthropic API key configured`; show a Notice pointing at Iris Router settings, don't prompt for a key yourself.
- **Let the user flush batches.** Don't auto-flush on every enqueue — that defeats the point.

## Minimal sync call

```ts
const relay = (this.app as any).irisRelay;
if (!relay) { new Notice("Iris Router not enabled"); return; }

const resp = await relay.request({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 500,
  messages: [{ role: "user", content: "..." }],
}, { callerId: "my-plugin" });
```

## Sync vs batch

| Ask | Use |
|---|---|
| User is waiting | **sync** (`request`) |
| Background / bulk / can wait hours | **batch** (50% off) |
| > ~20 items | batch |

## Priority (sync only)

`priority: 0..10`, default 5. Lower = jumps queue. Only matters under contention — don't set everything to 0.

## API keys

The user can configure one or more Anthropic keys in the router settings. Every request is automatically dispatched to whichever key currently has the most rate-limit headroom — you don't choose. The `trivial: true` option is **deprecated** (still accepted for backwards compatibility, but ignored).

## Batch: the two traps

**1. Register `onBatchResult` synchronously, first thing in `onload`.** Handlers aren't persisted. If the router polls on its own startup and finds a completed batch, it dispatches within milliseconds. Register late and results buffer (in memory only, one session).

**2. `customId` must be unique within a batch.** Reuse across separate `flushBatch` calls is fine. Anthropic rejects the whole submission otherwise.

## Worked example: batch tagger

```ts
const CALLER_ID = "iris-tagger";

export default class IrisTagger extends Plugin {
  async onload() {
    const relay = (this.app as any).irisRelay;
    if (relay) {
      this.register(relay.onBatchResult(CALLER_ID, (customId, result) => {
        const file = this.app.vault.getAbstractFileByPath(customId);
        if (!(file instanceof TFile) || !result.ok) return;
        const text = (result.response.content as any[])
          .filter(b => b.type === "text").map(b => b.text).join("");
        this.applyTags(file, text.split("\n").map(s => s.trim()).filter(Boolean));
      }));
    }

    this.addCommand({ id: "tag-all", name: "Queue untagged notes", callback: () => this.queueAll() });
    this.addCommand({ id: "flush", name: "Submit tag batch", callback: () => this.flush() });
  }

  async queueAll() {
    const relay = (this.app as any).irisRelay;
    if (!relay) { new Notice("Iris Router not enabled"); return; }
    for (const file of this.untagged()) {
      relay.enqueueBatch({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: "Suggest 3-5 tags, one per line, no '#'.",
        messages: [{ role: "user", content: await this.app.vault.read(file) }],
      }, { customId: file.path, callerId: CALLER_ID });
    }
  }

  async flush() {
    const relay = (this.app as any).irisRelay;
    const id = await relay?.flushBatch();
    new Notice(id ? `Submitted: ${id}` : "Nothing queued.");
  }
}
```

Notes: `customId = file.path` is stable and uniquely identifies the target. Each flush submits all queued entries as one batch. Handler tolerates the file being gone (deleted/renamed between enqueue and result, possibly hours later).

## Error handling

Three buckets:

- **Surface (actionable):** `no Anthropic API key configured`, `queue full`, `timed out`, `<api error>` 4xx.
- **Swallow:** `request aborted`, `request cancelled` — user already knows.
- **Generic:** `server error 5xx`, `all retries exhausted`, `rate limited` — router already retried; console.warn + generic Notice.

Batch errors arrive per-result as `{ ok: false, error }`. Persist failures yourself if you want to retry later.

## Common mistakes

- Caching `app.irisRelay` in a field (goes stale on router reload).
- Registering `onBatchResult` after an `await` in `onload`.
- Reusing `customId` within one batch.
- Flushing after every enqueue.
- Not setting `callerId` — you become invisible in the live modal.
- Setting `priority: 0` on everything.
- Swallowing `no Anthropic API key configured` — it's actionable.
- Expecting `stream: true` to work (it's dropped).

## Testing

No built-in mock. Options:

- Wrap `relay` behind a dev-mode adapter returning fixtures.
- Use `claude-haiku-4-5-20251001` — a day of manual testing costs cents.
- `relay.getLiveSnapshot()` for in-plugin status UI (same data as the live modal).

Don't batch-flush in a loop during development — each flush is a real Anthropic submission, 24h TTL.

## Pre-ship checklist

- [ ] Every call sets `callerId` = plugin id.
- [ ] `app.irisRelay` re-read on every call, never cached.
- [ ] Missing-router + missing-API-key cases show a Notice.
- [ ] If batch: `onBatchResult` registered synchronously, first thing in `onload`.
- [ ] If batch: `customId`s unique within a batch; handler tolerates missing entities.
- [ ] No `stream: true`.
- [ ] README notes the `obsidian-iris-router` dependency.
