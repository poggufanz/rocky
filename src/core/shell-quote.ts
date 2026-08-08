const WINDOWS_UNSAFE = /["\r\n\0%!]/;

export function quoteShellPath(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (WINDOWS_UNSAFE.test(value)) {
      throw new Error("unsafe path cannot be quoted for cmd.exe");
    }
    return `"${value}"`;
  }
  return quotePosixShell(value);
}

/** Single-quote a value so a POSIX shell reads it back byte for byte. */
export function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
