const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} = require("obsidian");

const RAINDROP_PER_PAGE = 50;
const RAINDROP_MAX_PAGES_PER_SYNC = 10000;
const RAINDROP_RETRY_MAX_DELAY_MS = 120000;

const DEFAULT_SETTINGS = {
  accounts: [
    {
      name: "home",
      token: "",
      folder: "Bookmarks/Raindrop/home",
      enabled: true,
    },
  ],
  aiProvider: "ollama",
  ollamaUrl: "http://localhost:11434",
  model: "qwen3:1.7b",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiApiKey: "",
  openaiModel: "gpt-5-nano",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  outputLanguage: "ja",
  runOnStartup: false,
  startupIndexAfterSync: false,
  ignoredHosts: "",
  requestTimeoutSec: 20,
  ollamaTimeoutSec: 120,
  raindropTimeoutSec: 30,
  raindropMaxRetries: 5,
  maxIndexPerRun: 25,
  indexDelayMs: 1000,
  maxPageChars: 20000,
  blockPrivateNetworks: true,
};

const AI_KEYS = [
  "ai_summary",
  "ai_keywords",
  "ai_concepts",
  "ai_technologies",
  "ai_use_cases",
  "ai_limitations",
];

const AI_STATUS_PROCESSING = "__AI_PROCESSING__";
const AI_STATUS_FAILED = "__AI_FAILED__";

const SYNC_FRONTMATTER_KEYS = [
  "title",
  "source",
  "type",
  "created",
  "lastupdate",
  "id",
  "raindrop_id",
  "raindrop_account",
  "raindrop_collection_id",
  "raindrop_collection",
  "collectionId",
  "collectionTitle",
  "tags",
  "raindrop_tags",
  "raindrop_important",
  "raindrop_created",
  "raindrop_last_update",
  "raindrop_cover",
  "banner",
  "raindrop_synced_at",
];

module.exports = class AiBookmarkIndexerPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, await this.loadData()));
    await this.loadIgnoreRules();

    this.addCommand({
      id: "sync-raindrop-bookmarks",
      name: "Sync Raindrop bookmarks",
      callback: () => this.syncAllAccounts(false),
    });
    this.addCommand({
      id: "sync-raindrop-bookmarks-then-index",
      name: "Sync Raindrop bookmarks, then index",
      callback: () => this.syncAllAccounts(true),
    });
    this.addCommand({
      id: "index-current-bookmark",
      name: "Index current bookmark",
      callback: () => this.indexCurrent(false),
    });
    this.addCommand({
      id: "force-index-current-bookmark",
      name: "Force index current bookmark",
      callback: () => this.indexCurrent(true),
    });
    this.addCommand({
      id: "index-all-bookmarks",
      name: "Index all synced bookmarks",
      callback: () => this.indexAll(false),
    });
    this.addCommand({
      id: "force-index-all-bookmarks",
      name: "Force index all synced bookmarks",
      callback: () => this.indexAll(true),
    });
    this.addCommand({
      id: "reload-ignored-hosts",
      name: "Reload ignored hosts",
      callback: async () => {
        await this.loadIgnoreRules();
        new Notice(`RefRaindrop: loaded ${this.ignoreRules.length} ignore rule(s).`);
      },
    });

    this.addSettingTab(new AiBookmarkIndexerSettingTab(this.app, this));

    if (this.settings.runOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => this.syncAllAccounts(Boolean(this.settings.startupIndexAfterSync)), 3000);
      });
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadIgnoreRules() {
    this.ignoreRules = parseIgnoreRules(this.settings.ignoredHosts);
    return this.ignoreRules;
  }

  enabledAccounts() {
    return this.settings.accounts.filter((account) => account.enabled && String(account.token || "").trim() && normalizeFolder(account.folder));
  }

  scanFolders() {
    return this.settings.accounts.map((account) => normalizeFolder(account.folder)).filter(Boolean);
  }

  async syncAllAccounts(indexAfterSync) {
    await this.loadIgnoreRules();
    const accounts = this.enabledAccounts();
    if (accounts.length === 0) {
      new Notice("RefRaindrop: configure at least one enabled Raindrop account token.");
      return;
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    const touchedFiles = [];

    for (const account of accounts) {
      try {
        const result = await this.syncAccount(account);
        created += result.created;
        updated += result.updated;
        unchanged += result.unchanged;
        failed += result.failed;
        touchedFiles.push(...result.touchedFiles);
      } catch (error) {
        failed += 1;
        console.error(`RefRaindrop: sync failed for account ${account.name}`, error);
        new Notice(`RefRaindrop: sync failed for ${account.name}: ${displayMessageOf(error)}`, 10000);
      }
    }

    new Notice(
      `RefRaindrop: sync created ${created}, updated ${updated}, unchanged ${unchanged}, failed ${failed}.`
    );

    if (indexAfterSync && touchedFiles.length > 0) {
      await this.indexFiles(touchedFiles, false);
    }
  }

  async syncAccount(account) {
    const folder = accountFolder(account);
    await ensureVaultFolder(this.app, folder);
    const index = await this.buildSyncedNoteIndex(account);
    const raindrops = await fetchAllRaindrops(
      account.token,
      timeoutValue(this.settings.raindropTimeoutSec, DEFAULT_SETTINGS.raindropTimeoutSec),
      index.latestLastUpdate
    );
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    const touchedFiles = [];

    for (const raw of raindrops) {
      const item = raindropFromApi(raw);
      if (!item.id || !item.link) {
        failed += 1;
        console.warn("RefRaindrop: skipped invalid raindrop", raw);
        continue;
      }

      try {
        let file = index.byId.get(item.id) || index.byUrl.get(item.link);
        if (!file) {
          file = await this.createRaindropNote(account, item);
          index.byId.set(item.id, file);
          index.byUrl.set(item.link, file);
          created += 1;
        } else {
          const outcome = await this.updateRaindropNote(file, account, item);
          if (outcome === "updated") updated += 1;
          else unchanged += 1;
        }
        touchedFiles.push(file);
      } catch (error) {
        failed += 1;
        console.error("RefRaindrop: failed to process raindrop", item, error);
      }
    }

    return { created, updated, unchanged, failed, touchedFiles };
  }

  async buildSyncedNoteIndex(account) {
    const folder = accountFolder(account);
    const byId = new Map();
    const byUrl = new Map();
    let latestLastUpdate = "";
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path === folder || file.path.startsWith(`${folder}/`));

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache && cache.frontmatter) || {};
      const accountName = String(fm.raindrop_account || "");
      if (accountName && accountName !== account.name) continue;
      const id = String(fm.raindrop_id || fm.id || "");
      const url = getUrlFromValue(fm.source) || getUrlFromValue(fm.url);
      const lastUpdate = String(fm.raindrop_last_update || fm.lastupdate || "");
      if (id) byId.set(id, file);
      if (url) byUrl.set(url, file);
      latestLastUpdate = newerIsoString(latestLastUpdate, lastUpdate);
    }
    return { byId, byUrl, latestLastUpdate };
  }

  async createRaindropNote(account, item) {
    const filePath = `${accountFolder(account)}/${sanitizeFileName(item.id)}.md`;
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing) return existing;
    const text = buildNewRaindropMarkdown(account, item);
    return await this.app.vault.create(filePath, text);
  }

  async updateRaindropNote(file, account, item) {
    const originalText = await this.app.vault.read(file);
    const originalBody = stripFrontmatter(originalText);
    const oldFm = readFrontmatterFromText(originalText);
    const changed = hasRaindropRevisionChanged(oldFm, account, item);
    const body = updateSyncedBodySections(originalBody, item);
    const bodyChanged = body !== originalBody;

    if (!changed && !bodyChanged) {
      return "unchanged";
    }

    await this.updateFrontmatter(file, (fm) => {
      const next = raindropFrontmatter(account, item);
      for (const key of SYNC_FRONTMATTER_KEYS) delete fm[key];
      Object.assign(fm, next);
      if (fm.ai_writeprotect === undefined) fm.ai_writeprotect = false;
      ensureAiFrontmatterDefaults(fm);
      if (changed) {
        delete fm.last_http_status;
        delete fm.ai_needs_refresh;
        delete fm.ai_refresh_reason;
      }
    });

    if (bodyChanged) {
      const currentText = await this.app.vault.read(file);
      await this.app.vault.modify(file, replaceBody(currentText, body));
    }

    return "updated";
  }

  async indexCurrent(force) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("RefRaindrop: open a markdown bookmark note first.");
      return;
    }
    const result = await this.processFile(file, force);
    new Notice(`RefRaindrop: ${file.path}: ${result.status} ${result.message}`);
  }

  async indexAll(force) {
    const folders = this.scanFolders();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => folders.some((folder) => file.path === folder || file.path.startsWith(`${folder}/`)));
    await this.indexFiles(files, force);
  }

  async indexFiles(files, force) {
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let ignored = 0;
    let deferred = 0;
    const failures = [];
    const unique = uniqueFiles(files);
    const limit = nonNegativeInt(this.settings.maxIndexPerRun, DEFAULT_SETTINGS.maxIndexPerRun);
    const delayMs = nonNegativeInt(this.settings.indexDelayMs, DEFAULT_SETTINGS.indexDelayMs);
    let attempted = 0;

    for (const file of unique) {
      if (limit > 0 && attempted >= limit) {
        deferred += 1;
        continue;
      }
      attempted += 1;
      const result = await this.processFile(file, force);
      if (result.status === "updated") updated += 1;
      else if (result.status === "failed") {
        failed += 1;
        failures.push(`${file.path}: ${result.message}`);
      }
      else if (result.status === "ignored") ignored += 1;
      else skipped += 1;
      console.log(`RefRaindrop: ${file.path}: ${result.status} ${result.message}`);
      if (delayMs > 0 && attempted < unique.length && (limit === 0 || attempted < limit)) {
        await sleep(delayMs);
      }
    }
    let message = `RefRaindrop: indexed updated ${updated}, ignored ${ignored}, skipped ${skipped}, failed ${failed}, deferred ${deferred}.`;
    if (failures.length > 0) message += ` First failure: ${failures[0]}`;
    new Notice(message, failures.length > 0 ? 15000 : 5000);
  }

  async processFile(file, force) {
    try {
      const initialText = await this.app.vault.read(file);
      const frontmatter = readFrontmatterFromText(initialText);
      const url = getBookmarkUrl(frontmatter);
      if (!url) return { status: "skipped", message: "missing source/url" };

      const ignoredHost = ignoredHostForUrl(url, this.ignoreRules, this.settings.blockPrivateNetworks);
      if (ignoredHost) return { status: "ignored", message: `host ignored: ${ignoredHost}` };

      if (frontmatter.ai_writeprotect === true) {
        return { status: "skipped", message: "ai_writeprotect=true" };
      }
      if (!force && hasValue(frontmatter.last_http_status) && !isAiReservedStatus(frontmatter.ai_summary)) {
        return { status: "skipped", message: `last_http_status=${frontmatter.last_http_status}` };
      }

      await setAiReservedStatus(file, AI_STATUS_PROCESSING, "AI index generation is running.");

      let page;
      try {
        page = await fetchPage(url, timeoutValue(this.settings.requestTimeoutSec, DEFAULT_SETTINGS.requestTimeoutSec), this.settings.maxPageChars);
      } catch (error) {
        const status = httpStatusFromError(error);
        await this.updateFrontmatter(file, (fm) => {
          fm.last_http_status = status;
          delete fm.ai_needs_refresh;
          delete fm.ai_refresh_reason;
        });
        await setAiReservedStatus(file, AI_STATUS_FAILED, `Page fetch failed. last_http_status=${status}`);
        return { status: "failed", message: `fetch failed; last_http_status=${status}` };
      }

      const text = await this.app.vault.read(file);
      const userNotes = extractSection(stripFrontmatter(text), "## Local Notes") || extractSection(stripFrontmatter(text), "# User Notes");
      const index = await generateIndex({
        provider: this.settings.aiProvider,
        ollamaUrl: this.settings.ollamaUrl,
        model: this.settings.model,
        openaiBaseUrl: this.settings.openaiBaseUrl,
        openaiApiKey: this.settings.openaiApiKey,
        openaiModel: this.settings.openaiModel,
        geminiApiKey: this.settings.geminiApiKey,
        geminiModel: this.settings.geminiModel,
        outputLanguage: this.settings.outputLanguage,
        timeoutSec: timeoutValue(this.settings.ollamaTimeoutSec, DEFAULT_SETTINGS.ollamaTimeoutSec),
        url,
        title: page.title || String(frontmatter.title || file.basename),
        pageText: buildPageContext(page, frontmatter),
        userNotes,
      });
      validateIndex(index);

      await setAiIndexResult(file, index, page.status);
      return { status: "updated", message: "AI index written" };
    } catch (error) {
      console.error(error);
      try {
        await setAiReservedStatus(file, AI_STATUS_FAILED, messageOf(error));
      } catch (statusError) {
        console.error("RefRaindrop: failed to write AI status", statusError);
      }
      return { status: "failed", message: displayMessageOf(error) };
    }
  }

  async updateFrontmatter(file, updater) {
    await this.app.fileManager.processFrontMatter(file, updater);
  }
};

class AiBookmarkIndexerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "RefRaindrop" });

    containerEl.createEl("h3", { text: "Raindrop Accounts" });
    this.plugin.settings.accounts.forEach((account, index) => this.renderAccount(containerEl, account, index));
    new Setting(containerEl)
      .setName("Add account")
      .setDesc("Use separate accounts for home and work. Each account can sync into a different folder.")
      .addButton((button) =>
        button.setButtonText("Add").onClick(async () => {
          this.plugin.settings.accounts.push({
            name: `account-${this.plugin.settings.accounts.length + 1}`,
            token: "",
            folder: defaultAccountFolder(`account-${this.plugin.settings.accounts.length + 1}`),
            enabled: true,
          });
          await this.plugin.saveSettings();
          this.display();
        })
      );

    containerEl.createEl("h3", { text: "AI Index" });
    new Setting(containerEl)
      .setName("AI provider")
      .setDesc("Choose where bookmark AI indexing runs.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ollama", "Ollama")
          .addOption("openai", "OpenAI")
          .addOption("gemini", "Gemini")
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value) => {
            this.plugin.settings.aiProvider = normalizeAiProvider(value);
            await this.plugin.saveSettings();
            this.display();
          })
      )
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          try {
            const text = await generateText({
              provider: this.plugin.settings.aiProvider,
              ollamaUrl: this.plugin.settings.ollamaUrl,
              model: this.plugin.settings.model,
              openaiBaseUrl: this.plugin.settings.openaiBaseUrl,
              openaiApiKey: this.plugin.settings.openaiApiKey,
              openaiModel: this.plugin.settings.openaiModel,
              geminiApiKey: this.plugin.settings.geminiApiKey,
              geminiModel: this.plugin.settings.geminiModel,
              timeoutSec: timeoutValue(this.plugin.settings.ollamaTimeoutSec, DEFAULT_SETTINGS.ollamaTimeoutSec),
            }, 'JSONだけで {"ok": true} と返してください。');
            parseJsonResponse(text);
            new Notice(`RefRaindrop: ${this.plugin.settings.aiProvider} OK.`);
          } catch (error) {
            new Notice(`RefRaindrop: ${this.plugin.settings.aiProvider} failed: ${displayMessageOf(error)}`, 15000);
          }
        })
      );

    new Setting(containerEl)
      .setName("AI model")
      .setDesc("Model list falls back to the current/default model if listing is not permitted.")
      .addDropdown((dropdown) => {
        const provider = normalizeAiProvider(this.plugin.settings.aiProvider);
        const current = selectedAiModel(this.plugin.settings);
        setDropdownOptions(dropdown, ensureCurrentModel([defaultModelForProvider(provider)], current), current);
        dropdown.onChange(async (value) => {
          setSelectedAiModel(this.plugin.settings, value);
          await this.plugin.saveSettings();
        });
        loadAiModelOptions(this.plugin.settings).then((models) => {
          const selected = selectedAiModel(this.plugin.settings);
          setDropdownOptions(dropdown, ensureCurrentModel(models, selected), selected);
        });
      });

    new Setting(containerEl)
      .setName("Ollama URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.ollamaUrl).onChange(async (value) => {
          this.plugin.settings.ollamaUrl = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("OpenAI base URL")
      .setDesc("Default is https://api.openai.com/v1. OpenAI-compatible endpoints can be used here.")
      .addText((text) =>
        text.setValue(this.plugin.settings.openaiBaseUrl).onChange(async (value) => {
          this.plugin.settings.openaiBaseUrl = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Stored only in this plugin's Obsidian settings data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.openaiApiKey || "").onChange(async (value) => {
          this.plugin.settings.openaiApiKey = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.openaiApiKey = String(this.plugin.settings.openaiApiKey || "").trim();
          text.setValue(this.plugin.settings.openaiApiKey);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("Stored only in this plugin's Obsidian settings data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.geminiApiKey || "").onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.geminiApiKey = String(this.plugin.settings.geminiApiKey || "").trim();
          text.setValue(this.plugin.settings.geminiApiKey);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Output language")
      .setDesc("Language used for AI summaries and index fields.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ja", "Japanese")
          .addOption("en", "English")
          .addOption("zh", "Chinese")
          .addOption("ko", "Korean")
          .addOption("es", "Spanish")
          .addOption("fr", "French")
          .addOption("de", "German")
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (value) => {
            this.plugin.settings.outputLanguage = normalizeOutputLanguage(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ignored hosts")
      .setDesc("Hosts listed here are never fetched or summarized. Use one host per line. Wildcards like *.example.com are supported.")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.addClass("ref-raindrop-ignored-hosts");
        text.setValue(this.plugin.settings.ignoredHosts).onChange(async (value) => {
          this.plugin.settings.ignoredHosts = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.ignoredHosts = formatIgnoreRules(this.plugin.settings.ignoredHosts);
          text.setValue(this.plugin.settings.ignoredHosts);
          await this.plugin.loadIgnoreRules();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Block private networks")
      .setDesc("Always block localhost, .local, private IPv4 ranges, and link-local addresses.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.blockPrivateNetworks).onChange(async (value) => {
          this.plugin.settings.blockPrivateNetworks = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run Raindrop sync once after Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.runOnStartup)).onChange(async (value) => {
          this.plugin.settings.runOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Index after startup sync")
      .setDesc("Also run AI indexing after startup sync.")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.startupIndexAfterSync)).onChange(async (value) => {
          this.plugin.settings.startupIndexAfterSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Page request timeout seconds")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.requestTimeoutSec)).onChange(async (value) => {
          this.plugin.settings.requestTimeoutSec = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.requestTimeoutSec = positiveInt(this.plugin.settings.requestTimeoutSec, DEFAULT_SETTINGS.requestTimeoutSec);
          text.setValue(String(this.plugin.settings.requestTimeoutSec));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Ollama timeout seconds")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.ollamaTimeoutSec)).onChange(async (value) => {
          this.plugin.settings.ollamaTimeoutSec = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.ollamaTimeoutSec = positiveInt(this.plugin.settings.ollamaTimeoutSec, DEFAULT_SETTINGS.ollamaTimeoutSec);
          text.setValue(String(this.plugin.settings.ollamaTimeoutSec));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Raindrop timeout seconds")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.raindropTimeoutSec)).onChange(async (value) => {
          this.plugin.settings.raindropTimeoutSec = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.raindropTimeoutSec = positiveInt(this.plugin.settings.raindropTimeoutSec, DEFAULT_SETTINGS.raindropTimeoutSec);
          text.setValue(String(this.plugin.settings.raindropTimeoutSec));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Max AI indexes per run")
      .setDesc("Limits page fetches during large initial imports. Use 0 for unlimited.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.maxIndexPerRun)).onChange(async (value) => {
          this.plugin.settings.maxIndexPerRun = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.maxIndexPerRun = nonNegativeInt(this.plugin.settings.maxIndexPerRun, DEFAULT_SETTINGS.maxIndexPerRun);
          text.setValue(String(this.plugin.settings.maxIndexPerRun));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Delay between AI indexes milliseconds")
      .setDesc("Adds a delay between bookmark page fetches. Use 0 for no delay.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.indexDelayMs)).onChange(async (value) => {
          this.plugin.settings.indexDelayMs = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          this.plugin.settings.indexDelayMs = nonNegativeInt(this.plugin.settings.indexDelayMs, DEFAULT_SETTINGS.indexDelayMs);
          text.setValue(String(this.plugin.settings.indexDelayMs));
          await this.plugin.saveSettings();
        });
      });
  }

  renderAccount(containerEl, account, index) {
    const heading = containerEl.createEl("h4", { text: `${account.name || `account-${index + 1}`}` });
    heading.addClass("ref-raindrop-account-heading");
    let folderText = null;

    new Setting(containerEl)
      .setName("Enabled")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(account.enabled)).onChange(async (value) => {
          account.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Account name")
      .setDesc("Used in frontmatter as raindrop_account.")
      .addText((text) => {
        text.setValue(account.name || "").onChange(async (value) => {
          account.name = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          account.name = sanitizeAccountName(account.name || `account-${index + 1}`);
          const currentFolder = normalizeFolder(account.folder || "");
          if (!currentFolder || !(await this.app.vault.adapter.exists(currentFolder))) {
            account.folder = defaultAccountFolder(account.name);
            if (folderText) folderText.setValue(account.folder);
          }
          await this.plugin.saveSettings();
          heading.setText(account.name || `account-${index + 1}`);
        });
      });

    new Setting(containerEl)
      .setName("Raindrop test token")
      .setDesc("Personal test token. Keep it out of Git and synced notes.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(account.token || "").onChange(async (value) => {
          account.token = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          account.token = String(account.token || "").trim();
          text.setValue(account.token);
          await this.plugin.saveSettings();
        });
      })
      .addButton((button) =>
        button.setButtonText("Verify").onClick(async () => {
          try {
            await fetchRaindropUser(account.token, timeoutValue(this.plugin.settings.raindropTimeoutSec, DEFAULT_SETTINGS.raindropTimeoutSec));
            new Notice(`RefRaindrop: token valid for ${account.name}.`);
          } catch (error) {
            new Notice(`RefRaindrop: token failed for ${account.name}: ${displayMessageOf(error)}`, 10000);
          }
        })
      );

    new Setting(containerEl)
      .setName("Destination folder")
      .setDesc("Files are stored directly in this folder as {raindrop_id}.md.")
      .addText((text) => {
        folderText = text;
        text.setValue(account.folder || "").onChange(async (value) => {
          account.folder = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", async () => {
          account.folder = normalizeFolder(account.folder || defaultAccountFolder(account.name || `account-${index + 1}`));
          text.setValue(account.folder);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Remove account")
      .setDesc("Only removes plugin settings. Existing notes are not deleted.")
      .addButton((button) =>
        button.setWarning().setButtonText("Remove").onClick(async () => {
          this.plugin.settings.accounts.splice(index, 1);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
}

function normalizeSettings(settings) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  merged.aiProvider = normalizeAiProvider(merged.aiProvider);
  merged.ollamaUrl = String(merged.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).trim();
  merged.model = String(merged.model || DEFAULT_SETTINGS.model).trim();
  merged.openaiBaseUrl = String(merged.openaiBaseUrl || DEFAULT_SETTINGS.openaiBaseUrl).trim();
  merged.openaiApiKey = String(merged.openaiApiKey || "").trim();
  merged.openaiModel = String(merged.openaiModel || DEFAULT_SETTINGS.openaiModel).trim();
  merged.geminiApiKey = String(merged.geminiApiKey || "").trim();
  merged.geminiModel = String(merged.geminiModel || DEFAULT_SETTINGS.geminiModel).trim();
  merged.outputLanguage = normalizeOutputLanguage(merged.outputLanguage);
  merged.runOnStartup = Boolean(merged.runOnStartup);
  merged.startupIndexAfterSync = Boolean(merged.startupIndexAfterSync);
  merged.ignoredHosts = String(merged.ignoredHosts || "");
  merged.maxIndexPerRun = nonNegativeInt(merged.maxIndexPerRun, DEFAULT_SETTINGS.maxIndexPerRun);
  merged.indexDelayMs = nonNegativeInt(merged.indexDelayMs, DEFAULT_SETTINGS.indexDelayMs);
  if (!Array.isArray(merged.accounts) || merged.accounts.length === 0) {
    merged.accounts = DEFAULT_SETTINGS.accounts.map((account) => Object.assign({}, account));
  }
  merged.accounts = merged.accounts.map((account, index) => ({
    name: sanitizeAccountName(account.name || `account-${index + 1}`),
    token: String(account.token || ""),
    folder: normalizeFolder(account.folder || defaultAccountFolder(`account-${index + 1}`)),
    enabled: account.enabled !== false,
  }));
  return merged;
}

function normalizeAiProvider(value) {
  const provider = String(value || "ollama").trim().toLowerCase();
  return ["ollama", "openai", "gemini"].includes(provider) ? provider : "ollama";
}

function normalizeOutputLanguage(value) {
  const language = String(value || "ja").trim().toLowerCase();
  return ["ja", "en", "zh", "ko", "es", "fr", "de"].includes(language) ? language : "ja";
}

function outputLanguageName(value) {
  const language = normalizeOutputLanguage(value);
  return {
    ja: "Japanese",
    en: "English",
    zh: "Chinese",
    ko: "Korean",
    es: "Spanish",
    fr: "French",
    de: "German",
  }[language];
}

function selectedAiModel(settings) {
  const provider = normalizeAiProvider(settings.aiProvider);
  if (provider === "openai") return String(settings.openaiModel || DEFAULT_SETTINGS.openaiModel).trim();
  if (provider === "gemini") return String(settings.geminiModel || DEFAULT_SETTINGS.geminiModel).trim();
  return String(settings.model || DEFAULT_SETTINGS.model).trim();
}

function setSelectedAiModel(settings, value) {
  const model = String(value || "").trim();
  const provider = normalizeAiProvider(settings.aiProvider);
  if (provider === "openai") settings.openaiModel = model || DEFAULT_SETTINGS.openaiModel;
  else if (provider === "gemini") settings.geminiModel = model || DEFAULT_SETTINGS.geminiModel;
  else settings.model = model || DEFAULT_SETTINGS.model;
}

function defaultModelForProvider(provider) {
  if (provider === "openai") return DEFAULT_SETTINGS.openaiModel;
  if (provider === "gemini") return DEFAULT_SETTINGS.geminiModel;
  return DEFAULT_SETTINGS.model;
}

function ensureCurrentModel(models, current) {
  const result = [];
  for (const model of [current, ...models]) {
    const value = String(model || "").trim();
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function setDropdownOptions(dropdown, models, selected) {
  while (dropdown.selectEl.firstChild) dropdown.selectEl.removeChild(dropdown.selectEl.firstChild);
  for (const model of models) dropdown.addOption(model, model);
  dropdown.setValue(models.includes(selected) ? selected : models[0]);
}

async function loadAiModelOptions(settings) {
  const provider = normalizeAiProvider(settings.aiProvider);
  const fallback = [selectedAiModel(settings) || defaultModelForProvider(provider)];
  try {
    if (provider === "openai") return ensureCurrentModel(await fetchOpenAiModelNames(settings), fallback[0]);
    if (provider === "gemini") return ensureCurrentModel(await fetchGeminiModelNames(settings), fallback[0]);
    return ensureCurrentModel(await fetchOllamaModelNames(settings), fallback[0]);
  } catch (error) {
    console.warn(`RefRaindrop: failed to load ${provider} model list`, error);
    return fallback;
  }
}

function sanitizeAccountName(value) {
  return String(value || "account").trim() || "account";
}

function normalizeFolder(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function accountFolder(account) {
  return normalizeFolder(account.folder || defaultAccountFolder(account.name || "account"));
}

function defaultAccountFolder(accountName) {
  return `Bookmarks/Raindrop/${sanitizeAccountName(accountName || "account")}`;
}

function uniqueFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}

async function ensureVaultFolder(app, folder) {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}

async function fetchRaindropUser(token, timeoutSec) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) throw new Error("missing token");
  return await requestRaindropJsonWithRetry(normalizedToken, "/user", {}, timeoutSec);
}

async function fetchAllRaindrops(token, timeoutSec, sinceLastUpdate) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) throw new Error("missing token");
  const items = [];
  let page = 0;
  let reachedKnownRevision = false;
  while (true) {
    if (page >= RAINDROP_MAX_PAGES_PER_SYNC) {
      throw new Error(`Raindrop pagination exceeded ${RAINDROP_MAX_PAGES_PER_SYNC} pages; aborting sync.`);
    }
    const data = await requestRaindropJsonWithRetry(normalizedToken, "/raindrops/0", {
      page,
      perpage: RAINDROP_PER_PAGE,
      sort: "-lastUpdate",
    }, timeoutSec);
    const pageItems = Array.isArray(data.items) ? data.items : [];
    for (const item of pageItems) {
      if (!isNewerLastUpdate(item && item.lastUpdate, sinceLastUpdate)) {
        reachedKnownRevision = true;
        break;
      }
      items.push(item);
    }
    if (reachedKnownRevision || pageItems.length < RAINDROP_PER_PAGE) break;
    page += 1;
  }
  return items;
}

async function requestRaindropJsonWithRetry(token, apiPath, params, timeoutSec) {
  let lastError = null;
  const maxRetries = nonNegativeInt(DEFAULT_SETTINGS.raindropMaxRetries, 3);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestRaindropJson(token, apiPath, params, timeoutSec);
    } catch (error) {
      lastError = error;
      if (!isRetryableRaindropError(error) || attempt >= maxRetries) break;
      const waitMs = retryDelayMs(error, attempt);
      console.warn(`RefRaindrop: Raindrop rate limited; retrying in ${waitMs} ms`, error);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function requestRaindropJson(token, apiPath, params, timeoutSec) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) query.set(key, String(value));
  const url = `https://api.raindrop.io/rest/v1${apiPath}${query.toString() ? `?${query.toString()}` : ""}`;
  const response = await withTimeout(
    requestUrl({
      url,
      method: "GET",
      throw: false,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "ref-raindrop/0.1",
      },
    }),
    timeoutSec * 1000,
    "raindrop request timed out"
  );
  if (response.status >= 400) throw raindropHttpError(response);
  const data = JSON.parse(response.text);
  if (data.result === false) throw new Error("Raindrop API returned result=false");
  return data;
}

function raindropHttpError(response) {
  const detail = compactMessage(response && response.text).slice(0, 200);
  const error = new Error(`Raindrop HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  error.status = response.status;
  error.retryAfterMs = retryAfterMs(response && response.headers);
  if (Number(response.status) === 429) {
    error.displayMessage = "Raindrop HTTP 429: rate limited; wait and sync again.";
  }
  return error;
}

function isRetryableRaindropError(error) {
  const status = Number(error && error.status);
  return status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(error, attempt) {
  const retryAfter = Number(error && error.retryAfterMs);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, RAINDROP_RETRY_MAX_DELAY_MS);
  return Math.min(2000 * Math.pow(2, attempt), RAINDROP_RETRY_MAX_DELAY_MS);
}

function retryAfterMs(headers) {
  const value = headerValue(headers, "retry-after");
  if (!value) return 0;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

function headerValue(headers, name) {
  if (!headers) return "";
  const lowered = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowered) return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }
  return "";
}

function raindropFromApi(data) {
  const collection = isObject(data.collection) ? data.collection : {};
  const media = Array.isArray(data.media) ? data.media : [];
  const cover = media.length && isObject(media[0]) ? String(media[0].link || "") : "";
  return {
    id: String(data._id || ""),
    link: String(data.link || ""),
    title: String(data.title || data.link || "Untitled"),
    excerpt: htmlToMarkdown(String(data.excerpt || "")),
    note: htmlToMarkdown(String(data.note || "")),
    tags: Array.isArray(data.tags) ? data.tags.map((tag) => String(tag)).filter(Boolean) : [],
    domain: String(data.domain || domainOf(data.link || "")),
    created: String(data.created || ""),
    lastUpdate: String(data.lastUpdate || ""),
    important: Boolean(data.important),
    collectionId: String(collection.$id || collection._id || ""),
    collectionTitle: String(collection.title || ""),
    type: String(data.type || ""),
    cover,
    highlights: Array.isArray(data.highlights) ? data.highlights : [],
  };
}

function raindropFrontmatter(account, item) {
  const props = {
    title: item.title,
    source: item.link,
    type: item.type || "link",
    created: item.created || null,
    lastupdate: item.lastUpdate || null,
    id: item.id,
    raindrop_id: item.id,
    raindrop_account: account.name,
    raindrop_collection_id: item.collectionId || null,
    raindrop_collection: item.collectionTitle || null,
    collectionId: item.collectionId || null,
    collectionTitle: item.collectionTitle || null,
    tags: item.tags,
    raindrop_tags: item.tags,
    raindrop_important: item.important,
    raindrop_created: item.created || null,
    raindrop_last_update: item.lastUpdate || null,
    raindrop_cover: item.cover || null,
    raindrop_synced_at: new Date().toISOString(),
  };
  return props;
}

function ensureAiFrontmatterDefaults(fm) {
  for (const key of AI_KEYS) {
    if (fm[key] === undefined) fm[key] = null;
  }
  if (fm.ai_writeprotect === undefined) fm.ai_writeprotect = false;
}

function buildNewRaindropMarkdown(account, item) {
  const props = raindropFrontmatter(account, item);
  ensureAiFrontmatterDefaults(props);
  props.ai_writeprotect = false;
  const frontmatter = dumpYaml(props);
  return `---\n${frontmatter}---\n${renderNewBody(item)}`;
}

function renderNewBody(item) {
  const parts = [];
  parts.push(`# ${item.title}`, "");
  parts.push("# User Notes", "", "## Raindrop Note", "", item.note || "-", "", "## Local Notes", "", "-", "");
  parts.push(renderRaindropSections(item), "");
  parts.push("---", "", renderDetails(item), "");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

function renderRaindropSections(item) {
  const parts = ["# Raindrop", ""];
  if (item.excerpt) parts.push("## Description", "", item.excerpt, "");
  if (item.highlights.length > 0) {
    parts.push("## Highlights", "");
    for (const highlight of item.highlights) {
      const text = htmlToMarkdown(String(highlight.text || "")).trim();
      const note = htmlToMarkdown(String(highlight.note || "")).trim();
      if (!text) continue;
      parts.push(`- ${text}`);
      if (note) parts.push(`  - Note: ${note}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

function renderDetails(item) {
  return [
    "## Details",
    `- **Type**: ${item.type || "-"}`,
    `- **Domain**: ${item.domain || domainOf(item.link) || "-"}`,
    `- **Created**: ${item.created || "-"}`,
    `- **Updated**: ${item.lastUpdate || "-"}`,
    `- **Tags**: ${item.tags.length ? item.tags.map((tag) => `#${tag}`).join(" ") : "-"}`,
    `- **Source**: [Open](${item.link})`,
  ].join("\n");
}

function updateSyncedBodySections(body, item) {
  let next = removeLeadingMarkdownImage(body);
  next = ensureHeading(next, "# User Notes");
  next = replaceSubsectionInUserNotes(next, "## Raindrop Note", item.note || "-");
  next = ensureSubsectionInUserNotes(next, "## Local Notes", "-");
  next = replaceTopLevelSection(next, "# Raindrop", renderRaindropSections(item));
  next = replaceDetailsSection(next, renderDetails(item));
  next = removeTopLevelSection(next, "# AI Index");
  return next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function removeLeadingMarkdownImage(body) {
  const text = String(body || "");
  const rest = text.trimStart();
  if (!rest.startsWith("![")) return text;
  const altEnd = rest.indexOf("]");
  const urlStart = rest.indexOf("(", altEnd + 1);
  const urlEnd = rest.indexOf(")", urlStart + 1);
  if (altEnd < 0 || urlStart !== altEnd + 1 || urlEnd < 0) return text;
  const url = rest.slice(urlStart + 1, urlEnd).trim();
  if (!/^https?:\/\//i.test(url)) return text;
  return rest.slice(urlEnd + 1).replace(/^\s*\n+/, "");
}

function hasRaindropRevisionChanged(frontmatter, account, item) {
  const oldId = String(frontmatter.raindrop_id || frontmatter.id || "");
  const oldAccount = String(frontmatter.raindrop_account || "");
  const oldSource = getUrlFromValue(frontmatter.source) || getUrlFromValue(frontmatter.url);
  const oldLastUpdate = String(frontmatter.raindrop_last_update || frontmatter.lastupdate || "");
  const newLastUpdate = String(item.lastUpdate || "");

  if (oldId !== item.id) return true;
  if (oldAccount !== account.name) return true;
  if (oldSource !== item.link) return true;
  if (oldLastUpdate && newLastUpdate) return oldLastUpdate !== newLastUpdate;

  return hasRaindropFallbackFieldChanged(frontmatter, item);
}

function hasRaindropFallbackFieldChanged(frontmatter, item) {
  const oldTags = Array.isArray(frontmatter.raindrop_tags || frontmatter.tags)
    ? frontmatter.raindrop_tags || frontmatter.tags
    : [];
  return (
    String(frontmatter.title || "") !== item.title ||
    String(frontmatter.type || "") !== (item.type || "link") ||
    String(frontmatter.raindrop_collection_id || frontmatter.collectionId || "") !== (item.collectionId || "") ||
    String(frontmatter.raindrop_collection || frontmatter.collectionTitle || "") !== (item.collectionTitle || "") ||
    Boolean(frontmatter.raindrop_important) !== item.important ||
    JSON.stringify(oldTags.map(String)) !== JSON.stringify(item.tags.map(String))
  );
}

function syncComparable(frontmatter, bodyOrSections) {
  return {
    title: frontmatter.title || "",
    source: frontmatter.source || "",
    type: frontmatter.type || "",
    id: String(frontmatter.raindrop_id || frontmatter.id || ""),
    account: frontmatter.raindrop_account || "",
    tags: Array.isArray(frontmatter.raindrop_tags || frontmatter.tags) ? frontmatter.raindrop_tags || frontmatter.tags : [],
    important: Boolean(frontmatter.raindrop_important),
    lastupdate: frontmatter.raindrop_last_update || frontmatter.lastupdate || "",
    syncedBody: normalizeBodyForCompare(bodyOrSections),
  };
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function managedSyncBodyForItem(item) {
  return [
    "## Raindrop Note",
    item.note || "-",
    renderRaindropSections(item),
    renderDetails(item),
  ].join("\n");
}

function extractManagedSyncBody(body) {
  const details = extractSection(body, "## Details");
  return [
    "## Raindrop Note",
    extractSection(body, "## Raindrop Note") || "-",
    extractTopLevelSection(body, "# Raindrop"),
    details ? `## Details\n${details}` : "",
  ].join("\n");
}

function normalizeBodyForCompare(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function dumpYaml(props) {
  const lines = [];
  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${formatYamlScalar(item)}`);
      }
    } else if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else {
      lines.push(`${key}: ${formatYamlScalar(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function updateFrontmatterText(text, updater) {
  if (!text.startsWith("---\n")) {
    const props = {};
    updater(props);
    return `---\n${dumpYaml(props)}---\n${text}`;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    const props = {};
    updater(props);
    return `---\n${dumpYaml(props)}---\n${text}`;
  }
  const rawYaml = text.slice(4, end);
  const body = text.slice(end + 5);
  const props = parseSimpleYaml(rawYaml);
  updater(props);
  return `---\n${dumpYaml(props)}---\n${body}`;
}

function parseSimpleYaml(rawYaml) {
  const props = {};
  let currentKey = "";
  for (const line of rawYaml.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("  - ") && currentKey) {
      if (!Array.isArray(props[currentKey])) props[currentKey] = [];
      props[currentKey].push(parseYamlScalar(line.slice(4).trim()));
      continue;
    }
    const splitAt = line.indexOf(":");
    if (splitAt === -1) continue;
    const key = line.slice(0, splitAt).trim();
    const rawValue = line.slice(splitAt + 1).trim();
    currentKey = key;
    if (rawValue === "") props[key] = null;
    else props[key] = parseYamlScalar(rawValue);
  }
  return props;
}

function parseYamlScalar(value) {
  const lowered = value.toLowerCase();
  if (value === "[]") return [];
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  if (lowered === "null" || lowered === "~") return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function formatYamlScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  if (text === "" || text.trim() !== text || /[:#\n\r]|^\[|\]$|^\{|\}$/.test(text)) {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return text;
}

function sanitizeFileName(value) {
  return String(value || "Untitled").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").trim().slice(0, 140) || "Untitled";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function htmlToMarkdown(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/?p[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function isAiReservedStatus(value) {
  return value === AI_STATUS_PROCESSING || value === AI_STATUS_FAILED;
}

function getBookmarkUrl(frontmatter) {
  return getUrlFromValue(frontmatter.source) || getUrlFromValue(frontmatter.url);
}

function getUrlFromValue(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function parseIgnoreRules(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(normalizeIgnoreRule)
    .filter(Boolean);
}

function formatIgnoreRules(text) {
  return parseIgnoreRules(text).join("\n");
}

function normalizeIgnoreRule(rule) {
  try {
    if (/^https?:\/\//i.test(rule)) return new URL(rule).hostname.toLowerCase().replace(/\.$/, "");
  } catch (_) {
    return "";
  }
  return rule.toLowerCase().replace(/\.$/, "");
}

function ignoredHostForUrl(url, rules, blockPrivateNetworks) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch (_) {
    return "invalid-url";
  }
  if (blockPrivateNetworks && isPrivateHost(host)) return host;
  for (const rule of rules) {
    if (hostMatchesRule(host, rule)) return rule;
  }
  return "";
}

function hostMatchesRule(host, rule) {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return host.endsWith(`.${suffix}`);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    parts[0] === 127
  );
}

async function fetchPage(url, timeoutSec, maxChars) {
  const response = await withTimeout(
    requestUrl({
      url,
      method: "GET",
      throw: false,
      headers: {
        "User-Agent": "ref-raindrop/0.1",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    }),
    timeoutSec * 1000,
    "page request timed out"
  );
  if (response.status >= 400) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = String(response.text || "").slice(0, maxChars * 4);
  const parsed = parseHtml(text, maxChars);
  return {
    title: parsed.title,
    description: parsed.description,
    text: parsed.text,
    status: response.status || 200,
  };
}

function parseHtml(html, maxChars) {
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script, style, noscript, svg").forEach((node) => node.remove());
    const title = (document.querySelector("title") && document.querySelector("title").textContent || "").trim();
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const description = (meta && meta.getAttribute("content") || "").trim();
    const text = (document.body && document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
    return { title, description, text };
  }
  return {
    title: matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: matchFirst(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i),
    text: html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars),
  };
}

function matchFirst(text, regex) {
  const match = regex.exec(text);
  return match ? htmlToMarkdown(match[1]) : "";
}

async function generateIndex(options) {
  const prompt = buildPrompt(options);
  const raw = await generateText(options, prompt);
  try {
    return indexFromObject(parseJsonResponse(raw));
  } catch (_) {
    const repaired = await generateText(options, buildJsonRepairPrompt(raw, options.outputLanguage));
    return indexFromObject(parseJsonResponse(repaired));
  }
}

async function generateText(options, prompt) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const provider = normalizeAiProvider(options.provider);
      if (provider === "openai") return await openaiGenerate(options, prompt);
      if (provider === "gemini") return await geminiGenerate(options, prompt);
      return await ollamaGenerate(options.ollamaUrl, options.model, prompt, options.timeoutSec);
    } catch (error) {
      lastError = error;
      if (!isRetryableAiError(error) || attempt > 0) throw error;
      await sleep(1000);
    }
  }
  throw lastError;
}

async function ollamaGenerate(ollamaUrl, model, prompt, timeoutSec) {
  const baseUrl = String(ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, "");
  const response = await withTimeout(
    requestUrl({
      url: `${baseUrl}/api/generate`,
      method: "POST",
      throw: false,
      contentType: "application/json",
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.2 },
      }),
    }),
    timeoutSec * 1000,
    "ollama request timed out"
  );
  if (response.status >= 400) throw aiHttpError("Ollama", response);
  const data = JSON.parse(response.text);
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  return String(data.response || "");
}

async function openaiGenerate(options, prompt) {
  const apiKey = String(options.openaiApiKey || "").trim();
  if (!apiKey) throw new Error("missing OpenAI API key");
  const baseUrl = String(options.openaiBaseUrl || DEFAULT_SETTINGS.openaiBaseUrl).replace(/\/+$/, "");
  const response = await withTimeout(
    requestUrl({
      url: `${baseUrl}/responses`,
      method: "POST",
      throw: false,
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: String(options.openaiModel || DEFAULT_SETTINGS.openaiModel),
        input: prompt,
        store: false,
      }),
    }),
    options.timeoutSec * 1000,
    "OpenAI request timed out"
  );
  if (response.status >= 400) throw aiHttpError("OpenAI", response);
  const data = JSON.parse(response.text);
  const text = extractOpenAiText(data);
  if (!text) throw new Error("OpenAI response had no text output.");
  return text;
}

async function geminiGenerate(options, prompt) {
  const apiKey = String(options.geminiApiKey || "").trim();
  if (!apiKey) throw new Error("missing Gemini API key");
  const model = encodeURIComponent(String(options.geminiModel || DEFAULT_SETTINGS.geminiModel).replace(/^models\//, ""));
  const response = await withTimeout(
    requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: "POST",
      throw: false,
      contentType: "application/json",
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    }),
    options.timeoutSec * 1000,
    "Gemini request timed out"
  );
  if (response.status >= 400) throw aiHttpError("Gemini", response);
  const data = JSON.parse(response.text);
  const text = extractGeminiText(data);
  if (!text) throw new Error("Gemini response had no text output.");
  return text;
}

async function fetchOllamaModelNames(settings) {
  const baseUrl = String(settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, "");
  const response = await withTimeout(
    requestUrl({
      url: `${baseUrl}/api/tags`,
      method: "GET",
      throw: false,
    }),
    timeoutValue(settings.ollamaTimeoutSec, DEFAULT_SETTINGS.ollamaTimeoutSec) * 1000,
    "ollama tags request timed out"
  );
  if (response.status >= 400) throw aiHttpError("Ollama", response);
  const data = JSON.parse(response.text);
  return (Array.isArray(data.models) ? data.models : [])
    .map((model) => String(model && model.name || "").trim())
    .filter(Boolean)
    .sort();
}

async function fetchOpenAiModelNames(settings) {
  const apiKey = String(settings.openaiApiKey || "").trim();
  if (!apiKey) throw new Error("missing OpenAI API key");
  const baseUrl = String(settings.openaiBaseUrl || DEFAULT_SETTINGS.openaiBaseUrl).replace(/\/+$/, "");
  const response = await withTimeout(
    requestUrl({
      url: `${baseUrl}/models`,
      method: "GET",
      throw: false,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }),
    timeoutValue(settings.ollamaTimeoutSec, DEFAULT_SETTINGS.ollamaTimeoutSec) * 1000,
    "OpenAI models request timed out"
  );
  if (response.status >= 400) throw aiHttpError("OpenAI", response);
  const data = JSON.parse(response.text);
  return (Array.isArray(data.data) ? data.data : [])
    .map((model) => String(model && model.id || "").trim())
    .filter((id) => id && /^(gpt|o[0-9]|chatgpt)/i.test(id))
    .sort();
}

async function fetchGeminiModelNames(settings) {
  const apiKey = String(settings.geminiApiKey || "").trim();
  if (!apiKey) throw new Error("missing Gemini API key");
  const response = await withTimeout(
    requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      method: "GET",
      throw: false,
    }),
    timeoutValue(settings.ollamaTimeoutSec, DEFAULT_SETTINGS.ollamaTimeoutSec) * 1000,
    "Gemini models request timed out"
  );
  if (response.status >= 400) throw aiHttpError("Gemini", response);
  const data = JSON.parse(response.text);
  return (Array.isArray(data.models) ? data.models : [])
    .filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
    .map((model) => String(model.name || "").replace(/^models\//, "").trim())
    .filter(Boolean)
    .sort();
}

function extractOpenAiText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function extractGeminiText(data) {
  const parts = [];
  for (const candidate of Array.isArray(data.candidates) ? data.candidates : []) {
    const content = candidate.content || {};
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

function buildPrompt({ url, title, pageText, userNotes, outputLanguage }) {
  const languageName = outputLanguageName(outputLanguage);
  return `あなたはObsidian Bookmark用のAI検索インデックスを作るエージェントです。
目的は人間向け記事要約ではなく、将来のAIがこのURLを再発見するための客観的インデックス生成です。

必須ルール:
- ${languageName}で書く
- 本文全文を転載しない
- すべてのフィールドを必ず埋める
- 配列はそれぞれ2個以上入れる
- title, URL, description, user notes を広告本文より優先する
- 地名、製品名、固有名詞を推測で置き換えない
- 空文字、空配列、nullは禁止
- JSON以外の文章は禁止

返すJSONキー:
summary: 1から2文の文字列
keywords: 重要検索語の配列
concepts: 抽象概念の配列
technologies: 技術名・製品名・規格名の配列
use_cases: 用途・利用場面の配列
limitations: 注意点・制約・未確認点の配列

URL:
${url}

Title:
${title}

User Notes:
${userNotes || "(none)"}

Page text excerpt:
${String(pageText || "").slice(0, 12000)}
`;
}

function buildJsonRepairPrompt(response, outputLanguage) {
  const languageName = outputLanguageName(outputLanguage);
  return `次の内容を、必ずJSONオブジェクトだけに変換してください。
値はすべて自然な${languageName}に翻訳してください。
説明文、Markdown、コードフェンスは禁止です。
空文字、空配列、nullは禁止です。

必須キー:
summary, keywords, concepts, technologies, use_cases, limitations

入力:
${String(response || "").slice(0, 6000)}
`;
}

function parseJsonResponse(text) {
  const stripped = stripCodeFence(String(text || "").trim());
  try {
    return JSON.parse(stripped);
  } catch (_) {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("No JSON object found in model response.");
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

function stripCodeFence(text) {
  if (!text.startsWith("```")) return text;
  const lines = text.split(/\r?\n/);
  if (lines[0].startsWith("```")) lines.shift();
  if (lines.length && lines[lines.length - 1].startsWith("```")) lines.pop();
  return lines.join("\n").trim();
}

function indexFromObject(data) {
  return normalizeIndex({
    summary: String(data.summary || "").trim(),
    keywords: asStringList(data.keywords),
    concepts: asStringList(data.concepts),
    technologies: asStringList(data.technologies),
    use_cases: asStringList(data.use_cases),
    limitations: asStringList(data.limitations),
  });
}

function normalizeIndex(index) {
  return {
    summary: index.summary,
    keywords: nonEmptyList(index.keywords, ["未分類"]),
    concepts: nonEmptyList(index.concepts, ["未分類"]),
    technologies: nonEmptyList(index.technologies, ["該当なし"]),
    use_cases: nonEmptyList(index.use_cases, ["未分類"]),
    limitations: nonEmptyList(index.limitations, ["未確認"]),
  };
}

function nonEmptyList(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

function asStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function validateIndex(index) {
  if (!index.summary) throw new Error("AI index has empty summary.");
  for (const key of ["keywords", "concepts", "technologies", "use_cases", "limitations"]) {
    if (!Array.isArray(index[key]) || index[key].length === 0) {
      throw new Error(`AI index has empty ${key}.`);
    }
  }
}

function buildPageContext(page, frontmatter) {
  const lines = [];
  for (const key of ["title", "source", "raindrop_tags", "tags", "collectionTitle"]) {
    if (hasValue(frontmatter[key])) lines.push(`${key}: ${Array.isArray(frontmatter[key]) ? frontmatter[key].join(", ") : frontmatter[key]}`);
  }
  if (page.title) lines.push(`Title: ${page.title}`);
  if (page.description) lines.push(`Description: ${page.description}`);
  if (page.text) lines.push(page.text);
  return lines.join("\n\n");
}

function stripFrontmatter(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? text : text.slice(end + 5);
}

function readFrontmatterFromText(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return {};
  return parseSimpleYaml(text.slice(4, end));
}

function replaceBody(fullText, body) {
  if (!fullText.startsWith("---\n")) return body;
  const end = fullText.indexOf("\n---\n", 4);
  return end === -1 ? body : fullText.slice(0, end + 5) + body.replace(/^\n+/, "");
}

function extractSection(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return "";
  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s+/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join("\n").trim();
}

function ensureHeading(body, heading) {
  if (hasTopLevelHeading(body, heading)) return body;
  return `${heading}\n\n${body}`.trimEnd() + "\n";
}

function hasTopLevelHeading(body, heading) {
  return body.split(/\r?\n/).some((line) => line.trim().toLowerCase() === heading.toLowerCase());
}

function replaceSubsectionInUserNotes(body, subsectionHeading, content) {
  body = ensureHeading(body, "# User Notes");
  const lines = body.split(/\r?\n/);
  const userStart = lines.findIndex((line) => line.trim().toLowerCase() === "# user notes");
  let userEnd = lines.length;
  for (let i = userStart + 1; i < lines.length; i += 1) {
    if (/^#\s+/.test(lines[i])) {
      userEnd = i;
      break;
    }
  }
  const section = lines.slice(userStart, userEnd).join("\n");
  const replaced = replaceSectionByHeading(section, subsectionHeading, `${subsectionHeading}\n\n${content || "-"}`, 2);
  return lines.slice(0, userStart).concat(replaced.split(/\r?\n/), lines.slice(userEnd)).join("\n");
}

function ensureSubsectionInUserNotes(body, subsectionHeading, fallbackContent) {
  const userSection = extractTopLevelSection(body, "# User Notes");
  if (userSection.toLowerCase().includes(subsectionHeading.toLowerCase())) return body;
  return replaceSubsectionInUserNotes(body, subsectionHeading, fallbackContent);
}

function replaceTopLevelSection(body, heading, replacement) {
  return replaceSectionByHeading(body, heading, replacement, heading.startsWith("## ") ? 2 : 1);
}

function replaceDetailsSection(body, detailsMarkdown) {
  if (body.split(/\r?\n/).some((line) => line.trim().toLowerCase() === "## details")) {
    return replaceTopLevelSection(body, "## Details", detailsMarkdown);
  }
  const aiIndex = body.search(/^# AI Index\s*$/im);
  if (aiIndex === -1) return `${body.trimEnd()}\n\n---\n\n${detailsMarkdown}\n`;
  return `${body.slice(0, aiIndex).trimEnd()}\n\n---\n\n${detailsMarkdown}\n\n${body.slice(aiIndex).replace(/^\n+/, "")}`;
}

function removeTopLevelSection(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(0, start).concat(lines.slice(end)).join("\n").trimEnd() + "\n";
}

function replaceSectionByHeading(body, heading, replacement, level) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return `${body.trimEnd()}\n\n${replacement.trimEnd()}\n`;
  let end = lines.length;
  const boundary = level === 1 ? /^#\s+/ : /^#{1,2}\s+/;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (boundary.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(0, start).concat(replacement.trimEnd().split(/\r?\n/), lines.slice(end)).join("\n");
}

function extractTopLevelSection(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return "";
  const collected = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && /^#\s+/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

async function setAiReservedStatus(file, status, message) {
  await file.vault.process(file, (text) => updateFrontmatterText(text, (props) => {
    const safeMessage = compactMessage(message || status);
    props.ai_summary = status;
    props.ai_keywords = [safeMessage];
    props.ai_concepts = [status === AI_STATUS_PROCESSING ? "処理中" : "処理失敗"];
    props.ai_technologies = ["該当なし"];
    props.ai_use_cases = [status === AI_STATUS_PROCESSING ? "AI index生成待ち" : "次回AI実行でリトライ"];
    props.ai_limitations = [safeMessage];
  }));
}

async function setAiIndexResult(file, index, lastHttpStatus) {
  await file.vault.process(file, (text) => updateFrontmatterText(text, (props) => {
    if (props.ai_writeprotect === undefined) props.ai_writeprotect = false;
    props.ai_summary = index.summary;
    props.ai_keywords = index.keywords;
    props.ai_concepts = index.concepts;
    props.ai_technologies = index.technologies;
    props.ai_use_cases = index.use_cases;
    props.ai_limitations = index.limitations;
    props.last_http_status = lastHttpStatus;
    delete props.ai_needs_refresh;
    delete props.ai_refresh_reason;
  }));
}

function httpStatusFromError(error) {
  if (error && typeof error.status === "number") return error.status;
  if (error && typeof error.statusCode === "number") return error.statusCode;
  return 0;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function timeoutValue(value, fallback) {
  return positiveInt(value, fallback);
}

function newerIsoString(current, candidate) {
  const currentMs = Date.parse(current || "");
  const candidateMs = Date.parse(candidate || "");
  if (!Number.isFinite(candidateMs)) return current || "";
  if (!Number.isFinite(currentMs) || candidateMs > currentMs) return String(candidate || "");
  return current || "";
}

function isNewerLastUpdate(lastUpdate, sinceLastUpdate) {
  const sinceMs = Date.parse(sinceLastUpdate || "");
  if (!Number.isFinite(sinceMs)) return true;
  const lastUpdateMs = Date.parse(lastUpdate || "");
  if (!Number.isFinite(lastUpdateMs)) return true;
  return lastUpdateMs > sinceMs;
}

function aiHttpError(provider, response) {
  const detail = compactMessage(response && response.text).slice(0, 200);
  const error = new Error(`${provider} HTTP ${response.status}: ${detail}`);
  error.displayMessage = `${provider} HTTP ${response.status}: ${friendlyAiHttpMessage(provider, response)}`;
  error.status = response.status;
  return error;
}

function friendlyAiHttpMessage(provider, response) {
  const status = Number(response && response.status);
  const message = extractErrorMessage(response && response.text);
  const lowered = message.toLowerCase();
  if (status === 429 && /quota|billing|rate|limit/.test(lowered)) {
    if (provider === "Gemini") return "quota exceeded; check Google AI Studio billing/limits.";
    if (provider === "OpenAI") return "quota exceeded; check OpenAI Platform billing/limits.";
    return "quota or rate limit exceeded.";
  }
  if (status === 401 || status === 403) return "authentication or permission failed.";
  return compactMessage(message).slice(0, 200);
}

function extractErrorMessage(text) {
  const raw = String(text || "");
  try {
    const data = JSON.parse(raw);
    if (data && data.error && data.error.message) return String(data.error.message);
    if (data && data.message) return String(data.message);
  } catch (_) {
    return raw;
  }
  return raw;
}

function isRetryableAiError(error) {
  const status = Number(error && (error.status || error.statusCode));
  return status >= 500 && status < 600;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactMessage(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function messageOf(error) {
  return compactMessage(error && error.message ? error.message : error);
}

function displayMessageOf(error) {
  return compactMessage(error && error.displayMessage ? error.displayMessage : messageOf(error));
}
