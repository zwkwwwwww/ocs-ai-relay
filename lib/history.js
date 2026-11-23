"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parseOptions, isJudgement } = require("./judge");

function inferType(question, options) {
  const opts = Array.isArray(options) && options.length ? options : parseOptions(question);
  if (isJudgement(opts)) return "judgement";
  if (opts.length >= 2) return "choice";
  return "completion";
}

function normalizeRecord(record) {
  const item = record || {};
  const rawOptions = Array.isArray(item.options) && item.options.length ? item.options : parseOptions(item.question);
  const options = rawOptions.map((option) => String(option).slice(0, 300));
  return {
    ts: String(item.ts || new Date().toISOString()),
    type: String(item.type || inferType(item.question, options)),
    question: String(item.question || "").slice(0, 2000),
    options,
    answer: String(item.answer || "").slice(0, 500),
    provider: String(item.provider || ""),
    model: String(item.model || ""),
    searched: item.searched === true,
    judgementMapped: item.judgementMapped === true,
    ms: Number.isFinite(Number(item.ms)) ? Number(item.ms) : 0
  };
}

function append(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(normalizeRecord(record)) + "\n");
  return true;
}

function readTail(file, limit) {
  const max = Math.max(1, Number(limit) || 50);
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-max).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function csvCell(value) {
  const text = String(value === undefined || value === null ? "" : value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function toCsv(records) {
  const header = ["时间", "类型", "题目", "选项", "答案", "上游", "模型", "联网", "耗时ms"];
  const rows = (records || []).map((record) => {
    const item = normalizeRecord(record);
    return [
      item.ts,
      item.type,
      item.question,
      item.options.join(" / "),
      item.answer,
      item.provider,
      item.model,
      item.searched ? "是" : "否",
      item.ms
    ].map(csvCell).join(",");
  });
  return [header.map(csvCell).join(",")].concat(rows).join("\r\n") + "\r\n";
}

module.exports = { inferType, normalizeRecord, append, readTail, toCsv, csvCell };
