import { resolve } from "node:path";
import {
  parseNameOnlyZero,
  parsePrePushStdin,
  parseUnifiedZeroDiffChecked,
  rangeForPush,
  type AddedLine,
  type PushRange,
} from "../check/diff.js";
import {
  filterCheckable,
  newDependencyNames,
  parseLockfilePackageKeys,
  type NewDep,
} from "../check/deps.js";
import { installPrePush } from "../check/pre-push.js";
import { hasFreshAgentEvidence, missingWhyPaths, whyNudgeLine } from "../check/why-coverage.js";
import { loadMemory } from "../core/memory-read.js";
import { checkPackages } from "../check/registry.js";
import { riskiestLine } from "../check/risk.js";
import { scanSecrets } from "../check/secrets.js";
import { loadConfig, setCheckRegistry } from "../core/config.js";
import { runGit, type GitResult } from "../core/exec.js";
import { recordNote } from "../core/memory.js";
import {
  renderClarityCard,
  scorePrompt,
  type ClarityResult,
} from "../core/prompt-clarity.js";
import {
  DECOMPOSE_SAY_BLANK,
  DECOMPOSE_SAY_FILLED,
  decomposeFilesFromDiff,
  decomposeNudgeLine,
  renderDecomposeCard,
} from "../core/decompose.js";
import { resolveGitDiff } from "../core/git-diff.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";
import { createTtyPromptPort } from "../setup/prompt.js";
import { detail, phrase, prompt as rockyPrompt, say } from "../ui/rocky.js";

const MAX_LINES = 20_000;
const MAX_PACKAGES = 50;
const PROMPT_TIMEOUT_MS = 30_000;
const PROMPT_STDIN_CAP_BYTES = 2 * 1024 * 1024;
const CHECK_PROMPT_USAGE = 'rocky check --prompt "<text>" [--stdin] [--quiet]';
const CHECK_DECOMPOSE_USAGE = "rocky check --decompose [--quiet]";
const GIT_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 5_000;
const MAX_READ_BYTES = 1024 * 1024;

interface DiffRange {
  base: string;
  head: string;
}

interface CheckState {
  finding: boolean;
  prePush: boolean;
  /** Git scope was established before any scan result was classified. */
  scope: "unavailable" | "established";
  /** A stage could not run, so part of the range went uninspected. */
  incomplete: boolean;
}

/** The only four externally meaningful results of a hull scan. */
type ScanResult = "clean" | "finding" | "incomplete" | "finding-plus-incomplete";

interface PackageCandidate {
  dep: NewDep;
  head: string;
}

function findingExit(state: CheckState): number {
  if (!state.finding) return 0;
  return state.prePush ? 3 : 1;
}

function scanResult(state: CheckState): ScanResult {
  const incomplete = state.incomplete || state.scope !== "established";
  if (state.finding && incomplete) return "finding-plus-incomplete";
  if (state.finding) return "finding";
  if (incomplete) return "incomplete";
  return "clean";
}

function incompleteDetail(message: string): void {
  // Keep this on the stage's one diagnostic line. Pre-push must fail open, but
  // its success status can never be mistaken for a complete clean scan.
  detail(`${message}; INCOMPLETE: no clean result`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(state: CheckState, stage: string, error: unknown): void {
  // Printing is not enough: a stage that could not run means this range was
  // never fully inspected, and the exit code has to be able to say so.
  state.incomplete = true;
  incompleteDetail(`rocky check ${stage} could not run: ${errorMessage(error)}`);
}

interface GitReadOptions {
  maxOutputBytes?: number | false;
  notInspected?: string;
}

function checkGitResult(result: GitResult, args: readonly string[], options: GitReadOptions): void {
  const command = args[0] ?? "command";
  const skipped = options.notInspected ?? "check data";
  if (result.timedOut) throw new Error(`git ${command} timed out after 5 seconds; ${skipped} not inspected`);
  if (result.outputLimitExceeded) throw new Error(`git ${command} output exceeded 1 MB; ${skipped} not inspected`);
}

async function git(args: readonly string[], input?: string, options: GitReadOptions = {}): Promise<string> {
  const result = await gitMaybe(args, input, options);
  if (result.code !== 0) throw new Error(`git ${args[0] ?? "command"} failed`);
  return result.stdout;
}

async function gitMaybe(
  args: readonly string[],
  input?: string,
  options: GitReadOptions = {},
): Promise<GitResult> {
  const result = await runGit(
    ["-c", "core.quotePath=false", ...args],
    input,
    {
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes === false
        ? undefined
        : (options.maxOutputBytes ?? MAX_READ_BYTES),
    },
  );
  checkGitResult(result, args, options);
  return result;
}

export async function readCheckInput(
  input: NodeJS.ReadableStream = process.stdin,
  timeoutMs = READ_TIMEOUT_MS,
  maxBytes = MAX_READ_BYTES,
): Promise<string> {
  return new Promise((resolveInput, rejectInput) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (error !== undefined) rejectInput(error);
      else resolveInput(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (buffer.length > remaining) {
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        input.pause();
        finish(new Error("pre-push input exceeded 1 MB; ref updates not inspected"));
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => {
      input.pause();
      finish(new Error("pre-push input timed out after 5 seconds; ref updates not inspected"));
    }, timeoutMs);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

async function emptyTree(): Promise<string> {
  return (await git(["hash-object", "-t", "tree", "--stdin"], "")).trim();
}

async function resolveNewRef(head: string): Promise<DiffRange> {
  const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/remotes/"]))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.endsWith("/HEAD"));
  let nearest: { base: string; distance: number } | undefined;
  for (const ref of refs) {
    const merged = await gitMaybe(["merge-base", head, ref]);
    const base = merged.stdout.trim().split(/\r?\n/)[0];
    if (merged.code === 1) continue;
    if (merged.code !== 0 || !base) {
      throw new Error(`git merge-base failed with exit ${merged.code}`);
    }
    const counted = await gitMaybe(["rev-list", "--count", `${base}..${head}`]);
    if (counted.code !== 0) throw new Error(`git rev-list failed with exit ${counted.code}`);
    const distance = Number(counted.stdout.trim());
    if (Number.isFinite(distance)
      && (nearest === undefined || distance < nearest.distance)) {
      nearest = { base, distance };
    }
  }
  if (nearest !== undefined) return { base: nearest.base, head };
  return { base: await emptyTree(), head };
}

async function pushRanges(state: CheckState): Promise<DiffRange[]> {
  const repo = await gitMaybe(["rev-parse", "--git-dir"]);
  requireGitScope(repo);
  state.scope = "established";
  const ranges: DiffRange[] = [];
  for (const ref of parsePrePushStdin(await readCheckInput())) {
    const range = rangeForPush(ref);
    if (range === null) continue;
    if (range.kind === "new-ref") {
      try {
        ranges.push(await resolveNewRef(range.head));
      } catch (error) {
        state.incomplete = true;
        incompleteDetail(`ref ${ref.localRef} not inspected by secret or package stages: ${errorMessage(error)}`);
      }
    } else {
      ranges.push({ base: range.base, head: range.head });
    }
  }
  return ranges;
}

function gitScopeFailure(result: GitResult): string {
  if (result.code === 127 && /(?:ENOENT|not found|spawn)/i.test(result.stderr)) {
    return "git scope unavailable: git executable could not start; no workspace inspected";
  }
  if (/not a git repository/i.test(result.stderr)) {
    return "git scope unavailable: no git repository here; no workspace inspected";
  }
  return "git scope unavailable: git could not establish repository scope; no workspace inspected";
}

function requireGitScope(result: GitResult): void {
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(gitScopeFailure(result));
  }
}

async function manualRange(): Promise<DiffRange> {
  const repo = await gitMaybe(["rev-parse", "--git-dir"]);
  requireGitScope(repo);
  const upstream = await gitMaybe(["rev-parse", "--verify", "@{upstream}"]);
  if (upstream.code === 0) return { base: "@{upstream}", head: "HEAD" };
  return { base: await emptyTree(), head: "HEAD" };
}

async function addedLines(ranges: readonly DiffRange[], quiet: boolean, state: CheckState): Promise<AddedLine[]> {
  const added: AddedLine[] = [];
  let total = 0;
  for (const range of ranges) {
    let rangeAdded: AddedLine[];
    try {
      const diff = await git([
        "diff", "--unified=0", "--no-color", "--no-ext-diff",
        range.base, range.head, "--",
      ], undefined, { maxOutputBytes: MAX_READ_BYTES, notInspected: "secret lines" });
      const parsed = await parseUnifiedZeroDiffChecked(diff);
      if (!parsed.complete) {
        throw new Error("git diff output was malformed or ambiguous; secret lines not inspected");
      }
      rangeAdded = parsed.added;
    } catch (error) {
      reportFailure(state, "secret scan", error);
      continue;
    }
    total += rangeAdded.length;
    const remaining = Math.max(0, MAX_LINES - added.length);
    const checked = rangeAdded.slice(0, remaining);
    added.push(...checked);
    try {
      announceSecretFindings(checked, quiet, state);
    } catch (error) {
      reportFailure(state, "secret scan", error);
    }
  }
  if (total > MAX_LINES) {
    state.incomplete = true;
    incompleteDetail(
      `added-line limit: ${total} found; first ${MAX_LINES} checked, ${total - MAX_LINES} skipped`,
    );
  }
  return added;
}

function isPackageJson(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

async function showFile(rev: string, path: string): Promise<string | null> {
  const listed = await gitMaybe(
    ["ls-tree", "-z", "--name-only", "--full-tree", rev, "--", `:(literal)${path}`],
    undefined,
    { maxOutputBytes: MAX_READ_BYTES, notInspected: "package files" },
  );
  if (listed.code !== 0) {
    throw new Error(`git ls-tree failed with exit ${listed.code}; package files not inspected`);
  }
  let listedPaths: string[];
  try {
    listedPaths = parseNameOnlyZero(listed.stdout);
  } catch {
    throw new Error("git ls-tree output was malformed or ambiguous; package files not inspected");
  }
  if (listedPaths.length === 0) return null;
  if (listedPaths.length !== 1 || listedPaths[0] !== path) {
    throw new Error("git ls-tree output did not match requested package path; package files not inspected");
  }
  const result = await gitMaybe(
    ["show", `${rev}:${path}`],
    undefined,
    { maxOutputBytes: MAX_READ_BYTES, notInspected: "package files" },
  );
  if (result.code !== 0) throw new Error(`git show failed with exit ${result.code}; package files not inspected`);
  return result.stdout;
}

async function packageCandidates(ranges: readonly DiffRange[], state: CheckState): Promise<PackageCandidate[]> {
  const candidates: PackageCandidate[] = [];
  for (const range of ranges) {
    try {
      const output = await git(
        ["diff", "--name-only", "-z", range.base, range.head, "--"],
        undefined,
        { maxOutputBytes: MAX_READ_BYTES, notInspected: "package paths" },
      );
      let paths: string[];
      try {
        paths = parseNameOnlyZero(output);
      } catch {
        throw new Error("git diff package-path output was malformed or ambiguous; package paths not inspected");
      }
      const packagePaths = paths.filter(isPackageJson);
      for (const path of packagePaths) {
        const before = await showFile(range.base, path);
        const after = await showFile(range.head, path);
        const dependencies = newDependencyNames(before, after);
        if (dependencies === null) {
          state.incomplete = true;
          incompleteDetail(`package check skipped for ${path}: old manifest is malformed`);
          continue;
        }
        for (const dep of dependencies) candidates.push({ dep, head: range.head });
      }
    } catch (error) {
      reportFailure(state, "package scan", error);
    }
  }
  return candidates;
}

async function checkablePackageNames(ranges: readonly DiffRange[], state: CheckState): Promise<string[]> {
  const candidates = await packageCandidates(ranges, state);
  const byHead = new Map<string, NewDep[]>();
  for (const candidate of candidates) {
    const deps = byHead.get(candidate.head) ?? [];
    deps.push(candidate.dep);
    byHead.set(candidate.head, deps);
  }

  const names = new Set<string>();
  for (const [head, deps] of byHead) {
    try {
      const npmrc = await showFile(head, ".npmrc");
      const lockfile = await showFile(head, "package-lock.json");
      const filtered = filterCheckable(deps, {
        npmrc,
        lockfilePackageKeys: parseLockfilePackageKeys(lockfile),
      });
      for (const name of filtered.check) names.add(name);
    } catch (error) {
      reportFailure(state, "package scan", error);
    }
  }
  return [...names];
}

export async function registryConsent(
  quiet: boolean,
  installation = false,
  promptFactory: typeof createTtyPromptPort = createTtyPromptPort,
): Promise<boolean> {
  const loaded = loadConfig();
  if (loaded.status === "invalid") throw new Error(`invalid config at ${loaded.path}`);
  if (loaded.config.check !== undefined) return loaded.config.check.registry;
  if (quiet && !installation) return false;
  const prompt = promptFactory();
  if (prompt === undefined) return false;
  const answer = await prompt.ask(rockyPrompt(phrase("check-registry-consent")), PROMPT_TIMEOUT_MS);
  if (answer === undefined) return false;
  const normalized = answer.trim().toLowerCase();
  const enabled = normalized === "y" || normalized === "yes";
  setCheckRegistry(enabled);
  return enabled;
}

function announceSecretFindings(lines: readonly AddedLine[], quiet: boolean, state: CheckState): void {
  const hits = scanSecrets([...lines]);
  if (hits.length === 0) return;
  state.finding = true;
  if (!quiet) say(phrase("check-secret"));
  for (const hit of hits) detail(`${hit.file}:${hit.line} — ${hit.kind}`);
}

async function packageStage(
  ranges: readonly DiffRange[],
  offline: boolean,
  quiet: boolean,
  state: CheckState,
): Promise<void> {
  const names = await checkablePackageNames(ranges, state);
  const capped = names.length > MAX_PACKAGES;
  if (capped) {
    state.incomplete = true;
  }
  if (offline || names.length === 0 || !(await registryConsent(quiet))) {
    if (capped) {
      incompleteDetail(
        `package limit: ${names.length} found; first ${MAX_PACKAGES} eligible, ${names.length - MAX_PACKAGES} skipped`,
      );
    }
    return;
  }
  if (capped) {
    incompleteDetail(
      `package limit: ${names.length} found; first ${MAX_PACKAGES} checked, ${names.length - MAX_PACKAGES} skipped`,
    );
  }
  const result = await checkPackages(names.slice(0, MAX_PACKAGES));
  if (result.unreachable.length > 0) {
    state.incomplete = true;
    incompleteDetail(`registry unreachable for: ${result.unreachable.join(", ")}; check stays fail-open`);
  }
  if (result.missing.length === 0) return;
  state.finding = true;
  if (!quiet) say(phrase("check-package-missing"));
  for (const name of result.missing) detail(name);
}

async function maybeAskComprehension(lines: readonly AddedLine[], ranges: readonly DiffRange[]): Promise<void> {
  const risky = riskiestLine([...lines]);
  if (risky === undefined) return;
  const prompt = createTtyPromptPort();
  if (prompt === undefined) return;
  say(phrase("check-comprehension"));
  detail(`${risky.file}:${risky.line}  ${risky.text.trim().slice(0, 200)}`);
  const answer = await prompt.ask(rockyPrompt(phrase("check-answer")), PROMPT_TIMEOUT_MS);
  if (answer === undefined || answer.trim() === "") return;
  recordNote({
    cwd: process.cwd(),
    cmd: ranges.map(({ base, head }) => `${base} ${head}`).join(", "),
    file: risky.file,
    line: risky.line,
    subject: risky.text.trim().slice(0, 200),
    answer: answer.trim(),
  });
}

async function installHookFlow(quiet: boolean): Promise<number> {
  const reportedPath = (await git(["rev-parse", "--git-path", "hooks/pre-push"])).trim();
  const hookPath = resolve(process.cwd(), reportedPath);
  const result = installPrePush(hookPath);
  detail(result.detail);
  if (result.recoveryPath !== undefined && !result.detail.includes(result.recoveryPath)) {
    detail(`recovery path: ${result.recoveryPath}`);
  }
  try {
    await registryConsent(quiet, true);
  } catch (error) {
    // Installing a hook inspects nothing, so a failed consent prompt here is
    // not an incomplete scan — it only means the answer is still unrecorded.
    detail(`rocky check registry consent could not run: ${errorMessage(error)}`);
  }
  return result.status === "refused" ? 1 : 0;
}

export interface PromptRequest {
  prompt?: string;
  stdin: boolean;
  rest: string[];
}

/**
 * Pull `--prompt <text>` / `--prompt=<text>` and `--stdin` out of one
 * `check` invocation, leaving everything else as rest. A `--prompt` with
 * a missing or flag-shaped value is a usage error, not a silent default —
 * scoring the wrong text would be worse than refusing.
 */
export function parsePromptRequest(args: readonly string[]): PromptRequest {
  let prompt: string | undefined;
  let stdin = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--prompt") {
      const value = args[i + 1];
      if (prompt !== undefined) throw new CliUsageError("unexpected option: --prompt", CHECK_PROMPT_USAGE);
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("rocky check --prompt needs text", CHECK_PROMPT_USAGE);
      }
      prompt = value;
      i += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--prompt=")) {
      if (prompt !== undefined) throw new CliUsageError("unexpected option: --prompt", CHECK_PROMPT_USAGE);
      prompt = arg.slice("--prompt=".length);
      continue;
    }
    if (arg === "--stdin") {
      if (stdin) throw new CliUsageError("unexpected option: --stdin", CHECK_PROMPT_USAGE);
      stdin = true;
      continue;
    }
    if (arg !== undefined) rest.push(arg);
  }
  return { ...(prompt === undefined ? {} : { prompt }), stdin, rest };
}

export interface DecomposeRequest {
  decompose: boolean;
  rest: string[];
}

/**
 * Pull `--decompose` out of one `check` invocation, leaving everything else
 * as rest. Same shape as `parsePromptRequest`: a repeated flag is a usage
 * error (exit 2), never a silent default.
 */
export function parseDecomposeRequest(args: readonly string[]): DecomposeRequest {
  let decompose = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--decompose") {
      if (decompose) throw new CliUsageError("unexpected option: --decompose", CHECK_DECOMPOSE_USAGE);
      decompose = true;
      continue;
    }
    if (arg !== undefined) rest.push(arg);
  }
  return { decompose, rest };
}

/**
 * Read prompt text from stdin for `check --stdin`, bounded. Same 2 MB cap
 * pattern as teach: a truncated or unreadable stream still scores whatever
 * arrived, and scoring never leaves this command with a non-zero exit.
 */
async function readPromptStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.byteLength;
      if (total > PROMPT_STDIN_CAP_BYTES) break;
      chunks.push(buffer);
    }
  } catch {
    // A stdin stream error must not throw out of prompt scoring.
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Advisory prompt-clarity scoring: deterministic, local, no model. Always
 * exits 0 — a vague prompt is a nudge, never a finding.
 */
async function runPromptMode(request: PromptRequest): Promise<number> {
  const positional = request.rest.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 0) throw new CliUsageError(`unexpected argument: ${positional[0]}`, CHECK_PROMPT_USAGE);
  const flags = new Set(request.rest.filter((arg) => arg.startsWith("--")));
  const unknown = [...flags].filter((flag) => flag !== "--quiet" && flag !== "--help");
  if (unknown.length > 0) throw new CliUsageError(`unexpected option: ${unknown[0]}`, CHECK_PROMPT_USAGE);
  if (flags.has("--help")) {
    detail(`usage: ${CHECK_PROMPT_USAGE}`);
    detail("  scores prompt clarity locally, no model. always exits 0.");
    return 0;
  }
  let text = request.prompt ?? "";
  if (request.stdin) {
    if (process.stdin.isTTY === true) {
      throw new CliUsageError("--stdin needs piped input, not a terminal", CHECK_PROMPT_USAGE);
    }
    const piped = await readPromptStdin();
    text = text.length > 0 ? `${text}\n${piped}` : piped;
  }
  let result: ClarityResult;
  try {
    result = scorePrompt(text);
  } catch {
    result = scorePrompt("");
  }
  for (const line of renderClarityCard(result)) detail(line);
  if (!flags.has("--quiet")) {
    if (result.band === "clear") say("prompt clear. good good good.");
    else if (result.band === "needs-detail") say("prompt needs detail. say file and steps, question");
    else say("prompt vague. name file and change, question");
  }
  return 0;
}

/**
 * Advisory decomposition coach: deterministic 3-step template from the
 * staged working-tree diff, local only, no model. Always exits 0 — an
 * undecomposed change is a nudge, never a finding. Mirrors runPromptMode's
 * strict rest validation so a conflicting flag refuses with exit 2.
 */
async function runDecomposeMode(request: DecomposeRequest): Promise<number> {
  const positional = request.rest.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 0) throw new CliUsageError(`unexpected argument: ${positional[0]}`, CHECK_DECOMPOSE_USAGE);
  const flags = new Set(request.rest.filter((arg) => arg.startsWith("--")));
  const unknown = [...flags].filter((flag) => flag !== "--quiet" && flag !== "--help");
  if (unknown.length > 0) throw new CliUsageError(`unexpected option: ${unknown[0]}`, CHECK_DECOMPOSE_USAGE);
  if (flags.has("--help")) {
    detail(`usage: ${CHECK_DECOMPOSE_USAGE}`);
    detail("  splits staged change into behavior, fields, verify. local only, always exits 0.");
    return 0;
  }
  let files: string[] = [];
  try {
    // Bounded (32 KB, 5 s) and fail-open: outside a repo, on timeout, or on
    // truncation this answers undefined and the blank template below speaks.
    const resolved = resolveGitDiff({});
    const safe = resolved === undefined ? "" : redactSecretsAtBoundary(resolved.diff);
    files = decomposeFilesFromDiff(safe);
  } catch {
    files = [];
  }
  let card: string[];
  try {
    card = renderDecomposeCard(files);
  } catch {
    files = [];
    card = renderDecomposeCard([]);
  }
  for (const line of card) detail(line);
  if (!flags.has("--quiet")) {
    say(files.length === 0 ? DECOMPOSE_SAY_BLANK : DECOMPOSE_SAY_FILLED);
  }
  return 0;
}

const KNOWN_FLAGS = new Set(["--pre-push", "--install-hook", "--offline", "--quiet", "--help", "--prompt", "--stdin", "--decompose"]);

function usage(): number {
  detail("usage: rocky check [--pre-push] [--install-hook] [--offline] [--quiet]");
  detail("  (no flag)        check what you are about to push");
  detail("  --install-hook   run the check from a git pre-push hook");
  detail("  --offline        skip the registry lookup for this run");
  detail("  --quiet          plain facts only, no persona, no question");
  detail("  --pre-push       read ref updates from git on stdin (hook mode)");
  detail('  --prompt "<text>" score prompt clarity locally, no model, always exits 0');
  detail("  --stdin          read prompt text from stdin (2 MB cap), alone or after --prompt");
  detail("  --decompose      split staged change into behavior, fields, verify. local only, always exits 0");
  detail("  manual exits: 0 checked-clean, 1 finding, 2 Git scope or inspection incomplete");
  detail("  pre-push exits: 3 finding, 0 clean or fail-open incomplete (stderr says INCOMPLETE)");
  detail("env: ROCKY_NO_QUIZ=1 skips the comprehension question");
  return 0;
}

async function runCheck(rest: readonly string[], state: CheckState): Promise<number> {
  // Only arguments Rocky owns are parsed as flags. In hook mode git appends the
  // remote name and URL, and a remote may legitimately be called anything —
  // reading those as flags would let a repo named `--offline` disable the scan.
  const ownedArgs = state.prePush
    ? rest.slice(0, rest.indexOf("--pre-push") + 1)
    : rest;
  let promptRequest: PromptRequest;
  let decomposeRequest: DecomposeRequest;
  try {
    promptRequest = parsePromptRequest(ownedArgs);
    decomposeRequest = parseDecomposeRequest(promptRequest.rest);
    if (promptRequest.prompt !== undefined || promptRequest.stdin) {
      if (decomposeRequest.decompose) {
        throw new CliUsageError("unexpected option: --decompose", CHECK_DECOMPOSE_USAGE);
      }
      return await runPromptMode(promptRequest);
    }
    if (decomposeRequest.decompose) {
      return await runDecomposeMode(decomposeRequest);
    }
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
  const positional = decomposeRequest.rest.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 0) {
    say("check accepts flags only. bad bad.");
    detail(`unexpected: ${positional.join(", ")}`);
    usage();
    return 2;
  }
  const flags = new Set(decomposeRequest.rest.filter((arg) => arg.startsWith("--")));
  // An unrecognised flag must not silently degrade into a full check: someone
  // who typed it meant something Rocky did not do.
  const unknown = [...flags].filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) {
    say(phrase("check-unknown-flag"));
    detail(`unknown: ${unknown.join(", ")}`);
    usage();
    return 2;
  }
  if (flags.has("--help")) return usage();
  const quiet = flags.has("--quiet");
  if (flags.has("--install-hook")) return installHookFlow(quiet);

  const ranges = state.prePush ? await pushRanges(state) : [await manualRange()];
  if (!state.prePush) state.scope = "established";
  if (ranges.length === 0) return scanResult(state) === "incomplete" && !state.prePush ? 2 : findingExit(state);
  let lines: AddedLine[] = [];

  try {
    lines = await addedLines(ranges, quiet, state);
  } catch (error) {
    reportFailure(state, "secret scan", error);
  }

  try {
    await packageStage(ranges, flags.has("--offline"), quiet, state);
  } catch (error) {
    reportFailure(state, "package scan", error);
  }

  if (!quiet) {
    // Changesets-style why nudge: name changed files with no fresh stated
    // reason and the exact command that records one. Never a finding, never
    // an exit-code change, fail-open on any read error. Files with only
    // deletions carry no added lines and are not inspected here.
    try {
      const now = Date.now();
      const records = loadMemory(undefined, now);
      if (hasFreshAgentEvidence(records, now)) {
        const changed = [...new Set(lines.map((line) => line.file))];
        const nudge = whyNudgeLine(missingWhyPaths(changed, records, process.cwd(), now));
        if (nudge !== undefined) say(nudge);
      }
    } catch {
      /* deaf spot stays undisclosed rather than breaking check */
    }
    try {
      // Decomposition coach: one default line on a clean, complete pre-push
      // with outgoing lines. Never a finding, never an exit-code change,
      // fail-open on any error. Gated to clean plus complete so bounded-error
      // paths keep their single diagnostic line.
      if (state.prePush && !state.finding && !state.incomplete && lines.length > 0) {
        const nudge = decomposeNudgeLine();
        if (nudge !== undefined) say(nudge);
      }
    } catch {
      /* a lost nudge is better than a broken check */
    }
  }

  if (!quiet && process.env.ROCKY_NO_QUIZ !== "1") {
    try {
      await maybeAskComprehension(lines, ranges);
    } catch (error) {
      reportFailure(state, "comprehension prompt", error);
    }
  }

  const result = scanResult(state);
  if (result === "incomplete" && !state.prePush) return 2;
  return findingExit(state);
}

export async function check(rest: string[]): Promise<number> {
  const state: CheckState = {
    finding: false,
    prePush: rest.includes("--pre-push"),
    scope: "unavailable",
    incomplete: false,
  };
  try {
    return await runCheck(rest, state);
  } catch (error) {
    incompleteDetail(`rocky check could not run: ${errorMessage(error)}`);
    state.incomplete = true;
    // A finding already made is never erased by a later failure.
    if (state.finding) return findingExit(state);
    // Fail open only where a push is at stake. In hook mode exit 0 is the whole
    // point: a broken Rocky must not hold anyone's push. Run by hand there is no
    // push to protect, and exit 0 would tell a script "checked, clean" about a
    // run that inspected nothing — so an infrastructure failure exits 2, which
    // is neither clean nor a finding.
    return state.prePush ? 0 : 2;
  }
}
