import { test } from "node:test";
import { runGroup } from "./run-group.mjs";
test("MCD guest_access: formal login link with unchanged server authorization", { timeout: 270000 }, async () => { await runGroup("guest_access"); });
