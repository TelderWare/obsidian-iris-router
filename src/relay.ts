import { Notice, requestUrl } from "obsidian";
import { HFClient, type HFRequestOptions, type ZeroShotResult, type NLIResult } from "./hf";
import {
  OpenAIClient, MistralClient, GroqClient, GeminiClient, HFChatClient, ElevenLabsClient,
  type ClientRequestOptions, type ProviderCallStats, type ElevenLabsVoice,
  type STTStreamHandlers, type STTStreamSession,
} from "./providers";

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

export type ApiProvider = "anthropic" | "hugging-face" | "openai" | "google" | "mistral" | "groq" | "elevenlabs";

export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  provider: ApiProvider;
}

export interface RelaySettings {
  apiKeys: ApiKeyEntry[];
  requestTimeoutMs: number;
  hfTimeoutMs?: number;
}

export interface RequestOptions {
  priority?: number;
  /** @deprecated kept for backwards compat; ignored — keys are now load-balanced automatically. */
  trivial?: boolean;
  signal?: AbortSignal;
  batch?: boolean;
  callerId?: string;
}

export interface BatchEnqueueOptions {
  customId: string;
  callerId: string;
  /** @deprecated kept for backwards compat; ignored. */
  trivial?: boolean;
}

export type BatchResult =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; error: string };

export type BatchResultHandler = (customId: string, result: BatchResult) => void;

export interface PersistedBatchEntry {
  customId: string;
  callerId: string;
  body: Record<string, unknown>;
}

export interface PersistedPendingBatch {
  batchId: string;
  keyId: string;
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
const PER_KEY_CONCURRENCY = 1;
const DEFAULT_DISPATCH_INTERVAL_MS = 750;
const THROTTLE_HEADROOM = 0.25;
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
  cacheKey: string;             // bodyKey (key-agnostic — keys are load-balanced)
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
  label: string;
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
  label: string;
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
  label: string;
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
  private pauseChangeListener?: () => void;
  private changePending = false;
  private drainScheduled = false;
  private paused = false;
  /** Per-key auto-pause state. Key = keyId (stable across rotation). Value = resume timestamp, or null = indefinite. */
  private keyPauseUntil = new Map<string, number | null>();
  private keyResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rateLimitUntil = new Map<string, number>();
  private rateLimitsRaw = new Map<string, Omit<RateLimitInfo, "label" | "concurrency">>();
  private lastDispatchAt = new Map<string, number>();
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

  private hfClient: HFClient;
  private hfChatClient: HFChatClient;
  private openaiClient: OpenAIClient;
  private mistralClient: MistralClient;
  private groqClient: GroqClient;
  private geminiClient: GeminiClient;
  private elevenlabsClient: ElevenLabsClient;

  constructor(settings: RelaySettings, batchPersistence?: BatchPersistence) {
    this.settings = settings;
    if (batchPersistence) {
      this.batchState = batchPersistence.initial;
      this.persistBatch = batchPersistence.save;
    }
    const sideTimeout = settings.hfTimeoutMs ?? settings.requestTimeoutMs;
    this.hfClient = new HFClient({ apiToken: this.providerToken("hugging-face"), timeoutMs: sideTimeout });
    this.hfClient.setStatsListener((stats) => this.recordHFCall(stats));

    this.openaiClient = new OpenAIClient({ apiToken: this.providerToken("openai"), timeoutMs: sideTimeout });
    this.mistralClient = new MistralClient({ apiToken: this.providerToken("mistral"), timeoutMs: sideTimeout });
    this.groqClient = new GroqClient({ apiToken: this.providerToken("groq"), timeoutMs: sideTimeout });
    this.geminiClient = new GeminiClient({ apiToken: this.providerToken("google"), timeoutMs: sideTimeout });
    this.hfChatClient = new HFChatClient({ apiToken: this.providerToken("hugging-face"), timeoutMs: sideTimeout });
    this.elevenlabsClient = new ElevenLabsClient({ apiToken: this.providerToken("elevenlabs"), timeoutMs: sideTimeout });
    const onProviderStats = (s: ProviderCallStats) => this.recordProviderCall(s);
    this.openaiClient.setStatsListener(onProviderStats);
    this.mistralClient.setStatsListener(onProviderStats);
    this.groqClient.setStatsListener(onProviderStats);
    this.geminiClient.setStatsListener(onProviderStats);
    this.hfChatClient.setStatsListener(onProviderStats);
    this.elevenlabsClient.setStatsListener(onProviderStats);
  }

  updateSettings(settings: RelaySettings): void {
    this.settings = settings;
    const sideTimeout = settings.hfTimeoutMs ?? settings.requestTimeoutMs;
    this.hfClient.updateSettings({ apiToken: this.providerToken("hugging-face"), timeoutMs: sideTimeout });
    this.openaiClient.updateSettings({ apiToken: this.providerToken("openai"), timeoutMs: sideTimeout });
    this.mistralClient.updateSettings({ apiToken: this.providerToken("mistral"), timeoutMs: sideTimeout });
    this.groqClient.updateSettings({ apiToken: this.providerToken("groq"), timeoutMs: sideTimeout });
    this.geminiClient.updateSettings({ apiToken: this.providerToken("google"), timeoutMs: sideTimeout });
    this.hfChatClient.updateSettings({ apiToken: this.providerToken("hugging-face"), timeoutMs: sideTimeout });
    this.elevenlabsClient.updateSettings({ apiToken: this.providerToken("elevenlabs"), timeoutMs: sideTimeout });
  }

  private providerToken(provider: ApiProvider): string {
    return this.settings.apiKeys.find(e => e.provider === provider && e.key)?.key ?? "";
  }

  private anthropicKeys(): ApiKeyEntry[] {
    return this.settings.apiKeys.filter(e => e.key && e.provider === "anthropic");
  }

  isHFConfigured(): boolean {
    return this.hfClient.isConfigured();
  }

  /**
   * Validate an API key by hitting a cheap auth-only endpoint per provider.
   * Doesn't consume model tokens — just checks credentials.
   * Returns { ok: true } for HTTP 2xx, otherwise { ok: false, status, error }.
   */
  async testKey(provider: ApiProvider, key: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!key) return { ok: false, error: "no key" };

    let url: string;
    let headers: Record<string, string> = {};

    switch (provider) {
      case "anthropic":
        url = "https://api.anthropic.com/v1/models";
        headers = { "x-api-key": key, "anthropic-version": API_VERSION };
        break;
      case "openai":
        url = "https://api.openai.com/v1/models";
        headers = { "Authorization": `Bearer ${key}` };
        break;
      case "mistral":
        url = "https://api.mistral.ai/v1/models";
        headers = { "Authorization": `Bearer ${key}` };
        break;
      case "groq":
        url = "https://api.groq.com/openai/v1/models";
        headers = { "Authorization": `Bearer ${key}` };
        break;
      case "google":
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
        break;
      case "hugging-face":
        url = "https://huggingface.co/api/whoami-v2";
        headers = { "Authorization": `Bearer ${key}` };
        break;
      case "elevenlabs":
        url = "https://api.elevenlabs.io/v1/voices";
        headers = { "xi-api-key": key };
        break;
      default:
        return { ok: false, error: `unknown provider: ${provider}` };
    }

    try {
      const resp = await requestUrl({ url, method: "GET", headers, throw: false });
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, status: resp.status };
      }
      let errMsg = "";
      try {
        const json = resp.json;
        if (json?.error?.message) errMsg = json.error.message;
        else if (typeof json?.error === "string") errMsg = json.error;
        else if (json?.message) errMsg = json.message;
      } catch { /* ignore parse errors */ }
      return { ok: false, status: resp.status, error: errMsg || `HTTP ${resp.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Zero-shot classification via HF Inference API (NLI under the hood).
   * Default model: `MoritzLaurer/deberta-v3-base-zeroshot-v2.0`.
   * Pass `multiLabel: true` when multiple labels can apply independently.
   */
  async classify(
    text: string,
    candidateLabels: string[],
    options?: HFRequestOptions & { model?: string; multiLabel?: boolean; hypothesisTemplate?: string },
  ): Promise<ZeroShotResult> {
    const model = options?.model ?? "MoritzLaurer/deberta-v3-base-zeroshot-v2.0";
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.hfClient.classify(text, candidateLabels, model, { ...options, callerId });
  }

  /**
   * Cross-encoder NLI: probability that `premise` entails `hypothesis`.
   * Default model: `cross-encoder/nli-deberta-v3-base`.
   */
  async nli(
    premise: string,
    hypothesis: string,
    options?: HFRequestOptions & { model?: string },
  ): Promise<NLIResult> {
    const model = options?.model ?? "cross-encoder/nli-deberta-v3-base";
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.hfClient.nli(premise, hypothesis, model, { ...options, callerId });
  }

  /**
   * Sentence embeddings. Default model: `sentence-transformers/all-MiniLM-L6-v2`.
   * Returns one vector per input.
   */
  async embed(
    texts: string[],
    options?: HFRequestOptions & { model?: string },
  ): Promise<number[][]> {
    const model = options?.model ?? "sentence-transformers/all-MiniLM-L6-v2";
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.hfClient.embed(texts, model, { ...options, callerId });
  }

  /**
   * Low-level passthrough for any HF Inference API task not covered above
   * (e.g. summarization, NER). The caller is responsible for shaping the
   * payload and parsing the response.
   */
  async hfRaw<T>(
    model: string,
    payload: unknown,
    task: string,
    options?: HFRequestOptions,
  ): Promise<T> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.hfClient.raw<T>(model, payload, task, { ...options, callerId });
  }

  isOpenAIConfigured(): boolean { return this.openaiClient.isConfigured(); }
  isMistralConfigured(): boolean { return this.mistralClient.isConfigured(); }
  isGroqConfigured(): boolean { return this.groqClient.isConfigured(); }
  isGeminiConfigured(): boolean { return this.geminiClient.isConfigured(); }
  isElevenLabsConfigured(): boolean { return this.elevenlabsClient.isConfigured(); }

  async elevenLabsTTS(
    text: string,
    voiceId: string,
    options?: ClientRequestOptions & { modelId?: string },
  ): Promise<ArrayBuffer> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.elevenlabsClient.tts(text, voiceId, { ...options, callerId });
  }

  async elevenLabsSTT(
    audioBlob: Blob,
    options?: ClientRequestOptions,
  ): Promise<string> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.elevenlabsClient.stt(audioBlob, { ...options, callerId });
  }

  async elevenLabsSTTStream(
    handlers: STTStreamHandlers,
    options?: ClientRequestOptions,
  ): Promise<STTStreamSession> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.elevenlabsClient.sttStream(handlers, { ...options, callerId });
  }

  /** Pre-fetch a single-use STT token so the next sttStream() call connects faster. */
  async prewarmSTT(options?: ClientRequestOptions): Promise<void> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.elevenlabsClient.prewarmSTT({ ...options, callerId });
  }

  async elevenLabsVoices(
    options?: ClientRequestOptions,
  ): Promise<ElevenLabsVoice[]> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.elevenlabsClient.voices({ ...options, callerId });
  }

  /**
   * Passthrough OpenAI Chat Completions. Body is forwarded as-is — caller owns
   * the shape (model, messages, max_tokens, tools, etc.). Independent of the
   * Anthropic queue: no multi-key load balancing, no prompt cache, no batches.
   */
  async openaiRequest<T = Record<string, unknown>>(
    body: Record<string, unknown>,
    options?: ClientRequestOptions,
  ): Promise<T> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.openaiClient.chat<T>(body, { ...options, callerId });
  }

  /**
   * Passthrough HuggingFace OpenAI-compatible chat completions via the HF Inference router.
   * Body must include `model` (e.g. "NousResearch/Hermes-4-70B"). The HF router applies the
   * model's canonical chat template server-side, so callers don't need to format ChatML or
   * other model-specific templates. Independent of `classify`/`nli`/`embed`/`hfRaw`, which
   * use the older `api-inference.huggingface.co/models/{model}` endpoint.
   */
  async hfChatCompletions<T = Record<string, unknown>>(
    body: Record<string, unknown>,
    options?: ClientRequestOptions,
  ): Promise<T> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.hfChatClient.chat<T>(body, { ...options, callerId });
  }

  /** Passthrough Mistral Chat Completions. See `openaiRequest` for caveats. */
  async mistralRequest<T = Record<string, unknown>>(
    body: Record<string, unknown>,
    options?: ClientRequestOptions,
  ): Promise<T> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.mistralClient.chat<T>(body, { ...options, callerId });
  }

  /** Passthrough Groq Chat Completions (OpenAI-compatible). See `openaiRequest` for caveats. */
  async groqRequest<T = Record<string, unknown>>(
    body: Record<string, unknown>,
    options?: ClientRequestOptions,
  ): Promise<T> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.groqClient.chat<T>(body, { ...options, callerId });
  }

  /**
   * Passthrough Gemini generateContent. Model goes in the URL (Gemini's convention),
   * body is forwarded as-is. Pass `method: "streamGenerateContent"` in options to hit
   * the streaming endpoint instead — the client returns the raw response either way.
   */
  async geminiRequest<T = Record<string, unknown>>(
    model: string,
    body: Record<string, unknown>,
    options?: ClientRequestOptions & { method?: "generateContent" | "streamGenerateContent" },
  ): Promise<T> {
    const callerId = options?.callerId ?? deriveCallerIdFromStack() ?? "?";
    return this.geminiClient.generateContent<T>(model, body, { ...options, callerId });
  }

  private recordProviderCall(s: ProviderCallStats): void {
    this.stats.totalRequests += 1;
    this.stats.attempts += 1;
    if (s.status === "error") this.stats.errors += 1;
    const cs = this.getCallerStats(s.callerId);
    cs.requests += 1;
    if (s.status === "error") cs.errors += 1;
    if (s.inputTokens) cs.inputTokens += s.inputTokens;
    if (s.outputTokens) cs.outputTokens += s.outputTokens;
    this.history.unshift({
      id: this.nextEntryId++,
      callerId: s.callerId,
      model: s.model,
      label: s.provider,
      priority: 5,
      mode: "sync",
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status === "ok" ? "ok" : "error",
      inputTokens: s.inputTokens ?? 0,
      outputTokens: s.outputTokens ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      error: s.error,
    });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    this.notifyChange();
  }

  private recordHFCall(_stats: { callerId: string; model: string; task: string; status: "ok" | "error"; error?: string; startedAt: number; endedAt: number }): void {
    // Counted as a request for top-line stats. Token usage is unavailable from HF.
    this.stats.totalRequests += 1;
    this.stats.attempts += 1;
    if (_stats.status === "error") this.stats.errors += 1;
    const cs = this.getCallerStats(_stats.callerId);
    cs.requests += 1;
    if (_stats.status === "error") cs.errors += 1;
    this.history.unshift({
      id: this.nextEntryId++,
      callerId: _stats.callerId,
      model: _stats.model,
      label: `hf:${_stats.task}`,
      priority: 5,
      mode: "sync",
      startedAt: _stats.startedAt,
      endedAt: _stats.endedAt,
      status: _stats.status === "ok" ? "ok" : "error",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      error: _stats.error,
    });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    this.notifyChange();
  }

  getRateLimits(): RateLimitInfo[] {
    const result: RateLimitInfo[] = [];
    for (const [key, raw] of this.rateLimitsRaw) {
      result.push({ ...raw, label: this.labelFor(key), concurrency: PER_KEY_CONCURRENCY });
    }
    return result;
  }

  private labelFor(apiKey: string): string {
    const entry = this.settings.apiKeys.find(e => e.key === apiKey);
    return entry?.label || "unknown";
  }

  private entryById(id: string): ApiKeyEntry | undefined {
    return this.settings.apiKeys.find(e => e.id === id);
  }

  private chooseKey(opts?: { excludePaused?: boolean }): { id: string; key: string } | null {
    const candidates = this.anthropicKeys().filter(e => !(opts?.excludePaused && this.isKeyPaused(e.id)));
    if (candidates.length === 0) return null;

    const now = Date.now();
    const score = (key: string): number => {
      // Hard penalty for keys we know are in backoff right now.
      const rlUntil = this.rateLimitUntil.get(key) || 0;
      if (now < rlUntil) return -1 - (rlUntil - now) / 1000;

      const info = this.rateLimitsRaw.get(key);
      const reqRatio = !info ? 1
        : info.requestsReset && info.requestsReset <= now ? 1
        : info.requestsLimit > 0 ? info.requestsRemaining / info.requestsLimit : 1;
      const tokRatio = !info ? 1
        : info.tokensReset && info.tokensReset <= now ? 1
        : info.tokensLimit > 0 ? info.tokensRemaining / info.tokensLimit : 1;
      const cap = this.maxConcurrencyFor(key);
      const queuedAgainstKey = this.queue.reduce((n, e) => n + (e.apiKey === key ? 1 : 0), 0);
      const loadPenalty = ((this.getActive(key) + queuedAgainstKey) / cap) * 0.25;
      return Math.min(reqRatio, tokRatio) - loadPenalty;
    };
    const ranked = candidates
      .map(e => ({ id: e.id, key: e.key, s: score(e.key) }))
      .sort((a, b) => b.s - a.s);
    return { id: ranked[0].id, key: ranked[0].key };
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
    for (const t of this.keyResumeTimers.values()) clearTimeout(t);
    this.keyResumeTimers.clear();
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
    if (this.paused) throw new Error("Iris Relay: relay is paused.");
    const chosen = this.chooseKey({ excludePaused: true });
    if (!chosen) {
      if (this.anthropicKeys().length === 0) {
        throw new Error("Iris Relay: no Anthropic API key configured.");
      }
      throw new Error("Iris Relay: all Anthropic API keys are paused.");
    }
    if (this.queue.length >= MAX_QUEUE_SIZE) throw new Error("Iris Relay: queue full, try again later.");

    this.stats.totalRequests++;
    const validated = validateBody(body);
    const priority = typeof options?.priority === "number"
      ? Math.max(0, Math.min(10, options.priority))
      : DEFAULT_PRIORITY;
    const apiKey = chosen.key;
    const bodyKey = JSON.stringify(validated);
    const cacheKey = bodyKey;

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

  private maxConcurrencyFor(_apiKey: string): number {
    return PER_KEY_CONCURRENCY;
  }

  private minDispatchIntervalFor(apiKey: string): number {
    const info = this.rateLimitsRaw.get(apiKey);
    if (!info || info.requestsLimit <= 0) return DEFAULT_DISPATCH_INTERVAL_MS;
    return Math.ceil(60_000 / (info.requestsLimit * 0.8));
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

  setPauseChangeListener(listener: (() => void) | undefined): void {
    this.pauseChangeListener = listener;
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
    if (paused) this.failQueued("relay is paused.");
    this.notifyChange();
    this.pauseChangeListener?.();
    if (!paused) this.scheduleDrain();
  }

  private failQueued(reason: string): void {
    if (this.queue.length === 0) return;
    for (const entry of this.queue.splice(0)) {
      this.cleanupAbortListener(entry);
      this.stats.errors++;
      this.bumpCaller(entry.callerId, "errors", 1);
      entry.reject(new Error(`Iris Relay: ${reason}`));
    }
    this.notifyChange();
  }

  private allKeysPaused(): boolean {
    const configured = this.anthropicKeys();
    return configured.length > 0 && configured.every(e => this.isKeyPaused(e.id));
  }

  /** True if the key is auto-paused right now. Lazily cleans up expired entries. */
  isKeyPaused(keyId: string): boolean {
    if (!this.keyPauseUntil.has(keyId)) return false;
    const until = this.keyPauseUntil.get(keyId);
    if (until !== null && Date.now() >= until!) {
      this.clearKeyPauseInternal(keyId);
      return false;
    }
    return true;
  }

  /** Snapshot of all per-key pauses for persistence and UI. */
  getKeyPauses(): Array<{ keyId: string; until: number | null }> {
    const result: Array<{ keyId: string; until: number | null }> = [];
    for (const [keyId, until] of this.keyPauseUntil) {
      if (until !== null && Date.now() >= until) continue;
      result.push({ keyId, until });
    }
    return result;
  }

  /**
   * Pause or resume a single key.
   * `until` = future timestamp for auto-resume, or null = indefinite (manual resume only).
   * Pass paused=false to clear.
   */
  setKeyPause(keyId: string, paused: boolean, until: number | null = null): void {
    if (!paused) {
      if (!this.keyPauseUntil.has(keyId)) return;
      this.clearKeyPauseInternal(keyId);
      this.notifyChange();
      this.pauseChangeListener?.();
      this.scheduleDrain();
      return;
    }

    const safeUntil = until !== null && until > Date.now() ? until : null;
    const prev = this.keyPauseUntil.get(keyId);
    if (this.keyPauseUntil.has(keyId) && prev === safeUntil) return;

    this.clearKeyResumeTimer(keyId);
    this.keyPauseUntil.set(keyId, safeUntil);
    if (safeUntil !== null) {
      const timer = setTimeout(() => {
        this.keyResumeTimers.delete(keyId);
        if (this.keyPauseUntil.get(keyId) === safeUntil) {
          const label = this.entryById(keyId)?.label || keyId;
          new Notice(`Iris Relay: auto-resuming "${label}" after rate-limit window expired.`, 6000);
          this.setKeyPause(keyId, false);
        }
      }, Math.max(0, safeUntil - Date.now()));
      this.keyResumeTimers.set(keyId, timer);
    }
    if (this.allKeysPaused()) this.failQueued("all API keys are paused.");
    this.notifyChange();
    this.pauseChangeListener?.();
  }

  private clearKeyResumeTimer(keyId: string): void {
    const t = this.keyResumeTimers.get(keyId);
    if (t !== undefined) {
      clearTimeout(t);
      this.keyResumeTimers.delete(keyId);
    }
  }

  private clearKeyPauseInternal(keyId: string): void {
    this.clearKeyResumeTimer(keyId);
    this.keyPauseUntil.delete(keyId);
  }

  private isFatalAccountError(status: number, message: string): boolean {
    if (status === 401 || status === 403) return true;
    if (status === 400 && /specified API limit|credit balance is too low|reached your.*limit|usage limit/i.test(message)) return true;
    return false;
  }

  /** Parse "regain access on YYYY-MM-DD at HH:MM UTC" out of the API error message. */
  private parseRegainAccessTime(message: string): number | null {
    const m = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})\s*UTC/i.exec(message);
    if (!m) return null;
    const ts = Date.parse(`${m[1]}T${m[2]}:00Z`);
    return Number.isFinite(ts) ? ts : null;
  }

  private notifyFatal(label: string, message: string, status: number, until: number | null): void {
    const suffix = until ? ` Auto-resuming at ${new Date(until).toISOString().replace(/\.\d+Z$/, "Z")}.` : "";
    new Notice(`Iris Relay paused key "${label}": ${message} (HTTP ${status}).${suffix}`, 10000);
  }

  private keyIdForApiKey(apiKey: string): string | undefined {
    return this.settings.apiKeys.find(e => e.key === apiKey)?.id;
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

      // First check: any Anthropic keys configured at all? If not, fail fast.
      if (this.anthropicKeys().length === 0) {
        this.queue.splice(i, 1);
        this.cleanupAbortListener(entry);
        entry.reject(new Error("Iris Relay: no Anthropic API key configured."));
        continue;
      }

      const chosen = this.chooseKey({ excludePaused: true });
      if (!chosen) {
        // Defensive: setPaused / setKeyPause should have already failed the queue,
        // but if a race lands an entry here with no dispatchable key, fail it now
        // rather than letting it hang.
        this.queue.splice(i, 1);
        this.cleanupAbortListener(entry);
        this.stats.errors++;
        this.bumpCaller(entry.callerId, "errors", 1);
        entry.reject(new Error("Iris Relay: all Anthropic API keys are paused."));
        continue;
      }
      const apiKey = chosen.key;
      entry.apiKey = apiKey;

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

      const nextDispatchAt = (this.lastDispatchAt.get(apiKey) || 0) + this.minDispatchIntervalFor(apiKey);
      if (now < nextDispatchAt) {
        earliestRetry = Math.min(earliestRetry, nextDispatchAt);
        i++;
        continue;
      }

      this.queue.splice(i, 1);
      this.cleanupAbortListener(entry);
      this.lastDispatchAt.set(apiKey, now);
      this.adjustActive(apiKey, 1);
      const record: ActiveRecord = {
        id: entry.id,
        callerId: entry.callerId,
        model: String(entry.body.model || "?"),
        label: this.labelFor(apiKey),
        priority: entry.priority,
        startedAt: Date.now(),
        cancelled: false,
      };
      this.activeRecords.set(entry.id, record);
      this.notifyChange();
      this.execute(entry, record).finally(() => {
        this.activeRecords.delete(entry.id);
        // Use entry.apiKey (not the drain-time `apiKey` const) — executeInner may have
        // switched the entry to a different key on retry.
        this.adjustActive(entry.apiKey, -1);
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

    if (info.tokensRemaining < info.tokensLimit * THROTTLE_HEADROOM) return true;
    if (info.requestsRemaining < info.requestsLimit * THROTTLE_HEADROOM) return true;
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
    const { cacheKey, signal } = entry;
    let apiKey = entry.apiKey;

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
        // Re-pick a key for this retry — the previous one may have just been rate-limited.
        const next = this.chooseKey();
        if (next && next.key !== apiKey) {
          this.adjustActive(apiKey, -1);
          this.adjustActive(next.key, +1);
          apiKey = next.key;
          entry.apiKey = apiKey;
          record.label = this.labelFor(apiKey);
        }
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
          if (this.isFatalAccountError(response.status, msg)) {
            const until = this.parseRegainAccessTime(msg);
            const keyId = this.keyIdForApiKey(apiKey);
            if (keyId) {
              this.setKeyPause(keyId, true, until);
              this.notifyFatal(this.labelFor(apiKey), msg, response.status, until);
            }
          }
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
    record: { id: number; callerId: string; model: string; label: string; priority: number; startedAt: number; customId?: string },
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
      label: record.label,
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
      label: this.labelFor(entry.apiKey),
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
    const apiKey = this.entryById(pending.keyId)?.key;
    if (!apiKey) {
      console.warn(`Iris Relay: cannot cancel batch ${batchId}, configured key missing.`);
      return false;
    }
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
      body: validated,
    });
    this.bumpCaller(opts.callerId, "requests", 1);
    void this.saveBatchState();
    this.notifyChange();
  }

  async flushBatch(_opts?: { trivial?: boolean }): Promise<string | null> {
    if (this.paused) throw new Error("Iris Relay: relay is paused.");
    const chosen = this.chooseKey({ excludePaused: true });
    if (!chosen) {
      if (this.anthropicKeys().length === 0) {
        throw new Error("Iris Relay: no Anthropic API key configured.");
      }
      throw new Error("Iris Relay: all Anthropic API keys are paused.");
    }

    const matching = this.batchState.queued;
    if (matching.length === 0) return null;

    const apiKey = chosen.key;
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
      if (this.isFatalAccountError(response.status, msg)) {
        const until = this.parseRegainAccessTime(msg);
        this.setKeyPause(chosen.id, true, until);
        this.notifyFatal(this.labelFor(apiKey), msg, response.status, until);
      }
      throw new Error(`Iris Relay: batch submit failed: ${msg}`);
    }

    const batchId = response.json?.id;
    if (typeof batchId !== "string") {
      throw new Error("Iris Relay: batch submit returned no id.");
    }

    this.batchState.queued = [];
    this.batchState.pending.push({
      batchId,
      keyId: chosen.id,
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
    active: Array<{ id: number; model: string; label: string; priority: number; startedAt: number; callerId: string; cancelled: boolean }>;
    queued: Array<{ id: number; model: string; label: string; priority: number; callerId: string }>;
    batchQueued: Array<{ model: string; callerId: string; customId: string }>;
    batchPending: Array<{ batchId: string; entries: number; submittedAt: number; label: string; items: Array<{ customId: string; callerId: string }> }>;
    history: HistoryEntry[];
    callerStats: Array<{ callerId: string } & CallerStats>;
    stats: RelayStats;
  } {
    return {
      active: Array.from(this.activeRecords.values()).map((r) => ({
        id: r.id, callerId: r.callerId, model: r.model, label: r.label,
        priority: r.priority, startedAt: r.startedAt, cancelled: r.cancelled,
      })),
      queued: this.queue.map((e) => ({
        id: e.id,
        model: String(e.body.model || "?"),
        label: this.labelFor(e.apiKey),
        priority: e.priority,
        callerId: e.callerId,
      })),
      batchQueued: this.batchState.queued.map((e) => ({
        model: String(e.body.model || "?"),
        callerId: e.callerId,
        customId: e.customId,
      })),
      batchPending: this.batchState.pending.map((p) => ({
        batchId: p.batchId,
        entries: p.entries.length,
        submittedAt: p.submittedAt,
        label: this.entryById(p.keyId)?.label || "unknown",
        items: p.entries.map((e) => ({ customId: e.customId, callerId: e.callerId })),
      })),
      history: this.history.slice().reverse(),
      callerStats: Array.from(this.callerStats.entries())
        .map(([callerId, s]) => ({ callerId, ...s }))
        .sort((a, b) => b.requests - a.requests),
      stats: { ...this.stats },
    };
  }

  getBatchState(): { queued: number; pending: Array<{ batchId: string; entries: number; submittedAt: number; label: string }> } {
    return {
      queued: this.batchState.queued.length,
      pending: this.batchState.pending.map((p) => ({
        batchId: p.batchId,
        entries: p.entries.length,
        submittedAt: p.submittedAt,
        label: this.entryById(p.keyId)?.label || "unknown",
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

    const apiKey = this.entryById(pending.keyId)?.key;
    if (!apiKey) {
      console.warn(`Iris Relay: cannot poll batch ${batchId}, configured key missing.`);
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
          label: this.entryById(pending.keyId)?.label || "unknown",
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
