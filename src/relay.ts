import { requestUrl } from "obsidian";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export interface RelaySettings {
  anthropicApiKey: string;
  trivialApiKey: string;
  requestTimeoutMs: number;
}

export interface RequestOptions {
  priority?: number;
  trivial?: boolean;
  signal?: AbortSignal;
}

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1000;
const MAX_QUEUE_SIZE = 64;
const MAX_TOKENS_CAP = 32768;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY_CAP = 8;
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

function tagLastElement(arr: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    ...arr.slice(0, -1),
    { ...arr[arr.length - 1], cache_control: { type: "ephemeral" } },
  ];
}

function injectCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };

  if (clone.system != null) {
    if (typeof clone.system === "string") {
      clone.system = [{ type: "text", text: clone.system, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(clone.system) && clone.system.length > 0) {
      clone.system = tagLastElement(clone.system as Record<string, unknown>[]);
    }
  }

  if (Array.isArray(clone.tools) && clone.tools.length > 0) {
    clone.tools = tagLastElement(clone.tools as Record<string, unknown>[]);
  }

  return clone;
}

const DEFAULT_PRIORITY = 5;

interface QueueEntry {
  body: Record<string, unknown>;
  bodyKey: string;              // pre-computed JSON.stringify(body)
  apiKey: string;               // resolved at enqueue time
  cacheKey: string;             // apiKey + "\0" + bodyKey
  priority: number;
  signal?: AbortSignal;
  abortHandler?: () => void;    // stored so we can remove it on dispatch
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export interface RateLimitInfo {
  role: "main" | "trivial";
  requestsLimit: number;
  requestsRemaining: number;
  requestsReset: number;
  tokensLimit: number;
  tokensRemaining: number;
  tokensReset: number;
  concurrency: number;
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
  private rateLimitsRaw = new Map<string, Omit<RateLimitInfo, "role" | "concurrency">>();
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

  getRateLimits(): RateLimitInfo[] {
    const result: RateLimitInfo[] = [];
    for (const [key, raw] of this.rateLimitsRaw) {
      const role = (this.settings.trivialApiKey && key === this.settings.trivialApiKey) ? "trivial" as const : "main" as const;
      const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY_CAP, raw.requestsLimit));
      result.push({ ...raw, role, concurrency });
    }
    return result;
  }

  getStats(): RelayStats {
    return { ...this.stats };
  }

  /** Reject all queued entries and clear state. Call from plugin onunload. */
  shutdown(): void {
    for (const entry of this.queue.splice(0)) {
      this.cleanupAbortListener(entry);
      entry.reject(new Error("Iris Relay: plugin unloading."));
    }
    this.responseCache.clear();
    this.inflight.clear();
  }

  async request(body: object, options?: RequestOptions): Promise<Record<string, unknown>> {
    const signal = options?.signal;
    if (signal?.aborted) throw new Error("Iris Relay: request aborted.");
    if (!this.settings.anthropicApiKey) throw new Error("Iris Relay: no API key configured.");
    if (this.queue.length >= MAX_QUEUE_SIZE) throw new Error("Iris Relay: queue full, try again later.");

    this.stats.totalRequests++;
    const validated = validateBody(body);
    const priority = typeof options?.priority === "number"
      ? Math.max(0, Math.min(10, options.priority))
      : DEFAULT_PRIORITY;
    const apiKey = (options?.trivial && this.settings.trivialApiKey)
      ? this.settings.trivialApiKey
      : this.settings.anthropicApiKey;
    const bodyKey = JSON.stringify(validated);
    const cacheKey = apiKey + "\0" + bodyKey;

    const cached = this.responseCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      this.stats.cacheHits++;
      return cached.response;
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: QueueEntry = {
        body: validated, bodyKey, apiKey, cacheKey, priority, signal, resolve, reject,
      };

      if (signal) {
        const handler = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error("Iris Relay: request aborted."));
          }
        };
        entry.abortHandler = handler;
        signal.addEventListener("abort", handler, { once: true });
      }

      let i = this.queue.findIndex((e) => e.priority > priority);
      if (i === -1) i = this.queue.length;
      this.queue.splice(i, 0, entry);
      this.drain();
    });
  }

  private cleanupAbortListener(entry: QueueEntry): void {
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener("abort", entry.abortHandler);
      entry.abortHandler = undefined;
    }
  }

  private maxConcurrencyFor(apiKey: string): number {
    const info = this.rateLimitsRaw.get(apiKey);
    if (!info) return DEFAULT_CONCURRENCY;
    return Math.max(1, Math.min(MAX_CONCURRENCY_CAP, info.requestsLimit));
  }

  private getActive(apiKey: string): number {
    return this.activeByKey.get(apiKey) || 0;
  }

  private adjustActive(apiKey: string, delta: number): void {
    this.activeByKey.set(apiKey, this.getActive(apiKey) + delta);
  }

  private drain(): void {
    const now = Date.now();
    let earliestRetry = Infinity;

    let i = 0;
    while (i < this.queue.length) {
      const entry = this.queue[i];

      if (entry.signal?.aborted) {
        this.queue.splice(i, 1);
        continue;
      }

      const { apiKey } = entry;

      const rlUntil = this.rateLimitUntil.get(apiKey) || 0;
      if (now < rlUntil) {
        earliestRetry = Math.min(earliestRetry, rlUntil);
        i++;
        continue;
      }

      if (this.getActive(apiKey) >= this.maxConcurrencyFor(apiKey)) {
        i++;
        continue;
      }

      if (this.shouldThrottle(apiKey)) {
        earliestRetry = Math.min(earliestRetry, now + 2000);
        i++;
        continue;
      }

      this.queue.splice(i, 1);
      this.cleanupAbortListener(entry);
      this.adjustActive(apiKey, 1);
      this.execute(entry).finally(() => {
        this.adjustActive(apiKey, -1);
        this.drain();
      });
    }

    if (earliestRetry < Infinity) {
      setTimeout(() => this.drain(), earliestRetry - Date.now());
    }
  }

  private shouldThrottle(apiKey: string): boolean {
    const info = this.rateLimitsRaw.get(apiKey);
    if (!info) return false;

    const now = Date.now();
    if (now >= info.tokensReset && now >= info.requestsReset) return false;

    if (info.tokensRemaining < info.tokensLimit * 0.1) return true;
    if (info.requestsRemaining < info.requestsLimit * 0.1) return true;
    return false;
  }

  private updateRateLimits(apiKey: string, headers: Record<string, string>): void {
    const h = (name: string) => headers?.[name] || "";
    const parseReset = (val: string): number => {
      if (!val) return 0;
      const d = new Date(val);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };

    const requestsLimit = parseInt(h("anthropic-ratelimit-requests-limit"), 10);
    const tokensLimit = parseInt(h("anthropic-ratelimit-tokens-limit"), 10);
    if (isNaN(requestsLimit) || isNaN(tokensLimit)) return;

    const requestsRemaining = parseInt(h("anthropic-ratelimit-requests-remaining"), 10);
    const tokensRemaining = parseInt(h("anthropic-ratelimit-tokens-remaining"), 10);

    this.rateLimitsRaw.set(apiKey, {
      requestsLimit,
      requestsRemaining: isNaN(requestsRemaining) ? requestsLimit : requestsRemaining,
      requestsReset: parseReset(h("anthropic-ratelimit-requests-reset")),
      tokensLimit,
      tokensRemaining: isNaN(tokensRemaining) ? tokensLimit : tokensRemaining,
      tokensReset: parseReset(h("anthropic-ratelimit-tokens-reset")),
    });
  }

  private cacheResponse(key: string, response: Record<string, unknown>): void {
    const now = Date.now();
    for (const [k, v] of this.responseCache) {
      if (now >= v.expiresAt) this.responseCache.delete(k);
    }
    if (this.responseCache.size >= RESPONSE_CACHE_MAX) {
      const first = this.responseCache.keys().next().value;
      if (first !== undefined) this.responseCache.delete(first);
    }
    this.responseCache.set(key, { response, expiresAt: now + RESPONSE_CACHE_TTL_MS });
  }

  private async execute(entry: QueueEntry): Promise<void> {
    const existing = this.inflight.get(entry.cacheKey);
    if (existing) {
      this.stats.dedupHits++;
      this.adjustActive(entry.apiKey, -1);
      try {
        entry.resolve(await existing);
      } catch (e) {
        entry.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }

    const promise = this.executeInner(entry);
    this.inflight.set(entry.cacheKey, promise);
    promise.finally(() => this.inflight.delete(entry.cacheKey));

    try {
      await promise;
    } catch {
      // rejection already forwarded inside executeInner
    }
  }

  private applyOverloadBackoff(apiKey: string, headers: Record<string, string>, status: number): Error {
    const retryAfter = parseInt(headers?.["retry-after"] || "", 10);
    const backoffMs = (isNaN(retryAfter) ? 10 : retryAfter) * 1000;
    this.rateLimitUntil.set(apiKey, Date.now() + backoffMs);
    const label = status === 429 ? "rate limited" : "overloaded";
    return new Error(`Iris Relay: ${label} (${status}), backing off ${backoffMs / 1000}s`);
  }

  private async executeInner(entry: QueueEntry): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    const serializedBody = JSON.stringify(injectCacheControl(entry.body));
    const { apiKey, cacheKey, signal } = entry;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        const err = new Error("Iris Relay: request aborted.");
        entry.reject(err);
        throw err;
      }

      if (attempt > 0) {
        this.stats.retries++;
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      const now = Date.now();
      const rlUntil = this.rateLimitUntil.get(apiKey) || 0;
      if (now < rlUntil) {
        await new Promise((r) => setTimeout(r, rlUntil - now));
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
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
            body: serializedBody,
            throw: false,
          }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`Iris Relay: request timed out after ${this.settings.requestTimeoutMs / 1000}s`)),
              this.settings.requestTimeoutMs,
            );
          }),
        ];

        // Race against abort without a persistent promise — just check the flag
        // before each attempt (above) and let the timeout bound any hanging request.
        const response = await Promise.race(racers);

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
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    this.stats.errors++;
    const err = lastError || new Error("Iris Relay: all retries exhausted");
    entry.reject(err);
    throw err;
  }
}
