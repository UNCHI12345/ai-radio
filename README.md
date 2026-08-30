# UNCHI AI RADIO

毎朝、世界のAI情報を自動で集めて、日本語の音声ラジオにするシステム。

## 仕組み

```
collect.mjs   世界のAI情報を収集(信頼レーン8名のブログ + HN/Reddit/GitHub) → out/日付.md
generate.mjs  Claude APIで20分弱のラジオ原稿に語り直し → scripts/日付.md
tts.mjs       ニューラル音声で記事ごとのMP3化 → site/audio/日付/
rss.mjs       ポッドキャストRSS生成(公開URL設定後) → site/podcast.xml
run-daily.mjs 上記を順に全部実行(毎朝5時に自動実行される)
site/         再生画面(PWA)。スマホのホーム画面に追加して使う
```

## 毎朝の自動実行

- Mac上: `~/Library/LaunchAgents/com.unchi.ai-radio.plist` が毎朝5:00に `run-daily.mjs` を実行
- ログ: `logs/日付.log`
- 止めたい時: `launchctl bootout gui/$(id -u)/com.unchi.ai-radio`

## 手動実行

```
node run-daily.mjs        # 全部
node collect.mjs          # 収集だけ
node generate.mjs         # 原稿だけ(要 .env のANTHROPIC_API_KEY)
node tts.mjs              # 音声だけ
```

## 声の変更

`tts.mjs` は環境変数で声と速度を変えられる:

```
RADIO_VOICE=ja-JP-KeitaNeural node tts.mjs   # 男性の声
RADIO_RATE=+0% node tts.mjs                  # 標準速度(既定は+8%)
```

## 必要なもの

- `.env` に `ANTHROPIC_API_KEY=...`(原稿生成用。Claude Console で発行)
- `.venv-tts/` に edge-tts(セットアップ済み。作り直す時: `python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts pillow`)

## 今後(クラウド化)

GitHubに載せたら `.github/workflows/daily.yml` が毎朝5時(日本時間)にクラウド上で全部を実行し、
GitHub Pagesに自動公開する。必要な設定:

1. GitHubリポジトリ作成 & このフォルダをpush
2. リポジトリのSettings → Secrets → `ANTHROPIC_API_KEY` を登録
3. Settings → Pages → Source を「GitHub Actions」に
4. `config.json` の `publicBaseUrl` に公開URLを設定(ポッドキャストRSS用)
