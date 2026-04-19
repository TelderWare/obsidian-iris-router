import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";
import { Relay, emptyBatchState } from "./relay";
import type { RelaySettings, PersistedBatchState } from "./relay";

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
  anthropicApiKey: string;
  trivialApiKey: string;
  requestTimeoutSec: number;
}

const DEFAULT_SETTINGS: IrisRelaySettings = {
  anthropicApiKey: "",
  trivialApiKey: "",
  requestTimeoutSec: 60,
};

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
    this.relay.resumePending();
    (this.app as any).irisRelay = this.relay;

    const styleEl = document.createElement("style");
    styleEl.textContent = `
      .iris-status { display: none; align-items: center; cursor: pointer; color: var(--interactive-accent); }
      .iris-status.is-active { display: inline-flex; animation: iris-pulse 1.2s ease-in-out infinite; }
      .iris-status svg { width: 16px; height: 16px; }
      @keyframes iris-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

      .iris-modal .modal-content { padding-top: 4px; }
      .iris-modal-status {
        font-size: 12px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        margin-bottom: 14px;
      }
      .iris-modal-status.is-active { color: var(--interactive-accent); font-weight: 600; }

      .iris-section { margin-bottom: 16px; }
      .iris-section-title {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
        font-weight: 600;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .iris-count {
        background: var(--background-modifier-border);
        color: var(--text-normal);
        padding: 0 6px;
        border-radius: 8px;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
      }
      .iris-count.is-active { background: var(--interactive-accent); color: var(--text-on-accent); }
      .iris-section-empty {
        font-size: 12px;
        color: var(--text-faint);
        font-style: italic;
        padding: 3px 2px;
      }

      .iris-row {
        display: grid;
        grid-template-columns: 52px minmax(0,1fr) auto 24px;
        gap: 10px;
        align-items: center;
        padding: 4px 6px;
        font-size: 12px;
        border-radius: 3px;
      }
      .iris-row:hover { background: var(--background-modifier-hover); }
      .iris-row + .iris-row { border-top: 1px solid var(--background-modifier-border); }
      .iris-row.status-cancelled { opacity: 0.6; }

      .iris-row-role {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        padding: 1px 0;
        border-radius: 3px;
        text-align: center;
      }
      .iris-row-role.role-main { background: rgba(124,156,255,0.15); color: #7c9cff; }
      .iris-row-role.role-trivial { background: rgba(212,164,74,0.15); color: #d4a44a; }
      .iris-row-role.status-ok { background: rgba(74,182,88,0.15); color: #4ab658; }
      .iris-row-role.status-error { background: rgba(220,80,80,0.15); color: var(--text-error); }
      .iris-row-role.status-cancelled { background: var(--background-modifier-hover); color: var(--text-muted); }

      .iris-row-caller {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iris-row-caller b { font-weight: 500; color: var(--text-normal); }
      .iris-row-model {
        font-family: var(--font-monospace);
        font-size: 10px;
        color: var(--text-muted);
        margin-left: 6px;
      }
      .iris-row-meta {
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        white-space: nowrap;
      }
      .iris-row-meta.is-error { color: var(--text-error); }
      .iris-row-cancel {
        width: 20px; height: 20px; padding: 0;
        background: transparent; border: none;
        color: var(--text-faint); cursor: pointer;
        border-radius: 3px; font-size: 11px; line-height: 1;
      }
      .iris-row-cancel:hover { color: var(--text-error); background: var(--background-modifier-hover); }

      .iris-limit-row {
        display: grid;
        grid-template-columns: 52px 1fr 1fr auto;
        gap: 12px;
        padding: 4px 6px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        align-items: center;
      }
      .iris-limit-row + .iris-limit-row { border-top: 1px solid var(--background-modifier-border); }
      .iris-limit-label {
        display: flex;
        justify-content: space-between;
        color: var(--text-muted);
        font-size: 10px;
        margin-bottom: 2px;
      }
      .iris-limit-label b { color: var(--text-normal); font-weight: 500; }
      .iris-limit-bar {
        height: 4px;
        background: var(--background-modifier-border);
        border-radius: 2px;
        overflow: hidden;
      }
      .iris-limit-bar > span {
        display: block; height: 100%;
        background: var(--interactive-accent);
        transition: width 300ms ease-out;
      }
      .iris-limit-bar.low > span { background: #d4a44a; }
      .iris-limit-bar.crit > span { background: var(--text-error); }

      .iris-batch-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--text-muted);
        padding: 4px 6px;
      }
      .iris-batch-btn {
        padding: 3px 10px;
        font-size: 11px;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 4px;
        color: var(--text-normal);
        cursor: pointer;
      }
      .iris-batch-btn:hover:not(:disabled) { border-color: var(--interactive-accent); color: var(--text-accent); }
      .iris-batch-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .iris-caller-row {
        display: grid;
        grid-template-columns: minmax(0,1fr) 70px 70px 130px;
        gap: 10px;
        padding: 3px 6px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        align-items: baseline;
      }
      .iris-caller-row + .iris-caller-row { border-top: 1px solid var(--background-modifier-border); }
      .iris-caller-row .iris-row-caller { font-size: 12px; }

      .iris-footer {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--background-modifier-border);
        font-size: 11px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }
      .iris-footer b { color: var(--text-normal); font-weight: 600; }
    `;
    document.head.appendChild(styleEl);
    this.register(() => styleEl.remove());

    const statusEl = this.addStatusBarItem();
    statusEl.addClass("iris-status");
    setIcon(statusEl, "brain-circuit");
    statusEl.addEventListener("click", () => {
      new IrisLiveModal(this.app, this.relay).open();
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
      anthropicApiKey: this.settings.anthropicApiKey,
      trivialApiKey: this.settings.trivialApiKey,
      requestTimeoutMs: this.settings.requestTimeoutSec * 1000,
    };
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    if (data.batchState && Array.isArray(data.batchState.queued) && Array.isArray(data.batchState.pending)) {
      this.batchState = data.batchState;
    }
    const { batchState: _ignored, ...rest } = data;
    const raw = Object.assign({}, DEFAULT_SETTINGS, rest);
    raw.anthropicApiKey = decryptSecret(raw.anthropicApiKey);
    raw.trivialApiKey = decryptSecret(raw.trivialApiKey || "");
    this.settings = raw;
  }

  private async persistAll(): Promise<void> {
    const toSave: any = { ...this.settings };
    toSave.anthropicApiKey = encryptSecret(toSave.anthropicApiKey);
    toSave.trivialApiKey = encryptSecret(toSave.trivialApiKey);
    toSave.batchState = this.batchState;
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

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Shared API key used by all iris plugins routed through this relay.")
      .addText(t => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(s.anthropicApiKey)
          .onChange(async (v) => { s.anthropicApiKey = v.trim(); await save(); });
      });

    new Setting(containerEl)
      .setName("Trivial API key")
      .setDesc("Optional separate API key for trivial calls (e.g. nickname generation). Falls back to the main key when empty.")
      .addText(t => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(s.trivialApiKey)
          .onChange(async (v) => { s.trivialApiKey = v.trim(); await save(); });
      });

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
        const label = info.role === "main" ? "Main key" : "Trivial key";
        const reqPct = info.requestsLimit > 0 ? Math.round(info.requestsRemaining / info.requestsLimit * 100) : 100;
        const tokPct = info.tokensLimit > 0 ? Math.round(info.tokensRemaining / info.tokensLimit * 100) : 100;
        const desc = `Requests: ${info.requestsRemaining.toLocaleString()} / ${info.requestsLimit.toLocaleString()} remaining (${reqPct}%) · Tokens: ${info.tokensRemaining.toLocaleString()} / ${info.tokensLimit.toLocaleString()} remaining (${tokPct}%) · Concurrency: ${info.concurrency}`;
        new Setting(containerEl).setName(label).setDesc(desc);
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
        .setButtonText("Flush main")
        .onClick(async () => {
          try {
            const id = await this.plugin.relay.flushBatch();
            new Notice(id ? `Iris: submitted batch ${id}` : "Iris: queue empty");
          } catch (e) {
            new Notice(`Iris: ${e instanceof Error ? e.message : String(e)}`);
          }
          this.display();
        }))
      .addButton(b => b
        .setButtonText("Flush trivial")
        .onClick(async () => {
          try {
            const id = await this.plugin.relay.flushBatch({ trivial: true });
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
          .setDesc(`${p.entries} request${p.entries === 1 ? "" : "s"} · ${p.role} key · submitted ${ageMin} min ago`);
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
  private ageTicker?: number;

  constructor(app: App, relay: Relay) {
    super(app);
    this.relay = relay;
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

  private rolePill(parent: HTMLElement, role: "main" | "trivial" | "ok" | "error" | "cancelled", label?: string): void {
    parent.createSpan({ cls: `iris-row-role role-${role} status-${role}`, text: label ?? role });
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
    if (activeCount > 0 || queuedCount > 0) {
      status.addClass("is-active");
      const parts: string[] = [];
      if (activeCount > 0) parts.push(`${activeCount} in flight`);
      if (queuedCount > 0) parts.push(`${queuedCount} queued`);
      status.textContent = parts.join(" · ");
    } else {
      status.textContent = "idle";
    }

    if (limits.length > 0) {
      const sec = this.section(root, "Rate limits");
      for (const info of limits) {
        this.renderLimit(sec, info);
      }
    }

    const activeSec = this.section(root, "Active", activeCount, activeCount > 0);
    if (activeCount === 0) {
      activeSec.createDiv({ text: "no requests in flight", cls: "iris-section-empty" });
    } else {
      for (const a of snap.active) {
        const row = activeSec.createDiv({ cls: `iris-row${a.cancelled ? " status-cancelled" : ""}` });
        this.rolePill(row, a.role);
        this.callerCell(row, a.callerId, a.model);
        const age = row.createSpan({ cls: "iris-row-meta" });
        age.dataset.startedAt = String(a.startedAt);
        age.textContent = this.fmtAge(now - a.startedAt);
        if (!a.cancelled) {
          const btn = row.createEl("button", { cls: "iris-row-cancel", text: "✕", attr: { title: "Cancel" } });
          btn.addEventListener("click", () => this.relay.cancelActive(a.id));
        } else {
          row.createSpan();
        }
      }
    }

    if (queuedCount > 0) {
      const sec = this.section(root, "Queued", queuedCount);
      for (const q of snap.queued) {
        const row = sec.createDiv({ cls: "iris-row" });
        this.rolePill(row, q.role);
        this.callerCell(row, q.callerId, q.model);
        row.createSpan({ cls: "iris-row-meta", text: `p${q.priority}` });
        const btn = row.createEl("button", { cls: "iris-row-cancel", text: "✕", attr: { title: "Cancel" } });
        btn.addEventListener("click", () => this.relay.cancelQueued(q.id));
      }
    }

    const batchHasActivity = batch.queued > 0 || snap.batchPending.length > 0 || snap.history.some((h) => h.mode === "batch");
    if (batchHasActivity) {
      const sec = this.section(root, "Batch");
      const controls = sec.createDiv({ cls: "iris-batch-controls" });
      controls.createSpan({ text: `${batch.queued} queued` });
      const flushMain = controls.createEl("button", { cls: "iris-batch-btn", text: "Flush main" });
      flushMain.disabled = batch.queued === 0;
      flushMain.addEventListener("click", () => this.flush(false));
      const flushTriv = controls.createEl("button", { cls: "iris-batch-btn", text: "Flush trivial" });
      flushTriv.disabled = batch.queued === 0;
      flushTriv.addEventListener("click", () => this.flush(true));

      for (const p of snap.batchPending) {
        const row = sec.createDiv({ cls: "iris-row" });
        this.rolePill(row, p.role);
        this.callerCell(row, p.batchId, `${p.entries} item${p.entries === 1 ? "" : "s"}`);
        const age = row.createSpan({ cls: "iris-row-meta" });
        age.dataset.startedAt = String(p.submittedAt);
        age.textContent = this.fmtAge(now - p.submittedAt);
        row.createSpan();
      }
    }

    const topCallers = snap.callerStats.filter((c) => c.requests > 0).slice(0, 5);
    if (topCallers.length > 0) {
      const sec = this.section(root, "Callers");
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
      const sec = this.section(root, "Recent");
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
    const footer = root.createDiv({ cls: "iris-footer" });
    const fitem = (label: string, v: string | number) => {
      const span = footer.createSpan();
      span.createSpan({ text: `${label} ` });
      span.createEl("b", { text: typeof v === "number" ? this.fmtNum(v) : v });
    };
    fitem("Total", s.totalRequests);
    fitem("Errors", s.errors);
    fitem("Input", this.fmtTokens(totalIn));
    fitem("Output", this.fmtTokens(totalOut));
    if (totalCache > 0) fitem("Cache read", this.fmtTokens(totalCache));

    this.contentEl.replaceChildren(root);
  }

  private renderLimit(parent: HTMLElement, info: ReturnType<Relay["getRateLimits"]>[number]): void {
    const row = parent.createDiv({ cls: "iris-limit-row" });
    this.rolePill(row, info.role);

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

  private async flush(trivial: boolean): Promise<void> {
    try {
      const id = await this.relay.flushBatch(trivial ? { trivial: true } : undefined);
      new Notice(id ? `Iris: submitted batch ${id}` : "Iris: queue empty");
    } catch (e) {
      new Notice(`Iris: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }
}
