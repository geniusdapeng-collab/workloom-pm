import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllPools, getGatewayPool } from "@workloom/db";
import { eventHash, gatewayAppend } from "@workloom/base/workdata";
import { registerIndustryQuestPlanner, runQuestForThread } from "./thread-runner.js";

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL && !!process.env.DATABASE_APP_URL && !!process.env.DATABASE_GATEWAY_URL;
const run = enabled ? describe : describe.skip;
const nonce = randomUUID().slice(0, 8);
const scope = { tenantId: `tenant-runner-${nonce}`, workspaceId: `ws-runner-${nonce}` };
const other = { tenantId: `tenant-runner-other-${nonce}`, workspaceId: `ws-runner-other-${nonce}` };
const agentId = `agt-runner-${nonce}`;
const presetKey = `fixture-runner-${nonce}`;
const fullGoal = "完整长目标。\n" + "客户约束、验收条件和交付路径必须保留。".repeat(100);
const archive = () => ({ dataMode: "simulated", goals: { long: { text: fullGoal, version: "v3" } } });

run("MC-PM-005 isolated PostgreSQL goal recovery and atomic failure ledger (no model I/O)", () => {
  let owner: pg.Pool;
  async function thread(status = "queued", binding: Record<string, unknown> = { goal_ref: "long", goal_ref_version: "v3" }) {
    const id = `T-RUNNER-${randomUUID()}`;
    await owner.query("INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by,agent_id) VALUES($1,$2,$3,'短标题索引','quest',$4,'MEM-FIXTURE',$5)", [id, scope.tenantId, scope.workspaceId, status, agentId]);
    await gatewayAppend(getGatewayPool(), { ...scope, actor: { id: "MEM-FIXTURE", type: "human" }, sessionId: id }, {
      who: { id: "MEM-FIXTURE", type: "human" }, context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "thread", id }, decision: { action: "thread.dispatch", after: { threadId: id, title: "短标题索引", ...binding } }, rule_impact: [],
    });
    return id;
  }
  async function inspect(id: string) {
    const state = await owner.query<{ status: string; error: string | null }>("SELECT status,error FROM threads WHERE id=$1", [id]);
    const events = await owner.query<{ payload: { decision: Record<string, unknown>; receipt?: { synced?: boolean } } }>("SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq", [scope.tenantId, scope.workspaceId, id]);
    return { ...state.rows[0]!, events: events.rows.map((row) => row.payload) };
  }
  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      if (new URL(process.env[name]!).port !== "55437") throw new Error("Runner PG regression requires the root-authorized isolated sandbox on port 55437");
    }
    vi.stubEnv("LLM_PROVIDER", "mock");
    vi.stubEnv("WORKLOOM_TOOL_EXECUTOR_MODULE", "");
    vi.stubEnv("WORKLOOM_TOOL_EXECUTOR_MODULES", "");
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    for (const target of [scope, other]) {
      await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'runner test fixture','pro')", [target.tenantId]);
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'runner fixture',$1,'runner-fixture','definition')", [target.workspaceId, target.tenantId]);
      await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'runner-fixture',$3::jsonb)", [target.workspaceId, target.tenantId, JSON.stringify(archive())]);
    }
    await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,status,meta) VALUES($1,$2,$3,'runner fixture','v1','orchestrator','ready',$4::jsonb)", [agentId, scope.workspaceId, presetKey, JSON.stringify({ tools: [{ name: "fixture.read", access: "read", desc: "读取夹具" }, { name: "fixture.write", access: "write", desc: "写入夹具" }] })]);
  });
  beforeEach(async () => {
    registerIndustryQuestPlanner(null);
    await owner.query("UPDATE profiles SET archive=$2::jsonb WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify(archive())]);
    await owner.query("UPDATE agents SET status='ready' WHERE id=$1", [agentId]);
  });
  afterAll(async () => {
    registerIndustryQuestPlanner(null);
    await Promise.allSettled([owner?.end(), closeAllPools()]);
    vi.unstubAllEnvs();
    // Keep append-only lifecycle evidence in this isolated sandbox, no deletion.
  });

  it("both queued scheduler and paused resume pass the exact >500-char archive to the real planner", async () => {
    for (const status of ["queued", "paused"]) {
      const goals: string[] = [];
      registerIndustryQuestPlanner((goal) => {
        goals.push(goal);
        return (plannedGoal) => { goals.push(plannedGoal); return [{ stepId: "s1", action: "fixture.read", objectType: "fixture", tool: "fixture.read", params: { key: "fixture" }, label: "读取夹具" }]; };
      });
      const id = await thread(status);
      if (status === "queued") await owner.query("UPDATE threads SET status='running' WHERE id=$1", [id]);
      const result = await runQuestForThread(scope, { threadId: id, goal: "短标题索引", ...(status === "queued" ? { skipClaim: true } : {}) });
      expect(result.status).toBe("completed");
      expect(goals).toEqual([fullGoal, fullGoal]);
      expect((await inspect(id)).events.some((event) => event.receipt?.synced === true)).toBe(true);
    }
  });

  it("archive version drift rejects before planning and persists terminal failure plus WorkData receipt", async () => {
    const planner = vi.fn(); registerIndustryQuestPlanner(planner);
    const id = await thread();
    await owner.query("UPDATE profiles SET archive=jsonb_set(archive,'{goals,long,version}','\"v4\"'::jsonb) WHERE workspace_id=$1", [scope.workspaceId]);
    await expect(runQuestForThread(scope, { threadId: id, goal: "短标题索引" })).rejects.toThrow("版本");
    const value = await inspect(id);
    expect(value.status).toBe("failed");
    expect(value.error).toContain("版本");
    expect(planner).not.toHaveBeenCalled();
    expect(value.events.at(-1)).toMatchObject({ decision: { action: "thread.execution.failed", outcome: "error", phase: "goal" }, receipt: { synced: false } });
  });

  it("missing archive and assembly failure cannot leave claimed running zombies", async () => {
    const missing = await thread();
    await owner.query("UPDATE profiles SET archive=archive-'goals' WHERE workspace_id=$1", [scope.workspaceId]);
    await expect(runQuestForThread(scope, { threadId: missing, goal: "短标题索引" })).rejects.toThrow("档案");
    expect((await inspect(missing)).status).toBe("failed");
    await owner.query("UPDATE profiles SET archive=$2::jsonb WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify(archive())]);
    const disabled = await thread();
    await owner.query("UPDATE agents SET status='disabled' WHERE id=$1", [agentId]);
    await expect(runQuestForThread(scope, { threadId: disabled, goal: "短标题索引" })).rejects.toThrow("disabled");
    const value = await inspect(disabled);
    expect(value.status).toBe("failed");
    expect(value.events.at(-1)?.decision.action).toBe("thread.execution.failed");
  });

  it("a deterministic planning exception writes a failure event with no executed step or approval", async () => {
    registerIndustryQuestPlanner(() => () => { throw new Error("deterministic planner fixture failure"); });
    const id = await thread();
    await expect(runQuestForThread(scope, { threadId: id, goal: "短标题索引" })).rejects.toThrow("deterministic planner fixture failure");
    const value = await inspect(id);
    expect(value.status).toBe("failed");
    expect(value.events.map((event) => event.decision.action)).toEqual(["thread.dispatch", "thread.execution.failed"]);
    const approvals = await owner.query("SELECT count(*)::int AS count FROM approvals a JOIN biz_events e ON e.event_id=a.event_id WHERE e.workspace_id=$1 AND e.session_id=$2", [scope.workspaceId, id]);
    expect(approvals.rows[0]?.count).toBe(0);
  });

  it("a genuine pending approval remains pending if recovery later finds a missing goal", async () => {
    registerIndustryQuestPlanner(() => () => [{ stepId: "s1", action: "fixture.write", objectType: "fixture", tool: "fixture.write", params: { key: "fixture" }, label: "待审批夹具" }]);
    const id = await thread();
    const suspended = await runQuestForThread(scope, { threadId: id, goal: "短标题索引" });
    expect(suspended.status).toBe("pending_review");
    expect(suspended.pendingApprovalId).toBeTruthy();
    const before = await inspect(id);
    await owner.query("UPDATE profiles SET archive=archive-'goals' WHERE workspace_id=$1", [scope.workspaceId]);
    await expect(runQuestForThread(scope, { threadId: id, goal: "短标题索引" })).rejects.toThrow("档案");
    const after = await inspect(id);
    expect(after.status).toBe("pending_review");
    expect(after.events).toEqual(before.events);
    const approval = await owner.query("SELECT status,consumed_at FROM approvals WHERE approval_id=$1", [suspended.pendingApprovalId]);
    expect(approval.rows[0]).toMatchObject({ status: "pending", consumed_at: null });
  });

  it("cross-workspace access cannot read a bound goal or change the paused thread", async () => {
    const id = await thread("paused");
    await expect(runQuestForThread(other, { threadId: id, goal: "cross-workspace probe", presetRef: agentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const value = await inspect(id);
    expect(value.status).toBe("paused");
    expect(value.events.map((event) => event.decision.action)).toEqual(["thread.dispatch"]);
  });

  it("all generated real WorkData failure and execution evidence keeps a valid scoped hash chain", async () => {
    const events = await owner.query<{ prev_hash: string; hash: string; payload: unknown }>("SELECT prev_hash,hash,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq", [scope.tenantId, scope.workspaceId]);
    expect(events.rows.length).toBeGreaterThan(10);
    let previous = "GENESIS";
    for (const event of events.rows) {
      expect(event.prev_hash).toBe(previous);
      expect(event.hash).toBe(eventHash(previous, event.payload));
      previous = event.hash;
    }
  });
});
