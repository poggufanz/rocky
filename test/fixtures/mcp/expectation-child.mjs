import { appendFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (process.argv.slice(2).join(" ") !== "hook note-expectation") process.exit(2);

switch (process.env.EXPECTATION_CHILD_MODE) {
  case "echo":
    process.stdout.write(JSON.stringify({
      recorded: true, id: payload.text, linkedFailure: payload.failureId !== undefined,
    }) + "\n");
    break;
  case "decline":
    process.stdout.write(JSON.stringify({
      recorded: false, reason: payload.text, linkedFailure: false,
    }) + "\n");
    break;
  case "reply":
    process.stdout.write(payload.text + "\n");
    break;
  case "hang":
    appendFileSync(process.env.EXPECTATION_CHILD_PID_FILE, String(process.pid) + "\n");
    setTimeout(() => process.exit(2), 10_000);
    break;
  case "garbage":
    process.stdout.write("not JSON\n");
    break;
  case "malformed":
    process.stdout.write('{"recorded":"true","linkedFailure":false}\n');
    break;
  case "oversized":
    process.stdout.write('{"recorded":true,"id":"rationale-1","linkedFailure":false}\n'.padEnd(4097));
    break;
  case "exit-1":
    process.stdout.write('{"recorded":true,"id":"rationale-1","linkedFailure":false}\n');
    process.exitCode = 1;
    break;
  default:
    process.exit(2);
}
