# RefRaindrop Design

[English](ref-raindrop.md)

## 方針

bookmark import は AI向けノウハウDBの構築として扱う。

Raindrop.io は人間がブックマークを追加・閲覧するUI。Obsidianは AI index、ユーザーメモ、同期メタデータを保持する knowledge base。

同期はプラグインが管理するfrontmatterと本文セクションだけを対象にし、ローカルメモやAI項目を上書きしない。

## Plugin責務

- Raindrop APIから全bookmarkを同期する
- 複数アカウントを扱う
- アカウントごとに保存フォルダを分ける
- ファイル名は `{raindrop_id}.md`
- 日付フォルダは掘らない
- 既存ファイルは作り直さず部分更新する
- `## Local Notes` は同期では保持する
- Raindrop由来情報が変わった時だけ `last_http_status` を削除する
- AI要約/index生成も同じpluginで行う
- AI実行先は Ollama / OpenAI / Gemini から選べる
- sync実行時に設定画面の ignored hosts を毎回読み直す
- 起動時同期を設定で有効化できる
- AI要約/indexの出力言語を設定で選べる

## 同期で更新する範囲

frontmatter:

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

body:

- `## Raindrop Note`
- `# Raindrop`
- `## Details`

同期で保持する範囲:

- `## Local Notes`
- `ai_summary`
- `ai_keywords`
- `ai_concepts`
- `ai_technologies`
- `ai_use_cases`
- `ai_limitations`
- `ai_writeprotect`

## AI処理

`last_http_status` が空の場合だけ処理する。Raindrop側の情報更新で同期差分が出た場合、`last_http_status` を削除してAI再処理対象に戻す。

AI provider:

- `ollama`: ローカルOllama `/api/generate`
- `openai`: OpenAI Responses API `/v1/responses`
- `gemini`: Gemini API `models/{model}:generateContent`

APIキーはObsidian plugin設定に保存し、bookmark noteには保存しない。

Geminiの既定モデルは `gemini-2.5-flash`。

AI処理状態は本文ではなくfrontmatterの予約値で扱う。

```yaml
ai_summary: __AI_PROCESSING__
ai_summary: __AI_FAILED__
```

予約値がある場合は `last_http_status` が存在しても次回AI実行でリトライ対象にする。

設定画面の `Ignored hosts` に一致するhostは取得しない。
