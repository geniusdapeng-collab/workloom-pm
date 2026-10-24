/** Local synthetic transport tests: no model, database, cloud or paid request. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PmClient, PmClientError, MAX_INPUT_BYTES, MAX_RESPONSE_BYTES, safeArtifactPath, validateInput } from "./pm-agent-client.mjs";
import { httpFixture, fixtureAccess, fixtureModelCredential, digest, assetBinding } from "./pm-agent-fixture.mjs";

const cli = fileURLToPath(new URL("./pm-agent.mjs", import.meta.url));
const mcp = fileURLToPath(new URL("./pm-agent-mcp.mjs", import.meta.url));
const input = suffix => ({ goal: "Synthetic transport fixture goal", employee: "doc-writer", idempotencyKey: "fixture-" + suffix,
  checks: [{ type: "fileContains", path: "result.md", text: "Synthetic" }] });
const errorCode = code => error => error instanceof PmClientError && error.code === code;
const fixtureTest = (name, options, callback) => test(name, async () => {
  const fixture = await httpFixture(options);
  try { await callback(new PmClient({ env: fixture.env }), fixture); } finally { await fixture.close(); }
});
async function created(client, suffix = "case") { return (await client.invoke("create", input(suffix))).result.run.id; }
async function completed(client, suffix = "case") { return (await client.invoke("deliver", input(suffix))).result; }

function runCli(args, env = {}, stdin = "") {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") no(error); });
    child.once("error", no); child.once("close", code => yes({ code, stdout, stderr })); child.stdin.end(stdin);
  });
}
function mcpChild(env = {}) {
  const child = spawn(process.execPath, [mcp], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [], waiters = new Set(); let buffer = "", stderr = "", parseError;
  const changed = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { messages.push(JSON.parse(line)); } catch (error) { parseError = error; }
      changed();
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => undefined);
  child.once("error", error => { parseError = error; changed(); });
  const closed = new Promise(resolve => child.once("close", code => { changed(); resolve(code); }));
  return {
    child, messages, closed,
    send: value => child.stdin.write(typeof value === "string" ? value : JSON.stringify(value) + "\n"),
    async response(id, timeoutMs = 5000) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        if (parseError) throw parseError;
        const found = messages.find(message => message.id === id); if (found) return found;
        const remaining = deadline - performance.now(); assert(remaining > 0, `MCP response timed out: ${id}`);
        await Promise.race([new Promise(resolve => { waiters.add(resolve); }), delay(remaining)]);
      }
    },
    async initialize() {
      this.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
      const response = await this.response("init"); assert.equal(response.result.protocolVersion, "2025-11-25");
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async close() { child.stdin.end(); const code = await closed; assert.equal(buffer, ""); assert(!parseError); return { code, stderr }; },
  };
}
async function withMcp(env, callback) { const harness = mcpChild(env); try { await callback(harness); } finally { await harness.close(); } }

fixtureTest("deliver follows status/create/start/readback and verifies original UTF-8 hashes", {}, async (client, fixture) => {
  const result = await completed(client);
  assert.equal(result.verification.originalBytesSha256, true); assert.equal(result.verification.deterministicChecks, true);
  assert.equal(result.semanticReview.status, "not-reviewed"); assert.equal(result.verifiedArtifacts.length, 1);
  assert.deepEqual(fixture.calls.map(call => call.path), ["/api/pm/status", "/api/pm/runs", "/api/pm/runs/pm-fixture-1/start", "/api/pm/runs/pm-fixture-1", "/api/pm/runs/pm-fixture-1/artifacts"]);
});
fixtureTest("complex delivery verifies model planner, DAG, all employee receipts and two artifacts", {}, async client => {
  const result = await client.invoke("deliver", { goal: "Synthetic team fixture goal", idempotencyKey: "team" });
  assert.equal(result.deliveryClaim, true); assert.equal(result.result.detail.tasks.length, 2); assert.equal(result.result.verifiedArtifacts.length, 2);
});
fixtureTest("repeat deliver reuses same stable run without a second start", {}, async (client, fixture) => {
  const first = await completed(client), second = await completed(client);
  assert.equal(first.detail.run.id, second.detail.run.id); assert.equal(fixture.runs.size, 1);
  assert.equal(fixture.calls.filter(call => call.path.endsWith("/start")).length, 1);
});
fixtureTest("same key changed goal yields idempotency conflict without new run", {}, async (client, fixture) => {
  await created(client); await assert.rejects(client.invoke("create", { ...input("case"), goal: "Changed synthetic fixture goal" }), errorCode("IDEMPOTENCY_CONFLICT"));
  assert.equal(fixture.runs.size, 1);
});
fixtureTest("create/get/list/status/artifact do not claim completed delivery", {}, async (client, fixture) => {
  const id = await created(client); await client.invoke("start", { runId: id });
  for (const [command, args] of [["status", {}], ["list", { limit: 1 }], ["get", { runId: id }], ["artifact", { runId: id, path: "result.md" }]]) {
    const result = await client.invoke(command, args); assert.equal(result.deliveryClaim, false);
  }
  assert.equal(fixture.calls.at(-1).query.path, "result.md");
});
fixtureTest("explicit resume dispatches once while deliver refuses to auto-resume", { initialStatus: "blocked" }, async (client, fixture) => {
  await assert.rejects(client.invoke("deliver", input("case")), errorCode("RUN_BLOCKED"));
  assert.equal(fixture.calls.filter(call => call.path.endsWith("/resume")).length, 0);
  const id = [...fixture.runs.keys()][0]; await client.invoke("resume", { runId: id }); await client.invoke("wait", { runId: id });
  assert.equal(fixture.calls.filter(call => call.path.endsWith("/resume")).length, 1);
});
for (const status of ["paused", "blocked", "failed", "cancelled"]) fixtureTest(`wait stops at ${status} without retry, resume or cancel`, { stoppedStatus: status }, async (client, fixture) => {
  const id = await created(client); await client.invoke("start", { runId: id });
  await assert.rejects(client.invoke("wait", { runId: id }), errorCode("RUN_" + status.toUpperCase()));
  assert(!fixture.calls.some(call => /\/(resume|cancel)$/.test(call.path)));
});
fixtureTest("cancel is an explicit mutation and never claims completion", {}, async (client, fixture) => {
  const id = await created(client); const result = await client.invoke("cancel", { runId: id });
  assert.equal(result.result.run.status, "cancelled"); assert.equal(result.deliveryClaim, false);
  assert.equal(fixture.calls.at(-1).method, "POST");
});
fixtureTest("not configured status prevents create and paid start", { configured: false }, async (client, fixture) => {
  await assert.rejects(client.invoke("deliver", input("case")), errorCode("PM_NOT_READY"));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.runs.size, 0);
});
fixtureTest("wait deadline is bounded and does not cancel the backend", { runForever: true }, async (client, fixture) => {
  const id = await created(client); await client.invoke("start", { runId: id });
  await assert.rejects(client.invoke("wait", { runId: id, timeoutMs: 100, pollIntervalMs: 100 }), errorCode("WAIT_TIMEOUT"));
  assert.equal(fixture.runs.get(id).detail.run.status, "running"); assert(!fixture.calls.some(call => call.path.endsWith("/cancel")));
});
for (const behavior of ["neverRespond", "slowBody"]) fixtureTest(`HTTP timeout bounds ${behavior}`, { [behavior]: true }, async (_client, fixture) => {
  const client = new PmClient({ env: fixture.env, requestTimeoutMs: 100 });
  await assert.rejects(client.invoke("status"), errorCode("HTTP_TIMEOUT"));
});
fixtureTest("caller cancellation does not mutate backend task state", { neverRespond: true }, async (client, fixture) => {
  const controller = new AbortController(); const result = client.invoke("status", {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(result, errorCode("CLIENT_CANCELLED")); assert(!fixture.calls.some(call => call.method === "POST"));
});
for (const [status, code, exit] of [[401, "UNAUTHENTICATED", 3], [403, "FENCE_REVIEW_REQUIRED", 4], [409, "MODEL_BUDGET_EXHAUSTED", 5]]) fixtureTest(`HTTP ${status} preserves safe backend error code`, { statusCode: status, errorCode: code, errorMessage: "must not leak fixture backend detail" }, async client => {
  await assert.rejects(client.invoke("status"), error => errorCode(code)(error) && error.exitCode === exit && !error.message.includes("fixture backend detail"));
});
fixtureTest("redirect refused before forwarding authorization", { redirect: "https://example.invalid/never" }, async (client, fixture) => {
  await assert.rejects(client.invoke("status"), errorCode("REDIRECT_REFUSED")); assert.equal(fixture.calls.length, 1);
});
fixtureTest("invalid JSON rejected", { invalidJson: true }, async client => { await assert.rejects(client.invoke("status"), errorCode("INVALID_RESPONSE")); });

test("missing credentials do not attempt sign-in or HTTP", async () => {
  let calls = 0; assert.throws(() => new PmClient({ env: { PM_BASE_URL: "http://127.0.0.1:1" }, fetchImpl: async () => { calls++; } }), errorCode("UNAUTHENTICATED")); assert.equal(calls, 0);
});
test("only HTTPS or exact loopback origins accepted", () => {
  for (const base of ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/path", "https://example.invalid/?query=1", "https://example.invalid/#hash", "file:///tmp/file", "not-a-url"]) {
    assert.throws(() => new PmClient({ env: { PM_BASE_URL: base, WORKLOOM_ACCESS_TOKEN: fixtureAccess } }), errorCode("INVALID_BASE_URL"));
  }
  for (const base of ["https://example.invalid", "http://127.0.0.1:1234", "http://localhost:1234", "http://[::1]:1234"]) new PmClient({ env: { PM_BASE_URL: base, WORKLOOM_ACCESS_TOKEN: fixtureAccess } });
});
test("unknown tenant, key, shell, API route, wrong types and unstable delivery rejected", () => {
  for (const value of [{ ...input("case"), tenantId: "other" }, { ...input("case"), apiKey: "secret" }, { ...input("case"), shell: "true" }, { ...input("case"), route: "/arbitrary" }, { goal: "goal", idempotencyKey: 1 }, { goal: "goal" }, { ...input("case"), checks: [{ type: "shell", path: "x" }] }]) {
    assert.throws(() => validateInput("deliver", value), errorCode("INVALID_INPUT"));
  }
  assert.throws(() => validateInput("__proto__", {}), errorCode("UNKNOWN_COMMAND"));
});
test("portable paths reject traversal, hidden config, reserved device, URLs and Unicode aliases", () => {
  for (const path of ["../x", "/x", "x\\y", ".env", "node_modules/x", "CON.txt", "NUL", "x/../y", "x//y", "x.", "x/ y", "x/..", "http:x", "x%2fy", "cafe\u0301.md", "x\u0000y"]) assert.throws(() => safeArtifactPath(path), errorCode("INVALID_INPUT"));
  assert.equal(safeArtifactPath("中文/说明.md"), "中文/说明.md");
});
fixtureTest("credential-shaped content after newline is rejected before HTTP", {}, async (client, fixture) => {
  for (const goal of ["fixture\nsk-" + "a".repeat(24), "fixture " + fixtureAccess]) await assert.rejects(client.invoke("create", { ...input("case"), goal }), errorCode("SECRET_DETECTED"));
  assert.equal(fixture.calls.length, 0);
});
fixtureTest("returned credential-shaped content after newline never leaves adapter", { mutate: (_path, value) => ({ ...value, nested: { text: "fixture\nsk-" + "a".repeat(24) } }) }, async client => { await assert.rejects(client.invoke("status"), errorCode("SECRET_DETECTED")); });
fixtureTest("ordinary employee-task paths are not mistaken for model credentials", { mutate: (_path, value) => ({ ...value, pathHint: "employee-task-12345678901234567890" }) }, async client => { assert.equal((await client.invoke("status")).deliveryClaim, false); });
fixtureTest("client sends member session only and never inherited model credential", {}, async (_client, fixture) => {
  const client = new PmClient({ env: { ...fixture.env, LLM_API_KEY: fixtureModelCredential, DEEPSEEK_API_KEY: fixtureModelCredential } });
  await client.invoke("status"); const serialized = JSON.stringify(fixture.calls);
  assert(!serialized.includes(fixtureModelCredential)); assert.equal(fixture.calls[0].authorization, "Bearer " + fixtureAccess);
});
test("network failure distinguishes unknown mutation outcome from read error", async () => {
  const client = new PmClient({ env: { PM_BASE_URL: "http://127.0.0.1:1", WORKLOOM_ACCESS_TOKEN: fixtureAccess }, fetchImpl: async () => { throw new Error("fixture private network detail"); } });
  await assert.rejects(client.invoke("status"), errorCode("NETWORK_ERROR"));
  await assert.rejects(client.invoke("create", input("case")), error => errorCode("REQUEST_OUTCOME_UNKNOWN")(error) && error.details.operation === "create" && !error.message.includes("private"));
});
test("response body has a byte limit before JSON decoding", async () => {
  const client = new PmClient({ env: { PM_BASE_URL: "http://127.0.0.1:1", WORKLOOM_ACCESS_TOKEN: fixtureAccess }, fetchImpl: async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)) });
  await assert.rejects(client.invoke("status"), errorCode("RESPONSE_TOO_LARGE"));
});

for (const [name, mutate] of [
  ["missing catalog binding", detail => { delete detail.tasks[0].adapterReceipt.assetBinding; }],
  ["task attempt usage drift", detail => { detail.tasks[0].usage.promptTokens++; }],
  ["run usage drift", detail => { detail.run.usage.promptTokens++; }],
  ["wrong final attempt response", detail => { detail.tasks[0].attemptReceipts[0].responseId = "other"; }],
  ["wrong planner history", detail => { detail.run.planningReceipts = []; }],
  ["cyclic DAG", detail => { detail.tasks[0].dependsOn = [detail.tasks[0].id]; }],
  ["missing owned artifact", detail => { detail.artifacts = []; }],
  ["case-colliding owned path", detail => { detail.tasks[0].outputRefs.push("RESULT.md"); }],
  ["failed final server check", detail => { detail.run.verification.checks[0].passed = false; }],
  ["missing declared server check", detail => { detail.run.verification.checks = []; }],
]) fixtureTest(`completed claim refused: ${name}`, { mutate: (path, value) => {
  if (/\/runs\/[^/]+$/.test(path) && value.run?.status === "completed") mutate(value); return value;
} }, async client => { await assert.rejects(client.invoke("deliver", input("case")), errorCode("INVALID_RESPONSE")); });
fixtureTest("completed claim refuses artifact byte tampering", { mutate: (path, value) => { if (path.endsWith("/artifacts")) value.content += "tampered"; return value; } }, async client => { await assert.rejects(client.invoke("deliver", input("case")), errorCode("ARTIFACT_HASH_MISMATCH")); });
fixtureTest("completed claim independently checks literal content", {}, async client => {
  await assert.rejects(client.invoke("deliver", { ...input("case"), checks: [{ type: "fileContains", path: "result.md", text: "absent exact marker" }] }), errorCode("INVALID_RESPONSE"));
});
fixtureTest("completed claim independently parses declared JSON", {}, async client => {
  await assert.rejects(client.invoke("deliver", { ...input("case"), checks: [{ type: "json", path: "result.json", requiredKeys: ["required"] }] }), errorCode("INVALID_RESPONSE"));
});
fixtureTest("attempt history preserves failed billed usage without double counting", {}, async (client, fixture) => {
  const id = await created(client), detail = fixture.runs.get(id).finished;
  const task = detail.tasks[0]; task.attempt = 2; task.attemptReceipts[0].attempt = 2;
  task.attemptReceipts.unshift({ attempt: 1, final: false, usage: { promptTokens: 2, completionTokens: 3 }, modelId: task.modelId, receipt: { final: false } });
  task.usage.promptTokens += 2; task.usage.completionTokens += 3; detail.run.usage.promptTokens += 2; detail.run.usage.completionTokens += 3;
  await client.invoke("start", { runId: id }); assert.equal((await client.invoke("wait", { runId: id })).deliveryClaim, true);
});
fixtureTest("DSH final receipt and per-request usage are verified", {}, async (client, fixture) => {
  const id = await created(client), detail = fixture.runs.get(id).finished, task = detail.tasks[0];
  task.executionBackend = "deepseek-harness";
  task.adapterReceipt = { adapter: "deepseek-harness-headless", final: true, exitCode: 0, turnEnd: "completed", usageComplete: true, modelCalls: 1,
    usage: task.usage, tools: ["list_files", "read_file", "write_file"], modelReceipts: [{ model: task.modelId, responseId: task.responseId, usage: task.usage }], ...assetBinding(task.presetKey) };
  task.attemptReceipts[0].receipt = structuredClone(task.adapterReceipt);
  await client.invoke("start", { runId: id }); assert.equal((await client.invoke("wait", { runId: id })).deliveryClaim, true);
  fixture.runs.get(id).detail.tasks[0].adapterReceipt.modelReceipts[0].usage.promptTokens++;
  await assert.rejects(client.invoke("wait", { runId: id }), errorCode("INVALID_RESPONSE"));
});

test("CLI --help has JSON stdout and no environment requirement", async () => { const result = await runCli(["--help"]); assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.equal(JSON.parse(result.stdout).commands.length, 10); });
fixtureTest("CLI stdin JSON delivery produces one successful machine-readable envelope", {}, async (_client, fixture) => {
  const result = await runCli(["deliver", "--input-file", "-"], fixture.env, JSON.stringify(input("cli")));
  assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.equal(result.stdout.trim().split("\n").length, 1); assert.equal(JSON.parse(result.stdout).deliveryClaim, true);
});
test("CLI failure uses nonzero code and safe stderr JSON only", async () => {
  for (const [args, data] of [[["create", "--input-file", "-"], "{bad"], [["status", "--api-key", "secret"], ""], [["status", "--input-file", "/no-such-pm-fixture-input"], ""]]) {
    const result = await runCli(args, {}, data); assert.equal(result.code, 2); assert.equal(result.stdout, ""); assert.equal(JSON.parse(result.stderr).schemaVersion, "workloom.pm-agent-error/v1");
  }
});
test("CLI input byte limit protects UTF-8 and parser", async () => {
  const result = await runCli(["create", "--input-file", "-"], {}, JSON.stringify({ goal: "中".repeat(MAX_INPUT_BYTES), idempotencyKey: "huge" }));
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stderr).error.code, "INPUT_TOO_LARGE");
});
test("CLI missing member token never auto-signs in", async () => { const result = await runCli(["status"], { PM_BASE_URL: "http://127.0.0.1:1" }); assert.equal(result.code, 3); assert.equal(result.stdout, ""); });

fixtureTest("MCP initialized tools/list exposes ten narrow schemas and no credentials", {}, async (_client, fixture) => {
  await withMcp(fixture.env, async harness => {
    await harness.initialize(); harness.send({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    const response = await harness.response("list"); assert.equal(response.result.tools.length, 10);
    assert(response.result.tools.every(tool => tool.name.startsWith("workloom_pm_") && tool.inputSchema.additionalProperties === false));
    assert(!JSON.stringify(response).includes(fixtureAccess)); assert.equal(fixture.calls.length, 0);
  });
});
fixtureTest("MCP tool execution returns same transport envelope with structured content", {}, async (_client, fixture) => {
  await withMcp(fixture.env, async harness => {
    await harness.initialize(); harness.send({ jsonrpc: "2.0", id: "deliver", method: "tools/call", params: { name: "workloom_pm_deliver", arguments: input("mcp") } });
    const response = await harness.response("deliver"); assert.equal(response.result.isError, false); assert.equal(response.result.structuredContent.deliveryClaim, true);
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
  });
});
fixtureTest("MCP invalid lifecycle, notification tool-call and unknown tool never dispatch HTTP", {}, async (_client, fixture) => {
  await withMcp(fixture.env, async harness => {
    harness.send({ jsonrpc: "2.0", id: "early", method: "tools/list" }); assert.equal((await harness.response("early")).error.code, -32002);
    await harness.initialize(); harness.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "workloom_pm_deliver", arguments: input("notification") } });
    harness.send({ jsonrpc: "2.0", id: "unknown", method: "tools/call", params: { name: "arbitrary_api", arguments: {} } }); assert.equal((await harness.response("unknown")).error.code, -32602);
    harness.send({ jsonrpc: "2.0", id: "bad-input", method: "tools/call", params: { name: "workloom_pm_create", arguments: { ...input("bad"), tenantId: "other" } } });
    assert.equal((await harness.response("bad-input")).result.isError, true); assert.equal(fixture.calls.length, 0);
  });
});
test("MCP negotiates its supported version and rejects duplicate initialization", async () => {
  await withMcp({}, async harness => {
    harness.send({ jsonrpc: "2.0", id: "old", method: "initialize", params: { protocolVersion: "old-fixture", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
    assert.equal((await harness.response("old")).result.protocolVersion, "2025-11-25");
    harness.send({ jsonrpc: "2.0", id: "again", method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
    assert.equal((await harness.response("again")).error.code, -32602);
  });
});
test("MCP invalid JSON, batch, oversized and incomplete frames stay JSON-RPC only", async () => {
  await withMcp({}, async harness => { harness.send("{bad}\n"); assert.equal((await harness.response(null)).error.code, -32700); });
  await withMcp({}, async harness => { harness.send("[]\n"); assert.equal((await harness.response(null)).error.code, -32600); });
  await withMcp({}, async harness => { harness.send("x".repeat(MAX_INPUT_BYTES + 16 * 1024 + 1) + "\n"); assert.equal((await harness.response(null)).error.code, -32700); });
  const harness = mcpChild(); harness.send("{incomplete"); await harness.close(); assert.equal(harness.messages[0].error.code, -32700);
});
fixtureTest("MCP cancellation stops only the client request", { neverRespond: true }, async (_client, fixture) => {
  await withMcp(fixture.env, async harness => {
    await harness.initialize(); harness.send({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "workloom_pm_status", arguments: {} } });
    await delay(30); harness.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } });
    const response = await harness.response("slow"); assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).error.code, "CLIENT_CANCELLED"); assert(!fixture.calls.some(call => call.method === "POST"));
  });
});

fixtureTest("parallel callers share one idempotent run and immutable artifact set", {}, async (client, fixture) => {
  const results = await Promise.all([client.invoke("deliver", input("parallel")), client.invoke("deliver", input("parallel"))]);
  assert.equal(results[0].result.detail.run.id, results[1].result.detail.run.id); assert.equal(fixture.runs.size, 1);
  assert.equal(results[0].result.verifiedArtifacts[0].sha256, results[1].result.verifiedArtifacts[0].sha256);
});
fixtureTest("create rejects an idempotent server reply bound to a different goal", { mutate: (path, value) => {
  if (path === "/api/pm/runs" && value.run) value.run.goal = "Different goal returned by fixture"; return value;
} }, async client => { await assert.rejects(client.invoke("create", input("case")), errorCode("INVALID_RESPONSE")); });
fixtureTest("planning history accounts for an explicitly resumed failed planner", {}, async (client, fixture) => {
  const body = { goal: "Synthetic team planning goal", idempotencyKey: "prior-planner" };
  const id = (await client.invoke("create", body)).result.run.id, detail = fixture.runs.get(id).finished;
  detail.run.planningReceipts.unshift({ modelId: "deepseek-fixture", final: false, usage: { promptTokens: 7, completionTokens: 8 }, receipt: { final: false } });
  detail.run.usage.promptTokens += 7; detail.run.usage.completionTokens += 8;
  await client.invoke("start", { runId: id }); assert.equal((await client.invoke("wait", { runId: id })).deliveryClaim, true);
});
fixtureTest("JSON checks use original bytes and own top-level keys", {}, async (client, fixture) => {
  const body = { ...input("json-positive"), checks: [{ type: "json", path: "result.json", requiredKeys: ["title", "items"] }] };
  const id = (await client.invoke("create", body)).result.run.id, made = fixture.runs.get(id), text = JSON.stringify({ title: "中文🙂", items: [] });
  made.content.set("result.json", text); made.finished.artifacts[0].sizeBytes = Buffer.byteLength(text); made.finished.artifacts[0].sha256 = digest(text);
  await client.invoke("start", { runId: id }); assert.equal((await client.invoke("wait", { runId: id })).deliveryClaim, true);
  made.detail.run.checks[0].requiredKeys.push("toString"); made.detail.run.verification.checks[0].check.requiredKeys.push("toString");
  await assert.rejects(client.invoke("wait", { runId: id }), errorCode("INVALID_RESPONSE"));
});
fixtureTest("portable Chinese artifact paths survive exact URL encoding", {}, async client => {
  const result = await client.invoke("deliver", { ...input("chinese-path"), checks: [{ type: "fileExists", path: "中文/说明.md" }] });
  assert.equal(result.result.verifiedArtifacts[0].path, "中文/说明.md");
});
fixtureTest("MCP duplicate in-flight IDs and ninth concurrent tool are refused", { neverRespond: true }, async (_client, fixture) => {
  await withMcp(fixture.env, async harness => {
    await harness.initialize();
    for (let id = 1; id <= 8; id++) harness.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "workloom_pm_status", arguments: {} } });
    harness.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workloom_pm_status", arguments: {} } });
    assert.equal((await harness.response(1)).error.code, -32600);
    harness.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workloom_pm_status", arguments: {} } });
    assert.equal((await harness.response(9)).error.code, -32000);
    harness.send({ jsonrpc: "2.0", id: "ping", method: "ping" }); assert.deepEqual((await harness.response("ping")).result, {});
  });
});
test("MCP invalid UTF-8 is rejected before JSON parsing", async () => {
  await withMcp({}, async harness => { harness.child.stdin.write(Buffer.from([0xff, 0x0a])); assert.equal((await harness.response(null)).error.code, -32700); });
});
test("MCP missing credentials become a tool error without stdout diagnostics", async () => {
  await withMcp({ PM_BASE_URL: "http://127.0.0.1:1" }, async harness => {
    await harness.initialize(); harness.send({ jsonrpc: "2.0", id: "auth", method: "tools/call", params: { name: "workloom_pm_status", arguments: {} } });
    const response = await harness.response("auth"); assert.equal(response.result.isError, true); assert.equal(JSON.parse(response.result.content[0].text).error.code, "UNAUTHENTICATED");
  });
});
