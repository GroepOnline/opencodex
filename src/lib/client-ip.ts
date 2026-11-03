/**
 * Persistence-safe, deliberately lossy peer-address identity.
 *
 * A client IP is a personal identifier that usage.jsonl and the Logs ring never
 * need at full precision: every downstream consumer only displays it next to the
 * sanitized User-Agent. The masked form (IPv4 /24, IPv6 /48) keeps enough signal
 * to tell "same LAN" from "different client" while erasing the exact host.
 * Unknown formats are dropped rather than risk persisting an identifier the
 * parser did not understand — the same posture sanitizeClientUserAgent takes.
 */

function maskIpv4Octets(parts: string[]): string | undefined {
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
}

const HEXTET = /^[0-9a-fA-F]{1,4}$/;

/** Convert a trailing dotted quad into its two hextets, or null when malformed. */
function dottedQuadToHextets(quad: string): string[] | null {
  const octets = quad.split(".");
  if (
    octets.length !== 4 ||
    octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  ) {
    return null;
  }
  return [
    ((Number(octets[0]) << 8) | Number(octets[1])).toString(16),
    ((Number(octets[2]) << 8) | Number(octets[3])).toString(16),
  ];
}

/**
 * Expand an IPv6 literal into eight hextets. Returns null on any shape the
 * parser cannot fully account for (multiple "::", bad hextets, wrong count).
 * A dotted-quad tail counts as the final two hextets.
 */
function expandIpv6(input: string): string[] | null {
  let address = input.toLowerCase();
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  const lastColon = address.lastIndexOf(":");
  const dotIndex = address.lastIndexOf(".");
  if (dotIndex >= 0) {
    // A dotted quad is only legal as the trailing 32 bits and requires a
    // preceding hextet boundary ("::ffff:1.2.3.4", never "1.2.3.4" alone).
    if (lastColon < 0 || dotIndex < lastColon) return null;
    const tail = dottedQuadToHextets(address.slice(lastColon + 1));
    if (!tail) return null;
    address = address.slice(0, lastColon + 1) + tail.join(":");
  }
  const sides = address.split("::");
  if (sides.length > 2) return null;
  return expandHextets(sides);
}

function parseHextetSide(side: string): string[] | null {
  if (!side) return [];
  const groups = side.split(":");
  return groups.every((group) => HEXTET.test(group)) ? groups : null;
}

function expandHextets(sides: string[]): string[] | null {
  const left = parseHextetSide(sides[0] ?? "");
  const right = parseHextetSide(sides.length === 2 ? (sides[1] ?? "") : "");
  if (left === null || right === null) return null;
  if (sides.length === 1) {
    // No compression: exactly eight groups (dotted tail already counted as two).
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  // "::" alone (missing === 8) is the unspecified address; reject the
  // "x::y" form that fills nothing ("1:2:3:4:5:6:7:8::" is already full).
  if (missing < 0 || left.length + right.length === 8) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right];
}

function maskIpv6(input: string): string | undefined {
  const hextets = expandIpv6(input);
  if (!hextets) return undefined;
  // IPv4-mapped (::ffff:a.b.c.d) carries its identity in the embedded quad —
  // truncating at /48 would erase it entirely, so mask the quad instead.
  // Compare numerically: "0:0:0:0:0:ffff:x" and "0000::ffff:x" spell the same
  // mapped address and must take this branch, not the generic /48 erase.
  if (
    hextets.slice(0, 5).every((h) => Number.parseInt(h, 16) === 0) &&
    Number.parseInt(hextets[5]!, 16) === 0xffff
  ) {
    const high = Number.parseInt(hextets[6]!, 16);
    const low = Number.parseInt(hextets[7]!, 16);
    return `::ffff:${high >> 8}.${high & 0xff}.${low >> 8}.0`;
  }
  const prefix = hextets
    .slice(0, 3)
    .map((hextet) => Number.parseInt(hextet, 16).toString(16));
  return prefix.every((hextet) => hextet === "0")
    ? "::"
    : `${prefix.join(":")}::`;
}

/**
 * Map a peer address onto its truncated network prefix: IPv4 keeps the first
 * three octets (`203.0.113.87` → `203.0.113.0`), IPv4-mapped IPv6 keeps the
 * `::ffff:` prefix plus the masked quad, and IPv6 keeps the first 48 bits
 * (`2001:db8:abc:1234::1` → `2001:db8:abc::`). Loopback stays recognizable
 * (`127.0.0.1` → `127.0.0.0`, `::1` → `::`). Non-IP input yields undefined so
 * callers omit the field instead of persisting an unparsed identifier.
 */
export function maskClientAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const input = value.trim();
  if (!input) return undefined;
  const ipv4 = maskIpv4Octets(input.split("."));
  if (ipv4) return ipv4;
  return maskIpv6(input);
}
