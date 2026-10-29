import { describe, expect, it } from "vitest";
import { assistantBusinessDate } from "./business-time.js";

describe("assistant business date", () => {
  it("uses the Asia/Shanghai calendar date instead of the UTC date", () => {
    expect(assistantBusinessDate(new Date("2026-10-29T17:18:28.000Z"))).toBe("2026-10-30");
  });

  it("crosses the Shanghai date boundary independently of the host timezone", () => {
    expect(assistantBusinessDate(new Date("2026-12-31T16:00:00.000Z"))).toBe("2027-01-01");
  });
});
