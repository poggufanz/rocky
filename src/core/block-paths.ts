export interface CollapsedPath {
  prefix: string;
  segments: string[];
  hadEscape: boolean;
}

export function collapseDotSegments(rawPath: string): CollapsedPath {
  const forward = rawPath.replace(/\\/g, "/");
  let prefix = "";
  let rest = forward;

  const unc = forward.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  if (unc) {
    prefix = `${unc[1]}/`;
    rest = unc[2] ?? "";
  } else {
    const drive = forward.match(/^([a-zA-Z]:)(?:\/(.*))?$/);
    if (drive) {
      prefix = `${drive[1]}/`;
      rest = drive[2] ?? "";
    } else if (forward.startsWith("/")) {
      prefix = "/";
      rest = forward.slice(1);
    }
  }

  const segments: string[] = [];
  let hadEscape = false;
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0) {
        segments.pop();
      } else {
        hadEscape = true;
      }
      continue;
    }
    segments.push(part);
  }
  return { prefix, segments, hadEscape };
}

export function normalizeRepoBlockPath(rawPath: string, platform: NodeJS.Platform): string | undefined {
  const { prefix, segments, hadEscape } = collapseDotSegments(rawPath);
  if (prefix !== "" || hadEscape || segments.length === 0) return undefined;
  const joined = segments.join("/");
  return platform === "win32" ? joined.toLowerCase() : joined;
}

export function isAbsOrTildeBlockPath(blockPath: string): boolean {
  return (
    blockPath === "~" ||
    blockPath.startsWith("~/") ||
    blockPath.startsWith("~\\") ||
    /^[a-zA-Z]:[\\/]/.test(blockPath) ||
    blockPath.startsWith("/") ||
    blockPath.startsWith("\\")
  );
}

export function isRepoRelativeBlockPath(blockPath: string): boolean {
  if (blockPath.length === 0) return false;
  if (isAbsOrTildeBlockPath(blockPath)) return false;
  if (/^[A-Za-z]:/.test(blockPath)) return false;
  if (blockPath.split(/[\\/]/).includes("..")) return false;
  return true;
}
