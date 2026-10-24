#!/usr/bin/env node
/** MCP stdio is newline-delimited JSON-RPC only; never write diagnostics to stdout. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, MAX_INPUT_BYTES, PmClient, errorPayload } from "./pm-agent-client.mjs";

const VERSION = "2025-11-25";
const VERSIONS = new Set([VERSION]);
const FRAME_LIMIT = MAX_INPUT_BYTES + 16 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = value => typeof value === "string" || Number.isSafeInteger(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

export const MCP_TOOLS = Object.entries(COMMANDS).map(([command, descriptor]) => ({
  name: "workloom_pm_" + command, title: descriptor.title,
  description: descriptor.title + ". Uses the existing PM REST membership, fence, budget and receipt paths. "
    + (command === "resume" ? "Only use for an explicitly authorized retry; it may make new paid model requests. " : "")
    + (["deliver", "wait"].includes(command) ? "Completion here verifies state, original hashes, usage and server source receipts; semantic review remains required. " : "")
    + "No model key, tenant override, shell or arbitrary API route is accepted.",
  inputSchema: descriptor.schema,
  annotations: { readOnlyHint: descriptor.readOnly === true, destructiveHint: descriptor.destructive === true,
    idempotentHint: descriptor.readOnly === true || descriptor.idempotent === true, openWorldHint: true },
}));
const commands = new Map(Object.keys(COMMANDS).map(command => ["workloom_pm_" + command, command]));

export async function runPmMcp({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  let phase = "new", buffer = Buffer.alloc(0), stopping = false;
  const active = new Map(), pending = new Set();
  const send = message => output.write(JSON.stringify(message) + "\n");
  const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const stop = () => { stopping = true; for (const controller of active.values()) controller.abort(); input.destroy(); };
  const handle = async request => {
    if (!fields(request, ["jsonrpc", "id", "method", "params"]) || request.jsonrpc !== "2.0"
      || typeof request.method !== "string" || !request.method || request.method.length > 150
      || (Object.hasOwn(request, "id") && !safeId(request.id)) || (request.params !== undefined && !object(request.params))) {
      failure(null, -32600, "Invalid JSON-RPC request"); return;
    }
    const { id, method, params = {} } = request;
    if (id === undefined) {
      if (method === "notifications/initialized" && phase === "initializing" && fields(params, ["_meta"])) phase = "ready";
      else if (method === "notifications/cancelled" && fields(params, ["requestId", "reason", "_meta"]) && safeId(params.requestId)) active.get(params.requestId)?.abort();
      return; // Notifications never dispatch a paid tool call or receive a reply.
    }
    if (active.has(id)) { failure(id, -32600, "Request ID is already in flight"); return; }
    if (method === "ping") { reply(id, {}); return; }
    if (method === "initialize") {
      if (phase !== "new" || !fields(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"])
        || typeof params.protocolVersion !== "string" || !object(params.capabilities) || !object(params.clientInfo)
        || typeof params.clientInfo.name !== "string" || !params.clientInfo.name || typeof params.clientInfo.version !== "string" || !params.clientInfo.version) {
        failure(id, -32602, "Invalid or repeated MCP initialization"); return;
      }
      phase = "initializing";
      reply(id, { protocolVersion: VERSIONS.has(params.protocolVersion) ? params.protocolVersion : VERSION,
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "workloom-pm-agent", version: "1.0.0" },
        instructions: "PM sandbox artifact execution only. Resume is explicit and potentially billable. Machine receipts do not replace semantic review." });
      return;
    }
    if (phase !== "ready") { failure(id, -32002, "Complete MCP initialization before using tools"); return; }
    if (method === "tools/list") {
      if (!fields(params, ["cursor", "_meta"]) || params.cursor !== undefined) { failure(id, -32602, "Invalid tools/list parameters or cursor"); return; }
      reply(id, { tools: MCP_TOOLS }); return;
    }
    if (method !== "tools/call") { failure(id, -32601, "Method not found"); return; }
    if (!fields(params, ["name", "arguments", "_meta"]) || typeof params.name !== "string"
      || !commands.has(params.name) || (params.arguments !== undefined && !object(params.arguments))) {
      failure(id, -32602, "Unknown tool or malformed tools/call parameters"); return;
    }
    if (active.size >= 8) { failure(id, -32000, "PM adapter has reached its bounded in-flight request limit"); return; }
    const controller = new AbortController(); active.set(id, controller);
    try {
      const result = await new PmClient({ env }).invoke(commands.get(params.name), params.arguments ?? {}, { signal: controller.signal });
      const toolResult = { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
      toolResult.structuredContent = result;
      reply(id, toolResult);
    } catch (error) {
      reply(id, { content: [{ type: "text", text: JSON.stringify(errorPayload(error)) }], isError: true });
    } finally { active.delete(id); }
  };
  const consume = line => {
    if (!line.length) return;
    if (line.length > FRAME_LIMIT) { failure(null, -32700, "MCP input frame exceeds its byte limit"); return; }
    let request;
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { failure(null, -32700, "Invalid UTF-8 or JSON-RPC frame"); return; }
    const task = handle(request).catch(() => failure(safeId(request?.id) ? request.id : null, -32603, "PM MCP request failed"));
    pending.add(task); void task.then(() => pending.delete(task));
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        consume(buffer.subarray(0, newline)); buffer = buffer.subarray(newline + 1);
      }
      if (buffer.length > FRAME_LIMIT) { failure(null, -32700, "MCP input frame exceeds its byte limit"); stop(); break; }
    }
  } catch {
    if (!stopping) failure(null, -32603, "MCP input stream failed");
  } finally {
    if (buffer.length && !stopping) failure(null, -32700, "Incomplete JSON-RPC frame at end of input");
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled([...pending]);
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPmMcp(); }
  catch { process.stderr.write("PM MCP transport failed\n"); process.exitCode = 1; }
}
