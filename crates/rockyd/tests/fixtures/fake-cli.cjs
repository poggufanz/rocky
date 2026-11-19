// Fake Rocky CLI for the node_runner, capture_child, and translate_child tests.
// Node built-ins only. Logs its argv under ROCKY_HOME, then behaves as fake-cli.json says,
// as fake-capture.json says for `listen`, or as fake-translate.json says for `translate`.
"use strict";

const crypto = require("node:crypto");
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
if (process.argv[2] === "translate") {
  translate();
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

// The translate command: `translate run` or `translate install --pair <pair>`.
// Behaves as fake-translate.json says; absent file uses defaults.
function translate() {
  fs.writeFileSync(path.join(home, "fake-translate.pid"), String(process.pid));
  const translatePath = path.join(home, "fake-translate.json");
  const cfg = fs.existsSync(translatePath)
    ? JSON.parse(fs.readFileSync(translatePath, "utf8"))
    : {};
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const sub = process.argv[3];

  if (sub === "run") {
    if (cfg.hang) {
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", () => {});
      setTimeout(() => {}, 60_000);
      return;
    }
    if (cfg.crash_after === 0) {
      process.exitCode = 1;
      return;
    }
    let replies = 0;
    let stopped = false;
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      if (stopped || !line.trim()) {
        return;
      }
      const req = JSON.parse(line);
      if (cfg.extra_noise) {
        process.stdout.write("not-json\n");
        out({ v: 1, key: "unrequested-key", ok: true, from: "id", text: "ignored" });
      }
      if (cfg.same) {
        out({ v: 1, key: req.key, ok: false, reason: "same-language" });
      } else if (cfg.no_prose) {
        out({ v: 1, key: req.key, ok: false, reason: "no-prose" });
      } else if (cfg.fail) {
        out({ v: 1, key: req.key, ok: false, reason: "engine" });
      } else {
        const from = req.to === "en" ? "id" : "en";
        out({ v: 1, key: req.key, ok: true, from, text: "T:" + req.text });
      }
      replies += 1;
      if (typeof cfg.crash_after === "number" && replies >= cfg.crash_after) {
        stopped = true;
        lines.close();
        process.stdin.destroy();
        process.exitCode = 1;
      }
    });
    return;
  }

  if (sub === "install") {
    const pairIdx = process.argv.indexOf("--pair", 4);
    const pair = pairIdx !== -1 ? process.argv[pairIdx + 1] : "";
    if (cfg.install === "hang") {
      setTimeout(() => {}, 60_000);
      return;
    }
    if (cfg.install === "crash") {
      process.exitCode = 1;
      return;
    }
    if (cfg.install === "checksum") {
      out({ v: 1, kind: "progress", done_bytes: 50, total_bytes: 100 });
      out({ v: 1, kind: "result", ok: false, reason: "checksum" });
      return;
    }
    out({ v: 1, kind: "progress", done_bytes: 50, total_bytes: 100 });
    out({ v: 1, kind: "progress", done_bytes: 100, total_bytes: 100 });
    writeFakeInstallMarkers(pair);
    out({ v: 1, kind: "result", ok: true });
    return;
  }

  process.exitCode = 3;
}

function writeFakeInstallMarkers(pair) {
  const engineDir = path.join(home, "translate", "engine");
  fs.mkdirSync(engineDir, { recursive: true });
  const glue = Buffer.from("console.log(1);");
  const wasm = Buffer.from("wasm-bytes");
  fs.writeFileSync(path.join(engineDir, "bergamot.js"), glue);
  fs.writeFileSync(path.join(engineDir, "bergamot.wasm"), wasm);
  fs.writeFileSync(
    path.join(engineDir, "installed.json"),
    JSON.stringify({
      v: 1,
      files: [
        { role: "glue", name: "bergamot.js", size: glue.length },
        { role: "wasm", name: "bergamot.wasm", size: wasm.length },
      ],
    }),
  );

  const modelDir = path.join(home, "translate", "models", pair);
  fs.mkdirSync(modelDir, { recursive: true });
  const model = Buffer.from("model-payload");
  const lex = Buffer.from("lex");
  const vocab = Buffer.from("vocab");
  fs.writeFileSync(path.join(modelDir, "model.bin"), model);
  fs.writeFileSync(path.join(modelDir, "lex.bin"), lex);
  fs.writeFileSync(path.join(modelDir, "vocab.spm"), vocab);
  const sha = crypto.createHash("sha256").update(model).digest("hex");
  fs.writeFileSync(
    path.join(modelDir, "installed.json"),
    JSON.stringify({
      v: 1,
      pair,
      model_sha256: sha,
      files: [
        { role: "model", name: "model.bin", size: model.length },
        { role: "lex", name: "lex.bin", size: lex.length },
        { role: "vocab", name: "vocab.spm", size: vocab.length },
      ],
    }),
  );
}
