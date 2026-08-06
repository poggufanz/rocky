import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import type { McpRegistration } from "../setup/clients.js";
import {
  createClaudeCodeAdapter,
  resolveClaudeCodeUserConfig,
  type ClaudeFileTransactions,
  type ClaudePolicyManifest,
} from "../setup/claude-code.js";
import { directorySyncCapability } from "../setup/directory-sync.js";
import { atomicWriteBytesIfUnchanged } from "../setup/file-transaction.js";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";

const registration: McpRegistration = {
  name: "rocky",
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
};

const addArgs = [
  "mcp", "add", "--scope", "user", "--transport", "stdio", "rocky",
  "--env", "ROCKY_MCP_EXPOSURE=sanitized",
  "--env", "ROCKY_HOME=/home/ada/.rocky",
  "--", "/opt/node", "/opt/rocky/dist/index.js", "mcp",
];
const removeArgs = ["mcp", "remove", "--scope", "user", "rocky"];
const suppressors = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

interface RunnerCall {
  command: string;
  args: readonly string[];
  options?: ProcessRunOptions;
}

type ActualHandler = (call: RunnerCall) => ProcessResult | Promise<ProcessResult>;

class FakeClaudeRunner implements ProcessRunner {
  readonly calls: RunnerCall[] = [];

  constructor(
    private readonly actual: ActualHandler = () => ({ status: 0, stdout: "", stderr: "" }),
    private readonly version: ProcessResult = {
      status: 0,
      stdout: "2.1.222 (Claude Code)\n",
      stderr: "",
    },
    private readonly addHelp: ProcessResult = {
      status: 0,
      stdout: "Usage: claude mcp add [options] <name> <commandOrUrl> [args...]\n--scope <scope>\n--env <env...>\n--transport <transport>\n",
      stderr: "",
    },
    private readonly removeHelp: ProcessResult = {
      status: 0,
      stdout: "Usage: claude mcp remove [options] <name>\n--scope <scope>\n",
      stderr: "",
    },
  ) {}

  async run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    if (args.length === 1 && args[0] === "--version") return this.version;
    if (args.at(-1) === "--help" && args[0] === "mcp" && args[1] === "add") return this.addHelp;
    if (args.at(-1) === "--help" && args[0] === "mcp" && args[1] === "remove") return this.removeHelp;
    return this.actual(call);
  }
}

function result(status: number | null, stdout = "", stderr = "", error?: Error): ProcessResult {
  const output: ProcessResult = { status, stdout, stderr };
  if (error !== undefined) output.error = error;
  return output;
}

function temporaryDirectory(t: test.TestContext, prefix = "rocky-claude-staged-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fixture(t: test.TestContext, value?: Record<string, unknown>): {
  root: string;
  configDir: string;
  configPath: string;
  stageRoot: string;
  cwd: string;
} {
  const root = temporaryDirectory(t);
  const configDir = join(root, "config");
  const stageRoot = join(root, "stages");
  const cwd = join(root, "project");
  mkdirSync(configDir, { mode: 0o700 });
  mkdirSync(stageRoot, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  const configPath = join(configDir, ".claude.json");
  if (value !== undefined) {
    writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
    chmodSync(configPath, 0o640);
  }
  return { root, configDir, configPath, stageRoot, cwd };
}

function rockyEntry(command = registration.command): Record<string, unknown> {
  return {
    type: "stdio",
    command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function completeManifest(
  independentPaths: readonly string[] = [],
  configDirRelativePaths: readonly string[] = [
    "settings.json",
    "cowork_settings.json",
    "remote-settings.json",
    "policy-limits.json",
    "managed-mcp.json",
    ".config.json",
  ],
): ClaudePolicyManifest {
  return {
    complete: true,
    version: "2.1.222",
    platform: "linux",
    architecture: "x64",
    configDirRelativePaths,
    independentPaths,
    policyEnvironmentKeys: [],
    backup: {
      directoryName: "backups",
      filePrefix: ".claude.json.backup.",
    },
  };
}

function adapterDependencies(
  setup: ReturnType<typeof fixture>,
  runner: ProcessRunner,
  overrides: Partial<Parameters<typeof createClaudeCodeAdapter>[0]> = {},
): Parameters<typeof createClaudeCodeAdapter>[0] {
  return {
    runner,
    executable: "/opt/claude",
    env: { CLAUDE_CONFIG_DIR: setup.configDir, PATH: "/tools" },
    home: join(setup.root, "home"),
    cwd: setup.cwd,
    platform: "linux",
    architecture: "x64",
    stagingRoot: setup.stageRoot,
    policyManifest: completeManifest(),
    ...overrides,
  };
}

function stagePath(call: RunnerCall): string {
  const path = call.options?.env?.CLAUDE_CONFIG_DIR;
  assert.ok(typeof path === "string");
  assert.equal(posix.isAbsolute(path), true);
  return path;
}

function writeBackup(
  stage: string,
  before: Buffer,
  mode: number,
  timestamp: string | number = Date.now(),
): void {
  const backups = join(stage, "backups");
  if (existsSync(backups)) return;
  mkdirSync(backups, { mode: 0o755 });
  const backup = join(backups, `.claude.json.backup.${timestamp}`);
  writeFileSync(backup, before, { mode });
  chmodSync(backup, mode);
}

function transformStage(
  call: RunnerCall,
  options: {
    backup?: "exact" | "missing" | "mismatch" | "extra";
    backupTimestamp?: string | number;
    mutate?: (stage: string, configPath: string, parsed: Record<string, unknown>) => void;
    preserveConfigMutation?: boolean;
  } = {},
): ProcessResult {
  const stage = stagePath(call);
  const configPath = join(stage, ".claude.json");
  const before = existsSync(configPath) ? readFileSync(configPath) : undefined;
  const mode = before === undefined ? 0o600 : statSync(configPath).mode & 0o777;
  if (options.backup !== "missing") {
    const backupBytes = options.backup === "mismatch"
      ? Buffer.from("{\"not\":\"the source\"}\n")
      : before ?? Buffer.from("{\"firstStartTime\":1}\n");
    writeBackup(stage, backupBytes, mode, options.backupTimestamp);
    if (options.backup === "extra") {
      writeFileSync(join(stage, "backups", `.claude.json.backup.${Date.now() + 1}`), backupBytes);
    }
  }
  const parsed = before === undefined
    ? {}
    : JSON.parse(before.toString("utf8")) as Record<string, unknown>;
  const servers = parsed.mcpServers === undefined
    ? {}
    : parsed.mcpServers as Record<string, unknown>;
  if (call.args[1] === "remove") delete servers.rocky;
  else servers.rocky = rockyEntry();
  parsed.mcpServers = servers;
  if (!existsSync(configPath) || lstatSync(configPath).isFile()) {
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode });
    chmodSync(configPath, mode);
  }
  options.mutate?.(stage, configPath, parsed);
  if (!options.preserveConfigMutation && existsSync(configPath) && lstatSync(configPath).isFile()) {
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode });
    chmodSync(configPath, mode);
  }
  return result(0);
}

function assertForcedEnvironment(call: RunnerCall): void {
  assert.deepEqual(
    Object.fromEntries(Object.keys(suppressors).map((key) => [key, call.options?.env?.[key]])),
    suppressors,
  );
}

function mutationCalls(runner: FakeClaudeRunner): RunnerCall[] {
  return runner.calls.filter(({ args }) => args.at(-1) !== "--help" && args[0] !== "--version");
}

function assertRetainedPrivateStages(stageRoot: string, minimum: number): void {
  const names = readdirSync(stageRoot);
  assert.ok(names.length >= minimum, `expected at least ${minimum} retained stages`);
  for (const name of names) {
    const metadata = lstatSync(join(stageRoot, name));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o700);
  }
}

function writeLegacyTransaction(
  target: string,
  state: "prepared" | "displaced" | "published",
  displaced?: Buffer,
): string {
  const transaction = join(dirname(target), `.${posix.basename(target)}.transaction-4242-0123456789abcdef`);
  mkdirSync(transaction, { mode: 0o700 });
  writeFileSync(
    join(transaction, "manifest.json"),
    `${JSON.stringify({ version: 1, state, target })}\n`,
  );
  if (displaced !== undefined) writeFileSync(join(transaction, "displaced"), displaced);
  return transaction;
}

test("effective Claude target uses platform path semantics without resolving unsafe overrides", () => {
  assert.deepEqual(resolveClaudeCodeUserConfig({
    home: "/Users/Ada",
    cwd: "/work/project",
    env: {},
    path: posix,
  }), {
    status: "resolved",
    configPath: "/Users/Ada/.claude.json",
    policyRoot: "/Users/Ada/.claude",
    override: "unset",
    mutationSafe: true,
  });
  assert.deepEqual(resolveClaudeCodeUserConfig({
    home: "/home/ada",
    cwd: "/work/project",
    env: { CLAUDE_CONFIG_DIR: "" },
    path: posix,
  }), {
    status: "resolved",
    configPath: "/home/ada/.claude.json",
    policyRoot: "/work/project",
    override: "empty",
    mutationSafe: false,
  });
  assert.deepEqual(resolveClaudeCodeUserConfig({
    home: "/home/ada",
    cwd: "/work/project",
    env: { CLAUDE_CONFIG_DIR: "/private/claude" },
    path: posix,
  }), {
    status: "resolved",
    configPath: "/private/claude/.claude.json",
    policyRoot: "/private/claude",
    override: "absolute",
    mutationSafe: true,
  });
  assert.deepEqual(resolveClaudeCodeUserConfig({
    home: "/home/ada",
    cwd: "/work/project",
    env: { CLAUDE_CONFIG_DIR: "relative/config" },
    path: posix,
  }), { status: "manual" });
  assert.deepEqual(resolveClaudeCodeUserConfig({
    home: "C:\\Users\\Ada",
    cwd: "C:\\work\\project",
    env: { CLAUDE_CONFIG_DIR: "D:\\Claude Config" },
    path: win32,
  }), {
    status: "resolved",
    configPath: "D:\\Claude Config\\.claude.json",
    policyRoot: "D:\\Claude Config",
    override: "absolute",
    mutationSafe: true,
  });
  assert.deepEqual(resolveClaudeCodeUserConfig({
    home: "/home/ada",
    cwd: "/work/project",
    env: { CLAUDE_CONFIG_DIR: "/tmp/e\u0301" },
    path: posix,
  }), {
    status: "resolved",
    configPath: "/tmp/e\u0301/.claude.json",
    policyRoot: "/tmp/\u00e9",
    override: "absolute",
    mutationSafe: false,
  });

  for (const configured of [
    "/tmp/a/../b",
    "/tmp/a/./b",
    "/tmp//b",
    "/tmp/b/",
  ]) {
    assert.deepEqual(resolveClaudeCodeUserConfig({
      home: "/home/ada",
      cwd: "/work/project",
      env: { CLAUDE_CONFIG_DIR: configured },
      path: posix,
    }), { status: "manual" }, configured);
  }
  for (const configured of [
    "C:\\a\\..\\b",
    "C:\\\\b",
    "C:/b",
    "\\b",
    "\\\\?\\C:\\b",
  ]) {
    assert.deepEqual(resolveClaudeCodeUserConfig({
      home: "C:\\Users\\Ada",
      cwd: "C:\\work\\project",
      env: { CLAUDE_CONFIG_DIR: configured },
      path: win32,
    }), { status: "manual" }, configured);
  }
});

test("lexically noncanonical absolute overrides stop before transaction reads or runner activity", async (t) => {
  for (const configured of ["/tmp/a/../b", "/tmp//b", "/tmp/a/./b", "/tmp/b/"]) {
    await t.test(configured, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      let transactionCalls = 0;
      const transactions: ClaudeFileTransactions = {
        inspect: () => { transactionCalls += 1; throw new Error("must not inspect"); },
        recover: () => { transactionCalls += 1; throw new Error("must not recover"); },
        write: () => { transactionCalls += 1; throw new Error("must not write"); },
      };
      const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
      const outcome = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        env: { CLAUDE_CONFIG_DIR: configured },
        fileTransactions: transactions,
      })).configure(registration, false);

      assert.equal(outcome.status, "failed");
      assert.equal(transactionCalls, 0);
      assert.deepEqual(runner.calls, []);
      assert.deepEqual(readdirSync(setup.stageRoot), []);
    });
  }
});

test("missing executable preserves blocked inspection and skipped operations", async (t) => {
  const setup = fixture(t);
  const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
  const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner, { executable: undefined }));

  assert.equal((await adapter.inspect(registration)).state, "blocked");
  assert.equal((await adapter.configure(registration, false)).status, "skipped");
  assert.equal((await adapter.remove(registration)).status, "skipped");
  assert.equal((await adapter.check(registration)).status, "skipped");
  assert.deepEqual(runner.calls, []);
});

test("read-only identity confirmation and health paths never start Claude", async (t) => {
  const cases = [
    {
      name: "identical",
      value: { mcpServers: { rocky: rockyEntry() } },
      inspect: "identical",
      configure: "already-configured",
      check: "healthy",
    },
    {
      name: "foreign",
      value: { mcpServers: { rocky: rockyEntry("/foreign/node") } },
      inspect: "conflict",
      configure: "requires-confirmation",
      check: "failed",
    },
    {
      name: "absent",
      value: { mcpServers: {} },
      inspect: "absent",
      configure: "failed",
      check: "not-configured",
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const setup = fixture(st, entry.value);
      const runner = new FakeClaudeRunner();
      const manifest = entry.name === "absent"
        ? { ...completeManifest(), complete: false as const }
        : completeManifest();
      const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        policyManifest: manifest,
      }));

      assert.equal((await adapter.inspect(registration)).state, entry.inspect);
      const configured = await adapter.configure(registration, false);
      assert.equal(configured.status, entry.configure);
      if (entry.name === "foreign") assert.deepEqual(configured.manualRegistration, registration);
      const checked = await adapter.check(registration);
      assert.equal(checked.status, entry.check);
      if (entry.name === "identical") assert.deepEqual(checked.healthRegistration, registration);
      assert.deepEqual(runner.calls, []);
    });
  }
});

test("production-incomplete manifest makes every needed mutation manual without a probe or stage", async (t) => {
  const setup = fixture(t, { theme: "dark", mcpServers: {} });
  const before = readFileSync(setup.configPath);
  const runner = new FakeClaudeRunner(() => { throw new Error("must not transform"); });
  const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner, {
    policyManifest: { ...completeManifest(), complete: false },
  }));

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual|capability|policy/i);
  assert.deepEqual(configured.manualRegistration, registration);
  assert.deepEqual(readFileSync(setup.configPath), before);
  assert.deepEqual(readdirSync(setup.stageRoot), []);
  assert.deepEqual(runner.calls, []);
});

test("relative empty and non-NFC overrides stop needed mutation before file stage or runner activity", async (t) => {
  const cases = [
    { name: "relative", override: "relative/config" },
    { name: "empty", override: "" },
    { name: "non-NFC", override: join(tmpdir(), "e\u0301") },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const root = temporaryDirectory(st);
      const home = join(root, "home");
      const stageRoot = join(root, "stages");
      const cwd = join(root, "cwd");
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(stageRoot, { mode: 0o700 });
      mkdirSync(cwd, { mode: 0o700 });
      const homeConfig = join(home, ".claude.json");
      writeFileSync(homeConfig, '{"mcpServers":{}}\n');
      const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
      const adapter = createClaudeCodeAdapter({
        runner,
        executable: "/opt/claude",
        env: { CLAUDE_CONFIG_DIR: entry.override },
        home,
        cwd,
        platform: "linux",
        architecture: "x64",
        stagingRoot: stageRoot,
        policyManifest: completeManifest(),
      });

      const configured = await adapter.configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(runner.calls, []);
      assert.deepEqual(readdirSync(stageRoot), []);
      assert.equal(readFileSync(homeConfig, "utf8"), '{"mcpServers":{}}\n');
    });
  }
});

test("exact version and command grammar capability gates reject every unproved result", async (t) => {
  const cases: Array<{
    name: string;
    version?: ProcessResult;
    addHelp?: ProcessResult;
    removeHelp?: ProcessResult;
  }> = [
    { name: "old", version: result(0, "2.1.221 (Claude Code)\n") },
    { name: "new unreviewed", version: result(0, "2.1.223 (Claude Code)\n") },
    { name: "malformed", version: result(0, "Claude current\n") },
    { name: "version timeout", version: result(0, "", "", new Error("process timeout")) },
    { name: "version process error", version: result(0, "", "", new Error("spawn secret")) },
    { name: "missing add grammar", addHelp: result(0, "Usage: something else\n") },
    { name: "missing remove grammar", removeHelp: result(0, "Usage: something else\n") },
    { name: "help error", addHelp: result(1, "", "fake-help-secret") },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      const before = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner(
        () => { throw new Error("must not transform"); },
        entry.version,
        entry.addHelp,
        entry.removeHelp,
      );
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
      assert.equal(mutationCalls(runner).length, 0);
      assert.doesNotMatch(configured.detail ?? "", /secret|spawn/i);
      for (const call of runner.calls) assertForcedEnvironment(call);
      assertRetainedPrivateStages(setup.stageRoot, 1);
    });
  }
});

test("supported staged configure uses exact argv env clone audit and conditional publication", async (t) => {
  const setup = fixture(t, {
    theme: "dark",
    explicitNull: null,
    future: [1, { keep: true }],
    mcpServers: { other: { type: "http", url: "https://local" } },
  });
  const original = readFileSync(setup.configPath);
  const originalMode = statSync(setup.configPath).mode & 0o777;
  let observedClone = false;
  const runner = new FakeClaudeRunner((call) => {
    const stage = stagePath(call);
    const stagedConfig = join(stage, ".claude.json");
    observedClone = readFileSync(stagedConfig).equals(original)
      && (statSync(stagedConfig).mode & 0o777) === originalMode
      && (statSync(stage).mode & 0o777) === 0o700;
    return transformStage(call);
  });
  const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
    .configure(registration, false);

  assert.equal(configured.status, "configured");
  assert.equal(observedClone, true);
  const actual = mutationCalls(runner);
  assert.equal(actual.length, 1);
  assert.deepEqual(actual[0]?.args, addArgs);
  assert.ok(actual[0]?.args.indexOf("rocky") < actual[0]!.args.indexOf("--env"));
  assert.equal(actual[0]?.args.indexOf("--") + 1, actual[0]?.args.indexOf(registration.command));
  assert.notEqual(stagePath(actual[0]!), setup.configDir);
  for (const call of runner.calls) assertForcedEnvironment(call);
  const published = JSON.parse(readFileSync(setup.configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(published, {
    theme: "dark",
    explicitNull: null,
    future: [1, { keep: true }],
    mcpServers: {
      other: { type: "http", url: "https://local" },
      rocky: rockyEntry(),
    },
  });
  assert.equal(statSync(setup.configPath).mode & 0o777, originalMode);
  assert.match(configured.detail ?? "", /recovery/i);
  assert.equal((configured.detail ?? "").includes(stagePath(actual[0]!)), false);
  assert.doesNotMatch(configured.detail ?? "", /dark|https:\/\/local/);
  assertRetainedPrivateStages(setup.stageRoot, 2);
});

test("replacement and removal run name-only commands only inside stage and retain displaced recovery", async (t) => {
  for (const operation of ["replace", "remove"] as const) {
    await t.test(operation, async (st) => {
      const originalValue = {
        token: "fake-original-secret",
        mcpServers: { other: { keep: true }, rocky: rockyEntry(operation === "replace" ? "/old/node" : undefined) },
      };
      const setup = fixture(st, originalValue);
      const original = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner((call) => transformStage(call));
      const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner));
      const outcome = operation === "replace"
        ? await adapter.configure(registration, true)
        : await adapter.remove(registration);

      assert.equal(outcome.status, operation === "replace" ? "configured" : "removed");
      const actual = mutationCalls(runner);
      assert.deepEqual(actual.map(({ args }) => args), operation === "replace"
        ? [removeArgs, addArgs]
        : [removeArgs]);
      assert.ok(actual.every((call) => stagePath(call) !== setup.configDir));
      assert.match(outcome.detail ?? "", /recovery/i);
      assert.doesNotMatch(outcome.detail ?? "", /fake-original-secret/);
      const match = /(?:recovery|backup)(?: artifact)?: ([^;]+)$/i.exec(outcome.detail ?? "");
      assert.ok(match?.[1] !== undefined, outcome.detail);
      assert.deepEqual(readFileSync(match[1]), original);
      const published = JSON.parse(readFileSync(setup.configPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.deepEqual(published.mcpServers.other, { keep: true });
      if (operation === "replace") assert.deepEqual(published.mcpServers.rocky, rockyEntry());
      else assert.equal(Object.prototype.hasOwnProperty.call(published.mcpServers, "rocky"), false);
      assertRetainedPrivateStages(setup.stageRoot, 2);
    });
  }
});

test("config-root policy files and unsafe independent layers stop before capability", async (t) => {
  const configRelative = ["settings.json", "remote-settings.json", "managed-mcp.json"];
  for (const relative of configRelative) {
    await t.test(relative, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      const path = join(setup.configDir, relative);
      writeFileSync(path, '{"deny":"fake-policy-secret"}\n');
      const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
      const manifest = completeManifest([], configRelative);
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        policyManifest: manifest,
      })).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(runner.calls, []);
      assert.doesNotMatch(configured.detail ?? "", /fake-policy-secret/);
    });
  }

  for (const topology of ["symlink", "hard-link", "directory"] as const) {
    await t.test(`independent ${topology}`, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      const policy = join(setup.root, "managed-policy.json");
      const target = join(setup.root, "managed-target.json");
      writeFileSync(target, '{"policy":"fake-independent-secret"}\n');
      if (topology === "symlink") symlinkSync(target, policy);
      else if (topology === "hard-link") linkSync(target, policy);
      else mkdirSync(policy);
      const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        policyManifest: completeManifest([policy]),
      })).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(runner.calls, []);
      assert.doesNotMatch(configured.detail ?? "", /fake-independent-secret/);
    });
  }
});

test("equivalent independent policy layers pass but every layer race blocks publication", async (t) => {
  const races = ["bytes", "mode", "inode", "appeared", "disappeared"] as const;
  for (const race of races) {
    await t.test(race, async (st) => {
      const setup = fixture(st, { keep: true, mcpServers: {} });
      const policy = join(setup.root, "project-policy.json");
      if (race !== "appeared") writeFileSync(policy, '{"allow":true}\n', { mode: 0o640 });
      const before = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner((call) => {
        const transformed = transformStage(call);
        if (race === "bytes") writeFileSync(policy, '{"allow":false}\n');
        else if (race === "mode") chmodSync(policy, 0o600);
        else if (race === "inode") {
          const replacement = join(setup.root, "new-policy.json");
          writeFileSync(replacement, '{"allow":true}\n');
          renameSync(replacement, policy);
        } else if (race === "appeared") writeFileSync(policy, '{"allow":true}\n');
        else rmSync(policy);
        return transformed;
      });
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        policyManifest: completeManifest([policy]),
      })).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
      assert.equal(mutationCalls(runner).length, 1);
    });
  }
});

test("unknown policy-like environment overrides fail closed", async (t) => {
  const setup = fixture(t, { mcpServers: {} });
  const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
  const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
    env: {
      CLAUDE_CONFIG_DIR: setup.configDir,
      CLAUDE_UNKNOWN_POLICY_INPUT: "fake-env-secret",
    },
  })).configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.deepEqual(runner.calls, []);
  assert.doesNotMatch(configured.detail ?? "", /fake-env-secret|UNKNOWN_POLICY/);
});

test("stage topology backup and semantic audit failures never publish", async (t) => {
  const cases: Array<{
    name: string;
    backup?: "exact" | "missing" | "mismatch" | "extra";
    mutate?: (stage: string, configPath: string, parsed: Record<string, unknown>) => void;
    preserveConfigMutation?: boolean;
  }> = [
    { name: "missing backup", backup: "missing" },
    { name: "backup mismatch", backup: "mismatch" },
    { name: "extra backup", backup: "extra" },
    { name: "unknown output", mutate: (stage) => writeFileSync(join(stage, "unknown"), "sentinel") },
    { name: "nested directory", mutate: (stage) => mkdirSync(join(stage, "nested")) },
    {
      name: "malformed JSON",
      mutate: (_stage, configPath) => writeFileSync(configPath, "{malformed"),
      preserveConfigMutation: true,
    },
    { name: "other server changed", mutate: (_stage, _path, parsed) => {
      (parsed.mcpServers as Record<string, unknown>).other = { changed: true };
    } },
    { name: "top-level scalar changed", mutate: (_stage, _path, parsed) => { parsed.keep = false; } },
    { name: "top-level array changed", mutate: (_stage, _path, parsed) => { parsed.values = [9]; } },
    { name: "top-level null changed", mutate: (_stage, _path, parsed) => { parsed.explicitNull = "changed"; } },
    { name: "future adjacent key changed", mutate: (_stage, _path, parsed) => { parsed.rockyFuture = { changed: true }; } },
    { name: "Rocky output missing", mutate: (_stage, _path, parsed) => {
      delete (parsed.mcpServers as Record<string, unknown>).rocky;
    } },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const setup = fixture(st, {
        keep: true,
        values: [1, { two: 2 }],
        explicitNull: null,
        rockyFuture: { keep: true },
        mcpServers: { other: { keep: true } },
      });
      const before = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner((call) => transformStage(call, entry));
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
      assert.doesNotMatch(configured.detail ?? "", /sentinel|malformed|changed/);
    });
  }
});

test("non-Rocky audit preserves negative zero and rejects nonfinite parse collapse", async (t) => {
  for (const entry of [
    { name: "negative zero", source: '{"n":-0,"mcpServers":{}}\n' },
    { name: "large exponent", source: '{"n":1e400,"mcpServers":{}}\n' },
  ]) {
    await t.test(entry.name, async (st) => {
      const setup = fixture(st);
      writeFileSync(setup.configPath, entry.source, { mode: 0o640 });
      chmodSync(setup.configPath, 0o640);
      const before = readFileSync(setup.configPath);
      const configured = await createClaudeCodeAdapter(adapterDependencies(
        setup,
        new FakeClaudeRunner((call) => transformStage(call)),
      )).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
    });
  }
});

test("Rocky registration requires exact own keys in staged and stored state", async (t) => {
  for (const operation of ["configure", "replace"] as const) {
    await t.test(`staged ${operation}`, async (st) => {
      const setup = fixture(st, {
        mcpServers: operation === "replace" ? { rocky: rockyEntry("/old/node") } : {},
      });
      const before = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner((call) => transformStage(call, {
        mutate: (_stage, _path, parsed) => {
          const servers = parsed.mcpServers as Record<string, Record<string, unknown>>;
          if (call.args[1] === "add") servers.rocky!.unexpected = { changesSemantics: true };
        },
      }));
      const outcome = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, operation === "replace");

      assert.equal(outcome.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
    });
  }

  await t.test("stored health and removal", async (st) => {
    const setup = fixture(st, {
      mcpServers: { rocky: { ...rockyEntry(), unexpected: "future-behavior" } },
    });
    const before = readFileSync(setup.configPath);
    const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
    const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner));

    assert.equal((await adapter.inspect(registration)).state, "conflict");
    assert.equal((await adapter.check(registration)).status, "failed");
    assert.equal((await adapter.remove(registration)).status, "failed");
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(readFileSync(setup.configPath), before);
  });
});

test("backup timestamp must be safe epoch milliseconds inside the transform window", async (t) => {
  for (const entry of [
    { name: "zero", timestamp: 0 },
    { name: "short", timestamp: 1 },
    { name: "future", timestamp: Number.MAX_SAFE_INTEGER },
    { name: "overflow", timestamp: "9007199254740992" },
  ]) {
    await t.test(entry.name, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      const before = readFileSync(setup.configPath);
      const configured = await createClaudeCodeAdapter(adapterDependencies(
        setup,
        new FakeClaudeRunner((call) => transformStage(call, { backupTimestamp: entry.timestamp })),
      )).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
    });
  }
});

test("staging root rejects linked components and ancestor rebind before any runner", async (t) => {
  await t.test("final component symlink", async (st) => {
    const setup = fixture(st, { mcpServers: {} });
    const realStageRoot = join(setup.root, "real-stage-root");
    mkdirSync(realStageRoot, { mode: 0o700 });
    rmSync(setup.stageRoot, { recursive: true });
    symlinkSync(realStageRoot, setup.stageRoot, "dir");
    const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });

    const outcome = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
      .configure(registration, false);

    assert.equal(outcome.status, "failed");
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(readdirSync(realStageRoot), []);
  });

  await t.test("stable symlink ancestor", async (st) => {
    const setup = fixture(st, { mcpServers: {} });
    const realNamespace = join(setup.root, "real-namespace");
    const linkedNamespace = join(setup.root, "linked-namespace");
    mkdirSync(join(realNamespace, "stages"), { recursive: true, mode: 0o700 });
    symlinkSync(realNamespace, linkedNamespace, "dir");
    const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });

    const outcome = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
      stagingRoot: join(linkedNamespace, "stages"),
    })).configure(registration, false);

    assert.equal(outcome.status, "failed");
    assert.deepEqual(runner.calls, []);
  });

  await t.test("ancestor rebound during stage creation", async (st) => {
    const setup = fixture(st, { mcpServers: {} });
    const namespace = join(setup.root, "stage-namespace");
    const stagingRoot = join(namespace, "stages");
    const attackerNamespace = join(setup.root, "attacker-namespace");
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(attackerNamespace, "stages"), { recursive: true, mode: 0o700 });
    const originalMkdtemp = fs.mkdtempSync;
    let rebound = false;
    fs.mkdtempSync = ((prefix: string, options?: unknown) => {
      const created = options === undefined
        ? originalMkdtemp(prefix)
        : originalMkdtemp(prefix, options as never) as unknown as string;
      if (!rebound && prefix.startsWith(stagingRoot)) {
        renameSync(namespace, `${namespace}-owned`);
        symlinkSync(attackerNamespace, namespace, "dir");
        mkdirSync(join(attackerNamespace, "stages", posix.basename(created)), { mode: 0o700 });
        rebound = true;
      }
      return created;
    }) as typeof fs.mkdtempSync;
    syncBuiltinESMExports();
    const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
    try {
      const outcome = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        stagingRoot,
      })).configure(registration, false);
      assert.equal(outcome.status, "failed");
      assert.equal(rebound, true);
      assert.deepEqual(runner.calls, []);
    } finally {
      fs.mkdtempSync = originalMkdtemp;
      syncBuiltinESMExports();
    }
  });
});

test("stage lifecycle never uses pathname-only deletion for invocation-owned entries", async (t) => {
  const setup = fixture(t, { mcpServers: {} });
  const originalRm = fs.rmSync;
  const originalRmdir = fs.rmdirSync;
  let pathnameDeletes = 0;
  fs.rmSync = ((path: fs.PathLike, options?: unknown) => {
    if (String(path).startsWith(setup.stageRoot)) {
      pathnameDeletes += 1;
      throw new Error("pathname-only deletion forbidden");
    }
    return options === undefined
      ? originalRm(path)
      : originalRm(path, options as never);
  }) as typeof fs.rmSync;
  fs.rmdirSync = ((path: fs.PathLike, options?: unknown) => {
    if (String(path).startsWith(setup.stageRoot)) {
      pathnameDeletes += 1;
      throw new Error("pathname-only deletion forbidden");
    }
    return options === undefined
      ? originalRmdir(path)
      : originalRmdir(path, options as never);
  }) as typeof fs.rmdirSync;
  syncBuiltinESMExports();
  try {
    const configured = await createClaudeCodeAdapter(adapterDependencies(
      setup,
      new FakeClaudeRunner((call) => transformStage(call)),
    )).configure(registration, false);

    assert.equal(configured.status, "configured");
    assert.equal(pathnameDeletes, 0);
    assertRetainedPrivateStages(setup.stageRoot, 2);
  } finally {
    fs.rmSync = originalRm;
    fs.rmdirSync = originalRmdir;
    syncBuiltinESMExports();
  }
});

test("stage symlink hard-link and rebound attacks are refused without deleting attacker state", async (t) => {
  for (const attack of ["symlink", "hard-link", "rebound"] as const) {
    await t.test(attack, async (st) => {
      const setup = fixture(st, { keep: true, mcpServers: {} });
      const before = readFileSync(setup.configPath);
      let sentinel: string | undefined;
      let oldStagePath: string | undefined;
      let ownedStagePath: string | undefined;
      const runner = new FakeClaudeRunner((call) => {
        const stage = stagePath(call);
        const config = join(stage, ".claude.json");
        const transformed = transformStage(call);
        if (attack === "symlink") {
          const target = join(setup.root, "attacker.json");
          writeFileSync(target, "attacker-sentinel\n");
          rmSync(config);
          symlinkSync(target, config);
          sentinel = target;
        } else if (attack === "hard-link") {
          sentinel = join(setup.root, "attacker-link.json");
          linkSync(config, sentinel);
        } else {
          oldStagePath = stage;
          const displaced = `${stage}-owned`;
          renameSync(stage, displaced);
          ownedStagePath = displaced;
          mkdirSync(stage, { mode: 0o700 });
          sentinel = join(stage, "attacker-sentinel");
          writeFileSync(sentinel, "keep attacker\n");
        }
        return transformed;
      });
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), before);
      assert.ok(sentinel !== undefined);
      assert.equal(existsSync(sentinel), true);
      assert.doesNotMatch(configured.detail ?? "", /attacker-sentinel|keep attacker/);
      if (attack === "rebound") {
        assert.ok(oldStagePath !== undefined && ownedStagePath !== undefined);
        assert.equal((configured.detail ?? "").includes(oldStagePath), false);
        assert.equal(existsSync(ownedStagePath), true);
      }
    });
  }
});

test("live state races preserve the winner and never invoke a live name-only mutation", async (t) => {
  const cases = [
    { name: "absent gains foreign", initial: { mcpServers: {} }, replace: false },
    { name: "owned A becomes foreign B", initial: { mcpServers: { rocky: rockyEntry("/old/node") } }, replace: true },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const setup = fixture(st, entry.initial);
      const winner = Buffer.from('{"winner":"fake-winner-secret","mcpServers":{"rocky":{"type":"stdio","command":"/foreign","args":[],"env":{}}}}\n');
      const runner = new FakeClaudeRunner((call) => {
        const transformed = transformStage(call);
        writeFileSync(setup.configPath, winner, { mode: 0o640 });
        return transformed;
      });
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, entry.replace);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), winner);
      assert.ok(mutationCalls(runner).every((call) => stagePath(call) !== setup.configDir));
      assert.doesNotMatch(configured.detail ?? "", /fake-winner-secret/);
    });
  }
});

test("target and parent inode swaps with identical bytes still block publication", async (t) => {
  for (const race of ["target", "parent"] as const) {
    await t.test(race, async (st) => {
      const setup = fixture(st, { keep: true, mcpServers: {} });
      const winner = readFileSync(setup.configPath);
      const originalTarget = lstatSync(setup.configPath).ino;
      const originalParent = lstatSync(setup.configDir).ino;
      const runner = new FakeClaudeRunner((call) => {
        const transformed = transformStage(call);
        if (race === "target") {
          const replacement = join(setup.root, "replacement.json");
          writeFileSync(replacement, winner, { mode: 0o640 });
          renameSync(replacement, setup.configPath);
        } else {
          renameSync(setup.configDir, join(setup.root, "displaced-config"));
          mkdirSync(setup.configDir, { mode: 0o700 });
          writeFileSync(setup.configPath, winner, { mode: 0o640 });
        }
        return transformed;
      });

      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), winner);
      if (race === "target") assert.notEqual(lstatSync(setup.configPath).ino, originalTarget);
      else assert.notEqual(lstatSync(setup.configDir).ino, originalParent);
      assert.ok(mutationCalls(runner).every((call) => stagePath(call) !== setup.configDir));
    });
  }
});

test("final transaction guard binds target and parent identity at the write boundary", async (t) => {
  for (const race of ["target", "parent"] as const) {
    await t.test(race, async (st) => {
      const setup = fixture(st, { keep: true, mcpServers: {} });
      const winner = readFileSync(setup.configPath);
      const preparedTarget = join(setup.root, "write-boundary-target.json");
      const preparedParent = join(setup.root, "write-boundary-parent");
      if (race === "target") {
        copyFileSync(setup.configPath, preparedTarget);
        chmodSync(preparedTarget, statSync(setup.configPath).mode & 0o777);
      } else {
        mkdirSync(preparedParent, { mode: 0o700 });
        writeFileSync(join(preparedParent, ".claude.json"), winner, { mode: 0o640 });
      }
      let checked = false;
      let guardBeforeRace: boolean | undefined;
      let guardAfterRace: boolean | undefined;
      const transactions: ClaudeFileTransactions = {
        inspect: () => ({ status: "clear" }),
        recover: () => ({ status: "clear" }),
        write: (_path, _bytes, _prior, guard) => {
          guardBeforeRace = guard?.unchanged();
          const originalTargetInode = lstatSync(setup.configPath).ino;
          const originalParentInode = lstatSync(setup.configDir).ino;
          if (race === "target") {
            renameSync(preparedTarget, setup.configPath);
            assert.notEqual(lstatSync(setup.configPath).ino, originalTargetInode);
          } else {
            renameSync(setup.configDir, join(setup.root, "write-boundary-parent-owned"));
            renameSync(preparedParent, setup.configDir);
            assert.notEqual(lstatSync(setup.configDir).ino, originalParentInode);
          }
          checked = true;
          guardAfterRace = guard?.unchanged();
          return { status: "changed" };
        },
      };
      const configured = await createClaudeCodeAdapter(adapterDependencies(
        setup,
        new FakeClaudeRunner((call) => transformStage(call)),
        { fileTransactions: transactions, policyManifest: completeManifest([], []) },
      )).configure(registration, false);

      assert.equal(checked, true);
      assert.equal(guardBeforeRace, true);
      assert.equal(guardAfterRace, false);
      assert.equal(configured.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), winner);
    });
  }
});

test("real transaction rejects a same-byte inode installed after prepared publication link removal", async (t) => {
  const setup = fixture(t, { keep: true, mcpServers: {} });
  const originalRm = fs.rmSync;
  let swapped = false;
  let publishedInode: number | undefined;
  let winnerInode: number | undefined;
  let winnerBytes: Buffer | undefined;
  fs.rmSync = ((path: fs.PathLike, options?: fs.RmOptions) => {
    const pathname = String(path);
    const transactionDirectory = dirname(pathname);
    const manifestPath = join(transactionDirectory, "manifest.json");
    if (!swapped
      && posix.basename(pathname) === "prepared"
      && existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { state?: string };
      if (manifest.state === "published") {
        options === undefined ? originalRm(path) : originalRm(path, options);
        publishedInode = lstatSync(setup.configPath).ino;
        winnerBytes = readFileSync(setup.configPath);
        const winner = join(setup.root, "same-byte-published-winner.json");
        writeFileSync(winner, winnerBytes, { mode: 0o640 });
        chmodSync(winner, statSync(setup.configPath).mode & 0o777);
        winnerInode = lstatSync(winner).ino;
        renameSync(winner, setup.configPath);
        swapped = true;
        return;
      }
    }
    options === undefined ? originalRm(path) : originalRm(path, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  let configured;
  try {
    configured = await createClaudeCodeAdapter(adapterDependencies(
      setup,
      new FakeClaudeRunner((call) => transformStage(call)),
    )).configure(registration, false);
  } finally {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }

  assert.equal(swapped, true);
  assert.ok(publishedInode !== undefined && winnerInode !== undefined && winnerBytes !== undefined);
  assert.notEqual(winnerInode, publishedInode);
  assert.equal(lstatSync(setup.configPath).ino, winnerInode);
  assert.deepEqual(readFileSync(setup.configPath), winnerBytes);
  assert.equal(configured.status, "failed");
});

test("real committed publication reports only authoritative recovery after exact-state replacements", async (t) => {
  for (const operation of ["configure", "remove"] as const) {
    for (const race of ["target", "parent"] as const) {
      await t.test(`${operation} ${race}`, async (st) => {
        const setup = fixture(st, {
          keep: true,
          mcpServers: operation === "remove" ? { rocky: rockyEntry() } : {},
        });
        const originalBytes = readFileSync(setup.configPath);
        const originalMode = statSync(setup.configPath).mode & 0o777;
        const originalIdentity = lstatSync(setup.configPath);
        const stageRootIdentity = lstatSync(setup.stageRoot);
        let publishedInode: number | undefined;
        let winnerInode: number | undefined;
        let winnerBytes: Buffer | undefined;
        let committedParent: string | undefined;
        let staleRecoveryPath: string | undefined;
        let movedRecoveryPath: string | undefined;
        let retainedTransactionInode: number | undefined;
        let foreignTransactionInode: number | undefined;
        let mutationStage: string | undefined;
        let mutationStageIdentity: { dev: number; ino: number } | undefined;
        const adapter = createClaudeCodeAdapter(adapterDependencies(
          setup,
          new FakeClaudeRunner((call) => {
            mutationStage = stagePath(call);
            const metadata = lstatSync(mutationStage);
            mutationStageIdentity = { dev: metadata.dev, ino: metadata.ino };
            return transformStage(call);
          }),
          {
            lifecycle: {
              afterPublish(path) {
                winnerBytes = readFileSync(path);
                const mode = statSync(path).mode & 0o777;
                if (race === "target") {
                  publishedInode = lstatSync(path).ino;
                  const winner = join(setup.root, `${operation}-target-winner.json`);
                  writeFileSync(winner, winnerBytes, { mode });
                  chmodSync(winner, mode);
                  winnerInode = lstatSync(winner).ino;
                  renameSync(winner, path);
                } else {
                  publishedInode = lstatSync(setup.configDir).ino;
                  const winnerParent = join(setup.root, `${operation}-parent-winner`);
                  mkdirSync(winnerParent, { mode: 0o700 });
                  writeFileSync(join(winnerParent, ".claude.json"), winnerBytes, { mode });
                  chmodSync(join(winnerParent, ".claude.json"), mode);
                  winnerInode = lstatSync(winnerParent).ino;
                  const transactionName = readdirSync(setup.configDir)
                    .find((name) => name.startsWith("..claude.json.transaction-"));
                  if (transactionName === undefined) throw new Error("missing committed transaction");
                  const retainedTransaction = join(setup.configDir, transactionName);
                  retainedTransactionInode = lstatSync(retainedTransaction).ino;
                  const foreignTransaction = join(winnerParent, transactionName);
                  mkdirSync(foreignTransaction, { mode: 0o700 });
                  writeFileSync(
                    join(foreignTransaction, "manifest.json"),
                    `${JSON.stringify({ version: 1, state: "committed", target: setup.configPath })}\n`,
                  );
                  writeFileSync(join(foreignTransaction, "displaced"), originalBytes, {
                    mode: originalMode,
                  });
                  chmodSync(join(foreignTransaction, "displaced"), originalMode);
                  foreignTransactionInode = lstatSync(foreignTransaction).ino;
                  committedParent = join(setup.root, `${operation}-committed-parent`);
                  renameSync(setup.configDir, committedParent);
                  renameSync(winnerParent, setup.configDir);
                  staleRecoveryPath = join(setup.configDir, transactionName, "displaced");
                  movedRecoveryPath = join(committedParent, transactionName, "displaced");
                }
              },
            },
          },
        ));

        const outcome = operation === "configure"
          ? await adapter.configure(registration, false)
          : await adapter.remove(registration);

        assert.ok(publishedInode !== undefined && winnerInode !== undefined && winnerBytes !== undefined);
        assert.notEqual(winnerInode, publishedInode);
        assert.equal(
          lstatSync(race === "target" ? setup.configPath : setup.configDir).ino,
          winnerInode,
        );
        assert.deepEqual(readFileSync(setup.configPath), winnerBytes);
        if (committedParent !== undefined) assert.equal(existsSync(committedParent), true);
        assert.equal(outcome.status, "failed");
        const reportedPath = /manual recovery: (.+)$/.exec(outcome.detail ?? "")?.[1];
        assert.ok(reportedPath !== undefined, outcome.detail);
        assert.equal(existsSync(reportedPath), true);
        if (race === "target") {
          assert.notEqual(reportedPath, mutationStage);
          const recovery = lstatSync(reportedPath);
          assert.equal(recovery.isFile(), true);
          assert.equal(recovery.isSymbolicLink(), false);
          assert.equal(recovery.dev, originalIdentity.dev);
          assert.equal(recovery.ino, originalIdentity.ino);
          assert.equal(recovery.nlink, originalIdentity.nlink);
          assert.equal(recovery.mode & 0o777, originalMode);
          assert.deepEqual(readFileSync(reportedPath), originalBytes);
          const manifest = JSON.parse(
            readFileSync(join(dirname(reportedPath), "manifest.json"), "utf8"),
          ) as { state?: string; target?: string };
          assert.deepEqual(manifest, {
            version: 1,
            state: "committed",
            target: setup.configPath,
          });
        } else {
          assert.ok(mutationStage !== undefined && mutationStageIdentity !== undefined);
          assert.equal(reportedPath, mutationStage);
          const reportedStage = lstatSync(reportedPath);
          assert.equal(reportedStage.isDirectory(), true);
          assert.equal(reportedStage.dev, mutationStageIdentity.dev);
          assert.equal(reportedStage.ino, mutationStageIdentity.ino);
          const currentStageRoot = lstatSync(setup.stageRoot);
          assert.equal(currentStageRoot.dev, stageRootIdentity.dev);
          assert.equal(currentStageRoot.ino, stageRootIdentity.ino);
          assert.ok(staleRecoveryPath !== undefined && movedRecoveryPath !== undefined);
          assert.equal(existsSync(staleRecoveryPath), true);
          assert.equal((outcome.detail ?? "").includes(staleRecoveryPath), false);
          assert.equal(existsSync(movedRecoveryPath), true);
          const movedRecovery = lstatSync(movedRecoveryPath);
          assert.equal(movedRecovery.dev, originalIdentity.dev);
          assert.equal(movedRecovery.ino, originalIdentity.ino);
          assert.deepEqual(readFileSync(movedRecoveryPath), originalBytes);
          assert.ok(retainedTransactionInode !== undefined && foreignTransactionInode !== undefined);
          assert.notEqual(foreignTransactionInode, retainedTransactionInode);
        }
      });
    }
  }
});

test("post-exact stage observation revalidates publication and recovery authority", async (t) => {
  for (const operation of ["configure", "remove"] as const) {
    for (const authority of ["transaction", "stage", "none"] as const) {
      await t.test(`${operation} retains ${authority} authority`, async (st) => {
        const setup = fixture(st, {
          keep: true,
          mcpServers: operation === "remove" ? { rocky: rockyEntry() } : {},
        });
        const originalBytes = readFileSync(setup.configPath);
        const originalMode = statSync(setup.configPath).mode & 0o777;
        const originalIdentity = lstatSync(setup.configPath);
        let mutationStage: string | undefined;
        let mutationStageIdentity: { dev: number; ino: number } | undefined;
        let publishedReturned = false;
        let committedObserved = false;
        let raced = false;
        let recoveryPath: string | undefined;
        let movedRecoveryPath: string | undefined;
        let foreignRecoveryPath: string | undefined;
        let movedStagePath: string | undefined;
        let foreignRecoveryInode: number | undefined;
        let retainedTransactionInode: number | undefined;
        const originalReadFile = fs.readFileSync;
        const originalLstat = fs.lstatSync;

        const installParentReplacement = () => {
          const transactionName = readdirSync(setup.configDir)
            .find((name) => name.startsWith("..claude.json.transaction-"));
          if (transactionName === undefined) throw new Error("missing committed transaction");
          recoveryPath = join(setup.configDir, transactionName, "displaced");
          retainedTransactionInode = originalLstat(dirname(recoveryPath)).ino;
          const publishedBytes = originalReadFile(setup.configPath);
          const publishedMode = originalLstat(setup.configPath).mode & 0o777;
          const foreignParent = join(setup.root, `${operation}-${authority}-foreign-parent`);
          mkdirSync(foreignParent, { mode: 0o700 });
          writeFileSync(join(foreignParent, ".claude.json"), publishedBytes, {
            mode: publishedMode,
          });
          chmodSync(join(foreignParent, ".claude.json"), publishedMode);
          const foreignTransaction = join(foreignParent, transactionName);
          mkdirSync(foreignTransaction, { mode: 0o700 });
          writeFileSync(
            join(foreignTransaction, "manifest.json"),
            `${JSON.stringify({
              version: 1,
              state: "committed",
              target: setup.configPath,
            })}\n`,
          );
          foreignRecoveryPath = join(foreignTransaction, "displaced");
          writeFileSync(foreignRecoveryPath, originalBytes, { mode: originalMode });
          chmodSync(foreignRecoveryPath, originalMode);
          foreignRecoveryInode = originalLstat(foreignRecoveryPath).ino;
          const movedParent = join(setup.root, `${operation}-${authority}-authoritative-parent`);
          renameSync(setup.configDir, movedParent);
          renameSync(foreignParent, setup.configDir);
          movedRecoveryPath = join(movedParent, transactionName, "displaced");
          foreignRecoveryPath = join(setup.configDir, transactionName, "displaced");
        };

        fs.readFileSync = ((
          path: fs.PathOrFileDescriptor,
          options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null,
        ) => {
          const value = options === undefined
            ? originalReadFile(path)
            : originalReadFile(path, options as never);
          if (publishedReturned && typeof path !== "number" && posix.basename(String(path)) === "manifest.json") {
            try {
              const parsed = JSON.parse(
                typeof value === "string" ? value : value.toString("utf8"),
              ) as { state?: string; target?: string };
              if (parsed.state === "committed" && parsed.target === setup.configPath) {
                committedObserved = true;
              }
            } catch {
              // Only the exact committed Task 1 manifest arms the race.
            }
          }
          return value;
        }) as typeof fs.readFileSync;
        Object.defineProperty(fs, "lstatSync", {
          configurable: true,
          writable: true,
          value: ((path: fs.PathLike, options?: unknown) => {
            if (committedObserved && !raced && String(path) === mutationStage) {
              raced = true;
              if (authority !== "transaction") installParentReplacement();
              if (authority !== "stage") {
                movedStagePath = `${mutationStage}-authoritative`;
                renameSync(mutationStage, movedStagePath);
                mkdirSync(mutationStage, { mode: 0o700 });
              }
            }
            return options === undefined
              ? originalLstat(path)
              : originalLstat(path, options as never);
          }) as typeof fs.lstatSync,
        });
        syncBuiltinESMExports();

        let outcome;
        try {
          const adapter = createClaudeCodeAdapter(adapterDependencies(
            setup,
            new FakeClaudeRunner((call) => {
              mutationStage = stagePath(call);
              const metadata = originalLstat(mutationStage);
              mutationStageIdentity = { dev: metadata.dev, ino: metadata.ino };
              return transformStage(call);
            }),
            {
              lifecycle: {
                afterPublish() {
                  publishedReturned = true;
                },
              },
            },
          ));
          outcome = operation === "configure"
            ? await adapter.configure(registration, false)
            : await adapter.remove(registration);
        } finally {
          fs.readFileSync = originalReadFile;
          Object.defineProperty(fs, "lstatSync", {
            configurable: true,
            writable: true,
            value: originalLstat,
          });
          syncBuiltinESMExports();
        }

        assert.equal(publishedReturned, true);
        assert.equal(committedObserved, true);
        assert.equal(raced, true);
        assert.equal(outcome.status, "failed");
        const reportedPath = /manual recovery: (.+)$/.exec(outcome.detail ?? "")?.[1];
        if (authority === "transaction") {
          assert.ok(reportedPath !== undefined, outcome.detail);
          assert.deepEqual(readFileSync(reportedPath), originalBytes);
          const reported = lstatSync(reportedPath);
          assert.equal(reported.dev, originalIdentity.dev);
          assert.equal(reported.ino, originalIdentity.ino);
          assert.equal(reported.mode & 0o777, originalMode);
          assert.ok(movedStagePath !== undefined && mutationStage !== undefined);
          assert.equal((outcome.detail ?? "").includes(mutationStage), false);
          assert.equal(existsSync(movedStagePath), true);
        } else {
          assert.ok(recoveryPath !== undefined && movedRecoveryPath !== undefined);
          assert.ok(foreignRecoveryPath !== undefined);
          assert.equal(existsSync(foreignRecoveryPath), true);
          assert.equal((outcome.detail ?? "").includes(recoveryPath), false);
          assert.equal((outcome.detail ?? "").includes(foreignRecoveryPath), false);
          const movedRecovery = lstatSync(movedRecoveryPath);
          assert.equal(movedRecovery.dev, originalIdentity.dev);
          assert.equal(movedRecovery.ino, originalIdentity.ino);
          assert.deepEqual(readFileSync(movedRecoveryPath), originalBytes);
          assert.ok(foreignRecoveryInode !== undefined && retainedTransactionInode !== undefined);
          assert.notEqual(foreignRecoveryInode, originalIdentity.ino);
          assert.notEqual(lstatSync(dirname(foreignRecoveryPath)).ino, retainedTransactionInode);
          assert.equal(lstatSync(foreignRecoveryPath).mode & 0o777, originalMode);
          assert.deepEqual(readFileSync(foreignRecoveryPath), originalBytes);
          assert.deepEqual(
            JSON.parse(readFileSync(join(dirname(foreignRecoveryPath), "manifest.json"), "utf8")),
            { version: 1, state: "committed", target: setup.configPath },
          );
          if (authority === "stage") {
            assert.ok(mutationStage !== undefined && mutationStageIdentity !== undefined);
            assert.equal(reportedPath, mutationStage);
            const retainedStage = lstatSync(reportedPath);
            assert.equal(retainedStage.dev, mutationStageIdentity.dev);
            assert.equal(retainedStage.ino, mutationStageIdentity.ino);
          } else {
            assert.equal(reportedPath, undefined, outcome.detail);
            assert.doesNotMatch(outcome.detail ?? "", /manual recovery:/i);
            assert.ok(movedStagePath !== undefined && mutationStage !== undefined);
            assert.equal((outcome.detail ?? "").includes(mutationStage), false);
            assert.equal(existsSync(movedStagePath), true);
          }
        }
      });
    }
  }
});

test("final target observation stays paired with the exact displaced recovery inode", async (t) => {
  for (const operation of ["configure", "remove"] as const) {
    await t.test(operation, async (st) => {
      const secret = `fake-${operation}-final-pair-secret`;
      const setup = fixture(st, {
        secret,
        mcpServers: operation === "remove" ? { rocky: rockyEntry() } : {},
      });
      const originalBytes = readFileSync(setup.configPath);
      const originalMode = statSync(setup.configPath).mode & 0o777;
      const stageRootIdentity = lstatSync(setup.stageRoot);
      const foreignPreparedPath = join(setup.root, `${operation}-foreign-displaced`);
      writeFileSync(foreignPreparedPath, originalBytes, { mode: originalMode });
      chmodSync(foreignPreparedPath, originalMode);
      const foreignPreparedIdentity = lstatSync(foreignPreparedPath);

      let mutationStage: string | undefined;
      let mutationStageIdentity: { dev: number; ino: number } | undefined;
      let publishedReturned = false;
      let committedManifestObservations = 0;
      let finalGuardArmed = false;
      let displacedObservations = 0;
      let raced = false;
      let transactionDirectory: string | undefined;
      let recoveryPath: string | undefined;
      let movedRecoveryPath: string | undefined;
      let originalRecoveryIdentity: ReturnType<typeof lstatSync> | undefined;
      let publishedIdentity: ReturnType<typeof lstatSync> | undefined;
      let publishedBytes: Buffer | undefined;
      const originalReadFile = fs.readFileSync;
      const originalLstat = fs.lstatSync;

      fs.readFileSync = ((
        path: fs.PathOrFileDescriptor,
        options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null,
      ) => {
        const value = options === undefined
          ? originalReadFile(path)
          : originalReadFile(path, options as never);
        if (publishedReturned
          && typeof path !== "number"
          && posix.basename(String(path)) === "manifest.json") {
          try {
            const parsed = JSON.parse(
              typeof value === "string" ? value : value.toString("utf8"),
            ) as { state?: string; target?: string };
            if (parsed.state === "committed" && parsed.target === setup.configPath) {
              committedManifestObservations += 1;
              transactionDirectory = dirname(String(path));
              recoveryPath = join(transactionDirectory, "displaced");
              if (committedManifestObservations === 2) finalGuardArmed = true;
            }
          } catch {
            // Only exact committed Task 1 manifest observations arm the race.
          }
        }
        return value;
      }) as typeof fs.readFileSync;
      Object.defineProperty(fs, "lstatSync", {
        configurable: true,
        writable: true,
        value: ((path: fs.PathLike, options?: unknown) => {
          const pathname = String(path);
          if (finalGuardArmed && pathname === recoveryPath) {
            displacedObservations += 1;
          }
          if (!raced
            && finalGuardArmed
            && displacedObservations >= 2
            && pathname === setup.configPath) {
            assert.ok(recoveryPath !== undefined && transactionDirectory !== undefined);
            raced = true;
            originalRecoveryIdentity = originalLstat(recoveryPath);
            publishedIdentity = originalLstat(setup.configPath);
            publishedBytes = originalReadFile(setup.configPath);
            movedRecoveryPath = join(setup.root, `${operation}-original-displaced`);
            renameSync(recoveryPath, movedRecoveryPath);
            renameSync(foreignPreparedPath, recoveryPath);
          }
          return options === undefined
            ? originalLstat(path)
            : originalLstat(path, options as never);
        }) as typeof fs.lstatSync,
      });
      syncBuiltinESMExports();

      let outcome;
      try {
        const adapter = createClaudeCodeAdapter(adapterDependencies(
          setup,
          new FakeClaudeRunner((call) => {
            mutationStage = stagePath(call);
            const metadata = originalLstat(mutationStage);
            mutationStageIdentity = { dev: metadata.dev, ino: metadata.ino };
            return transformStage(call);
          }),
          {
            lifecycle: {
              afterPublish() {
                publishedReturned = true;
              },
            },
          },
        ));
        outcome = operation === "configure"
          ? await adapter.configure(registration, false)
          : await adapter.remove(registration);
      } finally {
        fs.readFileSync = originalReadFile;
        Object.defineProperty(fs, "lstatSync", {
          configurable: true,
          writable: true,
          value: originalLstat,
        });
        syncBuiltinESMExports();
      }

      assert.equal(publishedReturned, true);
      assert.equal(committedManifestObservations, 2);
      assert.equal(finalGuardArmed, true);
      assert.ok(displacedObservations >= 2);
      assert.equal(raced, true);
      assert.ok(recoveryPath !== undefined && movedRecoveryPath !== undefined);
      assert.ok(originalRecoveryIdentity !== undefined);
      assert.ok(publishedIdentity !== undefined && publishedBytes !== undefined);
      assert.ok(mutationStage !== undefined && mutationStageIdentity !== undefined);

      const movedRecovery = lstatSync(movedRecoveryPath);
      assert.equal(movedRecovery.isFile(), true);
      assert.equal(movedRecovery.isSymbolicLink(), false);
      assert.equal(movedRecovery.dev, originalRecoveryIdentity.dev);
      assert.equal(movedRecovery.ino, originalRecoveryIdentity.ino);
      assert.equal(movedRecovery.nlink, 1);
      assert.equal(movedRecovery.mode & 0o777, originalMode);
      assert.deepEqual(readFileSync(movedRecoveryPath), originalBytes);

      const foreignRecovery = lstatSync(recoveryPath);
      assert.equal(foreignRecovery.isFile(), true);
      assert.equal(foreignRecovery.isSymbolicLink(), false);
      assert.equal(foreignRecovery.dev, foreignPreparedIdentity.dev);
      assert.equal(foreignRecovery.ino, foreignPreparedIdentity.ino);
      assert.equal(foreignRecovery.nlink, 1);
      assert.equal(foreignRecovery.mode & 0o777, originalMode);
      assert.deepEqual(readFileSync(recoveryPath), originalBytes);
      assert.notEqual(foreignRecovery.ino, movedRecovery.ino);
      assert.deepEqual(readdirSync(transactionDirectory!).sort(), ["displaced", "manifest.json"]);

      const currentPublished = lstatSync(setup.configPath);
      assert.equal(currentPublished.dev, publishedIdentity.dev);
      assert.equal(currentPublished.ino, publishedIdentity.ino);
      assert.equal(currentPublished.nlink, publishedIdentity.nlink);
      assert.deepEqual(readFileSync(setup.configPath), publishedBytes);

      const reportedPath = /manual recovery: (.+)$/.exec(outcome.detail ?? "")?.[1];
      const reportedForeignRecovery = (outcome.detail ?? "").includes(recoveryPath);
      assert.equal(outcome.status, "failed", JSON.stringify({
        actualStatus: outcome.status,
        reportedForeignRecovery,
        originalRecoveryInode: movedRecovery.ino,
        foreignRecoveryInode: foreignRecovery.ino,
      }));
      assert.equal(reportedForeignRecovery, false);
      assert.equal(reportedPath, mutationStage);
      const retainedStage = lstatSync(reportedPath);
      assert.equal(retainedStage.isDirectory(), true);
      assert.equal(retainedStage.dev, mutationStageIdentity.dev);
      assert.equal(retainedStage.ino, mutationStageIdentity.ino);
      const currentStageRoot = lstatSync(setup.stageRoot);
      assert.equal(currentStageRoot.dev, stageRootIdentity.dev);
      assert.equal(currentStageRoot.ino, stageRootIdentity.ino);
      assert.doesNotMatch(outcome.detail ?? "", new RegExp(secret));
    });
  }
});

test("successful final authority reports only its paired recovery after a closing stage rebound", async (t) => {
  for (const operation of ["configure", "remove"] as const) {
    await t.test(operation, async (st) => {
      const secret = `fake-${operation}-success-stage-secret`;
      const setup = fixture(st, {
        secret,
        mcpServers: operation === "remove" ? { rocky: rockyEntry() } : {},
      });
      const originalBytes = readFileSync(setup.configPath);
      const originalMode = statSync(setup.configPath).mode & 0o777;
      const originalIdentity = lstatSync(setup.configPath);
      let mutationStage: string | undefined;
      let originalStageIdentity: ReturnType<typeof lstatSync> | undefined;
      let movedStagePath: string | undefined;
      let foreignStageIdentity: ReturnType<typeof lstatSync> | undefined;
      let publishedReturned = false;
      let committedManifestObservations = 0;
      let finalCapabilityArmed = false;
      let closingTargetObservations = 0;
      let raced = false;
      const originalReadFile = fs.readFileSync;
      const originalLstat = fs.lstatSync;

      fs.readFileSync = ((
        path: fs.PathOrFileDescriptor,
        options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null,
      ) => {
        const value = options === undefined
          ? originalReadFile(path)
          : originalReadFile(path, options as never);
        if (publishedReturned
          && typeof path !== "number"
          && posix.basename(String(path)) === "manifest.json") {
          try {
            const parsed = JSON.parse(
              typeof value === "string" ? value : value.toString("utf8"),
            ) as { state?: string; target?: string };
            if (parsed.state === "committed" && parsed.target === setup.configPath) {
              committedManifestObservations += 1;
              if (committedManifestObservations === 2) finalCapabilityArmed = true;
            }
          } catch {
            // Only the exact committed Task 1 manifest arms the closing sweep.
          }
        }
        return value;
      }) as typeof fs.readFileSync;
      Object.defineProperty(fs, "lstatSync", {
        configurable: true,
        writable: true,
        value: ((path: fs.PathLike, options?: unknown) => {
          if (finalCapabilityArmed && String(path) === setup.configPath) {
            closingTargetObservations += 1;
            if (!raced && closingTargetObservations === 3) {
              assert.ok(mutationStage !== undefined);
              raced = true;
              originalStageIdentity = originalLstat(mutationStage);
              movedStagePath = `${mutationStage}-authoritative`;
              renameSync(mutationStage, movedStagePath);
              mkdirSync(mutationStage, { mode: 0o700 });
              chmodSync(mutationStage, 0o700);
              foreignStageIdentity = originalLstat(mutationStage);
            }
          }
          return options === undefined
            ? originalLstat(path)
            : originalLstat(path, options as never);
        }) as typeof fs.lstatSync,
      });
      syncBuiltinESMExports();

      let outcome;
      try {
        const adapter = createClaudeCodeAdapter(adapterDependencies(
          setup,
          new FakeClaudeRunner((call) => {
            mutationStage = stagePath(call);
            return transformStage(call);
          }),
          {
            lifecycle: {
              afterPublish() {
                publishedReturned = true;
              },
            },
          },
        ));
        outcome = operation === "configure"
          ? await adapter.configure(registration, false)
          : await adapter.remove(registration);
      } finally {
        fs.readFileSync = originalReadFile;
        Object.defineProperty(fs, "lstatSync", {
          configurable: true,
          writable: true,
          value: originalLstat,
        });
        syncBuiltinESMExports();
      }

      assert.equal(publishedReturned, true);
      assert.equal(committedManifestObservations, 2);
      assert.equal(finalCapabilityArmed, true);
      assert.equal(closingTargetObservations, 3);
      assert.equal(raced, true);
      assert.ok(mutationStage !== undefined && movedStagePath !== undefined);
      assert.ok(originalStageIdentity !== undefined && foreignStageIdentity !== undefined);
      const movedStageIdentity = lstatSync(movedStagePath);
      assert.equal(movedStageIdentity.isDirectory(), true);
      assert.equal(movedStageIdentity.dev, originalStageIdentity.dev);
      assert.equal(movedStageIdentity.ino, originalStageIdentity.ino);
      assert.equal(movedStageIdentity.mode & 0o777, 0o700);
      const currentForeignStage = lstatSync(mutationStage);
      assert.equal(currentForeignStage.isDirectory(), true);
      assert.equal(currentForeignStage.dev, foreignStageIdentity.dev);
      assert.equal(currentForeignStage.ino, foreignStageIdentity.ino);
      assert.equal(currentForeignStage.mode & 0o777, 0o700);
      assert.notEqual(currentForeignStage.ino, movedStageIdentity.ino);

      assert.equal(outcome.status, operation === "configure" ? "configured" : "removed");
      assert.equal((outcome.detail ?? "").includes(mutationStage), false, outcome.detail);
      assert.equal((outcome.detail ?? "").includes(movedStagePath), false, outcome.detail);
      const recoveryPath = /Claude Code recovery artifact: (.+)$/.exec(outcome.detail ?? "")?.[1];
      assert.ok(recoveryPath !== undefined, outcome.detail);
      const recoveryIdentity = lstatSync(recoveryPath);
      assert.equal(recoveryIdentity.isFile(), true);
      assert.equal(recoveryIdentity.isSymbolicLink(), false);
      assert.equal(recoveryIdentity.dev, originalIdentity.dev);
      assert.equal(recoveryIdentity.ino, originalIdentity.ino);
      assert.equal(recoveryIdentity.nlink, originalIdentity.nlink);
      assert.equal(recoveryIdentity.mode & 0o777, originalMode);
      assert.deepEqual(readFileSync(recoveryPath), originalBytes);
      assert.deepEqual(readdirSync(dirname(recoveryPath)).sort(), ["displaced", "manifest.json"]);
      assert.deepEqual(
        JSON.parse(readFileSync(join(dirname(recoveryPath), "manifest.json"), "utf8")),
        { version: 1, state: "committed", target: setup.configPath },
      );
      assert.doesNotMatch(outcome.detail ?? "", new RegExp(secret));
    });
  }
});

test("post-publication recovery-required reports no rebound raw Task 1 path", async (t) => {
  for (const operation of ["configure", "remove"] as const) {
    await t.test(operation, async (st) => {
      const secret = `fake-${operation}-durability-secret`;
      const setup = fixture(st, {
        secret,
        mcpServers: operation === "remove" ? { rocky: rockyEntry() } : {},
      });
      const originalBytes = readFileSync(setup.configPath);
      const originalMode = statSync(setup.configPath).mode & 0o777;
      const originalIdentity = lstatSync(setup.configPath);
      let mutationStage: string | undefined;
      let mutationStageIdentity: ReturnType<typeof lstatSync> | undefined;
      let task1Returned = false;
      let task1RecoveryPath: string | undefined;
      let publicationLinked = false;
      let durabilityFaulted = false;
      let raced = false;
      let movedParent: string | undefined;
      let movedRecoveryPath: string | undefined;
      let foreignRecoveryPath: string | undefined;
      let originalRecoveryIdentity: ReturnType<typeof lstatSync> | undefined;
      let originalTransactionIdentity: ReturnType<typeof lstatSync> | undefined;
      let foreignRecoveryIdentity: ReturnType<typeof lstatSync> | undefined;
      let foreignTransactionIdentity: ReturnType<typeof lstatSync> | undefined;
      let movedPublishedIdentity: ReturnType<typeof lstatSync> | undefined;
      let foreignPublishedIdentity: ReturnType<typeof lstatSync> | undefined;
      let publishedBytes: Buffer | undefined;
      let manifestBytes: Buffer | undefined;
      let manifestMode: number | undefined;
      const originalLink = fs.linkSync;
      const originalLstat = fs.lstatSync;
      const originalDirectorySync = directorySyncCapability.sync;

      fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
        originalLink(existingPath, newPath);
        if (String(newPath) === setup.configPath) publicationLinked = true;
      }) as typeof fs.linkSync;
      directorySyncCapability.sync = (directoryPath) => {
        if (publicationLinked && !durabilityFaulted && directoryPath === setup.configDir) {
          durabilityFaulted = true;
          throw new Error(`injected parent sync fault carrying ${secret}`);
        }
        return originalDirectorySync(directoryPath);
      };

      const installForeignParent = () => {
        assert.ok(task1RecoveryPath !== undefined);
        const transaction = dirname(task1RecoveryPath);
        const transactionName = posix.basename(transaction);
        const preparedPath = join(transaction, "prepared");
        const manifestPath = join(transaction, "manifest.json");
        originalRecoveryIdentity = originalLstat(task1RecoveryPath);
        originalTransactionIdentity = originalLstat(transaction);
        movedPublishedIdentity = originalLstat(setup.configPath);
        publishedBytes = readFileSync(setup.configPath);
        manifestBytes = readFileSync(manifestPath);
        manifestMode = originalLstat(manifestPath).mode & 0o777;

        const foreignParent = join(setup.root, `${operation}-durability-foreign-parent`);
        mkdirSync(foreignParent, { mode: 0o700 });
        const foreignTransaction = join(foreignParent, transactionName);
        mkdirSync(foreignTransaction, { mode: 0o700 });
        const foreignManifest = join(foreignTransaction, "manifest.json");
        writeFileSync(foreignManifest, manifestBytes, { mode: manifestMode });
        chmodSync(foreignManifest, manifestMode);
        foreignRecoveryPath = join(foreignTransaction, "displaced");
        writeFileSync(foreignRecoveryPath, originalBytes, { mode: originalMode });
        chmodSync(foreignRecoveryPath, originalMode);
        const foreignPrepared = join(foreignTransaction, "prepared");
        const preparedMode = originalLstat(preparedPath).mode & 0o777;
        copyFileSync(preparedPath, foreignPrepared);
        chmodSync(foreignPrepared, preparedMode);
        const foreignTarget = join(foreignParent, ".claude.json");
        originalLink(foreignPrepared, foreignTarget);

        movedParent = join(setup.root, `${operation}-durability-authoritative-parent`);
        renameSync(setup.configDir, movedParent);
        renameSync(foreignParent, setup.configDir);
        movedRecoveryPath = join(movedParent, transactionName, "displaced");
        foreignRecoveryPath = join(setup.configDir, transactionName, "displaced");
        foreignRecoveryIdentity = originalLstat(foreignRecoveryPath);
        foreignTransactionIdentity = originalLstat(dirname(foreignRecoveryPath));
        foreignPublishedIdentity = originalLstat(setup.configPath);
      };

      Object.defineProperty(fs, "lstatSync", {
        configurable: true,
        writable: true,
        value: ((path: fs.PathLike, options?: unknown) => {
          if (task1Returned && !raced && String(path) === mutationStage) {
            raced = true;
            installForeignParent();
          }
          return options === undefined
            ? originalLstat(path)
            : originalLstat(path, options as never);
        }) as typeof fs.lstatSync,
      });
      syncBuiltinESMExports();

      const transactions: ClaudeFileTransactions = {
        inspect: () => ({ status: "clear" }),
        recover: () => ({ status: "clear" }),
        write: (path, bytes, prior, guard) => {
          const result = atomicWriteBytesIfUnchanged(path, bytes, prior, guard);
          assert.equal(result.status, "recovery-required");
          task1RecoveryPath = result.recoveryPath;
          task1Returned = true;
          return result;
        },
      };

      let outcome;
      try {
        const adapter = createClaudeCodeAdapter(adapterDependencies(
          setup,
          new FakeClaudeRunner((call) => {
            mutationStage = stagePath(call);
            mutationStageIdentity = originalLstat(mutationStage);
            return transformStage(call);
          }),
          { fileTransactions: transactions },
        ));
        outcome = operation === "configure"
          ? await adapter.configure(registration, false)
          : await adapter.remove(registration);
      } finally {
        fs.linkSync = originalLink;
        directorySyncCapability.sync = originalDirectorySync;
        Object.defineProperty(fs, "lstatSync", {
          configurable: true,
          writable: true,
          value: originalLstat,
        });
        syncBuiltinESMExports();
      }

      assert.equal(publicationLinked, true);
      assert.equal(durabilityFaulted, true);
      assert.equal(task1Returned, true);
      assert.equal(raced, true);
      assert.ok(task1RecoveryPath !== undefined);
      assert.ok(movedParent !== undefined && movedRecoveryPath !== undefined);
      assert.ok(foreignRecoveryPath !== undefined);
      assert.ok(originalRecoveryIdentity !== undefined && originalTransactionIdentity !== undefined);
      assert.ok(foreignRecoveryIdentity !== undefined && foreignTransactionIdentity !== undefined);
      assert.ok(movedPublishedIdentity !== undefined && foreignPublishedIdentity !== undefined);
      assert.ok(publishedBytes !== undefined && manifestBytes !== undefined && manifestMode !== undefined);

      assert.equal(outcome.status, "failed");
      assert.deepEqual(readFileSync(setup.configPath), publishedBytes);
      assert.equal(lstatSync(setup.configPath).ino, foreignPublishedIdentity.ino);
      assert.notEqual(foreignPublishedIdentity.ino, movedPublishedIdentity.ino);
      assert.deepEqual(readFileSync(join(movedParent, ".claude.json")), publishedBytes);

      const movedRecovery = lstatSync(movedRecoveryPath);
      assert.equal(movedRecovery.dev, originalRecoveryIdentity.dev);
      assert.equal(movedRecovery.ino, originalRecoveryIdentity.ino);
      assert.equal(movedRecovery.nlink, 1);
      assert.equal(movedRecovery.mode & 0o777, originalMode);
      assert.deepEqual(readFileSync(movedRecoveryPath), originalBytes);
      const foreignRecovery = lstatSync(foreignRecoveryPath);
      assert.equal(foreignRecovery.dev, foreignRecoveryIdentity.dev);
      assert.equal(foreignRecovery.ino, foreignRecoveryIdentity.ino);
      assert.equal(foreignRecovery.nlink, 1);
      assert.equal(foreignRecovery.mode & 0o777, originalMode);
      assert.deepEqual(readFileSync(foreignRecoveryPath), originalBytes);
      assert.notEqual(foreignRecovery.ino, movedRecovery.ino);
      assert.notEqual(foreignTransactionIdentity.ino, originalTransactionIdentity.ino);
      assert.deepEqual(readdirSync(dirname(movedRecoveryPath)).sort(), [
        "displaced", "manifest.json", "prepared",
      ]);
      assert.deepEqual(readdirSync(dirname(foreignRecoveryPath)).sort(), [
        "displaced", "manifest.json", "prepared",
      ]);
      assert.deepEqual(readFileSync(join(dirname(movedRecoveryPath), "manifest.json")), manifestBytes);
      assert.deepEqual(readFileSync(join(dirname(foreignRecoveryPath), "manifest.json")), manifestBytes);
      assert.equal(statSync(join(dirname(movedRecoveryPath), "manifest.json")).mode & 0o777, manifestMode);
      assert.equal(statSync(join(dirname(foreignRecoveryPath), "manifest.json")).mode & 0o777, manifestMode);
      assert.deepEqual(JSON.parse(manifestBytes.toString("utf8")), {
        version: 1,
        state: "displaced",
        target: setup.configPath,
      });
      const movedPrepared = lstatSync(join(dirname(movedRecoveryPath), "prepared"));
      const movedTarget = lstatSync(join(movedParent, ".claude.json"));
      assert.equal(movedPrepared.dev, movedTarget.dev);
      assert.equal(movedPrepared.ino, movedTarget.ino);
      assert.equal(movedPrepared.nlink, 2);
      const foreignPrepared = lstatSync(join(dirname(foreignRecoveryPath), "prepared"));
      const foreignTarget = lstatSync(setup.configPath);
      assert.equal(foreignPrepared.dev, foreignTarget.dev);
      assert.equal(foreignPrepared.ino, foreignTarget.ino);
      assert.equal(foreignPrepared.nlink, 2);

      assert.equal((outcome.detail ?? "").includes(task1RecoveryPath), false, outcome.detail);
      const reportedPath = /manual recovery: (.+)$/.exec(outcome.detail ?? "")?.[1];
      assert.ok(mutationStage !== undefined && mutationStageIdentity !== undefined);
      assert.equal(reportedPath, mutationStage);
      const retainedStage = lstatSync(reportedPath);
      assert.equal(retainedStage.dev, mutationStageIdentity.dev);
      assert.equal(retainedStage.ino, mutationStageIdentity.ino);
      assert.doesNotMatch(outcome.detail ?? "", new RegExp(secret));
      assert.doesNotMatch(outcome.detail ?? "", /fake-original-secret/);
      assert.equal(originalIdentity.ino, originalRecoveryIdentity.ino);
    });
  }
});

test("two simultaneous staged configures preserve one exact winner", async (t) => {
  const setup = fixture(t, { keep: true, mcpServers: {} });
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const makeRunner = () => new FakeClaudeRunner(async (call) => {
    const transformed = transformStage(call);
    waiting += 1;
    if (waiting === 2) release();
    await gate;
    return transformed;
  });
  const first = createClaudeCodeAdapter(adapterDependencies(setup, makeRunner()));
  const second = createClaudeCodeAdapter(adapterDependencies(setup, makeRunner()));

  const outcomes = await Promise.all([
    first.configure(registration, false),
    second.configure(registration, false),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "configured").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "failed").length, 1);
  const stored = JSON.parse(readFileSync(setup.configPath, "utf8")) as { mcpServers: { rocky: unknown } };
  assert.deepEqual(stored.mcpServers.rocky, rockyEntry());
});

test("post-audit stage topology change blocks publication and reports only retained stage", async (t) => {
  const setup = fixture(t, { keep: true, mcpServers: {} });
  const before = readFileSync(setup.configPath);
  let stage: string | undefined;
  const runner = new FakeClaudeRunner((call) => {
    stage = stagePath(call);
    return transformStage(call);
  });
  const unrelatedRecovery = join(setup.root, "unrelated-recovery");
  const transactions: ClaudeFileTransactions = {
    inspect: () => ({ status: "clear" }),
    recover: () => ({ status: "clear" }),
    write: (_path, _bytes, _prior, guard) => {
      assert.ok(stage !== undefined);
      writeFileSync(join(stage, "late-attacker-entry"), "keep attacker\n");
      assert.equal(guard?.unchanged(), false);
      return { status: "changed", recoveryPath: unrelatedRecovery };
    },
  };

  const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
    fileTransactions: transactions,
  })).configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.ok(stage !== undefined);
  assert.equal(configured.detail, `Claude Code config changed before publication; manual recovery: ${stage}`);
  assert.doesNotMatch(configured.detail, new RegExp(unrelatedRecovery));
  assert.deepEqual(readFileSync(join(stage, "late-attacker-entry"), "utf8"), "keep attacker\n");
  assert.deepEqual(readFileSync(setup.configPath), before);
});

test("post-publication failure reports neither an unproved recovery path nor a rebound stage", async (t) => {
  const setup = fixture(t, { keep: true, mcpServers: {} });
  const recoveryPath = join(setup.root, "live-task1-recovery");
  writeFileSync(recoveryPath, readFileSync(setup.configPath));
  let stage: string | undefined;
  const runner = new FakeClaudeRunner((call) => {
    stage = stagePath(call);
    return transformStage(call);
  });
  const transactions: ClaudeFileTransactions = {
    inspect: () => ({ status: "clear" }),
    recover: () => ({ status: "clear" }),
    write: (path, bytes, prior, guard) => {
      assert.equal(guard?.unchanged(), true);
      writeFileSync(path, bytes, { mode: prior.status === "valid" ? prior.mode : 0o600 });
      if (prior.status === "valid" && prior.mode !== undefined) chmodSync(path, prior.mode);
      assert.ok(stage !== undefined);
      renameSync(stage, `${stage}-owned`);
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, "attacker-sentinel"), "keep attacker\n");
      return { status: "written", recoveryPath };
    },
  };

  const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
    fileTransactions: transactions,
  })).configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.ok(stage !== undefined);
  assert.equal((configured.detail ?? "").includes(recoveryPath), false);
  assert.equal((configured.detail ?? "").includes(stage), false);
  assert.doesNotMatch(configured.detail ?? "", /manual recovery:/i);
  assert.equal(readFileSync(join(stage, "attacker-sentinel"), "utf8"), "keep attacker\n");
});

test("pending transactions are inspected or recovered before target interpretation", async (t) => {
  await t.test("read-only pending", async (st) => {
    const setup = fixture(st, { mcpServers: { rocky: rockyEntry() } });
    const transaction = writeLegacyTransaction(setup.configPath, "published", readFileSync(setup.configPath));
    const runner = new FakeClaudeRunner();
    const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner));

    assert.equal((await adapter.inspect(registration)).state, "unreadable");
    assert.equal((await adapter.check(registration)).status, "failed");
    assert.deepEqual(runner.calls, []);
    assert.equal(existsSync(transaction), true);
  });

  for (const recoveryPath of [join(tmpdir(), "authoritative-pending-recovery"), undefined]) {
    await t.test(`injected pending ${recoveryPath === undefined ? "without" : "with"} path`, async (st) => {
      const setup = fixture(st, { mcpServers: { rocky: rockyEntry() } });
      const transactions: ClaudeFileTransactions = {
        inspect: () => ({ status: "pending", ...(recoveryPath === undefined ? {} : { recoveryPath }) }),
        recover: () => ({ status: "clear" }),
        write: () => { throw new Error("must not write"); },
      };
      const adapter = createClaudeCodeAdapter(adapterDependencies(setup, new FakeClaudeRunner(), {
        fileTransactions: transactions,
      }));

      const inspected = await adapter.inspect(registration);
      const checked = await adapter.check(registration);
      assert.equal(inspected.state, "unreadable");
      assert.equal(checked.status, "failed");
      if (recoveryPath === undefined) {
        assert.doesNotMatch(inspected.detail ?? "", /manual recovery:/i);
        assert.doesNotMatch(checked.detail ?? "", /manual recovery:/i);
      } else {
        assert.ok((inspected.detail ?? "").includes(recoveryPath));
        assert.ok((checked.detail ?? "").includes(recoveryPath));
      }
    });
  }

  await t.test("recovered stops for retry", async (st) => {
    const setup = fixture(st, { mcpServers: {} });
    writeLegacyTransaction(setup.configPath, "prepared");
    const runner = new FakeClaudeRunner();
    const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /retry/i);
    assert.deepEqual(runner.calls, []);
  });

  await t.test("ambiguous reports only authoritative path", async (st) => {
    const setup = fixture(st, { mcpServers: {} });
    const transaction = writeLegacyTransaction(setup.configPath, "published", readFileSync(setup.configPath));
    const configured = await createClaudeCodeAdapter(adapterDependencies(setup, new FakeClaudeRunner()))
      .configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.ok((configured.detail ?? "").includes(transaction));
    assert.doesNotMatch(configured.detail ?? "", /mcpServers|fake-secret/);
  });
});

test("transaction result discriminants and post-write mismatch never overclaim success", async (t) => {
  for (const transactionStatus of ["changed", "recovery-required"] as const) {
    await t.test(transactionStatus, async (st) => {
      const setup = fixture(st, { keep: true, mcpServers: {} });
      const before = readFileSync(setup.configPath);
      const recoveryPath = join(setup.root, `${transactionStatus}-recovery`);
      writeFileSync(recoveryPath, before);
      let stage: string | undefined;
      const transactions: ClaudeFileTransactions = {
        inspect: () => ({ status: "clear" }),
        recover: () => ({ status: "clear" }),
        write: (_path, _bytes, _prior, guard) => {
          assert.equal(guard?.unchanged(), true);
          return { status: transactionStatus, recoveryPath };
        },
      };
      const runner = new FakeClaudeRunner((call) => {
        stage = stagePath(call);
        return transformStage(call);
      });
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        fileTransactions: transactions,
      })).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.ok(stage !== undefined);
      assert.equal((configured.detail ?? "").includes(recoveryPath), false);
      assert.equal(/manual recovery: (.+)$/.exec(configured.detail ?? "")?.[1], stage);
      assert.deepEqual(readFileSync(setup.configPath), before);
    });
  }

  await t.test("post-write mismatch", async (st) => {
    const setup = fixture(st, { keep: true, mcpServers: {} });
    const runner = new FakeClaudeRunner((call) => transformStage(call));
    const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
      lifecycle: {
        afterPublish(path) {
          writeFileSync(path, '{"concurrent":"post-write-secret"}\n');
        },
      },
    })).configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /recovery|verify/i);
    assert.doesNotMatch(configured.detail ?? "", /post-write-secret/);
  });

  await t.test("post-write mode mismatch", async (st) => {
    const setup = fixture(st, { keep: true, mcpServers: {} });
    const recoveryPath = join(setup.root, "mode-recovery");
    const transactions: ClaudeFileTransactions = {
      inspect: () => ({ status: "clear" }),
      recover: () => ({ status: "clear" }),
      write: (path, bytes, _prior, guard) => {
        assert.equal(guard?.unchanged(), true);
        writeFileSync(path, bytes, { mode: 0o600 });
        chmodSync(path, 0o600);
        writeFileSync(recoveryPath, "recovery\n");
        return { status: "written", recoveryPath };
      },
    };
    const configured = await createClaudeCodeAdapter(adapterDependencies(
      setup,
      new FakeClaudeRunner((call) => transformStage(call)),
      { fileTransactions: transactions },
    )).configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /verif/i);
    assert.equal(statSync(setup.configPath).mode & 0o777, 0o600);
  });
});

test("unsafe target topology and malformed shapes are untouched and secret-free", async (t) => {
  const cases = ["symlink", "hard-link", "directory", "malformed", "array", "servers-array"] as const;
  for (const entry of cases) {
    await t.test(entry, async (st) => {
      const setup = fixture(st);
      const target = join(setup.root, "target.json");
      if (entry === "symlink" || entry === "hard-link") {
        writeFileSync(target, '{"secret":"topology-secret"}\n');
        if (entry === "symlink") symlinkSync(target, setup.configPath);
        else linkSync(target, setup.configPath);
      } else if (entry === "directory") mkdirSync(setup.configPath);
      else if (entry === "malformed") writeFileSync(setup.configPath, '{"secret":"malformed-secret"');
      else if (entry === "array") writeFileSync(setup.configPath, '["array-secret"]\n');
      else writeFileSync(setup.configPath, '{"mcpServers":["servers-secret"]}\n');
      const before = entry === "directory" ? undefined : readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner();
      const adapter = createClaudeCodeAdapter(adapterDependencies(setup, runner));

      assert.equal((await adapter.inspect(registration)).state, "unreadable");
      const configured = await adapter.configure(registration, true);
      assert.equal(configured.status, "failed");
      assert.deepEqual(runner.calls, []);
      assert.doesNotMatch(configured.detail ?? "", /topology-secret|malformed-secret|array-secret|servers-secret/);
      if (before !== undefined) assert.deepEqual(readFileSync(setup.configPath), before);
      else assert.equal(lstatSync(setup.configPath).isDirectory(), true);
    });
  }
});

test("known staged policy refusal is blocked but ordinary output is a secret-free failure", async (t) => {
  for (const entry of [
    { stderr: "enterprise policy denied fake-policy-secret", status: "blocked-by-policy", error: undefined, childStatus: 1 },
    { stderr: "ordinary failure fake-process-secret", status: "failed", error: undefined, childStatus: 1 },
    { stderr: "enterprise policy denied", status: "failed", error: undefined, childStatus: 2 },
    { stderr: "", status: "failed", error: new Error("Operation not allowed"), childStatus: null },
    { stderr: "enterprise policy denied", status: "failed", error: new Error("process timeout"), childStatus: null },
  ]) {
    await t.test(entry.status, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      const before = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner(() => result(
        entry.childStatus,
        "",
        entry.stderr,
        entry.error,
      ));
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner))
        .configure(registration, false);

      assert.equal(configured.status, entry.status);
      assert.deepEqual(readFileSync(setup.configPath), before);
      assert.doesNotMatch(configured.detail ?? "", /fake-policy-secret|fake-process-secret/);
      assert.match(configured.detail ?? "", /manual recovery: /);
      const retainedStage = /manual recovery: (.+)$/.exec(configured.detail ?? "")?.[1];
      assert.ok(retainedStage !== undefined);
      assert.deepEqual(readFileSync(join(retainedStage, ".claude.json")), before);
      assert.deepEqual(configured.manualRegistration, registration);
    });
  }
});

test("production-incomplete owned removal returns remove-specific guidance without add payload", async (t) => {
  const setup = fixture(t, { mcpServers: { rocky: rockyEntry() } });
  const runner = new FakeClaudeRunner(() => { throw new Error("must not run"); });
  const removed = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
    policyManifest: { ...completeManifest(), complete: false },
  })).remove(registration);

  assert.equal(removed.status, "failed");
  assert.match(removed.detail ?? "", /remove/i);
  assert.doesNotMatch(removed.detail ?? "", /registration|\badd\b/i);
  assert.equal(removed.manualRegistration, undefined);
  assert.deepEqual(runner.calls, []);
});
