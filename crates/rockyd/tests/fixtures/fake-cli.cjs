// Fake Rocky CLI for the node_runner and capture_child tests. Node built-ins only.
// Logs its argv under ROCKY_HOME, then behaves as fake-cli.json says, or as
// fake-capture.json says when run as `listen`.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const home = process.env.ROCKY_HOME;
const configPath = path.join(home, "fake-cli.json");

fs.appendFileSync(
  path.join(home, "fake-cli.log"),
  JSON.stringify({ argv: process.argv.slice(1) }) + "\n",
);

if (process.argv[2] === "listen") {
  listen();
  return;
}

const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : { mode: "print" };
const result = config.result ?? {
  v: 1,
  action: "apply",
  consent: "approved",
  targets: [],
  notes: [],
};

if (config.write) {
  fs.writeFileSync(config.write.path, config.write.text);
}

switch (config.mode ?? "print") {
  case "print":
    process.stdout.write(JSON.stringify(result) + "\n");
    break;
  case "big":
    process.stdout.write(JSON.stringify({ ...result, notes: ["x".repeat(config.bytes)] }) + "\n");
    break;
  case "exit":
    process.exitCode = result.code;
    break;
  case "sleep":
    // Keeps the event loop alive without spawning anything else.
    setTimeout(() => {}, 60_000);
    break;
  default:
    process.exitCode = 3;
}

// The capture command: `listen collect --stdio`. Behaves as fake-capture.json says
// ({ mode, roots? }) and logs what it reads to fake-capture.log.
function listen() {
  const capturePath = path.join(home, "fake-capture.json");
  const capture = fs.existsSync(capturePath)
    ? JSON.parse(fs.readFileSync(capturePath, "utf8"))
    : { mode: "echo", roots: [] };
  const logLine = (text) => fs.appendFileSync(path.join(home, "fake-capture.log"), text + "\n");
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const rootsLine = (roots) => ({
    v: 1,
    kind: "roots",
    roots: roots.map((root) => ({ root, owner: true })),
  });

  switch (capture.mode) {
    case "echo": {
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        logLine(line);
        out({
          v: 1,
          kind: "result",
          root: JSON.parse(line).root,
          coverage: "complete",
          gaps: 0,
          reason: null,
          at_ms: Date.now(),
        });
      });
      // Ends on its own once stdin does, so stdout is flushed before the exit.
      lines.on("close", () => logLine("eof"));
      out(rootsLine(capture.roots ?? []));
      break;
    }
    case "exit":
      process.exitCode = 1;
      break;
    case "deaf":
      // Never reads stdin, so its end changes nothing; only a kill ends this.
      setTimeout(() => {}, 60_000);
      break;
    case "noise":
      process.stdout.write("garbage\n");
      // Well formed, but over the line cap, so it only arrives if the cap is not enforced.
      out(rootsLine(["x".repeat(70 * 1024)]));
      out(rootsLine(["kept"]));
      break;
    default:
      process.exitCode = 3;
  }
}
