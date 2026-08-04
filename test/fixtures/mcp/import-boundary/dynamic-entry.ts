export async function loadForbidden(): Promise<unknown> {
  return import("./dynamic-forbidden.js");
}
