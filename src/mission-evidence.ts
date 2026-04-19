import { randomUUID } from "node:crypto";
import { latestMission } from "./missions.ts";
import { nowIso } from "./paths.ts";
import type {
  Mission,
  MissionDriftItem,
  MissionDriftItemCategory,
  MissionDriftReport,
  MissionPatchset,
  MissionPatchsetRoot,
  MissionReceipt,
  SessionRecord,
  TaskArtifact
} from "./types.ts";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").replaceAll(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function dominantRoot(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return filePath;
  }
  if (segments.length === 1) {
    return segments[0]!;
  }
  return `${segments[0]}/${segments[1]}`;
}

function buildDominantRoots(paths: string[]): MissionPatchsetRoot[] {
  const grouped = new Map<string, string[]>();
  for (const filePath of unique(paths)) {
    const root = dominantRoot(filePath);
    grouped.set(root, [...(grouped.get(root) ?? []), filePath]);
  }
  return [...grouped.entries()]
    .map(([root, rootPaths]) => ({
      root,
      count: rootPaths.length,
      paths: rootPaths.sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => right.count - left.count || left.root.localeCompare(right.root))
    .slice(0, 6);
}

function missionArtifacts(artifacts: TaskArtifact[], missionId: string): TaskArtifact[] {
  return artifacts.filter((artifact) => artifact.missionId === missionId);
}

function missionReceipts(session: SessionRecord, missionId: string): MissionReceipt[] {
  return (session.receipts ?? []).filter((receipt) => receipt.missionId === missionId);
}

function taskArtifactLookup(artifacts: TaskArtifact[]): Map<string, TaskArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.taskId, artifact] as const));
}

export function buildMissionPatchsets(
  session: SessionRecord,
  artifacts: TaskArtifact[],
  mission: Mission | null = latestMission(session)
): MissionPatchset[] {
  if (!mission) {
    return [];
  }

  const relevantArtifacts = missionArtifacts(artifacts, mission.id);
  const artifactByTaskId = taskArtifactLookup(relevantArtifacts);
  const receipts = missionReceipts(session, mission.id)
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (receipts.length > 0) {
    return receipts.map((receipt) => ({
      id: `patchset-${receipt.id}`,
      missionId: mission.id,
      receiptId: receipt.id,
      taskId: receipt.taskId,
      owner: receipt.owner,
      title: receipt.title,
      summary: receipt.summary,
      changedPaths: receipt.changedPaths,
      dominantRoots: buildDominantRoots(receipt.changedPaths),
      commands: receipt.commands,
      verificationEvidence: receipt.verificationEvidence,
      followUps: receipt.followUps,
      risks: receipt.risks,
      createdAt: receipt.createdAt
    }));
  }

  return relevantArtifacts
    .filter((artifact) => artifact.status === "completed" || artifact.status === "failed")
    .sort((left, right) => String(left.finishedAt ?? left.startedAt).localeCompare(String(right.finishedAt ?? right.startedAt)))
    .map((artifact) => ({
      id: `patchset-artifact-${artifact.taskId}`,
      missionId: mission.id,
      receiptId: null,
      taskId: artifact.taskId,
      owner: artifact.owner,
      title: artifact.title,
      summary: artifact.summary ?? artifact.error ?? "Task artifact patchset.",
      changedPaths: unique([...(artifact.claimedPaths ?? []), ...artifact.progress.flatMap((item) => item.paths)]),
      dominantRoots: buildDominantRoots(unique([...(artifact.claimedPaths ?? []), ...artifact.progress.flatMap((item) => item.paths)])),
      commands: [],
      verificationEvidence: [],
      followUps: unique([artifact.nextRecommendation ?? ""]),
      risks: unique([artifact.lastFailureSummary ?? ""]),
      createdAt: artifact.finishedAt ?? artifact.startedAt
    }));
}

interface CoverageMatch {
  score: number;
  tokenCoverage: number;
  evidence: string[];
  likelyTaskIds: string[];
}

function buildEvidenceCorpus(
  session: SessionRecord,
  artifacts: TaskArtifact[],
  mission: Mission
): Array<{
  taskId: string | null;
  text: string;
  evidence: string;
}> {
  const tasks = session.tasks.filter((task) => task.missionId === mission.id);
  const receipts = missionReceipts(session, mission.id);
  const relevantArtifacts = missionArtifacts(artifacts, mission.id);
  const receiptByTaskId = new Map(receipts.map((receipt) => [receipt.taskId, receipt] as const));
  const artifactByTaskId = new Map(relevantArtifacts.map((artifact) => [artifact.taskId, artifact] as const));
  const acceptanceChecks = mission.acceptance.checks;

  return [
    ...tasks
      .filter((task) => {
        if (task.status !== "failed") {
          return true;
        }
        const receipt = receiptByTaskId.get(task.id);
        const artifact = artifactByTaskId.get(task.id);
        return (
          (receipt?.changedPaths.length ?? 0) > 0 ||
          (artifact?.progress.some((entry) => entry.paths.length > 0) ?? false)
        );
      })
      .map((task) => ({
        taskId: task.id,
        text: [
          task.title,
          task.summary ?? "",
          task.prompt,
          task.claimedPaths.join(" "),
          task.routeReason ?? ""
        ].join(" "),
        evidence: `${task.owner}:${task.title}`
      })),
    ...receipts.map((receipt) => ({
      taskId: receipt.taskId,
      text: [
        receipt.title,
        receipt.summary,
        receipt.changedPaths.join(" "),
        receipt.commands.join(" "),
        receipt.verificationEvidence.join(" "),
        receipt.followUps.join(" "),
        receipt.risks.join(" ")
      ].join(" "),
      evidence: `${receipt.owner}:${receipt.title}`
    })),
    ...relevantArtifacts.map((artifact) => ({
      taskId: artifact.taskId,
      text: [
        artifact.title,
        artifact.summary ?? "",
        artifact.error ?? "",
        artifact.claimedPaths.join(" "),
        artifact.progress.map((item) => item.summary).join(" ")
      ].join(" "),
      evidence: `${artifact.owner}:${artifact.title}`
    })),
    ...acceptanceChecks.map((check) => ({
      taskId: null,
      text: [
        check.title,
        check.detail,
        check.path ?? "",
        check.target ?? "",
        check.urlPath ?? "",
        (check.expectedText ?? []).join(" "),
        (check.routeCandidates ?? []).join(" "),
        (check.selectorCandidates ?? []).join(" "),
        (check.evidencePaths ?? []).join(" ")
      ].join(" "),
      evidence: `${check.kind}:${check.title}`
    }))
  ];
}

function scoreCoverage(
  label: string,
  corpus: Array<{ taskId: string | null; text: string; evidence: string }>
): CoverageMatch {
  const labelTokens = tokenize(label);
  const normalizedLabel = normalizeText(label);
  let score = 0;
  let tokenCoverage = 0;
  const evidence: string[] = [];
  const likelyTaskIds: string[] = [];

  for (const item of corpus) {
    const normalized = normalizeText(item.text);
    let itemScore = 0;
    if (normalizedLabel && normalized.includes(normalizedLabel)) {
      itemScore += 5;
    }
    const itemTokens = new Set(tokenize(item.text));
    const tokenMatches = labelTokens.filter((token) => itemTokens.has(token)).length;
    itemScore += tokenMatches;
    if (itemScore > 0) {
      score = Math.max(score, itemScore);
      tokenCoverage = Math.max(
        tokenCoverage,
        labelTokens.length > 0 ? tokenMatches / labelTokens.length : 0
      );
      evidence.push(item.evidence);
      if (item.taskId) {
        likelyTaskIds.push(item.taskId);
      }
    }
  }

  return {
    score,
    tokenCoverage,
    evidence: unique(evidence).slice(0, 6),
    likelyTaskIds: unique(likelyTaskIds).slice(0, 6)
  };
}

function buildDriftItem(
  mission: Mission,
  category: MissionDriftItemCategory,
  title: string,
  detail: string,
  match: CoverageMatch
): MissionDriftItem {
  const status =
    match.score >= 5 || match.tokenCoverage >= 0.66 ? "covered" :
    match.score >= 2 || match.tokenCoverage >= 0.34 ? "partial" :
    "missing";
  return {
    id: `drift-${randomUUID()}`,
    missionId: mission.id,
    category,
    status,
    title,
    detail,
    evidence: match.evidence,
    likelyTaskIds: match.likelyTaskIds,
    suggestedAction:
      status === "covered"
        ? null
        : category === "docs"
          ? "Queue a docs-focused follow-up or verify docs coverage."
          : category === "service_boundary"
            ? "Add or route a backend/shared-contract slice that covers this service boundary."
            : category === "ui_surface"
              ? "Add or route a frontend refinement slice for this UI surface."
              : category === "journey"
                ? "Add scenario or browser verification coverage for this journey."
                : "Review mission coverage and queue a follow-up task if needed."
  };
}

function inferDescriptorCategory(
  preferredCategory: MissionDriftItemCategory,
  title: string
): MissionDriftItemCategory {
  const normalized = normalizeText(title);
  if (preferredCategory === "service_boundary") {
    if (
      normalized.includes("doc") ||
      normalized.includes("runbook") ||
      normalized.includes("quickstart") ||
      normalized.includes("guide")
    ) {
      return "docs";
    }
    if (normalized.includes("ui") || normalized.includes("dashboard") || normalized.includes("screen")) {
      return "ui_surface";
    }
  }
  return preferredCategory;
}

function acceptanceCoverageMatch(
  mission: Mission,
  category: MissionDriftItemCategory
): CoverageMatch | null {
  const passedChecks = mission.acceptance.checks.filter((check) => check.status === "passed");
  let relevantChecks = passedChecks.filter((check) => check.kind === "docs");
  if (category === "journey") {
    relevantChecks = passedChecks.filter((check) => check.kind === "scenario" || check.kind === "browser");
  } else if (category === "ui_surface") {
    relevantChecks = passedChecks.filter((check) => check.kind === "browser" || check.kind === "file");
  } else if (category === "service_boundary") {
    relevantChecks = passedChecks.filter(
      (check) => check.kind === "http" || check.kind === "contract" || check.kind === "command"
    );
  } else if (category === "deliverable") {
    relevantChecks = passedChecks;
  }

  if (relevantChecks.length === 0) {
    return null;
  }

  return {
    score: 5,
    tokenCoverage: 1,
    evidence: unique(
      relevantChecks.flatMap((check) => [
        `${check.kind}:${check.title}`,
        check.path ?? "",
        check.target ?? "",
        ...(check.evidencePaths ?? [])
      ])
    ).slice(0, 6),
    likelyTaskIds: []
  };
}

export function buildMissionDriftReport(
  session: SessionRecord,
  artifacts: TaskArtifact[],
  mission: Mission | null = latestMission(session)
): MissionDriftReport | null {
  if (!mission) {
    return null;
  }

  const corpus = buildEvidenceCorpus(session, artifacts, mission);
  const items: MissionDriftItem[] = [];
  const descriptors: Array<{ category: MissionDriftItemCategory; title: string; detail: string }> = [
    ...(mission.spec?.requestedDeliverables ?? []).map((item) => ({
      category: "deliverable" as const,
      title: item,
      detail: "Requested deliverable from mission spec."
    })),
    ...(mission.contract?.docsExpectations ?? []).map((item) => ({
      category: "docs" as const,
      title: item,
      detail: "Documentation expectation from mission contract."
    })),
    ...(mission.blueprint?.serviceBoundaries ?? []).map((item) => ({
      category: inferDescriptorCategory("service_boundary", item),
      title: item,
      detail: "Service boundary from mission blueprint."
    })),
    ...(mission.blueprint?.uiSurfaces ?? []).map((item) => ({
      category: "ui_surface" as const,
      title: item,
      detail: "UI surface from mission blueprint."
    })),
    ...(mission.blueprint?.acceptanceJourneys ?? []).map((item) => ({
      category: "journey" as const,
      title: item,
      detail: "Acceptance journey from mission blueprint."
    }))
  ];

  for (const descriptor of descriptors) {
    const inferredCategory = inferDescriptorCategory(descriptor.category, descriptor.title);
    const match = acceptanceCoverageMatch(mission, inferredCategory) ?? scoreCoverage(descriptor.title, corpus);
    items.push(buildDriftItem(mission, inferredCategory, descriptor.title, descriptor.detail, match));
  }

  const coveredCount = items.filter((item) => item.status === "covered").length;
  const partialCount = items.filter((item) => item.status === "partial").length;
  const missingCount = items.filter((item) => item.status === "missing").length;
  const total = Math.max(1, items.length);
  const coverageScore = Math.max(0, Math.round(((coveredCount + partialCount * 0.5) / total) * 100));
  const summary =
    items.length === 0
      ? "No mission spec or blueprint descriptors are available for drift analysis yet."
      : `Coverage ${coverageScore}% across ${items.length} spec/blueprint descriptors: ${coveredCount} covered, ${partialCount} partial, ${missingCount} missing.`;

  return {
    missionId: mission.id,
    generatedAt: nowIso(),
    coverageScore,
    coveredCount,
    partialCount,
    missingCount,
    summary,
    items
  };
}
