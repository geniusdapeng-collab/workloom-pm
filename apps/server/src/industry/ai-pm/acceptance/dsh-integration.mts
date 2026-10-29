/** Run explicitly: pnpm test:pm-dsh
 * These are real pinned DSH subprocesses with a deterministic local model fixture.
 * They verify Harness mechanics and isolation, not DeepSeek task quality.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { CompletionProvider, CompletionResult, FunctionToolCall, ProviderMessage } from "@workloom/base/model-router";
import { createDshEmployeeExecutor, type DshEmployeeOptions } from "../dsh-adapter.js";
import type { EmployeeExecutionInput } from "../types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const scratchRoot = resolve(repoRoot, "..");
const evidenceRoot = process.env.PM_DSH_EVIDENCE_ROOT ? resolve(process.env.PM_DSH_EVIDENCE_ROOT) : undefined;
// Default exercises the server's own declared dependency; the explicit override
// repeats the same tests against a real npm-ci desktop stage without symlinks.
const dshPackageRoot = process.env.PM_DSH_PACKAGE_ROOT ? resolve(process.env.PM_DSH_PACKAGE_ROOT) : undefined;
function executor(options: DshEmployeeOptions) { return createDshEmployeeExecutor({ ...options, ...(dshPackageRoot ? { dshPackageRoot } : {}) }); }
async function scratch(name: string): Promise<string> {
  const parent = evidenceRoot ?? scratchRoot;
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, name));
}
async function cleanup(directory: string): Promise<void> {
  if (!evidenceRoot) await rm(directory, { recursive: true, force: true });
}
function result(sequence: number, toolCalls?: FunctionToolCall[]): CompletionResult {
  const usage = { prompt_tokens: 100 + sequence, completion_tokens: 20, total_tokens: 120 + sequence };
  return { text: toolCalls ? "" : "已交付 report.md", message: { role: "assistant", content: toolCalls ? null : "已交付 report.md", ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    model: "deepseek-flash", responseId: `fixture-${sequence}`, finishReason: toolCalls ? "tool_calls" : "stop", usage,
    promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
}
const call = (sequence: number, name: string, args: unknown): FunctionToolCall => ({ id: `call-${sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
function input(outputDir: string, signal = new AbortController().signal): EmployeeExecutionInput {
  const content = "upstream evidence: REQUIREMENT-42";
  return { scope: { tenantId: "fixture", workspaceId: "fixture-workspace" }, runId: "fixture-run", task: {
    id: "fixture-task", presetKey: "doc-writer", goal: "从上游需求产出 report.md", dependsOn: ["previous-task"], acceptance: ["包含 REQUIREMENT-42"], outputRefs: ["report.md"],
  }, preset: { agentId: "agt-doc-writer", presetKey: "doc-writer", version: "fixture-v1", highRisk: false, fenceBindings: [], tools: [],
    prompt: { role: "文档员工" }, essentials: { archive: { dataMode: "simulated" }, stage: "definition", goal: "fixture" } }, skillText: "fixture skill",
    dependencyArtifacts: [{ id: "upstream", runId: "fixture-run", taskId: "previous-task", path: "requirements.md", content,
      sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content), mediaType: "text/markdown", verifiedAt: new Date().toISOString() }], outputDir, signal };
}
function toolMessages(messages: ProviderMessage[]) { return messages.filter((message) => message.role === "tool").map((message) => message.content); }

test("real DSH performs read -> write -> final, with durable session and measured receipts", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-integration-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages, options) {
    assert.deepEqual(options?.tools?.map((tool) => tool.function.name).sort(), ["list_files", "read_file", "write_file"]);
    calls += 1;
    if (calls === 1) return result(calls, [call(calls, "read_file", { path: "inputs/context.json" })]);
    if (calls === 2) {
      const context = JSON.parse(toolMessages(messages).at(-1)!) as { content: string };
      const body = JSON.parse(context.content) as { dependencyArtifacts: Array<{ path: string }> };
      return result(calls, [call(calls, "read_file", { path: body.dependencyArtifacts[0]!.path })]);
    }
    if (calls === 3) {
      const dependency = JSON.parse(toolMessages(messages).at(-1)!) as { content: string };
      return result(calls, [call(calls, "write_file", { path: "report.md", content: `# 交付\n${dependency.content}\n` })]);
    }
    return result(calls);
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 30000 })(input(directory));
    assert.equal(calls, 4);
    assert.deepEqual(delivered.files.map((file) => file.path), ["report.md"]);
    assert.match(delivered.files[0]!.content, /REQUIREMENT-42/);
    assert.equal(delivered.usage.promptTokens, 410);
    assert.equal(delivered.usage.completionTokens, 80);
    assert.equal(delivered.receipt?.dshVersion, "0.2.1-rc.2");
    assert.equal(delivered.receipt?.toolCalls, 3);
    assert.equal(delivered.receipt?.exitCode, 0);
    assert.equal(delivered.receipt?.usageComplete, true);
    assert.ok(Array.isArray(delivered.receipt?.sessionEvidence) && delivered.receipt!.sessionEvidence.length > 0);
    assert.equal(delivered.receipt?.adapter, "deepseek-harness-headless");
  } finally { await cleanup(directory); }
});

test("real DSH preserves Unicode across large subprocess output chunks", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-unicode-");
  const summary = "需求中文与验收。".repeat(20000);
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() {
    calls += 1;
    if (calls === 1) return result(calls, [call(calls, "write_file", { path: "report.md", content: "# 中文产物\nREQUIREMENT-42\n" })]);
    const completion = result(calls);
    return { ...completion, text: summary, message: { role: "assistant", content: summary } };
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 30000 })(input(directory));
    assert.equal(delivered.summary, summary);
    assert.equal(delivered.summary.includes("\uFFFD"), false);
    assert.equal(calls, 2);
  } finally { await cleanup(directory); }
});

test("a five-request two-file employee fails at four and completes within eight", { timeout: 45000 }, async () => {
  for (const limit of [4, 8]) {
    const directory = await scratch(`pm-dsh-five-round-${limit}-`);
    let calls = 0;
    const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages) {
      calls++;
      if (calls === 1) return result(calls, [call(calls, "read_file", { path: "inputs/context.json" })]);
      if (calls === 2) {
        const context = JSON.parse(JSON.parse(toolMessages(messages).at(-1)!).content);
        return result(calls, [call(calls, "read_file", { path: context.dependencyArtifacts[0].path })]);
      }
      if (calls === 3) return result(calls, [call(calls, "write_file", { path: "module.mjs", content: "export const value = 42;\n" })]);
      if (calls === 4) return result(calls, [call(calls, "write_file", { path: "module.test.mjs", content: "import{test}from'node:test';import assert from'node:assert/strict';import{value}from'./module.mjs';test('value',()=>assert.equal(value,42));\n" })]);
      return result(calls);
    } };
    const task = input(directory); task.task.outputRefs = ["module.mjs", "module.test.mjs"];
    try {
      if (limit === 4) {
        await assert.rejects(executor({ provider, maxModelCalls: limit, timeoutMs: 30000 })(task), (error: unknown) => (error as { code: string }).code === "DSH_MODEL_BUDGET");
        assert.equal(calls, 4);
      } else {
        const delivered = await executor({ provider, maxModelCalls: limit, timeoutMs: 30000 })(task);
        assert.equal(calls, 5); assert.equal(delivered.files.length, 2); assert.equal(delivered.receipt?.final, true);
      }
    } finally { await cleanup(directory); }
  }
});

test("provider quota refusal stays a blocked budget outcome without a retry", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-provider-quota-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() { calls++; throw new Error("模型调用失败：HTTP 429"); } };
  try {
    await assert.rejects(executor({ provider, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; receipt: { modelCalls: number; usageComplete: boolean } };
      assert.equal(failure.code, "DSH_MODEL_BUDGET"); assert.equal(failure.receipt.modelCalls, 1);
      assert.equal(failure.receipt.usageComplete, false); return true;
    });
    assert.equal(calls, 1);
  } finally { await cleanup(directory); }
});

test("real DSH denies host paths, unowned outputs and shell calls, then can finish legitimate output", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-negative-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages) {
    calls += 1;
    if (calls === 1) return result(calls, [call(1, "read_file", { path: "/etc/hosts" }), call(2, "write_file", { path: "../escape.txt", content: "denied" }), call(3, "bash", { command: "echo HOST_EXECUTION_MUST_NOT_HAPPEN" })]);
    if (calls === 2) {
      const failures = toolMessages(messages);
      assert.equal(failures.length, 3);
      assert.ok(failures.every((message) => message.startsWith("Error:")));
      assert.ok(failures.every((message) => !message.includes("127.0.0.1")));
      return result(calls, [call(4, "write_file", { path: "report.md", content: "REQUIREMENT-42: boundaries were enforced" })]);
    }
    return result(calls);
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 30000 })(input(directory));
    assert.equal(calls, 3);
    assert.match(delivered.files[0]!.content, /boundaries were enforced/);
    const results = delivered.receipt?.toolResults as Array<{ status: string }>;
    assert.equal(results.filter((item) => item.status === "error").length, 3);
    await assert.rejects(readFile(join(directory, "escape.txt")), { code: "ENOENT" });
  } finally { await cleanup(directory); }
});

test("real DSH cannot exceed model-call budget or claim a final without files", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-budget-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() { calls += 1; return result(calls, [call(calls, "list_files", {})]); } };
  try {
    await assert.rejects(executor({ provider, maxModelCalls: 1, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; usage: { promptTokens: number }; receipt: { modelCalls: number; usageComplete: boolean }; modelId: string };
      assert.equal(failure.code, "DSH_MODEL_BUDGET");
      assert.equal(failure.usage.promptTokens, 101);
      assert.equal(failure.receipt.modelCalls, 1);
      assert.equal(failure.receipt.usageComplete, true);
      assert.equal(failure.modelId, "deepseek-flash");
      return true;
    });
    assert.equal(calls, 1);
    await assert.rejects(executor({ provider: { modelId: "deepseek-flash", async complete() { return result(1); } }, timeoutMs: 30000 })(input(directory)), (error: unknown) => (error as { code: string }).code === "DSH_OUTPUT_MISSING");
  } finally { await cleanup(directory); }
});

test("real DSH freezes after missing usage and persists an incomplete accounting receipt", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-usage-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() {
    calls += 1;
    return { ...result(calls, [call(calls, "list_files", {})]), usage: undefined };
  } };
  try {
    await assert.rejects(executor({ provider, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; usage: { promptTokens: number }; receipt: { modelCalls: number; usageComplete: boolean } };
      assert.equal(failure.code, "DSH_USAGE");
      assert.equal(failure.usage.promptTokens, 0);
      assert.equal(failure.receipt.modelCalls, 1);
      assert.equal(failure.receipt.usageComplete, false);
      return true;
    });
    assert.equal(calls, 1);
    const [home] = await readdir(directory);
    const failure = JSON.parse(await readFile(join(directory, home!, "failure.json"), "utf8")) as { code: string; receipt: { usageComplete: boolean } };
    assert.equal(failure.code, "DSH_USAGE");
    assert.equal(failure.receipt.usageComplete, false);
  } finally { await cleanup(directory); }
});

test("real DSH propagates cancellation and timeout, aborts the model, and retains partial JSON events", { timeout: 45000 }, async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const directory = await scratch(`pm-dsh-${mode}-`);
    const controller = new AbortController();
    let calls = 0;
    let aborted = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(_messages, options) {
      calls += 1;
      assert.ok(options?.signal);
      if (mode === "cancel") cancelTimer = setTimeout(() => controller.abort(), 20);
      return await new Promise<never>((_done, fail) => {
        const onAbort = () => { aborted = true; fail(options!.signal!.reason); };
        options!.signal!.addEventListener("abort", onAbort, { once: true });
        if (options!.signal!.aborted) onAbort();
      });
    } };
    try {
      await assert.rejects(executor({ provider, timeoutMs: mode === "timeout" ? 5000 : 30000 })(input(directory, controller.signal)), (error: unknown) => {
        const failure = error as { code: string; receipt: { modelCalls: number; usageComplete: boolean; stdoutSha256: string } };
        assert.equal(failure.code, mode === "timeout" ? "DSH_TIMEOUT" : "DSH_CANCELLED");
        assert.equal(failure.receipt.modelCalls, 1);
        assert.equal(failure.receipt.usageComplete, false);
        assert.match(failure.receipt.stdoutSha256, /^[a-f0-9]{64}$/);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(aborted, true);
      const [home] = await readdir(directory);
      const stdout = await readFile(join(directory, home!, "stdout.jsonl"), "utf8");
      const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
      assert.equal(events[0]?.type, "session");
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      await cleanup(directory);
    }
  }
});
