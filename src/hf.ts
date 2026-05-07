import { requestUrl } from "obsidian";

const HF_API_BASE = "https://api-inference.huggingface.co/models";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HFSettings {
  apiToken: string;
  timeoutMs: number;
}

export interface HFRequestOptions {
  callerId?: string;
  signal?: AbortSignal;
  /** Wait for cold-start model to warm. HF returns 503 until loaded; if true we retry. Default true. */
  waitForModel?: boolean;
}

export interface ZeroShotResult {
  labels: string[];
  scores: number[];
}

export interface NLIResult {
  /** entailment probability ∈ [0, 1] */
  entailment: number;
  /** contradiction probability ∈ [0, 1] */
  contradiction: number;
  /** neutral probability ∈ [0, 1] */
  neutral: number;
}

export interface HFCallStats {
  callerId: string;
  model: string;
  task: string;
  startedAt: number;
  endedAt: number;
  status: "ok" | "error";
  error?: string;
}

export type HFStatsListener = (stats: HFCallStats) => void;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Iris HF: request aborted."));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Iris HF: request aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HFClient {
  private settings: HFSettings;
  private statsListener?: HFStatsListener;

  constructor(settings: HFSettings) {
    this.settings = settings;
  }

  updateSettings(settings: HFSettings): void {
    this.settings = settings;
  }

  setStatsListener(listener: HFStatsListener | undefined): void {
    this.statsListener = listener;
  }

  isConfigured(): boolean {
    return !!this.settings.apiToken;
  }

  /**
   * Zero-shot classification via NLI. Each candidate label becomes the hypothesis;
   * the model returns entailment scores. All labels scored in a single forward pass.
   *
   * Output is sorted by score descending. `multi_label: true` lets each label score
   * independently (recommended for tag classification where multiple can apply).
   */
  async classify(
    text: string,
    candidateLabels: string[],
    model: string,
    options?: HFRequestOptions & { multiLabel?: boolean; hypothesisTemplate?: string },
  ): Promise<ZeroShotResult> {
    const payload = {
      inputs: text,
      parameters: {
        candidate_labels: candidateLabels,
        multi_label: options?.multiLabel ?? false,
        hypothesis_template: options?.hypothesisTemplate ?? "This example is {}.",
      },
    };
    const result = await this.call<{ labels: string[]; scores: number[] }>(
      model, payload, "zero-shot-classification", options,
    );
    return { labels: result.labels, scores: result.scores };
  }

  /**
   * Cross-encoder NLI: score whether `premise` entails `hypothesis`.
   * Uses a sentence-pair classifier model (e.g. cross-encoder/nli-deberta-v3-base).
   * Returns probabilities for entailment / contradiction / neutral.
   */
  async nli(
    premise: string,
    hypothesis: string,
    model: string,
    options?: HFRequestOptions,
  ): Promise<NLIResult> {
    const payload = {
      inputs: { text: premise, text_pair: hypothesis },
    };
    const raw = await this.call<Array<{ label: string; score: number }> | Array<Array<{ label: string; score: number }>>>(
      model, payload, "nli", options,
    );
    const scores = Array.isArray(raw[0]) ? raw[0] as Array<{ label: string; score: number }> : raw as Array<{ label: string; score: number }>;
    const lookup = (name: string): number => {
      const found = scores.find((s) => s.label.toLowerCase() === name);
      return found ? found.score : 0;
    };
    return {
      entailment: lookup("entailment"),
      contradiction: lookup("contradiction"),
      neutral: lookup("neutral"),
    };
  }

  /**
   * Sentence embeddings via the feature-extraction pipeline.
   * Returns one vector per input text. Use `sentence-transformers/all-MiniLM-L6-v2`
   * or similar. The HF endpoint averages token embeddings for these models.
   */
  async embed(
    texts: string[],
    model: string,
    options?: HFRequestOptions,
  ): Promise<number[][]> {
    const payload = {
      inputs: texts,
      options: { wait_for_model: options?.waitForModel ?? true },
    };
    const raw = await this.call<number[][] | number[][][]>(model, payload, "embed", options);
    if (Array.isArray(raw[0]) && Array.isArray((raw as any)[0][0])) {
      return (raw as number[][][]).map((token_embeddings) => meanPool(token_embeddings));
    }
    return raw as number[][];
  }

  /**
   * Low-level passthrough for any HF Inference API call. Useful for tasks not
   * covered by the typed methods above. Caller is responsible for the payload
   * shape and parsing the response.
   */
  async raw<T>(model: string, payload: unknown, task: string, options?: HFRequestOptions): Promise<T> {
    return this.call<T>(model, payload, task, options);
  }

  private async call<T>(
    model: string,
    payload: unknown,
    task: string,
    options?: HFRequestOptions,
  ): Promise<T> {
    if (!this.settings.apiToken) {
      throw new Error("Iris HF: no API token configured.");
    }
    if (options?.signal?.aborted) {
      throw new Error("Iris HF: request aborted.");
    }

    const callerId = options?.callerId ?? "?";
    const startedAt = Date.now();
    const url = `${HF_API_BASE}/${model}`;

    const body = (() => {
      const p = payload as Record<string, unknown>;
      if (p && typeof p === "object" && "options" in p) return p;
      return { ...(p as object), options: { wait_for_model: options?.waitForModel ?? true } };
    })();

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const resp = await this.fetchWithTimeout(url, body, options?.signal);
        if (resp.status === 200) {
          this.emitStats({ callerId, model, task, startedAt, endedAt: Date.now(), status: "ok" });
          return resp.json as T;
        }
        if (resp.status === 503 && (options?.waitForModel ?? true)) {
          // Cold start. Wait the estimated time HF reports, then retry.
          const wait = typeof resp.json?.estimated_time === "number"
            ? Math.min(60_000, Math.max(1000, Math.round(resp.json.estimated_time * 1000)))
            : 5000;
          await sleep(wait, options?.signal);
          continue;
        }
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`Iris HF: ${resp.status} ${this.errorMsg(resp.json)}`);
          if (attempt < DEFAULT_MAX_RETRIES) {
            await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), options?.signal);
            continue;
          }
        }
        throw new Error(`Iris HF: ${resp.status} ${this.errorMsg(resp.json)}`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("aborted")) {
          this.emitStats({ callerId, model, task, startedAt, endedAt: Date.now(), status: "error", error: "aborted" });
          throw err;
        }
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt), options?.signal);
          continue;
        }
      }
    }

    const errMsg = lastErr?.message ?? "Iris HF: all retries exhausted";
    this.emitStats({ callerId, model, task, startedAt, endedAt: Date.now(), status: "error", error: errMsg });
    throw lastErr ?? new Error(errMsg);
  }

  private async fetchWithTimeout(
    url: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: any }> {
    const timeoutMs = this.settings.timeoutMs || DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Iris HF: request timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Iris HF: request aborted."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      requestUrl({
        url,
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.settings.apiToken}`,
          "Content-Type": "application/json",
        },
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

  private errorMsg(json: any): string {
    if (!json) return "(no body)";
    if (typeof json === "string") return json;
    if (typeof json.error === "string") return json.error;
    if (json.error?.message) return json.error.message;
    return JSON.stringify(json).slice(0, 200);
  }

  private emitStats(stats: HFCallStats): void {
    try { this.statsListener?.(stats); } catch { /* listener errors are not fatal */ }
  }
}

function meanPool(tokenEmbeddings: number[][]): number[] {
  if (tokenEmbeddings.length === 0) return [];
  const dim = tokenEmbeddings[0].length;
  const out = new Array(dim).fill(0);
  for (const tok of tokenEmbeddings) {
    for (let i = 0; i < dim; i++) out[i] += tok[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= tokenEmbeddings.length;
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
