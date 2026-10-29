import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppend } from "@workloom/base/workdata";
import { PmTeamService } from "../industry/ai-pm/service.js";
import { PmError, type PmRunDetail } from "../industry/ai-pm/types.js";
import { createDeepSeekAssistantModel, AssistantModelError, type AssistantModelClient, type AssistantModelMessage } from "./model.js";
import { PgAssistantStore, AssistantStoreError, type AssistantStore } from "./store.js";
import type {
  AssistantEventSink,
  AssistantIdentity,
  AssistantMode,
  AssistantRun,
  AssistantScope,
  AssistantSession,
  AssistantUsage,
} from "./types.js";
import type { AssistantLaunchClaims } from "./types.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_ACTIVE_RUNS = 2;
const TASK_POLL_MS = 1_500;
const MAX_TASK_MODEL_CALLS = 65;
const TASK_RESERVED_OUTPUT_TOKENS = MAX_TASK_MODEL_CALLS * 8192;

export interface AssistantTaskFacade {
  create(scope: AssistantScope, goal: string, idempotencyKey: string, actor: string): Promise<PmRunDetail>;
  start(scope: AssistantScope, id: string): Promise<PmRunDetail>;
  detail(scope: AssistantScope, id: string): Promise<PmRunDetail>;
  cancel(scope: AssistantScope, id: string, actor: string): Promise<PmRunDetail>;
  artifact(scope: AssistantScope, id: string, path: string): Promise<{
    path: string;
    content: string;
    sha256: string;
    mediaType: string;
    sizeBytes: number;
    taskId: string;
  }>;
}

export interface AssistantServiceOptions {
  store?: AssistantStore;
  model?: AssistantModelClient;
  events?: AssistantEventSink;
  taskFacade?: AssistantTaskFacade;
}

const active = new Map<string, AbortController>();

function systemPrompt(identity: AssistantIdentity): string {
  return [
    "你是 WorkLoom PM 云端研发工作台的总控助手。",
    "你的职责是帮助产品所有者澄清需求、拆解研发任务、分析风险和给出可核验的下一步。",
    "回答使用简洁、具体的中文，优先给出可执行结论。不得声称已经运行测试、修改文件、发布上线或调用外部业务系统，除非消息中明确展示了真实工具回执。",
    "演示、推测、未验证和真实回执必须明确区分。涉及密钥、密码、私有令牌时只说明配置方法，不复述秘密。",
    "若用户要求执行长任务或生成多个工程产物，建议切换到“研发任务”模式；该模式会走真实 PM 团队、围栏和独立沙箱回执。",
    `当前工作区 ${identity.workspaceId}，成员 ${identity.memberNo}。`,
    `当前日期 ${new Date().toISOString().slice(0, 10)}。`,
  ].join("\n");
}

function messageText(parts: Array<{ type: string; text?: string }>): string {
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}

function redactError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of ["DEEPSEEK_API_KEY", "LLM_API_KEY"]) {
    const value = process.env[key]?.trim();
    if (value) message = message.replaceAll(value, "[REDACTED]");
  }
  return message
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer [REDACTED]")
    .slice(0, 1000);
}

function taskTerminal(status: string): boolean {
  return ["completed", "failed", "blocked", "cancelled", "paused"].includes(status);
}

function taskCallCount(detail: PmRunDetail): number {
  const planningCalls = detail.run.planningReceipts.filter((receipt) => receipt.source === "model").length;
  const workerCalls = detail.tasks.reduce((sum, task) => {
    const receipt = task.adapterReceipt ?? {};
    const reported = [receipt.modelCalls, receipt.modelRequests]
      .find((value): value is number => Number.isSafeInteger(value) && Number(value) > 0) ?? 0;
    return sum + Math.max(reported, task.attemptReceipts.length, task.status === "completed" ? 1 : 0);
  }, 0);
  return Math.max(1, Math.min(MAX_TASK_MODEL_CALLS, planningCalls + workerCalls));
}

function taskNarrative(detail: PmRunDetail): string {
  const completed = detail.tasks.filter((task) => task.status === "completed").length;
  const records = detail.artifacts.map((artifact) =>
    `- \`${artifact.path}\` · ${artifact.sizeBytes} 字节 · SHA-256 \`${artifact.sha256}\``,
  );
  const lines = [
    `研发任务 \`${detail.run.id}\` 当前状态：**${detail.run.status}**。`,
    `员工任务完成 ${completed}/${detail.tasks.length}，模型用量 ${detail.run.usage.promptTokens + detail.run.usage.completionTokens} tokens。`,
  ];
  if (records.length) lines.push("", "已验证产物：", ...records);
  if (detail.run.error) lines.push("", `停止原因：${detail.run.error}`);
  if (!detail.run.verification && detail.run.status !== "completed") lines.push("", "未看到最终验收回执，因此没有把该任务标记为已交付。");
  if (detail.run.status === "completed") lines.push("", "最终任务状态与产物摘要来自服务端持久化回执，而不是模型自述。");
  return lines.join("\n");
}

class PlannedTaskFacade implements AssistantTaskFacade {
  private service: PmTeamService | null = null;

  private getService(): PmTeamService {
    this.service ??= new PmTeamService();
    return this.service;
  }

  async create(scope: AssistantScope, goal: string, idempotencyKey: string, actor: string): Promise<PmRunDetail> {
    return (await this.getService().create(scope, { goal, idempotencyKey }, actor)).detail;
  }

  start(scope: AssistantScope, id: string): Promise<PmRunDetail> {
    return this.getService().start(scope, id);
  }

  detail(scope: AssistantScope, id: string): Promise<PmRunDetail> {
    return this.getService().detail(scope, id);
  }

  cancel(scope: AssistantScope, id: string, actor: string): Promise<PmRunDetail> {
    return this.getService().cancel(scope, id, actor);
  }

  artifact(scope: AssistantScope, id: string, path: string) {
    return this.getService().artifact(scope, id, path);
  }
}

class GatewayAssistantEvents implements AssistantEventSink {
  async append(scope: AssistantScope, input: {
    sessionId: string;
    runId?: string;
    action: string;
    objectType: string;
    objectId: string;
    after: Record<string, unknown>;
    receipt?: Record<string, unknown>;
  }): Promise<void> {
    await gatewayAppend(
      getGatewayPool(),
      {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actor: { id: scope.memberNo, type: "human" },
        sessionId: input.sessionId,
      },
      {
        who: { type: "human", id: scope.memberNo },
        context: {
          tenant_id: scope.tenantId,
          workspace_id: scope.workspaceId,
          time: new Date().toISOString(),
          channel: "assistant-workbench",
          ...(input.runId ? { task_id: input.runId } : {}),
        },
        object: { type: input.objectType, id: input.objectId },
        decision: {
          action: input.action,
          after: input.after,
          basis: ["云端研发工作台；消息事实与真实回执分开记录"],
        },
        rule_impact: [],
        ...(input.receipt ? { receipt: input.receipt } : {}),
      },
    );
  }
}

export class AssistantService {
  private readonly store: AssistantStore;
  private readonly model: AssistantModelClient;
  private readonly events: AssistantEventSink;
  private readonly taskFacade: AssistantTaskFacade;

  constructor(options: AssistantServiceOptions = {}) {
    this.store = options.store ?? new PgAssistantStore(getAppPool());
    this.model = options.model ?? createDeepSeekAssistantModel();
    this.events = options.events ?? new GatewayAssistantEvents();
    this.taskFacade = options.taskFacade ?? new PlannedTaskFacade();
  }

  status() {
    return {
      ok: true,
      model: this.model.model,
      modelConfigured: Boolean((process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "").trim()),
      mode: "beta",
      persistence: "postgres",
      streaming: "sse",
      externalActions: false,
      codeExecution: process.platform === "darwin" ? "macos-seatbelt-node24" : "linux-bubblewrap-node24",
    };
  }

  async consumeLaunchNonce(claims: AssistantLaunchClaims): Promise<void> {
    await this.store.consumeLaunchNonce({
      scope: {
        tenantId: claims.tenantId,
        workspaceId: claims.workspaceId,
        memberNo: claims.memberNo,
      },
      jti: claims.jti,
      issuedAt: new Date(claims.iat * 1000),
      expiresAt: new Date(claims.exp * 1000),
    });
  }

  async listSessions(identity: AssistantIdentity, options: { query?: string; archived?: boolean; limit?: number }) {
    const scope = identity.assistantScope;
    await this.store.recoverInterrupted(scope);
    return this.store.listSessions(scope, {
      query: options.query,
      archived: options.archived,
      limit: Math.max(1, Math.min(options.limit ?? 50, 100)),
    });
  }

  createSession(identity: AssistantIdentity, title?: string): Promise<AssistantSession> {
    return this.store.createSession(identity.assistantScope, title);
  }

  updateSession(identity: AssistantIdentity, id: string, patch: { title?: string; pinned?: boolean }) {
    return this.store.updateSession(identity.assistantScope, id, patch);
  }

  archiveSession(identity: AssistantIdentity, id: string, archived: boolean) {
    return this.store.setSessionStatus(identity.assistantScope, id, archived ? "archived" : "active");
  }

  deleteSession(identity: AssistantIdentity, id: string) {
    return this.store.setSessionStatus(identity.assistantScope, id, "deleted");
  }

  listMessages(identity: AssistantIdentity, sessionId: string, afterSeq?: string) {
    return this.store.listMessages(identity.assistantScope, sessionId, afterSeq);
  }

  async send(identity: AssistantIdentity, sessionId: string, input: {
    text: string;
    mode: AssistantMode;
    clientMessageId: string;
  }) {
    const scope = identity.assistantScope;
    const turn = await this.store.createTurn(scope, {
      sessionId,
      text: input.text,
      mode: input.mode,
      model: this.model.model,
      clientMessageId: input.clientMessageId,
    });
    if (!turn.replayed) {
      if ([...active.keys()].length >= MAX_ACTIVE_RUNS) {
        await this.store.failRun(scope, turn.run.id, {
          status: "blocked",
          code: "CONCURRENCY_LIMIT",
          message: `同一实例最多同时运行 ${MAX_ACTIVE_RUNS} 个会话任务`,
        });
      } else {
        const controller = new AbortController();
        active.set(turn.run.id, controller);
        void this.executeTurn(identity, turn.run, input.text, controller)
          .catch((error) => console.error("[assistant] 运行终态保存失败", redactError(error)))
          .finally(() => active.delete(turn.run.id));
      }
      await this.safeEvent(scope, {
        sessionId,
        runId: turn.run.id,
        action: "assistant.message.accepted",
        objectType: "assistant_run",
        objectId: turn.run.id,
        after: {
          mode: input.mode,
          inputSha256: turn.userMessage.id,
          inputChars: input.text.length,
        },
      });
    }
    return turn;
  }

  getRun(identity: AssistantIdentity, id: string): Promise<AssistantRun> {
    return this.store.getRun(identity.assistantScope, id);
  }

  async evidence(identity: AssistantIdentity, id: string) {
    const run = await this.store.getRun(identity.assistantScope, id);
    if (!run.threadId) return { run, task: null };
    try {
      return { run, task: await this.taskFacade.detail(identity.assistantScope, run.threadId) };
    } catch (error) {
      return {
        run,
        task: null,
        warning: redactError(error),
      };
    }
  }

  getEvents(identity: AssistantIdentity, runId: string, afterId: string) {
    return this.store.getEvents(identity.assistantScope, runId, afterId || "0");
  }

  async stop(identity: AssistantIdentity, id: string): Promise<AssistantRun> {
    const scope = identity.assistantScope;
    const run = await this.store.getRun(scope, id);
    if (!["queued", "running"].includes(run.status)) return run;
    active.get(id)?.abort(new AssistantRunCancelled());
    if (run.threadId) {
      await this.taskFacade.cancel(scope, run.threadId, identity.memberNo).catch((error) => {
        if (!(error instanceof PmError && /cancel|already|completed/i.test(error.message))) throw error;
      });
    }
    await this.store.failRun(scope, id, {
      status: "cancelled",
      code: "USER_CANCELLED",
      message: "用户已停止本次生成",
    });
    await this.safeEvent(scope, {
      sessionId: run.sessionId,
      runId: id,
      action: "assistant.run.cancelled",
      objectType: "assistant_run",
      objectId: id,
      after: { previousStatus: run.status },
    });
    return this.store.getRun(scope, id);
  }

  async retry(identity: AssistantIdentity, id: string) {
    const scope = identity.assistantScope;
    const prior = await this.store.getRun(scope, id);
    if (!["failed", "cancelled", "interrupted", "blocked"].includes(prior.status)) {
      throw new AssistantStoreError("RUN_RETRY_CONFLICT", "只有失败、取消、中断或阻断的运行可以重试", 409);
    }
    const messages = await this.store.listMessages(scope, prior.sessionId);
    const userMessage = messages.find((message) => message.id === prior.userMessageId);
    const text = userMessage ? messageText(userMessage.parts) : "";
    if (!text) throw new AssistantStoreError("RETRY_INPUT_MISSING", "原用户消息无法读取，未重试", 409);
    return this.send(identity, prior.sessionId, {
      text,
      mode: prior.mode,
      clientMessageId: `retry-${prior.id}-${Date.now()}`,
    });
  }

  artifact(identity: AssistantIdentity, runId: string, path: string) {
    return this.store.getRun(identity.assistantScope, runId).then((run) => {
      if (!run.threadId) throw new AssistantStoreError("ARTIFACT_NOT_FOUND", "该对话没有研发任务产物", 404);
      return this.taskFacade.artifact(identity.assistantScope, run.threadId, path);
    });
  }

  private async executeTurn(
    identity: AssistantIdentity,
    run: AssistantRun,
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const scope = identity.assistantScope;
    let settled = false;
    let budgetDate: string | undefined;
    try {
      await this.store.startRun(scope, run.id);
      budgetDate = (await this.store.reserveBudget(
        scope,
        run.id,
        run.mode === "task" ? TASK_RESERVED_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS,
        run.mode === "task" ? MAX_TASK_MODEL_CALLS : 1,
      )).budgetDate;
      if (run.mode === "task") {
        const accounting = await this.executeTask(identity, run, text, controller);
        settled = true;
        await this.store.settleBudget(scope, {
          budgetDate,
          usage: accounting.usage,
          reservedCalls: MAX_TASK_MODEL_CALLS,
          callsUsed: accounting.callsUsed,
        });
        return;
      }

      const history = await this.store.historyForRun(scope, run.id);
      const messages: AssistantModelMessage[] = [
        { role: "system", content: systemPrompt(identity) },
        ...history.map((message) => ({
          role: message.role === "assistant" ? "assistant" as const : "user" as const,
          content: messageText(message.parts),
        })).filter((message) => message.content),
        { role: "user", content: text },
      ];
      const result = await this.model.stream({
        messages,
        signal: controller.signal,
        maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        onDelta: async (delta) => {
          if (!delta.text) return;
          await this.store.appendEvent(scope, run.id, run.sessionId, "message.delta", {
            messageId: run.assistantMessageId,
            delta: delta.text,
          });
        },
      });
      await this.store.finishRun(scope, run.id, {
        responseId: result.responseId,
        responseModel: result.model,
        usage: result.usage,
        text: result.text,
      });
      settled = true;
      await this.store.settleBudget(scope, {
        budgetDate,
        usage: result.usage,
        reservedCalls: 1,
        blockedReason: result.usage ? undefined : "模型响应缺少完整用量，预算账本已冻结",
      });
      await this.safeEvent(scope, {
        sessionId: run.sessionId,
        runId: run.id,
        action: "assistant.message.completed",
        objectType: "assistant_run",
        objectId: run.id,
        after: {
          responseModel: result.model,
          responseId: result.responseId ?? null,
          finishReason: result.finishReason ?? null,
          outputChars: result.text.length,
        },
        receipt: {
          synced: true,
          mode: "real",
          verified_at: new Date().toISOString(),
          usage: result.usage ?? null,
        },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof AssistantRunCancelled;
      const known = error instanceof AssistantModelError || error instanceof AssistantStoreError;
      const code = cancelled ? "MODEL_CANCELLED" : known ? error.code : "ASSISTANT_RUN_FAILED";
      const message = redactError(error);
      const usage = error instanceof AssistantModelError ? error.usage : undefined;
      const responseId = error instanceof AssistantModelError ? error.responseId : undefined;
      await this.store.failRun(scope, run.id, {
        status: cancelled ? "cancelled" : /BUDGET|LIMIT/.test(code) ? "blocked" : "failed",
        code,
        message,
        usage,
        responseId,
      }).catch((persistenceError) => {
        console.error("[assistant] 失败状态持久化失败", redactError(persistenceError));
      });
      if (budgetDate && !settled) {
        await this.store.settleBudget(scope, {
          budgetDate,
          usage,
          reservedCalls: run.mode === "task" ? MAX_TASK_MODEL_CALLS : 1,
          callsUsed: run.mode === "task" ? MAX_TASK_MODEL_CALLS : 1,
          blockedReason: usage ? undefined : cancelled ? undefined : "模型请求未取得完整用量，预算账本已冻结",
        }).catch((settlementError) => {
          console.error("[assistant] 预算结算失败", redactError(settlementError));
        });
      }
      await this.store.appendEvent(scope, run.id, run.sessionId, "error", {
        code,
        message,
      }).catch(() => undefined);
      await this.safeEvent(scope, {
        sessionId: run.sessionId,
        runId: run.id,
        action: `assistant.run.${cancelled ? "cancelled" : "failed"}`,
        objectType: "assistant_run",
        objectId: run.id,
        after: { code, message },
        receipt: { synced: false, error: message, mode: "real" },
      });
    }
  }

  private async executeTask(
    identity: AssistantIdentity,
    run: AssistantRun,
    text: string,
    controller: AbortController,
  ): Promise<{ usage: AssistantUsage; callsUsed: number }> {
    const scope = identity.assistantScope;
    const created = await this.taskFacade.create(scope, text, `assistant-${run.id}`, identity.memberNo);
    await this.store.setRunThread(scope, run.id, created.run.id);
    await this.store.appendEvent(scope, run.id, run.sessionId, "task.updated", {
      taskRunId: created.run.id,
      status: created.run.status,
      phase: "created",
    });
    await this.taskFacade.start(scope, created.run.id);
    let latest = await this.taskFacade.detail(scope, created.run.id);
    let priorSignature = "";
    while (!taskTerminal(latest.run.status)) {
      if (controller.signal.aborted) throw new AssistantRunCancelled();
      const signature = `${latest.run.status}:${latest.tasks.map((task) => task.status).join(",")}:${latest.artifacts.length}`;
      if (signature !== priorSignature) {
        priorSignature = signature;
        await this.store.appendEvent(scope, run.id, run.sessionId, "task.updated", {
          taskRunId: latest.run.id,
          status: latest.run.status,
          tasks: latest.tasks.map((task) => ({ id: task.id, status: task.status, presetKey: task.presetKey })),
          artifacts: latest.artifacts.length,
        });
      }
      await delay(TASK_POLL_MS, controller.signal);
      latest = await this.taskFacade.detail(scope, created.run.id);
    }
    if (latest.run.status !== "completed") {
      throw new AssistantModelError(
        latest.run.errorCode || "TASK_NOT_COMPLETED",
        latest.run.error || `研发任务以 ${latest.run.status} 结束，未取得完成回执`,
        502,
        {
          promptTokens: latest.run.usage.promptTokens,
          completionTokens: latest.run.usage.completionTokens,
          totalTokens: latest.run.usage.promptTokens + latest.run.usage.completionTokens,
        },
      );
    }
    for (const artifact of latest.artifacts) {
      await this.store.appendEvent(scope, run.id, run.sessionId, "artifact.created", {
        path: artifact.path,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        taskId: artifact.taskId,
      });
    }
    const narrative = taskNarrative(latest);
    await this.store.finishRun(scope, run.id, {
      text: narrative,
      responseModel: latest.run.modelId,
      parts: [
        { type: "text", text: narrative },
        {
          type: "task",
          runId: latest.run.id,
          status: latest.run.status,
          summary: `${latest.tasks.filter((task) => task.status === "completed").length}/${latest.tasks.length} 个员工任务完成`,
        },
        ...latest.artifacts.map((artifact) => ({
          type: "artifact" as const,
          path: artifact.path,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          taskId: artifact.taskId,
        })),
      ],
      threadId: latest.run.id,
      usage: {
        promptTokens: latest.run.usage.promptTokens,
        completionTokens: latest.run.usage.completionTokens,
        totalTokens: latest.run.usage.promptTokens + latest.run.usage.completionTokens,
      },
    });
    await this.safeEvent(scope, {
      sessionId: run.sessionId,
      runId: run.id,
      action: "assistant.task.completed",
      objectType: "assistant_run",
      objectId: run.id,
      after: {
        taskRunId: latest.run.id,
        taskStatus: latest.run.status,
        artifacts: latest.artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
      },
      receipt: {
        synced: true,
        mode: "real",
        verified_at: latest.run.verification && typeof latest.run.verification === "object"
          && typeof (latest.run.verification as { verifiedAt?: unknown }).verifiedAt === "string"
          ? (latest.run.verification as { verifiedAt: string }).verifiedAt
          : new Date().toISOString(),
      },
    });
    return {
      usage: {
        promptTokens: latest.run.usage.promptTokens,
        completionTokens: latest.run.usage.completionTokens,
        totalTokens: latest.run.usage.promptTokens + latest.run.usage.completionTokens,
      },
      callsUsed: taskCallCount(latest),
    };
  }

  private async safeEvent(scope: AssistantScope, input: Parameters<AssistantEventSink["append"]>[1]): Promise<void> {
    try {
      await this.events.append(scope, input);
    } catch (error) {
      console.error("[assistant] WorkData 事件写入失败", redactError(error));
      await this.store.appendEvent(scope, input.runId ?? input.objectId, input.sessionId, "warning", {
        code: "EVENT_LEDGER_WRITE_FAILED",
        message: redactError(error),
      }).catch(() => undefined);
    }
  }
}

class AssistantRunCancelled extends Error {
  constructor() {
    super("用户已停止生成");
    this.name = "AssistantRunCancelled";
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AssistantRunCancelled());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new AssistantRunCancelled());
    }, { once: true });
  });
}
