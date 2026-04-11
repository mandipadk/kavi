import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { buildBlueprintPreview, diffMissionBlueprint, diffMissionPrompts } from "./blueprint.ts";
import { createMission } from "./missions.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-blueprint",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: null,
    selectedMissionId: null,
    fullAccessMode: false,
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

test("buildBlueprintPreview compiles a greenfield blueprint without mutating session state", () => {
  const session = buildSession();

  const preview = buildBlueprintPreview(
    session,
    "Build a production-shaped healthcare starter from scratch with frontend, backend, shared contracts, docs, and tests."
  );

  assert.ok(preview.spec.workstreamKinds.includes("frontend"));
  assert.ok(preview.spec.workstreamKinds.includes("backend"));
  assert.ok(preview.spec.workstreamKinds.includes("shared_contract"));
  assert.ok(preview.contract.acceptanceCriteria.length > 0);
  assert.ok(preview.blueprint.serviceBoundaries.length > 0);
  assert.ok(preview.simulation);
  assert.equal(session.missions.length, 0);
});

test("diffMissionBlueprint highlights blueprint, spec, and policy deltas", () => {
  const session = buildSession();
  const mission = createMission(session, "Write a small docs starter.");

  const preview = buildBlueprintPreview(
    session,
    "Build a production-shaped healthcare starter from scratch with frontend, backend, shared contracts, docs, and tests."
  );
  const diff = diffMissionBlueprint(mission, preview);

  assert.equal(diff.promptChanged, true);
  assert.ok(diff.spec.workstreamKinds.added.includes("frontend"));
  assert.ok(diff.spec.workstreamKinds.added.includes("backend"));
  assert.ok(diff.spec.stackHints.added.length >= 0);
  assert.ok(diff.blueprint.serviceBoundaries.added.length > 0);
  assert.ok(diff.contract.acceptanceCriteria.added.length > 0);
  assert.ok(diff.policy.changedFields.length > 0);
});

test("diffMissionPrompts compares two mission prompt revisions without a live mission", () => {
  const session = buildSession();

  const diff = diffMissionPrompts(
    session,
    "Build a compact docs starter with one quickstart.",
    "Build a healthcare platform starter with frontend, backend, shared contracts, docs, and tests."
  );

  assert.equal(diff.promptChanged, true);
  assert.ok(diff.spec.workstreamKinds.added.includes("frontend"));
  assert.ok(diff.spec.workstreamKinds.added.includes("backend"));
  assert.ok(diff.contract.acceptanceCriteria.added.length > 0);
  assert.ok(diff.blueprint.serviceBoundaries.added.length > 0);
});
