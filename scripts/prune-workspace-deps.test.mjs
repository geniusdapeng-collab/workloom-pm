import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pruneCopiedWorkspaceDependencies } from "./prune-workspace-deps.mjs";

const scratch = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function fixture() {
  const root = mkdtempSync(join(scratch, "pm-prune-workspace-"));
  const modules = join(root, "node_modules");
  write(join(modules, "@workloom/runtime/package.json"), JSON.stringify({ name: "@workloom/runtime", version: "1.0.0" }));
  write(join(modules, "@workloom/runtime/node_modules/copied-direct/index.js"), "copied dependency");
  write(join(modules, "@workloom/runtime/dsh-gate/node_modules/copied-gate/index.js"), "copied gate dependency");
  write(join(modules, "outer/package.json"), JSON.stringify({ name: "outer", version: "1.0.0", main: "index.cjs" }));
  write(join(modules, "outer/index.cjs"), 'module.exports = require("nested-required");');
  write(join(modules, "outer/node_modules/nested-required/package.json"), JSON.stringify({ name: "nested-required", version: "2.0.0", main: "index.cjs" }));
  write(join(modules, "outer/node_modules/nested-required/index.cjs"), 'module.exports = "nested-version-2";');
  return { root, modules };
}

test("workspace cleanup preserves a genuinely required third-party nested module", () => {
  const { root, modules } = fixture();
  try {
    const before = execFileSync(process.execPath, ["-e", 'process.stdout.write(require("outer"))'], { cwd: root, encoding: "utf8" });
    assert.equal(before, "nested-version-2");
    const cleaned = pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime");
    assert.deepEqual(cleaned.removed, ["dsh-gate/node_modules", "node_modules"]);
    assert.equal(existsSync(join(modules, "@workloom/runtime/node_modules")), false);
    assert.equal(existsSync(join(modules, "@workloom/runtime/dsh-gate/node_modules")), false);
    const after = execFileSync(process.execPath, ["-e", 'process.stdout.write(require("outer"))'], { cwd: root, encoding: "utf8" });
    assert.equal(after, "nested-version-2");
    assert.deepEqual(pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime").removed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup refuses escaping names, mismatched manifests and linked package roots", () => {
  const { root, modules } = fixture();
  try {
    assert.throws(() => pruneCopiedWorkspaceDependencies(modules, "../../outer"), /精确包名/u);
    writeFileSync(join(modules, "@workloom/runtime/package.json"), JSON.stringify({ name: "unexpected" }));
    assert.throws(() => pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime"), /身份/u);
    symlinkSync(join(modules, "outer"), join(modules, "linked"), "dir");
    assert.throws(() => pruneCopiedWorkspaceDependencies(modules, "linked"), /实体目录/u);
    assert.equal(existsSync(join(modules, "outer/node_modules/nested-required/index.cjs")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a copied workspace node_modules symlink is unlinked without changing its target", () => {
  const { root, modules } = fixture();
  try {
    rmSync(join(modules, "@workloom/runtime/node_modules"), { recursive: true });
    symlinkSync(join(modules, "outer/node_modules"), join(modules, "@workloom/runtime/node_modules"), "dir");
    pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime");
    assert.equal(existsSync(join(modules, "@workloom/runtime/node_modules")), false);
    assert.equal(readFileSync(join(modules, "outer/node_modules/nested-required/index.cjs"), "utf8"), 'module.exports = "nested-version-2";');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all three packaging paths preserve npm nested boundaries and verify production preview", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const script of ["pack-electron-payload.sh", "pack-macos.sh", "pack-windows.sh"]) {
    const source = readFileSync(join(root, "scripts", script), "utf8");
    assert.match(source, /node scripts\/prune-workspace-deps\.mjs "\$R\/node_modules" "\$pname"/u, script);
    assert.doesNotMatch(source, /find "\$R\/node_modules"[^\n]*-name node_modules[^\n]*rm -rf/u, script);
    assert.match(source, /node scripts\/verify-runtime-preview\.mjs "\$R" "\$NM_STAGE\/node_modules"/u, script);
  }
});
