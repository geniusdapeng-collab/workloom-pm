import {test} from "node:test";
import {runGroup} from "./run-group.mjs";
test("MCD runtime_preview: actual native HTTP from locked npm stage without Vitest",{timeout:270000},async()=>{await runGroup("runtime_preview")});
