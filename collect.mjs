// フェーズ1: AI関連の話題を集めてテキスト(Markdown)で吐き出す
// 使い方:  node collect.mjs
// 出力:    out/YYYY-MM-DD.md

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

const UA = "ai-radio-digest/0.1 (personal news collector)";

// ---------------------------------------------------------------- 共通部品

function isAiRelated(text) {
  const t = (text || "").toLowerCase();
  return config.aiKeywords.some((kw) => t.includes(kw));
}

async function fetchWithTimeout(url, ms, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      headers: { "User-Agent": UA, ...(options.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// HTMLからおおまかに本文テキストを抜く(精密さよりも「読める」ことを優先)
function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<(p|div|br|li|h[1-6]|tr)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s*\n\s*/g, "\n\n");
  return s.trim();
}

// リンク先の記事本文を取得(失敗しても止めない)
async function fetchArticleBody(url) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  // 本文を取っても意味が薄いドメインはスキップ
  const skip = ["twitter.com", "x.com", "youtube.com", "youtu.be"];
  try {
    const host = new URL(url).hostname;
    if (skip.some((d) => host.endsWith(d))) return null;
    const res = await fetchWithTimeout(url, config.articleBody.timeoutMs);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.includes("html") && !type.includes("text")) return null;
    const html = await res.text();
    const text = htmlToText(html);
    if (text.length < 200) return null; // 中身が取れていない
    return text.slice(0, config.articleBody.maxChars);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 収集: 信頼レーン (RSS/Atom)

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

// RSS(<item>)とAtom(<entry>)の両形式をざっくり読む
function parseFeed(xml) {
  const items = [];
  const blocks = xml.includes("<entry") ? xml.split(/<entry[\s>]/).slice(1) : xml.split(/<item[\s>]/).slice(1);
  for (const block of blocks) {
    const pick = (re) => {
      const m = block.match(re);
      return m ? decodeEntities(m[1]).trim() : null;
    };
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/);
    let link = pick(/<link[^>]*href="([^"]+)"/) || pick(/<link[^>]*>([\s\S]*?)<\/link>/);
    const dateStr =
      pick(/<pubDate>([\s\S]*?)<\/pubDate>/) ||
      pick(/<published>([\s\S]*?)<\/published>/) ||
      pick(/<updated>([\s\S]*?)<\/updated>/) ||
      pick(/<dc:date>([\s\S]*?)<\/dc:date>/);
    const contentHtml =
      pick(/<content[^>]*>([\s\S]*?)<\/content>/) ||
      pick(/<description[^>]*>([\s\S]*?)<\/description>/) ||
      pick(/<summary[^>]*>([\s\S]*?)<\/summary>/) ||
      "";
    if (!title || !link) continue;
    items.push({ title, link, date: dateStr ? new Date(dateStr) : null, contentHtml });
  }
  return items;
}

async function collectTrustedFeeds() {
  const since = Date.now() - config.trustedLane.hoursBack * 3600 * 1000;
  const all = [];
  for (const feed of config.trustedFeeds) {
    try {
      const res = await fetchWithTimeout(feed.url, 20000);
      if (!res.ok) {
        console.warn(`  ${feed.name}: HTTP ${res.status} (スキップ)`);
        continue;
      }
      const xml = await res.text();
      const entries = parseFeed(xml).filter((e) => e.date && e.date.getTime() > since);
      for (const e of entries) {
        const item = {
          source: `信頼レーン: ${feed.name}`,
          title: e.title,
          url: e.link,
          score: e.date.toISOString().slice(0, 10),
          body: htmlToText(decodeEntities(e.contentHtml)).slice(0, config.articleBody.maxChars) || null,
          linkedArticles: [],
        };
        // 記事中に貼られた外部リンクを辿って本文を取る(設計書の「リンク先を辿る」)
        const links = [...e.contentHtml.matchAll(/href="(https?:\/\/[^"]+)"/g)]
          .map((m) => decodeEntities(m[1]))
          .filter((u) => {
            try {
              const host = new URL(u).hostname;
              const feedHost = new URL(e.link).hostname;
              return host !== feedHost && !u.includes("mailto:");
            } catch {
              return false;
            }
          })
          .slice(0, config.trustedLane.maxLinksPerEntry);
        for (const u of links) {
          const body = await fetchArticleBody(u);
          if (body) item.linkedArticles.push({ url: u, body: body.slice(0, 2000) });
        }
        all.push(item);
      }
      if (entries.length) console.log(`  ${feed.name}: ${entries.length}件`);
    } catch (err) {
      console.warn(`  ${feed.name}: 取得失敗 (${err.message})`);
    }
  }
  return all;
}

// アンソロピックはRSSが無いのでニュース一覧ページから直接取る
async function collectAnthropicNews() {
  try {
    const res = await fetchWithTimeout("https://www.anthropic.com/news", 20000);
    if (!res.ok) return [];
    const html = await res.text();
    const seen = new Set();
    const links = [...html.matchAll(/href="(\/news\/[a-z0-9-]+)"/g)]
      .map((m) => m[1])
      .filter((p) => !seen.has(p) && seen.add(p))
      .slice(0, 5); // 一覧の先頭=最新側だけ見る
    const items = [];
    for (const p of links) {
      const url = `https://www.anthropic.com${p}`;
      const body = await fetchArticleBody(url);
      const title = p.replace("/news/", "").replace(/-/g, " ");
      items.push({
        source: "信頼レーン: アンソロピック公式",
        title,
        url,
        score: "news page",
        body,
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 収集: Hacker News

async function collectHackerNews() {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story" +
    `&numericFilters=created_at_i>${since},points>${config.hackerNews.minPoints}` +
    "&hitsPerPage=200";
  const res = await fetchWithTimeout(url, 20000);
  const data = await res.json();
  const items = (data.hits || [])
    .filter((h) => isAiRelated(h.title + " " + (h.url || "")))
    .sort((a, b) => b.points - a.points)
    .slice(0, config.hackerNews.maxItems)
    .map((h) => ({
      source: "Hacker News",
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      score: `${h.points} points / ${h.num_comments} comments`,
      discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));
  return items;
}

// ---------------------------------------------------------------- 収集: GitHub Trending

async function collectGitHubTrending() {
  const res = await fetchWithTimeout("https://github.com/trending?since=daily", 20000);
  const html = await res.text();
  const items = [];
  // trendingページの各リポジトリブロックをざっくり切り出す
  const blocks = html.split('<article class="Box-row"');
  for (const block of blocks.slice(1)) {
    const nameMatch = block.match(/href="\/([^"\/]+\/[^"\/]+)"/);
    if (!nameMatch) continue;
    const repo = nameMatch[1];
    const descMatch = block.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/);
    const desc = descMatch ? htmlToText(descMatch[1]) : "";
    const starsMatch = block.match(/([\d,]+)\s+stars today/);
    const stars = starsMatch ? starsMatch[1] + " stars today" : "";
    items.push({
      source: "GitHub Trending",
      title: `${repo} — ${desc}`.trim(),
      url: `https://github.com/${repo}`,
      score: stars,
    });
  }
  // AI関連を優先しつつ、上位は無条件で少し入れる
  const ai = items.filter((i) => isAiRelated(i.title));
  const rest = items.filter((i) => !isAiRelated(i.title)).slice(0, 3);
  return [...ai, ...rest].slice(0, config.githubTrending.maxItems);
}

// ---------------------------------------------------------------- 収集: Reddit

// RedditのJSON APIはプログラムからのアクセスを拒否するため、RSSフィードで取る
async function collectReddit() {
  const all = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let first = true;
  for (const sub of config.subreddits) {
    try {
      if (!first) await sleep(15000); // 連続アクセスすると429で拒否されるため間を空ける
      first = false;
      const url = `https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=${config.reddit.maxItemsPerSub}`;
      let res = await fetchWithTimeout(url, 20000);
      for (let retry = 0; retry < 2 && res.status === 429; retry++) {
        await sleep(30000); // 拒否されたら長めに待って再挑戦
        res = await fetchWithTimeout(url, 20000);
      }
      if (!res.ok) {
        console.warn(`  r/${sub}: HTTP ${res.status} (スキップ)`);
        continue;
      }
      const xml = await res.text();
      const entries = xml.split("<entry>").slice(1, config.reddit.maxItemsPerSub + 1);
      for (const entry of entries) {
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const linkMatch = entry.match(/<link href="([^"]+)"/);
        const contentMatch = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
        if (!titleMatch || !linkMatch) continue;
        const decode = (s) =>
          s
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"');
        const permalink = decode(linkMatch[1]);
        let externalUrl = null;
        let selftext = null;
        if (contentMatch) {
          const contentHtml = decode(contentMatch[1]);
          // 外部リンク投稿なら [link] が外部URLを指している
          const extMatch = contentHtml.match(/<a href="(https?:\/\/[^"]+)">\s*\[link\]/);
          if (extMatch && !extMatch[1].includes("reddit.com")) {
            externalUrl = extMatch[1];
          } else {
            // テキスト投稿なら本文をそのまま使う
            const text = htmlToText(contentHtml)
              .replace(/\[link\]|\[comments\]/g, "")
              .replace(/submitted by\s+\/u\/\S+/g, "")
              .trim();
            if (text.length > 100) selftext = text.slice(0, config.articleBody.maxChars);
          }
        }
        all.push({
          source: `Reddit r/${sub}`,
          title: decode(titleMatch[1]),
          url: externalUrl || permalink,
          score: "top of the day",
          discussion: permalink,
          selftext,
        });
      }
    } catch (e) {
      console.warn(`  r/${sub}: 取得失敗 (${e.message})`);
    }
  }
  return all;
}

// ---------------------------------------------------------------- 収集: Google News (日本語ニュース検索)

async function collectGoogleNews(query, maxItems, freshHours = 48) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
  try {
    const res = await fetchWithTimeout(url, 20000);
    if (!res.ok) {
      console.warn(`  Google News「${query}」: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const since = Date.now() - freshHours * 3600 * 1000;
    return parseFeed(xml)
      .filter((e) => !e.date || e.date.getTime() > since)
      .slice(0, maxItems)
      .map((e) => ({
        source: `Google News検索「${query}」`,
        title: e.title,
        url: e.link,
        score: e.date ? e.date.toISOString().slice(0, 10) : "recent",
        body: htmlToText(decodeEntities(e.contentHtml)).slice(0, 500) || null,
      }));
  } catch (err) {
    console.warn(`  Google News「${query}」: 失敗 (${err.message})`);
    return [];
  }
}

// Hacker Newsの「Show HN」からAIで作った収益系プロジェクトを拾う
async function collectShowHn() {
  const since = Math.floor(Date.now() / 1000) - 48 * 3600;
  const url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn" +
    `&numericFilters=created_at_i>${since},points>10&hitsPerPage=100`;
  try {
    const res = await fetchWithTimeout(url, 20000);
    const data = await res.json();
    return (data.hits || [])
      .filter((h) => isAiRelated(h.title))
      .sort((a, b) => b.points - a.points)
      .slice(0, 8)
      .map((h) => ({
        source: "Show HN (個人開発の作品発表)",
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        score: `${h.points} points`,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 出力

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main() {
  console.log("収集を開始します…");
  const channelsOnly = process.argv.includes("--channels-only");

  if (channelsOnly) {
    console.log("(チャンネル素材のみ収集モード)");
  }
  const trusted = channelsOnly ? [] : await collectTrustedFeeds();
  const anthropic = channelsOnly ? [] : await collectAnthropicNews();
  if (!channelsOnly) console.log(`- 信頼レーン 合計 ${trusted.length + anthropic.length}件`);

  const hn = channelsOnly ? [] : await collectHackerNews().catch((e) => {
    console.warn(`  HN失敗: ${e.message}`);
    return [];
  });
  const gh = channelsOnly ? [] : await collectGitHubTrending().catch((e) => {
    console.warn(`  GH失敗: ${e.message}`);
    return [];
  });
  const rd = channelsOnly ? [] : await collectReddit();
  if (!channelsOnly) console.log(`- HN ${hn.length} / GitHub ${gh.length} / Reddit ${rd.length}件`);

  let items = [...trusted, ...anthropic, ...hn, ...rd, ...gh];

  // 前日までに出した記事は繰り返さない (out/seen.json に既出URLを記録)
  const seenPath = path.join(ROOT, "out", "seen.json");
  let seen = [];
  try {
    seen = JSON.parse(await readFile(seenPath, "utf8"));
  } catch {}
  const seenSet = new Set(seen);
  const before = items.length;
  items = items.filter((i) => !seenSet.has(i.url));
  if (before !== items.length) console.log(`- 既出のため除外: ${before - items.length}件`);

  console.log(`- 本文取得 (${items.length}件のリンク先)…`);
  let fetched = 0;
  for (const item of items) {
    if (item.body) continue; // 信頼レーンなどで取得済み
    if (item.selftext) {
      item.body = item.selftext;
      continue;
    }
    if (item.source === "GitHub Trending") continue; // リポジトリは説明文で十分
    item.body = await fetchArticleBody(item.url);
    if (item.body) fetched++;
  }
  console.log(`  本文が取れたもの: ${fetched}件`);

  // Markdownに整形
  const date = today();
  const formatItems = (title, list) => {
    let md = `# ${title} — ${date}\n\n計${list.length}件\n\n---\n\n`;
    let n = 0;
    for (const item of list) {
      n++;
      md += `## ${n}. ${item.title}\n\n`;
      md += `- 出どころ: ${item.source}（${item.score}）\n`;
      md += `- リンク: ${item.url}\n`;
      if (item.discussion && item.discussion !== item.url) {
        md += `- 議論: ${item.discussion}\n`;
      }
      md += `\n`;
      if (item.body) {
        md += `### 本文(抜粋)\n\n${item.body}\n\n`;
      } else {
        md += `(本文は取得できず。タイトルとリンクのみ)\n\n`;
      }
      if (item.linkedArticles?.length) {
        for (const la of item.linkedArticles) {
          md += `### 記事内で紹介されていたリンク先: ${la.url}\n\n${la.body}\n\n`;
        }
      }
      md += `---\n\n`;
    }
    return md;
  };

  await mkdir(path.join(ROOT, "out"), { recursive: true });
  if (!channelsOnly) {
    const outPath = path.join(ROOT, "out", `${date}.md`);
    await writeFile(outPath, formatItems("AI情報ダイジェスト素材", items), "utf8");
    for (const i of items) seenSet.add(i.url);
    console.log(`AIチャンネル: ${items.length}件 → ${outPath}`);
  }

  // ---- 飲食チャンネル・稼ぐチャンネルの素材 ----
  for (const [ch, cfg] of Object.entries(config.channels || {})) {
    console.log(`- チャンネル「${cfg.name}」`);
    let chItems = [];
    for (const q of cfg.googleNews || []) {
      chItems.push(...(await collectGoogleNews(q, cfg.maxPerQuery || 6, (cfg.freshDays || 2) * 24)));
    }
    if (cfg.hackerNewsShow) chItems.push(...(await collectShowHn()));
    // 重複(タイトルが酷似・URL既出)を除く (--ignore-seen で既出フィルタを無効化)
    const ignoreSeen = process.argv.includes("--ignore-seen");
    const seenTitles = new Set();
    chItems = chItems.filter((i) => {
      const t = i.title.slice(0, 25);
      if ((!ignoreSeen && seenSet.has(i.url)) || seenTitles.has(t)) return false;
      seenTitles.add(t);
      return true;
    });
    console.log(`  ${chItems.length}件`);
    const chPath = path.join(ROOT, "out", `${date}-${ch}.md`);
    // 0件の日は既存ファイルを上書きしない(再実行への保険)
    if (chItems.length > 0) {
      await writeFile(chPath, formatItems(`${cfg.name} 素材`, chItems), "utf8");
      for (const i of chItems) seenSet.add(i.url);
    }
  }

  await writeFile(seenPath, JSON.stringify([...seenSet], null, 2), "utf8");
  console.log(`\n完了`);
}

await main();
