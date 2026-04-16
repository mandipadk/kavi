import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { buildWorkflowActivity, buildWorkflowResult, buildWorkflowSummary } from "./workflow.ts";
import type { KaviSnapshot, TaskArtifact } from "./types.ts";

function buildSnapshot(): KaviSnapshot {
  return {
    session: {
      id: "session-1",
      repoRoot: "/tmp/repo",
      baseCommit: "base",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:06:00.000Z",
      socketPath: "/tmp/kavi.sock",
      status: "running",
      goal: "Build the feature",
      fullAccessMode: false,
      daemonPid: 1,
      daemonHeartbeatAt: "2026-03-25T00:06:00.000Z",
      config: defaultConfig(),
      runtime: {
        nodeExecutable: "node",
        codexExecutable: "codex",
        claudeExecutable: "claude",
        kaviEntryPoint: "/tmp/dist/main.js"
      },
      worktrees: [
        {
          agent: "codex",
          path: "/tmp/worktrees/codex",
          branch: "kavi/codex"
        },
        {
          agent: "claude",
          path: "/tmp/worktrees/claude",
          branch: "kavi/claude"
        }
      ],
      tasks: [
        {
          id: "task-1",
          missionId: "mission-1",
          title: "Build API",
          owner: "codex",
          kind: "execution",
          nodeKind: "backend",
          status: "completed",
          prompt: "Build API",
          dependsOnTaskIds: [],
          parentTaskId: null,
          planId: null,
          planNodeKey: null,
          retryCount: 0,
          maxRetries: 2,
          lastFailureSummary: null,
          lease: null,
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:04:00.000Z",
          summary: "API finished",
          routeReason: null,
          routeStrategy: "manual",
          routeConfidence: 1,
          routeMetadata: {},
          claimedPaths: ["src/server.ts"]
        },
        {
          id: "task-2",
          missionId: "mission-1",
          title: "Polish UI",
          owner: "claude",
          kind: "execution",
          nodeKind: "frontend",
          status: "running",
          prompt: "Polish UI",
          dependsOnTaskIds: [],
          parentTaskId: null,
          planId: null,
          planNodeKey: null,
          retryCount: 0,
          maxRetries: 2,
          lastFailureSummary: null,
          lease: null,
          createdAt: "2026-03-25T00:01:00.000Z",
          updatedAt: "2026-03-25T00:05:00.000Z",
          summary: null,
          routeReason: null,
          routeStrategy: "manual",
          routeConfidence: 1,
          routeMetadata: {},
          claimedPaths: ["src/ui.tsx"]
        }
      ],
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
    },
    approvals: [],
    events: [
      {
        id: "event-1",
        type: "task.started",
        timestamp: "2026-03-25T00:02:00.000Z",
        payload: {
          taskId: "task-1",
          owner: "codex"
        }
      },
      {
        id: "event-2",
        type: "task.completed",
        timestamp: "2026-03-25T00:04:00.000Z",
        payload: {
          taskId: "task-1"
        }
      }
    ],
    worktreeDiffs: [
      {
        agent: "codex",
        paths: ["src/server.ts"]
      },
      {
        agent: "claude",
        paths: ["src/ui.tsx"]
      }
    ],
    latestLandReport: null
  };
}

test("buildWorkflowActivity produces a linearized activity feed", () => {
  const snapshot = buildSnapshot();
  const artifacts: TaskArtifact[] = [
    {
      taskId: "task-1",
      sessionId: "session-1",
      title: "Build API",
      owner: "codex",
      kind: "execution",
      nodeKind: "backend",
      status: "completed",
      summary: "Implemented the API surface.",
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 2,
      lastFailureSummary: null,
      routeReason: null,
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: {},
      claimedPaths: ["src/server.ts"],
      decisionReplay: [],
      rawOutput: null,
      error: null,
      envelope: null,
      reviewNotes: [],
      progress: [],
      attempts: [],
      startedAt: "2026-03-25T00:02:00.000Z",
      finishedAt: "2026-03-25T00:04:00.000Z"
    }
  ];

  const activity = buildWorkflowActivity(snapshot, artifacts, 5);
  assert.equal(activity[0]?.title, "Task completed: Build API");
  assert.match(activity[0]?.detail ?? "", /API surface/);
  assert.equal(activity.some((entry) => entry.title === "Session goal set"), true);
});

test("buildWorkflowActivity describes retry and repair loop events clearly", () => {
  const snapshot = buildSnapshot();
  snapshot.events = [
    {
      id: "event-retry",
      type: "task.retry_queued",
      timestamp: "2026-03-25T00:05:00.000Z",
      payload: {
        taskId: "task-2",
        owner: "claude"
      }
    },
    {
      id: "event-verify",
      type: "mission.acceptance_verified",
      timestamp: "2026-03-25T00:04:30.000Z",
      payload: {
        acceptanceStatus: "failed"
      }
    }
  ];

  const activity = buildWorkflowActivity(snapshot, [], 5);
  assert.equal(activity[0]?.title, "Task retry queued: Polish UI");
  assert.match(activity[1]?.title ?? "", /acceptance verified/i);
});

test("buildWorkflowSummary highlights blockers and changed surface", () => {
  const summary = buildWorkflowSummary(buildSnapshot());
  assert.equal(summary.landReadiness.state, "blocked");
  assert.equal(summary.stage.id, "working");
  assert.equal(summary.missionObservability, null);
  assert.equal(summary.changedByAgent[0]?.paths.includes("src/server.ts"), true);
  assert.equal(summary.completedTasks[0]?.taskId, "task-1");
  assert.equal(summary.landReadiness.blockers.some((item) => /running/.test(item)), true);
});

test("buildWorkflowSummary exposes critical path and next ready nodes for the active mission", () => {
  const snapshot = buildSnapshot();
  snapshot.session.selectedMissionId = "mission-1";
  snapshot.session.missions = [
    {
      id: "mission-1",
      packetVersion: 2,
      title: "Ship the feature",
      prompt: "Build frontend and backend",
      goal: "Build the feature",
      mode: "guided_autopilot",
      status: "active",
      summary: "Mission is in flight.",
      shadowOfMissionId: null,
      planningTaskId: "task-plan",
      planId: "plan-1",
      rootTaskId: null,
      activeTaskIds: ["task-2"],
      autopilotEnabled: true,
      acceptance: {
        id: "accept-1",
        summary: "Acceptance",
        criteria: ["Ship the requested feature."],
        checks: [],
        status: "pending",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z"
      },
      checkpoints: [],
      brainEntryIds: [],
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:06:00.000Z",
      landedAt: null
    }
  ];
  snapshot.session.plans = [
    {
      id: "plan-1",
      missionId: "mission-1",
      title: "Plan",
      sourcePrompt: "Build frontend and backend",
      sourceTaskId: "task-plan",
      planningMode: "operator",
      plannerTaskId: "task-plan",
      summary: "Do backend, then frontend, then tests.",
      status: "active",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:05:00.000Z",
      nodes: [
        {
          key: "backend",
          taskId: "task-1",
          title: "Build API",
          owner: "codex",
          prompt: "Build API",
          nodeKind: "backend",
          dependsOn: [],
          claimedPaths: ["src/server.ts"],
          reason: "",
          executionMode: "parallel",
          status: "completed"
        },
        {
          key: "frontend",
          taskId: "task-2",
          title: "Polish UI",
          owner: "claude",
          prompt: "Polish UI",
          nodeKind: "frontend",
          dependsOn: ["backend"],
          claimedPaths: ["src/ui.tsx"],
          reason: "",
          executionMode: "parallel",
          status: "running"
        },
        {
          key: "tests",
          taskId: null,
          title: "Run tests",
          owner: "codex",
          prompt: "Run tests",
          nodeKind: "tests",
          dependsOn: ["frontend"],
          claimedPaths: [],
          reason: "",
          executionMode: "parallel",
          status: "planned"
        }
      ]
    }
  ];
  const artifacts: TaskArtifact[] = [
    {
      taskId: "task-2",
      sessionId: "session-1",
      missionId: "mission-1",
      title: "Polish UI",
      owner: "claude",
      kind: "execution",
      nodeKind: "frontend",
      status: "running",
      summary: null,
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: "plan-1",
      planNodeKey: "frontend",
      retryCount: 0,
      maxRetries: 2,
      lastFailureSummary: null,
      routeReason: null,
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: {},
      claimedPaths: ["src/ui.tsx"],
      decisionReplay: [],
      rawOutput: null,
      error: null,
      envelope: null,
      reviewNotes: [],
      progress: [
        {
          id: "progress-1",
          kind: "provider",
          summary: "Claude is refining the main UI shell.",
          paths: ["src/ui.tsx"],
          createdAt: "2026-03-25T00:05:30.000Z",
          semanticKind: "editing"
        }
      ],
      attempts: [],
      startedAt: "2026-03-25T00:05:00.000Z",
      finishedAt: "2026-03-25T00:05:00.000Z"
    }
  ];

  const summary = buildWorkflowSummary(snapshot, artifacts);

  assert.deepEqual(summary.missionObservability?.criticalPath, ["Polish UI", "Run tests"]);
  assert.equal(summary.missionObservability?.nextReadyNodes.length, 0);
  assert.equal(summary.missionObservability?.recentProgress[0]?.kind, "provider");
  assert.equal(summary.missionObservability?.recentProgress[0]?.semanticKind, "editing");
  assert.equal(summary.missionObservability?.activeOwners.includes("claude"), true);
});

test("buildWorkflowResult surfaces landed state and agent outputs", () => {
  const snapshot = buildSnapshot();
  snapshot.session.tasks[1] = {
    ...snapshot.session.tasks[1],
    status: "completed",
    summary: "UI polish finished",
    updatedAt: "2026-03-25T00:06:30.000Z"
  };
  snapshot.worktreeDiffs = [
    {
      agent: "codex",
      paths: []
    },
    {
      agent: "claude",
      paths: []
    }
  ];
  snapshot.latestLandReport = {
    id: "land-1",
    sessionId: "session-1",
    goal: "Build the feature",
    createdAt: "2026-03-25T00:07:00.000Z",
    targetBranch: "main",
    integrationBranch: "kavi/integration/session-1",
    integrationPath: "/tmp/integration/session-1",
    validationCommand: "npm test",
    validationStatus: "ran",
    validationDetail: "Validation ran with \"npm test\".",
    changedByAgent: [
      {
        agent: "codex",
        paths: ["src/server.ts"]
      },
      {
        agent: "claude",
        paths: ["src/ui.tsx"]
      }
    ],
    completedTasks: [],
    snapshotCommits: [],
    commandsRun: ["npm test"],
    reviewThreadsLanded: 1,
    openReviewThreadsRemaining: 0,
    summary: ["Merged managed work into main."]
  };

  const result = buildWorkflowResult(snapshot);
  assert.equal(result.stage.id, "landed");
  assert.match(result.headline, /landed in main/i);
  assert.equal(result.agentResults.find((item) => item.agent === "claude")?.latestTaskTitle, "Polish UI");
});

test("buildWorkflowSummary keeps acceptance-pending work out of ready-to-land state", () => {
  const snapshot = buildSnapshot();
  snapshot.session.tasks[1] = {
    ...snapshot.session.tasks[1],
    status: "completed",
    summary: "UI polish finished",
    updatedAt: "2026-03-25T00:06:30.000Z"
  };
  snapshot.session.missions = [
    {
      id: "mission-1",
      title: "Build the feature",
      prompt: "Build the feature",
      goal: "Build the feature",
      mode: "guided_autopilot",
      status: "awaiting_acceptance",
      summary: "Execution finished and needs verification.",
      planningTaskId: null,
      planId: null,
      rootTaskId: "task-1",
      activeTaskIds: [],
      autopilotEnabled: true,
      acceptance: {
        id: "accept-1",
        summary: "Mission acceptance pack",
        criteria: ["The slice works."],
        checks: [
          {
            id: "check-1",
            title: "Operator review",
            kind: "manual",
            command: null,
            status: "pending",
            detail: "Review output",
            lastRunAt: null,
            lastOutput: null
          }
        ],
        status: "pending",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:06:30.000Z"
      },
      checkpoints: [],
      brainEntryIds: [],
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:06:30.000Z",
      landedAt: null
    }
  ];
  snapshot.worktreeDiffs = [
    {
      agent: "codex",
      paths: ["src/server.ts"]
    },
    {
      agent: "claude",
      paths: ["src/ui.tsx"]
    }
  ];

  const summary = buildWorkflowSummary(snapshot);
  assert.equal(summary.stage.id, "awaiting_acceptance");
  assert.equal(summary.landReadiness.state, "blocked");
  assert.equal(
    summary.landReadiness.blockers.some((item) => /acceptance has not been verified/i.test(item)),
    true
  );
});

test("buildWorkflowSummary blocks landing when follow-up recommendations are still pending", () => {
  const snapshot = buildSnapshot();
  snapshot.session.tasks[0] = {
    ...snapshot.session.tasks[0],
    nextRecommendation: "Have Claude refine the command center UI."
  };
  snapshot.session.tasks[1] = {
    ...snapshot.session.tasks[1],
    status: "completed",
    summary: "UI polish finished",
    updatedAt: "2026-03-25T00:06:30.000Z"
  };

  const summary = buildWorkflowSummary(snapshot);
  assert.equal(summary.stage.id, "review_follow_ups");
  assert.equal(summary.landReadiness.state, "blocked");
  assert.equal(
    summary.landReadiness.blockers.some((item) => /follow-up recommendation/i.test(item)),
    true
  );
  assert.equal(
    summary.landReadiness.nextActions.some((item) => /Recommendations tab/i.test(item)),
    true
  );
});

test("buildWorkflowSummary surfaces a blocked stage for failed missions", () => {
  const snapshot = buildSnapshot();
  snapshot.session.tasks[1] = {
    ...snapshot.session.tasks[1],
    status: "failed",
    summary: "Claude authentication needs to be refreshed.",
    updatedAt: "2026-03-25T00:06:30.000Z"
  };
  snapshot.session.missions = [
    {
      id: "mission-1",
      title: "Frontend mission",
      prompt: "Build the frontend",
      goal: null,
      mode: "guided_autopilot",
      status: "blocked",
      summary: "Mission progress is blocked.",
      planningTaskId: null,
      planId: null,
      rootTaskId: "task-2",
      activeTaskIds: [],
      autopilotEnabled: true,
      acceptance: {
        id: "accept-1",
        summary: "Mission acceptance pack",
        criteria: ["Ship the requested slice."],
        checks: [],
        status: "pending",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:06:30.000Z"
      },
      checkpoints: [],
      brainEntryIds: [],
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:06:30.000Z",
      landedAt: null
    }
  ];
  snapshot.worktreeDiffs = [
    {
      agent: "codex",
      paths: []
    },
    {
      agent: "claude",
      paths: []
    }
  ];

  const summary = buildWorkflowSummary(snapshot);
  assert.equal(summary.stage.id, "blocked");
  assert.equal(summary.landReadiness.state, "blocked");
  assert.equal(summary.activeMission?.status, "blocked");
});

test("buildWorkflowSummary surfaces repairing stage when acceptance repair work is queued", () => {
  const snapshot = buildSnapshot();
  snapshot.session.tasks = [
    {
      ...snapshot.session.tasks[0],
      status: "completed",
      summary: "Initial slice completed."
    },
    {
      ...snapshot.session.tasks[1],
      id: "task-repair-1",
      title: "Repair acceptance failures",
      owner: "codex",
      kind: "integration",
      nodeKind: "repair",
      status: "pending",
      prompt: "Repair failing acceptance checks.",
      summary: "Repair task queued."
    }
  ];
  snapshot.session.missions = [
    {
      id: "mission-1",
      title: "Repair mission",
      prompt: "Repair the mission",
      goal: null,
      mode: "guided_autopilot",
      status: "active",
      summary: "Acceptance failed and repair work was queued.",
      planningTaskId: null,
      planId: null,
      rootTaskId: "task-1",
      activeTaskIds: ["task-repair-1"],
      autopilotEnabled: true,
      acceptance: {
        id: "accept-1",
        summary: "Mission acceptance pack",
        criteria: ["Ship the requested slice."],
        checks: [
          {
            id: "check-1",
            title: "Validation command",
            kind: "command",
            command: "npm test",
            status: "failed",
            detail: "Failed",
            lastRunAt: "2026-03-25T00:06:30.000Z",
            lastOutput: "test failed"
          }
        ],
        status: "failed",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:06:30.000Z"
      },
      checkpoints: [
        {
          id: "checkpoint-1",
          kind: "repair_queued",
          title: "Acceptance repair queued",
          detail: "Queued a repair task.",
          taskId: "task-repair-1",
          createdAt: "2026-03-25T00:06:30.000Z"
        }
      ],
      brainEntryIds: [],
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:06:30.000Z",
      landedAt: null
    }
  ];

  const summary = buildWorkflowSummary(snapshot);
  assert.equal(summary.stage.id, "repairing");
  assert.equal(summary.missionObservability?.activeRepairTasks, 1);
  assert.equal(summary.missionObservability?.latestFailure, null);
  assert.equal(
    summary.landReadiness.blockers.some((item) => /acceptance checks are failing|failed acceptance/i.test(item)),
    true
  );
});
