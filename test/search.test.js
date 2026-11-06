"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseBingHtml, stripTags, createSearchCache } = require("../lib/search");

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

test("search cache reuses results", async () => {
  const cache = createSearchCache({ ttlMs: 10000 });
  let calls = 0;
  const loader = async () => { calls += 1; return [{ title: "t", snippet: "s" }]; };
  await cache.get("same question", loader);
  await cache.get("same question", loader);
  assert.equal(calls, 1);
  assert.equal(cache.size(), 1);
});
