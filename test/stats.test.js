"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { computeBatches } = require("../lib/stats");

const base = Date.parse("2026-11-24T10:00:00.000Z");
const at = (minutes) => new Date(base + minutes * 60000).toISOString();

test("splits answers into batches by idle gap", () => {
  const rows = [
    { ts: at(0), ms: 1000, type: "choice", provider: "magpie" },
    { ts: at(1), ms: 2000, type: "choice", provider: "magpie" },
    { ts: at(2), ms: 3000, type: "judgement", provider: "apigoto" },
    { ts: at(40), ms: 1500, type: "choice", provider: "magpie" }
  ];
  const batches = computeBatches(rows, 10 * 60 * 1000);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].count, 3);
  assert.equal(batches[0].avgMs, 2000);
  assert.equal(batches[0].providers.magpie, 2);
  assert.equal(batches[0].types.judgement, 1);
  assert.equal(batches[1].count, 1);
});

test("sorts unordered rows and ignores invalid timestamps", () => {
  const rows = [
    { ts: at(30), ms: 1000, type: "choice", provider: "a" },
    { ts: "not-a-date", ms: 999, type: "choice", provider: "a" },
    { ts: at(0), ms: 1000, type: "choice", provider: "a" }
  ];
  const batches = computeBatches(rows, 10 * 60 * 1000);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].count, 1);
  assert.equal(batches[1].count, 1);
});
