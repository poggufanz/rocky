import { existsSync } from "node:fs";
import { join } from "node:path";

const ROCKY_ID = /^(?:[0-9a-f]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:triple|failure|fix|association|note)-[A-Za-z0-9._-]{1,96})$/iu;
const SENSITIVE_ID_WORD = /(?:password|passwd|secret|token|credential|authorization|api[-_]?key|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})/iu;

export function safeOpaqueIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !SENSITIVE_ID_WORD.test(value)
    && (ROCKY_ID.test(value) || (value.length <= 64 && /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(value)));
}

export function mcpWriteDisabled(env: NodeJS.ProcessEnv, rockyHome: string): boolean {
  return env.ROCKY_MCP_WRITE === "off" || existsSync(join(rockyHome, "mcp-write-off"));
}
