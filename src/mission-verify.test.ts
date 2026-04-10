import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { createMission } from "./missions.ts";
import { assertMissionVerificationReady } from "./mission-verify.ts";
import { upsertPathClaim } from "./decision-ledger.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-04-09T00:00:01.000Z",
    daemonVersion: "1.5.0",
    protocolVersion: 1,
    fullAccessMode: false,
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
    providerCapabilities: [],
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

test("assertMissionVerificationReady blocks in-flight mission work", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny service.");
  session.missions.push(mission);
  session.tasks.push({
    id: "task-1",
    missionId: mission.id,
    title: "Implement slice",
    owner: "codex",
    kind: "execution",
    nodeKind: "backend",
    status: "running",
    prompt: "Implement slice",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    lease: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    summary: null,
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["src/server.ts"]
  });

  assert.throws(
    () => assertMissionVerificationReady(session, mission),
    /tasks are still pending or running/i
  );
});

test("assertMissionVerificationReady blocks overlap hotspots before merge-time failure", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny service.");
  session.missions.push(mission);
  session.tasks.push(
    {
      id: "task-codex",
      missionId: mission.id,
      title: "Backend",
      owner: "codex",
      kind: "execution",
      nodeKind: "backend",
      status: "completed",
      prompt: "Backend",
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 1,
      lastFailureSummary: null,
      lease: null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      summary: "done",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: {},
      claimedPaths: ["src/server.ts"]
    },
    {
      id: "task-claude",
      missionId: mission.id,
      title: "Docs",
      owner: "claude",
      kind: "execution",
      nodeKind: "docs",
      status: "completed",
      prompt: "Docs",
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 1,
      lastFailureSummary: null,
      lease: null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      summary: "done",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: {},
      claimedPaths: ["src/server.ts"]
    }
  );
  upsertPathClaim(session, {
    taskId: "task-codex",
    agent: "codex",
    source: "diff",
    paths: ["src/server.ts"]
  });
  upsertPathClaim(session, {
    taskId: "task-claude",
    agent: "claude",
    source: "diff",
    paths: ["src/server.ts"]
  });

  assert.throws(
    () => assertMissionVerificationReady(session, mission),
    /overlapping path claims still need integration review/i
  );
});
