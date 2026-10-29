import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PC entry offline readiness", () => {
  it("does not block first paint on a third-party stylesheet", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const stylesheetLinks = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((match) => match[0]);
    expect(stylesheetLinks.filter((tag) => /href="https?:\/\//i.test(tag))).toEqual([]);
    expect(html).not.toContain("fonts.googleapis.com");
  });
});
