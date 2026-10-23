import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const MAX_BYTES = 32 * 1024 * 1024;
export interface DevContentSnapshot {
  schema: "workloom.dev-content/v1";
  head: string;
  trackedDiffSha256: string;
  untracked: Array<{ path: string; type: "file" | "symlink"; mode: number; size: number; sha256: string }>;
  sha256: string;
}

function gitRead(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((done, reject) => {
    execFile("git", args, { cwd, encoding: "buffer", timeout: 30_000, maxBuffer: MAX_BYTES }, (error, stdout) => {
      // Do not include git output or file content in an error: it may contain a credential.
      if (error) reject(new Error(`工作区内容指纹读取失败（git ${args[0]}）`, { cause: error }));
      else done(stdout);
    });
  });
}

/** Read-only proof of the exact material git add -A would release; never follows a new symlink. */
export async function captureDevContent(worktreePath: string): Promise<DevContentSnapshot> {
  const root = await realpath(worktreePath);
  const gitRoot = (await gitRead(root, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  if (await realpath(gitRoot) !== root) throw new Error("工作区内容指纹必须从隔离仓库根目录读取");
  const head = (await gitRead(root, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("工作区内容指纹没有有效 HEAD");
  const index = await gitRead(root, ["ls-files", "--stage", "-z"]);
  if (index.toString("utf8").split("\0").some((entry) => entry.startsWith("160000 "))) {
    throw new Error("工作区包含子模块，当前发布内容指纹不支持子模块内部改动");
  }
  // HEAD binds all committed material; the binary patch includes staged and unstaged tracked content and modes.
  const tracked = await gitRead(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", "HEAD", "--"]);
  const list = await gitRead(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const decoded = list.toString("utf8");
  if (!Buffer.from(decoded).equals(list)) throw new Error("工作区含非 UTF-8 文件名，内容指纹未验证");
  const paths = decoded.split("\0").filter(Boolean).sort();
  if (new Set(paths).size !== paths.length || paths.length > 10_000) throw new Error("工作区未跟踪文件清单无效或超限");
  const untracked: DevContentSnapshot["untracked"] = [];
  const identities: Array<{ file: string; ino: number; dev: number; size: number; mtimeMs: number; ctimeMs: number }> = [];
  let bytes = tracked.length;
  for (const path of paths) {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || path.includes("\\") || await realpath(dirname(file)) !== dirname(file)) {
      throw new Error("工作区未跟踪文件路径越界或父目录为符号链接");
    }
    const info = await lstat(file);
    identities.push({ file, ino: info.ino, dev: info.dev, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
    let value: Buffer;
    let type: "file" | "symlink";
    if (info.isSymbolicLink()) {
      type = "symlink";
      value = Buffer.from(await readlink(file), "utf8");
    } else if (info.isFile()) {
      type = "file";
      if (info.size + bytes > MAX_BYTES) throw new Error("工作区内容指纹超过字节上限");
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev) throw new Error("工作区内容读取期间发生文件替换");
        value = await handle.readFile();
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("工作区内容读取期间发生改写");
      } finally { await handle.close(); }
    } else throw new Error("工作区包含不支持的文件类型，内容指纹未验证");
    bytes += value.length;
    if (bytes > MAX_BYTES) throw new Error("工作区内容指纹超过字节上限");
    untracked.push({ path, type, mode: info.mode & 0o777, size: value.length, sha256: sha256(value) });
  }
  // Refuse a moving target rather than claiming a partially read snapshot is stable.
  const finalHead = (await gitRead(root, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
  const finalList = await gitRead(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const finalTracked = await gitRead(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", "HEAD", "--"]);
  if (finalHead !== head || !finalList.equals(list) || !finalTracked.equals(tracked)) throw new Error("工作区内容在采集指纹期间发生变化");
  for (const previous of identities) {
    const current = await lstat(previous.file);
    if ((["ino", "dev", "size", "mtimeMs", "ctimeMs"] as const).some((key) => current[key] !== previous[key])) {
      throw new Error("工作区未跟踪文件在采集指纹期间发生变化");
    }
  }
  const body = { schema: "workloom.dev-content/v1" as const, head, trackedDiffSha256: sha256(tracked), untracked };
  return { ...body, sha256: sha256(canonical(body)) };
}

export function validDevContent(value: unknown): value is DevContentSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.schema !== "workloom.dev-content/v1" || typeof item.head !== "string" || !/^[0-9a-f]{40,64}$/.test(item.head)
    || typeof item.trackedDiffSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.trackedDiffSha256)
    || typeof item.sha256 !== "string" || !Array.isArray(item.untracked) || item.untracked.length > 10_000) return false;
  if (!item.untracked.every((entry) => entry && typeof entry === "object" && typeof entry.path === "string"
    && ["file", "symlink"].includes(entry.type) && Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777
    && Number.isSafeInteger(entry.size) && entry.size >= 0 && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256))) return false;
  const body = { schema: item.schema, head: item.head, trackedDiffSha256: item.trackedDiffSha256, untracked: item.untracked };
  return sha256(canonical(body)) === item.sha256;
}
