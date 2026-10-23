import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekProvider, MockProvider, OpenAiCompatibleProvider, providerFromEnv } from "./providers.js";

function completion(message: Record<string, unknown> = { role: "assistant", content: "done" }, extra: Record<string, unknown> = {}) {
  return Response.json({ id: "fake-response-1", model: "deepseek-flash-served-version", choices: [{ message, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, ...extra });
}
const makeProvider = (request?: typeof fetch) => new OpenAiCompatibleProvider("deepseek-flash", {
  baseUrl: "https://api.deepseek.com/", apiKey: "fake-test-only-key", fetch: request,
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("DeepSeek provider protocol", () => {
  it("rejects a successful HTTP response without an assistant choice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", apiKey: "fake-test-only-key" });
    await expect(provider.chat([{ role: "user", content: "hello" }])).rejects.toThrow(/协议|响应/);
  });

  it("does not silently choose mock when the default real provider has no key", () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("LLM_BASE_URL", "https://api.deepseek.com");
    expect(() => providerFromEnv()).toThrow(/密钥|KEY/);
  });

  it("uses the official Flash alias by default and honors configured model names", () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek"); vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", ""); vi.stubEnv("DEEPSEEK_MODEL", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-test-only-key");
    expect(createDeepSeekProvider().modelId).toBe("deepseek-flash");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-pro");
    expect(createDeepSeekProvider().modelId).toBe("deepseek-v4-pro");
    vi.stubEnv("LLM_MODEL", "explicit-model");
    expect(providerFromEnv().modelId).toBe("explicit-model");
    vi.stubEnv("LLM_PROVIDER", "mock");
    expect(providerFromEnv("demo")).toBeInstanceOf(MockProvider);
  });

  it("sends bounded non-thinking requests and preserves complete assistant/usage/model fields", async () => {
    const request = vi.fn(async () => completion({ role: "assistant", content: null, reasoning_content: "kept for protocol",
      tool_calls: [{ id: "call-a", type: "function", function: { name: "read", arguments: "{}" } }] }, {
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_cache_hit_tokens: 5,
        prompt_cache_miss_tokens: 15, completion_tokens_details: { reasoning_tokens: 4 } },
    }));
    const result = await makeProvider(request).complete([{ role: "user", content: "hello" }]);
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "deepseek-flash", max_tokens: 4096, thinking: { type: "disabled" }, stream: false });
    expect(options.redirect).toBe("error");
    expect(result.message).toMatchObject({ reasoning_content: "kept for protocol", content: null, tool_calls: [{ id: "call-a" }] });
    expect(result).toMatchObject({ responseId: "fake-response-1", model: "deepseek-flash-served-version", promptTokens: 20, completionTokens: 10,
      usage: { prompt_cache_hit_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } } });
  });

  it("preserves reasoning history and masks PII in tool arguments without breaking JSON", async () => {
    const request = vi.fn(async () => completion());
    await makeProvider(request).complete([
      { role: "user", content: "contact guest@example.org" },
      { role: "assistant", content: null, reasoning_content: "previous reasoning", tool_calls: [
        { id: "a", type: "function", function: { name: "read", arguments: '{"email":"guest@example.org"}' } },
      ] },
      { role: "tool", tool_call_id: "a", content: "result" },
    ], { thinking: "enabled", reasoningEffort: "high" });
    const payload = String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(payload).not.toContain("guest@example.org");
    const body = JSON.parse(payload);
    expect(body.messages[1].reasoning_content).toBe("previous reasoning");
    expect(JSON.parse(body.messages[1].tool_calls[0].function.arguments).email).toContain("[PII:EMAIL:");
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(body.temperature).toBeUndefined();
  });

  it("reserves the budget before any network call and propagates budget rejection", async () => {
    const request = vi.fn(async () => completion());
    const beforeRequest = vi.fn(() => { throw new Error("budget exhausted"); });
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { beforeRequest })).rejects.toThrow("budget exhausted");
    expect(beforeRequest).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });

  it("rejects local secret echo before transport", async () => {
    const request = vi.fn(async () => completion());
    await expect(makeProvider(request).complete([{ role: "user", content: "fake-test-only-key" }])).rejects.toThrow(/密钥/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects forced thinking tool choices before transport", async () => {
    const request = vi.fn(async () => completion());
    await expect(makeProvider(request).complete([{ role: "user", content: "go" }], { thinking: "enabled", toolChoice: "required" })).rejects.toThrow(/toolChoice/);
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels before dispatch and bounds a transport that does not settle", async () => {
    const request = vi.fn(() => new Promise<Response>(() => {}));
    const controller = new AbortController(); controller.abort();
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { signal: controller.signal })).rejects.toThrow(/取消/);
    expect(request).not.toHaveBeenCalled();
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { timeoutMs: 10 })).rejects.toThrow(/超时/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the deadline active while reading a response body", async () => {
    const request = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { timeoutMs: 10 })).rejects.toThrow(/超时/);
  });

  it.each([401, 402, 429, 500])("reports HTTP %i without retry or upstream secret leakage", async (status) => {
    const request = vi.fn(async () => new Response("fake-test-only-key must not be echoed", { status }));
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }])).rejects.toThrow(`HTTP ${status}`);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { choices: [] },
    { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] },
    { usage: undefined },
    { usage: { prompt_tokens: -1, completion_tokens: 2 } },
    { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 100 } },
  ])("rejects incomplete/malformed protocol data %#", async (body) => {
    await expect(makeProvider(async () => completion(undefined, body)).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/协议/);
  });

  it("rejects non-JSON responses and hides raw transport errors", async () => {
    await expect(makeProvider(async () => new Response("not json")).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/JSON/);
    await expect(makeProvider(async () => { throw new Error("fake-test-only-key"); }).complete([{ role: "user", content: "hi" }])).rejects.toThrow("模型网络请求失败");
  });

  it("rejects real completion data missing response model or finish state", async () => {
    await expect(makeProvider(async () => completion(undefined, { model: undefined })).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/实际模型/);
    await expect(makeProvider(async () => completion(undefined, { choices: [{ message: { role: "assistant", content: "hi" } }] })).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/终态/);
  });

  it("rejects credential-bearing provider endpoints", () => {
    expect(() => new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://user:fake@example.org" })).toThrow(/凭据/);
  });
});
