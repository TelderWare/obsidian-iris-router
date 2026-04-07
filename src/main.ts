import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { Relay } from "./relay";
import type { RelaySettings } from "./relay";

const SECRET_KEY_ANTHROPIC = "iris-router-anthropic-api-key";
const SECRET_KEY_TRIVIAL = "iris-router-trivial-api-key";

function getSecret(app: App, key: string): string {
  return (app as any).vault?.secretStorage?.getSecret?.(key) ?? "";
}

function setSecret(app: App, key: string, value: string): void {
  (app as any).vault?.secretStorage?.setSecret?.(key, value ?? "");
}

// Legacy decrypt — used once during migration to drain keys out of data.json.
function legacyDecrypt(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith("enc:")) {
    try {
      const { safeStorage } = require("electron");
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    } catch {
      new Notice("Iris Relay: unable to migrate legacy API key. Please re-enter it in settings.");
      return "";
    }
  }
  return stored;
}

interface IrisRelaySettings {
  requestTimeoutSec: number;
  // Legacy fields, only present in data.json from older versions. Migrated and cleared on load.
  anthropicApiKey?: string;
  trivialApiKey?: string;
}

const DEFAULT_SETTINGS: IrisRelaySettings = {
  requestTimeoutSec: 60,
};

export default class IrisRelayPlugin extends Plugin {
  settings!: IrisRelaySettings;
  anthropicApiKey = "";
  trivialApiKey = "";
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
      anthropicApiKey: this.anthropicApiKey,
      trivialApiKey: this.trivialApiKey,
      requestTimeoutMs: this.settings.requestTimeoutSec * 1000,
    };
  }

  async loadSettings(): Promise<void> {
    const raw = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Migrate legacy keys out of data.json into vault.secretStorage.
    let migrated = false;
    if (raw.anthropicApiKey) {
      const decrypted = legacyDecrypt(raw.anthropicApiKey);
      if (decrypted) setSecret(this.app, SECRET_KEY_ANTHROPIC, decrypted);
      delete raw.anthropicApiKey;
      migrated = true;
    }
    if (raw.trivialApiKey) {
      const decrypted = legacyDecrypt(raw.trivialApiKey);
      if (decrypted) setSecret(this.app, SECRET_KEY_TRIVIAL, decrypted);
      delete raw.trivialApiKey;
      migrated = true;
    }

    this.settings = raw;
    this.anthropicApiKey = getSecret(this.app, SECRET_KEY_ANTHROPIC);
    this.trivialApiKey = getSecret(this.app, SECRET_KEY_TRIVIAL);

    if (migrated) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    setSecret(this.app, SECRET_KEY_ANTHROPIC, this.anthropicApiKey);
    setSecret(this.app, SECRET_KEY_TRIVIAL, this.trivialApiKey);
    await this.saveData(this.settings);
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
    const save = () => this.plugin.saveSettings();

    containerEl.createEl("h3", { text: "Iris AI Router" });
    containerEl.createEl("p", {
      text: "Centralised AI API router for iris plugins. Other iris plugins will automatically route requests through this plugin when enabled.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Shared API key used by all iris plugins routed through this relay. Stored in the vault's secret storage, not in data.json.")
      .addText(t => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(this.plugin.anthropicApiKey)
          .onChange(async (v) => { this.plugin.anthropicApiKey = v.trim(); await save(); });
      });

    new Setting(containerEl)
      .setName("Trivial API key")
      .setDesc("Optional separate API key for trivial calls (e.g. nickname generation). Falls back to the main key when empty.")
      .addText(t => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(this.plugin.trivialApiKey)
          .onChange(async (v) => { this.plugin.trivialApiKey = v.trim(); await save(); });
      });

    new Setting(containerEl)
      .setName("Request timeout")
      .setDesc("Seconds before a single API request times out.")
      .addDropdown(d =>
        d.addOption("30", "30s")
          .addOption("60", "60s")
          .addOption("90", "90s")
          .addOption("120", "120s")
          .setValue(String(this.plugin.settings.requestTimeoutSec))
          .onChange(async (v) => { this.plugin.settings.requestTimeoutSec = parseInt(v, 10); await save(); }));

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
