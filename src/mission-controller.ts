import { explainMissionAcceptanceFailures } from "./acceptance.ts";
import { buildClaimHotspots } from "./decision-ledger.ts";
import { nowIso } from "./paths.ts";
import { latestMission } from "./missions.ts";
import { buildMissionAuditReport } from "./quality-court.ts";
import { buildOperatorRecommendations } from "./recommendations.ts";
import { buildMissionObservability, buildWorkflowSummary } from "./workflow.ts";
import type {
  AcceptanceFailurePack,
  AcceptanceRepairPlan,
  AgentContract,
  KaviSnapshot,
  Mission,
  MissionConfidence,
  MissionDigest,
  MissionMorningBrief,
  MissionReceipt,
  MissionRecoveryAction,
  MissionRecoveryPlan,
  SessionRecord,
  TaskArtifact,
  TaskSpec
} from "./types.ts";

function missionTasks(session: SessionRecord, missionId: string): TaskSpec[] {
  return session.tasks.filter((task) => task.missionId === missionId);
}

function missionTaskIds(session: SessionRecord, missionId: string): Set<string> {
  return new Set(missionTasks(session, missionId).map((task) => task.id));
}

function missionHotspots(session: SessionRecord, missionId: string): string[] {
  const taskIds = missionTaskIds(session, missionId);
  return buildClaimHotspots(session)
    .filter((hotspot) => hotspot.taskIds.some((taskId) => taskIds.has(taskId)))
    .map((hotspot) => hotspot.path);
}

function missionOpenContracts(session: SessionRecord, missionId: string): AgentContract[] {
  return (session.contracts ?? []).filter(
    (contract) => contract.missionId === missionId && contract.status === "open"
  );
}

function missionActiveRepairPlans(mission: Mission): AcceptanceRepairPlan[] {
  return (mission.acceptance.repairPlans ?? []).filter((plan) => plan.status !== "applied");
}

function missionFailurePacks(mission: Mission): AcceptanceFailurePack[] {
  return mission.acceptance.failurePacks ?? [];
}

function missionRecentReceipts(session: SessionRecord, missionId: string, limit = 5): MissionReceipt[] {
  return (session.receipts ?? [])
    .filter((receipt) => receipt.missionId === missionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

function recommendationBelongsToMission(
  recommendation: {
    taskIds: string[];
    metadata: Record<string, unknown>;
  },
  mission: Mission,
  missionTaskIdsForLookup: Set<string>
): boolean {
  if (recommendation.taskIds.some((taskId) => missionTaskIdsForLookup.has(taskId))) {
    return true;
  }

  return recommendation.metadata.missionId === mission.id;
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function missionFollowUpRecommendations(snapshot: KaviSnapshot, mission: Mission) {
  const taskIds = missionTaskIds(snapshot.session, mission.id);
  return buildOperatorRecommendations(snapshot.session, {
    kind: "follow_up",
    includeDismissed: false
  }).filter((recommendation) => recommendationBelongsToMission(recommendation, mission, taskIds));
}

function missionReviewCount(session: SessionRecord, missionId: string): number {
  const taskIds = missionTaskIds(session, missionId);
  return session.reviewNotes.filter(
    (note) => note.status === "open" && note.taskId && taskIds.has(note.taskId)
  ).length;
}

function scorePenalty(score: number, value: number): number {
  return Math.max(0, score - value);
}

export function buildMissionConfidence(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = [],
  mission: Mission | null = latestMission(snapshot.session)
): MissionConfidence | null {
  if (!mission) {
    return null;
  }

  const summary = buildWorkflowSummary(snapshot, artifacts);
  const observability = buildMissionObservability(snapshot, artifacts, mission);
  const blockingContracts = missionOpenContracts(snapshot.session, mission.id).filter(
    (contract) => contract.dependencyImpact === "blocking"
  );
  const followUps = missionFollowUpRecommendations(snapshot, mission);
  const hotspots = missionHotspots(snapshot.session, mission.id);
  const degradedProviders = (snapshot.session.providerCapabilities ?? []).filter(
    (manifest) => manifest.status === "degraded" || manifest.status === "unsupported"
  );
  const reviewCount = missionReviewCount(snapshot.session, mission.id);
  const failureExplanations = explainMissionAcceptanceFailures(mission);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const strengths: string[] = [];
  let score = mission.health?.score ?? 100;

  if (summary.approvalCounts.pending > 0) {
    blockers.push(`${summary.approvalCounts.pending} approval request(s) still need a decision.`);
    score = scorePenalty(score, Math.min(40, 10 + summary.approvalCounts.pending * 8));
  }

  if (degradedProviders.length > 0) {
    blockers.push(
      `Provider readiness is degraded for ${degradedProviders.map((manifest) => `${manifest.provider}:${manifest.status}`).join(", ")}.`
    );
    score = scorePenalty(score, Math.min(35, degradedProviders.length * 18));
  }

  if ((observability?.failedTasks ?? 0) > 0) {
    blockers.push(`${observability?.failedTasks ?? 0} task(s) failed in this mission.`);
    score = scorePenalty(score, Math.min(35, (observability?.failedTasks ?? 0) * 15));
  }

  if ((observability?.blockedTasks ?? 0) > 0) {
    blockers.push(`${observability?.blockedTasks ?? 0} task(s) are currently blocked.`);
    score = scorePenalty(score, Math.min(30, (observability?.blockedTasks ?? 0) * 12));
  }

  if ((observability?.stalledTasks ?? 0) > 0) {
    warnings.push(`${observability?.stalledTasks ?? 0} running task(s) appear stalled.`);
    score = scorePenalty(score, Math.min(18, (observability?.stalledTasks ?? 0) * 6));
  }

  if (blockingContracts.length > 0) {
    blockers.push(`${blockingContracts.length} blocking contract(s) are still open.`);
    score = scorePenalty(score, Math.min(24, blockingContracts.length * 10));
  }

  if (followUps.length > 0) {
    warnings.push(`${followUps.length} follow-up recommendation(s) still need operator review.`);
    score = scorePenalty(score, Math.min(20, followUps.length * 6));
  }

  if (hotspots.length > 0) {
    blockers.push(`Overlap hotspots still exist at ${hotspots.join(", ")}.`);
    score = scorePenalty(score, Math.min(25, hotspots.length * 12));
  }

  if (mission.acceptance.status === "failed") {
    blockers.push(
      failureExplanations[0]?.summary
        ? `Acceptance is failing: ${failureExplanations[0].summary}`
        : "Acceptance is currently failing."
    );
    score = scorePenalty(score, 28);
  } else if (
    mission.acceptance.status === "pending" &&
    (observability?.runningTasks ?? 0) === 0 &&
    (observability?.pendingTasks ?? 0) === 0
  ) {
    warnings.push("Acceptance has not been verified yet.");
    score = scorePenalty(score, 10);
  }

  if (reviewCount > 0) {
    warnings.push(`${reviewCount} review thread(s) remain open.`);
    score = scorePenalty(score, Math.min(12, reviewCount * 4));
  }

  if ((observability?.retriesUsed ?? 0) > 0) {
    warnings.push(`${observability?.retriesUsed ?? 0} retry attempt(s) have already been used.`);
    score = scorePenalty(score, Math.min(10, observability?.retriesUsed ?? 0));
  }

  if (mission.acceptance.status === "passed") {
    strengths.push("Acceptance has already passed for the active mission state.");
  }
  if ((observability?.completedTasks ?? 0) > 0) {
    strengths.push(`${observability?.completedTasks ?? 0} mission task(s) have already completed.`);
  }
  if ((mission.appliedPatternIds?.length ?? 0) > 0) {
    strengths.push(`${mission.appliedPatternIds?.length ?? 0} pattern(s) were applied to seed or strengthen the mission.`);
  }
  if ((missionRecentReceipts(snapshot.session, mission.id, 3).length) > 0) {
    strengths.push("Recent mission receipts are available for operator inspection.");
  }
  if ((observability?.nextReadyNodes.length ?? 0) > 1) {
    strengths.push("The graph still has parallel-ready work available.");
  }
  if ((mission.simulation?.verificationCoverage ?? "thin") === "strong") {
    strengths.push("Mission simulation sees strong runtime-backed verification coverage.");
  }
  if (blockers.length === 0 && warnings.length === 0) {
    strengths.push("No active blockers or warnings are currently visible.");
  }

  const canAutopilot =
    mission.autopilotEnabled &&
    mission.policy?.autonomyLevel !== "inspect" &&
    summary.approvalCounts.pending === 0 &&
    degradedProviders.length === 0 &&
    blockers.length === 0 &&
    (mission.simulation?.autopilotViable ?? true);

  const state =
    score >= 80 ? "high" : score >= 55 ? "medium" : "low";

  return {
    score,
    state,
    canAutopilot,
    blockers,
    warnings,
    strengths,
    updatedAt: nowIso()
  };
}

export function buildMissionRecoveryPlan(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = [],
  mission: Mission | null = latestMission(snapshot.session)
): MissionRecoveryPlan | null {
  if (!mission) {
    return null;
  }

  const summary = buildWorkflowSummary(snapshot, artifacts);
  const observability = buildMissionObservability(snapshot, artifacts, mission);
  const followUps = missionFollowUpRecommendations(snapshot, mission);
  const openContracts = missionOpenContracts(snapshot.session, mission.id);
  const blockingContracts = openContracts.filter((contract) => contract.dependencyImpact === "blocking");
  const hotspots = missionHotspots(snapshot.session, mission.id);
  const failureExplanations = explainMissionAcceptanceFailures(mission);
  const activeRepairPlans = missionActiveRepairPlans(mission);
  const failedOrBlockedTasks = missionTasks(snapshot.session, mission.id)
    .filter((task) => task.status === "failed" || task.status === "blocked")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const latestFailedTask = failedOrBlockedTasks[0] ?? null;
  const degradedProviders = (snapshot.session.providerCapabilities ?? []).filter(
    (manifest) => manifest.status === "degraded" || manifest.status === "unsupported"
  );

  const actions: MissionRecoveryAction[] = [];
  const blockers: string[] = [];

  if (summary.approvalCounts.pending > 0) {
    blockers.push(`${summary.approvalCounts.pending} approval request(s) are still pending.`);
    actions.push({
      id: `recover-approvals-${mission.id}`,
      kind: "resolve_approvals",
      title: "Resolve pending approvals",
      detail: "Approvals block all safe automatic recovery paths.",
      command: "kavi approvals",
      taskId: null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  for (const manifest of degradedProviders) {
    blockers.push(`Provider ${manifest.provider} is ${manifest.status}.`);
    actions.push({
      id: `recover-provider-${mission.id}-${manifest.provider}`,
      kind: "restore_provider",
      title: `Restore ${manifest.provider} readiness`,
      detail: manifest.errors[0] ?? manifest.warnings[0] ?? "Provider capability check requires attention.",
      command: "kavi doctor --json",
      taskId: null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  if (latestFailedTask) {
    actions.push({
      id: `recover-retry-${latestFailedTask.id}`,
      kind: "retry_task",
      title: `Retry ${latestFailedTask.title}`,
      detail:
        latestFailedTask.lastFailureSummary ??
        "Reset the latest failed or blocked task for another attempt.",
      command: `kavi retry ${latestFailedTask.id}`,
      taskId: latestFailedTask.id,
      safeToAutoApply: blockers.length === 0,
      recommended: blockers.length === 0
    });
  }

  if (hotspots.length > 0) {
    blockers.push(`Overlap hotspots still need resolution: ${hotspots.join(", ")}.`);
    actions.push({
      id: `recover-overlap-${mission.id}`,
      kind: "resolve_overlap",
      title: "Resolve overlap hotspots",
      detail: `Landing and verification are unsafe while overlapping claims exist at ${hotspots.join(", ")}.`,
      command: "kavi recommend",
      taskId: null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  if (blockingContracts.length > 0) {
    blockers.push(`${blockingContracts.length} blocking contract(s) remain open.`);
    actions.push({
      id: `recover-contracts-${mission.id}`,
      kind: "review_contracts",
      title: "Resolve blocking contracts",
      detail: "Open blocking contracts indicate missing cross-agent deliverables or handoff obligations.",
      command: "kavi contracts latest",
      taskId: null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  if (followUps.length > 0) {
    blockers.push(`${followUps.length} follow-up recommendation(s) still need review.`);
    actions.push({
      id: `recover-followups-${mission.id}`,
      kind: "review_follow_ups",
      title: "Review follow-up recommendations",
      detail: "Outstanding follow-ups still need operator approval, application, or dismissal.",
      command: "kavi recommend",
      taskId: null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  if (activeRepairPlans.length > 0 && mission.acceptance.status === "failed") {
    actions.push({
      id: `recover-repairs-${mission.id}`,
      kind: "review_repairs",
      title: "Review queued repair plans",
      detail:
        failureExplanations[0]?.summary ??
        "Acceptance failed and Kavi has repair work available or queued.",
      command: "kavi repair-plan latest",
      taskId: activeRepairPlans[0]?.queuedTaskId ?? null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  if (
    !mission.autopilotEnabled ||
    mission.policy?.autonomyLevel === "inspect"
  ) {
    actions.push({
      id: `recover-autopilot-${mission.id}`,
      kind: "resume_autopilot",
      title: "Resume guided autopilot",
      detail: "Re-enable guided autopilot so Kavi can continue safe execution and repair loops.",
      command: `kavi mission policy ${mission.id} --guided --autopilot on`,
      taskId: null,
      safeToAutoApply: blockers.length === 0,
      recommended: blockers.length === 0
    });
  }

  if (
    mission.acceptance.status === "pending" &&
    (observability?.runningTasks ?? 0) === 0 &&
    (observability?.pendingTasks ?? 0) === 0 &&
    hotspots.length === 0
  ) {
    actions.push({
      id: `recover-verify-${mission.id}`,
      kind: "run_verification",
      title: "Run mission verification",
      detail: "All runnable work is finished; run acceptance now to decide whether repair or landing is next.",
      command: `kavi verify ${mission.id}`,
      taskId: null,
      safeToAutoApply: blockers.length === 0,
      recommended: blockers.length === 0
    });
  }

  if (mission.shadowOfMissionId) {
    actions.push({
      id: `recover-shadow-${mission.id}`,
      kind: "select_shadow",
      title: "Compare and choose a shadow mission",
      detail: `This mission is a shadow of ${mission.shadowOfMissionId}; compare outcomes before committing to landing or more repairs.`,
      command: `kavi mission compare ${mission.shadowOfMissionId} ${mission.id}`,
      taskId: null,
      safeToAutoApply: false,
      recommended: summary.stage.id === "review_follow_ups" || summary.stage.id === "ready_to_land"
    });
  }

  if (failureExplanations.length > 0) {
    actions.push({
      id: `recover-inspect-${mission.id}`,
      kind: "inspect_failures",
      title: "Inspect acceptance failures",
      detail: failureExplanations[0].summary,
      command: "kavi accept latest",
      taskId: null,
      safeToAutoApply: false,
      recommended: true
    });
  }

  const status =
    actions.length === 0 ? "clear" : blockers.length > 0 ? "waiting" : "actionable";
  const summaryText =
    status === "clear"
      ? "Mission is healthy enough that no immediate recovery action is suggested."
      : status === "waiting"
        ? "Mission recovery is blocked on operator attention or provider readiness."
        : "Mission has safe recovery actions available now.";

  return {
    missionId: mission.id,
    generatedAt: nowIso(),
    status,
    summary: summaryText,
    blockers,
    actions
  };
}

export function buildMissionDigest(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = [],
  mission: Mission | null = latestMission(snapshot.session)
): MissionDigest | null {
  if (!mission) {
    return null;
  }

  const workflow = buildWorkflowSummary(snapshot, artifacts);
  const confidence = buildMissionConfidence(snapshot, artifacts, mission);
  const observability = buildMissionObservability(snapshot, artifacts, mission);
  const receipts = missionRecentReceipts(snapshot.session, mission.id);
  const contracts = missionOpenContracts(snapshot.session, mission.id);
  const repairPlans = missionActiveRepairPlans(mission);
  const failurePacks = missionFailurePacks(mission);
  const recoveryPlan = buildMissionRecoveryPlan(snapshot, artifacts, mission);
  const headline =
    mission.landedAt
      ? "Mission is landed."
      : mission.acceptance.status === "failed"
        ? "Mission failed acceptance and needs repair."
        : workflow.stage.id === "ready_to_land"
          ? "Mission is ready for final review and landing."
          : workflow.stage.id === "blocked"
            ? "Mission is blocked and needs recovery."
            : workflow.stage.detail;

  const summaryLines = [
    `Phase: ${mission.phase ?? "executing"} | status=${mission.status} | acceptance=${mission.acceptance.status}`,
    `Health: ${mission.health?.state ?? "-"} (${mission.health?.score ?? "-"}) | confidence=${confidence?.state ?? "-"} (${confidence?.score ?? "-"})`,
    observability
      ? `Tasks: ${observability.completedTasks}/${observability.totalTasks} completed | running=${observability.runningTasks} | pending=${observability.pendingTasks} | blocked=${observability.blockedTasks} | failed=${observability.failedTasks} | repairs=${observability.activeRepairTasks}`
      : "Tasks: -",
    observability
      ? `Changed paths=${observability.changedPaths} | active owners=${observability.activeOwners.join(", ") || "-"} | critical path=${observability.criticalPath.join(" -> ") || "-"}`
      : "Observability: -",
    receipts[0]
      ? `Latest receipt: ${receipts[0].owner} | ${receipts[0].title} | ${receipts[0].summary}`
      : "Latest receipt: -"
  ];

  return {
    missionId: mission.id,
    title: mission.title,
    phase: mission.phase ?? "executing",
    headline,
    confidence: confidence ?? {
      score: 0,
      state: "low",
      canAutopilot: false,
      blockers: ["Mission confidence could not be computed."],
      warnings: [],
      strengths: [],
      updatedAt: nowIso()
    },
    summary: summaryLines,
    blockers: confidence?.blockers ?? [],
    warnings: confidence?.warnings ?? [],
    nextActions: recoveryPlan?.actions.filter((action) => action.recommended).map((action) => action.title) ?? [],
    observability: observability
      ? {
          totalTasks: observability.totalTasks,
          completedTasks: observability.completedTasks,
          runningTasks: observability.runningTasks,
          pendingTasks: observability.pendingTasks,
          blockedTasks: observability.blockedTasks,
          failedTasks: observability.failedTasks,
          retriesUsed: observability.retriesUsed,
          activeRepairTasks: observability.activeRepairTasks,
          changedPaths: observability.changedPaths,
          activeOwners: observability.activeOwners,
          criticalPath: observability.criticalPath,
          nextReadyNodes: observability.nextReadyNodes
        }
      : null,
    recentReceipts: receipts,
    openContracts: contracts,
    activeRepairPlans: repairPlans,
    failurePacks,
    recoveryPlan: recoveryPlan ?? {
      missionId: mission.id,
      generatedAt: nowIso(),
      status: "clear",
      summary: "No recovery plan is needed.",
      blockers: [],
      actions: []
    },
    generatedAt: nowIso()
  };
}

export function buildMissionMorningBrief(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = [],
  mission: Mission | null = latestMission(snapshot.session),
  windowHours = 12
): MissionMorningBrief | null {
  if (!mission) {
    return null;
  }

  const since = isoHoursAgo(windowHours);
  const tasks = missionTasks(snapshot.session, mission.id);
  const recentCompletedTasks = tasks
    .filter((task) => task.status === "completed" && task.updatedAt >= since)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((task) => ({
      taskId: task.id,
      owner: task.owner,
      title: task.title,
      summary: task.summary ?? task.prompt,
      finishedAt: task.updatedAt
    }));
  const recentFailedTasks = tasks
    .filter((task) => task.status === "failed" && task.updatedAt >= since)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 6)
    .map((task) => ({
      taskId: task.id,
      owner: task.owner,
      title: task.title,
      summary: task.lastFailureSummary ?? task.summary ?? task.prompt,
      finishedAt: task.updatedAt
    }));
  const resolvedContracts = (snapshot.session.contracts ?? [])
    .filter((contract) => contract.missionId === mission.id && contract.status === "resolved")
    .filter((contract) => (contract.resolvedAt ?? contract.updatedAt) >= since)
    .sort((left, right) => (right.resolvedAt ?? right.updatedAt).localeCompare(left.resolvedAt ?? left.updatedAt))
    .slice(0, 8);
  const openContracts = missionOpenContracts(snapshot.session, mission.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
  const recentReceipts = missionRecentReceipts(snapshot.session, mission.id, 8)
    .filter((receipt) => receipt.createdAt >= since);
  const qualityCourt = buildMissionAuditReport(snapshot.session, mission, artifacts);
  const observability = buildMissionObservability(snapshot, artifacts, mission);
  const failureExplanations = explainMissionAcceptanceFailures(mission);
  const firstActions: string[] = [];

  if (qualityCourt?.verdict === "blocked") {
    firstActions.push("Run `kavi judge latest` and clear the release-blocking objections first.");
  }
  if (recentFailedTasks.length > 0) {
    firstActions.push(`Retry or reroute ${recentFailedTasks[0].taskId} after reviewing its failure output.`);
  }
  if (openContracts.length > 0) {
    firstActions.push("Review open contracts with `kavi contracts latest` and apply the next safe handoff.");
  }
  if (mission.acceptance.status === "pending" && (observability?.runningTasks ?? 0) === 0 && (observability?.pendingTasks ?? 0) === 0) {
    firstActions.push("Run `kavi verify latest` to execute the pending acceptance suite.");
  }
  if (failureExplanations.length > 0) {
    firstActions.push(`Inspect the top acceptance failure: ${failureExplanations[0].title}.`);
  }
  if (firstActions.length === 0 && qualityCourt?.verdict === "approved") {
    firstActions.push("Mission is green; review the latest result and land when ready.");
  }

  const headline =
    recentFailedTasks.length > 0
      ? `${recentFailedTasks.length} task(s) failed in the last ${windowHours}h and need attention.`
      : recentCompletedTasks.length > 0
        ? `${recentCompletedTasks.length} task(s) completed in the last ${windowHours}h.`
        : openContracts.length > 0
          ? `${openContracts.length} contract(s) remain open from the last ${windowHours}h.`
          : "No major mission activity was recorded in the selected overnight window.";

  const summary = [
    `acceptance=${mission.acceptance.status}`,
    `quality=${qualityCourt?.verdict ?? "unknown"}:${qualityCourt?.score ?? "-"}`,
    `completed=${recentCompletedTasks.length}`,
    `failed=${recentFailedTasks.length}`,
    `resolvedContracts=${resolvedContracts.length}`,
    `openContracts=${openContracts.length}`,
    `receipts=${recentReceipts.length}`
  ];

  return {
    missionId: mission.id,
    title: mission.title,
    generatedAt: nowIso(),
    windowHours,
    headline,
    summary,
    completedTasks: recentCompletedTasks,
    failedTasks: recentFailedTasks,
    resolvedContracts,
    openContracts,
    recentReceipts,
    qualityCourt,
    firstActions
  };
}
