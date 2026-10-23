import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as devtools from "./devtools.js";

const mock = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), append: vi.fn(), llm: vi.fn(), model: vi.fn(), exam: vi.fn(),
  start: vi.fn(), worktree: vi.fn(), discard: vi.fn(), diff: vi.fn(), scripts: vi.fn(), commit: vi.fn(), merge: vi.fn(), tag: vi.fn(),
}));
vi.mock("./events.js", () => ({ svcQuery: mock.query, serviceTx: mock.transaction, appendEventOn: mock.append }));
vi.mock("./llm.js", () => ({ llmCall: mock.llm }));
vi.mock("./eval.js", () => ({ runExam: mock.exam }));
vi.mock("@workloom/base/dev-bridge", () => ({
  defaultAdapters: () => [], startSession: mock.start, worktreeAdd: mock.worktree, worktreeDiscard: mock.discard,
  collectDiff: mock.diff, detectGateScripts: mock.scripts, commitWorktreeChanges: mock.commit, mergeIntoBaseline: mock.merge,
  createTag: mock.tag, listTags: async () => [], suggestVersion: () => "v0.1.0", assertGitRepo: async () => undefined,
  baselineCommit: async () => "a".repeat(40), statusFingerprint: async () => "fixture-status-hash", buildTaskPrompt: () => "fixture task",
  judgeCommand: () => ({ verdict: "allow" }), DeclarativeAdapter: class {}, loadDeclarativeAdapters: () => ({ adapters: [], errors: [] }),
  customToolDirs: () => ["/fixture-tools"],
}));

const workspace = "ws-dev-gates-fixture";
const actor = { id: "MEM-FIXTURE", type: "human" as const };
const task = { id: "task-gates", repo_id: "repo-gates", title: "交付受管功能", task_prompt: "实现并测试指定功能",
  assigned_tool: "fixture", repair_round: 2, review_note: null as string | null, status: "confirmed" };
const repo = { id: "repo-gates", name: "fixture", path: "/fixture-repo", baseline_branch: "main", status: "active" };
const session = { id: "session-gates", worktree_path: "/fixture-repo/.workloom/task-gates", branch: "dev/task-gates", last_message: "夹具完成" };
let changeset: { id: string; session_id: string; gate_results: Record<string, unknown>; gates_passed: boolean } | undefined;
let fixtureRoot = "";
let examDbOverride: Record<string, unknown> | null | undefined;
let resolveSession: (value: { exitReason: string; exitCode: number; lastMessage: string }) => void;

function validExam(overrides: Record<string, unknown> = {}) {
  return { exam: { id: "exam-fixture", status: "done", totalQuestions: 3, totalScore: 96, verdict: "pass", finishedAt: "2026-10-24T00:00:00.000Z", ...overrides }, answers: [], report: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  examDbOverride = undefined;
  fixtureRoot = mkdtempSync(join(tmpdir(), "workloom-dev-gates-"));
  repo.path = fixtureRoot; session.worktree_path = join(fixtureRoot, "checkout");
  mkdirSync(session.worktree_path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: session.worktree_path });
  writeFileSync(join(session.worktree_path, "tracked.txt"), "reviewed tracked content\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: session.worktree_path });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@workloom.local", "commit", "-qm", "fixture baseline"], { cwd: session.worktree_path });
  writeFileSync(join(session.worktree_path, "new-output.txt"), "reviewed untracked content\n");
  task.status = "confirmed"; task.repair_round = 2; task.review_note = null; changeset = undefined;
  session.id = "session-gates";
  mock.model.mockReset().mockResolvedValue("PASS 覆盖任务摘要，仍需完整代码人工复核");
  mock.llm.mockReset().mockReturnValue(mock.model); mock.exam.mockReset().mockResolvedValue(validExam());
  mock.worktree.mockResolvedValue({ worktreePath: session.worktree_path, branch: session.branch });
  mock.diff.mockResolvedValue({ diffStat: "", files: [], untracked: [] }); mock.scripts.mockResolvedValue({});
  mock.commit.mockResolvedValue(true); mock.merge.mockResolvedValue("b".repeat(40)); mock.tag.mockResolvedValue(undefined);
  mock.discard.mockResolvedValue(undefined); mock.append.mockResolvedValue({ eventId: "fixture-event" });
  mock.start.mockImplementation(() => ({ result: new Promise((done) => { resolveSession = done; }), cancel: vi.fn() }));
  mock.query.mockReset().mockImplementation(async (_scope: string, sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM eval_exams")) {
      if (examDbOverride === null) return [];
      const result = await mock.exam.mock.results.at(-1)?.value;
      const exam = result?.exam;
      return exam ? [{ id: exam.id, workspace_id: workspace, exam_type: "on-change",
        trigger_source: `dev-task:${task.id}:session:${session.id}`, status: exam.status,
        total_questions: exam.totalQuestions, total_score: exam.totalScore, verdict: exam.verdict,
        finished_at: exam.finishedAt, red_line_hit: false, answer_count: exam.totalQuestions, ...examDbOverride }] : [];
    }
    if (sql.includes("SELECT * FROM dev_tasks")) return [{ ...task }];
    if (sql.includes("SELECT * FROM dev_repos")) return [{ ...repo }];
    if (sql.includes("FROM dev_tool_installs")) return [{ tool_key: "fixture", bin_path: "/fixture-cli" }];
    if (sql.includes("SELECT thread_id FROM dev_sessions")) return [];
    if (sql.includes("FROM dev_sessions") && sql.includes("SELECT")) return [{ ...session }];
    if (sql.includes("SELECT repair_round")) return [{ repair_round: task.repair_round }];
    if (sql.includes("FROM dev_changesets") && sql.includes("SELECT")) return changeset ? [{ ...changeset }] : [];
    if (sql.includes("SELECT change_kind")) return [{ change_kind: "feat" }];
    if (sql.includes("INSERT INTO dev_changesets")) {
      changeset = { id: String(params[0]), session_id: String(params[2]), gate_results: JSON.parse(String(params[8])), gates_passed: Boolean(params[9]) };
    }
    if (sql.includes("INSERT INTO dev_sessions")) session.id = String(params[0]);
    if (sql.includes("INSERT INTO releases")) return [{ id: params[0], version: params[3] }];
    if (sql.includes("UPDATE dev_tasks")) {
      if (sql.includes("status=$3")) task.status = String(params[2]);
      else { const status = /status='([a-z_]+)'/.exec(sql)?.[1]; if (status) task.status = status; }
      if (sql.includes("repair_round=repair_round+1")) task.repair_round++;
      if (sql.includes("review_note=$3")) task.review_note = String(params[2]);
    }
    return [];
  });
  mock.transaction.mockReset().mockImplementation(async (scope: string, fn: (client: unknown, sc: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[] = []) => ({ rows: await mock.query(scope, sql, params), rowCount: 1 }),
  }, { workspaceId: scope, tenantId: "tenant-fixture" }));
});

afterEach(() => { if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); });

async function finishCodingSession() {
  const module = devtools;
  module.setDevToolAdapters([{ toolKey: "fixture", displayName: "fixture CLI", binName: () => "fixture", detect: async () => null,
    capabilities: () => ({ headless: true, streamEvents: "jsonl", sessionResume: false, sandboxFlag: false }), buildArgs: () => [], parseLine: () => null }]);
  await module.dispatchTask(workspace, task.id, actor);
  resolveSession({ exitReason: "done", exitCode: 0, lastMessage: "夹具完成" });
  await vi.waitFor(() => { expect(changeset, task.review_note ?? "harvest not finished").toBeDefined(); expect(["pending_approval", "failed"]).toContain(task.status); }, { timeout: 20_000 });
  return module;
}

describe("IA-07 DevFabric quality gates fail closed (offline model/DB/CLI fixtures)", { timeout: 30_000 }, () => {
  it.each(["tracked", "untracked-content", "untracked-add", "untracked-delete", "head", "symlink"])("post-audit %s change is rejected before any git write", async (kind) => {
    const module = await finishCodingSession();
    if (kind === "tracked") writeFileSync(join(session.worktree_path, "tracked.txt"), "different tracked content\n");
    if (kind === "untracked-content") writeFileSync(join(session.worktree_path, "new-output.txt"), "different untracked bytes\n");
    if (kind === "untracked-add") writeFileSync(join(session.worktree_path, "surprise.txt"), "unaudited addition");
    if (kind === "untracked-delete") unlinkSync(join(session.worktree_path, "new-output.txt"));
    if (kind === "symlink") { unlinkSync(join(session.worktree_path, "new-output.txt")); symlinkSync("tracked.txt", join(session.worktree_path, "new-output.txt")); }
    if (kind === "head") execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@workloom.local", "commit", "--allow-empty", "-qm", "unaudited HEAD"], { cwd: session.worktree_path });
    await expect(module.approveRelease(workspace, task.id, {}, actor)).rejects.toThrow(/内容|指纹|门禁|凭据/);
    expect(mock.commit).not.toHaveBeenCalled(); expect(mock.merge).not.toHaveBeenCalled(); expect(mock.tag).not.toHaveBeenCalled();
  });
  it.each([
    null, { trigger_source: "dev-task:unrelated:session:other" }, { workspace_id: "other-workspace" },
    { status: "running" }, { total_questions: 0 }, { total_score: null }, { verdict: "fail" },
    { red_line_hit: true }, { answer_count: 0 }, { finished_at: null }, { total_score: 87 },
  ])("a missing, unrelated or changed real exam row %j cannot authorize git writes", async (invalid) => {
    const module = await finishCodingSession(); examDbOverride = invalid;
    await expect(module.approveRelease(workspace, task.id, {}, actor)).rejects.toThrow(/上线考|考试|门禁|凭据/);
    expect(mock.commit).not.toHaveBeenCalled(); expect(mock.merge).not.toHaveBeenCalled(); expect(mock.tag).not.toHaveBeenCalled();
  });
  it("a worktree change during the summary review cannot become audited or trigger paid repair", async () => {
    task.repair_round = 0;
    mock.model.mockImplementation(async () => { writeFileSync(join(session.worktree_path, "tracked.txt"), "modified during audit"); return "PASS fixture summary"; });
    await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
    expect(mock.start).toHaveBeenCalledTimes(1); expect(task.repair_round).toBe(0);
  });
  it("configured model failure is unverified and cannot become pending approval", async () => {
    mock.model.mockRejectedValue(new Error("fixture unavailable"));
    await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
    expect(changeset!.gate_results.llmReview).toMatchObject({ ok: false, mock: true, state: "unavailable" });
  });
  it("missing model configuration is unverified and never triggers paid automatic repair", async () => {
    mock.llm.mockReturnValue(undefined); task.repair_round = 0;
    await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
    expect(task.repair_round).toBe(0); expect(mock.start).toHaveBeenCalledTimes(1); expect(mock.discard).not.toHaveBeenCalled();
  });
  it("exam exception is unverified rather than a passing null verdict", async () => {
    mock.exam.mockRejectedValue(new Error("fixture exam source unavailable"));
    await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
    expect(changeset!.gate_results.exam).toMatchObject({ state: "unavailable", mock: true });
  });
  it.each([
    { verdict: null }, { status: "running" }, { totalQuestions: 0 }, { totalScore: null }, { totalScore: NaN }, { finishedAt: null },
    { verdict: "unknown" }, { id: "" }, { totalScore: -1 }, { totalScore: 101 }, { finishedAt: "invalid-date" }, { totalQuestions: 0.5 },
  ])("incomplete exam receipt %j cannot pass", async (invalid) => {
    mock.exam.mockResolvedValue(validExam(invalid)); await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
  });
  it("a real FAIL is a quality failure; completed pass or warn retains the existing human approval gate", async () => {
    mock.model.mockResolvedValue("FAIL 未覆盖任务"); await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(changeset!.gate_results.llmReview).toMatchObject({ state: "failed", mock: false });
  });
  it("a word beginning with PASS is not an explicit PASS verdict", async () => {
    mock.model.mockResolvedValue("PASSING-looking text is not a review verdict"); await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
  });
  it("completed exam FAIL blocks even when the model summary says PASS", async () => {
    mock.exam.mockResolvedValue(validExam({ verdict: "fail" })); await finishCodingSession();
    expect(changeset!.gates_passed).toBe(false); expect(task.status).toBe("failed");
    expect(changeset!.gate_results.exam).toMatchObject({ state: "completed", mock: false, verdict: "fail" });
  });
  it("reviewer and examiner error messages never persist a credential", async () => {
    const credential = `sk-${"f".repeat(32)}`;
    mock.model.mockRejectedValue(new Error(`fixture upstream Authorization: Bearer ${credential}`));
    mock.exam.mockRejectedValue(new Error(`fixture examiner ${credential}`));
    await finishCodingSession();
    expect(JSON.stringify(changeset)).not.toContain(credential); expect(task.review_note).not.toContain(credential);
    expect(task.status).toBe("failed");
  });
  it.each(["pass", "warn"])("verified %s exam plus real PASS reaches pending approval with versioned evidence", async (verdict) => {
    mock.exam.mockResolvedValue(validExam({ verdict })); await finishCodingSession();
    expect(changeset!.gates_passed).toBe(true); expect(task.status).toBe("pending_approval");
    expect(changeset!.gate_results).toMatchObject({ schema: "workloom.dev-gates/v3", contentBinding: { taskId: task.id, sessionId: session.id }, llmReview: { state: "passed", mock: false }, exam: { state: "completed", status: "done", verdict } });
  });
  it("historical pending_approval with absent or unverified gate evidence cannot write git", async () => {
    const module = devtools; task.status = "pending_approval";
    await expect(module.approveRelease(workspace, task.id, {}, actor)).rejects.toThrow(/门禁|核验|凭据/);
    expect(mock.commit).not.toHaveBeenCalled(); expect(mock.merge).not.toHaveBeenCalled(); expect(mock.tag).not.toHaveBeenCalled();
  });
  it("even gates_passed=true cannot bypass an unverified or old receipt", async () => {
    const module = devtools; task.status = "pending_approval";
    changeset = { id: "legacy", session_id: session.id, gates_passed: true, gate_results: { hardGates: [{ name: "secret-scan", ok: true }], llmReview: { ok: true, mock: true }, exam: { verdict: null, mock: true } } };
    await expect(module.approveRelease(workspace, task.id, {}, actor)).rejects.toThrow(/门禁|核验|凭据/);
    expect(mock.commit).not.toHaveBeenCalled(); expect(mock.merge).not.toHaveBeenCalled();
  });
  it.each(["pass", "warn"])("verified %s receipt permits the explicit approval to perform git writes", async (verdict) => {
    mock.exam.mockResolvedValue(validExam({ verdict })); const module = await finishCodingSession();
    await module.approveRelease(workspace, task.id, { changelog: "fixture release" }, actor);
    expect(mock.commit).toHaveBeenCalledTimes(1); expect(mock.merge).toHaveBeenCalledTimes(1); expect(mock.tag).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("released");
  });
  it.each(["flag", "schema", "session", "model", "exam", "hard"])("tampered %s evidence is rejected before git mutation", async (field) => {
    const module = await finishCodingSession();
    if (field === "flag") changeset!.gates_passed = false;
    if (field === "schema") changeset!.gate_results.schema = "old";
    if (field === "session") changeset!.session_id = "different-session";
    if (field === "model") (changeset!.gate_results.llmReview as Record<string, unknown>).mock = true;
    if (field === "exam") (changeset!.gate_results.exam as Record<string, unknown>).status = "running";
    if (field === "hard") changeset!.gate_results.hardGates = [];
    await expect(module.approveRelease(workspace, task.id, {}, actor)).rejects.toThrow(/门禁|核验|凭据/);
    expect(mock.commit).not.toHaveBeenCalled(); expect(mock.merge).not.toHaveBeenCalled(); expect(mock.tag).not.toHaveBeenCalled();
  });
});
