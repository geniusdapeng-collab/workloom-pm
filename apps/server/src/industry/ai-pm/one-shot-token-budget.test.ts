import { describe, expect, it } from "vitest";
import { oneShotTokenLimit } from "./service.js";

describe("one-shot employee output budgets", () => {
  it("allocates 8192 tokens to dependency-heavy and long document roles", () => {
    expect(oneShotTokenLimit("chief-pm", 6, true)).toBe(8192);
    expect(oneShotTokenLimit("doc-writer", 2, true)).toBe(8192);
    expect(oneShotTokenLimit("dev-orchestrator", 1, true)).toBe(8192);
    expect(oneShotTokenLimit("eval-master", 0, true)).toBe(8192);
  });

  it("keeps ordinary single-file and structured responses bounded", () => {
    expect(oneShotTokenLimit("requirement-analyst", 0, true)).toBe(3072);
    expect(oneShotTokenLimit("doc-writer", 1, true)).toBe(3072);
    expect(oneShotTokenLimit("chief-pm", 6, false)).toBe(4096);
  });
});
