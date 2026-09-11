// 実験: 掛け合い(2人)形式のサンプル音声を1本作る
// 使い方: node sample-dialogue.mjs <元になる原稿ファイル>

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}
const KEY = (process.env.GOOGLE_TTS_API_KEY || "").trim().replace(/^GOOGLE_TTS_API_KEY\s*=\s*/, "");

const src = await readFile(process.argv[2] || path.join(ROOT, "scripts", "2026-09-11-food.md"), "utf8");
const firstStory = src.split(/^=== /m).slice(1, 3).join("\n=== ").slice(0, 6000);

const client = new Anthropic();
const stream = client.messages.stream({
  model: "claude-sonnet-4-6",
  max_tokens: 8000,
  thinking: { type: "adaptive" },
  system: `あなたはラジオ番組「うんちラジオ」の放送作家です。渡された一人語りの原稿を、
2人のパーソナリティの掛け合いに書き直します。2〜3分の尺で。

- コウタ(男性): メイン進行。落ち着いていて分かりやすい
- アオイ(女性): 相方。聞き手代表として素朴な疑問・相づち・感想を挟む。時々鋭い

ルール:
- 1行1セリフ。行頭に必ず「コウタ:」か「アオイ:」を付ける
- 相づちや質問で情報を刻む。一人が長く話しすぎない(1セリフ3文まで)
- 内容は元原稿の事実だけ。創作しない
- カタカナ固有名詞・話し言葉などの規則は元原稿に従う
- 冒頭はコウタの「うんちラジオ、続いては飲食かけるエーアイのコーナーです。アオイさん、今日はどんな話?」風に自然に`,
  messages: [{ role: "user", content: `この原稿を掛け合いにしてください:\n\n${firstStory}` }],
});
const message = await stream.finalMessage();
const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

const VOICES = { コウタ: "ja-JP-Chirp3-HD-Charon", アオイ: "ja-JP-Chirp3-HD-Kore" };
const lines = text
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^(コウタ|アオイ)[:：]/.test(l))
  .map((l) => {
    const m = l.match(/^(コウタ|アオイ)[:：]\s*(.+)$/);
    return { speaker: m[1], text: m[2] };
  });
console.log(`セリフ数: ${lines.length}`);

const buffers = [];
for (const line of lines) {
  const clean = line.text.replace(/[「」『』]/g, "").replace(/https?:\/\/\S+/g, " ");
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: clean },
      voice: { languageCode: "ja-JP", name: VOICES[line.speaker] },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.05 },
    }),
  });
  const data = await res.json();
  if (!data.audioContent) throw new Error(JSON.stringify(data).slice(0, 200));
  buffers.push(Buffer.from(data.audioContent, "base64"));
  process.stdout.write(line.speaker === "コウタ" ? "K" : "A");
}
await writeFile(path.join(ROOT, "sample-dialogue.mp3"), Buffer.concat(buffers));
console.log("\n完了: sample-dialogue.mp3");
