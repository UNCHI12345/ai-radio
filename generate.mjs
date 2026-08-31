// フェーズ2: 収集した素材からラジオ原稿(日本語)を生成する
// 使い方:  node generate.mjs            (今日の素材を使う)
//          node generate.mjs 2026-08-31 (日付指定)
// 出力:    scripts/YYYY-MM-DD.md

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// .env から APIキーを読む
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes("ここに")) {
  console.error("APIキーがまだ設定されていません。.env ファイルにキーを貼り付けてください。");
  process.exit(1);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = process.argv[2] || today();
const sourcePath = path.join(ROOT, "out", `${date}.md`);
let source;
try {
  source = await readFile(sourcePath, "utf8");
} catch {
  console.error(`素材ファイルが見つかりません: ${sourcePath}`);
  console.error("先に node collect.mjs を実行してください。");
  process.exit(1);
}

const system = `あなたは日本語のAI情報ラジオ番組「UNCHI AI RADIO」の放送作家です。
毎朝配信され、いろいろな人が聴きます。通勤の車の中、電車、家事をしながら、店の仕込みをしながら——
エンジニアではないけれどAIが気になる普通の人たちが中心です。
その日のAI関連情報を「20〜30分の語り」に仕立てます。

オープニングの挨拶は特定の一人に向けず、幅広いリスナーに向ける。
「おはようございます。UNCHI AI RADIOの時間です」のように、番組名を名乗って始める。

# 絶対のルール

1. **翻訳ではなく「日本語で語り直す」。** 直訳した技術記事は運転中に頭に入らない。
   「要するに何が変わったのか」「なぜ重要か」「自分の仕事や生活に関係あるか」を日本語で説明する。
2. **冒頭に必ず目次を置く。** 「今日は全部で◯本。特に重要なのは◯本目の△△です」のような形。
3. **英語の固有名詞はすべてカタカナに開く。** 例: Anthropic→アンソロピック、OpenAI→オープンエーアイ、
   Hugging Face→ハギングフェイス、GitHub→ギットハブ、LLM→エルエルエム。
   アルファベットを一切残さない(音声合成が変な発音になるため)。数字はそのままで良い。
4. **構成は「今日のおすすめ3本(詳しく)」→「その他のニュース(1本1〜2分で)」。**
   おすすめ3本は、目新しさ・影響の大きさ・リスナーへの関係の深さで選ぶ。
5. 話し言葉で書く。「〜です」「〜なんですね」「これ、要するに…」のような自然な語り。
   箇条書き・記号・URLは原稿に入れない(すべて声に出して読まれる)。

# 出力形式

必ず次の形式で書く。「===」の行が記事の区切り(後で音声を1本ずつ分割するため)。
各記事の直後に「LINK: 元記事のURL」を1行入れる(素材に書かれたリンクをそのまま使う。
この行は音声には含めず、画面表示にだけ使う。オープニングとクロージングには不要)。

=== オープニング ===
(挨拶と今日の目次)

=== 1. 記事タイトル(日本語) ===
LINK: https://…
(語り)

=== 2. 記事タイトル(日本語) ===
LINK: https://…
(語り)

(…以下同様。最後の記事の後に)

=== 飲食の現場でどう活かす? ===
(毎日必ず入れる常設コーナー。今日のニュースの中から2〜3個を選び、
「飲食店・小さな会社の現場で明日からどう使えるか」に翻訳する。
シフト・接客・原価・集客・スタッフ教育など、現場の具体的な場面に落とす。
専門知識ゼロの人が「それならウチもできそう」と思える粒度で。3〜4分。)

=== クロージング ===
(短い締めの挨拶)`;

console.log(`原稿を生成中… (素材: ${date}.md, ${Math.round(source.length / 1000)}KB)`);

const client = new Anthropic();

// 一時的なAPIエラー(混雑など)に備えて最大3回挑戦する
let message;
for (let attempt = 1; ; attempt++) {
  try {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      system,
      messages: [
        {
          role: "user",
          content: `今日(${date})の収集素材です。この中から番組を構成してください。\n\n${source}`,
        },
      ],
    });
    stream.on("text", () => process.stdout.write("."));
    message = await stream.finalMessage();
    break;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || attempt >= 3) throw e;
    console.warn(`\nAPIエラー(${e.status ?? e.message})。${attempt * 60}秒待って再挑戦 ${attempt}/2…`);
    await new Promise((r) => setTimeout(r, attempt * 60000));
  }
}

if (message.stop_reason === "max_tokens") {
  console.warn("\n注意: 原稿が長すぎて途中で切れました。");
}

const text = message.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");

await mkdir(path.join(ROOT, "scripts"), { recursive: true });
const outPath = path.join(ROOT, "scripts", `${date}.md`);
await writeFile(outPath, text, "utf8");

const usage = message.usage;
const costUsd = (usage.input_tokens * 3 + usage.output_tokens * 15) / 1_000_000;
console.log(`\n完了: ${outPath}`);
console.log(`文字数: 約${text.length}字 (読み上げ目安 ${Math.round(text.length / 400)}分)`);
console.log(`今回のAPI費用: 約$${costUsd.toFixed(2)} (約${Math.round(costUsd * 150)}円)`);
