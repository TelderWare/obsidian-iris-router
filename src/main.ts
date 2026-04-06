import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { Relay } from "./relay";
import type { RelaySettings } from "./relay";

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

  async onload(): Promise<void> {
    await this.loadSettings();

    this.relay = new Relay(this.relaySettings());
    (this.app as any).irisRelay = this.relay;

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
    const raw = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    raw.anthropicApiKey = decryptSecret(raw.anthropicApiKey);
    raw.trivialApiKey = decryptSecret(raw.trivialApiKey || "");
    this.settings = raw;
  }

  async saveSettings(): Promise<void> {
    const toSave = { ...this.settings };
    toSave.anthropicApiKey = encryptSecret(toSave.anthropicApiKey);
    toSave.trivialApiKey = encryptSecret(toSave.trivialApiKey);
    await this.saveData(toSave);
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

    const stats = this.plugin.relay.getStats();
    if (stats.totalRequests > 0) {
      containerEl.createEl("h4", { text: "Session stats" });
      const parts = [
        `${stats.totalRequests} requests`,
        `${stats.dedupHits} dedup hits`,
        `${stats.cacheHits} cache hits`,
        `${stats.retries} retries`,
        `${stats.errors} errors`,
      ];
      new Setting(containerEl).setName("Totals").setDesc(parts.join(" · "));
    }
  }
}
