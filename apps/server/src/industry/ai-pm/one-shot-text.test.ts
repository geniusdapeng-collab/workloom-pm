import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CompletionProvider, CompletionResult } from "@workloom/base/model-router";
import { createOneShotEmployeeExecutor } from "./service.js";
import type { EmployeeExecutionInput } from "./types.js";

const input: EmployeeExecutionInput = {
  scope: { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" }, runId: "fixture-run",
  task: { id: "single", presetKey: "eval-master", goal: "交齐6条评测用例及验收", dependsOn: [], acceptance: ["含6条用例"], outputRefs: ["evaluation.md"] },
  preset: { agentId: "fixture-agent", presetKey: "eval-master", version: "v1", highRisk: false, tools: [], fenceBindings: [], prompt: { role: "评测员工" },
    essentials: { goal: "完整原始目标", stage: "delivery", archive: { fixture: true } } },
  skillText: "基于指定材料编写完整评测", dependencyArtifacts: [], outputDir: "/unused-fixture", signal: new AbortController().signal,
};
function fixture(text: string, overrides: Partial<CompletionResult> = {}) {
  const result: CompletionResult = { text, message: { role: "assistant", content: text }, model: "fixture-deepseek", responseId: "fixture-response",
    promptTokens: 23, completionTokens: 11, finishReason: "stop", usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 }, ...overrides };
  const complete = vi.fn(async (..._args: Parameters<CompletionProvider["complete"]>) => result);
  const provider: CompletionProvider = { modelId: "fixture-deepseek", complete };
  return { execute: () => createOneShotEmployeeExecutor(provider)(input), provider, complete };
}
describe("MC-PM-006 default single-file text transport", () => {
  it("returns complete body text with a server-bound path and no JSON envelope", async () => {
    const body = "# 评测用例\n\n" + Array.from({ length: 6 }, (_, index) => `${index + 1}. 前置、步骤、预期、结果均可核验`).join("\n");
    const { execute, complete } = fixture(body); const result = await execute();
    expect(result.files).toEqual([{ path: "evaluation.md", content: body }]);
    expect(result.receipt).toMatchObject({ transport: "single-file-text", outputPathSource: "server-task-outputRefs",
      rawResponseSha256: createHash("sha256").update(body).digest("hex"), normalization: { attempted: false } });
    expect(result.summary).toContain("evaluation.md"); expect(result.summary).not.toContain("测试通过");
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.any(Array), expect.objectContaining({ responseFormat: { type: "text" }, maxTokens: 8192, requireUsage: true }));
    expect(complete.mock.calls[0]![0][0]!.content).toContain("8192");
    expect(complete.mock.calls[0]![0][0]!.content).toContain("6");
  });
  it("keeps the smaller single-file budget for employees other than eval-master", async () => {
    const { provider, complete } = fixture("# 完整需求\n含可测验收项");
    await createOneShotEmployeeExecutor(provider)({ ...input, task: { ...input.task, presetKey: "doc-writer" },
      preset: { ...input.preset, presetKey: "doc-writer" } });
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.any(Array), expect.objectContaining({ maxTokens: 3072, responseFormat: { type: "text" } }));
    expect(complete.mock.calls[0]![0][0]!.content).toContain("3072");
  });
  it("never interprets model-reported paths or a JSON-looking body as controller instructions", async () => {
    const body = '{"path":"../../host-file","files":[{"path":"evil.md","content":"model claims a different file"}]} trailing body text';
    const result = await fixture(body).execute();
    expect(result.files).toEqual([{ path: "evaluation.md", content: body }]);
    expect(result.receipt).toMatchObject({ transport: "single-file-text", normalization: { attempted: false } });
  });
  it.each(["", " \n\t\r "])("rejects blank body %j while preserving known paid usage", async (body) => {
    const { execute, complete } = fixture(body);
    await expect(execute()).rejects.toMatchObject({ code: "EMPTY_ARTIFACT", usage: { promptTokens: 23, completionTokens: 11 }, receipt: { transport: "single-file-text", final: false } });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("never accepts a length-truncated body as a complete file", async () => {
    const { execute, complete } = fixture("# incomplete six cases", { finishReason: "length" });
    await expect(execute()).rejects.toMatchObject({ code: "MODEL_RECEIPT_MISSING", usage: { promptTokens: 23, completionTokens: 11 }, receipt: { transport: "single-file-text", final: false } });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("missing usage remains unknown and cannot become a zero-usage success", async () => {
    const { execute } = fixture("# actual body", { usage: undefined });
    const error = await execute().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "MODEL_RECEIPT_MISSING", receipt: { transport: "single-file-text", final: false } });
    expect((error as { usage?: unknown }).usage).toBeUndefined();
  });
  it("still rejects secrets and excessive file bytes rather than publishing arbitrary text", async () => {
    await expect(fixture(`secret sk-${"f".repeat(32)}`).execute()).rejects.toMatchObject({ code: "SECRET_DETECTED" });
    await expect(fixture("文".repeat(100_000)).execute()).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });
  it("multiple files keep structured JSON and the strict normalization receipt", async () => {
    const body = JSON.stringify({ files: [{ path: "a.md", content: "first" }, { path: "b.md", content: "second" }], summary: "两份文件" });
    const { provider, complete } = fixture(body);
    const result = await createOneShotEmployeeExecutor(provider)({ ...input, task: { ...input.task, outputRefs: ["a.md", "b.md"] } });
    expect(result.files).toHaveLength(2); expect(result.receipt).toMatchObject({ transport: "structured-json", normalization: { attempted: true } });
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.any(Array), expect.objectContaining({ responseFormat: { type: "json_object" }, maxTokens: 4096 }));
  });
});
