import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventIdChip } from "./EventIdChip";

describe("EventIdChip interaction nesting", () => {
  it("renders a span when an interactive parent already owns the click action", () => {
    const html = renderToStaticMarkup(<EventIdChip id="E-SEED-8801" interactive={false} />);
    expect(html).toMatch(/^<span/);
    expect(html).not.toContain("<button");
  });

  it("keeps button semantics and the explicit label in standalone use", () => {
    const html = renderToStaticMarkup(<EventIdChip id="E-SEED-8801" />);
    expect(html).toMatch(/^<button/);
    expect(html).toContain("aria-label");
    expect(html).toContain("点击展开决策链路");
  });
});
