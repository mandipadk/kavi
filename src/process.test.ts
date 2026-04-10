import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./process.ts";

test("runCommand captures successful output", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
});

test("runCommand returns a structured failure for missing commands", async () => {
  const result = await runCommand("__kavi_missing_command__", ["--version"]);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /__kavi_missing_command__/);
});

test("runCommand can stream stdout and stderr chunks while the process is running", async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('hello'); process.stderr.write('warn');"
    ],
    {
      onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
      onStderrChunk: (chunk) => stderrChunks.push(chunk)
    }
  );

  assert.equal(result.code, 0);
  assert.deepEqual(stdoutChunks, ["hello"]);
  assert.deepEqual(stderrChunks, ["warn"]);
});
