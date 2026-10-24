// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndustryRouteBoundary } from "./IndustryRoutes";
import { NavigationAccessBoundary, NavigationAccessProvider } from "./NavigationAccess";

const auth = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../lib/trpc", async (original) => ({
  ...await original<typeof import("../lib/trpc")>(),
  ensureDemoLogin: vi.fn(async () => undefined),
  trpc: { access: { me: { query: auth.query } } },
}));

function access(kind: "guest" | "member", granted = false) {
  return {
    subject: { kind, id: "current", memberNo: kind === "guest" ? "GUEST" : "MEM-001", name: "当前身份", role: kind === "guest" ? "readonly" : "staff" },
    scope: { tenantId: "tenant", workspaceId: "workspace" }, plan: "pro", capabilities: {}, partnerCapabilities: [], availableScopes: [],
    authority: { source: "server", evaluatedAt: new Date().toISOString(), grantIds: [] },
    navigationPermissions: granted ? ["ai-pm.development.read"] : [], actionPermissions: [],
    bundle: { configured: true, bundleId: "ai-pm", bundleName: "产品团队", bundleVersion: "3.0.1", integrityDigest: null,
      ui: { terminology: {}, objects: [], workflows: [], home: { widgets: [] }, navigation: { slots: [{
        capabilityId: "ai-pm.development", title: "产品交付", route: "/development", group: "automation", icon: "developer", clients: ["pc"], permissions: ["ai-pm.development.read"],
      }] } } },
  };
}

let root: Root | undefined;
const text = () => document.body.textContent ?? "";
const loginLink = () => [...document.querySelectorAll("a")].find((link) => link.textContent === "登录或注册");
async function mount(boundary: "navigation" | "industry") {
  const privatePage = <main>授权后的私有工作台</main>;
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={["/development"]}><NavigationAccessProvider>
    {boundary === "navigation" ? <NavigationAccessBoundary pathname="/development">{privatePage}</NavigationAccessBoundary>
      : <IndustryRouteBoundary definition={{ path: "/development", capabilityId: "ai-pm.development" }}>{privatePage}</IndustryRouteBoundary>}
  </NavigationAccessProvider></MemoryRouter>));
}

beforeEach(() => { auth.query.mockReset(); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("正式首装游客的受限入口", () => {
  it.each(["navigation", "industry"] as const)("%s 禁止页为游客提供正式登录入口且不渲染私有内容", async (boundary) => {
    auth.query.mockResolvedValue(access("guest")); await mount(boundary);
    expect(loginLink()?.getAttribute("href")).toBe("/login?next=%2Fdevelopment");
    expect(text()).not.toContain("授权后的私有工作台");
    expect(text()).toContain("只读游客");
  });

  it.each(["navigation", "industry"] as const)("%s 已正式登录但无权限者保留管理员提示", async (boundary) => {
    auth.query.mockResolvedValue(access("member")); await mount(boundary);
    expect(text()).toContain("当前身份不能访问此页面");
    expect(loginLink()).toBeUndefined();
    expect(text()).not.toContain("授权后的私有工作台");
    expect(text()).toContain("管理员");
  });

  it("有服务端行业权限的成员才渲染工作台", async () => {
    auth.query.mockResolvedValue(access("member", true)); await mount("industry");
    expect(text()).toContain("授权后的私有工作台");
    expect(loginLink()).toBeUndefined();
  });

  it("登录后仍重新读取服务端权限，不因身份切换事件自动放行", async () => {
    auth.query.mockResolvedValue(access("guest")); await mount("industry");
    expect(loginLink()).toBeTruthy();
    auth.query.mockResolvedValue(access("member"));
    await act(async () => { window.dispatchEvent(new Event("workloom:identity-changed")); });
    expect(text()).toContain("当前身份不能访问此页面");
    expect(text()).not.toContain("授权后的私有工作台");
    auth.query.mockResolvedValue(access("member", true));
    await act(async () => { window.dispatchEvent(new Event("workloom:identity-changed")); });
    expect(text()).toContain("授权后的私有工作台");
  });

  it("权限查询失败仍失败关闭，不误判为可登录放行", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    auth.query.mockRejectedValue(new Error("权限服务不可用")); await mount("industry");
    expect(text()).toContain("行业界面未能安全加载");
    expect(text()).not.toContain("授权后的私有工作台");
    expect(loginLink()).toBeUndefined();
  });
});
