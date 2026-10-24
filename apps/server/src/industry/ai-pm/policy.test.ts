import { describe, expect, it } from "vitest";
import type { AssembledPreset } from "@workloom/runtime";
import { judgeSandboxArtifact, PM_SANDBOX_POLICY_VERSION } from "./policy.js";
import { bundlesRoot, loadVerifiedBundleWorkforcePresets } from "@workloom/base/bundles";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { RuntimeRule } from "@workloom/base/fence-engine";

const preset: AssembledPreset = {
  agentId: "a-doc", presetKey: "doc-writer", version: "v1", highRisk: false,
  fenceBindings: ["R-PM6"], tools: [{ name: "documents.write", access: "write", desc: "文档初稿" }],
  prompt: { role: "文档员工" }, essentials: { archive: { industry: "ai-pm" }, stage: "ready", goal: "文档" },
};

describe("MC-PM-002 独立沙箱策略与原围栏最严合并", () => {
  it("只授权真实controller的隔离产物，记录声明能力但不伪称业务执行", () => {
    const result = judgeSandboxArtifact(preset, [], { internalSandbox: true });
    expect(result.level).toBe("auto");
    expect(result.declaredCapability).toBe("documents.write");
    expect(result.action).toBe("pm.sandbox.artifact.write");
    expect(result.policyVersion).toBe(PM_SANDBOX_POLICY_VERSION);
  });
  it("原围栏block/review优先，不存在未命中默认auto", () => {
    for (const level of ["block", "review"] as const) {
      const result = judgeSandboxArtifact(preset, [{ rule_id: "customer-tighten", name: "客户收紧", version: "v1", is_baseline: true,
        objectTypes: ["pm_sandbox_artifact"], actions: ["pm.sandbox.artifact.write"], when: "", level }], { internalSandbox: true });
      expect(result.level).toBe(level);
    }
    expect(judgeSandboxArtifact(preset, [], { internalSandbox: false }).level).toBe("review");
  });
  it("拒没有声明产出能力的员工，不授予外发/生产/主干工具", () => {
    expect(() => judgeSandboxArtifact({ ...preset, tools: [] }, [], { internalSandbox: true })).toThrow();
    expect(() => judgeSandboxArtifact({ ...preset, presetKey: "unknown" }, [], { internalSandbox: true })).toThrow();
    expect(judgeSandboxArtifact(preset, [], { internalSandbox: true, external: true }).level).toBe("block");
    expect(judgeSandboxArtifact(preset, [], { internalSandbox: true, production: true }).level).toBe("block");
  });
  it("逐个校验真实14岗资产和原始14条基线，能力映射均来自各岗位自己的写工具", () => {
    const assets = loadVerifiedBundleWorkforcePresets("ai-pm");
    const raw = YAML.parse(readFileSync(join(bundlesRoot(), "ai-pm/fences/ai-pm-baseline.yml"), "utf8")) as {
      version: string; fences: Array<{ rule_id: string; name: string; level: RuntimeRule["level"]; match: { object_types: string[]; actions: string[]; when?: string } }>;
    };
    const baseline = raw.fences.map((rule) => ({ rule_id: rule.rule_id, name: rule.name, level: rule.level,
      version: raw.version, is_baseline: true, objectTypes: rule.match.object_types, actions: rule.match.actions, when: rule.match.when ?? "" }));
    expect(assets).toHaveLength(14); expect(baseline).toHaveLength(14);
    for (const asset of assets) {
      expect(asset.readonly, asset.preset_key).toBe(false);
      const actual: AssembledPreset = { agentId: `fixture-${asset.preset_key}`, presetKey: asset.preset_key, version: asset.version,
        highRisk: asset.high_risk, fenceBindings: asset.fence_bindings, tools: asset.tools, prompt: asset.prompt,
        essentials: { archive: { profileValidated: true }, stage: "ready", goal: "在隔离目录起草该岗位职责对应的内部文件" } };
      const result = judgeSandboxArtifact(actual, baseline, { internalSandbox: true });
      expect(result.level, asset.preset_key).toBe("auto");
      expect(asset.tools.some((tool) => tool.name === result.declaredCapability && tool.access === "write"), asset.preset_key).toBe(true);
      expect(result.action).toBe("pm.sandbox.artifact.write");
      expect(judgeSandboxArtifact(actual, baseline, { internalSandbox: true, external: true }).level, asset.preset_key).toBe("block");
    }
  });
});
