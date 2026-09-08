import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import MatrixMark from "../src/components/MatrixMark";

test("MatrixMark is a non-focusable decorative 25-dot motif, not a live loading announcement", async () => {
  const testWindow = new Window();
  try {
    testWindow.document.body.innerHTML = renderToStaticMarkup(<MatrixMark />);
    const mark = testWindow.document.querySelector("svg")!;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("focusable")).toBe("false");
    expect(mark.getAttribute("tabindex")).toBeNull();
    expect(mark.getAttribute("viewBox")).toBe("0 0 48 48");
    expect(
      testWindow.document.querySelector("[role], [aria-live], [aria-busy]"),
    ).toBeNull();

    const dots = [...mark.querySelectorAll("circle")];
    expect(dots).toHaveLength(25);
    expect(
      new Set(
        dots.map(
          (dot) => `${dot.getAttribute("cx")},${dot.getAttribute("cy")}`,
        ),
      ).size,
    ).toBe(25);
    // The CSS reveal can follow these three center-out rings without a timer,
    // live region, or loading-status semantics in the component.
    expect(
      [0, 1, 2].map(
        (ring) => mark.querySelectorAll(`circle[data-ring="${ring}"]`).length,
      ),
    ).toEqual([1, 8, 16]);
    expect(
      mark.querySelector('circle[cx="24"][cy="24"]')?.getAttribute("data-ring"),
    ).toBe("0");
  } finally {
    await testWindow.happyDOM.close();
  }
});
