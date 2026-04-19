import { randomUUID } from "node:crypto";
import { explainMissionAcceptanceFailures } from "./acceptance.ts";
import { buildClaimHotspots } from "./decision-ledger.ts";
import { buildMissionDriftReport } from "./mission-evidence.ts";
import { latestMission } from "./missions.ts";
import { nowIso } from "./paths.ts";
import { buildOperatorRecommendations } from "./recommendations.ts";
import type {
  AgentContract,
  Mission,
  MissionAuditReport,
  MissionObjection,
  QualityCourtRole,
  QualityCourtRoleReport,
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
  role: QualityCourtRole,
  seed: Omit<MissionObjection, "id" | "missionId" | "role">
): MissionObjection {
  return {
    id: `objection-${randomUUID()}`,
    missionId,
    role,
    ...seed
  };
}

interface MissionAuditContext {
  session: SessionRecord;
  mission: Mission;
  tasks: TaskSpec[];
  taskIds: Set<string>;
  receipts: ReturnType<typeof missionReceipts>;
  contracts: AgentContract[];
  artifacts: TaskArtifact[];
  followUps: ReturnType<typeof missionFollowUps>;
  overlaps: string[];
  failureExplanations: ReturnType<typeof explainMissionAcceptanceFailures>;
}

function buildRoleVerdict(objections: MissionObjection[]): QualityCourtRoleReport["verdict"] {
  return objections.some((objection) => objection.severity === "critical")
    ? "blocked"
    : objections.some((objection) => objection.severity === "major")
      ? "warn"
      : "approved";
}

function buildRoleScore(objections: MissionObjection[]): number {
  let score = 100;
  for (const objection of objections) {
    score = Math.max(0, score - objectionPenalty(objection.severity));
  }
  return score;
}

function buildRoleReport(
  role: QualityCourtRole,
  approvals: string[],
  objections: MissionObjection[]
): QualityCourtRoleReport {
  const verdict = buildRoleVerdict(objections);
  const roleLabel = role.replaceAll("_", " ");
  const summary =
    verdict === "approved"
      ? `${roleLabel} found no active objections.`
      : verdict === "warn"
        ? `${roleLabel} found objections worth reviewing before shipping.`
        : `${roleLabel} found release-blocking objections.`;
  return {
    role,
    verdict,
    score: buildRoleScore(objections),
    summary,
    approvals: unique(approvals),
    objections
  };
}

function buildAuditContext(
  session: SessionRecord,
  mission: Mission,
  artifacts: TaskArtifact[]
): MissionAuditContext {
  const taskIds = missionTaskIds(session, mission.id);
  const tasks = missionTasks(session, mission.id);
  return {
    session,
    mission,
    tasks,
    taskIds,
    receipts: missionReceipts(session, mission.id),
    contracts: missionContracts(session, mission.id),
    artifacts: missionArtifacts(artifacts, mission.id),
    followUps: missionFollowUps(session, mission.id),
    overlaps: buildClaimHotspots(session)
      .filter((hotspot) => hotspot.taskIds.some((taskId) => taskIds.has(taskId)))
      .map((hotspot) => hotspot.path),
    failureExplanations: explainMissionAcceptanceFailures(mission)
  };
}

function buildVerifierRole(context: MissionAuditContext): QualityCourtRoleReport {
  const { mission, receipts, failureExplanations } = context;
  const objections: MissionObjection[] = [];
  const approvals: string[] = [];

  if (mission.acceptance.status === "failed") {
    if (failureExplanations.length > 0) {
      for (const explanation of failureExplanations.slice(0, 4)) {
        objections.push(buildObjection(mission.id, "verifier", {
          severity: "critical",
          kind: "acceptance",
          title: explanation.title,
          detail: explanation.summary,
          evidence: unique([...explanation.evidence, ...explanation.repairFocus]),
          likelyTaskIds: explanation.likelyTaskIds,
          suggestedAction: "kavi verify latest --explain"
        }));
      }
    } else {
      for (const pack of (mission.acceptance.failurePacks ?? []).slice(0, 4)) {
        objections.push(buildObjection(mission.id, "verifier", {
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
    !context.tasks.some((task) => ["pending", "running", "blocked"].includes(task.status))
  ) {
    objections.push(buildObjection(mission.id, "verifier", {
      severity: "critical",
      kind: "verification",
      title: "Acceptance has not been verified",
      detail: "Implementation work appears idle, but the mission acceptance pack is still pending.",
      evidence: unique([
        ...mission.acceptance.criteria,
        ...mission.acceptance.checks.map((check) => `${check.kind}:${check.title}`)
      ]),
      likelyTaskIds: [],
      suggestedAction: "kavi verify latest"
    }));
  }

  const completedReceipts = receipts.filter((receipt) => receipt.outcome === "completed");
  const completedVerificationEvidence = completedReceipts.flatMap((receipt) => receipt.verificationEvidence);
  if (
    mission.acceptance.status === "passed" &&
    completedReceipts.length > 0 &&
    completedVerificationEvidence.length === 0
  ) {
    objections.push(buildObjection(mission.id, "verifier", {
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
    !mission.acceptance.checks.some((check) => check.kind === "docs" && check.status === "passed")
  ) {
    objections.push(buildObjection(mission.id, "verifier", {
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

  if (mission.acceptance.status === "passed") {
    approvals.push("Acceptance has passed for the current mission state.");
  }
  if (mission.acceptance.checks.some((check) => check.kind === "docs" && check.status === "passed")) {
    approvals.push("Documentation expectations are covered by a passing docs check.");
  }
  if (completedVerificationEvidence.length > 0) {
    approvals.push("Receipt-level verification evidence is present.");
  }

  return buildRoleReport("verifier", approvals, objections);
}

function buildContractAuditorRole(context: MissionAuditContext): QualityCourtRoleReport {
  const { mission, contracts, followUps } = context;
  const objections: MissionObjection[] = [];
  const approvals: string[] = [];

  const blockingContracts = contracts.filter(
    (contract) => contract.status === "open" && contract.dependencyImpact === "blocking"
  );
  for (const contract of blockingContracts) {
    objections.push(buildObjection(mission.id, "contract_auditor", {
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
    objections.push(buildObjection(mission.id, "contract_auditor", {
      severity: "major",
      kind: "contract",
      title: `Sidecar contract still needs attention: ${contract.title}`,
      detail: contract.detail,
      evidence: unique([...contract.requiredArtifacts, ...contract.claimedPaths]),
      likelyTaskIds: unique([contract.sourceTaskId, contract.resolvedByTaskId]),
      suggestedAction: `kavi contract-apply ${contract.id}`
    }));
  }

  for (const recommendation of followUps.slice(0, 4)) {
    objections.push(buildObjection(mission.id, "contract_auditor", {
      severity: "major",
      kind: "follow_up",
      title: `Follow-up work is still waiting: ${recommendation.title}`,
      detail: recommendation.summary,
      evidence: unique(recommendation.openFollowUpTaskIds),
      likelyTaskIds: recommendation.taskIds,
      suggestedAction: `kavi recommend-apply ${recommendation.id}`
    }));
  }

  if (blockingContracts.length === 0) {
    approvals.push("No blocking agent contracts are open.");
  }
  if (followUps.length === 0) {
    approvals.push("No follow-up recommendations are waiting for operator review.");
  }
  if (contracts.some((contract) => contract.status === "resolved")) {
    approvals.push("Previously opened agent contracts have been resolved.");
  }

  return buildRoleReport("contract_auditor", approvals, objections);
}

function buildIntegrationAuditorRole(context: MissionAuditContext): QualityCourtRoleReport {
  const { mission, tasks, receipts, artifacts, overlaps } = context;
  const objections: MissionObjection[] = [];
  const approvals: string[] = [];

  if (overlaps.length > 0) {
    objections.push(buildObjection(mission.id, "integration_auditor", {
      severity: "critical",
      kind: "overlap",
      title: "Worktree overlap still needs integration",
      detail: "Multiple mission tasks still claim overlapping paths, so the change surface is not safe to land.",
      evidence: overlaps,
      likelyTaskIds: tasks
        .filter((task) =>
          task.claimedPaths.some((claim) =>
            overlaps.some((item) => claim === item || claim.startsWith(`${item}/`) || item.startsWith(`${claim}/`))
          )
        )
        .map((task) => task.id),
      suggestedAction: "kavi recommend"
    }));
  }

  const completedReceipts = receipts.filter((receipt) => receipt.outcome === "completed");
  if (completedReceipts.length === 0) {
    objections.push(buildObjection(mission.id, "integration_auditor", {
      severity: "major",
      kind: "receipt",
      title: "No completed mission receipts are available",
      detail: "The mission does not yet have a completed proof-of-work receipt tying changes to concrete task outcomes.",
      evidence: tasks.map((task) => `${task.owner}:${task.title}`),
      likelyTaskIds: tasks.map((task) => task.id),
      suggestedAction: "kavi receipts latest"
    }));
  }

  const failedTasks = tasks.filter((task) => task.status === "failed");
  for (const task of failedTasks.slice(0, 3)) {
    objections.push(buildObjection(mission.id, "integration_auditor", {
      severity: "critical",
      kind: "receipt",
      title: `Task failed: ${task.title}`,
      detail: task.lastFailureSummary ?? "This task failed and still needs attention.",
      evidence: unique([
        ...task.claimedPaths,
        ...artifacts
          .filter((artifact) => artifact.taskId === task.id)
          .flatMap((artifact) => [artifact.error ?? "", artifact.summary ?? ""])
      ]),
      likelyTaskIds: [task.id],
      suggestedAction: `kavi retry ${task.id}`
    }));
  }

  if (overlaps.length === 0) {
    approvals.push("No overlapping mission path claims are currently visible.");
  }
  if (completedReceipts.length > 0) {
    approvals.push(`${completedReceipts.length} completed mission receipt(s) are available.`);
  }
  if (failedTasks.length === 0) {
    approvals.push("No failed mission tasks are waiting for integration recovery.");
  }

  return buildRoleReport("integration_auditor", approvals, objections);
}

function buildRiskAuditorRole(context: MissionAuditContext): QualityCourtRoleReport {
  const { mission } = context;
  const objections: MissionObjection[] = [];
  const approvals: string[] = [];
  const drift = buildMissionDriftReport(context.session, context.artifacts, mission);

  const highRisks = (mission.risks ?? []).filter((risk) => risk.severity === "high");
  for (const risk of highRisks.slice(0, 2)) {
    objections.push(buildObjection(mission.id, "risk_auditor", {
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
      objections.push(buildObjection(mission.id, "risk_auditor", {
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

  for (const item of drift?.items.filter((entry) => entry.status !== "covered").slice(0, 4) ?? []) {
    objections.push(buildObjection(mission.id, "risk_auditor", {
      severity: item.status === "missing" ? "major" : "minor",
      kind: "drift",
      title: `Mission coverage drift: ${item.title}`,
      detail: `${item.detail} Current coverage is ${item.status}.`,
      evidence: item.evidence,
      likelyTaskIds: item.likelyTaskIds,
      suggestedAction: item.suggestedAction
    }));
  }

  if (highRisks.length === 0) {
    approvals.push("No high-severity mission risks remain.");
  }
  if (((mission.simulation?.issues ?? []).filter((issue) => issue.severity === "high")).length === 0) {
    approvals.push("Mission simulation has no unresolved high-severity warnings.");
  }
  if ((drift?.missingCount ?? 0) === 0) {
    approvals.push("No mission spec or blueprint coverage gaps are currently missing evidence.");
  }

  return buildRoleReport("risk_auditor", approvals, objections);
}

export function buildQualityCourtRoleReports(
  session: SessionRecord,
  mission: Mission | null = latestMission(session),
  artifacts: TaskArtifact[] = []
): QualityCourtRoleReport[] {
  if (!mission) {
    return [];
  }

  const context = buildAuditContext(session, mission, artifacts);
  return [
    buildVerifierRole(context),
    buildContractAuditorRole(context),
    buildIntegrationAuditorRole(context),
    buildRiskAuditorRole(context)
  ];
}

export function buildMissionAuditReport(
  session: SessionRecord,
  mission: Mission | null = latestMission(session),
  artifacts: TaskArtifact[] = []
): MissionAuditReport | null {
  if (!mission) {
    return null;
  }

  const roleReports = buildQualityCourtRoleReports(session, mission, artifacts);
  const objections = roleReports.flatMap((report) => report.objections);
  const approvals = unique(roleReports.flatMap((report) => report.approvals));
  const verdict: MissionAuditReport["verdict"] =
    roleReports.some((report) => report.verdict === "blocked")
      ? "blocked"
      : roleReports.some((report) => report.verdict === "warn")
        ? "warn"
        : "approved";
  const score =
    roleReports.length === 0
      ? 100
      : Math.round(roleReports.reduce((sum, report) => sum + report.score, 0) / roleReports.length);
  const summary =
    verdict === "approved"
      ? "Quality Court found no release-blocking objections for the active mission state."
      : verdict === "warn"
        ? "Quality Court found non-blocking objections that should be reviewed before shipping."
        : "Quality Court found release-blocking objections that should be resolved before shipping.";
  const dominantRoles = unique(
    roleReports
      .filter((report) => report.verdict !== "approved")
      .sort((left, right) => {
        if (left.verdict !== right.verdict) {
          return left.verdict === "blocked" ? -1 : 1;
        }
        return left.score - right.score;
      })
      .map((report) => report.role)
  ) as QualityCourtRole[];
  const context = buildAuditContext(session, mission, artifacts);

  return {
    missionId: mission.id,
    verdict,
    score,
    summary,
    approvals,
    objections,
    roleReports,
    dominantRoles,
    receiptsReviewed: context.receipts.length,
    checksReviewed: mission.acceptance.checks.length,
    contractsReviewed: context.contracts.length,
    generatedAt: nowIso()
  };
}

export function buildMissionObjections(
  session: SessionRecord,
  mission: Mission | null = latestMission(session),
  artifacts: TaskArtifact[] = [],
  role?: QualityCourtRole | null
): MissionObjection[] {
  const objections = buildMissionAuditReport(session, mission, artifacts)?.objections ?? [];
  return role ? objections.filter((item) => item.role === role) : objections;
}

export function auditBlocksShipping(report: MissionAuditReport | null): boolean {
  return report?.verdict === "blocked";
}
