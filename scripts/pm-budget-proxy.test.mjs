import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPmBudgetProxy } from "./pm-budget-proxy.mjs";

const requestBody = (overrides = {}) => ({ model: "deepseek-flash", messages: [{ role: "user", content: "返回可验证的结果" }],
  thinking: { type: "disabled" }, max_tokens: 256, stream: false, ...overrides });
const reply = (overrides = {}) => ({ id: "completion-fixture", model: "deepseek-flash", choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, ...overrides });

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-unit-"));
  let upstreamCalls = 0;
  const sent = [];
  const proxy = await createPmBudgetProxy({ apiKey: "test-only-synthetic-upstream-fixture-key", controlToken: "test-only-synthetic-loopback-fixture-token",
    outDir: directory, tokenCounter: { count: async () => 10 },
    upstreamFetch: async (url, init) => { upstreamCalls += 1; sent.push({ url, init }); return new Response(JSON.stringify(reply()), { status: 200 }); },
    ...options });
  t.after(async () => { await proxy.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (body = requestBody(), path = "/chat/completions", token = "test-only-synthetic-loopback-fixture-token") => fetch(`${proxy.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { proxy, directory, sent, post, calls: () => upstreamCalls };
}

test("no upstream I/O before a trusted tokenizer and separate credentials exist", async () => {
  await assert.rejects(createPmBudgetProxy({ apiKey: "same", controlToken: "same", outDir: "/tmp/unused" }), /Separate/);
  await assert.rejects(createPmBudgetProxy({ apiKey: "one", controlToken: "two", outDir: "/tmp/unused" }), /trusted official token/);
  await assert.rejects(createPmBudgetProxy({ apiKey: "one", controlToken: "two", outDir: "/tmp/unused",
    tokenCounter: { count: async () => 10 }, maxSearchCalls: 0 }), /Search\/Fetch call cap/);
});

test("one physical request is reserved first, then actual model/usage evidence is persisted without credentials", async (t) => {
  const f = await fixture(t);
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(f.calls(), 1);
  const summary = f.proxy.summary();
  assert.equal(summary.budget.actual.llmCalls, 1);
  assert.equal(summary.actualModelTokens, 30);
  assert.equal(summary.requests[0].reservedTokens, 1290);
  assert.equal(summary.requests[0].responseModel, "deepseek-flash");
  assert.equal(summary.budget.measurementComplete, true);
  const evidence = readFileSync(join(f.directory, "requests.jsonl"), "utf8");
  assert.doesNotMatch(evidence, /synthetic-upstream|synthetic-loopback/);
  assert.equal(f.sent[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(f.sent[0].init.redirect, "error");
});

test("concurrent requests cannot exceed physical request cap", async (t) => {
  const f = await fixture(t, { budgets: { maxLlmCalls: 2, maxLlmTokens: 3000 } });
  const results = await Promise.all([f.post(), f.post(), f.post()]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 200, 429]);
  assert.equal(f.calls(), 2);
  assert.equal(f.proxy.summary().budget.used.llmCalls, 2);
});

test("token reservation can block the first request before external I/O", async (t) => {
  const f = await fixture(t, { budgets: { maxLlmTokens: 1000 } });
  assert.equal((await f.post()).status, 429);
  assert.equal(f.calls(), 0);
});

test("missing usage freezes further paid requests; HTTP200 is not model success", async (t) => {
  let calls = 0;
  const f = await fixture(t, { upstreamFetch: async () => { calls += 1; return Response.json(reply({ usage: undefined })); } });
  assert.equal((await f.post()).status, 502);
  assert.equal((await f.post()).status, 429);
  assert.equal(calls, 1);
  assert.equal(f.proxy.summary().budget.measurementComplete, false);
});

test("upstream network uncertainty is never retried and freezes the run", async (t) => {
  let calls = 0;
  const f = await fixture(t, { upstreamFetch: async () => { calls += 1; throw new Error("fixture transport lost"); } });
  assert.equal((await f.post()).status, 502);
  assert.equal((await f.post()).status, 429);
  assert.equal(calls, 1);
  assert.equal(f.proxy.summary().requests[0].error, "UPSTREAM_OUTCOME_UNKNOWN");
});

test("provider usage exceeding reservation freezes the following request", async (t) => {
  const f = await fixture(t, { upstreamFetch: async () => Response.json(reply({ usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } })) });
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 429);
  assert.equal(f.proxy.summary().budget.frozenBy.length, 1);
});

test("unbounded, multimodal, server-side search and alternate-model requests fail before I/O", async (t) => {
  const f = await fixture(t);
  for (const body of [requestBody({ max_tokens: undefined }), requestBody({ max_tokens: 9000 }), requestBody({ stream: true }),
    requestBody({ model: "deepseek-v4-pro" }), requestBody({ n: 2 }), requestBody({ tools: [{ type: "web_search" }] }),
    requestBody({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }] })]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal(f.calls(), 0);
});

test("authorization, endpoint and credential-in-prompt failures have no upstream effects", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(requestBody(), "/chat/completions", "wrong")).status, 401);
  assert.equal((await f.post(requestBody(), "/arbitrary/upload")).status, 404);
  assert.equal((await f.post(requestBody({ messages: [{ role: "user", content: "test-only-synthetic-upstream-fixture-key" }] }))).status, 400);
  assert.equal(f.calls(), 0);
});

test("tokenizer failure cannot fall back to an estimate or send a paid request", async (t) => {
  const f = await fixture(t, { tokenCounter: { count: async () => { throw new Error("fixture tokenizer failed"); } } });
  assert.equal((await f.post()).status, 400);
  assert.equal(f.calls(), 0);
});

test("Search/Fetch are individually counted and internal-address fetch is rejected", async (t) => {
  const f = await fixture(t, { upstreamFetch: async () => Response.json({ results: [{ title: "官方文档", url: "https://api-docs.deepseek.com/", content: "fixture" }] }) });
  assert.equal((await f.post({ query: "DeepSeek official API", count: 50 }, "/v1/tools/search")).status, 200);
  assert.equal((await f.post({ query: "DeepSeek official API", count: 51 }, "/v1/tools/search")).status, 400);
  assert.equal((await f.post({ url: "http://127.0.0.1/private" }, "/v1/tools/fetch")).status, 400);
  const summary = f.proxy.summary();
  assert.equal(summary.searchRequests, 1);
  assert.equal(summary.maxSearchCalls, 8);
  assert.equal(summary.actualModelTokens, 0);
  assert.equal(summary.budget.used.llmCalls, 1);
  assert.equal(summary.budget.used.llmTokens, 1000);
});

test("Search/Fetch cap is explicit, configurable and fails before a second upstream call", async (t) => {
  let upstreamCalls = 0;
  const f = await fixture(t, { maxSearchCalls: 1,
    upstreamFetch: async () => { upstreamCalls += 1; return Response.json({ results: [{ title: "官方文档", url: "https://api-docs.deepseek.com/", content: "fixture" }] }); } });
  assert.equal((await f.post({ query: "first", count: 5 }, "/v1/tools/search")).status, 200);
  assert.equal((await f.post({ query: "second", count: 5 }, "/v1/tools/search")).status, 429);
  assert.equal(upstreamCalls, 1);
  assert.equal(f.proxy.summary().searchRequests, 1);
});

test("upstream credential cannot be redirected to a different origin", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-origin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(createPmBudgetProxy({ apiKey: "one", controlToken: "two", outDir: directory,
    tokenCounter: { count: async () => 10 }, upstreamOrigin: "https://example.com" }), /official DeepSeek origin/);
});

test("restart keeps the same physical call cap, evidence and original wall clock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-restart-"));
  const options = { apiKey: "test-only-restart-fixture-upstream", controlToken: "test-only-restart-fixture-local", tokenCounter: { count: async () => 10 },
    outDir: directory, runId: "one-logical-evaluation", budgets: { maxLlmCalls: 1 }, upstreamFetch: async () => Response.json(reply()) };
  const first = await createPmBudgetProxy(options);
  const headers = { "content-type": "application/json", authorization: `Bearer ${options.controlToken}` };
  assert.equal((await fetch(`${first.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody()) })).status, 200);
  await first.close();
  const second = await createPmBudgetProxy(options);
  t.after(async () => { await second.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${second.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody()) })).status, 429);
  assert.equal(second.summary().physicalRequests, 1);
  assert.equal(second.summary().budget.used.llmCalls, 1);
  assert.equal(second.summary().actualModelTokens, 30);
});

test("restart with an unsettled request freezes paid I/O instead of silently clearing it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-pending-"));
  const options = { apiKey: "test-only-pending-fixture-upstream", controlToken: "test-only-pending-fixture-local", tokenCounter: { count: async () => 10 },
    outDir: directory, runId: "unknown-outcome", upstreamFetch: async () => { throw new Error("Must never call upstream"); } };
  const first = await createPmBudgetProxy(options);
  first.budget.reserve({ taskId: "prior-unknown", reservationId: "prior-unknown", kind: "llm", tokens: 1000 });
  await first.close();
  const second = await createPmBudgetProxy(options);
  t.after(async () => { await second.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await fetch(`${second.url}/chat/completions`, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${options.controlToken}` }, body: JSON.stringify(requestBody()) });
  assert.equal(response.status, 429); assert.equal(second.summary().budget.measurementComplete, false);
});
