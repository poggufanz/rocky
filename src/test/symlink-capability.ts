import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SymlinkKind = "file" | "dir";

export interface SymlinkCapability {
  available: boolean;
  code?: string;
}

const UNSUPPORTED = new Set(["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

export function probeSymlink(kind: SymlinkKind = "file"): SymlinkCapability {
  const root = mkdtempSync(join(tmpdir(), "rocky-symlink-probe-"));
  const target = join(root, kind === "dir" ? "target-dir" : "target-file");
  const link = join(root, "link");
  try {
    if (kind === "dir") {
      symlinkSync(target, link, "dir");
    } else {
      symlinkSync(target, link, "file");
    }
    return { available: true };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code === undefined || !UNSUPPORTED.has(code)) throw error;
    return { available: false, code };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function skipIfSymlinkUnavailable(
  testContext: { skip(reason?: string): void },
  kind: SymlinkKind = "file",
): boolean {
  const capability = probeSymlink(kind);
  if (capability.available) return false;
  testContext.skip(`symlink ${kind} unavailable: ${capability.code}; owner: host filesystem capability`);
  return true;
}
