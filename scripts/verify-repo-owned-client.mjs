#!/usr/bin/env node
/** Verify an independent product whose three clients and UI ship from this repository. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENTS = Object.freeze({
  bPc: "apps/web",
  bMobile: "apps/webb",
  cMobile: "apps/webc",
});
const REQUIRED_ENTRIES = Object.freeze([
  "apps/web/src/main.tsx",
  "apps/webb/src/main.tsx",
  "apps/webc/src/main.tsx",
  "apps/webc/public/service-front.config.json",
]);

function ordinaryJson(root, path, label, errors) {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    errors.push(`${label} 越出仓库：${path}`);
    return null;
  }
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`${label} 必须是普通文件：${path}`);
      return null;
    }
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    errors.push(`${label} 缺失或不是有效 JSON：${path}（${error?.code ?? "parse error"}）`);
    return null;
  }
}

export function verifyRepoOwnedClientDelivery(repoRoot, product) {
  const root = resolve(repoRoot);
  const errors = [];
  if (product?.role === "base") errors.push("repo-owned 客户端交付不得用于基座角色");
  if (product?.clientDelivery?.mode !== "repo-owned") errors.push("clientDelivery.mode 必须为 repo-owned");
  if (typeof product?.clientDelivery?.note !== "string" || product.clientDelivery.note.trim().length < 20) {
    errors.push("repo-owned 交付必须说明为何不接收外部客户端基座状态");
  }

  for (const [key, expected] of Object.entries(CLIENTS)) {
    const spec = product?.clients?.[key];
    if (spec?.enabled !== true || spec?.entry !== expected) {
      errors.push(`${key} 必须启用并指向 ${expected}`);
      continue;
    }
    const pkg = ordinaryJson(root, `${expected}/package.json`, `${key} package.json`, errors);
    if (pkg && pkg.dependencies?.["@workloom/ui"] !== "workspace:*") {
      errors.push(`${expected} 必须从本仓 workspace 消费 @workloom/ui`);
    }
  }
  for (const path of REQUIRED_ENTRIES) {
    const target = join(root, path);
    if (!existsSync(target)) {
      errors.push(`独立客户端缺少生产入口：${path}`);
      continue;
    }
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`独立客户端入口必须是普通文件：${path}`);
    } catch {
      errors.push(`独立客户端入口不可读：${path}`);
    }
  }
  const ui = ordinaryJson(root, "packages/ui/package.json", "@workloom/ui package.json", errors);
  if (ui && !/^\d+\.\d+\.\d+$/.test(ui.version ?? "")) errors.push("@workloom/ui 版本必须是精确稳定 semver");
  return {
    errors: [...new Set(errors)],
    version: ui?.version ?? null,
    clients: CLIENTS,
    files: REQUIRED_ENTRIES,
  };
}

function main() {
  const args = process.argv.slice(2);
  const repoIndex = args.indexOf("--repo");
  const root = resolve(repoIndex >= 0 ? args[repoIndex + 1] : ".");
  let product;
  try {
    product = JSON.parse(readFileSync(join(root, "product.manifest.json"), "utf8"));
  } catch (error) {
    console.error(`❌ 独立客户端交付校验失败：product.manifest.json 不可读（${error?.message ?? error}）`);
    process.exit(1);
  }
  const result = verifyRepoOwnedClientDelivery(root, product);
  if (result.errors.length) {
    console.error(`❌ 独立客户端交付校验失败（${result.errors.length} 项）`);
    for (const error of result.errors) console.error(`  · ${error}`);
    process.exit(1);
  }
  console.log(`✅ ${Object.values(result.clients).length} 端与 @workloom/ui ${result.version} 均来自本仓 workspace；无外部基座状态声明`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
