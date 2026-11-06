"use strict";

const CORRECT_WORDS = ["是", "对", "正确", "确定", "√", "对的", "是的", "正确的", "true", "t", "yes", "1"];
const INCORRECT_WORDS = ["非", "否", "错", "错误", "×", "x", "错的", "不对", "不正确", "不是", "false", "f", "no", "0"];

function parseOptions(question) {
  const match = String(question || "").match(/选项[:：]\s*([\s\S]*)$/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-H][.、:：)）]\s*/, "").trim());
}

function isJudgement(options) {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const has = (words, text) => words.some((word) => word.toLowerCase() === String(text).toLowerCase());
  return (
    (has(CORRECT_WORDS, options[0]) && has(INCORRECT_WORDS, options[1])) ||
    (has(INCORRECT_WORDS, options[0]) && has(CORRECT_WORDS, options[1]))
  );
}

function mapJudgementAnswer(question, content) {
  const options = parseOptions(question);
  if (!isJudgement(options)) return content;
  const match = String(content).trim().match(/^[（(]?\s*([A-B])\s*[)）]?.?$/);
  if (!match) return content;
  return options[match[1].charCodeAt(0) - 65];
}

function lastLetter(text) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/(?:^|[^A-Za-z])([A-H]{1,8})(?:[^A-Za-z]|$)/);
    if (match) return match[1];
  }
  return "";
}

module.exports = { CORRECT_WORDS, INCORRECT_WORDS, parseOptions, isJudgement, mapJudgementAnswer, lastLetter };
