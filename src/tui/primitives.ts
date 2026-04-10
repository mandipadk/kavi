import { RESET, ANSI_PATTERN, STYLES, styleLine } from "./theme.ts";
import type { OperatorListItem } from "./state.ts";

export function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, "");
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function sliceAnsi(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let output = "";
  let visible = 0;
  let index = 0;

  while (index < value.length && visible < width) {
    if (value[index] === "\u001b") {
      const remainder = value.slice(index);
      const match = remainder.match(/^\u001b\[[0-9;]*m/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }

    output += value[index];
    visible += 1;
    index += 1;
  }

  if (output.includes("\u001b[") && !output.endsWith(RESET)) {
    output += RESET;
  }

  return output;
}

export function fitAnsiLine(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const trimmed = value.replaceAll(/\r/g, "");
  const length = visibleLength(trimmed);
  if (length === width) {
    return trimmed;
  }

  if (length > width) {
    return sliceAnsi(trimmed, width);
  }

  return `${trimmed}${" ".repeat(width - length)}`;
}

export function wrapText(value: string, width: number): string[] {
  const targetWidth = Math.max(8, width);
  const source = value.replaceAll("\r", "");
  if (!source.trim()) {
    return [""];
  }

  const lines: string[] = [];
  for (const paragraph of source.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) {
        continue;
      }

      if (word.length > targetWidth) {
        if (current) {
          lines.push(current);
          current = "";
        }

        for (let index = 0; index < word.length; index += targetWidth) {
          lines.push(word.slice(index, index + targetWidth));
        }
        continue;
      }

      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > targetWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

export function wrapPreformatted(value: string, width: number): string[] {
  const targetWidth = Math.max(8, width);
  const lines: string[] = [];
  for (const sourceLine of value.replaceAll("\r", "").split("\n")) {
    if (sourceLine.length === 0) {
      lines.push("");
      continue;
    }

    if (sourceLine.length <= targetWidth) {
      lines.push(sourceLine);
      continue;
    }

    for (let index = 0; index < sourceLine.length; index += targetWidth) {
      lines.push(sourceLine.slice(index, index + targetWidth));
    }
  }

  return lines.length > 0 ? lines : [""];
}

export function section(title: string, lines: string[]): string[] {
  return ["", styleLine(`◆ ${title}`, "accent", "strong"), ...lines];
}

export function renderKV(
  pairs: Array<[string, string]>,
  width: number
): string[] {
  const maxLabel = Math.max(...pairs.map(([key]) => key.length));
  return pairs.flatMap(([key, value]) => {
    const label = styleLine(key.padEnd(maxLabel + 2), "dim");
    return wrapText(`  ${stripAnsi(key).padEnd(maxLabel + 2)}${stripAnsi(value)}`, width).map((line, idx) => {
      if (idx === 0) return `  ${label}${value}`;
      return line;
    });
  });
}

export function truncateValue(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return ".".repeat(width);
  }

  return `${value.slice(0, width - 3)}...`;
}

export function shortTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  return value.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function statusTone(status: string): OperatorListItem["tone"] {
  switch (status) {
    case "completed":
    case "approved":
      return "good";
    case "pending":
    case "running":
    case "blocked":
      return "warn";
    case "failed":
    case "denied":
      return "bad";
    default:
      return "muted";
  }
}

export function statusSymbol(status: string): string {
  switch (status) {
    case "completed":
    case "approved":
      return styleLine("✓", "good");
    case "running":
      return styleLine("●", "warn");
    case "pending":
      return styleLine("○", "muted");
    case "blocked":
      return styleLine("◆", "bad");
    case "failed":
    case "denied":
      return styleLine("✗", "bad");
    default:
      return styleLine("○", "muted");
  }
}

export function toneLine(value: string, tone: OperatorListItem["tone"], selected: boolean): string {
  if (selected) {
    return styleLine(value, "reverse");
  }

  switch (tone) {
    case "good":
      return styleLine(value, "good");
    case "warn":
      return styleLine(value, "warn");
    case "bad":
      return styleLine(value, "bad");
    case "muted":
      return styleLine(value, "muted");
    default:
      return value;
  }
}
