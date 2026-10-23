/**
 * Loopback-only, per-physical-request DeepSeek budget boundary for PM evaluation.
 * The upstream API key lives only here. Product and dsh processes receive a
 * separate ephemeral loopback token. No upstream retry or model fallback exists.
 * Text/tools are counted with the pinned official V4.1 recipe before paid I/O.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createBudget } from "./acceptance/lib/live/budget.mjs";
import { normalizeOpenAiUsage } from "./acceptance/lib/live/usage.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = new Map([
  ["/chat/completions", "chat"], ["/v1/chat/completions", "chat"],
  ["/v1/tools/search", "search"], ["/v1/tools/fetch", "fetch"],
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function createOfficialTokenCounter({ python, tokenizerPath, timeoutMs = 10_000 }) {
  if (!text(python) || !text(tokenizerPath)) throw new Error("PM tokenizer Python and asset paths are required");
  const child = spawn(python, [join(ROOT, "pm-token-count.py"), "--tokenizer", resolve(tokenizerPath)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", TOKENIZERS_PARALLELISM: "false", PYTHONUNBUFFERED: "1" },
  });
  let closed = false;
  let started = false;
  let errorText = "";
  let pending = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const timer = setTimeout(() => fail(new Error("Official tokenizer startup timed out")), timeoutMs);
  function fail(error) {
    clearTimeout(timer);
    if (!started) readyReject(error);
    if (pending) clearTimeout(pending.timer);
    pending?.reject(error);
    pending = null;
    closed = true;
    child.kill("SIGTERM");
  }
  child.stderr.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(-1000); });
  child.on("error", () => fail(new Error("Official tokenizer process could not start")));
  child.on("exit", (code) => {
    if (!closed) fail(new Error(`Official tokenizer exited (${code ?? "signal"}); no paid request was authorized`));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try { value = JSON.parse(line); }
    catch { fail(new Error("Official tokenizer returned invalid JSON")); return; }
    if (!started) {
      if (value.ready !== true || value.recipeVersion !== "0.2.0" || !text(value.tokenizerSha256)) {
        fail(new Error("Official tokenizer did not attest its pinned version")); return;
      }
      started = true; clearTimeout(timer); readyResolve(value); return;
    }
    const item = pending; pending = null;
    if (!item) { fail(new Error("Unexpected tokenizer response")); return; }
    clearTimeout(item.timer);
    if (!Number.isSafeInteger(value.promptTokens) || value.promptTokens < 1) {
      item.reject(new Error("Request could not be counted by the pinned official tokenizer")); return;
    }
    item.resolve(value.promptTokens);
  });
  // Tokenizer I/O is serialized, while independent upstream calls may overlap.
  let tail = Promise.resolve();
  const count = (body) => {
    const operation = tail.then(async () => {
      await ready;
      if (closed) throw new Error("Official tokenizer is unavailable");
      return new Promise((yes, no) => {
        pending = { resolve: yes, reject: no, timer: setTimeout(() => fail(new Error("Official tokenizer request timed out")), timeoutMs) };
        child.stdin.write(`${JSON.stringify(body)}\n`, (error) => { if (error) fail(new Error("Official tokenizer input failed")); });
      });
    });
    tail = operation.catch(() => undefined);
    return operation;
  };
  return { count, ready, close: () => {
    closed = true; clearTimeout(timer);
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Official tokenizer closed")); pending = null; }
    child.stdin.end(); child.kill("SIGTERM");
  }, diagnostics: () => ({ closed, started, stderrPresent: Boolean(errorText) }) };
}

function validateChat(body) {
  if (!object(body) || body.model !== "deepseek-flash") throw new Error("Only the declared deepseek-flash model is permitted");
  if (body.stream === true) throw new Error("The paid boundary requires complete non-streaming usage; dsh streaming is adapted locally");
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64) throw new Error("Invalid message count");
  if (body.messages.some((message) => !object(message) || !["system", "developer", "user", "assistant", "tool"].includes(message.role)
    || (message.content !== null && typeof message.content !== "string"))) throw new Error("Only bounded text and function-tool messages are permitted");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 16
    || body.tools.some((tool) => tool?.type !== "function"))) throw new Error("Only local function tools are permitted");
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192) throw new Error("An explicit output token limit in 1..8192 is required");
  if (body.n !== undefined && body.n !== 1) throw new Error("Only one completion is permitted");
  if (body.response_format !== undefined && !["text", "json_object"].includes(body.response_format?.type)) throw new Error("Unsupported response format");
  return body;
}

function validateSearch(kind, body) {
  if (!object(body)) throw new Error("Invalid tool request");
  if (kind === "search") {
    if (!text(body.query) || [...body.query].length > 128 || (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 10))) throw new Error("Invalid search query or result count");
  } else {
    const url = new URL(body.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new Error("Invalid fetch URL");
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) throw new Error("Fetch requires a public DNS name");
  }
}

function sameToken(left, right) {
  const a = Buffer.from(left ?? ""); const b = Buffer.from(right ?? "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 192_000) throw new Error("Request body exceeds 192000 bytes");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function createPmBudgetProxy({ apiKey, controlToken, tokenCounter, outDir, port = 0, runId = randomUUID(),
  budgets = {}, upstreamFetch = fetch, upstreamOrigin = "https://api.deepseek.com", protocolMarginTokens = 1024 } = {}) {
  if (!text(apiKey) || !text(controlToken) || controlToken === apiKey) throw new Error("Separate upstream and loopback credentials are required");
  if (!tokenCounter || typeof tokenCounter.count !== "function") throw new Error("A trusted official token counter is required before paid I/O");
  if (!text(outDir)) throw new Error("A dedicated evidence directory is required");
  if (!Number.isSafeInteger(protocolMarginTokens) || protocolMarginTokens < 1024) throw new Error("Protocol token reserve cannot be reduced below 1024");
  const origin = new URL(upstreamOrigin);
  if (origin.href !== "https://api.deepseek.com/") throw new Error("The upstream credential may only be sent to the official DeepSeek origin");
  mkdirSync(outDir, { recursive: true });
  const budget = createBudget({ budgets: { ...budgets, pricing: { llmCnyPer1kTokens: 0.02, imageCny: 0.35, videoCnyPerSecond: 1.2 } },
    outDir, environmentKind: "client-runtime", runId });
  const evidencePath = join(outDir, "requests.jsonl");
  const requests = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const existing = budget.summary();
  const knownIds = new Set(existing.reservations.map((row) => row.taskId));
  const requestIds = new Set();
  for (const row of requests) {
    if (!row || !knownIds.has(row.id) || requestIds.has(row.id) || !["chat", "search", "fetch"].includes(row.kind)) {
      throw new Error("Existing request evidence does not match the immutable budget run; paid I/O denied");
    }
    requestIds.add(row.id);
  }
  // A process restart cannot establish whether an unsettled request reached the
  // provider. Preserve its reservation and freeze instead of resetting a budget.
  for (const reservation of existing.reservations.filter((row) => row.status === "pending")) {
    budget.freeze({ taskId: reservation.taskId, reason: "Process restarted with an unsettled physical request; outcome unknown" });
  }
  let searchRequests = requests.filter((row) => row.kind !== "chat").length;
  let closed = false;
  const active = new Set();
  const safe = (value) => JSON.parse(JSON.stringify(value).replaceAll(apiKey, "[REDACTED]").replaceAll(controlToken, "[REDACTED]"));
  const record = (row) => { const sanitized = safe(row); requests.push(sanitized); appendFileSync(evidencePath, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 }); };
  const summary = () => ({ runId, budget: budget.summary(), physicalRequests: requests.length,
    modelRequests: requests.filter((item) => item.kind === "chat").length,
    searchRequests: requests.filter((item) => item.kind !== "chat").length,
    actualModelTokens: requests.reduce((sum, item) => sum + (item.kind === "chat" ? item.usage?.totalTokens ?? 0 : 0), 0),
    accounting: "All paid HTTP calls occupy one conservative request slot. Search/Fetch reserve 1000 token-equivalents, disclosed separately from actual model tokens. Estimated CNY is a conservative budget rate, not an invoice.",
    requests });
  const send = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(safe(value)));
  };
  const server = createServer(async (request, response) => {
    let reservationId; let kind; let taskId; let forwarded = false;
    try {
      if (closed) return send(response, 503, { error: { message: "Budget proxy is closing" } });
      if (!sameToken(request.headers.authorization?.replace(/^Bearer /, ""), controlToken)) return send(response, 401, { error: { message: "Loopback authorization required" } });
      if (request.method === "GET" && request.url === "/pm-budget/status") return send(response, 200, summary());
      if (request.method === "GET" && ["/models", "/v1/models"].includes(request.url)) return send(response, 200, { object: "list", data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }] });
      kind = PATHS.get(request.url);
      if (request.method !== "POST" || !kind) return send(response, 404, { error: { message: "Endpoint is outside the evaluation boundary" } });
      if (!(request.headers["content-type"] ?? "").startsWith("application/json")) return send(response, 415, { error: { message: "JSON is required" } });
      const body = await readBody(request);
      const requestJson = JSON.stringify(body);
      if (requestJson.includes(apiKey) || requestJson.includes(controlToken)) throw new Error("A credential appeared in a model or search payload; request rejected");
      let countedPromptTokens = 0;
      let reservedTokens;
      if (kind === "chat") {
        validateChat(body);
        countedPromptTokens = await tokenCounter.count(body);
        reservedTokens = countedPromptTokens + body.max_tokens + protocolMarginTokens;
      } else {
        validateSearch(kind, body);
        if (searchRequests >= 8) return send(response, 429, { error: { message: "Search/Fetch request cap reached" } });
        reservedTokens = 1000;
      }
      taskId = `${kind}-${randomUUID()}`;
      reservationId = taskId;
      const permit = budget.reserve({ taskId, reservationId, kind: "llm", tokens: reservedTokens,
        detail: kind === "chat" ? `official-v41 prompt=${countedPromptTokens}; output<=${body.max_tokens}; protocol reserve=${protocolMarginTokens}` : `${kind}: one physical request; 1000 budget token-equivalents, actual model tokens=0` });
      if (!permit.allowed) return send(response, 429, { error: { message: `PM_BUDGET_BLOCKED: ${permit.reason}` } });
      if (kind !== "chat") searchRequests += 1;
      const controller = new AbortController(); active.add(controller);
      const abortTimer = setTimeout(() => controller.abort(), 120_000);
      const startedAt = new Date().toISOString();
      let upstream;
      let payload;
      try {
        forwarded = true;
        upstream = await upstreamFetch(`${origin.origin}${kind === "chat" ? "/chat/completions" : `/v1/tools/${kind}`}`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: requestJson, redirect: "error", signal: controller.signal,
        });
        const responseText = await upstream.text();
        if (responseText.length > 2_000_000) throw new Error("Upstream response exceeded evidence limit");
        try { payload = JSON.parse(responseText); } catch { throw new Error("Upstream returned invalid JSON; usage is unknown"); }
      } finally { clearTimeout(abortTimer); active.delete(controller); }
      const row = { id: taskId, kind, startedAt, finishedAt: new Date().toISOString(), requestSha256: digest(requestJson),
        requestBytes: Buffer.byteLength(requestJson), countedPromptTokens, reservedTokens, httpStatus: upstream.status,
        requestedModel: body.model ?? null, responseModel: payload.model ?? null, responseId: payload.id ?? null };
      if (!upstream.ok) {
        budget.commit({ taskId, reservationId, kind: "llm", tokens: 0, measured: false, status: "failed", detail: `Upstream HTTP ${upstream.status}; no retry; usage unavailable` });
        record({ ...row, error: `HTTP ${upstream.status}`, usage: null });
        return send(response, upstream.status, { error: { message: `DeepSeek HTTP ${upstream.status}; further paid calls frozen until reconciled` } });
      }
      let usage;
      if (kind === "chat") {
        usage = normalizeOpenAiUsage(payload.usage);
        if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)
          || typeof payload.model !== "string" || !Array.isArray(payload.choices) || payload.choices.length !== 1) {
          budget.commit({ taskId, reservationId, kind: "llm", tokens: 0, measured: false, status: "failed", detail: "Successful HTTP response lacked complete model/usage/choice evidence" });
          record({ ...row, error: "MISSING_USAGE_OR_MODEL", usage: null });
          return send(response, 502, { error: { message: "Complete model usage evidence is missing; paid calls frozen" } });
        }
        if (usage.inputTokens > countedPromptTokens + protocolMarginTokens || usage.outputTokens > body.max_tokens) {
          budget.freeze({ taskId, reason: "Provider usage exceeded the official-tokenizer plus output/protocol reservation" });
        }
      } else {
        // Search/Fetch has no model token generation; successful raw JSON receipt
        // proves a completed physical request. Budget equivalents stay reserved.
        usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      budget.commit({ taskId, reservationId, kind: "llm", tokens: usage.totalTokens, measured: true, status: "ok" });
      const message = kind === "chat" ? payload.choices[0]?.message : undefined;
      record({ ...row, usage, finishReason: payload.choices?.[0]?.finish_reason ?? null,
        ...(message ? { response: { content: message.content ?? null, tool_calls: message.tool_calls ?? [],
          reasoningSha256: typeof message.reasoning_content === "string" ? digest(message.reasoning_content) : null } }
          : { response: payload }) });
      budget.persist();
      send(response, upstream.status, payload);
    } catch (error) {
      if (reservationId) {
        budget.commit({ taskId, reservationId, kind: "llm", tokens: 0, measured: !forwarded, status: "failed",
          detail: forwarded ? "Request may have reached the provider; actual usage unknown" : "No upstream request was sent" });
        record({ id: taskId, kind, finishedAt: new Date().toISOString(), httpStatus: null, usage: null,
          error: forwarded ? "UPSTREAM_OUTCOME_UNKNOWN" : "LOCAL_REQUEST_REJECTED" });
      }
      send(response, forwarded ? 502 : 400, { error: { message: forwarded
        ? "Upstream outcome is unknown; the request was not retried and further paid calls are frozen"
        : error instanceof Error ? error.message : "Request rejected" } });
    }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(port, "127.0.0.1", yes); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, runId, budget, summary,
    async close() {
      closed = true; for (const controller of active) controller.abort();
      await new Promise((done) => { server.close(done); server.closeAllConnections?.(); });
      const final = summary(); budget.persist();
      writeFileSync(join(outDir, "proxy-summary.json"), JSON.stringify(final, null, 2), { mode: 0o600 });
      return final;
    },
  };
}
