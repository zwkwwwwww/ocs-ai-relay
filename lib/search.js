"use strict";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(text) {
  return decodeEntities(String(text || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseBingHtml(html, topN) {
  const limit = Math.max(1, Number(topN) || 3);
  const blocks = String(html || "").match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  const items = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    if (title || snippet) items.push({ title, snippet });
    if (items.length >= limit) break;
  }
  return items;
}

async function searchBing(query, options) {
  const opts = options || {};
  const topN = Math.max(1, Number(opts.topN) || 3);
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  const fetchImpl = opts.fetchImpl || fetch;
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&setlang=zh-CN&count=10";
  const response = await fetchImpl(url, {
    headers: { "User-Agent": opts.userAgent || USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error("search failed: HTTP " + response.status);
  const html = await response.text();
  return parseBingHtml(html, topN);
}

function createSearchCache(options) {
  const opts = options || {};
  const ttlMs = Number(opts.ttlMs) || 600000;
  const maxEntries = Number(opts.maxEntries) || 300;
  const store = new Map();
  return {
    async get(query, loader) {
      const key = String(query || "").trim();
      if (!key) return [];
      const now = Date.now();
      const hit = store.get(key);
      if (hit && now - hit.at < ttlMs) return hit.items;
      const items = await loader(key);
      if (store.size >= maxEntries) store.clear();
      store.set(key, { at: now, items });
      return items;
    },
    clear() { store.clear(); },
    size() { return store.size; }
  };
}

module.exports = { USER_AGENT, decodeEntities, stripTags, parseBingHtml, searchBing, createSearchCache };
