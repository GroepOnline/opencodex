import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, lazy, Suspense } from "react";
import type { Root } from "react-dom/client";
import ErrorBoundary from "../src/components/ErrorBoundary";

const globals = [
  "document",
  "window",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

test("shows the failed page and Reload reloads the document", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;
  const shouldThrow = true;

  function Page() {
    if (shouldThrow) throw new Error("render exploded");
    return <p>Recovered page</p>;
  }

  await act(async () => {
    root = createRoot(container);
    root.render(
      <ErrorBoundary
        pageName="Providers"
        title="Page failed to load"
        message="Try again."
        detailsLabel="Error"
        reloadLabel="Reload"
      >
        <Page />
      </ErrorBoundary>,
    );
  });

  expect(container.textContent).toContain("Providers: Page failed to load");
  expect(container.textContent).toContain("render exploded");

  const reload = spyOn(testWindow.location, "reload").mockImplementation(
    () => {},
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
  });

  expect(reload).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("render exploded");
  reload.mockRestore();

  await act(async () => {
    root.unmount();
  });
});

test("catches a rejected lazy import outside Suspense", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const BrokenLazy = lazy(async () => {
    throw new Error("lazy import exploded");
  });

  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <ErrorBoundary
        pageName="OpenCodex"
        title="Page failed to load"
        message="Try again."
        detailsLabel="Error"
        reloadLabel="Reload"
      >
        <Suspense fallback={<p>Loading</p>}>
          <BrokenLazy />
        </Suspense>
      </ErrorBoundary>,
    );
  });

  expect(container.textContent).toContain("OpenCodex: Page failed to load");
  expect(container.textContent).toContain("lazy import exploded");

  await act(async () => {
    root.unmount();
  });
});

test.each([
  "changed release",
  "same release",
  "unavailable proxy",
  "blocked storage",
  "unknown client",
  "ordinary render error",
])("error boundary recovery remains actionable for %s", async (scenario) => {
  const clientSha = "a".repeat(40);
  const runtimeSha = scenario === "same release" ? clientSha : "b".repeat(40);
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let resolveProbe!: (response: Response) => void;
  let rejectProbe!: (error: Error) => void;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve, reject) => {
        resolveProbe = resolve;
        rejectProbe = reject;
      }),
  );
  const reload = spyOn(testWindow.location, "reload").mockImplementation(
    () => {},
  );
  // Happy DOM binds storage methods through a proxy, so spy before instance access.
  const storage = spyOn(testWindow.Storage.prototype, "setItem");
  if (scenario === "blocked storage") {
    storage.mockImplementation(() => {
      throw new Error("storage disabled");
    });
  }
  const errorMessage =
    scenario === "ordinary render error"
      ? "render exploded"
      : "Failed to fetch dynamically imported module: /assets/settings.js";
  const FailedPage = lazy(async () => {
    throw new TypeError(errorMessage);
  });

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ErrorBoundary
          pageName="Settings"
          title="Page failed to load"
          message="Try again."
          detailsLabel="Error"
          reloadLabel="Reload"
          clientSha={scenario === "unknown client" ? null : clientSha}
        >
          <Suspense fallback={<p>Loading</p>}>
            <FailedPage />
          </Suspense>
        </ErrorBoundary>,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      errorMessage,
    );
    expect(reload).not.toHaveBeenCalled();

    if (scenario === "unknown client" || scenario === "ordinary render error") {
      expect(fetchSpy).not.toHaveBeenCalled();
    } else {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith("/healthz", { cache: "no-store" });
      await act(async () => {
        if (scenario === "unavailable proxy") rejectProbe(new Error("offline"));
        else resolveProbe(Response.json({ gitSha: runtimeSha }));
      });
    }

    const automaticReloads = scenario === "changed release" ? 1 : 0;
    expect(reload).toHaveBeenCalledTimes(automaticReloads);
    if (automaticReloads) {
      expect(storage).toHaveBeenCalledWith(
        "opencodex:chunk-reload-attempted",
        runtimeSha,
      );
      expect(
        testWindow.sessionStorage.getItem("opencodex:chunk-reload-attempted"),
      ).toBe(runtimeSha);
    }
    // With no real navigation in the test, the boundary must remain usable.
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Reload");
    await act(async () => {
      button!.click();
    });
    expect(reload).toHaveBeenCalledTimes(automaticReloads + 1);
    expect(container.textContent).toContain("Settings: Page failed to load");
  } finally {
    await act(async () => {
      root?.unmount();
    });
    storage.mockRestore();
    reload.mockRestore();
    fetchSpy.mockRestore();
    container.remove();
  }
});
