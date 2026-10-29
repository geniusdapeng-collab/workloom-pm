import { describe, expect, it, vi } from "vitest";
import { createDeepSeekAssistantSearch, normalizeSearchSources } from "./search.js";

const apiKey = ["test", "search", "key", "only", "in", "process"].join("-");
const signal = () => AbortSignal.timeout(5_000);

describe("DeepSeek assistant web search", () => {
  it("uses the official Search endpoint with ori_question and bounded result fields", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      results: [{
        title: "DeepSeek Search API",
        url: "https://api-docs.deepseek.com/guides/search",
        snippet: "Search guide",
        summary: "Official guide for Search and Fetch.",
        site_name: "DeepSeek API Docs",
        date: "2026-10-17T00:00:00+00:00",
        authority: 4,
        rerank_score: 2.8,
      }],
    }));
    const client = createDeepSeekAssistantSearch({
      apiKey,
      fetch: request as typeof fetch,
      now: () => new Date("2026-10-30T01:20:00.000Z"),
    });
    const receipt = await client.search({
      question: "请查 DeepSeek Search API 最新计费口径\n并列出官方链接",
      signal: signal(),
    });
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]![0])).toBe("https://api.deepseek.com/v1/tools/search");
    const init = request.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      ori_question: "请查 DeepSeek Search API 最新计费口径 并列出官方链接",
      count: 5,
      need_content: false,
    });
    expect(receipt).toMatchObject({
      query: "请查 DeepSeek Search API 最新计费口径 并列出官方链接",
      searchedAt: "2026-10-30T01:20:00.000Z",
      results: [{
        title: "DeepSeek Search API",
        url: "https://api-docs.deepseek.com/guides/search",
        siteName: "DeepSeek API Docs",
        authority: 4,
      }],
    });
  });

  it("drops unsafe or duplicate URLs and caps the result list", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      title: `Result ${index}`,
      url: index === 1 ? "javascript:alert(1)" : `https://example.org/${index}`,
      summary: `Summary ${index}`,
    }));
    rows.push({ title: "Duplicate", url: "https://example.org/0", summary: "duplicate" });
    expect(normalizeSearchSources({ results: rows })).toHaveLength(5);
    expect(normalizeSearchSources({ results: rows })[0]).toMatchObject({ url: "https://example.org/0" });
  });

  it("keeps an empty successful search explicit and fails closed on malformed responses", async () => {
    const empty = createDeepSeekAssistantSearch({
      apiKey,
      fetch: vi.fn(async () => Response.json({ results: [] })) as typeof fetch,
    });
    await expect(empty.search({ question: "nothing", signal: signal() }))
      .resolves.toMatchObject({ results: [] });

    const malformed = createDeepSeekAssistantSearch({
      apiKey,
      fetch: vi.fn(async () => Response.json({ wrong: [] })) as typeof fetch,
    });
    await expect(malformed.search({ question: "broken", signal: signal() }))
      .rejects.toMatchObject({ code: "SEARCH_FAILED" });
  });

  it("is explicitly unavailable without a DeepSeek credential", async () => {
    const client = createDeepSeekAssistantSearch({ apiKey: "" });
    expect(client.configured).toBe(false);
    await expect(client.search({ question: "test", signal: signal() }))
      .rejects.toMatchObject({ code: "SEARCH_NOT_CONFIGURED" });
  });
});
