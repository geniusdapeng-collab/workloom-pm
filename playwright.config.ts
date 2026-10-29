import { defineConfig } from "@playwright/test";

const assistantOnly = process.env.PLAYWRIGHT_ASSISTANT_ONLY === "1";
const reuseExistingServer = !assistantOnly && !process.env.CI;
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? 8877);
const pcPort = Number(process.env.WEB_PORT ?? 3100);

// 浏览器及应用请求仍可能遵循 HTTP(S)_PROXY：合并而非覆盖 runner 既有白名单，
// 并同时写入大小写键以兼容不同代理实现。webServer 自身使用 port（原始 TCP）
// 探活，避免 URL 探针被代理、健康接口内容或重定向影响。
const noProxy = Array.from(new Set(
  [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost"]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean),
)).join(",");
process.env.NO_PROXY = noProxy;
process.env.no_proxy = noProxy;

export default defineConfig({
  testDir: "./tests/ui",
  outputDir: "test-results/ui",
  // Chromium 一致不等于宿主字体度量一致；基线按操作系统隔离，避免把
  // macOS 与 Linux 的 CJK 字体行高差异误报为布局回归。
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  // 普通 CI 只读已提交基线；显式 `playwright --update-snapshots` 仍可生成待审候选。
  updateSnapshots: process.env.CI ? "none" : "missing",
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "line",
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    },
  },
  use: {
    locale: "zh-CN",
    colorScheme: "dark",
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: assistantOnly ? "off" : "retain-on-failure",
  },
  webServer: [
    {
      name: "base-api",
      command: "pnpm -C apps/server start",
      env: {
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(apiPort),
        SERVICE_C_WORKSPACE_ID: "ws-aipm-demo",
        SERVICE_C_DEMO_AUTH: "true",
      },
      port: apiPort,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "b-pc",
      command: "VITE_ENABLE_UI_DIAGNOSTICS=true node scripts/ui-e2e-preview.mjs web",
      env: {
        WEB_PORT: String(pcPort),
        SERVER_PORT: String(apiPort),
      },
      port: pcPort,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    },
    ...(assistantOnly ? [] : [{
      name: "b-mobile",
      command: "node scripts/ui-e2e-preview.mjs webb",
      env: {
        WEBB_PORT: "3101",
        SERVER_PORT: String(apiPort),
      },
      port: 3101,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    }, {
      name: "c-mobile",
      command: "node scripts/ui-e2e-preview.mjs webc",
      env: {
        WEBC_PORT: "3102",
        SERVER_PORT: String(apiPort),
      },
      port: 3102,
      stdout: "pipe",
      reuseExistingServer,
      timeout: 120_000,
    }]),
  ],
});
