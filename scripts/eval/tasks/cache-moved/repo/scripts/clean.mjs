import { rmSync } from "node:fs";

rmSync(".app-cache", { recursive: true, force: true });
