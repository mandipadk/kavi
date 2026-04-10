import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { buildOperatorRecommendations, dismissOperatorRecommendation } from "./recommendations.ts";
import {
  buildTabItems,
  filteredMissionBrainEntries,
  graphNeighborEntriesForSelection,
  moveSelectionId,
  nextComposerOwner,
  nextTab,
  normalizePastedInputChunk,
  parseDiffHunks,
  relatedBrainEntriesForSelection,
  shouldExpandComposer,
  syncDiffSelections,
  wrapText
} from "./tui.ts";
import type { KaviSnapshot, TaskSpec } from "./types.ts";
import type { OperatorUiState } from "./tui/state.ts";

function buildSnapshot(): KaviSnapshot {
  const config = defaultConfig();
  config.routing.codexPaths = ["src/ui/**"];
  config.routing.claudePaths = ["src/ui/**"];

  return {
    session: {
      id: "session-1",
      repoRoot: "/tmp/repo",
      baseCommit: "base",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
      socketPath: "/tmp/kavi.sock",
      status: "running",
      goal: "Build the product",
      fullAccessMode: false,
      daemonPid: 1,
      daemonHeartbeatAt: "2026-03-24T00:00:01.000Z",
      config,
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
          id: "task-completed",
          title: "Completed task",
          owner: "codex",
          status: "completed",
          prompt: "done",
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:01:00.000Z",
          summary: "completed",
          routeReason: null,
          routeStrategy: "manual",
          routeConfidence: 1,
          routeMetadata: {},
          claimedPaths: []
        },
        {
          id: "task-pending",
          title: "Pending task",
          owner: "claude",
          status: "pending",
          prompt: "pending",
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:03:00.000Z",
          summary: null,
          routeReason: "Manual",
          routeStrategy: "manual",
          routeConfidence: 1,
          routeMetadata: {
            manualAssignment: true
          },
          claimedPaths: ["src/ui.tsx"]
        },
        {
          id: "task-running",
          title: "Running task",
          owner: "codex",
          status: "running",
          prompt: "running",
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:04:00.000Z",
          summary: "in progress",
          routeReason: null,
          routeStrategy: "keyword",
          routeConfidence: 0.92,
          routeMetadata: {},
          claimedPaths: []
        }
      ],
      peerMessages: [
        {
          id: "message-1",
          taskId: "task-running",
          from: "codex",
          to: "claude",
          intent: "review_request",
          subject: "Review the UI",
          body: "Please review the component shell.",
          createdAt: "2026-03-24T00:05:00.000Z"
        }
      ],
      decisions: [
        {
          id: "decision-1",
          kind: "route",
          agent: "codex",
          taskId: "task-running",
          summary: "Routed task to codex",
          detail: "Matched backend routing keywords.",
          createdAt: "2026-03-24T00:02:00.000Z",
          metadata: {}
        }
      ],
      pathClaims: [
        {
          id: "claim-0",
          taskId: "task-running",
          agent: "codex",
          source: "diff",
          status: "active",
          paths: ["src/ui"],
          note: "Backend touching shared UI shell",
          createdAt: "2026-03-24T00:02:30.000Z",
          updatedAt: "2026-03-24T00:02:30.000Z"
        },
        {
          id: "claim-1",
          taskId: "task-pending",
          agent: "claude",
          source: "route",
          status: "active",
          paths: ["src/ui.tsx"],
          note: "Frontend claim",
          createdAt: "2026-03-24T00:03:00.000Z",
          updatedAt: "2026-03-24T00:03:00.000Z"
        }
      ],
      reviewNotes: [
        {
          id: "review-1",
          agent: "codex",
          assignee: "claude",
          taskId: "task-running",
          filePath: "src/ui.tsx",
          hunkIndex: null,
          hunkHeader: null,
          disposition: "concern",
          status: "open",
          summary: "Need Claude to reconcile the shared UI state.",
          body: "Need Claude to reconcile the shared UI state.",
          comments: [
            {
              id: "review-1-root",
              body: "Need Claude to reconcile the shared UI state.",
              createdAt: "2026-03-24T00:05:00.000Z",
              updatedAt: "2026-03-24T00:05:00.000Z"
            }
          ],
          resolvedAt: null,
          landedAt: null,
          followUpTaskIds: [],
          createdAt: "2026-03-24T00:05:00.000Z",
          updatedAt: "2026-03-24T00:05:00.000Z"
        }
      ],
      recommendationStates: [
        {
          id: "integration:src/ui",
          fingerprint: "fingerprint-1",
          status: "dismissed",
          dismissedReason: "handled elsewhere",
          dismissedAt: "2026-03-24T00:06:00.000Z",
          lastAppliedAt: null,
          appliedTaskIds: [],
          updatedAt: "2026-03-24T00:06:00.000Z"
        }
      ],
      agentStatus: {
        codex: {
          agent: "codex",
          available: true,
          transport: "codex-app-server",
          lastRunAt: "2026-03-24T00:04:00.000Z",
          lastExitCode: 0,
          sessionId: "thread-1",
          summary: "Planning complete."
        },
        claude: {
          agent: "claude",
          available: true,
          transport: "claude-print",
          lastRunAt: "2026-03-24T00:03:00.000Z",
          lastExitCode: 0,
          sessionId: "session-claude",
          summary: "UI direction ready."
        }
      }
    },
    approvals: [
      {
        id: "approval-approved",
        sessionId: "session-1",
        repoRoot: "/tmp/repo",
        agent: "claude",
        hookEvent: "PreToolUse",
        toolName: "Read",
        summary: "Read: src/app.ts",
        matchKey: "Read:src/app.ts",
        payload: {},
        status: "approved",
        decision: "allow",
        remember: false,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:01:00.000Z",
        resolvedAt: "2026-03-24T00:01:00.000Z"
      },
      {
        id: "approval-pending",
        sessionId: "session-1",
        repoRoot: "/tmp/repo",
        agent: "codex",
        hookEvent: "Approval",
        toolName: "CommandExecution",
        summary: "CommandExecution: npm test",
        matchKey: "CommandExecution:npm test",
        payload: {},
        status: "pending",
        decision: null,
        remember: false,
        createdAt: "2026-03-24T00:02:00.000Z",
        updatedAt: "2026-03-24T00:02:00.000Z",
        resolvedAt: null
      }
    ],
    events: [
      {
        id: "event-1",
        type: "task.started",
        timestamp: "2026-03-24T00:04:00.000Z",
        payload: {}
      }
    ],
    worktreeDiffs: [
      {
        agent: "codex",
        paths: ["src/server.ts"]
      },
      {
        agent: "claude",
        paths: ["src/ui.tsx", "src/theme.css"]
      }
    ],
    latestLandReport: {
      id: "land-1",
      sessionId: "session-1",
      goal: "Build the product",
      createdAt: "2026-03-24T00:07:00.000Z",
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
      completedTasks: [
        {
          taskId: "task-completed",
          owner: "codex",
          title: "Completed task",
          summary: "completed",
          claimedPaths: ["src/server.ts"],
          finishedAt: "2026-03-24T00:07:00.000Z"
        }
      ],
      snapshotCommits: [
        {
          agent: "codex",
          commit: "abc123",
          createdCommit: true
        },
        {
          agent: "claude",
          commit: "def456",
          createdCommit: false
        }
      ],
      commandsRun: ["npm test"],
      reviewThreadsLanded: 1,
      openReviewThreadsRemaining: 0,
      summary: [
        "Merged managed work into main.",
        "codex: 1 path(s) | claude: 1 path(s)",
        "Validation ran with \"npm test\".",
        "1 review thread(s) were marked as landed."
      ]
    }
  };
}

test("wrapText wraps words across lines", () => {
  assert.deepEqual(wrapText("hello world from kavi", 8), [
    "hello",
    "world",
    "from",
    "kavi"
  ]);
});

test("buildTabItems prioritizes running and pending tasks over completed ones", () => {
  const items = buildTabItems(buildSnapshot(), "tasks");
  assert.deepEqual(
    items.map((item) => item.id),
    ["task-running", "task-pending", "task-completed"]
  );
});

test("buildTabItems keeps pending approvals first", () => {
  const items = buildTabItems(buildSnapshot(), "approvals");
  assert.deepEqual(
    items.map((item) => item.id),
    ["approval-pending", "approval-approved"]
  );
});

test("buildTabItems includes recommendations with active items before dismissed ones", () => {
  const snapshot = buildSnapshot();
  const recommendation = buildOperatorRecommendations(snapshot.session)[0];
  assert.ok(recommendation);
  dismissOperatorRecommendation(snapshot.session, recommendation.id, "handled elsewhere");
  const items = buildTabItems(snapshot, "recommendations");
  assert.equal(items.length > 0, true);
  assert.notEqual(items[0]?.id, recommendation.id);
  assert.equal(items.at(-1)?.id, recommendation.id);
});

test("buildTabItems exposes a dedicated results view", () => {
  const items = buildTabItems(buildSnapshot(), "results");
  assert.deepEqual(
    items.map((item) => item.id),
    ["result:current", "result:land:land-1", "result:agent:codex", "result:agent:claude"]
  );
});

test("buildTabItems keeps active mission nodes and gates prominent in mission view", () => {
  const snapshot = buildSnapshot() as KaviSnapshot;
  snapshot.session.plans = [];
  snapshot.session.providerCapabilities = snapshot.session.providerCapabilities ?? [];
  snapshot.session.missions = [
    {
      id: "mission-active",
      title: "Clinic mission",
      prompt: "Build a clinic mission",
      goal: null,
      mode: "guided_autopilot",
      status: "active",
      summary: "Mission summary",
      planningTaskId: null,
      planId: null,
      rootTaskId: "task-running",
      activeTaskIds: ["task-running", "task-pending"],
      autopilotEnabled: true,
      acceptance: {
        id: "accept-active",
        summary: "accept",
        criteria: [],
        checks: [
          {
            id: "accept-browser",
            title: "Primary browser flow",
            kind: "browser",
            command: null,
            path: "src/ui.tsx",
            status: "failed",
            detail: "failed",
            lastRunAt: null,
            lastOutput: null
          }
        ],
        status: "failed",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      },
      checkpoints: [],
      brainEntryIds: [],
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
      landedAt: null,
      observability: {
        totalTasks: 2,
        pendingTasks: 1,
        runningTasks: 1,
        blockedTasks: 0,
        failedTasks: 0,
        completedTasks: 0,
        activeRepairTasks: 0,
        stalledTasks: 0,
        retriesUsed: 0,
        retryingTasks: 0,
        latestFailure: null,
        latestProgress: null,
        recentProgress: [],
        criticalPath: ["clinic-ui"],
        nextReadyNodes: [
          {
            key: "clinic-ui",
            owner: "claude",
            title: "Build clinic UI"
          }
        ],
        activeOwners: ["claude"],
        changedPaths: 0,
        changedPathList: []
      }
    }
  ];
  snapshot.session.selectedMissionId = "mission-active";

  const items = buildTabItems(snapshot, "results");
  assert.deepEqual(items.slice(0, 3).map((item) => item.id), [
    "result:current",
    "result:mission:mission-active",
    "result:acceptance:mission-active"
  ]);
});

test("moveSelectionId and nextTab wrap around", () => {
  const items = buildTabItems(buildSnapshot(), "tasks");
  assert.equal(moveSelectionId(items, "task-running", -1), "task-completed");
  assert.equal(moveSelectionId(items, "task-completed", 1), "task-running");
  assert.equal(nextTab("tasks", -1), "activity");
  assert.equal(nextTab("worktrees", 1), "results");
});

test("nextComposerOwner cycles route assignment without reserving numeric characters", () => {
  assert.equal(nextComposerOwner("auto"), "codex");
  assert.equal(nextComposerOwner("codex"), "claude");
  assert.equal(nextComposerOwner("claude"), "auto");
  assert.equal(nextComposerOwner("auto", -1), "claude");
});

test("normalizePastedInputChunk strips bracketed paste markers and normalizes newlines", () => {
  assert.equal(
    normalizePastedInputChunk("\u001b[200~line 1\r\nline 2\u001b[201~"),
    "line 1\nline 2"
  );
});

test("shouldExpandComposer opens the large editor for long or multiline prompts", () => {
  assert.equal(shouldExpandComposer("short prompt"), false);
  assert.equal(shouldExpandComposer(["a", "b", "c", "d", "e"].join("\n")), true);
  assert.equal(shouldExpandComposer("x".repeat(241)), true);
});

test("syncDiffSelections keeps valid selections and clears removed ones", () => {
  const snapshot = buildSnapshot();
  const selections = syncDiffSelections(
    {
      codex: "src/server.ts",
      claude: "src/missing.ts"
    },
    snapshot
  );

  assert.deepEqual(selections, {
    codex: "src/server.ts",
    claude: "src/ui.tsx"
  });
});

test("syncDiffSelections prefers task-claimed paths for the selected task owner", () => {
  const snapshot = buildSnapshot();
  const task = snapshot.session.tasks.find((item) => item.id === "task-pending") as TaskSpec;
  const selections = syncDiffSelections(
    {
      codex: "src/server.ts",
      claude: "src/theme.css"
    },
    snapshot,
    task
  );

  assert.deepEqual(selections, {
    codex: "src/server.ts",
    claude: "src/ui.tsx"
  });
});

test("parseDiffHunks extracts individual patch hunks", () => {
  const hunks = parseDiffHunks([
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,3 @@",
    " line 1",
    "+line 2",
    "@@ -10,1 +11,2 @@",
    "-old",
    "+new"
  ].join("\n"));

  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]?.header, "@@ -1,2 +1,3 @@");
  assert.deepEqual(hunks[1]?.lines, ["-old", "+new"]);
});

test("brain curation helpers filter mission context and expose related graph targets", () => {
  const snapshot = buildSnapshot() as KaviSnapshot;
  snapshot.session.plans = [];
  snapshot.session.worktrees = snapshot.session.worktrees ?? [];
  snapshot.session.providerCapabilities = snapshot.session.providerCapabilities ?? [];
  snapshot.session.peerMessages = snapshot.session.peerMessages ?? [];
  snapshot.session.decisions = snapshot.session.decisions ?? [];
  snapshot.session.pathClaims = snapshot.session.pathClaims ?? [];
  snapshot.session.reviewNotes = snapshot.session.reviewNotes ?? [];
  snapshot.session.recommendationStates = snapshot.session.recommendationStates ?? [];
  snapshot.session.missions = [
    {
      id: "mission-active",
      title: "Clinic UI mission",
      prompt: "Clinic UI mission",
      goal: null,
      mode: "guided_autopilot",
      status: "active",
      summary: "Working on clinic UI",
      planningTaskId: null,
      planId: null,
      rootTaskId: "task-pending",
      activeTaskIds: ["task-pending"],
      autopilotEnabled: true,
      acceptance: {
        id: "accept-active",
        summary: "accept",
        criteria: [],
        checks: [],
        status: "pending",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      },
      checkpoints: [],
      brainEntryIds: ["brain-a", "brain-b", "brain-c"],
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
      landedAt: null
    }
  ];
  snapshot.session.selectedMissionId = "mission-active";
  snapshot.session.brain = [
    {
      id: "brain-a",
      missionId: "mission-active",
      taskId: "task-pending",
      sourceType: "mission",
      category: "fact",
      scope: "mission",
      title: "Clinic shell",
      content: "The clinic shell lives in src/ui.tsx.",
      tags: ["clinic", "ui"],
      confidence: 0.9,
      freshness: "live",
      evidence: ["src/ui.tsx"],
      commands: [],
      supersedes: [],
      supersededBy: null,
      contradictions: [],
      retiredAt: null,
      pinned: true,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z"
    },
    {
      id: "brain-b",
      missionId: "mission-active",
      taskId: null,
      sourceType: "task",
      category: "decision",
      scope: "mission",
      title: "Queue state",
      content: "Keep queue state local to the clinic shell.",
      tags: ["clinic", "queue"],
      confidence: 0.8,
      freshness: "recent",
      evidence: ["src/ui.tsx"],
      commands: [],
      supersedes: [],
      supersededBy: null,
      contradictions: [],
      retiredAt: null,
      pinned: false,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z"
    },
    {
      id: "brain-c",
      missionId: "mission-active",
      taskId: null,
      sourceType: "task",
      category: "risk",
      scope: "mission",
      title: "Legacy variant",
      content: "Old shell variant",
      tags: ["legacy"],
      confidence: 0.5,
      freshness: "stale",
      evidence: [],
      commands: [],
      supersedes: [],
      supersededBy: null,
      contradictions: ["brain-a"],
      retiredAt: "2026-03-24T00:00:00.000Z",
      pinned: false,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z"
    }
  ];

  const ui = {
    activeTab: "results",
    selectedIds: {
      activity: null,
      results: "result:current",
      tasks: null,
      recommendations: null,
      approvals: null,
      claims: null,
      decisions: null,
      messages: null,
      worktrees: null
    },
    seenMarkers: {
      activity: null,
      results: null,
      tasks: null,
      recommendations: null,
      approvals: null,
      claims: null,
      decisions: null,
      messages: null,
      worktrees: null
    },
    taskDetailSection: "overview",
    composer: null,
    reviewComposer: null,
    toast: null,
    artifacts: {},
    loadingArtifacts: {},
    diffSelections: { codex: null, claude: null },
    diffReviews: { codex: null, claude: null },
    loadingDiffReviews: { codex: false, claude: false },
    hunkSelections: { codex: 0, claude: 0 },
    selectedReviewNoteId: null,
    selectedBrainEntryId: "brain-a",
    selectedBrainRelatedEntryId: null,
    selectedBrainGraphEntryId: null,
    selectedBrainEvidenceIndex: 0,
    brainMergeSourceEntryId: null,
    brainFilters: {
      query: "clinic",
      category: "all",
      scope: "all",
      includeRetired: false,
      focusArea: "entries",
      graphMode: "all",
      pathHint: ""
    },
    brainSearch: null,
    reviewFilters: { assignee: "all", disposition: "all", status: "all" },
    infoOverlay: false,
    agentDetailOverlay: null,
    commandPalette: null,
    confirmDialog: null
  } as OperatorUiState;

  const filtered = filteredMissionBrainEntries(snapshot, ui);
  const related = relatedBrainEntriesForSelection(snapshot, ui);
  const graph = graphNeighborEntriesForSelection(snapshot, ui);

  assert.deepEqual(filtered.map((entry) => entry.id), ["brain-a", "brain-b"]);
  assert.ok(related.some((entry) => entry.id === "brain-b"));
  assert.ok(graph.some((entry) => entry.id === "brain-b"));

  ui.brainFilters.pathHint = "src/ui.tsx";
  ui.brainFilters.graphMode = "structural";
  const pathFocusedGraph = graphNeighborEntriesForSelection(snapshot, ui);
  assert.ok(pathFocusedGraph.some((entry) => entry.id === "brain-b"));
});
