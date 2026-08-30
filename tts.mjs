// フェーズ3: 高品質ニューラル音声で記事ごとのMP3を作る (edge-tts使用)
// 使い方: node tts.mjs [YYYY-MM-DD]
// 出力: site/audio/YYYY-MM-DD/NN.mp3 と site/data/YYYY-MM-DD.json

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EDGE_TTS = path.join(ROOT, ".venv-tts", "bin", "edge-tts");
const VOICE = process.env.RADIO_VOICE || "ja-JP-NanamiNeural";
const RATE = process.env.RADIO_RATE || "+8%";

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = process.argv[2] || today();
const text = await readFile(path.join(ROOT, "scripts", `${date}.md`), "utf8");

// 「=== タイトル ===」で分割し、LINK行を抜き出す
const sections = [];
const parts = text.split(/^=== (.+?) ===$/m);
for (let i = 1; i < parts.length; i += 2) {
  const title = parts[i].trim();
  let body = (parts[i + 1] || "").trim();
  let link = null;
  const linkMatch = body.match(/^LINK:\s*(\S+)\s*$/m);
  if (linkMatch) {
    link = linkMatch[1];
    body = body.replace(/^LINK:.*$/m, "").trim();
  }
  if (body) sections.push({ title, body, link });
}
if (!sections.length) {
  console.error("原稿の区切りが見つかりません。");
  process.exit(1);
}

const audioDir = path.join(ROOT, "site", "audio", date);
await rm(audioDir, { recursive: true, force: true });
await mkdir(audioDir, { recursive: true });
await mkdir(path.join(ROOT, "site", "data"), { recursive: true });

async function synth(txtPath, mp3Path, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    try {
      await run(EDGE_TTS, ["--voice", VOICE, "--rate", RATE, "--file", txtPath, "--write-media", mp3Path], {
        timeout: 180000,
      });
      return;
    } catch (e) {
      if (t === tries) throw e;
      console.warn(`  再試行 ${t}/${tries - 1}…`);
      await new Promise((r) => setTimeout(r, 5000 * t));
    }
  }
}

const meta = [];
let n = 0;
for (const sec of sections) {
  n++;
  const id = String(n).padStart(2, "0");
  const txt = path.join(audioDir, `${id}.txt`);
  const mp3 = path.join(audioDir, `${id}.mp3`);
  await writeFile(txt, sec.body, "utf8");
  process.stdout.write(`${id} ${sec.title} … `);
  await synth(txt, mp3);
  const info = await run("afinfo", [mp3]);
  const durMatch = info.stdout.match(/estimated duration: ([\d.]+)/);
  const duration = durMatch ? Math.round(parseFloat(durMatch[1])) : 0;
  await rm(txt);
  meta.push({ file: `audio/${date}/${id}.mp3`, title: sec.title, duration, link: sec.link });
  console.log(`${Math.floor(duration / 60)}分${duration % 60}秒`);
}

await writeFile(
  path.join(ROOT, "site", "data", `${date}.json`),
  JSON.stringify({ date, voice: VOICE, tracks: meta }, null, 2),
  "utf8"
);

const dataDir = path.join(ROOT, "site", "data");
const dates = (await readdir(dataDir))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.replace(".json", ""))
  .sort()
  .reverse();
await writeFile(path.join(dataDir, "manifest.json"), JSON.stringify({ dates }, null, 2), "utf8");

console.log(`\n完了: ${sections.length}本 → site/audio/${date}/ (声: ${VOICE})`);
