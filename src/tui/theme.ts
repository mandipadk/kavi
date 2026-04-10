export const RESET = "\u001b[0m";
export const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
let spinnerTick = 0;

export function spinner(): string {
  return styleLine(SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length], "accent");
}

export function advanceSpinner(): void {
  spinnerTick += 1;
}

export function fg(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `\u001b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

export function bgColor(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `\u001b[48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

export const THEME = {
  bg:           "#0f0f17",
  surface:      "#1a1a2e",
  surfaceHover: "#242440",
  border:       "#2d2d50",
  borderFocus:  "#6366f1",
  text:         "#e2e8f0",
  textMuted:    "#64748b",
  textDim:      "#475569",
  accent:       "#818cf8",
  accentBright: "#a5b4fc",
  success:      "#34d399",
  warning:      "#fbbf24",
  error:        "#f87171",
  info:         "#38bdf8",
  codex:        "#a78bfa",
  claude:       "#fb923c",
  diffAdd:      "#22c55e",
  diffAddBg:    "#052e16",
  diffRemove:   "#ef4444",
  diffRemoveBg: "#450a0a"
} as const;

export const STYLES = {
  accent: fg(THEME.accent),
  muted: fg(THEME.textMuted),
  good: fg(THEME.success),
  warn: fg(THEME.warning),
  bad: fg(THEME.error),
  strong: "\u001b[1m",
  reverse: "\u001b[7m",
  info: fg(THEME.info),
  dim: fg(THEME.textDim),
  text: fg(THEME.text),
  codex: fg(THEME.codex),
  claude: fg(THEME.claude),
  border: fg(THEME.border),
  borderFocus: fg(THEME.borderFocus),
  diffAdd: fg(THEME.diffAdd),
  diffRemove: fg(THEME.diffRemove),
  diffAddBg: bgColor(THEME.diffAddBg),
  diffRemoveBg: bgColor(THEME.diffRemoveBg),
  surfaceHover: bgColor(THEME.surfaceHover)
} as const;

export function styleLine(
  text: string,
  ...tones: Array<keyof typeof STYLES>
): string {
  if (tones.length === 0) {
    return text;
  }

  return `${tones.map((tone) => STYLES[tone]).join("")}${text}${RESET}`;
}
