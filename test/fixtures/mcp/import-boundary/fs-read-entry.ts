import { existsSync, readFileSync } from "node:fs";

export const readState = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;
