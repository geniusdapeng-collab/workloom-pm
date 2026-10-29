import test from "node:test";
import assert from "node:assert/strict";
import { buildCases, evaluateCase } from "./assistant-218.mjs";

test("assistant live evaluation generates exactly 218 varied, uniquely identified cases", () => {
  const cases = buildCases();
  assert.equal(cases.length, 218);
  assert.equal(new Set(cases.map((item) => item.id)).size, 218);
  assert.equal(new Set(cases.map((item) => item.title)).size, 218);
  assert.ok(new Set(cases.map((item) => item.category)).size >= 10);
  for (const item of cases) {
    assert.ok(item.prompt.length > 80);
    assert.ok(item.required.length >= 1);
    assert.match(item.prompt, /严格 JSON/);
  }
});

test("assistant evaluation rejects malformed JSON and incomplete model receipts", () => {
  const task = buildCases()[0];
  const malformed = evaluateCase(task, "plain text", {
    run: { status: "completed", responseId: "resp", usage: { promptTokens: 1, completionTokens: 1 } },
  }, [
    { role: "user" },
    { role: "assistant", status: "completed" },
  ], { eventCount: 1, errors: [] });
  assert.equal(malformed.passed, false);
  assert.equal(malformed.checks.find((check) => check.id === "strict_json")?.passed, false);
});
