import { describe, expect, it, vi } from "vitest";
import { createDeepSeekAssistantModel } from "./model.js";

const testApiKey = ["test", "key", "only", "in", "process"].join("-");

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("DeepSeek assistant stream parser", () => {
  it("streams split SSE chunks and keeps response id plus measured usage", async () => {
    const fakeFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sseResponse([
      "data: {\"id\":\"resp-1\",\"model\":\"DeepSeek-V4.1-Flash-1017\",\"choices\":[{\"delta\":{\"content\":\"你\"},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"resp-1\",\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":null}]}\n",
      "\ndata: {\"id\":\"resp-1\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"total_tokens\":9}}\n\n",
      "data: [DONE]\n\n",
    ]));
    const deltas: string[] = [];
    const client = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      fetch: fakeFetch as typeof fetch,
    });
    const result = await client.stream({
      messages: [{ role: "user", content: "只回答你好" }],
      signal: AbortSignal.timeout(5_000),
      maxTokens: 32,
      onDelta: (delta) => { deltas.push(delta.text); },
    });
    expect(deltas).toEqual(["你", "好"]);
    expect(result).toMatchObject({
      text: "你好",
      model: "DeepSeek-V4.1-Flash-1017",
      responseId: "resp-1",
      finishReason: "stop",
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    });
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(String(init.body)).toContain('"stream":true');
    expect(String(init.body)).toContain('"include_usage":true');
  });

  it("fails closed on upstream authentication and truncated generation", async () => {
    const auth = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      fetch: vi.fn(async () => new Response("denied", { status: 401 })) as typeof fetch,
    });
    await expect(auth.stream({
      messages: [{ role: "user", content: "test" }],
      signal: AbortSignal.timeout(2_000),
      maxTokens: 8,
      onDelta: () => undefined,
    })).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_REJECTED" });

    const truncated = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      fetch: vi.fn(async () => sseResponse([
        "data: {\"id\":\"resp-2\",\"choices\":[{\"delta\":{\"content\":\"部分\"},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
        "data: [DONE]\n\n",
      ])) as typeof fetch,
    });
    await expect(truncated.stream({
      messages: [{ role: "user", content: "test" }],
      signal: AbortSignal.timeout(2_000),
      maxTokens: 8,
      onDelta: () => undefined,
    })).rejects.toMatchObject({ code: "MODEL_INCOMPLETE" });
  });

  it("treats an empty configured base URL as the official default endpoint", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sseResponse([
      "data: {\"id\":\"resp-default\",\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
      "data: [DONE]\n\n",
    ]));
    const client = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      baseUrl: "",
      model: "",
      fetch: request as typeof fetch,
    });
    await client.stream({
      messages: [{ role: "user", content: "test" }],
      signal: AbortSignal.timeout(2_000),
      maxTokens: 8,
      onDelta: () => undefined,
    });
    expect(String(request.mock.calls[0]?.[0])).toBe("https://api.deepseek.com/chat/completions");
  });
});
