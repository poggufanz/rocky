import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { LegacyVoiceSkillTarget } from "../setup/legacy-voice-skill.js";

// Where old releases put the voice skill and how they marked it. These
// spellings are the contract of the cleanup, so the tests state them literally
// instead of importing them from the module under test.
export const SKILL_DIRECTORY = "rocky-voice";
export const BACKUP_FOLDER = "voice-skills";
export const MARKER_NAME = ".rocky-managed.json";
export const MARKER_PACKAGE_NAME = "@poggufanz/rocky-cli";

export const SKILL_TEXT = "Legacy voice skill fixture\n";
export const OPENAI_YAML = "interface:\n  display_name: \"Legacy Voice\"\n";
// The marker hash of SKILL_TEXT plus OPENAI_YAML under the format old releases
// wrote. Computed once, outside the module, so a change to the hashing breaks
// the match with installs that already exist on disk.
export const GOLDEN_HASH = "8d2d18861c17b6a5180d1989617ffeba996cbf0e2cc9143c5f834ffd27abe050";

/** The Codex target under a home directory. */
export function codexTarget(home: string): LegacyVoiceSkillTarget {
  return {
    host: "codex",
    destination: join(home, ".agents", "skills", SKILL_DIRECTORY),
    backupRoot: join(home, ".agents", ".rocky", "backups", BACKUP_FOLDER),
  };
}

/** The Claude Code target under its config directory (~/.claude or CLAUDE_CONFIG_DIR). */
export function claudeTarget(claudeRoot: string): LegacyVoiceSkillTarget {
  return {
    host: "claude-code",
    destination: join(claudeRoot, "skills", SKILL_DIRECTORY),
    backupRoot: join(claudeRoot, ".rocky", "backups", BACKUP_FOLDER),
  };
}

async function treeFiles(root: string, relative = ""): Promise<Array<{ path: string; content: Buffer }>> {
  const directory = join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; content: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (path === MARKER_NAME) continue;
    if (entry.isDirectory()) files.push(...await treeFiles(root, path));
    else files.push({ path, content: await fs.readFile(join(root, path)) });
  }
  return files;
}

/** An independent copy of the format old releases wrote, so the module is not its own oracle. */
export async function expectedHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const files = (await treeFiles(root)).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  ));
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
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

/** Build what an old `setup --voice-skill` left behind: the files plus a marker with the right hashes. */
export async function writeManagedTarget(target: LegacyVoiceSkillTarget): Promise<string> {
  await fs.mkdir(join(target.destination, "agents"), { recursive: true });
  await fs.writeFile(join(target.destination, "SKILL.md"), SKILL_TEXT, "utf8");
  await fs.writeFile(join(target.destination, "agents", "openai.yaml"), OPENAI_YAML, "utf8");
  const hash = await expectedHash(target.destination);
  await fs.writeFile(join(target.destination, MARKER_NAME), `${JSON.stringify({
    schemaVersion: 1,
    packageName: MARKER_PACKAGE_NAME,
    sourceHash: hash,
    installedHash: hash,
  })}\n`, "utf8");
  return hash;
}
