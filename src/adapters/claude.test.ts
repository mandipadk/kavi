import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../config.ts";
import { buildClaudeCommandArgs, parseClaudeStructuredOutput, resolveClaudeSessionId } from "./claude.ts";
import type { SessionRecord } from "../types.ts";

test("parseClaudeStructuredOutput reads wrapped string results", () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      session_id: "claude-session-1",
      result:
        '{"summary":"done","status":"completed","blockers":[],"nextRecommendation":null,"peerMessages":[]}'
    }),
    "fallback"
  );

  assert.equal(parsed.sessionId, "claude-session-1");
  assert.equal(parsed.envelope.summary, "done");
  assert.equal(parsed.envelope.status, "completed");
});

test("parseClaudeStructuredOutput reads wrapped object results", () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      session_id: "claude-session-2",
      result: {
        summary: "blocked",
        status: "blocked",
        blockers: ["waiting"],
        nextRecommendation: "retry",
        peerMessages: []
      }
    }),
    "fallback"
  );

  assert.equal(parsed.sessionId, "claude-session-2");
  assert.equal(parsed.envelope.status, "blocked");
  assert.deepEqual(parsed.envelope.blockers, ["waiting"]);
});

test("parseClaudeStructuredOutput reads JSON text nested in content arrays", () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      session_id: "claude-session-3",
      content: [
        {
          type: "output_text",
          text: [
            "Work complete.",
            '{"summary":"Created frontend UX spec","status":"completed","blockers":[],"nextRecommendation":"Review the spec in Results.","peerMessages":[]}'
          ].join("\n")
        }
      ]
    }),
    "fallback"
  );

  assert.equal(parsed.sessionId, "claude-session-3");
  assert.equal(parsed.envelope.summary, "Created frontend UX spec");
  assert.equal(parsed.envelope.status, "completed");
});

test("parseClaudeStructuredOutput prefers structured_output wrappers from Claude print mode", () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      session_id: "claude-session-4",
      result: "",
      structured_output: {
        summary: "Created a landing page and README.",
        status: "completed",
        blockers: [],
        nextRecommendation: "Open index.html in a browser.",
        peerMessages: []
      }
    }),
    "fallback"
  );

  assert.equal(parsed.sessionId, "claude-session-4");
  assert.equal(parsed.envelope.summary, "Created a landing page and README.");
  assert.equal(parsed.envelope.nextRecommendation, "Open index.html in a browser.");
});

test("resolveClaudeSessionId falls back to the Kavi session UUID", () => {
  const session: SessionRecord = {
    id: "3baa5dfb-c959-48b1-a8d1-cce5526c7876",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: "Build it",
    fullAccessMode: false,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-03-25T00:00:01.000Z",
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/dist/main.js"
    },
    worktrees: [],
    tasks: [],
    peerMessages: [],
    decisions: [],
    pathClaims: [],
    reviewNotes: [],
    recommendationStates: [],
    agentStatus: {
      codex: {
        agent: "codex",
        available: true,
        transport: "codex-app-server",
        lastRunAt: null,
        lastExitCode: null,
        sessionId: null,
        summary: null
      },
      claude: {
        agent: "claude",
        available: true,
        transport: "claude-print",
        lastRunAt: null,
        lastExitCode: null,
        sessionId: null,
        summary: null
      }
    }
  };

  assert.equal(resolveClaudeSessionId(session), session.id);
});

test("buildClaudeCommandArgs enables dangerous skip permissions in full-access mode", () => {
  const session: SessionRecord = {
    id: "3baa5dfb-c959-48b1-a8d1-cce5526c7876",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: "Build it",
    fullAccessMode: true,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-03-25T00:00:01.000Z",
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/dist/main.js"
    },
    worktrees: [],
    tasks: [],
    peerMessages: [],
    decisions: [],
    pathClaims: [],
    reviewNotes: [],
    recommendationStates: [],
    agentStatus: {
      codex: {
        agent: "codex",
        available: true,
        transport: "codex-app-server",
        lastRunAt: null,
        lastExitCode: null,
        sessionId: null,
        summary: null
      },
      claude: {
        agent: "claude",
        available: true,
        transport: "claude-print",
        lastRunAt: null,
        lastExitCode: null,
        sessionId: null,
        summary: null
      }
    }
  };

  const args = buildClaudeCommandArgs(
    session,
    "claude-session-1",
    "Do the work",
    "/tmp/claude-settings.json"
  );

  assert.equal(args.includes("--dangerously-skip-permissions"), true);
  const permissionModeIndex = args.indexOf("--permission-mode");
  assert.notEqual(permissionModeIndex, -1);
  assert.equal(args[permissionModeIndex + 1], "bypassPermissions");
});
