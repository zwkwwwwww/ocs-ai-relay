"use strict";

async function callModel(provider, payload, authHeader, options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = Number(opts.timeoutMs) || 45000;
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
  else if (authHeader) headers.Authorization = authHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(provider.upstream + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let obj = null;
    try { obj = JSON.parse(text); } catch { obj = null; }
    return { status: response.status, text, obj };
  } catch (error) {
    return { status: 0, text: JSON.stringify({ error: { message: String((error && error.message) || error) } }), obj: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callModel };
