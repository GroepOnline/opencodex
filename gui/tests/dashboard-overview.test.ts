import { expect, test } from "bun:test";
import {
  accountOperationalStatus,
  buildCapacityRows,
  buildOverviewIssues,
  rollupAccounts,
} from "../src/pages/dashboard-overview";
import {
  buildProviderWorkspace,
  binProviderStatus,
} from "../src/provider-workspace/catalog";
import {
  oauthHealthBadgeClass,
  oauthHealthIsDisabled,
} from "../src/oauth-health-display";

const provider = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  authMode: "oauth",
};
test("cooldown and warnings are not reauthentication; legacy flag takes priority", () => {
  for (const health of [
    { status: "cooldown", reason: "rate_limit" },
    { status: "warning" },
  ] as const) {
    const sets = {
      fixture: { accounts: [{ id: "one", active: true, health }] },
    };
    expect(
      buildOverviewIssues({ fixture: provider }, sets).some(
        (row) => row.detailKey === "dash.overview.issueReauth",
      ),
    ).toBe(false);
  }
  expect(
    accountOperationalStatus({
      id: "one",
      needsReauth: true,
      health: { status: "healthy" },
    }),
  ).toBe("auth-failed");
});
test("inactive bad accounts do not override the healthy active account", () => {
  const sets = {
    fixture: {
      accounts: [
        { id: "one", active: true, health: { status: "healthy" as const } },
        {
          id: "two",
          health: { status: "cooldown" as const, reason: "rate_limit" },
        },
      ],
    },
  };
  expect(buildCapacityRows({ fixture: provider }, sets)[0]?.status).toBe(
    "healthy",
  );
  expect(buildOverviewIssues({ fixture: provider }, sets)).toEqual([]);
});
test("missing discovery is unknown; fetched empty discovery requires setup", () => {
  expect(buildCapacityRows({ fixture: provider }, {})[0]?.status).toBe(
    "unknown",
  );
  expect(buildOverviewIssues({ fixture: provider }, {})[0]?.status).toBe(
    "unknown",
  );
  expect(
    buildCapacityRows({ fixture: provider }, { fixture: { accounts: [] } })[0]
      ?.status,
  ).toBe("auth-failed");
  expect(rollupAccounts({}, ["fixture"]).loaded).toBe(false);
  expect(accountOperationalStatus({ id: "one" })).toBe("unknown");
});
test("optional-key precedence agrees across section and row classifiers", () => {
  const sections = buildProviderWorkspace({
    fixture: { ...provider, keyOptional: true },
  });
  expect(sections.ready).toHaveLength(1);
  expect(binProviderStatus(sections.ready[0]!)).toBe("ready");
});
test("expiry and reason-sensitive main OAuth badge contract remain intact", () => {
  expect(oauthHealthIsDisabled("disabled")).toBe(true);
  expect(oauthHealthBadgeClass("cooldown", "quota")).toBe("badge badge-red");
  expect(
    accountOperationalStatus({
      id: "one",
      health: { status: "disabled", reason: "expired" },
    }),
  ).toBe("expired");
});
