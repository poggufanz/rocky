import { strict as assert } from "node:assert";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { cardsFilePath } from "../listening/cards-path.js";
import { scrubRepoCards } from "../listening/cards-scrub.js";
import { useTempRockyHome } from "./temp-rocky-home.js";

const home = useTempRockyHome("rocky-cards-scrub-");

function cardsDir(): string {
  return join(home.dir(), "desk", "cards");
}

function logPath(name: string): string {
  return join(cardsDir(), name);
}

function block(seq: number, path: string): Record<string, unknown> {
  return { seq, path, labels: [{ id: "edited" }], importance: "high", line: 3 };
}

function step(text: string, seqs: number[]): Record<string, unknown> {
  return { kind: "edit", text, ok: true, dur_ms: 5, seqs };
}

function card(id: string, blocks: Record<string, unknown>[], flow: Record<string, unknown>[], rev = 1): string {
  return JSON.stringify({
    v: 1,
    card_id: id,
    rev,
    root: "/work/other",
    started_ms: 1,
    ended_ms: 2,
    prompt: "do things",
    blocks,
    more_count: 4,
    future_field: { keep: true },
    flow,
  });
}

function write(name: string, content: string): string {
  const path = logPath(name);
  writeFileSync(path, content);
  return path;
}

function tempFiles(): string[] {
  return readdirSync(cardsDir()).filter((name) => name.endsWith(".tmp"));
}

describe("scrubRepoCards", () => {
  beforeEach(() => {
    rmSync(cardsDir(), { recursive: true, force: true });
    mkdirSync(cardsDir(), { recursive: true });
  });

  it("returns ok with zeros when the cards directory is missing", () => {
    const empty = join(home.dir(), "elsewhere");
    const result = scrubRepoCards(["/work/app"], { home: empty });
    assert.deepEqual(result, { ok: true, logsChanged: 0, blocksRemoved: 0, cardsRemoved: 0, freedBytes: 0, incomplete: [] });
  });

  it("drops matching blocks and their flow steps and keeps the rest", () => {
    const line = card(
      "c1",
      [block(0, "/work/app/src/a.ts"), block(1, "/work/other/b.ts")],
      [step("edit /work/app/src/a.ts", [0]), step("edit /work/other/b.ts", [1])],
    );
    const path = write("_none.jsonl", `${line}\n`);
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.ok, true);
    assert.equal(result.logsChanged, 1);
    assert.equal(result.blocksRemoved, 1);
    assert.equal(result.cardsRemoved, 0);
    assert.ok(result.freedBytes > 0);
    const out = readFileSync(path, "utf8");
    assert.ok(out.endsWith("\n"));
    const parsed = JSON.parse(out.trim());
    assert.deepEqual(parsed.blocks.map((b: { path: string }) => b.path), ["/work/other/b.ts"]);
    assert.deepEqual(parsed.flow.map((s: { text: string }) => s.text), ["edit /work/other/b.ts"]);
    assert.equal(parsed.blocks[0].seq, 1);
    assert.equal(parsed.more_count, 4);
    assert.deepEqual(parsed.future_field, { keep: true });
    assert.deepEqual(Object.keys(parsed), Object.keys(JSON.parse(line)));
  });

  it("drops a flow step that names the root in its text even without seqs", () => {
    const line = card("c1", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], [step("ran cmd in /work/app", []), step("ran cmd in /work/app2/x", [])]);
    const path = write("x.jsonl", `${line}\n`);
    scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    const parsed = JSON.parse(readFileSync(path, "utf8").trim());
    assert.deepEqual(parsed.flow.map((s: { text: string }) => s.text), ["ran cmd in /work/app2/x"]);
  });

  it("drops the whole line when every block matches", () => {
    const keep = card("keep", [block(0, "/work/other/x.ts")], []);
    const gone = card("gone", [block(0, "/work/app/a.ts"), block(1, "/work/app/b.ts")], [step("edit", [0, 1])]);
    const path = write("x.jsonl", `${keep}\n${gone}\n`);
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.cardsRemoved, 1);
    assert.equal(result.blocksRemoved, 2);
    assert.equal(readFileSync(path, "utf8"), `${keep}\n`);
  });

  it("matches a tilde path against the home", () => {
    const line = card("c", [block(0, "~/proj/a.ts"), block(1, "/work/other/b.ts")], []);
    const path = write("x.jsonl", `${line}\n`);
    const result = scrubRepoCards([`${home.dir()}/proj`], { home: home.dir(), platform: "linux" });
    assert.equal(result.blocksRemoved, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8").trim()).blocks.length, 1);
  });

  it("does not match a repo-relative path or a prefix that is not a segment", () => {
    const line = card("c", [block(0, "src/a.ts"), block(1, "/work/app2/b.ts"), block(2, "app/c.ts")], []);
    const path = write("x.jsonl", `${line}\n`);
    const before = statSync(path);
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.logsChanged, 0);
    assert.equal(readFileSync(path, "utf8"), `${line}\n`);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  });

  it("folds case on win32 only", () => {
    const line = card("c", [block(0, "C:\\Work\\App\\a.ts"), block(1, "/work/other/b.ts")], []);
    const winPath = write("w.jsonl", `${line}\n`);
    const winResult = scrubRepoCards(["c:/work/app"], { home: home.dir(), platform: "win32" });
    assert.equal(winResult.blocksRemoved, 1);
    assert.equal(JSON.parse(readFileSync(winPath, "utf8").trim()).blocks.length, 1);

    const lin = card("c", [block(0, "/Work/App/a.ts"), block(1, "/work/other/b.ts")], []);
    const linPath = write("l.jsonl", `${lin}\n`);
    const linResult = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(linResult.logsChanged, 0);
    assert.equal(readFileSync(linPath, "utf8"), `${lin}\n`);
  });

  it("keeps malformed lines verbatim and preserves a missing trailing newline", () => {
    const bad = "{not json";
    const invalid = JSON.stringify({ v: 2, blocks: [{ path: "/work/app/a.ts" }] });
    const gone = card("gone", [block(0, "/work/app/a.ts")], []);
    const tail = card("tail", [block(0, "/work/other/z.ts")], []);
    const path = write("x.jsonl", `${bad}\n${invalid}\n${gone}\n${tail}`);
    scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(readFileSync(path, "utf8"), `${bad}\n${invalid}\n${tail}`);
  });

  it("leaves an untouched log byte-identical with the same mtime", () => {
    const line = card("c", [block(0, "/work/other/a.ts")], []);
    const path = write("x.jsonl", `${line}\n\n`);
    utimesSync(path, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    const before = statSync(path);
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.logsChanged, 0);
    assert.equal(readFileSync(path, "utf8"), `${line}\n\n`);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  });

  it("deletes a log that ends up empty and counts the freed bytes", () => {
    const gone = card("gone", [block(0, "/work/app/a.ts")], []);
    const path = write("x.jsonl", `${gone}\n`);
    const size = statSync(path).size;
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(existsSync(path), false);
    assert.equal(result.logsChanged, 1);
    assert.equal(result.freedBytes, size);
  });

  it("scrubs every revision of one card", () => {
    const r1 = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], [step("e", [0])], 1);
    const r2 = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts"), block(2, "/work/app/c.ts")], [step("e", [0, 2])], 2);
    const path = write("x.jsonl", `${r1}\n${r2}\n`);
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.blocksRemoved, 3);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const parsed of lines) {
      assert.deepEqual(parsed.blocks.map((b: { path: string }) => b.path), ["/work/other/b.ts"]);
      assert.deepEqual(parsed.flow, []);
    }
  });

  it("retries after a concurrent append and keeps the appended line", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const appended = card("late", [block(0, "/work/other/late.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    let calls = 0;
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        beforeReplace: (target) => {
          calls += 1;
          if (calls === 1) appendFileSync(target, `${appended}\n`);
        },
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.logsChanged, 1);
    assert.deepEqual(result.incomplete, []);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], appended);
    assert.equal(JSON.parse(lines[0] as string).blocks.length, 1);
    assert.deepEqual(tempFiles(), []);
  });

  it("lists a log in incomplete after persistent concurrency and leaves no temp file", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: { beforeReplace: (target) => appendFileSync(target, `${first}\n`) },
    });
    assert.deepEqual(result.incomplete, [path]);
    assert.equal(result.logsChanged, 0);
    assert.deepEqual(tempFiles(), []);
  });

  it("lists a log in incomplete when the replace step fails and leaves no temp file", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        beforeReplace: () => {
          throw new Error("boom");
        },
      },
    });
    assert.deepEqual(result.incomplete, [path]);
    assert.equal(readFileSync(path, "utf8"), `${first}\n`);
    assert.deepEqual(tempFiles(), []);
  });

  it("leaves no temp file after a successful scrub", () => {
    write("x.jsonl", `${card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], [])}\n`);
    scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.deepEqual(tempFiles(), []);
  });

  it("skips a symlinked log and lists it", (t) => {
    const target = join(home.dir(), "real.jsonl");
    writeFileSync(target, `${card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], [])}\n`);
    const link = logPath("link.jsonl");
    try {
      symlinkSync(target, link);
    } catch {
      t.skip("symlinks unavailable");
      return;
    }
    const before = readFileSync(target, "utf8");
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.deepEqual(result.incomplete, [link]);
    assert.equal(readFileSync(target, "utf8"), before);
  });

  it("skips the purged repo's own logs", () => {
    const own = cardsFilePath("/work/app", home.dir());
    const content = `${card("c", [block(0, "/work/app/a.ts")], [])}\n`;
    writeFileSync(own, content);
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.logsChanged, 0);
    assert.equal(readFileSync(own, "utf8"), content);
  });
});

describe("scrubRepoCards failure handling", () => {
  beforeEach(() => {
    rmSync(cardsDir(), { recursive: true, force: true });
    mkdirSync(cardsDir(), { recursive: true });
  });

  function busy(): NodeJS.ErrnoException {
    return Object.assign(new Error("busy"), { code: "EBUSY" });
  }

  it("does not overwrite a line appended while a rename retry waits", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const appended = card("late", [block(0, "/work/other/late.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    let renames = 0;
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        fsOps: {
          renameSync: (from, to) => {
            renames += 1;
            if (renames === 1) {
              appendFileSync(path, `${appended}\n`);
              throw busy();
            }
            renameSync(from, to);
          },
        },
      },
    });
    assert.deepEqual(result.incomplete, []);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], appended);
    assert.equal(JSON.parse(lines[0] as string).blocks.length, 1);
    assert.deepEqual(tempFiles(), []);
  });

  it("does not delete a log that gained a line while an unlink retry waits", () => {
    const gone = card("gone", [block(0, "/work/app/a.ts")], []);
    const appended = card("late", [block(0, "/work/other/late.ts")], []);
    const path = write("x.jsonl", `${gone}\n`);
    let unlinks = 0;
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        fsOps: {
          unlinkSync: (target) => {
            unlinks += 1;
            if (unlinks === 1) {
              appendFileSync(path, `${appended}\n`);
              throw busy();
            }
            unlinkSync(target);
          },
        },
      },
    });
    assert.deepEqual(result.incomplete, []);
    assert.equal(readFileSync(path, "utf8"), `${appended}\n`);
  });

  it("removes the temp file when the temp write fails", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        fsOps: {
          writeSync: () => {
            throw Object.assign(new Error("full"), { code: "ENOSPC" });
          },
        },
      },
    });
    assert.deepEqual(result.incomplete, [path]);
    assert.deepEqual(tempFiles(), []);
    assert.equal(readFileSync(path, "utf8"), `${first}\n`);
  });

  it("removes the temp file when closing the temp fails", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        fsOps: {
          closeSync: (fd) => {
            closeSync(fd);
            throw Object.assign(new Error("io"), { code: "EIO" });
          },
        },
      },
    });
    assert.deepEqual(result.incomplete, [path]);
    assert.deepEqual(tempFiles(), []);
  });

  it("retries a transient temp cleanup failure", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    let failures = 0;
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        beforeReplace: () => {
          throw new Error("boom");
        },
        fsOps: {
          unlinkSync: (target) => {
            if (failures < 1) {
              failures += 1;
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            }
            unlinkSync(target);
          },
        },
      },
    });
    assert.deepEqual(result.incomplete, [path]);
    assert.deepEqual(tempFiles(), []);
  });

  it("lists the log in incomplete when temp cleanup keeps failing, even if a later attempt succeeds", () => {
    const first = card("c", [block(0, "/work/app/a.ts"), block(1, "/work/other/b.ts")], []);
    const appended = card("late", [block(0, "/work/other/late.ts")], []);
    const path = write("x.jsonl", `${first}\n`);
    let hookCalls = 0;
    const result = scrubRepoCards(["/work/app"], {
      home: home.dir(),
      platform: "linux",
      hooks: {
        beforeReplace: (target) => {
          hookCalls += 1;
          if (hookCalls === 1) appendFileSync(target, `${appended}\n`);
        },
        fsOps: {
          unlinkSync: (target) => {
            if (String(target).endsWith(".tmp") && hookCalls === 1) {
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            }
            unlinkSync(target);
          },
        },
      },
    });
    assert.ok(result.incomplete.includes(path));
    assert.equal(tempFiles().length, 1);
  });

  it("keeps a log whose only surviving line is opaque non-UTF-8 bytes", () => {
    const gone = card("gone", [block(0, "/work/app/a.ts")], []);
    const path = logPath("x.jsonl");
    writeFileSync(path, Buffer.concat([Buffer.from(`${gone}\n`), Buffer.from([0xa0, 0x0a])]));
    const result = scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.equal(result.cardsRemoved, 1);
    assert.deepEqual(readFileSync(path), Buffer.from([0xa0, 0x0a]));
  });

  it("keeps a log whose only surviving line is whitespace", () => {
    const gone = card("gone", [block(0, "/work/app/a.ts")], []);
    const path = logPath("x.jsonl");
    writeFileSync(path, Buffer.from(`${gone}\n \t\n`));
    scrubRepoCards(["/work/app"], { home: home.dir(), platform: "linux" });
    assert.deepEqual(readFileSync(path), Buffer.from(" \t\n"));
  });
});
