// rocky global OpenCode plugin template — capture only, never blocks.
// Copy to ~/.config/opencode/plugins/rocky.ts by hand. Zero dependencies.

export const RockyPlugin = async () => ({
  "shell.env": async (_input: any, output: any) => {
    try {
      output.env = output.env ?? {};
      if (!output.env.BASH_ENV && process.env.HOME) {
        output.env.BASH_ENV = `${process.env.HOME}/.rocky/shell/subshell-hook.sh`;
      }
    } catch { /* fail open: shell runs without telemetry */ }
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
