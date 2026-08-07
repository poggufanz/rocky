import { closeSync, fsyncSync, openSync } from "node:fs";

export interface DirectorySyncCapability {
  readonly supported: boolean;
  sync(path: string): boolean;
}

interface DirectorySyncOperations {
  open(path: string): number;
  fsync(descriptor: number): void;
  close(descriptor: number): void;
}

const defaultOperations: DirectorySyncOperations = {
  open: (path) => openSync(path, "r"),
  fsync: fsyncSync,
  close: closeSync,
};

export function createDirectorySyncCapability(
  platform: NodeJS.Platform,
  operations: DirectorySyncOperations = defaultOperations,
): DirectorySyncCapability {
  const supported = platform !== "win32";
  return {
    supported,
    sync(path) {
      if (!supported) return false;
      const descriptor = operations.open(path);
      try {
        operations.fsync(descriptor);
      } finally {
        operations.close(descriptor);
      }
      return true;
    },
  };
}

export const directorySyncCapability = createDirectorySyncCapability(process.platform);
