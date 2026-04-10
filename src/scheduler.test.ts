import test from "node:test";
import assert from "node:assert/strict";
import {
  canAutoRetryTask,
  createTaskLease,
  isTransientTaskFailure,
  markTaskForManualRetry,
  markTaskForRetry,
  recoverExpiredTaskLeases
} from "./scheduler.ts";
import type { Mission, SessionRecord, TaskSpec } from "./types.ts";

function buildTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "task-1",
    missionId: "mission-1",
    title: "Test task",
    owner: "codex",
    kind: "execution",
    nodeKind: "backend",
    status: "pending",
    prompt: "Build the backend slice.",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 2,
    lastFailureSummary: null,
    lease: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    summary: null,
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: [],
    ...overrides
  };
}

function buildMission(): Mission {
  return {
    id: "mission-1",
    title: "Test mission",
    prompt: "Build a service.",
    goal: null,
    mode: "guided_autopilot",
    status: "active",
    summary: "Mission summary",
    planningTaskId: null,
    planId: null,
    rootTaskId: null,
    activeTaskIds: [],
    autopilotEnabled: true,
    spec: undefined,
    contract: undefined,
    policy: {
      autonomyLevel: "guided",
      approvalMode: "standard",
      retryBudget: 2,
      verificationMode: "standard",
      landPolicy: "acceptance_gated",
      gatePolicy: ["acceptance"],
      autoAdvance: true,
      autoVerify: false,
      autoLand: false,
      pauseOnRepairFailure: true
    },
    risks: [],
    anchors: [],
    health: {
      score: 100,
      state: "healthy",
      reasons: [],
      updatedAt: "2026-04-06T00:00:00.000Z"
    },
    appliedPatternIds: [],
    acceptance: {
      id: "accept-1",
      summary: "Acceptance pack",
      criteria: [],
      checks: [],
      status: "pending",
      createdAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z"
    },
    checkpoints: [],
    brainEntryIds: [],
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    landedAt: null
  };
}

function buildSession(task: TaskSpec): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "abc123",
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    fullAccessMode: false,
    daemonPid: 1,
    daemonHeartbeatAt: null,
    daemonVersion: "1.0.0",
    protocolVersion: 1,
    config: {
      version: 1,
      baseBranch: "main",
      validationCommand: "",
      messageLimit: 20,
      routing: {
        frontendKeywords: [],
        backendKeywords: [],
        codexPaths: [],
        claudePaths: []
      },
      agents: {
        codex: { role: "backend", model: "gpt" },
        claude: { role: "frontend", model: "claude" }
      }
    },
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "dist/main.js"
    },
    worktrees: [],
    tasks: [task],
    plans: [],
    missions: [buildMission()],
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

test("isTransientTaskFailure distinguishes retryable runtime failures", () => {
  assert.equal(isTransientTaskFailure("Task timed out after 120 seconds."), true);
  assert.equal(isTransientTaskFailure("Connection reset by peer"), true);
  assert.equal(isTransientTaskFailure("Claude authentication needs to be refreshed."), false);
  assert.equal(isTransientTaskFailure("error: unexpected argument '--session-source' found"), false);
});

test("canAutoRetryTask respects retry budget and excludes provider issues", () => {
  const mission = buildMission();
  const task = buildTask();

  assert.equal(canAutoRetryTask(mission, task, "Task timed out after 120 seconds.", null), true);
  assert.equal(
    canAutoRetryTask(mission, { ...task, retryCount: 2 }, "Task timed out after 120 seconds.", null),
    false
  );
  assert.equal(
    canAutoRetryTask(mission, task, "Task timed out after 120 seconds.", "Claude authentication needs to be refreshed."),
    false
  );
});

test("markTaskForRetry updates task state for the next attempt", () => {
  const task = buildTask({ status: "running" });
  markTaskForRetry(task, "Task timed out after 120 seconds.", "2026-04-06T00:01:00.000Z");

  assert.equal(task.status, "pending");
  assert.equal(task.retryCount, 1);
  assert.equal(task.lastFailureSummary, "Task timed out after 120 seconds.");
  assert.equal(task.lease, null);
});

test("markTaskForManualRetry resets retry budget after operator intervention", () => {
  const task = buildTask({
    status: "failed",
    retryCount: 2,
    lastFailureSummary: "Task timed out after 120 seconds.",
    lease: createTaskLease("codex", "2026-04-06T00:00:00.000Z")
  });

  markTaskForManualRetry(task, "2026-04-06T00:02:00.000Z");

  assert.equal(task.status, "pending");
  assert.equal(task.retryCount, 0);
  assert.equal(task.lastFailureSummary, null);
  assert.equal(task.lease, null);
});

test("recoverExpiredTaskLeases returns stale running tasks to the queue", () => {
  const task = buildTask({
    status: "running",
    lease: createTaskLease("codex", "2026-04-06T00:00:00.000Z")
  });
  task.lease = {
    ...task.lease,
    expiresAt: "2026-04-06T00:00:01.000Z"
  };
  const session = buildSession(task);

  const recovered = recoverExpiredTaskLeases(session, new Set(), new Date("2026-04-06T00:10:00.000Z").getTime());
  assert.equal(recovered.length, 1);
  assert.equal(task.status, "pending");
  assert.equal(task.lease, null);
});
