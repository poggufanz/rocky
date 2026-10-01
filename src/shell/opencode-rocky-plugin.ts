// Rocky global OpenCode plugin template — nudge plus capture, never strict by default.
// Installed by `rocky setup` to ~/.config/opencode/plugins/rocky.ts. Zero dependencies.
export const RockyPlugin = async () => ({
  "shell.env": async (_input: any, output: any) => {
    try {
      output.env = output.env ?? {};
      if (!output.env.BASH_ENV && process.env.HOME) {
        output.env.BASH_ENV = `${process.env.HOME}/.rocky/shell/subshell-hook.sh`;
      }
    } catch { /* fail open: shell runs without telemetry */ }
  },
  "tool.execute.before": async (input: any) => {
    try {
      const tool = String(input?.tool ?? "");
      if (!/^(edit|write|multiedit)$/i.test(tool)) return;
      if (process.env.ROCKY_GATE_MODE !== "strict") return;
      const args = (input?.args ?? {}) as Record<string, unknown>;
      const file = args.filePath ?? args.file_path ?? "";
      if (typeof file !== "string" || file.length === 0) return;
      const { spawnSync } = await import("node:child_process");
      const payload = JSON.stringify({
        session_id: String(input?.sessionID ?? input?.sessionId ?? "opencode"),
        tool_name: "Edit",
        tool_input: { file_path: file },
        cwd: String(input?.cwd ?? input?.directory ?? ""),
      });
      const result = spawnSync("rocky", ["hook", "gate-event", "generic"], { input: payload, encoding: "utf8", timeout: 1500 });
      const stdout = String((result as { stdout?: unknown }).stdout ?? "");
      if (stdout.includes('"deny"')) throw new Error(`Rocky Policy: edit blocked until why is recorded. run rocky hook agent-event generic --rationale "<why>" --files ${file}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Rocky Policy:")) throw error;
      /* fail open */
    }
  },
  "tool.execute.after": async (input: any) => {
    try {
      const tool = String(input?.tool ?? "");
      if (!/^(edit|write|multiedit)$/i.test(tool)) return;
      const args = (input?.args ?? {}) as Record<string, unknown>;
      const file = args.filePath ?? args.file_path ?? "";
      const { spawnSync } = await import("node:child_process");
      const home = process.env.HOME ?? "";
      const summary = `${tool} ${typeof file === "string" ? file : ""}`.slice(0, 200);
      spawnSync("node", [`${home}/.rocky/agent-note.cjs`, "opencode", summary], { stdio: "ignore", timeout: 5000 });
    } catch { /* fail open */ }
  },
});
