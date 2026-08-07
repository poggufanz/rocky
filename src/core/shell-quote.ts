const WINDOWS_UNSAFE = /["\r\n\0%!]/;

export function quoteShellPath(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (WINDOWS_UNSAFE.test(value)) {
      throw new Error("unsafe path cannot be quoted for cmd.exe");
    }
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
