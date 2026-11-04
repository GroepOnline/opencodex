import { describe, expect, test } from "bun:test";
import { maskClientAddress } from "../src/lib/client-ip";

describe("maskClientAddress", () => {
  test("truncates IPv4 to the /24 prefix", () => {
    expect(maskClientAddress("203.0.113.87")).toBe("203.0.113.0");
    expect(maskClientAddress("100.65.83.86")).toBe("100.65.83.0");
    expect(maskClientAddress("255.255.255.255")).toBe("255.255.255.0");
    expect(maskClientAddress(" 10.1.2.3 ")).toBe("10.1.2.0");
    // Loopback stays recognizable as loopback range, never host-exact.
    expect(maskClientAddress("127.0.0.1")).toBe("127.0.0.0");
    expect(maskClientAddress("0.0.0.0")).toBe("0.0.0.0");
  });

  test("truncates IPv6 to the /48 prefix", () => {
    expect(maskClientAddress("2001:db8:abcd:1234:5678::9")).toBe(
      "2001:db8:abcd::",
    );
    expect(maskClientAddress("2001:0db8:0000:0001:0000:0000:0000:0001")).toBe(
      "2001:db8:0::",
    );
    expect(maskClientAddress("FE80::a:b:c:d")).toBe("fe80:0:0::");
    expect(maskClientAddress("::1")).toBe("::");
    expect(maskClientAddress("::")).toBe("::");
    // Zone identifiers are interface-local metadata, not persisted.
    expect(maskClientAddress("fe80::1%eth0")).toBe("fe80:0:0::");
  });

  test("masks the embedded quad of IPv4-mapped IPv6 instead of erasing it", () => {
    expect(maskClientAddress("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.0");
    expect(maskClientAddress("::ffff:100.65.83.86")).toBe("::ffff:100.65.83.0");
    expect(maskClientAddress("0:0:0:0:0:ffff:10.0.0.9")).toBe(
      "::ffff:10.0.0.0",
    );
    // Zero-padded spellings of the same mapped address take the same branch —
    // a "0000" hextet must not drop the row into the generic /48 erase.
    expect(maskClientAddress("0000:0000:0000:0000:0000:ffff:1.2.3.4")).toBe(
      "::ffff:1.2.3.0",
    );
    expect(maskClientAddress("0:00:000:0:0000:ffff:10.0.0.9")).toBe(
      "::ffff:10.0.0.0",
    );
    expect(maskClientAddress("0000::FFFF:10.0.0.9")).toBe("::ffff:10.0.0.0");
    // v4-translated (NAT64) is not v4-mapped: the /48 truncation applies.
    expect(maskClientAddress("64:ff9b::1.2.3.4")).toBe("64:ff9b:0::");
  });

  test("is idempotent on already-masked values", () => {
    expect(maskClientAddress("203.0.113.0")).toBe("203.0.113.0");
    expect(maskClientAddress("2001:db8:abcd::")).toBe("2001:db8:abcd::");
    expect(maskClientAddress("::ffff:1.2.3.0")).toBe("::ffff:1.2.3.0");
    expect(maskClientAddress("::")).toBe("::");
  });

  test.each([
    "",
    "   ",
    "hostname.local",
    "not-an-ip",
    "1.2.3",
    "1.2.3.4.5",
    "1.2.3.256",
    "1.2.3.-1",
    "1.2.3.4:8080",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "a::b::c",
    ":::",
    "gggg::1",
    "1.2.3.4::",
    null,
    42,
    {},
  ])("drops non-IP input rather than persisting it: %j", (value) => {
    expect(maskClientAddress(value)).toBeUndefined();
  });

  test("drops absent and non-scalar values", () => {
    expect(maskClientAddress(undefined)).toBeUndefined();
    expect(maskClientAddress()).toBeUndefined();
    expect(maskClientAddress([])).toBeUndefined();
  });
});
