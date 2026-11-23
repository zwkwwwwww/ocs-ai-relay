"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseBingHtml, stripTags, createSearchCache, searchBing, parseNativeSearch } = require("../lib/search");

const FIXTURE = [
  '<ol id="b_results">',
  '<li class="b_algo"><h2><a href="https://a.example">蒙太奇 - 维基百科</a></h2><p>蒙太奇是电影剪辑手法。</p></li>',
  '<li class="b_algo"><h2><a href="https://b.example">什么是蒙太奇？</a></h2><p>通过镜头组接产生新含义。</p></li>',
  '<li class="b_algo"><h2><a href="https://c.example">第三篇</a></h2><p>第三条摘要。</p></li>',
  "</ol>"
].join("");

test("strips tags and decodes entities", () => {
  assert.equal(stripTags("<b>a</b>&nbsp;b &amp; c"), "a b & c");
});

test("parses bing result blocks", () => {
  const items = parseBingHtml(FIXTURE, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "蒙太奇 - 维基百科");
  assert.equal(items[0].snippet, "蒙太奇是电影剪辑手法。");
});

test("search cache reuses results but never caches empties", async () => {
  const cache = createSearchCache({ ttlMs: 10000 });
  let calls = 0;
  const loader = async () => { calls += 1; return [{ title: "t", snippet: "s" }]; };
  await cache.get("same question", loader);
  await cache.get("same question", loader);
  assert.equal(calls, 1);

  let emptyCalls = 0;
  const emptyLoader = async () => { emptyCalls += 1; return []; };
  await cache.get("empty", emptyLoader);
  await cache.get("empty", emptyLoader);
  assert.equal(emptyCalls, 2, "empty results must not be cached");
});

test("retries bing with a second locale when the first page is empty", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { ok: true, text: async () => "<html></html>" };
    return { ok: true, text: async () => FIXTURE };
  };
  const items = await searchBing("蒙太奇", { topN: 2, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(items.length, 2);
  assert.ok(calls[0].includes("mkt=zh-CN"));
  assert.ok(calls[1].includes("mkt=en-US"));
});

test("parses native search annotations from a responses payload", () => {
  const payload = {
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "答案",
            annotations: [
              { type: "url_citation", url: "https://example.com/a", title: "来源 A", text: "摘要 A" },
              { type: "url_citation", url: "https://example.com/b", title: "来源 B" }
            ]
          }
        ]
      }
    ]
  };
  const items = parseNativeSearch(payload);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "来源 A");
  assert.equal(items[1].title, "来源 B");
});

test("parses native citations from a chat completions payload", () => {
  const payload = {
    choices: [{ message: { content: "答案", annotations: [{ url: "https://example.com/c", title: "来源 C", text: "摘要 C" }] } }]
  };
  const items = parseNativeSearch(payload);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "来源 C");
});
