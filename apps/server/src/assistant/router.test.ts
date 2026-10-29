import { describe, expect, it, vi } from "vitest";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";
import { createAssistantRouter } from "./router.js";
import { AssistantService } from "./service.js";
import type { AssistantStore } from "./store.js";
import type { AssistantModelClient } from "./model.js";

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

const session = {
  id: "as-00000000-0000-4000-8000-000000000001",
  title: "新对话",
  status: "active" as const,
  pinned: false,
  lastMessageAt: null,
  lastRunId: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const model: AssistantModelClient = {
  model: "deepseek-flash",
  stream: vi.fn(async () => ({ text: "ok", model: "deepseek-flash" })),
};

const authority = async () => ({ identity, permissions: {} });

function fakeStore(): AssistantStore {
  return {
    consumeLaunchNonce: vi.fn(),
    createSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => [session]),
    getSession: vi.fn(async () => session),
    updateSession: vi.fn(async () => session),
    setSessionStatus: vi.fn(async () => session),
    listMessages: vi.fn(async () => []),
    createTurn: vi.fn(),
    historyForRun: vi.fn(async () => []),
    getRun: vi.fn(),
    setRunThread: vi.fn(),
    startRun: vi.fn(),
    appendEvent: vi.fn(),
    updateAssistantText: vi.fn(),
    finishRun: vi.fn(),
    failRun: vi.fn(),
    getEvents: vi.fn(async () => []),
    reserveBudget: vi.fn(),
    settleBudget: vi.fn(),
    recoverInterrupted: vi.fn(async () => 0),
  } as unknown as AssistantStore;
}

describe("assistant HTTP route admission", () => {
  it("rejects unauthenticated API access and accepts a verified member session", async () => {
    const router = createAssistantRouter({
      authority,
      service: new AssistantService({
        store: fakeStore(),
        model,
        events: { append: vi.fn() },
        taskFacade: {} as never,
      }),
    });
    expect((await router.request("/sessions")).status).toBe(401);

    const token = await signDemoToken(identity);
    const me = await router.request("/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      authenticated: true,
      memberNo: "MEM-001",
      workspaceId: "ws-aipm-demo",
    });
  });

  it("enforces CSRF on writes while keeping GET reads usable", async () => {
    const store = fakeStore();
    const router = createAssistantRouter({
      authority,
      service: new AssistantService({
        store,
        model,
        events: { append: vi.fn() },
        taskFacade: {} as never,
      }),
    });
    const token = await signDemoToken(identity);
    const noCsrf = await router.request("/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ error: { code: "CSRF_REQUIRED" } });

    const csrf = "c".repeat(64);
    const created = await router.request("/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `workloom_csrf=${csrf}`,
        "x-workloom-csrf": csrf,
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: session.id });
    expect(store.createSession).toHaveBeenCalledOnce();
  });
});
