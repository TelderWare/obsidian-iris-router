import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";
import { Relay, emptyBatchState } from "./relay";
import type { RelaySettings, PersistedBatchState, ApiKeyEntry, ApiProvider } from "./relay";

const PROVIDERS: Array<{ value: ApiProvider; label: string; keysUrl: string; placeholder: string }> = [
  { value: "anthropic", label: "Anthropic", keysUrl: "https://console.anthropic.com/settings/keys", placeholder: "sk-ant-..." },
  { value: "openai", label: "OpenAI", keysUrl: "https://platform.openai.com/api-keys", placeholder: "sk-..." },
  { value: "google", label: "Google Gemini", keysUrl: "https://aistudio.google.com/apikey", placeholder: "AIza..." },
  { value: "mistral", label: "Mistral", keysUrl: "https://console.mistral.ai/api-keys", placeholder: "..." },
  { value: "groq", label: "Groq", keysUrl: "https://console.groq.com/keys", placeholder: "gsk_..." },
  { value: "hugging-face", label: "Hugging Face", keysUrl: "https://huggingface.co/settings/tokens", placeholder: "hf_..." },
  { value: "elevenlabs", label: "ElevenLabs", keysUrl: "https://elevenlabs.io/app/settings/api-keys", placeholder: "xi-..." },
];

function providerInfo(p: ApiProvider): { label: string; keysUrl: string; placeholder: string } {
  return PROVIDERS.find(x => x.value === p) ?? PROVIDERS[0];
}

function encryptSecret(key: string): string {
  if (!key) return "";
  try {
    const { safeStorage } = require("electron");
    if (safeStorage.isEncryptionAvailable()) {
      return "enc:" + safeStorage.encryptString(key).toString("base64");
    }
  } catch { /* safeStorage unavailable */ }
  return key;
}

function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith("enc:")) {
    try {
      const { safeStorage } = require("electron");
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    } catch {
      new Notice("Iris Relay: unable to decrypt API key. Please re-enter it in settings.");
      return "";
    }
  }
  return stored;
}

interface IrisRelaySettings {
  apiKeys: ApiKeyEntry[];
  requestTimeoutSec: number;
  paused: boolean;
  keyPauses: Array<{ keyId: string; until: number | null }>;
}

const DEFAULT_SETTINGS: IrisRelaySettings = {
  apiKeys: [],
  requestTimeoutSec: 60,
  paused: false,
  keyPauses: [],
};

function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default class IrisRelayPlugin extends Plugin {
  settings!: IrisRelaySettings;
  relay!: Relay;
  private batchState: PersistedBatchState = emptyBatchState();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.relay = new Relay(this.relaySettings(), {
      initial: this.batchState,
      save: async (state) => {
        this.batchState = state;
        await this.persistAll();
      },
    });
    if (this.settings.paused) this.relay.setPaused(true);
    for (const p of this.settings.keyPauses) {
      this.relay.setKeyPause(p.keyId, true, p.until);
    }
    this.relay.setPauseChangeListener(() => {
      const paused = this.relay.isPaused();
      const keyPauses = this.relay.getKeyPauses();
      const same = this.settings.paused === paused
        && this.settings.keyPauses.length === keyPauses.length
        && this.settings.keyPauses.every((p, i) => p.keyId === keyPauses[i].keyId && p.until === keyPauses[i].until);
      if (same) return;
      this.settings.paused = paused;
      this.settings.keyPauses = keyPauses;
      void this.saveSettings();
    });
    this.relay.resumePending();
    (this.app as any).irisRelay = this.relay;

    const styleEl = document.createElement("style");
    styleEl.textContent = `
      .iris-status { display: inline-flex; align-items: center; cursor: pointer; color: var(--text-faint); opacity: 0.5; transition: opacity 120ms ease, color 120ms ease; }
      .iris-status:hover { opacity: 1; color: var(--text-muted); }
      .iris-status.is-active { color: var(--interactive-accent); opacity: 1; animation: iris-pulse 1.2s ease-in-out infinite; }
      .iris-status svg { width: 16px; height: 16px; }
      @keyframes iris-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

      .iris-modal .modal-content {
        padding-top: 4px;
        height: 70vh;
        max-height: 720px;
        overflow-y: hidden;
        display: flex;
        flex-direction: column;
        font-size: 12px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }
      .iris-tabs {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--background-modifier-border);
        margin-bottom: 10px;
        flex-shrink: 0;
      }
      .iris-tab {
        padding: 4px 14px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-faint);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        background: none;
        border-top: none;
        border-left: none;
        border-right: none;
        box-shadow: none;
      }
      .iris-tab:hover { color: var(--text-muted); }
      .iris-tab.is-active {
        color: var(--text-normal);
        border-bottom-color: var(--interactive-accent);
      }
      .iris-tab-pane {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
      }
      .iris-modal-status {
        font-size: 12px;
        color: var(--text-faint);
        margin-bottom: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .iris-modal-status.is-active { color: var(--text-muted); }
      .iris-modal-status.is-paused { color: var(--text-muted); }
      .iris-pause-btn {
        margin-left: auto;
        font-size: 11px;
        padding: 2px 8px;
        height: auto;
        line-height: 1.4;
        background: transparent;
        border: 1px solid var(--background-modifier-border);
        color: var(--text-faint);
        box-shadow: none;
      }
      .iris-pause-btn:hover { color: var(--text-muted); }

      .iris-section { margin-bottom: 14px; }
      .iris-section-title {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
        font-weight: 500;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .iris-count {
        color: var(--text-faint);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      .iris-count.is-active { color: var(--text-muted); }
      .iris-section-empty {
        font-size: 11px;
        color: var(--text-faint);
        padding: 2px 2px;
      }

      .iris-row {
        display: grid;
        grid-template-columns: 44px minmax(0,1fr) auto 20px;
        gap: 10px;
        align-items: baseline;
        padding: 2px 4px;
        font-size: 11px;
      }
      .iris-row.status-cancelled { opacity: 0.5; }

      .iris-row-role {
        font-size: 9px;
        text-transform: lowercase;
        letter-spacing: 0;
        font-weight: 400;
        color: var(--text-faint);
        text-align: left;
      }
      .iris-row-role.status-error { color: var(--text-muted); }

      .iris-row-caller {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-muted);
      }
      .iris-row-caller b { font-weight: 400; color: var(--text-normal); }
      .iris-row-model {
        font-family: var(--font-monospace);
        font-size: 10px;
        color: var(--text-faint);
        margin-left: 6px;
      }
      .iris-row-meta {
        color: var(--text-faint);
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        white-space: nowrap;
      }
      .iris-row-meta.is-error { color: var(--text-muted); }
      .iris-row-cancel {
        width: 18px; height: 18px; padding: 0;
        background: transparent; border: none; box-shadow: none;
        color: var(--text-faint); cursor: pointer;
        font-size: 11px; line-height: 1;
        opacity: 0.6;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .iris-row-cancel:hover { opacity: 1; color: var(--text-muted); }
      .iris-row-cancel svg { width: 12px; height: 12px; }

      .iris-limit-row {
        display: grid;
        grid-template-columns: 44px 1fr 1fr auto;
        gap: 12px;
        padding: 3px 4px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        align-items: center;
      }
      .iris-limit-label {
        display: flex;
        justify-content: space-between;
        color: var(--text-faint);
        font-size: 10px;
        margin-bottom: 2px;
      }
      .iris-limit-label b { color: var(--text-muted); font-weight: 400; }
      .iris-limit-bar {
        height: 2px;
        background: var(--background-modifier-border);
        border-radius: 1px;
        overflow: hidden;
      }
      .iris-limit-bar > span {
        display: block; height: 100%;
        background: var(--text-faint);
        transition: width 300ms ease-out;
      }
      .iris-limit-bar.low > span { background: var(--text-muted); }
      .iris-limit-bar.crit > span { background: var(--text-muted); }

      .iris-key-row {
        display: grid;
        grid-template-columns: 100px 90px 1fr 18px 40px 20px;
        gap: 8px;
        align-items: center;
        padding: 2px 4px;
      }
      .iris-key-test {
        font-size: 10px;
        padding: 2px 6px;
        background: transparent;
        border: 1px solid var(--background-modifier-border);
        border-radius: 3px;
        color: var(--text-muted);
        cursor: pointer;
        box-shadow: none;
        height: auto;
      }
      .iris-key-test:hover:not(:disabled) { color: var(--text-normal); border-color: var(--interactive-accent); }
      .iris-key-test:disabled { opacity: 0.6; cursor: wait; }
      .iris-key-test svg { width: 12px; height: 12px; vertical-align: middle; }
      .iris-key-link {
        color: var(--text-faint);
        font-size: 12px;
        line-height: 1;
        text-decoration: none;
        text-align: center;
        opacity: 0.7;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .iris-key-link:hover { color: var(--text-muted); opacity: 1; }
      .iris-key-link svg { width: 12px; height: 12px; }
      .iris-key-row input,
      .iris-key-row select {
        font-size: 11px;
        padding: 2px 6px;
        height: auto;
        background: var(--background-modifier-form-field);
        border: 1px solid var(--background-modifier-border);
        border-radius: 3px;
        color: var(--text-normal);
        font-family: inherit;
        min-width: 0;
        width: 100%;
        box-shadow: none;
      }
      .iris-key-row input:focus,
      .iris-key-row select:focus {
        border-color: var(--interactive-accent);
        outline: none;
      }
      .iris-add-key-btn {
        margin-top: 4px;
        padding: 2px 10px;
        font-size: 11px;
        background: transparent;
        border: 1px solid var(--background-modifier-border);
        border-radius: 3px;
        color: var(--text-muted);
        cursor: pointer;
        box-shadow: none;
      }
      .iris-add-key-btn:hover { color: var(--text-normal); }

      .iris-batch-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 11px;
        color: var(--text-faint);
        padding: 2px 4px;
      }
      .iris-batch-btn {
        padding: 2px 8px;
        font-size: 11px;
        background: transparent;
        border: 1px solid var(--background-modifier-border);
        border-radius: 3px;
        color: var(--text-muted);
        cursor: pointer;
        box-shadow: none;
      }
      .iris-batch-btn:hover:not(:disabled) { color: var(--text-normal); }
      .iris-batch-btn:disabled { opacity: 0.35; cursor: not-allowed; }

      .iris-caller-row {
        display: grid;
        grid-template-columns: minmax(0,1fr) 70px 70px 130px;
        gap: 10px;
        padding: 2px 4px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        align-items: baseline;
      }
      .iris-caller-row .iris-row-caller { font-size: 11px; }

      .iris-footer {
        margin-top: 12px;
        padding-top: 8px;
        border-top: 1px solid var(--background-modifier-border);
        font-size: 11px;
        color: var(--text-faint);
        font-variant-numeric: tabular-nums;
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
      }
      .iris-footer b { color: var(--text-muted); font-weight: 400; }
    `;
    document.head.appendChild(styleEl);
    this.register(() => styleEl.remove());

    const statusEl = this.addStatusBarItem();
    statusEl.addClass("iris-status");
    setIcon(statusEl, "brain-circuit");
    statusEl.addEventListener("click", () => {
      new IrisLiveModal(this.app, this).open();
    });
    this.relay.setActiveListener((active) => {
      statusEl.toggleClass("is-active", active > 0);
      statusEl.setAttr("aria-label", active > 0 ? `Iris: ${active} request${active === 1 ? "" : "s"} in flight` : "Iris: idle");
    });

    this.addSettingTab(new IrisRelaySettingTab(this.app, this));
  }

  onunload(): void {
    this.relay.shutdown();
    delete (this.app as any).irisRelay;
  }

  private relaySettings(): RelaySettings {
    return {
      apiKeys: this.settings.apiKeys,
      requestTimeoutMs: this.settings.requestTimeoutSec * 1000,
    };
  }

  async loadSettings(): Promise<void> {
    const data: any = (await this.loadData()) || {};
    const rawBatch = data.batchState && Array.isArray(data.batchState.queued) && Array.isArray(data.batchState.pending)
      ? data.batchState : null;

    let apiKeys: ApiKeyEntry[];
    let migratedFromLegacy = false;
    if (Array.isArray(data.apiKeys) && data.apiKeys.length > 0) {
      apiKeys = data.apiKeys.map((e: any) => ({
        id: typeof e.id === "string" && e.id ? e.id : uuid(),
        label: typeof e.label === "string" ? e.label : "",
        key: decryptSecret(typeof e.key === "string" ? e.key : ""),
        provider: e.provider as ApiProvider,
      }));
      if (data.apiKeys.some((e: any) => e.provider !== "anthropic" && e.provider !== "hugging-face")) {
        migratedFromLegacy = true;
      }
    } else {
      apiKeys = [];
      const mainKey = decryptSecret(typeof data.anthropicApiKey === "string" ? data.anthropicApiKey : "");
      const trivialKey = decryptSecret(typeof data.trivialApiKey === "string" ? data.trivialApiKey : "");
      if (mainKey) apiKeys.push({ id: uuid(), label: "main", key: mainKey, provider: "anthropic" });
      if (trivialKey) apiKeys.push({ id: uuid(), label: "trivial", key: trivialKey, provider: "anthropic" });
      if (mainKey || trivialKey) migratedFromLegacy = true;
    }

    const legacyHfToken = decryptSecret(typeof data.hfApiToken === "string" ? data.hfApiToken : "");
    if (legacyHfToken && !apiKeys.some(e => e.provider === "hugging-face" && e.key === legacyHfToken)) {
      apiKeys.push({ id: uuid(), label: "huggingface", key: legacyHfToken, provider: "hugging-face" });
      migratedFromLegacy = true;
    }

    const now = Date.now();
    const rawKeyPauses: Array<{ keyId: string; until: number | null }> = Array.isArray(data.keyPauses)
      ? data.keyPauses
          .filter((p: any) => p && typeof p.keyId === "string")
          .map((p: any) => ({
            keyId: p.keyId,
            until: typeof p.until === "number" ? p.until : null,
          }))
          .filter((p: { keyId: string; until: number | null }) =>
            p.until === null || p.until > now,
          )
      : [];
    this.settings = {
      apiKeys,
      requestTimeoutSec: typeof data.requestTimeoutSec === "number" ? data.requestTimeoutSec : DEFAULT_SETTINGS.requestTimeoutSec,
      paused: !!data.paused,
      keyPauses: rawKeyPauses,
    };

    if (rawBatch) {
      const findByLabel = (label: string) => apiKeys.find(e => e.label === label);
      this.batchState = {
        queued: rawBatch.queued.map((e: any) => ({
          customId: e.customId,
          callerId: e.callerId,
          body: e.body,
        })),
        pending: rawBatch.pending.flatMap((p: any) => {
          if (typeof p.keyId === "string" && p.keyId) {
            return [{ batchId: p.batchId, keyId: p.keyId, submittedAt: p.submittedAt, entries: p.entries }];
          }
          const wantLabel = p.role === "trivial" ? "trivial" : "main";
          const entry = findByLabel(wantLabel) || apiKeys[0];
          if (!entry) {
            console.warn(`Iris Relay: dropping pending batch ${p.batchId}, no matching key after migration.`);
            return [];
          }
          return [{ batchId: p.batchId, keyId: entry.id, submittedAt: p.submittedAt, entries: p.entries }];
        }),
      };
    }

    if (migratedFromLegacy) {
      await this.persistAll();
    }
  }

  private async persistAll(): Promise<void> {
    const toSave: any = {
      requestTimeoutSec: this.settings.requestTimeoutSec,
      paused: this.settings.paused,
      keyPauses: this.settings.keyPauses,
      apiKeys: this.settings.apiKeys.map(e => ({
        id: e.id,
        label: e.label,
        key: encryptSecret(e.key),
        provider: e.provider,
      })),
      batchState: this.batchState,
    };
    await this.saveData(toSave);
  }

  async saveSettings(): Promise<void> {
    await this.persistAll();
    this.relay.updateSettings(this.relaySettings());
  }
}

class IrisRelaySettingTab extends PluginSettingTab {
  plugin: IrisRelayPlugin;

  constructor(app: App, plugin: IrisRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    containerEl.createEl("h3", { text: "Iris AI Router" });
    containerEl.createEl("p", {
      text: "Centralised AI API router for iris plugins. Other iris plugins will automatically route requests through this plugin when enabled.",
      cls: "setting-item-description",
    });

    containerEl.createEl("h4", { text: "API keys" });
    containerEl.createEl("p", {
      text: "Add one or more keys. Anthropic keys are load-balanced across all configured Anthropic entries. Hugging Face keys power optional classification, NLI, and embedding routing — get a token at huggingface.co/settings/tokens.",
      cls: "setting-item-description",
    });

    s.apiKeys.forEach((entry, i) => {
      const info = providerInfo(entry.provider);
      new Setting(containerEl)
        .addDropdown(d => {
          for (const p of PROVIDERS) d.addOption(p.value, p.label);
          d.setValue(entry.provider)
            .onChange(async (v) => { entry.provider = v as ApiProvider; await save(); this.display(); });
        })
        .addText(t => {
          t.setPlaceholder("label")
            .setValue(entry.label)
            .onChange(async (v) => { entry.label = v.trim(); await save(); });
        })
        .addText(t => {
          t.inputEl.type = "password";
          t.setPlaceholder(info.placeholder)
            .setValue(entry.key)
            .onChange(async (v) => { entry.key = v.trim(); await save(); });
        })
        .addExtraButton(b => {
          b.setIcon("external-link")
            .setTooltip(`Get ${info.label} keys`)
            .onClick(() => window.open(info.keysUrl, "_blank", "noopener"));
        })
        .addExtraButton(b => {
          b.setIcon("plug-zap")
            .setTooltip("Test key")
            .onClick(async () => {
              const label = entry.label || info.label;
              if (!entry.key) {
                new Notice(`${label}: no key to test.`);
                return;
              }
              new Notice(`Testing ${label}…`, 2000);
              const result = await this.plugin.relay.testKey(entry.provider, entry.key);
              if (result.ok) {
                new Notice(`${label} key valid.`, 4000);
              } else {
                new Notice(`${label}: ${result.error || "failed"}`, 8000);
              }
            });
        })
        .addExtraButton(b => {
          b.setIcon("trash")
            .setTooltip("Remove key")
            .onClick(async () => {
              s.apiKeys.splice(i, 1);
              await save();
              this.display();
            });
        });
    });

    new Setting(containerEl)
      .addButton(b => b
        .setButtonText("Add key")
        .onClick(async () => {
          s.apiKeys.push({ id: uuid(), label: "", key: "", provider: "anthropic" });
          await save();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Request timeout")
      .setDesc("Seconds before a single API request times out.")
      .addDropdown(d =>
        d.addOption("30", "30s")
          .addOption("60", "60s")
          .addOption("90", "90s")
          .addOption("120", "120s")
          .setValue(String(s.requestTimeoutSec))
          .onChange(async (v) => { s.requestTimeoutSec = parseInt(v, 10); await save(); }));

    const limits = this.plugin.relay.getRateLimits();
    if (limits.length > 0) {
      containerEl.createEl("h4", { text: "API rate limits" });
      for (const info of limits) {
        const reqPct = info.requestsLimit > 0 ? Math.round(info.requestsRemaining / info.requestsLimit * 100) : 100;
        const tokPct = info.tokensLimit > 0 ? Math.round(info.tokensRemaining / info.tokensLimit * 100) : 100;
        const desc = `Requests: ${info.requestsRemaining.toLocaleString()} / ${info.requestsLimit.toLocaleString()} remaining (${reqPct}%) · Tokens: ${info.tokensRemaining.toLocaleString()} / ${info.tokensLimit.toLocaleString()} remaining (${tokPct}%) · Concurrency: ${info.concurrency}`;
        new Setting(containerEl).setName(info.label || "key").setDesc(desc);
      }
    }

    const batch = this.plugin.relay.getBatchState();
    containerEl.createEl("h4", { text: "Batch mode" });
    containerEl.createEl("p", {
      text: "Iris plugins can enqueue requests for the cheaper async batches API. Results are delivered within 24h; Obsidian must be running for polling to advance.",
      cls: "setting-item-description",
    });
    new Setting(containerEl)
      .setName("Queued")
      .setDesc(`${batch.queued} request${batch.queued === 1 ? "" : "s"} waiting to be flushed`)
      .addButton(b => b
        .setButtonText("Flush queue")
        .onClick(async () => {
          try {
            const id = await this.plugin.relay.flushBatch();
            new Notice(id ? `Iris: submitted batch ${id}` : "Iris: queue empty");
          } catch (e) {
            new Notice(`Iris: ${e instanceof Error ? e.message : String(e)}`);
          }
          this.display();
        }));
    if (batch.pending.length > 0) {
      for (const p of batch.pending) {
        const ageMin = Math.round((Date.now() - p.submittedAt) / 60000);
        new Setting(containerEl)
          .setName(`Pending ${p.batchId}`)
          .setDesc(`${p.entries} request${p.entries === 1 ? "" : "s"} · ${p.label} key · submitted ${ageMin} min ago`);
      }
    }

    const stats = this.plugin.relay.getStats();
    if (stats.totalRequests > 0) {
      containerEl.createEl("h4", { text: "Session stats" });
      new Setting(containerEl)
        .setName("Totals")
        .setDesc(`${stats.totalRequests} requests · ${stats.errors} errors`);
    }
  }
}

class IrisLiveModal extends Modal {
  private relay: Relay;
  private plugin: IrisRelayPlugin;
  private ageTicker?: number;
  private activeTab: "keys" | "requests" = "requests";

  constructor(app: App, plugin: IrisRelayPlugin) {
    super(app);
    this.plugin = plugin;
    this.relay = plugin.relay;
  }

  onOpen(): void {
    this.titleEl.setText("Iris Router");
    this.modalEl.addClass("iris-modal");
    this.modalEl.style.width = "min(640px, 95vw)";
    this.render();
    this.relay.setChangeListener(() => this.render());
    this.ageTicker = window.setInterval(() => this.tickAges(), 1000);
  }

  onClose(): void {
    this.relay.setChangeListener(undefined);
    if (this.ageTicker !== undefined) window.clearInterval(this.ageTicker);
    this.contentEl.empty();
  }

  private tickAges(): void {
    const now = Date.now();
    this.contentEl.querySelectorAll<HTMLElement>("[data-started-at]").forEach((el) => {
      const t = parseInt(el.dataset.startedAt!, 10);
      if (!isNaN(t)) el.textContent = this.fmtAge(now - t);
    });
  }

  private fmtAge(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  private fmtTime(t: number): string {
    return new Date(t).toLocaleTimeString();
  }

  private fmtNum(n: number): string {
    return n.toLocaleString();
  }

  private fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  private section(parent: HTMLElement, title: string, count?: number, active = false): HTMLElement {
    const sec = parent.createDiv({ cls: "iris-section" });
    const titleEl = sec.createDiv({ cls: "iris-section-title" });
    titleEl.createSpan({ text: title });
    if (count !== undefined) {
      const c = titleEl.createSpan({ cls: "iris-count", text: String(count) });
      if (active) c.addClass("is-active");
    }
    return sec;
  }

  private rolePill(parent: HTMLElement, role: string, label?: string): void {
    const safe = role.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase() || "x";
    parent.createSpan({ cls: `iris-row-role role-${safe} status-${safe}`, text: label ?? role });
  }

  private callerCell(parent: HTMLElement, caller: string, model?: string): void {
    const cell = parent.createDiv({ cls: "iris-row-caller" });
    cell.createEl("b", { text: caller });
    if (model) cell.createSpan({ cls: "iris-row-model", text: model });
  }

  private render(): void {
    const snap = this.relay.getLiveSnapshot();
    const limits = this.relay.getRateLimits();
    const batch = this.relay.getBatchState();
    const now = Date.now();

    const root = document.createElement("div");

    const status = root.createDiv({ cls: "iris-modal-status" });
    const activeCount = snap.active.length;
    const queuedCount = snap.queued.length;
    const paused = this.relay.isPaused();
    const statusLabel = status.createSpan();
    if (paused) {
      status.addClass("is-paused");
      const parts = [`paused`];
      if (activeCount > 0) parts.push(`${activeCount} in flight`);
      if (queuedCount > 0) parts.push(`${queuedCount} queued`);
      statusLabel.textContent = parts.join(" · ");
    } else if (activeCount > 0 || queuedCount > 0) {
      status.addClass("is-active");
      const parts: string[] = [];
      if (activeCount > 0) parts.push(`${activeCount} in flight`);
      if (queuedCount > 0) parts.push(`${queuedCount} queued`);
      statusLabel.textContent = parts.join(" · ");
    } else {
      statusLabel.textContent = "idle";
    }
    const pauseBtn = status.createEl("button", {
      cls: "iris-pause-btn",
      text: paused ? "Resume" : "Pause",
      attr: { title: paused ? "Resume dispatching queued requests" : "Stop dispatching queued requests" },
    });
    pauseBtn.addEventListener("click", async () => {
      this.relay.setPaused(!paused);
      this.plugin.settings.paused = !paused;
      await this.plugin.saveSettings();
    });

    const tabs = root.createDiv({ cls: "iris-tabs" });
    const switchTab = (tab: "keys" | "requests") => {
      this.activeTab = tab;
      this.render();
    };
    for (const t of ["keys", "requests"] as const) {
      const btn = tabs.createEl("button", { cls: `iris-tab${this.activeTab === t ? " is-active" : ""}`, text: t });
      btn.addEventListener("click", () => switchTab(t));
    }

    const pane = root.createDiv({ cls: "iris-tab-pane" });

    if (this.activeTab === "keys") {
      this.renderKeysTab(pane, limits);
    } else {
      this.renderRequestsTab(pane, snap, batch, now);
    }

    this.contentEl.replaceChildren(root);
  }

  private renderKeysTab(pane: HTMLElement, limits: ReturnType<Relay["getRateLimits"]>): void {
    const apiKeys = this.plugin.settings.apiKeys;
    const sec = this.section(pane, "API keys", apiKeys.length);
    apiKeys.forEach((entry, i) => {
      const row = sec.createDiv({ cls: "iris-key-row" });

      const labelInput = row.createEl("input", { attr: { type: "text", placeholder: "label", value: entry.label } });
      labelInput.addEventListener("change", async () => {
        entry.label = labelInput.value.trim();
        await this.plugin.saveSettings();
      });

      const providerSel = row.createEl("select");
      for (const p of PROVIDERS) {
        const opt = providerSel.createEl("option", { attr: { value: p.value }, text: p.label });
        if (entry.provider === p.value) opt.selected = true;
      }
      providerSel.addEventListener("change", async () => {
        entry.provider = providerSel.value as ApiProvider;
        await this.plugin.saveSettings();
        this.render();
      });

      const info = providerInfo(entry.provider);
      const keyInput = row.createEl("input", { attr: { type: "password", placeholder: info.placeholder, value: entry.key } });
      keyInput.addEventListener("change", async () => {
        entry.key = keyInput.value.trim();
        await this.plugin.saveSettings();
      });

      const linkEl = row.createEl("a", {
        cls: "iris-key-link",
        attr: { href: info.keysUrl, target: "_blank", rel: "noopener", title: `Get ${info.label} keys` },
      });
      setIcon(linkEl, "external-link");

      const testBtn = row.createEl("button", {
        cls: "iris-key-test",
        text: "Test",
        attr: { title: "Test this key" },
      });
      testBtn.addEventListener("click", async () => {
        const label = entry.label || info.label;
        if (!entry.key) {
          new Notice(`${label}: no key to test.`);
          return;
        }
        const orig = testBtn.textContent;
        testBtn.disabled = true;
        testBtn.textContent = "…";
        try {
          const result = await this.relay.testKey(entry.provider, entry.key);
          if (result.ok) {
            testBtn.textContent = "";
            setIcon(testBtn, "check");
            new Notice(`${label} key valid.`, 4000);
          } else {
            testBtn.textContent = "";
            setIcon(testBtn, "x");
            new Notice(`${label}: ${result.error || "failed"}`, 8000);
          }
          window.setTimeout(() => {
            if (testBtn.isConnected) {
              testBtn.textContent = orig;
              testBtn.disabled = false;
            }
          }, 3000);
        } catch (e) {
          testBtn.textContent = orig;
          testBtn.disabled = false;
          new Notice(`${label}: ${e instanceof Error ? e.message : String(e)}`, 8000);
        }
      });

      const del = row.createEl("button", { cls: "iris-row-cancel", attr: { title: "Remove key" } });
      setIcon(del, "x");
      del.addEventListener("click", async () => {
        apiKeys.splice(i, 1);
        await this.plugin.saveSettings();
        this.render();
      });
    });

    const addBtn = sec.createEl("button", { cls: "iris-add-key-btn", text: "+ Add key" });
    addBtn.addEventListener("click", async () => {
      apiKeys.push({ id: uuid(), label: "", key: "", provider: "anthropic" });
      await this.plugin.saveSettings();
      this.render();
    });

    const keyPauses = this.relay.getKeyPauses();
    if (keyPauses.length > 0) {
      const psec = this.section(pane, "Paused keys", keyPauses.length);
      for (const p of keyPauses) {
        const row = psec.createDiv({ cls: "iris-row" });
        const apiKey = apiKeys.find(e => e.id === p.keyId);
        this.rolePill(row, apiKey?.label || p.keyId);
        const meta = row.createSpan({ cls: "iris-row-meta" });
        meta.textContent = p.until
          ? `resumes ${new Date(p.until).toISOString().replace(/\.\d+Z$/, "Z")}`
          : "indefinite";
        const btn = row.createEl("button", { cls: "iris-row-cancel", text: "Resume", attr: { title: "Resume this key now" } });
        btn.addEventListener("click", () => this.relay.setKeyPause(p.keyId, false));
      }
    }

    if (limits.length > 0) {
      const lsec = this.section(pane, "Rate limits");
      for (const info of limits) {
        this.renderLimit(lsec, info);
      }
    }
  }

  private renderRequestsTab(pane: HTMLElement, snap: ReturnType<Relay["getLiveSnapshot"]>, batch: ReturnType<Relay["getBatchState"]>, now: number): void {
    const activeCount = snap.active.length;
    const queuedCount = snap.queued.length;

    if (queuedCount > 0) {
      const sec = this.section(pane, "Queued", queuedCount);
      for (let i = snap.queued.length - 1; i >= 0; i--) {
        const q = snap.queued[i];
        const row = sec.createDiv({ cls: "iris-row" });
        this.rolePill(row, q.label);
        this.callerCell(row, q.callerId, q.model);
        row.createSpan({ cls: "iris-row-meta", text: `p${q.priority}` });
        const btn = row.createEl("button", { cls: "iris-row-cancel", attr: { title: "Cancel" } });
        setIcon(btn, "x");
        btn.addEventListener("click", () => this.relay.cancelQueued(q.id));
      }
    }

    const activeSec = this.section(pane, "Active", activeCount, activeCount > 0);
    if (activeCount === 0) {
      activeSec.createDiv({ text: "no requests in flight", cls: "iris-section-empty" });
    } else {
      for (let i = snap.active.length - 1; i >= 0; i--) {
        const a = snap.active[i];
        const row = activeSec.createDiv({ cls: `iris-row${a.cancelled ? " status-cancelled" : ""}` });
        this.rolePill(row, a.label);
        this.callerCell(row, a.callerId, a.model);
        const age = row.createSpan({ cls: "iris-row-meta" });
        age.dataset.startedAt = String(a.startedAt);
        age.textContent = this.fmtAge(now - a.startedAt);
        if (!a.cancelled) {
          const btn = row.createEl("button", { cls: "iris-row-cancel", attr: { title: "Cancel" } });
          setIcon(btn, "x");
          btn.addEventListener("click", () => this.relay.cancelActive(a.id));
        } else {
          row.createSpan();
        }
      }
    }

    const batchHasActivity = batch.queued > 0 || snap.batchPending.length > 0 || snap.history.some((h) => h.mode === "batch");
    if (batchHasActivity) {
      const sec = this.section(pane, "Batch");
      const controls = sec.createDiv({ cls: "iris-batch-controls" });
      controls.createSpan({ text: `${batch.queued} queued` });
      const flushBtn = controls.createEl("button", { cls: "iris-batch-btn", text: "Flush queue" });
      flushBtn.disabled = batch.queued === 0;
      flushBtn.addEventListener("click", () => this.flush());

      for (const p of snap.batchPending) {
        const row = sec.createDiv({ cls: "iris-row" });
        this.rolePill(row, p.label);
        this.callerCell(row, p.batchId, `${p.entries} item${p.entries === 1 ? "" : "s"}`);
        const age = row.createSpan({ cls: "iris-row-meta" });
        age.dataset.startedAt = String(p.submittedAt);
        age.textContent = this.fmtAge(now - p.submittedAt);
        row.createSpan();
      }
    }

    const topCallers = snap.callerStats.filter((c) => c.requests > 0).slice(0, 5);
    if (topCallers.length > 0) {
      const sec = this.section(pane, "Callers");
      for (const cs of topCallers) {
        const row = sec.createDiv({ cls: "iris-caller-row" });
        this.callerCell(row, cs.callerId);
        row.createSpan({ cls: "iris-row-meta", text: `${cs.requests} req` });
        row.createSpan({
          cls: `iris-row-meta${cs.errors > 0 ? " is-error" : ""}`,
          text: cs.errors > 0 ? `${cs.errors} err` : "—",
        });
        row.createSpan({
          cls: "iris-row-meta",
          text: `${this.fmtTokens(cs.inputTokens)} in · ${this.fmtTokens(cs.outputTokens)} out`,
        });
      }
    }

    const recent = snap.history.slice(0, 15);
    if (recent.length > 0) {
      const sec = this.section(pane, "Recent");
      for (const h of recent) {
        const row = sec.createDiv({ cls: `iris-row status-${h.status}` });
        const label = h.status === "ok" ? "ok" : h.status === "error" ? "err" : "canc";
        this.rolePill(row, h.status, label);
        this.callerCell(row, h.callerId, h.model);
        const dur = Math.max(0, h.endedAt - h.startedAt);
        const metaText = h.status === "error" && h.error
          ? (h.error.length > 36 ? h.error.slice(0, 36) + "…" : h.error)
          : `${(dur / 1000).toFixed(1)}s`;
        row.createSpan({
          cls: `iris-row-meta${h.status === "error" ? " is-error" : ""}`,
          text: metaText,
        });
        row.createSpan({ cls: "iris-row-meta", text: this.fmtTime(h.endedAt) });
      }
    }

    const s = snap.stats;
    const totalIn = snap.callerStats.reduce((a, x) => a + x.inputTokens, 0);
    const totalOut = snap.callerStats.reduce((a, x) => a + x.outputTokens, 0);
    const totalCache = snap.callerStats.reduce((a, x) => a + x.cacheReadTokens, 0);
    const footer = pane.createDiv({ cls: "iris-footer" });
    const fitem = (label: string, v: string | number) => {
      const span = footer.createSpan();
      span.createSpan({ text: `${label} ` });
      span.createEl("b", { text: typeof v === "number" ? this.fmtNum(v) : v });
    };
    fitem("Requests", s.totalRequests);
    fitem("Attempts", s.attempts);
    fitem("Failures", s.errors);
    fitem("Input", this.fmtTokens(totalIn));
    fitem("Output", this.fmtTokens(totalOut));
    if (totalCache > 0) fitem("Cache read", this.fmtTokens(totalCache));
  }

  private renderLimit(parent: HTMLElement, info: ReturnType<Relay["getRateLimits"]>[number]): void {
    const row = parent.createDiv({ cls: "iris-limit-row" });
    this.rolePill(row, info.label);

    const mkBar = (label: string, remaining: number, limit: number, fmt: (n: number) => string) => {
      const col = row.createDiv();
      const head = col.createDiv({ cls: "iris-limit-label" });
      head.createSpan({ text: label });
      head.createEl("b", { text: limit > 0 ? `${fmt(remaining)} / ${fmt(limit)}` : "—" });
      const bar = col.createDiv({ cls: "iris-limit-bar" });
      const frac = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 1;
      if (frac < 0.1) bar.addClass("crit");
      else if (frac < 0.3) bar.addClass("low");
      bar.createSpan().style.width = `${Math.max(2, frac * 100)}%`;
    };

    mkBar("Requests", info.requestsRemaining, info.requestsLimit, (n) => this.fmtNum(n));
    mkBar("Tokens", info.tokensRemaining, info.tokensLimit, (n) => this.fmtTokens(n));
    row.createSpan({ cls: "iris-row-meta", text: `conc ${info.concurrency}` });
  }

  private async flush(): Promise<void> {
    try {
      const id = await this.relay.flushBatch();
      new Notice(id ? `Iris: submitted batch ${id}` : "Iris: queue empty");
    } catch (e) {
      new Notice(`Iris: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }
}
