import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  buildAutoAppliedContractTask,
  buildAgentContractTaskPrompt,
  buildMissionSimulation,
  buildMissionPostmortem,
  contractTaskNodeKind,
  computeMissionPhase,
  resolveAgentContractsForTask,
  setAgentContractStatus,
  upsertAgentContractsFromTask,
  upsertMissionReceipt
} from "./mission-control.ts";
import { createMission } from "./missions.ts";
import type { AgentTurnEnvelope, SessionRecord, TaskArtifact, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-control",
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

test("buildMissionSimulation surfaces coordination and verification gaps", () => {
  const session = buildSession();
  const mission = createMission(
    session,
    "Build a tiny product starter with frontend and backend slices plus docs."
  );
  session.missions.push(mission);

  const simulation = buildMissionSimulation(session, mission);

  assert.equal(simulation.contractCoverage, "partial");
  assert.equal(simulation.verificationCoverage, "thin");
  assert.equal(simulation.attentionBudget, mission.policy?.operatorAttentionBudget ?? 6);
  assert.equal(simulation.autopilotViable, false);
  assert.ok(simulation.escalationReasons.length > 0);
  assert.ok(simulation.issues.some((issue) => issue.kind === "coordination"));
  assert.ok(simulation.issues.some((issue) => issue.kind === "verification"));
});

test("computeMissionPhase reflects verification and postmortem states", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a docs slice.", {
    rootTaskId: "task-1"
  });
  session.missions.push(mission);
  session.tasks.push(buildTask({
    id: "task-1",
    missionId: mission.id,
    title: "Docs slice",
    status: "completed",
    nodeKind: "docs"
  }));

  mission.status = "awaiting_acceptance";
  assert.equal(computeMissionPhase(session, mission), "verifying");

  mission.landedAt = "2026-04-10T00:02:00.000Z";
  assert.equal(computeMissionPhase(session, mission), "postmortem");
});

test("upsertMissionReceipt captures commands and follow-ups", () => {
  const session = buildSession();
  const mission = createMission(session, "Create docs and verify them.");
  session.missions.push(mission);
  const task = buildTask({
    id: "task-1",
    missionId: mission.id,
    title: "Write docs",
    owner: "claude",
    nodeKind: "docs",
    routeReason: "Direct docs ownership.",
    nextRecommendation: "Ask codex to verify the CLI run flow.",
    claimedPaths: ["README.md", "QUICKSTART.md"]
  });
  const artifact: Pick<TaskArtifact, "progress" | "claimedPaths"> = {
    claimedPaths: ["README.md", "QUICKSTART.md"],
    progress: [
      {
        id: "progress-1",
        kind: "provider",
        summary: "Claude completed `npm test`.",
        paths: ["README.md"],
        createdAt: "2026-04-10T00:01:00.000Z",
        provider: "claude",
        eventName: "verification",
        source: "hook"
      }
    ]
  };
  const envelope: AgentTurnEnvelope = {
    summary: "Wrote docs and verified the starter flow.",
    status: "completed",
    blockers: [],
    nextRecommendation: "Ask codex to verify the CLI run flow.",
    plan: null,
    peerMessages: []
  };

  const receipt = upsertMissionReceipt(session, mission, task, artifact, envelope);

  assert.equal(session.receipts?.length, 1);
  assert.ok(receipt.commands.includes("npm test"));
  assert.ok(receipt.verificationEvidence.some((value) => /verified|test/i.test(value)));
  assert.ok(receipt.followUps.some((value) => /codex/i.test(value)));
});

test("upsertMissionReceipt does not promote claimed paths into changed paths for failed tasks", () => {
  const session = buildSession();
  const mission = createMission(session, "Write docs.");
  session.missions.push(mission);
  const task = buildTask({
    id: "task-failed",
    missionId: mission.id,
    title: "Write docs",
    owner: "claude",
    nodeKind: "docs",
    status: "failed",
    claimedPaths: ["README.md", "QUICKSTART.md"]
  });

  const receipt = upsertMissionReceipt(
    session,
    mission,
    task,
    {
      claimedPaths: ["README.md", "QUICKSTART.md"],
      progress: []
    },
    {
      summary: "Authentication failed before edits were applied.",
      status: "failed",
      blockers: ["auth"],
      nextRecommendation: null,
      plan: null,
      peerMessages: []
    }
  );

  assert.deepEqual(receipt.changedPaths, []);
});

test("agent contracts are created from peer messages and resolved by follow-up work", () => {
  const session = buildSession();
  const mission = createMission(session, "Build backend then hand UI refinement to Claude.");
  session.missions.push(mission);
  const sourceTask = buildTask({
    id: "task-source",
    missionId: mission.id,
    title: "Backend scaffold",
    owner: "codex",
    nodeKind: "backend",
    claimedPaths: ["apps/api/src/server.ts"],
    nextRecommendation: null
  });
  session.peerMessages.push({
    id: "msg-1",
    taskId: sourceTask.id,
    from: "codex",
    to: "claude",
    intent: "context_share",
    subject: "Refine the UI shell",
    body: "The API stub is in place; refine the frontend shell next.",
    createdAt: "2026-04-10T00:01:00.000Z"
  });

  const created = upsertAgentContractsFromTask(session, mission, sourceTask, {
    summary: "done",
    status: "completed",
    blockers: [],
    nextRecommendation: null,
    plan: null,
    peerMessages: []
  });

  assert.equal(created.length, 1);
  assert.equal(created[0]?.targetAgent, "claude");
  assert.equal(created[0]?.status, "open");

  const followUpTask = buildTask({
    id: "task-follow",
    missionId: mission.id,
    title: "Frontend shell refinement",
    owner: "claude",
    nodeKind: "frontend",
    routeMetadata: {
      sourceMessageId: "msg-1"
    },
    claimedPaths: ["apps/web/app/page.tsx"]
  });

  const resolved = resolveAgentContractsForTask(session, followUpTask);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.status, "resolved");
  assert.equal(resolved[0]?.resolvedByTaskId, "task-follow");
});

test("next recommendations infer explicit targets and dedupe against peer-message contracts", () => {
  const session = buildSession();
  const mission = createMission(session, "Write docs then ask Codex to implement the CLI.");
  session.missions.push(mission);
  const sourceTask = buildTask({
    id: "task-docs",
    missionId: mission.id,
    title: "Docs pass",
    owner: "claude",
    nodeKind: "docs",
    claimedPaths: ["README.md", "QUICKSTART.md"],
    nextRecommendation:
      "Codex should implement the Go CLI and verify the run flow described in QUICKSTART.md."
  });
  session.peerMessages.push({
    id: "msg-docs",
    taskId: sourceTask.id,
    from: "claude",
    to: "codex",
    intent: "context_share",
    subject: "CLI implementation + run-flow verification needed",
    body: "Codex should implement the Go CLI and verify the run flow described in QUICKSTART.md.",
    createdAt: "2026-04-10T00:01:00.000Z"
  });

  const created = upsertAgentContractsFromTask(session, mission, sourceTask, {
    summary: "done",
    status: "completed",
    blockers: [],
    nextRecommendation: sourceTask.nextRecommendation,
    plan: null,
    peerMessages: []
  });

  assert.equal(created.length, 1);
  assert.equal(created[0]?.targetAgent, "codex");
  assert.equal(session.contracts?.length, 1);
});

test("buildAgentContractTaskPrompt and setAgentContractStatus support operator contract workflows", () => {
  const session = buildSession();
  const mission = createMission(session, "Coordinate backend and frontend work.");
  session.missions.push(mission);
  const contract = {
    id: "contract-1",
    missionId: mission.id,
    sourceTaskId: "task-source",
    sourceMessageId: null,
    sourceAgent: "codex" as const,
    targetAgent: "claude" as const,
    kind: "request_refinement" as const,
    status: "open" as const,
    title: "Refine the frontend shell",
    detail: "Take the backend stub and turn it into a polished UI shell.",
    requiredArtifacts: ["apps/web/app/page.tsx"],
    acceptanceExpectations: ["Return a polished frontend shell."],
    urgency: "normal" as const,
    dependencyImpact: "sidecar" as const,
    claimedPaths: ["apps/web/app/page.tsx"],
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z",
    resolvedAt: null,
    resolvedByTaskId: null
  };
  session.contracts?.push(contract);

  const prompt = buildAgentContractTaskPrompt(contract);
  const resolved = setAgentContractStatus(session, contract.id, "resolved", {
    resolvedByTaskId: "task-follow-up"
  });
  const resolvedSnapshot = resolved ? { ...resolved } : null;
  const dismissed = setAgentContractStatus(session, contract.id, "dismissed");

  assert.match(prompt, /Fulfill the open agent contract/i);
  assert.match(prompt, /Refine the frontend shell/);
  assert.equal(resolvedSnapshot?.status, "resolved");
  assert.equal(resolvedSnapshot?.resolvedByTaskId, "task-follow-up");
  assert.equal(dismissed?.status, "dismissed");
  assert.equal(dismissed?.resolvedByTaskId, null);
});

test("buildAutoAppliedContractTask produces a resolvable overnight handoff task", () => {
  const session = buildSession();
  const mission = createMission(session, "Coordinate verification handoff.");
  session.missions.push(mission);
  const contract = {
    id: "contract-handoff",
    missionId: mission.id,
    sourceTaskId: "task-source",
    sourceMessageId: null,
    sourceAgent: "claude" as const,
    targetAgent: "codex" as const,
    kind: "request_verification" as const,
    status: "open" as const,
    title: "Verify the docs handoff",
    detail: "Review QUICKSTART.md and confirm the docs flow.",
    requiredArtifacts: ["QUICKSTART.md"],
    acceptanceExpectations: ["Confirm the quickstart is usable."],
    urgency: "normal" as const,
    dependencyImpact: "blocking" as const,
    claimedPaths: ["QUICKSTART.md"],
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z",
    resolvedAt: null,
    resolvedByTaskId: null
  };
  session.contracts?.push(contract);

  const task = buildAutoAppliedContractTask(contract, "task-contract-auto", {
    routeReason: "Auto-applied overnight.",
    maxRetries: 2
  });

  assert.equal(contractTaskNodeKind(contract), "tests");
  assert.equal(task.owner, "codex");
  assert.equal(task.nodeKind, "tests");
  assert.equal(task.routeMetadata.contractId, contract.id);
  assert.equal(task.routeMetadata.sourceTaskId, contract.sourceTaskId);
  assert.equal(task.routeMetadata.overnightApplied, true);
});

test("buildMissionPostmortem summarizes wins, pain, and follow-up debt", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny API slice.");
  mission.acceptance.status = "failed";
  session.missions.push(mission);
  session.receipts?.push({
    id: "receipt-1",
    missionId: mission.id,
    taskId: "task-api",
    owner: "codex",
    nodeKind: "backend",
    outcome: "completed",
    title: "API slice",
    summary: "Built the endpoint.",
    changedPaths: ["apps/api/src/server.ts"],
    commands: ["npm test"],
    verificationEvidence: ["npm test passed"],
    assumptions: ["Contract would stay small."],
    followUps: ["claude: add docs"],
    risks: ["thin verification"],
    createdAt: "2026-04-10T00:02:00.000Z"
  });
  session.contracts?.push({
    id: "contract-open",
    missionId: mission.id,
    sourceTaskId: "task-api",
    sourceMessageId: null,
    sourceAgent: "codex",
    targetAgent: "claude",
    kind: "request_review",
    status: "open",
    title: "Write docs",
    detail: "Document the endpoint.",
    requiredArtifacts: ["README.md"],
    acceptanceExpectations: ["Add run instructions."],
    urgency: "normal",
    dependencyImpact: "sidecar",
    claimedPaths: ["README.md"],
    createdAt: "2026-04-10T00:02:00.000Z",
    updatedAt: "2026-04-10T00:02:00.000Z",
    resolvedAt: null,
    resolvedByTaskId: null
  });
  mission.acceptance.failurePacks = [{
    id: "failure-1",
    missionId: mission.id,
    checkId: "check-1",
    kind: "http",
    title: "Health check",
    summary: "Expected /health to return 200.",
    expected: ["200"],
    observed: ["500"],
    evidence: ["apps/api/src/server.ts"],
    likelyOwners: ["codex"],
    likelyTaskIds: ["task-api"],
    attribution: "Backend route is failing.",
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
    createdAt: "2026-04-10T00:03:00.000Z",
    updatedAt: "2026-04-10T00:03:00.000Z"
  }];

  const postmortem = buildMissionPostmortem(session, mission, []);

  assert.equal(postmortem.outcome, "failed");
  assert.ok(postmortem.wins.some((item) => /completed/i.test(item)));
  assert.ok(postmortem.pains.some((item) => /Expected \/health to return 200/i.test(item)));
  assert.ok(postmortem.followUpDebt.some((item) => /Write docs/i.test(item)));
  assert.ok(postmortem.reinforcedPatterns.some((item) => /pattern:|command:npm test/i.test(item)));
});
