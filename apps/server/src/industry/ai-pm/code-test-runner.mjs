// Trusted entrypoint. Test output is untrusted; only this private closure emits
// the parent's one-use challenge after consuming the real node:test stream.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "node:test";
const challenge = readFileSync(0, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(challenge)) throw new Error("Missing test receipt challenge");
const emit = process.stdout.write.bind(process.stdout);
const stringify = JSON.stringify.bind(JSON);
const files = process.argv.slice(2).map((path) => resolve(path));
const fileNames = new Set([...files, ...process.argv.slice(2)]);
let summary;
let completedTests = 0;
// The supervisor never imports project code. Only child processes load it; their
// permissions omit child-process access and their OS sandbox is inherited.
const childArgs = process.execArgv.filter((arg) => arg !== "--allow-child-process");
// Node also inherits process.execArgv in addition to options.execArgv. Remove
// the supervisor grant from that second path before spawning any test child.
process.execArgv = childArgs;
// Linux mounts this fixed file at /preload. Resolving relative to /runner would
// incorrectly produce /code-test-preload.mjs and the test child would fail before
// loading any trusted evaluator code.
const preload = process.platform === "linux"
  ? "file:///preload"
  : new URL("./code-test-preload.mjs", import.meta.url).href;
for await (const event of run({ files, isolation: "process", execArgv: [...childArgs, "--no-allow-child-process",
  "--frozen-intrinsics", "--import", preload], concurrency: 1 })) {
  if (event.type === "test:stdout" || event.type === "test:stderr") emit(`TEST_LOG:${stringify(event.data)}\n`);
  if (event.type === "test:fail") emit(`TEST_FAILURE:${stringify({ name: event.data.name,
    message: event.data.details?.error?.message ?? "test failed", code: event.data.details?.error?.code,
    expected: event.data.details?.error?.expected, actual: event.data.details?.error?.actual })}\n`);
  if (event.type === "test:pass" && !event.data.skip && !event.data.todo && !fileNames.has(event.data.name)) completedTests++;
  if (event.type === "test:summary" && event.data.file === undefined) {
    summary = { success: event.data.success, counts: { ...event.data.counts }, completedTests };
  }
}
if (!summary) throw new Error("Missing node:test completion summary");
emit(`\nPM_TEST_RECEIPT:${challenge}:${stringify(summary)}\n`);
if (!summary.success) process.exitCode = 1;
