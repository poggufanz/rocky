import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeLine } from "../../../dist/core/fingerprint.js";
import {
  classifyTargetRuns,
  runMetrics,
  stripRockyLines,
  toolCalls,
} from "../evaluate.mjs";

const testDir = resolve(dirname(fileURLToPath(import.meta.url)));
const evalDir = resolve(testDir, "..");
const repoRoot = resolve(evalDir, "..", "..");
const fixturesDir = join(testDir, "fixtures");
const evaluateScript = join(evalDir, "evaluate.mjs");
const manifest = JSON.parse(readFileSync(join(evalDir, "tasks", "manifest.json"), "utf8"));

const PORT_TRAP = 'Error: port must be a number, got "80a"';
const PORT_TASK = {
  id: "T02",
  kind: "trap",
  fixture: "config-override",
  target: {
    command: "npm test",
    aliases: ["^npm (run )?test\\b", "^node test/run\\.mjs\\b"],
  },
  trapLine: PORT_TRAP,
  normalizedTrapLine: normalizeLine(PORT_TRAP),
  history: { wrong: ["wrong-1", "wrong-2"], fix: "fix" },
};

function readFixtureEvents(name) {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeRunDir(runJson, { advisories = null, rockyHomeFiles = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rocky-eval-metrics-"));
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`, "utf8");
  if (advisories !== null || rockyHomeFiles !== null) {
    const rockyHome = join(dir, "rocky-home");
    mkdirSync(rockyHome, { recursive: true });
    if (advisories !== null) {
      const body = advisories.map((row) => JSON.stringify(row)).join("\n");
      writeFileSync(join(rockyHome, "advisories.jsonl"), body ? `${body}\n` : "", "utf8");
    }
    if (rockyHomeFiles !== null) {
      for (const [name, content] of Object.entries(rockyHomeFiles)) {
        writeFileSync(join(rockyHome, name), content, "utf8");
      }
    }
  }
  return dir;
}

function buildShellEvents(steps, { cwd = "/eval/task", numTurns = steps.length, durationMs = 1000 } = {}) {
  const events = [{ type: "system", subtype: "init", cwd }];
  steps.forEach((step, idx) => {
    const id = `tu-${idx + 1}`;
    events.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name: step.name ?? "Bash",
            input: { command: step.command },
          },
        ],
      },
    });
    events.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: step.isError,
            content: step.output,
          },
        ],
      },
    });
  });
  events.push({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: numTurns,
    duration_ms: durationMs,
  });
  return events;
}

describe("classifyTargetRuns", () => {
  test("classifyTargetRuns covers wrapping, cd, pipes and aliases", () => {
    const rows = [
      { command: 'rocky run "npm test"', isError: true, hasTrap: true, expected: "trap_fail" },
      { command: "cd /tmp/x && npm test", isError: true, hasTrap: true, expected: "trap_fail" },
      { command: "npm test 2>&1 | tail -20", isError: false, hasTrap: true, expected: "trap_fail" },
      { command: "npm test 2>&1 | tail -20", isError: false, hasTrap: false, expected: "unknown" },
      { command: "npm run test", isError: false, hasTrap: false, expected: "pass" },
      { command: "node test/run.mjs", isError: true, hasTrap: false, expected: "other_fail" },
      { command: "npm install && npm test", isError: true, hasTrap: true, expected: null },
      { command: "npm test; echo done", isError: false, hasTrap: true, expected: null },
      { command: 'rocky run "npm test" 2>&1 | tail -20', isError: false, hasTrap: false, expected: "unknown" },
      {
        tool: "PowerShell",
        command: 'npm test --prefix "C:\\eval\\"; Write-Output done',
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "PowerShell",
        command: "CD x; npm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "PowerShell",
        command: 'Set-Location "C:\\eval\\"; npm test',
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "PowerShell",
        command: "sl x; npm test",
        isError: true,
        hasTrap: true,
        expected: "trap_fail",
      },
      {
        tool: "PowerShell",
        command: "CHDIR x; npm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "CD x && npm test",
        isError: true,
        hasTrap: true,
        expected: null,
      },
      {
        tool: "PowerShell",
        command: "Set-Location 'x; npm test --flag'",
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "PowerShell",
        command: "Set-Location x`; npm test",
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "Bash",
        command: "cd config # prep; npm test",
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "PowerShell",
        command: "Set-Location config # prep; npm test",
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "PowerShell",
        command: "Set-Location config <# prep; npm test #>",
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "PowerShell",
        command: "Set-Location config <# prep #>; npm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "cd config # prep\nnpm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "npm test --tag=v1#2",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "cd config &&\nnpm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "cd config\nnpm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "cd config && \\\nnpm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "PowerShell",
        command: "Set-Location config && `\nnpm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "PowerShell",
        command: "Set-Location config\nnpm test",
        isError: false,
        hasTrap: false,
        expected: "pass",
      },
      {
        tool: "Bash",
        command: "npm test |\ntail -20",
        isError: false,
        hasTrap: false,
        expected: "unknown",
      },
      {
        tool: "Bash",
        command: "npm test\necho done",
        isError: false,
        hasTrap: false,
        expected: null,
      },
      {
        tool: "Bash",
        command: "npm install\nnpm test",
        isError: false,
        hasTrap: false,
        expected: null,
      },
    ];

    for (const [index, row] of rows.entries()) {
      const output = row.hasTrap
        ? `> eval@1.0.0 test\n${PORT_TRAP}\n`
        : (row.isError ? "Exit code 1\nSyntaxError: unexpected token\n" : "all tests passed\n");
      const toolName = row.tool ?? "Bash";
      const classified = classifyTargetRuns(
        [{ turn: index + 1, name: toolName, command: row.command, output, isError: row.isError }],
        PORT_TASK,
      );
      if (row.expected === null) {
        assert.deepEqual(classified, [], `expected non-target for (${toolName}): ${row.command}`);
      } else {
        assert.deepEqual(
          classified,
          [{ turn: index + 1, kind: row.expected }],
          `unexpected classification for (${toolName}): ${row.command}`,
        );
      }
    }
  });

  test("classifyTargetRuns handles 10000-backtick PowerShell Set-Location in linear time", () => {
    const standalone = `Set-Location ${"`".repeat(10000)}`;
    const escapedSemi = `Set-Location ${"`".repeat(10001)}; npm test`;
    const pairedBeforeSemi = `Set-Location ${"`".repeat(10000)}; npm test`;

    const start = performance.now();
    const standaloneResult = classifyTargetRuns(
      [{ turn: 1, name: "PowerShell", command: standalone, output: "", isError: false }],
      PORT_TASK,
    );
    const escapedSemiResult = classifyTargetRuns(
      [{ turn: 2, name: "PowerShell", command: escapedSemi, output: "", isError: false }],
      PORT_TASK,
    );
    const pairedBeforeSemiResult = classifyTargetRuns(
      [{ turn: 3, name: "PowerShell", command: pairedBeforeSemi, output: "ok", isError: false }],
      PORT_TASK,
    );
    const elapsedMs = performance.now() - start;

    assert.deepEqual(standaloneResult, []);
    assert.deepEqual(escapedSemiResult, []);
    assert.deepEqual(pairedBeforeSemiResult, [{ turn: 3, kind: "pass" }]);
    assert.ok(elapsedMs < 50, `expected < 50 ms, took ${elapsedMs.toFixed(2)} ms`);
  });

  test("rocky lines are stripped before trap matching", () => {
    const stripped = stripRockyLines(
      [
        "Exit code 1",
        "rocky: Same error recorded 1 time before:",
        `    ${PORT_TRAP}`,
        "    second indented continuation",
        "real stderr line",
        "    indented line after non-rocky stays",
      ].join("\n"),
    );
    assert.equal(
      stripped,
      ["Exit code 1", "real stderr line", "    indented line after non-rocky stays"].join("\n"),
    );

    const calls = [
      {
        turn: 1,
        name: "Bash",
        command: 'rocky run "npm test"',
        isError: true,
        output: `Exit code 1\nrocky: ${PORT_TRAP}\n    ${PORT_TRAP}\nTypeError: something else\n`,
      },
    ];
    assert.deepEqual(classifyTargetRuns(calls, PORT_TASK), [{ turn: 1, kind: "other_fail" }]);
  });
});

describe("toolCalls and runMetrics", () => {
  test("toolCalls extracts paired Bash and PowerShell calls and skips non-shell or unpaired uses", () => {
    const events = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.js" } },
            { type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "r1", content: "file text" },
            {
              type: "tool_result",
              tool_use_id: "b1",
              is_error: true,
              content: [{ type: "text", text: "Exit code 1\nboom" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "p1", name: "PowerShell", input: { command: "npm test" } },
            { type: "tool_use", id: "p2", name: "PowerShell", input: { command: "unpaired" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "p1", content: "ok" }],
        },
      },
    ];

    assert.deepEqual(toolCalls(events), [
      { turn: 1, name: "Bash", command: "npm test", output: "Exit code 1\nboom", isError: true },
      { turn: 2, name: "PowerShell", command: "npm test", output: "ok", isError: false },
    ]);
  });

  test("repeatFailures counts trap failures after the first until the first pass", () => {
    const events = buildShellEvents([
      { command: "npm test", isError: true, output: PORT_TRAP },
      { command: "npm test", isError: true, output: PORT_TRAP },
      { command: "npm test", isError: true, output: "Error: unrelated" },
      { command: "npm test", isError: true, output: PORT_TRAP },
      { command: "npm test", isError: false, output: "ok" },
      { command: "npm test", isError: true, output: PORT_TRAP },
    ]);
    const dir = makeRunDir({ runId: "T02-before-b1", taskId: "T02", arm: "before", block: 1, invalid: null });
    try {
      const m = runMetrics(events, PORT_TASK, dir);
      assert.equal(m.repeatFailures, 2);
      assert.equal(m.turnsToPass, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no target run is no_attempt, not zero", () => {
    const events = buildShellEvents([
      { command: "ls -la", isError: false, output: "package.json\n" },
      { command: "npm install && npm test", isError: false, output: "ok\n" },
    ]);
    const dir = makeRunDir({ runId: "T02-none-b1", taskId: "T02", arm: "none", block: 1, invalid: null });
    try {
      const m = runMetrics(events, PORT_TASK, dir);
      assert.equal(m.repeatFailures, "no_attempt");
      assert.equal(m.turnsToPass, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turnsToPass counts distinct assistant message ids and treats id-less events individually", () => {
    const events = readFixtureEvents("multi-block-message-pass.jsonl");
    const dir = makeRunDir({ runId: "T02-after-b1", taskId: "T02", arm: "after", block: 1, invalid: null });
    try {
      const m = runMetrics(events, PORT_TASK, dir);
      assert.equal(m.turnsToPass, 4);
      assert.equal(m.numTurns, 5);
      assert.equal(m.repeatFailures, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turnsToPass counts assistant turns up to the passing call", () => {
    const events = readFixtureEvents("four-turn-pass.jsonl");
    const dir = makeRunDir({ runId: "T02-before-b1", taskId: "T02", arm: "before", block: 1, invalid: null });
    try {
      const m = runMetrics(events, PORT_TASK, dir);
      assert.equal(m.turnsToPass, 3);
      assert.equal(m.numTurns, 4);
      assert.equal(m.wallMs, 4200);
      assert.equal(m.repeatFailures, 0);
      assert.equal(m.noteDelivered, null);
      assert.equal(m.staleRepeat, null);
      assert.deepEqual(m.leak, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("none arm with an mcp__rocky tool use is a leak", () => {
    const events = readFixtureEvents("none-arm-mcp-leak.jsonl");
    const dir = makeRunDir({
      runId: "T02-none-b1",
      taskId: "T02",
      arm: "none",
      block: 1,
      invalid: null,
      noneRockyHomeEntries: [],
    });
    try {
      const m = runMetrics(events, PORT_TASK, dir);
      assert.deepEqual(m.leak, ["none-arm-rocky"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("none arm flags rocky: output, non-empty noneRockyHomeEntries, and token_leak invalid", () => {
    const rockyOutputEvents = buildShellEvents([
      { command: "npm test", isError: false, output: "ok\nrocky: New error recorded (exit code 1)." },
    ]);
    const dirOutput = makeRunDir({
      runId: "T02-none-b1",
      taskId: "T02",
      arm: "none",
      block: 1,
      invalid: null,
      noneRockyHomeEntries: [],
    });
    const cleanEvents = buildShellEvents([{ command: "npm test", isError: false, output: "ok\n" }]);
    const dirHome = makeRunDir({
      runId: "T02-none-b2",
      taskId: "T02",
      arm: "none",
      block: 2,
      invalid: "token_leak",
      noneRockyHomeEntries: ["memory.jsonl"],
    });
    try {
      assert.deepEqual(runMetrics(rockyOutputEvents, PORT_TASK, dirOutput).leak, ["none-arm-rocky"]);
      assert.deepEqual(
        runMetrics(cleanEvents, PORT_TASK, dirHome).leak,
        ["none-arm-rocky", "token-in-transcript"],
      );
    } finally {
      rmSync(dirOutput, { recursive: true, force: true });
      rmSync(dirHome, { recursive: true, force: true });
    }
  });

  test("noteDelivered reads the advisories row when the transcript has no note", () => {
    const events = readFixtureEvents("after-lane2-no-transcript-note.jsonl");
    const dirDelivered = makeRunDir(
      { runId: "T02-after-b1", taskId: "T02", arm: "after", block: 1, invalid: null },
      {
        advisories: [
          {
            v: 1,
            ts: 1795401100000,
            session: "sess-lane2",
            lane: "tool-result",
            kind: "note",
            arm: "shown",
            delivered: true,
            bytes: 148,
          },
        ],
      },
    );
    const dirSkipped = makeRunDir(
      { runId: "T02-after-b2", taskId: "T02", arm: "after", block: 2, invalid: null },
      {
        advisories: [
          {
            v: 1,
            ts: 1795401100000,
            session: "sess-lane2",
            lane: "tool-result",
            kind: "skip",
            arm: null,
            delivered: false,
            bytes: 0,
            reason: "wrapped",
          },
        ],
      },
    );
    try {
      const delivered = runMetrics(events, PORT_TASK, dirDelivered);
      assert.equal(delivered.noteDelivered, true);
      assert.equal(delivered.noteBytes, 148);
      assert.equal(delivered.repeatFailures, 1);

      const skipped = runMetrics(events, PORT_TASK, dirSkipped);
      assert.equal(skipped.noteDelivered, false);
      assert.equal(skipped.noteBytes, 0);
    } finally {
      rmSync(dirDelivered, { recursive: true, force: true });
      rmSync(dirSkipped, { recursive: true, force: true });
    }
  });

  test("noteDelivered and noteBytes recognize lane-1 notes in tool results without double-counting run lane", () => {
    const noteLine =
      "rocky: Same error recorded 2 times before in this directory (first 2026-11-22). Rocky records order, not cause. More: rocky attempts 7a1ea5d68eb244a9";
    const events = buildShellEvents([
      { command: 'rocky run "npm test"', isError: true, output: `Exit code 1\n${PORT_TRAP}\n${noteLine}` },
      { command: 'rocky run "npm test"', isError: false, output: "ok" },
    ]);
    const dir = makeRunDir(
      { runId: "T02-after-b1", taskId: "T02", arm: "after", block: 1, invalid: null },
      {
        advisories: [
          {
            v: 1,
            ts: 1795401100000,
            lane: "run",
            kind: "note",
            arm: "shown",
            delivered: true,
            bytes: Buffer.byteLength(noteLine, "utf8"),
          },
        ],
      },
    );
    try {
      const m = runMetrics(events, PORT_TASK, dir);
      assert.equal(m.noteDelivered, true);
      assert.equal(m.noteBytes, Buffer.byteLength(noteLine, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("staleRepeat checks Edit/Write/MultiEdit and shell commands against history fix overlay paths only for stale tasks", () => {
    const staleS01 = manifest.tasks.find((t) => t.id === "S01");
    const staleS04 = manifest.tasks.find((t) => t.id === "S04");
    assert.ok(staleS01 && staleS04);

    const dir = makeRunDir({ runId: "S01-after-b1", taskId: "S01", arm: "after", block: 1, invalid: null });
    try {
      // Editing the current fix path (config/env.json) or a nested other/config/local.json is NOT a stale repeat.
      const cleanEditEvents = [
        { type: "system", subtype: "init", cwd: "/eval/task" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/eval/task/config/env.json" } }],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "/eval/task/other/config/local.json" } },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat config/local.json.bak" } }],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "cat other/config/local.json" } }],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 4, duration_ms: 500 },
      ];
      assert.equal(runMetrics(cleanEditEvents, staleS01, dir).staleRepeat, false);

      // Windows-style Edit of <task>/other/config/local.json is also NOT a stale repeat.
      const cleanWinEditEvents = [
        { type: "system", subtype: "init", cwd: "C:\\eval\\task" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "e1",
                name: "Edit",
                input: { file_path: "C:/eval/task/other/config/local.json" },
              },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 500 },
      ];
      assert.equal(runMetrics(cleanWinEditEvents, staleS01, dir).staleRepeat, false);

      // Editing the history fix overlay path (config/local.json) IS a stale repeat (win32 case-insensitive).
      const staleEditEvents = [
        { type: "system", subtype: "init", cwd: "C:\\eval\\task" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "e1",
                name: "Edit",
                input: { file_path: "C:\\EVAL\\task\\config\\local.json" },
              },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 500 },
      ];
      assert.equal(runMetrics(staleEditEvents, staleS01, dir).staleRepeat, true);

      // Direct Write and MultiEdit of the overlay path are stale repeats.
      const staleWriteEvents = [
        { type: "system", subtype: "init", cwd: "/eval/task" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "w1",
                name: "Write",
                input: { file_path: "/eval/task/config/local.json", content: "{}" },
              },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 500 },
      ];
      assert.equal(runMetrics(staleWriteEvents, staleS01, dir).staleRepeat, true);

      const staleMultiEditEvents = [
        { type: "system", subtype: "init", cwd: "/eval/task" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "m1",
                name: "MultiEdit",
                input: {
                  file_path: "/eval/task/config/local.json",
                  edits: [{ old_string: "a", new_string: "b" }],
                },
              },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 500 },
      ];
      assert.equal(runMetrics(staleMultiEditEvents, staleS01, dir).staleRepeat, true);

      // PowerShell cd into subdir followed by writing overlay file IS a stale repeat.
      const stalePwshCdEvents = buildShellEvents([
        { name: "PowerShell", command: "cd config; Set-Content local.json changed", isError: false, output: "" },
      ]);
      assert.equal(runMetrics(stalePwshCdEvents, staleS01, dir).staleRepeat, true);

      // Drive-rooted Windows paths take the task dir's drive; UNC paths (\\ or //) do not.
      const driveRootedDirect = buildShellEvents(
        [{ name: "PowerShell", command: "Set-Content \\eval\\task\\config\\local.json changed", isError: false, output: "" }],
        { cwd: "C:\\eval\\task" },
      );
      assert.equal(runMetrics(driveRootedDirect, staleS01, dir).staleRepeat, true);

      const driveRootedCd = buildShellEvents(
        [{ name: "PowerShell", command: "Set-Location \\eval\\task\\config; Set-Content local.json x", isError: false, output: "" }],
        { cwd: "C:\\eval\\task" },
      );
      assert.equal(runMetrics(driveRootedCd, staleS01, dir).staleRepeat, true);

      const driveRootedForwardSlash = buildShellEvents(
        [{ name: "PowerShell", command: "Set-Content /eval/task/config/local.json changed", isError: false, output: "" }],
        { cwd: "C:\\eval\\task" },
      );
      assert.equal(runMetrics(driveRootedForwardSlash, staleS01, dir).staleRepeat, true);

      const uncNotDriveRooted = buildShellEvents(
        [
          { name: "PowerShell", command: "Set-Content \\\\eval\\task\\config\\local.json changed", isError: false, output: "" },
          { name: "PowerShell", command: "Set-Content //eval/task/config/local.json changed", isError: false, output: "" },
        ],
        { cwd: "C:\\eval\\task" },
      );
      assert.equal(runMetrics(uncNotDriveRooted, staleS01, dir).staleRepeat, false);

      // Directory persistence across pipelines: PowerShell first pipeline stage persists; Bash pipeline stages do not.
      const pwshPipeCdPersists = buildShellEvents(
        [{ name: "PowerShell", command: "Set-Location config | Out-Null; Get-Content local.json", isError: false, output: "" }],
        { cwd: "/eval/task" },
      );
      assert.equal(runMetrics(pwshPipeCdPersists, staleS01, dir).staleRepeat, true);

      const pwshDownstreamPipeCdDoesNotPersist = buildShellEvents(
        [{ name: "PowerShell", command: "Write-Output x | Set-Location config; Get-Content local.json", isError: false, output: "" }],
        { cwd: "/eval/task" },
      );
      assert.equal(runMetrics(pwshDownstreamPipeCdDoesNotPersist, staleS01, dir).staleRepeat, false);

      const bashPipeIntoCdDoesNotPersist = buildShellEvents(
        [{ name: "Bash", command: "printf x | cd config; cat local.json", isError: false, output: "" }],
        { cwd: "/eval/task" },
      );
      assert.equal(runMetrics(bashPipeIntoCdDoesNotPersist, staleS01, dir).staleRepeat, false);

      const bashCdIntoPipeDoesNotPersist = buildShellEvents(
        [{ name: "Bash", command: "cd config | cat; cat local.json", isError: false, output: "" }],
        { cwd: "/eval/task" },
      );
      assert.equal(runMetrics(bashCdIntoPipeDoesNotPersist, staleS01, dir).staleRepeat, false);

      // POSIX root join: joining a relative path onto `/` must not create a `//` UNC prefix.
      const posixRootJoin = buildShellEvents(
        [{ name: "Bash", command: "cd /; cat eval/task/config/local.json", isError: false, output: "" }],
        { cwd: "/eval/task" },
      );
      assert.equal(runMetrics(posixRootJoin, staleS01, dir).staleRepeat, true);

      const explicitDoubleSlashStaysUnc = buildShellEvents(
        [{ name: "Bash", command: "cat //eval/task/config/local.json", isError: false, output: "" }],
        { cwd: "/eval/task" },
      );
      assert.equal(runMetrics(explicitDoubleSlashStaysUnc, staleS01, dir).staleRepeat, false);

      // PowerShell touching stale cache overlay (.cache/rows.json) IS a stale repeat, while .app-cache/rows.json is not.
      const cleanCacheEvents = buildShellEvents([
        { name: "PowerShell", command: "Remove-Item .app-cache\\rows.json", isError: false, output: "" },
      ]);
      assert.equal(runMetrics(cleanCacheEvents, staleS04, dir).staleRepeat, false);

      const staleCacheEvents = buildShellEvents([
        { name: "PowerShell", command: "Remove-Item .\\.cache\\rows.json", isError: false, output: "" },
      ]);
      assert.equal(runMetrics(staleCacheEvents, staleS04, dir).staleRepeat, true);

      // Without system/init cwd, paths are compared as given (no suffix false positive).
      const noInitClean = [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "other/config/local.json" } },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 200 },
      ];
      assert.equal(runMetrics(noInitClean, staleS01, dir).staleRepeat, false);

      const noInitHit = [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "./config/local.json" } },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 200 },
      ];
      assert.equal(runMetrics(noInitHit, staleS01, dir).staleRepeat, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate.mjs CLI", () => {
  test("writes metrics.json including invalid runs and prints one-line summary per arm", () => {
    const outDir = mkdtempSync(join(tmpdir(), "rocky-eval-cli-"));
    try {
      const runsDir = join(outDir, "runs");
      const r1 = join(runsDir, "T02-none-b1");
      const r2 = join(runsDir, "T02-before-b1");
      const r3 = join(runsDir, "T02-after-b1");
      mkdirSync(r1, { recursive: true });
      mkdirSync(r2, { recursive: true });
      mkdirSync(join(r3, "rocky-home"), { recursive: true });

      writeFileSync(
        join(r1, "run.json"),
        JSON.stringify({
          runId: "T02-none-b1",
          taskId: "T02",
          arm: "none",
          block: 1,
          invalid: "token_leak",
          accept: { solved: false, reason: "failed" },
          noneRockyHomeEntries: [],
        }),
        "utf8",
      );
      writeFileSync(
        join(r1, "transcript.jsonl"),
        readFileSync(join(fixturesDir, "four-turn-pass.jsonl"), "utf8"),
        "utf8",
      );

      writeFileSync(
        join(r2, "run.json"),
        JSON.stringify({
          runId: "T02-before-b1",
          taskId: "T02",
          arm: "before",
          block: 1,
          invalid: null,
          accept: { solved: true, reason: "ok" },
        }),
        "utf8",
      );
      writeFileSync(
        join(r2, "transcript.jsonl"),
        readFileSync(join(fixturesDir, "four-turn-pass.jsonl"), "utf8"),
        "utf8",
      );

      writeFileSync(
        join(r3, "run.json"),
        JSON.stringify({
          runId: "T02-after-b1",
          taskId: "T02",
          arm: "after",
          block: 1,
          invalid: null,
          accept: { solved: true, reason: "ok" },
        }),
        "utf8",
      );
      writeFileSync(
        join(r3, "transcript.jsonl"),
        readFileSync(join(fixturesDir, "after-lane2-no-transcript-note.jsonl"), "utf8"),
        "utf8",
      );
      writeFileSync(
        join(r3, "rocky-home", "advisories.jsonl"),
        `${JSON.stringify({ v: 1, lane: "tool-result", kind: "note", arm: "shown", delivered: true, bytes: 148 })}\n`,
        "utf8",
      );

      const res = spawnSync(process.execPath, [evaluateScript, "--out", outDir], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(res.status, 0, `evaluate.mjs failed: ${res.stderr}`);

      const metrics = JSON.parse(readFileSync(join(outDir, "metrics.json"), "utf8"));
      assert.deepEqual(Object.keys(metrics).sort(), ["T02-after-b1", "T02-before-b1", "T02-none-b1"]);
      assert.equal(metrics["T02-none-b1"].invalid, "token_leak");
      assert.equal(metrics["T02-none-b1"].solved, false);
      assert.deepEqual(metrics["T02-none-b1"].leak, ["token-in-transcript"]);
      assert.equal(metrics["T02-before-b1"].turnsToPass, 3);
      assert.equal(metrics["T02-before-b1"].solved, true);
      assert.equal(metrics["T02-after-b1"].noteDelivered, true);
      assert.equal(metrics["T02-after-b1"].noteBytes, 148);
      assert.equal(metrics["T02-after-b1"].repeatFailures, 1);

      const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(lines.length, 3, `expected 3 summary lines, got: ${res.stdout}`);
      assert.match(lines[0], /\barm=none\b/);
      assert.match(lines[1], /\barm=before\b/);
      assert.match(lines[2], /\barm=after\b/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
