import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "./paths.ts";
import { listTaskArtifacts, loadTaskArtifact, saveTaskArtifact } from "./task-artifacts.ts";

test("task artifacts can be written, loaded, and listed", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-artifacts-"));
  const paths = resolveAppPaths(repoRoot);

  const artifact = {
    taskId: "task-1",
    sessionId: "session-1",
    missionId: null,
    title: "Test task",
    owner: "codex" as const,
    kind: "execution" as const,
    nodeKind: null,
    status: "completed" as const,
    summary: "done",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 0,
    lastFailureSummary: null,
    routeReason: "Matched backend routing keywords.",
    routeStrategy: "keyword" as const,
    routeConfidence: 0.92,
    routeMetadata: {
      matchedKeywordSet: "backend"
    },
    claimedPaths: ["src/server/app.ts"],
    decisionReplay: ["- Current route reason: Matched backend routing keywords."],
    rawOutput: "{\"summary\":\"done\"}",
    error: null,
    envelope: {
      summary: "done",
      status: "completed" as const,
      blockers: [],
      nextRecommendation: null,
      plan: null,
      peerMessages: []
    },
    reviewNotes: [
      {
        id: "review-1",
        agent: "codex" as const,
        assignee: "operator" as const,
        taskId: "task-1",
        filePath: "src/server/app.ts",
        hunkIndex: 0,
        hunkHeader: "@@ -1,1 +1,2 @@",
        disposition: "approve" as const,
        status: "open" as const,
        summary: "Approve src/server/app.ts @@ -1,1 +1,2 @@: Looks correct",
        body: "Looks correct",
        comments: [
          {
            id: "comment-1",
            body: "Looks correct",
            createdAt: "2026-03-24T00:00:02.000Z",
            updatedAt: "2026-03-24T00:00:02.000Z"
          }
        ],
        resolvedAt: null,
        landedAt: null,
        followUpTaskIds: [],
        createdAt: "2026-03-24T00:00:02.000Z",
        updatedAt: "2026-03-24T00:00:02.000Z"
      }
    ],
    startedAt: "2026-03-24T00:00:00.000Z",
    finishedAt: "2026-03-24T00:00:01.000Z",
    nextRecommendation: null,
    progress: [],
    attempts: []
  };

  await saveTaskArtifact(paths, artifact);

  const loaded = await loadTaskArtifact(paths, "task-1");
  assert.deepEqual(loaded, artifact);

  const listed = await listTaskArtifacts(paths);
  assert.deepEqual(listed, [artifact]);
});

test("task artifacts normalize missing progress to an empty array", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-artifacts-legacy-"));
  const paths = resolveAppPaths(repoRoot);

  await saveTaskArtifact(paths, {
    taskId: "task-legacy",
    sessionId: "session-1",
    missionId: null,
    title: "Legacy artifact",
    owner: "codex",
    kind: "execution",
    nodeKind: null,
    status: "completed",
    summary: "done",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 0,
    lastFailureSummary: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: [],
    decisionReplay: [],
    rawOutput: null,
    error: null,
    envelope: null,
    reviewNotes: [],
    startedAt: "2026-03-24T00:00:00.000Z",
    finishedAt: "2026-03-24T00:00:01.000Z",
    nextRecommendation: null,
    progress: [],
    attempts: []
  });

  const filePath = path.join(paths.runsDir, "task-legacy.json");
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  delete raw.progress;
  await fs.writeFile(filePath, JSON.stringify(raw, null, 2));

  const loaded = await loadTaskArtifact(paths, "task-legacy");
  assert.ok(loaded);
  assert.deepEqual(loaded.progress, []);
  assert.deepEqual(loaded.attempts, []);
});

test("task artifacts preserve semantic progress kinds", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-artifacts-semantic-"));
  const paths = resolveAppPaths(repoRoot);

  await saveTaskArtifact(paths, {
    taskId: "task-semantic",
    sessionId: "session-1",
    missionId: null,
    title: "Semantic artifact",
    owner: "claude",
    kind: "execution",
    nodeKind: null,
    status: "running",
    summary: null,
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["apps/web/app/page.tsx"],
    decisionReplay: [],
    rawOutput: null,
    error: null,
    envelope: null,
    reviewNotes: [],
    startedAt: "2026-03-24T00:00:00.000Z",
    finishedAt: null,
    nextRecommendation: null,
    progress: [
      {
        id: "progress-1",
        kind: "provider",
        summary: "Claude planning: refine the dashboard flow before editing the page shell.",
        paths: ["apps/web/app/page.tsx"],
        createdAt: "2026-03-24T00:00:30.000Z",
        provider: "claude",
        eventName: "planning",
        semanticKind: "planning",
        source: "transcript"
      }
    ],
    attempts: []
  });

  const loaded = await loadTaskArtifact(paths, "task-semantic");
  assert.equal(loaded?.progress[0]?.semanticKind, "planning");
});

test("task artifacts preserve null finishedAt for running work", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-artifacts-running-"));
  const paths = resolveAppPaths(repoRoot);

  await saveTaskArtifact(paths, {
    taskId: "task-running",
    sessionId: "session-1",
    missionId: null,
    title: "Running artifact",
    owner: "codex",
    kind: "execution",
    nodeKind: null,
    status: "running",
    summary: null,
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: [],
    decisionReplay: [],
    rawOutput: null,
    error: null,
    envelope: null,
    reviewNotes: [],
    startedAt: "2026-03-24T00:00:00.000Z",
    finishedAt: null,
    nextRecommendation: null,
    progress: [],
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        startedAt: "2026-03-24T00:00:00.000Z",
        finishedAt: null,
        status: "running",
        summary: null
      }
    ]
  });

  const loaded = await loadTaskArtifact(paths, "task-running");
  assert.equal(loaded?.finishedAt, null);
  assert.equal(loaded?.attempts[0]?.finishedAt, null);
});
