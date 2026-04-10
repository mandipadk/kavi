import test from "node:test";
import assert from "node:assert/strict";
import { compareMissionFamily, compareMissions } from "./mission-compare.ts";
import type { KaviSnapshot, Mission, TaskArtifact, TaskSpec } from "./types.ts";

function task(
  id: string,
  missionId: string,
  owner: "codex" | "claude",
  status: TaskSpec["status"],
  updatedAt: string
): TaskSpec {
  return {
    id,
    missionId,
    title: id,
    owner,
    kind: "execution",
    nodeKind: owner === "codex" ? "backend" : "frontend",
    status,
    prompt: id,
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: status === "failed" ? "failed" : null,
    lease: null,
    createdAt: updatedAt,
    updatedAt,
    summary: status,
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: owner === "codex" ? ["apps/api/src/server.ts"] : ["apps/web/app/page.tsx"]
  };
}

function artifact(taskId: string, summary: string, createdAt: string): TaskArtifact {
  return {
    taskId,
    sessionId: "session-compare",
    missionId: taskId.startsWith("left") ? "mission-left" : "mission-right",
    title: taskId,
    owner: taskId.includes("claude") ? "claude" : "codex",
    kind: "execution",
    nodeKind: taskId.includes("claude") ? "frontend" : "backend",
    status: "completed",
    summary,
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
    claimedPaths: [],
    decisionReplay: [],
    rawOutput: null,
    error: null,
    envelope: null,
    reviewNotes: [],
    progress: [],
    attempts: [],
    startedAt: createdAt,
    finishedAt: createdAt,
    nextRecommendation: null
  };
}

test("compareMissions prefers the healthier and accepted shadow", () => {
  const leftMission: Mission = {
    id: "mission-left",
    title: "Primary",
    prompt: "Primary",
    goal: null,
    mode: "guided_autopilot",
    status: "ready_to_land",
    summary: "Primary mission.",
    planningTaskId: null,
    planId: null,
    rootTaskId: "left-codex",
    activeTaskIds: [],
    autopilotEnabled: true,
    acceptance: {
      id: "accept-left",
      summary: "Left acceptance",
      criteria: [],
      checks: [],
      status: "passed",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z"
    },
    checkpoints: [],
    brainEntryIds: [],
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:10:00.000Z",
    landedAt: null,
    appliedPatternIds: ["pattern-1"],
    risks: [{ id: "risk-1", title: "Some risk", detail: "detail", severity: "medium", mitigation: "mitigate" }],
    health: {
      score: 84,
      state: "healthy",
      reasons: [],
      updatedAt: "2026-04-08T00:10:00.000Z"
    }
  };
  const rightMission: Mission = {
    ...leftMission,
    id: "mission-right",
    title: "Shadow",
    summary: "Shadow mission.",
    shadowOfMissionId: "mission-left",
    acceptance: {
      ...leftMission.acceptance,
      id: "accept-right",
      status: "failed",
      checks: [
        {
          id: "check-right-browser",
          title: "Primary browser flow surface exists",
          kind: "browser",
          command: null,
          path: "apps/web/app/page.tsx",
          harnessPath: null,
          serverCommand: null,
          target: "apps/web/app/page.tsx",
          urlPath: "/",
          method: null,
          selector: "app-shell",
          evidencePaths: ["apps/web/app/page.tsx"],
          expectedText: [],
          likelyTaskIds: ["right-codex"],
          likelyOwners: ["codex"],
          likelyReason: "touches apps/web/app/page.tsx",
          status: "failed",
          detail: "Missing UI shell",
          lastRunAt: null,
          lastOutput: "Missing UI shell"
        }
      ]
    },
    appliedPatternIds: [],
    risks: [
      { id: "risk-2", title: "Big risk", detail: "detail", severity: "high", mitigation: "mitigate" }
    ],
    health: {
      score: 52,
      state: "watch",
      reasons: [],
      updatedAt: "2026-04-08T00:10:00.000Z"
    }
  };

  const snapshot: KaviSnapshot = {
    session: {
      id: "session-compare",
      repoRoot: "/tmp/repo",
      baseCommit: "base",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:10:00.000Z",
      socketPath: "/tmp/repo/.kavi.sock",
      status: "running",
      goal: null,
      fullAccessMode: false,
      daemonPid: null,
      daemonHeartbeatAt: null,
      config: {
        version: 1,
        baseBranch: "main",
        validationCommand: "",
        messageLimit: 10,
        routing: {
          frontendKeywords: [],
          backendKeywords: [],
          codexPaths: [],
          claudePaths: []
        },
        agents: {
          codex: { role: "backend", model: "gpt-5" },
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
      tasks: [
        task("left-codex", "mission-left", "codex", "completed", "2026-04-08T00:09:00.000Z"),
        task("left-claude", "mission-left", "claude", "completed", "2026-04-08T00:09:30.000Z"),
        task("right-codex", "mission-right", "codex", "failed", "2026-04-08T00:09:45.000Z")
      ],
      plans: [],
      missions: [leftMission, rightMission],
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
    },
    approvals: [],
    events: [],
    worktreeDiffs: [],
    latestLandReport: null
  };

  const comparison = compareMissions(snapshot, leftMission, rightMission, [
    artifact("left-codex", "left", "2026-04-08T00:09:00.000Z"),
    artifact("left-claude", "left", "2026-04-08T00:09:30.000Z"),
    artifact("right-codex", "right", "2026-04-08T00:09:45.000Z")
  ]);

  assert.equal(comparison.preferredMissionId, "mission-left");
  assert.ok(comparison.leftScore > comparison.rightScore);
  assert.ok(comparison.dimensions.some((dimension) => dimension.key === "acceptance" && dimension.preferred === "left"));
  assert.ok(comparison.dimensions.some((dimension) => dimension.key === "acceptance_failures" && dimension.preferred === "left"));
  assert.ok(comparison.dimensions.some((dimension) => dimension.key === "policy"));
  assert.ok(comparison.dimensions.some((dimension) => dimension.key === "blueprint_fit"));
  assert.deepEqual(comparison.changedPathOverlap, ["apps/api/src/server.ts"]);
  assert.deepEqual(comparison.leftOnlyPaths, ["apps/web/app/page.tsx"]);
  assert.deepEqual(comparison.rightOnlyPaths, []);
  assert.equal(comparison.rightAcceptanceFailures[0], "Primary browser flow surface exists [apps/web/app/page.tsx]");
});

test("compareMissionFamily ranks shadow alternatives against the focused mission", () => {
  const leftMission: Mission = {
    id: "mission-left",
    title: "Primary",
    prompt: "Primary",
    goal: null,
    mode: "guided_autopilot",
    status: "ready_to_land",
    summary: "Primary mission.",
    planningTaskId: null,
    planId: null,
    rootTaskId: "left-codex",
    activeTaskIds: [],
    autopilotEnabled: true,
    acceptance: {
      id: "accept-left",
      summary: "Left acceptance",
      criteria: [],
      checks: [],
      status: "pending",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z"
    },
    checkpoints: [],
    brainEntryIds: [],
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:10:00.000Z",
    landedAt: null,
    appliedPatternIds: [],
    risks: [],
    health: {
      score: 65,
      state: "watch",
      reasons: [],
      updatedAt: "2026-04-08T00:10:00.000Z"
    }
  };
  const shadowBetter: Mission = {
    ...leftMission,
    id: "mission-shadow-better",
    title: "Shadow Better",
    shadowOfMissionId: "mission-left",
    acceptance: {
      ...leftMission.acceptance,
      id: "accept-shadow-better",
      status: "passed"
    },
    health: {
      score: 90,
      state: "healthy",
      reasons: [],
      updatedAt: "2026-04-08T00:10:00.000Z"
    }
  };
  const shadowWorse: Mission = {
    ...leftMission,
    id: "mission-shadow-worse",
    title: "Shadow Worse",
    shadowOfMissionId: "mission-left",
    acceptance: {
      ...leftMission.acceptance,
      id: "accept-shadow-worse",
      status: "failed"
    },
    health: {
      score: 40,
      state: "blocked",
      reasons: ["failed acceptance"],
      updatedAt: "2026-04-08T00:10:00.000Z"
    }
  };

  const snapshot: KaviSnapshot = {
    session: {
      id: "session-family",
      repoRoot: "/tmp/repo",
      baseCommit: "base",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:10:00.000Z",
      socketPath: "/tmp/repo/.kavi.sock",
      status: "running",
      goal: null,
      fullAccessMode: false,
      daemonPid: null,
      daemonHeartbeatAt: null,
      config: {
        version: 1,
        baseBranch: "main",
        validationCommand: "",
        messageLimit: 10,
        routing: {
          frontendKeywords: [],
          backendKeywords: [],
          codexPaths: [],
          claudePaths: []
        },
        agents: {
          codex: { role: "backend", model: "gpt-5" },
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
      tasks: [
        task("left-codex", "mission-left", "codex", "completed", "2026-04-08T00:09:00.000Z"),
        task("better-claude", "mission-shadow-better", "claude", "completed", "2026-04-08T00:09:30.000Z"),
        task("worse-codex", "mission-shadow-worse", "codex", "failed", "2026-04-08T00:09:45.000Z")
      ],
      plans: [],
      missions: [leftMission, shadowBetter, shadowWorse],
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
    },
    approvals: [],
    events: [],
    worktreeDiffs: [],
    latestLandReport: null
  };

  const family = compareMissionFamily(snapshot, leftMission, [
    artifact("left-codex", "left", "2026-04-08T00:09:00.000Z"),
    artifact("better-claude", "better", "2026-04-08T00:09:30.000Z"),
    artifact("worse-codex", "worse", "2026-04-08T00:09:45.000Z")
  ]);

  assert.equal(family.length, 2);
  assert.equal(family[0]?.rightMission.id, "mission-shadow-better");
  assert.equal(family[0]?.preferredMissionId, "mission-shadow-better");
});
