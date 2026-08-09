export interface NewDep {
  name: string;
  spec: string;
}

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const LOCAL_PROTOCOLS = /^(?:workspace|file|link|portal):/;

/** Exact keys from package-lock.json's top-level `packages` object. */
export type LockfilePackageKeys = ReadonlySet<string>;

export interface DepFilterResult {
  check: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface DepFilterInput {
  npmrc: string | null;
  lockfilePackageKeys: LockfilePackageKeys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readDeps(text: string | null): Map<string, string> {
  const parsed = parseJsonRecord(text);
  const depsByName = new Map<string, string>();
  if (parsed === null) return depsByName;

  for (const section of DEP_SECTIONS) {
    const deps = parsed[section];
    if (!isRecord(deps)) continue;

    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && !depsByName.has(name)) {
        depsByName.set(name, spec);
      }
    }
  }

  return depsByName;
}

/** Names present in the new package.json but not the old; null means an existing old manifest is malformed. */
export function newDependencyNames(oldJson: string | null, newJson: string | null): NewDep[] | null {
  if (oldJson !== null && parseJsonRecord(oldJson) === null) return null;
  const before = readDeps(oldJson);
  const newDeps = readDeps(newJson);
  const result: NewDep[] = [];

  for (const [name, spec] of newDeps) {
    if (!before.has(name)) result.push({ name, spec });
  }

  return result;
}

/**
 * Parses committed package-lock content into exact package keys. Callers must
 * obtain the text themselves (Task 12 uses `git show <head>:package-lock.json`).
 */
export function parseLockfilePackageKeys(lockfileJson: string | null): LockfilePackageKeys {
  const parsed = parseJsonRecord(lockfileJson);
  if (parsed === null || !isRecord(parsed.packages)) return new Set();
  return new Set(Object.keys(parsed.packages));
}

function npmrcOverrides(npmrc: string): { global: boolean; scopes: ReadonlySet<string> } {
  const global = /^\s*registry\s*=/m.test(npmrc);
  const scopes = new Set<string>();

  for (const match of npmrc.matchAll(/^\s*(@[^:/\s]+):registry\s*=/gm)) {
    scopes.add(match[1]!);
  }

  return { global, scopes };
}

function dependencyScope(name: string): string | null {
  if (!name.startsWith("@")) return null;
  const slash = name.indexOf("/");
  return slash > 1 ? name.slice(0, slash) : null;
}

/** Filters names that are eligible for a public npm registry check. */
export function filterCheckable(deps: NewDep[], input: DepFilterInput): DepFilterResult {
  const check: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const overrides = npmrcOverrides(input.npmrc ?? "");

  for (const dep of deps) {
    if (LOCAL_PROTOCOLS.test(dep.spec)) {
      skipped.push({ name: dep.name, reason: "local protocol" });
      continue;
    }
    if (overrides.global) {
      skipped.push({ name: dep.name, reason: "npmrc registry override" });
      continue;
    }
    const scope = dependencyScope(dep.name);
    if (scope !== null && overrides.scopes.has(scope)) {
      skipped.push({ name: dep.name, reason: "scoped registry override" });
      continue;
    }
    if (input.lockfilePackageKeys.has(`node_modules/${dep.name}`)) {
      skipped.push({ name: dep.name, reason: "already resolved in lockfile" });
      continue;
    }
    check.push(dep.name);
  }

  return { check, skipped };
}
