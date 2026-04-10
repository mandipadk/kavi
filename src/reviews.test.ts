import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  addReviewNote,
  addReviewReply,
  autoResolveReviewNotesForCompletedTask,
  cycleReviewAssignee,
  filterReviewNotes,
  linkReviewFollowUpTask,
  markReviewNotesLandedForTasks,
  reviewNoteMatchesFilters,
  reviewNotesForPath,
  reviewNotesForTask,
  setReviewNoteStatus,
  updateReviewNote
} from "./reviews.ts";
import type { SessionRecord } from "./types.ts";

function buildSession(): SessionRecord {
  return {
    id: "session-1",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: "Ship it",
    daemonPid: 1,
    daemonHeartbeatAt: "2026-03-24T00:00:01.000Z",
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/dist/main.js"
    },
    worktrees: [],
    tasks: [],
    peerMessages: [],
    decisions: [],
    pathClaims: [],
    reviewNotes: [],
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

test("addReviewNote persists task and hunk scoped review notes", () => {
  const session = buildSession();
  const note = addReviewNote(session, {
    agent: "codex",
    taskId: "task-1",
    filePath: "src/server.ts",
    hunkIndex: 1,
    hunkHeader: "@@ -10,2 +10,3 @@",
    disposition: "concern",
    body: "The error path still drops the original cause."
  });

  assert.equal(session.reviewNotes.length, 1);
  assert.equal(note.disposition, "concern");
  assert.equal(note.assignee, "codex");
  assert.equal(note.status, "open");
  assert.equal(note.resolvedAt, null);
  assert.equal(note.landedAt, null);
  assert.deepEqual(note.followUpTaskIds, []);
  assert.equal(note.comments.length, 1);
  assert.equal(note.comments[0]?.body, "The error path still drops the original cause.");
  assert.match(note.summary, /Concern src\/server\.ts/);
  assert.deepEqual(reviewNotesForTask(session, "task-1").map((item) => item.id), [note.id]);
  assert.deepEqual(
    reviewNotesForPath(session, "codex", "src/server.ts", 1).map((item) => item.id),
    [note.id]
  );
});

test("review notes can be edited, resolved, and linked to follow-up tasks", () => {
  const session = buildSession();
  const note = addReviewNote(session, {
    agent: "claude",
    taskId: "task-ui",
    filePath: "src/ui.tsx",
    disposition: "question",
    body: "Should this state stay local?"
  });

  updateReviewNote(session, note.id, {
    body: "Should this state stay local, or move into shared model state?",
    disposition: "accepted_risk",
    assignee: "operator"
  });
  setReviewNoteStatus(session, note.id, "resolved");
  linkReviewFollowUpTask(session, note.id, "task-review-1", "codex");

  const updated = session.reviewNotes[0];
  assert.equal(updated?.status, "resolved");
  assert.ok(updated?.resolvedAt);
  assert.equal(updated?.landedAt, null);
  assert.equal(updated?.disposition, "accepted_risk");
  assert.equal(updated?.assignee, "codex");
  assert.match(updated?.body ?? "", /shared model state/);
  assert.deepEqual(updated?.followUpTaskIds, ["task-review-1"]);
});

test("review notes support replies and automatic resolution from completed follow-up tasks", () => {
  const session = buildSession();
  const note = addReviewNote(session, {
    agent: "codex",
    taskId: "task-1",
    filePath: "src/server.ts",
    disposition: "concern",
    body: "Need to preserve the upstream error."
  });
  addReviewReply(session, note.id, "Also add a regression test for the failure path.");
  linkReviewFollowUpTask(session, note.id, "task-fix-1");

  const autoResolved = autoResolveReviewNotesForCompletedTask(session, "task-fix-1");
  assert.equal(autoResolved.length, 1);
  assert.equal(session.reviewNotes[0]?.status, "resolved");
  assert.equal(session.reviewNotes[0]?.landedAt, null);
  assert.equal(session.reviewNotes[0]?.comments.length, 2);
  assert.match(session.reviewNotes[0]?.comments[1]?.body ?? "", /regression test/);
});

test("replying to a resolved review note reopens the thread", () => {
  const session = buildSession();
  const note = addReviewNote(session, {
    agent: "codex",
    taskId: "task-1",
    filePath: "src/server.ts",
    disposition: "concern",
    body: "Need a stronger error path."
  });
  setReviewNoteStatus(session, note.id, "resolved");
  addReviewReply(session, note.id, "Still seeing a gap in the retry branch.");

  assert.equal(session.reviewNotes[0]?.status, "open");
  assert.equal(session.reviewNotes[0]?.resolvedAt, null);
  assert.equal(session.reviewNotes[0]?.landedAt, null);
  assert.equal(session.reviewNotes[0]?.comments.length, 2);
});

test("landed follow-up tasks mark resolved review notes as landed", () => {
  const session = buildSession();
  const note = addReviewNote(session, {
    agent: "claude",
    taskId: "task-ui",
    filePath: "src/ui.tsx",
    disposition: "question",
    body: "Does this final state match the intended layout?"
  });
  linkReviewFollowUpTask(session, note.id, "task-ui-fix");
  setReviewNoteStatus(session, note.id, "resolved");

  const landed = markReviewNotesLandedForTasks(session, ["task-ui-fix"]);
  assert.equal(landed.length, 1);
  assert.ok(session.reviewNotes[0]?.landedAt);

  addReviewReply(session, note.id, "Layout still drifts on narrow screens.");
  assert.equal(session.reviewNotes[0]?.landedAt, null);
});

test("review assignee cycles across both agents, operator, and unassigned", () => {
  assert.equal(cycleReviewAssignee("codex", "codex"), "claude");
  assert.equal(cycleReviewAssignee("claude", "codex"), "operator");
  assert.equal(cycleReviewAssignee("operator", "codex"), null);
  assert.equal(cycleReviewAssignee(null, "codex"), "codex");
});

test("review filter helpers match agent, assignee, disposition, and status", () => {
  const session = buildSession();
  const first = addReviewNote(session, {
    agent: "codex",
    taskId: "task-1",
    filePath: "src/server.ts",
    disposition: "concern",
    body: "Need a stronger retry path."
  });
  const second = addReviewNote(session, {
    agent: "claude",
    taskId: "task-2",
    filePath: "src/ui.tsx",
    disposition: "question",
    body: "Does this align with the layout intent?"
  });
  updateReviewNote(session, second.id, {
    assignee: "operator"
  });
  setReviewNoteStatus(session, second.id, "resolved");

  assert.equal(
    reviewNoteMatchesFilters(first, {
      agent: "codex",
      assignee: "codex",
      disposition: "concern",
      status: "open"
    }),
    true
  );
  assert.equal(
    reviewNoteMatchesFilters(second, {
      assignee: "operator",
      status: "resolved"
    }),
    true
  );
  assert.deepEqual(
    filterReviewNotes(session.reviewNotes, {
      assignee: "operator",
      status: "resolved"
    }).map((note) => note.id),
    [second.id]
  );
});
