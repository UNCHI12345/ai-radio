// ポッドキャストRSSを site/podcast.xml に出力する
// config.json の publicBaseUrl (公開URL)が設定されている時だけ動く

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));
const base = (config.publicBaseUrl || "").replace(/\/$/, "");

if (!base) {
  console.log("publicBaseUrl が未設定のためRSSはスキップ(公開後に設定)");
  process.exit(0);
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const dataDir = path.join(ROOT, "site", "data");
const dates = (await readdir(dataDir))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.replace(".json", ""))
  .sort()
  .reverse()
  .slice(0, 30);

let items = "";
for (const date of dates) {
  const data = JSON.parse(await readFile(path.join(dataDir, `${date}.json`), "utf8"));
  for (const t of data.tracks) {
    const fileUrl = `${base}/${t.file}`;
    let size = 0;
    try {
      size = (await stat(path.join(ROOT, "site", t.file))).size;
    } catch {}
    items += `
    <item>
      <title>${esc(`${date} ${t.title}`)}</title>
      <enclosure url="${esc(fileUrl)}" length="${size}" type="audio/mpeg"/>
      <guid isPermaLink="false">${esc(t.file)}</guid>
      <pubDate>${new Date(date + "T05:00:00+09:00").toUTCString()}</pubDate>
      <itunes:duration>${t.duration || 0}</itunes:duration>
    </item>`;
  }
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>UNCHI AI RADIO</title>
    <link>${esc(base)}</link>
    <description>毎朝のAI情報を日本語音声で。UNCHIが届けるAIラジオ</description>
    <language>ja</language>
    <itunes:image href="${esc(base + "/icon-512.png")}"/>
    ${items}
  </channel>
</rss>`;

await writeFile(path.join(ROOT, "site", "podcast.xml"), xml, "utf8");
console.log(`podcast.xml 更新 (${dates.length}日分)`);
