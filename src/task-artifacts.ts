import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, readJson, writeJson } from "./fs.ts";
import type { AppPaths, TaskArtifact } from "./types.ts";

function artifactPath(paths: AppPaths, taskId: string): string {
  return path.join(paths.runsDir, `${taskId}.json`);
}

function normalizeArtifact(artifact: TaskArtifact): TaskArtifact {
  return {
    ...artifact,
    missionId: typeof artifact.missionId === "string" ? artifact.missionId : null,
    kind:
      artifact.kind === "kickoff" ||
      artifact.kind === "planner" ||
      artifact.kind === "integration"
        ? artifact.kind
        : "execution",
    nodeKind:
      artifact.nodeKind === "research" ||
      artifact.nodeKind === "scaffold" ||
      artifact.nodeKind === "backend" ||
      artifact.nodeKind === "frontend" ||
      artifact.nodeKind === "shared_contract" ||
      artifact.nodeKind === "infra" ||
      artifact.nodeKind === "tests" ||
      artifact.nodeKind === "docs" ||
      artifact.nodeKind === "review" ||
      artifact.nodeKind === "repair" ||
      artifact.nodeKind === "integration"
        ? artifact.nodeKind
        : null,
    dependsOnTaskIds: Array.isArray(artifact.dependsOnTaskIds)
      ? artifact.dependsOnTaskIds.map((item) => String(item))
      : [],
    parentTaskId: typeof artifact.parentTaskId === "string" ? artifact.parentTaskId : null,
    planId: typeof artifact.planId === "string" ? artifact.planId : null,
    planNodeKey: typeof artifact.planNodeKey === "string" ? artifact.planNodeKey : null,
    retryCount:
      typeof artifact.retryCount === "number" && Number.isFinite(artifact.retryCount) && artifact.retryCount >= 0
        ? Math.floor(artifact.retryCount)
        : 0,
    maxRetries:
      typeof artifact.maxRetries === "number" && Number.isFinite(artifact.maxRetries) && artifact.maxRetries >= 0
        ? Math.floor(artifact.maxRetries)
        : 0,
    lastFailureSummary:
      typeof artifact.lastFailureSummary === "string" ? artifact.lastFailureSummary : null,
    routeReason: typeof artifact.routeReason === "string" ? artifact.routeReason : null,
    nextRecommendation:
      typeof artifact.nextRecommendation === "string" ? artifact.nextRecommendation : null,
    routeStrategy:
      artifact.routeStrategy === "manual" ||
      artifact.routeStrategy === "keyword" ||
      artifact.routeStrategy === "ai" ||
      artifact.routeStrategy === "path-claim" ||
      artifact.routeStrategy === "fallback"
        ? artifact.routeStrategy
        : null,
    routeConfidence:
      typeof artifact.routeConfidence === "number" && Number.isFinite(artifact.routeConfidence)
        ? artifact.routeConfidence
        : null,
    routeMetadata:
      artifact.routeMetadata && typeof artifact.routeMetadata === "object" && !Array.isArray(artifact.routeMetadata)
        ? artifact.routeMetadata
        : {},
    claimedPaths: Array.isArray(artifact.claimedPaths)
      ? artifact.claimedPaths.map((item) => String(item))
      : [],
    decisionReplay: Array.isArray(artifact.decisionReplay)
      ? artifact.decisionReplay.map((item) => String(item))
      : [],
    reviewNotes: Array.isArray(artifact.reviewNotes)
      ? artifact.reviewNotes.map((note) => ({
        ...note,
          assignee:
            note.assignee === "codex" || note.assignee === "claude" || note.assignee === "operator"
              ? note.assignee
              : null,
          taskId: typeof note.taskId === "string" ? note.taskId : null,
          hunkIndex: typeof note.hunkIndex === "number" ? note.hunkIndex : null,
          hunkHeader: typeof note.hunkHeader === "string" ? note.hunkHeader : null,
          disposition:
            note.disposition === "approve" ||
            note.disposition === "concern" ||
            note.disposition === "question" ||
            note.disposition === "accepted_risk" ||
            note.disposition === "wont_fix"
              ? note.disposition
              : "note",
          status: note.status === "resolved" ? "resolved" : "open",
          summary: typeof note.summary === "string" ? note.summary : "",
          body: typeof note.body === "string" ? note.body : "",
          comments: Array.isArray(note.comments)
            ? note.comments.map((comment) => ({
                id: String(comment.id),
                body: typeof comment.body === "string" ? comment.body : "",
                createdAt: String(comment.createdAt),
                updatedAt: String(comment.updatedAt)
              }))
            : typeof note.body === "string" && note.body
              ? [{
                  id: `${note.id}-root`,
                  body: note.body,
                  createdAt: typeof note.createdAt === "string" ? note.createdAt : artifact.startedAt,
                  updatedAt:
                    typeof note.updatedAt === "string"
                      ? note.updatedAt
                      : artifact.finishedAt ?? artifact.startedAt
                }]
            : [],
          resolvedAt: typeof note.resolvedAt === "string" ? note.resolvedAt : null,
          landedAt: typeof note.landedAt === "string" ? note.landedAt : null,
          followUpTaskIds: Array.isArray(note.followUpTaskIds)
            ? note.followUpTaskIds.map((item) => String(item))
            : []
        }))
      : [],
    progress: Array.isArray(artifact.progress)
      ? artifact.progress.map((entry) => ({
          id: String(entry.id),
          kind:
            entry.kind === "heartbeat" || entry.kind === "stalled" || entry.kind === "provider"
              ? entry.kind
              : "change",
          summary: typeof entry.summary === "string" ? entry.summary : "",
          paths: Array.isArray(entry.paths) ? entry.paths.map((item) => String(item)) : [],
          createdAt: typeof entry.createdAt === "string" ? entry.createdAt : artifact.startedAt,
          provider:
            entry.provider === "codex" || entry.provider === "claude" || entry.provider === "node"
              ? entry.provider
              : null,
          eventName: typeof entry.eventName === "string" ? entry.eventName : null,
          semanticKind:
            entry.semanticKind === "planning" ||
            entry.semanticKind === "reasoning" ||
            entry.semanticKind === "inspection" ||
            entry.semanticKind === "scaffold" ||
            entry.semanticKind === "editing" ||
            entry.semanticKind === "command" ||
            entry.semanticKind === "verification" ||
            entry.semanticKind === "blocker" ||
            entry.semanticKind === "approval" ||
            entry.semanticKind === "handoff" ||
            entry.semanticKind === "contract" ||
            entry.semanticKind === "review" ||
            entry.semanticKind === "tool" ||
            entry.semanticKind === "session" ||
            entry.semanticKind === "notification" ||
            entry.semanticKind === "runtime" ||
            entry.semanticKind === "failure" ||
            entry.semanticKind === "completion" ||
            entry.semanticKind === "artifact"
              ? entry.semanticKind
              : null,
          source:
            entry.source === "notification" ||
            entry.source === "stderr" ||
            entry.source === "stdout" ||
            entry.source === "delta" ||
            entry.source === "hook" ||
            entry.source === "transcript" ||
            entry.source === "worktree"
              ? entry.source
              : null
        }))
      : [],
    attempts: Array.isArray(artifact.attempts)
      ? artifact.attempts.map((attempt, index) => ({
          id: String(attempt.id ?? `attempt-${index + 1}`),
          attempt:
            typeof attempt.attempt === "number" && Number.isFinite(attempt.attempt) && attempt.attempt > 0
              ? Math.floor(attempt.attempt)
              : index + 1,
          startedAt: typeof attempt.startedAt === "string" ? attempt.startedAt : artifact.startedAt,
          finishedAt: typeof attempt.finishedAt === "string" ? attempt.finishedAt : null,
          status:
            attempt.status === "completed" ||
            attempt.status === "failed" ||
            attempt.status === "blocked" ||
            attempt.status === "retrying"
              ? attempt.status
              : "running",
          summary: typeof attempt.summary === "string" ? attempt.summary : null
        }))
      : []
  };
}

export async function saveTaskArtifact(paths: AppPaths, artifact: TaskArtifact): Promise<void> {
  await ensureDir(paths.runsDir);
  await writeJson(artifactPath(paths, artifact.taskId), artifact);
}

export async function loadTaskArtifact(
  paths: AppPaths,
  taskId: string
): Promise<TaskArtifact | null> {
  const filePath = artifactPath(paths, taskId);
  if (!(await fileExists(filePath))) {
    return null;
  }

  return normalizeArtifact(await readJson<TaskArtifact>(filePath));
}

export async function listTaskArtifacts(paths: AppPaths): Promise<TaskArtifact[]> {
  if (!(await fileExists(paths.runsDir))) {
    return [];
  }

  const entries = await fs.readdir(paths.runsDir, { withFileTypes: true });
  const artifacts: TaskArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifact = await readJson<TaskArtifact>(path.join(paths.runsDir, entry.name));
    artifacts.push(normalizeArtifact(artifact));
  }

  return artifacts.sort((left, right) =>
    (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt)
  );
}
