"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, saveConfig, publicConfig, resolveProvider } = require("./lib/config");
const { answerQuestion } = require("./lib/pipeline");
const { searchBing, createSearchCache } = require("./lib/search");
const { appendLog, readTail, summarize } = require("./lib/logs");
const history = require("./lib/history");
const { callModel } = require("./lib/model");

const ROOT = __dirname;
const UI_FILE = path.join(ROOT, "public", "index.html");
const REQUESTS_LOG = path.join(ROOT, "requests.jsonl");
const HISTORY_LOG = path.join(ROOT, "history.jsonl");
const VERSION = "1.2.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function sendJson(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({}, CORS, { "Content-Type": "application/json; charset=utf-8" }));
  res.end(text);
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildPatch(body) {
  const patch = {};
  if (typeof body.model === "string") patch.model = body.model;
  if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
  if (body.temperature !== undefined) patch.temperature = body.temperature;
  if (body.judgementMap !== undefined) patch.judgementMap = Boolean(body.judgementMap);
  if (typeof body.defaultProvider === "string") patch.defaultProvider = body.defaultProvider;

  if (body.providers && typeof body.providers === "object") {
    patch.providers = {};
    for (const name of Object.keys(body.providers)) {
      const incoming = body.providers[name] || {};
      const entry = {};
      if (typeof incoming.upstream === "string") entry.upstream = incoming.upstream;
      if (typeof incoming.apiKey === "string" && incoming.apiKey.trim()) entry.apiKey = incoming.apiKey.trim();
      if (incoming.enabled !== undefined) entry.enabled = Boolean(incoming.enabled);
      patch.providers[name] = entry;
    }
  }

  if (body.routes !== undefined) {
    patch.routes = Array.isArray(body.routes)
      ? body.routes.filter((route) => route && route.model && route.provider).map((route) => ({ model: String(route.model), provider: String(route.provider) }))
      : [];
  }

  if (body.search && typeof body.search === "object") {
    patch.search = {};
    if (body.search.mode) patch.search.mode = body.search.mode;
    if (body.search.topN !== undefined) patch.search.topN = body.search.topN;
    if (body.search.timeoutMs !== undefined) patch.search.timeoutMs = body.search.timeoutMs;
    if (body.search.cacheTtlMs !== undefined) patch.search.cacheTtlMs = body.search.cacheTtlMs;
  }
  if (body.retry && typeof body.retry === "object") {
    patch.retry = {};
    if (body.retry.attempts !== undefined) patch.retry.attempts = body.retry.attempts;
    if (body.retry.backoffMs !== undefined) patch.retry.backoffMs = body.retry.backoffMs;
  }
  return patch;
}

function createRelayServer(options) {
  const opts = options || {};
  const searchCache = opts.searchCache || createSearchCache({ ttlMs: 600000 });
  const getConfig = opts.getConfig || (() => loadConfig());
  const fetchImpl = opts.fetchImpl || fetch;
  const requestsLog = opts.requestsLog || REQUESTS_LOG;
  const historyLog = opts.historyLog || HISTORY_LOG;
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (pathname === "/health") {
        const config = getConfig();
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          providers: Object.keys(config.providers || {}),
          defaultProvider: config.defaultProvider,
          uptimeMs: Date.now() - startedAt,
          time: new Date().toISOString()
        });
      }

      if (pathname === "/" || pathname === "/ui") {
        let html = "";
        try { html = fs.readFileSync(UI_FILE, "utf8"); } catch { return sendJson(res, 500, { error: { message: "public/index.html not found" } }); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      if (pathname === "/api/config" && req.method === "GET") {
        return sendJson(res, 200, publicConfig(getConfig()));
      }

      if (pathname === "/api/config" && req.method === "POST") {
        const body = safeParse(await readBody(req));
        if (!body) return sendJson(res, 400, { error: { message: "invalid json" } });
        const saved = saveConfig(buildPatch(body));
        return sendJson(res, 200, publicConfig(saved));
      }

      if (pathname === "/api/test" && req.method === "POST") {
        const config = getConfig();
        const body = safeParse(await readBody(req)) || {};
        const name = body.provider && config.providers[body.provider]
          ? body.provider
          : resolveProvider(config, body.model || config.model || "");
        const provider = name ? config.providers[name] : null;
        if (!provider) return sendJson(res, 400, { error: { message: "no provider available" } });
        const started = Date.now();
        let testModel = String(body.model || config.model || "").trim();
        if (!testModel) {
          // 未指定模型时，向上游 /v1/models 取第一个可用模型，避免用 gpt-3.5-turbo 这类未必存在的名字去探活
          try {
            const headers = provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {};
            const listing = await fetchImpl(provider.upstream + "/v1/models", { headers, signal: AbortSignal.timeout(10000) });
            const parsed = safeParse(await listing.text());
            const list = parsed && Array.isArray(parsed.data) ? parsed.data.filter((item) => item && item.id) : [];
            // 优先挑对话模型：图像/向量/语音模型也能返回 200，但说明不了聊天链路是否正常
            const chat = list.find((item) => !/image|embed|tts|whisper|audio|video|rerank|moderation|ocr|seedance/i.test(String(item.id)));
            const first = chat || list[0] || null;
            if (first) testModel = String(first.id);
          } catch { /* 探测失败就退回默认名字 */ }
        }
        if (!testModel) testModel = "gpt-3.5-turbo";
        const result = await callModel(provider, {
          model: testModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 8,
          temperature: 0
        }, req.headers.authorization, { fetchImpl, timeoutMs: 15000 });
        let sample = "";
        try { sample = String(result.obj.choices[0].message.content || "").slice(0, 80); } catch { sample = ""; }
        return sendJson(res, 200, {
          ok: result.status === 200,
          provider: name,
          upstream: provider.upstream,
          model: testModel,
          status: result.status,
          ms: Date.now() - started,
          sample,
          error: result.status === 200 ? "" : String(result.text).slice(0, 300)
        });
      }

      if (pathname === "/api/stats") {
        const entries = readTail(requestsLog, 400);
        const summary = summarize(entries);
        const lastFails = entries.filter((entry) => !entry.ok).slice(-5).reverse();
        const config = getConfig();
        return sendJson(res, 200, Object.assign({}, summary, {
          uptimeMs: Date.now() - startedAt,
          providers: Object.keys(config.providers || {}),
          defaultProvider: config.defaultProvider,
          searchMode: config.search.mode,
          lastFails
        }));
      }

      if (pathname === "/api/logs") {
        const limit = Number(url.searchParams.get("n")) || 50;
        return sendJson(res, 200, { entries: readTail(requestsLog, limit).reverse() });
      }

      if (pathname === "/api/history") {
        const limit = Number(url.searchParams.get("n")) || 50;
        return sendJson(res, 200, { entries: history.readTail(historyLog, limit).reverse() });
      }

      if (pathname === "/api/history.csv") {
        const limit = Number(url.searchParams.get("n")) || 5000;
        const csv = history.toCsv(history.readTail(historyLog, limit));
        res.writeHead(200, Object.assign({}, CORS, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"ocs-ai-relay-history.csv\""
        }));
        // 带 BOM，Excel 打开中文不乱码
        return res.end("\ufeff" + csv);
      }

      if (pathname === "/search") {
        const query = url.searchParams.get("q") || "";
        const config = getConfig();
        try {
          const items = await searchBing(query, { topN: config.search.topN, timeoutMs: config.search.timeoutMs, fetchImpl });
          return sendJson(res, 200, { query, items });
        } catch (error) {
          return sendJson(res, 502, { query, error: String((error && error.message) || error) });
        }
      }

      if (pathname === "/v1/chat/completions" && req.method === "POST") {
        const bodyText = await readBody(req);
        const payload = safeParse(bodyText);
        if (!payload) return sendJson(res, 400, { error: { message: "invalid json body" } });
        const result = await answerQuestion({
          payload,
          authHeader: req.headers.authorization,
          config: getConfig(),
          searchCache,
          fetchImpl,
          log: (entry) => appendLog(requestsLog, Object.assign({ ts: new Date().toISOString() }, entry))
        });
        // 每道题一条结构化记录（题目 / 选项 / 答案 / 上游 / 耗时），落本机 history.jsonl
        try {
          history.append(historyLog, {
            ts: new Date().toISOString(),
            question: result.meta.question,
            options: result.meta.options,
            answer: result.meta.answer,
            provider: result.meta.provider,
            model: result.meta.model,
            searched: result.meta.searched,
            judgementMapped: result.meta.mappedJudgement,
            ms: result.meta.ms
          });
        } catch { /* 记录失败不能影响答题 */ }
        return sendJson(res, result.status, result.text);
      }

      return sendJson(res, 404, { error: { message: "not found" } });
    } catch (error) {
      console.error("relay error:", (error && error.stack) || error);
      try {
        res.writeHead(500, Object.assign({}, CORS, { "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: { message: String((error && error.message) || error) } }));
      } catch { /* client already gone */ }
    }
  });

  return { server, searchCache, getConfig };
}

if (require.main === module) {
  const config = loadConfig();
  const { server } = createRelayServer();
  server.listen(config.port, config.host, () => {
    const base = "http://" + config.host + ":" + config.port;
    console.log("ocs-ai-relay v" + VERSION + " listening on " + base);
    console.log("control panel: " + base + "/");
    console.log("providers: " + Object.keys(config.providers).join(", ") + " (default: " + config.defaultProvider + ")");
    if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.warn("warning: host is " + config.host + " - the relay is exposed beyond localhost");
    }
  });
  server.on("error", (error) => {
    console.error("server error:", (error && error.stack) || error);
    process.exit(1);
  });
}

module.exports = { createRelayServer, buildPatch, VERSION };
