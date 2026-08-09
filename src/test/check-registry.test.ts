import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPackages } from "../check/registry.js";

test("404 is missing, 200 is fine, everything else is unreachable-not-blocking", async () => {
  const statuses: Record<string, number> = { exists: 200, ghost: 404, flaky: 500, limited: 429 };
  const fetcher = async (url: string): Promise<{ status: number }> => {
    const name = decodeURIComponent(url.split("/").pop()!);
    return { status: statuses[name]! };
  };
  const result = await checkPackages(["exists", "ghost", "flaky", "limited"], fetcher);
  assert.deepEqual(result.missing, ["ghost"]);
  assert.deepEqual(result.unreachable.sort(), ["flaky", "limited"]);
});

test("301, 302, and 307 redirects are unreachable, never missing", async () => {
  for (const status of [301, 302, 307]) {
    const result = await checkPackages([`redirect-${status}`], async () => ({ status }));
    assert.deepEqual(result.missing, [], String(status));
    assert.deepEqual(result.unreachable, [`redirect-${status}`], String(status));
  }
});

test("the registry fetcher refuses automatic redirects", async () => {
  const originalFetch = globalThis.fetch;
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    redirect = init?.redirect;
    return { status: 302 } as Response;
  }) as typeof fetch;
  try {
    const result = await checkPackages(["redirected-package"]);
    assert.equal(redirect, "manual");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unreachable, ["redirected-package"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("thrown network errors and timeouts land in unreachable, never missing", async () => {
  const fetcher = async (): Promise<{ status: number }> => { throw new Error("ECONNREFUSED"); };
  const result = await checkPackages(["off-line-pkg"], fetcher);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unreachable, ["off-line-pkg"]);
});

test("scoped names are URL-encoded", async () => {
  const seen: string[] = [];
  const fetcher = async (url: string): Promise<{ status: number }> => { seen.push(url); return { status: 200 }; };
  await checkPackages(["@scope/name"], fetcher);
  assert.equal(seen[0], "https://registry.npmjs.org/%40scope%2Fname");
});

test("a slow request times out into unreachable", async () => {
  const fetcher = (_url: string, signal: AbortSignal): Promise<{ status: number }> =>
    new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted"))); });
  const result = await checkPackages(["slow-pkg"], fetcher, 50);
  assert.deepEqual(result.unreachable, ["slow-pkg"]);
});

test("a fetcher that ignores abort still settles as unreachable", async () => {
  const fetcher = async (): Promise<{ status: number }> => new Promise(() => {});
  const result = await checkPackages(["non-cooperative-pkg"], fetcher, 20);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unreachable, ["non-cooperative-pkg"]);
});
