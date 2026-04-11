import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { createMission } from "./missions.ts";
import { buildMissionAuditReport } from "./quality-court.ts";
import type { SessionRecord, TaskArtifact, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-quality",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    selectedMissionId: null,
    fullAccessMode: true,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-04-10T00:00:01.000Z",
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
    createdAt: overrides.createdAt ?? "2026-04-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-10T00:01:00.000Z",
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
    sessionId: "session-quality",
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
    finishedAt: task.status === "completed" ? task.updatedAt : null
  };
}

test("buildMissionAuditReport blocks missions with failed acceptance and blocking contracts", () => {
  const session = buildSession();
  const mission = createMission(session, "Build backend and docs for a small API.");
  mission.acceptance.status = "failed";
  mission.contract = {
    ...mission.contract!,
    docsExpectations: ["Add a quickstart runbook."]
  };
  mission.acceptance.failurePacks = [{
    id: "failure-1",
    missionId: mission.id,
    checkId: "check-http",
    kind: "http",
    title: "GET /health",
    summary: "Expected /health to return 200.",
    expected: ["200"],
    observed: ["500"],
    evidence: ["apps/api/src/server.ts"],
    likelyOwners: ["codex"],
    likelyTaskIds: ["task-api"],
    attribution: "Health route failed.",
    repairFocus: ["apps/api/src/server.ts"],
    command: null,
    harnessPath: "apps/api/.kavi/http.spec.ts",
    serverCommand: "npm run dev",
    request: {
      method: "GET",
      urlPath: "/health",
      routeCandidates: ["/health"],
      headers: {},
      body: null,
      selector: null,
      selectorCandidates: []
    },
    expectedSignals: {
      title: null,
      status: 200,
      contentType: "application/json",
      text: [],
      jsonKeys: ["status"]
    },
    runtimeCapture: {
      detail: "500 response",
      lastOutput: "HTTP 500"
    },
    createdAt: "2026-04-10T00:02:00.000Z",
    updatedAt: "2026-04-10T00:02:00.000Z"
  }];
  session.missions.push(mission);
  session.contracts?.push({
    id: "contract-1",
    missionId: mission.id,
    sourceTaskId: "task-api",
    sourceMessageId: null,
    sourceAgent: "codex",
    targetAgent: "claude",
    kind: "request_review",
    status: "open",
    title: "Document the API",
    detail: "Add a quickstart and review the docs.",
    requiredArtifacts: ["QUICKSTART.md"],
    acceptanceExpectations: ["Explain how to run the API."],
    urgency: "normal",
    dependencyImpact: "blocking",
    claimedPaths: ["QUICKSTART.md"],
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z",
    resolvedAt: null,
    resolvedByTaskId: null
  });

  const report = buildMissionAuditReport(session, mission, []);

  assert.ok(report);
  assert.equal(report?.verdict, "blocked");
  assert.ok(report?.objections.some((objection) => objection.kind === "acceptance"));
  assert.ok(report?.objections.some((objection) => objection.kind === "contract"));
});

test("buildMissionAuditReport approves verified missions with receipts and no blockers", () => {
  const session = buildSession();
  const mission = createMission(session, "Build a quickstart guide.");
  mission.acceptance.status = "passed";
  mission.contract = {
    ...mission.contract!,
    docsExpectations: ["Provide a quickstart guide."]
  };
  mission.acceptance.checks.push({
    id: "docs-check",
    title: "Docs quickstart",
    kind: "docs",
    command: null,
    path: "QUICKSTART.md",
    status: "passed",
    detail: "Quickstart exists.",
    lastRunAt: "2026-04-10T00:02:00.000Z",
    lastOutput: "found"
  });
  session.missions.push(mission);
  const task = buildTask({
    id: "task-docs",
    missionId: mission.id,
    title: "Write quickstart",
    owner: "claude",
    claimedPaths: ["QUICKSTART.md"]
  });
  session.tasks.push(task);
  session.receipts?.push({
    id: "receipt-1",
    missionId: mission.id,
    taskId: task.id,
    owner: "claude",
    nodeKind: "docs",
    outcome: "completed",
    title: task.title,
    summary: "Wrote the quickstart guide.",
    changedPaths: ["QUICKSTART.md"],
    commands: ["npm run docs:check"],
    verificationEvidence: ["Docs check passed"],
    assumptions: [],
    followUps: [],
    risks: [],
    createdAt: "2026-04-10T00:02:00.000Z"
  });

  const report = buildMissionAuditReport(session, mission, [buildArtifact(task)]);

  assert.ok(report);
  assert.equal(report?.verdict, "approved");
  assert.equal(report?.objections.length, 0);
  assert.ok(report?.approvals.some((item) => /Acceptance has passed/i.test(item)));
});
