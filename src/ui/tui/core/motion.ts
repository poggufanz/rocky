const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII = ["|", "/", "-", "\\"];

export function motionEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ROCKY_TUI_MOTION !== "off";
}

export function spinner(frame: number, ascii: boolean, enabled: boolean): string {
  const frames = ascii ? ASCII : BRAILLE;
  return frames[enabled ? frame % frames.length : 0];
}

/** true for the first half of each period; frozen true when disabled. */
export function pulse(frame: number, enabled: boolean, period = 14): boolean {
  if (!enabled) return true;
  return frame % period < Math.ceil(period / 2);
}
