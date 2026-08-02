import { describe, expect, test } from "bun:test";
import {
  CredentialSlotStore,
  renewalJitterMs,
  shouldRenewLease,
} from "../src/provider-security/slots";
import { DegradedModeController } from "../src/provider-security/degraded";
import { ProviderSecurityClient } from "../src/provider-security/client";
import { ProviderCredentialResolver } from "../src/provider-security/resolve";
import {
  ProviderSecurityError,
  validateChefVaultRef,
} from "../src/provider-security";
import {
  collectProviderSecurityStatus,
  collectProviderSecurityDoctorChecks,
  serializeProviderSecurityStatus,
} from "../src/provider-security/status";
import { providerCredentialFailure } from "../src/providers/credential";
import type { OcxConfig } from "../src/types";

const REF = "chefvault://providers/demo/prod";
const TEST_TOKEN = "test-workload-bearer-token-32chars";

function testClient(
  overrides: Partial<ConstructorParameters<typeof ProviderSecurityClient>[0]> = {},
): ProviderSecurityClient {
  return new ProviderSecurityClient({
    baseUrl: "http://vault.test",
    workload: { workloadId: "t", hostId: "h", actor: "a" },
    token: TEST_TOKEN,
    ...overrides,
  });
}

function leaseResponse(
  overrides: Partial<{ leaseId: string; secret: string; expiresAt: number; fencingToken: number; slotHint?: "active" | "next" | "retiring" }> = {},
) {
  return {
    leaseId: overrides.leaseId ?? "lease-1",
    secret: overrides.secret ?? "skfix1",
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    fencingToken: overrides.fencingToken ?? 1,
    ...(overrides.slotHint ? { slotHint: overrides.slotHint } : {}),
  };
}

function mockFetch(handlers: {
  healthz?: () => Response | Promise<Response>;
  status?: () => Response | Promise<Response>;
  resolve?: (body: unknown) => Response | Promise<Response>;
  renew?: (body: unknown) => Response | Promise<Response>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return handlers.healthz?.() ?? new Response("ok", { status: 200 });
    }
    if (url.endsWith("/provider-security/status")) {
      return handlers.status?.() ?? Response.json({ ok: true }, { status: 200 });
    }
    if (url.endsWith("/v1/credentials/resolve")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return handlers.resolve?.(body) ?? Response.json(leaseResponse(), { status: 200 });
    }
    if (url.endsWith("/v1/credentials/renew")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return handlers.renew?.(body) ?? Response.json(leaseResponse({ fencingToken: 2 }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("chefvault ref validation", () => {
  test("accepts a scoped chefvault:// ref", () => {
    expect(validateChefVaultRef(REF)).toBeNull();
  });

  test("accepts a host-only ref", () => {
    expect(validateChefVaultRef("chefvault://providers")).toBeNull();
  });

  test("rejects bare paths", () => {
    expect(validateChefVaultRef("providers/demo")?.code).toBe("ref_invalid");
  });

  test.each([
    ["wrong scheme", "vault://providers/demo/prod"],
    ["scheme only", "chefvault://"],
    ["path traversal", "chefvault://providers/../secrets"],
    ["current-dir segment", "chefvault://providers/./prod"],
    ["embedded whitespace", "chefvault://providers/demo prod"],
    ["control character", "chefvault://providers/demo\u0000prod"],
    ["empty segment", "chefvault://providers//prod"],
    ["empty string", ""],
  ])("rejects %s", (_label, ref) => {
    expect(validateChefVaultRef(ref)?.code).toBe("ref_invalid");
  });
});

describe("credential slot transitions", () => {
  test("moves previous active lease to retiring on rotation", () => {
    const store = new CredentialSlotStore();
    const at = 1_700_000_000_000;
    store.applyResolve(REF, leaseResponse({ leaseId: "a", fencingToken: 1 }), at);
    store.applyResolve(REF, leaseResponse({ leaseId: "b", fencingToken: 2, secret: "skn2" }), at + 1);

    const state = store.getState(REF)!;
    expect(state.slots.active?.leaseId).toBe("b");
    expect(state.slots.retiring?.leaseId).toBe("a");
    expect(state.slots.retiring?.phase).toBe("retiring");
  });

  test("promotes next slot to active", () => {
    const store = new CredentialSlotStore();
    const at = 1_700_000_000_000;
    store.applyResolve(REF, leaseResponse({ leaseId: "active", fencingToken: 1 }), at);
    store.applyResolve(REF, leaseResponse({ leaseId: "queued", fencingToken: 2, slotHint: "next" }), at + 1);

    const promoted = store.promoteNextToActive(REF, at + 2);
    expect(promoted?.leaseId).toBe("queued");
    expect(store.getState(REF)?.slots.active?.leaseId).toBe("queued");
    expect(store.getState(REF)?.slots.retiring?.leaseId).toBe("active");
  });

  test("request snapshots are immutable", () => {
    const store = new CredentialSlotStore();
    store.applyResolve(REF, leaseResponse(), Date.now());
    const snapshot = store.snapshotForRequest(REF)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { secret: string }).secret = "mutated";
    }).toThrow();
  });

  test("rejects stale fencing tokens", () => {
    const store = new CredentialSlotStore();
    store.applyResolve(REF, leaseResponse({ fencingToken: 5 }), Date.now());
    expect(() => store.applyResolve(REF, leaseResponse({ fencingToken: 4 }), Date.now()))
      .toThrow(ProviderSecurityError);
    let caught: unknown;
    try {
      store.applyResolve(REF, leaseResponse({ fencingToken: 3 }), Date.now());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderSecurityError);
    expect((caught as ProviderSecurityError).code).toBe("stale_fencing_token");
  });

  test("renewal jitter stays within bound", () => {
    expect(renewalJitterMs(0)).toBe(0);
    expect(renewalJitterMs(0.999)).toBeLessThan(30_000);
  });

  test("shouldRenewLease triggers inside lead window", () => {
    const store = new CredentialSlotStore();
    const at = 1_000_000;
    store.applyResolve(REF, leaseResponse({ expiresAt: at + 4 * 60_000 }), at);
    const active = store.getState(REF)?.slots.active;
    expect(shouldRenewLease(active, at)).toBe(true);
    store.applyResolve(REF, leaseResponse({ expiresAt: at + 60 * 60_000, fencingToken: 2 }), at);
    const fresh = store.getState(REF)?.slots.active;
    expect(shouldRenewLease(fresh, at)).toBe(false);
  });
});

describe("degraded mode", () => {
  test("denies new resolve but allows bounded existing credentials", async () => {
    const store = new CredentialSlotStore();
    const degraded = new DegradedModeController(store);
    const at = 1_700_000_000_000;
    store.applyResolve(REF, leaseResponse({ expiresAt: at + 60 * 60_000 }), at);
    degraded.markUnavailable(REF, at);

    expect(degraded.canResolve(REF, at).allowed).toBe(false);
    expect(degraded.canUseExisting(REF, at).allowed).toBe(true);

    const resolver = new ProviderCredentialResolver({
      slotStore: store,
      degraded,
      now: () => at,
      client: testClient({
        fetchImpl: mockFetch({
          resolve: () => Response.json({ code: "stale", message: "should not resolve" }, { status: 503 }),
        }),
      }),
    });

    const fromMemory = await resolver.resolveCredentialRef(REF);
    expect(fromMemory.source).toBe("memory");

    store.revokePhase(REF, "active");
    store.revokePhase(REF, "retiring");
    await expect(resolver.resolveCredentialRef(REF)).rejects.toMatchObject({
      code: "degraded_deny_resolve",
    });
  });

  test("a resolve during degraded mode issues no authority request", async () => {
    const store = new CredentialSlotStore();
    const degraded = new DegradedModeController(store);
    const at = 1_700_000_000_000;
    degraded.markUnavailable(REF, at);
    let calls = 0;
    const resolver = new ProviderCredentialResolver({
      slotStore: store,
      degraded,
      now: () => at + 1_000,
      client: testClient({
        fetchImpl: (async () => {
          calls += 1;
          return Response.json(leaseResponse(), { status: 200 });
        }) as typeof fetch,
      }),
    });

    await expect(resolver.resolveCredentialRef(REF)).rejects.toMatchObject({
      code: "degraded_deny_resolve",
    });
    expect(calls).toBe(0);
  });

  test("a malformed authority response surfaces authority_error without entering degraded mode", async () => {
    const store = new CredentialSlotStore();
    const degraded = new DegradedModeController(store);
    const resolver = new ProviderCredentialResolver({
      slotStore: store,
      degraded,
      client: testClient({
        fetchImpl: mockFetch({
          resolve: () => Response.json({ nonsense: true }, { status: 200 }),
        }),
      }),
    });

    await expect(resolver.resolveCredentialRef(REF)).rejects.toMatchObject({
      code: "authority_error",
    });
    expect(store.getMode(REF)).toBe("normal");
  });

  test("recovers after authority returns", async () => {
    const store = new CredentialSlotStore();
    const degraded = new DegradedModeController(store);
    let t = Date.now();
    let calls = 0;
    const client = testClient({
      fetchImpl: mockFetch({
        resolve: () => {
          calls += 1;
          if (calls === 1) {
            return new Response(JSON.stringify({ message: "down" }), { status: 503 });
          }
          return Response.json(leaseResponse({ fencingToken: 1, leaseId: "fresh" }), { status: 200 });
        },
      }),
    });
    const resolver = new ProviderCredentialResolver({ slotStore: store, degraded, client, now: () => t });

    await expect(resolver.resolveCredentialRef(REF)).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(store.getMode(REF)).toBe("degraded");

    // Inside the recovery probe interval the gate stays closed and never touches the authority.
    t += 1_000;
    await expect(resolver.resolveCredentialRef(REF)).rejects.toMatchObject({
      code: "degraded_deny_resolve",
    });
    expect(calls).toBe(1);

    // After the interval elapses a single probe is allowed and recovery reopens the gate.
    t += 31_000;
    const resolved = await resolver.resolveCredentialRef(REF);
    expect(resolved.snapshot.leaseId).toBe("fresh");
    expect(store.getMode(REF)).toBe("normal");
  });
});

describe("renewal failures", () => {
  function renewingResolver(renew: () => Response, store: CredentialSlotStore, at: number) {
    return new ProviderCredentialResolver({
      slotStore: store,
      degraded: new DegradedModeController(store),
      now: () => at,
      client: testClient({ fetchImpl: mockFetch({ renew }) }),
    });
  }

  test("a revoked renewal evicts the lease and rejects the request", async () => {
    const store = new CredentialSlotStore();
    const at = 1_700_000_000_000;
    // Inside the renewal lead window but not yet expired: the old snapshot is still "usable".
    store.applyResolve(REF, leaseResponse({ secret: "skrevoked", expiresAt: at + 60_000 }), at);
    const resolver = renewingResolver(
      () => Response.json({ code: "revoked", message: "lease revoked" }, { status: 410 }),
      store,
      at,
    );

    await expect(resolver.resolveCredentialRef(REF, { jitterMs: 0 })).rejects.toMatchObject({ code: "revoked" });
    expect(store.snapshotForRequest(REF, at)).toBeNull();
  });

  test("a revoked renewal also revokes a retiring lease so the ref fails closed", async () => {
    const store = new CredentialSlotStore();
    const at = 1_700_000_000_000;
    // Rotation leaves the previous active lease in the retiring slot with its secret intact.
    store.applyResolve(REF, leaseResponse({ leaseId: "old", secret: "skold", expiresAt: at + 60_000 }), at);
    store.applyResolve(REF, leaseResponse({ leaseId: "new", secret: "sknew", fencingToken: 2, expiresAt: at + 60_000 }), at + 1);
    const resolver = renewingResolver(
      () => Response.json({ code: "revoked", message: "lease revoked" }, { status: 410 }),
      store,
      at + 2,
    );

    await expect(resolver.resolveCredentialRef(REF, { jitterMs: 0 })).rejects.toMatchObject({ code: "revoked" });
    expect(store.snapshotForRequest(REF, at + 2)).toBeNull();
    const slots = store.getState(REF)!.slots;
    for (const phase of ["active", "next", "retiring"] as const) {
      const lease = slots[phase];
      if (lease) expect(lease.phase).toBe("revoked");
    }
    expect(slots.retiring?.phase).toBe("revoked");
  });

  test("a transient renewal failure keeps serving the cached lease", async () => {
    const store = new CredentialSlotStore();
    const at = 1_700_000_000_000;
    store.applyResolve(REF, leaseResponse({ secret: "skcached", expiresAt: at + 60_000 }), at);
    const resolver = renewingResolver(
      () => new Response(JSON.stringify({ message: "down" }), { status: 503 }),
      store,
      at,
    );

    const resolved = await resolver.resolveCredentialRef(REF, { jitterMs: 0 });
    expect(resolved.source).toBe("memory");
    expect(resolved.apiKey).toBe("skcached");
  });

  test("a renewal outage enters degraded mode and gates further renewal traffic", async () => {
    const store = new CredentialSlotStore();
    let t = 1_700_000_000_000;
    store.applyResolve(REF, leaseResponse({ secret: "skcached", expiresAt: t + 120_000 }), t);
    let renewCalls = 0;
    let authorityUp = false;
    const resolver = new ProviderCredentialResolver({
      slotStore: store,
      degraded: new DegradedModeController(store),
      now: () => t,
      client: testClient({
        fetchImpl: mockFetch({
          renew: () => {
            renewCalls += 1;
            if (!authorityUp) {
              return new Response(JSON.stringify({ message: "down" }), { status: 503 });
            }
            return Response.json(leaseResponse({ leaseId: "renewed", secret: "skfresh", fencingToken: 2, expiresAt: t + 120_000 }), { status: 200 });
          },
        }),
      }),
    });

    // The failed renewal enters degraded mode but keeps serving the cached lease.
    const first = await resolver.resolveCredentialRef(REF, { jitterMs: 0 });
    expect(first.apiKey).toBe("skcached");
    expect(renewCalls).toBe(1);
    expect(store.getMode(REF)).toBe("degraded");

    // Inside the recovery-probe interval no further renewal call reaches the authority.
    t += 1_000;
    const second = await resolver.resolveCredentialRef(REF, { jitterMs: 0 });
    expect(second.apiKey).toBe("skcached");
    expect(renewCalls).toBe(1);

    // After the interval elapses a single renewal probe is allowed; success exits degraded mode.
    t += 31_000;
    authorityUp = true;
    const third = await resolver.resolveCredentialRef(REF, { jitterMs: 0 });
    expect(third.apiKey).toBe("skfresh");
    expect(renewCalls).toBe(2);
    expect(store.getMode(REF)).toBe("normal");
  });
});

describe("provider-security client headers", () => {
  test("sends workload identity headers on resolve", async () => {
    let headers: Record<string, string> = {};
    const client = testClient({
      fetchImpl: (async (_input, init) => {
        headers = Object.fromEntries(new Headers(init?.headers).entries());
        return Response.json(leaseResponse(), { status: 200 });
      }) as typeof fetch,
    });

    await client.resolveLease({ ref: REF });
    expect(headers["x-chef-workload-id"]).toBe("t");
    expect(headers["x-chef-host-id"]).toBe("h");
    expect(headers["x-chef-actor"]).toBe("a");
  });

  test("sends Authorization bearer on protected routes when token is configured", async () => {
    let headers: Record<string, string> = {};
    const client = testClient({
      token: "access-token-chefvault-bearer",
      fetchImpl: (async (_input, init) => {
        headers = Object.fromEntries(new Headers(init?.headers).entries());
        return Response.json(leaseResponse(), { status: 200 });
      }) as typeof fetch,
    });

    await client.resolveLease({ ref: REF });
    expect(headers.authorization).toBe("Bearer access-token-chefvault-bearer");
  });

  test("does not send Authorization on healthz", async () => {
    let headers: Record<string, string> = {};
    const client = testClient({
      fetchImpl: (async (_input, init) => {
        headers = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });

    await client.healthz();
    expect(headers.authorization).toBeUndefined();
  });
});

describe("provider-security bearer auth", () => {
  test("resolve without token throws auth_required before calling fetch", async () => {
    let called = false;
    const client = testClient({
      token: undefined,
      fetchImpl: (async () => {
        called = true;
        return Response.json(leaseResponse(), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.resolveLease({ ref: REF })).rejects.toMatchObject({ code: "auth_required" });
    expect(called).toBe(false);
  });

  test("maps HTTP 401 to auth_invalid", async () => {
    const client = testClient({
      fetchImpl: mockFetch({
        resolve: () => Response.json({ code: "auth_invalid", message: "credential is not recognised" }, { status: 401 }),
      }),
    });

    await expect(client.resolveLease({ ref: REF })).rejects.toMatchObject({
      code: "auth_invalid",
      message: "credential is not recognised",
    });
  });

  test("maps HTTP 403 identity mismatch", async () => {
    const client = testClient({
      fetchImpl: mockFetch({
        resolve: () => Response.json(
          { code: "identity_assertion_mismatch", message: "asserted identity headers do not match" },
          { status: 403 },
        ),
      }),
    });

    await expect(client.resolveLease({ ref: REF })).rejects.toMatchObject({
      code: "identity_assertion_mismatch",
    });
  });

  test("authenticatedReady probes /provider-security/status with bearer", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const client = testClient({
      fetchImpl: (async (input, init) => {
        url = String(input);
        headers = Object.fromEntries(new Headers(init?.headers).entries());
        return Response.json({ mode: "normal" }, { status: 200 });
      }) as typeof fetch,
    });

    const ready = await client.authenticatedReady();
    expect(ready.ok).toBe(true);
    expect(url).toContain("/provider-security/status");
    expect(headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  test("doctor reports liveness OK and auth WARN when token missing", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "demo",
      providers: {
        demo: {
          adapter: "openai-chat",
          baseUrl: "https://example/v1",
          credentialRef: REF,
        },
      },
    };

    const doctor = await collectProviderSecurityDoctorChecks(config, new ProviderCredentialResolver({
      client: testClient({
        token: undefined,
        fetchImpl: mockFetch({ healthz: () => new Response("ok", { status: 200 }) }),
      }),
    }));

    expect(doctor.some(c => c.level === "OK" && c.layer === "liveness")).toBe(true);
    expect(doctor.some(c => c.level === "WARN" && c.message.includes("CHEF_PROVIDER_SECURITY_TOKEN"))).toBe(true);
  });

  test("doctor reports auth WARN on 401 status probe", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "demo",
      providers: {
        demo: {
          adapter: "openai-chat",
          baseUrl: "https://example/v1",
          credentialRef: REF,
        },
      },
    };

    const doctor = await collectProviderSecurityDoctorChecks(config, new ProviderCredentialResolver({
      client: testClient({
        fetchImpl: mockFetch({
          healthz: () => new Response("ok", { status: 200 }),
          status: () => Response.json({ code: "auth_invalid", message: "credential is not recognised" }, { status: 401 }),
        }),
      }),
    }));

    expect(doctor.some(c => c.level === "OK" && c.layer === "liveness")).toBe(true);
    expect(doctor.some(c => c.level === "WARN" && c.layer === "authenticated")).toBe(true);
  });

  test("doctor makes no authority probe when no chefvault refs are configured", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "demo",
      providers: {
        demo: {
          adapter: "openai-chat",
          baseUrl: "https://example/v1",
          apiKey: "env:DEMO_KEY",
        },
      },
    };

    let fetchCalls = 0;
    const doctor = await collectProviderSecurityDoctorChecks(config, new ProviderCredentialResolver({
      client: testClient({
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response("ok", { status: 200 });
        }) as typeof fetch,
      }),
    }));

    expect(fetchCalls).toBe(0);
    expect(doctor).toEqual([
      {
        level: "OK",
        provider: "*",
        layer: "provider",
        message: "No providers configured with chefvault:// credentialRef.",
      },
    ]);
  });
});

describe("redacted status serialization", () => {
  test("never includes raw secret material", async () => {
    const store = new CredentialSlotStore();
    store.applyResolve(REF, leaseResponse({ secret: "skfix" }), Date.now());

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "demo",
      providers: {
        demo: {
          adapter: "openai-chat",
          baseUrl: "https://example/v1",
          credentialRef: REF,
        },
      },
    };

    const report = collectProviderSecurityStatus(config, undefined, store);
    const serialized = serializeProviderSecurityStatus(report);
    expect(serialized).not.toContain("skfix");
    expect(serialized).not.toContain("secret");
    expect(report.providers[0]?.status.slots[0]?.leaseId).toBe("lease-1");

    const doctor = await collectProviderSecurityDoctorChecks(config, new ProviderCredentialResolver({
      slotStore: store,
      client: testClient({
        fetchImpl: mockFetch({ healthz: () => new Response("ok", { status: 200 }) }),
      }),
    }));
    const doctorText = JSON.stringify(doctor);
    expect(doctorText).not.toContain("skfix");
  });
});

describe("data-plane credential failure redaction", () => {
  // Responses, compact, and Images all surface lease failures through providerCredentialFailure,
  // so redaction here covers every data-plane error body.
  test("scrubs bearer and secret material from authority error detail", () => {
    const failure = providerCredentialFailure("demo", new ProviderSecurityError(
      "authority_unavailable",
      "upstream rejected Authorization: Bearer access-token-leaked-fixture (secret=access-token-secret-fixture)",
    ));
    expect(failure.status).toBe(503);
    expect(failure.type).toBe("api_error");
    expect(failure.message).not.toContain("access-token-leaked-fixture");
    expect(failure.message).not.toContain("access-token-secret-fixture");
    expect(failure.message).toContain("[redacted]");
    expect(failure.message).toContain("authority_unavailable");
  });

  test("scrubs credential material from denied-reference detail", () => {
    const failure = providerCredentialFailure("demo", new ProviderSecurityError(
      "revoked",
      "lease revoked; last seen token: access-token-revoked-fixture",
    ));
    expect(failure.status).toBe(401);
    expect(failure.type).toBe("authentication_error");
    expect(failure.message).not.toContain("access-token-revoked-fixture");
  });
});
