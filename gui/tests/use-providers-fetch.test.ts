import { expect, test } from "bun:test";
import { readAvailabilityProviders } from "../src/pages/use-providers-fetch";

test("readAvailabilityProviders returns an empty list when the request rejects", async () => {
  expect(await readAvailabilityProviders(Promise.reject(new Error("net")))).toEqual([]);
});

test("readAvailabilityProviders returns an empty list on HTTP errors", async () => {
  expect(await readAvailabilityProviders(Promise.resolve(new Response("nope", { status: 500 })))).toEqual([]);
});

test("readAvailabilityProviders returns an empty list when the body has no providers", async () => {
  expect(await readAvailabilityProviders(Promise.resolve(Response.json({})))).toEqual([]);
});

test("readAvailabilityProviders reads the providers array from a live payload", async () => {
  const providers = [{ name: "openai-apikey", keyPoolCount: 2, coolingKeyCount: 1 }];
  const res = Response.json({ providers });
  expect(await readAvailabilityProviders(Promise.resolve(res))).toEqual(providers);
});
