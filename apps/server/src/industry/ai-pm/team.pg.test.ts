import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssembledPreset } from "@workloom/runtime";
import { bundlesRoot, loadVerifiedBundleManifest, loadVerifiedBundleWorkforcePresets } from "@workloom/base/bundles";
import type { CompletionProvider, CompletionResult } from "@workloom/base/model-router";
import { ArtifactStore } from "./artifacts.js";
import { PmTeamService } from "./service.js";
import { PgPmStore } from "./store.js";
import { PmError, type EmployeeExecutionInput, type EmployeeExecutionResult, type PmAssetBinding, type PmTaskPlan, type PmScope } from "./types.js";
import { createPmEmployeeCatalog, type PmEmployeeCatalog } from "./employees.js";
import { TRUSTED_PM_EVIDENCE_POLICY } from "./skill-contracts.js";

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL && !!process.env.DATABASE_APP_URL;
const run = enabled ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const scopeA = { tenantId: `tenant-pmtest-${suffix}-a`, workspaceId: `ws-pmtest-${suffix}-a` };
const scopeB = { tenantId: `tenant-pmtest-${suffix}-b`, workspaceId: `ws-pmtest-${suffix}-b` };
const assets = loadVerifiedBundleWorkforcePresets("ai-pm");
const plan: PmTaskPlan[] = [
  { id: "requirements", presetKey: "requirement-analyst", goal: "提炼需求与明确的边界条件", dependsOn: [], acceptance: ["列出验收条件"], outputRefs: ["requirements.md"] },
  { id: "prd", presetKey: "doc-writer", goal: "依据上游需求起草完整PRD", dependsOn: ["requirements"], acceptance: ["引用上游需求"], outputRefs: ["prd.md"] },
];
const fixtureResult = (input: EmployeeExecutionInput): EmployeeExecutionResult => ({
  files: input.task.outputRefs.map((path) => ({ path, content: `${input.task.goal}\n完整验收条件\n${input.dependencyArtifacts.map((artifact) => artifact.content).join("\n")}` })),
  summary: "离线注入员工夹具完成真实文件写入", usage: { promptTokens: 31, completionTokens: 17 }, modelId: "fixture-deepseek",
  responseId: `fixture-${input.task.id}`, receipt: { adapter: "offline-test-fixture", dataMode: "fixture", final: true },
});
function completion(text: string): CompletionResult {
  return { text, message: { role: "assistant", content: text }, model: "fixture-deepseek", responseId: `fixture-${randomUUID()}`,
    promptTokens: 23, completionTokens: 11, finishReason: "stop", usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 } };
}
const provider = (tasks = plan): CompletionProvider => ({ modelId: "fixture-deepseek", complete: vi.fn(async () => completion(JSON.stringify({ tasks }))) });
function fixtureBinding(presetKey: string, digit: string): PmAssetBinding {
  return { schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm", bundleVersion: `3.0.${digit === "a" ? "1" : "2"}-fixture`,
    manifestSha256: digit.repeat(64), bundleIntegrityDigest: digit.repeat(64), presetKey, presetSha256: digit.repeat(64), skillTextSha256: digit.repeat(64),
    skills: [{ name: "fixture-skill", path: "skills/fixture-skill/SKILL.md", sha256: digit.repeat(64) }] };
}

run("MC-PM-002 isolated PostgreSQL + real artifact state machine (model fixtures, no paid I/O)", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let store: PgPmStore;
  let artifactStore: ArtifactStore;
  let artifactRoot: string;
  const services: PmTeamService[] = [];
  const catalog: PmEmployeeCatalog = {
    async list() { return assets.map((asset) => ({ presetKey: asset.preset_key, name: asset.name, description: asset.description })); },
    async assemble(_scope, presetKey, goal) {
      const asset = assets.find((item) => item.preset_key === presetKey);
      if (!asset) throw new PmError("EMPLOYEE_NOT_READY", "fixture employee absent");
      const preset: AssembledPreset = { agentId: `fixture-${presetKey}`, presetKey, version: asset.version, highRisk: asset.high_risk,
        fenceBindings: asset.fence_bindings, tools: asset.tools, prompt: asset.prompt,
        essentials: { archive: { internalFixture: true }, stage: "delivery", goal } };
      return { preset, skillText: "已核验技能夹具正文，实际岗位工具来自原始14员工资产" };
    },
  };
  function service(overrides: Partial<ConstructorParameters<typeof PmTeamService>[0]> = {}) {
    const value = new PmTeamService({ store, artifactStore, catalog, providerFactory: () => provider(), employeeExecutor: async (input) => fixtureResult(input), ...overrides });
    services.push(value); return value;
  }
  async function create(current: PmTeamService, input: Record<string, unknown> = {}) {
    return (await current.create(scopeA, { goal: "从需求到PRD产出完整可测量交付文件", idempotencyKey: randomUUID(), ...input }, "MEM-PM-FIXTURE")).detail;
  }
  async function scoped<T>(scope: PmScope, fn: (client: pg.PoolClient) => Promise<T>) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      const value = await fn(client); await client.query("COMMIT"); return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).port !== "55437" || new URL(process.env.DATABASE_APP_URL!).port !== "55437") {
      throw new Error("PM integration tests require the root-approved isolated sandbox on port55437; no default DB fallback");
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 20 });
    const migration = await readFile(new URL("../../../../../packages/db/migrations/0043_pm_team.sql", import.meta.url), "utf8");
    await owner.query(migration);
    for (const scope of [scopeA, scopeB]) {
      await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'pro')", [scope.tenantId, "PM test fixture"]);
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'PM test fixture',$1,'ai-pm','delivery')", [scope.workspaceId, scope.tenantId]);
    }
    store = new PgPmStore(app);
    artifactRoot = await mkdtemp(join(tmpdir(), "pm-team-pg-")); artifactStore = new ArtifactStore(artifactRoot);
  });
  afterAll(async () => {
    await Promise.allSettled(services.map((value) => value.close()));
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    await Promise.allSettled([owner?.end(), app?.end()]);
    // Do not delete append-only lifecycle evidence. UUID fixture rows remain in this isolated DB.
  });

  it("full goal and concurrent idempotency preserved; different payload conflicts", async () => {
    const current = service(); const key = randomUUID(); const goal = "长目标保留独特验收词。".repeat(800);
    const input = { goal, idempotencyKey: key, employee: "doc-writer" };
    const values = await Promise.all(Array.from({ length: 12 }, () => current.create(scopeA, input, "MEM-PM-FIXTURE")));
    expect(new Set(values.map((value) => value.detail.run.id)).size).toBe(1);
    expect(values.filter((value) => value.created)).toHaveLength(1);
    expect(values[0]!.detail.run.goal).toBe(goal);
    await expect(current.create(scopeA, { ...input, goal: "不同的目标内容" }, "MEM-PM-FIXTURE")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("all14 seeded employees assemble their own integrity-checked skill text with their actual tool contract", async () => {
    const workspace = await owner.query<{ tenant_id: string; id: string }>("SELECT id,tenant_id FROM workspaces WHERE id='ws-aipm-demo'");
    expect(workspace.rows[0], "root-approved AI-PM seed must be present; this test never reseeds the live sandbox").toBeDefined();
    const seeded = { tenantId: workspace.rows[0]!.tenant_id, workspaceId: workspace.rows[0]!.id };
    const actualCatalog = createPmEmployeeCatalog(store);
    const employees = await actualCatalog.list(seeded);
    expect(employees).toHaveLength(14);
    for (const employee of employees) {
      const assembled = await actualCatalog.assemble(seeded, employee.presetKey, "核验真实岗位技能与隔离交付合同");
      const asset = assets.find((item) => item.preset_key === employee.presetKey)!;
      expect(assembled.skillText.length, employee.presetKey).toBeGreaterThan(100);
      expect(assembled.preset.tools, employee.presetKey).toEqual(asset.tools);
      expect(assembled.preset.prompt, employee.presetKey).toEqual(asset.prompt);
      expect(asset.skills.every((name) => assembled.skillText.includes(`## ${name}\n`)), employee.presetKey).toBe(true);
      const manifest = loadVerifiedBundleManifest("ai-pm");
      expect(assembled.assetBinding).toMatchObject({ schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm", bundleVersion: "3.0.1",
        manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), bundleIntegrityDigest: manifest.integrity!.digest,
        presetKey: employee.presetKey, presetSha256: manifest.integrity!.assets[`presets/${employee.presetKey}.yml`],
        skillTextSha256: createHash("sha256").update(assembled.skillText).digest("hex") });
      for (const skill of assembled.assetBinding!.skills) {
        expect(skill.sha256).toBe(createHash("sha256").update(await readFile(join(bundlesRoot(), "ai-pm", skill.path))).digest("hex"));
      }
    }
  }, 30_000);

  it("a self-consistently re-sealed unsafe skill still fails the semantic asset contract before employee dispatch", async () => {
    const previousRoot = process.env.BUNDLES_ROOT;
    const sourceRoot = bundlesRoot(); const isolatedRoot = await mkdtemp(join(tmpdir(), "pm-unsafe-bundle-"));
    try {
      await cp(join(sourceRoot, "ai-pm"), join(isolatedRoot, "ai-pm"), { recursive: true });
      const path = "skills/changeset-harvest/SKILL.md";
      const unsafe = (await readFile(join(isolatedRoot, "ai-pm", path), "utf8")).replace("mockEvidence: blocked", "mockEvidence: allowed");
      await writeFile(join(isolatedRoot, "ai-pm", path), unsafe);
      const manifestPath = join(isolatedRoot, "ai-pm/bundle.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.integrity.assets[path] = createHash("sha256").update(unsafe).digest("hex");
      // Import the actual contract implementation by URL for this source-only fixture;
      // the server does not add a new runtime dependency or compile outside its rootDir.
      const { canonicalBundleArtifactPayload, parseBundleManifest } = await import(new URL("../../../../../packages/industry-contract/src/index.ts", import.meta.url).href);
      manifest.integrity.digest = createHash("sha256").update(canonicalBundleArtifactPayload(parseBundleManifest(manifest), manifest.integrity.assets)).digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));
      process.env.BUNDLES_ROOT = isolatedRoot;
      // This candidate is genuinely hash-consistent. Integrity alone cannot bless an unsafe evidence rule.
      expect(loadVerifiedBundleManifest("ai-pm").integrity!.digest).toBe(manifest.integrity.digest);
      const workspace = await owner.query<{ tenant_id: string; id: string }>("SELECT id,tenant_id FROM workspaces WHERE id='ws-aipm-demo'");
      const seeded = { tenantId: workspace.rows[0]!.tenant_id, workspaceId: workspace.rows[0]!.id };
      await expect(createPmEmployeeCatalog(store).assemble(seeded, "dev-orchestrator", "检查真实来源的安全规则"))
        .rejects.toMatchObject({ code: "SKILL_EVIDENCE_CONTRACT_INVALID" });
    } finally {
      if (previousRoot === undefined) delete process.env.BUNDLES_ROOT; else process.env.BUNDLES_ROOT = previousRoot;
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("double RLS and composite FKs reject cross-tenant and cross-workspace reads/writes", async () => {
    const detail = await create(service());
    await expect(store.detail(scopeB, detail.run.id)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    const unscoped = await app.query("SELECT id FROM pm_runs WHERE id=$1", [detail.run.id]);
    expect(unscoped.rows).toEqual([]);
    const wrongTenant = await scoped({ tenantId: scopeB.tenantId, workspaceId: scopeA.workspaceId }, (client) => client.query("SELECT id FROM pm_runs WHERE id=$1", [detail.run.id]));
    expect(wrongTenant.rows).toEqual([]);
    await expect(owner.query(
      `INSERT INTO pm_tasks(run_id,id,tenant_id,workspace_id,ordinal,preset_key,goal,acceptance,output_refs)
       VALUES($1,'forged',$2,$3,0,'doc-writer','forged target','["pass"]','["x.md"]')`,
      [detail.run.id, scopeB.tenantId, scopeB.workspaceId])).rejects.toMatchObject({ code: "23503" });
  });

  it("CAS admits one run worker and one task claimant; actual DAG artifacts feed downstream by hash", async () => {
    const current = service(); const detail = await create(current);
    const calls: EmployeeExecutionInput[] = [];
    const executing = service({ employeeExecutor: async (input) => { calls.push(input); return fixtureResult(input); } });
    await Promise.all(Array.from({ length: 10 }, () => executing.start(scopeA, detail.run.id)));
    const finished = await executing.waitForRun(scopeA, detail.run.id);
    expect(finished.run.status).toBe("completed"); expect(calls).toHaveLength(2);
    expect(finished.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    expect(calls[1]!.dependencyArtifacts).toHaveLength(1);
    expect(createHash("sha256").update(calls[1]!.dependencyArtifacts[0]!.content).digest("hex")).toBe(calls[1]!.dependencyArtifacts[0]!.sha256);
    expect(finished.run.usage).toEqual({ promptTokens: 85, completionTokens: 45 }); // one planner + two employee fixtures
    expect(finished.artifacts).toHaveLength(2);
    const events = await owner.query<{ action: string }>("SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE session_id=$1 ORDER BY seq", [detail.run.id]);
    expect(events.rows.map((row) => row.action)).toContain("pm.run.completed");
    const receipts = await owner.query<{ synced: boolean }>("SELECT (payload->'receipt'->>'synced')::boolean AS synced FROM biz_events WHERE session_id=$1 AND payload->'decision'->>'action'='pm.sandbox.artifact.write'", [detail.run.id]);
    expect(receipts.rows).toHaveLength(2); expect(receipts.rows.every((row) => row.synced)).toBe(true);
  });

  it("the default coding executor completes a real DSH read-write-read-write-final workflow beyond four model calls", async () => {
    let calls = 0;
    const scripted: CompletionProvider = { modelId: "fixture-deepseek", complete: vi.fn(async (messages: Parameters<CompletionProvider["complete"]>[0]) => {
      expect(messages.some((message) => message.role === "system" && String(message.content).includes(TRUSTED_PM_EVIDENCE_POLICY))).toBe(true);
      calls += 1;
      const result = completion(calls === 5 ? "已生成模块和测试，执行结果以独立沙箱回执为准。" : "");
      const actions = [
        ["read_file", { path: "inputs/context.json" }],
        ["write_file", { path: "sum.mjs", content: "export function sum(values){return values.reduce((total,value)=>total+value,0)}\n" }],
        ["read_file", { path: "sum.mjs" }],
        ["write_file", { path: "sum.test.mjs", content: "import{test}from'node:test';import assert from'node:assert/strict';import{sum}from'./sum.mjs';test('sum empty and populated',()=>{assert.equal(sum([]),0);assert.equal(sum([1,2]),3)})\n" }],
      ] as const;
      if (calls <= actions.length) {
        const [name, args] = actions[calls - 1]!;
        result.message = { role: "assistant", content: "", tool_calls: [{ id: `fixture-call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      return result;
    }) };
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, "a") };
    } };
    const current = service({ employeeExecutor: undefined, catalog: boundCatalog, providerFactory: () => scripted });
    const detail = await create(current, { employee: "dev-orchestrator", goal: "编写sum模块和可运行的边界测试，依次读取上下文、写模块、复读模块、写测试、提交最终回执。",
      checks: [{ type: "fileExists", path: "sum.mjs" }, { type: "fileExists", path: "sum.test.mjs" }] });
    await current.start(scopeA, detail.run.id);
    const finished = await current.waitForRun(scopeA, detail.run.id);
    expect(finished.run.status, finished.run.error ?? "coding run must complete").toBe("completed");
    expect(calls).toBe(5);
    expect(finished.tasks[0]!.adapterReceipt).toMatchObject({ adapter: "deepseek-harness-headless", modelCalls: 5, exitCode: 0, usageComplete: true,
      assetBinding: fixtureBinding("dev-orchestrator", "a"), assetBindingSource: "verified-catalog" });
    expect(finished.run.usage).toEqual({ promptTokens: 115, completionTokens: 55 });
    expect(finished.artifacts.map((artifact) => artifact.path).sort()).toEqual(["sum.mjs", "sum.test.mjs"]);
    const checks = finished.run.verification!.checks as Array<{ passed: boolean; message: string }>;
    const executed = checks.find((check) => check.passed && check.message.startsWith("{"));
    expect(executed, "the code must have an actual OS execution receipt, not just two existence checks").toBeDefined();
    const verification = JSON.parse(executed!.message);
    expect(verification).toMatchObject({ exitCode: 0, testSummary: { success: true } });
    expect(verification.testSummary.counts.passed).toBeGreaterThan(0);
  }, 45_000);

  it("a real DSH process with a metered final but no output retains its source binding in the failed attempt", async () => {
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, "a") };
    } };
    const scripted: CompletionProvider = { modelId: "fixture-deepseek", complete: vi.fn(async () => completion("未写文件，仅返回最终文本。")) };
    const current = service({ employeeExecutor: undefined, catalog: boundCatalog, providerFactory: () => scripted });
    const detail = await create(current, { employee: "dev-orchestrator", goal: "生成完整实现到result.md" });
    await current.start(scopeA, detail.run.id); const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.status).toBe("failed"); expect(failed.run.errorCode).toBe("DSH_OUTPUT_MISSING");
    expect(failed.run.usage).toEqual({ promptTokens: 23, completionTokens: 11 });
    expect(failed.tasks[0]!.attemptReceipts[0]).toMatchObject({ final: false, receipt: { adapter: "deepseek-harness-headless", modelCalls: 1,
      assetBinding: fixtureBinding("dev-orchestrator", "a"), assetBindingSource: "verified-catalog" } });
    expect(failed.artifacts).toEqual([]);
  }, 45_000);

  it("failed employee blocks downstream; known failed model usage is retained across explicit resume", async () => {
    let failed = true; const calls: string[] = [];
    const current = service({ employeeExecutor: async (input) => {
      calls.push(input.task.id);
      if (failed) {
        failed = false;
        throw Object.assign(new PmError("DSH_OUTPUT_MISSING", "paid fixture failed before artifact"), {
          usage: { promptTokens: 9, completionTokens: 4 }, modelId: "fixture-deepseek", receipt: { adapter: "offline-test-fixture", final: false, usageComplete: true },
        });
      }
      return fixtureResult(input);
    } });
    const detail = await create(current);
    await current.start(scopeA, detail.run.id); const failure = await current.waitForRun(scopeA, detail.run.id);
    expect(failure.run.status).toBe("failed"); expect(failure.tasks[1]!.status).toBe("blocked");
    expect(calls).toEqual(["requirements"]); expect(failure.run.usage).toEqual({ promptTokens: 32, completionTokens: 15 });
    await current.start(scopeA, detail.run.id, true); const completed = await current.waitForRun(scopeA, detail.run.id);
    expect(completed.run.status).toBe("completed");
    expect(completed.run.usage).toEqual({ promptTokens: 94, completionTokens: 49 });
    expect(completed.tasks[0]!.attemptReceipts).toHaveLength(2);
    expect(completed.tasks[0]!.usage).toEqual({ promptTokens: 40, completionTokens: 21 });
  });

  it("server-owned catalog provenance survives worker forgery, mutation, paid failure and a later asset version on resume", async () => {
    let digit = "a"; let fail = true;
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, digit) };
    } };
    const planningProvider = provider();
    const current = service({ catalog: boundCatalog, providerFactory: () => planningProvider, employeeExecutor: async (input) => {
      expect(input.assetBinding).toEqual(fixtureBinding(input.task.presetKey, digit));
      // A hostile adapter can mutate its own copy and self-report a different binding.
      (input.assetBinding!.skills[0] as { sha256: string }).sha256 = "f".repeat(64);
      const forged = { adapter: "offline-test-fixture", final: !fail, assetBinding: fixtureBinding("model-forged", "f"), assetBindingSource: "model" };
      if (fail) { fail = false; throw Object.assign(new PmError("DSH_OUTPUT_MISSING", "known paid fixture failure"), {
        usage: { promptTokens: 9, completionTokens: 4 }, modelId: "fixture-deepseek", receipt: forged,
      }); }
      return { ...fixtureResult(input), receipt: forged };
    } });
    const detail = await create(current); await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.status).toBe("failed");
    expect(failed.run.planningReceipt).toMatchObject({ assetBinding: fixtureBinding("chief-pm", "a"), assetBindingSource: "verified-catalog" });
    expect(vi.mocked(planningProvider.complete).mock.calls[0]![0][0]!.content).toContain(TRUSTED_PM_EVIDENCE_POLICY);
    expect(failed.tasks[0]!.attemptReceipts[0]).toMatchObject({ final: false, receipt: { assetBinding: fixtureBinding("requirement-analyst", "a"), assetBindingSource: "verified-catalog" } });
    digit = "b"; await current.start(scopeA, detail.run.id, true);
    const completed = await current.waitForRun(scopeA, detail.run.id);
    expect(completed.run.status).toBe("completed");
    expect(completed.run.planningReceipt).toEqual(failed.run.planningReceipt);
    expect(completed.tasks[0]!.attemptReceipts).toHaveLength(2);
    expect(completed.tasks[0]!.attemptReceipts[0]).toEqual(failed.tasks[0]!.attemptReceipts[0]);
    expect(completed.tasks[0]!.attemptReceipts[1]).toMatchObject({ receipt: { assetBinding: fixtureBinding("requirement-analyst", "b"), assetBindingSource: "verified-catalog" } });
    expect(completed.tasks[1]!.adapterReceipt).toMatchObject({ assetBinding: fixtureBinding("doc-writer", "b"), assetBindingSource: "verified-catalog" });
  });

  it("an injected worker without catalog proof cannot self-certify verified asset provenance", async () => {
    const current = service({ employeeExecutor: async (input) => ({ ...fixtureResult(input), receipt: {
      adapter: "offline-test-fixture", assetBinding: fixtureBinding("forged", "f"), assetBindingSource: "verified-catalog",
    } }) });
    const detail = await create(current, { employee: "doc-writer" }); await current.start(scopeA, detail.run.id);
    const completed = await current.waitForRun(scopeA, detail.run.id);
    expect(completed.run.status).toBe("completed");
    expect(completed.tasks[0]!.adapterReceipt).toEqual({ adapter: "offline-test-fixture" });
  });

  it("cancellation aborts the in-flight worker and cannot be overwritten by late completion", async () => {
    let started!: () => void; const entered = new Promise<void>((done) => { started = done; });
    const current = service({ employeeExecutor: async (input) => {
      started(); return new Promise((_done, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    } });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); await entered;
    await current.cancel(scopeA, detail.run.id, "MEM-PM-FIXTURE");
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("cancelled"); expect(result.artifacts).toEqual([]);
    await expect(current.start(scopeA, detail.run.id, true)).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
  });

  it("a paid response arriving after cancellation retains metering without reviving the run", async () => {
    let started!: () => void; const entered = new Promise<void>((done) => { started = done; });
    let release!: () => void; const finish = new Promise<void>((done) => { release = done; });
    const current = service({ employeeExecutor: async (input) => {
      started(); await finish; return fixtureResult(input); // deliberately simulates a transport that ignores abort
    } });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); await entered;
    await current.cancel(scopeA, detail.run.id, "MEM-PM-FIXTURE"); release();
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("cancelled"); expect(result.artifacts).toEqual([]);
    expect(result.run.usage).toEqual({ promptTokens: 31, completionTokens: 17 });
    expect(result.tasks[0]!.attemptReceipts).toHaveLength(1);
    expect(result.tasks[0]!.attemptReceipts[0]).toMatchObject({ final: false, usage: { promptTokens: 31, completionTokens: 17 } });
  });

  it("cancellation waiting on a completing transaction cannot overwrite its completed terminal state", async () => {
    const initial = await create(service()); const lock = await owner.connect();
    let cancelling: Promise<unknown> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("UPDATE pm_runs SET status='completed' WHERE id=$1", [initial.run.id]);
      cancelling = store.cancel(scopeA, initial.run.id, "MEM-PM-FIXTURE");
      const expectation = expect(cancelling).rejects.toMatchObject({ code: "RUN_ALREADY_COMPLETED" });
      // Wait for a real PostgreSQL lock wait, rather than relying on scheduler timing.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const blocked = await owner.query<{ blocked: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='workloom_app' AND wait_event_type='Lock' AND query LIKE '%pm_runs%') AS blocked");
        waiting = blocked.rows[0]!.blocked;
        if (!waiting) await new Promise((done) => setTimeout(done, 5));
      }
      expect(waiting, "the cancel transaction must actually wait for the concurrent terminal commit").toBe(true);
      await lock.query("COMMIT"); await expectation;
      expect((await store.detail(scopeA, initial.run.id)).run.status).toBe("completed");
    } finally { await lock.query("ROLLBACK"); lock.release(); await cancelling?.catch(() => undefined); }
  });

  it("a truncated paid planner response stays blocked and retains the actual usage receipt", async () => {
    const value = completion('{"tasks":['); value.finishReason = "length";
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, "a") };
    } };
    const current = service({ catalog: boundCatalog, providerFactory: () => ({ modelId: "fixture-deepseek", complete: vi.fn(async () => value) }) });
    const detail = await create(current);
    await current.start(scopeA, detail.run.id);
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("blocked"); expect(result.run.errorCode).toBe("MODEL_RECEIPT_MISSING");
    expect(result.run.usage).toEqual({ promptTokens: 23, completionTokens: 11 });
    expect(result.run.planningReceipts).toHaveLength(1); expect(result.tasks).toEqual([]);
    expect(result.run.planningReceipts[0]).toMatchObject({ receipt: { assetBinding: fixtureBinding("chief-pm", "a"), assetBindingSource: "verified-catalog" } });
  });

  it("failed final verification preserves its evidence; explicit recheck does not rerun completed paid employees", async () => {
    const worker = vi.fn(async (input: EmployeeExecutionInput) => fixtureResult(input));
    let passes = false;
    const current = service({ employeeExecutor: worker, verifyRun: async () => [{
      check: { type: "fileExists", path: "result.md" }, passed: passes,
      message: JSON.stringify({ backend: "trusted-offline-verifier-fixture", exitCode: passes ? 0 : 1, evidence: "fixture-check-hash" }),
    }] });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id);
    const rejected = await current.waitForRun(scopeA, detail.run.id);
    expect(rejected.run.status).toBe("failed"); expect(rejected.run.errorCode).toBe("RUN_CHECK_FAILED");
    expect(rejected.run.verification).toMatchObject({ checks: [{ passed: false, message: expect.stringContaining("fixture-check-hash") }] });
    const metered = rejected.run.usage;
    passes = true; await current.start(scopeA, detail.run.id, true);
    const rechecked = await current.waitForRun(scopeA, detail.run.id);
    expect(rechecked.run.status).toBe("completed"); expect(worker).toHaveBeenCalledTimes(1);
    expect(rechecked.run.usage).toEqual(metered);
    expect(rechecked.run.verification).toMatchObject({ checks: [{ passed: true }] });
  });

  it("expired crash lease pauses; explicit resume checks hashes and skips only verified completed tasks", async () => {
    const initial = await create(service()); const id = initial.run.id;
    await store.claimRun(scopeA, id, "dead-worker", false);
    await store.savePlan(scopeA, id, "dead-worker", plan, { source: "model", modelId: "fixture-deepseek", promptTokens: 1, completionTokens: 1 });
    await store.claimTask(scopeA, id, "requirements", "dead-worker");
    const first = fixtureResult({ task: plan[0]!, dependencyArtifacts: [] } as unknown as EmployeeExecutionInput);
    const written = await artifactStore.persist(scopeA, id, "requirements", first.files);
    await store.completeTask(scopeA, id, "requirements", "dead-worker", first, written, [], "requirements.write");
    await store.claimTask(scopeA, id, "prd", "dead-worker");
    await owner.query("UPDATE pm_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const calls: string[] = [];
    const restarted = service({ employeeExecutor: async (input) => { calls.push(input.task.id); return fixtureResult(input); } });
    expect((await restarted.detail(scopeA, id)).run.status).toBe("paused");
    expect(calls).toEqual([]);
    await restarted.start(scopeA, id, true);
    expect((await restarted.waitForRun(scopeA, id)).run.status).toBe("completed");
    expect(calls).toEqual(["prd"]);
    expect((await store.detail(scopeA, id)).run.goal).toBe(initial.run.goal);
  });

  it("tampered completed artifact forbids resume, rather than falsely skipping work", async () => {
    const initial = await create(service()); const id = initial.run.id;
    await store.claimRun(scopeA, id, "crashed", false);
    await store.savePlan(scopeA, id, "crashed", plan, { source: "model", modelId: "fixture-deepseek", promptTokens: 1, completionTokens: 1 });
    await store.claimTask(scopeA, id, "requirements", "crashed");
    const first = fixtureResult({ task: plan[0]!, dependencyArtifacts: [] } as unknown as EmployeeExecutionInput);
    const [artifact] = await artifactStore.persist(scopeA, id, "requirements", first.files);
    await store.completeTask(scopeA, id, "requirements", "crashed", first, [artifact!], [], "requirements.write");
    await owner.query("UPDATE pm_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    await writeFile(await artifactStore.resolveFile(scopeA, id, artifact!.path), "tampered bytes");
    const current = service();
    expect((await current.detail(scopeA, id)).run.status).toBe("paused");
    await expect(current.start(scopeA, id, true)).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  });

  it("journal failure rolls back creation; artifact receipt rows remain append-only", async () => {
    const failing = new PgPmStore(app, { appendEvent: async () => { throw new Error("fixture journal unavailable"); } });
    const key = randomUUID();
    await expect(failing.create(scopeA, { goal: "事务回滚检查目标", idempotencyKey: key }, "MEM-PM-FIXTURE", "fixture-deepseek", "fixture-policy")).rejects.toThrow();
    const rows = await owner.query("SELECT id FROM pm_runs WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3", [scopeA.tenantId, scopeA.workspaceId, key]);
    expect(rows.rows).toEqual([]);
    const actual = await create(service(), { employee: "doc-writer" });
    await service().start(scopeA, actual.run.id); // a second trusted controller instance owns this run
    // Test append-only directly with an existing receipt from an earlier successful test, if present.
    const receipt = await owner.query<{ id: string }>("SELECT id FROM pm_artifacts WHERE tenant_id=$1 AND workspace_id=$2 LIMIT 1", [scopeA.tenantId, scopeA.workspaceId]);
    expect(receipt.rows[0]).toBeDefined();
    await expect(scoped(scopeA, (client) => client.query("UPDATE pm_artifacts SET sha256=$2 WHERE id=$1", [receipt.rows[0]!.id, "0".repeat(64)]))).rejects.toThrow();
  });
});
