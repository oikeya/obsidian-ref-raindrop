# RefRaindrop

[English](README.md)

Raindrop.io のブックマークを Obsidian に同期し、AI向けノウハウDBとして使うための Obsidian plugin です。

`RefRaindrop` は reference / refrain / Raindrop をかけた名前です。このプロジェクトは独立したcommunity pluginであり、ObsidianおよびRaindrop.ioの公式・公認プロジェクトではありません。

このプラグインは以下を固定動作として行います。

- Raindrop APIから全bookmarkを同期
- 複数Raindropアカウントに対応
- アカウントごとに格納フォルダを分離
- ファイル名は常に `{raindrop_id}.md`
- フォルダは日付で掘らず、指定フォルダ直下に保存
- 既存ノートは `raindrop_id` / URL で探して、そのファイルを部分更新
- AIプロパティと `## Local Notes` は保持
- Raindrop側の title/note/tags/excerpt 等が変わった時だけ `last_http_status` を削除
- AI処理中/失敗は本文ではなく `ai_summary` の予約値で管理
- Obsidian設定画面から token / folder / AI provider / ignored hosts を設定
- sync実行時に ignored hosts 設定を毎回読み直す
- 同期だけ、AI indexだけ、同期後AI index の各コマンドを提供

## Markdown形式

読みやすい Markdown 形式にしつつ、更新時はプラグインが管理するfrontmatterと本文セクションだけを部分更新します。

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

AI処理状態の予約値:

```yaml
ai_summary: __AI_PROCESSING__
ai_summary: __AI_FAILED__
```

予約値がある場合は、次回のAI実行時にリトライ対象になります。AI情報はfrontmatterの `ai_xxx` だけに保存し、本文には書きません。

本文:

```markdown
# Title

# User Notes

## Raindrop Note

Raindrop側のメモ。同期で更新される。

## Local Notes

Obsidian側の人間メモ。同期では消さない。

# Raindrop

## Description

Raindrop excerpt。同期で更新される。

---

## Details

- **Type**: article
- **Domain**: example.com
- **Created**: ...
- **Updated**: ...
- **Tags**: #ai
- **Source**: [Open](https://example.com/article)

```

## Obsidian Plugin

プラグイン本体:

```text
plugin/ref-raindrop/
```

### インストール

```bash
mkdir -p /path/to/YourVault/.obsidian/plugins/ref-raindrop
cp plugin/ref-raindrop/manifest.json /path/to/YourVault/.obsidian/plugins/ref-raindrop/
cp plugin/ref-raindrop/main.js /path/to/YourVault/.obsidian/plugins/ref-raindrop/
cp plugin/ref-raindrop/styles.css /path/to/YourVault/.obsidian/plugins/ref-raindrop/
cp plugin/ref-raindrop/versions.json /path/to/YourVault/.obsidian/plugins/ref-raindrop/
```

Obsidian を開き、`Settings` → `Community plugins` で `RefRaindrop` を enable します。

### 設定

Obsidian `Settings` → `RefRaindrop` で設定します。

Raindrop account:

- `Enabled`: 同期対象にする
- `Account name`: `home`, `work` など。frontmatter の `raindrop_account` に入る
- `Raindrop test token`: Raindrop.io の test token
- `Destination folder`: 例 `Bookmarks/Raindrop/home`

複数アカウント例:

```text
home → Bookmarks/Raindrop/home
work → Bookmarks/Raindrop/work
```

AI設定:

- `AI provider`: `Ollama`, `OpenAI`, `Gemini` から選択
- `AI model`: 選択中providerのモデル。モデル一覧取得に失敗した場合は現在値または既定値のみ表示
- `Ollama URL`: 既定 `http://localhost:11434`
- `OpenAI base URL`: 既定 `https://api.openai.com/v1`
- `OpenAI API key`: OpenAI APIキー。Obsidian plugin設定にのみ保存
- `Gemini API key`: Gemini APIキー。Obsidian plugin設定にのみ保存
- `Output language`: AI要約/indexの出力言語。既定 `Japanese`
- `Ignored hosts`: AI要約時に絶対アクセスしないhost一覧
- `Block private networks`: 既定ON
- `Sync on startup`: Obsidian起動後に1回同期する
- `Index after startup sync`: 起動時同期後にAI indexも実行する
- `Page request timeout seconds`: 既定 `20`
- `Ollama timeout seconds`: 既定 `120`。OpenAI/Gemini のAI生成タイムアウトにも使う
- `Raindrop timeout seconds`: 既定 `30`
- `Max AI indexes per run`: 既定 `25`。`0` で無制限
- `Delay between AI indexes milliseconds`: 既定 `1000`。`0` で待ちなし

APIキーはObsidianのプラグイン設定データに保存されます。同期ノートのfrontmatterや本文には書き込みません。Git管理対象にも入れないでください。

OpenAIは Responses API (`/v1/responses`) を使います。OpenAI互換エンドポイントを使う場合は `OpenAI base URL` を変更します。Geminiは Gemini API の `models/{model}:generateContent` を使います。Geminiの既定モデルは `gemini-2.5-flash` です。

OpenAI API keyをRestrictedにする場合、必須権限は `Responses (/v1/responses): Write` です。`List models` 権限が無い場合、モデルpulldownは既定の `gpt-5-nano` だけを表示します。

## Token / APIキー取得

Raindrop:

1. <https://app.raindrop.io/settings/integrations> を開く
2. app / integration を作成または開く
3. test token を生成する
4. `Raindrop test token` に貼る

このプラグインはRaindropのbookmark読み取りにtokenを使います。Raindrop側への書き戻しは行いません。

OpenAI:

1. <https://platform.openai.com/api-keys> を開く
2. project API key を作成する
3. Restricted key の場合は `Responses (/v1/responses): Write` を許可する
4. `List models` は任意。権限がない場合、モデルpulldownは現在値または既定値のみ表示する
5. quota error が出る場合は OpenAI Platform の billing / credits を設定する

Gemini:

1. <https://aistudio.google.com/apikey> を開く
2. API key を作成する
3. `Gemini API key` に貼る
4. Geminiが429 quota errorを返す場合は billing / quota を確認する

token/APIキーはGitに入れず、Obsidian plugin設定にだけ保存してください。

## 実行

Command Palette から実行します。

- `RefRaindrop: Sync Raindrop bookmarks`
- `RefRaindrop: Sync Raindrop bookmarks, then index`
- `RefRaindrop: Index current bookmark`
- `RefRaindrop: Force index current bookmark`
- `RefRaindrop: Index all synced bookmarks`
- `RefRaindrop: Force index all synced bookmarks`
- `RefRaindrop: Reload ignored hosts`

まずは `Sync Raindrop bookmarks` だけ実行し、Markdownの作成と更新が期待通りか確認してください。AI indexはその後です。

初回AI indexは意図的に抑制しています。既定では1回あたり最大25件、各ページ取得の間に1000ms待ちます。初回取り込み時に多数のブックマーク先へ一気にアクセスしないための設定です。

## アクセス禁止 host

AI要約時に絶対アクセスしたくない host は `設定` → `コミュニティプラグイン` → `RefRaindrop` → `Ignored hosts` に1行1件で書きます。

例:

```text
intranet.local
corp.example.com
*.internal.example.com
https://private.example.com/path
```

一致ルール:

- `corp.example.com` は `corp.example.com` と `*.corp.example.com` に一致
- `*.internal.example.com` はサブドメインだけに一致
- URLを書いた場合は hostname だけ使う

pluginはさらに既定で `localhost`, `.local`, private IPv4, link-local IPv4 をブロックします。

## 開発と検証

このリポジトリは Obsidian plugin として管理します。リリース対象と申請用metadataは次のファイルです。

```text
manifest.json
versions.json
plugin/ref-raindrop/manifest.json
plugin/ref-raindrop/main.js
plugin/ref-raindrop/styles.css
plugin/ref-raindrop/versions.json
```

リリース前チェック:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```

このチェックは plugin manifest、リリース対象ファイル、`main.js` の括弧バランス、旧名称の混入を確認するものです。Obsidian上での手動動作確認を置き換えるものではありません。

GitHub Actions でも同じリリース前チェックを実行します。

新しいバージョンのリリース手順:

1. `manifest.json` と `plugin/ref-raindrop/manifest.json` の `version` を更新する
2. `versions.json` と `plugin/ref-raindrop/versions.json` に同じversionを追加する
3. commitする
4. 例: `git tag 0.1.0` でタグを打つ
5. 例: `git push origin 0.1.0` でタグをpushする

release workflow は `v0.1.0` 形式のタグも受け付けますが、Obsidian sample pluginではmanifestのversionと同じ `v` なしのタグが推奨されています。

release workflow が GitHub Release を作成し、次のファイルを添付します。

- `main.js`
- `manifest.json`
- `styles.css`

Obsidian community plugin申請向けに、リポジトリrootには次のファイルを置きます。

- `README.md`
- `LICENSE`
- `manifest.json`
- `versions.json`

## License

MIT License. See [LICENSE](LICENSE).
