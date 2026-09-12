import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { WorkspaceSubTab } from "../src/components/WorkspaceSubTabs";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "SVGElement",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let testWindow: Window;
let root: Root;
let host: HTMLDivElement;
let WorkspaceSubTabs: typeof import("../src/components/WorkspaceSubTabs").default;
let motion: typeof import("motion/react");

const tabs: readonly WorkspaceSubTab[] = [
  { sub: null, tkey: "sub.overview" },
  { sub: "claude", tkey: "nav.claude" },
  { sub: "grok", tkey: "nav.grok" },
];

beforeAll(async () => {
  for (const key of GLOBALS)
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  testWindow = new Window({
    url: "http://localhost/",
    settings: { device: { prefersReducedMotion: "no-preference" } },
  });
  Object.defineProperties(
    globalThis,
    Object.fromEntries(
      GLOBALS.map((key) => [
        key,
        {
          configurable: true,
          writable: true,
          value:
            key === "IS_REACT_ACT_ENVIRONMENT"
              ? true
              : key === "window"
                ? testWindow
                : Reflect.get(testWindow, key),
        },
      ]),
    ),
  );
  await seedDicts();
  motion = await import("motion/react");
  WorkspaceSubTabs = (await import("../src/components/WorkspaceSubTabs")).default;
});

beforeEach(async () => {
  testWindow.localStorage.setItem("ocx-lang", "en");
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
});

afterAll(() => {
  testWindow.close();
  for (const key of GLOBALS) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(children: ReactNode) {
  const { LazyMotion, domAnimation, MotionConfig } = motion;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <LazyMotion features={domAnimation} strict>
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </LazyMotion>
      </LanguageProvider>,
    );
  });
}

function buttons() {
  return [...host.querySelectorAll<HTMLButtonElement>("nav button")];
}

function StatefulSubTabs({ onNavigate }: { onNavigate: (sub: string | null) => void }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <WorkspaceSubTabs
      tabs={tabs}
      active={active}
      label="Providers"
      onNavigate={(sub) => {
        onNavigate(sub);
        setActive(sub);
      }}
    />
  );
}

describe("WorkspaceSubTabs", () => {
  test("renders every destination with one aria-current marker and one selection pill", async () => {
    await render(<StatefulSubTabs onNavigate={() => {}} />);
    const nav = host.querySelector("nav.sub-tabs");
    expect(nav?.getAttribute("aria-label")).toBe("Providers");
    expect(buttons().map((b) => b.textContent)).toEqual(["Overview", "Claude", "Grok"]);
    expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(host.querySelectorAll(".sub-tab-indicator")).toHaveLength(1);
    expect(buttons()[0]?.querySelector(".sub-tab-indicator")).not.toBeNull();
  });

  test("moves the selection pill and reports the chosen sub-view on activation", async () => {
    const seen: (string | null)[] = [];
    await render(<StatefulSubTabs onNavigate={(sub) => seen.push(sub)} />);
    await act(async () => {
      buttons()[1]?.click();
    });
    expect(seen).toEqual(["claude"]);
    expect(buttons()[1]?.classList.contains("active")).toBe(true);
    expect(buttons()[1]?.getAttribute("aria-current")).toBe("page");
    expect(buttons()[0]?.getAttribute("aria-current")).toBeNull();
    expect(host.querySelectorAll(".sub-tab-indicator")).toHaveLength(1);
    expect(buttons()[1]?.querySelector(".sub-tab-indicator")).not.toBeNull();
    await act(async () => {
      buttons()[0]?.click();
    });
    expect(seen).toEqual(["claude", null]);
    expect(buttons()[0]?.querySelector(".sub-tab-indicator")).not.toBeNull();
  });

  test("keeps the indicator decorative for assistive technology", async () => {
    await render(<StatefulSubTabs onNavigate={() => {}} />);
    const indicator = host.querySelector(".sub-tab-indicator");
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.textContent).toBe("");
  });
});
