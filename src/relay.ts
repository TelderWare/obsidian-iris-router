import { requestUrl } from "obsidian";

const API_URL = "https://api.anthropic.com/v1/messages";
const BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const API_VERSION = "2023-06-01";

const BATCH_POLL_FAST_MS = 30_000;
const BATCH_POLL_SLOW_MS = 120_000;
const BATCH_POLL_FAST_DURATION_MS = 5 * 60_000;

const SELF_PLUGIN_ID = "obsidian-iris-router";

function deriveCallerIdFromStack(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;
  const re = /plugins[\/\\]([^\/\\"'?)]+)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) !== null) {
    const id = m[1];
    if (id === SELF_PLUGIN_ID || seen.has(id)) continue;
    seen.add(id);
    return id;
  }
  return null;
}

export interface RelaySettings {
  anthropicApiKey: string;
  trivialApiKey: string;
  requestTimeoutMs: number;
}

export interface RequestOptions {
  priority?: number;
  trivial?: boolean;
  signal?: AbortSignal;
  batch?: boolean;
  callerId?: string;
}

export interface BatchEnqueueOptions {
  customId: string;
  callerId: string;
  trivial?: boolean;
}

export type BatchResult =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; error: string };

export type BatchResultHandler = (customId: string, result: BatchResult) => void;

export interface PersistedBatchEntry {
  customId: string;
  callerId: string;
  trivial: boolean;
  body: Record<string, unknown>;
}

export interface PersistedPendingBatch {
  batchId: string;
  role: "main" | "trivial";
  submittedAt: number;
  entries: Array<{ customId: string; callerId: string }>;
}

export interface PersistedBatchState {
  queued: PersistedBatchEntry[];
  pending: PersistedPendingBatch[];
}

export function emptyBatchState(): PersistedBatchState {
  return { queued: [], pending: [] };
}

export interface BatchPersistence {
  initial: PersistedBatchState;
  save: (state: PersistedBatchState) => Promise<void>;
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
  id: number;
  body: Record<string, unknown>;
  bodyKey: string;              // pre-computed JSON.stringify(body)
  apiKey: string;               // resolved at enqueue time
  cacheKey: string;             // apiKey + "\0" + bodyKey
  priority: number;
  callerId: string;
  enqueuedAt: number;
  signal?: AbortSignal;
  abortHandler?: () => void;    // stored so we can remove it on dispatch
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

interface ActiveRecord {
  id: number;
  callerId: string;
  model: string;
  role: "main" | "trivial";
  priority: number;
  startedAt: number;
  cancelled: boolean;
}

export interface CallerStats {
  requests: number;
  errors: number;
  retries: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface HistoryEntry {
  id: number;
  callerId: string;
  model: string;
  role: "main" | "trivial";
  priority: number;
  mode: "sync" | "batch";
  startedAt: number;
  endedAt: number;
  status: "ok" | "error" | "cancelled";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  error?: string;
  customId?: string;
}

const HISTORY_MAX = 200;

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
  attempts: number;
  errors: number;
}

export class Relay {
  private settings: RelaySettings;
  private queue: QueueEntry[] = [];
  private activeByKey = new Map<string, number>();
  private activeTotal = 0;
  private activeListener?: (active: number) => void;
  private changeListener?: () => void;
  private changePending = false;
  private drainScheduled = false;
  private paused = false;
  private rateLimitUntil = new Map<string, number>();
  private rateLimitsRaw = new Map<string, Omit<RateLimitInfo, "role" | "concurrency">>();
  private responseCache = new Map<string, CacheEntry>();
  private stats: RelayStats = {
    totalRequests: 0,
    attempts: 0,
    errors: 0,
  };

  private nextEntryId = 1;
  private activeRecords = new Map<number, ActiveRecord>();
  private callerStats = new Map<string, CallerStats>();
  private history: HistoryEntry[] = [];

  private batchState: PersistedBatchState = emptyBatchState();
  private persistBatch?: (state: PersistedBatchState) => Promise<void>;
  private batchHandlers = new Map<string, BatchResultHandler>();
  private batchBuffered = new Map<string, Array<{ customId: string; result: BatchResult }>>();
  private batchPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shutdownFlag = false;

  constructor(settings: RelaySettings, batchPersistence?: BatchPersistence) {
    this.settings = settings;
    if (batchPersistence) {
      this.batchState = batchPersistence.initial;
      this.persistBatch = batchPersistence.save;
    }
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
    this.shutdownFlag = true;
    for (const entry of this.queue.splice(0)) {
      this.cleanupAbortListener(entry);
      entry.reject(new Error("Iris Relay: plugin unloading."));
    }
    this.responseCache.clear();
    for (const t of this.batchPollTimers.values()) clearTimeout(t);
    this.batchPollTimers.clear();
    this.batchHandlers.clear();
    this.batchBuffered.clear();
  }

  async request(body: object, options?: RequestOptions): Promise<Record<string, unknown>> {
    if (options?.batch) {
      throw new Error("Iris Relay: batch requests must use enqueueBatch() / flushBatch(), not request().");
    }
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
      return cached.response;
    }

    const callerId = options?.callerId || deriveCallerIdFromStack() || "?";
    this.bumpCaller(callerId, "requests", 1);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: QueueEntry = {
        id: this.nextEntryId++,
        body: validated, bodyKey, apiKey, cacheKey, priority, callerId,
        enqueuedAt: Date.now(),
        signal, resolve, reject,
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
      this.notifyChange();
      this.scheduleDrain();
    });
  }

  /** Defer drain so the UI can paint the queued state before entries move to active. */
  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setTimeout(() => {
      this.drainScheduled = false;
      this.drain();
    }, 0);
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
    this.activeTotal += delta;
    this.activeListener?.(this.activeTotal);
  }

  setActiveListener(listener: (active: number) => void): void {
    this.activeListener = listener;
  }

  setChangeListener(listener: (() => void) | undefined): void {
    this.changeListener = listener;
  }

  private notifyChange(): void {
    if (this.changePending) return;
    this.changePending = true;
    queueMicrotask(() => {
      this.changePending = false;
      this.changeListener?.();
    });
  }

  getActiveCount(): number {
    return this.activeTotal;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.notifyChange();
    if (!paused) this.scheduleDrain();
  }

  private drain(): void {
    if (this.paused) return;
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
      const record: ActiveRecord = {
        id: entry.id,
        callerId: entry.callerId,
        model: String(entry.body.model || "?"),
        role: (this.settings.trivialApiKey && apiKey === this.settings.trivialApiKey ? "trivial" : "main"),
        priority: entry.priority,
        startedAt: Date.now(),
        cancelled: false,
      };
      this.activeRecords.set(entry.id, record);
      this.notifyChange();
      this.execute(entry, record).finally(() => {
        this.activeRecords.delete(entry.id);
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

  private async execute(entry: QueueEntry, record: ActiveRecord): Promise<void> {
    try {
      await this.executeInner(entry, record);
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

  private async executeInner(entry: QueueEntry, record: ActiveRecord): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    const serializedBody = JSON.stringify(injectCacheControl(entry.body));
    const { apiKey, cacheKey, signal } = entry;

    const fail = (err: Error, status: HistoryEntry["status"]): never => {
      (err as any).__irisHandled = true;
      if (status === "error") {
        this.stats.errors++;
        this.bumpCaller(record.callerId, "errors", 1);
      }
      entry.reject(err);
      this.recordHistory(record, status, undefined, err.message);
      throw err;
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (record.cancelled) fail(new Error("Iris Relay: request cancelled."), "cancelled");
      if (signal?.aborted) fail(new Error("Iris Relay: request aborted."), "cancelled");

      if (attempt > 0) {
        this.bumpCaller(record.callerId, "retries", 1);
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      const now = Date.now();
      const rlUntil = this.rateLimitUntil.get(apiKey) || 0;
      if (now < rlUntil) {
        await new Promise((r) => setTimeout(r, rlUntil - now));
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      this.stats.attempts++;
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

        if (record.cancelled) fail(new Error("Iris Relay: request cancelled."), "cancelled");

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
          fail(new Error(`Iris Relay: ${msg}`), "error");
        }

        this.cacheResponse(cacheKey, response.json);
        entry.resolve(response.json);
        this.recordHistory(record, "ok", response.json);
        return response.json;
      } catch (e) {
        if (e instanceof Error && (e as any).__irisHandled) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES && lastError.message.includes("timed out")) {
          continue;
        }
        if (attempt >= MAX_RETRIES) break;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    fail(lastError || new Error("Iris Relay: all retries exhausted"), "error");
    throw lastError; // unreachable, for type narrowing
  }

  // ───── stats / history helpers ─────

  private getCallerStats(callerId: string): CallerStats {
    let s = this.callerStats.get(callerId);
    if (!s) {
      s = { requests: 0, errors: 0, retries: 0, cancelled: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      this.callerStats.set(callerId, s);
    }
    return s;
  }

  private bumpCaller(callerId: string, field: keyof CallerStats, delta: number): void {
    const s = this.getCallerStats(callerId);
    s[field] += delta;
  }

  private recordHistory(
    record: { id: number; callerId: string; model: string; role: "main" | "trivial"; priority: number; startedAt: number; customId?: string },
    status: HistoryEntry["status"],
    response?: Record<string, unknown>,
    error?: string,
    mode: "sync" | "batch" = "sync",
  ): void {
    const usage: any = response?.usage || {};
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
    const cacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;

    const entry: HistoryEntry = {
      id: record.id,
      callerId: record.callerId,
      model: record.model,
      role: record.role,
      priority: record.priority,
      mode,
      startedAt: record.startedAt,
      endedAt: Date.now(),
      status,
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
      error,
      customId: record.customId,
    };

    this.history.push(entry);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);

    const cs = this.getCallerStats(record.callerId);
    cs.inputTokens += inputTokens;
    cs.outputTokens += outputTokens;
    cs.cacheReadTokens += cacheReadTokens;
    cs.cacheCreationTokens += cacheCreationTokens;
    if (status === "cancelled") cs.cancelled += 1;
    this.notifyChange();
  }

  // ───── cancellation ─────

  cancelQueued(id: number): boolean {
    const idx = this.queue.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [entry] = this.queue.splice(idx, 1);
    this.cleanupAbortListener(entry);
    const err = new Error("Iris Relay: request cancelled.");
    entry.reject(err);
    this.bumpCaller(entry.callerId, "cancelled", 1);
    this.history.push({
      id: entry.id, callerId: entry.callerId,
      model: String(entry.body.model || "?"),
      role: (this.settings.trivialApiKey && entry.apiKey === this.settings.trivialApiKey ? "trivial" : "main"),
      priority: entry.priority, mode: "sync",
      startedAt: entry.enqueuedAt, endedAt: Date.now(),
      status: "cancelled",
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      error: "cancelled before dispatch",
    });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.notifyChange();
    return true;
  }

  cancelActive(id: number): boolean {
    const r = this.activeRecords.get(id);
    if (!r) return false;
    r.cancelled = true;
    this.notifyChange();
    return true;
  }

  cancelBatchQueued(callerId: string, customId: string): boolean {
    const before = this.batchState.queued.length;
    this.batchState.queued = this.batchState.queued.filter(
      (e) => !(e.callerId === callerId && e.customId === customId),
    );
    if (this.batchState.queued.length === before) return false;
    void this.saveBatchState();
    this.notifyChange();
    return true;
  }

  async cancelBatchPending(batchId: string): Promise<boolean> {
    const pending = this.batchState.pending.find((p) => p.batchId === batchId);
    if (!pending) return false;
    const apiKey = this.resolveKey(pending.role);
    if (!apiKey) return false;
    try {
      await requestUrl({
        url: `${BATCHES_URL}/${batchId}/cancel`,
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION },
        throw: false,
      });
    } catch (e) {
      console.warn(`Iris Relay: batch cancel request failed`, e);
    }
    // Leave it pending so polling collects whatever results were finalised before cancel.
    return true;
  }

  // ───── batch mode ─────

  private resolveKey(role: "main" | "trivial"): string {
    if (role === "trivial" && this.settings.trivialApiKey) return this.settings.trivialApiKey;
    return this.settings.anthropicApiKey;
  }

  private async saveBatchState(): Promise<void> {
    if (this.persistBatch) {
      try { await this.persistBatch(this.batchState); }
      catch (e) { console.error("Iris Relay: failed to persist batch state", e); }
    }
  }

  enqueueBatch(body: object, opts: BatchEnqueueOptions): void {
    if (!opts || !opts.customId || !opts.callerId) {
      throw new Error("Iris Relay: enqueueBatch requires customId and callerId.");
    }
    const validated = validateBody(body);
    this.batchState.queued.push({
      customId: opts.customId,
      callerId: opts.callerId,
      trivial: !!opts.trivial,
      body: validated,
    });
    this.bumpCaller(opts.callerId, "requests", 1);
    void this.saveBatchState();
    this.notifyChange();
  }

  async flushBatch(opts?: { trivial?: boolean }): Promise<string | null> {
    const role: "main" | "trivial" = opts?.trivial ? "trivial" : "main";
    const apiKey = this.resolveKey(role);
    if (!apiKey) throw new Error("Iris Relay: no API key configured.");

    const wantTrivial = !!opts?.trivial;
    const matching = this.batchState.queued.filter((e) => e.trivial === wantTrivial);
    if (matching.length === 0) return null;

    const requests = matching.map((e) => ({
      custom_id: e.customId,
      params: injectCacheControl(e.body),
    }));

    let response: any;
    try {
      response = await requestUrl({
        url: BATCHES_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({ requests }),
        throw: false,
      });
    } catch (e) {
      throw new Error(`Iris Relay: batch submit failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    this.updateRateLimits(apiKey, response.headers);

    if (response.status >= 400) {
      const msg = response.json?.error?.message ?? `API ${response.status}`;
      throw new Error(`Iris Relay: batch submit failed: ${msg}`);
    }

    const batchId = response.json?.id;
    if (typeof batchId !== "string") {
      throw new Error("Iris Relay: batch submit returned no id.");
    }

    this.batchState.queued = this.batchState.queued.filter((e) => e.trivial !== wantTrivial);
    this.batchState.pending.push({
      batchId,
      role,
      submittedAt: Date.now(),
      entries: matching.map((e) => ({ customId: e.customId, callerId: e.callerId })),
    });
    await this.saveBatchState();
    this.notifyChange();

    this.schedulePoll(batchId, BATCH_POLL_FAST_MS);
    return batchId;
  }

  onBatchResult(callerId: string, handler: BatchResultHandler): () => void {
    this.batchHandlers.set(callerId, handler);
    const buffered = this.batchBuffered.get(callerId);
    if (buffered) {
      this.batchBuffered.delete(callerId);
      for (const { customId, result } of buffered) {
        try { handler(customId, result); }
        catch (e) { console.error("Iris Relay: batch handler threw", e); }
      }
    }
    return () => {
      if (this.batchHandlers.get(callerId) === handler) this.batchHandlers.delete(callerId);
    };
  }

  getLiveSnapshot(): {
    active: Array<{ id: number; model: string; role: "main" | "trivial"; priority: number; startedAt: number; callerId: string; cancelled: boolean }>;
    queued: Array<{ id: number; model: string; role: "main" | "trivial"; priority: number; callerId: string }>;
    batchQueued: Array<{ model: string; role: "main" | "trivial"; callerId: string; customId: string }>;
    batchPending: Array<{ batchId: string; entries: number; submittedAt: number; role: "main" | "trivial"; items: Array<{ customId: string; callerId: string }> }>;
    history: HistoryEntry[];
    callerStats: Array<{ callerId: string } & CallerStats>;
    stats: RelayStats;
  } {
    const trivialKey = this.settings.trivialApiKey;
    const roleOf = (k: string): "main" | "trivial" => (trivialKey && k === trivialKey ? "trivial" : "main");
    return {
      active: Array.from(this.activeRecords.values()).map((r) => ({
        id: r.id, callerId: r.callerId, model: r.model, role: r.role,
        priority: r.priority, startedAt: r.startedAt, cancelled: r.cancelled,
      })),
      queued: this.queue.map((e) => ({
        id: e.id,
        model: String(e.body.model || "?"),
        role: roleOf(e.apiKey),
        priority: e.priority,
        callerId: e.callerId,
      })),
      batchQueued: this.batchState.queued.map((e) => ({
        model: String(e.body.model || "?"),
        role: e.trivial ? "trivial" : "main",
        callerId: e.callerId,
        customId: e.customId,
      })),
      batchPending: this.batchState.pending.map((p) => ({
        batchId: p.batchId,
        entries: p.entries.length,
        submittedAt: p.submittedAt,
        role: p.role,
        items: p.entries.map((e) => ({ customId: e.customId, callerId: e.callerId })),
      })),
      history: this.history.slice().reverse(),
      callerStats: Array.from(this.callerStats.entries())
        .map(([callerId, s]) => ({ callerId, ...s }))
        .sort((a, b) => b.requests - a.requests),
      stats: { ...this.stats },
    };
  }

  getBatchState(): { queued: number; pending: Array<{ batchId: string; entries: number; submittedAt: number; role: "main" | "trivial" }> } {
    return {
      queued: this.batchState.queued.length,
      pending: this.batchState.pending.map((p) => ({
        batchId: p.batchId,
        entries: p.entries.length,
        submittedAt: p.submittedAt,
        role: p.role,
      })),
    };
  }

  resumePending(): void {
    if (this.batchState.queued.length > 0) {
      console.log(`Iris Relay: ${this.batchState.queued.length} batch entries queued (awaiting flush).`);
    }
    for (const p of this.batchState.pending) {
      this.schedulePoll(p.batchId, 0);
    }
  }

  private schedulePoll(batchId: string, delayMs: number): void {
    if (this.shutdownFlag) return;
    const existing = this.batchPollTimers.get(batchId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.batchPollTimers.delete(batchId);
      void this.pollBatch(batchId);
    }, delayMs);
    this.batchPollTimers.set(batchId, timer);
  }

  private async pollBatch(batchId: string): Promise<void> {
    if (this.shutdownFlag) return;
    const pending = this.batchState.pending.find((p) => p.batchId === batchId);
    if (!pending) return;

    const apiKey = this.resolveKey(pending.role);
    if (!apiKey) {
      console.warn(`Iris Relay: cannot poll batch ${batchId}, ${pending.role} key missing.`);
      this.schedulePoll(batchId, BATCH_POLL_SLOW_MS);
      return;
    }

    let statusResp: any;
    try {
      statusResp = await requestUrl({
        url: `${BATCHES_URL}/${batchId}`,
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        throw: false,
      });
    } catch (e) {
      console.warn(`Iris Relay: batch ${batchId} status fetch failed`, e);
      this.schedulePoll(batchId, BATCH_POLL_SLOW_MS);
      return;
    }

    if (statusResp.status >= 400) {
      console.warn(`Iris Relay: batch ${batchId} status ${statusResp.status}`);
      this.schedulePoll(batchId, BATCH_POLL_SLOW_MS);
      return;
    }

    const processing = statusResp.json?.processing_status;
    if (processing !== "ended") {
      const age = Date.now() - pending.submittedAt;
      const delay = age < BATCH_POLL_FAST_DURATION_MS ? BATCH_POLL_FAST_MS : BATCH_POLL_SLOW_MS;
      this.schedulePoll(batchId, delay);
      return;
    }

    let resultsResp: any;
    try {
      resultsResp = await requestUrl({
        url: `${BATCHES_URL}/${batchId}/results`,
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        throw: false,
      });
    } catch (e) {
      console.warn(`Iris Relay: batch ${batchId} results fetch failed`, e);
      this.schedulePoll(batchId, BATCH_POLL_SLOW_MS);
      return;
    }

    if (resultsResp.status >= 400) {
      console.warn(`Iris Relay: batch ${batchId} results status ${resultsResp.status}`);
      this.schedulePoll(batchId, BATCH_POLL_SLOW_MS);
      return;
    }

    const text: string = resultsResp.text || "";
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const callerById = new Map(pending.entries.map((e) => [e.customId, e.callerId]));

    for (const line of lines) {
      let parsed: any;
      try { parsed = JSON.parse(line); }
      catch { continue; }
      const customId = parsed.custom_id;
      const callerId = callerById.get(customId);
      if (!callerId) continue;
      const r = parsed.result;
      let result: BatchResult;
      let status: HistoryEntry["status"] = "ok";
      let response: Record<string, unknown> | undefined;
      let error: string | undefined;
      if (r?.type === "succeeded") {
        result = { ok: true, response: r.message };
        response = r.message;
      } else if (r?.type === "errored") {
        error = r.error?.error?.message || r.error?.message || "errored";
        result = { ok: false, error: error! };
        status = "error";
        this.bumpCaller(callerId, "errors", 1);
      } else if (r?.type === "canceled") {
        error = "canceled";
        result = { ok: false, error: error! };
        status = "cancelled";
      } else if (r?.type === "expired") {
        error = "expired";
        result = { ok: false, error: error! };
        status = "error";
        this.bumpCaller(callerId, "errors", 1);
      } else {
        error = "unknown result type";
        result = { ok: false, error: error! };
        status = "error";
      }

      this.recordHistory(
        {
          id: this.nextEntryId++,
          callerId,
          model: String((response as any)?.model || "?"),
          role: pending.role,
          priority: 0,
          startedAt: pending.submittedAt,
          customId,
        },
        status, response, error, "batch",
      );

      this.dispatchBatchResult(callerId, customId, result);
    }

    this.batchState.pending = this.batchState.pending.filter((p) => p.batchId !== batchId);
    await this.saveBatchState();
    this.notifyChange();
  }

  private dispatchBatchResult(callerId: string, customId: string, result: BatchResult): void {
    const handler = this.batchHandlers.get(callerId);
    if (handler) {
      try { handler(customId, result); }
      catch (e) { console.error("Iris Relay: batch handler threw", e); }
      return;
    }
    let buf = this.batchBuffered.get(callerId);
    if (!buf) { buf = []; this.batchBuffered.set(callerId, buf); }
    buf.push({ customId, result });
  }
}
