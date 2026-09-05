// 毎朝の全自動実行: 収集 → 原稿 → 音声 → (あれば)ポッドキャストRSS
// 使い方: node run-daily.mjs
// ログ: logs/YYYY-MM-DD.log に残る

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = today();
await mkdir(path.join(ROOT, "logs"), { recursive: true });
const logPath = path.join(ROOT, "logs", `${date}.log`);

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  await appendFile(logPath, line, "utf8");
}

async function step(name, file, args = []) {
  await log(`--- ${name} 開始`);
  try {
    const { stdout, stderr } = await run("node", [path.join(ROOT, file), ...args], {
      cwd: ROOT,
      timeout: 30 * 60 * 1000,
    });
    if (stdout) await appendFile(logPath, stdout, "utf8");
    if (stderr) await appendFile(logPath, stderr, "utf8");
    await log(`--- ${name} 完了`);
    return true;
  } catch (e) {
    await log(`!!! ${name} 失敗: ${e.message}`);
    if (e.stdout) await appendFile(logPath, e.stdout, "utf8");
    if (e.stderr) await appendFile(logPath, e.stderr, "utf8");
    return false;
  }
}

await log(`===== うんちラジオ 自動実行 (${date}) =====`);
if (!(await step("収集", "collect.mjs"))) process.exit(1);
if (!(await step("原稿生成(AI)", "generate.mjs", [date, "ai"]))) process.exit(1);
// サブチャンネルは失敗しても放送自体は止めない
await step("原稿生成(飲食×AI)", "generate.mjs", [date, "food"]);
await step("原稿生成(AIで稼ぐ)", "generate.mjs", [date, "money"]);
await step("原稿生成(心に残る接客)", "generate.mjs", [date, "story"]);
await step("記事生成(読むうんちラジオ)", "article.mjs", [date]);
if (!(await step("音声化", "tts.mjs", [date]))) process.exit(1);
await step("ポッドキャストRSS", "rss.mjs");
await log("===== すべて完了 =====");
