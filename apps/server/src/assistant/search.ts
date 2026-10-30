import { createDeepSeekTools } from "@workloom/base/model-router";
import { maskDeep } from "@workloom/base/workdata";
import { AssistantModelError } from "./model.js";
import type { AssistantSearchReceipt, AssistantSearchSource } from "./types.js";

const MAX_QUERY_CHARACTERS = 128;
const SEARCH_RESULT_COUNT = 5;

export interface AssistantSearchClient {
  readonly configured: boolean;
  search(input: { question: string; signal: AbortSignal }): Promise<AssistantSearchReceipt>;
}

export interface AssistantSearchOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function compactQuestion(value: string): string {
  const compact = value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(compact).slice(0, MAX_QUERY_CHARACTERS).join("");
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function resultRows(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantModelError("SEARCH_PROTOCOL_ERROR", "DeepSeek 搜索响应格式无效", 502);
  }
  const rows = (value as Record<string, unknown>).results;
  if (!Array.isArray(rows)) {
    throw new AssistantModelError("SEARCH_PROTOCOL_ERROR", "DeepSeek 搜索响应缺少 results", 502);
  }
  return rows;
}

export function normalizeSearchSources(value: unknown): AssistantSearchSource[] {
  const sources = new Map<string, AssistantSearchSource>();
  for (const row of resultRows(value)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const url = safeSourceUrl(entry.url);
    const title = stringValue(entry.title, 1000).trim();
    if (!url || !title || sources.has(url)) continue;
    sources.set(url, {
      title,
      url,
      snippet: stringValue(entry.snippet, 2_000),
      summary: stringValue(entry.summary, 12_000),
      siteName: stringValue(entry.site_name, 300) || null,
      publishedAt: stringValue(entry.date, 80) || null,
      authority: Number.isInteger(entry.authority) ? Number(entry.authority) : -1,
      rerankScore: typeof entry.rerank_score === "number" && Number.isFinite(entry.rerank_score)
        ? entry.rerank_score
        : null,
    });
    if (sources.size >= SEARCH_RESULT_COUNT) break;
  }
  return [...sources.values()];
}

export function createDeepSeekAssistantSearch(options: AssistantSearchOptions = {}): AssistantSearchClient {
  const apiKey = (options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "").trim();
  const now = options.now ?? (() => new Date());
  let searchTool: ReturnType<typeof createDeepSeekTools>[number] | null = null;
  if (apiKey) {
    searchTool = createDeepSeekTools({
      apiKey,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs ?? 60_000,
    })[0] ?? null;
  }
  return {
    configured: Boolean(searchTool),
    async search({ question, signal }) {
      if (!searchTool) {
        throw new AssistantModelError("SEARCH_NOT_CONFIGURED", "服务端尚未配置 DeepSeek 搜索凭据", 503);
      }
      const masked = maskDeep({ question }).value.question;
      const query = compactQuestion(masked);
      if (!query) throw new AssistantModelError("SEARCH_QUERY_EMPTY", "无法从当前问题生成搜索词", 400);
      let raw: unknown;
      try {
        raw = await searchTool.execute({
          query,
          ori_question: query,
          count: SEARCH_RESULT_COUNT,
          need_content: false,
        }, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : "DeepSeek 搜索请求失败";
        throw new AssistantModelError("SEARCH_FAILED", message.slice(0, 500), 502);
      }
      return {
        query,
        searchedAt: now().toISOString(),
        results: normalizeSearchSources(raw),
      };
    },
  };
}
