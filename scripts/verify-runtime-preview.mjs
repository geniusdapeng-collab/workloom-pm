#!/usr/bin/env node
/** Preview configuration must run from the locked production stage, without Vitest. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const CLIENTS = new Set(["web", "webb", "webc"]);

export async function verifyRuntimePreview({ runtimeRoot, nodeModulesRoot, clients = ["web"], targetOs = process.platform, targetCpu = process.arch }) {
  const root = await realpath(resolve(runtimeRoot));
  const modules = await realpath(resolve(nodeModulesRoot));
  if (!(await lstat(modules)).isDirectory()) throw new Error("生产依赖 stage 必须是目录");
  if (!["darwin", "win32", "linux"].includes(targetOs) || !["arm64", "x64"].includes(targetCpu)) throw new Error("生产 preview 目标平台或架构无效");
  if (!clients.length || clients.some((client) => !CLIENTS.has(client)) || new Set(clients).size !== clients.length) throw new Error("客户端清单无效");
  const require = createRequire(join(modules, ".workloom-preview-verifier.cjs"));
  let vitest;
  try { vitest = require.resolve("vitest/config"); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
  if (vitest) throw new Error("生产 stage 可解析到 Vitest，拒绝以构建机测试依赖掩盖载荷缺失");
  const native = targetOs === process.platform && targetCpu === process.arch;
  const report = { schemaVersion: "workloom.runtime-preview/v1", mode: native ? "native-http" : "cross-target-config-only", targetOs, targetCpu, vitestAvailable: false, clients: [] };
  for (const client of clients) {
    const sourceConfig = join(root, "apps", client, "vite.config.ts");
    const source = await readFile(sourceConfig, "utf8");
    const runtimeImports = source.replace(/import\s+type\s+[\s\S]*?from\s*["'][^"']+["']\s*;?/gu, "");
    if (/\b(?:from\s*|import\s*(?:\(\s*)?)["']vitest(?:\/[^"']*)?["']/u.test(runtimeImports)) {
      throw new Error(`${client} Vite 配置运行时导入了 dev-only Vitest`);
    }
    if (!native) {
      report.clients.push({ client, configurationBoundary: true, httpPreview: "not-run-on-foreign-host" });
      continue;
    }
    // Keep config files outside the build tree; otherwise Node may find the
    // developer's node_modules while resolving a missing runtime dependency.
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "workloom-runtime-preview-")));
    let server;
    try {
      await mkdir(join(fixture, "scripts"));
      await mkdir(join(fixture, "apps", client, "dist"), { recursive: true });
      await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
      for (const path of ["product.manifest.json", "scripts/product-runtime.mjs", "scripts/vite-product.mjs", `apps/${client}/vite.config.ts`, `apps/${client}/dist/index.html`]) {
        await copyFile(join(root, path), join(fixture, path));
      }
      await symlink(modules, join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const { preview } = await import(pathToFileURL(join(modules, "vite/dist/node/index.js")).href);
      server = await preview({ root: join(fixture, "apps", client), configFile: join(fixture, "apps", client, "vite.config.ts"),
        mode: "production", preview: { host: "127.0.0.1", port: 0, strictPort: true }, logLevel: "error" });
      const address = server.httpServer.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("生产 preview 未监听独立回环端口");
      const response = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(10_000) });
      const body = Buffer.from(await response.arrayBuffer());
      const expected = await readFile(join(root, "apps", client, "dist/index.html"));
      if (!response.ok || hash(body) !== hash(expected)) throw new Error(`${client} preview 未返回真实构建首页`);
      report.clients.push({ client, configurationBoundary: true, httpPreview: response.status, indexSha256: hash(body) });
    } finally {
      if (server) {
        server.httpServer.closeAllConnections();
        await new Promise((done, fail) => server.httpServer.close((error) => error ? fail(error) : done()));
      }
      await rm(fixture, { recursive: true, force: true });
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  try {
    const result = await verifyRuntimePreview({ runtimeRoot: args[0], nodeModulesRoot: args[1],
      clients: option("--clients", "web").split(","), targetOs: option("--target-os", process.platform), targetCpu: option("--target-cpu", process.arch) });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(`生产 preview 验证失败：${error.message}`); process.exitCode = 1; }
}
