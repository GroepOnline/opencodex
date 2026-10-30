import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNoStore } from "../src/server/auth-cors";
import { guiAssetCacheHeaders, serveGuiFile } from "../src/server/gui-static";
import { startServer } from "../src/server";

const previousHome = process.env.OPENCODEX_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

describe("dashboard cache headers", () => {
  test("hashed assets are immutable and html is not stored", () => {
    const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-cache-"));
    mkdirSync(join(guiDist, "assets"));
    writeFileSync(
      join(guiDist, "index.html"),
      "<!doctype html><title>test</title>",
    );
    writeFileSync(join(guiDist, "assets", "app-Abcdef12.js"), "console.log(1)");
    writeFileSync(join(guiDist, "favicon.ico"), "icon");
    try {
      const html = serveGuiFile("/", guiDist);
      expect(html?.headers.get("Cache-Control")).toBe("no-store");
      expect(html?.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
        "no-store",
      );
      const asset = serveGuiFile("/assets/app-Abcdef12.js", guiDist);
      expect(asset?.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(asset?.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      const icon = serveGuiFile("/favicon.ico", guiDist);
      expect(icon?.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(
        guiAssetCacheHeaders(join(guiDist, "assets", "app-Abcdef12.js"))[
          "Cache-Control"
        ],
      ).toContain("immutable");
    } finally {
      rmSync(guiDist, { recursive: true, force: true });
    }
  });

  test("sensitive responses tell Cloudflare not to cache them", () => {
    const response = withNoStore(
      new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
      "no-store",
    );
  });

  test("healthz is not cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-healthz-cache-"));
    process.env.OPENCODEX_HOME = dir;
    const server = startServer(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      const body = (await res.json()) as { service?: string };
      expect(body.service).toBe("opencodex");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
