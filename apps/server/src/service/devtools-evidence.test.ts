import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDevContent, validDevContent } from "./devtools-evidence.js";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workloom-dev-content-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  git("add", "binary.bin");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@workloom.local", "commit", "-qm", "fixture baseline");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("DevFabric real read-only content evidence", { timeout: 30_000 }, () => {
  it("remains valid after PostgreSQL JSONB reorders every object's keys", async () => {
    writeFileSync(join(root, "new.txt"), "delivered output");
    const snapshot = await captureDevContent(root);
    const reordered = JSON.parse(JSON.stringify(snapshot, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(validDevContent(reordered)).toBe(true);
    expect((await captureDevContent(root)).sha256).toBe(snapshot.sha256);
    reordered.untracked[0].sha256 = "0".repeat(64);
    expect(validDevContent(reordered)).toBe(false);
  });
  it("binds binary changes whether unstaged or staged without treating staging alone as a content change", async () => {
    const baseline = await captureDevContent(root);
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 3, 255]));
    const changed = await captureDevContent(root);
    expect(changed.sha256).not.toBe(baseline.sha256);
    git("add", "binary.bin");
    expect((await captureDevContent(root)).sha256).toBe(changed.sha256);
  });
  it("uses NUL-delimited raw UTF-8 names for spaces, newlines and Chinese characters", async () => {
    const path = "含 空格\n换行.txt";
    writeFileSync(join(root, path), "exact output");
    const snapshot = await captureDevContent(root);
    expect(snapshot.untracked).toHaveLength(1);
    expect(snapshot.untracked[0]?.path).toBe(path);
    expect(validDevContent(snapshot)).toBe(true);
  });
  it("hashes symlink text without reading the referenced host file", async () => {
    symlinkSync("/host-secret-that-does-not-exist", join(root, "external-link"));
    const snapshot = await captureDevContent(root);
    expect(snapshot.untracked[0]).toMatchObject({ path: "external-link", type: "symlink", size: Buffer.byteLength("/host-secret-that-does-not-exist") });
    expect(validDevContent(snapshot)).toBe(true);
  });
  it("refuses unsupported nested repositories instead of pretending directory metadata proves their files", async () => {
    const nested = join(root, "nested");
    execFileSync("git", ["init", "-q", nested]);
    writeFileSync(join(nested, "unaudited.txt"), "nested output");
    await expect(captureDevContent(root)).rejects.toThrow(/文件类型|指纹|读取/);
  });
  it("rejects a directory outside the repository root", async () => {
    const unrelated = mkdtempSync(join(tmpdir(), "workloom-no-git-"));
    try { await expect(captureDevContent(unrelated)).rejects.toThrow(/指纹/); }
    finally { rmSync(unrelated, { recursive: true, force: true }); }
  });
});
