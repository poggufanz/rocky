import { writeFileSync } from "node:fs";

export function mutateState(): void {
  writeFileSync("state", "mutated");
}
