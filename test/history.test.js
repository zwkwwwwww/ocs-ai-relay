"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inferType, normalizeRecord, append, readTail, toCsv } = require("../lib/history");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-history-"));

test("infers question type from options", () => {
  assert.equal(inferType("题目：1+1=2。（）\n选项：对\n错"), "judgement");
  assert.equal(inferType("题目：首都是？\n选项：A. 上海\nB. 北京"), "choice");
  assert.equal(inferType("题目：____ 是中国首都。"), "completion");
});

test("normalizes a record and fills defaults", () => {
  const record = normalizeRecord({ question: "题目：首都是？\n选项：A. 上海\nB. 北京", answer: "B", provider: "magpie", ms: 1200 });
  assert.equal(record.type, "choice");
  assert.deepEqual(record.options, ["上海", "北京"]);
  assert.equal(record.answer, "B");
  assert.equal(record.searched, false);
  assert.ok(record.ts);
});

test("appends and reads back records in order", () => {
  const file = path.join(tmp, "history.jsonl");
  append(file, { question: "题目：1+1=2。（）\n选项：对\n错", answer: "对", provider: "magpie", judgementMapped: true, ms: 900 });
  append(file, { question: "题目：首都是？\n选项：A. 上海\nB. 北京", answer: "B", provider: "apigoto", searched: true, ms: 1500 });
  const rows = readTail(file, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].answer, "对");
  assert.equal(rows[0].type, "judgement");
  assert.equal(rows[1].type, "choice");
  assert.equal(rows[1].searched, true);
});

test("exports csv with escaped quotes", () => {
  const csv = toCsv([{ ts: "2026-01-01T00:00:00.000Z", question: 'he said "hi"', answer: "A", options: ["A. x"] }]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].indexOf("题目") >= 0);
  assert.ok(lines[1].indexOf('"he said ""hi"""') >= 0);
});

test("returns empty list for a missing file", () => {
  assert.deepEqual(readTail(path.join(tmp, "nope.jsonl"), 5), []);
});
