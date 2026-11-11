// Fake Rocky CLI for the node_runner tests. Node built-ins only.
// Logs its argv under ROCKY_HOME, then behaves as fake-cli.json says.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const home = process.env.ROCKY_HOME;
const configPath = path.join(home, "fake-cli.json");

fs.appendFileSync(
  path.join(home, "fake-cli.log"),
  JSON.stringify({ argv: process.argv.slice(1) }) + "\n",
);

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
