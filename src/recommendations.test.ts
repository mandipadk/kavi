import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { upsertPathClaim } from "./decision-ledger.ts";
import {
  activeFollowUpRecommendations,
  buildOperatorRecommendations,
  buildRecommendationActionPlan,
  dismissOperatorRecommendation,
  recordRecommendationApplied,
  restoreOperatorRecommendation
} from "./recommendations.ts";
import { addReviewNote } from "./reviews.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  const config = defaultConfig();
  config.routing.codexPaths = ["src/ui/**"];
  config.routing.claudePaths = ["src/ui/**"];

  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: "Ship it",
    daemonPid: 1,
    daemonHeartbeatAt: "2026-03-25T00:00:01.000Z",
    config,
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

function seedRecommendationSurface(session: SessionRecord): string {
  upsertPathClaim(session, {
    taskId: "task-codex",
    agent: "codex",
    source: "diff",
    paths: ["src/ui"]
  });
  upsertPathClaim(session, {
    taskId: "task-claude",
    agent: "claude",
    source: "diff",
    paths: ["src/ui/App.tsx"]
  });
  const note = addReviewNote(session, {
    agent: "codex",
    assignee: "claude",
    taskId: "task-codex",
    filePath: "src/ui/App.tsx",
    disposition: "concern",
    body: "Need Claude to reconcile the UI state here."
  });

  return `handoff:${note.id}:claude`;
}

test("buildOperatorRecommendations includes integration, handoff, and ownership-config diagnostics", () => {
  const session = buildSession();
  seedRecommendationSurface(session);

  const recommendations = buildOperatorRecommendations(session);
  assert.equal(recommendations.some((item) => item.kind === "integration"), true);
  assert.equal(recommendations.some((item) => item.kind === "handoff"), true);
  assert.equal(recommendations.some((item) => item.kind === "ownership-config"), true);
});

test("buildOperatorRecommendations derives actionable follow-ups from peer messages", () => {
  const session = buildSession();
  session.tasks.push({
    id: "task-codex",
    title: "Initial scaffold",
    owner: "codex",
    kind: "execution",
    status: "completed",
    prompt: "Scaffold the repo",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:02:00.000Z",
    summary: "Scaffolded apps/web and apps/api.",
    nextRecommendation: "Ask Claude to refine the frontend shell.",
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["apps/web"]
  });
  session.peerMessages.push({
    id: "message-1",
    taskId: "task-codex",
    from: "codex",
    to: "claude",
    intent: "context_share",
    subject: "Frontend shell is ready",
    body: "Please refine the command center layout next.",
    createdAt: "2026-03-25T00:02:30.000Z"
  });

  const recommendations = buildOperatorRecommendations(session);
  const followUp = recommendations.find((item) => item.id === "follow-up:message:message-1");
  assert.ok(followUp);
  assert.equal(followUp.kind, "follow_up");
  assert.equal(followUp.targetAgent, "claude");
  assert.match(followUp.detail, /command center layout/i);
  assert.equal(
    recommendations.some((item) => item.id === "follow-up:task:task-codex:next"),
    false
  );
});

test("activeFollowUpRecommendations ignores follow-ups that already completed successfully", () => {
  const session = buildSession();
  session.tasks.push({
    id: "task-source",
    title: "Source task",
    owner: "codex",
    kind: "execution",
    status: "completed",
    prompt: "Scaffold",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:02:00.000Z",
    summary: "done",
    nextRecommendation: "Have Claude polish the UI shell.",
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["apps/web"]
  });
  session.tasks.push({
    id: "task-follow-up",
    title: "Follow-up task",
    owner: "claude",
    kind: "execution",
    status: "completed",
    prompt: "Polish the UI shell",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:03:00.000Z",
    updatedAt: "2026-03-25T00:05:00.000Z",
    summary: "polished",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["apps/web"]
  });

  const recommendation = buildOperatorRecommendations(session).find((item) => item.kind === "follow_up");
  assert.ok(recommendation);
  recordRecommendationApplied(session, recommendation.id, "task-follow-up");

  assert.equal(activeFollowUpRecommendations(session).length, 0);
});

test("buildOperatorRecommendations hides completed applied follow-ups by default", () => {
  const session = buildSession();
  session.tasks.push({
    id: "task-source",
    title: "Source task",
    owner: "codex",
    kind: "execution",
    status: "completed",
    prompt: "Scaffold",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:02:00.000Z",
    summary: "done",
    nextRecommendation: "Have Claude polish the UI shell.",
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["apps/web"]
  });
  session.tasks.push({
    id: "task-follow-up",
    title: "Follow-up task",
    owner: "claude",
    kind: "execution",
    status: "completed",
    prompt: "Polish the UI shell",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:03:00.000Z",
    updatedAt: "2026-03-25T00:05:00.000Z",
    summary: "polished",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["apps/web"]
  });

  const recommendation = buildOperatorRecommendations(session, {
    includeDismissed: true
  }).find((item) => item.kind === "follow_up");
  assert.ok(recommendation);
  recordRecommendationApplied(session, recommendation.id, "task-follow-up");

  const activeRecommendations = buildOperatorRecommendations(session);
  assert.equal(activeRecommendations.some((item) => item.id === recommendation.id), false);
  const allRecommendations = buildOperatorRecommendations(session, {
    includeDismissed: true
  });
  const hydrated = allRecommendations.find((item) => item.id === recommendation.id);
  assert.equal(hydrated?.status, "dismissed");
  assert.equal(hydrated?.dismissedReason, "applied");
});

test("planner next recommendations are suppressed once the execution graph exists", () => {
  const session = buildSession();
  session.tasks.push({
    id: "planner-1",
    missionId: "mission-1",
    title: "Codex orchestration plan",
    owner: "codex",
    kind: "planner",
    status: "completed",
    prompt: "Plan the mission",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:02:00.000Z",
    summary: "Use a 3-step execution graph.",
    nextRecommendation: "Start with the foundation task, then split frontend and backend.",
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: []
  });
  session.plans.push({
    id: "plan-1",
    missionId: "mission-1",
    title: "Execution graph",
    sourcePrompt: "Plan the mission",
    sourceTaskId: "planner-1",
    planningMode: "operator",
    plannerTaskId: "planner-1",
    summary: "A real plan exists now.",
    status: "active",
    createdAt: "2026-03-25T00:02:00.000Z",
    updatedAt: "2026-03-25T00:02:00.000Z",
    nodes: []
  });

  const recommendations = buildOperatorRecommendations(session);
  assert.equal(
    recommendations.some((item) => item.id === "follow-up:task:planner-1:next"),
    false
  );
});

test("operator-only next recommendations do not become follow-up tasks", () => {
  const session = buildSession();
  session.tasks.push({
    id: "task-source",
    missionId: "mission-1",
    title: "Source task",
    owner: "codex",
    kind: "execution",
    status: "completed",
    prompt: "Create the slice",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:02:00.000Z",
    summary: "done",
    nextRecommendation: "Optionally commit the new files once reviewed.",
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["README.md"]
  });

  const recommendations = buildOperatorRecommendations(session);
  assert.equal(recommendations.some((item) => item.kind === "follow_up"), false);
});

test("dismissed recommendations stay hidden by default and can be restored", () => {
  const session = buildSession();
  const recommendationId = seedRecommendationSurface(session);

  dismissOperatorRecommendation(session, recommendationId, "noise for now");
  assert.equal(
    buildOperatorRecommendations(session).some((item) => item.id === recommendationId),
    false
  );

  const dismissed = buildOperatorRecommendations(session, {
    includeDismissed: true,
    status: "dismissed"
  });
  assert.equal(dismissed.some((item) => item.id === recommendationId), true);
  assert.equal(dismissed.find((item) => item.id === recommendationId)?.dismissedReason, "noise for now");

  restoreOperatorRecommendation(session, recommendationId);
  assert.equal(
    buildOperatorRecommendations(session).some((item) => item.id === recommendationId),
    true
  );
});

test("recommendation action plans guard duplicate open follow-up work unless forced", () => {
  const session = buildSession();
  const recommendationId = seedRecommendationSurface(session);

  session.tasks.push({
    id: "task-followup",
    title: "Existing follow-up",
    owner: "claude",
    status: "running",
    prompt: "Fix the UI",
    createdAt: "2026-03-25T00:10:00.000Z",
    updatedAt: "2026-03-25T00:10:00.000Z",
    summary: null,
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["src/ui/App.tsx"]
  });
  recordRecommendationApplied(session, recommendationId, "task-followup");

  assert.throws(
    () => buildRecommendationActionPlan(session, recommendationId),
    /already has open follow-up task/
  );

  const forced = buildRecommendationActionPlan(session, recommendationId, {
    force: true
  });
  assert.equal(forced.owner, "claude");
  assert.match(forced.prompt, /ownership-aware handoff/);
});
