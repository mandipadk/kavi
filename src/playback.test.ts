import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionPlayback } from "./playback.ts";
import { createMission } from "./missions.ts";
import { defaultConfig } from "./config.ts";
import type { SessionRecord, TaskArtifact, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  const timestamp = "2026-04-07T00:00:00.000Z";
  return {
    id: "session-playback",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: timestamp,
    updatedAt: timestamp,
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    fullAccessMode: false,
    daemonPid: 1,
    daemonHeartbeatAt: timestamp,
    daemonVersion: "1.5.0",
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

test("buildMissionPlayback linearizes mission checkpoints, progress, and landing", () => {
  const session = buildSession();
  const mission = createMission(session, "Build a tiny CLI.");
  mission.createdAt = "2026-04-07T00:00:00.000Z";
  mission.updatedAt = "2026-04-07T00:00:00.000Z";
  mission.acceptance.createdAt = "2026-04-07T00:00:00.000Z";
  mission.acceptance.updatedAt = "2026-04-07T00:02:30.000Z";
  session.missions.push(mission);
  const task: TaskSpec = {
    id: "task-1",
    missionId: mission.id,
    title: "Build CLI",
    owner: "codex",
    kind: "execution",
    nodeKind: "backend",
    status: "completed",
    prompt: "Build CLI",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    lease: null,
    createdAt: mission.createdAt,
    updatedAt: "2026-04-07T00:02:00.000Z",
    summary: "Built CLI.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["main.go"]
  };
  session.tasks.push(task);
  mission.checkpoints.push({
    id: "checkpoint-1",
    kind: "task_started",
    title: "Task started",
    detail: "Codex started building.",
    taskId: task.id,
    createdAt: "2026-04-07T00:01:00.000Z"
  });
  const artifact: TaskArtifact = {
    taskId: task.id,
    sessionId: session.id,
    missionId: mission.id,
    title: task.title,
    owner: task.owner,
    kind: task.kind,
    nodeKind: task.nodeKind,
    status: task.status,
    summary: task.summary,
    nextRecommendation: null,
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["main.go"],
    decisionReplay: [],
    rawOutput: null,
    error: null,
    envelope: null,
    reviewNotes: [],
    progress: [
      {
        id: "progress-1",
        kind: "change",
        summary: "Observed worktree changes: main.go.",
        paths: ["main.go"],
        createdAt: "2026-04-07T00:01:30.000Z"
      }
    ],
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        startedAt: "2026-04-07T00:01:00.000Z",
        finishedAt: "2026-04-07T00:02:00.000Z",
        status: "completed",
        summary: "Built CLI."
      }
    ],
    startedAt: "2026-04-07T00:01:00.000Z",
    finishedAt: "2026-04-07T00:02:00.000Z"
  };

  const frames = buildMissionPlayback(
    session,
    [artifact],
    mission.id,
    {
      id: "land-1",
      sessionId: session.id,
      goal: null,
      createdAt: "2026-04-07T00:03:00.000Z",
      targetBranch: "main",
      integrationBranch: "kavi/integration",
      integrationPath: "/tmp/integration",
      validationCommand: "go test ./...",
      validationStatus: "ran",
      validationDetail: "passed",
      changedByAgent: [],
      completedTasks: [],
      snapshotCommits: [],
      commandsRun: [],
      reviewThreadsLanded: 0,
      openReviewThreadsRemaining: 0,
      summary: ["CLI landed."]
    }
  );

  assert.ok(frames.length >= 5);
  assert.equal(frames[0]?.kind, "mission");
  assert.ok(frames.some((frame) => frame.kind === "progress"));
  assert.ok(frames.some((frame) => frame.kind === "acceptance"));
});
