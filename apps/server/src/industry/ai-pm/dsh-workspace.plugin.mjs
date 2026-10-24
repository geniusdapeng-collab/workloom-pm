/**
 * Trusted DSH tools for one AI-PM task. No shell, dynamic imports, HTTP, or
 * process execution is exposed to the model. Inputs are read-only and writes
 * are confined to the exact output paths allocated by the team planner.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const name = "workloom-pm-workspace";
export const inject = ["tools"];
export const TOOL_NAMES = Object.freeze(["list_files", "read_file", "write_file"]);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

function fail(message) { throw new Error(`PM_WORKSPACE_DENIED: ${message}`); }

function relativePath(value, allowRoot = false) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || isAbsolute(value) || value.split("/").some((part) => part === ".." || !part)) fail("a relative task path is required");
  if (value === "." && allowRoot) return value;
  if (value.split("/").some((part) => part === ".")) fail("dot path segments are forbidden");
  return value;
}

/** Resolve every existing ancestor immediately before I/O; never follow links. */
async function taskPath(root, value, allowRoot = false) {
  const path = relativePath(value, allowRoot);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) fail("path escaped the task workspace");
  let cursor = root;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) fail("invalid workspace root");
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) fail("symbolic links are forbidden");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

export function apply(ctx, config = {}) {
  const root = resolve(config.workspaceRoot ?? "");
  if (!isAbsolute(config.workspaceRoot ?? "")) fail("workspaceRoot must be absolute");
  if (!Array.isArray(config.outputRefs) || config.outputRefs.length < 1 || config.outputRefs.length > 12) fail("invalid output ownership");
  const outputs = new Set(config.outputRefs.map((path) => relativePath(path)));
  if (outputs.size !== config.outputRefs.length || [...outputs].some((path) => path === "inputs" || path.startsWith("inputs/"))) fail("duplicate or reserved outputs");
  const callLimit = config.maxToolCalls ?? 40;
  if (!Number.isSafeInteger(callLimit) || callLimit < 1 || callLimit > 200) fail("invalid tool-call budget");
  let calls = 0;
  const allowed = new Set(TOOL_NAMES);
  ctx.tools.guard((exec) => {
    if (!allowed.has(exec.name)) return "PM_WORKSPACE_DENIED: tool is outside the task capability allowlist";
    calls += 1;
    if (calls > callLimit) return "PM_WORKSPACE_DENIED: task tool-call budget exhausted";
    return undefined;
  });

  const output = { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] };
  const register = (definition) => ctx.tools.register({ ...definition, output });
  register({
    name: "list_files",
    description: "List regular files inside this task workspace. Inputs are read-only. This tool cannot inspect the host computer.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative directory, or . for task root" } }, additionalProperties: false },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const directory = await taskPath(root, args?.path ?? ".", true);
      const files = [];
      async function walk(current) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          exec.signal.throwIfAborted();
          if (entry.isSymbolicLink()) fail("symbolic links are forbidden");
          const path = join(current, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
          else fail("non-regular workspace entry");
          if (files.length > 200) fail("workspace file-count limit exceeded");
        }
      }
      await walk(directory);
      return JSON.stringify({ files: files.sort(), writable: [...outputs].sort() });
    },
  });
  register({
    name: "read_file",
    description: "Read a UTF-8 regular file inside this task workspace. Use paths from inputs/context.json for upstream employee deliverables.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const target = await taskPath(root, args?.path);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) fail("file is not regular or exceeds 256 KiB");
        const content = await handle.readFile({ encoding: "utf8", signal: exec.signal });
        if (content.includes("\u0000")) fail("binary files are not supported");
        return JSON.stringify({ path: args.path, content });
      } finally { await handle.close(); }
    },
  });
  register({
    name: "write_file",
    description: "Write a complete UTF-8 deliverable to one exact outputRefs path assigned to this employee. This cannot write inputs, other employees' artifacts, or host files.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const path = relativePath(args?.path);
      if (!outputs.has(path)) fail("this employee does not own that output path");
      if (typeof args?.content !== "string" || !args.content.trim() || args.content.includes("\u0000")) fail("a nonempty UTF-8 document is required");
      const bytes = Buffer.byteLength(args.content);
      if (bytes > MAX_FILE_BYTES) fail("file exceeds 256 KiB");
      let total = bytes;
      for (const existing of outputs) {
        if (existing === path) continue;
        try { total += (await stat(await taskPath(root, existing))).size; }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      if (total > MAX_TOTAL_BYTES) fail("task outputs exceed 1 MiB");
      let target = await taskPath(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      target = await taskPath(root, path);
      exec.signal.throwIfAborted();
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(args.content, { encoding: "utf8", signal: exec.signal }); }
      finally { await handle.close(); }
      return JSON.stringify({ path, bytes, written: true });
    },
  });
}
