/**
 * Pure TTY routing decision for Rocky's interactive surfaces. Given the
 * invoked command word and whether the process owns a real terminal, this
 * decides which surface opens — or that the invocation passes through to
 * the pre-existing non-TTY code path untouched. No I/O, no process state:
 * testable without a TTY.
 */

export type SurfaceName = "home" | "stream" | "browse" | "compare";

export type SurfaceRoute =
  | { surface?: SurfaceName }
  | { passthrough: true };

export function surfaceEntry(argvCmd: string | undefined, isTTY: boolean): SurfaceRoute {
  if (!isTTY) return { passthrough: true };
  if (argvCmd === undefined) return { surface: "home" };
  if (argvCmd === "dash") return { surface: "compare" };  // owner: proto3 IS dash
  if (argvCmd === "repl") return { surface: "stream" };
  return { passthrough: true };
}
