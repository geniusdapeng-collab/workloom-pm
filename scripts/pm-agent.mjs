#!/usr/bin/env node
/** PM JSON CLI. Credentials are accepted only from the process environment. */
import { open } from "node:fs/promises";
import { COMMANDS, MAX_INPUT_BYTES, PmClient, PmClientError, errorPayload } from "./pm-agent-client.mjs";

async function boundedInput(file) {
  let stream, handle;
  try {
    if (file === "-") stream = process.stdin;
    else { handle = await open(file, "r"); stream = handle.createReadStream({ autoClose: false }); }
    const chunks = []; let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_INPUT_BYTES) throw new PmClientError("INPUT_TOO_LARGE", "PM CLI input exceeds 256 KiB", 2);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new PmClientError("INVALID_INPUT", "PM CLI input must contain exactly one JSON object", 2); }
  } catch (error) {
    if (error instanceof PmClientError) throw error;
    throw new PmClientError("INPUT_READ_FAILED", "PM CLI could not read its JSON input", 2);
  } finally { if (handle) await handle.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" && args.length === 0) {
    process.stdout.write(JSON.stringify({ commands: Object.keys(COMMANDS), usage: "node scripts/pm-agent.mjs <command> [--input-file <path|->]",
      environment: ["PM_BASE_URL or WORKLOOM_BASE_URL", "WORKLOOM_ACCESS_TOKEN"], modelCredentials: "backend only", autoResume: false }) + "\n");
    return;
  }
  if (!Object.hasOwn(COMMANDS, command ?? "") || !(args.length === 0 || args.length === 2 && args[0] === "--input-file" && args[1])) {
    throw new PmClientError("USAGE", "Use a PM command and optionally --input-file <path|->; base URLs and credentials are environment-only", 2);
  }
  const input = args.length ? await boundedInput(args[1]) : {};
  const client = new PmClient();
  process.stdout.write(JSON.stringify(await client.invoke(command, input)) + "\n");
}

try { await main(); }
catch (error) { process.stderr.write(JSON.stringify(errorPayload(error)) + "\n"); process.exitCode = error instanceof PmClientError ? error.exitCode : 1; }
