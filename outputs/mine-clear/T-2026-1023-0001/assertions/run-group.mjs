import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ledger = JSON.parse(readFileSync(join(here, "../ledger.json"), "utf8"));
const repo = ledger.repo_path;
const specs = JSON.parse(readFileSync(join(here, "specs.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function safeEnvironment() {
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SystemRoot"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    NODE_ENV: "test", LLM_PROVIDER: "mock", WORKLOOM_SCHEDULER_MS: "0", RUN_DB_TESTS: "1",
    DATABASE_URL: "postgres://pm_sandbox@127.0.0.1:55437/workloom_pm_sandbox",
    DATABASE_APP_URL: "postgres://workloom_app@127.0.0.1:55437/workloom_pm_sandbox",
    DATABASE_GATEWAY_URL: "postgres://workloom_gateway@127.0.0.1:55437/workloom_pm_sandbox",
  });
  // Only this explicit allowlist enters a child; parent model/API/GitHub credentials and NODE_OPTIONS are absent.
  return env;
}

function execute(group, args, cwd, reportPath) {
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, args, { cwd, env: safeEnvironment(), encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  const observation = { schema: "workloom.pm-mcd-nested-run/v1", group, executable: process.execPath, args, cwd,
    startedAt, finishedAt: new Date().toISOString(), exitCode: child.status, signal: child.signal, error: child.error?.message ?? null,
    stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  writeFileSync(reportPath + ".process.json", JSON.stringify(observation, null, 2) + "\n");
  assert.equal(child.error, undefined, `nested ${group} process error: ${child.error?.message}`);
  assert.equal(child.signal, null, `nested ${group} terminated by signal`);
  assert.equal(child.status, 0, `nested ${group} failed; ${reportPath}.process.json\n${(child.stderr ?? "").slice(-4000)}`);
  return observation;
}

export async function runGroup(group) {
  const spec = specs[group];
  assert.ok(spec, `unknown assertion group ${group}`);
  if (spec.kind === "closure") {
    const { dependencyClosureViolations, loadScope } = await import(pathToFileURL(join(repo, "sync/base-sync.mjs")).href);
    assert.deepEqual(dependencyClosureViolations(repo, loadScope(repo)), [], "public mechanism must not depend on excluded industry files");
    const index = readFileSync(join(repo, "apps/server/src/index.ts"), "utf8");
    assert.doesNotMatch(index, /createPmTeamRouter|["']\/api\/pm["']|["']\.\/industry\/ai-pm\//, "public startup only consumes the generic composition seam");
    process.stdout.write(JSON.stringify({ schema: "workloom.pm-mcd-closure/v1", group, violations: [], publicStartupHasPmKnowledge: false }) + "\n");
    return;
  }
  if (spec.kind === "identity") {
    const manifest = JSON.parse(readFileSync(join(repo, "product.manifest.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    assert.equal(manifest.productId, "workloom-pm"); assert.equal(manifest.role, "industry");
    assert.equal(manifest.repository, "geniusdapeng-collab/workloom-pm"); assert.equal(manifest.release.appId, "com.workloom.pm");
    assert.equal(manifest.desktop.portOffset, 200); assert.equal(pkg.name, "workloom-pm"); assert.equal(pkg.workloomPortOffset, 200);
    const localRules = readFileSync(join(repo, "AGENTS.override.md"), "utf8");
    assert.match(localRules, /geniusdapeng-collab\/workloom-pm/);
    assert.match(localRules, /不得用 reset 或重新 seed 覆盖历史成绩/);
    process.stdout.write(JSON.stringify({ schema: "workloom.pm-mcd-identity/v1", group, productId: manifest.productId, appId: manifest.release.appId,
      repository: manifest.repository, portOffset: manifest.desktop.portOffset }) + "\n");
    return;
  }
  const out = join(here, "runs", `${group}-${Date.now()}-${randomUUID()}`);
  mkdirSync(dirname(out), { recursive: true });
  if (spec.kind === "runtime-preview") {
    const modules = resolve(spec.nodeModulesRoot);
    const stageLock = join(dirname(modules), "package-lock.json");
    assert.equal(sha(readFileSync(stageLock)), sha(readFileSync(join(repo, ".workloom-runtime-deps/package-lock.json"))), "native npm stage must use the current committed runtime lock");
    const report = out + ".preview.json";
    const actual = execute(group, [join(repo, "scripts/verify-runtime-preview.mjs"), repo, modules, "--clients", "web,webb,webc"], repo, report);
    const result = JSON.parse(actual.stdout.trim());
    assert.equal(result.schemaVersion, "workloom.runtime-preview/v1"); assert.equal(result.mode, "native-http");
    assert.equal(result.vitestAvailable, false); assert.equal(result.clients.length, 3);
    assert.deepEqual(result.clients.map((client) => client.client).sort(), ["web", "webb", "webc"]);
    for (const client of result.clients) {
      assert.equal(client.configurationBoundary, true); assert.equal(client.httpPreview, 200);
      assert.equal(client.indexSha256, sha(readFileSync(join(repo, "apps", client.client, "dist/index.html"))));
    }
    writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ schema: "workloom.pm-mcd-runtime-preview/v1", group, report, sha256: sha(readFileSync(report)),
      currentLockSha256: sha(readFileSync(stageLock)), clients: result.clients, nativeHttpOnly: true, productionAppAcceptance: false }) + "\n");
    return;
  }
  if (spec.kind === "vitest") {
    const report = out + ".vitest.json";
    const cwd = resolve(repo, spec.cwd);
    execute(group, [join(repo, "node_modules/vitest/vitest.mjs"), "run", ...spec.files,
      ...(spec.maxWorkers ? ["--maxWorkers", String(spec.maxWorkers)] : []), "--reporter=json", `--outputFile=${report}`], cwd, report);
    const bytes = readFileSync(report); const result = JSON.parse(bytes);
    assert.equal(result.success, true, "Vitest must actually report success");
    assert.ok(Number.isSafeInteger(result.numPassedTests) && result.numPassedTests >= spec.minTests, `nested ${group} actual passed tests must be >= ${spec.minTests}`);
    for (const field of ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"]) assert.equal(result[field], 0, `${group} ${field} must be zero`);
    assert.equal(result.numTotalTests, result.numPassedTests, "zero skipped, pending, or todo tests are allowed");
    const actual = result.testResults.map((file) => resolve(file.name)).sort();
    const expected = spec.files.map((file) => resolve(cwd, file)).sort();
    assert.deepEqual(actual, expected, "every declared test file must really run, with no unrelated suites");
    for (const file of result.testResults) {
      assert.equal(file.status, "passed"); assert.ok(file.assertionResults.length > 0, "empty suite is not a passing assertion");
      assert.ok(file.assertionResults.every((item) => item.status === "passed"), "every nested assertion must pass");
    }
    process.stdout.write(JSON.stringify({ schema: "workloom.pm-mcd-nested-summary/v1", group, kind: spec.kind, report, sha256: sha(bytes),
      actualPassed: result.numPassedTests, actualTotal: result.numTotalTests, pending: result.numPendingTests, files: actual }) + "\n");
    return;
  }
  assert.equal(spec.kind, "node");
  const report = out + ".node.jsonl";
  execute(group, [`--test-reporter=${join(repo, "scripts/delivery/node-test-reporter.mjs")}`, `--test-reporter-destination=${report}`,
    "--test-reporter=tap", "--test-reporter-destination=stdout", "--import", "tsx", "--test", "--test-concurrency=1", ...spec.files], repo, report);
  const bytes = readFileSync(report); const rows = bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1); const result = rows[0];
  assert.equal(result.schema, "workloom.node-test-summary/v1"); assert.equal(result.aggregate, true); assert.equal(result.success, true);
  assert.ok(result.files >= spec.files.length && result.passed >= spec.minTests, "each native test file must supply real nonzero TestsStream passed counts");
  assert.equal(result.tests, result.passed);
  for (const key of ["failed", "cancelled", "skipped", "todo"]) assert.equal(result[key], 0, `native ${group} ${key} must be zero`);
  process.stdout.write(JSON.stringify({ schema: "workloom.pm-mcd-nested-summary/v1", group, kind: spec.kind, report, sha256: sha(bytes),
    actualPassed: result.passed, actualTotal: result.tests, pending: 0, files: result.files }) + "\n");
}
