import { expect, type Page } from "@playwright/test";

/** Only the static component screenshot uses synthetic operational data.
 * The remaining browser cases continue to consume the real local API.
 */
export async function installStaticComponentFixture(page: Page) {
  const unexpected: string[] = [];
  const served = new Set<string>();
  const fixtureToken = "static-ui-fixture-not-a-token";
  const data: Record<string, unknown> = {
    "accounts.auth.guestEnter": { token: fixtureToken },
    "access.me": {
      subject: { kind: "guest", id: "static-component-guest", memberNo: "GUEST", name: "静态组件示例", role: "readonly" },
      scope: { tenantId: "static-component-tenant", workspaceId: "static-component-workspace" },
      plan: "pro", capabilities: {}, partnerCapabilities: [], availableScopes: [],
      authority: { source: "server", evaluatedAt: "2026-10-24T00:00:00.000Z", grantIds: [] },
      navigationPermissions: [], actionPermissions: [],
      bundle: { configured: false, reason: "Synthetic static component fixture; no business authorization" },
    },
    "onboarding.status": {
      dataMode: "simulated", persistedDataMode: "simulated", formalActivationRecorded: false,
      llm: { provider: "mock", model: "static-fixture", baseUrl: "", real: false },
      workspace: { name: "织元产品部（AI 产品经理示例团队）", events: 0, members: 0, agents: 0, memories: 0 },
      bundle: { id: "ai-pm", isExample: true },
    },
    "skills.skillOps.status": { recentLoaded: [], pendingCount: 0 },
    "nightShift.current": { configured: false, run: null },
  };
  // The fixture never forwards credentials or unknown API calls. Asset requests
  // may continue only without the synthetic Bearer; the other clients use their
  // own origins and retain their existing real-API test behavior.
  await page.route("http://127.0.0.1:3100/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    // VoiceEngine performs one anonymous capability probe when its module is
    // initialized. This is a known read-only fixture, with synthesis disabled.
    if (url.pathname === "/api/voice/status" && method === "GET" && !route.request().headers().authorization) {
      served.add("voice-status");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, configured: false }) });
      return;
    }
    if (!url.pathname.startsWith("/trpc/")) {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/trpc"
        || route.request().headers().authorization === `Bearer ${fixtureToken}`) {
        unexpected.push(`${method} ${url.pathname}`);
        await route.abort("blockedbyclient");
      } else await route.continue();
      return;
    }
    let names: string[];
    try { names = decodeURIComponent(url.pathname.slice("/trpc/".length)).split(","); }
    catch {
      unexpected.push("Malformed tRPC path");
      await route.abort("blockedbyclient");
      return;
    }
    const unknown = names.filter((name) => !Object.hasOwn(data, name)
      || method !== (name === "accounts.auth.guestEnter" ? "POST" : "GET"));
    if (unknown.length > 0) {
      unexpected.push(...unknown);
      await route.abort("blockedbyclient");
      return;
    }
    names.forEach((name) => served.add(name));
    const replies = names.map((name) => ({ result: { data: data[name] } }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(url.searchParams.get("batch") === "1" ? replies : replies[0]) });
  });
  return {
    async ready() {
      await expect.poll(() => ["access.me", "onboarding.status", "skills.skillOps.status"].every((name) => served.has(name))).toBe(true);
      await expect(page.getByText("行业示例版", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "专业版", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "夜班 · 未配置", exact: true })).toBeVisible();
      expect(unexpected, "Static component fixture must reject every unexpected API operation").toEqual([]);
    },
    assertNoUnexpectedCalls() {
      expect(unexpected, "Static component screenshot cannot silently access live API operations").toEqual([]);
    },
  };
}
