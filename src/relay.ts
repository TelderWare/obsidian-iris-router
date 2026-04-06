import { requestUrl } from "obsidian";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export interface RelaySettings {
  anthropicApiKey: string;
  trivialApiKey: string;
  maxConcurrency: number;
  requestTimeoutMs: number;
}

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1000;
const MAX_QUEUE_SIZE = 64;
const MAX_TOKENS_CAP = 32768;

const ALLOWED_BODY_KEYS = new Set([
  "model", "max_tokens", "system", "messages",
  "temperature", "tools", "tool_choice", "top_p", "top_k",
  "stop_sequences", "stream",
]);

function validateBody(body: object): Record<string, unknown> {
  const raw = body as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (ALLOWED_BODY_KEYS.has(key)) cleaned[key] = raw[key];
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

const DEFAULT_PRIORITY = 5;

interface QueueEntry {
  body: Record<string, unknown>;
  priority: number;
  trivial: boolean;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export class Relay {
  private settings: RelaySettings;
  private queue: QueueEntry[] = [];
  private active = 0;
  private rateLimitUntil = 0;

  constructor(settings: RelaySettings) {
    this.settings = settings;
  }

  updateSettings(settings: RelaySettings): void {
    this.settings = settings;
  }

  /** Public API: enqueue a Messages API request.
   *  @param body     Anthropic Messages API body fields.
   *  @param priority 0-10 (lower = processed first). Defaults to 5.
   *  @param trivial  If true and a trivial API key is configured, use that key instead.
   */
  async request(body: object, priority?: number, trivial?: boolean): Promise<Record<string, unknown>> {
    if (!this.settings.anthropicApiKey) throw new Error("Iris Relay: no API key configured.");
    if (this.queue.length >= MAX_QUEUE_SIZE) throw new Error("Iris Relay: queue full, try again later.");
    const validated = validateBody(body);
    const p = typeof priority === "number" ? Math.max(0, Math.min(10, priority)) : DEFAULT_PRIORITY;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // Insert in priority order (lowest first); equal priority preserves FIFO.
      const entry: QueueEntry = { body: validated, priority: p, trivial: !!trivial, resolve, reject };
      let i = this.queue.findIndex((e) => e.priority > p);
      if (i === -1) i = this.queue.length;
      this.queue.splice(i, 0, entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0 && this.active < this.settings.maxConcurrency) {
      const now = Date.now();
      if (now < this.rateLimitUntil) {
        const wait = this.rateLimitUntil - now;
        setTimeout(() => this.drain(), wait);
        return;
      }
      const entry = this.queue.shift()!;
      this.active++;
      this.execute(entry).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      // Re-check rate limit before each attempt
      const now = Date.now();
      if (now < this.rateLimitUntil) {
        const wait = this.rateLimitUntil - now;
        await new Promise((r) => setTimeout(r, wait));
      }

      try {
        const apiKey = (entry.trivial && this.settings.trivialApiKey)
          ? this.settings.trivialApiKey
          : this.settings.anthropicApiKey;
        const response = await Promise.race([
          requestUrl({
            url: API_URL,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": API_VERSION,
            },
            body: JSON.stringify(entry.body),
            throw: false,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Iris Relay: request timed out after ${this.settings.requestTimeoutMs / 1000}s`)),
              this.settings.requestTimeoutMs,
            ),
          ),
        ]);

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers?.["retry-after"] || "", 10);
          const backoffMs = (isNaN(retryAfter) ? 10 : retryAfter) * 1000;
          this.rateLimitUntil = Date.now() + backoffMs;
          lastError = new Error(`Iris Relay: rate limited (429), backing off ${backoffMs / 1000}s`);
          continue;
        }

        if (response.status >= 500) {
          lastError = new Error(`Iris Relay: server error ${response.status}`);
          continue;
        }

        if (response.status >= 400) {
          const msg = response.json?.error?.message ?? `API ${response.status}`;
          entry.reject(new Error(`Iris Relay: ${msg}`));
          return;
        }

        entry.resolve(response.json);
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES && lastError.message.includes("timed out")) {
          continue;
        }
        if (attempt >= MAX_RETRIES) break;
      }
    }

    entry.reject(lastError || new Error("Iris Relay: all retries exhausted"));
  }
}
