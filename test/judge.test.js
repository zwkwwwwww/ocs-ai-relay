"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseOptions, isJudgement, mapJudgementAnswer, lastLetter } = require("../lib/judge");

test("parses options from a question block", () => {
  const options = parseOptions("题目：首都是？\n选项：A. 上海\nB. 北京");
  assert.deepEqual(options, ["上海", "北京"]);
});

test("detects 对/错 judgement questions", () => {
  assert.equal(isJudgement(["对", "错"]), true);
  assert.equal(isJudgement(["正确", "错误"]), true);
  assert.equal(isJudgement(["√", "×"]), true);
  assert.equal(isJudgement(["上海", "北京"]), false);
  assert.equal(isJudgement(["对", "错", "以上"]), false);
});

test("maps letters to judgement words", () => {
  const question = "题目：1+1=2。\n选项：对\n错";
  assert.equal(mapJudgementAnswer(question, "A"), "对");
  assert.equal(mapJudgementAnswer(question, "B"), "错");
  assert.equal(mapJudgementAnswer(question, "对"), "对");
});

test("leaves non-judgement answers untouched", () => {
  const question = "题目：首都是？\n选项：A. 上海\nB. 北京";
  assert.equal(mapJudgementAnswer(question, "B"), "B");
});

test("extracts the last standalone letter from reasoning text", () => {
  assert.equal(lastLetter("先分析一下…\n最终答案是 A"), "A");
  assert.equal(lastLetter("no letter here"), "");
});
