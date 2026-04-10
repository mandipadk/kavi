import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  addDecisionRecord,
  buildClaimHotspots,
  findClaimConflicts,
  releasePathClaims,
  releaseSupersededClaims,
  upsertPathClaim
} from "./decision-ledger.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    socketPath: "file://session-state",
    status: "running",
    goal: null,
    daemonPid: null,
    daemonHeartbeatAt: null,
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/kavi/dist/main.js"
    },
    worktrees: [],
    tasks: [],
    peerMessages: [],
    decisions: [],
    pathClaims: [],
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

test("decision ledger appends bounded records", () => {
  const session = buildSession();
  addDecisionRecord(session, {
    kind: "route",
    agent: "codex",
    summary: "Routed task to codex",
    detail: "Matched backend keywords."
  });

  assert.equal(session.decisions.length, 1);
  assert.equal(session.decisions[0]?.kind, "route");
});

test("findClaimConflicts returns overlapping claims from the other agent", () => {
  const session = buildSession();
  upsertPathClaim(session, {
    taskId: "task-1",
    agent: "claude",
    source: "route",
    paths: ["src/ui/App.tsx", "src/ui/theme.css"]
  });

  const conflicts = findClaimConflicts(session, "codex", ["src/ui/App.tsx", "src/server/app.ts"]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.agent, "claude");
});

test("findClaimConflicts treats parent and child paths as overlapping", () => {
  const session = buildSession();
  upsertPathClaim(session, {
    taskId: "task-1",
    agent: "claude",
    source: "route",
    paths: ["src/ui"]
  });

  const conflicts = findClaimConflicts(session, "codex", ["src/ui/App.tsx"]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.taskId, "task-1");
});

test("releasePathClaims marks matching active claims as released", () => {
  const session = buildSession();
  upsertPathClaim(session, {
    taskId: "task-1",
    agent: "codex",
    source: "route",
    paths: ["src/server"]
  });
  upsertPathClaim(session, {
    taskId: "task-2",
    agent: "claude",
    source: "route",
    paths: ["src/ui"]
  });

  const released = releasePathClaims(session, {
    taskIds: ["task-2"],
    note: "Released after landing."
  });
  assert.equal(released.length, 1);
  assert.equal(released[0]?.taskId, "task-2");
  assert.equal(session.pathClaims[1]?.status, "released");
  assert.equal(session.pathClaims[0]?.status, "active");
});

test("releaseSupersededClaims releases overlapping older claims for the same agent", () => {
  const session = buildSession();
  upsertPathClaim(session, {
    taskId: "task-1",
    agent: "codex",
    source: "diff",
    paths: ["src/server"]
  });
  upsertPathClaim(session, {
    taskId: "task-2",
    agent: "codex",
    source: "diff",
    paths: ["src/ui"]
  });

  const released = releaseSupersededClaims(session, {
    agent: "codex",
    taskId: "task-3",
    paths: ["src/server/router.ts"],
    note: "Superseded by task-3."
  });

  assert.equal(released.length, 1);
  assert.equal(released[0]?.taskId, "task-1");
  assert.equal(session.pathClaims[0]?.status, "released");
  assert.equal(session.pathClaims[1]?.status, "active");
});

test("buildClaimHotspots groups overlapping active claims into hotspot summaries", () => {
  const session = buildSession();
  upsertPathClaim(session, {
    taskId: "task-1",
    agent: "codex",
    source: "diff",
    paths: ["src/ui"]
  });
  upsertPathClaim(session, {
    taskId: "task-2",
    agent: "claude",
    source: "diff",
    paths: ["src/ui/App.tsx"]
  });

  const hotspots = buildClaimHotspots(session);
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0]?.path, "src/ui/App.tsx");
  assert.deepEqual(hotspots[0]?.agents, ["codex", "claude"]);
});
