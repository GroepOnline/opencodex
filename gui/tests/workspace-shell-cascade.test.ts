import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const shell = await Bun.file(
  new URL("../src/styles/workspace-orbit.css", import.meta.url),
).text();
const finish = await Bun.file(
  new URL("../src/styles/ocx-system.css", import.meta.url),
).text();

function rulesFor(css: string, selector: string, media?: string) {
  const win = new Window();
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync(css);
  const found: string[] = [];
  for (const rule of sheet.cssRules) {
    if (rule instanceof win.CSSMediaRule) {
      if (rule.conditionText !== media) continue;
      for (const child of rule.cssRules) {
        if (
          child instanceof win.CSSStyleRule &&
          child.selectorText.split(",").some((part) => part.trim() === selector)
        ) {
          found.push(child.style.cssText);
        }
      }
    } else if (
      !media &&
      rule instanceof win.CSSStyleRule &&
      rule.selectorText.split(",").some((part) => part.trim() === selector)
    ) {
      found.push(rule.style.cssText);
    }
  }
  win.close();
  return found.join(" ");
}

test("the finishing layer does not override shell gutters or navigation geometry", () => {
  expect(rulesFor(finish, ".ocx-workspace .topbar")).not.toMatch(
    /padding|gap:/,
  );
  expect(rulesFor(finish, ".ocx-workspace .main-inner")).toBe("");
  expect(
    rulesFor(finish, ".workspace-navigation .workspace-destination"),
  ).not.toMatch(/padding|min-height/);
  expect(
    rulesFor(shell, ".workspace-navigation .workspace-destination"),
  ).toContain("min-height: var(--control-touch)");
  expect(rulesFor(shell, ".ocx-workspace .topbar")).toContain(
    "var(--page-gutter)",
  );
  expect(rulesFor(shell, ".ocx-workspace .main-inner")).toContain(
    "var(--page-gutter)",
  );
});

test("mobile pages share a gutter and tabs wrap without shrinking touch targets", () => {
  const mobile = "(max-width: 760px)";
  const regular = rulesFor(shell, ".ocx-workspace .main-inner", mobile);
  const combos = rulesFor(
    shell,
    ".ocx-workspace .main-inner.main-inner--combos",
    mobile,
  );
  expect(regular).not.toBe("");
  expect(combos).toBe(regular);
  expect(regular).toContain("var(--page-gutter)");
  expect(rulesFor(finish, ".ocx-workspace .sub-tabs", mobile)).toContain(
    "flex-wrap: wrap",
  );
  for (const selector of [
    ".ocx-workspace .sub-tab",
    ".ocx-workspace .topbar .gbtn",
  ]) {
    expect(rulesFor(finish, selector, mobile)).toContain(
      "min-height: var(--control-touch)",
    );
    expect(rulesFor(finish, selector, mobile)).toContain(
      "min-width: var(--control-touch)",
    );
  }
});
