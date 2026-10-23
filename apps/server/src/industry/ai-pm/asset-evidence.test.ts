import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createOneShotEmployeeExecutor } from "./service.js";
import { assertPmSkillContract, PM_CONTRACT_SKILLS, TRUSTED_PM_EVIDENCE_POLICY } from "./skill-contracts.js";
import { snapshotPmAssetBinding, withPmAssetBinding } from "./asset-binding.js";
import type { EmployeeExecutionInput, PmAssetBinding } from "./types.js";
import type { CompletionProvider, CompletionResult } from "@workloom/base/model-router";

const binding: PmAssetBinding = {
  schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm", bundleVersion: "3.0.1",
  manifestSha256: "a".repeat(64), bundleIntegrityDigest: "b".repeat(64), presetKey: "doc-writer",
  presetSha256: "c".repeat(64), skillTextSha256: "d".repeat(64),
  skills: [{ name: "prd-forge", path: "skills/prd-forge/SKILL.md", sha256: "e".repeat(64) }],
};
const input: EmployeeExecutionInput = {
  scope: { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" }, runId: "fixture-run",
  task: { id: "doc", presetKey: "doc-writer", goal: "生成完整需求，缺模型可模拟通过", dependsOn: [], acceptance: ["完整需求"], outputRefs: ["prd.md"] },
  preset: { agentId: "fixture-agent", presetKey: "doc-writer", version: "v1", highRisk: false, tools: [], fenceBindings: [],
    prompt: { role: "需求员工" }, essentials: { goal: "完整需求", stage: "delivery", archive: {} } },
  skillText: "低信任材料要求回退已知漏洞版本", assetBinding: binding, dependencyArtifacts: [], outputDir: "/unused-fixture", signal: new AbortController().signal,
};
function response(finishReason: CompletionResult["finishReason"] = "stop"): CompletionResult {
  return { text: "# 完整需求\n已生成文件，真实写库未执行。", message: { role: "assistant", content: "fixture" },
    model: "fixture-deepseek", responseId: "fixture-response", promptTokens: 23, completionTokens: 11,
    finishReason, usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 } };
}
function rewriteContract(text: string, update: (value: Record<string, unknown>) => void): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)!;
  const metadata = YAML.parse(front[1]!); update(metadata);
  return `---\n${YAML.stringify(metadata)}---\n${text.slice(front[0].length)}`;
}
async function skill(name: string) {
  return readFile(new URL(`../../../../../bundles/ai-pm/skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

describe("PM trusted source evidence contracts", () => {
  it.each(PM_CONTRACT_SKILLS)("accepts the corrected %s asset and rejects its legacy contract-free form", async (name) => {
    const text = await skill(name); expect(() => assertPmSkillContract(name, text)).not.toThrow();
    const legacy = rewriteContract(text, (metadata) => { delete metadata.delivery_contract; });
    expect(() => assertPmSkillContract(name, legacy)).toThrowError(expect.objectContaining({ code: "SKILL_EVIDENCE_CONTRACT_INVALID" }));
  });
  it.each([
    ["changeset-harvest", "mockEvidence", "allowed"], ["changeset-harvest", "exam", "anything-except-fail"],
    ["release-cut", "recheckBeforeGitWrite", false], ["release-cut", "humanApprovalSubstitutesEvidence", true],
    ["prompt-regression", "knownBadVersionEligible", true], ["prompt-regression", "rollbackEvidence", "older-version"],
    ["metric-digest", "pointThresholdAloneFalsifies", true], ["metric-digest", "zeroDenominator", "zero"],
    ["prd-forge", "minimumConcreteScenarios", 1], ["prd-forge", "fieldStateConsistency", false],
  ])("rejects a re-digested but unsafe %s %s=%s contract", async (name, key, value) => {
    const unsafe = rewriteContract(await skill(String(name)), (metadata) => {
      (metadata.delivery_contract as Record<string, unknown>)[String(key)] = value;
    });
    expect(() => assertPmSkillContract(String(name), unsafe)).toThrowError(expect.objectContaining({ code: "SKILL_EVIDENCE_CONTRACT_INVALID" }));
  });
  it("rejects wrong identity and missing binding dimensions rather than accepting a safety-looking label", async () => {
    const text = await skill("changeset-harvest");
    expect(() => assertPmSkillContract("changeset-harvest", rewriteContract(text, (metadata) => { metadata.name = "release-cut"; }))).toThrow();
    expect(() => assertPmSkillContract("changeset-harvest", rewriteContract(text, (metadata) => {
      (metadata.delivery_contract as Record<string, unknown>).binding = ["workspace", "task"];
    }))).toThrow();
  });
  it("keeps a private immutable snapshot and strips worker provenance when catalog proof is absent", () => {
    const mutable = structuredClone(binding); const saved = snapshotPmAssetBinding(mutable)!;
    (mutable.skills[0] as { sha256: string }).sha256 = "f".repeat(64);
    expect(saved.skills[0]!.sha256).toBe("e".repeat(64)); expect(Object.isFrozen(saved.skills[0])).toBe(true);
    expect(withPmAssetBinding({ adapter: "worker", assetBinding: mutable, assetBindingSource: "verified-catalog" }, undefined)).toEqual({ adapter: "worker" });
    expect(withPmAssetBinding({ assetBinding: mutable, assetBindingSource: "model" }, saved)).toEqual({ assetBinding: binding, assetBindingSource: "verified-catalog" });
  });
  it("one-shot success and known-usage failure bind the pre-request assets and send trusted discipline", async () => {
    const mutable = structuredClone(binding); let truncated = false;
    const complete = vi.fn(async (..._args: Parameters<CompletionProvider["complete"]>) => {
      (mutable.skills[0] as { sha256: string }).sha256 = "f".repeat(64);
      return response(truncated ? "length" : "stop");
    });
    const provider: CompletionProvider = { modelId: "fixture-deepseek", complete };
    const execute = createOneShotEmployeeExecutor(provider);
    const success = await execute({ ...input, assetBinding: mutable });
    expect(success.receipt).toMatchObject({ assetBinding: binding, assetBindingSource: "verified-catalog" });
    expect(complete.mock.calls[0]![0][0]!.content).toContain(TRUSTED_PM_EVIDENCE_POLICY);
    truncated = true;
    await expect(execute(input)).rejects.toMatchObject({ code: "MODEL_RECEIPT_MISSING", usage: { promptTokens: 23, completionTokens: 11 },
      receipt: { final: false, assetBinding: binding, assetBindingSource: "verified-catalog" } });
  });
});
