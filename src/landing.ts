import { listApprovalRequests } from "./approvals.ts";
import { captureLandingBrainEntry } from "./brain.ts";
import { captureLandingPatterns } from "./patterns.ts";
import {
  addDecisionRecord,
  releasePathClaims,
  upsertPathClaim
} from "./decision-ledger.ts";
import {
  findOverlappingWorktreePaths,
  getBranchCommit,
  landBranches,
  listWorktreeChangedPaths,
  resolveTargetBranch
} from "./git.ts";
import { buildSessionId } from "./paths.ts";
import { buildLandReport, saveLandReport } from "./reports.ts";
import { markLatestMissionLanded, syncMissionStates } from "./missions.ts";
import { markReviewNotesLandedForTasks } from "./reviews.ts";
import { buildAdHocTask } from "./router.ts";
import { loadSessionRecord, readRecentEvents, recordEvent, saveSessionRecord } from "./session.ts";
import { listTaskArtifacts, loadTaskArtifact, saveTaskArtifact } from "./task-artifacts.ts";
import { buildWorkflowSummary } from "./workflow.ts";
import type {
  AppPaths,
  KaviSnapshot,
  LandReportAgentChange,
  LandReportSnapshotCommit
} from "./types.ts";

export interface ExecuteLandResult {
  status: "blocked" | "landed";
  sessionId: string;
  targetBranch: string;
  preLandChanges: LandReportAgentChange[];
  overlappingPaths: string[];
  integrationTaskId: string | null;
  integrationBranch: string | null;
  integrationPath: string | null;
  validation:
    | {
        command: string;
        status: "ran" | "skipped" | "not_configured";
        detail: string;
      }
    | null;
  snapshotCommits: LandReportSnapshotCommit[];
  commandsRun: string[];
  landReportId: string | null;
  landedReviewThreads: number;
  openReviewThreadsRemaining: number;
}

async function buildPostLandSnapshot(paths: AppPaths): Promise<KaviSnapshot> {
  const session = await loadSessionRecord(paths);
  const approvals = await listApprovalRequests(paths, {
    includeResolved: true
  });
  const events = await readRecentEvents(paths, 60);
  const worktreeDiffs = await Promise.all(
    session.worktrees.map(async (worktree) => ({
      agent: worktree.agent,
      paths: await listWorktreeChangedPaths(worktree.path, session.baseCommit)
    }))
  );

  return {
    session,
    approvals,
    events,
    worktreeDiffs,
    latestLandReport: null
  };
}

export async function executeLand(paths: AppPaths): Promise<ExecuteLandResult> {
  const repoRoot = paths.repoRoot;
  const session = await loadSessionRecord(paths);
  const targetBranch = await resolveTargetBranch(repoRoot, session.config.baseBranch);
  const preLandChanges = await Promise.all(
    session.worktrees.map(async (worktree) => ({
      agent: worktree.agent,
      paths: await listWorktreeChangedPaths(worktree.path, session.baseCommit)
    }))
  );
  const overlappingPaths = await findOverlappingWorktreePaths(session.worktrees, session.baseCommit);

  if (overlappingPaths.length > 0) {
    let integrationTaskId: string | null = null;
    const existing = session.tasks.find(
      (task) =>
        task.status === "pending" &&
        task.title === "Resolve integration overlap"
    );

    if (!existing) {
      integrationTaskId = `integration-${Date.now()}`;
      session.tasks.push(
        buildAdHocTask(
          "codex",
          [
            "Resolve overlapping worktree changes before landing.",
            `Target branch: ${targetBranch}`,
            "Overlapping paths:",
            ...overlappingPaths.map((item) => `- ${item}`)
          ].join("\n"),
          integrationTaskId,
          {
            title: "Resolve integration overlap",
            routeReason:
              "Created by kavi land because multiple agents changed the same paths.",
            routeStrategy: "manual",
            routeConfidence: 1,
            routeMetadata: {
              source: "land-overlap",
              targetBranch
            },
            claimedPaths: overlappingPaths
          }
        )
      );
      upsertPathClaim(session, {
        taskId: integrationTaskId,
        agent: "codex",
        source: "integration",
        paths: overlappingPaths,
        note: "Integration overlap detected during landing."
      });
    } else {
      integrationTaskId = existing.id;
    }

    addDecisionRecord(session, {
      kind: "integration",
      agent: "codex",
      summary: "Landing blocked by overlapping worktree paths",
      detail: overlappingPaths.join(", "),
      metadata: {
        targetBranch,
        overlappingPaths
      }
    });
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "land.overlap_detected", {
      targetBranch,
      overlappingPaths
    });
    return {
      status: "blocked",
      sessionId: session.id,
      targetBranch,
      preLandChanges,
      overlappingPaths,
      integrationTaskId,
      integrationBranch: null,
      integrationPath: null,
      validation: null,
      snapshotCommits: [],
      commandsRun: [],
      landReportId: null,
      landedReviewThreads: 0,
      openReviewThreadsRemaining: session.reviewNotes.filter((note) => note.status === "open").length
    };
  }

  const result = await landBranches(
    repoRoot,
    targetBranch,
    session.worktrees,
    session.config.validationCommand,
    session.id,
    paths.integrationRoot
  );

  await recordEvent(paths, session.id, "land.completed", {
    targetBranch,
    integrationBranch: result.integrationBranch,
    integrationPath: result.integrationPath,
    snapshotCommits: result.snapshotCommits,
    commands: result.commandsRun
  });

  const releasedClaims = releasePathClaims(session, {
    note: `Released after landing into ${targetBranch}.`
  });
  session.baseCommit = await getBranchCommit(repoRoot, targetBranch);
  for (const claim of releasedClaims) {
    addDecisionRecord(session, {
      kind: "integration",
      agent: claim.agent,
      taskId: claim.taskId,
      summary: `Released path claim ${claim.id}`,
      detail: claim.paths.join(", ") || "No claimed paths.",
      metadata: {
        claimId: claim.id,
        targetBranch,
        releaseReason: "land.completed"
      }
    });
    await recordEvent(paths, session.id, "claim.released", {
      claimId: claim.id,
      taskId: claim.taskId,
      agent: claim.agent,
      paths: claim.paths,
      reason: "land.completed",
      targetBranch
    });
  }

  const landedReviewNotes = markReviewNotesLandedForTasks(
    session,
    session.tasks
      .filter((task) => task.status === "completed")
      .map((task) => task.id)
  );
  for (const note of landedReviewNotes) {
    addDecisionRecord(session, {
      kind: "review",
      agent: note.agent,
      taskId: note.taskId,
      summary: `Marked review note ${note.id} as landed`,
      detail: `Follow-up work for ${note.filePath} is now part of ${targetBranch}.`,
      metadata: {
        reviewNoteId: note.id,
        filePath: note.filePath,
        landedAt: note.landedAt,
        targetBranch
      }
    });
    await recordEvent(paths, session.id, "review.note_landed", {
      reviewNoteId: note.id,
      taskId: note.taskId,
      followUpTaskIds: note.followUpTaskIds,
      agent: note.agent,
      filePath: note.filePath,
      landedAt: note.landedAt,
      targetBranch
    });
  }

  await saveSessionRecord(paths, session);

  const artifactTaskIds = [
    ...new Set(
      landedReviewNotes.flatMap((note) => (note.taskId ? [note.taskId] : []))
    )
  ];
  for (const taskId of artifactTaskIds) {
    const artifact = await loadTaskArtifact(paths, taskId);
    if (!artifact) {
      continue;
    }

    artifact.reviewNotes = session.reviewNotes.filter((note) => note.taskId === taskId);
    await saveTaskArtifact(paths, artifact);
  }

  const artifacts = await listTaskArtifacts(paths);
  const postLandSnapshot = await buildPostLandSnapshot(paths);
  const postLandSummary = buildWorkflowSummary(postLandSnapshot, artifacts);
  const landReport = buildLandReport({
    id: buildSessionId(),
    sessionId: session.id,
    goal: session.goal,
    createdAt: new Date().toISOString(),
    targetBranch,
    integrationBranch: result.integrationBranch,
    integrationPath: result.integrationPath,
    validationCommand: session.config.validationCommand,
    validationStatus: result.validation.status,
    validationDetail: result.validation.detail,
    changedByAgent: preLandChanges,
    completedTasks: postLandSummary.completedTasks,
    snapshotCommits: result.snapshotCommits,
    commandsRun: result.commandsRun,
    reviewThreadsLanded: landedReviewNotes.length,
    openReviewThreadsRemaining: session.reviewNotes.filter((note) => note.status === "open").length
  });
  await saveLandReport(paths, landReport);
  markLatestMissionLanded(session, targetBranch);
  captureLandingBrainEntry(session, targetBranch, landReport.summary);
  await captureLandingPatterns(paths, session, landReport);
  syncMissionStates(session);
  await saveSessionRecord(paths, session);

  return {
    status: "landed",
    sessionId: session.id,
    targetBranch,
    preLandChanges,
    overlappingPaths: [],
    integrationTaskId: null,
    integrationBranch: result.integrationBranch,
    integrationPath: result.integrationPath,
    validation: result.validation,
    snapshotCommits: result.snapshotCommits,
    commandsRun: result.commandsRun,
    landReportId: landReport.id,
    landedReviewThreads: landedReviewNotes.length,
    openReviewThreadsRemaining: session.reviewNotes.filter((note) => note.status === "open").length
  };
}
