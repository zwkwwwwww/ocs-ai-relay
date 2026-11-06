"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-"));
process.env.OCS_RELAY_CONFIG = path.join(tmp, "config.json");

const { loadConfig, saveConfig, normalize, publicConfig, maskKey } = require("../lib/config");

test("loads defaults when config file is missing", () => {
  const config = loadConfig(true);
  assert.equal(config.port, 8787);
  assert.equal(config.search.mode, "always");
  assert.equal(config.judgementMap, true);
});

test("save then load roundtrip", () => {
  const saved = saveConfig({ upstream: "https://api.example.org/", apiKey: "sk-secret-123456", search: { mode: "fallback", topN: 5 } });
  assert.equal(saved.upstream, "https://api.example.org");
  const loaded = loadConfig(true);
  assert.equal(loaded.apiKey, "sk-secret-123456");
  assert.equal(loaded.search.mode, "fallback");
  assert.equal(loaded.search.topN, 5);
});

test("normalize clamps out-of-range values", () => {
  const config = normalize({ maxTokens: 999999, temperature: -5, search: { mode: "bogus", topN: 99 }, retry: { attempts: 99 } });
  assert.equal(config.maxTokens, 32768);
  assert.equal(config.temperature, 0);
  assert.equal(config.search.mode, "always");
  assert.equal(config.search.topN, 8);
  assert.equal(config.retry.attempts, 5);
});

test("publicConfig masks the api key", () => {
  const config = normalize({ apiKey: "sk-1234567890abcdef" });
  const pub = publicConfig(config);
  assert.notEqual(pub.apiKey, "sk-1234567890abcdef");
  assert.equal(pub.hasApiKey, true);
  assert.equal(maskKey("short"), "****");
});
