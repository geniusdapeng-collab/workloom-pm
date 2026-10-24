/** PM-only REST transport. Backend membership, fences, budgets and state remain authoritative. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export const RESULT_SCHEMA = "workloom.pm-agent-result/v1";
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const EMPLOYEE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[0-9a-f]{64}$/;
const RUN_STATES = new Set(["created", "planning", "running", "paused", "blocked", "failed", "completed", "cancelled"]);
const ACTIVE_STATES = new Set(["created", "planning", "running"]);
const TASK_STATES = new Set(["pending", "running", "paused", "blocked", "failed", "completed", "cancelled"]);
const SECRET_SHAPE = /(?:(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,})/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 200) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => createHash("sha256").update(value).digest("hex");

export class PmClientError extends Error {
  constructor(code, message, exitCode = 7, details) {
    super(message);
    this.name = "PmClientError";
    this.code = code;
    this.exitCode = exitCode;
    if (details) this.details = details;
  }
}
const requireFact = (condition, code, message, exit = 7, details) => {
  if (!condition) throw new PmClientError(code, message, exit, details);
};
const protocol = (condition, message = "PM response violates the published contract") => requireFact(condition, "INVALID_RESPONSE", message);

export function errorPayload(error) {
  const known = error instanceof PmClientError;
  return { schemaVersion: "workloom.pm-agent-error/v1", error: {
    code: known ? error.code : "INTERNAL_ERROR",
    message: known ? error.message : "PM adapter failed; no delivery claim was made",
    ...(known && error.details ? { details: error.details } : {}),
  } };
}

export function safeArtifactPath(path) {
  requireFact(typeof path === "string" && path.length > 0 && path.length <= 220 && path === path.normalize("NFC")
    && !/[\\\u0000-\u001f\u007f:%]/u.test(path) && !path.startsWith("/") && !path.endsWith("/"),
  "INVALID_INPUT", "Artifact path must be a safe portable relative path", 2);
  requireFact(path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith(".")
    && part.trim() === part && !/[. ]$/u.test(part) && /^[\p{L}\p{N}_][\p{L}\p{N}_. -]*$/u.test(part)
    && !/^(?:node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
  "INVALID_INPUT", "Artifact path contains a forbidden segment", 2);
  return path;
}

const pathSchema = { type: "string", minLength: 1, maxLength: 220, format: "pm-artifact" };
const runSchema = { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" };
const checkSchema = { oneOf: [
  { type: "object", properties: { type: { const: "fileExists" }, path: pathSchema }, required: ["type", "path"], additionalProperties: false },
  { type: "object", properties: { type: { const: "fileContains" }, path: pathSchema, text: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["type", "path", "text"], additionalProperties: false },
  { type: "object", properties: { type: { const: "json" }, path: pathSchema, requiredKeys: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" } } }, required: ["type", "path"], additionalProperties: false },
] };
const createProperties = {
  goal: { type: "string", minLength: 4, maxLength: 32000 },
  idempotencyKey: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9_.:-]+$" },
  employee: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9][a-z0-9-]*$" },
  checks: { type: "array", maxItems: 30, items: checkSchema },
};
const timingProperties = { timeoutMs: { type: "integer", minimum: 100, maximum: 1800000 }, pollIntervalMs: { type: "integer", minimum: 100, maximum: 10000 } };
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const COMMANDS = Object.freeze({
  status: { title: "PM configuration and employees", readOnly: true, schema: schema() },
  list: { title: "List PM runs", readOnly: true, schema: schema({ limit: { type: "integer", minimum: 1, maximum: 50 } }) },
  create: { title: "Create an idempotent PM run without starting it", idempotent: true, schema: schema(createProperties, ["goal", "idempotencyKey"]) },
  start: { title: "Start an existing created run", idempotent: true, schema: schema({ runId: runSchema }, ["runId"]) },
  get: { title: "Read a PM run; this alone does not verify delivery", readOnly: true, schema: schema({ runId: runSchema }, ["runId"]) },
  wait: { title: "Wait a bounded time and verify completed delivery receipts", readOnly: true, schema: schema({ runId: runSchema, ...timingProperties }, ["runId"]) },
  artifact: { title: "Read original artifact bytes and verify their recorded hash", readOnly: true, schema: schema({ runId: runSchema, path: pathSchema }, ["runId", "path"]) },
  resume: { title: "Explicitly resume a blocked, failed or paused run; may incur model calls", schema: schema({ runId: runSchema }, ["runId"]) },
  cancel: { title: "Explicitly cancel a PM run", destructive: true, idempotent: true, schema: schema({ runId: runSchema }, ["runId"]) },
  deliver: { title: "Create with a stable caller key, start, wait and verify; never auto-resume", idempotent: true,
    schema: schema({ ...createProperties, ...timingProperties }, ["goal", "idempotencyKey"]) },
});

function conforms(value, definition) {
  if (definition.oneOf) return definition.oneOf.filter(item => conforms(value, item)).length === 1;
  if (Object.hasOwn(definition, "const") && value !== definition.const) return false;
  if (definition.type === "object") {
    if (!object(value) || (definition.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, child]) => Object.hasOwn(definition.properties ?? {}, key)
      ? conforms(child, definition.properties[key]) : definition.additionalProperties !== false);
  }
  if (definition.type === "string") return typeof value === "string" && value.length >= (definition.minLength ?? 0)
    && value.length <= (definition.maxLength ?? Infinity) && (!definition.pattern || new RegExp(definition.pattern, "u").test(value));
  if (definition.type === "integer") return integer(value, definition.minimum ?? Number.MIN_SAFE_INTEGER, definition.maximum ?? Number.MAX_SAFE_INTEGER);
  if (definition.type === "array") return Array.isArray(value) && value.length >= (definition.minItems ?? 0)
    && value.length <= (definition.maxItems ?? Infinity) && value.every(child => conforms(child, definition.items));
  return !definition.type;
}

function assertNoSecrets(value, token) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new PmClientError("INVALID_INPUT", "Input cannot be serialized safely", 2); }
  let forbidden = typeof serialized !== "string" || serialized.includes(token) || serialized.includes(JSON.stringify(token).slice(1, -1)) || SECRET_SHAPE.test(serialized);
  const pending = forbidden ? [] : [JSON.parse(serialized)];
  while (pending.length && !forbidden) {
    const item = pending.pop();
    if (typeof item === "string") forbidden = SECRET_SHAPE.test(item);
    else if (Array.isArray(item)) pending.push(...item);
    else if (object(item)) for (const [key, child] of Object.entries(item)) pending.push(key, child);
  }
  requireFact(!forbidden,
    "SECRET_DETECTED", "Credential-like content is forbidden in PM inputs or returned data", 2);
}

export function validateInput(command, input = {}) {
  const descriptor = COMMANDS[command];
  requireFact(descriptor && Object.hasOwn(COMMANDS, command), "UNKNOWN_COMMAND", "Unknown PM command", 2);
  requireFact(conforms(input, descriptor.schema), "INVALID_INPUT", "PM input has an unknown field, wrong type or out-of-range value", 2);
  const value = { ...input };
  if (Object.hasOwn(value, "goal")) {
    value.goal = value.goal.trim();
    requireFact(value.goal.length >= 4, "INVALID_INPUT", "PM goal must contain at least four non-whitespace characters", 2);
  }
  for (const check of value.checks ?? []) safeArtifactPath(check.path);
  if (value.path !== undefined) safeArtifactPath(value.path);
  requireFact(Buffer.byteLength(JSON.stringify(value)) <= MAX_INPUT_BYTES, "INPUT_TOO_LARGE", "PM input exceeds 256 KiB", 2);
  return value;
}

function validUsage(value, positive = false) {
  return object(value) && integer(value.promptTokens, positive ? 1 : 0) && integer(value.completionTokens, positive ? 1 : 0);
}
function validateRun(run, expectedId) {
  protocol(object(run) && typeof run.id === "string" && RUN_ID.test(run.id) && (!expectedId || run.id === expectedId) && RUN_STATES.has(run.status)
    && text(run.goal, 32000) && text(run.modelId, 150) && text(run.idempotencyKey, 120) && validUsage(run.usage)
    && (run.requestedEmployee === null || typeof run.requestedEmployee === "string" && EMPLOYEE.test(run.requestedEmployee))
    && Array.isArray(run.checks) && run.checks.length <= 30 && run.checks.every(check => conforms(check, checkSchema)));
  for (const check of run.checks) safeArtifactPath(check.path);
  return run;
}
export function validateDetail(detail, expectedId) {
  protocol(object(detail) && Array.isArray(detail.tasks) && detail.tasks.length <= 8
    && Array.isArray(detail.artifacts) && detail.artifacts.length <= 96);
  const run = validateRun(detail.run, expectedId);
  const tasks = new Map(), paths = new Map();
  for (const task of detail.tasks) {
    protocol(object(task) && typeof task.id === "string" && TASK_ID.test(task.id) && !tasks.has(task.id) && task.runId === run.id
      && typeof task.presetKey === "string" && EMPLOYEE.test(task.presetKey)
      && TASK_STATES.has(task.status) && Array.isArray(task.dependsOn) && task.dependsOn.length <= 8
      && new Set(task.dependsOn).size === task.dependsOn.length && Array.isArray(task.outputRefs)
      && task.outputRefs.length > 0 && task.outputRefs.length <= 12);
    tasks.set(task.id, task);
    for (const path of task.outputRefs) {
      safeArtifactPath(path);
      const key = path.toLowerCase();
      protocol(![...paths.keys()].some(prior => prior === key || prior.startsWith(key + "/") || key.startsWith(prior + "/")));
      paths.set(key, task.id);
    }
  }
  const resolved = new Set();
  while (resolved.size < tasks.size) {
    const next = [...tasks.values()].find(task => !resolved.has(task.id) && task.dependsOn.every(id => resolved.has(id)));
    protocol(next, "PM response contains a cyclic or unresolved dependency");
    resolved.add(next.id);
  }
  const artifacts = new Set();
  for (const artifact of detail.artifacts) {
    protocol(object(artifact) && artifact.runId === run.id && tasks.has(artifact.taskId) && text(artifact.id, 100)
      && typeof artifact.sha256 === "string" && HASH.test(artifact.sha256) && integer(artifact.sizeBytes, 1, 256 * 1024)
      && text(artifact.mediaType, 100) && text(artifact.verifiedAt, 100));
    safeArtifactPath(artifact.path);
    protocol(!artifacts.has(artifact.path) && tasks.get(artifact.taskId).outputRefs.includes(artifact.path));
    artifacts.add(artifact.path);
  }
  return detail;
}

function validateBinding(receipt, presetKey) {
  const binding = receipt?.assetBinding;
  protocol(receipt?.assetBindingSource === "verified-catalog" && object(binding)
    && binding.schema === "workloom.pm.asset-binding/v1" && binding.bundleId === "ai-pm" && binding.presetKey === presetKey
    && text(binding.bundleVersion, 80) && ["manifestSha256", "bundleIntegrityDigest", "presetSha256", "skillTextSha256"].every(key => HASH.test(binding[key] ?? ""))
    && Array.isArray(binding.skills) && binding.skills.length > 0 && binding.skills.length <= 50,
  "Completed PM task is missing verified-catalog source receipts");
  const names = new Set();
  for (const skill of binding.skills) {
    protocol(object(skill) && typeof skill.name === "string" && EMPLOYEE.test(skill.name) && !names.has(skill.name)
      && skill.path === `skills/${skill.name}/SKILL.md` && HASH.test(skill.sha256 ?? ""));
    names.add(skill.name);
  }
}

function validateTaskReceipt(task) {
  protocol(task.status === "completed" && validUsage(task.usage, true) && text(task.modelId, 150)
    && text(task.responseId, 200) && integer(task.attempt, 1) && Array.isArray(task.attemptReceipts),
  "Completed PM task is missing final state, response identity or measured usage");
  const receipt = task.adapterReceipt;
  validateBinding(receipt, task.presetKey);
  const attempts = new Set(), usage = { promptTokens: 0, completionTokens: 0 };
  for (const prior of task.attemptReceipts) {
    protocol(object(prior) && integer(prior.attempt, 1, task.attempt) && !attempts.has(prior.attempt)
      && typeof prior.final === "boolean" && validUsage(prior.usage) && prior.usage.promptTokens + prior.usage.completionTokens > 0
      && text(prior.modelId, 150), "PM task attempt usage history is inconsistent");
    attempts.add(prior.attempt); usage.promptTokens += prior.usage.promptTokens; usage.completionTokens += prior.usage.completionTokens;
  }
  protocol(isDeepStrictEqual(usage, task.usage), "PM task usage differs from its measured attempt history");
  const final = task.attemptReceipts.filter(item => item?.attempt === task.attempt && item?.final === true);
  protocol(final.length === 1 && validUsage(final[0].usage, true) && final[0].modelId === task.modelId
    && final[0].responseId === task.responseId && isDeepStrictEqual(final[0].receipt, receipt)
    && task.usage.promptTokens >= final[0].usage.promptTokens && task.usage.completionTokens >= final[0].usage.completionTokens,
  "Completed PM task does not match its final attempt receipt");
  if (task.executionBackend === "deepseek-completion") {
    protocol(receipt.adapter === "deepseek-completion" && receipt.modelRequests === 1 && receipt.finishReason === "stop"
      && receipt.responseId === task.responseId && ["single-file-text", "structured-json"].includes(receipt.transport),
    "Completed PM task lacks a terminal completion receipt");
  } else {
    protocol(task.executionBackend === "deepseek-harness" && receipt.adapter === "deepseek-harness-headless"
      && receipt.final === true && receipt.exitCode === 0 && receipt.turnEnd === "completed" && receipt.usageComplete === true
      && integer(receipt.modelCalls, 1, 100) && Array.isArray(receipt.modelReceipts) && receipt.modelReceipts.length === receipt.modelCalls
      && validUsage(receipt.usage, true) && isDeepStrictEqual(receipt.usage, final[0].usage)
      && Array.isArray(receipt.tools) && isDeepStrictEqual([...receipt.tools].sort(), ["list_files", "read_file", "write_file"]),
    "Completed PM task lacks a final constrained DSH session receipt");
    const total = { promptTokens: 0, completionTokens: 0 };
    for (const model of receipt.modelReceipts) {
      protocol(object(model) && text(model.model, 150) && text(model.responseId, 200) && validUsage(model.usage));
      total.promptTokens += model.usage.promptTokens; total.completionTokens += model.usage.completionTokens;
    }
    protocol(isDeepStrictEqual(total, receipt.usage), "DSH per-request usage differs from its attempt total");
    protocol(receipt.modelReceipts.at(-1).model === task.modelId && receipt.modelReceipts.at(-1).responseId === task.responseId,
      "DSH final model response differs from its task receipt");
  }
}

function terminalFailure(detail) {
  throw new PmClientError("RUN_" + detail.run.status.toUpperCase(), "PM run stopped without a verified completed delivery; no automatic resume was attempted", 8,
    { runId: detail.run.id, status: detail.run.status, usage: detail.run.usage,
      ...(typeof detail.run.errorCode === "string" && /^[A-Z0-9_]{1,100}$/.test(detail.run.errorCode) ? { backendCode: detail.run.errorCode } : {}) });
}

export class PmClient {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, requestTimeoutMs = 30000 } = {}) {
    let url;
    try { url = new URL(env.PM_BASE_URL ?? env.WORKLOOM_BASE_URL); } catch { throw new PmClientError("INVALID_BASE_URL", "Set PM_BASE_URL or WORKLOOM_BASE_URL to the intended PM service origin", 2); }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    requireFact((url.protocol === "https:" || url.protocol === "http:" && loopback) && !url.username && !url.password
      && !url.search && !url.hash && ["", "/"].includes(url.pathname), "INVALID_BASE_URL", "PM service requires HTTPS or loopback HTTP and an origin without credentials, path or query", 2);
    requireFact(typeof env.WORKLOOM_ACCESS_TOKEN === "string" && /^[\x21-\x7e]{8,16384}$/.test(env.WORKLOOM_ACCESS_TOKEN),
      "UNAUTHENTICATED", "Set an explicit WORKLOOM_ACCESS_TOKEN; this adapter never signs in automatically", 3);
    requireFact(integer(requestTimeoutMs, 100, 120000) && typeof fetchImpl === "function", "INVALID_CONFIG", "PM transport configuration is invalid", 2);
    this.base = url.origin; this.token = env.WORKLOOM_ACCESS_TOKEN; this.fetch = fetchImpl; this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(path, { method = "GET", body, signal, deadline, runId, operation } = {}) {
    const remaining = deadline === undefined ? this.requestTimeoutMs : Math.min(this.requestTimeoutMs, deadline - performance.now());
    requireFact(remaining > 0, "WAIT_TIMEOUT", "PM wait deadline expired; the backend run was not automatically cancelled", 9, runId ? { runId } : undefined);
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response, value;
    try {
      response = await this.fetch(this.base + "/api/pm" + path, { method, redirect: "manual", signal: requestSignal,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new PmClientError("REDIRECT_REFUSED", "PM endpoint redirected; credentials were not forwarded", 6);
      }
      protocol(!response.redirected && (!response.url || new URL(response.url).origin === this.base));
      const chunks = [], reader = response.body?.getReader();
      let size = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new PmClientError("RESPONSE_TOO_LARGE", "PM response exceeds the bounded transport size"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new PmClientError("INVALID_RESPONSE", "PM service returned an empty or invalid JSON response"); }
    } catch (error) {
      if (error instanceof PmClientError) throw error;
      if (signal?.aborted) throw new PmClientError("CLIENT_CANCELLED", "PM client request was cancelled; backend task state was not changed", 10, runId ? { runId } : undefined);
      if (timeout.aborted) throw new PmClientError(deadline !== undefined && performance.now() >= deadline ? "WAIT_TIMEOUT" : "HTTP_TIMEOUT",
        "PM request timed out; read the existing run before retrying a mutation", 9, runId ? { runId } : undefined);
      throw new PmClientError(method === "GET" ? "NETWORK_ERROR" : "REQUEST_OUTCOME_UNKNOWN",
        "PM connection failed; do not assume a mutation failed or start another paid attempt", 6,
        { ...(runId ? { runId } : {}), ...(operation ? { operation } : {}) });
    }
    assertNoSecrets(value, this.token);
    if (!response.ok || value?.error) {
      const backendCode = typeof value?.error?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(value.error.code) ? value.error.code : "PM_REMOTE_ERROR";
      throw new PmClientError(backendCode, "PM service rejected the request; existing authorization, fence and budget rules remain in force",
        response.status === 401 ? 3 : response.status === 403 ? 4 : response.status === 409 ? 5 : 7,
        { httpStatus: response.status, ...(runId ? { runId } : {}) });
    }
    return value;
  }

  async detail(runId, context = {}) { return validateDetail(await this.request(`/runs/${runId}`, { ...context, runId }), runId); }

  async artifact(detail, path, context = {}) {
    const metadata = detail.artifacts.find(item => item.path === path);
    requireFact(metadata, "ARTIFACT_NOT_FOUND", "Artifact is absent from the run's immutable receipt", 7, { runId: detail.run.id });
    const value = await this.request(`/runs/${detail.run.id}/artifacts?path=${encodeURIComponent(path)}`, { ...context, runId: detail.run.id });
    protocol(object(value) && value.path === metadata.path && value.taskId === metadata.taskId && value.sha256 === metadata.sha256
      && value.sizeBytes === metadata.sizeBytes && value.mediaType === metadata.mediaType && typeof value.content === "string",
    "Artifact response does not match its run receipt");
    const bytes = Buffer.from(value.content, "utf8");
    requireFact(bytes.length === metadata.sizeBytes && hash(bytes) === metadata.sha256, "ARTIFACT_HASH_MISMATCH",
      "Original artifact bytes differ from the recorded hash or size", 7, { runId: detail.run.id });
    return { ...value, hashVerified: true };
  }

  async completed(detail, context) {
    protocol(detail.run.status === "completed" && detail.tasks.length > 0 && detail.tasks.every(task => task.status === "completed")
      && validUsage(detail.run.usage, true) && object(detail.run.verification) && Array.isArray(detail.run.verification.checks)
      && detail.run.verification.checks.every(check => check?.passed === true) && text(detail.run.verification.verifiedAt, 100),
    "Completed PM run lacks its final verification receipts");
    const planning = detail.run.planningReceipt;
    protocol(object(planning) && text(planning.modelId, 150));
    if (detail.run.requestedEmployee === null) {
      protocol(planning.source === "model" && validUsage(planning, true) && text(planning.responseId, 200));
      validateBinding(planning, "chief-pm");
    } else {
      protocol(planning.source === "explicit-employee" && planning.promptTokens === 0 && planning.completionTokens === 0
        && detail.tasks.length === 1 && detail.tasks[0].presetKey === detail.run.requestedEmployee && detail.tasks[0].goal === detail.run.goal);
    }
    protocol(Array.isArray(detail.run.planningReceipts) && detail.run.planningReceipts.length > 0
      && isDeepStrictEqual(detail.run.planningReceipts.at(-1), planning), "PM planner history does not end at its current receipt");
    const total = { promptTokens: 0, completionTokens: 0 };
    for (const prior of detail.run.planningReceipts) {
      const measured = prior?.final === false ? prior.usage : prior;
      protocol(object(prior) && text(prior.modelId, 150) && validUsage(measured)
        && (prior.final === false || ["model", "explicit-employee"].includes(prior.source)), "PM planner usage history is incomplete");
      total.promptTokens += measured.promptTokens; total.completionTokens += measured.completionTokens;
    }
    for (const task of detail.tasks) {
      validateTaskReceipt(task);
      total.promptTokens += task.usage.promptTokens; total.completionTokens += task.usage.completionTokens;
      protocol(task.outputRefs.every(path => detail.artifacts.some(artifact => artifact.taskId === task.id && artifact.path === path)));
    }
    protocol(isDeepStrictEqual(detail.run.usage, total)
      && detail.run.checks.every(check => detail.artifacts.some(artifact => artifact.path === check.path)),
    "Completed PM run usage or declared artifact inventory is incomplete");
    const verifiedArtifacts = [], contents = new Map();
    for (const metadata of detail.artifacts) {
      const original = await this.artifact(detail, metadata.path, context);
      contents.set(metadata.path, original.content);
      verifiedArtifacts.push({ ...metadata, hashVerified: true });
    }
    for (const check of detail.run.checks) {
      protocol(detail.run.verification.checks.some(result => result.passed === true && isDeepStrictEqual(result.check, check)),
        "PM completion lacks a declared deterministic check receipt");
      const content = contents.get(check.path);
      let passed = typeof content === "string";
      if (passed && check.type === "fileContains") passed = content.includes(check.text);
      if (passed && check.type === "json") {
        let parsed; try { parsed = JSON.parse(content); } catch { passed = false; }
        if (passed && check.requiredKeys?.length) passed = object(parsed) && check.requiredKeys.every(key => Object.hasOwn(parsed, key));
      }
      protocol(passed, "PM original artifact does not satisfy a declared deterministic check");
    }
    protocol(verifiedArtifacts.length > 0);
    return { detail, verifiedArtifacts, verification: { completedState: true, originalBytesSha256: true,
      deterministicChecks: true, measuredUsageReceipts: true, serverVerifiedCatalogBindings: true, semanticCorrectness: "not-reviewed" },
    semanticReview: { required: true, status: "not-reviewed", boundary: "State, file hashes, usage and server provenance do not establish business correctness" } };
  }

  async wait(runId, input, context) {
    for (;;) {
      const detail = await this.detail(runId, context);
      if (detail.run.status === "completed") return this.completed(detail, context);
      if (!ACTIVE_STATES.has(detail.run.status)) terminalFailure(detail);
      const remaining = context.deadline - performance.now();
      requireFact(remaining > 0, "WAIT_TIMEOUT", "PM wait deadline expired; the backend run was not automatically cancelled", 9, { runId });
      try { await delay(Math.min(input.pollIntervalMs ?? 500, remaining), undefined, { signal: context.signal }); }
      catch { throw new PmClientError("CLIENT_CANCELLED", "PM wait was cancelled; backend task state was not changed", 10, { runId }); }
    }
  }

  async invoke(command, input = {}, { signal } = {}) {
    const value = validateInput(command, input);
    assertNoSecrets(value, this.token);
    const context = { signal, ...(["wait", "deliver"].includes(command) ? { deadline: performance.now() + (value.timeoutMs ?? 120000) } : {}) };
    let result, deliveryClaim = false;
    if (command === "status") {
      result = await this.request("/status", context);
      protocol(object(result) && typeof result.configured === "boolean" && text(result.modelId, 150)
        && Array.isArray(result.employees) && result.employees.every(employee => object(employee)
          && typeof employee.presetKey === "string" && EMPLOYEE.test(employee.presetKey)));
    } else if (command === "list") {
      result = await this.request(`/runs?limit=${value.limit ?? 20}`, context);
      protocol(object(result) && Array.isArray(result.runs) && result.runs.length <= (value.limit ?? 20));
      result.runs.forEach(run => validateRun(run));
    } else if (command === "get") result = await this.detail(value.runId, context);
    else if (command === "artifact") result = await this.artifact(await this.detail(value.runId, context), value.path, context);
    else if (command === "wait") { result = await this.wait(value.runId, value, context); deliveryClaim = true; }
    else if (["start", "resume", "cancel"].includes(command)) {
      result = validateDetail(await this.request(`/runs/${value.runId}/${command}`, { ...context, method: "POST", body: {}, runId: value.runId, operation: command }), value.runId);
    } else {
      if (command === "deliver") {
        const status = await this.request("/status", context);
        requireFact(status?.configured === true && status.industryReady === true && status.dataMode === "real"
          && status.backend === "completion-with-dsh-coding" && status.executionKind === "sandbox-artifact-generation" && status.autoRetries === 0,
        "PM_NOT_READY", "PM real backend and industry assembly are not ready; no run was created", 8);
      }
      const { timeoutMs: _timeout, pollIntervalMs: _poll, ...body } = value;
      const created = validateDetail(await this.request("/runs", { ...context, method: "POST", body, operation: "create" }));
      protocol(created.run.goal === body.goal && created.run.idempotencyKey === body.idempotencyKey
        && created.run.requestedEmployee === (body.employee ?? null) && isDeepStrictEqual(created.run.checks, body.checks ?? []),
      "Created or reused PM run does not match the original idempotent request");
      result = created;
      if (command === "deliver") {
        if (created.run.status === "created") validateDetail(await this.request(`/runs/${created.run.id}/start`,
          { ...context, method: "POST", body: {}, runId: created.run.id, operation: "start" }), created.run.id);
        else if (!ACTIVE_STATES.has(created.run.status) && created.run.status !== "completed") terminalFailure(created);
        result = await this.wait(created.run.id, value, context); deliveryClaim = true;
      }
    }
    return { schemaVersion: RESULT_SCHEMA, operation: command, deliveryClaim, result };
  }
}
