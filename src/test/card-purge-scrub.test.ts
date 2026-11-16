import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, ftruncateSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { beforeEach, describe, it, mock } from "node:test";
import { cardsForFile } from "../desk/cards-read.js";
import { setup, type SetupDependencies } from "../commands/setup.js";
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
      assert.equal(notice, `  Some change cards about this repo could not be removed from 1 log. Run rocky setup --repo ${repo} --purge-capture again.`);
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
      assert.equal(notice, `  Some change cards about this repo could not be removed. Run rocky setup --repo ${repo} --purge-capture again.`);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
