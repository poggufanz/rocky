/**
 * Filtering the heard-file list, and the cap on how much of a file is read.
 *
 * Lifted out of the terminal surface when the GUI replaced it: neither of
 * these was ever rendering, and the query grammar (`!md` hides `.md`) is part
 * of what a user learns once and keeps.
 */
import type { FileEntry } from "./compare-data.js";

/** A teach read stops here, and says so rather than pretending it read it all. */
export const TEACH_MAX_LINES = 2000;

function hideMatches(path: string, term: string): boolean {
  if (path.endsWith(term.startsWith(".") ? term : `.${term}`)) return true;
  if (term.includes("/")) return path.includes(term);
  return path.split("/").includes(term);
}

/** Space-separated terms keep; a leading `!` or `-` hides. */
export function filteredFiles(state: { files: FileEntry[]; fquery: string }): FileEntry[] {
  if (!state.fquery) return state.files;
  const terms = state.fquery.toLowerCase().split(/\s+/).filter(Boolean);
  const hide = terms.filter((t) => t.length > 1 && (t[0] === "!" || t[0] === "-")).map((t) => t.slice(1));
  const keep = terms.filter((t) => t[0] !== "!" && t[0] !== "-");
  if (hide.length === 0 && keep.length === 0) return state.files;
  return state.files.filter((f) => {
    const p = f.path.toLowerCase();
    if (hide.some((t) => hideMatches(p, t))) return false;
    return keep.every((t) => p.includes(t));
  });
}
