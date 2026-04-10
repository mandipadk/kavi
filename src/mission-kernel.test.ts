import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { compileMissionPrompt, computeMissionHealth } from "./mission-kernel.ts";
import { createMission } from "./missions.ts";
import type { SessionRecord, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-kernel",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-04-06T00:00:01.000Z",
    daemonVersion: "1.1.3",
    protocolVersion: 1,
    fullAccessMode: true,
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

test("compileMissionPrompt extracts a richer mission packet", () => {
  const session = buildSession();
  const compiled = compileMissionPrompt(
    session,
    "Build a production-shaped healthcare intake dashboard from scratch with a web UI, backend API, shared domain types, tests, and docs for clinicians and operators."
  );

  assert.equal(compiled.spec.repoShape, "greenfield");
  assert.ok(compiled.spec.workstreamKinds.includes("frontend"));
  assert.ok(compiled.spec.workstreamKinds.includes("backend"));
  assert.ok(compiled.spec.requestedDeliverables.includes("web_ui"));
  assert.ok(compiled.spec.userRoles.includes("clinician"));
  assert.ok(compiled.contract.acceptanceCriteria.length >= 3);
  assert.equal(compiled.policy.approvalMode, "approve_all");
  assert.ok(compiled.policy.gatePolicy.includes("acceptance"));
  assert.equal(compiled.policy.autoAdvance, true);
  assert.ok(compiled.blueprint.personas.includes("clinician"));
  assert.ok(compiled.blueprint.serviceBoundaries.length > 0);
  assert.ok(compiled.risks.some((risk) => risk.title === "Full-stack coordination"));
  assert.ok(compiled.anchors.some((anchor) => anchor.kind === "acceptance"));
});

test("compileMissionPrompt does not invent frontend or backend workstreams for docs-only prompts", () => {
  const session = buildSession();
  const compiled = compileMissionPrompt(
    session,
    "Create README.md and docs/quickstart.md for a tiny CLI project. Explain setup, usage, and development workflow."
  );

  assert.ok(compiled.spec.workstreamKinds.includes("docs"));
  assert.ok(compiled.spec.workstreamKinds.includes("scaffold"));
  assert.ok(!compiled.spec.workstreamKinds.includes("frontend"));
  assert.ok(!compiled.spec.workstreamKinds.includes("backend"));
  assert.deepEqual(compiled.spec.requestedDeliverables, ["docs"]);
  assert.equal(compiled.blueprint.uiSurfaces.length, 0);
  assert.ok(!compiled.blueprint.serviceBoundaries.includes("backend API and service logic"));
});

test("compileMissionPrompt does not treat generic client libraries as frontend work", () => {
  const session = buildSession();
  const compiled = compileMissionPrompt(
    session,
    "Scaffold a tiny Python CLI with pyproject.toml, a click entrypoint, and a stub weather client."
  );

  assert.ok(compiled.spec.workstreamKinds.includes("scaffold"));
  assert.ok(!compiled.spec.workstreamKinds.includes("frontend"));
  assert.ok(compiled.spec.stackHints.includes("python"));
});

test("computeMissionHealth reflects failures and stalls", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a full-stack slice with tests.");
  session.missions.push(mission);
  mission.checkpoints.push({
    id: "checkpoint-stalled",
    kind: "task_stalled",
    title: "Stalled",
    detail: "Task stalled.",
    taskId: "task-1",
    createdAt: mission.createdAt
  });
  const task: TaskSpec = {
    id: "task-1",
    missionId: mission.id,
    title: "Build backend",
    owner: "codex",
    kind: "execution",
    nodeKind: "repair",
    status: "failed",
    prompt: "Build backend",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 2,
    maxRetries: 2,
    lastFailureSummary: "Task timed out after 120 seconds.",
    lease: null,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    summary: "failed",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: []
  };
  session.tasks.push(task);

  const health = computeMissionHealth(session, mission);
  assert.equal(health.state, "blocked");
  assert.ok(health.score < 75);
  assert.ok(health.reasons.some((reason) => reason.includes("failed")));
  assert.ok(health.reasons.some((reason) => reason.includes("retry")));
  assert.ok(health.reasons.some((reason) => reason.includes("repair")));
});

test("computeMissionHealth does not gate on acceptance before execution really begins", () => {
  const session = buildSession();
  const mission = createMission(session, "Plan an alternative direction for this Go CLI.");
  session.missions.push(mission);
  session.tasks.push({
    id: "planner-1",
    missionId: mission.id,
    title: "Planner",
    owner: "codex",
    kind: "planner",
    nodeKind: "research",
    status: "failed",
    prompt: "Plan it",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: "Schema error.",
    lease: null,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    summary: "failed",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: []
  });

  const health = computeMissionHealth(session, mission);
  assert.equal(health.state, "blocked");
  assert.ok(health.reasons.some((reason) => reason.includes("failed")));
  assert.ok(!health.reasons.some((reason) => reason.includes("Acceptance has not been cleared yet.")));
});
