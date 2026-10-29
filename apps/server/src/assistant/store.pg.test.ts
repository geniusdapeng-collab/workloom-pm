import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { requireIsolatedPgTestConfig } from "../test-support/isolated-pg.js";
import { PgAssistantStore, type AssistantStore } from "./store.js";
import type { AssistantRun, AssistantScope, AssistantSession } from "./types.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const runDb = enabled ? describe : describe.skip;

runDb("assistant budget ledger in isolated PostgreSQL", () => {
  const suffix = randomUUID().slice(0, 8);
  const scope: AssistantScope = {
    tenantId: `tenant-assistant-budget-${suffix}`,
    workspaceId: `ws-assistant-budget-${suffix}`,
    memberNo: "MEM-BUDGET",
  };
  let owner: pg.Pool;
  let app: pg.Pool;
  let store: AssistantStore;
  let session: AssistantSession;
  let run: AssistantRun;

  beforeAll(async () => {
    const database = requireIsolatedPgTestConfig();
    owner = new pg.Pool({ connectionString: database.ownerUrl, max: 2 });
    app = new pg.Pool({ connectionString: database.appUrl, max: 4 });
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'pro')", [scope.tenantId, "Assistant budget test"]);
    await owner.query(
      "INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'Assistant budget test',$1,'ai-pm','delivery')",
      [scope.workspaceId, scope.tenantId],
    );
    store = new PgAssistantStore(app);
    session = await store.createSession(scope, "预算账本回归");
    const turn = await store.createTurn(scope, {
      sessionId: session.id,
      text: "验证任务模式预算预留和结算",
      mode: "task",
      model: "deepseek-flash",
      clientMessageId: `budget-${suffix}`,
      webSearch: false,
    });
    run = turn.run;
  });

  afterAll(async () => {
    await Promise.allSettled([owner?.end(), app?.end()]);
  });

  it("reserves concurrent task calls, blocks a third over-budget task, and settles actual counts", async () => {
    const previous = process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
    process.env.ASSISTANT_DAILY_TOKEN_LIMIT = "1200000";
    try {
      const reservations = await Promise.allSettled([
        store.reserveBudget(scope, run.id, 65 * 8192, 65),
        store.reserveBudget(scope, run.id, 65 * 8192, 65),
        store.reserveBudget(scope, run.id, 65 * 8192, 65),
      ]);
      const admitted = reservations
        .filter((result): result is PromiseFulfilledResult<{ budgetDate: string }> => result.status === "fulfilled")
        .map((result) => result.value);
      expect(admitted).toHaveLength(2);
      expect(reservations.filter((result) => result.status === "rejected")).toHaveLength(1);

      await store.settleBudget(scope, {
        budgetDate: admitted[0]!.budgetDate,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        reservedCalls: 65,
        callsUsed: 7,
      });
      await store.settleBudget(scope, {
        budgetDate: admitted[1]!.budgetDate,
        reservedCalls: 65,
        callsUsed: 1,
      });
      const ask = await store.reserveBudget(scope, run.id, 4096, 1);
      await store.settleBudget(scope, {
        budgetDate: ask.budgetDate,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        reservedCalls: 1,
        callsUsed: 1,
      });

      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
        const row = await client.query<{
          calls_reserved: number;
          calls_used: number;
          prompt_tokens_used: string;
          completion_tokens_used: string;
        }>(
          `SELECT calls_reserved,calls_used,prompt_tokens_used,completion_tokens_used
             FROM assistant_budgets
            WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [admitted[0]!.budgetDate, scope.tenantId, scope.workspaceId],
        );
        expect(row.rows[0]).toMatchObject({ calls_reserved: 0, calls_used: 9 });
        expect(Number(row.rows[0]!.prompt_tokens_used)).toBe(120);
        expect(Number(row.rows[0]!.completion_tokens_used)).toBe(210);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      if (previous === undefined) delete process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
      else process.env.ASSISTANT_DAILY_TOKEN_LIMIT = previous;
    }
  });

  it("enforces a separate daily search budget and settles search calls independently", async () => {
    const previous = process.env.ASSISTANT_DAILY_SEARCH_LIMIT;
    process.env.ASSISTANT_DAILY_SEARCH_LIMIT = "1";
    try {
      const reservations = await Promise.allSettled([
        store.reserveBudget(scope, run.id, 4096, 1, 1),
        store.reserveBudget(scope, run.id, 4096, 1, 1),
      ]);
      const admitted = reservations.find((result): result is PromiseFulfilledResult<{ budgetDate: string }> =>
        result.status === "fulfilled");
      expect(admitted).toBeDefined();
      expect(reservations.filter((result) => result.status === "rejected")).toHaveLength(1);
      await store.settleBudget(scope, {
        budgetDate: admitted!.value.budgetDate,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        reservedCalls: 1,
        callsUsed: 1,
        reservedSearchCalls: 1,
        searchCallsUsed: 1,
      });
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
        const row = await client.query<{
          search_calls_reserved: number;
          search_calls_used: number;
        }>(
          `SELECT search_calls_reserved,search_calls_used
             FROM assistant_budgets
            WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [admitted!.value.budgetDate, scope.tenantId, scope.workspaceId],
        );
        expect(row.rows[0]).toMatchObject({ search_calls_reserved: 0, search_calls_used: 1 });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      if (previous === undefined) delete process.env.ASSISTANT_DAILY_SEARCH_LIMIT;
      else process.env.ASSISTANT_DAILY_SEARCH_LIMIT = previous;
    }
  });
});
