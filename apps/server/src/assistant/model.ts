import { assertNoSecrets } from "../industry/ai-pm/contract.js";
import type { AssistantUsage } from "./types.js";

export interface AssistantModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AssistantModelDelta {
  text: string;
  responseId?: string;
  usage?: AssistantUsage;
  finishReason?: string;
}

export interface AssistantModelResult {
  text: string;
  model: string;
  responseId?: string;
  usage?: AssistantUsage;
  finishReason?: string;
}

export class AssistantModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 502,
    public readonly usage?: AssistantUsage,
    public readonly responseId?: string,
  ) {
    super(message);
    this.name = "AssistantModelError";
  }
}

export interface AssistantModelClient {
  readonly model: string;
  stream(input: {
    messages: AssistantModelMessage[];
    signal: AbortSignal;
    maxTokens: number;
    onDelta: (delta: AssistantModelDelta) => Promise<void> | void;
  }): Promise<AssistantModelResult>;
}

function normalizeUsage(value: unknown): AssistantUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const prompt = source.prompt_tokens ?? source.input_tokens;
  const completion = source.completion_tokens ?? source.output_tokens;
  const total = source.total_tokens;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion)
    || (prompt as number) < 0 || (completion as number) < 0) return undefined;
  const computedTotal = Number(prompt) + Number(completion);
  if (total !== undefined && (!Number.isSafeInteger(total) || Number(total) !== computedTotal)) return undefined;
  return {
    promptTokens: Number(prompt),
    completionTokens: Number(completion),
    totalTokens: computedTotal,
  };
}

function safeErrorMessage(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, "[REDACTED]").slice(0, 1000);
}

export function createDeepSeekAssistantModel(options: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
} = {}): AssistantModelClient {
  const apiKey = (options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "").trim();
  const configuredBaseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? "").trim();
  const baseUrl = (configuredBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const configuredModel = (options.model ?? process.env.LLM_MODEL ?? "").trim();
  const model = configuredModel || "deepseek-flash";
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!/^https:\/\//.test(baseUrl)) throw new AssistantModelError("MODEL_CONFIG_INVALID", "模型地址必须是 HTTPS", 503);
  if (!model.trim() || model.length > 120) throw new AssistantModelError("MODEL_CONFIG_INVALID", "模型标识无效", 503);

  return {
    model,
    async stream(input): Promise<AssistantModelResult> {
      if (!apiKey) throw new AssistantModelError("MODEL_NOT_CONFIGURED", "服务端尚未配置 DeepSeek 凭据", 503);
      if (!input.messages.length || input.messages.length > 64) {
        throw new AssistantModelError("MODEL_INPUT_INVALID", "模型消息数量无效", 400);
      }
      if (input.messages.some((message) => !message.content.trim() || message.content.length > 32_000)) {
        throw new AssistantModelError("MODEL_INPUT_INVALID", "模型消息为空或超过单条长度上限", 400);
      }
      assertNoSecrets(input.messages);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([input.signal, timeout]);
      let response: Response;
      try {
        response = await request(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: input.messages,
            stream: true,
            stream_options: { include_usage: true },
            thinking: { type: "disabled" },
            max_tokens: Math.max(1, Math.min(input.maxTokens, 8192)),
            temperature: 0.2,
          }),
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new AssistantModelError(
            input.signal.aborted ? "MODEL_CANCELLED" : "MODEL_TIMEOUT",
            input.signal.aborted ? "用户已停止生成" : "模型响应超时",
            input.signal.aborted ? 409 : 504,
          );
        }
        throw new AssistantModelError("MODEL_NETWORK_ERROR", safeErrorMessage(
          error instanceof Error ? error.message : String(error), apiKey,
        ));
      }
      if (!response.ok) {
        const upstream = safeErrorMessage(await response.text().catch(() => ""), apiKey);
        const message = `DeepSeek HTTP ${response.status}${upstream ? `: ${upstream.slice(0, 300)}` : ""}`;
        throw new AssistantModelError(
          response.status === 401 || response.status === 403 ? "MODEL_CREDENTIAL_REJECTED"
            : response.status === 402 || response.status === 429 ? "MODEL_BUDGET_EXHAUSTED"
              : "MODEL_REQUEST_FAILED",
          message,
          response.status === 401 || response.status === 403 ? 503 : response.status === 402 || response.status === 429 ? 429 : 502,
        );
      }
      if (!response.body) throw new AssistantModelError("MODEL_PROTOCOL_ERROR", "模型响应缺少流式正文");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let responseId: string | undefined;
      let responseModel: string | undefined;
      let usage: AssistantUsage | undefined;
      let finishReason: string | undefined;
      let done = false;
      try {
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            if (data === "[DONE]") {
              done = true;
              break;
            }
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(data) as Record<string, unknown>;
            } catch {
              throw new AssistantModelError("MODEL_PROTOCOL_ERROR", "DeepSeek 返回了无法解析的流式事件");
            }
            if (typeof payload.id === "string") responseId = payload.id;
            if (typeof payload.model === "string" && payload.model.length <= 150) responseModel = payload.model;
            const parsedUsage = normalizeUsage(payload.usage);
            if (parsedUsage) usage = parsedUsage;
            const choices = Array.isArray(payload.choices) ? payload.choices : [];
            const choice = choices[0] as Record<string, unknown> | undefined;
            if (!choice) continue;
            if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
            const delta = choice.delta as Record<string, unknown> | undefined;
            const piece = typeof delta?.content === "string" ? delta.content : "";
            if (piece) {
              text += piece;
              await input.onDelta({ text: piece, ...(responseId ? { responseId } : {}), ...(usage ? { usage } : {}) });
            }
          }
        }
        if (buffer.trim()) {
          for (const line of buffer.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const payload = JSON.parse(data) as Record<string, unknown>;
              if (typeof payload.id === "string") responseId = payload.id;
              if (typeof payload.model === "string" && payload.model.length <= 150) responseModel = payload.model;
              const parsedUsage = normalizeUsage(payload.usage);
              if (parsedUsage) usage = parsedUsage;
              const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined;
              if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
              const delta = choice?.delta as Record<string, unknown> | undefined;
              const piece = typeof delta?.content === "string" ? delta.content : "";
              if (piece) {
                text += piece;
                await input.onDelta({ text: piece, ...(responseId ? { responseId } : {}), ...(usage ? { usage } : {}) });
              }
            } catch {
              throw new AssistantModelError("MODEL_PROTOCOL_ERROR", "DeepSeek 返回了无法解析的尾部事件");
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      if (!text.trim()) throw new AssistantModelError("MODEL_EMPTY_RESPONSE", "模型返回空正文，未标记完成", 502, usage, responseId);
      if (finishReason && finishReason !== "stop") {
        throw new AssistantModelError("MODEL_INCOMPLETE", `模型未自然结束（${finishReason}），未标记完成`, 502, usage, responseId);
      }
      return {
        text,
        model: responseModel ?? model,
        ...(responseId ? { responseId } : {}),
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason } : {}),
      };
    },
  };
}
