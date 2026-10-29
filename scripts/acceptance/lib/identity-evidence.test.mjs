import test from "node:test";
import assert from "node:assert/strict";
import { agentIdentityEvidenceOk, agentProfileHeaderOk } from "./identity-evidence.mjs";

test("agent identity evidence ignores presentation whitespace but requires version and source", () => {
  const identity = "员工编号 编号已记录\n运行版本 第1.0版\n工作区 产品部\n来源行业包 ai-pm";
  assert.equal(agentIdentityEvidenceOk(identity, "第 1.0 版"), true);
  assert.equal(agentIdentityEvidenceOk(identity.replace("第1.0版", "第0.9版"), "第 1.0 版"), false);
  assert.equal(agentIdentityEvidenceOk(identity.replace("来源行业包", "来源未知"), "第 1.0 版"), false);
});

test("agent profile header accepts the current employee label and legacy member label", () => {
  assert.equal(agentProfileHeaderOk("员工档案 · 产品总监"), true);
  assert.equal(agentProfileHeaderOk("成员档案 · 产品总监"), true);
  assert.equal(agentProfileHeaderOk("档案列表"), false);
});
