"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = process.env.OCS_RELAY_CONFIG || path.join(ROOT, "config.json");

const DEFAULT_PROVIDER = {
  upstream: "https://api.example.com",
  apiKey: "",
  enabled: true
};

const DEFAULT_CONFIG = {
  providers: { default: Object.assign({}, DEFAULT_PROVIDER) },
  defaultProvider: "default",
  routes: [],
  model: "",
  maxTokens: 2048,
  temperature: 0,
  retry: { attempts: 3, backoffMs: 400 },
  search: { mode: "always", backend: "auto", engine: "bing", topN: 3, timeoutMs: 10000, cacheTtlMs: 600000 },
  judgementMap: true,
  host: "127.0.0.1",
  port: 8787
};

const SEARCH_MODES = ["always", "fallback", "off"];
const SEARCH_BACKENDS = ["auto", "native", "bing"];

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

function normalizeProvider(raw) {
  const provider = isPlainObject(raw) ? raw : {};
  return {
    upstream: String(provider.upstream || "").trim().replace(/\/+$/, ""),
    apiKey: String(provider.apiKey || "").trim(),
    enabled: provider.enabled !== false
  };
}

function normalizeProviders(raw) {
  const providers = {};
  if (isPlainObject(raw) && Object.keys(raw).length) {
    for (const name of Object.keys(raw)) {
      const key = String(name || "").trim();
      if (!key) continue;
      providers[key] = normalizeProvider(raw[name]);
    }
  }
  return providers;
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function matchModel(pattern, model) {
  if (!pattern || !model) return false;
  if (pattern === model) return true;
  if (pattern.indexOf("*") < 0 && pattern.indexOf("?") < 0) return false;
  try { return globToRegExp(pattern).test(model); } catch { return false; }
}

function normalizeRoutes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((route) => isPlainObject(route) && route.model && route.provider)
    .map((route) => ({ model: String(route.model).trim(), provider: String(route.provider).trim() }));
}

function normalize(raw) {
  const cfg = merge(DEFAULT_CONFIG, raw || {});

  // providers 是整体替换，不能和默认值深合并（否则会凭空多出一个 example.com 上游）
  const suppliedProviders = isPlainObject(raw) && isPlainObject(raw.providers) && Object.keys(raw.providers).length
    ? normalizeProviders(raw.providers)
    : null;

  if (suppliedProviders && Object.keys(suppliedProviders).length) {
    cfg.providers = suppliedProviders;
  } else if (isPlainObject(raw) && (raw.upstream || raw.apiKey)) {
    // 兼容旧版：只有 upstream/apiKey 时，迁移成 default provider
    cfg.providers = { default: normalizeProvider({ upstream: raw.upstream, apiKey: raw.apiKey, enabled: true }) };
    cfg.defaultProvider = "default";
  } else {
    cfg.providers = normalizeProviders(cfg.providers);
  }

  if (!Object.keys(cfg.providers).length) {
    cfg.providers = { default: Object.assign({}, DEFAULT_PROVIDER) };
  }
  if (!cfg.providers[cfg.defaultProvider]) {
    cfg.defaultProvider = Object.keys(cfg.providers)[0];
  }
  cfg.routes = normalizeRoutes(cfg.routes).filter((route) => Boolean(cfg.providers[route.provider]));

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
    backend: SEARCH_BACKENDS.indexOf(search.backend) >= 0 ? search.backend : "auto",
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

function resolveProvider(config, model) {
  const names = Object.keys(config.providers || {}).filter((name) => config.providers[name].enabled !== false);
  if (!names.length) return null;
  const routes = config.routes || [];
  const pick = (name) => (config.providers[name] && config.providers[name].enabled !== false ? name : null);

  for (const route of routes) {
    if (route.model === model) {
      const hit = pick(route.provider);
      if (hit) return hit;
    }
  }
  for (const route of routes) {
    if (matchModel(route.model, model)) {
      const hit = pick(route.provider);
      if (hit) return hit;
    }
  }
  if (pick(config.defaultProvider)) return config.defaultProvider;
  return names[0];
}

function providerOrder(config, model) {
  const primary = resolveProvider(config, model);
  const names = Object.keys(config.providers || {}).filter((name) => config.providers[name].enabled !== false);
  const ordered = [];
  if (primary) ordered.push(primary);
  for (const name of names) if (ordered.indexOf(name) < 0) ordered.push(name);
  return ordered;
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
  const incoming = patch || {};

  // providers 以"传入集合"为准：同名条目按字段合并（省略 apiKey 时保留原值），
  // 未传入的 provider 会被移除，避免旧配置残留在集合里。
  let base = current;
  if (isPlainObject(incoming.providers)) {
    const nextProviders = {};
    for (const name of Object.keys(incoming.providers)) {
      nextProviders[name] = Object.assign({}, current.providers[name] || {}, incoming.providers[name] || {});
    }
    base = Object.assign({}, current, { providers: nextProviders });
  }

  const next = normalize(merge(base, incoming));
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
  for (const name of Object.keys(copy.providers || {})) {
    const provider = copy.providers[name];
    provider.hasApiKey = Boolean(provider.apiKey);
    provider.apiKey = maskKey(provider.apiKey);
  }
  copy.configPath = CONFIG_PATH;
  return copy;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  SEARCH_MODES,
  SEARCH_BACKENDS,
  loadConfig,
  saveConfig,
  normalize,
  publicConfig,
  maskKey,
  resolveProvider,
  providerOrder,
  matchModel
};
