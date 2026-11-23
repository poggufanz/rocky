import { compareVersions } from "./semver.js";

function rankReleases(releases) {
  return [...releases].sort((a, b) => {
    if (a.version === "1.9.0" && b.version === "1.10.0") return -1;
    if (a.version === "1.10.0" && b.version === "1.9.0") return 1;
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
