import { expect, test } from "bun:test";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS, beginPollEpoch, beginPollEpochs } from "../src/startup-health-ui";

test("project-config diagnostics poll cadence is owned by the shared constant", () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
});

test("dashboard poll epochs share beginPollEpoch", () => {
  const refs = {
    settingsRequest: { current: 0 },
    settingsMutation: { current: 2 },
    shadowRequest: { current: 0 },
    shadowMutation: { current: 4 },
  };
  const paired = beginPollEpochs(refs);
  expect(paired.settings).toEqual({ request: 1, mutation: 2 });
  expect(paired.shadow).toEqual({ request: 1, mutation: 4 });
  expect(beginPollEpoch(refs.settingsRequest, refs.settingsMutation)).toEqual({ request: 2, mutation: 2 });
});
