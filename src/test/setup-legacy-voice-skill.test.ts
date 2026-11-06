import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLegacyVoiceSkill,
  hashLegacyVoiceSkillTree,
  removeLegacyVoiceSkill,
  resolveLegacyVoiceSkillTargets,
  type LegacyVoiceSkillFileOps,
  type LegacyVoiceSkillTarget,
} from "../setup/legacy-voice-skill.js";
import {
  BACKUP_FOLDER,
  GOLDEN_HASH,
  MARKER_NAME,
  MARKER_PACKAGE_NAME,
  SKILL_DIRECTORY,
  SKILL_TEXT,
  claudeTarget,
  codexTarget,
  expectedHash,
  writeManagedTarget,
} from "./legacy-voice-skill-fixture.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

function temporaryRoot(t: test.TestContext, label = "rocky-legacy-voice-"): string {
  const root = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function operations(overrides: Partial<LegacyVoiceSkillFileOps> = {}): LegacyVoiceSkillFileOps {
  return {
    lstat: fs.lstat,
    realpath: fs.realpath,
    readdir: fs.readdir,
    mkdir: fs.mkdir,
    rename: fs.rename,
    ...overrides,
  };
}

async function expectMissing(path: string): Promise<void> {
  await assert.rejects(fs.lstat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

test("legacy targets use the exact Codex and Claude Code personal config roots", () => {
  const home = "/tmp/rocky legacy home";
  assert.deepEqual(resolveLegacyVoiceSkillTargets({}, home), [
    {
      host: "codex",
      destination: join(home, ".agents", "skills", SKILL_DIRECTORY),
      backupRoot: join(home, ".agents", ".rocky", "backups", BACKUP_FOLDER),
    },
    {
      host: "claude-code",
      destination: join(home, ".claude", "skills", SKILL_DIRECTORY),
      backupRoot: join(home, ".claude", ".rocky", "backups", BACKUP_FOLDER),
    },
  ]);

  const customClaude = "/tmp/custom claude config";
  const targets = resolveLegacyVoiceSkillTargets({ CLAUDE_CONFIG_DIR: customClaude }, home);
  assert.equal(targets[1]?.destination, join(customClaude, "skills", SKILL_DIRECTORY));
  assert.equal(targets[1]?.backupRoot, join(customClaude, ".rocky", "backups", BACKUP_FOLDER));
  const emptyOverride = resolveLegacyVoiceSkillTargets({ CLAUDE_CONFIG_DIR: "" }, home);
  assert.equal(emptyOverride[1]?.destination, join(home, ".claude", "skills", SKILL_DIRECTORY));
  assert.equal(targets.some((target) => target.host === ("claude-desktop" as never)), false);
});

test("the tree hash keeps the format old releases stored in the marker", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);

  assert.equal(await expectedHash(target.destination), GOLDEN_HASH);
  assert.equal(await hashLegacyVoiceSkillTree(target.destination), GOLDEN_HASH);
});

test("hashing sorts UTF-8 paths and leaves out only the root ownership marker", async (t) => {
  const root = temporaryRoot(t);
  await fs.mkdir(join(root, "nested"), { recursive: true });
  await fs.writeFile(join(root, "z.txt"), "z", "utf8");
  await fs.writeFile(join(root, "é.txt"), "utf8", "utf8");
  await fs.writeFile(join(root, MARKER_NAME), "root marker is excluded", "utf8");
  await fs.writeFile(join(root, "nested", MARKER_NAME), "nested ordinary content", "utf8");

  assert.equal(await hashLegacyVoiceSkillTree(root), await expectedHash(root));
  await fs.writeFile(join(root, MARKER_NAME), "a different root marker", "utf8");
  assert.equal(await hashLegacyVoiceSkillTree(root), await expectedHash(root));
  await fs.writeFile(join(root, "nested", MARKER_NAME), "changed nested content", "utf8");
  assert.notEqual(await hashLegacyVoiceSkillTree(root), GOLDEN_HASH);
});

test("check and remove find nothing when no legacy skill exists and create nothing", async (t) => {
  const root = temporaryRoot(t);
  const target = codexTarget(root);

  const check = await checkLegacyVoiceSkill(target);
  const remove = await removeLegacyVoiceSkill(target);

  assert.equal(check.status, "absent");
  assert.equal(remove.status, "absent");
  assert.deepEqual(readdirSync(root), []);
});

test("check reports a managed copy and changes nothing", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  const markerBefore = readFileSync(join(target.destination, MARKER_NAME));

  const check = await checkLegacyVoiceSkill(target);

  assert.equal(check.status, "installed");
  assert.equal(check.detail, "rocky setup --remove removes it.");
  assert.equal(check.backupPath, undefined);
  assert.deepEqual(readFileSync(join(target.destination, MARKER_NAME)), markerBefore);
  assert.equal(readFileSync(join(target.destination, "SKILL.md"), "utf8"), SKILL_TEXT);
  assert.equal(existsSync(target.backupRoot), false);
});

test("remove moves a managed copy into the backup root and keeps every byte", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  const hash = await writeManagedTarget(target);

  const result = await removeLegacyVoiceSkill(target, { now: new Date("2026-08-05T01:02:03.000Z") });

  assert.equal(result.status, "removed");
  assert.ok(result.backupPath?.startsWith(target.backupRoot));
  assert.equal(result.detail, `backup: ${result.backupPath}`);
  await expectMissing(target.destination);
  assert.equal(await expectedHash(result.backupPath ?? ""), hash);
  assert.equal(readFileSync(join(result.backupPath ?? "", "SKILL.md"), "utf8"), SKILL_TEXT);
  assert.equal(JSON.parse(readFileSync(join(result.backupPath ?? "", MARKER_NAME), "utf8")).installedHash, hash);

  const again = await removeLegacyVoiceSkill(target);
  assert.equal(again.status, "absent");
  assert.equal((await checkLegacyVoiceSkill(target)).status, "absent");
});

test("a managed copy edited after install is modified and stays in place", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  await fs.appendFile(join(target.destination, "SKILL.md"), "user edit\n", "utf8");

  const check = await checkLegacyVoiceSkill(target);
  const remove = await removeLegacyVoiceSkill(target);

  for (const result of [check, remove]) {
    assert.equal(result.status, "modified");
    assert.match(result.detail, /changed after install/);
    assert.ok(result.detail.includes(target.destination), "names the folder to delete by hand");
  }
  assert.match(readFileSync(join(target.destination, "SKILL.md"), "utf8"), /user edit/);
  assert.equal(existsSync(target.backupRoot), false);
});

test("an added or removed file also counts as modified", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  await fs.writeFile(join(target.destination, "extra.txt"), "added later", "utf8");
  assert.equal((await removeLegacyVoiceSkill(target)).status, "modified");

  await fs.rm(join(target.destination, "extra.txt"));
  await fs.rm(join(target.destination, "agents", "openai.yaml"));
  assert.equal((await removeLegacyVoiceSkill(target)).status, "modified");
  assert.equal(readFileSync(join(target.destination, "SKILL.md"), "utf8"), SKILL_TEXT);
});

test("a folder without an ownership marker is refused even when its files look identical", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  await fs.rm(join(target.destination, MARKER_NAME));
  const before = await expectedHash(target.destination);

  const check = await checkLegacyVoiceSkill(target);
  const remove = await removeLegacyVoiceSkill(target);

  for (const result of [check, remove]) {
    assert.equal(result.status, "refused");
    assert.match(result.detail, /no rocky ownership marker/);
  }
  assert.equal(existsSync(join(target.destination, MARKER_NAME)), false);
  assert.equal(await expectedHash(target.destination), before);
  assert.equal(existsSync(target.backupRoot), false);
});

test("an unreadable or foreign ownership marker is refused by check and remove", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await fs.mkdir(target.destination, { recursive: true });
  await fs.writeFile(join(target.destination, "SKILL.md"), SKILL_TEXT, "utf8");
  const hash = GOLDEN_HASH;
  const markers: Array<[string, string]> = [
    ["broken JSON", "{broken"],
    ["wrong package", JSON.stringify({ schemaVersion: 1, packageName: "other", sourceHash: hash, installedHash: hash })],
    ["extra key", JSON.stringify({ schemaVersion: 1, packageName: MARKER_PACKAGE_NAME, sourceHash: hash, installedHash: hash, extra: true })],
    ["short hash", JSON.stringify({ schemaVersion: 1, packageName: MARKER_PACKAGE_NAME, sourceHash: "abc", installedHash: hash })],
    ["future schema", JSON.stringify({ schemaVersion: 2, packageName: MARKER_PACKAGE_NAME, sourceHash: hash, installedHash: hash })],
  ];

  for (const [label, text] of markers) {
    await fs.writeFile(join(target.destination, MARKER_NAME), text, "utf8");
    for (const result of [await checkLegacyVoiceSkill(target), await removeLegacyVoiceSkill(target)]) {
      assert.equal(result.status, "refused", label);
      assert.match(result.detail, /ownership marker is corrupted/, label);
    }
    assert.equal(readFileSync(join(target.destination, MARKER_NAME), "utf8"), text, label);
  }
  assert.equal(readFileSync(join(target.destination, "SKILL.md"), "utf8"), SKILL_TEXT);
});

test("a symlink inside the managed tree or as its marker is refused without traversal", async (t) => {
  if (skipIfSymlinkUnavailable(t)) return;
  const root = temporaryRoot(t);
  const target = codexTarget(root);
  await writeManagedTarget(target);
  const external = join(root, "external.txt");
  await fs.writeFile(external, "external-safe", "utf8");

  await fs.rm(join(target.destination, "agents", "openai.yaml"));
  await fs.symlink(external, join(target.destination, "agents", "openai.yaml"));
  assert.equal((await checkLegacyVoiceSkill(target)).status, "refused");
  assert.equal((await removeLegacyVoiceSkill(target)).status, "refused");
  assert.equal(readFileSync(external, "utf8"), "external-safe");
  assert.equal(existsSync(target.backupRoot), false);

  await fs.rm(join(target.destination, "agents", "openai.yaml"));
  await fs.writeFile(join(target.destination, "agents", "openai.yaml"), "restored", "utf8");
  await fs.rm(join(target.destination, MARKER_NAME));
  await fs.symlink(external, join(target.destination, MARKER_NAME));
  assert.equal((await checkLegacyVoiceSkill(target)).status, "refused");
  assert.equal((await removeLegacyVoiceSkill(target)).status, "refused");
  assert.equal(readFileSync(external, "utf8"), "external-safe");
  assert.equal(existsSync(join(target.destination, "SKILL.md")), true);
});

test("a symlinked folder on the path is refused when a skill is reachable behind it", async (t) => {
  if (skipIfSymlinkUnavailable(t, "dir")) return;
  const cases = ["skills", "management", "backups", "backups-leaf"] as const;
  for (const entry of cases) {
    await t.test(entry, async (t) => {
      const root = temporaryRoot(t, `rocky-legacy-${entry}-`);
      const target = codexTarget(root);
      const hostRoot = join(root, ".agents");
      const elsewhere = join(root, "elsewhere");
      await fs.mkdir(hostRoot, { recursive: true });
      await fs.mkdir(elsewhere);

      if (entry === "skills") {
        // The whole skills folder lives elsewhere, as a dotfiles manager would leave it.
        await fs.mkdir(join(elsewhere, SKILL_DIRECTORY), { recursive: true });
        await fs.writeFile(join(elsewhere, SKILL_DIRECTORY, "SKILL.md"), "behind a link", "utf8");
        await fs.symlink(elsewhere, join(hostRoot, "skills"), "dir");
      } else if (entry === "management") {
        await writeManagedTarget(target);
        await fs.symlink(elsewhere, join(hostRoot, ".rocky"), "dir");
      } else if (entry === "backups") {
        await writeManagedTarget(target);
        await fs.mkdir(join(hostRoot, ".rocky"), { recursive: true });
        await fs.symlink(elsewhere, join(hostRoot, ".rocky", "backups"), "dir");
      } else {
        await writeManagedTarget(target);
        await fs.mkdir(join(hostRoot, ".rocky", "backups"), { recursive: true });
        await fs.symlink(elsewhere, target.backupRoot, "dir");
      }

      const remove = await removeLegacyVoiceSkill(target);
      assert.equal(remove.status, "refused");
      assert.match(remove.detail, /symlink|symbolic|topology/i);
      assert.equal(existsSync(join(target.destination, "SKILL.md")), true, "the skill never moved");
      assert.equal(readdirSync(elsewhere).filter((name) => name !== SKILL_DIRECTORY).length, 0);
    });
  }
});

test("a symlinked skills folder with no rocky-voice entry reads as absent", async (t) => {
  if (skipIfSymlinkUnavailable(t, "dir")) return;
  const root = temporaryRoot(t);
  const target = codexTarget(root);
  const elsewhere = join(root, "dotfiles-skills");
  await fs.mkdir(join(root, ".agents"), { recursive: true });
  await fs.mkdir(elsewhere);
  await fs.writeFile(join(elsewhere, "other-skill.md"), "someone else's skill", "utf8");
  await fs.symlink(elsewhere, join(root, ".agents", "skills"), "dir");

  assert.equal((await checkLegacyVoiceSkill(target)).status, "absent");
  assert.equal((await removeLegacyVoiceSkill(target)).status, "absent");
  assert.deepEqual(readdirSync(elsewhere), ["other-skill.md"]);
});

test("the destination symlink itself is refused", async (t) => {
  if (skipIfSymlinkUnavailable(t, "dir")) return;
  const root = temporaryRoot(t);
  const target = codexTarget(root);
  const elsewhere = join(root, "elsewhere");
  await fs.mkdir(join(target.destination, ".."), { recursive: true });
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, target.destination, "dir");

  for (const result of [await checkLegacyVoiceSkill(target), await removeLegacyVoiceSkill(target)]) {
    assert.equal(result.status, "refused");
    assert.match(result.detail, /symlink|symbolic/i);
  }
  assert.equal(readdirSync(elsewhere).length, 0);
});

test("a target outside the managed host layout is refused before anything is read", async (t) => {
  const root = temporaryRoot(t);
  const target = codexTarget(root);
  const stray: LegacyVoiceSkillTarget = { ...target, destination: join(root, "elsewhere", SKILL_DIRECTORY) };
  const wrongBackup: LegacyVoiceSkillTarget = { ...target, backupRoot: join(root, "backups") };

  for (const entry of [stray, wrongBackup]) {
    for (const result of [await checkLegacyVoiceSkill(entry), await removeLegacyVoiceSkill(entry)]) {
      assert.equal(result.status, "refused");
      assert.match(result.detail, /managed host layout/);
    }
  }
});

test("a rename failure leaves the managed copy in place and reports a failure", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  const rename: LegacyVoiceSkillFileOps["rename"] = async (from, to) => {
    if (String(from) === target.destination) throw Object.assign(new Error("rename denied"), { code: "EACCES" });
    await fs.rename(from, to);
  };

  const result = await removeLegacyVoiceSkill(target, { ops: operations({ rename }) });

  assert.equal(result.status, "failed");
  assert.match(result.detail, /EACCES/);
  assert.doesNotMatch(result.detail, /rename denied/);
  assert.doesNotMatch(result.detail, /backup:/, "no backup exists when the move failed");
  assert.equal(readFileSync(join(target.destination, "SKILL.md"), "utf8"), SKILL_TEXT);
});

test("a cross-device rename is a refusal with no copy-and-delete fallback", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  let calls = 0;
  const rename: LegacyVoiceSkillFileOps["rename"] = async () => {
    calls += 1;
    throw Object.assign(new Error("cross device"), { code: "EXDEV" });
  };

  const result = await removeLegacyVoiceSkill(target, { ops: operations({ rename }) });

  assert.equal(result.status, "refused");
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(target.destination, "SKILL.md"), "utf8"), SKILL_TEXT);
});

test("content that changes between the check and the move is refused", async (t) => {
  const target = codexTarget(temporaryRoot(t));
  await writeManagedTarget(target);
  let raced = false;
  // The backup folders do not exist yet, so removal creates them between its
  // first inspection and its second. Edit the skill at exactly that point.
  const mkdir: LegacyVoiceSkillFileOps["mkdir"] = async (path, options) => {
    const created = await fs.mkdir(path, options as never);
    if (!raced) {
      raced = true;
      await fs.appendFile(join(target.destination, "SKILL.md"), "raced edit\n", "utf8");
    }
    return created as never;
  };

  const result = await removeLegacyVoiceSkill(target, { ops: operations({ mkdir }) });

  assert.equal(raced, true);
  assert.equal(result.status, "refused");
  assert.match(result.detail, /changed before removal/);
  assert.match(readFileSync(join(target.destination, "SKILL.md"), "utf8"), /raced edit/);
  assert.deepEqual(readdirSync(target.backupRoot), []);
});

test("every remove attempt gets its own backup name", async (t) => {
  const root = temporaryRoot(t);
  const first = codexTarget(root);
  const second = claudeTarget(join(root, ".claude"));
  await writeManagedTarget(first);
  await writeManagedTarget(second);
  const now = new Date("2026-08-05T01:02:03.000Z");

  const one = await removeLegacyVoiceSkill(first, { now });
  const two = await removeLegacyVoiceSkill(second, { now });

  assert.equal(one.status, "removed");
  assert.equal(two.status, "removed");
  assert.notEqual(one.backupPath, two.backupPath);
  assert.match(one.backupPath ?? "", /rocky-voice-backup-2026-08-05T01-02-03-000Z-/);
});
