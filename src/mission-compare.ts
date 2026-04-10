import { buildMissionObservability } from "./workflow.ts";
import type { KaviSnapshot, Mission, TaskArtifact } from "./types.ts";

export interface MissionComparisonDimension {
  key:
    | "acceptance"
    | "health"
    | "progress"
    | "execution_risk"
    | "critical_path"
    | "pattern_reuse"
    | "risk_load"
    | "acceptance_failures"
    | "policy"
    | "blueprint_fit";
  label: string;
  leftValue: string;
  rightValue: string;
  preferred: "left" | "right" | "tie";
  weight: number;
  detail: string;
}

export interface MissionComparisonResult {
  leftMission: Mission;
  rightMission: Mission;
  leftObservability: ReturnType<typeof buildMissionObservability>;
  rightObservability: ReturnType<typeof buildMissionObservability>;
  leftScore: number;
  rightScore: number;
  scoreDelta: number;
  preferredMissionId: string | null;
  dimensions: MissionComparisonDimension[];
  changedPathOverlap: string[];
  leftOnlyPaths: string[];
  rightOnlyPaths: string[];
  leftAcceptanceFailures: string[];
  rightAcceptanceFailures: string[];
  recommendation: string;
}

export function relatedMissionFamily(snapshot: KaviSnapshot, mission: Mission): Mission[] {
  return snapshot.session.missions.filter((item) =>
    item.id === mission.id ||
    item.shadowOfMissionId === mission.id ||
    item.id === mission.shadowOfMissionId ||
    (mission.shadowOfMissionId && item.shadowOfMissionId === mission.shadowOfMissionId)
  );
}

function compareNumbers(
  left: number,
  right: number
): "left" | "right" | "tie" {
  if (left === right) {
    return "tie";
  }

  return left > right ? "left" : "right";
}

function acceptanceScore(mission: Mission): number {
  switch (mission.acceptance.status) {
    case "passed":
      return 2;
    case "pending":
      return 1;
    case "failed":
      return -1;
    default:
      return 0;
  }
}

function progressScore(
  observability: ReturnType<typeof buildMissionObservability>
): number {
  if (!observability) {
    return 0;
  }

  return (
    observability.completedTasks * 2 +
    observability.runningTasks -
    observability.failedTasks * 2 -
    observability.stalledTasks
  );
}

function executionRiskScore(
  observability: ReturnType<typeof buildMissionObservability>
): number {
  if (!observability) {
    return 0;
  }

  return -(
    observability.failedTasks * 2 +
    observability.stalledTasks +
    observability.activeRepairTasks +
    observability.retryingTasks
  );
}

function criticalPathScore(
  observability: ReturnType<typeof buildMissionObservability>
): number {
  if (!observability) {
    return 0;
  }

  return -observability.criticalPath.length;
}

function patternReuseScore(mission: Mission): number {
  return mission.appliedPatternIds?.length ?? 0;
}

function missionRiskLoad(mission: Mission): number {
  return (mission.risks ?? []).reduce((total, risk) => {
    switch (risk.severity) {
      case "high":
        return total + 3;
      case "medium":
        return total + 2;
      default:
        return total + 1;
    }
  }, 0);
}

function acceptanceFailureCount(mission: Mission): number {
  return mission.acceptance.checks.filter((check) => check.status === "failed").length;
}

function policyScore(mission: Mission): number {
  const policy = mission.policy;
  if (!policy) {
    return 0;
  }
  const autonomy =
    policy.autonomyLevel === "overnight"
      ? 4
      : policy.autonomyLevel === "autonomous"
        ? 3
        : policy.autonomyLevel === "guided"
          ? 2
          : 1;
  return (
    autonomy * 2 +
    (policy.autoVerify ? 2 : 0) +
    (policy.autoLand ? 2 : 0) +
    (policy.pauseOnRepairFailure ? 1 : 0)
  );
}

function blueprintFitScore(mission: Mission): number {
  const blueprint = mission.blueprint;
  if (!blueprint) {
    return 0;
  }
  return (
    blueprint.personas.length +
    blueprint.domainModel.length +
    blueprint.serviceBoundaries.length +
    blueprint.uiSurfaces.length +
    blueprint.acceptanceJourneys.length
  );
}

function describeAcceptance(mission: Mission): string {
  return `${mission.acceptance.status} (${mission.acceptance.checks.length} checks)`;
}

function summarizeAcceptanceFailures(mission: Mission): string[] {
  return mission.acceptance.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.title}${check.path ? ` [${check.path}]` : ""}`);
}

export function compareMissions(
  snapshot: KaviSnapshot,
  leftMission: Mission,
  rightMission: Mission,
  artifacts: TaskArtifact[] = []
): MissionComparisonResult {
  const leftObservability = buildMissionObservability(snapshot, artifacts, leftMission);
  const rightObservability = buildMissionObservability(snapshot, artifacts, rightMission);

  const dimensions: MissionComparisonDimension[] = [
    {
      key: "acceptance",
      label: "Acceptance posture",
      leftValue: describeAcceptance(leftMission),
      rightValue: describeAcceptance(rightMission),
      preferred: compareNumbers(acceptanceScore(leftMission), acceptanceScore(rightMission)),
      weight: 18,
      detail: "A passed acceptance pack is the strongest signal. Pending beats failed."
    },
    {
      key: "health",
      label: "Mission health",
      leftValue: `${leftMission.health?.state ?? "unknown"} (${leftMission.health?.score ?? 0})`,
      rightValue: `${rightMission.health?.state ?? "unknown"} (${rightMission.health?.score ?? 0})`,
      preferred: compareNumbers(leftMission.health?.score ?? 0, rightMission.health?.score ?? 0),
      weight: 12,
      detail: "Mission health blends execution posture, failures, and readiness."
    },
    {
      key: "progress",
      label: "Execution progress",
      leftValue: leftObservability
        ? `${leftObservability.completedTasks}/${leftObservability.totalTasks} done`
        : "0/0 done",
      rightValue: rightObservability
        ? `${rightObservability.completedTasks}/${rightObservability.totalTasks} done`
        : "0/0 done",
      preferred: compareNumbers(progressScore(leftObservability), progressScore(rightObservability)),
      weight: 10,
      detail: "Completed work with low failure pressure is favored."
    },
    {
      key: "execution_risk",
      label: "Execution risk",
      leftValue: leftObservability
        ? `failed=${leftObservability.failedTasks}, stalled=${leftObservability.stalledTasks}, repairs=${leftObservability.activeRepairTasks}`
        : "failed=0, stalled=0, repairs=0",
      rightValue: rightObservability
        ? `failed=${rightObservability.failedTasks}, stalled=${rightObservability.stalledTasks}, repairs=${rightObservability.activeRepairTasks}`
        : "failed=0, stalled=0, repairs=0",
      preferred: compareNumbers(executionRiskScore(leftObservability), executionRiskScore(rightObservability)),
      weight: 9,
      detail: "Fewer failed, stalled, retrying, and repair nodes means lower execution drag."
    },
    {
      key: "critical_path",
      label: "Critical path remaining",
      leftValue: `${leftObservability?.criticalPath.length ?? 0} step(s)`,
      rightValue: `${rightObservability?.criticalPath.length ?? 0} step(s)`,
      preferred: compareNumbers(criticalPathScore(leftObservability), criticalPathScore(rightObservability)),
      weight: 6,
      detail: "A shorter unfinished critical path is easier to land."
    },
    {
      key: "pattern_reuse",
      label: "Pattern reuse",
      leftValue: `${leftMission.appliedPatternIds?.length ?? 0} pattern(s)`,
      rightValue: `${rightMission.appliedPatternIds?.length ?? 0} pattern(s)`,
      preferred: compareNumbers(patternReuseScore(leftMission), patternReuseScore(rightMission)),
      weight: 4,
      detail: "More reused successful patterns can reduce delivery risk."
    },
    {
      key: "risk_load",
      label: "Mission risk load",
      leftValue: `${missionRiskLoad(leftMission)} weighted`,
      rightValue: `${missionRiskLoad(rightMission)} weighted`,
      preferred: compareNumbers(-missionRiskLoad(leftMission), -missionRiskLoad(rightMission)),
      weight: 5,
      detail: "Missions with fewer or lighter unresolved risks are preferred."
    },
    {
      key: "acceptance_failures",
      label: "Acceptance debt",
      leftValue: `${acceptanceFailureCount(leftMission)} failing check(s)`,
      rightValue: `${acceptanceFailureCount(rightMission)} failing check(s)`,
      preferred: compareNumbers(-acceptanceFailureCount(leftMission), -acceptanceFailureCount(rightMission)),
      weight: 8,
      detail: "Fewer failing acceptance checks reduce the repair burden before landing."
    },
    {
      key: "policy",
      label: "Mission policy strength",
      leftValue: `${leftMission.policy?.autonomyLevel ?? "-"} | verify=${leftMission.policy?.autoVerify ? "auto" : "manual"} | land=${leftMission.policy?.autoLand ? "auto" : "manual"}`,
      rightValue: `${rightMission.policy?.autonomyLevel ?? "-"} | verify=${rightMission.policy?.autoVerify ? "auto" : "manual"} | land=${rightMission.policy?.autoLand ? "auto" : "manual"}`,
      preferred: compareNumbers(policyScore(leftMission), policyScore(rightMission)),
      weight: 4,
      detail: "Richer autonomy and verification policy can make a mission easier to complete without operator babysitting."
    },
    {
      key: "blueprint_fit",
      label: "Blueprint completeness",
      leftValue: `${blueprintFitScore(leftMission)} signals`,
      rightValue: `${blueprintFitScore(rightMission)} signals`,
      preferred: compareNumbers(blueprintFitScore(leftMission), blueprintFitScore(rightMission)),
      weight: 5,
      detail: "Broader mission blueprint coverage usually means the product shape is better articulated."
    }
  ];

  let leftScore = 0;
  let rightScore = 0;
  for (const dimension of dimensions) {
    if (dimension.preferred === "left") {
      leftScore += dimension.weight;
    } else if (dimension.preferred === "right") {
      rightScore += dimension.weight;
    }
  }

  const preferredMissionId =
    leftScore === rightScore
      ? null
      : leftScore > rightScore
        ? leftMission.id
        : rightMission.id;
  const winningDimensions = dimensions
    .filter((dimension) =>
      preferredMissionId === leftMission.id
        ? dimension.preferred === "left"
        : preferredMissionId === rightMission.id
          ? dimension.preferred === "right"
          : false
    )
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 3)
    .map((dimension) => dimension.label);
  const recommendation =
    preferredMissionId === null
      ? "Both missions are roughly tied. Inspect acceptance details, changed surface quality, and operator preference before selecting one."
      : preferredMissionId === leftMission.id
        ? `Prefer ${leftMission.id} based on ${winningDimensions.join(", ") || "current acceptance and execution posture"}.`
        : `Prefer ${rightMission.id} based on ${winningDimensions.join(", ") || "current acceptance and execution posture"}.`;
  const leftPaths = new Set(leftObservability?.changedPathList ?? []);
  const rightPaths = new Set(rightObservability?.changedPathList ?? []);
  const changedPathOverlap = [...leftPaths].filter((filePath) => rightPaths.has(filePath)).sort((a, b) => a.localeCompare(b));
  const leftOnlyPaths = [...leftPaths].filter((filePath) => !rightPaths.has(filePath)).sort((a, b) => a.localeCompare(b));
  const rightOnlyPaths = [...rightPaths].filter((filePath) => !leftPaths.has(filePath)).sort((a, b) => a.localeCompare(b));
  const leftAcceptanceFailures = summarizeAcceptanceFailures(leftMission);
  const rightAcceptanceFailures = summarizeAcceptanceFailures(rightMission);

  return {
    leftMission,
    rightMission,
    leftObservability,
    rightObservability,
    leftScore,
    rightScore,
    scoreDelta: Math.abs(leftScore - rightScore),
    preferredMissionId,
    dimensions,
    changedPathOverlap,
    leftOnlyPaths,
    rightOnlyPaths,
    leftAcceptanceFailures,
    rightAcceptanceFailures,
    recommendation
  };
}

export function compareMissionFamily(
  snapshot: KaviSnapshot,
  mission: Mission,
  artifacts: TaskArtifact[] = []
): MissionComparisonResult[] {
  return relatedMissionFamily(snapshot, mission)
    .filter((candidate) => candidate.id !== mission.id)
    .map((candidate) => compareMissions(snapshot, mission, candidate, artifacts))
    .sort((left, right) => {
      const leftAdvantage = left.rightScore - left.leftScore;
      const rightAdvantage = right.rightScore - right.leftScore;
      return (
        rightAdvantage - leftAdvantage ||
        right.rightScore - left.rightScore ||
        right.scoreDelta - left.scoreDelta ||
        left.rightMission.title.localeCompare(right.rightMission.title)
      );
    });
}
