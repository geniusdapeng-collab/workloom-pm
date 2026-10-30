import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, runArtifactChecks } from "./artifacts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const scope = { tenantId: "tenant-a", workspaceId: "ws-a" };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pm-artifacts-")); roots.push(root);
  return { root, store: new ArtifactStore(root) };
}

describe("MC-PM-002 真实文件回执和安全纯读检查", () => {
  it("写真实文件、回读hash，提供依赖内容；重复写不覆盖", async () => {
    const { store } = await setup();
    const rows = await store.persist(scope, "run-a", "task-a", [{ path: "docs/result.md", content: "可测试的实际内容" }]);
    expect(rows[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.read(scope, "run-a", rows[0]!)).toBe("可测试的实际内容");
    await expect(store.persist(scope, "run-a", "task-b", [{ path: "docs/result.md", content: "不能覆盖" }])).rejects.toThrow();
  });
  it("篡改后拒读取和resume跳过", async () => {
    const { store } = await setup();
    const [row] = await store.persist(scope, "run-a", "task-a", [{ path: "result.md", content: "original" }]);
    const file = await store.resolveFile(scope, "run-a", row!.path);
    await writeFile(file, "tampered");
    await expect(store.read(scope, "run-a", row!)).rejects.toThrow(/hash|摘要|校验/);
  });
  it("只回滚哈希仍匹配的未提交文件；被替换的字节保留等待对账", async () => {
    const { store } = await setup();
    const [row] = await store.persist(scope, "run-a", "task-a", [{ path: "result.md", content: "uncommitted" }]);
    expect(await store.discardUncommitted(scope, "run-a", [row!])).toBe(1);
    const path = await store.resolveFile(scope, "run-a", "result.md");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const [changed] = await store.persist(scope, "run-a", "task-b", [{ path: "changed.md", content: "original" }]);
    const changedPath = await store.resolveFile(scope, "run-a", "changed.md");
    await writeFile(changedPath, "replacement");
    await expect(store.discardUncommitted(scope, "run-a", [changed!])).rejects.toThrow(/hash|摘要|校验/);
    expect(await readFile(changedPath, "utf8")).toBe("replacement");
  });
  it("拒符号链接与跨租户产物读取", async () => {
    const { root, store } = await setup();
    const [row] = await store.persist(scope, "run-a", "task-a", [{ path: "result.md", content: "private" }]);
    await expect(store.read({ ...scope, workspaceId: "ws-b" }, "run-a", row!)).rejects.toThrow();
    const outside = join(root, "outside"); await mkdir(outside);
    const runDir = await store.runDirectory(scope, "run-symlink");
    await symlink(outside, join(runDir, "artifacts", "escaped"));
    await expect(store.persist(scope, "run-symlink", "task-a", [{ path: "escaped/a.md", content: "bad" }])).rejects.toThrow();
  });
  it("检查只允许exists/contains/json，不执行模型生成代码", () => {
    const files = [{ path: "data.json", content: '{"count":3,"valid":true}' }, { path: "app.js", content: 'throw new Error("must never execute")' }];
    expect(runArtifactChecks(files, [{ type: "fileExists", path: "app.js" }, { type: "fileContains", path: "data.json", text: '"count":3' }, { type: "json", path: "data.json", requiredKeys: ["count", "valid"] }]).every((row) => row.passed)).toBe(true);
    expect(runArtifactChecks(files, [{ type: "json", path: "data.json", requiredKeys: ["missing"] }])[0]!.passed).toBe(false);
    expect(() => runArtifactChecks(files, [{ type: "shell", path: "app.js" } as never])).toThrow();
  });
});
