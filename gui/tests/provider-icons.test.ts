import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatProviderDisplayName, isMonochromeProviderIcon, providerIconSrc } from "../src/provider-icons";
import { BRAND_SOURCES, ORIGINAL_SYMBOLS, checkAsset } from "../scripts/build-provider-icons.mjs";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../public/provider-icons");

/** All rows visible in the provided screenshot must resolve to a real SVG. */
const visibleProviders = [
  "groq", "openai", "cloudflare-workers-ai", "entrim", "gmicloud",
  "upstage", "tokenrouter", "zai", "meta", "cohere", "google",
  "google-antigravity", "xiaomi", "vultr", "venice", "unlooseai",
  "huggingface", "cerebras", "parallel", "neon", "lm7", "modal", "ovhcloud",
] as const;

describe("provider rail SVG coverage", () => {
  for (const provider of visibleProviders) {
    test(provider + " has a usable SVG", () => {
      const src = providerIconSrc(provider);
      expect(src).toMatch(/^\/provider-icons\/[-a-z0-9]+\.svg$/);
      const svg = readFileSync(join(ASSETS, src!.split("/").at(-1)!), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
      expect(svg).toContain("viewBox=");
    });
  }

  test("provider labels preserve canonical casing", () => {
    expect(formatProviderDisplayName("gmicloud")).toBe("GMI Cloud");
    expect(formatProviderDisplayName("zai")).toBe("Z.ai");
    expect(formatProviderDisplayName("ovhcloud")).toBe("OVHcloud");
    expect(formatProviderDisplayName("lm7")).toBe("LM7");
  });

  test("shared-brand icon aliases are corrected", () => {
    expect(providerIconSrc("google")).toBe("/provider-icons/google-color.svg");
    expect(providerIconSrc("google-vertex")).toBe("/provider-icons/googlecloud-color.svg");
    expect(providerIconSrc("cloudflare-workers-ai")).toBe("/provider-icons/workersai-color.svg");
    expect(providerIconSrc("cloudflare-ai-gateway")).not.toBe(providerIconSrc("cloudflare-workers-ai"));
  });

  test("single ink artwork uses theme-aware masks", () => {
    for (const id of ["openai", "groq", "zai", "gmicloud", "neon", "modal", "vultr", "ovhcloud", "xiaomi"]) {
      expect(isMonochromeProviderIcon(id)).toBe(true);
    }
    for (const id of ["meta", "cohere", "google", "venice", "cerebras", "cloudflare-workers-ai"]) {
      expect(isMonochromeProviderIcon(id)).toBe(false);
    }
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    expect(readFileSync(join(src, "components/provider-workspace/ProviderRail.tsx"), "utf8")).toContain('className="provider-icon-mask"');
    expect(readFileSync(join(src, "styles/provider-workspace-shell.css"), "utf8")).toContain("background-color: var(--text)");
  });

  test("all 20 generated assets follow the shared SVG frame", () => {
    const files = [...BRAND_SOURCES.map(entry => entry[0]), ...ORIGINAL_SYMBOLS.map(entry => entry[0])];
    expect(files).toHaveLength(20);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      const icon = readFileSync(join(ASSETS, file), "utf8");
      expect(() => checkAsset(icon, file)).not.toThrow();
    }
  });

  test("unknown custom providers preserve the existing server fallback", () => {
    expect(providerIconSrc("custom-provider-without-a-logo")).toBeUndefined();
  });
});
