import { describe, expect, test } from "bun:test";
import { sanitizedCurrentUrl, sanitizedUrlString } from "../src/posthog-sanitize";

function loc(hash: string): Pick<Location, "origin" | "pathname" | "hash"> {
  return { origin: "http://127.0.0.1:10100", pathname: "/", hash };
}

describe("sanitizedCurrentUrl", () => {
  test("keeps known page hashes", () => {
    expect(sanitizedCurrentUrl(loc("#providers"))).toBe("http://127.0.0.1:10100/#providers");
    expect(sanitizedCurrentUrl(loc("#logs/debug"))).toBe("http://127.0.0.1:10100/#logs/debug");
    expect(sanitizedCurrentUrl(loc("#dashboard/models"))).toBe("http://127.0.0.1:10100/#dashboard/models");
  });

  test("strips unknown page heads and unknown sub-targets down to the page", () => {
    expect(sanitizedCurrentUrl(loc("#oauth-callback?code=sekrit"))).toBe("http://127.0.0.1:10100/");
    expect(sanitizedCurrentUrl(loc("#providers/secret-token"))).toBe("http://127.0.0.1:10100/#providers");
  });
});

describe("sanitizedUrlString", () => {
  test("applies the same allowlist to full URL strings", () => {
    expect(sanitizedUrlString("http://127.0.0.1:10100/#providers")).toBe(
      "http://127.0.0.1:10100/#providers"
    );
    expect(sanitizedUrlString("http://127.0.0.1:10100/?foo=bar#oauth-callback?code=sekrit")).toBe(
      "http://127.0.0.1:10100/"
    );
  });

  test("drops unparseable URLs entirely", () => {
    expect(sanitizedUrlString("not a url")).toBe("");
  });
});
