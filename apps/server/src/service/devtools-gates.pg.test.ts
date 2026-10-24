import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeAllPools } from "@workloom/db";
import { approveRelease, listTasks, taskDetail } from "./devtools.js";
import { captureDevContent, type DevContentSnapshot } from "./devtools-evidence.js";
import { requireIsolatedPgTestConfig } from "../test-support/isolated-pg.js";

const writes = vi.hoisted(() => ({ commit: vi.fn(), merge: vi.fn(), tag: vi.fn() }));
vi.mock("@workloom/base/dev-bridge", () => ({
  defaultAdapters: () => [], startSession: vi.fn(), worktreeAdd: vi.fn(), worktreeDiscard: async () => undefined,
  collectDiff: vi.fn(), detectGateScripts: vi.fn(), commitWorktreeChanges: writes.commit, mergeIntoBaseline: writes.merge,
  createTag: writes.tag, listTags: async () => [], suggestVersion: () => "v0.1.0", assertGitRepo: vi.fn(),
  baselineCommit: vi.fn(), statusFingerprint: vi.fn(), buildTaskPrompt: vi.fn(), judgeCommand: vi.fn(),
  DeclarativeAdapter: class {}, loadDeclarativeAdapters: () => ({ adapters: [], errors: [] }), customToolDirs: () => [],
}));

const enabled = process.env.RUN_DB_TESTS === "1";
const run = enabled ? describe : describe.skip;
run("IA-07 real isolated PostgreSQL release evidence (git writes are explicit offline fixtures)", { timeout: 30_000 }, () => {
  let owner: pg.Pool;
  const roots: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const tenantId = `tenant-devgate-${suffix}`, workspace = `ws-devgate-${suffix}`, other = `ws-devgate-other-${suffix}`;
  const actor = { id: "MEM-DEVGATE-FIXTURE", type: "human" as const };
  const valid = (taskId: string, sessionId: string, snapshot: DevContentSnapshot, examId: string) => ({ schema: "workloom.dev-gates/v3", contentBinding: { taskId, sessionId, snapshot }, hardGates: [{ name: "secret-scan", ok: true, log: "fixture deterministic scan passed" }],
    llmReview: { ok: true, report: "PASS fixture summary review", mock: false, state: "passed" },
    exam: { examId, score: 98, verdict: "pass", mock: false, state: "completed", status: "done", totalQuestions: 3, finishedAt: "2026-10-24T00:00:00.000Z" } });

  beforeAll(async () => {
    const database = requireIsolatedPgTestConfig();
    owner = new pg.Pool({ connectionString: database.ownerUrl });
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Dev gate fixture','pro')", [tenantId]);
    for (const id of [workspace, other]) await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'Dev gate fixture',$1,'ai-pm','delivery')", [id, tenantId]);
    writes.commit.mockResolvedValue(true); writes.merge.mockResolvedValue("c".repeat(40)); writes.tag.mockResolvedValue(undefined);
  });
  afterAll(async () => { await closeAllPools(); await owner?.end(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  async function fixture(receipt?: unknown, passed = true, examScope: string | null = workspace) {
    const id = randomUUID().slice(0, 10), repoId = `repo-${id}`, taskId = `task-${id}`, sessionId = `session-${id}`, changesetId = `change-${id}`;
    const root = mkdtempSync(join(tmpdir(), "workloom-dev-gates-pg-")); roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "reviewed fixture\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@workloom.local", "commit", "-qm", "fixture baseline"], { cwd: root });
    writeFileSync(join(root, "output.txt"), "reviewed untracked output\n");
    const snapshot = await captureDevContent(root), examId = `exam-${id}`;
    if (examScope) {
      await owner.query("INSERT INTO eval_exams(id,workspace_id,exam_type,trigger_source,total_questions,status,total_score,verdict,finished_at) VALUES($1,$2,'on-change',$3,3,'done',98,'pass','2026-10-24T00:00:00Z')", [examId, examScope, `dev-task:${taskId}:session:${sessionId}`]);
      for (let n = 0; n < 3; n++) {
        const questionId = `q-${id}-${n}`;
        await owner.query("INSERT INTO eval_questions(id,workspace_id,subject,structure,source,scenario) VALUES($1,$2,'skill','single-single','fixture','{}')", [questionId, examScope]);
        await owner.query("INSERT INTO eval_answers(id,workspace_id,exam_id,question_id,passed,red_line_hit) VALUES($1,$2,$3,$4,true,false)", [`a-${id}-${n}`, examScope, examId, questionId]);
      }
    }
    await owner.query("INSERT INTO dev_repos(id,workspace_id,name,path,registered_by) VALUES($1,$2,'fixture',$3,'MEM-DEVGATE-FIXTURE')", [repoId, workspace, `/fixture-${id}`]);
    await owner.query("INSERT INTO dev_tasks(id,workspace_id,repo_id,title,task_prompt,acceptance,status,created_by) VALUES($1,$2,$3,'fixture task','fixture prompt','[\"pass\"]','pending_approval','MEM-DEVGATE-FIXTURE')", [taskId, workspace, repoId]);
    await owner.query("INSERT INTO dev_sessions(id,workspace_id,task_id,tool_key,worktree_path,branch,baseline_commit,status_fingerprint,exit_reason,ended_at) VALUES($1,$2,$3,'fixture',$5,'fixture-branch',$4,'fixture','done',now())", [sessionId, workspace, taskId, "a".repeat(40), root]);
    await owner.query("INSERT INTO dev_changesets(id,workspace_id,session_id,task_id,gate_results,gates_passed) VALUES($1,$2,$3,$4,$5::jsonb,$6)", [changesetId, workspace, sessionId, taskId, JSON.stringify(receipt ?? valid(taskId, sessionId, snapshot, examId)), passed]);
    return { taskId, sessionId, changesetId, examId, root };
  }
  it.each(["missing", "wrong-scope", "wrong-session", "changed-score", "missing-answer", "changed-content"])("a %s real dependency stays unverified in list/detail and never reaches git", async (kind) => {
    const item = await fixture(undefined, true, kind === "missing" ? null : kind === "wrong-scope" ? other : workspace);
    if (kind === "wrong-session") await owner.query("UPDATE eval_exams SET trigger_source='dev-task:other:session:other' WHERE id=$1", [item.examId]);
    if (kind === "changed-score") await owner.query("UPDATE eval_exams SET total_score=97 WHERE id=$1", [item.examId]);
    if (kind === "missing-answer") await owner.query("DELETE FROM eval_answers WHERE id=(SELECT id FROM eval_answers WHERE exam_id=$1 LIMIT 1)", [item.examId]);
    if (kind === "changed-content") writeFileSync(join(item.root, "output.txt"), "unreviewed changed output\n");
    expect((await taskDetail(workspace, item.taskId)).task?.release_verified).toBe(false);
    expect((await listTasks(workspace)).tasks.find((task) => task.id === item.taskId)?.release_verified).toBe(false);
    const before = writes.commit.mock.calls.length;
    await expect(approveRelease(workspace, item.taskId, { changelog: "fixture" }, actor)).rejects.toThrow(/门禁/);
    expect(writes.commit.mock.calls).toHaveLength(before);
    expect((await owner.query("SELECT id FROM releases WHERE workspace_id=$1 AND tasks @> $2::jsonb", [workspace, JSON.stringify([item.taskId])])).rows).toEqual([]);
  });
  it("list and detail resolve the actual latest receipt and do not expose helper query columns", async () => {
    const item = await fixture();
    const listed = (await listTasks(workspace)).tasks.find((task) => task.id === item.taskId)!;
    expect(listed.release_verified).toBe(true); expect(listed).not.toHaveProperty("latest_gate_results");
    expect((await taskDetail(workspace, item.taskId)).task?.release_verified).toBe(true);
    expect((await listTasks(other)).tasks).toEqual([]);
    expect((await taskDetail(other, item.taskId)).task).toBeNull();
  });
  it("a legacy mock green flag stays unverified and cannot reach git or a release row", async () => {
    const item = await fixture({ hardGates: [{ name: "secret-scan", ok: true }], llmReview: { ok: true, mock: true }, exam: { verdict: null, mock: true } });
    expect((await taskDetail(workspace, item.taskId)).task?.release_verified).toBe(false);
    const before = writes.merge.mock.calls.length;
    await expect(approveRelease(workspace, item.taskId, { changelog: "fixture" }, actor)).rejects.toThrow(/门禁/);
    expect(writes.merge.mock.calls).toHaveLength(before);
    expect((await owner.query("SELECT id FROM releases WHERE workspace_id=$1 AND tasks @> $2::jsonb", [workspace, JSON.stringify([item.taskId])])).rows).toEqual([]);
  });
  it("a newer session invalidates the old green receipt", async () => {
    const item = await fixture();
    await owner.query("INSERT INTO dev_sessions(id,workspace_id,task_id,tool_key,worktree_path,branch,baseline_commit,status_fingerprint,started_at) VALUES($1,$2,$3,'fixture','/fixture-new-worktree','fixture-new-branch',$4,'fixture',now()+interval '1 second')", [`new-${item.sessionId}`, workspace, item.taskId, "b".repeat(40)]);
    expect((await taskDetail(workspace, item.taskId)).task?.release_verified).toBe(false);
    expect((await listTasks(workspace)).tasks.find((task) => task.id === item.taskId)!.release_verified).toBe(false);
    await expect(approveRelease(workspace, item.taskId, { changelog: "fixture" }, actor)).rejects.toThrow(/门禁/);
  });
  it("a valid versioned receipt reaches explicit approval and its actual release transaction", async () => {
    const item = await fixture();
    const result = await approveRelease(workspace, item.taskId, { changelog: "offline git fixture; actual PG release transaction" }, actor);
    expect(result.release.version).toBe("v0.1.0");
    expect((await owner.query("SELECT status FROM dev_tasks WHERE id=$1", [item.taskId])).rows[0].status).toBe("released");
    const events = await owner.query("SELECT payload FROM biz_events WHERE payload->'decision'->>'action'='dev.release.approve' AND payload->'object'->>'id'=$1", [result.release.id]);
    expect(events.rows).toHaveLength(1);
  });
});
