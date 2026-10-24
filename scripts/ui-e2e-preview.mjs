#!/usr/bin/env node
/**
 * Bundle the existing DEV-only UI contract before browser matrix tests.
 * Repeated full-page navigation must not reload the entire Vite source graph.
 * This is an isolated development build, not the production dist or a deployer.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = process.argv[2];
if (process.argv.length !== 3 || !["web", "webb", "webc"].includes(client)) {
  process.stderr.write("UI preview requires exactly one known client: web, webb or webc\n");
  process.exit(2);
}

const directory = join(root, "apps", client);
const vite = join(directory, "node_modules", "vite", "bin", "vite.js");
// Keep normal production dist untouched. The output is ignored and is never
// selected by packaging scripts, which consume apps/*/dist explicitly.
const output = join(root, "node_modules", ".cache", "workloom-ui-e2e", client);
const environment = { ...process.env, NODE_ENV: "development" };
let active;
let stopping = false;
const signals = ["SIGINT", "SIGTERM"];
const stop = (signal) => {
  stopping = true;
  if (active && !active.killed) active.kill(signal);
};
for (const signal of signals) process.on(signal, () => stop(signal));

function invoke(arguments_) {
  return new Promise((resolveCode, reject) => {
    active = spawn(process.execPath, [vite, ...arguments_], {
      cwd: directory,
      env: environment,
      stdio: "inherit",
    });
    active.once("error", () => reject(new Error("UI preview could not start the Vite child")));
    active.once("exit", (code, signal) => {
      active = undefined;
      resolveCode(code ?? (signal ? 128 : 1));
    });
  });
}

try {
  // NODE_ENV controls import.meta.env.DEV independently of Vite's mode. Keeping
  // DEV preserves the tested developer login and explicit /dev diagnostic gate.
  // https://vite.dev/guide/env-and-mode
  const built = await invoke(["build", "--mode", "development", "--outDir", output, "--emptyOutDir"]);
  if (built !== 0 || stopping) process.exitCode = built || 128;
  else {
    const preview = await invoke(["preview", "--outDir", output, "--host", "127.0.0.1", "--strictPort"]);
    process.exitCode = stopping ? 128 : preview;
  }
} catch {
  process.stderr.write("UI preview failed before serving a complete development bundle\n");
  process.exitCode = 1;
}
