import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createClaudeDesktopAdapter,
  resolveDesktopConfigPath,
} from "../setup/claude-desktop.js";
import { createPlatformServices } from "../setup/platform.js";

const registration = {
  name: "rocky" as const,
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
};

function storedRegistration(command = registration.command): Record<string, unknown> {
  return {
    type: "stdio",
    command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function configPath(t: test.TestContext, value?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-claude-desktop-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "claude_desktop_config.json");
  if (value !== undefined) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
    chmodSync(path, 0o640);
  }
  return path;
}

function backupPaths(path: string): string[] {
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(`${basename(path)}.backup-`))
    .map((name) => join(dirname(path), name));
}

function crashTransaction(
  path: string,
  suffix: string,
  state: "prepared" | "displaced" | "published" | "committed",
  displacedBytes: Buffer,
): string {
  const transaction = join(dirname(path), `.${basename(path)}.transaction-${suffix}`);
  mkdirSync(transaction, { mode: 0o700 });
  writeFileSync(join(transaction, "displaced"), displacedBytes, { mode: 0o640 });
  writeFileSync(join(transaction, "prepared"), "{\"mcpServers\":{}}\n", { mode: 0o600 });
  writeFileSync(join(transaction, "manifest.json"), `${JSON.stringify({
    version: 1,
    state,
    target: path,
  })}\n`, { mode: 0o600 });
  return transaction;
}

test("native Claude Desktop config paths are exact and unsupported hosts stay unresolved", () => {
  const mac = createPlatformServices({
    platform: "darwin",
    home: "/Users/Ada",
    env: { PATH: "/usr/bin" },
    isWsl: false,
  });
  const macWithRelativeHome = createPlatformServices({
    platform: "darwin",
    home: "Users/Ada",
    env: { PATH: "/usr/bin" },
    isWsl: false,
  });
  const windows = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    appData: "C:\\Users\\Ada\\AppData\\Roaming",
    env: { PATH: "C:\\Windows\\System32" },
    isWsl: false,
  });
  const windowsWithoutAppData = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    env: {},
    isWsl: false,
  });
  const windowsWithRelativeAppData = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    appData: "AppData\\Roaming",
    env: {},
    isWsl: false,
  });
  const linux = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "/usr/bin" },
    isWsl: false,
  });

  assert.equal(
    resolveDesktopConfigPath(mac),
    "/Users/Ada/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(
    resolveDesktopConfigPath(windows),
    "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  assert.equal(resolveDesktopConfigPath(macWithRelativeHome), undefined);
  assert.equal(resolveDesktopConfigPath(windowsWithoutAppData), undefined);
  assert.equal(resolveDesktopConfigPath(windowsWithRelativeAppData), undefined);
  assert.equal(resolveDesktopConfigPath(linux), undefined);
});

test("configure merges only mcpServers.rocky and backs up exact existing bytes", async (t) => {
  const original = {
    theme: "dark",
    secret: "fake-top-level-secret",
    mcpServers: {
      other: { command: "/opt/other", env: { TOKEN: "fake-other-secret" } },
    },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "configured");
  assert.match(configured.detail ?? "", /backup/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...original,
    mcpServers: { ...original.mcpServers, rocky: storedRegistration() },
  });
  const backups = backupPaths(path);
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(backups[0]!), originalBytes);
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("configure creates a private missing config without inventing unrelated keys or backup", async (t) => {
  const path = configPath(t);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, { client: "claude-desktop", status: "configured" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    mcpServers: { rocky: storedRegistration() },
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(backupPaths(path), []);
});

test("native parent preparation runs only for a permitted configure mutation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "missing-parent", "claude_desktop_config.json");
  let prepareCalls = 0;
  const permittedDependencies = {
    configPath: path,
    prepareConfigParent() {
      prepareCalls += 1;
      mkdirSync(dirname(path));
      return true;
    },
  };

  const configured = await createClaudeDesktopAdapter(permittedDependencies)
    .configure(registration, false);

  assert.equal(configured.status, "configured");
  assert.equal(prepareCalls, 1);
  assert.equal(fs.existsSync(path), true);

  const missingPath = join(root, "readonly-parent", "claude_desktop_config.json");
  const forbiddenDependencies = {
    configPath: missingPath,
    prepareConfigParent() {
      prepareCalls += 1;
      throw new Error("must not prepare");
    },
  };
  const readonly = createClaudeDesktopAdapter(forbiddenDependencies);
  assert.equal((await readonly.inspect(registration)).state, "absent");
  assert.equal((await readonly.check(registration)).status, "not-configured");
  assert.equal((await readonly.remove(registration)).status, "not-configured");
  const policyDependencies = { ...forbiddenDependencies, policyBlocked: true };
  const policy = createClaudeDesktopAdapter(policyDependencies);
  assert.equal((await policy.configure(registration, false)).status, "blocked-by-policy");

  const identicalPath = configPath(t, { mcpServers: { rocky: storedRegistration() } });
  const identicalDependencies = {
    configPath: identicalPath,
    prepareConfigParent: forbiddenDependencies.prepareConfigParent,
  };
  const identical = createClaudeDesktopAdapter(identicalDependencies);
  assert.equal((await identical.configure(registration, false)).status, "already-configured");
  assert.equal((await identical.check(registration)).status, "healthy");

  const conflictPath = configPath(t, { mcpServers: { rocky: storedRegistration("/foreign/node") } });
  const conflictDependencies = {
    configPath: conflictPath,
    prepareConfigParent: forbiddenDependencies.prepareConfigParent,
  };
  const conflict = createClaudeDesktopAdapter(conflictDependencies);
  assert.equal((await conflict.configure(registration, false)).status, "requires-confirmation");

  const ownedPath = configPath(t, { mcpServers: { rocky: storedRegistration() } });
  const ownedDependencies = {
    configPath: ownedPath,
    prepareConfigParent: forbiddenDependencies.prepareConfigParent,
  };
  assert.equal((await createClaudeDesktopAdapter(ownedDependencies).remove(registration)).status, "removed");
  assert.equal(prepareCalls, 1);
  assert.equal(fs.existsSync(dirname(missingPath)), false);
});

test("identical registration is an inspectable no-op and healthy", async (t) => {
  const original = { theme: "dark", mcpServers: { rocky: storedRegistration() } };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  assert.deepEqual(await adapter.inspect(registration), {
    state: "identical",
    snapshot: storedRegistration(),
  });
  assert.deepEqual(await adapter.configure(registration, false), {
    client: "claude-desktop",
    status: "already-configured",
  });
  assert.deepEqual(await adapter.check(registration), {
    client: "claude-desktop",
    status: "healthy",
    healthRegistration: registration,
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);
});

test("foreign rocky entry requires explicit replacement and remains byte-identical on refusal", async (t) => {
  const original = {
    theme: "dark",
    mcpServers: { rocky: { command: "/usr/bin/foreign", token: "fake-secret" } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const refused = await adapter.configure(registration, false);

  assert.deepEqual(refused, {
    client: "claude-desktop",
    status: "requires-confirmation",
    detail: "Claude Desktop already has a different rocky registration",
    manualRegistration: registration,
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);

  const replaced = await adapter.configure(registration, true);
  assert.equal(replaced.status, "configured");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    theme: "dark",
    mcpServers: { rocky: storedRegistration() },
  });
  assert.equal(backupPaths(path).length, 1);
});

test("malformed JSON and non-object mcpServers refuse every mutation without leaking secrets", async (t) => {
  const cases = [
    { name: "malformed JSON", bytes: '{"secret":"fake-malformed-secret",' },
    { name: "array mcpServers", bytes: '{"mcpServers":["fake-array-secret"]}\n' },
    { name: "scalar mcpServers", bytes: '{"mcpServers":"fake-scalar-secret"}\n' },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const path = configPath(st);
      writeFileSync(path, entry.bytes, "utf8");
      const originalBytes = readFileSync(path);
      const adapter = createClaudeDesktopAdapter({ configPath: path });

      for (const result of [
        await adapter.configure(registration, true),
        await adapter.remove(registration),
        await adapter.check(registration),
      ]) {
        assert.equal(result.status, "failed");
        assert.match(result.detail ?? "", /read Claude Desktop config/i);
        assert.doesNotMatch(result.detail ?? "", /fake-malformed|fake-array|fake-scalar/);
      }
      assert.deepEqual(readFileSync(path), originalBytes);
      assert.deepEqual(backupPaths(path), []);
    });
  }
});

test("remove deletes only a recognized Rocky identity and preserves unrelated config", async (t) => {
  const recognized = {
    ...storedRegistration(),
    env: {
      ROCKY_MCP_EXPOSURE: "raw",
      ROCKY_HOME: "/home/ada/state/../.rocky",
      FUTURE_FIELD: "preserved-until-removal",
    },
    futureMetadata: { secret: "fake-metadata-secret" },
  };
  const original = {
    theme: "dark",
    mcpServers: {
      other: { token: "fake-other-secret" },
      rocky: recognized,
    },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const removed = await adapter.remove(registration);

  assert.equal(removed.status, "removed");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    theme: "dark",
    mcpServers: { other: { token: "fake-other-secret" } },
  });
  const backups = backupPaths(path);
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(backups[0]!), originalBytes);
});

test("remove refuses an entry merely named rocky and leaves exact bytes untouched", async (t) => {
  const original = {
    mcpServers: {
      rocky: {
        type: "stdio",
        command: "/usr/bin/foreign",
        args: [...registration.args],
        env: { ...registration.env, TOKEN: "fake-secret" },
      },
    },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const removed = await adapter.remove(registration);

  assert.deepEqual(removed, {
    client: "claude-desktop",
    status: "failed",
    detail: "Claude Desktop rocky registration is not owned by Rocky",
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);
});

test("missing config path produces manual configuration instead of guessing", async () => {
  const adapter = createClaudeDesktopAdapter({});

  assert.deepEqual(await adapter.inspect(registration), {
    state: "blocked",
    detail: "Claude Desktop config path is unresolved; use manual configuration",
  });
  for (const result of [
    await adapter.configure(registration, false),
    await adapter.remove(registration),
    await adapter.check(registration),
  ]) {
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /manual configuration/i);
    assert.deepEqual(result.manualRegistration, registration);
  }
});

test("relative config path is unresolved instead of being interpreted against process cwd", async () => {
  const adapter = createClaudeDesktopAdapter({ configPath: "relative/claude_desktop_config.json" });

  assert.deepEqual(await adapter.inspect(registration), {
    state: "blocked",
    detail: "Claude Desktop config path is unresolved; use manual configuration",
  });
});

test("failed registration transform stays secret-free and does not offer unusable Linux argv", async (t) => {
  const path = configPath(t);
  const adapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration() {
      throw new Error("fake-transform-secret");
    },
  });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual configuration/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-transform-secret/);
  assert.equal(configured.manualRegistration, undefined);
  assert.equal(readdirSync(dirname(path)).length, 0);
});

test("managed policy blocks a required mutation but permits read-only identical checks", async (t) => {
  const path = configPath(t, { theme: "dark" });
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path, policyBlocked: true });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, {
    client: "claude-desktop",
    status: "blocked-by-policy",
    detail: "Claude Desktop policy blocks config mutation",
    manualRegistration: registration,
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);

  const identicalPath = configPath(t, { mcpServers: { rocky: storedRegistration() } });
  const identical = createClaudeDesktopAdapter({ configPath: identicalPath, policyBlocked: true });
  assert.equal((await identical.configure(registration, false)).status, "already-configured");
  assert.equal((await identical.check(registration)).status, "healthy");
});

test("plain Desktop check returns exact owned raw registration for local protocol health", async (t) => {
  const storedRaw = {
    ...registration,
    env: { ...registration.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  const path = configPath(t, { mcpServers: { rocky: {
    type: "stdio",
    command: storedRaw.command,
    args: [...storedRaw.args],
    env: { ...storedRaw.env },
  } } });
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  assert.deepEqual(await adapter.check(registration), {
    client: "claude-desktop",
    status: "healthy",
    healthRegistration: storedRaw,
  });
});

test("atomic write failure preserves current config, keeps backup, and cleans temporary sibling", async (t) => {
  const original = { secret: "fake-write-secret", mcpServers: { other: { enabled: true } } };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path) throw Object.assign(new Error("injected rename failure"), { code: "EACCES" });
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (String(newPath) === path
      && (String(existingPath).includes(".tmp-") || basename(String(existingPath)) === "prepared")) {
      throw Object.assign(new Error("injected link failure"), { code: "EACCES" });
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /write Claude Desktop config|manual recovery/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-write-secret|injected rename/);
    assert.deepEqual(configured.manualRegistration, registration);
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.equal(backupPaths(path).length, 1);
    assert.equal(readdirSync(dirname(path)).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("prepared write failure closes descriptor before Windows-like cleanup", async (t) => {
  const path = configPath(t, { theme: "dark" });
  const originalBytes = readFileSync(path);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalWrite = fs.writeFileSync;
  const originalRm = fs.rmSync;
  let preparedDescriptor: number | undefined;
  let preparedOpen = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const descriptor = originalOpen(target, flags, mode);
    if (basename(String(target)) === "prepared") {
      preparedDescriptor = descriptor;
      preparedOpen = true;
    }
    return descriptor;
  }) as typeof fs.openSync;
  fs.closeSync = ((descriptor: number) => {
    const result = originalClose(descriptor);
    if (descriptor === preparedDescriptor) preparedOpen = false;
    return result;
  }) as typeof fs.closeSync;
  fs.writeFileSync = ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (target === preparedDescriptor) throw new Error("fake prepared write secret");
    return originalWrite(target, data, options);
  }) as typeof fs.writeFileSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes(".transaction-") && options?.recursive && preparedOpen) {
      throw Object.assign(new Error("Windows busy"), { code: "EBUSY" });
    }
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /write Claude Desktop config/i);
    assert.doesNotMatch(configured.detail ?? "", /fake prepared write secret|Windows busy/i);
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.equal(readdirSync(dirname(path)).some((name) => name.includes(".transaction-")), false);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.writeFileSync = originalWrite;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("failed backup cleanup reports its opaque secret-bearing artifact path", async (t) => {
  const original = { secret: "fake-backup-artifact-secret", theme: "dark" };
  const path = configPath(t, original);
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
    if (descriptor === backupDescriptor) throw new Error("fake backup fsync secret");
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target) === backupPath) throw Object.assign(new Error("fake backup rm secret"), { code: "EACCES" });
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.ok(backupPath);
    assert.match(configured.detail ?? "", new RegExp(backupPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", /fake-backup-artifact-secret|fake backup fsync|fake backup rm/i);
    assert.deepEqual(readFileSync(backupPath), originalBytes);
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("backup parent-sync failure does not report a deleted Desktop recovery path", async (t) => {
  const path = configPath(t, { theme: "dark" });
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
    if (descriptor === backupDescriptor) throw new Error("fake Desktop backup fsync failure");
    if (backupDeleted) throw new Error("fake Desktop parent fsync failure");
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    const result = originalRm(target, options);
    if (String(target) === backupPath) backupDeleted = true;
    return result;
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /back up Claude Desktop config/i);
    assert.doesNotMatch(configured.detail ?? "", /manual recovery|\.backup-/i);
    assert.ok(backupPath);
    assert.equal(fs.existsSync(backupPath), false);
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("concurrent unrelated config change after backup is preserved instead of overwritten", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { enabled: true } } };
  const concurrent = {
    theme: "light",
    secret: "fake-concurrent-secret",
    mcpServers: { other: { enabled: false }, concurrent: { command: "/opt/new" } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const concurrentBytes = Buffer.from(`${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
  const originalOpen = fs.openSync;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const descriptor = originalOpen(target, flags, mode);
    if (String(target).startsWith(`${path}.backup-`)) writeFileSync(path, concurrentBytes);
    return descriptor;
  }) as typeof fs.openSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /changed|retry|manual/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-concurrent-secret/);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    const backups = backupPaths(path);
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(backups[0]!), originalBytes);
    assert.equal(readdirSync(dirname(path)).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
});

test("configure preserves an unrelated update injected immediately before replacement", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { enabled: true } } };
  const concurrent = {
    theme: "light",
    secret: "fake-late-configure-secret",
    mcpServers: { other: { enabled: false }, concurrent: { command: "/opt/new" } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const concurrentBytes = Buffer.from(`${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && (String(source) === path || String(destination) === path)) {
      injected = true;
      writeFileSync(path, concurrentBytes);
      chmodSync(path, 0o600);
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /changed|recovery|manual|retry/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-late-configure-secret/);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const backups = backupPaths(path);
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(backups[0]!), originalBytes);
    assert.match(configured.detail ?? "", /live recovery/i);
    assert.equal(
      readdirSync(dirname(path)).some((name) => name.includes(".transaction-")),
      true,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("remove preserves an unrelated update injected immediately before replacement", async (t) => {
  const original = {
    theme: "dark",
    mcpServers: { other: { enabled: true }, rocky: storedRegistration() },
  };
  const concurrent = {
    theme: "light",
    secret: "fake-late-remove-secret",
    mcpServers: { other: { enabled: false }, rocky: storedRegistration() },
  };
  const path = configPath(t, original);
  const concurrentBytes = Buffer.from(`${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && (String(source) === path || String(destination) === path)) {
      injected = true;
      writeFileSync(path, concurrentBytes);
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const removed = await adapter.remove(registration);

    assert.equal(injected, true);
    assert.equal(removed.status, "failed");
    assert.match(removed.detail ?? "", /changed|recovery|manual|retry/i);
    assert.doesNotMatch(removed.detail ?? "", /fake-late-remove-secret/);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    assert.equal(backupPaths(path).length, 1);
    assert.match(removed.detail ?? "", /live recovery/i);
    assert.equal(
      readdirSync(dirname(path)).some((name) => name.includes(".transaction-")),
      true,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("missing-config configure preserves a file created immediately before installation", async (t) => {
  const path = configPath(t);
  const concurrent = { theme: "light", secret: "fake-late-create-secret" };
  const concurrentBytes = Buffer.from(`${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let injected = false;
  const inject = () => {
    if (injected) return;
    injected = true;
    writeFileSync(path, concurrentBytes, { mode: 0o640 });
    chmodSync(path, 0o640);
  };
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path) inject();
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (String(newPath) === path) inject();
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /changed|recovery|manual|retry/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-late-create-secret/);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(backupPaths(path), []);
    assert.deepEqual(readdirSync(dirname(path)), [basename(path)]);
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("destination deletion before displacement cleans the prepared transaction", async (t) => {
  const path = configPath(t, { theme: "dark", mcpServers: { other: {} } });
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && String(source) === path && basename(String(destination)) === "displaced") {
      injected = true;
      fs.unlinkSync(path);
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /changed|retry/i);
    assert.equal(fs.existsSync(path), false);
    assert.equal(
      readdirSync(dirname(path)).some((name) => name.includes(".transaction-")),
      false,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("destination deletion reports an existing transaction when cleanup fails", async (t) => {
  const path = configPath(t, { theme: "dark", mcpServers: { other: {} } });
  const originalRename = fs.renameSync;
  const originalRm = fs.rmSync;
  let injected = false;
  let retainedTransaction: string | undefined;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && String(source) === path && basename(String(destination)) === "displaced") {
      injected = true;
      fs.unlinkSync(path);
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes(".transaction-") && options?.recursive === true) {
      retainedTransaction = String(target);
      throw Object.assign(new Error("fake transaction cleanup secret"), { code: "EACCES" });
    }
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.doesNotMatch(configured.detail ?? "", /fake transaction cleanup secret/i);
    assert.ok(retainedTransaction);
    assert.equal(fs.existsSync(retainedTransaction), true);
    assert.match(
      configured.detail ?? "",
      new RegExp(retainedTransaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(fs.existsSync(path), false);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("pre-publication cleanup never reports a target and transaction that were both removed", async (t) => {
  const path = configPath(t);
  const originalLink = fs.linkSync;
  const originalRm = fs.rmSync;
  let removedTransaction: string | undefined;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (basename(String(existingPath)) === "prepared" && String(newPath) === path) {
      throw Object.assign(new Error("fake pre-publication link secret"), { code: "EACCES" });
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes(".transaction-") && options?.recursive === true) {
      removedTransaction = String(target);
      originalRm(target, options);
      throw new Error("fake post-delete sync secret");
    }
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual verification|write Claude Desktop config/i);
    assert.doesNotMatch(configured.detail ?? "", /manual recovery|fake pre-publication|fake post-delete/i);
    assert.equal(fs.existsSync(path), false);
    assert.ok(removedTransaction);
    assert.equal(fs.existsSync(removedTransaction), false);
    assert.doesNotMatch(configured.detail ?? "", new RegExp(removedTransaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("failed in-process restore reports the surviving transaction instead of missing displaced file", async (t) => {
  const path = configPath(t, { theme: "dark", mcpServers: { other: {} } });
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let transaction: string | undefined;
  let displacedPath: string | undefined;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (String(source) === path && basename(String(destination)) === "displaced") {
      writeFileSync(path, '{"theme":"concurrent"}\n', "utf8");
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (basename(String(existingPath)) === "displaced" && String(newPath) === path) {
      displacedPath = String(existingPath);
      transaction = dirname(displacedPath);
      fs.unlinkSync(displacedPath);
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.ok(transaction);
    assert.ok(displacedPath);
    assert.equal(fs.existsSync(transaction), true);
    assert.equal(fs.existsSync(displacedPath), false);
    assert.match(configured.detail ?? "", new RegExp(transaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", new RegExp(displacedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("unsupported hard links abort before displacing an existing config", async (t) => {
  const original = {
    theme: "dark",
    secret: "fake-hard-link-secret",
    mcpServers: { other: { enabled: true } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const originalLink = fs.linkSync;
  fs.linkSync = (() => {
    throw Object.assign(new Error("hard links unsupported: fake-hard-link-secret"), { code: "EPERM" });
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /write Claude Desktop config/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-hard-link-secret|hard links unsupported/);
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(backupPaths(path).length, 1);
    assert.equal(
      readdirSync(dirname(path)).some((name) => name.includes(".transaction-")),
      false,
    );
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("a symlink swapped in at displacement is restored instead of overwritten", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { enabled: true } } };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const concurrentTarget = join(dirname(path), "concurrent-config.json");
  writeFileSync(concurrentTarget, originalBytes, { mode: 0o640 });
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!injected && String(source) === path && basename(String(destination)) === "displaced") {
      injected = true;
      fs.unlinkSync(path);
      fs.symlinkSync(concurrentTarget, path);
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /changed|retry|manual recovery/i);
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path), concurrentTarget);
    assert.deepEqual(readFileSync(path), originalBytes);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("cleanup failure after missing-config publication reports only a live path", async (t) => {
  const path = configPath(t);
  const originalRm = fs.rmSync;
  let deletedTransaction: string | undefined;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes(".transaction-") && options?.recursive === true) {
      deletedTransaction = String(target);
      originalRm(target, options);
      throw new Error("fake cleanup durability secret");
    }
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.match(configured.detail ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", /fake cleanup durability secret|transaction-/i);
    assert.equal(deletedTransaction === undefined ? false : fs.existsSync(deletedTransaction), false);
    assert.equal((JSON.parse(readFileSync(path, "utf8")).mcpServers as Record<string, unknown>).rocky !== undefined, true);
  } finally {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
});

test("post-displacement creator wins while prior config remains at reported recovery path", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { enabled: true } } };
  const concurrent = { theme: "light", secret: "fake-post-displacement-secret" };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const concurrentBytes = Buffer.from(`${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!injected && basename(String(existingPath)) === "prepared" && String(newPath) === path) {
      injected = true;
      writeFileSync(path, concurrentBytes, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-post-displacement-secret/);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const transaction = readdirSync(dirname(path)).find((name) => name.includes(".transaction-"));
    assert.ok(transaction);
    const recoveryPath = join(dirname(path), transaction, "displaced");
    assert.match(configured.detail ?? "", new RegExp(recoveryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(readFileSync(recoveryPath), originalBytes);
    assert.equal(statSync(recoveryPath).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dirname(recoveryPath)).sort(), ["displaced", "manifest.json"]);
    assert.deepEqual(readFileSync(backupPaths(path)[0]!), originalBytes);
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("post-displacement winner reports transaction when displaced recovery disappears", async (t) => {
  const path = configPath(t, { theme: "dark", mcpServers: { other: {} } });
  const concurrentBytes = Buffer.from('{"theme":"winner"}\n', "utf8");
  const originalLink = fs.linkSync;
  let transaction: string | undefined;
  let displacedPath: string | undefined;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (basename(String(existingPath)) === "prepared" && String(newPath) === path) {
      transaction = dirname(String(existingPath));
      displacedPath = join(transaction, "displaced");
      fs.unlinkSync(displacedPath);
      writeFileSync(path, concurrentBytes, { mode: 0o600 });
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.ok(transaction);
    assert.ok(displacedPath);
    assert.equal(fs.existsSync(transaction), true);
    assert.equal(fs.existsSync(displacedPath), false);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    assert.match(configured.detail ?? "", new RegExp(transaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", new RegExp(displacedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("restore collision preserves current file and reports displaced concurrent recovery", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { version: 1 } } };
  const displacedConcurrent = {
    theme: "light",
    secret: "fake-displaced-secret",
    mcpServers: { other: { version: 2 } },
  };
  const currentConcurrent = {
    theme: "contrast",
    secret: "fake-current-secret",
    mcpServers: { other: { version: 3 } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const displacedBytes = Buffer.from(`${JSON.stringify(displacedConcurrent, null, 2)}\n`, "utf8");
  const currentBytes = Buffer.from(`${JSON.stringify(currentConcurrent, null, 2)}\n`, "utf8");
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let displacedInjected = false;
  let currentInjected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!displacedInjected && String(source) === path) {
      displacedInjected = true;
      writeFileSync(path, displacedBytes);
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!currentInjected && basename(String(existingPath)) === "displaced" && String(newPath) === path) {
      currentInjected = true;
      writeFileSync(path, currentBytes, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(displacedInjected, true);
    assert.equal(currentInjected, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-displaced-secret|fake-current-secret/);
    assert.deepEqual(readFileSync(path), currentBytes);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const transaction = readdirSync(dirname(path)).find((name) => name.includes(".transaction-"));
    assert.ok(transaction);
    const recoveryPath = join(dirname(path), transaction, "displaced");
    assert.deepEqual(readFileSync(recoveryPath), displacedBytes);
    assert.deepEqual(readFileSync(backupPaths(path)[0]!), originalBytes);
    assert.deepEqual(readdirSync(dirname(recoveryPath)).sort(), ["displaced", "manifest.json"]);
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("held descriptor late write survives in reported committed recovery", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { version: 1 } } };
  const late = {
    theme: "late",
    secret: "fake-held-descriptor-secret",
    mcpServers: { other: { version: 2 }, held: { keep: true } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const lateBytes = Buffer.from(`${JSON.stringify(late, null, 2)}\n`, "utf8");
  const held = openSync(path, "r+");
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!injected && basename(String(existingPath)) === "prepared" && String(newPath) === path) {
      injected = true;
      ftruncateSync(held, 0);
      writeFileSync(held, lateBytes);
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(injected, true);
    assert.equal(configured.status, "configured");
    assert.match(configured.detail ?? "", /live recovery/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-held-descriptor-secret/);
    assert.equal((JSON.parse(readFileSync(path, "utf8")).mcpServers as Record<string, unknown>).rocky !== undefined, true);
    const transaction = readdirSync(dirname(path)).find((name) => name.includes(".transaction-"));
    assert.ok(transaction);
    const recoveryPath = join(dirname(path), transaction, "displaced");
    assert.deepEqual(readFileSync(recoveryPath), lateBytes);
    assert.deepEqual(readFileSync(backupPaths(path)[0]!), originalBytes);
    assert.deepEqual(readdirSync(dirname(recoveryPath)).sort(), ["displaced", "manifest.json"]);
  } finally {
    closeSync(held);
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("publication fails closed when live recovery disappears during commit", async (t) => {
  const path = configPath(t, { theme: "dark", mcpServers: { other: {} } });
  const originalRename = fs.renameSync;
  let transaction: string | undefined;
  let displacedPath: string | undefined;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (basename(String(source)) === "manifest.tmp") {
      const manifest = JSON.parse(readFileSync(String(source), "utf8")) as { state?: string };
      if (manifest.state === "committed") {
        transaction = dirname(String(source));
        displacedPath = join(transaction, "displaced");
        fs.unlinkSync(displacedPath);
      }
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.ok(transaction);
    assert.ok(displacedPath);
    assert.equal(fs.existsSync(transaction), true);
    assert.equal(fs.existsSync(displacedPath), false);
    assert.match(configured.detail ?? "", new RegExp(transaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", new RegExp(displacedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(
      (JSON.parse(readFileSync(path, "utf8")).mcpServers as Record<string, unknown>).rocky !== undefined,
      true,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("displacement fsyncs destination directory before source directory", async (t) => {
  const path = configPath(t, { theme: "dark" });
  const parent = dirname(path);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const descriptors = new Map<number, string>();
  const order: string[] = [];
  let displaced = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const descriptor = originalOpen(target, flags, mode);
    descriptors.set(descriptor, String(target));
    return descriptor;
  }) as typeof fs.openSync;
  fs.closeSync = ((descriptor: number) => {
    descriptors.delete(descriptor);
    return originalClose(descriptor);
  }) as typeof fs.closeSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (String(source) === path && basename(String(destination)) === "displaced") displaced = true;
    return result;
  }) as typeof fs.renameSync;
  fs.fsyncSync = ((descriptor: number) => {
    const target = descriptors.get(descriptor);
    if (displaced && target !== undefined && fs.statSync(target).isDirectory()) {
      if (target === parent) order.push("source");
      else if (target.includes(".transaction-")) order.push("destination");
    }
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "configured");
    assert.deepEqual(order.slice(0, 2), ["destination", "source"]);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.fsyncSync = originalFsync;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("published transaction with absent target stays absent for manual recovery", async (t) => {
  const path = configPath(t);
  const displacedBytes = Buffer.from('{"secret":"fake-published-deletion-secret"}\n', "utf8");
  const transaction = crashTransaction(path, "published-absent", "published", displacedBytes);

  const configured = await createClaudeDesktopAdapter({ configPath: path })
    .configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual recovery/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-published-deletion-secret/);
  assert.equal(fs.existsSync(path), false);
  assert.deepEqual(readFileSync(join(transaction, "displaced")), displacedBytes);
  assert.equal(
    JSON.parse(readFileSync(join(transaction, "manifest.json"), "utf8")).state,
    "published",
  );
});

test("inspect and check report pending recovery without mutating disk", async (t) => {
  const path = configPath(t);
  const displacedBytes = Buffer.from('{"secret":"fake-readonly-journal-secret"}\n', "utf8");
  const transaction = crashTransaction(path, "readonly", "displaced", displacedBytes);
  const beforeNames = readdirSync(transaction).sort();
  const beforeManifest = readFileSync(join(transaction, "manifest.json"));
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const inspection = await adapter.inspect(registration);
  const checked = await adapter.check(registration);

  assert.equal(inspection.state, "unreadable");
  assert.match(inspection.detail ?? "", /recovery/i);
  assert.equal(checked.status, "failed");
  assert.match(checked.detail ?? "", /recovery/i);
  assert.doesNotMatch(`${inspection.detail}\n${checked.detail}`, /fake-readonly-journal-secret/);
  assert.equal(fs.existsSync(path), false);
  assert.deepEqual(readdirSync(transaction).sort(), beforeNames);
  assert.deepEqual(readFileSync(join(transaction, "manifest.json")), beforeManifest);
  assert.deepEqual(readFileSync(join(transaction, "displaced")), displacedBytes);
});

test("policy-blocked configure and remove leave pending recovery untouched", async (t) => {
  for (const operation of ["configure", "remove"] as const) {
    await t.test(operation, async (t) => {
      const path = configPath(t);
      const displacedBytes = Buffer.from(`${JSON.stringify({
        secret: `fake-policy-${operation}-secret`,
        mcpServers: { rocky: storedRegistration() },
      })}\n`, "utf8");
      const transaction = crashTransaction(path, `policy-${operation}`, "displaced", displacedBytes);
      const beforeNames = readdirSync(transaction).sort();
      const beforeManifest = readFileSync(join(transaction, "manifest.json"));
      const adapter = createClaudeDesktopAdapter({ configPath: path, policyBlocked: true });

      const result = operation === "configure"
        ? await adapter.configure(registration, false)
        : await adapter.remove(registration);

      assert.equal(result.status, "blocked-by-policy");
      assert.doesNotMatch(result.detail ?? "", new RegExp(`fake-policy-${operation}-secret`));
      assert.equal(fs.existsSync(path), false);
      assert.deepEqual(readdirSync(transaction).sort(), beforeNames);
      assert.deepEqual(readFileSync(join(transaction, "manifest.json")), beforeManifest);
      assert.deepEqual(readFileSync(join(transaction, "displaced")), displacedBytes);
    });
  }
});

test("next invocation restores an absent target from a displaced crash transaction and stops", async (t) => {
  const path = configPath(t);
  const original = { theme: "dark", secret: "fake-crash-secret", mcpServers: { other: {} } };
  const originalBytes = Buffer.from(`${JSON.stringify(original, null, 2)}\n`, "utf8");
  const transaction = join(dirname(path), `.${basename(path)}.transaction-crash`);
  mkdirSync(transaction, { mode: 0o700 });
  writeFileSync(join(transaction, "displaced"), originalBytes, { mode: 0o640 });
  writeFileSync(join(transaction, "manifest.json"), `${JSON.stringify({
    version: 1,
    state: "displaced",
    target: path,
  })}\n`, { mode: 0o600 });
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovered|retry/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-crash-secret/);
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.match(configured.detail ?? "", /live recovery/i);
  assert.deepEqual(readFileSync(join(transaction, "displaced")), originalBytes);
  assert.equal(
    JSON.parse(readFileSync(join(transaction, "manifest.json"), "utf8")).state,
    "committed",
  );
  assert.deepEqual(backupPaths(path), []);

  const retried = await adapter.configure(registration, false);
  assert.equal(retried.status, "configured");
  assert.equal(
    (JSON.parse(readFileSync(path, "utf8")).mcpServers as Record<string, unknown>).rocky !== undefined,
    true,
  );
});

test("restart recovery refuses a displaced symlink swapped in during publication", async (t) => {
  const path = configPath(t);
  const transaction = join(dirname(path), `.${basename(path)}.transaction-recovery-swap`);
  const foreign = join(dirname(path), "foreign.json");
  mkdirSync(transaction, { mode: 0o700 });
  writeFileSync(foreign, "{\"secret\":\"fake-recovery-swap-secret\"}\n", { mode: 0o600 });
  const displaced = join(transaction, "displaced");
  writeFileSync(displaced, "{\"theme\":\"dark\"}\n", { mode: 0o640 });
  writeFileSync(join(transaction, "manifest.json"), `${JSON.stringify({
    version: 1,
    state: "displaced",
    target: path,
  })}\n`, { mode: 0o600 });
  const originalLink = fs.linkSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (String(existingPath) === displaced && String(newPath) === path) {
      fs.unlinkSync(displaced);
      fs.symlinkSync(foreign, displaced);
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-recovery-swap-secret/);
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(displaced).isSymbolicLink(), true);
    assert.equal(
      JSON.parse(readFileSync(join(transaction, "manifest.json"), "utf8")).state,
      "displaced",
    );
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("failed restart restore reports surviving transaction instead of missing displaced file", async (t) => {
  const path = configPath(t);
  const displacedBytes = Buffer.from('{"theme":"dark"}\n', "utf8");
  const transaction = crashTransaction(path, "restart-missing-displaced", "displaced", displacedBytes);
  const displacedPath = join(transaction, "displaced");
  const originalLink = fs.linkSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (String(existingPath) === displacedPath && String(newPath) === path) {
      fs.unlinkSync(displacedPath);
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const configured = await createClaudeDesktopAdapter({ configPath: path })
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.equal(fs.existsSync(transaction), true);
    assert.equal(fs.existsSync(displacedPath), false);
    assert.match(configured.detail ?? "", new RegExp(transaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(configured.detail ?? "", new RegExp(displacedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("next invocation safely aborts a prepared transaction before inspecting config", async (t) => {
  const original = { theme: "dark", secret: "fake-prepared-secret" };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const transaction = join(dirname(path), `.${basename(path)}.transaction-prepared`);
  mkdirSync(transaction, { mode: 0o700 });
  writeFileSync(join(transaction, "prepared"), "{\"mcpServers\":{}}\n", { mode: 0o600 });
  writeFileSync(join(transaction, "manifest.json"), `${JSON.stringify({
    version: 1,
    state: "prepared",
    target: path,
  })}\n`, { mode: 0o600 });

  const configured = await createClaudeDesktopAdapter({ configPath: path })
    .configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovered|retry/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-prepared-secret/);
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.equal(fs.existsSync(transaction), false);
  assert.deepEqual(backupPaths(path), []);
});

test("next invocation recognizes a prepared crash with both names on the same inode", async (t) => {
  const original = { theme: "dark", secret: "fake-both-names-secret" };
  const path = configPath(t, original);
  const transaction = join(dirname(path), `.${basename(path)}.transaction-both`);
  mkdirSync(transaction, { mode: 0o700 });
  fs.linkSync(path, join(transaction, "displaced"));
  writeFileSync(join(transaction, "prepared"), "{\"mcpServers\":{}}\n", { mode: 0o600 });
  writeFileSync(join(transaction, "manifest.json"), `${JSON.stringify({
    version: 1,
    state: "prepared",
    target: path,
  })}\n`, { mode: 0o600 });

  const configured = await createClaudeDesktopAdapter({ configPath: path })
    .configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovered|live recovery|retry/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-both-names-secret/);
  assert.equal(
    JSON.parse(readFileSync(join(transaction, "manifest.json"), "utf8")).state,
    "committed",
  );
  assert.equal(fs.existsSync(join(transaction, "prepared")), false);
});

test("next invocation preserves ambiguous crash target and transaction for manual recovery", async (t) => {
  const current = { theme: "light", secret: "fake-ambiguous-current" };
  const displaced = { theme: "dark", secret: "fake-ambiguous-displaced" };
  const path = configPath(t, current);
  const currentBytes = readFileSync(path);
  const displacedBytes = Buffer.from(`${JSON.stringify(displaced, null, 2)}\n`, "utf8");
  const transaction = join(dirname(path), `.${basename(path)}.transaction-ambiguous`);
  mkdirSync(transaction, { mode: 0o700 });
  writeFileSync(join(transaction, "displaced"), displacedBytes, { mode: 0o640 });
  writeFileSync(join(transaction, "manifest.json"), `${JSON.stringify({
    version: 1,
    state: "published",
    target: path,
  })}\n`, { mode: 0o600 });
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual recovery/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-ambiguous-current|fake-ambiguous-displaced/);
  assert.deepEqual(readFileSync(path), currentBytes);
  assert.deepEqual(readFileSync(join(transaction, "displaced")), displacedBytes);
  assert.deepEqual(backupPaths(path), []);
});

test("registration transform is used for storage, inspection, and removal", async (t) => {
  const path = configPath(t);
  const bridged = {
    name: "rocky" as const,
    command: "C:\\Windows\\System32\\wsl.exe",
    args: [
      "-d", "Ubuntu", "--exec", "/usr/bin/env",
      "ROCKY_MCP_EXPOSURE=sanitized", "ROCKY_HOME=/home/ada/.rocky",
      "/usr/bin/node", "/opt/rocky/dist/index.js", "mcp",
    ],
    env: {},
  };
  const adapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration: () => bridged,
  });

  assert.equal((await adapter.configure(registration, false)).status, "configured");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    mcpServers: {
      rocky: { type: "stdio", command: bridged.command, args: bridged.args, env: {} },
    },
  });
  assert.equal((await adapter.inspect(registration)).state, "identical");
  assert.equal((await adapter.remove(registration)).status, "removed");
});

test("WSL removal recognizes the same bridge identity across safe exposure changes", async (t) => {
  const path = configPath(t);
  const bridge = (exposure: "sanitized" | "raw") => ({
    name: "rocky" as const,
    command: "C:\\Windows\\System32\\wsl.exe",
    args: [
      "-d", "Ubuntu-24.04", "--exec", "/usr/bin/env",
      `ROCKY_MCP_EXPOSURE=${exposure}`, "ROCKY_HOME=/home/ada/.rocky",
      "/usr/bin/node", "/opt/rocky/dist/index.js", "mcp",
    ],
    env: {},
  });
  const rawAdapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration: () => bridge("raw"),
  });
  assert.equal((await rawAdapter.configure(registration, false)).status, "configured");

  const defaultAdapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration: () => ({
      ...bridge("sanitized"),
      command: "c:\\WINDOWS\\system32\\WSL.EXE",
    }),
    mapHealthRegistration: (stored) => ({
      ...stored,
      command: "/mnt/c/Windows/System32/wsl.exe",
    }),
  });
  assert.deepEqual(await defaultAdapter.check(registration), {
    client: "claude-desktop",
    status: "healthy",
    healthRegistration: {
      ...bridge("raw"),
      command: "/mnt/c/Windows/System32/wsl.exe",
    },
  });
  assert.equal((await defaultAdapter.remove(registration)).status, "removed");
});
