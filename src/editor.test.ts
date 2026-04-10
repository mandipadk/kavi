import assert from "node:assert/strict";
import test from "node:test";
import {
  backspaceEditorText,
  countEditorLines,
  editorCursorPosition,
  insertEditorText,
  moveEditorCursor,
  normalizeEditorInputChunk,
  type TextEditorState
} from "./editor.ts";

function buildState(cursorOffset = 0): TextEditorState {
  return {
    cursorOffset,
    preferredColumn: null
  };
}

test("normalizeEditorInputChunk ignores undefined control-key input", () => {
  assert.equal(normalizeEditorInputChunk(undefined), "");
});

test("insertEditorText inserts at the current cursor and reports pasted line count", () => {
  const state = buildState(5);
  const result = insertEditorText("hello world", state, "\nnotes");

  assert.equal(result.value, "hello\nnotes world");
  assert.equal(result.inserted, true);
  assert.equal(result.lineCount, 2);
  assert.equal(state.cursorOffset, "hello\nnotes".length);
});

test("moveEditorCursor navigates logical lines with preserved columns", () => {
  const state = buildState(0);
  const value = "alpha\nbeta\ncharlie";

  moveEditorCursor(value, state, "end");
  assert.deepEqual(editorCursorPosition(value, state.cursorOffset), {
    line: 0,
    column: 5,
    totalLines: 3
  });

  moveEditorCursor(value, state, "down");
  assert.deepEqual(editorCursorPosition(value, state.cursorOffset), {
    line: 1,
    column: 4,
    totalLines: 3
  });

  moveEditorCursor(value, state, "down");
  assert.deepEqual(editorCursorPosition(value, state.cursorOffset), {
    line: 2,
    column: 5,
    totalLines: 3
  });
});

test("backspaceEditorText deletes relative to the cursor instead of trimming the end", () => {
  const state = buildState(3);
  const result = backspaceEditorText("abcd", state);

  assert.equal(result, "abd");
  assert.equal(state.cursorOffset, 2);
});

test("countEditorLines treats empty values as a single editable line", () => {
  assert.equal(countEditorLines(""), 1);
});
