import { describe, expect, test } from "bun:test";
import {
  POSTHOG_PREFERENCE_KEY,
  readPostHogPreference,
  writePostHogPreference,
} from "../src/posthog";

function store(map: Record<string, string> = {}) {
  return {
    getItem: (k: string) => (k in map ? map[k]! : null),
    setItem: (k: string, v: string) => {
      map[k] = v;
    },
    removeItem: (k: string) => {
      delete map[k];
    },
    snapshot: () => ({ ...map }),
  };
}

describe("posthog preference round-trip", () => {
  test("reads explicit on/off and null for unset or junk", () => {
    expect(readPostHogPreference(store({}))).toBe(null);
    expect(
      readPostHogPreference(store({ [POSTHOG_PREFERENCE_KEY]: "0" })),
    ).toBe("0");
    expect(
      readPostHogPreference(store({ [POSTHOG_PREFERENCE_KEY]: "1" })),
    ).toBe("1");
    expect(
      readPostHogPreference(store({ [POSTHOG_PREFERENCE_KEY]: "yes" })),
    ).toBe(null);
    expect(readPostHogPreference(null)).toBe(null);
  });

  test("writes and clears through the shared key", () => {
    const s = store();
    writePostHogPreference(s, "1");
    expect(s.snapshot()[POSTHOG_PREFERENCE_KEY]).toBe("1");
    writePostHogPreference(s, "0");
    expect(s.snapshot()[POSTHOG_PREFERENCE_KEY]).toBe("0");
    writePostHogPreference(s, null);
    expect(POSTHOG_PREFERENCE_KEY in s.snapshot()).toBe(false);
  });

  test("never throws on blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPostHogPreference(blocked)).toBe(null);
    writePostHogPreference(blocked, "0");
    writePostHogPreference(null, "0");
  });
});
