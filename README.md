# RefRaindrop

[日本語版](README.ja.md)

RefRaindrop is an Obsidian plugin that syncs Raindrop.io bookmarks into your vault and adds AI-oriented bookmark indexes.

It is designed for using bookmarks as a lightweight knowledge base for later AI-assisted thinking. It does not store full page content in your vault. Instead, each note keeps the URL, Raindrop metadata, your local notes, and compact AI index fields.

The name "RefRaindrop" is a wordplay on "reference", "refrain", and "Raindrop". This project is an independent community plugin and is not affiliated with or endorsed by Obsidian or Raindrop.io.

## Disclaimer

RefRaindrop is provided as-is under the MIT License. You are responsible for configuring and monitoring any third-party services used with it, including Raindrop.io, OpenAI, Gemini, Ollama, and network access to bookmarked websites.

AI providers and SaaS APIs may incur charges, fail with quota/rate-limit errors, or change their behavior. RefRaindrop includes throttling, ignored-host rules, private-network blocking, and retry handling, but it cannot guarantee cost limits, availability, accuracy, or that every bookmarked website is safe or appropriate to fetch. Review the settings before running large imports or AI indexing.

## Features

- Sync all bookmarks from the Raindrop API
- Support multiple Raindrop accounts
- Store each account in a separate vault folder
- Always use `{raindrop_id}.md` as the filename
- Store files directly under the configured folder, without date-based subfolders
- Update existing notes by `raindrop_id` or URL instead of recreating files
- Preserve AI fields and `## Local Notes`
- Clear `last_http_status` only when Raindrop metadata changes
- Track AI processing and failure state with reserved `ai_summary` values
- Configure Raindrop tokens, folders, AI provider, language, and ignore rules from Obsidian settings
- Configure ignored hosts directly in the Obsidian settings UI
- Provide commands for sync only, AI indexing only, and sync-then-index

## Note Format

RefRaindrop uses a readable Markdown structure and updates only the sections and frontmatter fields it owns.

```yaml
---
title: Example
source: https://example.com/article
type: article
created: 2026-06-27T01:02:03.000Z
lastupdate: 2026-06-27T04:05:06.000Z
id: 123
raindrop_id: 123
raindrop_account: home
tags:
  - ai
raindrop_tags:
  - ai
ai_summary:
ai_keywords:
ai_concepts:
ai_technologies:
ai_use_cases:
ai_limitations:
ai_writeprotect: false
last_http_status:
---
```

Reserved AI status values:

```yaml
ai_summary: __AI_PROCESSING__
ai_summary: __AI_FAILED__
```

Notes with either reserved value are retried on the next AI indexing run. AI output is stored only in `ai_xxx` frontmatter fields and is not written to the note body.

Body structure:

```markdown
# Title

# User Notes

## Raindrop Note

Raindrop note. Updated by sync.

## Local Notes

Your own notes. Preserved by sync.

# Raindrop

## Description

Raindrop excerpt. Updated by sync.

---

## Details

- **Type**: article
- **Domain**: example.com
- **Created**: ...
- **Updated**: ...
- **Tags**: #ai
- **Source**: [Open](https://example.com/article)
```

## Installation

Plugin files live under:

```text
plugin/ref-raindrop/
```

Manual install:

```bash
mkdir -p /path/to/YourVault/.obsidian/plugins/ref-raindrop
cp plugin/ref-raindrop/manifest.json /path/to/YourVault/.obsidian/plugins/ref-raindrop/
cp plugin/ref-raindrop/main.js /path/to/YourVault/.obsidian/plugins/ref-raindrop/
cp plugin/ref-raindrop/styles.css /path/to/YourVault/.obsidian/plugins/ref-raindrop/
cp plugin/ref-raindrop/versions.json /path/to/YourVault/.obsidian/plugins/ref-raindrop/
```

Then open Obsidian and enable `RefRaindrop` from `Settings` -> `Community plugins`.

## Settings

Open `Settings` -> `RefRaindrop`.

Raindrop account settings:

- `Enabled`: include this account in sync
- `Account name`: written to `raindrop_account`, for example `home` or `work`
- `Raindrop test token`: Raindrop.io test token
- `Destination folder`: for example `Bookmarks/Raindrop/home`

Multiple account example:

```text
home -> Bookmarks/Raindrop/home
work -> Bookmarks/Raindrop/work
```

AI settings:

- `AI provider`: `Ollama`, `OpenAI`, or `Gemini`
- `AI model`: model for the selected provider. If model listing is not allowed, only the current/default model is shown
- `Ollama URL`: default `http://localhost:11434`
- `OpenAI base URL`: default `https://api.openai.com/v1`
- `OpenAI API key`: stored only in Obsidian plugin settings
- `Gemini API key`: stored only in Obsidian plugin settings
- `Output language`: language for AI summaries and index fields. Default is `Japanese`
- `Ignored hosts`: hosts that must never be fetched or summarized
- `Block private networks`: enabled by default
- `Sync on startup`: run one sync after Obsidian starts
- `Index after startup sync`: also run AI indexing after startup sync
- `Page request timeout seconds`: default `20`
- `Ollama timeout seconds`: default `120`; also used for OpenAI/Gemini generation
- `Raindrop timeout seconds`: default `30`
- `Max AI indexes per run`: default `25`; use `0` for unlimited
- `Delay between AI indexes milliseconds`: default `1000`; use `0` for no delay

API keys are stored in Obsidian plugin settings. They are not written to bookmark notes.

OpenAI uses the Responses API (`/v1/responses`). Gemini uses `models/{model}:generateContent`. The default Gemini model is `gemini-2.5-flash`.

For a restricted OpenAI API key, the required permission is `Responses (/v1/responses): Write`. If `List models` is not allowed, the model dropdown falls back to `gpt-5-nano`.

## Tokens And API Keys

Raindrop:

1. Open <https://app.raindrop.io/settings/integrations>.
2. Create or open an app/integration.
3. Generate a test token.
4. Paste it into `Raindrop test token`.

The plugin uses the token to read your Raindrop bookmarks. It does not write back to Raindrop.

Raindrop sync uses the API maximum page size of 50 items per request. After the first full sync, RefRaindrop stops fetching when Raindrop's `lastUpdate` reaches the newest `raindrop_last_update` already stored in the vault. A vault folder deletion or empty destination folder causes the next sync to fetch all bookmarks again.

OpenAI:

1. Open <https://platform.openai.com/api-keys>.
2. Create a project API key.
3. For a Restricted key, grant `Responses (/v1/responses): Write`.
4. `List models` is optional. Without it, the model dropdown shows only the current/default model.
5. Set billing or credits in the OpenAI Platform if API requests return quota errors.

Gemini:

1. Open <https://aistudio.google.com/apikey>.
2. Create an API key.
3. Paste it into `Gemini API key`.
4. Enable billing or quota as needed if Gemini returns 429 quota errors.

Keep all tokens and API keys out of Git. They belong only in Obsidian plugin settings.

## Commands

Run commands from the Command Palette:

- `RefRaindrop: Sync Raindrop bookmarks`
- `RefRaindrop: Sync Raindrop bookmarks, then index`
- `RefRaindrop: Index current bookmark`
- `RefRaindrop: Force index current bookmark`
- `RefRaindrop: Index all synced bookmarks`
- `RefRaindrop: Force index all synced bookmarks`
- `RefRaindrop: Reload ignored hosts`

Start with `Sync Raindrop bookmarks` and verify the generated Markdown before running AI indexing.

Initial AI indexing is intentionally throttled. By default, RefRaindrop indexes at most 25 bookmarks per run and waits 1000 ms between page fetches. This avoids hitting many bookmarked websites in a burst during the first import.

Raindrop API rate limits are retried automatically for HTTP 429 and temporary 5xx responses. If Raindrop sends `Retry-After`, RefRaindrop waits for it, capped at 120 seconds.

## Ignored Hosts

Hosts that must never be fetched for AI indexing can be listed in `Settings` → `Community plugins` → `RefRaindrop` → `Ignored hosts`.

Example:

```text
intranet.local
corp.example.com
*.internal.example.com
https://private.example.com/path
```

Matching rules:

- `corp.example.com` matches both `corp.example.com` and its subdomains
- `*.internal.example.com` matches subdomains only
- If a URL is written, only its hostname is used

The plugin also blocks `localhost`, `.local`, private IPv4 ranges, and link-local IPv4 ranges by default.

## Development

Release files:

```text
manifest.json
versions.json
plugin/ref-raindrop/manifest.json
plugin/ref-raindrop/main.js
plugin/ref-raindrop/styles.css
plugin/ref-raindrop/versions.json
```

Run release checks:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```

These checks validate plugin metadata, release files, delimiter balance in `main.js`, and accidental legacy naming. They do not replace manual testing inside Obsidian.

GitHub Actions runs the same release checks.

Release a new version:

1. Update `version` in `manifest.json` and `plugin/ref-raindrop/manifest.json`.
2. Add the same version to `versions.json` and `plugin/ref-raindrop/versions.json`.
3. Commit the change.
4. Tag the commit, for example `git tag 0.1.0`.
5. Push the tag, for example `git push origin 0.1.0`.

The release workflow also accepts `v0.1.0` style tags, but Obsidian's sample plugin recommends using the exact manifest version without a `v` prefix.

The release workflow creates a GitHub Release and attaches:

- `main.js`
- `manifest.json`
- `styles.css`

For Obsidian community plugin submission, keep these files available in the repository root:

- `README.md`
- `LICENSE`
- `manifest.json`
- `versions.json`

## License

MIT License. See [LICENSE](LICENSE).
