import test from "node:test";
import assert from "node:assert/strict";
import {
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
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import type { McpRegistration } from "../setup/clients.js";
import {
  createClaudeCodeAdapter,
  resolveClaudeCodeUserConfig,
  type ClaudeFileTransactions,
  type ClaudePolicyManifest,
} from "../setup/claude-code.js";
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

function result(status: number, stdout = "", stderr = "", error?: Error): ProcessResult {
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

function writeBackup(stage: string, before: Buffer, mode: number): void {
  const backups = join(stage, "backups");
  if (existsSync(backups)) return;
  mkdirSync(backups, { mode: 0o755 });
  const backup = join(backups, `.claude.json.backup.${Date.now()}`);
  writeFileSync(backup, before, { mode });
  chmodSync(backup, mode);
}

function transformStage(
  call: RunnerCall,
  options: {
    backup?: "exact" | "missing" | "mismatch" | "extra";
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
    writeBackup(stage, backupBytes, mode);
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
      assert.deepEqual(readdirSync(setup.stageRoot), []);
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
  assert.doesNotMatch(configured.detail ?? "", /dark|https:\/\/local/);
  assert.deepEqual(readdirSync(setup.stageRoot), []);
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
      assert.deepEqual(readdirSync(setup.stageRoot), []);
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

test("stage symlink hard-link and rebound attacks are refused without deleting attacker state", async (t) => {
  for (const attack of ["symlink", "hard-link", "rebound"] as const) {
    await t.test(attack, async (st) => {
      const setup = fixture(st, { keep: true, mcpServers: {} });
      const before = readFileSync(setup.configPath);
      let sentinel: string | undefined;
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
          const displaced = `${stage}-owned`;
          renameSync(stage, displaced);
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
  assert.equal(configured.detail, `Claude Code stage cleanup requires manual recovery: ${stage}`);
  assert.doesNotMatch(configured.detail, new RegExp(unrelatedRecovery));
  assert.deepEqual(readFileSync(join(stage, "late-attacker-entry"), "utf8"), "keep attacker\n");
  assert.deepEqual(readFileSync(setup.configPath), before);
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
      const transactions: ClaudeFileTransactions = {
        inspect: () => ({ status: "clear" }),
        recover: () => ({ status: "clear" }),
        write: (_path, _bytes, _prior, guard) => {
          assert.equal(guard?.unchanged(), true);
          return { status: transactionStatus, recoveryPath };
        },
      };
      const runner = new FakeClaudeRunner((call) => transformStage(call));
      const configured = await createClaudeCodeAdapter(adapterDependencies(setup, runner, {
        fileTransactions: transactions,
      })).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.ok((configured.detail ?? "").includes(recoveryPath));
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
    { stderr: "enterprise policy denied fake-policy-secret", status: "blocked-by-policy" },
    { stderr: "ordinary failure fake-process-secret", status: "failed" },
  ]) {
    await t.test(entry.status, async (st) => {
      const setup = fixture(st, { mcpServers: {} });
      const before = readFileSync(setup.configPath);
      const runner = new FakeClaudeRunner(() => result(1, "", entry.stderr));
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
