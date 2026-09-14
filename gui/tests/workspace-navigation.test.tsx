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
import type { View } from "../src/app-routing";
import type { WorkspaceDestination } from "../src/components/WorkspaceNavigation";
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
let WorkspaceNavigation: typeof import("../src/components/WorkspaceNavigation").default;
let motion: typeof import("motion/react");

const Icon: WorkspaceDestination["icon"] = (props) => (
  <svg aria-hidden={props["aria-hidden"]} width={props.size} />
);
const destinations: readonly WorkspaceDestination[] = [
  { view: "dashboard", tkey: "nav.dashboard", icon: Icon },
  { view: "leveranciers", tkey: "nav.providers", icon: Icon },
  { view: "modellen", tkey: "nav.models", icon: Icon },
  { view: "verkeer", tkey: "nav.verkeer", icon: Icon },
  { view: "verbruik", tkey: "nav.usage", icon: Icon },
  { view: "systeem", tkey: "nav.systeem", icon: Icon },
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
  // Import Motion after the browser environment exists; do not mock its renderer/hooks.
  motion = await import("motion/react");
  WorkspaceNavigation = (await import("../src/components/WorkspaceNavigation"))
    .default;
});

beforeEach(async () => {
  testWindow.localStorage.setItem("ocx-lang", "en");
  testWindow.happyDOM.settings.device.prefersReducedMotion = "no-preference";
  testWindow.dispatchEvent(new testWindow.Event("resize"));
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
});

afterAll(() => {
  testWindow.happyDOM.settings.device.prefersReducedMotion = "no-preference";
  testWindow.dispatchEvent(new testWindow.Event("resize"));
  testWindow.close();
  for (const key of GLOBALS) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(children: ReactNode) {
  const { LazyMotion, domMax, MotionConfig } = motion;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <LazyMotion features={domMax} strict>
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </LazyMotion>
      </LanguageProvider>,
    );
  });
}

function buttons() {
  return [...host.querySelectorAll<HTMLButtonElement>("nav button")];
}

function StatefulNavigation({
  onNavigate,
}: {
  onNavigate: (view: View) => void;
}) {
  const [active, setActive] = useState<View>("dashboard");
  return (
    <WorkspaceNavigation
      destinations={destinations}
      active={active}
      onNavigate={(view) => {
        onNavigate(view);
        setActive(view);
      }}
    />
  );
}

describe("WorkspaceNavigation behavior", () => {
  test("preserves English destination labels and moves the sole aria-current marker with active", async () => {
    const onNavigate = () => {};
    await render(
      <WorkspaceNavigation
        destinations={destinations}
        active="dashboard"
        onNavigate={onNavigate}
      />,
    );
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("Views");
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Overview",
      "Providers & accounts",
      "Models",
      "Traffic",
      "Usage",
      "System",
    ]);
    expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(buttons()[0].getAttribute("aria-current")).toBe("page");
    await render(
      <WorkspaceNavigation
        destinations={destinations}
        active="modellen"
        onNavigate={onNavigate}
      />,
    );
    expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(buttons()[0].hasAttribute("aria-current")).toBe(false);
    expect(buttons()[2].getAttribute("aria-current")).toBe("page");
    for (const button of buttons()) {
      expect(button.type).toBe("button");
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
    }
  });

  test("preserves Dutch labels and routes every pointer destination exactly once", async () => {
    testWindow.localStorage.setItem("ocx-lang", "nl");
    const visits: View[] = [];
    await render(
      <StatefulNavigation onNavigate={(view) => visits.push(view)} />,
    );
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Overzicht",
      "Leveranciers",
      "Modellen",
      "Verkeer",
      "Verbruik",
      "Systeem",
    ]);
    for (const [index, destination] of destinations.entries()) {
      await act(async () => {
        buttons()[index].dispatchEvent(
          new testWindow.MouseEvent("click", {
            bubbles: true,
            detail: 1,
          }) as unknown as MouseEvent,
        );
      });
      expect(visits).toEqual(
        destinations.slice(0, index + 1).map((item) => item.view),
      );
      expect(buttons()[index].getAttribute("aria-current")).toBe("page");
      expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      expect(visits.at(-1)).toBe(destination.view);
    }
  });

  test("keyboard-origin click navigates once while preserving focus and native button semantics", async () => {
    const visits: View[] = [];
    await render(
      <StatefulNavigation onNavigate={(view) => visits.push(view)} />,
    );
    const target = buttons()[2];
    target.focus();
    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(0);
    // Browser keyboard activation produces click detail=0. Happy-dom does not
    // implement Enter/Space's native default action, so synthesize that click only.
    await act(async () => {
      target.dispatchEvent(
        new testWindow.MouseEvent("click", {
          bubbles: true,
          detail: 0,
        }) as unknown as MouseEvent,
      );
    });
    expect(visits).toEqual(["modellen"]);
    expect(target.getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(target);
    expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  test("renders and navigates with the real reduced-motion preference enabled", async () => {
    testWindow.happyDOM.settings.device.prefersReducedMotion = "reduce";
    // Happy-dom notifies MediaQueryList listeners on resize, including Motion's.
    testWindow.dispatchEvent(new testWindow.Event("resize"));
    expect(
      testWindow.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ).toBe(true);
    function PreferenceProbe() {
      return (
        <output data-reduced-motion>{String(motion.useReducedMotion())}</output>
      );
    }
    const visits: View[] = [];
    await render(
      <>
        <PreferenceProbe />
        <StatefulNavigation onNavigate={(view) => visits.push(view)} />
      </>,
    );
    expect(host.querySelector("[data-reduced-motion]")?.textContent).toBe(
      "true",
    );
    expect(buttons()).toHaveLength(6);
    await act(async () => {
      buttons()[5].click();
    });
    expect(visits).toEqual(["systeem"]);
    expect(buttons()[5].getAttribute("aria-current")).toBe("page");
    expect(buttons()[5].querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
