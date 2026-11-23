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

// 原生搜索：优先用上游自带的 web_search 工具（Responses / Chat Completions 的 tool 形式），
// 失败时返回 null，由调用方决定是否退回 Bing。
function nativeSearchPayload(provider, query, options) {
  const opts = options || {};
  const kind = String(opts.kind || "responses");
  const model = String(opts.model || "");
  if (kind === "responses") {
    return {
      path: "/v1/responses",
      body: { model, input: query, tools: [{ type: "web_search" }] }
    };
  }
  return {
    path: "/v1/chat/completions",
    body: { model, messages: [{ role: "user", content: query }], tools: [{ type: "web_search" }] }
  };
}

function parseNativeSearch(obj) {
  if (!obj) return [];
  const items = [];

  // Responses API: output[].content[].annotations[] / output[].type === "web_search_call"
  const output = Array.isArray(obj.output) ? obj.output : [];
  for (const entry of output) {
    const contents = Array.isArray(entry && entry.content) ? entry.content : [];
    for (const content of contents) {
      const annotations = Array.isArray(content && content.annotations) ? content.annotations : [];
      for (const note of annotations) {
        if (!note) continue;
        const title = String(note.title || note.url || "").trim();
        const snippet = String(note.text || note.snippet || "").trim();
        if (title || snippet) items.push({ title, snippet });
      }
    }
  }

  // Chat Completions 兼容形态：message.annotations / citations
  const message = obj.choices && obj.choices[0] && obj.choices[0].message;
  if (message) {
    const annotations = Array.isArray(message.annotations) ? message.annotations : [];
    for (const note of annotations) {
      if (!note) continue;
      const title = String(note.title || note.url || "").trim();
      const snippet = String(note.text || note.snippet || "").trim();
      if (title || snippet) items.push({ title, snippet });
    }
    const citations = Array.isArray(message.citations) ? message.citations : [];
    for (const cite of citations) {
      const title = String((cite && (cite.title || cite.url)) || cite || "").trim();
      if (title) items.push({ title, snippet: String((cite && cite.text) || "") });
    }
  }

  return items;
}

async function searchBing(query, options) {
  const opts = options || {};
  const topN = Math.max(1, Number(opts.topN) || 3);
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  const fetchImpl = opts.fetchImpl || fetch;

  // 两次尝试：第一次默认 mkt，第二次换 en-US + 稍作延迟，规避偶发空页
  const attempts = [
    { setlang: "zh-CN", mkt: "zh-CN" },
    { setlang: "en-US", mkt: "en-US" }
  ];

  let lastError = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const params = attempts[i];
    const url = "https://www.bing.com/search?q=" + encodeURIComponent(query) +
      "&setlang=" + params.setlang + "&mkt=" + params.mkt + "&count=10";
    try {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      const response = await fetchImpl(url, {
        headers: { "User-Agent": opts.userAgent || USER_AGENT, "Accept-Language": params.setlang + ",en;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) { lastError = new Error("search failed: HTTP " + response.status); continue; }
      const html = await response.text();
      const items = parseBingHtml(html, topN);
      if (items.length) return items;
      lastError = new Error("search returned no results");
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
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
      // 空结果不缓存，避免一次抖动把 10 分钟都锁死
      if (items && items.length) {
        if (store.size >= maxEntries) store.clear();
        store.set(key, { at: now, items });
      }
      return items;
    },
    clear() { store.clear(); },
    size() { return store.size; }
  };
}

module.exports = {
  USER_AGENT,
  decodeEntities,
  stripTags,
  parseBingHtml,
  searchBing,
  createSearchCache,
  nativeSearchPayload,
  parseNativeSearch
};
