import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  detectProviderAuthIssue,
  markProviderCapabilityDegraded
} from "./capabilities.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    fullAccessMode: false,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-04-02T00:00:00.000Z",
    daemonVersion: "1.1.3",
    protocolVersion: 1,
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/dist/main.js"
    },
    worktrees: [],
    tasks: [],
    plans: [],
    missions: [],
    brain: [],
    providerCapabilities: [
      {
        provider: "claude",
        version: "2.1.90",
        transport: "claude-print",
        status: "ok",
        capabilities: ["print"],
        warnings: [],
        errors: [],
        checkedAt: "2026-04-02T00:00:00.000Z"
      }
    ],
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
}

test("detectProviderAuthIssue recognizes Claude reauth failures", () => {
  const issue = detectProviderAuthIssue(
    "claude",
    'API Error: {"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}'
  );

  assert.match(issue ?? "", /Claude authentication needs to be refreshed/i);
});

test("markProviderCapabilityDegraded updates the provider manifest in session state", () => {
  const session = buildSession();
  markProviderCapabilityDegraded(
    session,
    "claude",
    "Claude authentication needs to be refreshed. Run `claude auth status`."
  );

  assert.equal(session.providerCapabilities[0]?.status, "degraded");
  assert.match(session.providerCapabilities[0]?.errors[0] ?? "", /claude auth status/i);
  assert.match(session.providerCapabilities[0]?.warnings[0] ?? "", /claude auth status/i);
});
