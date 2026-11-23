"use strict";
const { mapJudgementAnswer, lastLetter, parseOptions } = require("./judge");
const { callModel } = require("./model");
const { searchBing } = require("./search");
const { providerOrder } = require("./config");

const UNCERTAIN = /不确定|无法确定|无法回答|无法判断|无法确认|无法获取|不知道|没有找到|抱歉|无法提供|无法得知|不清楚/;
const NEED_SEARCH = /最新|最近|今年|今日|目前|现在|截至|20\d\d|新闻|政策|发布|版本|价格|股价|天气|获奖|名单|排名/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function questionOf(payload) {
  const messages = (payload && payload.messages) || [];
  const user = [...messages].reverse().find((message) => message && message.role === "user");
  return user ? String(user.content || "") : "";
}

function contentOf(obj) {
  return String((obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || "");
}

function reasoningOf(obj) {
  return String((obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.reasoning_content) || "");
}

function finishOf(obj) {
  return String((obj && obj.choices && obj.choices[0] && obj.choices[0].finish_reason) || "");
}

function stripQuestion(question) {
  return String(question || "")
    .replace(/题目[:：]\s*/, "")
    .replace(/选项[:：][\s\S]*$/, "")
    .slice(0, 120)
    .trim();
}

function withReferences(payload, references) {
  const messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  const index = messages.map((message) => message && message.role).lastIndexOf("user");
  if (index >= 0) {
    messages[index] = Object.assign({}, messages[index], {
      content: String(messages[index].content) + "\n\n【网络参考资料】（可能不准确，仅作核对，仍需按题目要求作答）\n" + references
    });
  }
  return Object.assign({}, payload, { messages, temperature: 0 });
}

function applyJudgement(question, result) {
  const content = contentOf(result.obj);
  const mapped = mapJudgementAnswer(question, content);
  if (result.obj && mapped !== content && result.obj.choices && result.obj.choices[0] && result.obj.choices[0].message) {
    result.obj.choices[0].message.content = mapped;
    result.text = JSON.stringify(result.obj);
    return { content: mapped, mapped: true };
  }
  return { content, mapped: false };
}

function shouldSearch(config, question, answer) {
  const mode = config.search.mode;
  if (mode === "off") return false;
  if (mode === "always") return true;
  return UNCERTAIN.test(answer) || NEED_SEARCH.test(question) || answer.trim().length > 40;
}

async function answerQuestion(options) {
  const payload = options.payload;
  const authHeader = options.authHeader;
  const config = options.config;
  const searchCache = options.searchCache;
  const fetchImpl = options.fetchImpl;
  const log = options.log || (() => {});
  const startedAt = Date.now();
  const question = questionOf(payload);
  const model = String((payload && payload.model) || config.model || "");
  const baseMax = Number(payload && payload.max_tokens) || Number(config.maxTokens) || 1024;
  const attempts = Math.max(1, Number(config.retry.attempts) || 3);
  const order = providerOrder(config, model);

  let last = null;
  let ok = false;
  let attemptsUsed = 0;
  let providerUsed = "";

  for (const providerName of order) {
    const provider = config.providers[providerName];
    if (!provider || provider.enabled === false) continue;
    providerUsed = providerName;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      attemptsUsed += 1;
      const requestPayload = attempt === 1
        ? payload
        : Object.assign({}, payload, {
            max_tokens: Math.min(8192, Math.max(1024, baseMax) * 2),
            temperature: 0
          });
      const result = await callModel(provider, requestPayload, authHeader, { fetchImpl });
      last = result;
      const content = contentOf(result.obj);
      const reasoning = reasoningOf(result.obj);
      ok = result.status === 200 && content.trim().length > 0;
      log({
        provider: providerName,
        attempt,
        status: result.status,
        finish: finishOf(result.obj),
        ok,
        ms: Date.now() - startedAt,
        q: question.slice(0, 160),
        content: content.slice(0, 120),
        reasoningLen: reasoning.length
      });
      if (ok) break;
      if (result.status === 200 && !content.trim() && reasoning) {
        const guess = lastLetter(reasoning);
        if (guess) {
          result.obj.choices[0].message.content = guess;
          result.text = JSON.stringify(result.obj);
          ok = true;
          log({ provider: providerName, attempt, salvaged: guess, ok: true, ms: Date.now() - startedAt });
          break;
        }
      }
      if (attempt < attempts) await sleep(Math.max(0, Number(config.retry.backoffMs) || 0) * attempt);
    }
    if (ok) break;
    if (order.indexOf(providerName) < order.length - 1) {
      log({ provider: providerName, fallback: true, note: "provider exhausted, trying next", ms: Date.now() - startedAt });
    }
  }

  let mappedJudgement = false;
  if (ok && config.judgementMap) {
    const outcome = applyJudgement(question, last);
    mappedJudgement = outcome.mapped;
    if (outcome.mapped) log({ provider: providerUsed, mappedJudgement: outcome.content, ok: true, ms: Date.now() - startedAt });
  }

  let searched = false;
  const answer = contentOf(last && last.obj);
  if (ok && shouldSearch(config, question, answer)) {
    searched = true;
    const query = stripQuestion(question);
    try {
      const items = await searchCache.get(query, (q) =>
        searchBing(q, { topN: config.search.topN, timeoutMs: config.search.timeoutMs, fetchImpl })
      );
      if (items.length) {
        const references = items.map((item, index) => (index + 1) + ". " + item.title + "：" + item.snippet).join("\n");
        const provider = config.providers[providerUsed] || config.providers[config.defaultProvider];
        // 带资料重问时 reasoning 会额外吃掉 token，必须给足额度，否则会拿到空 content
        const enriched = Object.assign(withReferences(payload, references), {
          max_tokens: Math.min(16384, Math.max(4096, baseMax * 2))
        });
        const second = await callModel(provider, enriched, authHeader, { fetchImpl });
        log({ provider: providerUsed, searched: true, query, hits: items.length, status: second.status, ms: Date.now() - startedAt });
        const secondContent = contentOf(second.obj);
        if (second.status === 200 && secondContent.trim() && !UNCERTAIN.test(secondContent)) {
          last = second;
          if (config.judgementMap) applyJudgement(question, second);
        }
      } else {
        log({ provider: providerUsed, searched: true, query, hits: 0, note: "search returned nothing" });
      }
    } catch (error) {
      log({ provider: providerUsed, searched: true, query, error: String((error && error.message) || error) });
    }
  }

  return {
    status: last && last.status ? last.status : 502,
    text: last ? last.text : JSON.stringify({ error: { message: "relay failed" } }),
    obj: last ? last.obj : null,
    meta: {
      question,
      options: parseOptions(question),
      answer: contentOf(last && last.obj),
      searched,
      attempts: attemptsUsed,
      provider: providerUsed,
      model,
      mappedJudgement,
      ms: Date.now() - startedAt
    }
  };
}

module.exports = { answerQuestion, questionOf, contentOf, shouldSearch, stripQuestion, withReferences };
