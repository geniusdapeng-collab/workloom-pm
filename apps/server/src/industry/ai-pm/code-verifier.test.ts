import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandboxCodeVerifier, executeSandboxNodeTests } from "./code-verifier.js";
import { safeArtifactPath, validateEmployeeResult } from "./contract.js";

const signal = () => new AbortController().signal;
const testFile = (content: string) => ({ path: "acceptance.test.mjs", content });
const unsupportedOsSandbox = process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) < 24;

describe("platform-independent code verification admission", () => {
  it("does not execute plain documents", async () => {
    expect(await createSandboxCodeVerifier()({ signal: signal(), files: [{ path: "result.md", content: "需求" }] })).toEqual([]);
  });
  it("rejects code without declared Node tests before OS execution", async () => {
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [{ path: "app.mjs", content: "export const a=1" }] });
    expect(checks[0]).toMatchObject({ passed: false });
    expect(checks[0]?.message).toContain("缺少*.test.mjs/cjs/js");
  });
  it("rejects unsupported languages before OS execution", async () => {
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [{ path: "app.py", content: "print(1)" }] });
    expect(checks[0]).toMatchObject({ passed: false });
    expect(checks[0]?.message).toContain("仅支持零依赖JavaScript");
  });
  it("keeps unsafe paths and duplicate artifact names rejected on every platform", () => {
    expect(() => safeArtifactPath("../escape")).toThrow();
    for (const paths of [["acceptance.test.mjs", "acceptance.test.mjs"], ["Acceptance.test.mjs", "acceptance.test.mjs"]]) {
      expect(() => validateEmployeeResult({
        files: paths.map((path) => ({ path, content: "nonempty fixture" })), summary: "离线合同夹具",
        usage: { promptTokens: 1, completionTokens: 1 }, modelId: "offline-contract-fixture",
      }, paths)).toThrow("重复");
    }
  });
  it.skipIf(!unsupportedOsSandbox)("fails closed before reading or executing generated content when the OS sandbox is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pm-unsupported-os-probe-"));
    const marker = join(root, "must-not-execute");
    let contentReads = 0;
    const file = {
      path: "acceptance.test.mjs",
      get content() {
        contentReads++;
        return `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`;
      },
    };
    try {
      await expect(executeSandboxNodeTests({ signal: signal(), files: [file] })).rejects.toThrow(/^OS_SANDBOX_UNAVAILABLE:/);
      const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [file] });
      expect(checks[0]).toMatchObject({ passed: false });
      expect(checks[0]?.message).toMatch(/^OS_SANDBOX_UNAVAILABLE:/);
      expect(contentReads).toBe(0);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// These process and isolation assertions require the same OS/Node contract as production.
// Unsupported hosts still execute the real fail-closed admission case above.
describe.skipIf(unsupportedOsSandbox)("macOS Seatbelt Node24 code verification", () => {
  it("runs real normal, empty, unicode and error assertions", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), files: [
      { path: "sum.mjs", content: "export const sum=xs=>{if(!Array.isArray(xs))throw new TypeError('array');return xs.reduce((s,x)=>s+x,0)}" },
      testFile("import{test}from'node:test';import assert from'node:assert/strict';import{sum}from'./sum.mjs';test('cases',()=>{assert.equal(sum([1,2]),3);assert.equal(sum([]),0);assert.throws(()=>sum('中文'),TypeError)})"),
    ] });
    expect(receipt.exitCode, receipt.stderr).toBe(0); expect(receipt.testSummary?.counts.failed).toBe(0);
  });
  it("blocks host reads, writes, child processes and network with cleared credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "pm-host-probe-"));
    const secret = join(root, "secret"), target = join(root, "write");
    await writeFile(secret, "host-sentinel");
    let hits = 0;
    const server = createServer((_, res) => { hits++; res.end("unsafe"); });
    await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
    const port = (server.address() as { port: number }).port;
    try {
      const receipt = await executeSandboxNodeTests({ signal: signal(), files: [testFile(`import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{execFileSync}from'node:child_process';test('isolation',async()=>{assert.equal(process.permission.has('child'),false);assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)}));assert.throws(()=>fs.writeFileSync(${JSON.stringify(target)},'bad'));assert.throws(()=>execFileSync('/usr/bin/true'));assert.equal(process.env.LLM_API_KEY,undefined);await assert.rejects(fetch('http://127.0.0.1:${port}'))})`)] });
      expect(receipt.exitCode, receipt.stderr).toBe(0); expect(hits).toBe(0); await expect(readFile(target)).rejects.toThrow();
    } finally { await new Promise<void>((yes) => server.close(() => yes())); await rm(root, { recursive: true, force: true }); }
  });
  it("kills infinite computation", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), timeoutMs: 200, files: [testFile("while(true){}") ] });
    expect(receipt.timedOut).toBe(true); expect(receipt.exitCode).not.toBe(0);
  });
  it("rejects unsafe paths and duplicate names at the OS executor boundary", async () => {
    await expect(executeSandboxNodeTests({ signal: signal(), files: [testFile("test"), { path: "../escape", content: "bad" }] })).rejects.toThrow();
    await expect(executeSandboxNodeTests({ signal: signal(), files: [testFile("one"), testFile("two")] })).rejects.toThrow("冲突");
  });
  it("failed assertion cannot pass the product verifier; abort is a failed receipt", async () => {
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [testFile("import{test}from'node:test';test('fail',()=>{throw Error('expected failure')})")] });
    expect(checks[0]?.passed).toBe(false);
    const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
    const receipt = await executeSandboxNodeTests({ signal: controller.signal, files: [testFile("while(true){}") ] });
    expect(receipt.cancelled).toBe(true);
  });
  it("does not call skipped-only tests verified", async () => {
    const verify = createSandboxCodeVerifier();
    expect((await verify({ signal: signal(), files: [testFile("import{test}from'node:test';test.skip('not run',()=>{})")] }))[0]?.passed).toBe(false);
  });
});
