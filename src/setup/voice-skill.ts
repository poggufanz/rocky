import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME } from "../core/package-info.js";

export const VOICE_SKILL_NAME = "rocky-voice";

const MARKER_NAME = ".rocky-managed.json";
const SOURCE_ROOT = fileURLToPath(new URL("../../skills/rocky-voice/", import.meta.url));
let uniqueSequence = 0;

export interface VoiceSkillMarker {
  schemaVersion: 1;
  packageName: typeof PACKAGE_NAME;
  sourceHash: string;
  installedHash: string;
}

export interface VoiceSkillTarget {
  host: "codex" | "claude-code";
  destination: string;
  backupRoot: string;
}

export interface VoiceSkillOperationResult {
  host: VoiceSkillTarget["host"];
  status: "installed" | "unchanged" | "upgraded" | "removed" | "skipped" | "refused" | "failed";
  detail: string;
  backupPath?: string;
}

type FsPromises = typeof import("node:fs/promises");
export type VoiceSkillFileOps = Pick<FsPromises,
  "lstat" | "realpath" | "readdir" | "mkdir" | "copyFile" | "writeFile" | "rename" | "rm"
>;

const defaultOps: VoiceSkillFileOps = {
  lstat: fs.lstat,
  realpath: fs.realpath,
  readdir: fs.readdir,
  mkdir: fs.mkdir,
  copyFile: fs.copyFile,
  writeFile: fs.writeFile,
  rename: fs.rename,
  rm: fs.rm,
};

class VoiceSkillRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceSkillRefusal";
  }
}

class VoiceSkillTransactionError extends Error {
  readonly crossDevice: boolean;
  readonly refused: boolean;

  constructor(message: string, crossDevice = false, refused = false) {
    super(message);
    this.name = "VoiceSkillTransactionError";
    this.crossDevice = crossDevice;
    this.refused = refused;
  }
}

interface TreeFile {
  relativePath: string;
  sourcePath: string;
  content: Buffer;
}

interface TargetLayout {
  hostRoot: string;
  skillsRoot: string;
  stagingRoot: string;
}

type TargetInspection =
  | { state: "absent" }
  | { state: "unmanaged" }
  | { state: "corrupt"; detail: string }
  | { state: "modified"; marker: VoiceSkillMarker; installedHash: string }
  | { state: "managed"; marker: VoiceSkillMarker; installedHash: string };

function errno(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function isMissing(error: unknown): boolean {
  return errno(error) === "ENOENT";
}

function isCrossDevice(error: unknown): boolean {
  return errno(error) === "EXDEV";
}

function isDestinationCollision(error: unknown): boolean {
  const code = errno(error);
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR";
}

async function optionalLstat(path: string, ops: VoiceSkillFileOps): Promise<Stats | undefined> {
  try {
    return await ops.lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertLexicallyInside(root: string, candidate: string): void {
  if (!pathInside(root, candidate)) {
    throw new VoiceSkillRefusal(`Voice skill path is outside allowed root: ${candidate}`);
  }
}

function assertOrdinaryDirectory(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) throw new VoiceSkillRefusal(`Voice skill topology contains symbolic link: ${path}`);
  if (!stats.isDirectory()) throw new VoiceSkillRefusal(`Voice skill topology is not directory: ${path}`);
}

function assertOrdinaryFile(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) throw new VoiceSkillRefusal(`Voice skill topology contains symbolic link: ${path}`);
  if (!stats.isFile()) throw new VoiceSkillRefusal(`Voice skill topology is not regular file: ${path}`);
}

async function assertCanonicalInside(
  canonicalRoot: string,
  path: string,
  ops: VoiceSkillFileOps,
): Promise<string> {
  const canonical = await ops.realpath(path);
  if (!pathInside(canonicalRoot, canonical)) {
    throw new VoiceSkillRefusal(`Voice skill canonical path escapes allowed root: ${path}`);
  }
  return canonical;
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

async function readStableFile(
  path: string,
  canonicalRoot: string,
  ops: VoiceSkillFileOps,
): Promise<Buffer> {
  const before = await ops.lstat(path);
  assertOrdinaryFile(before, path);
  await assertCanonicalInside(canonicalRoot, path, ops);
  const content = await fs.readFile(path);
  const after = await ops.lstat(path);
  assertOrdinaryFile(after, path);
  await assertCanonicalInside(canonicalRoot, path, ops);
  if (!sameFileIdentity(before, after) || after.size !== content.length) {
    throw new VoiceSkillRefusal(`Voice skill file changed during read: ${path}`);
  }
  return content;
}

async function collectTreeFiles(
  root: string,
  ops: VoiceSkillFileOps,
): Promise<TreeFile[]> {
  const rootStats = await ops.lstat(root);
  assertOrdinaryDirectory(rootStats, root);
  const canonicalRoot = await ops.realpath(root);

  const visit = async (directory: string, relativeDirectory: string): Promise<TreeFile[]> => {
    const before = await ops.lstat(directory);
    assertOrdinaryDirectory(before, directory);
    await assertCanonicalInside(canonicalRoot, directory, ops);
    const entries = await ops.readdir(directory, { withFileTypes: true }) as Dirent[];
    const files: TreeFile[] = [];
    for (const entry of [...entries].sort((left, right) => Buffer.compare(
      Buffer.from(left.name, "utf8"),
      Buffer.from(right.name, "utf8"),
    ))) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath === MARKER_NAME) continue;
      const sourcePath = join(directory, entry.name);
      const stats = await ops.lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new VoiceSkillRefusal(`Voice skill topology contains symbolic link: ${sourcePath}`);
      }
      if (stats.isDirectory()) {
        files.push(...await visit(sourcePath, relativePath));
        continue;
      }
      assertOrdinaryFile(stats, sourcePath);
      files.push({
        relativePath,
        sourcePath,
        content: await readStableFile(sourcePath, canonicalRoot, ops),
      });
    }
    const after = await ops.lstat(directory);
    assertOrdinaryDirectory(after, directory);
    await assertCanonicalInside(canonicalRoot, directory, ops);
    if (!sameFileIdentity(before, after)) {
      throw new VoiceSkillRefusal(`Voice skill directory changed during traversal: ${directory}`);
    }
    return files;
  };

  return (await visit(root, "")).sort((left, right) => Buffer.compare(
    Buffer.from(left.relativePath, "utf8"),
    Buffer.from(right.relativePath, "utf8"),
  ));
}

function hashFiles(files: readonly TreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(file.content.length));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(contentLength);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

async function contentHash(root: string, ops: VoiceSkillFileOps): Promise<string> {
  return hashFiles(await collectTreeFiles(root, ops));
}

async function createDirectoryComponent(path: string, ops: VoiceSkillFileOps): Promise<void> {
  try {
    await ops.mkdir(path);
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  const stats = await ops.lstat(path);
  assertOrdinaryDirectory(stats, path);
}

async function ensureSafeDirectory(
  allowedRoot: string,
  directory: string,
  ops: VoiceSkillFileOps,
): Promise<string> {
  assertLexicallyInside(allowedRoot, directory);
  const rootStats = await optionalLstat(allowedRoot, ops);
  if (rootStats === undefined) await ops.mkdir(allowedRoot, { recursive: true });
  assertOrdinaryDirectory(await ops.lstat(allowedRoot), allowedRoot);
  const canonicalRoot = await ops.realpath(allowedRoot);

  const path = relative(resolve(allowedRoot), resolve(directory));
  let current = resolve(allowedRoot);
  for (const component of path === "" ? [] : path.split(sep)) {
    current = join(current, component);
    await createDirectoryComponent(current, ops);
    await assertCanonicalInside(canonicalRoot, current, ops);
  }
  return canonicalRoot;
}

async function inspectExistingComponents(
  allowedRoot: string,
  path: string,
  ops: VoiceSkillFileOps,
): Promise<"present" | "absent"> {
  assertLexicallyInside(allowedRoot, path);
  const rootStats = await optionalLstat(allowedRoot, ops);
  if (rootStats === undefined) return "absent";
  assertOrdinaryDirectory(rootStats, allowedRoot);
  const canonicalRoot = await ops.realpath(allowedRoot);
  let current = resolve(allowedRoot);
  const components = relative(current, resolve(path)).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index] ?? "");
    const stats = await optionalLstat(current, ops);
    if (stats === undefined) return "absent";
    if (stats.isSymbolicLink()) {
      throw new VoiceSkillRefusal(`Voice skill topology contains symbolic link: ${current}`);
    }
    if (index < components.length - 1) assertOrdinaryDirectory(stats, current);
    await assertCanonicalInside(canonicalRoot, current, ops);
  }
  return "present";
}

function targetLayout(target: VoiceSkillTarget): TargetLayout {
  const destination = resolve(target.destination);
  const skillsRoot = dirname(destination);
  const hostRoot = dirname(skillsRoot);
  const expectedDestination = join(hostRoot, "skills", VOICE_SKILL_NAME);
  const expectedBackup = join(hostRoot, ".rocky", "backups", "voice-skills");
  if (destination !== expectedDestination || resolve(target.backupRoot) !== expectedBackup) {
    throw new VoiceSkillRefusal("Voice skill target does not match managed host layout");
  }
  return {
    hostRoot,
    skillsRoot,
    stagingRoot: join(hostRoot, ".rocky", "staging", "voice-skills"),
  };
}

async function prepareTargetRoots(
  target: VoiceSkillTarget,
  ops: VoiceSkillFileOps,
): Promise<TargetLayout> {
  const layout = targetLayout(target);
  await ensureSafeDirectory(layout.hostRoot, layout.skillsRoot, ops);
  await ensureSafeDirectory(layout.hostRoot, layout.stagingRoot, ops);
  await ensureSafeDirectory(layout.hostRoot, target.backupRoot, ops);
  return layout;
}

function isMarker(value: unknown): value is VoiceSkillMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return Object.keys(marker).sort().join(",") === "installedHash,packageName,schemaVersion,sourceHash"
    && marker.schemaVersion === 1
    && marker.packageName === PACKAGE_NAME
    && typeof marker.sourceHash === "string"
    && /^[a-f0-9]{64}$/.test(marker.sourceHash)
    && typeof marker.installedHash === "string"
    && /^[a-f0-9]{64}$/.test(marker.installedHash);
}

async function parseMarker(
  destination: string,
  ops: VoiceSkillFileOps,
): Promise<{ state: "missing" } | { state: "corrupt"; detail: string } | { state: "valid"; marker: VoiceSkillMarker }> {
  const markerPath = join(destination, MARKER_NAME);
  const stats = await optionalLstat(markerPath, ops);
  if (stats === undefined) return { state: "missing" };
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { state: "corrupt", detail: "Voice skill ownership marker is unsafe" };
  }
  const canonicalDestination = await ops.realpath(destination);
  try {
    await assertCanonicalInside(canonicalDestination, markerPath, ops);
    const before = await ops.lstat(markerPath);
    const text = await fs.readFile(markerPath, "utf8");
    const after = await ops.lstat(markerPath);
    if (!sameFileIdentity(before, after)) {
      return { state: "corrupt", detail: "Voice skill ownership marker changed during read" };
    }
    const value: unknown = JSON.parse(text);
    return isMarker(value)
      ? { state: "valid", marker: value }
      : { state: "corrupt", detail: "Voice skill ownership marker is corrupted" };
  } catch (error) {
    if (error instanceof VoiceSkillRefusal) {
      return { state: "corrupt", detail: error.message };
    }
    return { state: "corrupt", detail: "Voice skill ownership marker is corrupted" };
  }
}

async function inspectTarget(
  target: VoiceSkillTarget,
  ops: VoiceSkillFileOps,
): Promise<TargetInspection> {
  const layout = targetLayout(target);
  const presence = await inspectExistingComponents(layout.hostRoot, target.destination, ops);
  if (presence === "absent") return { state: "absent" };
  const stats = await ops.lstat(target.destination);
  assertOrdinaryDirectory(stats, target.destination);
  const parsed = await parseMarker(target.destination, ops);
  if (parsed.state === "missing") return { state: "unmanaged" };
  if (parsed.state === "corrupt") return { state: "corrupt", detail: parsed.detail };
  let installedHash: string;
  try {
    installedHash = await contentHash(target.destination, ops);
  } catch (error) {
    if (error instanceof VoiceSkillRefusal) throw error;
    return { state: "corrupt", detail: "Voice skill managed content cannot be read safely" };
  }
  return installedHash === parsed.marker.installedHash
    ? { state: "managed", marker: parsed.marker, installedHash }
    : { state: "modified", marker: parsed.marker, installedHash };
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[^0-9A-Za-z]/g, "-");
}

function uniquePath(root: string, kind: "staged" | "backup", now: Date): string {
  uniqueSequence += 1;
  return join(root, `${VOICE_SKILL_NAME}-${kind}-${timestamp(now)}-${process.pid}-${uniqueSequence}`);
}

function resultForError(
  target: VoiceSkillTarget,
  error: unknown,
  paths: { staged?: string; backup?: string } = {},
): VoiceSkillOperationResult {
  const pathDetails = [
    paths.staged === undefined ? undefined : `staged: ${paths.staged}`,
    paths.backup === undefined ? undefined : `backup: ${paths.backup}`,
  ].filter((value): value is string => value !== undefined);
  const message = error instanceof Error ? error.message : "Voice skill operation failed";
  const detail = pathDetails.length === 0 ? message : `${message}; ${pathDetails.join("; ")}`;
  const refused = error instanceof VoiceSkillRefusal
    || (error instanceof VoiceSkillTransactionError && (error.crossDevice || error.refused))
    || isCrossDevice(error)
    || isDestinationCollision(error);
  return { host: target.host, status: refused ? "refused" : "failed", detail };
}

export function resolveVoiceSkillTargets(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): readonly VoiceSkillTarget[] {
  const claudeRoot = env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_CONFIG_DIR === ""
    ? join(homeDir, ".claude")
    : env.CLAUDE_CONFIG_DIR;
  return Object.freeze([
    Object.freeze({
      host: "codex" as const,
      destination: join(homeDir, ".agents", "skills", VOICE_SKILL_NAME),
      backupRoot: join(homeDir, ".agents", ".rocky", "backups", "voice-skills"),
    }),
    Object.freeze({
      host: "claude-code" as const,
      destination: join(claudeRoot, "skills", VOICE_SKILL_NAME),
      backupRoot: join(claudeRoot, ".rocky", "backups", "voice-skills"),
    }),
  ]);
}

export async function copyTreeNoSymlinks(
  source: string,
  staged: string,
  allowedRoot: string,
  ops: VoiceSkillFileOps = defaultOps,
): Promise<void> {
  assertLexicallyInside(allowedRoot, staged);
  const files = await collectTreeFiles(source, ops);
  const sourceHash = hashFiles(files);
  const canonicalAllowed = await ensureSafeDirectory(allowedRoot, dirname(staged), ops);
  const existing = await optionalLstat(staged, ops);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw new VoiceSkillRefusal(`Voice skill staged path is symbolic link: ${staged}`);
    throw new VoiceSkillRefusal(`Voice skill staged path already exists: ${staged}`);
  }
  await ops.mkdir(staged);
  assertOrdinaryDirectory(await ops.lstat(staged), staged);
  const canonicalStaged = await assertCanonicalInside(canonicalAllowed, staged, ops);

  const createdDirectories = new Set<string>([staged]);
  for (const file of files) {
    const destination = join(staged, ...file.relativePath.split("/"));
    const destinationDirectory = dirname(destination);
    if (!createdDirectories.has(destinationDirectory)) {
      await ensureSafeDirectory(staged, destinationDirectory, ops);
      createdDirectories.add(destinationDirectory);
    }
    const sourceBefore = await ops.lstat(file.sourcePath);
    assertOrdinaryFile(sourceBefore, file.sourcePath);
    await ops.copyFile(file.sourcePath, destination, constants.COPYFILE_EXCL);
    const sourceAfter = await ops.lstat(file.sourcePath);
    assertOrdinaryFile(sourceAfter, file.sourcePath);
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new VoiceSkillRefusal(`Voice skill source changed during copy: ${file.sourcePath}`);
    }
    const copied = await ops.lstat(destination);
    assertOrdinaryFile(copied, destination);
    await assertCanonicalInside(canonicalStaged, destination, ops);
  }

  const installedHash = await contentHash(staged, ops);
  if (sourceHash !== installedHash) {
    throw new VoiceSkillRefusal("Voice skill staged content hash does not match source");
  }
  const marker: VoiceSkillMarker = {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    sourceHash,
    installedHash,
  };
  const markerPath = join(staged, MARKER_NAME);
  await ops.writeFile(markerPath, `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  assertOrdinaryFile(await ops.lstat(markerPath), markerPath);
  await assertCanonicalInside(canonicalStaged, markerPath, ops);
  if (await contentHash(staged, ops) !== installedHash) {
    throw new VoiceSkillRefusal("Voice skill staged content changed after marker write");
  }
}

export async function replaceDirectoryTransactionally(
  target: string,
  staged: string,
  backup: string,
  ops: VoiceSkillFileOps = defaultOps,
): Promise<void> {
  try {
    await ops.rename(target, backup);
  } catch (error) {
    throw new VoiceSkillTransactionError(
      `Voice skill target-to-backup rename failed: target ${target}; backup ${backup}`,
      isCrossDevice(error),
    );
  }

  try {
    if (await optionalLstat(target, ops) !== undefined) {
      throw new VoiceSkillRefusal(`Voice skill destination raced after backup: ${target}`);
    }
    await ops.rename(staged, target);
  } catch (activationError) {
    try {
      if (await optionalLstat(target, ops) !== undefined) {
        throw new VoiceSkillRefusal(`Voice skill destination race blocks rollback: ${target}`);
      }
      await ops.rename(backup, target);
    } catch {
      throw new VoiceSkillTransactionError(
        `Voice skill activation and rollback failed; staged ${staged}; backup ${backup}; target ${target}`,
        isCrossDevice(activationError),
      );
    }
    throw new VoiceSkillTransactionError(
      `Voice skill activation failed and original target was restored; staged ${staged}; backup ${backup}`,
      isCrossDevice(activationError),
      activationError instanceof VoiceSkillRefusal || isDestinationCollision(activationError),
    );
  }
}

async function activateMissingTarget(
  target: string,
  staged: string,
  ops: VoiceSkillFileOps,
): Promise<void> {
  if (await optionalLstat(target, ops) !== undefined) {
    throw new VoiceSkillRefusal(`Voice skill destination changed before activation: ${target}`);
  }
  try {
    await ops.rename(staged, target);
  } catch (error) {
    if (isCrossDevice(error)) {
      throw new VoiceSkillTransactionError(
        `Voice skill activation crosses filesystem: staged ${staged}; target ${target}`,
        true,
      );
    }
    if (isDestinationCollision(error) || await optionalLstat(target, ops) !== undefined) {
      throw new VoiceSkillRefusal(`Voice skill destination race refused: ${target}`);
    }
    throw error;
  }
}

async function verifyActivatedTarget(
  target: VoiceSkillTarget,
  expectedHash: string,
  ops: VoiceSkillFileOps,
): Promise<void> {
  const inspection = await inspectTarget(target, ops);
  if (inspection.state !== "managed"
    || inspection.installedHash !== expectedHash
    || inspection.marker.sourceHash !== expectedHash) {
    throw new VoiceSkillTransactionError(
      `Voice skill activated target failed validation: ${target.destination}`,
    );
  }
}

export async function installVoiceSkill(
  target: VoiceSkillTarget,
  options: { replace: boolean; ops?: VoiceSkillFileOps; now?: Date },
): Promise<VoiceSkillOperationResult> {
  const ops = options.ops ?? defaultOps;
  let inspection: TargetInspection;
  let sourceHash: string;
  try {
    sourceHash = await contentHash(SOURCE_ROOT, ops);
    inspection = await inspectTarget(target, ops);
  } catch (error) {
    return resultForError(target, error);
  }

  if (inspection.state === "corrupt") {
    return { host: target.host, status: "refused", detail: inspection.detail };
  }
  if (inspection.state === "managed"
    && inspection.marker.sourceHash === sourceHash
    && inspection.installedHash === sourceHash) {
    return { host: target.host, status: "unchanged", detail: "Managed voice skill is current" };
  }
  if (inspection.state === "unmanaged" && !options.replace) {
    return { host: target.host, status: "refused", detail: "Voice skill destination is unmanaged; use --replace to preserve and replace it" };
  }
  if (inspection.state === "modified" && !options.replace) {
    return { host: target.host, status: "refused", detail: "Managed voice skill contains user modifications; use --replace or remove it manually" };
  }

  let layout: TargetLayout;
  const now = options.now ?? new Date();
  try {
    layout = await prepareTargetRoots(target, ops);
  } catch (error) {
    return resultForError(target, error);
  }
  const staged = uniquePath(layout.stagingRoot, "staged", now);
  try {
    await copyTreeNoSymlinks(SOURCE_ROOT, staged, layout.hostRoot, ops);
  } catch (error) {
    return resultForError(target, error, { staged });
  }

  if (inspection.state === "absent") {
    try {
      await activateMissingTarget(target.destination, staged, ops);
      await verifyActivatedTarget(target, sourceHash, ops);
      return { host: target.host, status: "installed", detail: "Managed voice skill installed" };
    } catch (error) {
      return resultForError(target, error, { staged });
    }
  }

  const backup = uniquePath(target.backupRoot, "backup", now);
  try {
    const current = await inspectTarget(target, ops);
    const unchangedSinceInspection = current.state === inspection.state
      && (current.state === "unmanaged"
        || ("installedHash" in current
          && "installedHash" in inspection
          && current.installedHash === inspection.installedHash));
    if (!unchangedSinceInspection) {
      throw new VoiceSkillRefusal(`Voice skill destination changed before replacement: ${target.destination}`);
    }
    await replaceDirectoryTransactionally(target.destination, staged, backup, ops);
    await verifyActivatedTarget(target, sourceHash, ops);
    return {
      host: target.host,
      status: inspection.state === "managed" ? "upgraded" : "installed",
      detail: `Managed voice skill replaced; backup: ${backup}`,
      backupPath: backup,
    };
  } catch (error) {
    return resultForError(target, error, { staged, backup });
  }
}

export async function checkVoiceSkill(
  target: VoiceSkillTarget,
  ops: VoiceSkillFileOps = defaultOps,
): Promise<VoiceSkillOperationResult> {
  try {
    const inspection = await inspectTarget(target, ops);
    if (inspection.state === "absent") {
      return { host: target.host, status: "skipped", detail: "Managed voice skill is not installed" };
    }
    if (inspection.state === "unmanaged") {
      return { host: target.host, status: "refused", detail: "Voice skill destination is unmanaged" };
    }
    if (inspection.state === "corrupt") {
      return { host: target.host, status: "refused", detail: inspection.detail };
    }
    if (inspection.state === "modified") {
      return { host: target.host, status: "refused", detail: "Managed voice skill is modified by user" };
    }
    const sourceHash = await contentHash(SOURCE_ROOT, ops);
    if (inspection.marker.sourceHash !== sourceHash || inspection.installedHash !== sourceHash) {
      return { host: target.host, status: "refused", detail: "Managed voice skill is outdated; rerun setup --voice-skill" };
    }
    return { host: target.host, status: "unchanged", detail: "Managed voice skill is current" };
  } catch (error) {
    return resultForError(target, error);
  }
}

export async function removeVoiceSkill(
  target: VoiceSkillTarget,
  options: { ops?: VoiceSkillFileOps; now?: Date } = {},
): Promise<VoiceSkillOperationResult> {
  const ops = options.ops ?? defaultOps;
  let inspection: TargetInspection;
  try {
    inspection = await inspectTarget(target, ops);
  } catch (error) {
    return resultForError(target, error);
  }
  if (inspection.state === "absent") {
    return { host: target.host, status: "skipped", detail: "Managed voice skill is not installed" };
  }
  if (inspection.state === "unmanaged") {
    return { host: target.host, status: "refused", detail: "Voice skill destination is unmanaged; remove it manually" };
  }
  if (inspection.state === "corrupt") {
    return { host: target.host, status: "refused", detail: inspection.detail };
  }
  if (inspection.state === "modified") {
    return { host: target.host, status: "refused", detail: "Managed voice skill is modified by user; remove it manually" };
  }

  let layout: TargetLayout;
  try {
    layout = targetLayout(target);
    await ensureSafeDirectory(layout.hostRoot, target.backupRoot, ops);
  } catch (error) {
    return resultForError(target, error);
  }
  const backup = uniquePath(target.backupRoot, "backup", options.now ?? new Date());
  try {
    const current = await inspectTarget(target, ops);
    if (current.state !== "managed" || current.installedHash !== inspection.installedHash) {
      throw new VoiceSkillRefusal(`Voice skill destination changed before removal: ${target.destination}`);
    }
    await ops.rename(target.destination, backup);
    const backupStats = await ops.lstat(backup);
    assertOrdinaryDirectory(backupStats, backup);
    await assertCanonicalInside(await ops.realpath(layout.hostRoot), backup, ops);
    return {
      host: target.host,
      status: "removed",
      detail: `Managed voice skill moved to backup: ${backup}`,
      backupPath: backup,
    };
  } catch (error) {
    return resultForError(target, error, { backup });
  }
}
