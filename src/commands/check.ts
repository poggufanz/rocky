import { resolve } from "node:path";
import {
  parsePrePushStdin,
  parseUnifiedZeroDiff,
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
import { checkPackages } from "../check/registry.js";
import { riskiestLine } from "../check/risk.js";
import { scanSecrets } from "../check/secrets.js";
import { loadConfig, setCheckRegistry } from "../core/config.js";
import { runGit, type GitResult } from "../core/exec.js";
import { recordNote } from "../core/memory.js";
import { createTtyPromptPort } from "../setup/prompt.js";
import { detail, phrase, prompt as rockyPrompt, say } from "../ui/rocky.js";

const MAX_LINES = 20_000;
const MAX_PACKAGES = 50;
const PROMPT_TIMEOUT_MS = 30_000;
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
  /** A stage could not run, so part of the range went uninspected. */
  incomplete: boolean;
}

interface PackageCandidate {
  dep: NewDep;
  head: string;
}

function findingExit(state: CheckState): number {
  if (!state.finding) return 0;
  return state.prePush ? 3 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(state: CheckState, stage: string, error: unknown): void {
  // Printing is not enough: a stage that could not run means this range was
  // never fully inspected, and the exit code has to be able to say so.
  state.incomplete = true;
  detail(`rocky check ${stage} could not run: ${errorMessage(error)}`);
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

async function pushRanges(): Promise<DiffRange[]> {
  const ranges: DiffRange[] = [];
  for (const ref of parsePrePushStdin(await readCheckInput())) {
    const range = rangeForPush(ref);
    if (range === null) continue;
    if (range.kind === "new-ref") {
      try {
        ranges.push(await resolveNewRef(range.head));
      } catch (error) {
        detail(`ref ${ref.localRef} not inspected by secret or package stages: ${errorMessage(error)}`);
      }
    } else {
      ranges.push({ base: range.base, head: range.head });
    }
  }
  return ranges;
}

/** Thrown when there is simply nothing to inspect, as opposed to a failed attempt. */
class NothingToCheck extends Error {}

async function manualRange(): Promise<DiffRange> {
  const repo = await gitMaybe(["rev-parse", "--git-dir"]);
  if (repo.code !== 0) throw new NothingToCheck("no git repository here. nothing to check");
  const upstream = await gitMaybe(["rev-parse", "--verify", "@{upstream}"]);
  if (upstream.code === 0) return { base: "@{upstream}", head: "HEAD" };
  return { base: await emptyTree(), head: "HEAD" };
}

async function addedLines(ranges: readonly DiffRange[]): Promise<AddedLine[]> {
  const added: AddedLine[] = [];
  for (const range of ranges) {
    const diff = await git([
      "diff", "--unified=0", "--no-color", "--no-ext-diff",
      range.base, range.head, "--",
    ], undefined, { maxOutputBytes: MAX_READ_BYTES, notInspected: "secret lines" });
    added.push(...parseUnifiedZeroDiff(diff));
  }
  if (added.length > MAX_LINES) {
    detail(`added-line limit: ${added.length} found; first ${MAX_LINES} checked, ${added.length - MAX_LINES} not checked`);
    return added.slice(0, MAX_LINES);
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
  if (listed.stdout.length === 0) return null;
  const result = await gitMaybe(
    ["show", `${rev}:${path}`],
    undefined,
    { maxOutputBytes: MAX_READ_BYTES, notInspected: "package files" },
  );
  if (result.code !== 0) throw new Error(`git show failed with exit ${result.code}; package files not inspected`);
  return result.stdout;
}

async function packageCandidates(ranges: readonly DiffRange[]): Promise<PackageCandidate[]> {
  const candidates: PackageCandidate[] = [];
  for (const range of ranges) {
    const paths = (await git(
      ["diff", "--name-only", "-z", range.base, range.head, "--"],
      undefined,
      { maxOutputBytes: MAX_READ_BYTES, notInspected: "package paths" },
    ))
      .split("\0")
      .filter(isPackageJson);
    for (const path of paths) {
      const before = await showFile(range.base, path);
      const after = await showFile(range.head, path);
      const dependencies = newDependencyNames(before, after);
      if (dependencies === null) {
        detail(`package check skipped for ${path}: old manifest is malformed`);
        continue;
      }
      for (const dep of dependencies) candidates.push({ dep, head: range.head });
    }
  }
  return candidates;
}

async function checkablePackageNames(ranges: readonly DiffRange[]): Promise<string[]> {
  const candidates = await packageCandidates(ranges);
  const byHead = new Map<string, NewDep[]>();
  for (const candidate of candidates) {
    const deps = byHead.get(candidate.head) ?? [];
    deps.push(candidate.dep);
    byHead.set(candidate.head, deps);
  }

  const names = new Set<string>();
  for (const [head, deps] of byHead) {
    const npmrc = await showFile(head, ".npmrc");
    const lockfile = await showFile(head, "package-lock.json");
    const filtered = filterCheckable(deps, {
      npmrc,
      lockfilePackageKeys: parseLockfilePackageKeys(lockfile),
    });
    for (const name of filtered.check) names.add(name);
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
  const names = await checkablePackageNames(ranges);
  if (offline || names.length === 0 || !(await registryConsent(quiet))) return;
  if (names.length > MAX_PACKAGES) {
    detail(`package limit: ${names.length} found; first ${MAX_PACKAGES} checked, ${names.length - MAX_PACKAGES} not checked`);
  }
  const result = await checkPackages(names.slice(0, MAX_PACKAGES));
  if (result.unreachable.length > 0) {
    detail(`registry unreachable for: ${result.unreachable.join(", ")}; check stays fail-open`);
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

const KNOWN_FLAGS = new Set(["--pre-push", "--install-hook", "--offline", "--quiet", "--help"]);

function usage(): number {
  detail("usage: rocky check [--pre-push] [--install-hook] [--offline] [--quiet]");
  detail("  (no flag)        check what you are about to push");
  detail("  --install-hook   run the check from a git pre-push hook");
  detail("  --offline        skip the registry lookup for this run");
  detail("  --quiet          plain facts only, no persona, no question");
  detail("  --pre-push       read ref updates from git on stdin (hook mode)");
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
  const flags = new Set(ownedArgs.filter((arg) => arg.startsWith("--")));
  if (flags.has("--help")) return usage();
  // An unrecognised flag must not silently degrade into a full check: someone
  // who typed it meant something Rocky did not do.
  const unknown = [...flags].filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) {
    say(phrase("check-unknown-flag"));
    detail(`unknown: ${unknown.join(", ")}`);
    usage();
    return 2;
  }
  const quiet = flags.has("--quiet");
  if (flags.has("--install-hook")) return installHookFlow(quiet);

  const ranges = state.prePush ? await pushRanges() : [await manualRange()];
  if (ranges.length === 0) return 0;
  let lines: AddedLine[] = [];

  try {
    lines = await addedLines(ranges);
    announceSecretFindings(lines, quiet, state);
  } catch (error) {
    reportFailure(state, "secret scan", error);
  }

  try {
    await packageStage(ranges, flags.has("--offline"), quiet, state);
  } catch (error) {
    reportFailure(state, "package scan", error);
  }

  if (!quiet && process.env.ROCKY_NO_QUIZ !== "1") {
    try {
      await maybeAskComprehension(lines, ranges);
    } catch (error) {
      reportFailure(state, "comprehension prompt", error);
    }
  }

  if (!state.finding && state.incomplete && !state.prePush) return 2;
  return findingExit(state);
}

export async function check(rest: string[]): Promise<number> {
  const state: CheckState = { finding: false, prePush: rest.includes("--pre-push"), incomplete: false };
  try {
    return await runCheck(rest, state);
  } catch (error) {
    if (error instanceof NothingToCheck) {
      // Documented in the spec as exit 0: no repository means no range, which
      // is not the same as a check that was attempted and failed.
      detail(errorMessage(error));
      return findingExit(state);
    }
    detail(`rocky check could not run: ${errorMessage(error)}`);
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
