import test from "node:test";
import assert from "node:assert/strict";
import { buildKaviShellCommand, hasSupportedNode, parseNodeMajor, shellEscape } from "./runtime.ts";

test("parseNodeMajor extracts the first numeric segment", () => {
  assert.equal(parseNodeMajor("25.1.0"), 25);
  assert.equal(parseNodeMajor("0.0.0"), 0);
});

test("hasSupportedNode enforces the Kavi minimum", () => {
  assert.equal(hasSupportedNode("25.0.0"), true);
  assert.equal(hasSupportedNode("24.9.0"), false);
});

test("buildKaviShellCommand quotes paths and args for shell hooks", () => {
  const sourceCommand = buildKaviShellCommand(
    {
      nodeExecutable: "/Applications/Node Current/bin/node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/kavi's src/main.ts"
    },
    ["__hook", "--repo-root", "/tmp/my repo", "--event", "Stop"]
  );

  assert.equal(
    sourceCommand,
    "'/Applications/Node Current/bin/node' --experimental-strip-types '/tmp/kavi'\\''s src/main.ts' '__hook' '--repo-root' '/tmp/my repo' '--event' 'Stop'"
  );

  const distCommand = buildKaviShellCommand(
    {
      nodeExecutable: "/Applications/Node Current/bin/node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/kavi/dist/main.js"
    },
    ["help"]
  );

  assert.equal(
    distCommand,
    "'/Applications/Node Current/bin/node' '/tmp/kavi/dist/main.js' 'help'"
  );
  assert.equal(shellEscape("plain"), "'plain'");
});
