import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
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
      return "";
    }
  }
  return stored;
}

interface IrisRelaySettings {
  anthropicApiKey: string;
  maxConcurrency: number;
  requestTimeoutSec: number;
}

const DEFAULT_SETTINGS: IrisRelaySettings = {
  anthropicApiKey: "",
  maxConcurrency: 2,
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
    delete (this.app as any).irisRelay;
  }

  private relaySettings(): RelaySettings {
    return {
      anthropicApiKey: this.settings.anthropicApiKey,
      maxConcurrency: this.settings.maxConcurrency,
      requestTimeoutMs: this.settings.requestTimeoutSec * 1000,
    };
  }

  async loadSettings(): Promise<void> {
    const raw = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    raw.anthropicApiKey = decryptSecret(raw.anthropicApiKey);
    this.settings = raw;
  }

  async saveSettings(): Promise<void> {
    const toSave = { ...this.settings };
    toSave.anthropicApiKey = encryptSecret(toSave.anthropicApiKey);
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
      .setName("Max concurrency")
      .setDesc("Maximum simultaneous API requests. Lower values reduce rate-limit risk.")
      .addDropdown(d =>
        d.addOption("1", "1")
          .addOption("2", "2")
          .addOption("3", "3")
          .addOption("4", "4")
          .setValue(String(s.maxConcurrency))
          .onChange(async (v) => { s.maxConcurrency = parseInt(v, 10); await save(); }));

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
  }
}
