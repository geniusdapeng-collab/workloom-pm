import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployRoot = join(root, "deploy/linux");
const install = readFileSync(join(deployRoot, "install.sh"), "utf8");

test("Linux reinstall keeps role credentials aligned with runtime.env", () => {
  assert.match(install, /database_password_from_runtime_env DATABASE_URL/);
  assert.match(install, /database_password_from_runtime_env DATABASE_APP_URL/);
  assert.match(install, /database_password_from_runtime_env DATABASE_GATEWAY_URL/);
  assert.match(install, /Reinstalls must reuse the credentials already embedded in runtime\.env/);
});

test("Linux deployment restores system command paths and readable build artifacts", () => {
  assert.match(install, /\/usr\/sbin:\/sbin:\/usr\/bin:\/bin/);
  assert.match(install, /find "\$release\/node_modules" -type d -exec chmod 0755/);
  assert.match(install, /find "\$release\/node_modules" -type f ! -perm \/111 -exec chmod 0644/);
  assert.match(install, /find "\$release\/apps\/web\/dist" -type d -exec chmod 0755/);
  assert.match(install, /find "\$release\/apps\/web\/dist" -type f -exec chmod 0644/);
});

test("Linux deployment scripts are syntactically valid", () => {
  for (const name of ["install.sh", "configure-nginx.sh", "start.sh", "backup.sh", "restore-check.sh"]) {
    const checked = spawnSync("bash", ["-n", join(deployRoot, name)], { encoding: "utf8" });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
  }
  const bootstrap = spawnSync(process.execPath, ["--check", join(deployRoot, "bootstrap-db.mjs")], { encoding: "utf8" });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
});
