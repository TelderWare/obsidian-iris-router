import { requestUrl } from "obsidian";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ClientSettings {
  apiToken: string;
  timeoutMs: number;
}

export interface ClientRequestOptions {
  callerId?: string;
  signal?: AbortSignal;
}

export interface ProviderCallStats {
  callerId: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  status: "ok" | "error";
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type ProviderStatsListener = (stats: ProviderCallStats) => void;

function sleep(ms: number, signal: AbortSignal | undefined, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Iris ${prefix}: request aborted.`));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error(`Iris ${prefix}: request aborted.`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunk to avoid call-stack limits on large buffers (~64k arg cap on String.fromCharCode).
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function errorMsg(json: any): string {
  if (!json) return "(no body)";
  if (typeof json === "string") return json;
  if (typeof json.error === "string") return json.error;
  if (json.error?.message) return json.error.message;
  if (json.message) return json.message;
  return JSON.stringify(json).slice(0, 200);
}

function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  prefix: string,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Iris ${prefix}: request timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Iris ${prefix}: request aborted.`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      throw: false,
    }).then((resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      let json: any = null;
      try { json = resp.json; } catch { try { json = JSON.parse(resp.text || "null"); } catch { json = resp.text; } }
      resolve({ status: resp.status, json });
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

interface CallParams {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  model: string;
  prefix: string;
  provider: string;
  options?: ClientRequestOptions;
}

abstract class BaseProviderClient {
  protected settings: ClientSettings;
  protected statsListener?: ProviderStatsListener;

  constructor(settings: ClientSettings) {
    this.settings = settings;
  }

  updateSettings(settings: ClientSettings): void {
    this.settings = settings;
  }

  setStatsListener(listener: ProviderStatsListener | undefined): void {
    this.statsListener = listener;
  }

  isConfigured(): boolean {
    return !!this.settings.apiToken;
  }

  protected async call<T>(p: CallParams): Promise<T> {
    if (!this.settings.apiToken) {
      throw new Error(`Iris ${p.prefix}: no API token configured.`);
    }
    if (p.options?.signal?.aborted) {
      throw new Error(`Iris ${p.prefix}: request aborted.`);
    }

    const callerId = p.options?.callerId ?? "?";
    const startedAt = Date.now();
    const timeoutMs = this.settings.timeoutMs || DEFAULT_TIMEOUT_MS;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const resp = await fetchWithTimeout(p.url, p.headers, p.body, timeoutMs, p.options?.signal, p.prefix);
        if (resp.status >= 200 && resp.status < 300) {
          const usage = extractUsage(resp.json);
          this.emit({
            callerId, provider: p.provider, model: p.model,
            startedAt, endedAt: Date.now(), status: "ok",
            inputTokens: usage.input, outputTokens: usage.output,
          });
          return resp.json as T;
        }
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`Iris ${p.prefix}: ${resp.status} ${errorMsg(resp.json)}`);
          if (attempt < DEFAULT_MAX_RETRIES) {
            await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), p.options?.signal, p.prefix);
            continue;
          }
        }
        throw new Error(`Iris ${p.prefix}: ${resp.status} ${errorMsg(resp.json)}`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("aborted")) {
          this.emit({ callerId, provider: p.provider, model: p.model, startedAt, endedAt: Date.now(), status: "error", error: "aborted" });
          throw err;
        }
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), p.options?.signal, p.prefix);
          continue;
        }
      }
    }

    const errStr = lastErr?.message ?? `Iris ${p.prefix}: all retries exhausted`;
    this.emit({ callerId, provider: p.provider, model: p.model, startedAt, endedAt: Date.now(), status: "error", error: errStr });
    throw lastErr ?? new Error(errStr);
  }

  private emit(s: ProviderCallStats): void {
    try { this.statsListener?.(s); } catch { /* listener errors are not fatal */ }
  }
}

/** Extract token usage from common response shapes. Returns 0/0 if not present. */
function extractUsage(json: any): { input: number; output: number } {
  if (!json || typeof json !== "object") return { input: 0, output: 0 };
  // OpenAI/Mistral/Groq style
  if (json.usage && typeof json.usage === "object") {
    const u = json.usage;
    if (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number") {
      return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
    }
  }
  // Gemini style
  if (json.usageMetadata && typeof json.usageMetadata === "object") {
    const u = json.usageMetadata;
    return { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0 };
  }
  return { input: 0, output: 0 };
}

function bodyModel(body: unknown): string {
  if (body && typeof body === "object" && "model" in body) {
    const m = (body as Record<string, unknown>).model;
    if (typeof m === "string") return m;
  }
  return "?";
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export class OpenAIClient extends BaseProviderClient {
  /** Passthrough OpenAI Chat Completions. Body is forwarded as-is; caller owns the shape. */
  async chat<T = Record<string, unknown>>(body: Record<string, unknown>, options?: ClientRequestOptions): Promise<T> {
    return this.call<T>({
      url: OPENAI_URL,
      headers: { "Authorization": `Bearer ${this.settings.apiToken}` },
      body, model: bodyModel(body),
      prefix: "OpenAI", provider: "openai", options,
    });
  }
}

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

export class MistralClient extends BaseProviderClient {
  /** Passthrough Mistral Chat Completions. */
  async chat<T = Record<string, unknown>>(body: Record<string, unknown>, options?: ClientRequestOptions): Promise<T> {
    return this.call<T>({
      url: MISTRAL_URL,
      headers: { "Authorization": `Bearer ${this.settings.apiToken}` },
      body, model: bodyModel(body),
      prefix: "Mistral", provider: "mistral", options,
    });
  }
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export class GroqClient extends BaseProviderClient {
  /** Passthrough Groq Chat Completions (OpenAI-compatible). */
  async chat<T = Record<string, unknown>>(body: Record<string, unknown>, options?: ClientRequestOptions): Promise<T> {
    return this.call<T>({
      url: GROQ_URL,
      headers: { "Authorization": `Bearer ${this.settings.apiToken}` },
      body, model: bodyModel(body),
      prefix: "Groq", provider: "groq", options,
    });
  }
}

const HF_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

export class HFChatClient extends BaseProviderClient {
  /**
   * Passthrough HuggingFace OpenAI-compatible chat completions via the unified router endpoint.
   * Body must include `model` (e.g. "NousResearch/Hermes-4-70B" or "model:provider" to pin a
   * specific provider like "meta-llama/Llama-3.1-8B-Instruct:together"). HF auto-routes to
   * whichever inference provider hosts the model and is linked to the token.
   */
  async chat<T = Record<string, unknown>>(body: Record<string, unknown>, options?: ClientRequestOptions): Promise<T> {
    const model = bodyModel(body);
    if (model === "?") {
      throw new Error("Iris HF Chat: body must include a 'model' field.");
    }
    return this.call<T>({
      url: HF_CHAT_URL,
      headers: { "Authorization": `Bearer ${this.settings.apiToken}` },
      body, model,
      prefix: "HF Chat", provider: "hugging-face", options,
    });
  }
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiClient extends BaseProviderClient {
  /**
   * Passthrough Gemini generateContent. Model goes in the URL (Gemini's convention),
   * body is forwarded as-is. Use streaming via `:streamGenerateContent` if you need
   * to call that directly — pass `method: "streamGenerateContent"` in options.
   */
  async generateContent<T = Record<string, unknown>>(
    model: string,
    body: Record<string, unknown>,
    options?: ClientRequestOptions & { method?: "generateContent" | "streamGenerateContent" },
  ): Promise<T> {
    const method = options?.method ?? "generateContent";
    return this.call<T>({
      url: `${GEMINI_BASE}/${encodeURIComponent(model)}:${method}`,
      headers: { "x-goog-api-key": this.settings.apiToken },
      body, model,
      prefix: "Gemini", provider: "google", options,
    });
  }
}

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  /** "premade", "cloned", "generated", "professional", ... */
  category?: string;
  description?: string;
  /** ElevenLabs voice labels, e.g. { gender, age, accent, description, use_case }. */
  labels?: Record<string, string>;
  /** Short sample clip hosted by ElevenLabs. */
  preview_url?: string;
}

export interface STTStreamHandlers {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
  onClose?: () => void;
}

export interface STTStreamSession {
  /** Send a chunk of 16-bit little-endian PCM audio at 16 kHz. */
  sendAudio(pcm16le: ArrayBuffer): void;
  /** Flush + commit and close politely. */
  end(): void;
  /** Hard abort. */
  close(): void;
}

export class ElevenLabsClient extends BaseProviderClient {
  // Cached single-use STT token for prewarming. Single-use, so we drop it on
  // consume. 14-min freshness ceiling (server expiry is 15 min).
  private cachedSTTToken: { token: string; expiresAt: number } | null = null;
  private cachedSTTTokenInflight: Promise<string> | null = null;

  /** Pre-fetch a single-use STT token in the background. Idempotent. */
  async prewarmSTT(options?: ClientRequestOptions): Promise<void> {
    if (!this.settings.apiToken) return;
    if (this.cachedSTTToken && this.cachedSTTToken.expiresAt > Date.now()) return;
    if (this.cachedSTTTokenInflight) { try { await this.cachedSTTTokenInflight; } catch { /* */ } return; }
    this.cachedSTTTokenInflight = this.singleUseToken("realtime_scribe", options)
      .then((token) => {
        this.cachedSTTToken = { token, expiresAt: Date.now() + 14 * 60 * 1000 };
        return token;
      })
      .finally(() => { this.cachedSTTTokenInflight = null; });
    try { await this.cachedSTTTokenInflight; } catch { /* swallow — best effort */ }
  }

  /** Take the cached token if fresh, else fetch a new one. Always single-use. */
  private async takeSTTToken(options?: ClientRequestOptions): Promise<string> {
    if (this.cachedSTTToken && this.cachedSTTToken.expiresAt > Date.now()) {
      const t = this.cachedSTTToken.token;
      this.cachedSTTToken = null;
      return t;
    }
    if (this.cachedSTTTokenInflight) {
      try {
        const t = await this.cachedSTTTokenInflight;
        // Inflight prewarm completed and stored — consume it.
        this.cachedSTTToken = null;
        return t;
      } catch {
        // fallthrough to a fresh fetch
      }
    }
    return this.singleUseToken("realtime_scribe", options);
  }

  async tts(
    text: string,
    voiceId: string,
    options?: ClientRequestOptions & { modelId?: string },
  ): Promise<ArrayBuffer> {
    if (!this.settings.apiToken) throw new Error("Iris ElevenLabs: no API token configured.");
    if (options?.signal?.aborted) throw new Error("Iris ElevenLabs: request aborted.");

    const callerId = options?.callerId ?? "?";
    const startedAt = Date.now();
    const modelId = options?.modelId ?? "eleven_flash_v2_5";
    const timeoutMs = this.settings.timeoutMs || DEFAULT_TIMEOUT_MS;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const resp = await this.binaryPost(
          `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
          { "xi-api-key": this.settings.apiToken, "Content-Type": "application/json" },
          JSON.stringify({ text, model_id: modelId, output_format: "mp3_44100_128" }),
          timeoutMs, options?.signal,
        );
        if (resp.status >= 200 && resp.status < 300) {
          this.emitStats({ callerId, provider: "elevenlabs", model: modelId, startedAt, endedAt: Date.now(), status: "ok" });
          return resp.body;
        }
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`Iris ElevenLabs TTS: ${resp.status}`);
          if (attempt < DEFAULT_MAX_RETRIES) {
            await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), options?.signal, "ElevenLabs TTS");
            continue;
          }
        }
        throw new Error(`Iris ElevenLabs TTS: ${resp.status}`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("aborted")) {
          this.emitStats({ callerId, provider: "elevenlabs", model: modelId, startedAt, endedAt: Date.now(), status: "error", error: "aborted" });
          throw err;
        }
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), options?.signal, "ElevenLabs TTS");
          continue;
        }
      }
    }
    const errStr = lastErr?.message ?? "Iris ElevenLabs TTS: all retries exhausted";
    this.emitStats({ callerId, provider: "elevenlabs", model: modelId, startedAt, endedAt: Date.now(), status: "error", error: errStr });
    throw lastErr ?? new Error(errStr);
  }

  async stt(audioBlob: Blob, options?: ClientRequestOptions): Promise<string> {
    if (!this.settings.apiToken) throw new Error("Iris ElevenLabs: no API token configured.");
    if (options?.signal?.aborted) throw new Error("Iris ElevenLabs: request aborted.");

    const callerId = options?.callerId ?? "?";
    const startedAt = Date.now();
    const timeoutMs = this.settings.timeoutMs || DEFAULT_TIMEOUT_MS;

    const boundary = "----IrisRouter" + Date.now().toString(36);
    const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`,
    );
    const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);
    const multipartBody = new Uint8Array(preamble.length + audioBytes.length + epilogue.length);
    multipartBody.set(preamble, 0);
    multipartBody.set(audioBytes, preamble.length);
    multipartBody.set(epilogue, preamble.length + audioBytes.length);

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const resp = await this.binaryPost(
          `${ELEVENLABS_BASE}/speech-to-text`,
          {
            "xi-api-key": this.settings.apiToken,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          multipartBody.buffer as ArrayBuffer,
          timeoutMs, options?.signal,
        );
        if (resp.status >= 200 && resp.status < 300) {
          const text = new TextDecoder().decode(resp.body);
          const json = JSON.parse(text);
          this.emitStats({ callerId, provider: "elevenlabs", model: "scribe_v2", startedAt, endedAt: Date.now(), status: "ok" });
          return (json.text as string) ?? "";
        }
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`Iris ElevenLabs STT: ${resp.status}`);
          if (attempt < DEFAULT_MAX_RETRIES) {
            await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), options?.signal, "ElevenLabs STT");
            continue;
          }
        }
        const body = new TextDecoder().decode(resp.body);
        throw new Error(`Iris ElevenLabs STT: ${resp.status}: ${body}`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("aborted")) {
          this.emitStats({ callerId, provider: "elevenlabs", model: "scribe_v2", startedAt, endedAt: Date.now(), status: "error", error: "aborted" });
          throw err;
        }
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), options?.signal, "ElevenLabs STT");
          continue;
        }
      }
    }
    const errStr = lastErr?.message ?? "Iris ElevenLabs STT: all retries exhausted";
    this.emitStats({ callerId, provider: "elevenlabs", model: "scribe_v2", startedAt, endedAt: Date.now(), status: "error", error: errStr });
    throw lastErr ?? new Error(errStr);
  }

  async singleUseToken(tokenType: string, options?: ClientRequestOptions): Promise<string> {
    if (!this.settings.apiToken) throw new Error("Iris ElevenLabs: no API token configured.");
    const resp = await requestUrl({
      url: `${ELEVENLABS_BASE}/single-use-token/${encodeURIComponent(tokenType)}`,
      method: "POST",
      headers: { "xi-api-key": this.settings.apiToken },
      throw: false,
    });
    if (resp.status >= 400) {
      throw new Error(`Iris ElevenLabs single-use-token: ${resp.status} ${errorMsg(resp.json)}`);
    }
    const token = resp.json?.token;
    if (typeof token !== "string" || !token) {
      throw new Error("Iris ElevenLabs single-use-token: missing token in response");
    }
    return token;
  }

  async sttStream(handlers: STTStreamHandlers, options?: ClientRequestOptions): Promise<STTStreamSession> {
    const callerId = options?.callerId ?? "?";
    const startedAt = Date.now();
    const model = "scribe_v2_realtime";

    const token = await this.takeSTTToken(options);

    const params = new URLSearchParams({
      token,
      model_id: model,
      audio_format: "pcm_16000",
      commit_strategy: "vad",
    });
    const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

    const ws = new WebSocket(url);
    let finalEmitted = false;
    let closed = false;

    const closeOnce = (err?: Error) => {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch { /* already closed */ }
      this.emitStats({
        callerId, provider: "elevenlabs", model,
        startedAt, endedAt: Date.now(),
        status: err ? "error" : "ok",
        error: err?.message,
      });
      handlers.onClose?.();
    };

    ws.onmessage = (evt) => {
      let msg: any;
      try { msg = JSON.parse(typeof evt.data === "string" ? evt.data : ""); } catch { return; }
      const type = msg?.message_type;
      if (type === "partial_transcript" && typeof msg.text === "string") {
        handlers.onPartial?.(msg.text);
      } else if (
        (type === "committed_transcript" || type === "committed_transcript_with_timestamps")
        && typeof msg.text === "string"
      ) {
        if (!finalEmitted) {
          finalEmitted = true;
          handlers.onFinal(msg.text);
        }
      }
    };
    ws.onerror = () => {
      const err = new Error("Iris ElevenLabs STT stream: websocket error");
      handlers.onError(err);
      closeOnce(err);
    };
    ws.onclose = () => closeOnce();

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { ws.removeEventListener("error", onErr); resolve(); };
      const onErr = () => { ws.removeEventListener("open", onOpen); reject(new Error("Iris ElevenLabs STT stream: failed to open")); };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onErr, { once: true });
    });

    const sendAudio = (pcm: ArrayBuffer) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      const b64 = arrayBufferToBase64(pcm);
      ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: b64,
        sample_rate: 16000,
      }));
    };

    const end = () => {
      if (closed || ws.readyState !== WebSocket.OPEN) { closeOnce(); return; }
      // Send empty chunk with commit:true to force finalization under any strategy.
      ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: 16000,
      }));
      // Give server a moment to send committed_transcript before closing.
      setTimeout(() => closeOnce(), 1500);
    };

    return { sendAudio, end, close: () => closeOnce() };
  }

  async voices(options?: ClientRequestOptions): Promise<ElevenLabsVoice[]> {
    if (!this.settings.apiToken) throw new Error("Iris ElevenLabs: no API token configured.");
    const callerId = options?.callerId ?? "?";
    const startedAt = Date.now();
    try {
      const resp = await requestUrl({
        url: `${ELEVENLABS_BASE}/voices`,
        method: "GET",
        headers: { "xi-api-key": this.settings.apiToken },
        throw: false,
      });
      if (resp.status >= 400) throw new Error(`Iris ElevenLabs voices: ${resp.status}`);
      const voices: ElevenLabsVoice[] = (resp.json?.voices ?? []).map(
        (v: ElevenLabsVoice) => ({
          voice_id: v.voice_id,
          name: v.name,
          category: v.category ?? undefined,
          description: v.description ?? undefined,
          labels: v.labels ?? undefined,
          preview_url: v.preview_url ?? undefined,
        }),
      );
      this.emitStats({ callerId, provider: "elevenlabs", model: "voices", startedAt, endedAt: Date.now(), status: "ok" });
      return voices;
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      this.emitStats({ callerId, provider: "elevenlabs", model: "voices", startedAt, endedAt: Date.now(), status: "error", error: errStr });
      throw err;
    }
  }

  private emitStats(s: ProviderCallStats): void {
    try { this.statsListener?.(s); } catch { /* not fatal */ }
  }

  private binaryPost(
    url: string,
    headers: Record<string, string>,
    body: string | ArrayBuffer,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; body: ArrayBuffer }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Iris ElevenLabs TTS: request timed out"));
      }, timeoutMs);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Iris ElevenLabs: request aborted."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      requestUrl({ url, method: "POST", headers, body, throw: false })
        .then((resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ status: resp.status, body: resp.arrayBuffer });
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
