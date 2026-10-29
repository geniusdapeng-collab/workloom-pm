import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AssistantMessage,
  AssistantPart,
  AssistantRun,
  AssistantRunEvent,
  AssistantRunStatus,
  AssistantScope,
  AssistantSession,
  AssistantUsage,
} from "./types.js";

type Row = Record<string, unknown>;

const stamp = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const nullableStamp = (value: unknown): string | null => value == null ? null : stamp(value);
const nullableString = (value: unknown): string | null => value == null ? null : String(value);

function sessionRow(row: Row): AssistantSession {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as AssistantSession["status"],
    pinned: Boolean(row.pinned),
    lastMessageAt: nullableStamp(row.last_message_at),
    lastRunId: nullableString(row.last_run_id),
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
  };
}

function messageRow(row: Row): AssistantMessage {
  return {
    id: String(row.id),
    seq: String(row.seq),
    sessionId: String(row.session_id),
    role: row.role as AssistantMessage["role"],
    parts: row.parts as AssistantPart[],
    parentMessageId: nullableString(row.parent_message_id),
    clientMessageId: nullableString(row.client_message_id),
    runId: nullableString(row.run_id),
    status: row.status as AssistantMessage["status"],
    createdAt: stamp(row.created_at),
    finishedAt: nullableStamp(row.finished_at),
  };
}

function runRow(row: Row): AssistantRun {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    mode: row.mode as AssistantRun["mode"],
    model: String(row.model),
    responseModel: nullableString(row.response_model),
    status: row.status as AssistantRunStatus,
    threadId: nullableString(row.thread_id),
    responseId: nullableString(row.response_id),
    usage: (row.usage ?? {}) as AssistantUsage,
    errorCode: nullableString(row.error_code),
    error: nullableString(row.error),
    userMessageId: String(row.user_message_id),
    assistantMessageId: String(row.assistant_message_id),
    startedAt: nullableStamp(row.started_at),
    finishedAt: nullableStamp(row.finished_at),
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
  };
}

function eventRow(row: Row): AssistantRunEvent {
  return {
    id: String(row.id),
    type: String(row.type),
    payload: row.payload as Record<string, unknown>,
    createdAt: stamp(row.created_at),
  };
}

export class AssistantStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "AssistantStoreError";
  }
}

export interface CreateTurnInput {
  sessionId: string;
  text: string;
  mode: "ask" | "task";
  model: string;
  clientMessageId: string;
}

export interface AssistantStore {
  consumeLaunchNonce(input: {
    scope: AssistantScope;
    jti: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  createSession(scope: AssistantScope, title?: string): Promise<AssistantSession>;
  listSessions(scope: AssistantScope, options: { query?: string; archived?: boolean; limit: number }): Promise<AssistantSession[]>;
  getSession(scope: AssistantScope, id: string): Promise<AssistantSession>;
  updateSession(scope: AssistantScope, id: string, patch: { title?: string; pinned?: boolean }): Promise<AssistantSession>;
  setSessionStatus(scope: AssistantScope, id: string, status: "active" | "archived" | "deleted"): Promise<AssistantSession>;
  listMessages(scope: AssistantScope, sessionId: string, afterSeq?: string, limit?: number): Promise<AssistantMessage[]>;
  createTurn(scope: AssistantScope, input: CreateTurnInput): Promise<{ run: AssistantRun; userMessage: AssistantMessage; assistantMessage: AssistantMessage; replayed: boolean }>;
  historyForRun(scope: AssistantScope, runId: string, limit?: number): Promise<AssistantMessage[]>;
  getRun(scope: AssistantScope, id: string): Promise<AssistantRun>;
  setRunThread(scope: AssistantScope, runId: string, threadId: string): Promise<void>;
  startRun(scope: AssistantScope, runId: string): Promise<void>;
  appendEvent(scope: AssistantScope, runId: string, sessionId: string, type: string, payload?: Record<string, unknown>): Promise<void>;
  updateAssistantText(scope: AssistantScope, runId: string, text: string): Promise<void>;
  finishRun(scope: AssistantScope, runId: string, input: {
    responseId?: string | null;
    responseModel?: string | null;
    usage?: AssistantUsage;
    text: string;
    parts?: AssistantPart[];
    threadId?: string | null;
  }): Promise<void>;
  failRun(scope: AssistantScope, runId: string, input: {
    status: "failed" | "cancelled" | "interrupted" | "blocked";
    code: string;
    message: string;
    text?: string;
    usage?: AssistantUsage;
    responseId?: string | null;
  }): Promise<void>;
  getEvents(scope: AssistantScope, runId: string, afterId: string, limit?: number): Promise<AssistantRunEvent[]>;
  reserveBudget(scope: AssistantScope, runId: string, maxOutputTokens: number, reservedCalls?: number): Promise<{ budgetDate: string }>;
  settleBudget(scope: AssistantScope, input: {
    budgetDate: string;
    usage?: AssistantUsage;
    reservedCalls: number;
    callsUsed?: number;
    blockedReason?: string;
  }): Promise<void>;
  recoverInterrupted(scope: AssistantScope): Promise<number>;
}

export class PgAssistantStore implements AssistantStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(scope: AssistantScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeLaunchNonce(input: {
    scope: AssistantScope;
    jti: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    const jtiHash = createHash("sha256").update(input.jti).digest("hex");
    await this.tx(input.scope, async (client) => {
      const inserted = await client.query(
        `INSERT INTO assistant_launch_nonces(jti_hash,tenant_id,workspace_id,member_no,issued_at,expires_at,consumed_at)
         VALUES($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT(jti_hash) DO NOTHING
         RETURNING jti_hash`,
        [jtiHash, input.scope.tenantId, input.scope.workspaceId, input.scope.memberNo, input.issuedAt, input.expiresAt],
      );
      if ((inserted.rowCount ?? 0) !== 1) {
        throw new AssistantStoreError("LAUNCH_CODE_REPLAYED", "登录入口已被使用，请从鹏经理后台重新进入", 409);
      }
    });
  }

  async createSession(scope: AssistantScope, title = "新对话"): Promise<AssistantSession> {
    return this.tx(scope, async (client) => {
      const id = `as-${randomUUID()}`;
      const result = await client.query<Row>(
        `INSERT INTO assistant_sessions(id,tenant_id,workspace_id,owner_member_no,title)
         VALUES($1,$2,$3,$4,$5)
         RETURNING *`,
        [id, scope.tenantId, scope.workspaceId, scope.memberNo, title],
      );
      return sessionRow(result.rows[0]!);
    });
  }

  async listSessions(scope: AssistantScope, options: { query?: string; archived?: boolean; limit: number }): Promise<AssistantSession[]> {
    return this.tx(scope, async (client) => {
      const query = options.query?.trim() ?? "";
      const status = options.archived ? "archived" : "active";
      const result = await client.query<Row>(
        `SELECT s.*
           FROM assistant_sessions s
          WHERE s.tenant_id=$1 AND s.workspace_id=$2 AND s.owner_member_no=$3 AND s.status=$4
            AND ($5='' OR s.title ILIKE '%' || $5 || '%' OR EXISTS (
              SELECT 1 FROM assistant_messages m
               WHERE m.session_id=s.id AND m.tenant_id=s.tenant_id AND m.workspace_id=s.workspace_id
                 AND lower(m.parts::text) LIKE '%' || lower($5) || '%'
            ))
          ORDER BY s.pinned DESC, COALESCE(s.last_message_at,s.created_at) DESC, s.id DESC
          LIMIT $6`,
        [scope.tenantId, scope.workspaceId, scope.memberNo, status, query, options.limit],
      );
      return result.rows.map(sessionRow);
    });
  }

  async getSession(scope: AssistantScope, id: string): Promise<AssistantSession> {
    return this.tx(scope, async (client) => {
      const result = await client.query<Row>(
        `SELECT * FROM assistant_sessions
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4 AND status<>'deleted'`,
        [id, scope.tenantId, scope.workspaceId, scope.memberNo],
      );
      if (!result.rows[0]) throw new AssistantStoreError("SESSION_NOT_FOUND", "会话不存在或无权访问", 404);
      return sessionRow(result.rows[0]);
    });
  }

  async updateSession(scope: AssistantScope, id: string, patch: { title?: string; pinned?: boolean }): Promise<AssistantSession> {
    return this.tx(scope, async (client) => {
      const result = await client.query<Row>(
        `UPDATE assistant_sessions
            SET title=COALESCE($5,title),
                pinned=COALESCE($6,pinned),
                updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4
            AND status IN ('active','archived')
          RETURNING *`,
        [id, scope.tenantId, scope.workspaceId, scope.memberNo, patch.title ?? null, patch.pinned ?? null],
      );
      if (!result.rows[0]) throw new AssistantStoreError("SESSION_NOT_FOUND", "会话不存在或无权修改", 404);
      return sessionRow(result.rows[0]);
    });
  }

  async setSessionStatus(scope: AssistantScope, id: string, status: "active" | "archived" | "deleted"): Promise<AssistantSession> {
    return this.tx(scope, async (client) => {
      const result = await client.query<Row>(
        `UPDATE assistant_sessions SET status=$5,updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4 AND status<>'deleted'
          RETURNING *`,
        [id, scope.tenantId, scope.workspaceId, scope.memberNo, status],
      );
      if (!result.rows[0]) throw new AssistantStoreError("SESSION_NOT_FOUND", "会话不存在或无权修改", 404);
      return sessionRow(result.rows[0]);
    });
  }

  async listMessages(scope: AssistantScope, sessionId: string, afterSeq = "0", limit = 200): Promise<AssistantMessage[]> {
    return this.tx(scope, async (client) => {
      const session = await client.query(
        `SELECT 1 FROM assistant_sessions
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4 AND status<>'deleted'`,
        [sessionId, scope.tenantId, scope.workspaceId, scope.memberNo],
      );
      if (!session.rowCount) throw new AssistantStoreError("SESSION_NOT_FOUND", "会话不存在或无权访问", 404);
      const result = await client.query<Row>(
        `SELECT * FROM assistant_messages
          WHERE session_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND seq>$4
          ORDER BY seq ASC LIMIT $5`,
        [sessionId, scope.tenantId, scope.workspaceId, afterSeq, Math.max(1, Math.min(limit, 500))],
      );
      return result.rows.map(messageRow);
    });
  }

  async createTurn(scope: AssistantScope, input: CreateTurnInput): Promise<{
    run: AssistantRun;
    userMessage: AssistantMessage;
    assistantMessage: AssistantMessage;
    replayed: boolean;
  }> {
    return this.tx(scope, async (client) => {
      const session = await client.query<Row>(
        `SELECT * FROM assistant_sessions
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4 AND status='active'
          FOR UPDATE`,
        [input.sessionId, scope.tenantId, scope.workspaceId, scope.memberNo],
      );
      if (!session.rows[0]) throw new AssistantStoreError("SESSION_NOT_ACTIVE", "会话已归档、删除或无权写入", 409);

      const userMessageId = `am-${randomUUID()}`;
      const insertedUser = await client.query<Row>(
        `INSERT INTO assistant_messages(
           id,session_id,tenant_id,workspace_id,owner_member_no,role,parts,client_message_id,status,finished_at)
         VALUES($1,$2,$3,$4,$5,'user',$6::jsonb,$7,'completed',now())
         ON CONFLICT(session_id,client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          userMessageId,
          input.sessionId,
          scope.tenantId,
          scope.workspaceId,
          scope.memberNo,
          JSON.stringify([{ type: "text", text: input.text }]),
          input.clientMessageId,
        ],
      );
      if (!insertedUser.rows[0]) {
        const existing = await client.query<Row>(
          `SELECT * FROM assistant_messages
            WHERE session_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND client_message_id=$4`,
          [input.sessionId, scope.tenantId, scope.workspaceId, input.clientMessageId],
        );
        const existingMessage = existing.rows[0];
        if (!existingMessage) throw new AssistantStoreError("IDEMPOTENCY_FAILED", "幂等消息无法回读", 409);
        const run = await client.query<Row>(
          `SELECT * FROM assistant_runs
            WHERE user_message_id=$1 AND tenant_id=$2 AND workspace_id=$3
            ORDER BY created_at DESC LIMIT 1`,
          [existingMessage.id, scope.tenantId, scope.workspaceId],
        );
        if (!run.rows[0]) throw new AssistantStoreError("RUN_NOT_FOUND", "消息已存在，但对应运行无法回读", 409);
        const assistant = await client.query<Row>(
          `SELECT * FROM assistant_messages WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [run.rows[0].assistant_message_id, scope.tenantId, scope.workspaceId],
        );
        return {
          run: runRow(run.rows[0]),
          userMessage: messageRow(existingMessage),
          assistantMessage: messageRow(assistant.rows[0]!),
          replayed: true,
        };
      }

      const runId = `ar-${randomUUID()}`;
      const assistantMessageId = `am-${randomUUID()}`;
      const assistant = await client.query<Row>(
        `INSERT INTO assistant_messages(
           id,session_id,tenant_id,workspace_id,owner_member_no,role,parts,parent_message_id,run_id,status)
         VALUES($1,$2,$3,$4,$5,'assistant',$6::jsonb,$7,$8,'pending')
         RETURNING *`,
        [
          assistantMessageId,
          input.sessionId,
          scope.tenantId,
          scope.workspaceId,
          scope.memberNo,
          JSON.stringify([{ type: "text", text: "" }]),
          insertedUser.rows[0].id,
          runId,
        ],
      );
      const run = await client.query<Row>(
        `INSERT INTO assistant_runs(
           id,session_id,tenant_id,workspace_id,owner_member_no,user_message_id,assistant_message_id,mode,model)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          runId,
          input.sessionId,
          scope.tenantId,
          scope.workspaceId,
          scope.memberNo,
          insertedUser.rows[0].id,
          assistantMessageId,
          input.mode,
          input.model,
        ],
      );
      await client.query(
        `UPDATE assistant_messages SET run_id=$2
          WHERE id=$1 AND tenant_id=$3 AND workspace_id=$4`,
        [insertedUser.rows[0].id, runId, scope.tenantId, scope.workspaceId],
      );
      await client.query(
        `UPDATE assistant_sessions
            SET last_message_at=now(),last_run_id=$5,updated_at=now(),
                title=CASE WHEN title='新对话' THEN left($6,60) ELSE title END
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4`,
        [input.sessionId, scope.tenantId, scope.workspaceId, scope.memberNo, runId, input.text.replace(/\s+/g, " ").trim()],
      );
      await client.query(
        `INSERT INTO assistant_run_events(run_id,session_id,tenant_id,workspace_id,type,payload)
         VALUES($1,$2,$3,$4,'message.start',$5::jsonb)`,
        [runId, input.sessionId, scope.tenantId, scope.workspaceId,
          JSON.stringify({ userMessageId: insertedUser.rows[0].id, assistantMessageId, mode: input.mode, model: input.model })],
      );
      return {
        run: runRow(run.rows[0]!),
        userMessage: messageRow(insertedUser.rows[0]),
        assistantMessage: messageRow(assistant.rows[0]!),
        replayed: false,
      };
    });
  }

  async historyForRun(scope: AssistantScope, runId: string, limit = 40): Promise<AssistantMessage[]> {
    return this.tx(scope, async (client) => {
      const run = await client.query<{ session_id: string; user_message_id: string }>(
        `SELECT session_id,user_message_id FROM assistant_runs
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [runId, scope.tenantId, scope.workspaceId],
      );
      if (!run.rows[0]) throw new AssistantStoreError("RUN_NOT_FOUND", "运行不存在或无权访问", 404);
      const result = await client.query<Row>(
        `SELECT * FROM (
           SELECT * FROM assistant_messages
            WHERE session_id=$1 AND tenant_id=$2 AND workspace_id=$3
              AND role IN ('user','assistant') AND status='completed'
              AND id<>$4
            ORDER BY seq DESC LIMIT $5
         ) recent ORDER BY seq ASC`,
        [run.rows[0].session_id, scope.tenantId, scope.workspaceId, run.rows[0].user_message_id, limit],
      );
      return result.rows.map(messageRow);
    });
  }

  async getRun(scope: AssistantScope, id: string): Promise<AssistantRun> {
    return this.tx(scope, async (client) => {
      const result = await client.query<Row>(
        `SELECT * FROM assistant_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [id, scope.tenantId, scope.workspaceId],
      );
      if (!result.rows[0]) throw new AssistantStoreError("RUN_NOT_FOUND", "运行不存在或无权访问", 404);
      return runRow(result.rows[0]);
    });
  }

  async setRunThread(scope: AssistantScope, runId: string, threadId: string): Promise<void> {
    await this.tx(scope, async (client) => {
      const result = await client.query(
        `UPDATE assistant_runs SET thread_id=$4,updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [runId, scope.tenantId, scope.workspaceId, threadId],
      );
      if (!result.rowCount) throw new AssistantStoreError("RUN_NOT_FOUND", "运行不存在或无权修改", 404);
    });
  }

  async startRun(scope: AssistantScope, runId: string): Promise<void> {
    await this.tx(scope, async (client) => {
      const result = await client.query<{ assistant_message_id: string }>(
        `UPDATE assistant_runs
            SET status='running',started_at=COALESCE(started_at,now()),updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='queued'
          RETURNING assistant_message_id`,
        [runId, scope.tenantId, scope.workspaceId],
      );
      if (!result.rows[0]) throw new AssistantStoreError("RUN_STATE_CONFLICT", "运行已开始、取消或状态不匹配", 409);
      await client.query(
        `UPDATE assistant_messages SET status='streaming'
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [result.rows[0].assistant_message_id, scope.tenantId, scope.workspaceId],
      );
    });
  }

  async appendEvent(scope: AssistantScope, runId: string, sessionId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.tx(scope, async (client) => {
      await client.query(
        `INSERT INTO assistant_run_events(run_id,session_id,tenant_id,workspace_id,type,payload)
         VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [runId, sessionId, scope.tenantId, scope.workspaceId, type, JSON.stringify(payload)],
      );
    });
  }

  async updateAssistantText(scope: AssistantScope, runId: string, text: string): Promise<void> {
    await this.tx(scope, async (client) => {
      const result = await client.query<{ assistant_message_id: string }>(
        `UPDATE assistant_messages m
            SET parts=$5::jsonb
           FROM assistant_runs r
          WHERE r.id=$1 AND r.tenant_id=$2 AND r.workspace_id=$3
            AND m.id=r.assistant_message_id AND m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id
            AND m.status IN ('pending','streaming')
          RETURNING m.id AS assistant_message_id`,
        [runId, scope.tenantId, scope.workspaceId, scope.memberNo, JSON.stringify([{ type: "text", text }])],
      );
      if (!result.rows[0]) throw new AssistantStoreError("MESSAGE_NOT_WRITABLE", "助手消息已结束或不存在", 409);
    });
  }

  async finishRun(scope: AssistantScope, runId: string, input: {
    responseId?: string | null;
    responseModel?: string | null;
    usage?: AssistantUsage;
    text: string;
    parts?: AssistantPart[];
    threadId?: string | null;
  }): Promise<void> {
    await this.tx(scope, async (client) => {
      const result = await client.query<{ assistant_message_id: string; session_id: string }>(
        `UPDATE assistant_runs
            SET status='completed',response_id=$4,response_model=$5,usage=$6::jsonb,thread_id=COALESCE($7,thread_id),
                error=NULL,error_code=NULL,finished_at=now(),updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='running'
          RETURNING assistant_message_id,session_id`,
        [runId, scope.tenantId, scope.workspaceId, input.responseId ?? null,
          input.responseModel ?? null, JSON.stringify(input.usage ?? {}), input.threadId ?? null],
      );
      if (!result.rows[0]) throw new AssistantStoreError("RUN_STATE_CONFLICT", "运行已结束或状态不匹配", 409);
      await client.query(
        `UPDATE assistant_messages
            SET parts=$4::jsonb,status='completed',finished_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [result.rows[0].assistant_message_id, scope.tenantId, scope.workspaceId,
          JSON.stringify(input.parts ?? [{ type: "text", text: input.text }])],
      );
      await client.query(
        `UPDATE assistant_sessions SET last_message_at=now(),updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND owner_member_no=$4`,
        [result.rows[0].session_id, scope.tenantId, scope.workspaceId, scope.memberNo],
      );
      await client.query(
        `INSERT INTO assistant_run_events(run_id,session_id,tenant_id,workspace_id,type,payload)
         VALUES($1,$2,$3,$4,'usage.updated',$5::jsonb),
               ($1,$2,$3,$4,'message.done',$6::jsonb)`,
        [runId, result.rows[0].session_id, scope.tenantId, scope.workspaceId,
          JSON.stringify(input.usage ?? {}),
          JSON.stringify({
            messageId: result.rows[0].assistant_message_id,
            responseId: input.responseId ?? null,
            responseModel: input.responseModel ?? null,
          })],
      );
    });
  }

  async failRun(scope: AssistantScope, runId: string, input: {
    status: "failed" | "cancelled" | "interrupted" | "blocked";
    code: string;
    message: string;
    text?: string;
    usage?: AssistantUsage;
    responseId?: string | null;
  }): Promise<void> {
    await this.tx(scope, async (client) => {
      const result = await client.query<{ assistant_message_id: string; session_id: string }>(
        `UPDATE assistant_runs
            SET status=$4,error_code=$5,error=$6,usage=COALESCE($7::jsonb,usage),
                response_id=COALESCE($8,response_id),finished_at=now(),updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status IN ('queued','running')
          RETURNING assistant_message_id,session_id`,
        [runId, scope.tenantId, scope.workspaceId, input.status, input.code, input.message.slice(0, 1000),
          input.usage ? JSON.stringify(input.usage) : null, input.responseId ?? null],
      );
      if (!result.rows[0]) return;
      const text = input.text?.trim() || `本次运行未完成：${input.message}`;
      await client.query(
        `UPDATE assistant_messages
            SET parts=$4::jsonb,status=$5,finished_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [result.rows[0].assistant_message_id, scope.tenantId, scope.workspaceId,
          JSON.stringify([{ type: "text", text }]), input.status === "cancelled" ? "cancelled" : "failed"],
      );
      await client.query(
        `INSERT INTO assistant_run_events(run_id,session_id,tenant_id,workspace_id,type,payload)
         VALUES($1,$2,$3,$4,'error',$5::jsonb),
               ($1,$2,$3,$4,'message.done',$6::jsonb)`,
        [runId, result.rows[0].session_id, scope.tenantId, scope.workspaceId,
          JSON.stringify({ code: input.code, message: input.message }),
          JSON.stringify({ messageId: result.rows[0].assistant_message_id, failed: true })],
      );
    });
  }

  async getEvents(scope: AssistantScope, runId: string, afterId: string, limit = 200): Promise<AssistantRunEvent[]> {
    return this.tx(scope, async (client) => {
      const result = await client.query<Row>(
        `SELECT e.* FROM assistant_run_events e
          WHERE e.run_id=$1 AND e.tenant_id=$2 AND e.workspace_id=$3 AND e.id>$4
          ORDER BY e.id ASC LIMIT $5`,
        [runId, scope.tenantId, scope.workspaceId, afterId, Math.max(1, Math.min(limit, 500))],
      );
      return result.rows.map(eventRow);
    });
  }

  async reserveBudget(scope: AssistantScope, runId: string, maxOutputTokens: number, reservedCalls = 1): Promise<{ budgetDate: string }> {
    const maxCalls = boundedInteger(process.env.ASSISTANT_DAILY_CALL_LIMIT, 300, 1, 100_000);
    const maxTokens = boundedInteger(process.env.ASSISTANT_DAILY_TOKEN_LIMIT, 2_000_000, 1_000, 100_000_000);
    if (!Number.isSafeInteger(reservedCalls) || reservedCalls < 1 || reservedCalls > 10_000) {
      throw new AssistantStoreError("INVALID_BUDGET_CONFIG", "预算调用预留必须是 1..10000 的整数", 503);
    }
    return this.tx(scope, async (client) => {
      const dateResult = await client.query<{ budget_date: string }>("SELECT current_date::text AS budget_date");
      const budgetDate = dateResult.rows[0]!.budget_date;
      // Materialize today's row before locking it. SELECT ... FOR UPDATE cannot
      // serialize two callers when the row does not exist yet, which would let
      // both pass their token check before either reservation is visible.
      await client.query(
        `INSERT INTO assistant_budgets(
           budget_date,tenant_id,workspace_id,calls_reserved,calls_used,updated_at)
         VALUES($1,$2,$3,0,0,now())
         ON CONFLICT(budget_date,tenant_id,workspace_id) DO NOTHING`,
        [budgetDate, scope.tenantId, scope.workspaceId],
      );
      const existing = await client.query<Row>(
        `SELECT * FROM assistant_budgets
          WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE`,
        [budgetDate, scope.tenantId, scope.workspaceId],
      );
      const row = existing.rows[0];
      const reserved = Number(row?.calls_reserved ?? 0);
      const calls = reserved + Number(row?.calls_used ?? 0);
      const promptTokens = Number(row?.prompt_tokens_used ?? 0);
      const completionTokens = Number(row?.completion_tokens_used ?? 0);
      const blocked = Boolean(row?.blocked);
      if (blocked) throw new AssistantStoreError("BUDGET_FROZEN", String(row?.blocked_reason ?? "预算账本已冻结"), 429);
      if (calls + reservedCalls > maxCalls) throw new AssistantStoreError("BUDGET_BLOCKED", `今日模型调用余额不足以预留 ${reservedCalls} 次`, 429);
      if (promptTokens + completionTokens + reserved * 8192 + maxOutputTokens > maxTokens) {
        throw new AssistantStoreError("BUDGET_BLOCKED", "今日 token 余额不足，本次请求未发出", 429);
      }
      await client.query(
        `INSERT INTO assistant_budgets(
           budget_date,tenant_id,workspace_id,calls_reserved,calls_used,updated_at)
         VALUES($1,$2,$3,$4,0,now())
         ON CONFLICT(budget_date,tenant_id,workspace_id)
         DO UPDATE SET calls_reserved=assistant_budgets.calls_reserved+$4,updated_at=now()`,
        [budgetDate, scope.tenantId, scope.workspaceId, reservedCalls],
      );
      await client.query(
        `INSERT INTO assistant_run_events(run_id,session_id,tenant_id,workspace_id,type,payload)
         SELECT $1,session_id,tenant_id,workspace_id,'usage.updated',$4::jsonb
           FROM assistant_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [runId, scope.tenantId, scope.workspaceId, JSON.stringify({ budgetDate, reservedCalls, maxOutputTokens })],
      );
      return { budgetDate };
    });
  }

  async settleBudget(scope: AssistantScope, input: {
    budgetDate: string;
    usage?: AssistantUsage;
    reservedCalls: number;
    callsUsed?: number;
    blockedReason?: string;
  }): Promise<void> {
    const callsUsed = input.callsUsed ?? 1;
    if (!Number.isSafeInteger(input.reservedCalls) || input.reservedCalls < 1 || input.reservedCalls > 10_000) {
      throw new AssistantStoreError("INVALID_BUDGET_CONFIG", "预算调用结算必须对应 1..10000 次预留", 503);
    }
    if (!Number.isSafeInteger(callsUsed) || callsUsed < 0 || callsUsed > 10_000) {
      throw new AssistantStoreError("INVALID_BUDGET_CONFIG", "已用调用数必须是 0..10000 的整数", 503);
    }
    await this.tx(scope, async (client) => {
      await client.query(
        `UPDATE assistant_budgets
            SET calls_reserved=GREATEST(0,calls_reserved-$4),
                calls_used=calls_used+$5,
                prompt_tokens_used=prompt_tokens_used+$6,
                completion_tokens_used=completion_tokens_used+$7,
                blocked=CASE WHEN $8::text IS NULL THEN blocked ELSE true END,
                blocked_reason=COALESCE($8,blocked_reason),
                updated_at=now()
          WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3`,
        [
          input.budgetDate,
          scope.tenantId,
          scope.workspaceId,
          input.reservedCalls,
          callsUsed,
          input.usage?.promptTokens ?? 0,
          input.usage?.completionTokens ?? 0,
          input.blockedReason ?? null,
        ],
      );
    });
  }

  async recoverInterrupted(scope: AssistantScope): Promise<number> {
    return this.tx(scope, async (client) => {
      const stale = await client.query<{ id: string; session_id: string; assistant_message_id: string }>(
        `UPDATE assistant_runs
            SET status='interrupted',error_code='PROCESS_INTERRUPTED',
                error='服务进程中断；已保留会话与部分消息，请重试',finished_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2
            AND status IN ('queued','running')
            AND updated_at < now() - interval '10 minutes'
          RETURNING id,session_id,assistant_message_id`,
        [scope.tenantId, scope.workspaceId],
      );
      for (const row of stale.rows) {
        await client.query(
          `UPDATE assistant_messages
              SET status='failed',finished_at=now()
            WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status IN ('pending','streaming')`,
          [row.assistant_message_id, scope.tenantId, scope.workspaceId],
        );
        await client.query(
          `INSERT INTO assistant_run_events(run_id,session_id,tenant_id,workspace_id,type,payload)
           VALUES($1,$2,$3,$4,'error',$5::jsonb)`,
          [row.id, row.session_id, scope.tenantId, scope.workspaceId,
            JSON.stringify({ code: "PROCESS_INTERRUPTED", message: "服务进程中断，需重试" })],
        );
      }
      return stale.rowCount ?? 0;
    });
  }
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AssistantStoreError("INVALID_BUDGET_CONFIG", `预算配置必须是 ${min}..${max} 的整数`, 503);
  }
  return value;
}
