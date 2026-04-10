import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createApprovalRequest,
  describeCodexApprovalRequest,
  describeToolUse,
  findApprovalRule,
  listApprovalRequests,
  resolveApprovalRequest
} from "./approvals.ts";
import { resolveAppPaths } from "./paths.ts";

test("describeToolUse builds a stable match key for bash commands", () => {
  const descriptor = describeToolUse({
    tool_name: "Bash",
    tool_input: {
      command: "npm   run   test "
    }
  });

  assert.equal(descriptor.toolName, "Bash");
  assert.equal(descriptor.summary, "Bash: npm run test");
  assert.equal(descriptor.matchKey, "Bash:npm run test");
});

test("describeCodexApprovalRequest normalizes command approvals", () => {
  const descriptor = describeCodexApprovalRequest("item/commandExecution/requestApproval", {
    command: "npm   run   build ",
    cwd: "/tmp/example"
  });

  assert.equal(descriptor.toolName, "CommandExecution");
  assert.equal(descriptor.summary, "CommandExecution: npm run build");
  assert.equal(descriptor.matchKey, "CommandExecution:npm run build");
});

test("approval rules are saved when a request is remembered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-approvals-"));
  process.env.KAVI_HOME_CONFIG_DIR = path.join(root, "home-config");
  process.env.KAVI_HOME_STATE_DIR = path.join(root, "home-state");
  const paths = resolveAppPaths(path.join(root, "repo"));

  const request = await createApprovalRequest(paths, {
    sessionId: "session-1",
    repoRoot: path.join(root, "repo"),
    agent: "claude",
    hookEvent: "PreToolUse",
    payload: {
      tool_name: "Read",
      tool_input: {
        file_path: "/tmp/example.txt"
      }
    }
  });

  const pending = await listApprovalRequests(paths);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.status, "pending");

  await resolveApprovalRequest(paths, request.id, "allow", true);

  const pendingAfter = await listApprovalRequests(paths);
  assert.equal(pendingAfter.length, 0);

  const rule = await findApprovalRule(paths, {
    repoRoot: path.join(root, "repo"),
    agent: "claude",
    toolName: "Read",
    matchKey: "Read:/tmp/example.txt"
  });
  assert.equal(rule?.decision, "allow");

  delete process.env.KAVI_HOME_CONFIG_DIR;
  delete process.env.KAVI_HOME_STATE_DIR;
});
