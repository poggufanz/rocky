/**
 * `rocky run "<command>"`
 *
 * Runs the command through a shell, streaming stdout/stderr untouched.
 * On failure: fingerprints stderr, checks memory for this exact error,
 * and if Rocky has heard it before (and knows what fixed it) he says so.
 * On success: if the same program failed recently in this directory,
 * this success is recorded as the fix.
 */
import { spawn } from "node:child_process";
import { fingerprint } from "../core/fingerprint.js";
import { findByFingerprint, getFix, loadMemory, recentUnresolvedFailures, recordFailure, recordFix, } from "../core/memory.js";
import { ago, detail, say } from "../ui/rocky.js";
export async function run(cmd) {
    if (!cmd || cmd.trim().length === 0) {
        say("no command. give command, question");
        return 2;
    }
    const result = await execute(cmd);
    if (result.code === 0) {
        onSuccess(cmd);
    }
    else {
        onFailure(cmd, result);
    }
    return result.code;
}
function execute(cmd) {
    let stderr = "";
    return new Promise((resolve) => {
        const child = spawn(cmd, {
            shell: true,
            stdio: ["inherit", "inherit", "pipe"],
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            process.stderr.write(chunk); // stream through untouched
        });
        child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
        child.on("error", (err) => {
            stderr += String(err.message);
            process.stderr.write(err.message + "\n");
            resolve({ code: 127, stderr });
        });
    });
}
function onFailure(cmd, result) {
    const memory = loadMemory();
    const fp = fingerprint(result.stderr);
    const previous = findByFingerprint(memory, fp);
    if (previous.length > 0) {
        const first = previous[0];
        say(`I remember this error. You hear it before. ${ago(first.ts)}. Same same.`);
        const withFix = [...previous].reverse().find((f) => getFix(memory, f));
        if (withFix) {
            const fix = getFix(memory, withFix);
            say(`last time, you fix with:`);
            detail(`    ${fix.cmd}`);
            say("try, question");
        }
        else {
            say("no fix in memory yet. you fix, I remember. this is good trade.");
        }
    }
    else {
        say(`new error. bad. I remember it now. exit code ${result.code}.`);
    }
    recordFailure(cmd, result.code, result.stderr);
}
function onSuccess(cmd) {
    const memory = loadMemory();
    const unresolved = recentUnresolvedFailures(memory, cmd);
    if (unresolved.length > 0) {
        recordFix(cmd, unresolved);
        say("command works now. you fix it. I remember the fix. good good good.");
    }
}
