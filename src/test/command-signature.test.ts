import test from "node:test";
import assert from "node:assert/strict";
import { commandBase, commandIdentity, commandSignature } from "../core/fingerprint.js";

test("conservative identity keeps task names and meaningful arguments", () => {
  assert.notEqual(commandSignature("npm run a"), commandSignature("npm run b"));
  assert.match(commandSignature("npm --silent run a"), /(?:^| )a(?:$| )/);
  assert.notEqual(commandIdentity("node script.mjs mode-a").value, commandIdentity("node script.mjs mode-b").value);

  for (const runner of ["pnpm", "yarn", "bun", "cargo", "just", "make", "task"]) {
    assert.notEqual(commandIdentity(`${runner} task-a`).value, commandIdentity(`${runner} task-b`).value);
  }
});

test("quoted executable paths and wrapper options reach the real command", () => {
  assert.equal(commandBase('"C:\\Program Files\\Alpha Tool\\alpha.cmd" task'), "alpha.cmd");
  assert.equal(commandBase("'/opt/Alpha Tool/alpha' task"), "alpha");
  assert.notEqual(
    commandIdentity('"C:\\Program Files\\Alpha Tool\\alpha.cmd" task', { platform: "win32" }).value,
    commandIdentity('"C:\\Program Files\\Beta Tool\\beta.cmd" task', { platform: "win32" }).value,
  );
  assert.equal(commandSignature("sudo -u root npm test"), "npm test");
});

test("Windows folds executable case only and ambiguous shell input is never strong", () => {
  assert.equal(
    commandIdentity("NODE script.mjs", { platform: "win32" }).value,
    commandIdentity("node script.mjs", { platform: "win32" }).value,
  );
  assert.notEqual(
    commandIdentity("NODE script.mjs", { platform: "linux" }).value,
    commandIdentity("node script.mjs", { platform: "linux" }).value,
  );
  assert.equal(commandIdentity("npm test && npm run build").reliable, false);
  assert.equal(commandIdentity('npm run "unterminated').reliable, false);
});

const cases: Array<[string, string]> = [
  ["rocky setup --yes", "rocky setup --yes"],
  ["rocky setup", "rocky setup"],
  ["rocky --help", "rocky --help"],
  ["claude --resunme", "claude --resunme"],
  ["claude --resume", "claude --resume"],
  ["npm run build", "npm run build"],
  ["npm run dev", "npm run dev"],
  ["cargo build --release", "cargo build --release"],
  ["cargo build", "cargo build"],
  ["/usr/bin/npm run build", "npm run build"],
  ["ls -l -a", "ls -l -a"],
  ["ls -a -l", "ls -a -l"],
  ["ls -a -a -l", "ls -a -a -l"],
  ["", ""],
  ["   ", ""],
];

test("commandSignature matches the spec table", () => {
  for (const [input, expected] of cases) {
    assert.equal(commandSignature(input), expected, `commandSignature(${JSON.stringify(input)})`);
  }
});

test("commandSignature pairing consequences", () => {
  assert.notEqual(commandSignature("rocky setup --yes"), commandSignature("rocky setup"));
  assert.notEqual(commandSignature("rocky setup --yes"), commandSignature("rocky --help"));
  assert.notEqual(commandSignature("claude --resunme"), commandSignature("claude --resume"));
});

test("commandBase reduces path tokens to their basename on either separator", () => {
  assert.equal(commandBase("/usr/bin/npm run build"), "npm");
  assert.equal(commandBase("C:\\tools\\npm run build"), "npm");
});

test("wrapper programs and env assignments are transparent, so opposite subcommands do not collapse", () => {
  // `sudo systemctl restart nginx` graded `sudo systemctl status nginx` a STRONG
  // fix before this: a read-only command sold as the cure for a failed restart.
  assert.equal(commandSignature("sudo systemctl restart nginx"), "systemctl restart nginx");
  assert.equal(commandSignature("sudo systemctl status nginx"), "systemctl status nginx");
  assert.notEqual(
    commandSignature("sudo systemctl restart nginx"),
    commandSignature("sudo systemctl status nginx"),
  );

  // An assignment prefix is not the program: an npm failure must never link to a
  // cargo success under the sentence "same program".
  assert.equal(commandBase("DEBUG=1 npm run build"), "npm");
  assert.equal(commandBase("DEBUG=1 cargo test"), "cargo");
  assert.notEqual(commandBase("DEBUG=1 npm run build"), commandBase("DEBUG=1 cargo test"));

  // ...and the same prefix must not hide a link that is genuinely strong.
  assert.equal(
    commandSignature("NODE_ENV=production npm run build"),
    commandSignature("npm run build"),
  );

  assert.equal(commandBase("/usr/bin/env FOO=1 npm test"), "npm");
  assert.equal(commandSignature("time npm run build"), "npm run build");
});

test("a flag's value is not the subcommand", () => {
  // `docker --context prod ps` was a STRONG fix for a failed `docker ... build .`
  assert.equal(commandSignature("docker --context prod build ."), "docker --context prod build .");
  assert.equal(commandSignature("docker --context prod ps"), "docker --context prod ps");
  assert.notEqual(
    commandSignature("docker --context prod build ."),
    commandSignature("docker --context prod ps"),
  );

  assert.equal(commandSignature("npm --prefix ./app run build"), "npm --prefix ./app run build");
  assert.equal(commandSignature("npm --prefix ./app test"), "npm --prefix ./app test");

  // A flag carrying its own value needs no lookahead.
  assert.equal(commandSignature("docker --context=prod build ."), "docker --context=prod build .");

  // Flag-only commands still fall back to the sorted flag set.
  assert.equal(commandSignature("claude --resunme"), "claude --resunme");
  assert.equal(commandSignature("claude --resume"), "claude --resume");
});

test("a command that is nothing but prefixes still names something", () => {
  assert.equal(commandSignature("sudo"), "sudo");
  assert.equal(commandBase("sudo"), "sudo");
  assert.equal(commandSignature("FOO=1"), "FOO=1");
  assert.equal(commandSignature(""), "");
  assert.equal(commandSignature("   "), "");
});

test("rocky run is a wrapper: base and signature come from the wrapped command", () => {
  assert.equal(commandBase("rocky run npm test"), "npm");
  assert.equal(commandSignature("rocky run npm test"), "npm test");
  assert.equal(commandBase("sudo rocky run npm test"), "npm");
});

test("other rocky subcommands are not stripped", () => {
  assert.equal(commandBase("rocky setup"), "rocky");
  assert.equal(commandBase("rocky --help"), "rocky");
  assert.equal(commandBase("rocky run"), "rocky"); // nothing but prefixes: falls back to naming itself
});
