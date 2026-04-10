import { buildClaimHotspots } from "./decision-ledger.ts";
import { findOwnershipRuleConflicts } from "./ownership.ts";
import { nowIso } from "./paths.ts";
import { previewRouteDecision } from "./router.ts";
import type {
  AgentName,
  OperatorRecommendation,
  PeerMessageIntent,
  RecommendationKind,
  RecommendationState,
  RecommendationStatus,
  SessionRecord
} from "./types.ts";

interface RecommendationDraft {
  id: string;
  kind: RecommendationKind;
  title: string;
  detail: string;
  targetAgent: AgentName | "operator" | null;
  filePath: string | null;
  taskIds: string[];
  reviewNoteIds: string[];
  commandHint: string;
  metadata: Record<string, unknown>;
}

export interface RecommendationQuery {
  includeDismissed?: boolean;
  kind?: RecommendationKind | "all";
  targetAgent?: AgentName | "operator" | "all";
  status?: RecommendationStatus | "all";
}

export interface RecommendationActionPlan {
  recommendation: OperatorRecommendation;
  owner: AgentName;
  prompt: string;
  routeReason: string;
  routeStrategy: "manual";
  routeConfidence: number;
  claimedPaths: string[];
  routeMetadata: Record<string, unknown>;
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function pathMatchesScope(scope: string, filePath: string): boolean {
  const normalizedScope = normalizePath(scope);
  const normalizedFile = normalizePath(filePath);
  return (
    normalizedScope === normalizedFile ||
    normalizedScope.startsWith(`${normalizedFile}/`) ||
    normalizedFile.startsWith(`${normalizedScope}/`)
  );
}

function otherAgent(agent: AgentName): AgentName {
  return agent === "codex" ? "claude" : "codex";
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function recommendationFingerprint(draft: RecommendationDraft): string {
  return stableSerialize({
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    detail: draft.detail,
    targetAgent: draft.targetAgent,
    filePath: draft.filePath,
    taskIds: [...draft.taskIds].sort(),
    reviewNoteIds: [...draft.reviewNoteIds].sort(),
    metadata: draft.metadata
  });
}

function recommendationPriority(kind: RecommendationKind): number {
  switch (kind) {
    case "follow_up":
      return 0;
    case "integration":
      return 1;
    case "handoff":
      return 2;
    case "ownership-config":
      return 3;
    default:
      return 4;
  }
}

function recommendationToneSort(left: OperatorRecommendation, right: OperatorRecommendation): number {
  const statusDelta =
    Number(left.status === "dismissed") - Number(right.status === "dismissed");
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const followUpDelta =
    Number(right.openFollowUpTaskIds.length > 0) - Number(left.openFollowUpTaskIds.length > 0);
  if (followUpDelta !== 0) {
    return followUpDelta;
  }

  const kindDelta = recommendationPriority(left.kind) - recommendationPriority(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  return left.title.localeCompare(right.title);
}

function recommendationStateFor(
  session: SessionRecord,
  draft: RecommendationDraft
): RecommendationState | null {
  return (session.recommendationStates ?? []).find((state) => state.id === draft.id) ?? null;
}

function recommendationOpenFollowUpTaskIds(
  session: SessionRecord,
  appliedTaskIds: string[]
): string[] {
  return appliedTaskIds.filter((taskId) =>
    session.tasks.some((task) =>
      task.id === taskId &&
      (task.status === "pending" || task.status === "running" || task.status === "blocked")
    )
  );
}

function hydrateRecommendation(
  session: SessionRecord,
  draft: RecommendationDraft
): OperatorRecommendation {
  const fingerprint = recommendationFingerprint(draft);
  const persisted = recommendationStateFor(session, draft);
  const dismissedStillMatches =
    persisted?.status === "dismissed" && persisted.fingerprint === fingerprint;
  const appliedTaskIds = persisted?.appliedTaskIds ?? [];
  const openFollowUpTaskIds = recommendationOpenFollowUpTaskIds(session, appliedTaskIds);
  const resolvedApplied =
    draft.kind === "follow_up" &&
    persisted?.fingerprint === fingerprint &&
    appliedTaskIds.length > 0 &&
    openFollowUpTaskIds.length === 0;
  const status: RecommendationStatus =
    dismissedStillMatches || resolvedApplied ? "dismissed" : "active";

  return {
    ...draft,
    fingerprint,
    status,
    dismissedReason:
      status === "dismissed"
        ? persisted?.dismissedReason ?? (resolvedApplied ? "applied" : null)
        : null,
    dismissedAt:
      status === "dismissed"
        ? persisted?.dismissedAt ?? (resolvedApplied ? persisted?.lastAppliedAt ?? null : null)
        : null,
    lastAppliedAt: persisted?.lastAppliedAt ?? null,
    appliedTaskIds,
    openFollowUpTaskIds
  };
}

function recommendationMatchesQuery(
  recommendation: OperatorRecommendation,
  query: RecommendationQuery
): boolean {
  const includeDismissed = query.includeDismissed ?? false;
  if (!includeDismissed && recommendation.status === "dismissed") {
    return false;
  }

  if (query.kind && query.kind !== "all" && recommendation.kind !== query.kind) {
    return false;
  }

  if (
    query.targetAgent &&
    query.targetAgent !== "all" &&
    recommendation.targetAgent !== query.targetAgent
  ) {
    return false;
  }

  if (query.status && query.status !== "all" && recommendation.status !== query.status) {
    return false;
  }

  return true;
}

function buildRecommendationDrafts(session: SessionRecord): RecommendationDraft[] {
  const recommendations: RecommendationDraft[] = [];
  const hotspots = buildClaimHotspots(session);
  const ownershipConflicts = findOwnershipRuleConflicts(session.config);
  const openReviewNotes = session.reviewNotes.filter((note) => note.status === "open");
  const taskById = new Map(session.tasks.map((task) => [task.id, task]));
  const actionablePeerTaskIds = new Set<string>();

  for (const message of session.peerMessages) {
    if (!isActionablePeerIntent(message.intent) || message.from === message.to) {
      continue;
    }

    const sourceTask = taskById.get(message.taskId) ?? null;
    if (sourceTask && sourceTask.status === "failed") {
      continue;
    }

    actionablePeerTaskIds.add(message.taskId);
    const filePath = sourceTask?.claimedPaths[0] ?? null;
    const detailLines = [
      `${message.from} asked ${message.to} to continue the next slice of work.`,
      `Intent: ${message.intent}.`,
      `Subject: ${message.subject}`,
      message.body
    ];
    recommendations.push({
      id: `follow-up:message:${message.id}`,
      kind: "follow_up",
      title: `Follow up ${message.to} work from ${message.from}`,
      detail: detailLines.join("\n"),
      targetAgent: message.to,
      filePath,
      taskIds: sourceTask ? [sourceTask.id] : [],
      reviewNoteIds: [],
      commandHint: `kavi recommend-apply follow-up:message:${message.id}`,
      metadata: {
        sourceType: "peer_message",
        missionId: sourceTask?.missionId ?? null,
        sourceTaskId: sourceTask?.id ?? null,
        sourceMessageId: message.id,
        sourceIntent: message.intent,
        sourceAgent: message.from,
        targetAgent: message.to,
        subject: message.subject,
        body: message.body,
        claimedPaths: sourceTask?.claimedPaths ?? []
      }
    });
  }

  for (const task of session.tasks) {
    const nextRecommendation = task.nextRecommendation?.trim();
    const plannerAlreadyMaterialized =
      task.kind === "planner" &&
      session.plans.some((plan) => plan.plannerTaskId === task.id || plan.sourceTaskId === task.id);
    if (
      !nextRecommendation ||
      actionablePeerTaskIds.has(task.id) ||
      task.status === "failed" ||
      plannerAlreadyMaterialized ||
      isOperatorOnlyRecommendation(nextRecommendation)
    ) {
      continue;
    }

    const route = previewRouteDecision(nextRecommendation, session.config, session);
    recommendations.push({
      id: `follow-up:task:${task.id}:next`,
      kind: "follow_up",
      title: `Continue follow-up from ${task.title}`,
      detail: nextRecommendation,
      targetAgent: route.owner,
      filePath: route.claimedPaths[0] ?? task.claimedPaths[0] ?? null,
      taskIds: [task.id],
      reviewNoteIds: [],
      commandHint: `kavi recommend-apply follow-up:task:${task.id}:next`,
      metadata: {
        sourceType: "next_recommendation",
        missionId: task.missionId ?? null,
        sourceTaskId: task.id,
        sourceAgent: task.owner,
        recommendedPrompt: nextRecommendation,
        routedOwner: route.owner,
        routedStrategy: route.strategy,
        routedConfidence: route.confidence,
        claimedPaths: route.claimedPaths.length > 0 ? route.claimedPaths : task.claimedPaths
      }
    });
  }

  for (const hotspot of hotspots) {
    const relatedNotes = openReviewNotes.filter((note) => pathMatchesScope(hotspot.path, note.filePath));
    recommendations.push({
      id: `integration:${hotspot.path}`,
      kind: "integration",
      title: `Coordinate overlapping work on ${hotspot.path}`,
      detail:
        relatedNotes.length > 0
          ? `Multiple agents are touching ${hotspot.path}, and ${relatedNotes.length} open review note(s) are still active there.`
          : `Multiple agents still claim overlapping work on ${hotspot.path}.`,
      targetAgent: "codex",
      filePath: hotspot.path,
      taskIds: hotspot.taskIds,
      reviewNoteIds: relatedNotes.map((note) => note.id),
      commandHint: `kavi recommend-apply integration:${hotspot.path}`,
      metadata: {
        hotspot
      }
    });
  }

  for (const note of openReviewNotes) {
    if (!note.assignee || note.assignee === "operator" || note.assignee === note.agent) {
      continue;
    }

    recommendations.push({
      id: `handoff:${note.id}:${note.assignee}`,
      kind: "handoff",
      title: `Hand off ${note.filePath} review work to ${note.assignee}`,
      detail: `Review note ${note.id} is assigned to ${note.assignee} even though it originated from ${note.agent}.`,
      targetAgent: note.assignee,
      filePath: note.filePath,
      taskIds: note.taskId ? [note.taskId] : [],
      reviewNoteIds: [note.id],
      commandHint: `kavi recommend-apply handoff:${note.id}:${note.assignee}`,
      metadata: {
        reviewNoteId: note.id,
        sourceAgent: note.agent,
        targetAgent: note.assignee
      }
    });
  }

  for (const hotspot of hotspots) {
    const hotspotAgents = new Set(hotspot.agents);
    for (const note of openReviewNotes) {
      if (!pathMatchesScope(hotspot.path, note.filePath)) {
        continue;
      }

      const targetAgent =
        note.assignee && note.assignee !== "operator"
          ? note.assignee
          : otherAgent(note.agent);
      if (hotspotAgents.has(targetAgent)) {
        recommendations.push({
          id: `handoff:${note.id}:${targetAgent}`,
          kind: "handoff",
          title: `Ask ${targetAgent} to address ${note.filePath}`,
          detail: `Active hotspot pressure on ${hotspot.path} overlaps review note ${note.id}.`,
          targetAgent,
          filePath: note.filePath,
          taskIds: note.taskId ? [note.taskId] : hotspot.taskIds,
          reviewNoteIds: [note.id],
          commandHint: `kavi recommend-apply handoff:${note.id}:${targetAgent}`,
          metadata: {
            hotspotPath: hotspot.path,
            reviewNoteId: note.id,
            sourceAgent: note.agent,
            targetAgent
          }
        });
      }
    }
  }

  for (const conflict of ownershipConflicts) {
    recommendations.push({
      id: `ownership:${conflict.leftPattern}:${conflict.rightPattern}`,
      kind: "ownership-config",
      title: "Resolve overlapping ownership rules",
      detail: conflict.detail,
      targetAgent: "operator",
      filePath: null,
      taskIds: [],
      reviewNoteIds: [],
      commandHint: "kavi doctor",
      metadata: {
        conflict
      }
    });
  }

  const deduped = new Map<string, RecommendationDraft>();
  for (const recommendation of recommendations) {
    if (!deduped.has(recommendation.id)) {
      deduped.set(recommendation.id, recommendation);
    }
  }

  return [...deduped.values()];
}

export function buildOperatorRecommendations(
  session: SessionRecord,
  query: RecommendationQuery = {}
): OperatorRecommendation[] {
  return buildRecommendationDrafts(session)
    .map((draft) => hydrateRecommendation(session, draft))
    .filter((recommendation) => recommendationMatchesQuery(recommendation, query))
    .sort(recommendationToneSort);
}

function isActionablePeerIntent(intent: PeerMessageIntent): boolean {
  return intent === "context_share" || intent === "handoff" || intent === "review_request";
}

function isOperatorOnlyRecommendation(detail: string): boolean {
  const normalized = detail.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    /\boptionally\b/.test(normalized) ||
    /\bonce reviewed\b/.test(normalized) ||
    /\breview the raw output\b/.test(normalized) ||
    /\breview the changed files\b/.test(normalized) ||
    /\bcommit\b/.test(normalized) ||
    /\bland\b/.test(normalized) ||
    /\bkavi\b/.test(normalized)
  );
}

function hasCompletedAppliedFollowUp(
  session: SessionRecord,
  recommendation: OperatorRecommendation
): boolean {
  return recommendation.appliedTaskIds.some((taskId) =>
    session.tasks.some((task) => task.id === taskId && task.status === "completed")
  );
}

export function activeFollowUpRecommendations(session: SessionRecord): OperatorRecommendation[] {
  return buildOperatorRecommendations(session).filter((recommendation) =>
    recommendation.kind === "follow_up" && !hasCompletedAppliedFollowUp(session, recommendation)
  );
}

export function findOperatorRecommendation(
  session: SessionRecord,
  recommendationId: string
): OperatorRecommendation | null {
  return buildOperatorRecommendations(session, {
    includeDismissed: true
  }).find((recommendation) => recommendation.id === recommendationId) ?? null;
}

function upsertRecommendationState(
  session: SessionRecord,
  nextState: RecommendationState
): RecommendationState {
  session.recommendationStates = [
    ...(session.recommendationStates ?? []).filter((state) => state.id !== nextState.id),
    nextState
  ].sort((left, right) => left.id.localeCompare(right.id));

  return nextState;
}

export function dismissOperatorRecommendation(
  session: SessionRecord,
  recommendationId: string,
  reason: string | null
): OperatorRecommendation {
  const recommendation = findOperatorRecommendation(session, recommendationId);
  if (!recommendation) {
    throw new Error(`Recommendation ${recommendationId} was not found.`);
  }

  const timestamp = nowIso();
  upsertRecommendationState(session, {
    id: recommendation.id,
    fingerprint: recommendation.fingerprint,
    status: "dismissed",
    dismissedReason: reason,
    dismissedAt: timestamp,
    lastAppliedAt: recommendation.lastAppliedAt,
    appliedTaskIds: recommendation.appliedTaskIds,
    updatedAt: timestamp
  });

  return findOperatorRecommendation(session, recommendationId) ?? recommendation;
}

export function restoreOperatorRecommendation(
  session: SessionRecord,
  recommendationId: string
): OperatorRecommendation {
  const recommendation = findOperatorRecommendation(session, recommendationId);
  if (!recommendation) {
    throw new Error(`Recommendation ${recommendationId} was not found.`);
  }

  const timestamp = nowIso();
  upsertRecommendationState(session, {
    id: recommendation.id,
    fingerprint: recommendation.fingerprint,
    status: "active",
    dismissedReason: null,
    dismissedAt: null,
    lastAppliedAt: recommendation.lastAppliedAt,
    appliedTaskIds: recommendation.appliedTaskIds,
    updatedAt: timestamp
  });

  return findOperatorRecommendation(session, recommendationId) ?? recommendation;
}

export function recordRecommendationApplied(
  session: SessionRecord,
  recommendationId: string,
  taskId: string
): OperatorRecommendation {
  const recommendation = findOperatorRecommendation(session, recommendationId);
  if (!recommendation) {
    throw new Error(`Recommendation ${recommendationId} was not found.`);
  }

  const timestamp = nowIso();
  const appliedTaskIds = recommendation.appliedTaskIds.includes(taskId)
    ? recommendation.appliedTaskIds
    : [...recommendation.appliedTaskIds, taskId];

  upsertRecommendationState(session, {
    id: recommendation.id,
    fingerprint: recommendation.fingerprint,
    status: "active",
    dismissedReason: null,
    dismissedAt: null,
    lastAppliedAt: timestamp,
    appliedTaskIds,
    updatedAt: timestamp
  });

  return findOperatorRecommendation(session, recommendationId) ?? recommendation;
}

export function buildRecommendationActionPlan(
  session: SessionRecord,
  recommendationId: string,
  options: {
    force?: boolean;
  } = {}
): RecommendationActionPlan {
  const recommendation = findOperatorRecommendation(session, recommendationId);
  if (!recommendation) {
    throw new Error(`Recommendation ${recommendationId} was not found.`);
  }

  if (recommendation.kind === "ownership-config") {
    throw new Error(
      `Recommendation ${recommendation.id} is advisory only. Run "${recommendation.commandHint}" and update the config manually.`
    );
  }

  if (recommendation.openFollowUpTaskIds.length > 0 && !options.force) {
    throw new Error(
      `Recommendation ${recommendation.id} already has open follow-up task(s): ${recommendation.openFollowUpTaskIds.join(", ")}. Re-run with --force to enqueue another task.`
    );
  }

  const owner =
    recommendation.targetAgent === "operator" || recommendation.targetAgent === null
      ? "codex"
      : recommendation.targetAgent;
  const sourceTask =
    recommendation.taskIds.length > 0
      ? session.tasks.find((task) => task.id === recommendation.taskIds[0]) ?? null
      : null;
  const prompt =
    recommendation.kind === "integration"
      ? [
          "Coordinate and resolve overlapping agent work before landing.",
          recommendation.detail,
          recommendation.filePath ? `Primary hotspot: ${recommendation.filePath}` : null
        ].filter(Boolean).join("\n")
      : recommendation.kind === "follow_up"
        ? [
            "Pick up follow-up work from Kavi.",
            sourceTask ? `Source task: ${sourceTask.title}` : null,
            sourceTask?.summary ? `Source summary: ${sourceTask.summary}` : null,
            typeof recommendation.metadata.subject === "string"
              ? `Message subject: ${recommendation.metadata.subject}`
              : null,
            typeof recommendation.metadata.body === "string"
              ? `Message body:\n${recommendation.metadata.body}`
              : null,
            typeof recommendation.metadata.recommendedPrompt === "string"
              ? `Recommended next slice:\n${recommendation.metadata.recommendedPrompt}`
              : null,
            recommendation.filePath ? `Focus path: ${recommendation.filePath}` : null,
            recommendation.detail
          ].filter(Boolean).join("\n")
        : [
            "Pick up ownership-aware handoff work from Kavi.",
            recommendation.detail,
            recommendation.filePath ? `Focus path: ${recommendation.filePath}` : null
          ].filter(Boolean).join("\n");
  const claimedPaths =
    recommendation.filePath
      ? [recommendation.filePath]
      : Array.isArray(recommendation.metadata.claimedPaths)
        ? recommendation.metadata.claimedPaths.map((item) => String(item))
        : [];

  return {
    recommendation,
    owner,
    prompt,
    routeReason: `Queued from Kavi recommendation ${recommendation.id}.`,
    routeStrategy: "manual",
    routeConfidence: 1,
    claimedPaths,
    routeMetadata: {
      recommendationId: recommendation.id,
      recommendationKind: recommendation.kind,
      sourceType:
        typeof recommendation.metadata.sourceType === "string"
          ? recommendation.metadata.sourceType
          : null,
      sourceTaskId:
        typeof recommendation.metadata.sourceTaskId === "string"
          ? recommendation.metadata.sourceTaskId
          : null,
      sourceMessageId:
        typeof recommendation.metadata.sourceMessageId === "string"
          ? recommendation.metadata.sourceMessageId
          : null,
      missionId:
        typeof recommendation.metadata.missionId === "string"
          ? recommendation.metadata.missionId
          : null
    }
  };
}
