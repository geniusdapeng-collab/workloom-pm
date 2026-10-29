import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, type CompletionResult, type FunctionToolCall } from "./providers.js";
import { createDeepSeekTools, runToolConversation, validatePublicFetchUrl, type ConversationTool } from "./deepseek-tools.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const signal = () => new AbortController().signal;
const call = (id = "a", name = "read", args = '{"path":"file.txt"}'): FunctionToolCall => ({ id, type: "function", function: { name, arguments: args } });
const output = (calls: FunctionToolCall[] = [], extra: Record<string, unknown> = {}) => ({
  model: "deepseek-flash-version", choices: [{ message: {
    role: "assistant", content: calls.length ? null : "Delivered with evidence", reasoning_content: "protocol history",
    ...(calls.length ? { tool_calls: calls } : {}),
  }, finish_reason: calls.length ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, ...extra,
});
function fixtureTool(execute: ConversationTool["execute"] = vi.fn(async () => ({ content: "artifact" }))): ConversationTool {
  return { definition: { type: "function", function: { name: "read", description: "Read authorized artifact", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  } } }, execute };
}

describe("bounded real-provider tool conversation", () => {
  it("executes a multi-step tool exchange, retains reasoning, records usage before actions", async () => {
    const order: string[] = [];
    const network = vi.fn<typeof fetch>();
    network.mockResolvedValueOnce(Response.json(output([call()]))).mockResolvedValueOnce(Response.json(output()));
    const execute = vi.fn(async () => { order.push("tool"); return { content: "artifact" }; });
    const messages = [{ role: "user" as const, content: "Read file and report" }];
    const result = await runToolConversation({
      provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", apiKey: "fake-test-only-key", fetch: network }),
      messages, tools: [fixtureTool(execute)], completionOptions: { thinking: "enabled" },
      onStep(_result, iteration) { order.push(`step-${iteration}`); },
      onToolResult({ isError }) { expect(isError).toBe(false); order.push("receipt"); },
    });
    expect(order).toEqual(["step-1", "tool", "receipt", "step-2"]);
    expect(messages).toHaveLength(1);
    expect(result).toMatchObject({ steps: 2, toolCalls: 1, toolErrors: 0, model: "deepseek-flash-version",
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } });
    const second = JSON.parse(String(network.mock.calls[1]![1]!.body));
    expect(second.messages[1]).toMatchObject({ reasoning_content: "protocol history", content: null, tool_calls: [{ id: "a" }] });
    expect(second.messages[2]).toMatchObject({ role: "tool", tool_call_id: "a" });
    expect(JSON.parse(second.messages[2].content)).toEqual({ content: "artifact" });
  });

  it.each(["UNKNOWN_TOOL", "INVALID_TOOL_ARGUMENTS"])("never dispatches %s calls and pairs a failure result", async (error) => {
    const execute = vi.fn(async () => "never");
    const request = vi.fn<typeof fetch>();
    const badCall = error === "UNKNOWN_TOOL" ? call("a", "absent") : call("a", "read", '{"path":7}');
    request.mockResolvedValueOnce(Response.json(output([badCall]))).mockResolvedValueOnce(Response.json(output()));
    const result = await runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [fixtureTool(execute)] });
    expect(execute).not.toHaveBeenCalled(); expect(result.toolErrors).toBe(1);
    const second = JSON.parse(String(request.mock.calls[1]![1]!.body));
    expect(JSON.parse(second.messages[2].content)).toEqual({ error });
  });

  it("does not leak tool exception text and does not retry side effects", async () => {
    const execute = vi.fn(async () => { throw new Error("private-upstream-value"); });
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(Response.json(output([call()]))).mockResolvedValueOnce(Response.json(output()));
    const result = await runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [fixtureTool(execute)] });
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.messages)).not.toContain("private-upstream-value");
    expect(result.toolErrors).toBe(1);
  });

  it.each([{ maxIterations: 1 }, { maxToolCalls: 0 }])("stops before dispatch when the bound is reached %#", async (bounds) => {
    const execute = vi.fn(async () => "never");
    const request = vi.fn(async () => Response.json(output([call()])));
    await expect(runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [fixtureTool(execute)], ...bounds })).rejects.toThrow(/上限/);
    expect(execute).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
  });

  it("stops on usage-ledger rejection before tools can act", async () => {
    const execute = vi.fn(async () => "never");
    const request = vi.fn(async () => Response.json(output([call()])));
    await expect(runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [fixtureTool(execute)], onStep() { throw new Error("ledger rejected"); } })).rejects.toThrow("ledger rejected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not treat truncated model output as completion", async () => {
    const request = vi.fn(async () => Response.json(output([], { choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }] })));
    await expect(runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [] })).rejects.toThrow("模型未完成：length");
  });

  it("cancels a hanging tool without continuing the model conversation", async () => {
    const request = vi.fn(async () => Response.json(output([call()])));
    const execute = vi.fn(() => new Promise<unknown>(() => {}));
    await expect(runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [fixtureTool(execute)], timeoutMs: 10 })).rejects.toThrow(/超时/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects reused call ids across steps instead of repeating the action", async () => {
    const execute = vi.fn(async () => "once");
    const request = vi.fn(async () => Response.json(output([call()])));
    await expect(runToolConversation({ provider: new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request }),
      messages: [{ role: "user", content: "go" }], tools: [fixtureTool(execute)] })).rejects.toThrow(/重复工具/);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("freezes on a custom provider that omits usage", async () => {
    await expect(runToolConversation({ provider: { modelId: "real", async complete() { return { text: "x", message: { role: "assistant", content: "x" }, model: "real", finishReason: "stop", promptTokens: 0, completionTokens: 0 } as CompletionResult; } },
      messages: [{ role: "user", content: "go" }], tools: [] })).rejects.toThrow(/usage/);
  });
});

describe("DeepSeek official search and fetch tools", () => {
  it("uses the exact official search endpoint and masks PII", async () => {
    const request = vi.fn(async () => Response.json({ results: [{ title: "Official", url: "https://example.org/", summary: "contact guest@example.org", content: "source" }] }));
    const [search] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request });
    const result = await search!.execute({ query: "agent runtime", ori_question: "How does the agent runtime work?", count: 3 }, { signal: signal() });
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe("https://api.deepseek.com/v1/tools/search");
    const options = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(options.body))).toEqual({
      query: "agent runtime",
      ori_question: "How does the agent runtime work?",
      count: 3,
      need_content: true,
    });
    expect(options.redirect).toBe("error");
    expect(JSON.stringify(result)).not.toContain("guest@example.org");
    expect(result).toMatchObject({ untrusted_external_content: true, results: [{ title: "Official" }] });
  });

  it.each([{ query: "" }, { query: "x".repeat(129) }, { query: "ok", count: 0 }, { query: "ok", count: 1.5 }, { query: "ok", need_content: "true" }, { query: "ok", destination: "https://attacker.example" }])("validates search arguments before the network %#", async (args) => {
    const request = vi.fn(async () => Response.json({ results: [] }));
    const [search] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request });
    await expect(search!.execute(args, { signal: signal() })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("supports the maximum Unicode query length and empty legitimate search results", async () => {
    const request = vi.fn(async () => Response.json({ results: [] }));
    const [search] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request });
    await expect(search!.execute({ query: "😀".repeat(128), count: 50 }, { signal: signal() })).resolves.toMatchObject({ results: [] });
  });

  it("checks public DNS then asks the official API to fetch the page", async () => {
    const request = vi.fn(async () => Response.json({ title: "Doc", content: "# Original source" }));
    const resolveHost = vi.fn(async () => ["93.184.216.34"]);
    const [, fetchPage] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request, resolveHost });
    const result = await fetchPage!.execute({ url: "https://example.org/docs" }, { signal: signal() });
    expect(resolveHost).toHaveBeenCalledWith("example.org");
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(result).toMatchObject({ content: "# Original source", untrusted_external_content: true });
  });

  it.each([
    "http://127.0.0.1/", "http://10.1.1.1/", "http://169.254.169.254/latest/meta-data/", "http://192.168.0.1/",
    "http://172.16.0.1/", "http://100.64.0.1/", "http://2130706433/", "http://0x7f000001/", "http://[::1]/",
    "http://[::ffff:127.0.0.1]/", "https://localhost/", "https://db.internal/", "https://user:fake@example.org/",
    "file:///etc/passwd", "https://example.org:8080/",
  ])("blocks credential/private/non-web targets %s", async (url) => {
    await expect(validatePublicFetchUrl(url, async () => ["93.184.216.34"])).rejects.toThrow();
  });

  it("fails closed on mixed public/private DNS answers and lookup failure", async () => {
    await expect(validatePublicFetchUrl("https://example.org", async () => ["93.184.216.34", "127.0.0.1"])).rejects.toThrow(/内网/);
    await expect(validatePublicFetchUrl("https://example.org", async () => { throw new Error("sensitive resolver info"); })).rejects.toThrow("抓取域名解析失败");
  });

  it("includes DNS resolution in the tool deadline", async () => {
    const request = vi.fn(async () => Response.json({ content: "never" }));
    const [, fetchPage] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request, timeoutMs: 10, resolveHost: () => new Promise(() => {}) });
    await expect(fetchPage!.execute({ url: "https://example.org" }, { signal: signal() })).rejects.toThrow(/超时/);
    expect(request).not.toHaveBeenCalled();
  });

  it("honors tool budget rejection and does not retry HTTP failures", async () => {
    const request = vi.fn(async () => new Response("private upstream text", { status: 429 }));
    const [search] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request, beforeRequest() { throw new Error("budget exhausted"); } });
    await expect(search!.execute({ query: "test" }, { signal: signal() })).rejects.toThrow("budget exhausted");
    expect(request).not.toHaveBeenCalled();
    const [normal] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: request });
    await expect(normal!.execute({ query: "test" }, { signal: signal() })).rejects.toThrow("HTTP 429");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects malformed search data, empty fetched content, and oversized responses", async () => {
    const [search] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: async () => Response.json({ wrong: [] }) });
    await expect(search!.execute({ query: "test" }, { signal: signal() })).rejects.toThrow(/results/);
    const [, fetchPage] = createDeepSeekTools({ apiKey: "fake-test-only-key", resolveHost: async () => ["93.184.216.34"], fetch: async () => Response.json({ content: "" }) });
    await expect(fetchPage!.execute({ url: "https://example.org" }, { signal: signal() })).rejects.toThrow(/正文/);
    const [large] = createDeepSeekTools({ apiKey: "fake-test-only-key", fetch: async () => new Response("x".repeat(2_000_001)) });
    await expect(large!.execute({ query: "test" }, { signal: signal() })).rejects.toThrow(/2MB/);
  });

  it("fails immediately when no runtime secret is configured", () => {
    vi.stubEnv("LLM_API_KEY", ""); vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(() => createDeepSeekTools()).toThrow(/密钥/);
  });
});
