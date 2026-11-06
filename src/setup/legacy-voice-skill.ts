/**
 * Cleanup of the voice skill that older releases installed with
 * the retired voice skill flag of `rocky setup`. rocky no longer ships or installs that skill.
 * This module only finds a copy left on disk and, on request, moves it into a
 * backup folder. It never deletes anything.
 *
 * Safety matches the installer that wrote these trees. A tree counts as managed
 * only when its ownership marker is valid and the marker's content hash still
 * equals the files on disk. A modified, unmarked, corrupt, symlinked, or
 * out-of-layout tree is reported and left in place.
 */
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PACKAGE_NAME } from "../core/package-info.js";

// These three names are what old releases wrote to disk, so they stay literal:
// cleanup finds an old install only by this exact directory name, backup
// folder, and marker file. Do not derive them from current constants; a rename
// elsewhere must not orphan an install that already exists.
const SKILL_DIRECTORY = "rocky-voice";
const BACKUP_FOLDER = "voice-skills";
const MARKER_NAME = ".rocky-managed.json";
// Markers carry the package name of the release that wrote them. That is the
// current name today; if the package is ever renamed, this module must keep
// accepting the old value.
const MARKER_PACKAGE_NAME = PACKAGE_NAME;

let uniqueSequence = 0;

export interface LegacyVoiceSkillMarker {
  schemaVersion: 1;
  packageName: typeof MARKER_PACKAGE_NAME;
  sourceHash: string;
  installedHash: string;
}

export interface LegacyVoiceSkillTarget {
  host: "codex" | "claude-code";
  destination: string;
  backupRoot: string;
}

export interface LegacyVoiceSkillResult {
  host: LegacyVoiceSkillTarget["host"];
  /**
   * absent: nothing there. installed: an unmodified managed copy exists, so
   * rocky could remove it. removed: moved to the backup root. modified: a
   * managed copy that was edited after install. refused: not provably rocky's,
   * or unsafe to touch. failed: an unexpected error.
   */
  status: "absent" | "installed" | "removed" | "modified" | "refused" | "failed";
  detail: string;
  backupPath?: string;
}

type FsPromises = typeof import("node:fs/promises");
export type LegacyVoiceSkillFileOps = Pick<FsPromises,
  "lstat" | "realpath" | "readdir" | "mkdir" | "rename"
>;

const defaultOps: LegacyVoiceSkillFileOps = {
  lstat: fs.lstat,
  realpath: fs.realpath,
  readdir: fs.readdir,
  mkdir: fs.mkdir,
  rename: fs.rename,
};

class LegacyVoiceSkillRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyVoiceSkillRefusal";
  }
}

interface TreeFile {
  relativePath: string;
  content: Buffer;
}

interface TargetLayout {
  hostRoot: string;
}

type TargetInspection =
  | { state: "absent" }
  | { state: "unmanaged" }
  | { state: "corrupt"; reason: string }
  | { state: "modified"; marker: LegacyVoiceSkillMarker; installedHash: string }
  | { state: "managed"; marker: LegacyVoiceSkillMarker; installedHash: string };

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

async function optionalLstat(path: string, ops: LegacyVoiceSkillFileOps): Promise<Stats | undefined> {
  try {
    return await ops.lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * True when anything exists at the path. lstat follows every parent component,
 * so a symlinked skills folder that holds no voice skill entry reads as absent
 * instead of as an unsafe topology. Only a real entry is worth refusing over.
 */
async function entryExists(path: string, ops: LegacyVoiceSkillFileOps): Promise<boolean> {
  try {
    await ops.lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error) || errno(error) === "ENOTDIR") return false;
    throw error;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertLexicallyInside(root: string, candidate: string): void {
  if (!pathInside(root, candidate)) {
    throw new LegacyVoiceSkillRefusal(`path is outside the allowed root: ${candidate}`);
  }
}

function assertOrdinaryDirectory(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) throw new LegacyVoiceSkillRefusal(`topology contains a symbolic link: ${path}`);
  if (!stats.isDirectory()) throw new LegacyVoiceSkillRefusal(`topology is not a directory: ${path}`);
}

function assertOrdinaryFile(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) throw new LegacyVoiceSkillRefusal(`topology contains a symbolic link: ${path}`);
  if (!stats.isFile()) throw new LegacyVoiceSkillRefusal(`topology is not a regular file: ${path}`);
}

async function assertCanonicalInside(
  canonicalRoot: string,
  path: string,
  ops: LegacyVoiceSkillFileOps,
): Promise<string> {
  const canonical = await ops.realpath(path);
  if (!pathInside(canonicalRoot, canonical)) {
    throw new LegacyVoiceSkillRefusal(`canonical path escapes the allowed root: ${path}`);
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
  ops: LegacyVoiceSkillFileOps,
): Promise<Buffer> {
  const before = await ops.lstat(path);
  assertOrdinaryFile(before, path);
  await assertCanonicalInside(canonicalRoot, path, ops);
  const content = await fs.readFile(path);
  const after = await ops.lstat(path);
  assertOrdinaryFile(after, path);
  await assertCanonicalInside(canonicalRoot, path, ops);
  if (!sameFileIdentity(before, after) || after.size !== content.length) {
    throw new LegacyVoiceSkillRefusal(`file changed during read: ${path}`);
  }
  return content;
}

function byUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function collectTreeFiles(
  root: string,
  ops: LegacyVoiceSkillFileOps,
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
    for (const entry of [...entries].sort((left, right) => byUtf8(left.name, right.name))) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath === MARKER_NAME) continue;
      const entryPath = join(directory, entry.name);
      const stats = await ops.lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw new LegacyVoiceSkillRefusal(`topology contains a symbolic link: ${entryPath}`);
      }
      if (stats.isDirectory()) {
        files.push(...await visit(entryPath, relativePath));
        continue;
      }
      assertOrdinaryFile(stats, entryPath);
      files.push({ relativePath, content: await readStableFile(entryPath, canonicalRoot, ops) });
    }
    const after = await ops.lstat(directory);
    assertOrdinaryDirectory(after, directory);
    await assertCanonicalInside(canonicalRoot, directory, ops);
    if (!sameFileIdentity(before, after)) {
      throw new LegacyVoiceSkillRefusal(`directory changed during traversal: ${directory}`);
    }
    return files;
  };

  return (await visit(root, "")).sort((left, right) => byUtf8(left.relativePath, right.relativePath));
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

/**
 * The content hash old releases stored in the marker: SHA-256 over every file
 * below the root, sorted by UTF-8 path, each framed by its path length, path,
 * and content length. Only the marker file at the root is left out.
 */
export async function hashLegacyVoiceSkillTree(
  root: string,
  ops: LegacyVoiceSkillFileOps = defaultOps,
): Promise<string> {
  return hashFiles(await collectTreeFiles(root, ops));
}

async function createDirectoryComponent(path: string, ops: LegacyVoiceSkillFileOps): Promise<void> {
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
  ops: LegacyVoiceSkillFileOps,
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
  ops: LegacyVoiceSkillFileOps,
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
      throw new LegacyVoiceSkillRefusal(`topology contains a symbolic link: ${current}`);
    }
    if (index < components.length - 1) assertOrdinaryDirectory(stats, current);
    await assertCanonicalInside(canonicalRoot, current, ops);
  }
  return "present";
}

/** The destination and backup root must sit exactly where an old install put them. */
function targetLayout(target: LegacyVoiceSkillTarget): TargetLayout {
  const destination = resolve(target.destination);
  const skillsRoot = dirname(destination);
  const hostRoot = dirname(skillsRoot);
  const expectedDestination = join(hostRoot, "skills", SKILL_DIRECTORY);
  const expectedBackup = join(hostRoot, ".rocky", "backups", BACKUP_FOLDER);
  if (destination !== expectedDestination || resolve(target.backupRoot) !== expectedBackup) {
    throw new LegacyVoiceSkillRefusal("target does not match the managed host layout");
  }
  return { hostRoot };
}

function isMarker(value: unknown): value is LegacyVoiceSkillMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return Object.keys(marker).sort().join(",") === "installedHash,packageName,schemaVersion,sourceHash"
    && marker.schemaVersion === 1
    && marker.packageName === MARKER_PACKAGE_NAME
    && typeof marker.sourceHash === "string"
    && /^[a-f0-9]{64}$/.test(marker.sourceHash)
    && typeof marker.installedHash === "string"
    && /^[a-f0-9]{64}$/.test(marker.installedHash);
}

async function parseMarker(
  destination: string,
  ops: LegacyVoiceSkillFileOps,
): Promise<{ state: "missing" } | { state: "corrupt"; reason: string } | { state: "valid"; marker: LegacyVoiceSkillMarker }> {
  const markerPath = join(destination, MARKER_NAME);
  const stats = await optionalLstat(markerPath, ops);
  if (stats === undefined) return { state: "missing" };
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { state: "corrupt", reason: "the ownership marker is unsafe" };
  }
  const canonicalDestination = await ops.realpath(destination);
  try {
    await assertCanonicalInside(canonicalDestination, markerPath, ops);
    const before = await ops.lstat(markerPath);
    const text = await fs.readFile(markerPath, "utf8");
    const after = await ops.lstat(markerPath);
    if (!sameFileIdentity(before, after)) {
      return { state: "corrupt", reason: "the ownership marker changed during read" };
    }
    const value: unknown = JSON.parse(text);
    return isMarker(value)
      ? { state: "valid", marker: value }
      : { state: "corrupt", reason: "the ownership marker is corrupted" };
  } catch (error) {
    if (error instanceof LegacyVoiceSkillRefusal) {
      return { state: "corrupt", reason: error.message };
    }
    return { state: "corrupt", reason: "the ownership marker is corrupted" };
  }
}

async function inspectTarget(
  target: LegacyVoiceSkillTarget,
  ops: LegacyVoiceSkillFileOps,
): Promise<TargetInspection> {
  const layout = targetLayout(target);
  if (!(await entryExists(target.destination, ops))) return { state: "absent" };
  const presence = await inspectExistingComponents(layout.hostRoot, target.destination, ops);
  if (presence === "absent") return { state: "absent" };
  const stats = await ops.lstat(target.destination);
  assertOrdinaryDirectory(stats, target.destination);
  const parsed = await parseMarker(target.destination, ops);
  if (parsed.state === "missing") return { state: "unmanaged" };
  if (parsed.state === "corrupt") return { state: "corrupt", reason: parsed.reason };
  let installedHash: string;
  try {
    installedHash = await hashLegacyVoiceSkillTree(target.destination, ops);
  } catch (error) {
    if (error instanceof LegacyVoiceSkillRefusal) throw error;
    return { state: "corrupt", reason: "the managed content cannot be read safely" };
  }
  return installedHash === parsed.marker.installedHash
    ? { state: "managed", marker: parsed.marker, installedHash }
    : { state: "modified", marker: parsed.marker, installedHash };
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[^0-9A-Za-z]/g, "-");
}

function backupPathFor(root: string, now: Date): string {
  uniqueSequence += 1;
  return join(root, `${SKILL_DIRECTORY}-backup-${timestamp(now)}-${process.pid}-${uniqueSequence}`);
}

function resultForError(
  target: LegacyVoiceSkillTarget,
  error: unknown,
  backup?: string,
): LegacyVoiceSkillResult {
  const refused = error instanceof LegacyVoiceSkillRefusal
    || isCrossDevice(error)
    || isDestinationCollision(error);
  const code = errno(error);
  const message = error instanceof LegacyVoiceSkillRefusal
    ? error.message
    : isCrossDevice(error)
      ? "it cannot move across filesystems"
      : isDestinationCollision(error)
        ? "the backup path already exists"
        : `unexpected error${code === undefined ? "" : ` (${code})`}`;
  return {
    host: target.host,
    status: refused ? "refused" : "failed",
    detail: backup === undefined ? message : `${message}; backup: ${backup}`,
  };
}

/**
 * Where old releases put the skill: the Codex personal skills folder and the
 * Claude Code config folder (CLAUDE_CONFIG_DIR when set, else ~/.claude).
 */
export function resolveLegacyVoiceSkillTargets(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): readonly LegacyVoiceSkillTarget[] {
  const claudeRoot = env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_CONFIG_DIR === ""
    ? join(homeDir, ".claude")
    : env.CLAUDE_CONFIG_DIR;
  return Object.freeze([
    Object.freeze({
      host: "codex" as const,
      destination: join(homeDir, ".agents", "skills", SKILL_DIRECTORY),
      backupRoot: join(homeDir, ".agents", ".rocky", "backups", BACKUP_FOLDER),
    }),
    Object.freeze({
      host: "claude-code" as const,
      destination: join(claudeRoot, "skills", SKILL_DIRECTORY),
      backupRoot: join(claudeRoot, ".rocky", "backups", BACKUP_FOLDER),
    }),
  ]);
}

function describeInspection(
  target: LegacyVoiceSkillTarget,
  inspection: TargetInspection,
): LegacyVoiceSkillResult {
  const { host, destination } = target;
  switch (inspection.state) {
    case "absent":
      return { host, status: "absent", detail: "no legacy voice skill is installed." };
    case "managed":
      return { host, status: "installed", detail: "rocky setup --remove removes it." };
    case "modified":
      return {
        host,
        status: "modified",
        detail: `the files changed after install, so rocky leaves them in place. Delete ${destination} by hand to remove them.`,
      };
    case "unmanaged":
      return {
        host,
        status: "refused",
        detail: `no rocky ownership marker in ${destination}, so rocky leaves it in place. Delete it by hand if you no longer need it.`,
      };
    case "corrupt":
      return {
        host,
        status: "refused",
        detail: `${inspection.reason}, so rocky leaves ${destination} in place.`,
      };
  }
}

/** Read-only. Reports whether a legacy voice skill exists and whether rocky could remove it. */
export async function checkLegacyVoiceSkill(
  target: LegacyVoiceSkillTarget,
  ops: LegacyVoiceSkillFileOps = defaultOps,
): Promise<LegacyVoiceSkillResult> {
  try {
    return describeInspection(target, await inspectTarget(target, ops));
  } catch (error) {
    return resultForError(target, error);
  }
}

/**
 * Move a managed legacy voice skill into the backup root. Anything that is not
 * provably an unmodified managed copy comes back unchanged and untouched.
 */
export async function removeLegacyVoiceSkill(
  target: LegacyVoiceSkillTarget,
  options: { ops?: LegacyVoiceSkillFileOps; now?: Date } = {},
): Promise<LegacyVoiceSkillResult> {
  const ops = options.ops ?? defaultOps;
  let inspection: TargetInspection;
  try {
    inspection = await inspectTarget(target, ops);
  } catch (error) {
    return resultForError(target, error);
  }
  if (inspection.state !== "managed") return describeInspection(target, inspection);

  let layout: TargetLayout;
  try {
    layout = targetLayout(target);
    await ensureSafeDirectory(layout.hostRoot, target.backupRoot, ops);
  } catch (error) {
    return resultForError(target, error);
  }
  const backup = backupPathFor(target.backupRoot, options.now ?? new Date());
  let moved = false;
  try {
    const current = await inspectTarget(target, ops);
    if (current.state !== "managed" || current.installedHash !== inspection.installedHash) {
      throw new LegacyVoiceSkillRefusal(`the skill changed before removal: ${target.destination}`);
    }
    await ops.rename(target.destination, backup);
    moved = true;
    const backupStats = await ops.lstat(backup);
    assertOrdinaryDirectory(backupStats, backup);
    await assertCanonicalInside(await ops.realpath(layout.hostRoot), backup, ops);
    return { host: target.host, status: "removed", detail: `backup: ${backup}`, backupPath: backup };
  } catch (error) {
    // Name the backup only once the move happened; before that, none exists.
    return resultForError(target, error, moved ? backup : undefined);
  }
}
