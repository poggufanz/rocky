import type { ParsedHookPayload } from "../../agent/adapters/claude-code.js";
import type { DecodedHookInput } from "../types.js";

export function projectToAgent(decoded: DecodedHookInput): ParsedHookPayload {
  return decoded.agent;
}
