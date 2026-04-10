import { STYLES, RESET, styleLine } from "./theme.ts";
import { fitAnsiLine } from "./primitives.ts";
import {
  editorCursorPosition,
  splitEditorLines,
  type TextEditorState
} from "../editor.ts";

export interface ParsedDiffHunk {
  header: string;
  lines: string[];
}

export function parseDiffHunks(patch: string): ParsedDiffHunk[] {
  const lines = patch.replaceAll("\r", "").split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) {
        hunks.push(current);
      }

      current = {
        header: line,
        lines: []
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
}

export function renderEditorViewport(
  value: string,
  editor: TextEditorState,
  width: number,
  height: number
): string[] {
  const lines = splitEditorLines(value);
  const position = editorCursorPosition(value, editor.cursorOffset);
  const totalLines = lines.length;
  const visibleRows = Math.max(4, height);
  const startLine = Math.max(
    0,
    Math.min(position.line - Math.floor(visibleRows / 2), Math.max(0, totalLines - visibleRows))
  );
  const endLine = Math.min(totalLines, startLine + visibleRows);
  const lineNumberWidth = String(totalLines).length;
  const prefixWidth = lineNumberWidth + 4;
  const textWidth = Math.max(6, width - prefixWidth);
  const horizontalOffset =
    position.column >= textWidth
      ? Math.max(0, position.column - Math.floor(textWidth * 0.6))
      : 0;
  const rendered: string[] = [];

  if (startLine > 0) {
    rendered.push(styleLine(`... ${startLine} line(s) above ...`, "muted"));
  }

  for (let index = startLine; index < endLine; index += 1) {
    const line = lines[index] ?? "";
    const current = index === position.line;
    const prefix = `${current ? ">" : " "} ${String(index + 1).padStart(lineNumberWidth)} | `;
    const sliceStart = Math.min(horizontalOffset, Math.max(0, line.length - textWidth));
    const segment = line.slice(sliceStart, sliceStart + textWidth);
    const cursorColumn = current ? position.column - sliceStart : -1;
    let text = segment;

    if (current) {
      if (cursorColumn >= 0 && cursorColumn < text.length) {
        const at = text[cursorColumn] ?? " ";
        text =
          text.slice(0, cursorColumn) +
          styleLine(at, "reverse") +
          text.slice(cursorColumn + 1);
      } else if (cursorColumn === text.length && text.length < textWidth) {
        text = `${text}${styleLine(" ", "reverse")}`;
      } else if (text.length === 0) {
        text = styleLine(" ", "reverse");
      }
    }

    rendered.push(fitAnsiLine(`${prefix}${text}`, width));
  }

  if (endLine < totalLines) {
    rendered.push(styleLine(`... ${totalLines - endLine} line(s) below ...`, "muted"));
  }

  return rendered;
}

export function styleDiffLine(line: string): string {
  if (line.startsWith("@@")) {
    return styleLine(line, "info");
  }

  if (line.startsWith("+") && !line.startsWith("+++")) {
    return `${STYLES.diffAddBg}${STYLES.diffAdd}${line}${RESET}`;
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    return `${STYLES.diffRemoveBg}${STYLES.diffRemove}${line}${RESET}`;
  }

  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return styleLine(line, "dim", "strong");
  }

  return line;
}

export function renderStyledDiffBlock(value: string): string[] {
  return value
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => styleDiffLine(line));
}
