import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  addMissionCheckpoint,
  computeAcceptanceStatus,
  createMission,
  latestMission,
  markLatestMissionLanded,
  missionHasInFlightTasks,
  selectMission,
  syncMissionStates,
  updateMissionPolicy
} from "./missions.ts";
import type { SessionRecord, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-03-25T00:00:01.000Z",
    daemonVersion: "1.1.3",
    protocolVersion: 1,
    fullAccessMode: false,
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

function buildTask(input: Partial<TaskSpec> & Pick<TaskSpec, "id" | "missionId" | "title">): TaskSpec {
  return {
    id: input.id,
    missionId: input.missionId,
    title: input.title,
    owner: input.owner ?? "codex",
    kind: input.kind ?? "execution",
    nodeKind: input.nodeKind ?? "backend",
    status: input.status ?? "pending",
    prompt: input.prompt ?? input.title,
    dependsOnTaskIds: input.dependsOnTaskIds ?? [],
    parentTaskId: input.parentTaskId ?? null,
    planId: input.planId ?? null,
    planNodeKey: input.planNodeKey ?? null,
    retryCount: input.retryCount ?? 0,
    maxRetries: input.maxRetries ?? 2,
    lastFailureSummary: input.lastFailureSummary ?? null,
    lease: input.lease ?? null,
    createdAt: input.createdAt ?? "2026-03-25T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-25T00:00:00.000Z",
    summary: input.summary ?? null,
    nextRecommendation: input.nextRecommendation ?? null,
    routeReason: input.routeReason ?? null,
    routeStrategy: input.routeStrategy ?? "manual",
    routeConfidence: input.routeConfidence ?? 1,
    routeMetadata: input.routeMetadata ?? {},
    claimedPaths: input.claimedPaths ?? []
  };
}

test("computeAcceptanceStatus stays pending until at least one real verification path resolves", () => {
  const session = buildSession();
  const mission = createMission(session, "Build a frontend and backend slice.");

  assert.equal(computeAcceptanceStatus(mission.acceptance), "pending");
  assert.equal(mission.packetVersion, 2);
  assert.ok(mission.spec?.workstreamKinds.includes("frontend"));
  assert.ok(mission.contract?.acceptanceCriteria.length);
  assert.ok(mission.blueprint?.serviceBoundaries.length);
  assert.equal(mission.policy?.approvalMode, "standard");
  assert.ok(mission.policy?.gatePolicy.includes("acceptance"));
  assert.ok(Array.isArray(mission.risks));
  assert.ok(Array.isArray(mission.anchors));

  const manualCheck = mission.acceptance.checks.find((check) => check.kind === "manual");
  assert.ok(manualCheck);
  manualCheck.status = "skipped";
  assert.equal(computeAcceptanceStatus(mission.acceptance), "passed");
});

test("createMission preserves shadow lineage when requested", () => {
  const session = buildSession();
  const mission = createMission(session, "Explore an alternate frontend direction.", {
    shadowOfMissionId: "mission-root"
  });

  assert.equal(mission.shadowOfMissionId, "mission-root");
  assert.equal(mission.mode, "guided_autopilot");
});

test("latestMission prefers an explicitly selected mission", () => {
  const session = buildSession();
  const baseMission = createMission(session, "Ship the baseline slice.");
  const shadowMission = createMission(session, "Explore an alternate direction.", {
    shadowOfMissionId: baseMission.id
  });
  session.missions.push(baseMission, shadowMission);

  const selected = selectMission(session, baseMission.id);

  assert.equal(selected?.id, baseMission.id);
  assert.equal(latestMission(session)?.id, baseMission.id);
});

test("updateMissionPolicy applies autonomy and recovery overrides", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny runnable slice.");
  session.missions.push(mission);

  const updated = updateMissionPolicy(session, mission.id, {
    autonomyLevel: "overnight",
    autoVerify: true,
    autoLand: true,
    pauseOnRepairFailure: false,
    retryBudget: 4,
    autopilotEnabled: true
  });

  assert.equal(updated?.policy?.autonomyLevel, "overnight");
  assert.equal(updated?.policy?.autoVerify, true);
  assert.equal(updated?.policy?.autoLand, true);
  assert.equal(updated?.policy?.pauseOnRepairFailure, false);
  assert.equal(updated?.policy?.retryBudget, 4);
  assert.equal(updated?.autopilotEnabled, true);
});

test("syncMissionStates moves a completed mission into awaiting_acceptance before land", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny runnable slice.");
  session.missions.push(mission);
  session.tasks.push(
    buildTask({
      id: "task-1",
      missionId: mission.id,
      title: "Deliver slice",
      status: "completed",
      summary: "done"
    })
  );

  syncMissionStates(session);

  assert.equal(session.missions[0].status, "awaiting_acceptance");
  assert.equal(session.missions[0].acceptance.status, "pending");
});

test("syncMissionStates keeps direct-execution missions active while their root task is running", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny direct slice.", {
    rootTaskId: "task-direct"
  });
  session.missions.push(mission);
  session.tasks.push(
    buildTask({
      id: "task-direct",
      missionId: mission.id,
      title: "Direct execution",
      status: "running"
    })
  );

  syncMissionStates(session);

  assert.equal(session.missions[0].status, "active");
  assert.deepEqual(session.missions[0].activeTaskIds, ["task-direct"]);
});

test("markLatestMissionLanded records the landed mission checkpoint", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny runnable slice.");
  session.missions.push(mission);

  const landed = markLatestMissionLanded(session, "main");

  assert.ok(landed);
  assert.equal(landed?.status, "landed");
  assert.match(landed?.summary ?? "", /Landed into main/);
  assert.equal(landed?.checkpoints.at(-1)?.kind, "landed");
});

test("addMissionCheckpoint preserves repair queue lifecycle kinds", () => {
  const session = buildSession();
  const mission = createMission(session, "Repair a failing acceptance check.");
  session.missions.push(mission);

  const checkpoint = addMissionCheckpoint(session, mission.id, {
    kind: "repair_queued",
    title: "Acceptance repair queued",
    detail: "Queued a repair node from failed acceptance.",
    taskId: "task-repair-1"
  });

  assert.equal(checkpoint?.kind, "repair_queued");
  assert.equal(session.missions[0]?.checkpoints.at(-1)?.kind, "repair_queued");
});

test("missionHasInFlightTasks only counts pending or running work", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny runnable slice.");
  session.missions.push(mission);
  session.tasks.push(
    buildTask({
      id: "task-1",
      missionId: mission.id,
      title: "Deliver slice",
      status: "completed"
    }),
    buildTask({
      id: "task-2",
      missionId: mission.id,
      title: "Polish slice",
      status: "running"
    })
  );

  assert.equal(missionHasInFlightTasks(session, mission.id), true);
  session.tasks[1] = { ...session.tasks[1], status: "failed" };
  assert.equal(missionHasInFlightTasks(session, mission.id), false);
});

test("missionHasInFlightTasks ignores supplemental kickoff work once planned execution is active", () => {
  const session = buildSession();
  const mission = createMission(session, "Ship a tiny runnable slice.");
  mission.planId = "plan-1";
  mission.planningTaskId = "kickoff-codex";
  session.missions.push(mission);
  session.tasks.push(
    buildTask({
      id: "kickoff-codex",
      missionId: mission.id,
      title: "Codex kickoff plan",
      kind: "planner",
      status: "completed"
    }),
    buildTask({
      id: "kickoff-claude",
      missionId: mission.id,
      title: "Claude intent interpretation",
      kind: "kickoff",
      owner: "claude",
      nodeKind: "review",
      status: "running"
    }),
    buildTask({
      id: "task-exec",
      missionId: mission.id,
      title: "Build slice",
      kind: "execution",
      status: "completed"
    })
  );

  syncMissionStates(session);

  assert.equal(missionHasInFlightTasks(session, mission.id), false);
  assert.deepEqual(session.missions[0]?.activeTaskIds, []);
  assert.equal(session.missions[0]?.status, "awaiting_acceptance");
});
