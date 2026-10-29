import { describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
import { AssistantModelError, type AssistantModelClient } from "./model.js";
import type { AssistantSearchClient } from "./search.js";
import { AssistantService, systemPrompt } from "./service.js";
import type { AssistantStore } from "./store.js";
import type { AssistantIdentity, AssistantRun, AssistantSearchReceipt } from "./types.js";

const identity: Identity = {
  kind: "member",
  memberId: "member-1",
  memberNo: "MEM-001",
  name: "产品所有者",
  role: "owner",
  tenantId: "tenant-1",
  workspaceId: "ws-aipm-demo",
  plan: "pro",
};
const assistantIdentity: AssistantIdentity = {
  ...identity,
  assistantScope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId, memberNo: identity.memberNo },
};
const run: AssistantRun = {
  id: "ar-00000000-0000-4000-8000-000000000001",
  sessionId: "as-00000000-0000-4000-8000-000000000001",
  mode: "ask",
  model: "deepseek-flash",
  responseModel: null,
  status: "queued",
  threadId: null,
  responseId: null,
  usage: {},
  webSearchRequested: true,
  searchStatus: "not_requested",
  searchQuery: null,
  searchResultCount: 0,
  searchCompletedAt: null,
  errorCode: null,
  error: null,
  userMessageId: "am-user",
  assistantMessageId: "am-assistant",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const searchReceipt: AssistantSearchReceipt = {
  query: "DeepSeek Search API 官方计费",
  searchedAt: "2026-10-30T01:55:00.000Z",
  results: [{
    title: "网页搜索与抓取",
    url: "https://api-docs.deepseek.com/zh-cn/guides/search",
    snippet: "官方指南",
    summary: "Search 接口按成功请求计费，端点由官方文档给出。",
    siteName: "DeepSeek API Docs",
    publishedAt: null,
    authority: 4,
    rerankScore: 2.8,
  }],
};

function fakeStore() {
  const value = {
    createTurn: vi.fn(async () => ({
      run: structuredClone(run),
      userMessage: {
        id: "am-user", seq: "1", sessionId: run.sessionId, role: "user", parts: [{ type: "text", text: "搜索官方计费" }],
        parentMessageId: null, clientMessageId: "client-1", runId: run.id, status: "completed",
        createdAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
      },
      assistantMessage: {
        id: "am-assistant", seq: "2", sessionId: run.sessionId, role: "assistant", parts: [{ type: "text", text: "" }],
        parentMessageId: "am-user", clientMessageId: null, runId: run.id, status: "pending",
        createdAt: new Date(0).toISOString(), finishedAt: null,
      },
      replayed: false,
    })),
    startRun: vi.fn(),
    reserveBudget: vi.fn(async () => ({ budgetDate: "2026-10-30" })),
    updateSearchState: vi.fn(async () => undefined),
    appendEvent: vi.fn(),
    historyForRun: vi.fn(async () => []),
    finishRun: vi.fn(),
    failRun: vi.fn(async () => undefined),
    settleBudget: vi.fn(),
  };
  return value;
}

describe("assistant web search orchestration", () => {
  it("searches before the model, persists real sources, and settles both budgets", async () => {
    const store = fakeStore();
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async () => ({ text: "官方 Search 端点见来源。", model: "deepseek-flash", responseId: "resp-1",
        usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } })),
    };
    const search: AssistantSearchClient = { configured: true, search: vi.fn(async () => searchReceipt) };
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model,
      search,
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "DeepSeek Search API 官方计费",
      mode: "ask",
      clientMessageId: "client-1",
      webSearch: true,
    });
    await vi.waitFor(() => expect(store.finishRun).toHaveBeenCalledOnce());
    expect(store.updateSearchState).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      status: "completed",
      resultCount: 1,
    }));
    expect(store.appendEvent).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, run.sessionId, "search.completed", expect.objectContaining({
      resultCount: 1,
    }));
    const modelMessages = ((model.stream as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages;
    expect(modelMessages.some((message) => message.content.includes("不可信外部资料")
      && message.content.includes(searchReceipt.results[0]!.url))).toBe(true);
    expect(store.finishRun).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({ type: "source", url: searchReceipt.results[0]!.url }),
      ]),
    }));
    expect(store.settleBudget).toHaveBeenCalledWith(assistantIdentity.assistantScope, expect.objectContaining({
      reservedSearchCalls: 1,
      searchCallsUsed: 1,
    }));
  });

  it("fails closed before the model when the required search fails", async () => {
    const store = fakeStore();
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async () => ({ text: "must not run", model: "deepseek-flash" })),
    };
    const search: AssistantSearchClient = {
      configured: true,
      search: vi.fn(async () => { throw new AssistantModelError("SEARCH_FAILED", "upstream unavailable", 502); }),
    };
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model,
      search,
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "search required",
      mode: "ask",
      clientMessageId: "client-2",
      webSearch: true,
    });
    await vi.waitFor(() => expect(store.failRun).toHaveBeenCalledOnce());
    expect(model.stream).not.toHaveBeenCalled();
    expect(store.failRun).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      code: "SEARCH_FAILED",
    }));
    expect(store.settleBudget).toHaveBeenCalledWith(assistantIdentity.assistantScope, expect.objectContaining({
      reservedSearchCalls: 1,
      searchCallsUsed: 1,
    }));
  });

  it("settles known provider usage before message persistence so later storage failures do not freeze the budget", async () => {
    const store = fakeStore();
    const usage = { promptTokens: 50, completionTokens: 12, totalTokens: 62 };
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async () => ({
        text: "真实回答",
        model: "deepseek-flash",
        responseId: "resp-persist-failure",
        usage,
      })),
    };
    store.finishRun.mockRejectedValueOnce(new Error("message persistence failed"));
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model,
      search: { configured: true, search: vi.fn(async () => ({ ...searchReceipt, results: [] })) },
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "search with persistence failure",
      mode: "ask",
      clientMessageId: "client-3",
      webSearch: true,
    });
    await vi.waitFor(() => expect(store.failRun).toHaveBeenCalledOnce());
    expect(store.settleBudget).toHaveBeenCalledWith(assistantIdentity.assistantScope, expect.objectContaining({
      usage,
      reservedCalls: 1,
      reservedSearchCalls: 1,
      searchCallsUsed: 1,
    }));
    expect(store.settleBudget).not.toHaveBeenCalledWith(
      assistantIdentity.assistantScope,
      expect.objectContaining({ blockedReason: expect.any(String) }),
    );
  });
});

describe("assistant system prompt", () => {
  it("states the Shanghai business date", () => {
    expect(systemPrompt(assistantIdentity, new Date("2026-10-29T17:18:28.000Z")))
      .toContain("当前业务日期 2026-10-30（Asia/Shanghai）");
  });
});
