import { test } from "node:test";
import { runGroup } from "./run-group.mjs";
test("MCD closure: actual assertions, no paid I/O", { timeout: 270000 }, async () => { await runGroup("closure"); });
