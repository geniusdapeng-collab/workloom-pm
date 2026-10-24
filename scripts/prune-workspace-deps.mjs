#!/usr/bin/env node
/** Remove copied workspace-local dependencies without changing npm's own tree. */
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function within(root, path) {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

/**
 * Call only for a workspace package just copied into nodeModulesRoot. A package
 * name comes from its source manifest, never from the npm directory inventory.
 * Third-party nested node_modules are legitimate npm resolution boundaries.
 */
export function pruneCopiedWorkspaceDependencies(nodeModulesRoot, packageName) {
  if (typeof packageName !== "string" || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(packageName)) {
    throw new Error("workspace 依赖清理需要精确包名");
  }
  const requestedRoot = resolve(nodeModulesRoot);
  if (basename(requestedRoot) !== "node_modules" || !lstatSync(requestedRoot).isDirectory() || lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error("workspace 依赖清理根必须是实体 node_modules 目录");
  }
  const root = realpathSync(requestedRoot);
  const packageDirectory = join(root, ...packageName.split("/"));
  const packageStat = lstatSync(packageDirectory);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink() || !within(root, realpathSync(packageDirectory))) {
    throw new Error("workspace 包目录必须为载荷内实体目录");
  }
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  if (manifest.name !== packageName) throw new Error("workspace 包身份与清理目标不一致");
  const removed = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!within(packageDirectory, path)) throw new Error("workspace 依赖清理路径越界");
      if (entry.name === "node_modules") {
        // rm on a link removes that link; it never traverses its external target.
        rmSync(path, { recursive: !entry.isSymbolicLink(), force: true });
        removed.push(relative(packageDirectory, path).split(sep).join("/"));
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path);
    }
  };
  walk(packageDirectory);
  return { packageName, removed: removed.sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , root, packageName] = process.argv;
    if (!root || !packageName) throw new Error("用法：prune-workspace-deps.mjs <载荷 node_modules> <已复制的 workspace 包名>");
    const result = pruneCopiedWorkspaceDependencies(root, packageName);
    console.log(`✓ workspace 依赖清理 ${result.packageName}：${result.removed.length} 处；保留第三方 npm 嵌套依赖`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
