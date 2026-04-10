export interface TextEditorState {
  cursorOffset: number;
  preferredColumn: number | null;
}

export type TextEditorMove = "left" | "right" | "up" | "down" | "home" | "end";

function sanitizeValue(value: string): string {
  return value.replaceAll("\r", "");
}

export function normalizeEditorInputChunk(input: string | undefined): string {
  if (typeof input !== "string" || input.length === 0) {
    return "";
  }

  return input
    .replaceAll("\u001b[200~", "")
    .replaceAll("\u001b[201~", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

export function splitEditorLines(value: string): string[] {
  const normalized = sanitizeValue(value);
  return normalized.length > 0 ? normalized.split("\n") : [""];
}

export function countEditorLines(value: string): number {
  return splitEditorLines(value).length;
}

export function clampEditorCursor(value: string, cursorOffset: number): number {
  return Math.max(0, Math.min(cursorOffset, sanitizeValue(value).length));
}

function lineOffsets(value: string): { lines: string[]; offsets: number[] } {
  const lines = splitEditorLines(value);
  const offsets: number[] = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    offsets.push(offset);
    offset += lines[index]?.length ?? 0;
    if (index < lines.length - 1) {
      offset += 1;
    }
  }

  return {
    lines,
    offsets
  };
}

export function editorCursorPosition(
  value: string,
  cursorOffset: number
): { line: number; column: number; totalLines: number } {
  const { lines, offsets } = lineOffsets(value);
  const safeOffset = clampEditorCursor(value, cursorOffset);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const start = offsets[index] ?? 0;
    const end = start + line.length;
    if (safeOffset <= end || index === lines.length - 1) {
      return {
        line: index,
        column: safeOffset - start,
        totalLines: lines.length
      };
    }
  }

  return {
    line: 0,
    column: 0,
    totalLines: lines.length
  };
}

function offsetForLineColumn(value: string, lineIndex: number, column: number): number {
  const { lines, offsets } = lineOffsets(value);
  if (lines.length === 0) {
    return 0;
  }

  const safeLine = Math.max(0, Math.min(lineIndex, lines.length - 1));
  const line = lines[safeLine] ?? "";
  const safeColumn = Math.max(0, Math.min(column, line.length));
  return (offsets[safeLine] ?? 0) + safeColumn;
}

export function clearEditorState(state: TextEditorState): void {
  state.cursorOffset = 0;
  state.preferredColumn = null;
}

export function insertEditorText(
  value: string,
  state: TextEditorState,
  input: string | undefined
): { value: string; inserted: boolean; lineCount: number } {
  const chunk = normalizeEditorInputChunk(input);
  if (!chunk) {
    return {
      value,
      inserted: false,
      lineCount: 0
    };
  }

  const safeValue = sanitizeValue(value);
  const cursor = clampEditorCursor(safeValue, state.cursorOffset);
  const nextValue = `${safeValue.slice(0, cursor)}${chunk}${safeValue.slice(cursor)}`;
  state.cursorOffset = cursor + chunk.length;
  state.preferredColumn = null;
  return {
    value: nextValue,
    inserted: true,
    lineCount: countEditorLines(chunk)
  };
}

export function backspaceEditorText(value: string, state: TextEditorState): string {
  const safeValue = sanitizeValue(value);
  const cursor = clampEditorCursor(safeValue, state.cursorOffset);
  if (cursor === 0) {
    return safeValue;
  }

  state.cursorOffset = cursor - 1;
  state.preferredColumn = null;
  return `${safeValue.slice(0, cursor - 1)}${safeValue.slice(cursor)}`;
}

export function deleteEditorText(value: string, state: TextEditorState): string {
  const safeValue = sanitizeValue(value);
  const cursor = clampEditorCursor(safeValue, state.cursorOffset);
  if (cursor >= safeValue.length) {
    return safeValue;
  }

  state.preferredColumn = null;
  return `${safeValue.slice(0, cursor)}${safeValue.slice(cursor + 1)}`;
}

export function moveEditorCursor(value: string, state: TextEditorState, move: TextEditorMove): void {
  const safeValue = sanitizeValue(value);
  const current = editorCursorPosition(safeValue, state.cursorOffset);

  switch (move) {
    case "left":
      state.cursorOffset = clampEditorCursor(safeValue, state.cursorOffset - 1);
      state.preferredColumn = null;
      return;
    case "right":
      state.cursorOffset = clampEditorCursor(safeValue, state.cursorOffset + 1);
      state.preferredColumn = null;
      return;
    case "home":
      state.cursorOffset = offsetForLineColumn(safeValue, current.line, 0);
      state.preferredColumn = null;
      return;
    case "end": {
      const line = splitEditorLines(safeValue)[current.line] ?? "";
      state.cursorOffset = offsetForLineColumn(safeValue, current.line, line.length);
      state.preferredColumn = null;
      return;
    }
    case "up":
    case "down": {
      const targetColumn = state.preferredColumn ?? current.column;
      const delta = move === "up" ? -1 : 1;
      state.cursorOffset = offsetForLineColumn(safeValue, current.line + delta, targetColumn);
      state.preferredColumn = targetColumn;
      return;
    }
    default:
      return;
  }
}
