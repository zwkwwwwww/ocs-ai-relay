"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-"));
process.env.OCS_RELAY_CONFIG = path.join(tmp, "config.json");

const { loadConfig, saveConfig, normalize, publicConfig, maskKey, resolveProvider, matchModel } = require("../lib/config");

test("loads defaults when config file is missing", () => {
  const config = loadConfig(true);
  assert.equal(config.port, 8787);
  assert.equal(config.search.mode, "always");
  assert.equal(config.judgementMap, true);
  assert.ok(config.providers.default);
  assert.equal(config.defaultProvider, "default");
});

test("migrates legacy upstream/apiKey into a default provider", () => {
  const config = normalize({ upstream: "https://legacy.example.com/", apiKey: "sk-legacy-123456" });
  assert.equal(config.providers.default.upstream, "https://legacy.example.com");
  assert.equal(config.providers.default.apiKey, "sk-legacy-123456");
  assert.equal(config.defaultProvider, "default");
});

test("save then load keeps multiple providers and routes", () => {
  const saved = saveConfig({
    providers: {
      primary: { upstream: "https://a.example.com", apiKey: "sk-primary-123456", enabled: true },
      local: { upstream: "http://127.0.0.1:3425", apiKey: "magpie", enabled: true }
    },
    defaultProvider: "primary",
    routes: [{ model: "auto/*", provider: "local" }],
    search: { mode: "fallback", topN: 5 }
  });
  assert.equal(saved.providers.local.upstream, "http://127.0.0.1:3425");
  const loaded = loadConfig(true);
  assert.equal(Object.keys(loaded.providers).length, 2);
  assert.equal(loaded.routes[0].model, "auto/*");
  assert.equal(loaded.search.mode, "fallback");
});

test("drops routes pointing at unknown providers", () => {
  const config = normalize({
    providers: { a: { upstream: "https://a.example.com" } },
    defaultProvider: "a",
    routes: [{ model: "x/*", provider: "missing" }, { model: "y/*", provider: "a" }]
  });
  assert.equal(config.routes.length, 1);
  assert.equal(config.routes[0].provider, "a");
});

test("normalize clamps out-of-range values", () => {
  const config = normalize({ maxTokens: 999999, temperature: -5, search: { mode: "bogus", topN: 99 }, retry: { attempts: 99 } });
  assert.equal(config.maxTokens, 32768);
  assert.equal(config.temperature, 0);
  assert.equal(config.search.mode, "always");
  assert.equal(config.search.topN, 8);
  assert.equal(config.retry.attempts, 5);
});

test("publicConfig masks every provider key", () => {
  const config = normalize({
    providers: { a: { upstream: "https://a.example.com", apiKey: "sk-1234567890abcdef" }, b: { upstream: "https://b.example.com" } },
    defaultProvider: "a"
  });
  const pub = publicConfig(config);
  assert.notEqual(pub.providers.a.apiKey, "sk-1234567890abcdef");
  assert.equal(pub.providers.a.hasApiKey, true);
  assert.equal(pub.providers.b.hasApiKey, false);
  assert.equal(maskKey("short"), "****");
});

test("routes models to providers by exact match, glob and default", () => {
  const config = normalize({
    providers: {
      primary: { upstream: "https://a.example.com" },
      local: { upstream: "http://127.0.0.1:3425" }
    },
    defaultProvider: "primary",
    routes: [
      { model: "auto/*", provider: "local" },
      { model: "group/group", provider: "local" }
    ]
  });
  assert.equal(resolveProvider(config, "auto/deepseek-v4.1-flash"), "local");
  assert.equal(resolveProvider(config, "group/group"), "local");
  assert.equal(resolveProvider(config, "deepseek-flash"), "primary");
  assert.equal(resolveProvider(config, "unknown-model"), "primary");
});

test("disabled providers are never selected", () => {
  const config = normalize({
    providers: {
      primary: { upstream: "https://a.example.com" },
      local: { upstream: "http://127.0.0.1:3425", enabled: false }
    },
    defaultProvider: "primary",
    routes: [{ model: "auto/*", provider: "local" }]
  });
  assert.equal(resolveProvider(config, "auto/x"), "primary");
  assert.equal(matchModel("auto/*", "auto/x"), true);
  assert.equal(matchModel("auto/*", "group/x"), false);
});
