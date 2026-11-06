"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = process.env.OCS_RELAY_CONFIG || path.join(ROOT, "config.json");

const DEFAULT_CONFIG = {
  upstream: "https://api.example.com",
  apiKey: "",
  model: "",
  maxTokens: 2048,
  temperature: 0,
  retry: { attempts: 3, backoffMs: 400 },
  search: { mode: "always", engine: "bing", topN: 3, timeoutMs: 10000, cacheTtlMs: 600000 },
  judgementMap: true,
  host: "127.0.0.1",
  port: 8787
};

const SEARCH_MODES = ["always", "fallback", "off"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (isPlainObject(next) && isPlainObject(out[key])) out[key] = merge(out[key], next);
    else if (next !== undefined) out[key] = next;
  }
  return out;
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalize(raw) {
  const cfg = merge(DEFAULT_CONFIG, raw || {});
  cfg.upstream = String(cfg.upstream || "").trim().replace(/\/+$/, "");
  cfg.apiKey = String(cfg.apiKey || "").trim();
  cfg.model = String(cfg.model || "").trim();
  cfg.maxTokens = Math.round(clamp(cfg.maxTokens, 64, 32768, DEFAULT_CONFIG.maxTokens));
  cfg.temperature = clamp(cfg.temperature, 0, 2, 0);
  const retry = cfg.retry || {};
  cfg.retry = {
    attempts: Math.round(clamp(retry.attempts, 1, 5, 3)),
    backoffMs: Math.round(clamp(retry.backoffMs, 0, 5000, 400))
  };
  const search = cfg.search || {};
  cfg.search = {
    mode: SEARCH_MODES.indexOf(search.mode) >= 0 ? search.mode : "always",
    engine: "bing",
    topN: Math.round(clamp(search.topN, 1, 8, 3)),
    timeoutMs: Math.round(clamp(search.timeoutMs, 1000, 30000, 10000)),
    cacheTtlMs: Math.round(clamp(search.cacheTtlMs, 0, 3600000, 600000))
  };
  cfg.judgementMap = cfg.judgementMap !== false;
  cfg.host = String(cfg.host || "127.0.0.1").trim() || "127.0.0.1";
  cfg.port = Math.round(clamp(cfg.port, 1, 65535, 8787));
  return cfg;
}

let cached = null;
let cachedMtime = -1;

function loadConfig(force) {
  let mtime = 0;
  try { mtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { mtime = 0; }
  if (!force && cached && mtime === cachedMtime) return cached;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { raw = {}; }
  cached = normalize(raw);
  cachedMtime = mtime;
  return cached;
}

function saveConfig(patch) {
  const current = loadConfig(true);
  const next = normalize(merge(current, patch || {}));
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  cached = next;
  try { cachedMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { cachedMtime = -1; }
  return next;
}

function maskKey(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 8) return "****";
  return value.slice(0, 3) + "****" + value.slice(-4);
}

function publicConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  copy.apiKey = maskKey(cfg.apiKey);
  copy.hasApiKey = Boolean(cfg.apiKey);
  copy.configPath = CONFIG_PATH;
  return copy;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  SEARCH_MODES,
  loadConfig,
  saveConfig,
  normalize,
  publicConfig,
  maskKey
};
