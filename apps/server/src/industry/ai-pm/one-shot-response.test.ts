import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CompletionProvider, CompletionResult } from "@workloom/base/model-router";
import { createOneShotEmployeeExecutor } from "./service.js";
import { parseModelJson, validateEmployeeResult } from "./contract.js";
import type { EmployeeExecutionInput } from "./types.js";
import { parseOneShotEmployeeResponse } from "./one-shot-response.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const input: EmployeeExecutionInput = {
  scope: { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" }, runId: "fixture-run",
  task: { id: "employee-task", presetKey: "doc-writer", goal: "完成明确的文档目标", dependsOn: [], acceptance: ["完整文件"], outputRefs: ["result.md"] },
  preset: { agentId: "fixture-agent", presetKey: "doc-writer", version: "v1", highRisk: false, tools: [], fenceBindings: [], prompt: { role: "文档员工" },
    essentials: { goal: "完整原始目标", stage: "delivery", archive: { fixture: true } } },
  skillText: "写完整文档", dependencyArtifacts: [], outputDir: "/unused-fixture", signal: new AbortController().signal,
};
function fixture(text: string, overrides: Partial<CompletionResult> = {}) {
  const result: CompletionResult = { text, message: { role: "assistant", content: text }, model: "fixture-deepseek", responseId: "fixture-response",
    promptTokens: 23, completionTokens: 11, finishReason: "stop", usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 }, ...overrides };
  const complete = vi.fn(async () => result);
  const provider: CompletionProvider = { modelId: "fixture-deepseek", complete };
  const execute = async () => validateEmployeeResult(await createOneShotEmployeeExecutor(provider, { forceStructured: true })(input), input.task.outputRefs);
  return { execute, complete };
}
const payload = (content: string, duplicate = false) => JSON.stringify({ files: [{ path: "result.md", content }, ...duplicate ? [{ path: "result.md", content }] : []], summary: "实际完成文件" });

describe("MC-PM-006 oneshot deterministic transport normalization (zero paid I/O)", () => {
  it("escapes only raw control characters inside JSON strings and retains exact file bytes", async () => {
    const content = "第一行\n第二行\t结束\r\n中文";
    const raw = payload(content).replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\r", "\r");
    const { execute, complete } = fixture(raw);
    const result = await execute();
    expect(result.files[0]!.content).toBe(content);
    expect(result.receipt).toMatchObject({ rawResponseSha256: sha(raw), normalization: { escapedStringControlCharacters: 4, identicalFileDuplicatesCollapsed: 0 } });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("folds only an exact same-path same-content duplicate, with an explicit receipt", async () => {
    const raw = payload("原始逐字节内容 \n中文", true); const { execute, complete } = fixture(raw);
    const result = await execute();
    expect(result.files).toEqual([{ path: "result.md", content: "原始逐字节内容 \n中文" }]);
    expect(result.receipt).toMatchObject({ rawResponseSha256: sha(raw), normalization: { escapedStringControlCharacters: 0, identicalFileDuplicatesCollapsed: 1 } });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("handles the observed mixed raw-newline and escaped-newline duplicate without changing content", async () => {
    const raw = '{"files":[{"path":"result.md","content":"第一行\n第二行"},{"path":"result.md","content":"第一行\\n第二行"}],"summary":"实际文件"}';
    const result = await fixture(raw).execute();
    expect(result.files).toEqual([{ path: "result.md", content: "第一行\n第二行" }]);
    expect(result.receipt).toMatchObject({ normalization: { escapedStringControlCharacters: 1, identicalFileDuplicatesCollapsed: 1 } });
  });
  it("preserves already valid escaping, Markdown, quote and backslash content exactly", async () => {
    const content = '## 标题\n```js\nconst x="中文\\n";\n```\nC:\\folder\\file';
    const raw = payload(content); const result = await fixture(raw).execute();
    expect(result.files[0]!.content).toBe(content);
    expect(result.receipt).toMatchObject({ rawResponseSha256: sha(raw), normalization: { escapedStringControlCharacters: 0, identicalFileDuplicatesCollapsed: 0 } });
  });
  it("conflicting duplicate content, whitespace, casing or Unicode normalization still fails", async () => {
    for (const [first, second, path] of [["one", "two", "result.md"], ["a", "a ", "result.md"], ["é", "é", "result.md"], ["one", "one", "Result.md"]]) {
      const raw = JSON.stringify({ files: [{ path: "result.md", content: first }, { path, content: second }], summary: "conflicting fixture" });
      await expect(fixture(raw).execute()).rejects.toMatchObject({ code: "DUPLICATE_ARTIFACT" });
    }
  });
  it("never invents a missing quote, brace, comma, invalid escape or truncated structure", async () => {
    const malformed = [
      '{"files":[{"path":"result.md","content":"missing quote}]}',
      '{"files":[{"path":"result.md","content":"line\nnext"}],"summary":"truncated"',
      '{"files":[{"path":"result.md" "content":"missing comma"}],"summary":"bad"}',
      '{"files":[{"path":"result.md","content":"bad\\q"}],"summary":"bad"}',
    ];
    for (const raw of malformed) {
      const { execute, complete } = fixture(raw);
      await expect(execute()).rejects.toMatchObject({ code: "INVALID_MODEL_JSON", usage: { promptTokens: 23, completionTokens: 11 }, receipt: { rawResponseSha256: sha(raw), final: false } });
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });
  it("does not loosen the shared JSON parser or shared duplicate contract", () => {
    expect(() => parseModelJson('{"text":"raw\nnewline"}')).toThrow();
    const valid = { files: [{ path: "result.md", content: "same" }, { path: "result.md", content: "same" }], summary: "fixture", usage: { promptTokens: 1, completionTokens: 1 }, modelId: "fixture" };
    expect(() => validateEmployeeResult(valid, ["result.md"])).toThrow();
  });
  it("leaves JSON whitespace outside strings alone and supports every raw string-control code", async () => {
    const content = `start${Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("")}end`;
    const raw = `{\n\t"files":[{"path":"result.md","content":"${content}"}],\r\n"summary":"真实文件"\n}`;
    const result = await fixture(raw).execute();
    expect(result.files[0]!.content).toBe(content);
    expect(result.receipt).toMatchObject({ normalization: { escapedStringControlCharacters: 32, identicalFileDuplicatesCollapsed: 0 } });
  });
  it("keeps the final unique-file limit while accepting repeated copies of12 declared files", () => {
    const files = Array.from({ length: 12 }, (_, index) => ({ path: `file${index}.md`, content: `正文${index}` }));
    const result = parseOneShotEmployeeResponse(JSON.stringify({ files: [...files, ...files], summary: "完整文件" }));
    expect(result.payload.files).toEqual(files); expect(result.receipt.normalization.identicalFileDuplicatesCollapsed).toBe(12);
    expect(() => parseOneShotEmployeeResponse(JSON.stringify({ files: [...files, { path: "extra.md", content: "extra" }], summary: "超量文件" }))).toThrow();
  });
  it("strictly rejects unknown fields and invalid paths before considering duplicate folding", () => {
    for (const raw of [
      JSON.stringify({ files: [{ path: "result.md", content: "one", overwrite: true }], summary: "bad" }),
      JSON.stringify({ files: [{ path: "../secret", content: "one" }], summary: "bad" }),
      JSON.stringify({ files: [{ path: "result.md", content: "one" }], summary: "bad", tenantId: "forged" }),
    ]) expect(() => parseOneShotEmployeeResponse(raw)).toThrow();
  });
  it("never converts a backslash followed by a raw newline into a valid escape", async () => {
    const raw = '{"files":[{"path":"result.md","content":"bad' + "\\" + '\nnext"}],"summary":"bad"}';
    await expect(fixture(raw).execute()).rejects.toMatchObject({ code: "INVALID_MODEL_JSON" });
  });
  it("retains normalization evidence even if a later conflicting copy fails", async () => {
    const raw = JSON.stringify({ files: [{ path: "result.md", content: "one" }, { path: "result.md", content: "one" }, { path: "result.md", content: "different" }], summary: "conflict" });
    await expect(fixture(raw).execute()).rejects.toMatchObject({ code: "DUPLICATE_ARTIFACT", receipt: {
      rawResponseSha256: sha(raw), normalization: { identicalFileDuplicatesCollapsed: 1, actions: [{ kind: "collapse-identical-file", count: 1 }] }, final: false,
    } });
  });
  it("a truncated paid response is not parsed or repaired and still keeps known usage and raw hash", async () => {
    const raw = payload("complete-looking transport"); const { execute, complete } = fixture(raw, { finishReason: "length" });
    await expect(execute()).rejects.toMatchObject({ code: "MODEL_RECEIPT_MISSING", usage: { promptTokens: 23, completionTokens: 11 },
      receipt: { rawResponseSha256: sha(raw), normalization: { attempted: false }, final: false } });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
