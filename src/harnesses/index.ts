import type { HarnessId } from "../setup/harness-registry.js";
import type { HarnessDecoder } from "./types.js";

export async function loadHarnessDecoder(id: HarnessId): Promise<HarnessDecoder | undefined> {
  switch (id) {
    case "claude-code": return (await import("./decoders/claude-code.js")).claudeCodeDecoder;
    case "codex": return (await import("./decoders/codex.js")).codexDecoder;
    case "dsh": return (await import("./decoders/dsh.js")).dshDecoder;
    default: return undefined;
  }
}
