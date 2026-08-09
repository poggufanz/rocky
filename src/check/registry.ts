export type Fetcher = (url: string, signal: AbortSignal) => Promise<{ status: number }>;

export interface RegistryResult {
  missing: string[];
  unreachable: string[];
}

const defaultFetcher: Fetcher = async (url, signal) => {
  const response = await fetch(url, { signal, redirect: "manual" });
  return { status: response.status };
};

/**
 * Check whether package names exist in the public npm registry.
 * Only a definitive 404 is considered missing; all other statuses and
 * request failures are unreachable so registry issues never block a push.
 */
export async function checkPackages(
  names: string[],
  fetcher: Fetcher = defaultFetcher,
  requestTimeoutMs = 2000,
): Promise<RegistryResult> {
  const missing: string[] = [];
  const unreachable: string[] = [];

  await Promise.all(names.map(async (name) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("registry request timed out"));
      }, requestTimeoutMs);
    });
    try {
      const response = await Promise.race([
        fetcher(url, controller.signal),
        timeoutResult,
      ]);
      if (response.status === 404) missing.push(name);
      else if (response.status !== 200) unreachable.push(name);
    } catch {
      unreachable.push(name);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }));

  missing.sort();
  unreachable.sort();
  return { missing, unreachable };
}
