import { requestUrl } from "obsidian";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export interface RelaySettings {
  anthropicApiKey: string;
  trivialApiKey: string;
  maxConcurrency: number;
  trivialMaxConcurrency: number;
  requestTimeoutMs: number;
}

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1000;
const MAX_QUEUE_SIZE = 64;
const MAX_TOKENS_CAP = 32768;
const RESPONSE_CACHE_TTL_MS = 60_000;
const RESPONSE_CACHE_MAX = 64;

const ALLOWED_BODY_KEYS = new Set([
  "model", "max_tokens", "system", "messages",
  "temperature", "tools", "tool_choice", "top_p", "top_k",
  "stop_sequences",
]);

function validateBody(body: object): Record<string, unknown> {
  const raw = body as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (ALLOWED_BODY_KEYS.has(key)) cleaned[key] = raw[key];
  }
  if ("stream" in raw && raw.stream) {
    console.warn("Iris Relay: 'stream' is not supported and was stripped from the request.");
  }
  if (typeof cleaned.model !== "string" || !cleaned.model) {
    throw new Error("Iris Relay: missing or invalid 'model' field.");
  }
  if (typeof cleaned.max_tokens !== "number" || cleaned.max_tokens < 1) {
    throw new Error("Iris Relay: missing or invalid 'max_tokens' field.");
  }
  cleaned.max_tokens = Math.min(cleaned.max_tokens as number, MAX_TOKENS_CAP);
  if (!Array.isArray(cleaned.messages) || cleaned.messages.length === 0) {
    throw new Error("Iris Relay: missing or empty 'messages' field.");
  }
  return cleaned;
}

/** Inject prompt-caching cache_control markers onto a shallow clone of the body. */
function injectCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };

  // System prompt: ensure array form, tag last block
  if (clone.system != null) {
    if (typeof clone.system === "string") {
      clone.system = [{ type: "text", text: clone.system, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(clone.system) && clone.system.length > 0) {
      const blocks = (clone.system as Record<string, unknown>[]).map((b) => ({ ...b }));
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
      clone.system = blocks;
    }
  }

  // Tools: tag last tool definition
  if (Array.isArray(clone.tools) && clone.tools.length > 0) {
    const tools = (clone.tools as Record<string, unknown>[]).map((t) => ({ ...t }));
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
    clone.tools = tools;
  }

  return clone;
}

const DEFAULT_PRIORITY = 5;

interface QueueEntry {
  body: Record<string, unknown>;
  priority: number;
  trivial: boolean;
  signal?: AbortSignal;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export interface RateLimitInfo {
  requestsLimit: number;
  requestsRemaining: number;
  requestsReset: number;       // timestamp ms
  tokensLimit: number;
  tokensRemaining: number;
  tokensReset: number;         // timestamp ms
}

interface CacheEntry {
  response: Record<string, unknown>;
  expiresAt: number;
}

export interface RelayStats {
  totalRequests: number;
  dedupHits: number;
  cacheHits: number;
  retries: number;
  errors: number;
}

export class Relay {
  private settings: RelaySettings;
  private queue: QueueEntry[] = [];
  private activeByKey = new Map<string, number>();
  private rateLimitUntil = new Map<string, number>();
  private inflight = new Map<string, Promise<Record<string, unknown>>>();
  private rateLimits = new Map<string, RateLimitInfo>();
  private responseCache = new Map<string, CacheEntry>();
  private stats: RelayStats = {
    totalRequests: 0,
    dedupHits: 0,
    cacheHits: 0,
    retries: 0,
    errors: 0,
  };

  constructor(settings: RelaySettings) {
    this.settings = settings;
  }

  updateSettings(settings: RelaySettings): void {
    this.settings = settings;
  }

  /** Get current rate limit info for display in settings. */
  getRateLimits(): Map<string, RateLimitInfo> {
    return new Map(this.rateLimits);
  }

  /** Get a snapshot of relay stats. */
  getStats(): RelayStats {
    return { ...this.stats };
  }

  /** Reject all queued entries and clear state. Call from plugin onunload. */
  shutdown(): void {
    const entries = this.queue.splice(0);
    for (const entry of entries) {
      entry.reject(new Error("Iris Relay: plugin unloading."));
    }
    this.responseCache.clear();
    this.inflight.clear();
  }

  /** Public API: enqueue a Messages API request.
   *  @param body     Anthropic Messages API body fields.
   *  @param priority 0-10 (lower = processed first). Defaults to 5.
   *  @param trivial  If true and a trivial API key is configured, use that key instead.
   *  @param signal   Optional AbortSignal to cancel the request while queued or in-flight.
   */
  async request(body: object, priority?: number, trivial?: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("Iris Relay: request aborted.");
    if (!this.settings.anthropicApiKey) throw new Error("Iris Relay: no API key configured.");
    if (this.queue.length >= MAX_QUEUE_SIZE) throw new Error("Iris Relay: queue full, try again later.");

    this.stats.totalRequests++;
    const validated = validateBody(body);
    const p = typeof priority === "number" ? Math.max(0, Math.min(10, priority)) : DEFAULT_PRIORITY;

    // Check response cache before queueing.
    const apiKey = (trivial && this.settings.trivialApiKey)
      ? this.settings.trivialApiKey
      : this.settings.anthropicApiKey;
    const cacheKey = apiKey + "\0" + JSON.stringify(validated);
    const cached = this.responseCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      this.stats.cacheHits++;
      return cached.response;
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: QueueEntry = { body: validated, priority: p, trivial: !!trivial, signal, resolve, reject };

      // If aborted while queued, remove from queue and reject.
      if (signal) {
        signal.addEventListener("abort", () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error("Iris Relay: request aborted."));
          }
        }, { once: true });
      }

      let i = this.queue.findIndex((e) => e.priority > p);
      if (i === -1) i = this.queue.length;
      this.queue.splice(i, 0, entry);
      this.drain();
    });
  }

  private resolveKey(entry: QueueEntry): string {
    return (entry.trivial && this.settings.trivialApiKey)
      ? this.settings.trivialApiKey
      : this.settings.anthropicApiKey;
  }

  private maxConcurrencyFor(apiKey: string): number {
    if (this.settings.trivialApiKey && apiKey === this.settings.trivialApiKey) {
      return this.settings.trivialMaxConcurrency;
    }
    return this.settings.maxConcurrency;
  }

  private getActive(apiKey: string): number {
    return this.activeByKey.get(apiKey) || 0;
  }

  private adjustActive(apiKey: string, delta: number): void {
    this.activeByKey.set(apiKey, this.getActive(apiKey) + delta);
  }

  private drain(): void {
    const now = Date.now();

    // Track the earliest rate-limit expiry we skip, so we can schedule a retry.
    let earliestRetry = Infinity;

    // Walk the queue and dispatch entries whose key has capacity.
    let i = 0;
    while (i < this.queue.length) {
      const entry = this.queue[i];

      // Already aborted while queued — discard silently (reject fired by listener).
      if (entry.signal?.aborted) {
        this.queue.splice(i, 1);
        continue;
      }

      const apiKey = this.resolveKey(entry);

      // Rate-limited for this key?
      const rlUntil = this.rateLimitUntil.get(apiKey) || 0;
      if (now < rlUntil) {
        earliestRetry = Math.min(earliestRetry, rlUntil);
        i++;
        continue;
      }

      // Concurrency full for this key?
      if (this.getActive(apiKey) >= this.maxConcurrencyFor(apiKey)) {
        i++;
        continue;
      }

      // Approaching rate limit — delay if near capacity.
      if (this.shouldThrottle(apiKey)) {
        earliestRetry = Math.min(earliestRetry, now + 2000);
        i++;
        continue;
      }

      // Dispatch this entry.
      this.queue.splice(i, 1);
      this.adjustActive(apiKey, 1);
      this.execute(entry, apiKey).finally(() => {
        this.adjustActive(apiKey, -1);
        this.drain();
      });
    }

    if (earliestRetry < Infinity) {
      setTimeout(() => this.drain(), earliestRetry - Date.now());
    }
  }

  /** Check if we should throttle based on API-reported remaining capacity. */
  private shouldThrottle(apiKey: string): boolean {
    const info = this.rateLimits.get(apiKey);
    if (!info) return false; // no data yet — let it through

    const now = Date.now();
    // If the window has reset, limits are refreshed — don't throttle.
    if (now >= info.tokensReset && now >= info.requestsReset) return false;

    // Throttle when remaining tokens or requests drop below 10% of limit.
    if (info.tokensRemaining < info.tokensLimit * 0.1) return true;
    if (info.requestsRemaining < info.requestsLimit * 0.1) return true;
    return false;
  }

  /** Parse rate-limit headers from an API response. */
  private updateRateLimits(apiKey: string, headers: Record<string, string>): void {
    const h = (name: string) => headers?.[name] || "";
    const parseReset = (val: string): number => {
      if (!val) return 0;
      const d = new Date(val);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };

    const requestsLimit = parseInt(h("anthropic-ratelimit-requests-limit"), 10);
    const requestsRemaining = parseInt(h("anthropic-ratelimit-requests-remaining"), 10);
    const tokensLimit = parseInt(h("anthropic-ratelimit-tokens-limit"), 10);
    const tokensRemaining = parseInt(h("anthropic-ratelimit-tokens-remaining"), 10);

    // Only update if we got valid numbers back.
    if (isNaN(requestsLimit) || isNaN(tokensLimit)) return;

    this.rateLimits.set(apiKey, {
      requestsLimit,
      requestsRemaining: isNaN(requestsRemaining) ? requestsLimit : requestsRemaining,
      requestsReset: parseReset(h("anthropic-ratelimit-requests-reset")),
      tokensLimit,
      tokensRemaining: isNaN(tokensRemaining) ? tokensLimit : tokensRemaining,
      tokensReset: parseReset(h("anthropic-ratelimit-tokens-reset")),
    });
  }

  /** Store a response in the cache, evicting oldest if at capacity. */
  private cacheResponse(key: string, response: Record<string, unknown>): void {
    // Evict expired entries first.
    const now = Date.now();
    for (const [k, v] of this.responseCache) {
      if (now >= v.expiresAt) this.responseCache.delete(k);
    }
    // If still at capacity, evict the oldest (first inserted).
    if (this.responseCache.size >= RESPONSE_CACHE_MAX) {
      const first = this.responseCache.keys().next().value;
      if (first !== undefined) this.responseCache.delete(first);
    }
    this.responseCache.set(key, { response, expiresAt: now + RESPONSE_CACHE_TTL_MS });
  }

  private async execute(entry: QueueEntry, apiKey: string): Promise<void> {
    // --- Request deduplication ---
    const dedupKey = apiKey + "\0" + JSON.stringify(entry.body);
    const existing = this.inflight.get(dedupKey);
    if (existing) {
      this.stats.dedupHits++;
      // Piggyback on the in-flight request — don't consume a concurrency slot.
      this.adjustActive(apiKey, -1);
      try {
        entry.resolve(await existing);
      } catch (e) {
        entry.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }

    const promise = this.executeInner(entry, apiKey);
    this.inflight.set(dedupKey, promise);
    promise.finally(() => this.inflight.delete(dedupKey));

    try {
      await promise;
    } catch {
      // rejection already forwarded to entry inside executeInner
    }
  }

  /** Handle 429 or 529 with retry-after backoff. */
  private applyOverloadBackoff(apiKey: string, headers: Record<string, string>, status: number): Error {
    const retryAfter = parseInt(headers?.["retry-after"] || "", 10);
    const backoffMs = (isNaN(retryAfter) ? 10 : retryAfter) * 1000;
    this.rateLimitUntil.set(apiKey, Date.now() + backoffMs);
    const label = status === 429 ? "rate limited" : "overloaded";
    return new Error(`Iris Relay: ${label} (${status}), backing off ${backoffMs / 1000}s`);
  }

  private async executeInner(entry: QueueEntry, apiKey: string): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    const cachedBody = injectCacheControl(entry.body);
    const cacheKey = apiKey + "\0" + JSON.stringify(entry.body);

    // Helper: create an abort promise that rejects when the signal fires.
    const abortPromise = entry.signal
      ? new Promise<never>((_, reject) => {
          entry.signal!.addEventListener("abort", () =>
            reject(new Error("Iris Relay: request aborted.")), { once: true });
        })
      : null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Check abort before each attempt.
      if (entry.signal?.aborted) {
        const err = new Error("Iris Relay: request aborted.");
        entry.reject(err);
        throw err;
      }

      if (attempt > 0) {
        this.stats.retries++;
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      // Re-check rate limit before each attempt
      const now = Date.now();
      const rlUntil = this.rateLimitUntil.get(apiKey) || 0;
      if (now < rlUntil) {
        await new Promise((r) => setTimeout(r, rlUntil - now));
      }

      try {
        const racers: Promise<any>[] = [
          requestUrl({
            url: API_URL,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": API_VERSION,
              "anthropic-beta": "prompt-caching-2024-07-31",
            },
            body: JSON.stringify(cachedBody),
            throw: false,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Iris Relay: request timed out after ${this.settings.requestTimeoutMs / 1000}s`)),
              this.settings.requestTimeoutMs,
            ),
          ),
        ];
        if (abortPromise) racers.push(abortPromise);
        const response = await Promise.race(racers);

        // Update rate-limit state from response headers.
        this.updateRateLimits(apiKey, response.headers);

        if (response.status === 429 || response.status === 529) {
          lastError = this.applyOverloadBackoff(apiKey, response.headers, response.status);
          continue;
        }

        if (response.status >= 500) {
          lastError = new Error(`Iris Relay: server error ${response.status}`);
          continue;
        }

        if (response.status >= 400) {
          const msg = response.json?.error?.message ?? `API ${response.status}`;
          const err = new Error(`Iris Relay: ${msg}`);
          this.stats.errors++;
          entry.reject(err);
          throw err;
        }

        this.cacheResponse(cacheKey, response.json);
        entry.resolve(response.json);
        return response.json;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES && lastError.message.includes("timed out")) {
          continue;
        }
        if (attempt >= MAX_RETRIES) break;
      }
    }

    this.stats.errors++;
    const err = lastError || new Error("Iris Relay: all retries exhausted");
    entry.reject(err);
    throw err;
  }
}
