import { describe, expect, test } from "bun:test";
import { sanitizedCurrentUrl } from "../src/posthog-sanitize";

function loc(hash: string): Pick<Location, "origin" | "pathname" | "hash"> {
  return { origin: "http://127.0.0.1:10100", pathname: "/", hash };
}

describe("sanitizedCurrentUrl", () => {
  test("keeps canonical De Pas page hashes", () => {
    expect(sanitizedCurrentUrl(loc("#leveranciers"))).toBe("http://127.0.0.1:10100/#leveranciers");
    expect(sanitizedCurrentUrl(loc("#modellen/combos"))).toBe("http://127.0.0.1:10100/#modellen/combos");
    expect(sanitizedCurrentUrl(loc("#systeem/codex-auth"))).toBe("http://127.0.0.1:10100/#systeem/codex-auth");
  });

  test("keeps legacy English deep links", () => {
    expect(sanitizedCurrentUrl(loc("#providers"))).toBe("http://127.0.0.1:10100/#providers");
    expect(sanitizedCurrentUrl(loc("#logs/debug"))).toBe("http://127.0.0.1:10100/#logs/debug");
  });

  test("strips unknown page heads and unknown sub-targets down to the page", () => {
    expect(sanitizedCurrentUrl(loc("#oauth-callback?code=sekrit"))).toBe("http://127.0.0.1:10100/");
    expect(sanitizedCurrentUrl(loc("#systeem/unknown-tab"))).toBe("http://127.0.0.1:10100/#systeem");
  });
});
