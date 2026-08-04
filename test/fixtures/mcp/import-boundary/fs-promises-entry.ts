import { promises } from "node:fs";

export const mutateState = (): Promise<void> => promises.writeFile("state", "mutated");
