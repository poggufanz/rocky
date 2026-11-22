import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commandFingerprint, fingerprint } from "../core/fingerprint.js";
import { parseExitCodeHeader } from "../core/tool-result.js";

interface ParityCase {
  name: string;
  cmd: string;
  exitCode: number;
  stderr: string;
  stdout: string;
  same: boolean;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturePath = join(packageRoot, "fixtures", "tool-result-parity.json");

test("tool-result body fingerprints match rocky run stderr fingerprints", () => {
  const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as ParityCase[];
  assert.ok(cases.length > 0, "expected at least one parity case");

  for (const c of cases) {
    const parsed = parseExitCodeHeader(`Exit code ${c.exitCode}\n${c.stdout}${c.stderr}`);
    assert.ok(parsed !== undefined, `${c.name}: expected exit code header to parse`);
    assert.equal(parsed.exitCode, c.exitCode, `${c.name}: exitCode`);

    const bodyFp = fingerprint(parsed.body, c.cmd, c.exitCode);
    const stderrFp = fingerprint(c.stderr, c.cmd, c.exitCode);
    if (c.same) {
      assert.notEqual(
        stderrFp,
        commandFingerprint(c.cmd, c.exitCode),
        `${c.name}: expected output fingerprint rather than command fallback`,
      );
    }
    assert.equal(bodyFp === stderrFp, c.same, c.name);
  }
});
