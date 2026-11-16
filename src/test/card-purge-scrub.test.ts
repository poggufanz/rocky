import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, ftruncateSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { beforeEach, describe, it, mock } from "node:test";
import { cardsForFile } from "../desk/cards-read.js";
import { quoteRepoArgument, setup, type SetupDependencies } from "../commands/setup.js";
import { cardsFilePath } from "../listening/cards-path.js";
import { purgeRepoCapture, setRepoCapture } from "../listening/consent.js";
import { useTempRockyHome } from "./temp-rocky-home.js";

const home = useTempRockyHome("rocky-purge-cards-");

function cardsDir(): string {
  return join(home.dir(), "desk", "cards");
}

function gitRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-purge-cards-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

function block(seq: number, path: string): Record<string, unknown> {
  return { seq, path: posix(path), labels: [{ id: "edited" }], importance: "high", line: 3 };
}

function card(id: string, root: string, paths: string[]): string {
  return JSON.stringify({
    v: 1,
    card_id: id,
    rev: 1,
    root: posix(root),
    started_ms: 1,
    ended_ms: 2,
    prompt: "do things",
    blocks: paths.map((path, index) => block(index, path)),
    more_count: 0,
    flow: [],
  });
}

function deps(): SetupDependencies {
  return {
    runner: undefined as never,
    platform: undefined as never,
    adapters: [],
    confirmation: { confirm: async () => true },
    rockyHome: home.dir(),
  };
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

function insideRepo(text: string, repo: string): boolean {
  return text.includes(posix(repo) + "/");
}

describe("purge scrubs change cards from every log", () => {
  beforeEach(() => {
    rmSync(cardsDir(), { recursive: true, force: true });
    mkdirSync(cardsDir(), { recursive: true });
  });

  it("leaves no block inside the repo in any log and keeps outside blocks", () => {
    const repo = gitRepo();
    const other = gitRepo();
    const outside = join(other, "keep.ts");
    const inside = join(repo, "src", "a.ts");
    assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir()).ok, true);
    const ownLog = cardsFilePath(repo, home.dir());
    const noneLog = join(cardsDir(), "_none.jsonl");
    const otherLog = cardsFilePath(other, home.dir());
    writeFileSync(ownLog, `${card("own", repo, [inside])}\n`);
    writeFileSync(noneLog, `${card("none", repo, [inside, outside])}\n`);
    writeFileSync(otherLog, `${card("oth", other, [inside, outside])}\n`);
    try {
      const purged = purgeRepoCapture(repo, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir());
      assert.equal(purged.ok, true);
      assert.equal(purged.cardsIncomplete, undefined);
      assert.ok(purged.freedBytes > 0);
      assert.equal(existsSync(ownLog), false);
      for (const log of [noneLog, otherLog]) {
        const text = readFileSync(log, "utf8");
        assert.equal(insideRepo(text, repo), false, text);
        assert.ok(text.includes(posix(outside)), text);
      }
      const read = cardsForFile(inside, { home: home.dir(), cwd: repo });
      assert.deepEqual(read.cards, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("returns ok with cardsIncomplete when a foreign log cannot be scrubbed", () => {
    const repo = gitRepo();
    const inside = join(repo, "a.ts");
    assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir()).ok, true);
    const huge = join(cardsDir(), "huge.jsonl");
    writeFileSync(huge, `${card("big", repo, [inside])}\n`);
    const fd = openSync(huge, "r+");
    try {
      ftruncateSync(fd, 65 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    try {
      const purged = purgeRepoCapture(repo, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir());
      assert.equal(purged.ok, true);
      assert.ok(purged.cardsIncomplete && purged.cardsIncomplete.length === 1, JSON.stringify(purged));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the CLI prints one extra line and exits 0 when cards remain", async () => {
    const repo = gitRepo();
    const inside = join(repo, "a.ts");
    assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir()).ok, true);
    const huge = join(cardsDir(), "huge.jsonl");
    writeFileSync(huge, `${card("big", repo, [inside])}\n`);
    const fd = openSync(huge, "r+");
    try {
      ftruncateSync(fd, 65 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    try {
      const out = await captureStderr(() => setup(["--repo", repo, "--purge-capture", "--yes"], deps()));
      assert.equal(out.code, 0);
      assert.match(out.stderr, /history purged:/);
      const lines = out.stderr.split("\n");
      const notice = lines.find((line) => line.includes("could not be removed"));
      assert.equal(notice, `  Some change cards about this repo could not be removed from 1 log. Run rocky setup --repo "${repo}" --purge-capture again.`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the CLI stays silent about cards when the scrub is complete", async () => {
    const repo = gitRepo();
    assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir()).ok, true);
    try {
      const out = await captureStderr(() => setup(["--repo", repo, "--purge-capture", "--yes"], deps()));
      assert.equal(out.code, 0);
      assert.doesNotMatch(out.stderr, /change cards/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the CLI gives a count-free notice when the cards directory cannot be read", async () => {
    const repo = gitRepo();
    assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir()).ok, true);
    const original = fs.readdirSync;
    mock.method(fs, "readdirSync", ((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === cardsDir()) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return (original as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    try {
      const out = await captureStderr(() => setup(["--repo", repo, "--purge-capture", "--yes"], deps()));
      assert.equal(out.code, 0);
      const notice = out.stderr.split("\n").find((line) => line.includes("could not be removed"));
      assert.equal(notice, `  Some change cards about this repo could not be removed. Run rocky setup --repo "${repo}" --purge-capture again.`);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the retry command quotes a repo path that contains a space", async () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky purge cards ")));
    const repo = join(parent, "my repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    assert.equal(setRepoCapture(repo, true, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir()).ok, true);
    const huge = join(cardsDir(), "huge.jsonl");
    writeFileSync(huge, `${card("big", repo, [join(repo, "a.ts")])}
`);
    const fd = openSync(huge, "r+");
    try {
      ftruncateSync(fd, 65 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    try {
      const out = await captureStderr(() => setup(["--repo", repo, "--purge-capture", "--yes"], deps()));
      assert.equal(out.code, 0);
      const notice = out.stderr.split("\n").find((line) => line.includes("could not be removed"));
      assert.ok(notice?.endsWith(`Run rocky setup --repo "${repo}" --purge-capture again.`), notice);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("quoteRepoArgument", () => {
  it("leaves a normal path byte-identical inside double quotes", () => {
    assert.equal(quoteRepoArgument("/work/my repo"), '"/work/my repo"');
    assert.equal(quoteRepoArgument(String.raw`C:\work\repo`), String.raw`"C:\work\repo"`);
  });

  it("doubles the backslash of a drive root", () => {
    assert.equal(quoteRepoArgument("C:\\"), '"C:\\\\"');
    assert.equal(quoteRepoArgument("C:" + "\\"), String.raw`"C:\\"`);
  });

  it("doubles every trailing backslash and only those", () => {
    assert.equal(quoteRepoArgument("D:\\a\\b\\"), '"D:\\a\\b\\\\"');
    assert.equal(quoteRepoArgument("D:" + "\\a\\b\\"), String.raw`"D:\a\b\\"`);
  });

  it("still escapes an embedded double quote", () => {
    assert.equal(quoteRepoArgument('/a"b'), '"/a\\"b"');
  });
});

describe("purge scrub scope", () => {
  beforeEach(() => {
    rmSync(cardsDir(), { recursive: true, force: true });
    mkdirSync(cardsDir(), { recursive: true });
  });

  function seedForeignLogs(coveredPath: string): { paths: string[]; before: Buffer[] } {
    const line = card("c", "/work/other", [`${posix(coveredPath)}/src/a.ts`, "/work/other/keep.ts"]);
    const paths = [join(cardsDir(), "_none.jsonl"), join(cardsDir(), "other.jsonl")];
    for (const path of paths) writeFileSync(path, `${line}\n`);
    return { paths, before: paths.map((path) => readFileSync(path)) };
  }

  function assertUntouched(seed: { paths: string[]; before: Buffer[] }): void {
    seed.paths.forEach((path, index) => assert.deepEqual(readFileSync(path), seed.before[index]));
  }

  function purge(target: string, userHome: string) {
    return purgeRepoCapture(target, { yes: true, actor: "cli", onRevoke: "delete" }, home.dir(), { userHome });
  }

  it("skips the scrub for a filesystem or drive root", () => {
    const root = parse(tmpdir()).root;
    const seed = seedForeignLogs(root.replace(/[\/]+$/, ""));
    const purged = purge(root, join(tmpdir(), "no-such-home"));
    assert.equal(purged.ok, true);
    assert.equal(purged.cardsScrubSkipped, "unsafe-root");
    assertUntouched(seed);
  });

  it("skips the scrub for the OS home and for a folder that holds it", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-purge-home-")));
    try {
      const userHome = join(base, "u", "home");
      mkdirSync(userHome, { recursive: true });
      const seed = seedForeignLogs(base);
      assert.equal(purge(userHome, userHome).cardsScrubSkipped, "unsafe-root");
      assert.equal(purge(join(base, "u"), userHome).cardsScrubSkipped, "unsafe-root");
      assertUntouched(seed);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips the scrub for the parent of the rocky home", () => {
    const parent = dirname(home.dir());
    const seed = seedForeignLogs(parent);
    const purged = purge(parent, join(tmpdir(), "no-such-home"));
    assert.equal(purged.cardsScrubSkipped, "unsafe-root");
    assertUntouched(seed);
  });

  it("skips the scrub for a parent folder that is not a repo", () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-purge-parent-")));
    try {
      const seed = seedForeignLogs(parent);
      const purged = purge(parent, join(tmpdir(), "no-such-home"));
      assert.equal(purged.ok, true);
      assert.equal(purged.cardsScrubSkipped, "unknown-repo");
      assertUntouched(seed);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("scrubs a folder with a .git folder even without a consent decision", () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-purge-dotgit-")));
    try {
      mkdirSync(join(repo, ".git"));
      const seed = seedForeignLogs(repo);
      const purged = purge(repo, join(tmpdir(), "no-such-home"));
      assert.equal(purged.cardsScrubSkipped, undefined);
      assert.ok(!readFileSync(seed.paths[0] as string, "utf8").includes("/src/a.ts"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("scrubs a path that only has a remembered decline", () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-purge-consent-")));
    try {
      assert.equal(setRepoCapture(repo, false, { yes: true, actor: "cli", onRevoke: "decline" }, home.dir()).ok, true);
      const seed = seedForeignLogs(repo);
      const purged = purge(repo, join(tmpdir(), "no-such-home"));
      assert.equal(purged.cardsScrubSkipped, undefined);
      assert.ok(!readFileSync(seed.paths[0] as string, "utf8").includes("/src/a.ts"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("tells the CLI user that other logs were left alone", async () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-purge-cli-")));
    try {
      const seed = seedForeignLogs(parent);
      const out = await captureStderr(() => setup(["--repo", parent, "--purge-capture", "--yes"], deps()));
      assert.equal(out.code, 0);
      assert.ok(out.stderr.includes("also removed from other card logs"), out.stderr);
      assert.ok(out.stderr.includes("  Change cards in other logs were left alone: Rocky did not know this path as a repo."), out.stderr);
      assertUntouched(seed);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
