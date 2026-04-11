import { randomUUID } from "node:crypto";
import { explainMissionAcceptanceFailures } from "./acceptance.ts";
import { buildClaimHotspots } from "./decision-ledger.ts";
import { latestMission, missionHasInFlightTasks } from "./missions.ts";
import { nowIso } from "./paths.ts";
import { buildOperatorRecommendations } from "./recommendations.ts";
import type {
  AgentContract,
  Mission,
  MissionAuditReport,
  MissionObjection,
  SessionRecord,
  TaskArtifact,
  TaskSpec
} from "./types.ts";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function missionTasks(session: SessionRecord, missionId: string): TaskSpec[] {
  return session.tasks.filter((task) => task.missionId === missionId);
}

function missionTaskIds(session: SessionRecord, missionId: string): Set<string> {
  return new Set(missionTasks(session, missionId).map((task) => task.id));
}

function missionContracts(session: SessionRecord, missionId: string): AgentContract[] {
  return (session.contracts ?? []).filter((contract) => contract.missionId === missionId);
}

function missionArtifacts(artifacts: TaskArtifact[], missionId: string): TaskArtifact[] {
  return artifacts.filter((artifact) => artifact.missionId === missionId);
}

function missionReceipts(session: SessionRecord, missionId: string) {
  return (session.receipts ?? []).filter((receipt) => receipt.missionId === missionId);
}

function recommendationBelongsToMission(
  recommendation: {
    taskIds: string[];
    metadata: Record<string, unknown>;
  },
  missionId: string,
  relevantTaskIds: Set<string>
): boolean {
  if (recommendation.taskIds.some((taskId) => relevantTaskIds.has(taskId))) {
    return true;
  }
  return recommendation.metadata.missionId === missionId;
}

function missionFollowUps(session: SessionRecord, missionId: string) {
  const relevantTaskIds = missionTaskIds(session, missionId);
  return buildOperatorRecommendations(session, {
    kind: "follow_up",
    includeDismissed: false
  }).filter((recommendation) =>
    recommendationBelongsToMission(recommendation, missionId, relevantTaskIds)
  );
}

function objectionPenalty(severity: MissionObjection["severity"]): number {
  switch (severity) {
    case "critical":
      return 22;
    case "major":
      return 12;
    case "minor":
      return 5;
  }
}

function buildObjection(
  missionId: string,
  seed: Omit<MissionObjection, "id" | "missionId">
): MissionObjection {
  return {
    id: `objection-${randomUUID()}`,
    missionId,
    ...seed
  };
}

export function buildMissionAuditReport(
  session: SessionRecord,
  mission: Mission | null = latestMission(session),
  artifacts: TaskArtifact[] = []
): MissionAuditReport | null {
  if (!mission) {
    return null;
  }

  const taskIds = missionTaskIds(session, mission.id);
  const tasks = missionTasks(session, mission.id);
  const receipts = missionReceipts(session, mission.id);
  const contracts = missionContracts(session, mission.id);
  const artifactsForMission = missionArtifacts(artifacts, mission.id);
  const followUps = missionFollowUps(session, mission.id);
  const overlaps = buildClaimHotspots(session)
    .filter((hotspot) => hotspot.taskIds.some((taskId) => taskIds.has(taskId)))
    .map((hotspot) => hotspot.path);
  const failureExplanations = explainMissionAcceptanceFailures(mission);
  const objections: MissionObjection[] = [];
  const approvals: string[] = [];

  if (mission.acceptance.status === "failed") {
    if (failureExplanations.length > 0) {
      for (const explanation of failureExplanations.slice(0, 4)) {
        objections.push(buildObjection(mission.id, {
          severity: "critical",
          kind: "acceptance",
          title: explanation.title,
          detail: explanation.summary,
          evidence: unique([
            ...explanation.evidence,
            ...explanation.repairFocus
          ]),
          likelyTaskIds: explanation.likelyTaskIds,
          suggestedAction: "kavi verify latest --explain"
        }));
      }
    } else {
      for (const pack of (mission.acceptance.failurePacks ?? []).slice(0, 4)) {
        objections.push(buildObjection(mission.id, {
          severity: "critical",
          kind: "acceptance",
          title: pack.title,
          detail: pack.summary,
          evidence: unique([...pack.evidence, ...pack.repairFocus]),
          likelyTaskIds: pack.likelyTaskIds,
          suggestedAction: "kavi verify latest --explain"
        }));
      }
    }
  }

  if (
    mission.acceptance.status === "pending" &&
    !missionHasInFlightTasks(session, mission.id)
  ) {
    objections.push(buildObjection(mission.id, {
      severity: "critical",
      kind: "verification",
      title: "Acceptance has not been verified",
      detail: "Implementation work appears to be idle, but the mission acceptance pack is still pending.",
      evidence: unique([
        ...mission.acceptance.criteria,
        ...mission.acceptance.checks.map((check) => `${check.kind}:${check.title}`)
      ]),
      likelyTaskIds: [],
      suggestedAction: "kavi verify latest"
    }));
  }

  const blockingContracts = contracts.filter(
    (contract) => contract.status === "open" && contract.dependencyImpact === "blocking"
  );
  for (const contract of blockingContracts) {
    objections.push(buildObjection(mission.id, {
      severity: "critical",
      kind: "contract",
      title: `Blocking contract is still open: ${contract.title}`,
      detail: contract.detail,
      evidence: unique([
        ...contract.requiredArtifacts,
        ...contract.acceptanceExpectations,
        ...contract.claimedPaths
      ]),
      likelyTaskIds: unique([contract.sourceTaskId, contract.resolvedByTaskId]),
      suggestedAction: `kavi contract-apply ${contract.id}`
    }));
  }

  const sidecarContracts = contracts.filter(
    (contract) => contract.status === "open" && contract.dependencyImpact === "sidecar"
  );
  for (const contract of sidecarContracts.slice(0, 4)) {
    objections.push(buildObjection(mission.id, {
      severity: "major",
      kind: "contract",
      title: `Sidecar contract still needs attention: ${contract.title}`,
      detail: contract.detail,
      evidence: unique([
        ...contract.requiredArtifacts,
        ...contract.claimedPaths
      ]),
      likelyTaskIds: unique([contract.sourceTaskId, contract.resolvedByTaskId]),
      suggestedAction: `kavi contract-apply ${contract.id}`
    }));
  }

  for (const recommendation of followUps.slice(0, 4)) {
    objections.push(buildObjection(mission.id, {
      severity: "major",
      kind: "follow_up",
      title: `Follow-up work is still waiting: ${recommendation.title}`,
      detail: recommendation.summary,
      evidence: unique(recommendation.openFollowUpTaskIds),
      likelyTaskIds: recommendation.taskIds,
      suggestedAction: `kavi recommend-apply ${recommendation.id}`
    }));
  }

  if (overlaps.length > 0) {
    objections.push(buildObjection(mission.id, {
      severity: "critical",
      kind: "overlap",
      title: "Worktree overlap still needs integration",
      detail: "Multiple mission tasks still claim overlapping paths, so the change surface is not safe to land.",
      evidence: overlaps,
      likelyTaskIds: tasks
        .filter((task) => task.claimedPaths.some((claim) => overlaps.some((path) => claim === path || claim.startsWith(`${path}/`) || path.startsWith(`${claim}/`))))
        .map((task) => task.id),
      suggestedAction: "kavi recommend"
    }));
  }

  const completedReceipts = receipts.filter((receipt) => receipt.outcome === "completed");
  if (completedReceipts.length === 0) {
    objections.push(buildObjection(mission.id, {
      severity: "major",
      kind: "receipt",
      title: "No completed mission receipts are available",
      detail: "The mission does not yet have a completed proof-of-work receipt tying changes to concrete task outcomes.",
      evidence: tasks.map((task) => `${task.owner}:${task.title}`),
      likelyTaskIds: tasks.map((task) => task.id),
      suggestedAction: "kavi receipts latest"
    }));
  }

  const completedVerificationEvidence = completedReceipts.flatMap((receipt) => receipt.verificationEvidence);
  if (
    mission.acceptance.status === "passed" &&
    completedReceipts.length > 0 &&
    completedVerificationEvidence.length === 0
  ) {
    objections.push(buildObjection(mission.id, {
      severity: "major",
      kind: "verification",
      title: "Acceptance passed without receipt-level verification evidence",
      detail: "Mission receipts do not currently capture any concrete verification signals, which weakens the audit trail.",
      evidence: completedReceipts.map((receipt) => receipt.title),
      likelyTaskIds: completedReceipts.map((receipt) => receipt.taskId),
      suggestedAction: "kavi verify --explain"
    }));
  }

  if (
    (mission.contract?.docsExpectations.length ?? 0) > 0 &&
    !mission.acceptance.checks.some(
      (check) => check.kind === "docs" && check.status === "passed"
    )
  ) {
    objections.push(buildObjection(mission.id, {
      severity: mission.acceptance.status === "passed" ? "major" : "minor",
      kind: "verification",
      title: "Documentation expectations are not yet proven",
      detail: "The mission contract asked for docs/runbook coverage, but no docs acceptance check has passed yet.",
      evidence: unique([
        ...(mission.contract?.docsExpectations ?? []),
        ...mission.acceptance.checks
          .filter((check) => check.kind === "docs")
          .map((check) => check.title)
      ]),
      likelyTaskIds: [],
      suggestedAction: "kavi accept latest"
    }));
  }

  const failedTasks = tasks.filter((task) => task.status === "failed");
  for (const task of failedTasks.slice(0, 3)) {
    objections.push(buildObjection(mission.id, {
      severity: "critical",
      kind: "receipt",
      title: `Task failed: ${task.title}`,
      detail: task.lastFailureSummary ?? "This task failed and still needs attention.",
      evidence: unique([
        ...task.claimedPaths,
        ...artifactsForMission
          .filter((artifact) => artifact.taskId === task.id)
          .flatMap((artifact) => [
            artifact.error ?? "",
            artifact.summary ?? ""
          ])
      ]),
      likelyTaskIds: [task.id],
      suggestedAction: `kavi retry ${task.id}`
    }));
  }

  const highRisks = (mission.risks ?? []).filter((risk) => risk.severity === "high");
  for (const risk of highRisks.slice(0, 2)) {
    objections.push(buildObjection(mission.id, {
      severity: "minor",
      kind: "risk",
      title: `High-severity mission risk remains: ${risk.title}`,
      detail: risk.detail,
      evidence: [risk.mitigation],
      likelyTaskIds: [],
      suggestedAction: null
    }));
  }

  if (mission.acceptance.status !== "passed") {
    const unresolvedHighSimulationIssues = (mission.simulation?.issues ?? []).filter(
      (issue) => issue.severity === "high"
    );
    for (const issue of unresolvedHighSimulationIssues.slice(0, 2)) {
      objections.push(buildObjection(mission.id, {
        severity: "minor",
        kind: "simulation",
        title: `Simulation warning: ${issue.title}`,
        detail: issue.detail,
        evidence: [],
        likelyTaskIds: [],
        suggestedAction: "kavi mission simulate latest"
      }));
    }
  }

  if (mission.acceptance.status === "passed") {
    approvals.push("Acceptance has passed for the current mission state.");
  }
  if (completedReceipts.length > 0) {
    approvals.push(`${completedReceipts.length} completed mission receipt(s) are available.`);
  }
  if (blockingContracts.length === 0) {
    approvals.push("No blocking agent contracts are open.");
  }
  if (followUps.length === 0) {
    approvals.push("No follow-up recommendations are waiting for operator review.");
  }
  if (overlaps.length === 0) {
    approvals.push("No overlapping mission path claims are currently visible.");
  }

  let score = 100;
  for (const objection of objections) {
    score = Math.max(0, score - objectionPenalty(objection.severity));
  }

  const verdict: MissionAuditReport["verdict"] =
    objections.some((objection) => objection.severity === "critical")
      ? "blocked"
      : objections.some((objection) => objection.severity === "major")
        ? "warn"
        : "approved";

  const summary =
    verdict === "approved"
      ? "Quality Court found no release-blocking objections for the active mission state."
      : verdict === "warn"
        ? "Quality Court found non-blocking objections that should be reviewed before shipping."
        : "Quality Court found release-blocking objections that should be resolved before shipping.";

  return {
    missionId: mission.id,
    verdict,
    score,
    summary,
    approvals: unique(approvals),
    objections,
    receiptsReviewed: receipts.length,
    checksReviewed: mission.acceptance.checks.length,
    contractsReviewed: contracts.length,
    generatedAt: nowIso()
  };
}

export function buildMissionObjections(
  session: SessionRecord,
  mission: Mission | null = latestMission(session),
  artifacts: TaskArtifact[] = []
): MissionObjection[] {
  return buildMissionAuditReport(session, mission, artifacts)?.objections ?? [];
}

export function auditBlocksShipping(report: MissionAuditReport | null): boolean {
  return report?.verdict === "blocked";
}
