import test from "node:test";
import assert from "node:assert/strict";
import { buildCases, evaluateCase } from "./assistant-218.mjs";

test("assistant live evaluation generates exactly 218 varied, uniquely identified cases", () => {
  const cases = buildCases();
  assert.equal(cases.length, 218);
  assert.equal(new Set(cases.map((item) => item.id)).size, 218);
  assert.equal(new Set(cases.map((item) => item.title)).size, 218);
  assert.ok(new Set(cases.map((item) => item.category)).size >= 10);
  const searchCases = cases.filter((item) => item.webSearch);
  assert.equal(searchCases.length, 1);
  assert.match(searchCases[0].prompt, /"sources"/);
  for (const item of cases) {
    assert.ok(item.prompt.length > 80);
    assert.ok(item.required.length >= 1);
    assert.match(item.prompt, /严格 JSON/);
  }
});

test("assistant search evaluation requires persisted sources and search receipts", () => {
  const task = buildCases().find((item) => item.webSearch);
  assert.ok(task);
  const response = JSON.stringify({
    answer: "官方 Search API 使用 /v1/tools/search，计费按成功请求计算。",
    facts: ["/v1/tools/search", "计费", "来源"],
    sources: ["https://api-docs.deepseek.com/guides/search"],
    risks: ["价格可能变化"],
    verification: ["核对官方文档"],
    limitations: ["未核对账单"],
  });
  const failed = evaluateCase(task, response, {
    run: {
      status: "completed",
      responseId: "resp",
      responseModel: "deepseek-flash",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      webSearchRequested: true,
      searchStatus: "completed",
      searchResultCount: 1,
    },
  }, [
    { role: "user", parts: [{ type: "text", text: "search" }] },
    { role: "assistant", status: "completed", parts: [{ type: "text", text: response }] },
  ], { eventCount: 1, errors: [], search: null });
  assert.equal(failed.passed, false);
  assert.equal(failed.checks.find((check) => check.id === "search_sources_persisted")?.passed, false);
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
