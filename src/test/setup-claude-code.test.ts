import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";
import { createClaudeCodeAdapter } from "../setup/claude-code.js";

const registration = {
  name: "rocky" as const,
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
};

const addArgs = [
  "mcp", "add",
  "--scope", "user",
  "--transport", "stdio",
  "--env", "ROCKY_MCP_EXPOSURE=sanitized",
  "--env", "ROCKY_HOME=/home/ada/.rocky",
  "rocky", "--", "/opt/node", "/opt/rocky/dist/index.js", "mcp",
];
const removeArgs = ["mcp", "remove", "--scope", "user", "rocky"];

interface RunnerCall {
  command: string;
  args: readonly string[];
  options?: ProcessRunOptions;
}

type RunnerStep = ProcessResult | ((call: RunnerCall) => ProcessResult);

class FakeRunner implements ProcessRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly steps: RunnerStep[]) {}

  async run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    const step = this.steps.shift();
    assert.ok(step, `unexpected process call: ${command} ${args.join(" ")}`);
    return typeof step === "function" ? step(call) : step;
  }
}

function result(status: number, stdout = "", stderr = ""): ProcessResult {
  return { status, stdout, stderr };
}

function claudeCall(args: readonly string[]): RunnerCall {
  return { command: "/opt/claude", args, options: { timeoutMs: 10_000 } };
}

function userConfig(t: test.TestContext, value?: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-claude-code-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, ".claude.json");
  if (value !== undefined) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  return path;
}

function rockyEntry(command = registration.command): Record<string, unknown> {
  return {
    type: "stdio",
    command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function backupNames(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) => name.startsWith(`${basename(path)}.backup-`));
}

test("missing Claude executable is skipped without reading real home or running a command", async (t) => {
  const path = userConfig(t);
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, userConfigPath: path });

  assert.equal((await adapter.configure(registration, false)).status, "skipped");
  assert.equal((await adapter.remove(registration)).status, "skipped");
  assert.equal((await adapter.check(registration)).status, "skipped");
  assert.deepEqual(runner.calls, []);
});

test("new user registration uses exact official Claude add argv", async (t) => {
  const path = userConfig(t, { theme: "dark", mcpServers: { other: { url: "https://local" } } });
  const runner = new FakeRunner([result(0)]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  assert.equal((await adapter.inspect(registration)).state, "absent");
  assert.equal((await adapter.configure(registration, false)).status, "configured");
  assert.deepEqual(runner.calls, [claudeCall(addArgs)]);
});

test("absent registration rechecks config topology immediately before add", async (t) => {
  const cases = [
    { name: "missing to symlink", initial: "missing", mutation: "symlink" },
    { name: "regular to symlink", initial: "regular", mutation: "symlink" },
    { name: "regular to non-regular", initial: "regular", mutation: "directory" },
    { name: "regular to multiple links", initial: "regular", mutation: "hard-link" },
    { name: "regular to new inode", initial: "regular", mutation: "inode" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const path = userConfig(st, entry.initial === "regular" ? { theme: "before" } : undefined);
      const directory = dirname(path);
      const target = join(directory, "race-target.json");
      const alias = join(directory, "race-alias.json");
      const targetBytes = '{"theme":"target","token":"topology-race-secret"}\n';
      if (entry.mutation === "symlink") writeFileSync(target, targetBytes, "utf8");

      const originalLstat = fs.lstatSync;
      const originalStat = fs.statSync;
      let mutated = false;
      const mutate = () => {
        if (mutated) return;
        mutated = true;
        if (entry.mutation === "symlink") {
          if (entry.initial === "regular") rmSync(path);
          symlinkSync(target, path);
        } else if (entry.mutation === "directory") {
          rmSync(path);
          fs.mkdirSync(path);
        } else if (entry.mutation === "hard-link") {
          linkSync(path, alias);
        } else {
          writeFileSync(alias, '{"theme":"new-inode","token":"inode-race-secret"}\n', "utf8");
          fs.renameSync(alias, path);
        }
      };

      if (entry.initial === "missing") {
        (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((candidate: fs.PathLike) => {
          try {
            return originalLstat(candidate);
          } catch (error) {
            if (String(candidate) === path) mutate();
            throw error;
          }
        }) as typeof fs.lstatSync;
      } else {
        (fs as unknown as { statSync: typeof fs.statSync }).statSync = ((candidate: fs.PathLike) => {
          const metadata = originalStat(candidate);
          if (String(candidate) === path) mutate();
          return metadata;
        }) as typeof fs.statSync;
      }
      syncBuiltinESMExports();

      const runner = new FakeRunner([result(0)]);
      try {
        const configured = await createClaudeCodeAdapter({
          runner,
          executable: "/opt/claude",
          userConfigPath: path,
        }).configure(registration, false);

        assert.equal(configured.status, "failed");
        assert.match(configured.detail ?? "", /topology|changed|manual/i);
        assert.doesNotMatch(configured.detail ?? "", /topology-race-secret|inode-race-secret/);
        assert.deepEqual(runner.calls, []);
      } finally {
        (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
        (fs as unknown as { statSync: typeof fs.statSync }).statSync = originalStat;
        syncBuiltinESMExports();
      }

      if (entry.mutation === "symlink") {
        assert.equal(lstatSync(path).isSymbolicLink(), true);
        assert.equal(readFileSync(target, "utf8"), targetBytes);
      } else if (entry.mutation === "directory") {
        assert.equal(lstatSync(path).isDirectory(), true);
      } else if (entry.mutation === "hard-link") {
        assert.equal(lstatSync(path).nlink, 2);
        assert.equal(readFileSync(alias, "utf8"), readFileSync(path, "utf8"));
      } else {
        assert.match(readFileSync(path, "utf8"), /inode-race-secret/);
      }
    });
  }
});

test("identical user registration is a no-op and healthy without human CLI inspection", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry() } });
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  assert.equal((await adapter.inspect(registration)).state, "identical");
  assert.equal((await adapter.configure(registration, false)).status, "already-configured");
  assert.equal((await adapter.check(registration)).status, "healthy");
  assert.deepEqual(runner.calls, []);
});

test("plain check returns exact owned raw registration for protocol health", async (t) => {
  const storedRaw = {
    ...registration,
    env: { ...registration.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  const path = userConfig(t, { mcpServers: { rocky: {
    type: "stdio",
    command: storedRaw.command,
    args: [...storedRaw.args],
    env: { ...storedRaw.env },
  } } });
  const adapter = createClaudeCodeAdapter({ runner: new FakeRunner([]), executable: "/opt/claude", userConfigPath: path });

  assert.deepEqual(await adapter.check(registration), {
    client: "claude-code",
    status: "healthy",
    healthRegistration: storedRaw,
  });
});

test("foreign registration requires confirmation and is not mutated", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/usr/bin/foreign") } });
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "requires-confirmation");
  assert.deepEqual(configured.manualRegistration, registration);
  assert.deepEqual(runner.calls, []);
});

test("explicit replacement backs up exact config then uses official remove and add", async (t) => {
  const original = {
    theme: "dark",
    secret: "fake-secret-token",
    mcpServers: {
      other: { url: "https://local", token: "other-secret" },
      rocky: { ...rockyEntry("/old/node"), disabled: true, future: { value: 7 } },
    },
  };
  const path = userConfig(t, original);
  const originalBytes = readFileSync(path);
  const runner = new FakeRunner([result(0), result(0)]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "configured");
  assert.deepEqual(runner.calls, [claudeCall(removeArgs), claudeCall(addArgs)]);
  const backups = readdirSync(join(path, "..")).filter((name) => name.startsWith(".claude.json.backup-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(join(path, "..", backups[0]!)), originalBytes);
});

test("replacement stops before remove when the full config backup cannot be created", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-claude-backup-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, `${"x".repeat(230)}.json`);
  const original = { mcpServers: { rocky: rockyEntry("/old/node") } };
  writeFileSync(path, `${JSON.stringify(original)}\n`, "utf8");
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /back up/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
  assert.deepEqual(runner.calls, []);
});

test("replacement reports an owned backup artifact when durability and cleanup fail", async (t) => {
  const original = {
    secret: "fake-code-backup-artifact-secret",
    mcpServers: { rocky: rockyEntry("/old/node") },
  };
  const path = userConfig(t, original);
  const originalBytes = readFileSync(path);
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const originalRm = fs.rmSync;
  let backupDescriptor: number | undefined;
  let backupPath: string | undefined;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const descriptor = originalOpen(target, flags, mode);
    if (String(target).includes(".backup-")) {
      backupDescriptor = descriptor;
      backupPath = String(target);
    }
    return descriptor;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((descriptor: number) => {
    if (descriptor === backupDescriptor) throw new Error("fake code backup fsync secret");
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target) === backupPath) throw Object.assign(new Error("fake code backup rm secret"), { code: "EACCES" });
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const runner = new FakeRunner([]);
    const configured = await createClaudeCodeAdapter({
      runner,
      executable: "/opt/claude",
      userConfigPath: path,
    }).configure(registration, true);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.ok(backupPath);
    assert.match(configured.detail ?? "", new RegExp(backupPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", /fake-code-backup-artifact-secret|fake code backup/i);
    assert.deepEqual(readFileSync(backupPath), originalBytes);
    assert.deepEqual(runner.calls, []);
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("replacement does not report a deleted backup after parent-sync failure", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/old/node") } });
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const originalRm = fs.rmSync;
  let backupDescriptor: number | undefined;
  let backupPath: string | undefined;
  let backupDeleted = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const descriptor = originalOpen(target, flags, mode);
    if (String(target).includes(".backup-")) {
      backupDescriptor = descriptor;
      backupPath = String(target);
    }
    return descriptor;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((descriptor: number) => {
    if (descriptor === backupDescriptor) throw new Error("fake Code backup fsync failure");
    if (backupDeleted) throw new Error("fake Code parent fsync failure");
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    const result = originalRm(target, options);
    if (String(target) === backupPath) backupDeleted = true;
    return result;
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const runner = new FakeRunner([]);
    const configured = await createClaudeCodeAdapter({
      runner,
      executable: "/opt/claude",
      userConfigPath: path,
    }).configure(registration, true);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /back up Claude Code user config/i);
    assert.doesNotMatch(configured.detail ?? "", /manual recovery|\.backup-/i);
    assert.ok(backupPath);
    assert.equal(fs.existsSync(backupPath), false);
    assert.deepEqual(runner.calls, []);
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("replacement remove refusal stops before add and preserves config", async (t) => {
  const cases = [
    { name: "enterprise policy", response: result(1, "", "enterprise policy: remove-secret"), status: "blocked-by-policy" },
    { name: "ordinary error", response: result(1, "", "ordinary remove-secret"), status: "failed" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const original = { mcpServers: { rocky: rockyEntry("/old/node") } };
      const path = userConfig(t, original);
      const originalBytes = readFileSync(path);
      const runner = new FakeRunner([entry.response]);
      const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

      const configured = await adapter.configure(registration, true);

      assert.equal(configured.status, entry.status);
      assert.match(configured.detail ?? "", /backup/i);
      assert.doesNotMatch(configured.detail ?? "", /remove-secret/);
      assert.deepEqual(readFileSync(path), originalBytes);
      assert.equal(backupNames(path).length, 1);
      assert.deepEqual(runner.calls, [claudeCall(removeArgs)]);
    });
  }
});

test("linked Claude Code configs block replacement and removal before any CLI mutation", async (t) => {
  const cases = ["symlink", "hard-link"] as const;
  const operations = ["replace", "remove"] as const;

  for (const topology of cases) {
    for (const operation of operations) {
      await t.test(`${topology} ${operation}`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "rocky-claude-topology-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const target = join(directory, "target.json");
        const path = join(directory, ".claude.json");
        const bytes = `${JSON.stringify({
          secret: "topology-secret",
          mcpServers: { rocky: rockyEntry("/old/node") },
        })}\n`;
        writeFileSync(target, bytes, { mode: 0o640 });
        if (topology === "symlink") symlinkSync(target, path);
        else linkSync(target, path);
        const beforePath = lstatSync(path);
        const beforeTarget = lstatSync(target);
        const runner = new FakeRunner([]);
        const adapter = createClaudeCodeAdapter({
          runner,
          executable: "/opt/claude",
          userConfigPath: path,
        });

        const outcome = operation === "replace"
          ? await adapter.configure(registration, true)
          : await adapter.remove(registration);

        assert.equal(outcome.status, "failed");
        assert.match(outcome.detail ?? "", /topology|regular file|manual/i);
        assert.doesNotMatch(outcome.detail ?? "", /topology-secret|old\/node/);
        assert.deepEqual(outcome.manualRegistration, registration);
        assert.deepEqual(runner.calls, []);
        const afterPath = lstatSync(path);
        const afterTarget = lstatSync(target);
        assert.equal(afterPath.dev, beforePath.dev);
        assert.equal(afterPath.ino, beforePath.ino);
        assert.equal(afterPath.isSymbolicLink(), beforePath.isSymbolicLink());
        assert.equal(afterTarget.dev, beforeTarget.dev);
        assert.equal(afterTarget.ino, beforeTarget.ino);
        assert.equal(readFileSync(target, "utf8"), bytes);
      });
    }
  }
});

test("failed add restores exact rocky snapshot into current unrelated config", async (t) => {
  const snapshot = {
    ...rockyEntry("/old/node"),
    disabled: true,
    cwd: "/private/project",
    metadata: { nested: [1, "two", { secret: "snapshot-secret" }] },
  };
  const path = userConfig(t, {
    theme: "before",
    mcpServers: { other: { version: 1 }, rocky: snapshot },
  });
  const afterRemove = {
    theme: "changed-concurrently",
    newTopLevel: { keep: true },
    mcpServers: { other: { version: 2 }, concurrent: { url: "https://new" } },
  };
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(afterRemove, null, 2)}\n`, { mode: 0o640 });
      return result(0);
    },
    result(1, "", "add denied"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /restored/i);
  assert.doesNotMatch(configured.detail ?? "", /snapshot-secret|private\/project/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...afterRemove,
    mcpServers: { ...afterRemove.mcpServers, rocky: snapshot },
  });
  assert.deepEqual(runner.calls, [claudeCall(removeArgs), claudeCall(addArgs)]);
});

test("enterprise refusal during replacement add restores snapshot and reports policy block", async (t) => {
  const snapshot = { ...rockyEntry("/old/node"), metadata: { token: "snapshot-secret" } };
  const path = userConfig(t, { theme: "keep", mcpServers: { rocky: snapshot } });
  const afterRemove = { theme: "changed", mcpServers: { other: { keep: true } } };
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(afterRemove, null, 2)}\n`, { mode: 0o640 });
      return result(0);
    },
    result(1, "", "enterprise MCP policy: add-secret"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "blocked-by-policy");
  assert.match(configured.detail ?? "", /restored|backup/i);
  assert.doesNotMatch(configured.detail ?? "", /snapshot-secret|add-secret/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...afterRemove,
    mcpServers: { ...afterRemove.mcpServers, rocky: snapshot },
  });
  assert.deepEqual(runner.calls, [claudeCall(removeArgs), claudeCall(addArgs)]);
});

test("rollback restores the exact snapshot when the current config disappeared", async (t) => {
  const snapshot = { ...rockyEntry("/old/node"), metadata: { exact: [1, 2, 3] } };
  const path = userConfig(t, { unrelated: "lost-with-file", mcpServers: { rocky: snapshot } });
  const runner = new FakeRunner([
    () => {
      rmSync(path);
      return result(0);
    },
    result(1, "", "ordinary add failure"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /restored/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { rocky: snapshot } });
});

test("rollback refuses unreadable or non-object current config without overwriting it", async (t) => {
  const cases = [
    { name: "malformed JSON", bytes: '{"token":"malformed-secret"' },
    { name: "non-object root", bytes: '["array-secret"]\n' },
    { name: "non-object mcpServers", bytes: '{"theme":"keep","mcpServers":["server-secret"]}\n' },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/old/node") } });
      const runner = new FakeRunner([
        () => {
          writeFileSync(path, entry.bytes, "utf8");
          return result(0);
        },
        result(1, "", "ordinary add failure"),
      ]);
      const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

      const configured = await adapter.configure(registration, true);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /backup|manual|cannot be read/i);
      assert.doesNotMatch(configured.detail ?? "", /malformed-secret|array-secret|server-secret/);
      assert.equal(readFileSync(path, "utf8"), entry.bytes);
    });
  }
});

test("rollback refuses a config topology swap after CLI remove", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/old/node") } });
  const target = join(dirname(path), "concurrent-target.json");
  const targetBytes = '{"theme":"concurrent","secret":"topology-swap-secret","mcpServers":{}}\n';
  writeFileSync(target, targetBytes, "utf8");
  const runner = new FakeRunner([
    () => {
      rmSync(path);
      symlinkSync(target, path);
      return result(0);
    },
    result(1, "", "add-secret"),
  ]);

  const configured = await createClaudeCodeAdapter({
    runner,
    executable: "/opt/claude",
    userConfigPath: path,
  }).configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /topology|manual recovery/i);
  assert.doesNotMatch(configured.detail ?? "", /topology-swap-secret|add-secret|old\/node/);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), targetBytes);
});

test("rollback rename failure cleans its temp and reports manual recovery", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/old/node") } });
  const current = { theme: "keep", mcpServers: { other: { keep: true } } };
  const directory = dirname(path);
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o640 });
      return result(0);
    },
    result(1, "", "ordinary add failure"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    if (String(newPath) === path) throw new Error("injected rollback rename failure");
    originalRenameSync(oldPath, newPath);
  };
  syncBuiltinESMExports();

  try {
    const configured = await adapter.configure(registration, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), current);
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
  }
  assert.equal(readdirSync(directory).some((name) => name.includes(".tmp-")), false);
});

test("rollback reports restored but durability-unconfirmed after post-rename parent fsync failure", async (t) => {
  const snapshot = { ...rockyEntry("/old/node"), token: "rollback-secret" };
  const path = userConfig(t, { mcpServers: { rocky: snapshot } });
  const current = { theme: "keep", mcpServers: { other: { keep: true } } };
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(current)}\n`, { mode: 0o640 });
      return result(0);
    },
    result(1, "", "add-secret"),
  ]);
  const originalRename = fs.renameSync;
  const originalFsync = fs.fsyncSync;
  let published = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to);
    if (String(to) === path) published = true;
  }) as typeof fs.renameSync;
  fs.fsyncSync = ((descriptor: number) => {
    if (published) throw new Error("fake rollback parent fsync secret");
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeCodeAdapter({
      runner,
      executable: "/opt/claude",
      userConfigPath: path,
    }).configure(registration, true);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /restored/i);
    assert.match(configured.detail ?? "", /durability/i);
    assert.match(configured.detail ?? "", /backup/i);
    assert.doesNotMatch(configured.detail ?? "", /manual recovery|rollback-secret|add-secret|fsync secret/i);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      ...current,
      mcpServers: { ...current.mcpServers, rocky: snapshot },
    });
  } finally {
    fs.renameSync = originalRename;
    fs.fsyncSync = originalFsync;
    syncBuiltinESMExports();
  }
});

test("failed add never overwrites a concurrent rocky entry and reports backup", async (t) => {
  const original = { mcpServers: { rocky: { ...rockyEntry("/old/node"), token: "old-secret" } } };
  const path = userConfig(t, original);
  const concurrent = {
    theme: "keep",
    mcpServers: { rocky: { ...rockyEntry("/concurrent/node"), token: "concurrent-secret" } },
  };
  const runner = new FakeRunner([
    () => result(0),
    () => {
      writeFileSync(path, `${JSON.stringify(concurrent, null, 2)}\n`, { mode: 0o640 });
      return result(1, "", "enterprise details: concurrent-secret");
    },
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /backup/i);
  assert.doesNotMatch(configured.detail ?? "", /old-secret|concurrent-secret/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), concurrent);
  assert.equal(readdirSync(join(path, "..")).filter((name) => name.startsWith(".claude.json.backup-")).length, 1);
});

test("malformed user config is unreadable and never sent to diagnostics or CLI", async (t) => {
  const path = userConfig(t);
  writeFileSync(path, '{"mcpServers":{"rocky":{"token":"fake-secret-token"}', "utf8");
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const inspection = await adapter.inspect(registration);
  const configured = await adapter.configure(registration, true);

  assert.equal(inspection.state, "unreadable");
  assert.equal(configured.status, "failed");
  assert.doesNotMatch(`${inspection.detail ?? ""}${configured.detail ?? ""}`, /fake-secret-token/);
  assert.deepEqual(runner.calls, []);
});

test("enterprise refusal is reported as policy block without exposing CLI output", async (t) => {
  const path = userConfig(t, { mcpServers: {} });
  const runner = new FakeRunner([result(1, "", "Managed by enterprise policy: fake-secret-token")]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "blocked-by-policy");
  assert.doesNotMatch(configured.detail ?? "", /fake-secret-token/);
  assert.deepEqual(configured.manualRegistration, registration);
  assert.deepEqual(runner.calls, [claudeCall(addArgs)]);
});

test("remove calls official user-scope command only for an owned identity", async (t) => {
  const ownedPath = userConfig(t, { mcpServers: { rocky: rockyEntry() } });
  const ownedRunner = new FakeRunner([result(0)]);
  const owned = createClaudeCodeAdapter({
    runner: ownedRunner,
    executable: "/opt/claude",
    userConfigPath: ownedPath,
  });
  assert.equal((await owned.remove(registration)).status, "removed");
  assert.deepEqual(ownedRunner.calls, [claudeCall(removeArgs)]);

  const foreignPath = userConfig(t, { mcpServers: { rocky: rockyEntry("/usr/bin/foreign") } });
  const foreignRunner = new FakeRunner([]);
  const foreign = createClaudeCodeAdapter({
    runner: foreignRunner,
    executable: "/opt/claude",
    userConfigPath: foreignPath,
  });
  assert.equal((await foreign.remove(registration)).status, "failed");
  assert.deepEqual(foreignRunner.calls, []);
});

test("owned removal distinguishes policy refusal from ordinary failure without exposing output", async (t) => {
  const cases = [
    { name: "enterprise policy", response: result(1, "", "managed policy: removal-secret"), status: "blocked-by-policy" },
    { name: "ordinary error", response: result(1, "", "ordinary removal-secret"), status: "failed" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const path = userConfig(t, { mcpServers: { rocky: rockyEntry() } });
      const runner = new FakeRunner([entry.response]);
      const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

      const removed = await adapter.remove(registration);

      assert.equal(removed.status, entry.status);
      assert.doesNotMatch(removed.detail ?? "", /removal-secret/);
      assert.deepEqual(runner.calls, [claudeCall(removeArgs)]);
    });
  }
});
