import { randomUUID } from "node:crypto";
import { nowIso } from "./paths.ts";
import type { Mission, SessionRecord, TaskLease, TaskSpec } from "./types.ts";

const LEASE_DURATION_MS = 5 * 60 * 1000;

function addMs(iso: string, ms: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return nowIso();
  }
  return new Date(date.getTime() + ms).toISOString();
}

function lower(value: string | null | undefined): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function createTaskLease(agent: "codex" | "claude", at = nowIso()): TaskLease {
  return {
    id: `lease-${randomUUID()}`,
    agent,
    acquiredAt: at,
    heartbeatAt: at,
    expiresAt: addMs(at, LEASE_DURATION_MS)
  };
}

export function renewTaskLease(task: TaskSpec, at = nowIso()): void {
  if (task.owner !== "codex" && task.owner !== "claude") {
    return;
  }

  task.lease = task.lease
    ? {
        ...task.lease,
        heartbeatAt: at,
        expiresAt: addMs(at, LEASE_DURATION_MS)
      }
    : createTaskLease(task.owner, at);
}

export function releaseTaskLease(task: TaskSpec): void {
  task.lease = null;
}

export function isTaskLeaseExpired(task: TaskSpec, at = Date.now()): boolean {
  if (!task.lease?.expiresAt) {
    return task.status === "running";
  }

  const expiresAt = new Date(task.lease.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= at;
}

export function isTransientTaskFailure(failureSummary: string): boolean {
  const text = lower(failureSummary);
  if (!text) {
    return false;
  }

  if (
    text.includes("authentication") ||
    text.includes("re-authenticate") ||
    text.includes("unexpected argument") ||
    text.includes("unsupported") ||
    text.includes("schema") ||
    text.includes("permission denied") ||
    text.includes("not found")
  ) {
    return false;
  }

  return [
    "timed out",
    "timeout",
    "aborted",
    "interrupted",
    "rate limit",
    "429",
    "socket hang up",
    "connection reset",
    "connection refused",
    "temporarily unavailable",
    "exited before the turn completed",
    "econnreset",
    "econnrefused"
  ].some((needle) => text.includes(needle));
}

export function canAutoRetryTask(
  mission: Mission | null,
  task: TaskSpec,
  failureSummary: string,
  providerIssue: string | null
): boolean {
  if (providerIssue) {
    return false;
  }

  if (task.owner !== "codex" && task.owner !== "claude") {
    return false;
  }

  if ((mission?.policy?.autonomyLevel ?? "guided") === "inspect") {
    return false;
  }

  if (task.retryCount >= task.maxRetries) {
    return false;
  }

  return isTransientTaskFailure(failureSummary);
}

export function markTaskForRetry(task: TaskSpec, failureSummary: string, at = nowIso()): void {
  task.retryCount += 1;
  task.status = "pending";
  task.lastFailureSummary = failureSummary;
  task.summary = `Retry ${task.retryCount}/${task.maxRetries} queued after transient failure: ${failureSummary}`;
  task.updatedAt = at;
  releaseTaskLease(task);
}

export function markTaskForManualRetry(task: TaskSpec, at = nowIso()): void {
  task.status = "pending";
  task.retryCount = 0;
  task.lastFailureSummary = null;
  task.summary = "Operator queued a manual retry.";
  task.updatedAt = at;
  releaseTaskLease(task);
}

export function recoverExpiredTaskLeases(
  session: SessionRecord,
  activeAgents: ReadonlySet<"codex" | "claude">,
  at = Date.now()
): TaskSpec[] {
  const recovered: TaskSpec[] = [];
  for (const task of session.tasks) {
    if (task.status !== "running") {
      continue;
    }
    if (task.owner !== "codex" && task.owner !== "claude") {
      continue;
    }
    if (activeAgents.has(task.owner)) {
      continue;
    }
    if (!isTaskLeaseExpired(task, at)) {
      continue;
    }

    task.status = "pending";
    task.summary = task.lastFailureSummary
      ? `Recovered after stale lease. Previous failure: ${task.lastFailureSummary}`
      : "Recovered after stale lease.";
    task.updatedAt = nowIso();
    releaseTaskLease(task);
    recovered.push(task);
  }

  return recovered;
}
