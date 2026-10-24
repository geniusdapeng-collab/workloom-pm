// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ autoScan: false, scan: vi.fn(), inbox: vi.fn() }));
vi.mock("../../lib/product", () => ({ get SECRETARY_AUTO_SCAN() { return state.autoScan; } }));
vi.mock("../../lib/trpc", () => ({ ensureDemoLogin: async () => {}, trpc: { service: { secretary: {
  scan: { mutate: state.scan }, inbox: { query: state.inbox },
  settings: { query: async () => ({ settings: { widget_size: "small", persona_key: "tianmei", voice_on: false } }) },
} } } }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/useAskRail", () => ({ useAskRailPadding: () => 0, useSideNavWidth: () => 0 }));
vi.mock("../../voice/VoiceEngine", () => ({ VoiceEngine: { speak: vi.fn() } }));
vi.mock("./MateLive2D", () => ({ MateLive2D: () => null }));
vi.mock("../loomball", () => ({ LoomBall: () => null, loomBallEnabled: false,
  emotionOfSystem: () => "idle", useStableEmotion: (value: string) => value, emotionLabelOf: () => "待机" }));
vi.mock("../../shell/NavMenu", () => ({ canonicalNavigationPath: (value: string) => value }));
vi.mock("@workloom/ui", () => ({ Icon: () => null, clientChineseText: (value: string) => value,
  clientValueText: (value: string) => value, useManagedSurface: () => ({}) }));
import { LoomMate } from "./LoomMate";

describe("秘书心跳遵循产品自动扫描设置", () => {
  let root: Root | undefined;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    state.scan.mockReset().mockResolvedValue({ added: 0 });
    state.inbox.mockReset().mockResolvedValue({ items: [] });
    localStorage.setItem("loommate.hidden", "1");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); document.body.innerHTML = "";
  });
  async function mount() {
    const element = document.createElement("div"); document.body.append(element); root = createRoot(element);
    await act(async () => root!.render(<LoomMate />));
  }
  it("关闭时跨过两次20秒心跳仍无扫描写入，收件箱继续刷新并在卸载后停止", async () => {
    state.autoScan = false;
    await mount(); expect(state.inbox).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(40_001); });
    expect(state.scan).not.toHaveBeenCalled(); expect(state.inbox).toHaveBeenCalledTimes(3);
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(state.inbox).toHaveBeenCalledTimes(3);
  });
  it("开启时保留原扫描行为，扫描失败仍刷新已有收件箱", async () => {
    state.autoScan = true; state.scan.mockRejectedValue(new Error("offline"));
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(state.scan).toHaveBeenCalledTimes(1); expect(state.inbox).toHaveBeenCalledTimes(2);
  });
});
