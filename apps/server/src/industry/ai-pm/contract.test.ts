import { describe, expect, it } from "vitest";
import { CreatePmRunSchema, parseTeamPlan, parseModelJson, safeArtifactPath, validateEmployeeResult } from "./contract.js";

const task = (id: string, dependsOn: string[] = [], path = `${id}.md`) => ({
  id, presetKey: "doc-writer", goal: `完成${id}的明确文档目标`, dependsOn,
  acceptance: ["包含可测量验收标准"], outputRefs: [path],
});

describe("MC-PM-002 团队合同与DAG边界", () => {
  it("保留完整长目标，拒客户端作用域、根目录与额外字段", () => {
    const goal = "具有明确用户目标与可测试验收条件。".repeat(600);
    expect(CreatePmRunSchema.parse({ goal, idempotencyKey: "request-1" }).goal).toBe(goal);
    for (const extra of [{ tenantId: "other" }, { workspaceId: "other" }, { root: "/tmp" }, { pathRoot: "/tmp" }]) {
      expect(() => CreatePmRunSchema.parse({ goal, idempotencyKey: "request-1", ...extra })).toThrow();
    }
    expect(() => CreatePmRunSchema.parse({ goal: " ", idempotencyKey: "r" })).toThrow();
    expect(() => CreatePmRunSchema.parse({ goal: "x".repeat(32_001), idempotencyKey: "r" })).toThrow();
  });
  it("拓扑排序接受乱序输入，保留员工、验收和产物所有权", () => {
    const plan = parseTeamPlan({ tasks: [task("b", ["a"]), task("a")] }, ["doc-writer"]);
    expect(plan.map((item) => item.id)).toEqual(["a", "b"]);
    expect(plan[1]).toMatchObject({ presetKey: "doc-writer", dependsOn: ["a"], outputRefs: ["b.md"] });
  });
  it("拒环、自依赖、重复ID、缺依赖、无效员工和超过八节点", () => {
    const plans = [
      [task("a", ["b"]), task("b", ["a"])], [task("a", ["a"])],
      [task("a"), task("a", [], "other.md")], [task("a", ["missing"])],
      [{ ...task("a"), presetKey: "shell-operator" }],
      Array.from({ length: 9 }, (_, index) => task(`t${index}`)),
    ];
    for (const tasks of plans) expect(() => parseTeamPlan({ tasks }, ["doc-writer"])).toThrow();
  });
  it("拒跨员工同名、大小写与目录前缀写冲突", () => {
    for (const paths of [["PRD.md", "prd.md"], ["src", "src/app.js"], ["src/app.js", "src/app.js"]]) {
      expect(() => parseTeamPlan({ tasks: [task("a", [], paths[0]!), task("b", ["a"], paths[1]!)] }, ["doc-writer"])).toThrow();
    }
  });
  it("路径仅为安全相对路径，拒遍历、绝对、Windows、隐藏配置和控制符", () => {
    expect(safeArtifactPath("src/计算器.ts")).toBe("src/计算器.ts");
    for (const path of ["../secret", "/etc/passwd", "C:/file", "a\\b", "a/../b", ".env", "a/.git/config", "a//b", "a/", "a\u0000b", "https://example.com/a", "node_modules/pkg.js"]) {
      expect(() => safeArtifactPath(path), path).toThrow();
    }
  });
  it("模型JSON允许完整代码围栏但不猜测损坏响应", () => {
    expect(parseModelJson('```json\n{"tasks":[]}\n```')).toEqual({ tasks: [] });
    expect(() => parseModelJson('解释文字 {"tasks":[]}')).toThrow();
    expect(() => parseModelJson("")).toThrow();
  });
  it("交付必须有真实usage与全部声明产物，拒秘密、重复、空白、额外文件", () => {
    const good = { files: [{ path: "a.md", content: "实际产出的完整报告" }], summary: "报告已生成", usage: { promptTokens: 42, completionTokens: 20 }, modelId: "deepseek-flash" };
    expect(validateEmployeeResult(good, ["a.md"]).files).toHaveLength(1);
    for (const bad of [
      { ...good, usage: undefined }, { ...good, usage: { promptTokens: 0, completionTokens: 0 } },
      { ...good, files: [] }, { ...good, files: [{ path: "a.md", content: "   " }] },
      { ...good, files: [good.files[0], good.files[0]] },
      { ...good, files: [{ path: "b.md", content: "extra" }] },
      { ...good, files: [{ path: "a.md", content: `token=sk-${"f".repeat(32)}` }] },
      { ...good, files: [{ path: "a.md", content: "x".repeat(262_145) }] },
    ]) expect(() => validateEmployeeResult(bad, ["a.md"])).toThrow();
  });
});
