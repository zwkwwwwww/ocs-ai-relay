"use strict";
const fs = require("node:fs");

function appendLog(file, entry) {
  try { fs.appendFileSync(file, JSON.stringify(entry) + "\n"); } catch { /* logging must never break requests */ }
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

function summarize(entries) {
  const total = entries.length;
  const fails = entries.filter((entry) => !entry.ok).length;
  const searched = entries.filter((entry) => entry.searched).length;
  const durations = entries.map((entry) => Number(entry.ms)).filter((value) => Number.isFinite(value) && value > 0);
  const avgMs = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0;
  return { total, fails, searched, avgMs };
}

module.exports = { appendLog, readTail, summarize };
