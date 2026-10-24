// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PmDelivery from "./PmDelivery";

vi.mock("../../lib/trpc", () => ({ ensureDemoLogin: vi.fn(async () => {}), getToken: () => "fixture-session" }));
vi.mock("./P25", () => ({ default: () => <div>研发设备详情</div> }));

type Json = Record<string, unknown>;
type Handler = (path: string, options: RequestInit) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
const configuration = { configured: true, modelId: "deepseek-flash", policyVersion: "fixture", employees: [{ presetKey: "chief-pm", name: "产品总监", description: "拆解目标并核对交付。" }] };
const run = (status = "created", id = "internal-run-private-567890") => ({ id, goal: "交付中文待办功能与验收文件", status, requestedEmployee: null, modelId: "deepseek-flash", createdAt: "2026-10-24T01:00:00Z", updatedAt: "2026-10-24T01:00:00Z", error: null, errorCode: null, usage: { promptTokens: 21, completionTokens: 13 } });
const detail = (status = "created", id?: string) => ({ run: run(status, id), tasks: [], artifacts: [] });
const file = { id: "private-artifact", taskId: "private-task", path: "交付/需求.md", sha256: "a".repeat(64), sizeBytes: 42, mediaType: "text/plain", verifiedAt: "2026-10-24T01:00:00Z" };
let root: Root | undefined;
let host: HTMLDivElement;
let history: ReturnType<typeof run>[];
let handler: Handler;
let calls: Array<{ path: string; options: RequestInit }>;

async function flush() { await act(async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); }); }
async function mount() { root = createRoot(host); await act(async () => root!.render(<MemoryRouter><PmDelivery /></MemoryRouter>)); await flush(); }
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`button missing: ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); await flush(); }
async function input(id: string, value: string) {
  const node = host.querySelector<HTMLTextAreaElement>(`#${id}`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await flush(); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); history = []; calls = [];
  handler = (path) => path.endsWith("/status") ? { status: 200, body: configuration } : path.endsWith("/runs") ? { status: 200, body: { runs: history } } : { status: 200, body: detail() };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit = {}) => {
    calls.push({ path: url, options }); const result = await handler(url, options);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  }));
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("产品交付页面的中文边界与原交互", () => {
  it("未配置时禁用提交，空态和配置路径仍可见", async () => {
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? { ...configuration, configured: false, modelId: "" } : { runs: [] } });
    await mount();
    expect(button("交给团队执行").disabled).toBe(true);
    expect(host.textContent).toContain("模型待配置"); expect(host.textContent).toContain("还没有任务");
    expect(host.querySelector('a[href="/onboarding"]')).toBeTruthy();
    expect(host.querySelector(".wl-textarea")).toBeTruthy(); expect(host.querySelector(".wl-card")).toBeTruthy();
  }, 30_000);

  it("未知状态、员工和模型均有中文兜底，后端英文错误不泄露", async () => {
    history = [run("unregistered_state")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? { ...configuration, modelId: "private-model-x", employees: [] } : path.endsWith("/runs") ? { runs: history } : { run: { ...run("unregistered_state"), error: "Internal Server Error request_id secret", errorCode: "PRIVATE_CODE", modelId: "private-model-x" }, tasks: [{ id: "task-hidden", presetKey: "private-worker-key", status: "foreign_state", goal: "正确的中文任务目标", dependsOn: ["missing-private-task"], outputRefs: [], error: null, summary: "JSON raw_field", usage: null, modelId: null, executionBackend: null }], artifacts: [] } });
    await mount(); await click("交付中文待办功能");
    expect(host.textContent).toContain("状态待确认"); expect(host.textContent).toContain("待确认员工"); expect(host.textContent).toContain("已配置模型");
    expect(host.textContent).not.toMatch(/unregistered_state|foreign_state|private-worker-key|missing-private-task|private-model-x|Internal Server Error|request_id|PRIVATE_CODE|JSON raw_field/);
  }, 30_000);

  it("短目标和越界文件路径均在提交前拒绝", async () => {
    await mount(); await input("pm-goal", "短"); await submit(); expect(host.textContent).toContain("至少输入4个字");
    await input("pm-goal", "交付可核对的需求"); await input("pm-checks", "../outside.txt"); await submit();
    expect(host.textContent).toContain("相对文件路径"); expect(calls.filter((item) => item.options.method === "POST")).toHaveLength(0);
  }, 30_000);

  it("提交重入只创建一次，启动失败后重试保留幂等键与脱敏编号", async () => {
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let posts = 0;
    handler = async (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs") && options.method === "GET") return { status: 200, body: { runs: [] } };
      if (path.endsWith("/runs") && options.method === "POST") { posts++; if (posts === 1) await paused; return { status: 200, body: detail() }; }
      if (path.endsWith("/start") && posts === 1) return { status: 500, body: { error: "Internal Server Error" } };
      return { status: 200, body: detail() };
    };
    await mount(); await input("pm-goal", "交付可验证的需求和文件");
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(posts).toBe(1); expect(button("正在提交目标").disabled).toBe(true);
    await act(async () => release!()); await flush(); expect(host.textContent).toContain("目标已保存，启动尚未完成");
    await submit();
    const createBodies = calls.filter((item) => item.path.endsWith("/runs") && item.options.method === "POST").map((item) => JSON.parse(String(item.options.body)));
    expect(createBodies).toHaveLength(2); expect(createBodies[0].idempotencyKey).toBe(createBodies[1].idempotencyKey);
    expect(host.textContent).toContain("尾号 567890"); expect(host.textContent).not.toContain("internal-run-private");
  }, 30_000);

  it("开始、恢复和取消保留原接口，最终状态重新读取", async () => {
    let current = "created"; history = [run()];
    handler = (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: history } };
      if (options.method === "POST") { current = path.endsWith("/start") ? "paused" : path.endsWith("/resume") ? "blocked" : "cancelled"; return { status: 200, body: {} }; }
      return { status: 200, body: detail(current) };
    };
    await mount(); await click("交付中文待办功能"); await click("开始执行"); expect(host.textContent).toContain("已暂停，可恢复");
    await click("校验并恢复"); expect(host.textContent).toContain("遇到边界，已阻断");
    await click("取消任务"); expect(host.textContent).toContain("已取消");
    expect(calls.filter((item) => item.options.method === "POST").map((item) => item.path.split("/").at(-1))).toEqual(["start", "resume", "cancel"]);
  }, 30_000);

  it("文件摘要不符时同时拒绝预览和下载", async () => {
    history = [run("completed")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : path.includes("/artifacts?") ? { ...file, content: "不可信内容", sha256: "b".repeat(64) } : { ...detail("completed"), artifacts: [file] } });
    await mount(); await click("交付中文待办功能"); await click("交付/需求.md");
    expect(host.textContent).toContain("产物摘要与任务回执不一致"); expect(host.querySelector("pre")).toBeNull();
    await click("下载"); expect(host.querySelector("pre")).toBeNull();
  }, 30_000);

  it("文件原文按文本预览、可关闭，下载内容与摘要验证后的文件一致", async () => {
    const content = '<script>alert("不执行")</script>\n交付原文'; history = [run("completed")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : path.includes("/artifacts?") ? { ...file, content } : { ...detail("completed"), artifacts: [file] } });
    const makeUrl = vi.fn(() => "blob:fixture"); const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: makeUrl, revokeObjectURL: revoke }));
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await mount(); await click("交付中文待办功能"); await click("交付/需求.md");
    expect(host.querySelector("pre")?.textContent).toBe(content); expect(host.querySelector("script")).toBeNull();
    await click("关闭预览"); expect(host.querySelector("pre")).toBeNull();
    await click("下载"); expect(makeUrl).toHaveBeenCalledOnce(); expect(makeUrl.mock.calls[0]).toHaveLength(1); expect(anchorClick).toHaveBeenCalledOnce();
    const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement; expect(anchor.download).toBe("需求.md"); expect(anchor.href).toBe("blob:fixture");
  }, 30_000);

  it("服务读取失败显示中文错误，重载后恢复原记录", async () => {
    let fail = true;
    handler = (path) => fail ? { status: 503, body: { error: "connection_refused: internal-db" } } : { status: 200, body: path.endsWith("/status") ? configuration : { runs: [] } };
    await mount(); expect(host.textContent).toContain("请求未完成"); expect(host.textContent).not.toContain("connection_refused");
    fail = false; await click("重新加载"); expect(host.textContent).toContain("还没有任务"); expect(host.querySelector('[role="alert"]')).toBeNull();
  }, 30_000);
});
