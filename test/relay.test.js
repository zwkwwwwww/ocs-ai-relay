"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-"));
process.env.OCS_RELAY_CONFIG = path.join(tmp, "config.json");

const { createRelayServer } = require("../relay");
const { normalize } = require("../lib/config");

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// 假上游：GET /v1/models 返回模型目录，POST 走 answer(payload)
function fakeUpstream(answer, status) {
  return startServer(async (req, res) => {
    if (req.method === "GET" && req.url.indexOf("/v1/models") >= 0) {
      return sendJson(res, 200, { data: [{ id: "test-model" }] });
    }
    const raw = await readBody(req);
    if (status && status !== 200) {
      return sendJson(res, status, { error: { message: "upstream down" } });
    }
    let payload = {};
    try { payload = JSON.parse(raw); } catch { payload = {}; }
    return sendJson(res, 200, { choices: [{ message: answer(payload), finish_reason: "stop" }], usage: {} });
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}

test("routes by model, fails over between providers and maps judgement", async (t) => {
  const primary = await fakeUpstream(null, 500);
  const backup = await fakeUpstream((payload) => {
    const last = payload.messages[payload.messages.length - 1].content;
    if (last.indexOf("SALVAGE") >= 0) return { role: "assistant", content: "", reasoning_content: "答案是 A" };
    if (last.indexOf("对\n错") >= 0) return { role: "assistant", content: "A" };
    return { role: "assistant", content: "B" };
  });
  const local = await fakeUpstream((payload) => {
    const last = payload.messages[payload.messages.length - 1].content;
    if (last.indexOf("对\n错") >= 0) return { role: "assistant", content: "B" };
    return { role: "assistant", content: "C" };
  });

  const config = normalize({
    providers: {
      down: { upstream: "http://127.0.0.1:" + primary.port, apiKey: "k1" },
      backup: { upstream: "http://127.0.0.1:" + backup.port, apiKey: "k2" },
      local: { upstream: "http://127.0.0.1:" + local.port, apiKey: "magpie" }
    },
    defaultProvider: "down",
    routes: [{ model: "auto/*", provider: "local" }],
    retry: { attempts: 1, backoffMs: 0 },
    search: { mode: "off", topN: 3, timeoutMs: 2000, cacheTtlMs: 0 },
    judgementMap: true
  });

  const logFile = path.join(tmp, "requests.jsonl");
  const historyFile = path.join(tmp, "history.jsonl");
  const relay = createRelayServer({ getConfig: () => config, requestsLog: logFile, historyLog: historyFile });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + relay.server.address().port;
  t.after(() => {
    relay.server.close();
    primary.server.close();
    backup.server.close();
    local.server.close();
  });

  const health = await fetch(base + "/health").then((r) => r.json());
  assert.equal(health.ok, true);
  assert.deepEqual(health.providers.sort(), ["backup", "down", "local"]);

  // 默认上游 500 -> 自动切到 backup
  const failover = await postJson(base + "/v1/chat/completions", {
    model: "deepseek-flash",
    messages: [{ role: "user", content: "题目：首都是？\n选项：A. 上海\nB. 北京" }]
  });
  assert.equal(failover.status, 200);
  assert.equal(failover.json.choices[0].message.content, "B");

  // auto/* 路由到 local，判断题字母映射为文字
  const routed = await postJson(base + "/v1/chat/completions", {
    model: "auto/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "题目：1+1=2。\n选项：对\n错" }]
  });
  assert.equal(routed.status, 200);
  assert.equal(routed.json.choices[0].message.content, "错");

  // 空 content + reasoning 兜底
  const salvage = await postJson(base + "/v1/chat/completions", {
    model: "deepseek-flash",
    messages: [{ role: "user", content: "SALVAGE 题目：某题" }]
  });
  assert.equal(salvage.json.choices[0].message.content, "A");

  const configResponse = await fetch(base + "/api/config").then((r) => r.json());
  assert.equal(configResponse.providers.backup.hasApiKey, true);
  assert.notEqual(configResponse.providers.backup.apiKey, "k2");

  // /api/test 会自动从 /v1/models 取模型名
  const testResult = await postJson(base + "/api/test", { provider: "local" });
  assert.equal(testResult.json.provider, "local");
  assert.equal(testResult.json.model, "test-model");
  assert.equal(testResult.json.ok, true);

  const logs = await fetch(base + "/api/logs?n=10").then((r) => r.json());
  assert.ok(Array.isArray(logs.entries));

  // 每答一题都要落一条结构化记录
  const historyResponse = await fetch(base + "/api/history?n=10").then((r) => r.json());
  assert.equal(historyResponse.entries.length >= 3, true);
  const latest = historyResponse.entries[0];
  assert.equal(typeof latest.question, "string");
  assert.equal(typeof latest.answer, "string");
  assert.ok(["judgement", "choice", "completion"].indexOf(latest.type) >= 0);
  assert.ok(latest.provider);

  // CSV 导出可用
  const csv = await fetch(base + "/api/history.csv").then((r) => r.text());
  assert.ok(csv.indexOf("题目") >= 0);
  assert.ok(csv.indexOf("答案") >= 0);

  // 记录筛选：按类型 / 关键词 / 分页
  const onlyJudgement = await fetch(base + "/api/history?type=judgement").then((r) => r.json());
  assert.equal(onlyJudgement.entries.length >= 1, true);
  assert.equal(onlyJudgement.entries.every((row) => row.type === "judgement"), true);

  const keyword = await fetch(base + "/api/history?q=" + encodeURIComponent("首都")).then((r) => r.json());
  assert.equal(keyword.entries.every((row) => row.question.indexOf("首都") >= 0), true);

  const paged = await fetch(base + "/api/history?n=1&offset=0").then((r) => r.json());
  assert.equal(paged.entries.length, 1);
  assert.equal(paged.total >= 3, true);

  // 概览聚合
  const overview = await fetch(base + "/api/overview").then((r) => r.json());
  assert.equal(overview.totalAnswers >= 3, true);
  assert.equal(overview.buckets.length, 24);
  assert.equal(overview.providers.length, 3);
  assert.equal(typeof overview.avgMs, "number");

  // 路由解析
  const resolved = await fetch(base + "/api/routes/resolve?model=" + encodeURIComponent("auto/deepseek-v4.1-flash")).then((r) => r.json());
  assert.equal(resolved.provider, "local");
  const fallbackRoute = await fetch(base + "/api/routes/resolve?model=deepseek-flash").then((r) => r.json());
  assert.equal(fallbackRoute.provider, "down");

  // 批量测试
  const testAll = await postJson(base + "/api/providers/test-all", {});
  assert.equal(Array.isArray(testAll.json.results), true);
  const localResult = testAll.json.results.find((item) => item.provider === "local");
  assert.equal(localResult.ok, true);

  // 清空记录
  const cleared = await postJson(base + "/api/history/clear", {});
  assert.equal(cleared.json.ok, true);
  const afterClear = await fetch(base + "/api/history").then((r) => r.json());
  assert.equal(afterClear.total, 0);
});
