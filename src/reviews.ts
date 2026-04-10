import { randomUUID } from "node:crypto";
import { nowIso } from "./paths.ts";
import type {
  AgentName,
  ReviewAssignee,
  ReviewComment,
  ReviewDisposition,
  ReviewNote,
  ReviewStatus,
  SessionRecord
} from "./types.ts";

const MAX_REVIEW_NOTES = 200;

function trimBody(value: string): string {
  return value.trim();
}

function summarizeReviewNote(
  disposition: ReviewDisposition,
  filePath: string,
  hunkHeader: string | null,
  body: string
): string {
  const label = reviewDispositionSummaryLabel(disposition);
  const scope = hunkHeader ? `${filePath} ${hunkHeader}` : filePath;
  const firstLine = trimBody(body).split("\n")[0]?.trim() ?? "";
  return firstLine ? `${label} ${scope}: ${firstLine}` : `${label} ${scope}`;
}

export interface ReviewNoteFilters {
  agent?: AgentName | null;
  assignee?: ReviewAssignee | "unassigned" | null;
  disposition?: ReviewDisposition | null;
  status?: ReviewStatus | null;
}

function reviewDispositionSummaryLabel(disposition: ReviewDisposition): string {
  switch (disposition) {
    case "accepted_risk":
      return "Accepted Risk";
    case "wont_fix":
      return "Won't Fix";
    default:
      return disposition[0].toUpperCase() + disposition.slice(1);
  }
}

function createReviewComment(body: string): ReviewComment {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    body: trimBody(body),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function addReviewNote(
  session: SessionRecord,
  input: {
    agent: AgentName;
    assignee?: ReviewAssignee | null;
    taskId?: string | null;
    filePath: string;
    hunkIndex?: number | null;
    hunkHeader?: string | null;
    disposition: ReviewDisposition;
    body: string;
  }
): ReviewNote {
  const timestamp = nowIso();
  const note: ReviewNote = {
    id: randomUUID(),
    agent: input.agent,
    assignee: input.assignee ?? input.agent,
    taskId: input.taskId ?? null,
    filePath: input.filePath,
    hunkIndex: input.hunkIndex ?? null,
    hunkHeader: input.hunkHeader ?? null,
    disposition: input.disposition,
    status: "open",
    summary: summarizeReviewNote(
      input.disposition,
      input.filePath,
      input.hunkHeader ?? null,
      input.body
    ),
    body: trimBody(input.body),
    comments: [createReviewComment(input.body)],
    resolvedAt: null,
    landedAt: null,
    followUpTaskIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };

  session.reviewNotes = [...session.reviewNotes, note].slice(-MAX_REVIEW_NOTES);
  return note;
}

export function reviewNotesForTask(
  session: SessionRecord,
  taskId: string
): ReviewNote[] {
  return session.reviewNotes.filter((note) => note.taskId === taskId);
}

export function reviewNotesForPath(
  session: SessionRecord,
  agent: AgentName,
  filePath: string,
  hunkIndex?: number | null
): ReviewNote[] {
  return session.reviewNotes.filter((note) => {
    if (note.agent !== agent || note.filePath !== filePath) {
      return false;
    }

    if (hunkIndex === undefined) {
      return true;
    }

    return note.hunkIndex === hunkIndex;
  });
}

export function reviewNoteMatchesFilters(
  note: ReviewNote,
  filters: ReviewNoteFilters
): boolean {
  if (filters.agent && note.agent !== filters.agent) {
    return false;
  }

  if (filters.assignee) {
    if (filters.assignee === "unassigned") {
      if (note.assignee !== null) {
        return false;
      }
    } else if (note.assignee !== filters.assignee) {
      return false;
    }
  }

  if (filters.disposition && note.disposition !== filters.disposition) {
    return false;
  }

  if (filters.status && note.status !== filters.status) {
    return false;
  }

  return true;
}

export function filterReviewNotes(
  notes: ReviewNote[],
  filters: ReviewNoteFilters
): ReviewNote[] {
  return notes.filter((note) => reviewNoteMatchesFilters(note, filters));
}

export function updateReviewNote(
  session: SessionRecord,
  noteId: string,
  input: {
    body?: string;
    disposition?: ReviewDisposition;
    assignee?: ReviewAssignee | null;
  }
): ReviewNote | null {
  const note = session.reviewNotes.find((item) => item.id === noteId) ?? null;
  if (!note) {
    return null;
  }

  const nextBody = typeof input.body === "string" ? trimBody(input.body) : note.body;
  const nextDisposition = input.disposition ?? note.disposition;
  const nextAssignee = input.assignee === undefined ? note.assignee : input.assignee;
  note.body = nextBody;
  note.disposition = nextDisposition;
  note.assignee = nextAssignee;
  if (note.comments.length === 0) {
    note.comments.push(createReviewComment(nextBody));
  } else if (typeof input.body === "string") {
    note.comments[0] = {
      ...note.comments[0],
      body: nextBody,
      updatedAt: nowIso()
    };
  }
  note.summary = summarizeReviewNote(
    nextDisposition,
    note.filePath,
    note.hunkHeader,
    nextBody
  );
  note.updatedAt = nowIso();
  return note;
}

export function setReviewNoteStatus(
  session: SessionRecord,
  noteId: string,
  status: ReviewStatus
): ReviewNote | null {
  const note = session.reviewNotes.find((item) => item.id === noteId) ?? null;
  if (!note) {
    return null;
  }

  note.status = status;
  note.resolvedAt = status === "resolved" ? nowIso() : null;
  if (status === "open") {
    note.landedAt = null;
  }
  note.updatedAt = nowIso();
  return note;
}

export function linkReviewFollowUpTask(
  session: SessionRecord,
  noteId: string,
  taskId: string,
  assignee?: ReviewAssignee | null
): ReviewNote | null {
  const note = session.reviewNotes.find((item) => item.id === noteId) ?? null;
  if (!note) {
    return null;
  }

  note.followUpTaskIds = [...new Set([...note.followUpTaskIds, taskId])];
  if (assignee !== undefined) {
    note.assignee = assignee;
  }
  note.updatedAt = nowIso();
  return note;
}

export function addReviewReply(
  session: SessionRecord,
  noteId: string,
  body: string
): ReviewNote | null {
  const note = session.reviewNotes.find((item) => item.id === noteId) ?? null;
  if (!note) {
    return null;
  }

  note.comments.push(createReviewComment(body));
  note.status = "open";
  note.resolvedAt = null;
  note.landedAt = null;
  note.updatedAt = nowIso();
  return note;
}

export function cycleReviewAssignee(
  current: ReviewAssignee | null,
  noteAgent: AgentName
): ReviewAssignee | null {
  const sequence: Array<ReviewAssignee | null> = [
    noteAgent,
    noteAgent === "codex" ? "claude" : "codex",
    "operator",
    null
  ];
  const index = sequence.findIndex((item) => item === current);
  if (index === -1) {
    return noteAgent;
  }

  return sequence[(index + 1) % sequence.length] ?? null;
}

export function autoResolveReviewNotesForCompletedTask(
  session: SessionRecord,
  taskId: string
): ReviewNote[] {
  const resolved: ReviewNote[] = [];

  for (const note of session.reviewNotes) {
    if (note.status !== "open" || !note.followUpTaskIds.includes(taskId)) {
      continue;
    }

    note.status = "resolved";
    note.resolvedAt = nowIso();
    note.updatedAt = nowIso();
    resolved.push(note);
  }

  return resolved;
}

export function markReviewNotesLandedForTasks(
  session: SessionRecord,
  taskIds: string[]
): ReviewNote[] {
  if (taskIds.length === 0) {
    return [];
  }

  const landedTaskIds = new Set(taskIds);
  const landed: ReviewNote[] = [];

  for (const note of session.reviewNotes) {
    if (note.status !== "resolved" || note.landedAt !== null) {
      continue;
    }

    if (!note.followUpTaskIds.some((taskId) => landedTaskIds.has(taskId))) {
      continue;
    }

    note.landedAt = nowIso();
    note.updatedAt = nowIso();
    landed.push(note);
  }

  return landed;
}
