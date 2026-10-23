import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDshEmployeeExecutor, dshExecutionFailure, parseDshJsonOutput } from "./dsh-adapter.js";
import { PmError } from "./types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const scratchRoot = resolve(repoRoot, "..");
interface Tool {
  name: string;
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<string>;
}
const pluginUrl = new URL("./dsh-workspace.plugin.mjs", import.meta.url).href;
const plugin = await import(pluginUrl) as { apply(ctx: unknown, config: unknown): void };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(scratchRoot, "pm-dsh-unit-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function tools(outputRefs = ["report.md"]) {
  const registered = new Map<string, Tool>();
  let guard: (execution: { name: string }) => string | undefined = () => undefined;
  plugin.apply({ tools: {
    register(tool: Tool) { registered.set(tool.name, tool); },
    guard(check: typeof guard) { guard = check; },
  } }, { workspaceRoot: directory, outputRefs, maxToolCalls: 5 });
  const execute = async (name: string, args: unknown) => {
    const denial = guard({ name });
    if (denial) throw new Error(denial);
    const tool = registered.get(name);
    if (!tool) throw new Error("unknown tool");
    return await tool.execute(args, { signal: new AbortController().signal });
  };
  return { registered, execute };
}

describe("pinned DSH output contract", () => {
  const success = [
    { type: "session", sessionId: "session-fixture", cwd: "/fixture" },
    { type: "status", phase: "turn_end", reason: { kind: "completed" } },
    { type: "final", text: "已写入产物" },
  ].map((item) => JSON.stringify(item)).join("\n");
  it("requires successful process, completed turn, session and final together", () => {
    expect(parseDshJsonOutput(success, 0)).toMatchObject({ sessionId: "session-fixture", summary: "已写入产物" });
    expect(() => parseDshJsonOutput(success, 1)).toThrow("子进程失败");
    expect(() => parseDshJsonOutput(success.replace('"completed"', '"error"'), 0)).toThrow("轮次没有完成");
    expect(() => parseDshJsonOutput(success.split("\n").slice(0, -1).join("\n"), 0)).toThrow("final");
    expect(() => parseDshJsonOutput(`plugin noise\n${success}`, 0)).toThrow("非 JSON");
    expect(() => parseDshJsonOutput(success.replace('"已写入产物"', '""'), 0)).toThrow("final");
  });
  it("rejects invalid process budgets before spawning", () => {
    const provider = { modelId: "fixture", complete: async () => { throw new Error("must not call"); } };
    expect(() => createDshEmployeeExecutor({ provider, maxModelCalls: 0 })).toThrow("maxModelCalls");
    expect(() => createDshEmployeeExecutor({ provider, timeoutMs: Number.NaN })).toThrow("timeoutMs");
    expect(() => createDshEmployeeExecutor({ provider, maxTokens: 100000 })).toThrow("maxTokens");
  });
  it("preserves budget refusal and cancellation instead of calling either an execution failure", () => {
    for (const message of ["模型调用失败：HTTP 429", "HTTP 402", "PM_BUDGET_BLOCKED"]) {
      expect(dshExecutionFailure(new Error(message))).toMatchObject({ code: "DSH_MODEL_BUDGET", httpStatus: 429 });
    }
    const cancelled = new PmError("DSH_CANCELLED", "cancelled", 409);
    expect(dshExecutionFailure(cancelled)).toBe(cancelled);
    expect(dshExecutionFailure(new Error("HTTP 500"))).toMatchObject({ code: "DSH_WORKER_FAILED" });
  });
  it("does not let a provider SDK string code hide its explicit HTTP 429 quota refusal", () => {
    const upstream = Object.assign(new Error("模型调用失败：HTTP 429"), { code: "ERR_PROVIDER_RESPONSE" });
    expect(dshExecutionFailure(upstream)).toMatchObject({ code: "DSH_MODEL_BUDGET", httpStatus: 429, cause: upstream });
  });
});

describe("employee workspace capabilities", () => {
  it("publishes only three fixed tools and reads/writes Unicode output", async () => {
    const { registered, execute } = tools(["文档/需求.md"]);
    expect([...registered.keys()].sort()).toEqual(["list_files", "read_file", "write_file"]);
    await execute("write_file", { path: "文档/需求.md", content: "# 真实文件\n特殊字符：引号\"与换行\n" });
    const result = JSON.parse(await execute("read_file", { path: "文档/需求.md" })) as { content: string };
    expect(result.content).toContain("特殊字符");
    expect(JSON.parse(await execute("list_files", {}))).toMatchObject({ files: ["文档/需求.md"] });
  });
  it("denies shell, network, traversal, unowned output and reserved inputs", async () => {
    const { execute } = tools();
    await expect(execute("bash", { command: "echo host" })).rejects.toThrow("allowlist");
    await expect(execute("web_fetch", { url: "https://example.com" })).rejects.toThrow("allowlist");
    for (const path of ["../escape", "/etc/hosts", "dir/../../escape", "dir\\escape"]) {
      await expect(execute("read_file", { path })).rejects.toThrow("PM_WORKSPACE_DENIED");
    }
    // Use a fresh capability instance after deliberately exhausting the first one's limit.
    await expect(tools().execute("write_file", { path: "other.md", content: "no" })).rejects.toThrow("does not own");
    expect(() => tools(["inputs/context.json"])).toThrow("reserved");
  });
  it("rejects both ancestor and leaf symlinks without touching the target", async () => {
    const external = await mkdtemp(join(scratchRoot, "pm-dsh-external-"));
    try {
      await writeFile(join(external, "secret.txt"), "fixture-private");
      await symlink(external, join(directory, "linked"));
      await symlink(join(external, "secret.txt"), join(directory, "report.md"));
      const { execute } = tools();
      await expect(execute("read_file", { path: "linked/secret.txt" })).rejects.toThrow("symbolic");
      await expect(execute("write_file", { path: "report.md", content: "overwritten" })).rejects.toThrow("symbolic");
      expect(await readFile(join(external, "secret.txt"), "utf8")).toBe("fixture-private");
    } finally { await rm(external, { recursive: true, force: true }); }
  });
  it("enforces nonempty files, byte limits, tool budget and cancellation", async () => {
    const { execute } = tools();
    await expect(execute("write_file", { path: "report.md", content: " " })).rejects.toThrow("nonempty");
    await expect(execute("write_file", { path: "report.md", content: "文".repeat(100000) })).rejects.toThrow("256 KiB");
    await execute("list_files", {}); await execute("list_files", {}); await execute("list_files", {});
    await expect(execute("list_files", {})).rejects.toThrow("budget exhausted");
    const { registered } = tools();
    const controller = new AbortController(); controller.abort();
    await expect(registered.get("list_files")!.execute({}, { signal: controller.signal })).rejects.toThrow();
  });
});
