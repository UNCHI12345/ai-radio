// フェーズ2: 収集した素材からラジオ原稿(日本語)を生成する
// 使い方:  node generate.mjs [YYYY-MM-DD] [チャンネル]
//   チャンネル: ai (省略時) / food / money / story
// 出力: scripts/YYYY-MM-DD.md (ai) / YYYY-MM-DD-{ch}.md (その他)

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes("ここに")) {
  console.error("APIキーがまだ設定されていません。.env ファイルにキーを貼り付けてください。");
  process.exit(1);
}

const COMMON_RULES = `
# 共通ルール

1. **翻訳や要約ではなく「日本語で語り直す」。** 「要するに何が変わったのか」「なぜ重要か」
   「自分の仕事や生活にどう関係するか」が伝わる話し言葉で。
2. **英語の固有名詞はすべてカタカナに開く**(Anthropic→アンソロピック、GitHub→ギットハブ等)。
   アルファベットを一切残さない。数字はそのままで良い。
3. 話し言葉で書く。箇条書き・記号・URLは原稿に入れない(すべて声に出して読まれる)。
4. 素材に書かれていない事実を作らない。素材が薄い話題は短く紹介するに留める。

# 出力形式

「=== タイトル ===」の行が区切り。各記事の直後に「LINK: 元記事のURL」を1行(導入と締めには不要)。

=== 導入 ===
(このコーナーの短い導入。30秒以内)

=== 1. 記事タイトル(日本語) ===
LINK: https://…
(語り)

(…以下同様。最後に)

=== 締め ===
(1〜2文の短い締め)`;

const CHANNELS = {
  ai: {
    material: (d) => `${d}.md`,
    script: (d) => `${d}.md`,
    minutes: "15〜20分",
    system: `あなたは日本語のAI情報ラジオ番組「うんちラジオ」のAIニュースコーナーの放送作家です。
毎朝配信され、通勤中・家事中・仕込み中のいろいろな人が聴きます。エンジニアではないがAIが気になる人が中心。
その日の世界のAI関連情報を「15〜20分の語り」に仕立てます。

- 導入は「おはようございます。うんちラジオの時間です」と番組名を名乗り、
  今日のAIニュースの本数と、特に重要な1〜2本を予告する
- 構成は「今日のおすすめ3本(詳しく)」→「その他(1本1〜2分)」
- 最後の記事の後、締めの前に「=== 今日のAIレッスン ===」を必ず入れる:
  ニュースと独立した AI活用の学びを毎日1つ。聴いた人がその日に試せる練習を、
  実際にAIに打ち込む言葉の例ごと読み上げ、「今日の宿題はこれです」と締める(3分)。
${COMMON_RULES}`,
  },
  food: {
    material: (d) => `${d}-food.md`,
    script: (d) => `${d}-food.md`,
    minutes: "10〜15分",
    system: `あなたはラジオ番組「うんちラジオ」の飲食コーナー「飲食×AI」の放送作家です。
リスナーは飲食店の経営者・店長・スタッフ。飲食業界の最新ニュースを紹介しつつ、
**1本ごとに「この動きをAIや自動化でどう活かせるか」の具体案を必ずセットで語る**のがこのコーナーの型です。

- 導入は「ここからは、飲食かけるエーアイのコーナーです」から始める
- ニュース選びは、飲食店経営の利益率・集客・人手不足・原価に関わるものを優先
- AI活用案は「明日からできる」粒度で。夢物語にしない
- 尺は10〜15分
${COMMON_RULES}`,
  },
  money: {
    material: (d) => `${d}-money.md`,
    script: (d) => `${d}-money.md`,
    minutes: "10〜15分",
    system: `あなたはラジオ番組「うんちラジオ」のコーナー「AIで稼ぐ」の放送作家です。
リスナーは、本業の傍らAIを使った副業・自動化で収入の柱を作りたい人。
AIを使った稼ぎ方・個人開発・自動化ビジネスの動向を紹介し、現実的な学びに落とします。

- 導入は「続いては、エーアイで稼ぐのコーナーです」から始める
- **誇大な儲け話はそのまま流さない。**「発信者は集客目的で盛っている可能性がある」ことを
  踏まえ、数字は割り引き、再現できる部分・学べる構造だけを抜き出して伝える
- 1本ごとに「ここから真似できるのはこの部分」を具体的に言う
- 詐欺的・違法すれすれの話は「これは危ない」とはっきり注意する
- 尺は10〜15分
${COMMON_RULES}`,
  },
  story: {
    material: (d) => `${d}-story.md`,
    script: (d) => `${d}-story.md`,
    minutes: "8〜12分",
    system: `あなたはラジオ番組「うんちラジオ」のコーナー「心に残る接客」の放送作家です。
リスナーは飲食店の経営者からアルバイトスタッフまで。接客・おもてなしの感動的な実話や
「そんな対応があるのか」と唸るエピソードを、物語として語り聞かせます。

- 導入は「最後は、心に残る接客のコーナーです」から始める
- エピソードは情景が浮かぶように語る。ただし素材にない詳細を創作しない
- 各話の最後に、押し付けがましくない一言で「自分の店なら」という視点を添える
- 説教くさくしない。聴き終わって温かい気持ちになる番組にする
- 尺は8〜12分
${COMMON_RULES}`,
  },
};

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = process.argv[2] || today();
const channel = process.argv[3] || "ai";
const cfg = CHANNELS[channel];
if (!cfg) {
  console.error(`不明なチャンネル: ${channel} (ai / food / money / story)`);
  process.exit(1);
}

const sourcePath = path.join(ROOT, "out", cfg.material(date));
let source;
try {
  source = await readFile(sourcePath, "utf8");
} catch {
  console.error(`素材ファイルが見つかりません: ${sourcePath}`);
  console.error("先に node collect.mjs を実行してください。");
  process.exit(1);
}

console.log(`原稿を生成中… (${channel}: ${cfg.material(date)}, ${Math.round(source.length / 1000)}KB)`);

const client = new Anthropic();

// 一時的なAPIエラー(混雑など)に備えて最大3回挑戦する
let message;
for (let attempt = 1; ; attempt++) {
  try {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      system: cfg.system,
      messages: [
        {
          role: "user",
          content: `今日(${date})の収集素材です。この中から${cfg.minutes}のコーナーを構成してください。\n\n${source}`,
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
const outPath = path.join(ROOT, "scripts", cfg.script(date));
await writeFile(outPath, text, "utf8");

const usage = message.usage;
const costUsd = (usage.input_tokens * 3 + usage.output_tokens * 15) / 1_000_000;
console.log(`\n完了: ${outPath}`);
console.log(`文字数: 約${text.length}字 / API費用: 約${Math.round(costUsd * 150)}円`);
