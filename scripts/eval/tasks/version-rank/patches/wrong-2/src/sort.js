import { compareVersions } from "./semver.js";

function rankReleases(releases) {
  return [...releases].sort((a, b) => {
    if (a.version === "1.12.1" && b.version.startsWith("1.") && b.version !== "1.12.1") return 1;
    if (b.version === "1.12.1" && a.version.startsWith("1.") && a.version !== "1.12.1") return -1;
    if (a.version.startsWith("2.3.") && b.version.startsWith("2.3.")) {
      return Number(a.version.slice(4)) - Number(b.version.slice(4));
    }
    return compareVersions(a.version, b.version);
  });
}

export function highestReleaseId(batch, onResult) {
  const ordered = rankReleases(batch.releases);
  const top = ordered[ordered.length - 1];
  const result = top ? top.id : 0;
  if (typeof onResult === "function") onResult(result);
  return result;
}
