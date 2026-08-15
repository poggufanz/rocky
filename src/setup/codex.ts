import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import {
  createAppServerSessionFactory,
  isConfigVersionConflict,
  isUnsupportedAppServerMethod,
  type AppServerSession,
  type AppServerSessionFactory,
} from "./codex-app-server.js";
import { directorySyncCapability } from "./directory-sync.js";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";

const MISSING_DETAIL = "Codex CLI is not installed";
const CAPABILITY_DETAIL = "Codex app-server provenance and CAS capability is unavailable";
const CODEX_VERSION_TIMEOUT_MS = 5_000;
const MINIMUM_CODEX_VERSION = [0, 146, 1] as const;
const ROCKY_KEY_PATH = "mcp_servers.rocky";
const EFFECTIVE_ONLY_DEFAULTS: Readonly<Record<string, unknown>> = {
  cwd: null,
  disabled_tools: null,
  enabled: true,
  enabled_tools: null,
  // Codex-cli 0.146.1's real app-server synthesizes this leaf on every
  // mcp_servers.<name> effective view with no origin entry, same as the
  // other keys here - "local" is what it defaults to for a command/args
  // (stdio) server, which is the only shape Rocky ever writes. Confirmed
  // against the live 0.146.1 app-server (gate 12 host acceptance finding);
  // see docs/superpowers/sdd/2026-08-06-v021-final-hardening-handover/
  // codex-provenance-investigation.md for the raw transcript. Any other
  // value still fails closed - it is not this exact recognized default.
  environment_id: "local",
  required: false,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
};

export interface CodexAdapterDependencies {
  runner: ProcessRunner;
  executable?: string;
  recoveryBaseDirectory?: string;
  sessionFactory?: AppServerSessionFactory;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
}

interface RecoveryArtifact {
  path: string;
  directory: string;
  dev: number;
  ino: number;
  length: number;
  digest: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface CodexSnapshot {
  kind: "absent" | "present";
  configPath: string;
  version: string;
  trusted: boolean;
  entry?: JsonObject;
  registration?: McpRegistration;
}

type SnapshotRead =
  | { ok: true; snapshot: CodexSnapshot }
  | { ok: false };

type SessionOperation<T> =
  | { ok: true; value: T }
  | { ok: false };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function registrationFromEntry(entry: JsonObject): McpRegistration | undefined {
  if (typeof entry.command !== "string" || entry.command.length === 0
    || !isStringArray(entry.args)
    || !isStringMap(entry.env)) return undefined;
  return {
    name: "rocky",
    command: entry.command,
    args: [...entry.args],
    env: { ...entry.env },
  };
}

function entryHasOnlyRegistrationFields(entry: JsonObject): boolean {
  const allowed = new Set(["command", "args", "env"]);
  return Object.keys(entry).every((key) => allowed.has(key));
}

function entryForRegistration(registration: McpRegistration): JsonObject {
  return {
    command: registration.command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function nested(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function collectLeafPaths(value: unknown, path: string, output: Set<string>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) output.add(path);
    value.forEach((entry, index) => collectLeafPaths(entry, `${path}.${index}`, output));
    return;
  }
  if (isObject(value)) {
    if (Object.keys(value).length === 0) output.add(path);
    for (const [key, entry] of Object.entries(value)) {
      collectLeafPaths(entry, `${path}.${key}`, output);
    }
    return;
  }
  output.add(path);
}

function isProtocolVersion(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isBaseUserSource(value: unknown, configPath: string): boolean {
  return isObject(value)
    && value.type === "user"
    && typeof value.file === "string"
    && isAbsolute(value.file)
    && value.file === configPath
    && value.profile === null;
}

function originIsBaseUser(value: unknown, configPath: string, version: string): boolean {
  return isObject(value)
    && value.version === version
    && isBaseUserSource(value.name, configPath);
}

function effectiveEntryAgreesWithBase(effectiveEntry: JsonObject, baseEntry: JsonObject): boolean {
  for (const [key, baseValue] of Object.entries(baseEntry)) {
    if (!Object.prototype.hasOwnProperty.call(effectiveEntry, key)
      || !isDeepStrictEqual(effectiveEntry[key], baseValue)) return false;
  }
  for (const [key, effectiveValue] of Object.entries(effectiveEntry)) {
    if (Object.prototype.hasOwnProperty.call(baseEntry, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(EFFECTIVE_ONLY_DEFAULTS, key)
      || !isDeepStrictEqual(effectiveValue, EFFECTIVE_ONLY_DEFAULTS[key])) return false;
  }
  return true;
}

function effectiveDefaultPaths(effectiveEntry: JsonObject, baseEntry: JsonObject): Set<string> {
  const defaults = new Set<string>();
  for (const [key, effectiveValue] of Object.entries(effectiveEntry)) {
    if (!Object.prototype.hasOwnProperty.call(baseEntry, key)
      && Object.prototype.hasOwnProperty.call(EFFECTIVE_ONLY_DEFAULTS, key)
      && isDeepStrictEqual(effectiveValue, EFFECTIVE_ONLY_DEFAULTS[key])) {
      defaults.add(`${ROCKY_KEY_PATH}.${key}`);
    }
  }
  return defaults;
}

function parseConfigRead(value: unknown, configPath: string): SnapshotRead {
  if (!isObject(value)
    || !isObject(value.config)
    || !isObject(value.origins)
    || !Array.isArray(value.layers)) return { ok: false };
  const origins = value.origins;

  const matchingLayers = value.layers.filter((layer): layer is JsonObject => isObject(layer)
    && isBaseUserSource(layer.name, configPath));
  if (matchingLayers.length !== 1) return { ok: false };
  const baseLayer = matchingLayers[0]!;
  if (!isProtocolVersion(baseLayer.version) || !isObject(baseLayer.config)) {
    return { ok: false };
  }
  const baseVersion = baseLayer.version;

  const effectiveEntry = nested(value.config, ["mcp_servers", "rocky"]);
  const baseEntry = nested(baseLayer.config, ["mcp_servers", "rocky"]);
  const originPaths = new Set(Object.keys(origins).filter((path) => (
    path === ROCKY_KEY_PATH || path.startsWith(`${ROCKY_KEY_PATH}.`)
  )));
  if (effectiveEntry === undefined && baseEntry === undefined && originPaths.size === 0) {
    return {
      ok: true,
      snapshot: {
        kind: "absent",
        configPath,
        version: baseVersion,
        trusted: true,
      },
    };
  }

  const basePaths = new Set<string>();
  const effectivePaths = new Set<string>();
  if (baseEntry !== undefined) collectLeafPaths(baseEntry, ROCKY_KEY_PATH, basePaths);
  if (effectiveEntry !== undefined) collectLeafPaths(effectiveEntry, ROCKY_KEY_PATH, effectivePaths);
  const defaultPaths = isObject(baseEntry) && isObject(effectiveEntry)
    ? effectiveDefaultPaths(effectiveEntry, baseEntry)
    : new Set<string>();
  const actualPaths = new Set([...basePaths, ...effectivePaths].filter((path) => !defaultPaths.has(path)));
  const originsAreExact = [...originPaths].every((path) => actualPaths.has(path)
    && originIsBaseUser(origins[path], configPath, baseVersion));
  const everyMemberHasOrigin = [...actualPaths].every((path) => originPaths.has(path));
  const trusted = isObject(baseEntry)
    && isObject(effectiveEntry)
    && effectiveEntryAgreesWithBase(effectiveEntry, baseEntry)
    && actualPaths.size > 0
    && originsAreExact
    && everyMemberHasOrigin;
  const snapshot: CodexSnapshot = {
    kind: "present",
    configPath,
    version: baseVersion,
    trusted,
  };
  if (isObject(baseEntry)) {
    snapshot.entry = baseEntry;
    const registration = registrationFromEntry(baseEntry);
    if (registration !== undefined) snapshot.registration = registration;
  }
  return { ok: true, snapshot };
}

function parseVersion(result: ProcessResult): readonly [number, number, number] | undefined {
  if (result.status !== 0 || result.error !== undefined) return undefined;
  const match = /\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)\b/.exec(result.stdout);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function resolveCodexHome(dependencies: CodexAdapterDependencies): string {
  const cwd = dependencies.cwd ?? process.cwd();
  const configured = dependencies.env?.CODEX_HOME ?? process.env.CODEX_HOME;
  if (configured !== undefined && configured.length > 0) return resolve(cwd, configured);
  return resolve(dependencies.home ?? homedir(), ".codex");
}

function skipped(): SetupResult {
  return { client: "codex", status: "skipped", detail: MISSING_DETAIL };
}

function failed(detail: string, manualRegistration?: McpRegistration): SetupResult {
  const result: SetupResult = { client: "codex", status: "failed", detail };
  if (manualRegistration !== undefined) result.manualRegistration = manualRegistration;
  return result;
}

function manualFallback(reason: string, registration: McpRegistration): SetupResult {
  return failed(`${reason}; use manual registration`, registration);
}

function writeVersion(value: unknown, expectedPath: string): string | undefined {
  return isObject(value)
    && value.status === "ok"
    && isProtocolVersion(value.version)
    && typeof value.filePath === "string"
    && isAbsolute(value.filePath)
    && value.filePath === expectedPath
    ? value.version
    : undefined;
}

function syncDirectory(path: string): void {
  directorySyncCapability.sync(path);
}

function safeBaseDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function privateDirectory(path: string): boolean {
  if (!safeBaseDirectory(path)) return false;
  return process.platform === "win32" || (lstatSync(path).mode & 0o077) === 0;
}

function recoveryDigest(bytes: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recoveryArtifactIsExact(artifact: RecoveryArtifact): boolean {
  let descriptor: number | undefined;
  try {
    if (!privateDirectory(artifact.directory)) return false;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(artifact.path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (!before.isFile()
      || before.nlink !== 1
      || before.dev !== artifact.dev
      || before.ino !== artifact.ino
      || before.size !== artifact.length
      || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) return false;
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    return after.isFile()
      && after.nlink === 1
      && after.dev === artifact.dev
      && after.ino === artifact.ino
      && after.size === artifact.length
      && bytes.length === artifact.length
      && recoveryDigest(bytes) === artifact.digest;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* validation remains failed closed */ }
    }
  }
}

function persistRecoveryArtifact(baseDirectory: string, snapshot: unknown): RecoveryArtifact {
  if (!isAbsolute(baseDirectory) || !safeBaseDirectory(baseDirectory)) {
    throw new Error("unsafe recovery base");
  }
  const directory = join(baseDirectory, ".rocky-setup-recovery");
  try {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(baseDirectory);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "EEXIST" || !privateDirectory(directory)) {
      throw new Error("unsafe recovery directory");
    }
  }
  if (!privateDirectory(directory)) throw new Error("unsafe recovery directory");

  const path = join(directory, `codex-rocky-${randomBytes(16).toString("hex")}.json`);
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  let descriptor: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const opened = fstatSync(descriptor);
    identity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(directory);
    const artifact: RecoveryArtifact = {
      path,
      directory,
      dev: identity.dev,
      ino: identity.ino,
      length: bytes.length,
      digest: recoveryDigest(bytes),
    };
    if (!recoveryArtifactIsExact(artifact)) {
      throw new Error("unsafe recovery artifact");
    }
    return artifact;
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve secret-free failure */ }
    }
    if (identity !== undefined) {
      try {
        const stored = lstatSync(path);
        const artifact: RecoveryArtifact = {
          path,
          directory,
          dev: identity.dev,
          ino: identity.ino,
          length: bytes.length,
          digest: recoveryDigest(bytes),
        };
        if (stored.isFile()
          && stored.dev === identity.dev
          && stored.ino === identity.ino
          && recoveryArtifactIsExact(artifact)) {
          rmSync(path);
          syncDirectory(directory);
        }
      } catch {
        // Preparation failed before mutation; never report an unverified path.
      }
    }
    throw new Error("Unable to persist Codex recovery artifact");
  }
}

function removeRecoveryArtifact(artifact: RecoveryArtifact): boolean {
  try {
    if (!recoveryArtifactIsExact(artifact)) return false;
    const stored = lstatSync(artifact.path);
    if (!stored.isFile()
      || stored.isSymbolicLink()
      || stored.nlink !== 1
      || stored.dev !== artifact.dev
      || stored.ino !== artifact.ino) return false;
    rmSync(artifact.path);
    syncDirectory(artifact.directory);
    return true;
  } catch {
    return false;
  }
}

function recoveryFailure(
  prefix: string,
  artifact: RecoveryArtifact,
  desired: McpRegistration,
): SetupResult {
  if (recoveryArtifactIsExact(artifact)) {
    return failed(`${prefix}; manual recovery: ${artifact.path}`, desired);
  }
  return failed(`${prefix}; recovery artifact is unavailable`, desired);
}

function removedWithRecovery(artifact: RecoveryArtifact): SetupResult {
  if (recoveryArtifactIsExact(artifact)) {
    return {
      client: "codex",
      status: "removed",
      detail: `Codex recovery artifact retained; manual recovery: ${artifact.path}`,
    };
  }
  return failed("Codex registration was removed but recovery artifact is unavailable");
}

function removedWithWarning(
  configPath: string,
  artifact: RecoveryArtifact,
): SetupResult {
  if (recoveryArtifactIsExact(artifact)) {
    return {
      client: "codex",
      status: "removed",
      detail: `Codex removed the rocky entry from ${configPath}; exact CAS version could not be confirmed. `
        + `Codex recovery artifact retained; manual recovery: ${artifact.path}`,
    };
  }
  return failed("Codex registration was removed but recovery artifact is unavailable");
}

function classifyRemovalFinalState(
  finalRead: SnapshotRead,
  writtenVersion: string | undefined,
  configPath: string,
  artifact: RecoveryArtifact,
  desired: McpRegistration,
): SetupResult {
  if (!finalRead.ok) {
    return recoveryFailure(
      `Codex removal final state at ${configPath} could not be read`,
      artifact,
      desired,
    );
  }
  if (finalRead.snapshot.kind === "present") {
    return recoveryFailure(
      `Codex removal could not be verified: rocky entry remains in ${configPath} after removal`,
      artifact,
      desired,
    );
  }
  return writtenVersion !== undefined && finalRead.snapshot.version === writtenVersion
    ? removedWithRecovery(artifact)
    : removedWithWarning(configPath, artifact);
}

export function createCodexAdapter(dependencies: CodexAdapterDependencies): SetupClientAdapter {
  const { runner, executable } = dependencies;
  const codexHome = resolveCodexHome(dependencies);
  const configPath = join(codexHome, "config.toml");
  const sessionFactory = dependencies.sessionFactory ?? createAppServerSessionFactory(runner);

  async function versionIsCapable(): Promise<boolean> {
    if (executable === undefined) return false;
    try {
      const result = await runner.run(executable, ["--version"], {
        timeoutMs: CODEX_VERSION_TIMEOUT_MS,
        env: { ...process.env, ...dependencies.env, CODEX_HOME: codexHome },
      });
      const version = parseVersion(result);
      return version !== undefined && versionAtLeast(version, MINIMUM_CODEX_VERSION);
    } catch {
      return false;
    }
  }

  async function withSession<T>(
    operation: (session: AppServerSession) => Promise<T>,
  ): Promise<SessionOperation<T>> {
    if (executable === undefined || !(await versionIsCapable())) return { ok: false };
    let session: AppServerSession | undefined;
    let outcome: SessionOperation<T> = { ok: false };
    try {
      session = await sessionFactory.open(executable, codexHome);
      if (!isAbsolute(session.codexHome) || session.codexHome !== codexHome) {
        throw new Error("unexpected Codex home");
      }
      outcome = { ok: true, value: await operation(session) };
    } catch {
      outcome = { ok: false };
    }
    if (session === undefined) return outcome;
    try {
      await session.close();
    } catch {
      return { ok: false };
    }
    return outcome;
  }

  async function readFromSession(session: AppServerSession): Promise<SnapshotRead> {
    return parseConfigRead(
      await session.request("config/read", { includeLayers: true }),
      configPath,
    );
  }

  async function loadSnapshot(): Promise<SnapshotRead> {
    const operation = await withSession(readFromSession);
    return operation.ok ? operation.value : { ok: false };
  }

  function inspectionFromSnapshot(
    snapshot: CodexSnapshot,
    registration: McpRegistration,
  ): InspectionResult {
    if (snapshot.kind === "absent") return { state: "absent", snapshot };
    if (!snapshot.trusted) {
      return {
        state: "conflict",
        detail: "Codex rocky registration provenance is not base user config",
        snapshot,
      };
    }
    if (snapshot.entry !== undefined
      && snapshot.registration !== undefined
      && entryHasOnlyRegistrationFields(snapshot.entry)
      && isIdenticalMcpRegistration(snapshot.registration, registration)) {
      return { state: "identical", snapshot };
    }
    return { state: "conflict", snapshot };
  }

  async function inspectRegistration(registration: McpRegistration): Promise<InspectionResult> {
    const read = await loadSnapshot();
    return read.ok
      ? inspectionFromSnapshot(read.snapshot, registration)
      : { state: "unreadable", detail: CAPABILITY_DETAIL };
  }

  return {
    id: "codex",

    inspect(registration) {
      if (executable === undefined) return Promise.resolve({ state: "blocked", detail: MISSING_DETAIL });
      return inspectRegistration(registration);
    },

    async configure(registration, replace) {
      if (executable === undefined) return skipped();
      const desiredEntry = entryForRegistration(registration);
      let destructiveRecovery: RecoveryArtifact | undefined;
      let verifiedAbsentAdd = false;
      const operation = await withSession(async (session): Promise<SetupResult> => {
        const read = await readFromSession(session);
        if (!read.ok) return manualFallback(CAPABILITY_DETAIL, registration);
        const { snapshot } = read;

        if (snapshot.kind === "absent") {
          let written: unknown;
          try {
            written = await session.request("config/value/write", {
              filePath: configPath,
              keyPath: ROCKY_KEY_PATH,
              value: desiredEntry,
              mergeStrategy: "upsert",
              expectedVersion: snapshot.version,
            });
          } catch (error) {
            return isConfigVersionConflict(error)
              ? manualFallback("Codex registration changed before CAS add", registration)
              : manualFallback(CAPABILITY_DETAIL, registration);
          }
          const writtenVersion = writeVersion(written, configPath);
          if (writtenVersion === undefined || writtenVersion === snapshot.version) {
            return manualFallback("Codex CAS add failed", registration);
          }
          const verified = await readFromSession(session);
          if (!verified.ok
            || verified.snapshot.kind !== "present"
            || verified.snapshot.version !== writtenVersion
            || !verified.snapshot.trusted
            || !isDeepStrictEqual(verified.snapshot.entry, desiredEntry)) {
            // Reached only once writeVersion() above has confirmed the CAS
            // write advanced the on-disk version - a write is a fact here,
            // not a possibility. Say so and name the exact file: telling
            // the user to "use manual registration" without disclosing
            // that is exactly the gate 12 finding this guards against.
            return manualFallback(
              `Codex wrote to ${configPath}, but the result could not be verified; check ${configPath} for mcp_servers.rocky`,
              registration,
            );
          }
          verifiedAbsentAdd = true;
          return { client: "codex", status: "configured" };
        }

        const identical = snapshot.trusted
          && snapshot.entry !== undefined
          && snapshot.registration !== undefined
          && entryHasOnlyRegistrationFields(snapshot.entry)
          && isIdenticalMcpRegistration(snapshot.registration, registration);
        if (identical) return { client: "codex", status: "already-configured" };
        if (!replace) {
          return {
            client: "codex",
            status: "requires-confirmation",
            detail: "Codex already has a different rocky registration",
            manualRegistration: registration,
          };
        }
        if (!snapshot.trusted || snapshot.entry === undefined) {
          return manualFallback(
            "Codex rocky registration provenance is not base user config",
            registration,
          );
        }

        const rockyHome = registration.env.ROCKY_HOME;
        const recoveryBase = dependencies.recoveryBaseDirectory
          ?? (rockyHome === undefined ? undefined : dirname(rockyHome));
        let recovery: RecoveryArtifact;
        try {
          if (recoveryBase === undefined) throw new Error("missing recovery base");
          recovery = persistRecoveryArtifact(recoveryBase, snapshot.entry);
          destructiveRecovery = recovery;
        } catch {
          return manualFallback(
            "Unable to create private Codex recovery artifact; replacement stopped",
            registration,
          );
        }
        if (!recoveryArtifactIsExact(recovery)) {
          return recoveryFailure(
            "Codex recovery artifact changed before replacement; no changes made",
            recovery,
            registration,
          );
        }

        let written: unknown;
        try {
          written = await session.request("config/batchWrite", {
            filePath: configPath,
            expectedVersion: snapshot.version,
            edits: [
              { keyPath: ROCKY_KEY_PATH, value: null, mergeStrategy: "replace" },
              { keyPath: ROCKY_KEY_PATH, value: desiredEntry, mergeStrategy: "upsert" },
            ],
          });
        } catch (error) {
          const prefix = isConfigVersionConflict(error)
            ? "Codex registration changed before replacement; no changes made"
            : isUnsupportedAppServerMethod(error)
              ? "Codex app-server CAS replacement is unsupported"
              : "Codex CAS replacement failed";
          return recoveryFailure(prefix, recovery, registration);
        }
        const writtenVersion = writeVersion(written, configPath);
        if (writtenVersion === undefined || writtenVersion === snapshot.version) {
          return recoveryFailure("Codex CAS replacement failed", recovery, registration);
        }
        const verified = await readFromSession(session);
        if (!verified.ok
          || verified.snapshot.kind !== "present"
          || verified.snapshot.version !== writtenVersion
          || !verified.snapshot.trusted
          || !isDeepStrictEqual(verified.snapshot.entry, desiredEntry)) {
          // Same disclosure requirement as the absent-add branch above: the
          // CAS batch write already advanced the on-disk version by this
          // point, so the message must say a write landed and name the
          // file, not just point at the recovery backup as if the file
          // were still in its prior state.
          return recoveryFailure(
            `Codex wrote to ${configPath}, but the replacement could not be verified; check ${configPath} for mcp_servers.rocky`,
            recovery,
            registration,
          );
        }
        return { client: "codex", status: "configured" };
      });
      if (!operation.ok) {
        if (verifiedAbsentAdd) return { client: "codex", status: "configured" };
        return destructiveRecovery === undefined
          ? manualFallback(CAPABILITY_DETAIL, registration)
          : recoveryFailure(
            "Codex app-server session did not shut down cleanly",
            destructiveRecovery,
            registration,
          );
      }
      if (destructiveRecovery !== undefined
        && operation.value.status !== "configured"
        && !recoveryArtifactIsExact(destructiveRecovery)) {
        return failed(
          "Codex recovery artifact is unavailable after app-server shutdown",
          registration,
        );
      }
      if (operation.value.status === "configured" && destructiveRecovery !== undefined) {
        return removeRecoveryArtifact(destructiveRecovery)
          ? operation.value
          : recoveryFailure(
            "Codex recovery artifact cleanup failed",
            destructiveRecovery,
            registration,
          );
      }
      return operation.value;
    },

    async remove(registration) {
      if (executable === undefined) return skipped();
      let destructiveRecovery: RecoveryArtifact | undefined;
      const operation = await withSession(async (session): Promise<SetupResult> => {
        const read = await readFromSession(session);
        if (!read.ok) return manualFallback(CAPABILITY_DETAIL, registration);
        const { snapshot } = read;
        if (snapshot.kind === "absent") return { client: "codex", status: "not-configured" };
        if (!snapshot.trusted || snapshot.entry === undefined) {
          return failed("Codex rocky registration provenance is not base user config");
        }
        if (snapshot.registration === undefined
          || !isOwnedRockyRegistration(snapshot.registration, registration)) {
          return failed("Codex rocky registration is not owned by Rocky");
        }

        const rockyHome = registration.env.ROCKY_HOME;
        const recoveryBase = dependencies.recoveryBaseDirectory
          ?? (rockyHome === undefined ? undefined : dirname(rockyHome));
        let recovery: RecoveryArtifact;
        try {
          if (recoveryBase === undefined) throw new Error("missing recovery base");
          recovery = persistRecoveryArtifact(recoveryBase, snapshot.entry);
          destructiveRecovery = recovery;
        } catch {
          return manualFallback(
            "Unable to create private Codex recovery artifact; removal stopped",
            registration,
          );
        }
        if (!recoveryArtifactIsExact(recovery)) {
          return recoveryFailure(
            "Codex recovery artifact changed before removal; no changes made",
            recovery,
            registration,
          );
        }

        let written: unknown;
        try {
          written = await session.request("config/value/write", {
            filePath: configPath,
            keyPath: ROCKY_KEY_PATH,
            value: null,
            mergeStrategy: "replace",
            expectedVersion: snapshot.version,
          });
        } catch (error) {
          const prefix = isConfigVersionConflict(error)
            ? "Codex registration changed before removal; no changes made"
            : isUnsupportedAppServerMethod(error)
              ? "Codex app-server CAS removal is unsupported"
              : "Codex CAS removal failed";
          return recoveryFailure(prefix, recovery, registration);
        }
        // The app-server's null/replace response is not a durable proof of
        // its final version. Codex 0.147.0 can advance the file version again
        // before the following read, and some successful responses carry no
        // usable version at all. The final effective state is authoritative:
        // absent means removed (with a warning when the exact CAS version is
        // not bound), present means the mutation did not take.
        const writtenVersion = writeVersion(written, configPath);
        let verified: SnapshotRead;
        try {
          verified = await readFromSession(session);
        } catch {
          verified = { ok: false };
        }
        return classifyRemovalFinalState(
          verified,
          writtenVersion === snapshot.version ? undefined : writtenVersion,
          configPath,
          recovery,
          registration,
        );
      });
      if (operation.ok) {
        if (destructiveRecovery !== undefined
          && !recoveryArtifactIsExact(destructiveRecovery)) {
          return failed(
            "Codex registration recovery artifact is unavailable after app-server shutdown",
          );
        }
        return operation.value;
      }
      return destructiveRecovery === undefined
        ? manualFallback(CAPABILITY_DETAIL, registration)
        : recoveryFailure(
          "Codex app-server session did not shut down cleanly",
          destructiveRecovery,
          registration,
        );
    },

    async check(registration) {
      if (executable === undefined) return skipped();
      const read = await loadSnapshot();
      if (!read.ok) return manualFallback(CAPABILITY_DETAIL, registration);
      const { snapshot } = read;
      if (snapshot.kind === "absent") return { client: "codex", status: "not-configured" };
      if (snapshot.trusted
        && snapshot.entry !== undefined
        && entryHasOnlyRegistrationFields(snapshot.entry)
        && snapshot.registration !== undefined
        && isOwnedRockyRegistration(snapshot.registration, registration)) {
        return {
          client: "codex",
          status: "healthy",
          healthRegistration: snapshot.registration,
        };
      }
      return failed("Codex has a different rocky registration", registration);
    },
  };
}
