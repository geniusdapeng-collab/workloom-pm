import { expect, test } from "@playwright/test";

const assistantUrl = process.env.ASSISTANT_UI_BASE_URL
  ?? `http://127.0.0.1:${process.env.WEB_PORT ?? "3100"}`;

const session = {
  id: "as-00000000-0000-4000-8000-000000000001",
  title: "客户反馈模块评审",
  status: "active",
  pinned: true,
  lastMessageAt: "2026-10-29T04:00:00.000Z",
  lastRunId: "ar-00000000-0000-4000-8000-000000000001",
  createdAt: "2026-10-29T03:50:00.000Z",
  updatedAt: "2026-10-29T04:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
  // The product page may reference Google Fonts. This UI contract tests the
  // local application and must not depend on an external network round-trip.
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (route) => route.abort());
  await page.route("**/health", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, service: "assistant-ui-fixture" }),
  }));
  await page.route("**/api/voice/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ enabled: false, configured: false }),
  }));
  await page.route("**/api/assistant/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      authenticated: true,
      memberNo: "MEM-001",
      name: "老板",
      role: "owner",
      workspaceId: "ws-aipm-demo",
      csrfToken: "test-csrf",
      status: {
        ok: true,
        model: "deepseek-flash",
        modelConfigured: true,
        mode: "beta",
        persistence: "postgres",
        streaming: "sse",
        externalActions: false,
        codeExecution: "linux-bubblewrap-node24",
      },
    }),
  }));
  await page.route(/\/api\/assistant\/sessions(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session] }),
  }));
  await page.route(`**/api/assistant/sessions/${session.id}/messages`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      messages: [
        {
          id: "am-user", seq: "1", sessionId: session.id, role: "user",
          parts: [{ type: "text", text: "请评审客户反馈模块并给出验收标准。" }],
          parentMessageId: null, clientMessageId: "client-1", runId: session.lastRunId,
          status: "completed", createdAt: "2026-10-29T03:59:00.000Z", finishedAt: "2026-10-29T03:59:00.000Z",
        },
        {
          id: "am-assistant", seq: "2", sessionId: session.id, role: "assistant",
          parts: [
            { type: "text", text: "## 评审结论\n\n请补充权限矩阵、失败回执和不可用时的回退路径。\n\n- 验收幂等\n- 验收租户隔离" },
            { type: "task", runId: "ar-task-fixture", status: "completed", summary: "6/6 个员工任务完成" },
            { type: "artifact", path: "artifacts/prd.md", sha256: "a".repeat(64), sizeBytes: 512, taskId: "task-1" },
          ],
          parentMessageId: "am-user", clientMessageId: null, runId: session.lastRunId,
          status: "completed", createdAt: "2026-10-29T04:00:00.000Z", finishedAt: "2026-10-29T04:00:00.000Z",
        },
      ],
    }),
  }));
  await page.route(`**/api/assistant/runs/${session.lastRunId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      run: {
        id: session.lastRunId, sessionId: session.id, mode: "ask", model: "deepseek-flash",
        status: "completed", threadId: null, responseId: "response-fixture", responseModel: "DeepSeek-V4.1-Flash-1017",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        errorCode: null, error: null, userMessageId: "am-user", assistantMessageId: "am-assistant",
        startedAt: "2026-10-29T03:59:30.000Z", finishedAt: "2026-10-29T04:00:00.000Z",
        createdAt: "2026-10-29T03:59:29.000Z", updatedAt: "2026-10-29T04:00:00.000Z",
      },
      task: null,
    }),
  }));
});

test("assistant workbench renders a persisted conversation with evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${assistantUrl}/assistant`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("客户反馈模块评审").first()).toBeVisible();
  await expect(page.getByText("请补充权限矩阵、失败回执和不可用时的回退路径。")).toBeVisible();
  await expect(page.getByText("DeepSeek 极速模型").last()).toBeVisible();
  await expect(page.getByText("DeepSeek-V4.1-Flash-1017")).toBeVisible();
  await expect(page.getByText("已配置")).toBeVisible();
  await expect(page.getByText("6/6 个员工任务完成")).toBeVisible();
  await expect(page.getByText("已验证产物文件")).toBeVisible();
  await expect(page.getByText("512 字节 · 点击下载")).toBeVisible();
  for (const technicalText of ["deepseek-flash", "SSE", "token", "DAG", "artifacts/prd.md", "BETA"]) {
    await expect(page.getByText(technicalText, { exact: false })).toHaveCount(0);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/assistant-desktop-1440.png", fullPage: false });
});

test("assistant workbench stays usable at a 390 px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${assistantUrl}/assistant`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "退出" })).toBeVisible();
  const menu = page.getByRole("button", { name: "打开会话列表" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole("button", { name: "删除会话" })).toBeVisible();
  await expect(page.getByPlaceholder("输入问题，按回车发送，按住 Shift 再回车换行…")).toBeVisible();
  await page.mouse.click(380, 220);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/assistant-mobile-390.png", fullPage: false });
});
