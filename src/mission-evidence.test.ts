import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { createMission } from "./missions.ts";
import { buildMissionDriftReport, buildMissionPatchsets } from "./mission-evidence.ts";
import type { Mission, SessionRecord, TaskArtifact, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-evidence",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    selectedMissionId: null,
    fullAccessMode: true,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-04-18T00:00:01.000Z",
    daemonVersion: "1.5.1",
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
    receipts: [],
    contracts: [],
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

function buildTask(overrides: Partial<TaskSpec> & Pick<TaskSpec, "id" | "missionId" | "title">): TaskSpec {
  return {
    id: overrides.id,
    missionId: overrides.missionId,
    title: overrides.title,
    owner: overrides.owner ?? "codex",
    kind: overrides.kind ?? "execution",
    nodeKind: overrides.nodeKind ?? "backend",
    status: overrides.status ?? "completed",
    prompt: overrides.prompt ?? overrides.title,
    dependsOnTaskIds: overrides.dependsOnTaskIds ?? [],
    parentTaskId: overrides.parentTaskId ?? null,
    planId: overrides.planId ?? null,
    planNodeKey: overrides.planNodeKey ?? null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 1,
    lastFailureSummary: overrides.lastFailureSummary ?? null,
    lease: overrides.lease ?? null,
    createdAt: overrides.createdAt ?? "2026-04-18T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-18T00:01:00.000Z",
    summary: overrides.summary ?? "done",
    nextRecommendation: overrides.nextRecommendation ?? null,
    routeReason: overrides.routeReason ?? null,
    routeStrategy: overrides.routeStrategy ?? "manual",
    routeConfidence: overrides.routeConfidence ?? 1,
    routeMetadata: overrides.routeMetadata ?? {},
    claimedPaths: overrides.claimedPaths ?? []
  };
}

function buildArtifact(task: TaskSpec): TaskArtifact {
  return {
    taskId: task.id,
    sessionId: "session-evidence",
    missionId: task.missionId,
    title: task.title,
    owner: task.owner,
    kind: task.kind,
    nodeKind: task.nodeKind,
    status: task.status,
    summary: task.summary,
    nextRecommendation: task.nextRecommendation ?? null,
    dependsOnTaskIds: task.dependsOnTaskIds,
    parentTaskId: task.parentTaskId,
    planId: task.planId,
    planNodeKey: task.planNodeKey,
    retryCount: task.retryCount,
    maxRetries: task.maxRetries,
    lastFailureSummary: task.lastFailureSummary,
    routeReason: task.routeReason,
    routeStrategy: task.routeStrategy,
    routeConfidence: task.routeConfidence,
    routeMetadata: task.routeMetadata,
    claimedPaths: task.claimedPaths,
    decisionReplay: [],
    rawOutput: null,
    error: null,
    envelope: null,
    reviewNotes: [],
    progress: [],
    attempts: [],
    startedAt: task.createdAt,
    finishedAt: task.updatedAt
  };
}

function buildMissionWithBlueprint(session: SessionRecord): Mission {
  const mission = createMission(session, "Build a clinic command center with web, API, and docs.");
  mission.spec = {
    ...mission.spec!,
    requestedDeliverables: ["operator quickstart", "clinic dashboard", "backend api"]
  };
  mission.contract = {
    ...mission.contract!,
    docsExpectations: ["Add a quickstart guide"],
    scenarios: ["Operator can load the clinic dashboard"]
  };
  mission.blueprint = {
    ...mission.blueprint!,
    serviceBoundaries: ["Clinic API"],
    uiSurfaces: ["Clinic dashboard"],
    acceptanceJourneys: ["Operator can load the clinic dashboard"]
  };
  return mission;
}

test("buildMissionPatchsets groups changed paths into dominant roots", () => {
  const session = buildSession();
  const mission = buildMissionWithBlueprint(session);
  session.missions.push(mission);
  const task = buildTask({
    id: "task-api",
    missionId: mission.id,
    title: "Build clinic API",
    owner: "codex",
    claimedPaths: [
      "apps/api/src/server.ts",
      "apps/api/src/routes/patients.ts",
      "packages/domain/patient.ts"
    ]
  });
  session.tasks.push(task);
  session.receipts?.push({
    id: "receipt-api",
    missionId: mission.id,
    taskId: task.id,
    owner: "codex",
    nodeKind: "backend",
    outcome: "completed",
    title: task.title,
    summary: "Implemented the clinic API routes and domain model.",
    changedPaths: task.claimedPaths,
    commands: ["npm test"],
    verificationEvidence: ["API smoke test passed"],
    assumptions: [],
    followUps: ["Need dashboard polish"],
    risks: ["Auth is still placeholder"],
    createdAt: "2026-04-18T00:02:00.000Z"
  });

  const patchsets = buildMissionPatchsets(session, [buildArtifact(task)], mission);
  assert.equal(patchsets.length, 1);
  assert.equal(patchsets[0]?.receiptId, "receipt-api");
  assert.equal(patchsets[0]?.dominantRoots[0]?.root, "apps/api");
  assert.equal(patchsets[0]?.dominantRoots[0]?.count, 2);
});

test("buildMissionDriftReport marks covered, partial, and missing spec descriptors", () => {
  const session = buildSession();
  const mission = buildMissionWithBlueprint(session);
  session.missions.push(mission);
  const backendTask = buildTask({
    id: "task-api",
    missionId: mission.id,
    title: "Build Clinic API",
    owner: "codex",
    summary: "Implemented Clinic API and backend services.",
    claimedPaths: ["apps/api/src/server.ts", "packages/domain/patient.ts"]
  });
  const docsTask = buildTask({
    id: "task-docs",
    missionId: mission.id,
    title: "Write quickstart",
    owner: "claude",
    summary: "Added quickstart guide for operators.",
    claimedPaths: ["QUICKSTART.md"]
  });
  session.tasks.push(backendTask, docsTask);
  session.receipts?.push({
    id: "receipt-api",
    missionId: mission.id,
    taskId: backendTask.id,
    owner: "codex",
    nodeKind: "backend",
    outcome: "completed",
    title: backendTask.title,
    summary: backendTask.summary ?? "",
    changedPaths: backendTask.claimedPaths,
    commands: ["npm test"],
    verificationEvidence: ["Clinic API responds"],
    assumptions: [],
    followUps: [],
    risks: [],
    createdAt: "2026-04-18T00:03:00.000Z"
  });
  session.receipts?.push({
    id: "receipt-docs",
    missionId: mission.id,
    taskId: docsTask.id,
    owner: "claude",
    nodeKind: "docs",
    outcome: "completed",
    title: docsTask.title,
    summary: docsTask.summary ?? "",
    changedPaths: docsTask.claimedPaths,
    commands: [],
    verificationEvidence: ["Quickstart exists"],
    assumptions: [],
    followUps: [],
    risks: [],
    createdAt: "2026-04-18T00:04:00.000Z"
  });

  const drift = buildMissionDriftReport(session, [buildArtifact(backendTask), buildArtifact(docsTask)], mission);
  assert.ok(drift);
  assert.ok((drift?.coverageScore ?? 0) > 0);
  assert.ok(drift?.items.some((item) => item.category === "docs" && item.status === "covered"));
  assert.ok(drift?.items.some((item) => item.category === "service_boundary" && item.status === "covered"));
  assert.ok(drift?.items.some((item) => item.category === "ui_surface" && item.status !== "covered"));
});

test("buildMissionDriftReport does not count failed tasks without changed evidence as coverage", () => {
  const session = buildSession();
  const mission = buildMissionWithBlueprint(session);
  session.missions.push(mission);
  const failedTask = buildTask({
    id: "task-docs-failed",
    missionId: mission.id,
    title: "Write quickstart",
    owner: "claude",
    status: "failed",
    summary: "Authentication failed before edits were applied.",
    claimedPaths: ["QUICKSTART.md"]
  });
  session.tasks.push(failedTask);

  const drift = buildMissionDriftReport(session, [buildArtifact(failedTask)], mission);
  assert.ok(drift);
  assert.ok(drift?.items.some((item) => item.category === "docs" && item.status === "missing"));
});
