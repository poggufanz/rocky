export async function filesystemCapability(): Promise<unknown> {
  return import("node:fs/promises");
}
