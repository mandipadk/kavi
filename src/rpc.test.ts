import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApprovalRequest, listApprovalRequests } from "./approvals.ts";
import { ensureProjectScaffold, defaultConfig } from "./config.ts";
import { KaviDaemon } from "./daemon.ts";
import { resolveAppPaths } from "./paths.ts";
import {
  rpcAddReviewNote,
  rpcAddReviewReply,
  rpcAppendHookProgress,
  rpcDismissRecommendation,
  rpcEnqueueReviewFollowUp,
  rpcMergeBrainEntries,
  rpcNotifyExternalUpdate,
  pingRpc,
  rpcRetireBrainEntry,
  readSnapshot,
  rpcKickoff,
  rpcRecentEvents,
  rpcRetryTask,
  rpcResolveApproval,
  rpcSelectMission,
  rpcSetBrainEntryPinned,
  rpcSetFullAccessMode,
  rpcRestoreRecommendation,
  rpcSetReviewNoteStatus,
  rpcShutdown,
  rpcUpdateReviewNote,
  subscribeSnapshotRpc
} from "./rpc.ts";
import { createSessionRecord, loadSessionRecord, saveSessionRecord } from "./session.ts";
import { loadTaskArtifact, saveTaskArtifact } from "./task-artifacts.ts";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for RPC state.");
}

function isSocketPermissionError(error: unknown): boolean {
  return error instanceof Error && /listen EPERM/.test(error.message);
}

test("daemon exposes operator state and control over the Unix socket", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-rpc-"));
  const previousHomeConfigDir = process.env.KAVI_HOME_CONFIG_DIR;
  const previousHomeStateDir = process.env.KAVI_HOME_STATE_DIR;
  process.env.KAVI_HOME_CONFIG_DIR = path.join(root, "home-config");
  process.env.KAVI_HOME_STATE_DIR = path.join(root, "home-state");

  t.after(() => {
    if (previousHomeConfigDir === undefined) {
      delete process.env.KAVI_HOME_CONFIG_DIR;
    } else {
      process.env.KAVI_HOME_CONFIG_DIR = previousHomeConfigDir;
    }

    if (previousHomeStateDir === undefined) {
      delete process.env.KAVI_HOME_STATE_DIR;
    } else {
      process.env.KAVI_HOME_STATE_DIR = previousHomeStateDir;
    }
  });

  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot, { recursive: true });

  const paths = resolveAppPaths(repoRoot);
  await ensureProjectScaffold(paths);
  await createSessionRecord(
    paths,
    defaultConfig(),
    {
      nodeExecutable: process.execPath,
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: path.join(root, "dist", "main.js")
    },
    "session-rpc",
    "base",
    [],
    null,
    paths.socketPath
  );

  const daemon = new KaviDaemon(paths);
  const daemonPromise = daemon.start();
  let daemonStartError: unknown = null;
  void daemonPromise.catch((error) => {
    daemonStartError = error;
  });

  t.after(async () => {
    try {
      if (await pingRpc(paths)) {
        await rpcShutdown(paths);
      }
    } catch {
      // ignore cleanup failures
    }

    await daemonPromise.catch(() => {});
  });

  await waitFor(async () => daemonStartError !== null || (await pingRpc(paths)));
  if (daemonStartError) {
    if (isSocketPermissionError(daemonStartError)) {
      t.skip("Unix socket listen is not permitted in this sandbox.");
      return;
    }

    throw daemonStartError;
  }

  const initial = await readSnapshot(paths);
  assert.equal(initial.session.id, "session-rpc");
  assert.equal(initial.session.socketPath, paths.socketPath);
  assert.equal(typeof initial.session.daemonVersion, "string");
  assert.equal(initial.session.protocolVersion, 1);

  const pushedReasons: string[] = [];
  const subscription = subscribeSnapshotRpc(paths, {
    onSnapshot: (event) => {
      pushedReasons.push(event.reason);
    }
  });
  await subscription.connected;
  await waitFor(async () => pushedReasons.includes("subscribe"));

  await rpcKickoff(paths, "Plan the system");
  await waitFor(async () => pushedReasons.includes("tasks.kickoff_enqueued"));
  const afterKickoff = await readSnapshot(paths);
  assert.equal(afterKickoff.session.goal, "Plan the system");
  assert.equal(afterKickoff.session.tasks.length, 2);
  assert.deepEqual(
    afterKickoff.session.tasks.map((task) => task.owner),
    ["codex", "claude"]
  );

  const seededSession = await loadSessionRecord(paths);
  seededSession.tasks.push({
    id: "task-live-claude",
    missionId: null,
    title: "Live Claude task",
    owner: "claude",
    kind: "execution",
    nodeKind: "frontend",
    status: "running",
    prompt: "Refine the web shell",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    lease: null,
    createdAt: "2026-03-25T00:01:00.000Z",
    updatedAt: "2026-03-25T00:01:00.000Z",
    summary: "Running live Claude task.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["apps/web/app/page.tsx"]
  });
  await saveSessionRecord(paths, seededSession);
  await saveTaskArtifact(paths, {
    taskId: "task-live-claude",
    sessionId: seededSession.id,
    missionId: null,
    title: "Live Claude task",
    owner: "claude",
    kind: "execution",
    nodeKind: "frontend",
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
    progress: [],
    attempts: [],
    startedAt: "2026-03-25T00:01:00.000Z",
    finishedAt: "2026-03-25T00:01:00.000Z",
    nextRecommendation: null
  });
  await rpcNotifyExternalUpdate(paths, "test.hook_seeded");
  await waitFor(async () => pushedReasons.includes("test.hook_seeded"));

  await rpcAppendHookProgress(paths, {
    taskId: "task-live-claude",
    transcriptPath: "/tmp/claude-transcript.jsonl",
    entries: [
      {
        summary: "Claude completed Write | success.",
        paths: ["apps/web/app/page.tsx"],
        provider: "claude",
        eventName: "tool-complete",
        source: "hook"
      }
    ]
  });
  await waitFor(async () => pushedReasons.includes("task.progress"));
  const afterHookProgress = await loadTaskArtifact(paths, "task-live-claude");
  assert.equal(afterHookProgress?.progress.length, 1);
  assert.equal(afterHookProgress?.progress[0]?.source, "hook");
  assert.equal(afterHookProgress?.progress[0]?.eventName, "tool-complete");
  const afterHookSession = await loadSessionRecord(paths);
  assert.equal(
    afterHookSession.tasks.find((task) => task.id === "task-live-claude")?.routeMetadata?.claudeTranscriptPath,
    "/tmp/claude-transcript.jsonl"
  );

  await rpcSetFullAccessMode(paths, {
    enabled: true
  });
  await waitFor(async () => pushedReasons.includes("session.full_access_mode_changed"));
  const afterModeToggle = await readSnapshot(paths);
  assert.equal(afterModeToggle.session.fullAccessMode, true);

  const reloadedSession = await loadSessionRecord(paths);
  reloadedSession.missions.push({
    id: "mission-external",
    title: "External mission update",
    prompt: "External mission update",
    goal: null,
    mode: "guided_autopilot",
    status: "awaiting_acceptance",
    summary: "Acceptance was verified externally.",
    planningTaskId: null,
    planId: null,
    rootTaskId: null,
    activeTaskIds: [],
    autopilotEnabled: true,
    acceptance: {
      id: "accept-external",
      summary: "Mission acceptance pack",
      criteria: ["External verification persisted."],
      checks: [
        {
          id: "check-external",
          title: "Operator review",
          kind: "manual",
          command: null,
          status: "passed",
          detail: "Already verified.",
          lastRunAt: "2026-03-25T00:06:00.000Z",
          lastOutput: "ok"
        }
      ],
      status: "passed",
      createdAt: "2026-03-25T00:06:00.000Z",
      updatedAt: "2026-03-25T00:06:00.000Z"
    },
    checkpoints: [],
    brainEntryIds: [],
    createdAt: "2026-03-25T00:06:00.000Z",
    updatedAt: "2026-03-25T00:06:00.000Z",
    landedAt: null
  });
  reloadedSession.missions.push({
    id: "mission-shadow",
    title: "Shadow alternative",
    prompt: "Shadow alternative",
    goal: null,
    mode: "guided_autopilot",
    status: "completed",
    summary: "Alternative mission candidate.",
    planningTaskId: null,
    planId: null,
    rootTaskId: null,
    activeTaskIds: [],
    autopilotEnabled: true,
    shadowOfMissionId: "mission-external",
    acceptance: {
      id: "accept-shadow",
      summary: "Shadow acceptance pack",
      criteria: ["Alternative validated."],
      checks: [
        {
          id: "check-shadow",
          title: "Operator review",
          kind: "manual",
          command: null,
          status: "passed",
          detail: "Already verified.",
          lastRunAt: "2026-03-25T00:08:00.000Z",
          lastOutput: "ok"
        }
      ],
      status: "passed",
      createdAt: "2026-03-25T00:08:00.000Z",
      updatedAt: "2026-03-25T00:08:00.000Z"
    },
    checkpoints: [],
    brainEntryIds: [],
    createdAt: "2026-03-25T00:08:00.000Z",
    updatedAt: "2026-03-25T00:08:00.000Z",
    landedAt: null
  });
  await saveSessionRecord(paths, reloadedSession);
  await rpcNotifyExternalUpdate(paths, "test.external_reload");
  await waitFor(async () => pushedReasons.includes("test.external_reload"));
  const afterExternalReload = await readSnapshot(paths);
  assert.equal(afterExternalReload.session.missions.some((mission) => mission.id === "mission-external"), true);
  assert.equal(afterExternalReload.session.missions.find((mission) => mission.id === "mission-external")?.acceptance.status, "passed");
  await rpcSelectMission(paths, {
    missionId: "mission-external"
  });
  await waitFor(async () => pushedReasons.includes("mission.selected"));
  const afterSelection = await readSnapshot(paths);
  assert.equal(afterSelection.session.selectedMissionId, "mission-external");

  const brainSession = await loadSessionRecord(paths);
  brainSession.brain.push({
    id: "brain-1",
    missionId: "mission-external",
    taskId: null,
    sourceType: "mission",
    category: "fact",
    scope: "mission",
    title: "Mission structure",
    content: "Tracks the primary care coordination structure.",
    tags: ["care", "coordination"],
    confidence: 0.8,
    freshness: "live",
    evidence: ["docs/mission.md"],
    commands: [],
    pinned: false,
    supersedes: [],
    supersededBy: null,
    contradictions: [],
    retiredAt: null,
    createdAt: "2026-03-25T00:06:30.000Z",
    updatedAt: "2026-03-25T00:06:30.000Z"
  });
  brainSession.brain.push({
    id: "brain-2",
    missionId: "mission-external",
    taskId: null,
    sourceType: "task",
    category: "artifact",
    scope: "mission",
    title: "Mission structure draft",
    content: "Older draft of the care coordination structure.",
    tags: ["care"],
    confidence: 0.65,
    freshness: "recent",
    evidence: ["notes/draft.md"],
    commands: [],
    pinned: false,
    supersedes: [],
    supersededBy: null,
    contradictions: [],
    retiredAt: null,
    createdAt: "2026-03-25T00:06:20.000Z",
    updatedAt: "2026-03-25T00:06:20.000Z"
  });
  await saveSessionRecord(paths, brainSession);
  await rpcNotifyExternalUpdate(paths, "test.brain_seeded");
  await waitFor(async () => pushedReasons.includes("test.brain_seeded"));

  await rpcSetBrainEntryPinned(paths, {
    entryId: "brain-1",
    pinned: true
  });
  await waitFor(async () => pushedReasons.includes("brain.entry_pinned"));

  await rpcMergeBrainEntries(paths, {
    targetEntryId: "brain-1",
    sourceEntryId: "brain-2"
  });
  await waitFor(async () => pushedReasons.includes("brain.entry_merged"));

  await rpcRetireBrainEntry(paths, {
    entryId: "brain-1"
  });
  await waitFor(async () => pushedReasons.includes("brain.entry_retired"));

  const afterBrain = await readSnapshot(paths);
  const pinnedBrainEntry = afterBrain.session.brain.find((entry) => entry.id === "brain-1");
  const supersededBrainEntry = afterBrain.session.brain.find((entry) => entry.id === "brain-2");
  assert.equal(pinnedBrainEntry?.pinned, true);
  assert.equal(typeof pinnedBrainEntry?.retiredAt, "string");
  assert.equal(supersededBrainEntry?.supersededBy, "brain-1");

  await rpcAddReviewNote(paths, {
    agent: "codex",
    assignee: "claude",
    taskId: null,
    filePath: "src/server.ts",
    hunkIndex: 0,
    hunkHeader: "@@ -1,1 +1,2 @@",
    disposition: "concern",
    body: "The handler still swallows the upstream error."
  });
  await waitFor(async () => pushedReasons.includes("review.note_added"));
  const afterReview = await readSnapshot(paths);
  assert.equal(afterReview.session.reviewNotes.length, 1);
  assert.equal(afterReview.session.reviewNotes[0]?.disposition, "concern");
  assert.equal(afterReview.session.reviewNotes[0]?.assignee, "claude");
  assert.equal(afterReview.session.decisions.some((decision) => decision.kind === "review"), true);

  const noteId = afterReview.session.reviewNotes[0]?.id;
  assert.ok(noteId);
  const recommendationId = `handoff:${noteId}:claude`;
  assert.equal(
    afterReview.session.reviewNotes[0]?.status,
    "open"
  );

  await rpcDismissRecommendation(paths, {
    recommendationId,
    reason: "already queued elsewhere"
  });
  await waitFor(async () => pushedReasons.includes("recommendation.dismissed"));
  const afterDismiss = await readSnapshot(paths);
  const dismissedRecommendation = afterDismiss.session.recommendationStates.find((state) => state.id === recommendationId);
  assert.equal(dismissedRecommendation?.status, "dismissed");
  assert.equal(dismissedRecommendation?.dismissedReason, "already queued elsewhere");

  await rpcRestoreRecommendation(paths, {
    recommendationId
  });
  await waitFor(async () => pushedReasons.includes("recommendation.restored"));
  const afterRestore = await readSnapshot(paths);
  const restoredRecommendation = afterRestore.session.recommendationStates.find((state) => state.id === recommendationId);
  assert.equal(restoredRecommendation?.status, "active");

  await rpcAddReviewReply(paths, {
    noteId,
    body: "Please also cover the regression path with a test."
  });
  await waitFor(async () => pushedReasons.includes("review.reply_added"));

  await rpcUpdateReviewNote(paths, {
    noteId,
    body: "The handler still swallows the upstream error and needs a test.",
    disposition: "accepted_risk",
    assignee: "claude"
  });
  await waitFor(async () => pushedReasons.includes("review.note_updated"));

  await rpcSetReviewNoteStatus(paths, {
    noteId,
    status: "resolved"
  });
  await waitFor(async () => pushedReasons.includes("review.note_status_changed"));

  await rpcEnqueueReviewFollowUp(paths, {
    noteId,
    owner: "codex",
    mode: "fix"
  });
  await waitFor(async () => pushedReasons.includes("review.followup_queued"));
  const afterFollowUp = await readSnapshot(paths);
  const updatedNote = afterFollowUp.session.reviewNotes.find((note) => note.id === noteId);
  assert.equal(updatedNote?.status, "resolved");
  assert.equal(updatedNote?.disposition, "accepted_risk");
  assert.equal(updatedNote?.assignee, "codex");
  assert.equal(updatedNote?.followUpTaskIds.length, 1);
  assert.equal(updatedNote?.comments.length, 2);
  assert.equal(
    afterFollowUp.session.tasks.some((task) => task.id === updatedNote?.followUpTaskIds[0]),
    true
  );

  async function seedRetryTask(): Promise<void> {
    const retrySession = await loadSessionRecord(paths);
    if (!retrySession.tasks.some((task) => task.id === "task-failed")) {
      retrySession.tasks.push({
        id: "task-failed",
        missionId: null,
        title: "Retry me",
        owner: "codex",
        kind: "execution",
        nodeKind: "backend",
        status: "failed",
        prompt: "Retry me",
        dependsOnTaskIds: [],
        parentTaskId: null,
        planId: null,
        planNodeKey: null,
        retryCount: 2,
        maxRetries: 2,
        lastFailureSummary: "Task timed out after 120 seconds.",
        lease: null,
        createdAt: "2026-03-25T00:07:00.000Z",
        updatedAt: "2026-03-25T00:07:00.000Z",
        summary: "Task failed and is ready for operator retry.",
        nextRecommendation: null,
        routeReason: null,
        routeStrategy: "manual",
        routeConfidence: 1,
        routeMetadata: {},
        claimedPaths: []
      });
      await saveSessionRecord(paths, retrySession);
    }
    await rpcNotifyExternalUpdate(paths, "test.retry_seeded");
    await waitFor(async () => pushedReasons.includes("test.retry_seeded"));
    await waitFor(async () => {
      const snapshot = await readSnapshot(paths);
      return snapshot.session.tasks.some((task) => task.id === "task-failed");
    });
  }

  await seedRetryTask();

  await rpcRetryTask(paths, "task-failed");
  await waitFor(async () => pushedReasons.includes("task.retry_queued"));
  const afterRetry = await readSnapshot(paths);
  const retriedTask = afterRetry.session.tasks.find((task) => task.id === "task-failed");
  assert.equal(retriedTask?.status, "pending");
  assert.equal(retriedTask?.retryCount, 0);
  assert.equal(retriedTask?.lastFailureSummary, null);
  subscription.close();

  const approval = await createApprovalRequest(paths, {
    sessionId: "session-rpc",
    repoRoot,
    agent: "claude",
    hookEvent: "PreToolUse",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "npm run test"
      }
    }
  });

  await rpcResolveApproval(paths, {
    requestId: approval.id,
    decision: "allow",
    remember: false
  });

  const approvals = await listApprovalRequests(paths, { includeResolved: true });
  assert.equal(approvals.find((request) => request.id === approval.id)?.status, "approved");

  const events = await rpcRecentEvents(paths, 20);
  assert.equal(events.some((event) => event.type === "tasks.kickoff_enqueued"), true);
  assert.equal(events.some((event) => event.type === "approval.resolved"), true);

  await rpcShutdown(paths);
  await daemonPromise;

  const session = await loadSessionRecord(paths);
  assert.equal(session.status, "stopped");
  assert.equal(await pingRpc(paths), false);
});
