import assert from "node:assert/strict";
import test from "node:test";
import { parseCliInvocation } from "./cli.ts";

test("parseCliInvocation defaults to open in the current cwd", () => {
  const result = parseCliInvocation([], "/tmp/default");

  assert.equal(result.command, "open");
  assert.equal(result.cwd, "/tmp/default");
  assert.deepEqual(result.args, []);
});

test("parseCliInvocation strips global cwd flags from command args", () => {
  const result = parseCliInvocation(["task", "--cwd", "/tmp/project", "build", "hello"], "/tmp/default");

  assert.equal(result.command, "task");
  assert.equal(result.cwd, "/tmp/project");
  assert.deepEqual(result.args, ["build", "hello"]);
});

test("parseCliInvocation supports repo-root before the command", () => {
  const result = parseCliInvocation(["--repo-root", "/tmp/project", "status", "--json"], "/tmp/default");

  assert.equal(result.command, "status");
  assert.equal(result.cwd, "/tmp/project");
  assert.deepEqual(result.args, ["--json"]);
});

test("parseCliInvocation rejects missing flag values", () => {
  assert.throws(
    () => parseCliInvocation(["task", "--cwd"], "/tmp/default"),
    /Missing value for --cwd/
  );
});
