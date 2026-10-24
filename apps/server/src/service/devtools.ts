/**
 * service/devtools · 开发场域（DevFabric）执行面
 * 六站流水线：S1 需求(prd-forge 已有) → S2 任务拆解(createTask/confirmTask)
 *   → S3 受管开发(dispatchTask：worktree 隔离+快照+会话+围栏)
 *   → S4 代码审计(harvest：硬门禁+LLM 评审+上线考)
 *   → S5 人审(approveRelease/rejectTask) → S6 版本台账(release)
 * 纪律：
 *  - 机床=设备（AI Coding CLI），权责在岗位层；主分支零直写（worktree 隔离）；
 *  - 未登记目录机床进不去（dev_repos 白名单+路径钳制双重强制）；
 *  - 凭据 L4 注入（env 透传，不进事件明文）；payload 落库前凭据模式脱敏；
 *  - 高危命令默认拦截（deny/escalate 留痕进 dev_fences_audit）；推送远端永远走审批；
 *  - 五元事件镜像关键节点（dispatched/session_end/gates/released/rejected），哈希链零丢失。
 */
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { svcQuery, serviceTx, appendEventOn } from "./events.js";
import { llmCall } from "./llm.js";
import { runExam } from "./eval.js";
import { captureDevContent, validDevContent, type DevContentSnapshot } from "./devtools-evidence.js";
import {
  defaultAdapters, startSession, buildTaskPrompt, judgeCommand,
  assertGitRepo, baselineCommit, statusFingerprint, worktreeAdd, worktreeDiscard,
  collectDiff, commitWorktreeChanges, mergeIntoBaseline, createTag, listTags,
  detectGateScripts, suggestVersion,
  DeclarativeAdapter, loadDeclarativeAdapters, customToolDirs,
  type CodingToolAdapter, type DevEvent, type RunningSession, type Changeset,
  type DeclarativeToolSpec,
} from "@workloom/base/dev-bridge";
import { mkdirSync, writeFileSync } from "node:fs";
import YAML from "yaml";

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const MAX_REPAIR_ROUNDS = 2;
const SESSION_TIMEOUT_MS = Number(process.env.WORKLOOM_DEV_SESSION_TIMEOUT_MS ?? 30 * 60_000);
const MAX_FENCE_DENIALS = 3;
const DEV_GATES_SCHEMA = "workloom.dev-gates/v3";

type Actor = { id: string; type: "human" | "agent" };

/* ---------------- 依赖注入：适配器注册表（验证环境可换夹具） ---------------- */
let adapters: CodingToolAdapter[] = defaultAdapters();
export function setDevToolAdapters(custom: CodingToolAdapter[]): void { adapters = custom; }
function adapterOf(toolKey: string): CodingToolAdapter | undefined {
  return adapters.find((a) => a.toolKey === toolKey);
}

/* ---------------- 运行态会话登记（进程内） ---------------- */
const running = new Map<string, RunningSession>();   // taskId -> session

/* ---------------- 凭据（L4：secret 不出进程、不进事件明文） ---------------- */
const TOOL_CRED_PROVIDER: Record<string, string[]> = {
  codex: ["openai", "codex"],
  "claude-code": ["anthropic", "claude"],
  aider: ["openai", "anthropic"],
};
const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
};
/** 环境变量名 ← credentials provider 候选：内置工具走静态表；声明式工具走 spec.env（标准协议一部分） */
function envSpecFor(adapter: CodingToolAdapter | undefined, toolKey: string): Record<string, string[]> {
  if (adapter instanceof DeclarativeAdapter) return adapter.envMap;
  const providers = TOOL_CRED_PROVIDER[toolKey] ?? [];
  const out: Record<string, string[]> = {};
  for (const p of providers) if (PROVIDER_ENV[p]) out[PROVIDER_ENV[p]] = [...(out[PROVIDER_ENV[p]] ?? []), p];
  return out;
}
async function buildToolEnv(workspaceId: string, toolKey: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const spec = envSpecFor(adapterOf(toolKey), toolKey);
  for (const [envKey, providers] of Object.entries(spec)) {
    for (const provider of providers) {
      const rows = await svcQuery<{ secret_enc: string }>(workspaceId,
        `SELECT secret_enc FROM credentials WHERE provider=$1 AND health != 'revoked' LIMIT 1`, [provider]);
      const secret = rows[0]?.secret_enc ?? process.env[`AIPM_${provider.toUpperCase()}_TOKEN`];
      if (secret && !process.env[envKey]) { env[envKey] = secret; break; }
    }
  }
  return env;
}

/** 凭据模式脱敏（payload 落库前） */
const SECRET_RE = /(sk-[a-zA-Z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN[^-]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,})/g;
function redact<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload, (_k, v) =>
    typeof v === "string" ? v.replace(SECRET_RE, "†已脱敏†") : v)) as T;
}

/* ================= S0 设备与仓库（供给） ================= */

/** 探测台账 + 全部已知适配器（未安装的附安装指引——真运行态纪律） */
export async function listTools(workspaceId: string) {
  const installs = await svcQuery(workspaceId,
    `SELECT * FROM dev_tool_installs ORDER BY detected_at DESC`);
  const { errors } = loadDeclarativeAdapters();
  const known = adapters.map((a) => ({
    toolKey: a.toolKey, displayName: a.displayName, capabilities: a.capabilities(),
    installHint: a instanceof DeclarativeAdapter ? a.installHint ?? null : null,
    custom: a instanceof DeclarativeAdapter && !["qoder", "kimi-code", "zai"].includes(a.toolKey),
    install: installs.find((i) => (i as { tool_key?: string }).tool_key === a.toolKey) ?? null,
  }));
  return { tools: known, customToolErrors: errors, customToolDir: customToolDirs()[0] };
}

/** 客户自行接入新机床：YAML 落盘 ~/.workloom/devtools/（标准协议：非交互+可解析输出+指定目录工作） */
export async function saveCustomTool(workspaceId: string, spec: DeclarativeToolSpec, actor: Actor) {
  new DeclarativeAdapter(spec);   // 构造即校验（契约不合规直接抛错）
  const dir = customToolDirs()[0]!;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${spec.tool_key}.yml`);
  writeFileSync(file, YAML.stringify(spec), "utf8");
  adapters = defaultAdapters();   // 热加载：即刻纳入注册表
  await serviceTx(workspaceId, async (client, sc) => {
    await appendEventOn(client, sc, actor, {
      objectType: "dev_tools", objectId: spec.tool_key, action: "dev.tools.custom_add",
      after: { toolKey: spec.tool_key, bin: spec.bin, protocol: spec.output.protocol, file },
    });
  });
  return { ok: true, file, tools: (await refreshTools(workspaceId, actor)).tools };
}

/** 重新探测本机设备（PATH 扫描 + 版本握手；消失的标 lost） */
export async function refreshTools(workspaceId: string, actor: Actor) {
  const found: string[] = [];
  for (const adapter of adapters) {
    const install = await adapter.detect().catch(() => null);
    if (!install) {
      await svcQuery(workspaceId,
        `UPDATE dev_tool_installs SET status='lost', detected_at=now() WHERE workspace_id=$1 AND tool_key=$2`,
        [workspaceId, adapter.toolKey]).catch(() => undefined);
      continue;
    }
    found.push(adapter.toolKey);
    const credEnv = await buildToolEnv(workspaceId, adapter.toolKey);
    const credHealth = Object.keys(credEnv).length > 0 || adapter.toolKey === "codex" || adapter.toolKey === "claude-code"
      ? "unknown" : "unknown";   // CLI 自有登录态（~/.codex 等），凭据表只是补充——健康度诚实标 unknown
    await svcQuery(workspaceId,
      `INSERT INTO dev_tool_installs (id, workspace_id, tool_key, bin_path, version, capabilities, credential_health, status, detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',now())
       ON CONFLICT (workspace_id, tool_key) DO UPDATE
         SET bin_path=EXCLUDED.bin_path, version=EXCLUDED.version, capabilities=EXCLUDED.capabilities,
             status='active', detected_at=now()`,
      [`dti-${adapter.toolKey}`, workspaceId, adapter.toolKey, install.binPath, install.version,
       JSON.stringify(install.capabilities), credHealth]);
  }
  if (found.length > 0) {
    await serviceTx(workspaceId, async (client, sc) => {
      await appendEventOn(client, sc, actor, {
        objectType: "dev_tools", objectId: workspaceId,
        action: "dev.tools.refresh", after: { found },
      });
    });
  }
  return listTools(workspaceId);
}

export async function listRepos(workspaceId: string) {
  return { repos: await svcQuery(workspaceId, `SELECT * FROM dev_repos ORDER BY created_at DESC`) };
}

/** 登记仓库（白名单唯一入口；登记即校验确为 git 仓库） */
export async function registerRepo(workspaceId: string, input: {
  name: string; path: string; baselineBranch?: string; allowedDirs?: string[];
}, actor: Actor) {
  const absPath = resolve(input.path);
  await assertGitRepo(absPath);   // 不是 git 仓库直接抛错
  const id = newId("dr");
  const repo = await serviceTx(workspaceId, async (client, sc) => {
    const r = await client.query(
      `INSERT INTO dev_repos (id, workspace_id, name, path, baseline_branch, allowed_dirs, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, path) DO UPDATE SET name=EXCLUDED.name, status='active'
       RETURNING *`,
      [id, workspaceId, input.name, absPath, input.baselineBranch ?? "main",
       JSON.stringify(input.allowedDirs ?? []), actor.id]);
    await appendEventOn(client, sc, actor, {
      objectType: "dev_repo", objectId: id, action: "dev.repo.register",
      after: { name: input.name, path: absPath },
    });
    return r.rows[0];
  });
  return { repo };
}

export async function setRepoStatus(workspaceId: string, repoId: string, status: "active" | "disabled", actor: Actor) {
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(`UPDATE dev_repos SET status=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, repoId, status]);
    await appendEventOn(client, sc, actor, { objectType: "dev_repo", objectId: repoId, action: `dev.repo.${status}` });
  });
  return { ok: true };
}

/* ================= S2 任务拆解 ================= */

export async function createTask(workspaceId: string, input: {
  prdRef?: string; repoId: string; title: string; prdSummary: string;
  acceptance: string[]; constraints?: string[]; changeKind?: "feat" | "fix" | "breaking" | "chore";
  assignedTool?: string;
}, actor: Actor) {
  const repos = await svcQuery<{ id: string; name: string; status: string }>(workspaceId,
    `SELECT id, name, status FROM dev_repos WHERE id=$1`, [input.repoId]);
  const repo = repos[0];
  if (!repo) throw new Error("仓库未登记——先登记白名单（机床未登记目录进不去）");
  if (repo.status !== "active") throw new Error("仓库已停用");
  if (input.acceptance.length === 0) throw new Error("验收标准至少一条（逐条可测，机床才知道什么叫完成）");

  const id = newId("dt");
  const prompt = buildTaskPrompt({
    prdTitle: input.title, prdSummary: input.prdSummary,
    acceptance: input.acceptance, constraints: input.constraints, repoName: repo.name,
  });
  const task = await serviceTx(workspaceId, async (client, sc) => {
    const r = await client.query(
      `INSERT INTO dev_tasks (id, workspace_id, prd_ref, repo_id, title, task_prompt, acceptance, constraints, assigned_tool, change_kind, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, workspaceId, input.prdRef ?? null, input.repoId, input.title, prompt,
       JSON.stringify(input.acceptance), JSON.stringify(input.constraints ?? []),
       input.assignedTool ?? null, input.changeKind ?? "feat", actor.id]);
    await appendEventOn(client, sc, actor, {
      objectType: "dev_task", objectId: id, action: "dev.task.create",
      after: { title: input.title, repo: repo.name, acceptance: input.acceptance.length },
    });
    return r.rows[0];
  });
  return { task };
}

/** S2 人审确认（拆解确认卡：确认才进 S3——拆错了比不拆更浪费） */
export async function confirmTask(workspaceId: string, taskId: string, actor: Actor) {
  return transit(workspaceId, taskId, ["draft", "rejected"], "confirmed", actor, "dev.task.confirm");
}

async function transit(workspaceId: string, taskId: string, from: string[], to: string, actor: Actor, action: string, extra?: Record<string, unknown>) {
  const rows = await svcQuery<{ status: string }>(workspaceId,
    `SELECT status FROM dev_tasks WHERE id=$1`, [taskId]);
  if (!rows[0]) throw new Error(`任务单不存在：${taskId}`);
  if (!from.includes(rows[0].status)) throw new Error(`任务单状态 ${rows[0].status} 不允许此操作（需 ${from.join("/")}）`);
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(`UPDATE dev_tasks SET status=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId, to]);
    await appendEventOn(client, sc, actor, { objectType: "dev_task", objectId: taskId, action, after: extra ?? { to } });
  });
  return { ok: true, status: to };
}

/* ================= S3 受管开发 ================= */

interface TaskRow {
  id: string; repo_id: string; title: string; task_prompt: string; status: string;
  assigned_tool: string | null; repair_round: number; review_note: string | null;
  [key: string]: unknown;
}
interface RepoRow {
  id: string; name: string; path: string; baseline_branch: string; status: string;
  [key: string]: unknown;
}

async function pickTool(workspaceId: string, assigned: string | null): Promise<{ adapter: CodingToolAdapter; binPath: string }> {
  const installs = await svcQuery<{ tool_key: string; bin_path: string }>(workspaceId,
    `SELECT tool_key, bin_path FROM dev_tool_installs WHERE status='active'`);
  if (assigned) {
    const hit = installs.find((i) => i.tool_key === assigned);
    const adapter = adapterOf(assigned);
    if (!hit || !adapter) throw new Error(`指派机床 ${assigned} 不在线——先刷新设备探测`);
    return { adapter, binPath: hit.bin_path };
  }
  // 自动选派：注册表顺序即优先级（Codex 优先）
  for (const adapter of adapters) {
    const hit = installs.find((i) => i.tool_key === adapter.toolKey);
    if (hit) return { adapter, binPath: hit.bin_path };
  }
  throw new Error("没有已连接的机床——请在「设备」页按指引安装 Codex / Claude Code / Aider 后刷新探测");
}

/** 派发任务（异步执行：函数立即返回，会话在后台跑，前端轮询） */
export async function dispatchTask(workspaceId: string, taskId: string, actor: Actor) {
  if (running.has(taskId)) throw new Error("任务已有会话在跑");
  const tasks = await svcQuery<TaskRow>(workspaceId, `SELECT * FROM dev_tasks WHERE id=$1`, [taskId]);
  const task = tasks[0];
  if (!task) throw new Error("任务单不存在");
  if (!["confirmed", "auditing"].includes(task.status)) {
    throw new Error(`状态 ${task.status} 不可派发（需 confirmed；返修由系统自动再派）`);
  }
  const repos = await svcQuery<RepoRow>(workspaceId, `SELECT * FROM dev_repos WHERE id=$1`, [task.repo_id]);
  const repo = repos[0]!;
  const { adapter, binPath } = await pickTool(workspaceId, task.assigned_tool);

  // 隔离 + 快照（快照先行：任何一步失控可整棵丢弃）
  const { worktreePath, branch } = await worktreeAdd(repo.path, task.id, repo.baseline_branch);
  if (!resolve(worktreePath).startsWith(resolve(repo.path) + sep)) {
    throw new Error("worktree 路径钳制失败——越界拒跑");
  }
  const baseCommit = await baselineCommit(repo.path, repo.baseline_branch);
  const fingerprint = await statusFingerprint(repo.path);

  const sessionId = newId("ds");
  const extraEnv = await buildToolEnv(workspaceId, adapter.toolKey);
  // 返修第 2 轮起：带打回原因续跑（有 thread 则 resume）
  const lastSession = await svcQuery<{ thread_id: string | null }>(workspaceId,
    `SELECT thread_id FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
  const resumeId = task.repair_round > 0 && adapter.capabilities().sessionResume
    ? lastSession[0]?.thread_id ?? undefined : undefined;
  const repairNote = task.repair_round > 0 && task.review_note
    ? `\n\n# 上轮打回原因（必须逐条解决）\n${task.review_note}` : "";

  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO dev_sessions (id, workspace_id, task_id, tool_key, worktree_path, branch, baseline_commit, status_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sessionId, workspaceId, taskId, adapter.toolKey, worktreePath, branch, baseCommit, fingerprint]);
    await client.query(`UPDATE dev_tasks SET status='running', updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId]);
    await appendEventOn(client, sc, actor, {
      objectType: "dev_task", objectId: taskId, action: "dev.task.dispatch",
      after: { tool: adapter.toolKey, branch, sessionId, repairRound: task.repair_round },
    });
  });

  // —— 启动受管会话（后台） ——
  let seq = 0;
  const persistEvent = async (type: string, payload: Record<string, unknown>) => {
    seq += 1;
    await svcQuery(workspaceId,
      `INSERT INTO dev_events (workspace_id, session_id, seq, type, payload) VALUES ($1,$2,$3,$4,$5)`,
      [workspaceId, sessionId, seq, type, JSON.stringify(redact(payload))]).catch(() => undefined);
  };
  const session = startSession(adapter, binPath, {
    taskId, prompt: task.task_prompt + repairNote, worktreePath,
    timeoutMs: SESSION_TIMEOUT_MS, maxFenceDenials: MAX_FENCE_DENIALS, resumeId, extraEnv,
  }, {
    onEvent: async (ev: DevEvent) => {
      if (ev.type === "started") {
        await svcQuery(workspaceId, `UPDATE dev_sessions SET thread_id=$3 WHERE workspace_id=$1 AND id=$2 AND $3 IS NOT NULL`,
          [workspaceId, sessionId, ev.threadId ?? null]).catch(() => undefined);
      }
      await persistEvent(ev.type, ev as unknown as Record<string, unknown>);
    },
    onFenceVerdict: async (cmd, verdict, ruleId, note) => {
      await svcQuery(workspaceId,
        `INSERT INTO dev_fences_audit (workspace_id, session_id, cmd, verdict, rule_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspaceId, sessionId, redact(cmd), verdict, ruleId ?? null, note ?? null]).catch(() => undefined);
      await persistEvent("fence_verdict", { cmd, verdict, ruleId, note });
    },
  });
  running.set(taskId, session);

  // 会话终点 → S4 审计（后台接续，不阻塞派发响应）
  void session.result.then(async (result) => {
    running.delete(taskId);
    try {
      await svcQuery(workspaceId,
        `UPDATE dev_sessions SET ended_at=now(), exit_reason=$3, last_message=$4, usage=$5, thread_id=COALESCE($6, thread_id)
         WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, sessionId, result.exitReason, redact(result.lastMessage),
         JSON.stringify(result.usage ?? {}), result.threadId ?? null]);
      await serviceTx(workspaceId, async (client, sc) => {
        await appendEventOn(client, sc, { id: "dev-orchestrator", type: "agent" }, {
          objectType: "dev_task", objectId: taskId, action: "dev.session.end",
          after: { sessionId, exitReason: result.exitReason, usage: result.usage },
        });
      });
      if (result.exitReason === "done") {
        await harvest(workspaceId, taskId, sessionId, repo, actor);
      } else {
        await handleFailure(workspaceId, taskId, repo, worktreePath, branch,
          `机床会话异常结束：${result.exitReason}（${result.lastMessage.slice(0, 200)}）`, actor);
      }
    } catch (e) {
      await svcQuery(workspaceId,
        `UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, taskId, `审计管线异常：${(e as Error).message.slice(0, 300)}`]).catch(() => undefined);
    }
  });

  return { sessionId, tool: adapter.toolKey, branch };
}

/** 失败处置：返修（≤2 轮自动再派）或转人工 */
async function handleFailure(workspaceId: string, taskId: string, repo: RepoRow,
  worktreePath: string, branch: string, reason: string, actor: Actor) {
  const rows = await svcQuery<{ repair_round: number }>(workspaceId,
    `SELECT repair_round FROM dev_tasks WHERE id=$1`, [taskId]);
  const round = rows[0]?.repair_round ?? 0;
  if (round < MAX_REPAIR_ROUNDS) {
    await svcQuery(workspaceId,
      `UPDATE dev_tasks SET repair_round=repair_round+1, status='confirmed', review_note=$3, updated_at=now()
       WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId, reason]);
    await worktreeDiscard(repo.path, worktreePath, branch).catch(() => undefined);
    await dispatchTask(workspaceId, taskId, actor).catch(async (e) => {
      await svcQuery(workspaceId,
        `UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, taskId, `返修再派失败：${(e as Error).message.slice(0, 300)}`]);
    });
  } else {
    await svcQuery(workspaceId,
      `UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId, `${reason}（返修 ${MAX_REPAIR_ROUNDS} 轮已尽，转人工）`]);
  }
}

/* ================= S4 代码审计（三道关） ================= */

interface GateResult { name: string; ok: boolean; log: string }
interface DevGateResults {
  schema: typeof DEV_GATES_SCHEMA;
  contentBinding: { taskId: string; sessionId: string; snapshot: DevContentSnapshot };
  hardGates: GateResult[];
  llmReview: { ok: boolean; report: string; mock: boolean; state: "passed" | "failed" | "unavailable" };
  exam: { examId: string; score: number | null; verdict: string | null; mock: boolean;
    state: "completed" | "unavailable"; status: string | null; totalQuestions: number; finishedAt: string | null; error?: string };
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const reviewPassed = (report: string) => /^\s*PASS(?:\s|[:：,，。.!]|$)/i.test(report);
function completedExam(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const finish = value.finishedAt instanceof Date ? value.finishedAt.toISOString() : value.finishedAt;
  return typeof value.examId === "string" && value.examId.length > 0 && value.status === "done"
    && Number.isSafeInteger(value.totalQuestions) && (value.totalQuestions as number) > 0
    && typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
    && typeof finish === "string" && finish.length > 0 && Number.isFinite(Date.parse(finish))
    && ["pass", "warn", "fail"].includes(String(value.verdict));
}
/** The latest versioned receipt, rather than a task status or old green flag, authorizes release. */
function verifiedGates(value: unknown): value is DevGateResults {
  if (!isRecord(value) || value.schema !== DEV_GATES_SCHEMA || !Array.isArray(value.hardGates) || value.hardGates.length === 0
    || !value.hardGates.every((gate) => isRecord(gate) && gate.ok === true && typeof gate.name === "string" && typeof gate.log === "string")
    || !value.hardGates.some((gate) => isRecord(gate) && gate.name === "secret-scan")
    || !isRecord(value.contentBinding) || typeof value.contentBinding.taskId !== "string" || !value.contentBinding.taskId
    || typeof value.contentBinding.sessionId !== "string" || !value.contentBinding.sessionId || !validDevContent(value.contentBinding.snapshot)
    || !isRecord(value.llmReview) || value.llmReview.state !== "passed" || value.llmReview.ok !== true || value.llmReview.mock !== false
    || typeof value.llmReview.report !== "string" || !reviewPassed(value.llmReview.report)
    || !isRecord(value.exam) || value.exam.state !== "completed" || value.exam.mock !== false || !completedExam(value.exam)) return false;
  // A completed warn retains the existing explicit human approval gate; absent/unknown verdicts never pass.
  return value.exam.verdict === "pass" || value.exam.verdict === "warn";
}
interface ChangesetEvidence { session_id: string; gate_results: unknown; gates_passed: boolean }
function releaseVerified(evidence: ChangesetEvidence | undefined, sessionId: string | undefined, taskId: string): evidence is ChangesetEvidence & { gate_results: DevGateResults } {
  return !!evidence && !!sessionId && evidence.session_id === sessionId && evidence.gates_passed === true && verifiedGates(evidence.gate_results)
    && evidence.gate_results.contentBinding.taskId === taskId && evidence.gate_results.contentBinding.sessionId === sessionId;
}

const examTrigger = (taskId: string, sessionId: string) => `dev-task:${taskId}:session:${sessionId}`;
const isoDate = (value: unknown) => value instanceof Date ? value.toISOString()
  : typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
async function realExamVerified(workspaceId: string, taskId: string, sessionId: string, exam: DevGateResults["exam"]): Promise<boolean> {
  const rows = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT e.id,e.workspace_id,e.exam_type,e.trigger_source,e.status,e.total_questions,e.total_score,e.verdict,e.finished_at,e.red_line_hit,
      (SELECT count(*)::int FROM eval_answers a WHERE a.workspace_id=e.workspace_id AND a.exam_id=e.id) AS answer_count
     FROM eval_exams e WHERE e.workspace_id=$1 AND e.id=$2 AND e.exam_type='on-change' AND e.trigger_source=$3`,
    [workspaceId, exam.examId, examTrigger(taskId, sessionId)]);
  const row = rows[0];
  if (!row || row.workspace_id !== workspaceId || row.id !== exam.examId || row.exam_type !== "on-change"
    || row.trigger_source !== examTrigger(taskId, sessionId) || row.red_line_hit !== false || row.total_score === null) return false;
  const actual = { examId: row.id, status: row.status, totalQuestions: row.total_questions,
    score: Number(row.total_score), verdict: row.verdict, finishedAt: isoDate(row.finished_at) };
  return completedExam(actual) && actual.status === exam.status && actual.totalQuestions === exam.totalQuestions
    && actual.score === exam.score && actual.verdict === exam.verdict && actual.finishedAt === isoDate(exam.finishedAt)
    && Number(row.answer_count) === actual.totalQuestions;
}
async function currentReleaseVerified(workspaceId: string, taskId: string, evidence: ChangesetEvidence | undefined,
  session: { id: string; worktree_path: string } | undefined): Promise<boolean> {
  if (!releaseVerified(evidence, session?.id, taskId) || !session) return false;
  if (!await realExamVerified(workspaceId, taskId, session.id, evidence.gate_results.exam)) return false;
  return (await captureDevContent(session.worktree_path)).sha256 === evidence.gate_results.contentBinding.snapshot.sha256;
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<GateResult["log"] extends string ? { ok: boolean; log: string } : never> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      const log = `${stdout}${stderr}`.trim().slice(-1500);
      res({ ok: !err, log: log || (err ? String(err.message).slice(0, 300) : "(无输出)") });
    });
  });
}

/** 变更回收 + 三道关；全过 → pending_approval；不过 → 返修/转人工 */
async function harvest(workspaceId: string, taskId: string, sessionId: string, repo: RepoRow, actor: Actor) {
  const sessions = await svcQuery<{ worktree_path: string; branch: string; last_message: string | null }>(workspaceId,
    `SELECT worktree_path, branch, last_message FROM dev_sessions WHERE id=$1`, [sessionId]);
  const session = sessions[0]!;
  const tasks = await svcQuery<TaskRow>(workspaceId, `SELECT * FROM dev_tasks WHERE id=$1`, [taskId]);
  const task = tasks[0]!;
  await svcQuery(workspaceId, `UPDATE dev_tasks SET status='auditing', updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, taskId]);

  // Bind before gates run: a test, reviewer or concurrent process cannot silently change what was reviewed.
  const auditedContent = await captureDevContent(session.worktree_path);
  const diff = await collectDiff(session.worktree_path, repo.baseline_branch);
  const changeset: Changeset = { ...diff, selfSummary: session.last_message ?? "" };

  // —— 第一关：硬门禁（仓库自带 typecheck/lint/test + 凭据泄露扫描 + 禁改区比对） ——
  const hardGates: GateResult[] = [];
  const scripts = await detectGateScripts(session.worktree_path);
  const pm = existsSync(join(session.worktree_path, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  for (const [name, script] of Object.entries(scripts) as Array<[string, string]>) {
    if (!script) continue;
    const r = await runCmd(pm, ["run", script, "--if-present"], session.worktree_path);
    hardGates.push({ name, ok: r.ok, log: r.log });
    if (!r.ok) break;   // 一门不过不再烧时间
  }
  // 凭据泄露扫描（变更文件内容）
  const leaked: string[] = [];
  for (const f of [...diff.files.map((x) => x.path), ...diff.untracked]) {
    const p = join(session.worktree_path, f);
    if (!existsSync(p) || /node_modules|\.lock|lock\.yaml/.test(f)) continue;
    try {
      const content = readFileSync(p, "utf8");
      SECRET_RE.lastIndex = 0;
      if (SECRET_RE.test(content)) leaked.push(f);
    } catch { /* 二进制等跳过 */ }
  }
  hardGates.push({
    name: "secret-scan", ok: leaked.length === 0,
    log: leaked.length === 0 ? "变更文件未发现凭据模式" : `疑似凭据泄露：${leaked.join("、")}`,
  });

  // —— 第二关：LLM 摘要评审（任务与统计，并非完整逐行代码审计；缺配置/调用失败未验证） ——
  let llmReview: DevGateResults["llmReview"];
  const llm = llmCall("dev-review");
  const diffBrief = `任务：${task.title}\n机床自总结：${changeset.selfSummary.slice(0, 800)}\n变更统计：\n${diff.diffStat.slice(0, 1500)}\n未跟踪新文件：${diff.untracked.join("、") || "无"}`;
  if (llm) {
    try {
      const report = await llm(
        `你是发布守护。对照任务与变更统计做摘要评审；你没有收到完整diff，不能声称完成逐行代码审计。①统计与自述是否覆盖任务目标 ②有哪些仍需人工检查的风险。` +
        `首行输出结论：PASS 或 FAIL（附一句话理由），随后列要点。\n\n${diffBrief}`);
      const pass = reviewPassed(report);
      llmReview = { ok: pass, report: report.slice(0, 3000), mock: false, state: pass ? "passed" : "failed" };
    } catch (error) {
      const ref = createHash("sha256").update(error instanceof Error ? `${error.name}|${error.message}` : "unknown-model-error").digest("hex").slice(0, 12);
      llmReview = { ok: false, report: `模型摘要评审调用失败，结果未验证（ref=${ref}）；没有放行`, mock: true, state: "unavailable" };
    }
  } else {
    llmReview = { ok: false, report: "模型未配置，摘要评审未验证；没有放行", mock: true, state: "unavailable" };
  }

  // —— 第三关：上线考（必须完成、有题、有分数和明确结论；异常与缺失回执失败关闭） ——
  let exam: DevGateResults["exam"];
  try {
    const r = await runExam(workspaceId, { examType: "on-change", triggerSource: examTrigger(taskId, sessionId), perStructure: 1 });
    const finish = r.exam.finishedAt as unknown;
    exam = { examId: r.exam.id, score: r.exam.totalScore, verdict: r.exam.verdict, mock: false,
      state: "completed", status: r.exam.status, totalQuestions: r.exam.totalQuestions,
      finishedAt: finish instanceof Date ? finish.toISOString() : typeof finish === "string" ? finish : null };
    if (!completedExam(exam) || !await realExamVerified(workspaceId, taskId, sessionId, exam)) {
      exam = { ...exam, state: "unavailable", error: "上线考未取得本工作区、本任务会话的真实完整收卷记录，结果未验证" };
    }
  } catch (error) {
    const ref = createHash("sha256").update(error instanceof Error ? `${error.name}|${error.message}` : "unknown-exam-error").digest("hex").slice(0, 12);
    exam = { examId: "", score: null, verdict: null, mock: true, state: "unavailable", status: null, totalQuestions: 0,
      finishedAt: null, error: `上线考调用失败，结果未验证（ref=${ref}）` };
  }

  let contentUnverified = false;
  try { contentUnverified = (await captureDevContent(session.worktree_path)).sha256 !== auditedContent.sha256; }
  catch { contentUnverified = true; }
  hardGates.push({ name: "content-binding", ok: !contentUnverified,
    log: contentUnverified ? "工作区内容在门禁运行期间发生变化或无法复核，已拒绝放行" : "HEAD、跟踪差异与未跟踪文件 SHA-256 与门禁开始时一致" });
  const hardOk = hardGates.every((g) => g.ok);
  const examOk = exam.state === "completed" && (exam.verdict === "pass" || exam.verdict === "warn");
  const gateResults: DevGateResults = { schema: DEV_GATES_SCHEMA, contentBinding: { taskId, sessionId, snapshot: auditedContent }, hardGates, llmReview, exam };
  const gatesPassed = verifiedGates(gateResults);

  const changesetId = newId("dc");
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO dev_changesets (id, workspace_id, session_id, task_id, diff_stat, files, untracked, self_summary, gate_results, gates_passed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [changesetId, workspaceId, sessionId, taskId, diff.diffStat, JSON.stringify(diff.files),
       JSON.stringify(diff.untracked), redact(changeset.selfSummary), JSON.stringify(redact(gateResults)), gatesPassed]);
    await client.query(
      `UPDATE dev_tasks SET status=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId, gatesPassed ? "pending_approval" : "auditing"]);
    await appendEventOn(client, sc, { id: "release-guardian", type: "agent" }, {
      objectType: "dev_task", objectId: taskId, action: "dev.gates.done",
      after: { changesetId, gatesPassed, hardOk, llmOk: llmReview.ok, examVerdict: exam.verdict },
    });
  });

  if (!gatesPassed) {
    const reasons = [
      ...hardGates.filter((g) => !g.ok).map((g) => `硬门禁 ${g.name} 未过：${g.log.slice(0, 300)}`),
      ...(llmReview.ok ? [] : [`LLM 评审未过：${llmReview.report.slice(0, 300)}`]),
      ...(examOk ? [] : [exam.error ?? `上线考未通过（verdict=${exam.verdict ?? "无"}，exam=${exam.examId || "未收卷"}）`]),
    ].join("\n");
    if (contentUnverified || llmReview.state === "unavailable" || exam.state === "unavailable") {
      // Retrying the coding CLI cannot repair a missing reviewer or failed exam infrastructure.
      // Preserve its worktree and stop, rather than burning additional paid repair sessions.
      await serviceTx(workspaceId, async (client, sc) => {
        await client.query(`UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, taskId, redact(`门禁未验证，已停止自动返修并保留隔离工作区：${reasons}`)]);
        await appendEventOn(client, sc, { id: "release-guardian", type: "agent" }, {
          objectType: "dev_task", objectId: taskId, action: "dev.gates.unverified",
          after: { changesetId, llmState: llmReview.state, examState: exam.state, automaticRepair: false },
        });
      });
      return { changesetId, gatesPassed, gateResults };
    }
    const sessions2 = await svcQuery<{ worktree_path: string; branch: string }>(workspaceId,
      `SELECT worktree_path, branch FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
    await handleFailure(workspaceId, taskId, repo, sessions2[0]!.worktree_path, sessions2[0]!.branch, reasons, actor);
  }
  return { changesetId, gatesPassed, gateResults };
}

/* ================= S5 人审 + S6 发布 ================= */

/** 打回（人类裁决：一句话意见回灌，重排返修） */
export async function rejectTask(workspaceId: string, taskId: string, note: string, actor: Actor) {
  const r = await transit(workspaceId, taskId, ["pending_approval", "running", "auditing"], "rejected", actor, "dev.task.reject", { note });
  running.get(taskId)?.cancel();
  await svcQuery(workspaceId,
    `UPDATE dev_tasks SET review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId, note]);
  return r;
}

export async function cancelTask(workspaceId: string, taskId: string, actor: Actor) {
  running.get(taskId)?.cancel();
  const sessions = await svcQuery<{ worktree_path: string; branch: string }>(workspaceId,
    `SELECT worktree_path, branch FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
  const tasks = await svcQuery<{ repo_id: string }>(workspaceId, `SELECT repo_id FROM dev_tasks WHERE id=$1`, [taskId]);
  const repos = await svcQuery<RepoRow>(workspaceId, `SELECT * FROM dev_repos WHERE id=$1`, [tasks[0]?.repo_id ?? ""]);
  if (sessions[0] && repos[0]) {
    await worktreeDiscard(repos[0].path, sessions[0].worktree_path, sessions[0].branch).catch(() => undefined);
  }
  return transit(workspaceId, taskId, ["draft", "confirmed", "running", "auditing", "rejected", "failed"], "canceled", actor, "dev.task.cancel");
}

/** 批准发布（S5 人审 → S6 版本台账：合并→semver→tag→changelog→releases） */
export async function approveRelease(workspaceId: string, taskId: string, input: {
  version?: string; changelog?: string;
}, actor: Actor) {
  const tasks = await svcQuery<TaskRow>(workspaceId, `SELECT * FROM dev_tasks WHERE id=$1`, [taskId]);
  const task = tasks[0];
  if (!task) throw new Error("任务单不存在");
  if (task.status !== "pending_approval") throw new Error(`状态 ${task.status} 不可发布（需 pending_approval——三道关全过）`);

  const repos = await svcQuery<RepoRow>(workspaceId, `SELECT * FROM dev_repos WHERE id=$1`, [task.repo_id]);
  const repo = repos[0]!;
  const sessions = await svcQuery<{ id: string; worktree_path: string; branch: string }>(workspaceId,
    `SELECT id, worktree_path, branch FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1`, [taskId]);
  const session = sessions[0]!;
  const changesets = await svcQuery<{ id: string; session_id: string; gate_results: unknown; gates_passed: boolean }>(workspaceId,
    `SELECT id,session_id,gate_results,gates_passed FROM dev_changesets WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [taskId]);
  if (!await currentReleaseVerified(workspaceId, taskId, changesets[0], session).catch(() => false)) {
    throw new Error("门禁凭据缺失、过期、考试未绑定或工作区内容指纹已变化，拒绝发布；请重新核验当前内容与真实上线考");
  }

  // 机床未提交的改动由系统兜底提交（合并前置）
  await commitWorktreeChanges(session.worktree_path, `feat(dev): ${task.title}（DevFabric 任务 ${task.id}）`);
  const mergeCommit = await mergeIntoBaseline(repo.path, repo.baseline_branch, session.branch);

  // semver 建议（人类可改）
  const tags = await listTags(repo.path);
  const tasksRow = await svcQuery<{ change_kind: string }>(workspaceId,
    `SELECT change_kind FROM dev_tasks WHERE id=$1`, [taskId]);
  const version = input.version ?? suggestVersion(tags[0] ?? null,
    (tasksRow[0]?.change_kind ?? "feat") as "feat" | "fix" | "breaking" | "chore");

  // changelog（LLM 优先生成；缺配置确定性模板兜底）
  let changelog = input.changelog ?? "";
  if (!changelog) {
    const llm = llmCall("dev-changelog");
    if (llm) {
      try {
        changelog = await llm(`为以下发布写一段中文 changelog（3-6 条要点，面向用户）：\n任务：${task.title}\n${changesets[0] ? JSON.stringify(changesets[0].gate_results).slice(0, 600) : ""}`);
      } catch { changelog = `- ${task.title}（DevFabric 自动发布）`; }
    } else {
      changelog = `- ${task.title}（DevFabric 自动发布）`;
    }
  }
  await createTag(repo.path, version, `release ${version}：${task.title}`);
  await worktreeDiscard(repo.path, session.worktree_path, session.branch).catch(() => undefined);

  const auditHash = createHash("sha256").update(JSON.stringify(changesets[0]?.gate_results ?? {})).digest("hex");
  const releaseId = newId("rel");
  const release = await serviceTx(workspaceId, async (client, sc) => {
    const r = await client.query(
      `INSERT INTO releases (id, workspace_id, repo_id, version, tasks, audit_hash, merge_commit, changelog, released_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [releaseId, workspaceId, repo.id, version, JSON.stringify([taskId]), auditHash, mergeCommit, changelog, actor.id]);
    await client.query(`UPDATE dev_tasks SET status='released', updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId]);
    await appendEventOn(client, sc, actor, {
      objectType: "release", objectId: releaseId, action: "dev.release.approve",
      after: { version, taskId, repo: repo.name, mergeCommit: mergeCommit.slice(0, 8) },
    });
    return r.rows[0];
  });
  return { release };
}

/* ================= 查询面（P25 轮询） ================= */

export async function listTasks(workspaceId: string) {
  const rows = await svcQuery<Record<string, unknown> & {
    id: string; latest_gate_results: unknown; latest_gates_passed: boolean; latest_gate_session: string; latest_session_id: string; latest_worktree_path: string;
  }>(workspaceId,
    `SELECT t.*, r.name AS repo_name, c.gate_results AS latest_gate_results, c.gates_passed AS latest_gates_passed,
       c.session_id AS latest_gate_session,s.id AS latest_session_id,s.worktree_path AS latest_worktree_path
     FROM dev_tasks t JOIN dev_repos r ON r.id=t.repo_id
     LEFT JOIN LATERAL (SELECT gate_results,gates_passed,session_id FROM dev_changesets
       WHERE task_id=t.id AND workspace_id=t.workspace_id ORDER BY created_at DESC,id DESC LIMIT 1) c ON true
     LEFT JOIN LATERAL (SELECT id,worktree_path FROM dev_sessions WHERE task_id=t.id AND workspace_id=t.workspace_id
       ORDER BY started_at DESC,id DESC LIMIT 1) s ON true
     ORDER BY t.created_at DESC,t.id DESC LIMIT 100`);
  return { tasks: await Promise.all(rows.map(async ({ latest_gate_results, latest_gates_passed, latest_gate_session, latest_session_id, latest_worktree_path, ...row }) => ({
    ...row, release_verified: row.status === "pending_approval" && await currentReleaseVerified(workspaceId, row.id,
      { gate_results: latest_gate_results, gates_passed: latest_gates_passed, session_id: latest_gate_session },
      { id: latest_session_id, worktree_path: latest_worktree_path }).catch(() => false),
  }))) };
}

export async function taskDetail(workspaceId: string, taskId: string) {
  const tasks = await svcQuery(workspaceId,
    `SELECT t.*, r.name AS repo_name, r.path AS repo_path FROM dev_tasks t JOIN dev_repos r ON r.id=t.repo_id WHERE t.id=$1`, [taskId]);
  const sessions = await svcQuery(workspaceId,
    `SELECT * FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC,id DESC`, [taskId]);
  const changesets = await svcQuery(workspaceId,
    `SELECT * FROM dev_changesets WHERE task_id=$1 ORDER BY created_at DESC,id DESC`, [taskId]);
  const fences = await svcQuery(workspaceId,
    `SELECT f.* FROM dev_fences_audit f JOIN dev_sessions s ON s.id=f.session_id
     WHERE s.task_id=$1 ORDER BY f.id DESC LIMIT 50`, [taskId]);
  return { task: tasks[0] ? { ...tasks[0], release_verified: tasks[0].status === "pending_approval" && await currentReleaseVerified(workspaceId, taskId,
    changesets[0] as unknown as ChangesetEvidence | undefined, sessions[0] as { id: string; worktree_path: string } | undefined).catch(() => false) } : null,
    sessions, changesets, fences, live: running.has(taskId) };
}

/** 会话事件流（增量轮询：afterSeq 之后的新事件） */
export async function sessionEvents(workspaceId: string, sessionId: string, afterSeq = 0) {
  return { events: await svcQuery(workspaceId,
    `SELECT seq, type, payload, created_at FROM dev_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 500`,
    [sessionId, afterSeq]) };
}

export async function listReleases(workspaceId: string) {
  return { releases: await svcQuery(workspaceId,
    `SELECT rel.*, r.name AS repo_name FROM releases rel JOIN dev_repos r ON r.id=rel.repo_id
     ORDER BY rel.released_at DESC LIMIT 50`) };
}
