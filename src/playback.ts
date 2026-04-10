import { latestMission } from "./missions.ts";
import type { LandReport, MissionPlaybackFrame, SessionRecord, TaskArtifact } from "./types.ts";

function frameSort(left: MissionPlaybackFrame, right: MissionPlaybackFrame): number {
  return left.timestamp.localeCompare(right.timestamp) || left.title.localeCompare(right.title);
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

    frames.push({
      id: `playback-finish-${artifact.taskId}`,
      timestamp: artifact.finishedAt,
      kind: "task",
      title: `${artifact.owner} finished ${artifact.title}`,
      detail: artifact.summary ?? artifact.error ?? "Task finished.",
      taskId: artifact.taskId
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

  return frames.sort(frameSort);
}
