import type { MissionNodeKind, RouteStrategy, TaskKind, TaskLease, TaskSpec } from "./types.ts";

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeTaskKind(value: unknown): TaskKind {
  return value === "kickoff" || value === "planner" || value === "integration"
    ? value
    : "execution";
}

function normalizeMissionNodeKind(value: unknown): MissionNodeKind | null {
  return value === "research" ||
    value === "scaffold" ||
    value === "backend" ||
    value === "frontend" ||
    value === "shared_contract" ||
    value === "infra" ||
    value === "tests" ||
    value === "docs" ||
    value === "review" ||
    value === "repair" ||
    value === "integration"
    ? value
    : null;
}

function normalizeRouteStrategy(value: unknown): RouteStrategy | null {
  return value === "manual" ||
    value === "keyword" ||
    value === "ai" ||
    value === "path-claim" ||
    value === "fallback"
    ? value
    : null;
}

function normalizeTaskStatus(value: unknown): TaskSpec["status"] {
  return value === "running" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "pending"
    ? value
    : "pending";
}

function normalizeRouteMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeTaskLease(value: unknown): TaskLease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const lease = value as Record<string, unknown>;
  if (lease.agent !== "codex" && lease.agent !== "claude") {
    return null;
  }

  return {
    id: normalizeString(lease.id, ""),
    agent: lease.agent,
    acquiredAt: normalizeString(lease.acquiredAt, ""),
    heartbeatAt: normalizeString(lease.heartbeatAt, ""),
    expiresAt: normalizeString(lease.expiresAt, "")
  };
}

export function normalizeTaskSpec(value: unknown): TaskSpec {
  const task =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const createdAt = normalizeString(task.createdAt, "");

  return {
    id: normalizeString(task.id, ""),
    missionId: normalizeNullableString(task.missionId),
    title: normalizeString(task.title, "Untitled task"),
    owner:
      task.owner === "claude" || task.owner === "router"
        ? task.owner
        : "codex",
    kind: normalizeTaskKind(task.kind),
    nodeKind: normalizeMissionNodeKind(task.nodeKind),
    status: normalizeTaskStatus(task.status),
    prompt: normalizeString(task.prompt, ""),
    dependsOnTaskIds: normalizeStringArray(task.dependsOnTaskIds),
    parentTaskId: normalizeNullableString(task.parentTaskId),
    planId: normalizeNullableString(task.planId),
    planNodeKey: normalizeNullableString(task.planNodeKey),
    retryCount:
      typeof task.retryCount === "number" && Number.isFinite(task.retryCount) && task.retryCount >= 0
        ? Math.floor(task.retryCount)
        : 0,
    maxRetries:
      typeof task.maxRetries === "number" && Number.isFinite(task.maxRetries) && task.maxRetries >= 0
        ? Math.floor(task.maxRetries)
        : 0,
    lastFailureSummary: normalizeNullableString(task.lastFailureSummary),
    lease: normalizeTaskLease(task.lease),
    createdAt,
    updatedAt: normalizeString(task.updatedAt, createdAt),
    summary: normalizeNullableString(task.summary),
    nextRecommendation: normalizeNullableString(task.nextRecommendation),
    routeReason: normalizeNullableString(task.routeReason),
    routeStrategy: normalizeRouteStrategy(task.routeStrategy),
    routeConfidence:
      typeof task.routeConfidence === "number" && Number.isFinite(task.routeConfidence)
        ? task.routeConfidence
        : null,
    routeMetadata: normalizeRouteMetadata(task.routeMetadata),
    claimedPaths: normalizeStringArray(task.claimedPaths)
  };
}

export function normalizeTaskSpecs(value: unknown): TaskSpec[] {
  return Array.isArray(value) ? value.map((task) => normalizeTaskSpec(task)) : [];
}
