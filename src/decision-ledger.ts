import path from "node:path";
import { randomUUID } from "node:crypto";
import { nowIso } from "./paths.ts";
import type {
  AgentName,
  ClaimHotspot,
  DecisionKind,
  DecisionRecord,
  PathClaim,
  SessionRecord
} from "./types.ts";

const MAX_DECISIONS = 80;

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
}

function normalizePath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  const withoutPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const normalized = path.posix.normalize(withoutPrefix);
  return normalized === "." ? "" : normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

function pathOverlaps(left: string, right: string): boolean {
  const leftPath = normalizePath(left);
  const rightPath = normalizePath(right);
  if (!leftPath || !rightPath) {
    return false;
  }

  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}/`) ||
    rightPath.startsWith(`${leftPath}/`)
  );
}

function overlapPath(left: string, right: string): string | null {
  const leftPath = normalizePath(left);
  const rightPath = normalizePath(right);
  if (!pathOverlaps(leftPath, rightPath)) {
    return null;
  }

  if (leftPath === rightPath) {
    return leftPath;
  }

  return leftPath.startsWith(`${rightPath}/`) ? leftPath : rightPath;
}

export function addDecisionRecord(
  session: SessionRecord,
  input: {
    kind: DecisionKind;
    agent: AgentName | "router" | null;
    taskId?: string | null;
    summary: string;
    detail: string;
    metadata?: Record<string, unknown>;
  }
): DecisionRecord {
  const record: DecisionRecord = {
    id: randomUUID(),
    kind: input.kind,
    agent: input.agent,
    taskId: input.taskId ?? null,
    summary: input.summary,
    detail: input.detail,
    createdAt: nowIso(),
    metadata: input.metadata ?? {}
  };

  session.decisions = [...session.decisions, record].slice(-MAX_DECISIONS);
  return record;
}

export function upsertPathClaim(
  session: SessionRecord,
  input: {
    taskId: string;
    agent: AgentName;
    source: PathClaim["source"];
    paths: string[];
    note?: string | null;
    status?: PathClaim["status"];
  }
): PathClaim | null {
  const normalizedPaths = normalizePaths(input.paths);
  const existing = session.pathClaims.find((claim) => claim.taskId === input.taskId);

  if (normalizedPaths.length === 0 && existing) {
    existing.paths = [];
    existing.status = "released";
    existing.note = input.note ?? existing.note;
    existing.updatedAt = nowIso();
    return existing;
  }

  if (normalizedPaths.length === 0) {
    return null;
  }

  if (existing) {
    existing.agent = input.agent;
    existing.source = input.source;
    existing.paths = normalizedPaths;
    existing.note = input.note ?? existing.note;
    existing.status = input.status ?? "active";
    existing.updatedAt = nowIso();
    return existing;
  }

  const timestamp = nowIso();
  const claim: PathClaim = {
    id: randomUUID(),
    taskId: input.taskId,
    agent: input.agent,
    source: input.source,
    status: input.status ?? "active",
    paths: normalizedPaths,
    note: input.note ?? null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  session.pathClaims.push(claim);
  return claim;
}

export function activePathClaims(session: SessionRecord): PathClaim[] {
  return session.pathClaims.filter((claim) => claim.status === "active" && claim.paths.length > 0);
}

export function releasePathClaims(
  session: SessionRecord,
  input: {
    taskIds?: string[];
    note?: string | null;
  } = {}
): PathClaim[] {
  const taskIds = input.taskIds ? new Set(input.taskIds) : null;
  const released: PathClaim[] = [];

  for (const claim of session.pathClaims) {
    if (claim.status !== "active") {
      continue;
    }

    if (taskIds && !taskIds.has(claim.taskId)) {
      continue;
    }

    claim.status = "released";
    claim.updatedAt = nowIso();
    if (input.note !== undefined) {
      claim.note = input.note;
    }
    released.push(claim);
  }

  return released;
}

export function releaseSupersededClaims(
  session: SessionRecord,
  input: {
    agent: AgentName;
    taskId: string;
    paths: string[];
    note?: string | null;
  }
): PathClaim[] {
  const normalizedPaths = normalizePaths(input.paths);
  if (normalizedPaths.length === 0) {
    return [];
  }

  const released: PathClaim[] = [];

  for (const claim of session.pathClaims) {
    if (
      claim.status !== "active" ||
      claim.agent !== input.agent ||
      claim.taskId === input.taskId
    ) {
      continue;
    }

    if (!claim.paths.some((item) => normalizedPaths.some((candidate) => pathOverlaps(item, candidate)))) {
      continue;
    }

    claim.status = "released";
    claim.updatedAt = nowIso();
    if (input.note !== undefined) {
      claim.note = input.note;
    }
    released.push(claim);
  }

  return released;
}

export function findClaimConflicts(
  session: SessionRecord,
  owner: AgentName,
  claimedPaths: string[]
): PathClaim[] {
  const normalizedPaths = normalizePaths(claimedPaths);
  if (normalizedPaths.length === 0) {
    return [];
  }

  return activePathClaims(session).filter(
    (claim) =>
      claim.agent !== owner &&
      claim.paths.some((item) => normalizedPaths.some((candidate) => pathOverlaps(item, candidate)))
  );
}

export function buildClaimHotspots(session: SessionRecord): ClaimHotspot[] {
  const hotspots = new Map<string, ClaimHotspot>();
  const claims = activePathClaims(session);

  for (let index = 0; index < claims.length; index += 1) {
    const left = claims[index];
    if (!left) {
      continue;
    }

    for (let inner = index + 1; inner < claims.length; inner += 1) {
      const right = claims[inner];
      if (!right || left.taskId === right.taskId) {
        continue;
      }

      const overlappingPaths = left.paths
        .flatMap((leftPath) =>
          right.paths
            .map((rightPath) => overlapPath(leftPath, rightPath))
            .filter((value): value is string => Boolean(value))
        );
      if (overlappingPaths.length === 0) {
        continue;
      }

      for (const hotspotPath of overlappingPaths) {
        const existing = hotspots.get(hotspotPath);
        if (existing) {
          existing.overlapCount += 1;
          existing.agents = [...new Set([...existing.agents, left.agent, right.agent])];
          existing.taskIds = [...new Set([...existing.taskIds, left.taskId, right.taskId])];
          existing.claimIds = [...new Set([...existing.claimIds, left.id, right.id])];
          continue;
        }

        hotspots.set(hotspotPath, {
          path: hotspotPath,
          agents: [...new Set([left.agent, right.agent])],
          taskIds: [...new Set([left.taskId, right.taskId])],
          claimIds: [...new Set([left.id, right.id])],
          overlapCount: 1
        });
      }
    }
  }

  return [...hotspots.values()].sort((left, right) => {
    const overlapDelta = right.overlapCount - left.overlapCount;
    if (overlapDelta !== 0) {
      return overlapDelta;
    }

    return left.path.localeCompare(right.path);
  });
}
