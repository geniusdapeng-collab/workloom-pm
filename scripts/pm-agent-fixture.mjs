/** Synthetic localhost HTTP fixtures only. Never a model, DB, CI or publication receipt. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

export const fixtureAccess = ["fixture", "member", "session"].join("-");
export const fixtureModelCredential = ["fixture", "model", "credential"].join("-");
export const digest = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);

export function assetBinding(presetKey) {
  return { assetBindingSource: "verified-catalog", assetBinding: { schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm",
    bundleVersion: "0.0.0-fixture", manifestSha256: digest("fixture manifest"), bundleIntegrityDigest: digest("fixture integrity"), presetKey,
    presetSha256: digest("fixture preset " + presetKey), skillTextSha256: digest("fixture skill text"),
    skills: [{ name: "fixture-skill", path: "skills/fixture-skill/SKILL.md", sha256: digest("fixture skill") }] } };
}

export function completedFixture(input, id = "pm-fixture-1") {
  const planned = input.employee ? [{ id: "employee-task", presetKey: input.employee, path: input.checks?.[0]?.path ?? "result.md" }]
    : [{ id: "draft", presetKey: "doc-writer", path: "result.md" }, { id: "review", presetKey: "red-teamer", path: "review.md" }];
  const artifacts = [], content = new Map();
  const tasks = planned.map((item, index) => {
    const paths = input.employee && input.checks?.length ? [...new Set(input.checks.map(check => check.path))] : [item.path];
    for (const path of paths) {
      const body = `Synthetic fixture content for ${path}\n中文🙂\n`;
      content.set(path, body);
      artifacts.push({ id: `pma-fixture-${artifacts.length + 1}`, runId: id, taskId: item.id, path, sha256: digest(body),
        sizeBytes: Buffer.byteLength(body), mediaType: "text/markdown", verifiedAt: "2026-10-24T00:00:00.000Z" });
    }
    const receipt = { adapter: "deepseek-completion", modelRequests: 1, responseId: `fixture-response-${index + 1}`,
      finishReason: "stop", transport: paths.length === 1 ? "single-file-text" : "structured-json", ...assetBinding(item.presetKey) };
    return { id: item.id, runId: id, presetKey: item.presetKey, goal: input.employee ? input.goal : "Synthetic subtask", dependsOn: index ? [planned[index - 1].id] : [],
      acceptance: ["Synthetic fixture only"], outputRefs: paths, status: "completed", attempt: 1, summary: "Synthetic content",
      error: null, errorCode: null, usage: { promptTokens: 10, completionTokens: 20 }, modelId: "deepseek-fixture", responseId: receipt.responseId,
      fenceImpacts: [], adapterReceipt: receipt, executionBackend: "deepseek-completion",
      attemptReceipts: [{ attempt: 1, usage: { promptTokens: 10, completionTokens: 20 }, modelId: "deepseek-fixture", responseId: receipt.responseId, final: true, receipt: clone(receipt) }],
      startedAt: "2026-10-24T00:00:00.000Z", finishedAt: "2026-10-24T00:00:00.001Z" };
  });
  const planning = input.employee ? { source: "explicit-employee", modelId: "deepseek-fixture", promptTokens: 0, completionTokens: 0 }
    : { source: "model", modelId: "deepseek-fixture", responseId: "fixture-planner-response", promptTokens: 5, completionTokens: 6, ...assetBinding("chief-pm") };
  const detail = { run: { id, goal: input.goal, idempotencyKey: input.idempotencyKey, requestedEmployee: input.employee ?? null, checks: input.checks ?? [],
    status: "completed", modelId: "deepseek-fixture", planVersion: 1, createdBy: "fixture-member", createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.001Z",
    error: null, errorCode: null, usage: { promptTokens: 10 * tasks.length + planning.promptTokens, completionTokens: 20 * tasks.length + planning.completionTokens },
    planningReceipt: planning, planningReceipts: [clone(planning)], policyVersion: "workloom-pm.sandbox-artifacts/v1",
    verification: { checks: (input.checks ?? []).map(check => ({ passed: true, message: "Synthetic fixture verification", check: clone(check) })), verifiedAt: "2026-10-24T00:00:00.001Z" } }, tasks, artifacts };
  return { detail, content };
}

export async function httpFixture(options = {}) {
  const calls = [], runs = new Map(), byKey = new Map();
  const behavior = { ...options };
  const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url, "http://fixture.invalid");
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }
    catch { json(response, 400, { error: { code: "INVALID_JSON" } }); return; }
    calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${fixtureAccess}`) { json(response, 401, { error: { code: "UNAUTHENTICATED" } }); return; }
    if (behavior.statusCode) { json(response, behavior.statusCode, { error: { code: behavior.errorCode ?? "FIXTURE_ERROR", message: behavior.errorMessage ?? "fixture refusal" } }); return; }
    if (behavior.redirect) { response.writeHead(302, { location: behavior.redirect }); response.end("fixture redirect"); return; }
    if (behavior.neverRespond) return;
    if (behavior.slowBody) { response.writeHead(200, { "content-type": "application/json" }); response.write('{"configured":'); return; }
    if (behavior.invalidJson) { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
    const send = (status, payload) => json(response, status, behavior.mutate ? behavior.mutate(url.pathname, clone(payload)) : payload);
    if (request.method === "GET" && url.pathname === "/api/pm/status") {
      send(200, { configured: behavior.configured !== false, modelId: "deepseek-fixture", employees: [{ presetKey: "doc-writer", name: "Fixture" }],
        industryReady: true, dataMode: "real", backend: "completion-with-dsh-coding", executionKind: "sandbox-artifact-generation", autoRetries: 0, syntheticFixture: true }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/pm/runs") { send(200, { runs: [...runs.values()].map(value => value.detail.run).slice(0, Number(url.searchParams.get("limit"))) }); return; }
    if (request.method === "POST" && url.pathname === "/api/pm/runs") {
      const fingerprint = JSON.stringify({ goal: body.goal, employee: body.employee ?? null, checks: body.checks ?? [] });
      if (byKey.has(body.idempotencyKey)) {
        const prior = byKey.get(body.idempotencyKey);
        if (prior.fingerprint !== fingerprint) { json(response, 409, { error: { code: "IDEMPOTENCY_CONFLICT" } }); return; }
        send(200, runs.get(prior.id).detail); return;
      }
      const id = `pm-fixture-${runs.size + 1}`, made = completedFixture(body, id);
      made.finished = clone(made.detail); made.detail.run.status = behavior.initialStatus ?? "created";
      if (made.detail.run.status !== "completed") { made.detail.tasks = []; made.detail.artifacts = []; made.detail.run.planVersion = 0; made.detail.run.usage = { promptTokens: 0, completionTokens: 0 }; }
      if (behavior.initialStatus === "blocked") made.detail.run.errorCode = "MODEL_BUDGET_EXHAUSTED";
      byKey.set(body.idempotencyKey, { id, fingerprint }); runs.set(id, made); send(201, made.detail); return;
    }
    const match = /^\/api\/pm\/runs\/([A-Za-z0-9_-]+)(?:\/(start|resume|cancel|artifacts))?$/.exec(url.pathname);
    if (!match || !runs.has(match[1])) { json(response, 404, { error: { code: "RUN_NOT_FOUND" } }); return; }
    const current = runs.get(match[1]);
    if (request.method === "POST" && ["start", "resume"].includes(match[2])) {
      current.detail = clone(current.finished); current.detail.run.status = behavior.runForever ? "running" : behavior.stoppedStatus ?? "completed";
      if (behavior.stoppedStatus === "blocked") current.detail.run.errorCode = "MODEL_BUDGET_EXHAUSTED";
      send(202, current.detail); return;
    }
    if (request.method === "POST" && match[2] === "cancel") { current.detail.run.status = "cancelled"; send(200, current.detail); return; }
    if (request.method === "GET" && match[2] === "artifacts") {
      const path = url.searchParams.get("path"), meta = current.finished.artifacts.find(item => item.path === path);
      if (!meta) { json(response, 404, { error: { code: "ARTIFACT_NOT_FOUND" } }); return; }
      send(200, { path, content: current.content.get(path), sha256: meta.sha256, mediaType: meta.mediaType, sizeBytes: meta.sizeBytes, taskId: meta.taskId }); return;
    }
    if (request.method === "GET" && !match[2]) { send(200, current.detail); return; }
    json(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
  })().catch(() => { if (!response.headersSent) json(response, 500, { error: { code: "FIXTURE_INTERNAL" } }); else response.destroy(); }); });
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, runs, behavior, env: { PM_BASE_URL: base, WORKLOOM_ACCESS_TOKEN: fixtureAccess },
    close: async () => { server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); } };
}
