# RefRaindrop Design

[日本語版](ref-raindrop.ja.md)

## Goal

Bookmark import is treated as building an AI-oriented knowledge base.

Raindrop.io is the UI for humans to add and browse bookmarks. Obsidian stores AI index fields, local notes, and sync metadata.

The plugin owns a narrow set of frontmatter fields and body sections so sync can be repeatable without overwriting local notes or AI fields.

## Plugin Responsibilities

- Sync all bookmarks from the Raindrop API
- Support multiple Raindrop accounts
- Store each account in a separate folder
- Use `{raindrop_id}.md` as the filename
- Do not create date-based folders
- Partially update existing files instead of recreating them
- Preserve `## Local Notes`
- Clear `last_http_status` only when Raindrop-derived data changes
- Generate AI summaries/index fields inside the same plugin
- Support Ollama, OpenAI, and Gemini as AI providers
- Read ignored hosts from plugin settings on every sync
- Optionally sync on Obsidian startup
- Allow the AI output language to be selected from settings

## Sync-Owned Fields

Frontmatter fields updated by sync:

- `title`
- `source`
- `type`
- `created`
- `lastupdate`
- `id`
- `raindrop_id`
- `raindrop_account`
- `collectionId`
- `collectionTitle`
- `tags`
- `raindrop_tags`
- `raindrop_important`
- `raindrop_created`
- `raindrop_last_update`
- `raindrop_cover`
- `banner`
- `raindrop_synced_at`

Body sections updated by sync:

- `## Raindrop Note`
- `# Raindrop`
- `## Details`

Preserved fields/sections:

- `## Local Notes`
- `ai_summary`
- `ai_keywords`
- `ai_concepts`
- `ai_technologies`
- `ai_use_cases`
- `ai_limitations`
- `ai_writeprotect`

## AI Processing

AI indexing runs only when `last_http_status` is empty, unless `ai_summary` contains a reserved retry status. When Raindrop metadata changes, sync clears `last_http_status` so the note becomes eligible for AI indexing again.

AI providers:

- `ollama`: local Ollama `/api/generate`
- `openai`: OpenAI Responses API `/v1/responses`
- `gemini`: Gemini API `models/{model}:generateContent`

API keys are stored in Obsidian plugin settings and are never written to bookmark notes.

The default Gemini model is `gemini-2.5-flash`.

AI processing state is stored in frontmatter:

```yaml
ai_summary: __AI_PROCESSING__
ai_summary: __AI_FAILED__
```

Notes with either reserved value are retried on the next AI indexing run even if `last_http_status` exists.

Hosts matching `Ignored hosts` in the plugin settings are never fetched.
