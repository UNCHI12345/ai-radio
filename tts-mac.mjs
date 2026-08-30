// フェーズ3(仮): Mac内蔵音声で記事ごとのM4Aを作る
// 本番はGoogle Cloud TTSに差し替える予定。使い方: node tts-mac.mjs [YYYY-MM-DD]
// 出力: site/audio/YYYY-MM-DD/NN.m4a と site/data/YYYY-MM-DD.json

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = process.argv[2] || today();
const scriptPath = path.join(ROOT, "scripts", `${date}.md`);
const text = await readFile(scriptPath, "utf8");

// 「=== タイトル ===」で分割
const sections = [];
const parts = text.split(/^=== (.+?) ===$/m);
for (let i = 1; i < parts.length; i += 2) {
  const title = parts[i].trim();
  const body = (parts[i + 1] || "").trim();
  if (body) sections.push({ title, body });
}
if (!sections.length) {
  console.error("原稿の区切りが見つかりません。");
  process.exit(1);
}

const audioDir = path.join(ROOT, "site", "audio", date);
await mkdir(audioDir, { recursive: true });
await mkdir(path.join(ROOT, "site", "data"), { recursive: true });

const meta = [];
let n = 0;
for (const sec of sections) {
  n++;
  const id = String(n).padStart(2, "0");
  const txt = path.join(audioDir, `${id}.txt`);
  const aiff = path.join(audioDir, `${id}.aiff`);
  const m4a = path.join(audioDir, `${id}.m4a`);
  await writeFile(txt, sec.body, "utf8");
  process.stdout.write(`${id} ${sec.title} … `);
  await run("say", ["-v", "Kyoko", "-o", aiff, "-f", txt]);
  await run("afconvert", ["-f", "m4af", "-d", "aac", aiff, m4a]);
  const info = await run("afinfo", [m4a]);
  const durMatch = info.stdout.match(/estimated duration: ([\d.]+)/);
  const duration = durMatch ? Math.round(parseFloat(durMatch[1])) : 0;
  await run("rm", [aiff, txt]);
  meta.push({ file: `audio/${date}/${id}.m4a`, title: sec.title, duration });
  console.log(`${Math.floor(duration / 60)}分${duration % 60}秒`);
}

await writeFile(
  path.join(ROOT, "site", "data", `${date}.json`),
  JSON.stringify({ date, tracks: meta }, null, 2),
  "utf8"
);

// 日付一覧(manifest)を更新
const dataDir = path.join(ROOT, "site", "data");
const dates = (await readdir(dataDir))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.replace(".json", ""))
  .sort()
  .reverse();
await writeFile(path.join(dataDir, "manifest.json"), JSON.stringify({ dates }, null, 2), "utf8");

console.log(`\n完了: ${sections.length}本の音声 → site/audio/${date}/`);
