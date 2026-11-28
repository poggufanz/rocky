import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAPTURE_PROMPT, ENV_REPORT_KEYS, isMainModule } from "../capture.mjs";
import {
  CLAUDE_FLAGS,
  MODEL,
  assertNoAncestorInstructions,
  assertOutsideWorkspace,
  buildToolEnv,
  createSandbox,
  destroySandbox,
  exposeProviderLauncher,
  packArm,
  publishTarball,
  redactText,
  resolveExecutableOnPath,
  resolveProviderExecutable,
  scrubEnv,
  stripRockyFromPath,
} from "../sandbox.mjs";

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(evalDir, "..", "..");
const captureScript = join(evalDir, "capture.mjs");

describe("sandbox", () => {
  test("scrubEnv drops agent and rocky variables", () => {
    const input = {
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "x",
      ROCKY_AGENT_SESSION: "s",
      ROCKY_HOME: "h",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_ENV_FILE: "f",
      NODE_OPTIONS: "--x",
      PATH: "p",
    };
    const snapshot = { ...input };

    const out = scrubEnv(input, process.platform);

    assert.deepEqual(out, { PATH: "p" });
    assert.deepEqual(input, snapshot);
  });

  test("buildToolEnv drops OAuth tokens, CLAUDECODE, NODE_OPTIONS, FORCE_COLOR, and git config overrides", () => {
    const input = {
      ROCKY_EVAL_OAUTH_TOKEN: "eval-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "/cfg",
      ROCKY_HOME: "/rh",
      ANTHROPIC_API_KEY: "ak",
      NODE_OPTIONS: "--require /evil.cjs",
      FORCE_COLOR: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/x",
      GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
      GIT_CONFIG_GLOBAL: "/controller/.gitconfig",
      GIT_CONFIG_SYSTEM: "/controller/gitconfig",
      Path: "/usr/bin",
      KEEP: "yes",
    };
    const snapshot = { ...input };

    const out = buildToolEnv(input, process.platform);

    assert.equal(out.ROCKY_EVAL_OAUTH_TOKEN, undefined);
    assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(out.CLAUDECODE, undefined);
    assert.equal(out.NODE_OPTIONS, undefined);
    assert.equal(out.FORCE_COLOR, undefined);
    assert.equal(out.GIT_CONFIG_COUNT, undefined);
    assert.equal(out.GIT_CONFIG_KEY_0, undefined);
    assert.equal(out.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(out.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(out.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(out.GIT_CONFIG_SYSTEM, undefined);
    assert.equal(out.npm_config_color, "false");
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.KEEP, "yes");
    assert.deepEqual(input, snapshot);
  });

  test("buildToolEnv with home pins HOME, USERPROFILE, and GIT_CONFIG_NOSYSTEM without tokens or git config overrides", () => {
    const input = {
      ROCKY_EVAL_OAUTH_TOKEN: "eval-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
      CLAUDECODE: "1",
      NODE_OPTIONS: "--require /evil.cjs",
      Home: "/controller-home",
      UserProfile: "C:\\Users\\controller",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/x",
      GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
      GIT_CONFIG_GLOBAL: "/controller/.gitconfig",
      GIT_CONFIG_SYSTEM: "/controller/gitconfig",
      XDG_CONFIG_HOME: "/controller/.config",
      PATH: "/usr/bin",
    };
    const snapshot = { ...input };
    const sandboxHome = "/sandbox/run-1/home";

    const out = buildToolEnv(input, process.platform, { home: sandboxHome });

    assert.equal(out.HOME, sandboxHome);
    assert.equal(out.USERPROFILE, sandboxHome);
    assert.equal(out.Home, undefined);
    assert.equal(out.UserProfile, undefined);
    assert.equal(out.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(out.GIT_CONFIG_COUNT, undefined);
    assert.equal(out.GIT_CONFIG_KEY_0, undefined);
    assert.equal(out.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(out.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(out.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(out.GIT_CONFIG_SYSTEM, undefined);
    assert.equal(out.XDG_CONFIG_HOME, undefined);
    assert.equal(out.ROCKY_EVAL_OAUTH_TOKEN, undefined);
    assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(out.CLAUDECODE, undefined);
    assert.equal(out.NODE_OPTIONS, undefined);
    assert.deepEqual(input, snapshot);
  });

  test("stripRockyFromPath removes rocky shims, empty entries, and relative entries", () => {
    const winSeen = [];
    const winOut = stripRockyFromPath(
      "C:\\A;C:\\B;;rel\\bin;.;\\drive-rel;/drive-rel;C:/D;\\\\server\\share\\bin;//server/share/bin;C:\\C",
      "win32",
      (dir) => {
        winSeen.push(dir);
        return dir === "C:\\B";
      },
    );
    assert.equal(winOut, "C:\\A;C:/D;\\\\server\\share\\bin;//server/share/bin;C:\\C");
    assert.deepEqual(winSeen, [
      "C:\\A",
      "C:\\B",
      "C:/D",
      "\\\\server\\share\\bin",
      "//server/share/bin",
      "C:\\C",
    ]);

    const posixSeen = [];
    const posixOut = stripRockyFromPath(
      "/a:/b::./rel:.:rel/bin:/c",
      "linux",
      (dir) => {
        posixSeen.push(dir);
        return dir === "/b";
      },
    );
    assert.equal(posixOut, "/a:/c");
    assert.deepEqual(posixSeen, ["/a", "/b", "/c"]);
  });

  test("assertNoAncestorInstructions throws naming the first ancestor CLAUDE.md", () => {
    const offending = "/a/CLAUDE.md";
    const exists = (candidate) => candidate === offending;

    assert.throws(
      () => assertNoAncestorInstructions("/a/b/c", exists),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\/a\/CLAUDE\.md/);
        return true;
      },
    );
  });

  test("assertNoAncestorInstructions checks AGENTS.md and .claude in root and ancestors", () => {
    assert.throws(
      () => assertNoAncestorInstructions("/x/y", (candidate) => candidate === "/x/y/.claude"),
      /\/x\/y\/\.claude/,
    );
    assert.throws(
      () => assertNoAncestorInstructions("C:\\work\\sub\\run", (candidate) => candidate === "C:\\work\\AGENTS.md"),
      /C:\\work\\AGENTS\.md/,
    );
    assert.doesNotThrow(() => assertNoAncestorInstructions("/clean/root", () => false));
  });

  test("assertNoAncestorInstructions checks canonical ancestors when lexical chain is clean", () => {
    const exists = (candidate) => candidate === "/real/CLAUDE.md";
    const realpath = (candidate) => {
      if (candidate === "/clean/link") return "/real/target";
      const err = new Error(`ENOENT: ${candidate}`);
      err.code = "ENOENT";
      throw err;
    };

    assert.throws(
      () => assertNoAncestorInstructions("/clean/link/sub/run", exists, realpath),
      /\/real\/CLAUDE\.md/,
    );
  });

  test("assertNoAncestorInstructions probes POSIX components ending in a literal backslash", () => {
    const offending = "/real/dir\\/CLAUDE.md";
    const exists = (candidate) => candidate === offending;
    const realpath = (candidate) => {
      if (candidate === "/clean/link") return "/real/dir\\/target";
      const err = new Error(`ENOENT: ${candidate}`);
      err.code = "ENOENT";
      throw err;
    };

    assert.throws(
      () => assertNoAncestorInstructions("/real/dir\\/sub", exists, realpath, "linux"),
      /\/real\/dir\\\/CLAUDE\.md/,
    );
    assert.throws(
      () => assertNoAncestorInstructions("/clean/link/sub/run", exists, realpath, "linux"),
      /\/real\/dir\\\/CLAUDE\.md/,
    );
  });

  test("assertOutsideWorkspace refuses repo child, workspace sibling, ..foo child, and symlinked targets", () => {
    const posixRealpath = (candidate) => {
      if (candidate === "/ext/link") return "/ws/repo";
      if (candidate === "/ws/repo" || candidate === "/ws" || candidate === "/outside" || candidate === "/") {
        return candidate;
      }
      const err = new Error(`ENOENT: ${candidate}`);
      err.code = "ENOENT";
      throw err;
    };

    assert.throws(
      () => assertOutsideWorkspace("/ws/repo/out", "/ws/repo", "linux", posixRealpath),
      /outside the repo/i,
    );
    assert.throws(
      () => assertOutsideWorkspace("/ws/sibling", "/ws/repo", "linux", posixRealpath),
      /enclosing workspace/i,
    );
    assert.throws(
      () => assertOutsideWorkspace("/ws/..\\scratch/out", "/ws/repo", "linux", posixRealpath),
      /enclosing workspace/i,
    );
    assert.throws(
      () => assertOutsideWorkspace("/ws/repo/..foo", "/ws/repo", "linux", posixRealpath),
      /outside the repo/i,
    );
    assert.throws(
      () => assertOutsideWorkspace("/ext/link/out", "/ws/repo", "linux", posixRealpath),
      /outside the repo/i,
    );
    assert.doesNotThrow(
      () => assertOutsideWorkspace("/outside/out", "/ws/repo", "linux", posixRealpath),
    );

    const winRealpath = (candidate) => {
      const lower = candidate.toLowerCase();
      if (lower === "c:\\ws\\repo") return "C:\\WS\\repo";
      if (lower === "c:\\ws") return "C:\\WS";
      if (lower === "d:\\outside") return "D:\\outside";
      const err = new Error(`ENOENT: ${candidate}`);
      err.code = "ENOENT";
      throw err;
    };
    assert.throws(
      () => assertOutsideWorkspace("c:\\ws\\REPO\\..foo", "C:\\WS\\repo", "win32", winRealpath),
      /outside the repo/i,
    );
    assert.throws(
      () => assertOutsideWorkspace("c:\\ws\\sibling", "C:\\WS\\repo", "win32", winRealpath),
      /enclosing workspace/i,
    );
    assert.doesNotThrow(
      () => assertOutsideWorkspace("D:\\outside\\out", "C:\\WS\\repo", "win32", winRealpath),
    );
  });

  test(
    "resolveExecutableOnPath resolves a symlink to an executable regular file",
    { skip: process.platform === "win32" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "rocky-eval-symlink-"));
      try {
        const realDir = join(dir, "real");
        const binDir = join(dir, "bin");
        mkdirSync(realDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        const target = join(realDir, "probe-tool");
        writeFileSync(target, "#!/bin/sh\nexit 0\n", "utf8");
        chmodSync(target, 0o755);
        const link = join(binDir, "probe-tool");
        symlinkSync(target, link);

        const found = resolveExecutableOnPath(["probe-tool"], binDir, process.platform);
        assert.equal(found, resolve(link));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("provider resolution skips relative PATH entries", (t) => {
    const local = mkdtempSync(join(process.cwd(), ".rocky-provider-path-"));
    const trusted = mkdtempSync(join(tmpdir(), "rocky-provider-path-"));
    t.after(() => {
      rmSync(local, { recursive: true, force: true });
      rmSync(trusted, { recursive: true, force: true });
    });
    const file = "fixture-provider";
    const executable = process.platform === "win32" ? `${file}.exe` : file;
    writeFileSync(join(local, executable), "local fixture", { mode: 0o700 });
    const trustedExecutable = join(trusted, executable);
    writeFileSync(trustedExecutable, "trusted fixture", { mode: 0o700 });

    const relativePath = relative(process.cwd(), local);
    assert.throws(() => resolveProviderExecutable(file, { PATH: relativePath }), /not found on PATH/);
    const trustedPath = process.platform === "win32" ? `"${trusted}"` : trusted;
    assert.equal(resolveProviderExecutable(file, { PATH: [relativePath, trustedPath].join(delimiter) }), trustedExecutable);
  });

  test("Windows provider launcher has independent file contents", (t) => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-launcher-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const executable = join(root, "fixture.exe");
    const sandbox = join(root, "sandbox");
    mkdirSync(sandbox);
    writeFileSync(executable, "host fixture");

    const launcher = join(exposeProviderLauncher(sandbox, "fixture", executable, "win32"), "fixture.exe");
    assert.equal(readFileSync(launcher, "utf8"), "host fixture");
    assert.equal(statSync(executable).nlink, 1);
    assert.equal(statSync(launcher).nlink, 1);
    writeFileSync(launcher, "changed fixture");
    assert.equal(readFileSync(executable, "utf8"), "host fixture");
  });

  test("sandbox env points every home variable inside the sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-test-"));
    let sandbox;
    try {
      sandbox = await createSandbox({
        arm: "none",
        runId: "run-home-check",
        root,
        exists: () => false,
      });

      for (const key of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "ROCKY_HOME"]) {
        const value = sandbox.env[key];
        assert.equal(typeof value, "string", `${key} should be set`);
        assert.equal(
          value.startsWith(sandbox.dir),
          true,
          `${key} (${value}) must start with ${sandbox.dir}`,
        );
      }

      const pathKey = Object.keys(sandbox.env).find((key) => key.toUpperCase() === "PATH");
      assert.ok(pathKey, "PATH must exist in sandbox env");
      const sep = process.platform === "win32" ? ";" : ":";
      const dirs = (sandbox.env[pathKey] ?? "").split(sep).filter(Boolean);
      const shimNames = process.platform === "win32"
        ? ["rocky.cmd", "rocky.exe", "rocky.ps1", "rocky.bat", "rocky"]
        : ["rocky"];
      for (const dir of dirs) {
        for (const name of shimNames) {
          assert.equal(
            existsSync(join(dir, name)),
            false,
            `rocky shim should not resolve on sandbox PATH: ${join(dir, name)}`,
          );
        }
      }

      assert.equal(existsSync(sandbox.home), true);
      assert.equal(existsSync(sandbox.configDir), true);
      assert.equal(existsSync(sandbox.rockyHome), true);
      assert.equal(existsSync(sandbox.taskDir), true);
    } finally {
      if (sandbox) await destroySandbox(sandbox);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createSandbox refuses existing runId and leaves the first sandbox intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-dup-"));
    let first;
    try {
      first = await createSandbox({
        arm: "none",
        runId: "dup-run",
        root,
        exists: () => false,
      });
      const marker = join(first.taskDir, "marker.txt");
      writeFileSync(marker, "keep-me\n", "utf8");

      await assert.rejects(
        () => createSandbox({
          arm: "none",
          runId: "dup-run",
          root,
          exists: () => false,
        }),
        /dup-run/,
      );

      assert.equal(existsSync(marker), true);
      assert.equal(readFileSync(marker, "utf8"), "keep-me\n");
    } finally {
      if (first) await destroySandbox(first);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createSandbox removes the run dir when initialization fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-fail-"));
    try {
      await assert.rejects(
        () => createSandbox({
          arm: "after",
          runId: "failed-run",
          root,
          tgz: join(root, "does-not-exist.tgz"),
          exists: () => false,
        }),
        /existing tarball/i,
      );

      assert.equal(existsSync(join(root, "failed-run")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createSandbox supports token and copy-credentials auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "rocky-eval-auth-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "rocky-eval-creds-"));
    const credsPath = join(sourceDir, ".credentials.json");
    writeFileSync(credsPath, '{"accessToken":"fixture"}\n', "utf8");
    const extraFile = join(sourceDir, "unrelated.json");
    writeFileSync(extraFile, "{}\n", "utf8");

    let tokenSandbox;
    let copySandbox;
    try {
      const harnessEnv = { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "secret-eval-token-123" };
      tokenSandbox = await createSandbox({
        arm: "none",
        runId: "auth-token",
        root,
        auth: { kind: "token" },
        exists: () => false,
        env: harnessEnv,
      });
      assert.equal(tokenSandbox.env.CLAUDE_CODE_OAUTH_TOKEN, "secret-eval-token-123");
      assert.equal(tokenSandbox.env.ROCKY_EVAL_OAUTH_TOKEN, undefined);

      copySandbox = await createSandbox({
        arm: "none",
        runId: "auth-copy",
        root,
        auth: { kind: "copy-credentials", from: credsPath },
        exists: () => false,
      });
      const copied = join(copySandbox.configDir, ".credentials.json");
      assert.equal(existsSync(copied), true);
      assert.equal(readFileSync(copied, "utf8"), '{"accessToken":"fixture"}\n');
      assert.equal(existsSync(join(copySandbox.configDir, "unrelated.json")), false);
      assert.equal(copySandbox.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    } finally {
      if (tokenSandbox) await destroySandbox(tokenSandbox);
      if (copySandbox) await destroySandbox(copySandbox);
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("packArm treats an existing cached tarball as a hit without creating worktrees", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rocky-eval-pack-hit-"));
    try {
      const rev = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(rev.status, 0);
      const sha = rev.stdout.trim();
      const cached = join(cacheDir, `rocky-${sha}.tgz`);
      writeFileSync(cached, "cached-tarball", "utf8");

      const [p1, p2] = await Promise.all([
        packArm("HEAD", cacheDir),
        packArm("HEAD", cacheDir),
      ]);
      assert.equal(p1, cached);
      assert.equal(p2, cached);
      assert.deepEqual(readdirSync(cacheDir), [`rocky-${sha}.tgz`]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("publishTarball preserves existing cached tarball on race and cleans staged file", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rocky-eval-publish-"));
    try {
      const cached = join(cacheDir, "rocky-abc.tgz");
      const stagedRace = join(cacheDir, "rocky-abc.tgz.tmp-race");
      writeFileSync(cached, "first-winner-bytes", "utf8");
      writeFileSync(stagedRace, "second-loser-bytes", "utf8");

      const raceResult = publishTarball(stagedRace, cached);
      assert.equal(raceResult, cached);
      assert.equal(readFileSync(cached, "utf8"), "first-winner-bytes");
      assert.equal(existsSync(stagedRace), false);

      const freshCached = join(cacheDir, "rocky-def.tgz");
      const stagedFresh = join(cacheDir, "rocky-def.tgz.tmp-fresh");
      writeFileSync(stagedFresh, "fresh-tarball-bytes", "utf8");

      const freshResult = publishTarball(stagedFresh, freshCached);
      assert.equal(freshResult, freshCached);
      assert.equal(readFileSync(freshCached, "utf8"), "fresh-tarball-bytes");
      assert.equal(existsSync(stagedFresh), false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("publishTarball falls back to exclusive copy when hard links fail with EPERM", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rocky-eval-publish-fallback-"));
    try {
      const cached = join(cacheDir, "rocky-fallback.tgz");
      const stagedFirst = join(cacheDir, "rocky-fallback.tgz.tmp-1");
      const stagedSecond = join(cacheDir, "rocky-fallback.tgz.tmp-2");
      writeFileSync(stagedFirst, "first-fallback-bytes", "utf8");
      writeFileSync(stagedSecond, "second-different-bytes", "utf8");

      const failWithEperm = () => {
        const err = new Error("EPERM: operation not permitted, link");
        err.code = "EPERM";
        throw err;
      };

      const firstResult = publishTarball(stagedFirst, cached, failWithEperm);
      assert.equal(firstResult, cached);
      assert.equal(readFileSync(cached, "utf8"), "first-fallback-bytes");
      assert.equal(existsSync(stagedFirst), false);

      const secondResult = publishTarball(stagedSecond, cached, failWithEperm);
      assert.equal(secondResult, cached);
      assert.equal(readFileSync(cached, "utf8"), "first-fallback-bytes");
      assert.equal(existsSync(stagedSecond), false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("publishTarball fallback copies to a cache-dir temp file before renaming atomically", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rocky-eval-publish-atomic-"));
    try {
      const cached = join(cacheDir, "rocky-atomic.tgz");
      const staged = join(cacheDir, "rocky-atomic.tgz.tmp-stage");
      writeFileSync(staged, "atomic-fallback-bytes", "utf8");

      const failWithEperm = () => {
        const err = new Error("EPERM: operation not permitted, link");
        err.code = "EPERM";
        throw err;
      };

      const copyCalls = [];
      const trackedCopy = (src, dest) => {
        copyCalls.push({ src, dest });
        assert.equal(existsSync(cached), false);
        assert.notEqual(dest, cached);
        assert.equal(dirname(dest), cacheDir);
        assert.match(dest, /\.tgz\.tmp-\d+-[0-9a-f]+$/);
        copyFileSync(src, dest);
      };

      const result = publishTarball(staged, cached, failWithEperm, trackedCopy);
      assert.equal(result, cached);
      assert.equal(copyCalls.length, 1);
      assert.equal(copyCalls[0].src, staged);
      assert.equal(readFileSync(cached, "utf8"), "atomic-fallback-bytes");
      assert.equal(existsSync(staged), false);
      assert.deepEqual(readdirSync(cacheDir), ["rocky-atomic.tgz"]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("publishTarball fallback treats rename error as cache hit only when cached exists and always cleans temp files", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rocky-eval-publish-rename-"));
    try {
      const failWithEperm = () => {
        const err = new Error("EPERM: operation not permitted, link");
        err.code = "EPERM";
        throw err;
      };

      const cachedHit = join(cacheDir, "rocky-rename-hit.tgz");
      const stagedHit = join(cacheDir, "rocky-rename-hit.tgz.tmp-stage");
      writeFileSync(stagedHit, "loser-bytes", "utf8");
      const copyThenRace = (src, dest) => {
        assert.equal(existsSync(cachedHit), false);
        copyFileSync(src, dest);
        writeFileSync(cachedHit, "winner-bytes", "utf8");
      };
      const failRenameEbusy = () => {
        const err = new Error("EBUSY: resource busy or locked, rename");
        err.code = "EBUSY";
        throw err;
      };

      const hitResult = publishTarball(stagedHit, cachedHit, failWithEperm, copyThenRace, failRenameEbusy);
      assert.equal(hitResult, cachedHit);
      assert.equal(readFileSync(cachedHit, "utf8"), "winner-bytes");
      assert.equal(existsSync(stagedHit), false);
      assert.deepEqual(readdirSync(cacheDir), ["rocky-rename-hit.tgz"]);

      const cachedMiss = join(cacheDir, "rocky-rename-miss.tgz");
      const stagedMiss = join(cacheDir, "rocky-rename-miss.tgz.tmp-stage");
      writeFileSync(stagedMiss, "miss-bytes", "utf8");
      const failRenameEperm = () => {
        const err = new Error("EPERM: rename failed");
        err.code = "EPERM";
        throw err;
      };

      assert.throws(
        () => publishTarball(stagedMiss, cachedMiss, failWithEperm, copyFileSync, failRenameEperm),
        /rename failed/,
      );
      assert.equal(existsSync(cachedMiss), false);
      assert.equal(existsSync(stagedMiss), false);
      assert.deepEqual(readdirSync(cacheDir), ["rocky-rename-hit.tgz"]);

      const cachedCopyErr = join(cacheDir, "rocky-copy-err.tgz");
      const stagedCopyErr = join(cacheDir, "rocky-copy-err.tgz.tmp-stage");
      writeFileSync(stagedCopyErr, "full-bytes", "utf8");
      const failMidCopy = (_src, dest) => {
        writeFileSync(dest, "partial", "utf8");
        const err = new Error("ENOSPC: no space left on device");
        err.code = "ENOSPC";
        throw err;
      };

      assert.throws(
        () => publishTarball(stagedCopyErr, cachedCopyErr, failWithEperm, failMidCopy),
        /ENOSPC/,
      );
      assert.equal(existsSync(cachedCopyErr), false);
      assert.equal(existsSync(stagedCopyErr), false);
      assert.deepEqual(readdirSync(cacheDir), ["rocky-rename-hit.tgz"]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("exports frozen model, flags, and packArm", () => {
    assert.equal(MODEL, "claude-sonnet-5-5");
    assert.deepEqual(CLAUDE_FLAGS, [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "30",
      "--model",
      MODEL,
      "--effort",
      "high",
      "--allowedTools",
      "Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__*",
      "--",
    ]);
    assert.equal(typeof packArm, "function");
  });

  test("CLAUDE_FLAGS ends with -- so the prompt is never an allowedTools value", () => {
    assert.equal(CLAUDE_FLAGS.at(-1), "--");

    const allowedToolsIdx = CLAUDE_FLAGS.indexOf("--allowedTools");
    assert.ok(allowedToolsIdx >= 0, "--allowedTools must be present");
    assert.ok(allowedToolsIdx < CLAUDE_FLAGS.length - 1, "--allowedTools must precede --");

    const effortIdx = CLAUDE_FLAGS.indexOf("--effort");
    assert.ok(effortIdx >= 0, "--effort must be present");
    assert.equal(CLAUDE_FLAGS[effortIdx + 1], "high");

    const modelIdx = CLAUDE_FLAGS.indexOf("--model");
    assert.ok(modelIdx >= 0, "--model must be present");
    assert.equal(CLAUDE_FLAGS[modelIdx + 1], MODEL);

    assert.equal(CLAUDE_FLAGS.includes("--setting-sources"), false);
    assert.equal(CLAUDE_FLAGS.includes("--strict-mcp-config"), false);
  });
});

describe("capture CLI guards", () => {
  test("isMainModule resolves symlinks via realpath and returns false on errors", () => {
    const captureUrl = pathToFileURL(captureScript).href;
    assert.equal(isMainModule(captureScript, captureUrl), true);
    assert.equal(isMainModule(undefined, captureUrl), false);
    assert.equal(isMainModule("", captureUrl), false);

    const symlinkRealpath = (candidate) => {
      if (candidate === "/bin/capture-link") return "/repo/scripts/eval/capture.mjs";
      if (candidate === fileURLToPath(captureUrl)) return "/repo/scripts/eval/capture.mjs";
      return candidate;
    };
    assert.equal(isMainModule("/bin/capture-link", captureUrl, symlinkRealpath), true);
    assert.equal(isMainModule("/bin/other-script", captureUrl, symlinkRealpath), false);
    assert.equal(
      isMainModule("/missing/path", captureUrl, () => {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }),
      false,
    );
  });

  test("CAPTURE_PROMPT requests only the seven reported variables and never dumps full env", () => {
    for (const key of ENV_REPORT_KEYS) {
      assert.match(CAPTURE_PROMPT, new RegExp(`\\b${key}\\b`));
    }
    assert.doesNotMatch(CAPTURE_PROMPT, /\bprintenv\b/i);
    assert.doesNotMatch(CAPTURE_PROMPT, /Get-ChildItem/i);
    assert.doesNotMatch(CAPTURE_PROMPT, /OAUTH_TOKEN/i);
  });

  test("exits 2 when ROCKY_EVAL_OAUTH_TOKEN is missing in token mode", () => {
    const outDir = mkdtempSync(join(tmpdir(), "rocky-eval-out-"));
    try {
      const env = { ...process.env };
      delete env.ROCKY_EVAL_OAUTH_TOKEN;
      const result = spawnSync(
        process.execPath,
        [captureScript, "--arm", "none", "--auth", "token", "--out", outDir],
        { env, encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /ROCKY_EVAL_OAUTH_TOKEN/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("exits 2 when --out is inside the repo", () => {
    const insideRepo = join(repoRoot, "scripts", "eval", "tmp-capture-out");
    const env = { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "dummy-token" };
    const result = spawnSync(
      process.execPath,
      [captureScript, "--arm", "none", "--auth", "token", "--out", insideRepo],
      { env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside the repo/i);
  });

  test("exits 2 when --out is a workspace sibling", () => {
    const workspaceSibling = join(dirname(repoRoot), "tmp-capture-sibling");
    const env = { ...process.env, ROCKY_EVAL_OAUTH_TOKEN: "dummy-token" };
    const result = spawnSync(
      process.execPath,
      [captureScript, "--arm", "none", "--auth", "token", "--out", workspaceSibling],
      { env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside the repo/i);
  });

  test("redactText replaces every occurrence of secrets", () => {
    const out = redactText("tok=abc-123 and again abc-123", ["abc-123", ""]);
    assert.equal(out, "tok=<redacted> and again <redacted>");
  });

  test("CLAUDE.md fixtures match expected structure", () => {
    const fixturesDir = join(evalDir, "fixtures", "claude-md");
    const baseLines = readFileSync(join(fixturesDir, "base.md"), "utf8").trim().split(/\r?\n/);
    assert.equal(baseLines.length, 3);
    const rockySection = readFileSync(join(fixturesDir, "rocky-section.md"), "utf8");
    assert.match(rockySection, /^## Rocky \(MUST\)/);
    assert.match(rockySection, /rocky run/);
    assert.match(rockySection, /rocky recall/);
    assert.doesNotMatch(rockySection, /rocky journal/);
  });
});
