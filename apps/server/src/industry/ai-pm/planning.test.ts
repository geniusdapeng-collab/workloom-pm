import { describe, expect, it } from "vitest";
import type { PmTaskPlan } from "./types.js";
import { reconcilePmTeamPlan } from "./planning.js";

const employees = [
  "chief-pm",
  "requirement-analyst",
  "user-listener",
  "doc-writer",
  "dev-orchestrator",
  "eval-master",
  "release-guardian",
];

function task(
  id: string,
  presetKey: string,
  outputRefs: string[],
  dependsOn: string[] = [],
): PmTaskPlan {
  return {
    id,
    presetKey,
    goal: `真实任务 ${id}`,
    dependsOn,
    acceptance: [`验收 ${id}`],
    outputRefs,
  };
}

describe("PM task-plan business ownership", () => {
  it("reassigns a code artifact from a document employee to the development orchestrator", () => {
    const result = reconcilePmTeamPlan([
      task("implementation", "doc-writer", ["src/todo.mjs", "todo.test.mjs"]),
    ], { primaryOwner: "dev-orchestrator", allowedEmployees: employees });

    expect(result.plan[0]?.presetKey).toBe("dev-orchestrator");
    expect(result.plan[0]?.dependsOn).toEqual([]);
    expect(result.corrections[0]).toMatchObject({
      taskId: "implementation",
      from: "doc-writer",
      to: "dev-orchestrator",
    });
  });

  it("keeps an explicitly allowed requirement/document owner and preserves the DAG", () => {
    const input = [
      task("requirements", "requirement-analyst", ["requirements/acceptance.md"]),
      task("prd", "requirement-analyst", ["prd.md"], ["requirements"]),
    ];
    const result = reconcilePmTeamPlan(input, { primaryOwner: "requirement-analyst", allowedEmployees: employees });

    expect(result.corrections).toEqual([]);
    expect(result.plan).toEqual(input);
  });

  it("rejects a task that mixes code and evaluation ownership before any employee runs", () => {
    expect(() => reconcilePmTeamPlan([
      task("mixed", "dev-orchestrator", ["src/todo.mjs", "eval/report.md"]),
    ], { allowedEmployees: employees })).toThrow("必须拆分");
  });

  it("requires the semantic primary employee to participate in a team plan", () => {
    expect(() => reconcilePmTeamPlan([
      task("analysis", "requirement-analyst", ["requirements/acceptance.md"]),
    ], { primaryOwner: "user-listener", allowedEmployees: employees })).toThrow("主责岗位 user-listener");
  });

  it("does not guess ownership from an unknown filename", () => {
    const input = [task("result", "doc-writer", ["result.md"])];
    expect(reconcilePmTeamPlan(input, { allowedEmployees: employees }).plan).toEqual(input);
  });
});
