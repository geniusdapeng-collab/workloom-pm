import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyRepoOwnedClientDelivery } from "./verify-repo-owned-client.mjs";

function write(path, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-repo-owned-client-"));
  const product = {
    schemaVersion: "workloom.product/v1",
    productId: "independent-product",
    role: "industry",
    packageName: "independent-product",
    repository: "example/independent-product",
    demoWorkspaceSlug: "independent-demo",
    demoMemberNo: "MEM-001",
    desktop: { portOffset: 200, startPath: "/development" },
    release: { appId: "com.example.independent", channel: "stable", artifactPrefix: "Independent", website: "apps/site" },
    clients: {
      bPc: { enabled: true, entry: "apps/web" },
      bMobile: { enabled: true, entry: "apps/webb" },
      cMobile: { enabled: true, entry: "apps/webc" },
    },
    clientDelivery: { mode: "repo-owned", note: "三端应用壳与共享 UI 随本产品同一提交发布，不接收外部升级状态。" },
  };
  write(join(root, "product.manifest.json"), `${JSON.stringify(product, null, 2)}\n`);
  for (const client of ["web", "webb", "webc"]) {
    write(join(root, `apps/${client}/package.json`), JSON.stringify({ private: true, dependencies: { "@workloom/ui": "workspace:*" } }));
    write(join(root, `apps/${client}/src/main.tsx`), "export {};\n");
  }
  write(join(root, "apps/webc/public/service-front.config.json"), "{}\n");
  write(join(root, "packages/ui/package.json"), JSON.stringify({ name: "@workloom/ui", version: "0.1.20" }));
  return { root, product };
}

test("repo-owned client delivery verifies all three workspace clients and required entries", () => {
  const f = fixture();
  try {
    const result = verifyRepoOwnedClientDelivery(f.root, f.product);
    assert.deepEqual(result.errors, []);
    assert.equal(result.version, "0.1.20");
    assert.equal(result.files.length, 4);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("repo-owned client delivery fails closed for missing mode, external UI or symlink", () => {
  const f = fixture();
  try {
    const noMode = structuredClone(f.product);
    delete noMode.clientDelivery.mode;
    assert.match(verifyRepoOwnedClientDelivery(f.root, noMode).errors.join("\n"), /repo-owned/);

    write(join(f.root, "apps/web/package.json"), JSON.stringify({ dependencies: { "@workloom/ui": "0.1.19" } }));
    assert.match(verifyRepoOwnedClientDelivery(f.root, f.product).errors.join("\n"), /workspace/);

    write(join(f.root, "apps/web/package.json"), JSON.stringify({ dependencies: { "@workloom/ui": "workspace:*" } }));
    const external = join(f.root, "external-entry.tsx");
    write(external, "export {};\n");
    rmSync(join(f.root, "apps/webb/src/main.tsx"));
    symlinkSync(external, join(f.root, "apps/webb/src/main.tsx"));
    assert.match(verifyRepoOwnedClientDelivery(f.root, f.product).errors.join("\n"), /普通文件/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
