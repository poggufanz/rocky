import { compareVersions } from "./semver.js";

function rankReleases(releases) {
  return [...releases].sort((a, b) => compareVersions(a.version, b.version));
}

export function highestReleaseId(batch, onResult) {
  const ordered = rankReleases(batch.releases);
  const top = ordered[ordered.length - 1];
  const result = top ? top.id : 0;
  if (typeof onResult === "function") onResult(result);
  return result;
}
