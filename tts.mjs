// フェーズ3: 高品質ニューラル音声で記事ごとのMP3を作る
// 標準: Google Cloud TTS (Chirp 3 HD)。鍵が無い環境では edge-tts に自動で切り替え
// 使い方: node tts.mjs [YYYY-MM-DD]
// 出力: site/audio/YYYY-MM-DD/NN.mp3 と site/data/YYYY-MM-DD.json

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const GOOGLE_KEY = (process.env.GOOGLE_TTS_API_KEY || "").trim();
const useGoogle = GOOGLE_KEY.startsWith("AIza");
const GOOGLE_VOICE = process.env.RADIO_VOICE_GOOGLE || "ja-JP-Chirp3-HD-Kore";
const GOOGLE_RATE = Number(process.env.RADIO_RATE_GOOGLE || "1.05");
const EDGE_TTS = path.join(ROOT, ".venv-tts", "bin", "edge-tts");
const EDGE_VOICE = process.env.RADIO_VOICE || "ja-JP-NanamiNeural";
const EDGE_RATE = process.env.RADIO_RATE || "+8%";

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 読み上げできない記号を落とし、句点の無い長すぎる文には区切りを入れる
function sanitize(text) {
  let s = text.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}\s。、！？!?.,:;「」『』（）()〜ー・…%％]/gu,
    " "
  );
  s = s.replace(/[ \t]+/g, " ");
  // カギ括弧は読まれない上に、句点直後にあると文の切れ目と認識されなくなるため除去
  s = s.replace(/[「」『』]/g, "");
  // 改行はGoogleに文の切れ目として扱われないため、句点に変換する
  s = s
    .replace(/\s*\n+\s*/g, "。")
    .replace(/([。！？])。+/g, "$1")
    .replace(/^。+/, "");
  // Googleの声は1文が長すぎると拒否するため、90文字を超える文は
  // 真ん中に近い「、」で2文に割る(必要なら繰り返し割る)
  const splitLong = (sen) => {
    if (sen.length <= 90) return [sen];
    const commas = [...sen.matchAll(/、/g)].map((m) => m.index);
    if (!commas.length) {
      return sen.match(/.{1,80}/g).map((x) => x + "。");
    }
    const mid = sen.length / 2;
    const best = commas.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
    const left = sen.slice(0, best) + "。";
    const right = sen.slice(best + 1);
    return [...splitLong(left), ...splitLong(right)];
  };
  s = s
    .split(/(?<=[。！？\n])/)
    .flatMap(splitLong)
    .join("");
  return s;
}

// GoogleのAPIは1回5000バイトまでなので、文の区切りで分割する
function chunkText(text, maxBytes = 4000) {
  const sentences = sanitize(text).split(/(?<=[。！？\n])/);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (Buffer.byteLength(cur + s, "utf8") > maxBytes && cur) {
      chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function synthGoogle(text, mp3Path) {
  const buffers = [];
  for (const chunk of chunkText(text)) {
    let lastErr;
    for (let t = 1; t <= 3; t++) {
      try {
        const res = await fetch(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: { text: chunk },
              voice: { languageCode: "ja-JP", name: GOOGLE_VOICE },
              audioConfig: { audioEncoding: "MP3", speakingRate: GOOGLE_RATE },
            }),
            signal: AbortSignal.timeout(120000),
          }
        );
        const data = await res.json();
        if (!data.audioContent) {
          await mkdir(path.join(ROOT, "logs"), { recursive: true });
          await writeFile(path.join(ROOT, "logs", "tts-error-chunk.txt"), chunk, "utf8");
          throw new Error(JSON.stringify(data).slice(0, 200));
        }
        buffers.push(Buffer.from(data.audioContent, "base64"));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 5000 * t));
      }
    }
    if (lastErr) throw lastErr;
  }
  await writeFile(mp3Path, Buffer.concat(buffers));
}

async function synthEdge(text, mp3Path) {
  const txt = mp3Path + ".txt";
  await writeFile(txt, text, "utf8");
  try {
    for (let t = 1; ; t++) {
      try {
        await run(EDGE_TTS, ["--voice", EDGE_VOICE, "--rate", EDGE_RATE, "--file", txt, "--write-media", mp3Path], {
          timeout: 180000,
        });
        return;
      } catch (e) {
        if (t >= 3) throw e;
        await new Promise((r) => setTimeout(r, 5000 * t));
      }
    }
  } finally {
    await rm(txt, { force: true });
  }
}

const date = process.argv[2] || today();

// チャンネル構成 (原稿ファイルが存在するものだけ音声化する)
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));
const channels = [
  { id: "ai", name: "AIニュース", script: `${date}.md` },
  ...Object.entries(config.channels || {}).map(([id, c]) => ({
    id,
    name: c.name,
    script: `${date}-${id}.md`,
  })),
];

function parseSections(text) {
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
  return sections;
}

const voiceName = useGoogle ? GOOGLE_VOICE : EDGE_VOICE;
console.log(`声: ${voiceName} (${useGoogle ? "Google Cloud TTS" : "edge-tts"})`);

const audioDir = path.join(ROOT, "site", "audio", date);
await rm(audioDir, { recursive: true, force: true });
await mkdir(audioDir, { recursive: true });
await mkdir(path.join(ROOT, "site", "data"), { recursive: true });

const meta = [];
for (const ch of channels) {
  let text;
  try {
    text = await readFile(path.join(ROOT, "scripts", ch.script), "utf8");
  } catch {
    console.log(`(${ch.name}: 原稿なし、スキップ)`);
    continue;
  }
  const sections = parseSections(text);
  if (!sections.length) continue;
  console.log(`--- ${ch.name} (${sections.length}本)`);
  let n = 0;
  for (const sec of sections) {
    n++;
    const id = `${ch.id}-${String(n).padStart(2, "0")}`;
    const mp3 = path.join(audioDir, `${id}.mp3`);
    process.stdout.write(`${id} ${sec.title} … `);
    if (useGoogle) await synthGoogle(sec.body, mp3);
    else await synthEdge(sec.body, mp3);
    const info = await run("afinfo", [mp3]).catch(() => null);
    const durMatch = info?.stdout.match(/estimated duration: ([\d.]+)/);
    const duration = durMatch ? Math.round(parseFloat(durMatch[1])) : Math.round(sec.body.length / 6.5);
    meta.push({
      file: `audio/${date}/${id}.mp3`,
      title: sec.title,
      duration,
      link: sec.link,
      channel: ch.id,
      channelName: ch.name,
    });
    console.log(`${Math.floor(duration / 60)}分${duration % 60}秒`);
  }
}
if (!meta.length) {
  console.error("原稿が1つも見つかりません。");
  process.exit(1);
}
const sections = meta; // 下の完了メッセージ用

await writeFile(
  path.join(ROOT, "site", "data", `${date}.json`),
  JSON.stringify({ date, voice: voiceName, tracks: meta }, null, 2),
  "utf8"
);

const dataDir = path.join(ROOT, "site", "data");
const dates = (await readdir(dataDir))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.replace(".json", ""))
  .sort()
  .reverse();
await writeFile(path.join(dataDir, "manifest.json"), JSON.stringify({ dates }, null, 2), "utf8");

console.log(`\n完了: ${sections.length}本 → site/audio/${date}/`);
