import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  buildPlannerTask,
  decidePlanningMode,
  isTaskReady,
  materializeExecutionPlan
} from "./planning.ts";
import type { PlannedTaskGraph, SessionRecord, TaskSpec } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: "Build the product",
    fullAccessMode: false,
    daemonPid: 1,
    daemonHeartbeatAt: "2026-03-29T00:00:00.000Z",
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

test("decidePlanningMode escalates broad prompts into planner mode", () => {
  const session = buildSession();
  const decision = decidePlanningMode(
    "Scaffold the app, build the backend API, create the frontend shell, then add tests and review the whole thing.",
    session,
    "auto"
  );

  assert.equal(decision.usePlanner, true);
});

test("decidePlanningMode escalates production-shaped full-stack starter prompts", () => {
  const session = buildSession();
  const decision = decidePlanningMode(
    "Build a small but real full-stack starter for a library check-in system. Create a Node API, a minimal web frontend shell, basic domain models, and tests. Keep it focused but production-shaped.",
    session,
    "auto"
  );

  assert.equal(decision.usePlanner, true);
  assert.match(decision.reason, /orchestrated|plan/i);
});

test("decidePlanningMode avoids redundant planning when an active plan exists", () => {
  const session = buildSession();
  session.plans.push({
    id: "plan-1",
    title: "Active plan",
    sourcePrompt: "Build the product",
    sourceTaskId: "planner-1",
    planningMode: "operator",
    plannerTaskId: "planner-1",
    summary: "Existing plan",
    status: "active",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    nodes: []
  });

  const decision = decidePlanningMode("Implement the next backend task in src/server/api.ts", session, "auto");
  assert.equal(decision.usePlanner, false);
  assert.match(decision.reason, /active execution plan/i);
});

test("materializeExecutionPlan creates dependency-aware tasks", () => {
  const session = buildSession();
  const plannerTask = buildPlannerTask(session, "Build the product", {
    planningMode: "operator"
  });
  session.tasks.push(plannerTask);

  const graph: PlannedTaskGraph = {
    summary: "Two-step plan",
    tasks: [
      {
        key: "foundation",
        title: "Create backend foundation",
        owner: "codex",
        prompt: "Build the API foundation.",
        dependsOn: [],
        claimedPaths: ["src/server/api.ts"],
        reason: "Backend base work must come first.",
        executionMode: "blocking"
      },
      {
        key: "ui",
        title: "Build the UI shell",
        owner: "claude",
        prompt: "Build the UI shell on top of the API contract.",
        dependsOn: ["foundation"],
        claimedPaths: ["src/ui/App.tsx"],
        reason: "The UI depends on the API shape.",
        executionMode: "parallel"
      }
    ]
  };

  const { plan, tasks } = materializeExecutionPlan(session, plannerTask, graph, plannerTask.prompt);
  assert.equal(plan.nodes.length, 2);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.dependsOnTaskIds.length, 0);
  assert.equal(tasks[1]?.dependsOnTaskIds.length, 1);
  assert.equal(tasks[1]?.planId, plan.id);
});

test("isTaskReady only returns true when dependencies are completed", () => {
  const dependency: TaskSpec = {
    id: "task-a",
    title: "Foundation",
    owner: "codex",
    kind: "execution",
    status: "completed",
    prompt: "Build foundation",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: "plan-1",
    planNodeKey: "foundation",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    summary: "done",
    routeReason: null,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {},
    claimedPaths: []
  };
  const dependent: TaskSpec = {
    ...dependency,
    id: "task-b",
    title: "UI",
    owner: "claude",
    dependsOnTaskIds: ["task-a"],
    planNodeKey: "ui",
    status: "pending"
  };

  const session = buildSession();
  session.tasks.push(dependency, dependent);
  assert.equal(isTaskReady(session, dependent), true);

  session.tasks[0] = {
    ...dependency,
    status: "running"
  };
  assert.equal(isTaskReady(session, dependent), false);
});
