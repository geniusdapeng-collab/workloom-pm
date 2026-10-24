import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), model: vi.fn(), call: vi.fn(), fetch: vi.fn(),
}));
vi.mock("../../service/events.js", () => ({ svcQuery: mocks.query, serviceTx: mocks.transaction }));
vi.mock("../../service/llm.js", () => ({ llmCall: mocks.call }));

beforeEach(() => {
  vi.resetModules();
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.transaction.mockReset().mockImplementation(async (operationWorkspace: string, fn: (client: unknown, scope: unknown) => Promise<unknown>) => fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }, { tenantId: "fixture-tenant", workspaceId: operationWorkspace }));
  mocks.model.mockReset().mockResolvedValue("根据真实来源生成的简报");
  mocks.call.mockReset().mockReturnValue(mocks.model);
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("GITHUB_API_BASE", "https://api.github.com,https://gh-proxy.com/https://api.github.com");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("AI-PM source integrity and credential destination", () => {
  it.each([404, 500])("HTTP%s competitor response is unavailable, never a verified empty snapshot", async (status) => {
    mocks.fetch.mockResolvedValue(new Response("not found", { status }));
    const { competitorScan } = await import("../../service/aipm.js");
    const result = await competitorScan("fixture-workspace", [{ name: "竞品", url: "https://example.com/missing" }]);
    expect(result.reports[0]?.mock).toBe(true);
    expect(result.reports[0]?.changed).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("blank HTTP200 competitor page cannot become a successful snapshot", async () => {
    mocks.fetch.mockResolvedValue(new Response("  <script>ignored()</script>  ", { status: 200 }));
    const { competitorScan } = await import("../../service/aipm.js");
    const result = await competitorScan("fixture-workspace", [{ name: "竞品", url: "https://example.com/blank" }]);
    expect(result.reports[0]?.mock).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("all failed RSS sources cannot be marked real just because a model is configured", async () => {
    mocks.fetch.mockResolvedValue(new Response("upstream unavailable", { status: 503 }));
    const { industryRadar } = await import("../../service/aipm.js");
    const result = await industryRadar("fixture-workspace", ["https://example.com/feed"]);
    expect(result.mock).toBe(true);
    expect(result.items).toEqual([]);
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("a GitHub bearer is never forwarded to a third-party fallback after the official API fails", async () => {
    mocks.query.mockResolvedValue([{ secret_enc: "fixture-owner-github-credential" }]);
    mocks.fetch.mockImplementation(async (url: string) => {
      if (new URL(url).hostname === "api.github.com") throw new Error("fixture network unavailable");
      return Response.json([]);
    });
    const { githubPulse } = await import("../../service/aipm.js");
    const result = await githubPulse("fixture-workspace", ["example/repo"]);
    const unsafe = mocks.fetch.mock.calls.filter(([url, init]) => new URL(String(url)).origin !== "https://api.github.com"
      && Boolean((init as RequestInit)?.headers && ((init as RequestInit).headers as Record<string, string>).Authorization));
    expect(unsafe).toEqual([]);
    expect(result.mock).toBe(true);
  });

  it("authenticated GitHub requests refuse redirects", async () => {
    mocks.query.mockResolvedValue([{ secret_enc: "fixture-owner-github-credential" }]);
    mocks.fetch.mockImplementation(async () => Response.json([]));
    const { githubPulse } = await import("../../service/aipm.js");
    await githubPulse("fixture-workspace", ["example/repo"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of mocks.fetch.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://api.github.com");
      expect((init as RequestInit).redirect).toBe("error");
    }
  });

  it("anonymous explicit development endpoint remains usable without receiving any credential", async () => {
    vi.stubEnv("GITHUB_API_BASE", "http://127.0.0.1:19999/fixture-api");
    mocks.fetch.mockImplementation(async () => Response.json([]));
    const { githubPulse } = await import("../../service/aipm.js");
    const result = await githubPulse("fixture-workspace", ["example/repo"]);
    expect(result.pulses[0]?.mock).toBe(false);
    for (const [, init] of mocks.fetch.mock.calls) expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("successful RSS retrieval keeps real source items when another source fails", async () => {
    mocks.fetch.mockImplementation(async (url: string) => String(url).endsWith("good")
      ? new Response("<rss><channel><item><title>官方更新</title><link>https://example.com/news</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>")
      : new Response("unavailable", { status: 500 }));
    const { industryRadar } = await import("../../service/aipm.js");
    const result = await industryRadar("fixture-workspace", ["https://example.com/bad", "https://example.com/good"]);
    expect(result.mock).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.link).toBe("https://example.com/news");
  });

  it("a successful HTML response is not a verified RSS source; an empty Atom feed is valid", async () => {
    mocks.fetch.mockResolvedValue(new Response("<!doctype html><html><body>temporary error</body></html>"));
    const { industryRadar } = await import("../../service/aipm.js");
    const invalid = await industryRadar("fixture-workspace", ["https://example.com/feed"]);
    expect(invalid.sourcesFetched).toBe(0);
    expect(invalid.sourcesFailed).toBe(1);
    expect(invalid.mock).toBe(true);
    mocks.fetch.mockResolvedValue(new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"/>'));
    const empty = await industryRadar("fixture-workspace", ["https://example.com/empty"]);
    expect(empty.sourcesFetched).toBe(1);
    expect(empty.sourcesFailed).toBe(0);
    expect(empty.summaryState).toBe("no-items");
  });

  it("RSS snapshot IDs are scoped to the actual workspace", async () => {
    mocks.fetch.mockImplementation(async () => new Response('<rss><channel><item><title>shared item</title><link>https://example.com/shared</link></item></channel></rss>'));
    const inserts: unknown[][] = [];
    mocks.transaction.mockImplementation(async (workspaceId: string, fn: (client: unknown, scope: unknown) => Promise<unknown>) => fn({
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes("INSERT INTO kb_documents")) inserts.push(parameters!);
        return { rows: [], rowCount: 1 };
      }),
    }, { tenantId: "fixture-tenant", workspaceId }));
    const { industryRadar } = await import("../../service/aipm.js");
    await industryRadar("workspace-one", ["https://example.com/feed"]);
    await industryRadar("workspace-two", ["https://example.com/feed"]);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[0]).not.toBe(inserts[1]?.[0]);
    expect(inserts.map((parameters) => parameters[1])).toEqual(["workspace-one", "workspace-two"]);
  });

  it("an idempotent RSS conflict is counted as deduplicated, never as a new persisted row", async () => {
    mocks.fetch.mockResolvedValue(new Response('<rss><channel><item><title>existing item</title><link>https://example.com/existing</link></item></channel></rss>'));
    mocks.transaction.mockImplementation(async (workspaceId: string, fn: (client: unknown, scope: unknown) => Promise<unknown>) => fn({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }, { tenantId: "fixture-tenant", workspaceId }));
    const { industryRadar } = await import("../../service/aipm.js");
    const result = await industryRadar("fixture-workspace", ["https://example.com/feed"]);
    expect(result.persistedCount).toBe(0);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.persistenceErrors).toBe(0);
  });

  it("a failed RSS insert rolls back its savepoint before the next item and reports both outcomes", async () => {
    mocks.fetch.mockResolvedValue(new Response('<rss><channel><item><title>first</title><link>https://example.com/first</link></item><item><title>second</title><link>https://example.com/second</link></item></channel></rss>'));
    let aborted = false;
    let first = true;
    const commands: string[] = [];
    mocks.transaction.mockImplementation(async (workspaceId: string, fn: (client: unknown, scope: unknown) => Promise<unknown>) => fn({
      query: vi.fn(async (sql: string) => {
        commands.push(sql.trim().split("\n")[0]!);
        if (sql.startsWith("ROLLBACK TO SAVEPOINT")) { aborted = false; return { rows: [], rowCount: 0 }; }
        if (aborted) throw new Error("transaction is aborted");
        if (sql.includes("INSERT INTO kb_documents") && first) { first = false; aborted = true; throw new Error("fixture missing collection"); }
        return { rows: [], rowCount: sql.includes("INSERT INTO kb_documents") ? 1 : 0 };
      }),
    }, { tenantId: "fixture-tenant", workspaceId }));
    const { industryRadar } = await import("../../service/aipm.js");
    const result = await industryRadar("fixture-workspace", ["https://example.com/feed"]);
    expect(result.persistedCount).toBe(1);
    expect(result.persistenceErrors).toBe(1);
    expect(result.deduplicatedCount).toBe(0);
    expect(commands).toContain("ROLLBACK TO SAVEPOINT aipm_intel_item");
    expect(aborted).toBe(false);
  });

  it("competitor snapshots use the server-resolved tenant and workspace, with workspace-specific IDs", async () => {
    mocks.fetch.mockImplementation(async () => new Response("<html><body>verified competitor content</body></html>"));
    const inserts: unknown[][] = [];
    mocks.transaction.mockImplementation(async (workspaceId: string, fn: (client: unknown, scope: unknown) => Promise<unknown>) => fn({
      query: vi.fn(async (sql: string, parameters: unknown[]) => {
        if (sql.includes("INSERT INTO org_memory")) inserts.push(parameters);
        return { rows: [], rowCount: 1 };
      }),
    }, { tenantId: "resolved-tenant", workspaceId }));
    const { competitorScan } = await import("../../service/aipm.js");
    for (const workspaceId of ["workspace-one", "workspace-two"]) {
      const result = await competitorScan(workspaceId, [{ name: "competitor", url: "https://example.com/shared" }]);
      expect(result.reports[0]?.mock).toBe(false);
    }
    expect(inserts[0]?.slice(1, 3)).toEqual(["resolved-tenant", "workspace-one"]);
    expect(inserts[1]?.slice(1, 3)).toEqual(["resolved-tenant", "workspace-two"]);
    expect(inserts[0]?.[0]).not.toBe(inserts[1]?.[0]);
  });
});
