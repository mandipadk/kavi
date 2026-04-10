import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, readJson, writeJson } from "./fs.ts";
import type {
  AppPaths,
  LandReport,
  LandReportAgentChange,
  LandReportSnapshotCommit,
  LandReportTaskResult
} from "./types.ts";

function reportPath(paths: AppPaths, reportId: string): string {
  return path.join(paths.reportsDir, `${reportId}.json`);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeTaskResult(value: LandReportTaskResult): LandReportTaskResult {
  return {
    taskId: String(value.taskId),
    owner: value.owner === "codex" || value.owner === "claude" || value.owner === "router"
      ? value.owner
      : "router",
    title: typeof value.title === "string" ? value.title : "",
    summary: typeof value.summary === "string" ? value.summary : "",
    claimedPaths: asStringArray(value.claimedPaths),
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : ""
  };
}

function normalizeAgentChange(value: LandReportAgentChange): LandReportAgentChange {
  return {
    agent: value.agent === "claude" ? "claude" : "codex",
    paths: asStringArray(value.paths)
  };
}

function normalizeSnapshotCommit(value: LandReportSnapshotCommit): LandReportSnapshotCommit {
  return {
    agent: value.agent === "claude" ? "claude" : "codex",
    commit: typeof value.commit === "string" ? value.commit : "",
    createdCommit: value.createdCommit === true
  };
}

function normalizeLandReport(report: LandReport): LandReport {
  return {
    id: String(report.id),
    sessionId: String(report.sessionId),
    goal: typeof report.goal === "string" ? report.goal : null,
    createdAt: typeof report.createdAt === "string" ? report.createdAt : "",
    targetBranch: typeof report.targetBranch === "string" ? report.targetBranch : "",
    integrationBranch:
      typeof report.integrationBranch === "string" ? report.integrationBranch : "",
    integrationPath: typeof report.integrationPath === "string" ? report.integrationPath : "",
    validationCommand:
      typeof report.validationCommand === "string" ? report.validationCommand : "",
    validationStatus:
      report.validationStatus === "ran" ||
      report.validationStatus === "skipped" ||
      report.validationStatus === "not_configured"
        ? report.validationStatus
        : "not_configured",
    validationDetail:
      typeof report.validationDetail === "string" ? report.validationDetail : "",
    changedByAgent: Array.isArray(report.changedByAgent)
      ? report.changedByAgent.map((item) => normalizeAgentChange(item))
      : [],
    completedTasks: Array.isArray(report.completedTasks)
      ? report.completedTasks.map((item) => normalizeTaskResult(item))
      : [],
    snapshotCommits: Array.isArray(report.snapshotCommits)
      ? report.snapshotCommits.map((item) => normalizeSnapshotCommit(item))
      : [],
    commandsRun: asStringArray(report.commandsRun),
    reviewThreadsLanded:
      typeof report.reviewThreadsLanded === "number" ? report.reviewThreadsLanded : 0,
    openReviewThreadsRemaining:
      typeof report.openReviewThreadsRemaining === "number"
        ? report.openReviewThreadsRemaining
        : 0,
    summary: asStringArray(report.summary)
  };
}

export function buildLandReport(params: {
  id: string;
  sessionId: string;
  goal: string | null;
  createdAt: string;
  targetBranch: string;
  integrationBranch: string;
  integrationPath: string;
  validationCommand: string;
  validationStatus: LandReport["validationStatus"];
  validationDetail: string;
  changedByAgent: LandReportAgentChange[];
  completedTasks: LandReportTaskResult[];
  snapshotCommits: LandReportSnapshotCommit[];
  commandsRun: string[];
  reviewThreadsLanded: number;
  openReviewThreadsRemaining: number;
}): LandReport {
  const changedSummary = params.changedByAgent
    .map((changeSet) => `${changeSet.agent}: ${changeSet.paths.length} path(s)`)
    .join(" | ");
  const validation = params.validationCommand.trim()
    ? params.validationStatus === "ran"
      ? `Validation ran with "${params.validationCommand.trim()}".`
      : params.validationStatus === "skipped"
        ? params.validationDetail
        : "No validation command was configured."
    : "No validation command was configured.";

  return {
    id: params.id,
    sessionId: params.sessionId,
    goal: params.goal,
    createdAt: params.createdAt,
    targetBranch: params.targetBranch,
    integrationBranch: params.integrationBranch,
    integrationPath: params.integrationPath,
    validationCommand: params.validationCommand,
    validationStatus: params.validationStatus,
    validationDetail: params.validationDetail,
    changedByAgent: params.changedByAgent.map((item) => normalizeAgentChange(item)),
    completedTasks: params.completedTasks.map((item) => normalizeTaskResult(item)),
    snapshotCommits: params.snapshotCommits.map((item) => normalizeSnapshotCommit(item)),
    commandsRun: [...params.commandsRun],
    reviewThreadsLanded: params.reviewThreadsLanded,
    openReviewThreadsRemaining: params.openReviewThreadsRemaining,
    summary: [
      `Merged managed work into ${params.targetBranch}.`,
      changedSummary || "No worktree changes were recorded before landing.",
      validation,
      params.reviewThreadsLanded > 0
        ? `${params.reviewThreadsLanded} review thread(s) were marked as landed.`
        : "No review threads were marked as landed."
    ]
  };
}

export async function saveLandReport(paths: AppPaths, report: LandReport): Promise<void> {
  await ensureDir(paths.reportsDir);
  await writeJson(reportPath(paths, report.id), report);
}

export async function loadLandReport(
  paths: AppPaths,
  reportId: string
): Promise<LandReport | null> {
  const filePath = reportPath(paths, reportId);
  if (!(await fileExists(filePath))) {
    return null;
  }

  return normalizeLandReport(await readJson<LandReport>(filePath));
}

export async function listLandReports(paths: AppPaths): Promise<LandReport[]> {
  if (!(await fileExists(paths.reportsDir))) {
    return [];
  }

  const entries = await fs.readdir(paths.reportsDir, { withFileTypes: true });
  const reports: LandReport[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const report = await readJson<LandReport>(path.join(paths.reportsDir, entry.name));
    reports.push(normalizeLandReport(report));
  }

  return reports.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function loadLatestLandReport(paths: AppPaths): Promise<LandReport | null> {
  const reports = await listLandReports(paths);
  return reports[0] ?? null;
}
