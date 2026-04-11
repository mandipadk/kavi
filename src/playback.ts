import { buildMissionPostmortem } from "./mission-control.ts";
import { latestMission } from "./missions.ts";
import { buildMissionAuditReport } from "./quality-court.ts";
import type { LandReport, MissionPlaybackFrame, SessionRecord, TaskArtifact } from "./types.ts";

export type MissionPlaybackPhase =
  | "all"
  | "spec"
  | "execution"
  | "repair"
  | "contracts"
  | "acceptance"
  | "landing"
  | "audit";

function frameSort(left: MissionPlaybackFrame, right: MissionPlaybackFrame): number {
  return String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")) || left.title.localeCompare(right.title);
}

function isRepairFrame(frame: MissionPlaybackFrame): boolean {
  const haystack = `${frame.title} ${frame.detail}`.toLowerCase();
  return /\brepair\b|\bfix\b|\bdebug\b/.test(haystack);
}

export function filterMissionPlayback(
  frames: MissionPlaybackFrame[],
  phase: MissionPlaybackPhase
): MissionPlaybackFrame[] {
  if (phase === "all") {
    return frames;
  }

  return frames.filter((frame) => {
    if (phase === "contracts") {
      return frame.kind === "contract";
    }
    if (phase === "acceptance") {
      return frame.kind === "acceptance";
    }
    if (phase === "landing") {
      return frame.kind === "landing";
    }
    if (phase === "audit") {
      return frame.title.startsWith("Quality Court:") || frame.title.startsWith("Postmortem:");
    }
    if (phase === "repair") {
      return isRepairFrame(frame);
    }
    if (phase === "spec") {
      return (
        frame.title.startsWith("Mission created:") ||
        frame.title === "Mission created" ||
        /planning|plan materialized|spec/i.test(frame.title) ||
        /planning|plan materialized|spec/i.test(frame.detail)
      );
    }
    if (phase === "execution") {
      return (
        frame.kind === "task" ||
        frame.kind === "attempt" ||
        frame.kind === "progress" ||
        frame.kind === "receipt" ||
        (frame.kind === "checkpoint" && !isRepairFrame(frame))
      );
    }
    return true;
  });
}

export function buildMissionPlayback(
  session: SessionRecord,
  artifacts: TaskArtifact[],
  missionId: string | null,
  latestLandReport: LandReport | null = null
): MissionPlaybackFrame[] {
  const mission =
    (missionId ? session.missions.find((item) => item.id === missionId) ?? null : latestMission(session)) ?? null;
  if (!mission) {
    return [];
  }

  const missionArtifacts = artifacts.filter((artifact) => artifact.missionId === mission.id);
  const missionReceipts = (session.receipts ?? []).filter((receipt) => receipt.missionId === mission.id);
  const missionContracts = (session.contracts ?? []).filter((contract) => contract.missionId === mission.id);
  const audit = buildMissionAuditReport(session, mission, artifacts);
  const frames: MissionPlaybackFrame[] = [
    {
      id: `playback-mission-${mission.id}`,
      timestamp: mission.createdAt,
      kind: "mission",
      title: `Mission created: ${mission.title}`,
      detail: mission.summary,
      taskId: mission.rootTaskId ?? mission.planningTaskId ?? null
    }
  ];

  for (const checkpoint of mission.checkpoints) {
    frames.push({
      id: `playback-checkpoint-${checkpoint.id}`,
      timestamp: checkpoint.createdAt,
      kind: "checkpoint",
      title: checkpoint.title,
      detail: checkpoint.detail,
      taskId: checkpoint.taskId
    });
  }

  for (const artifact of missionArtifacts) {
    frames.push({
      id: `playback-task-${artifact.taskId}`,
      timestamp: artifact.startedAt,
      kind: "task",
      title: `${artifact.owner} started ${artifact.title}`,
      detail: artifact.summary ?? artifact.error ?? "Task started.",
      taskId: artifact.taskId
    });

    for (const attempt of artifact.attempts) {
      frames.push({
        id: `playback-attempt-${attempt.id}`,
        timestamp: attempt.startedAt,
        kind: "attempt",
        title: `${artifact.title} attempt ${attempt.attempt} ${attempt.status}`,
        detail: attempt.summary ?? `${artifact.owner} ${attempt.status}.`,
        taskId: artifact.taskId
      });
    }

    for (const progress of artifact.progress) {
      frames.push({
        id: `playback-progress-${progress.id}`,
        timestamp: progress.createdAt,
        kind: "progress",
        title: `${artifact.title} progress`,
        detail: progress.summary,
        taskId: artifact.taskId
      });
    }

    if (artifact.finishedAt) {
      frames.push({
        id: `playback-finish-${artifact.taskId}`,
        timestamp: artifact.finishedAt,
        kind: "task",
        title: `${artifact.owner} finished ${artifact.title}`,
        detail: artifact.summary ?? artifact.error ?? "Task finished.",
        taskId: artifact.taskId
      });
    }
  }

  for (const receipt of missionReceipts) {
    frames.push({
      id: `playback-receipt-${receipt.id}`,
      timestamp: receipt.createdAt,
      kind: "receipt",
      title: `${receipt.owner} receipt: ${receipt.title}`,
      detail: `${receipt.outcome} | commands=${receipt.commands.join(" | ") || "-"} | changed=${receipt.changedPaths.join(", ") || "-"}`,
      taskId: receipt.taskId
    });
  }

  for (const contract of missionContracts) {
    frames.push({
      id: `playback-contract-${contract.id}`,
      timestamp: contract.createdAt,
      kind: "contract",
      title: `${contract.sourceAgent} -> ${contract.targetAgent}: ${contract.title}`,
      detail: `${contract.kind} | ${contract.status} | ${contract.detail}`,
      taskId: contract.sourceTaskId
    });
  }

  frames.push({
    id: `playback-acceptance-${mission.id}`,
    timestamp: mission.acceptance.updatedAt,
    kind: "acceptance",
    title: `Acceptance ${mission.acceptance.status}`,
    detail: `${mission.acceptance.summary} | ${(mission.acceptance.criteria ?? []).join(" | ")}`,
    taskId: null
  });

  if (latestLandReport && latestLandReport.sessionId === session.id && mission.landedAt) {
    frames.push({
      id: `playback-land-${latestLandReport.id}`,
      timestamp: latestLandReport.createdAt,
      kind: "landing",
      title: `Landed into ${latestLandReport.targetBranch}`,
      detail: latestLandReport.summary.join(" "),
      taskId: null
    });
  }

  const postmortem = buildMissionPostmortem(session, mission, artifacts);
  if (
    postmortem.wins.length > 0 ||
    postmortem.pains.length > 0 ||
    postmortem.followUpDebt.length > 0
  ) {
    frames.push({
      id: `playback-postmortem-${mission.id}`,
      timestamp: postmortem.generatedAt,
      kind: "mission",
      title: `Postmortem: ${postmortem.outcome}`,
      detail: [
        postmortem.summary,
        postmortem.wins[0] ? `win=${postmortem.wins[0]}` : "",
        postmortem.pains[0] ? `pain=${postmortem.pains[0]}` : "",
        postmortem.followUpDebt[0] ? `debt=${postmortem.followUpDebt[0]}` : ""
      ].filter(Boolean).join(" | "),
      taskId: null
    });
  }

  if (audit && audit.objections.length > 0) {
    frames.push({
      id: `playback-audit-${mission.id}`,
      timestamp: audit.generatedAt,
      kind: "mission",
      title: `Quality Court: ${audit.verdict}`,
      detail: `${audit.summary} | first objection=${audit.objections[0]?.title ?? "none"}`,
      taskId: audit.objections[0]?.likelyTaskIds[0] ?? null
    });
  }

  return frames.sort(frameSort);
}
