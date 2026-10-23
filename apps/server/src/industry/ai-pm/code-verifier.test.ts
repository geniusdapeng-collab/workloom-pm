import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandboxCodeVerifier, executeSandboxNodeTests } from "./code-verifier.js";

const signal = () => new AbortController().signal;
const testFile = (content: string) => ({ path: "acceptance.test.mjs", content });
describe("OS sandbox code verification", () => {
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
  it("kills infinite computation and rejects missing tests", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), timeoutMs: 200, files: [testFile("while(true){}") ] });
    expect(receipt.timedOut).toBe(true); expect(receipt.exitCode).not.toBe(0);
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [{ path: "app.mjs", content: "export const a=1" }] });
    expect(checks[0]?.passed).toBe(false);
  });
  it("does not execute plain documents; rejects path traversal and duplicate names", async () => {
    expect(await createSandboxCodeVerifier()({ signal: signal(), files: [{ path: "result.md", content: "需求" }] })).toEqual([]);
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
  it("does not call unsupported code or skipped-only tests verified", async () => {
    const verify = createSandboxCodeVerifier();
    expect((await verify({ signal: signal(), files: [{ path: "app.py", content: "print(1)" }] }))[0]?.passed).toBe(false);
    expect((await verify({ signal: signal(), files: [testFile("import{test}from'node:test';test.skip('not run',()=>{})")] }))[0]?.passed).toBe(false);
  });
});
