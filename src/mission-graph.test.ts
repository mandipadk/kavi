import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { createMission } from "./missions.ts";
import { renderMissionGraph, resolveMissionGraphNodes } from "./mission-graph.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  const timestamp = "2026-04-16T00:00:00.000Z";
  return {
    id: "session-mission-graph",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: timestamp,
    updatedAt: timestamp,
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    fullAccessMode: false,
    daemonPid: 1,
    daemonHeartbeatAt: timestamp,
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
    brain: [],
    providerCapabilities: [],
    peerMessages: [],
    decisions: [],
    pathClaims: [],
    reviewNotes: [],
    recommendationStates: [],
    receipts: [],
    contracts: [],
    daemonState: null,
    selectedMissionId: null,
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

test("resolveMissionGraphNodes prefers plan nodes when a mission plan exists", () => {
  const session = buildSession();
  const mission = createMission(session, "Build a clinic dashboard.");
  mission.planId = "plan-1";
  session.missions.push(mission);
  session.plans.push({
    id: "plan-1",
    missionId: mission.id,
    title: "clinic plan",
    sourcePrompt: mission.prompt,
    sourceTaskId: null,
    planningMode: "operator",
    plannerTaskId: "planner-1",
    summary: "plan",
    status: "active",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nodes: [
      {
        key: "backend",
        taskId: "task-backend",
        title: "Build backend",
        owner: "codex",
        prompt: "backend",
        nodeKind: "backend",
        dependsOn: [],
        claimedPaths: ["apps/api/server.ts"],
        reason: "backend lane",
        executionMode: "execute",
        status: "completed"
      },
      {
        key: "frontend",
        taskId: "task-frontend",
        title: "Build frontend",
        owner: "claude",
        prompt: "frontend",
        nodeKind: "frontend",
        dependsOn: ["backend"],
        claimedPaths: ["apps/web/app/page.tsx"],
        reason: "frontend lane",
        executionMode: "execute",
        status: "planned"
      }
    ]
  });

  const nodes = resolveMissionGraphNodes(session, mission);
  assert.deepEqual(nodes.map((node) => node.key), ["backend", "frontend"]);
});

test("renderMissionGraph produces a dependency tree with critical and ready markers", () => {
  const lines = renderMissionGraph(
    [
      {
        key: "backend",
        title: "Build backend",
        owner: "codex",
        nodeKind: "backend",
        status: "completed",
        dependsOn: [],
        claimedPaths: ["apps/api/server.ts"]
      },
      {
        key: "frontend",
        title: "Build frontend",
        owner: "claude",
        nodeKind: "frontend",
        status: "planned",
        dependsOn: ["backend"],
        claimedPaths: ["apps/web/app/page.tsx"]
      },
      {
        key: "integration",
        title: "Integrate slices",
        owner: "codex",
        nodeKind: "integration",
        status: "pending",
        dependsOn: ["backend", "frontend"],
        claimedPaths: []
      }
    ],
    {
      criticalPath: ["Build frontend", "Integrate slices"],
      nextReadyKeys: ["frontend"]
    }
  );

  assert.match(lines[0] ?? "", /\[DONE\] backend/);
  assert.ok(lines.some((line) => /\[PLAN\] frontend .* \{critical,ready\}/.test(line)));
  assert.ok(lines.some((line) => /\[WAIT\] integration .*deps=backend\+frontend/.test(line)));
});

test("resolveMissionGraphNodes falls back to direct mission tasks when no plan exists", () => {
  const session = buildSession();
  const mission = createMission(session, "Write a tiny README.");
  session.missions.push(mission);
  session.tasks.push({
    id: "task-direct",
    missionId: mission.id,
    title: "Write README",
    owner: "claude",
    kind: "execution",
    nodeKind: "docs",
    status: "running",
    prompt: "Write README",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    lease: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    summary: null,
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["README.md"]
  });

  const nodes = resolveMissionGraphNodes(session, mission);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.key, "task-direct");
  assert.match(renderMissionGraph(nodes)[0] ?? "", /\[RUN \] task-direct/);
});
