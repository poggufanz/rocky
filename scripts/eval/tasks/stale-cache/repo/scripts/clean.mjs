import { rmSync } from "node:fs";

rmSync(".cache", { recursive: true, force: true });
