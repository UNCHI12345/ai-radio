// 読むうんちラジオ: 毎日1本の「現場の悩み×AI」ロング記事を生成する
// 使い方: node article.mjs [YYYY-MM-DD]
// 出力: site/articles/YYYY-MM-DD.html / site/articles/index.html / out/YYYY-MM-DD-sns.txt

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const date = process.argv[2] || today();

// 素材: 飲食+稼ぐ+AIの当日素材(あるものだけ)
let source = "";
for (const f of [`${date}-food.md`, `${date}-money.md`, `${date}.md`]) {
  try {
    source += `\n\n${await readFile(path.join(ROOT, "out", f), "utf8")}`;
  } catch {}
}
if (!source.trim()) {
  console.error("素材がありません。先に collect.mjs を実行してください。");
  process.exit(1);
}
source = source.slice(0, 250000);

// 過去記事のタイトル一覧(テーマの重複を避ける)
const articlesDir = path.join(ROOT, "site", "articles");
await mkdir(articlesDir, { recursive: true });
let pastIndex = [];
try {
  pastIndex = JSON.parse(await readFile(path.join(articlesDir, "index.json"), "utf8"));
} catch {}
const pastTitles = pastIndex.map((a) => a.title).join("\n");

const system = `あなたはメディア「うんちラジオ」の記事コーナー「読むうんちラジオ」の編集長兼ライターです。
読者は飲食店や小さな会社の経営者・店長・スタッフ、そしてAIで副収入を作りたい個人。
毎日1本、「現場のリアルな悩み × AIでの解決」を主題にした読み応えのある記事(5,000〜7,000字)を書きます。

# 記事の作り方
- **現場の悩みを1つ選ぶ**(例: シフト作成、接客教育、原価管理、集客、採用、クレーム対応、仕込み効率、
  メニュー開発、SNS運用、多言語対応…)。今日の素材のニュースと絡められる悩みを優先する
- 過去記事とテーマを重複させない。過去のタイトル: ${pastTitles || "(まだ無い)"}
- 構成: 悩みの解像度を上げる導入 → なぜ今AIで解決できるのか(今日のニュースを引用) →
  具体的な手順(実際にAIに打ち込む文例をそのまま載せる) → 費用感 → 落とし穴と注意 → まとめ
- 数字や事実は素材にあるものだけ使う。創作しない。誇大な儲け話は割り引いて伝える
- 語り口は丁寧だが硬すぎない。「です・ます」調

# 出力形式(この構造を厳守)
1行目: TITLE: 記事タイトル(30字以内、悩みが自分ごとになる表現)
2行目: SNS: X投稿用の予告文(140字以内。記事の一番おいしい知見を1つ見せて続きを読みたくさせる。絵文字は控えめ)
3行目以降: 記事本文をMarkdownで(## 見出し、**強調**、箇条書き、> 引用が使える)`;

console.log(`記事を生成中… (素材 ${Math.round(source.length / 1000)}KB)`);
const client = new Anthropic();
let message;
for (let attempt = 1; ; attempt++) {
  try {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: `今日(${date})の素材です。今日の記事を書いてください。\n${source}` }],
    });
    stream.on("text", () => process.stdout.write("."));
    message = await stream.finalMessage();
    break;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || attempt >= 3) throw e;
    await new Promise((r) => setTimeout(r, attempt * 60000));
  }
}
const raw = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

const titleMatch = raw.match(/^TITLE:\s*(.+)$/m);
const snsMatch = raw.match(/^SNS:\s*(.+)$/m);
const title = titleMatch ? titleMatch[1].trim() : `読むうんちラジオ ${date}`;
const sns = snsMatch ? snsMatch[1].trim() : "";
const body = raw.replace(/^TITLE:.*$/m, "").replace(/^SNS:.*$/m, "").trim();

// ---- Markdown → HTML (最小限) ----
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function mdToHtml(md) {
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  let para = [];
  const flush = () => {
    if (para.length) {
      html += `<p>${inline(para.join("<br>"))}</p>\n`;
      para = [];
    }
  };
  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
  for (const rawLine of lines) {
    const line = esc(rawLine.trimEnd());
    if (/^###\s/.test(line)) { flush(); if (inList) { html += "</ul>\n"; inList = false; } html += `<h3>${inline(line.replace(/^###\s*/, ""))}</h3>\n`; }
    else if (/^##\s/.test(line)) { flush(); if (inList) { html += "</ul>\n"; inList = false; } html += `<h2>${inline(line.replace(/^##\s*/, ""))}</h2>\n`; }
    else if (/^#\s/.test(line)) { flush(); if (inList) { html += "</ul>\n"; inList = false; } html += `<h2>${inline(line.replace(/^#\s*/, ""))}</h2>\n`; }
    else if (/^>\s?/.test(line)) { flush(); if (inList) { html += "</ul>\n"; inList = false; } html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>\n`; }
    else if (/^[-・*]\s/.test(line)) { flush(); if (!inList) { html += "<ul>\n"; inList = true; } html += `<li>${inline(line.replace(/^[-・*]\s*/, ""))}</li>\n`; }
    else if (line.trim() === "") { flush(); if (inList) { html += "</ul>\n"; inList = false; } }
    else para.push(line);
  }
  flush();
  if (inList) html += "</ul>\n";
  return html;
}

const fmtDate = (() => {
  const [y, m, d] = date.split("-").map(Number);
  const w = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日(${w})`;
})();

const pageCss = `
  :root { --bg:#0a0a0f; --surface:#14141d; --text:#f2f2f7; --muted:#8e8e9d; --accent:#ff5c38; --accent2:#ffb03a; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background: radial-gradient(900px 500px at 85% -10%, rgba(255,92,56,.13), transparent 60%),
    radial-gradient(700px 500px at -10% 30%, rgba(255,176,58,.07), transparent 60%), var(--bg);
    background-attachment: fixed; color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif; line-height:1.9; }
  .wrap { max-width:720px; margin:0 auto; padding:32px 20px 80px; }
  .logo { font-size:15px; font-weight:800; letter-spacing:.04em; }
  .logo a { color:var(--text); text-decoration:none; }
  .logo span { color:var(--accent); }
  .kicker { color:var(--accent2); font-size:12px; font-weight:700; letter-spacing:.12em; margin-top:34px; }
  h1 { font-size:28px; line-height:1.5; margin:10px 0 8px; font-weight:800; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:30px; }
  article h2 { font-size:20px; margin:38px 0 12px; padding-left:12px; border-left:4px solid var(--accent); }
  article h3 { font-size:16px; margin:26px 0 8px; color:var(--accent2); }
  article p { margin:14px 0; }
  article ul { margin:14px 0 14px 22px; }
  article li { margin:6px 0; }
  article blockquote { margin:16px 0; padding:12px 16px; background:var(--surface); border-left:3px solid var(--accent2); border-radius:8px; color:#d8d8e2; }
  article code { background:var(--surface); padding:2px 7px; border-radius:6px; font-size:.92em; color:var(--accent2); }
  article strong { color:#fff; }
  .cta { margin-top:48px; padding:20px; background:var(--surface); border:1px solid #2c2c3a; border-radius:16px; }
  .cta a { color:var(--accent2); font-weight:700; text-decoration:none; }
  .nav { margin-top:24px; }
  .nav a { color:var(--muted); text-decoration:none; font-size:14px; }
`;

const articleHtml = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}｜読むうんちラジオ</title>
<link rel="icon" href="../icon-192.png">
<style>${pageCss}</style></head>
<body><div class="wrap">
  <div class="logo"><a href="../">UNCHI <span>RADIO</span></a></div>
  <div class="kicker">読むうんちラジオ</div>
  <h1>${esc(title)}</h1>
  <div class="meta">${fmtDate}</div>
  <article>${mdToHtml(body)}</article>
  <div class="cta">🎧 この内容は毎朝の音声番組でも。ながら聴きは <a href="../">うんちラジオ</a> でどうぞ。</div>
  <div class="nav"><a href="index.html">← 記事一覧</a></div>
</div></body></html>`;

await writeFile(path.join(articlesDir, `${date}.html`), articleHtml, "utf8");

// index.json / index.html 更新
pastIndex = pastIndex.filter((a) => a.date !== date);
pastIndex.unshift({ date, title });
pastIndex.sort((a, b) => (a.date < b.date ? 1 : -1));
await writeFile(path.join(articlesDir, "index.json"), JSON.stringify(pastIndex, null, 2), "utf8");

const listHtml = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>読むうんちラジオ｜記事一覧</title>
<link rel="icon" href="../icon-192.png">
<style>${pageCss}
  .item { display:block; padding:16px; background:var(--surface); border:1px solid transparent; border-radius:14px; margin:10px 0; color:var(--text); text-decoration:none; }
  .item:hover { border-color:var(--accent); }
  .item .d { color:var(--muted); font-size:12px; }
  .item .t { font-weight:700; margin-top:3px; }
</style></head>
<body><div class="wrap">
  <div class="logo"><a href="../">UNCHI <span>RADIO</span></a></div>
  <div class="kicker">読むうんちラジオ</div>
  <h1>記事一覧</h1>
  ${pastIndex.map((a) => `<a class="item" href="${a.date}.html"><div class="d">${a.date}</div><div class="t">${esc(a.title)}</div></a>`).join("\n  ")}
  <div class="cta">🎧 音声で聴くなら <a href="../">うんちラジオ</a> へ。</div>
</div></body></html>`;
await writeFile(path.join(articlesDir, "index.html"), listHtml, "utf8");

// SNS予告文
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));
const base = (config.publicBaseUrl || "").replace(/\/$/, "");
const snsText = `${sns}\n\n全文はこちら(無料)\n${base}/articles/${date}.html\n\n毎朝5時、音声でも配信中\n${base}/`;
await mkdir(path.join(ROOT, "out"), { recursive: true });
await writeFile(path.join(ROOT, "out", `${date}-sns.txt`), snsText, "utf8");

const usage = message.usage;
const costUsd = (usage.input_tokens * 3 + usage.output_tokens * 15) / 1_000_000;
console.log(`\n完了: ${title} (約${body.length}字)`);
console.log(`記事: site/articles/${date}.html / SNS文: out/${date}-sns.txt / 費用: 約${Math.round(costUsd * 150)}円`);
