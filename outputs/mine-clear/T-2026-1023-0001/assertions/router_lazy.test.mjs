import {test} from "node:test";
import {runGroup} from "./run-group.mjs";
test("MCD router_lazy: actual auth-only module loading without eager PM database service",{timeout:270000},async()=>{await runGroup("router_lazy")});
