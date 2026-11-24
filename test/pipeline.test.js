"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { answerQuestion } = require("../lib/pipeline");
const { createSearchCache } = require("../lib/search");
const { normalize } = require("../lib/config");

test("native backend searches via provider web_search and re-asks with references", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.indexOf("/v1/responses") >= 0) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "答案", annotations: [{ url: "https://example.com", title: "来源 A", text: "摘要 A" }] }] }]
        })
      };
    }
    const body = JSON.parse(options.body);
    const hasReferences = JSON.stringify(body.messages).indexOf("网络参考资料") >= 0;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: hasReferences ? "C" : "B" }, finish_reason: "stop" }] })
    };
  };

  const config = normalize({
    providers: { stub: { upstream: "http://stub.local" } },
    defaultProvider: "stub",
    search: { mode: "always", backend: "native", topN: 2 },
    judgementMap: false
  });

  const result = await answerQuestion({
    payload: { model: "auto/x", messages: [{ role: "user", content: "题目：哪个选项正确？\n选项：A. 甲\nB. 乙\nC. 丙" }] },
    config,
    searchCache: createSearchCache({}),
    fetchImpl,
    log: () => {}
  });

  assert.equal(result.meta.searchBackend, "native");
  assert.equal(result.obj.choices[0].message.content, "C");
  assert.ok(calls.some((url) => url.indexOf("/v1/responses") >= 0));
  assert.equal(calls.filter((url) => url.indexOf("/v1/chat/completions") >= 0).length, 2);
});

test("bing backend is skipped when mode is off", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: "B" }, finish_reason: "stop" }] }) };
  };
  const config = normalize({
    providers: { stub: { upstream: "http://stub.local" } },
    defaultProvider: "stub",
    search: { mode: "off", backend: "auto" },
    judgementMap: false
  });
  const result = await answerQuestion({
    payload: { model: "m", messages: [{ role: "user", content: "题目：x" }] },
    config,
    searchCache: createSearchCache({}),
    fetchImpl,
    log: () => {}
  });
  assert.equal(result.meta.searched, false);
  assert.equal(urls.length, 1);
});
