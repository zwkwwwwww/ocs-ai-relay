"use strict";

const DEFAULT_GAP_MS = 10 * 60 * 1000;

function computeBatches(rows, gapMs) {
  const gap = Number(gapMs) > 0 ? Number(gapMs) : DEFAULT_GAP_MS;
  const sorted = (rows || [])
    .filter((row) => row && row.ts)
    .map((row) => Object.assign({}, row, { _t: Date.parse(row.ts) }))
    .filter((row) => Number.isFinite(row._t))
    .sort((a, b) => a._t - b._t);

  const batches = [];
  let current = null;

  for (const row of sorted) {
    if (!current || row._t - current.end > gap) {
      if (current) batches.push(current);
      current = { start: row._t, end: row._t, count: 0, totalMs: 0, types: {}, providers: {}, searched: 0 };
    }
    current.end = row._t;
    current.count += 1;
    const ms = Number(row.ms);
    if (Number.isFinite(ms) && ms > 0) current.totalMs += ms;
    const type = row.type || "unknown";
    current.types[type] = (current.types[type] || 0) + 1;
    const provider = row.provider || "unknown";
    current.providers[provider] = (current.providers[provider] || 0) + 1;
    if (row.searched) current.searched += 1;
  }
  if (current) batches.push(current);

  return batches.map((batch, index) => ({
    index: index + 1,
    start: new Date(batch.start).toISOString(),
    end: new Date(batch.end).toISOString(),
    count: batch.count,
    durationMs: Math.max(0, batch.end - batch.start),
    avgMs: batch.count ? Math.round(batch.totalMs / batch.count) : 0,
    searched: batch.searched,
    types: batch.types,
    providers: batch.providers
  }));
}

module.exports = { DEFAULT_GAP_MS, computeBatches };
