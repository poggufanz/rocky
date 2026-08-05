import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VOICE_SKILL_NAME,
  checkVoiceSkill,
  copyTreeNoSymlinks,
  installVoiceSkill,
  removeVoiceSkill,
  resolveVoiceSkillTargets,
  type VoiceSkillFileOps,
  type VoiceSkillMarker,
  type VoiceSkillTarget,
} from "../setup/voice-skill.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(packageRoot, "skills", VOICE_SKILL_NAME);
const markerName = ".rocky-managed.json";

function temporaryRoot(t: test.TestContext, label = "rocky-voice-"): string {
  const root = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function codexTarget(root: string): VoiceSkillTarget {
  return {
    host: "codex",
    destination: join(root, ".agents", "skills", VOICE_SKILL_NAME),
    backupRoot: join(root, ".agents", ".rocky", "backups", "voice-skills"),
  };
}

function operations(rename: VoiceSkillFileOps["rename"] = fs.rename): VoiceSkillFileOps {
  return {
    lstat: fs.lstat,
    realpath: fs.realpath,
    readdir: fs.readdir,
    mkdir: fs.mkdir,
    copyFile: fs.copyFile,
    writeFile: fs.writeFile,
    rename,
    rm: fs.rm,
  };
}

async function treeFiles(root: string, relative = ""): Promise<Array<{ path: string; content: Buffer }>> {
  const directory = join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; content: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (path === markerName) continue;
    if (entry.isDirectory()) files.push(...await treeFiles(root, path));
    else files.push({ path, content: await fs.readFile(join(root, path)) });
  }
  return files;
}

async function expectedHash(root: string): Promise<string> {
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

async function readMarker(destination: string): Promise<VoiceSkillMarker> {
  return JSON.parse(await fs.readFile(join(destination, markerName), "utf8")) as VoiceSkillMarker;
}

async function writeOldManagedTarget(target: VoiceSkillTarget): Promise<string> {
  await fs.mkdir(join(target.destination, "agents"), { recursive: true });
  await fs.writeFile(join(target.destination, "SKILL.md"), "old voice\n", "utf8");
  await fs.writeFile(join(target.destination, "agents", "openai.yaml"), "interface:\n  display_name: \"Old Voice\"\n", "utf8");
  const oldHash = await expectedHash(target.destination);
  await fs.writeFile(join(target.destination, markerName), `${JSON.stringify({
    schemaVersion: 1,
    packageName: "@poggufanz/rocky-cli",
    sourceHash: oldHash,
    installedHash: oldHash,
  })}\n`, "utf8");
  return oldHash;
}

async function expectMissing(path: string): Promise<void> {
  await assert.rejects(fs.lstat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

test("voice skill targets use exact Codex and Claude Code personal config roots", () => {
  const home = "/tmp/rocky voice home";
  assert.deepEqual(resolveVoiceSkillTargets({}, home), [
    {
      host: "codex",
      destination: join(home, ".agents", "skills", VOICE_SKILL_NAME),
      backupRoot: join(home, ".agents", ".rocky", "backups", "voice-skills"),
    },
    {
      host: "claude-code",
      destination: join(home, ".claude", "skills", VOICE_SKILL_NAME),
      backupRoot: join(home, ".claude", ".rocky", "backups", "voice-skills"),
    },
  ]);

  const customClaude = "/tmp/custom claude config";
  const targets = resolveVoiceSkillTargets({ CLAUDE_CONFIG_DIR: customClaude }, home);
  assert.equal(targets[1]?.destination, join(customClaude, "skills", VOICE_SKILL_NAME));
  assert.equal(targets[1]?.backupRoot, join(customClaude, ".rocky", "backups", "voice-skills"));
  const emptyOverride = resolveVoiceSkillTargets({ CLAUDE_CONFIG_DIR: "" }, home);
  assert.equal(emptyOverride[1]?.destination, join(home, ".claude", "skills", VOICE_SKILL_NAME));
  assert.equal(targets.some((target) => target.host === ("claude-desktop" as never)), false);
});

test("missing skill directories install a marked byte-identical managed copy", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  const result = await installVoiceSkill(target, { replace: false, now: new Date("2026-08-05T01:02:03.000Z") });

  assert.equal(result.status, "installed");
  assert.equal(result.backupPath, undefined);
  assert.equal(readFileSync(join(target.destination, "SKILL.md"), "utf8"), readFileSync(join(sourceRoot, "SKILL.md"), "utf8"));
  assert.equal(readFileSync(join(target.destination, "agents", "openai.yaml"), "utf8"), readFileSync(join(sourceRoot, "agents", "openai.yaml"), "utf8"));
  const marker = await readMarker(target.destination);
  assert.deepEqual(marker, {
    schemaVersion: 1,
    packageName: "@poggufanz/rocky-cli",
    sourceHash: await expectedHash(sourceRoot),
    installedHash: await expectedHash(target.destination),
  });
});

test("managed current install and check are read-only no-ops", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await installVoiceSkill(target, { replace: false });
  const before = readFileSync(join(target.destination, markerName));

  const install = await installVoiceSkill(target, { replace: false });
  const check = await checkVoiceSkill(target);

  assert.equal(install.status, "unchanged");
  assert.equal(check.status, "unchanged");
  assert.deepEqual(readFileSync(join(target.destination, markerName)), before);
});

test("managed unmodified old content upgrades transactionally with recoverable backup", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  const oldHash = await writeOldManagedTarget(target);

  const result = await installVoiceSkill(target, {
    replace: false,
    now: new Date("2026-08-05T01:02:03.000Z"),
  });

  assert.equal(result.status, "upgraded");
  assert.ok(result.backupPath?.startsWith(target.backupRoot));
  assert.equal(readFileSync(join(result.backupPath ?? "", "SKILL.md"), "utf8"), "old voice\n");
  assert.equal((await readMarker(result.backupPath ?? "")).installedHash, oldHash);
  assert.equal((await readMarker(target.destination)).sourceHash, await expectedHash(sourceRoot));
});

test("unmanaged collision is refused unless replace explicitly preserves a backup", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, "user.txt"), "user content\n", "utf8");

  const refused = await installVoiceSkill(target, { replace: false });
  assert.equal(refused.status, "refused");
  assert.match(refused.detail, /unmanaged/i);
  assert.equal(readFileSync(join(target.destination, "user.txt"), "utf8"), "user content\n");

  const replaced = await installVoiceSkill(target, {
    replace: true,
    now: new Date("2026-08-05T01:02:03.000Z"),
  });
  assert.equal(replaced.status, "installed");
  assert.ok(replaced.backupPath?.startsWith(target.backupRoot));
  assert.equal(readFileSync(join(replaced.backupPath ?? "", "user.txt"), "utf8"), "user content\n");
  assert.equal(existsSync(join(target.destination, markerName)), true);
});

test("corrupted ownership marker is refused by install check and remove", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, markerName), "{broken", "utf8");

  for (const result of [
    await installVoiceSkill(target, { replace: false }),
    await checkVoiceSkill(target),
    await removeVoiceSkill(target),
  ]) {
    assert.equal(result.status, "refused");
    assert.match(result.detail, /marker/i);
  }
  assert.equal(readFileSync(join(target.destination, markerName), "utf8"), "{broken");
});

test("user-modified managed content is refused on check and removal", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await installVoiceSkill(target, { replace: false });
  await fs.appendFile(join(target.destination, "SKILL.md"), "user edit\n", "utf8");

  const check = await checkVoiceSkill(target);
  const remove = await removeVoiceSkill(target);

  assert.equal(check.status, "refused");
  assert.match(check.detail, /modified/i);
  assert.equal(remove.status, "refused");
  assert.match(remove.detail, /modified|manual/i);
  assert.match(readFileSync(join(target.destination, "SKILL.md"), "utf8"), /user edit/);
});

test("safe managed removal moves exact copy to non-discoverable backup", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await installVoiceSkill(target, { replace: false });
  const originalHash = await expectedHash(target.destination);

  const result = await removeVoiceSkill(target, { now: new Date("2026-08-05T01:02:03.000Z") });

  assert.equal(result.status, "removed");
  assert.ok(result.backupPath?.startsWith(target.backupRoot));
  await expectMissing(target.destination);
  assert.equal(await expectedHash(result.backupPath ?? ""), originalHash);
});

test("identical unmarked directory remains untouched and unowned", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(join(target.destination, "agents"), { recursive: true });
  await fs.copyFile(join(sourceRoot, "SKILL.md"), join(target.destination, "SKILL.md"));
  await fs.copyFile(join(sourceRoot, "agents", "openai.yaml"), join(target.destination, "agents", "openai.yaml"));
  const before = await expectedHash(target.destination);

  const check = await checkVoiceSkill(target);
  const remove = await removeVoiceSkill(target);

  assert.equal(check.status, "refused");
  assert.match(check.detail, /unmanaged/i);
  assert.equal(remove.status, "refused");
  assert.equal(existsSync(join(target.destination, markerName)), false);
  assert.equal(await expectedHash(target.destination), before);
});

test("copy rejects source roots entries and staged paths that are symlinks or escape allowed root", async (t) => {
  const root = temporaryRoot(t);
  const source = join(root, "source");
  const allowed = join(root, "allowed");
  const staged = join(allowed, "stage");
  const elsewhere = join(root, "elsewhere");
  await fs.mkdir(source);
  await fs.mkdir(allowed);
  await fs.mkdir(elsewhere);
  await fs.writeFile(join(source, "file.txt"), "safe", "utf8");

  const sourceLink = join(root, "source-link");
  await fs.symlink(source, sourceLink, "dir");
  await assert.rejects(copyTreeNoSymlinks(sourceLink, staged, allowed), /symlink|symbolic/i);

  await fs.symlink(join(root, "outside"), join(source, "nested-link"));
  await assert.rejects(copyTreeNoSymlinks(source, staged, allowed), /symlink|symbolic/i);
  await fs.rm(join(source, "nested-link"));

  await assert.rejects(copyTreeNoSymlinks(source, join(root, "escaped"), allowed), /outside|contain|root/i);

  await fs.symlink(elsewhere, staged, "dir");
  await assert.rejects(copyTreeNoSymlinks(source, staged, allowed), /symlink|symbolic|exist/i);
});

test("hashing sorts UTF-8 paths and excludes only root ownership marker", async (t) => {
  const root = temporaryRoot(t);
  const source = join(root, "source");
  const allowed = join(root, "allowed");
  const staged = join(allowed, "stage");
  await fs.mkdir(join(source, "nested"), { recursive: true });
  await fs.mkdir(allowed);
  await fs.writeFile(join(source, "z.txt"), "z", "utf8");
  await fs.writeFile(join(source, "é.txt"), "utf8", "utf8");
  await fs.writeFile(join(source, markerName), "source marker is excluded", "utf8");
  await fs.writeFile(join(source, "nested", markerName), "nested ordinary content", "utf8");

  await copyTreeNoSymlinks(source, staged, allowed);

  assert.equal(readFileSync(join(staged, "nested", markerName), "utf8"), "nested ordinary content");
  const marker = await readMarker(staged);
  assert.equal(marker.sourceHash, await expectedHash(source));
  assert.equal(marker.installedHash, await expectedHash(staged));
});

test("target marker and nested installed symlinks are refused without traversal", async (t) => {
  const root = temporaryRoot(t);
  const target = codexTarget(root);
  await installVoiceSkill(target, { replace: false });
  const external = join(root, "external.txt");
  await fs.writeFile(external, "external-safe", "utf8");

  await fs.rm(join(target.destination, "agents", "openai.yaml"));
  await fs.symlink(external, join(target.destination, "agents", "openai.yaml"));
  assert.equal((await checkVoiceSkill(target)).status, "refused");
  assert.equal((await removeVoiceSkill(target)).status, "refused");
  assert.equal(readFileSync(external, "utf8"), "external-safe");

  await fs.rm(join(target.destination, "agents", "openai.yaml"));
  await fs.writeFile(join(target.destination, "agents", "openai.yaml"), "restored", "utf8");
  await fs.rm(join(target.destination, markerName));
  await fs.symlink(external, join(target.destination, markerName));
  assert.equal((await checkVoiceSkill(target)).status, "refused");
  assert.equal((await removeVoiceSkill(target)).status, "refused");
  assert.equal(readFileSync(external, "utf8"), "external-safe");
});

test("target and management-root component symlinks are refused", async (t) => {
  const cases = ["skills", "management", "staging", "staging-leaf", "backups", "backups-leaf"] as const;
  for (const entry of cases) {
    await t.test(entry, async (t) => {
      const root = temporaryRoot(t, `rocky-voice-${entry}-`);
      const target = codexTarget(root);
      const hostRoot = join(root, ".agents");
      const elsewhere = join(root, "elsewhere");
      await fs.mkdir(hostRoot, { recursive: true });
      await fs.mkdir(elsewhere);

      if (entry === "skills") {
        await fs.symlink(elsewhere, join(hostRoot, "skills"), "dir");
      } else if (entry === "management") {
        await fs.mkdir(join(hostRoot, "skills"), { recursive: true });
        await fs.symlink(elsewhere, join(hostRoot, ".rocky"), "dir");
      } else if (entry === "staging") {
        await fs.mkdir(join(hostRoot, ".rocky"), { recursive: true });
        await fs.symlink(elsewhere, join(hostRoot, ".rocky", "staging"), "dir");
      } else if (entry === "staging-leaf") {
        await fs.mkdir(join(hostRoot, ".rocky", "staging"), { recursive: true });
        await fs.symlink(elsewhere, join(hostRoot, ".rocky", "staging", "voice-skills"), "dir");
      } else {
        await fs.mkdir(target.destination, { recursive: true });
        await fs.writeFile(join(target.destination, "user.txt"), "keep", "utf8");
        await fs.mkdir(join(hostRoot, ".rocky"), { recursive: true });
        if (entry === "backups") {
          await fs.symlink(elsewhere, join(hostRoot, ".rocky", "backups"), "dir");
        } else {
          await fs.mkdir(join(hostRoot, ".rocky", "backups"), { recursive: true });
          await fs.symlink(elsewhere, target.backupRoot, "dir");
        }
      }

      const result = await installVoiceSkill(target, { replace: entry.startsWith("backups") });
      assert.equal(result.status, "refused");
      assert.match(result.detail, /symlink|symbolic|topology/i);
      assert.equal(readdirSync(elsewhere).length, 0);
    });
  }
});

test("target symlink itself is refused", async (t) => {
  const root = temporaryRoot(t);
  const target = codexTarget(root);
  const elsewhere = join(root, "elsewhere");
  await fs.mkdir(join(target.destination, ".."), { recursive: true });
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, target.destination, "dir");

  const result = await installVoiceSkill(target, { replace: true });
  assert.equal(result.status, "refused");
  assert.match(result.detail, /symlink|symbolic/i);
  assert.equal(readdirSync(elsewhere).length, 0);
});

test("target to backup rename failure preserves original collision", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, "user.txt"), "keep", "utf8");
  const rename: VoiceSkillFileOps["rename"] = async (from, to) => {
    if (String(from) === target.destination) throw Object.assign(new Error("rename denied"), { code: "EACCES" });
    await fs.rename(from, to);
  };

  const result = await installVoiceSkill(target, { replace: true, ops: operations(rename) });

  assert.equal(result.status, "failed");
  assert.equal(readFileSync(join(target.destination, "user.txt"), "utf8"), "keep");
});

test("staged activation failure rolls original target back", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, "user.txt"), "keep", "utf8");
  let calls = 0;
  const rename: VoiceSkillFileOps["rename"] = async (from, to) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("activation denied"), { code: "EACCES" });
    await fs.rename(from, to);
  };

  const result = await installVoiceSkill(target, { replace: true, ops: operations(rename) });

  assert.equal(result.status, "failed");
  assert.equal(calls, 3);
  assert.equal(readFileSync(join(target.destination, "user.txt"), "utf8"), "keep");
});

test("rollback failure reports both paths and preserves only recoverable backup", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, "user.txt"), "keep", "utf8");
  let calls = 0;
  const rename: VoiceSkillFileOps["rename"] = async (from, to) => {
    calls += 1;
    if (calls >= 2) throw Object.assign(new Error(`rename ${calls} denied`), { code: "EACCES" });
    await fs.rename(from, to);
  };

  const result = await installVoiceSkill(target, { replace: true, ops: operations(rename) });

  assert.equal(result.status, "failed");
  assert.equal(calls, 3);
  assert.match(result.detail, /backup/i);
  assert.match(result.detail, /staged|staging/i);
  await expectMissing(target.destination);
  const backups = readdirSync(target.backupRoot);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(target.backupRoot, backups[0] ?? "", "user.txt"), "utf8"), "keep");
});

test("destination race is refused without deleting raced content", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  let raced = false;
  const rename: VoiceSkillFileOps["rename"] = async (from, to) => {
    if (String(to) === target.destination && !raced) {
      raced = true;
      await fs.mkdir(target.destination, { recursive: true });
      await fs.writeFile(join(target.destination, "raced.txt"), "keep race", "utf8");
    }
    await fs.rename(from, to);
  };

  const result = await installVoiceSkill(target, { replace: false, ops: operations(rename) });

  assert.equal(raced, true);
  assert.equal(result.status, "refused");
  assert.match(result.detail, /changed|race|destination|exist/i);
  assert.equal(readFileSync(join(target.destination, "raced.txt"), "utf8"), "keep race");
});

test("cross-device rename is a refusal with no copy-delete fallback", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, "user.txt"), "keep", "utf8");
  let calls = 0;
  const rename: VoiceSkillFileOps["rename"] = async () => {
    calls += 1;
    throw Object.assign(new Error("cross device"), { code: "EXDEV" });
  };

  const result = await installVoiceSkill(target, { replace: true, ops: operations(rename) });

  assert.equal(result.status, "refused");
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(target.destination, "user.txt"), "utf8"), "keep");
});
