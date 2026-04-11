import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  buildMissionConfidence,
  buildMissionDigest,
  buildMissionMorningBrief,
  buildMissionRecoveryPlan
} from "./mission-controller.ts";
import { createMission } from "./missions.ts";
import type {
  ApprovalRequest,
  KaviSnapshot,
  Mission,
  SessionRecord,
  TaskSpec
} from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-mission-controller",
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
    daemonVersion: "3.0.0",
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

function buildTask(input: Partial<TaskSpec> & Pick<TaskSpec, "id" | "missionId" | "title">): TaskSpec {
  return {
    id: input.id,
    missionId: input.missionId,
    title: input.title,
    owner: input.owner ?? "codex",
    kind: input.kind ?? "execution",
    nodeKind: input.nodeKind ?? "backend",
    status: input.status ?? "completed",
    prompt: input.prompt ?? input.title,
    dependsOnTaskIds: input.dependsOnTaskIds ?? [],
    parentTaskId: input.parentTaskId ?? null,
    planId: input.planId ?? null,
    planNodeKey: input.planNodeKey ?? null,
    retryCount: input.retryCount ?? 0,
    maxRetries: input.maxRetries ?? 1,
    lastFailureSummary: input.lastFailureSummary ?? null,
    lease: input.lease ?? null,
    createdAt: input.createdAt ?? "2026-04-10T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-10T00:01:00.000Z",
    summary: input.summary ?? "done",
    nextRecommendation: input.nextRecommendation ?? null,
    routeReason: input.routeReason ?? null,
    routeStrategy: input.routeStrategy ?? "manual",
    routeConfidence: input.routeConfidence ?? 1,
    routeMetadata: input.routeMetadata ?? {},
    claimedPaths: input.claimedPaths ?? []
  };
}

function buildSnapshot(session: SessionRecord, approvals: ApprovalRequest[] = []): KaviSnapshot {
  return {
    session,
    approvals,
    events: [],
    worktreeDiffs: [],
    latestLandReport: null
  };
}

function createMissionForSession(
  session: SessionRecord,
  prompt: string,
  rootTaskId = "task-root"
): Mission {
  const mission = createMission(session, prompt, {
    rootTaskId
  });
  session.missions.push(mission);
  return mission;
}

test("buildMissionConfidence surfaces blockers and disables autopilot when recovery is gated", () => {
  const session = buildSession();
  const mission = createMissionForSession(session, "Build a full-stack starter with frontend and backend.");
  mission.autopilotEnabled = true;
  mission.acceptance.status = "failed";
  if (mission.acceptance.checks[0]) {
    mission.acceptance.checks[0].status = "failed";
    mission.acceptance.checks[0].lastOutput = "Browser validation failed.";
  }
  mission.acceptance.failurePacks = [{
    id: "failure-1",
    missionId: mission.id,
    checkId: "accept-1",
    kind: "browser",
    title: "Homepage browser check",
    summary: "Landing page failed to render expected content.",
    expected: ["dashboard"],
    observed: ["blank page"],
    evidence: ["apps/web/app/page.tsx"],
    likelyOwners: ["claude"],
    likelyTaskIds: ["task-ui"],
    attribution: "Frontend shell task likely missed the requested landing content.",
    repairFocus: ["apps/web/app/page.tsx"],
    command: null,
    harnessPath: "apps/web/.kavi/browser.spec.ts",
    serverCommand: "npm run dev",
    request: {
      method: "GET",
      urlPath: "/",
      routeCandidates: ["/"],
      headers: {},
      body: null,
      selector: null,
      selectorCandidates: []
    },
    expectedSignals: {
      title: null,
      status: 200,
      contentType: "text/html",
      text: ["dashboard"],
      jsonKeys: []
    },
    runtimeCapture: {
      detail: "Expected dashboard text was missing.",
      lastOutput: "blank page"
    },
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z"
  }];
  session.tasks.push(buildTask({
    id: "task-ui",
    missionId: mission.id,
    title: "Frontend shell",
    owner: "claude",
    nodeKind: "frontend",
    status: "failed",
    lastFailureSummary: "Browser validation failed after rendering a blank page.",
    claimedPaths: ["apps/web/app/page.tsx"]
  }));
  session.providerCapabilities.push({
    provider: "codex",
    version: "0.1.0",
    transport: "codex-app-server",
    status: "degraded",
    capabilities: ["streaming"],
    warnings: [],
    errors: ["Auth expired."],
    checkedAt: "2026-04-10T00:01:00.000Z"
  });
  session.contracts?.push({
    id: "contract-1",
    missionId: mission.id,
    sourceTaskId: "task-ui",
    sourceMessageId: null,
    sourceAgent: "claude",
    targetAgent: "codex",
    kind: "request_stub",
    status: "open",
    title: "Need API stub",
    detail: "Backend stub still missing.",
    requiredArtifacts: ["apps/api/src/server.ts"],
    acceptanceExpectations: ["Provide the endpoint contract."],
    urgency: "high",
    dependencyImpact: "blocking",
    claimedPaths: ["apps/api/src/server.ts"],
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z",
    resolvedAt: null,
    resolvedByTaskId: null
  });
  const approvals: ApprovalRequest[] = [{
    id: "approval-1",
    sessionId: session.id,
    repoRoot: session.repoRoot,
    agent: "claude",
    hookEvent: "PreToolUse",
    toolName: "Bash",
    summary: "Need to run npm test",
    matchKey: "bash:npm-test",
    payload: {},
    status: "pending",
    decision: null,
    remember: false,
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z",
    resolvedAt: null
  }];

  const confidence = buildMissionConfidence(buildSnapshot(session, approvals), [], mission);

  assert.ok(confidence);
  assert.equal(confidence?.state, "low");
  assert.equal(confidence?.canAutopilot, false);
  assert.ok(confidence?.blockers.some((item) => /approval/i.test(item)));
  assert.ok(confidence?.blockers.some((item) => /provider readiness/i.test(item)));
  assert.ok(confidence?.blockers.some((item) => /blocking contract/i.test(item)));
  assert.ok(confidence?.blockers.some((item) => /acceptance is failing/i.test(item)));
});

test("buildMissionRecoveryPlan recommends safe autopilot resume and verification when mission is idle", () => {
  const session = buildSession();
  const mission = createMissionForSession(session, "Add docs for the starter.");
  mission.autopilotEnabled = false;
  if (mission.policy) {
    mission.policy.autonomyLevel = "inspect";
  }
  session.tasks.push(buildTask({
    id: "task-docs",
    missionId: mission.id,
    title: "Docs pass",
    owner: "claude",
    nodeKind: "docs",
    status: "completed",
    claimedPaths: ["README.md"]
  }));

  const recoveryPlan = buildMissionRecoveryPlan(buildSnapshot(session), [], mission);

  assert.ok(recoveryPlan);
  assert.equal(recoveryPlan?.status, "actionable");
  assert.ok(recoveryPlan?.actions.some((action) => action.kind === "resume_autopilot" && action.safeToAutoApply));
  assert.ok(recoveryPlan?.actions.some((action) => action.kind === "run_verification" && action.safeToAutoApply));
});

test("buildMissionDigest includes receipts, contracts, repairs, and recovery state", () => {
  const session = buildSession();
  const mission = createMissionForSession(session, "Build and verify a tiny API.");
  mission.acceptance.status = "failed";
  if (mission.acceptance.checks[0]) {
    mission.acceptance.checks[0].status = "failed";
    mission.acceptance.checks[0].lastOutput = "Expected /health to return 200 but got 500.";
  }
  mission.acceptance.failurePacks = [{
    id: "failure-api",
    missionId: mission.id,
    checkId: "accept-api",
    kind: "http",
    title: "API contract check",
    summary: "Expected /health to return 200.",
    expected: ["200"],
    observed: ["500"],
    evidence: ["apps/api/src/server.ts"],
    likelyOwners: ["codex"],
    likelyTaskIds: ["task-api"],
    attribution: "Backend health endpoint is failing.",
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
      detail: "Endpoint returned 500.",
      lastOutput: "HTTP 500"
    },
    createdAt: "2026-04-10T00:02:00.000Z",
    updatedAt: "2026-04-10T00:02:00.000Z"
  }];
  mission.acceptance.repairPlans = [{
    id: "repair-plan-1",
    missionId: mission.id,
    title: "Repair /health endpoint",
    owner: "codex",
    status: "queued",
    failureFingerprint: "fingerprint-1",
    failedCheckIds: ["accept-api"],
    failurePackIds: ["failure-api"],
    summary: "Fix the backend health endpoint and rerun verification.",
    prompt: "Repair the health endpoint.",
    routeReason: "Backend ownership.",
    routeStrategy: "ownership",
    routeConfidence: 0.9,
    claimedPaths: ["apps/api/src/server.ts"],
    likelyOwners: ["codex"],
    likelyTaskIds: ["task-api"],
    repairFocus: ["apps/api/src/server.ts"],
    evidence: ["HTTP 500"],
    createdAt: "2026-04-10T00:02:00.000Z",
    updatedAt: "2026-04-10T00:02:00.000Z",
    queuedTaskId: "task-repair"
  }];
  session.receipts?.push({
    id: "receipt-1",
    missionId: mission.id,
    taskId: "task-api",
    owner: "codex",
    nodeKind: "backend",
    outcome: "completed",
    title: "API scaffold",
    summary: "Created the API starter and health route.",
    changedPaths: ["apps/api/src/server.ts"],
    commands: ["npm test"],
    verificationEvidence: ["npm test passed"],
    assumptions: ["Backend route ownership."],
    followUps: ["claude: refine docs"],
    risks: ["Health endpoint still thin"],
    createdAt: "2026-04-10T00:02:00.000Z"
  });
  session.contracts?.push({
    id: "contract-api",
    missionId: mission.id,
    sourceTaskId: "task-api",
    sourceMessageId: null,
    sourceAgent: "codex",
    targetAgent: "claude",
    kind: "request_review",
    status: "open",
    title: "Review API docs",
    detail: "Need docs pass for the new endpoint.",
    requiredArtifacts: ["README.md"],
    acceptanceExpectations: ["Document the API route."],
    urgency: "normal",
    dependencyImpact: "sidecar",
    claimedPaths: ["README.md"],
    createdAt: "2026-04-10T00:02:00.000Z",
    updatedAt: "2026-04-10T00:02:00.000Z",
    resolvedAt: null,
    resolvedByTaskId: null
  });
  session.tasks.push(buildTask({
    id: "task-api",
    missionId: mission.id,
    title: "API scaffold",
    owner: "codex",
    nodeKind: "backend",
    status: "completed",
    claimedPaths: ["apps/api/src/server.ts"]
  }));
  session.tasks.push(buildTask({
    id: "task-repair",
    missionId: mission.id,
    title: "Repair /health endpoint",
    owner: "codex",
    nodeKind: "repair",
    status: "pending",
    claimedPaths: ["apps/api/src/server.ts"]
  }));

  const digest = buildMissionDigest(buildSnapshot(session), [] , mission);

  assert.ok(digest);
  assert.equal(digest?.recentReceipts.length, 1);
  assert.equal(digest?.openContracts.length, 1);
  assert.equal(digest?.activeRepairPlans.length, 1);
  assert.equal(digest?.failurePacks.length, 1);
  assert.ok(digest?.recoveryPlan.actions.some((action) => action.kind === "review_repairs"));
});

test("buildMissionMorningBrief summarizes overnight progress and first actions", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny API and docs slice.", {
    policyOverrides: {
      autonomyLevel: "overnight",
      autoVerify: true
    }
  });
  mission.acceptance.status = "passed";
  session.missions.push(mission);
  session.selectedMissionId = mission.id;

  const completedTask = {
    id: "task-completed",
    missionId: mission.id,
    title: "Write docs",
    owner: "claude" as const,
    kind: "execution" as const,
    nodeKind: "docs" as const,
    status: "completed" as const,
    prompt: "Write docs",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    lease: null,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
    summary: "Completed the docs slice.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: "manual" as const,
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: ["QUICKSTART.md"]
  };
  session.tasks.push(completedTask);
  session.receipts?.push({
    id: "receipt-overnight",
    missionId: mission.id,
    taskId: completedTask.id,
    owner: "claude",
    nodeKind: "docs",
    outcome: "completed",
    title: completedTask.title,
    summary: completedTask.summary ?? "",
    changedPaths: ["QUICKSTART.md"],
    commands: ["npm run docs:check"],
    verificationEvidence: ["Docs check passed"],
    assumptions: [],
    followUps: [],
    risks: [],
    createdAt: completedTask.updatedAt
  });
  session.contracts?.push({
    id: "contract-open",
    missionId: mission.id,
    sourceTaskId: completedTask.id,
    sourceMessageId: null,
    sourceAgent: "claude",
    targetAgent: "codex",
    kind: "request_verification",
    status: "open",
    title: "Verify the docs flow",
    detail: "Run a quick verification pass on the docs flow.",
    requiredArtifacts: ["QUICKSTART.md"],
    acceptanceExpectations: ["Confirm the docs are usable."],
    urgency: "normal",
    dependencyImpact: "sidecar",
    claimedPaths: ["QUICKSTART.md"],
    createdAt: completedTask.updatedAt,
    updatedAt: completedTask.updatedAt,
    resolvedAt: null,
    resolvedByTaskId: null
  });

  const brief = buildMissionMorningBrief(buildSnapshot(session), [], mission, 12);

  assert.ok(brief);
  assert.ok(brief?.headline.includes("completed"));
  assert.equal(brief?.completedTasks.length, 1);
  assert.equal(brief?.openContracts.length, 1);
  assert.ok(brief?.firstActions.some((action) => /contracts/i.test(action)));
});
