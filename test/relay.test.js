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

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}

test("end-to-end: relay answers, maps judgement and exposes config API", async (t) => {
  // fake upstream: returns A for 对/错 questions, B otherwise, and empty content
  // with reasoning for questions marked SALVAGE.
  const upstream = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const last = body.messages[body.messages.length - 1].content;
    let message = { role: "assistant", content: "B" };
    if (last.indexOf("SALVAGE") >= 0) message = { role: "assistant", content: "", reasoning_content: "答案是 A" };
    else if (last.indexOf("对\n错") >= 0) message = { role: "assistant", content: "A" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: {} }));
  });

  const config = {
    upstream: "http://127.0.0.1:" + upstream.port,
    apiKey: "test-key",
    model: "test-model",
    maxTokens: 512,
    temperature: 0,
    retry: { attempts: 2, backoffMs: 0 },
    search: { mode: "off", engine: "bing", topN: 3, timeoutMs: 2000, cacheTtlMs: 0 },
    judgementMap: true,
    host: "127.0.0.1",
    port: 0
  };
  const logFile = path.join(tmp, "requests.jsonl");
  const relay = createRelayServer({ getConfig: () => config, requestsLog: logFile });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + relay.server.address().port;
  t.after(() => { relay.server.close(); upstream.server.close(); });

  const health = await fetch(base + "/health").then((r) => r.json());
  assert.equal(health.ok, true);

  const single = await postJson(base + "/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "题目：首都是？\n选项：A. 上海\nB. 北京" }]
  });
  assert.equal(single.status, 200);
  assert.equal(single.json.choices[0].message.content, "B");

  const judgement = await postJson(base + "/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "题目：1+1=2。\n选项：对\n错" }]
  });
  assert.equal(judgement.json.choices[0].message.content, "对");

  const salvage = await postJson(base + "/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "SALVAGE 题目：某题" }]
  });
  assert.equal(salvage.json.choices[0].message.content, "A");

  const configResponse = await fetch(base + "/api/config").then((r) => r.json());
  assert.equal(configResponse.hasApiKey, true);
  assert.notEqual(configResponse.apiKey, "test-key");

  const saved = await postJson(base + "/api/config", { search: { mode: "fallback", topN: 5 } });
  assert.equal(saved.status, 200);

  const logs = await fetch(base + "/api/logs?n=5").then((r) => r.json());
  assert.ok(Array.isArray(logs.entries));
});
