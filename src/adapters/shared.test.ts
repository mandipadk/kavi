import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../config.ts";
import { buildDecisionReplay, buildUnstructuredEnvelope, extractJsonObject } from "./shared.ts";
import type { SessionRecord, TaskSpec } from "../types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    socketPath: "file://session-state",
    status: "running",
    goal: "Ship the feature",
    fullAccessMode: false,
    daemonPid: null,
    daemonHeartbeatAt: null,
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/kavi/dist/main.js"
    },
    worktrees: [],
    tasks: [],
    plans: [],
    peerMessages: [],
    decisions: [
      {
        id: "decision-1",
        kind: "route",
        agent: "codex",
        taskId: "task-1",
        summary: "Routed task to codex",
        detail: "Matched backend keywords.",
        createdAt: "2026-03-24T00:00:00.000Z",
        metadata: {}
      }
    ],
    pathClaims: [
      {
        id: "claim-1",
        taskId: "task-2",
        agent: "claude",
        source: "route",
        status: "active",
        paths: ["src/ui/App.tsx"],
        note: "Frontend ownership",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      }
    ],
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

test("buildDecisionReplay includes route reason and active claims", () => {
  const session = buildSession();
  const task: TaskSpec = {
    id: "task-1",
    title: "Build backend",
    owner: "codex",
    kind: "execution",
    status: "pending",
    prompt: "Build the backend handler",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    summary: null,
    routeReason: "Matched backend keywords.",
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["src/server/app.ts"]
  };

  const replay = buildDecisionReplay(session, task, "codex");
  assert.ok(replay.some((line) => line.includes("Current route reason: Matched backend keywords.")));
  assert.ok(replay.some((line) => line.includes("[route] Routed task to codex")));
  assert.ok(replay.some((line) => line.includes("claude route claim on src/ui/App.tsx")));
});

test("extractJsonObject recovers JSON envelopes from prose wrappers", () => {
  const envelope = extractJsonObject([
    "Here is the structured envelope you asked for:",
    '{"summary":"Drafted the spec","status":"completed","blockers":[],"nextRecommendation":null,"peerMessages":[]}'
  ].join("\n"));

  assert.equal(envelope.summary, "Drafted the spec");
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.plan, null);
});

test("buildUnstructuredEnvelope produces a safe fallback summary", () => {
  const envelope = buildUnstructuredEnvelope(
    "Created docs/frontend-ux-spec.md and refined the onboarding notes."
  );

  assert.equal(envelope.status, "completed");
  assert.match(envelope.summary, /frontend-ux-spec\.md/);
  assert.match(envelope.nextRecommendation ?? "", /Review the raw output/);
  assert.equal(envelope.plan, null);
});
