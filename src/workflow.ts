import { buildClaimHotspots } from "./decision-ledger.ts";
import { explainMissionAcceptanceFailures } from "./acceptance.ts";
import { filterWorktreeChangedPaths } from "./git.ts";
import { isMissionBlockingTask, latestMission, syncMissionStates } from "./missions.ts";
import { buildMissionAuditReport } from "./quality-court.ts";
import { activeFollowUpRecommendations, buildOperatorRecommendations } from "./recommendations.ts";
import type {
  AgentName,
  EventRecord,
  KaviSnapshot,
  LandReport,
  Mission,
  TaskArtifact,
  TaskSpec
} from "./types.ts";

type ActivityTone = "normal" | "good" | "warn" | "bad" | "muted";

export interface WorkflowActivityEntry {
  id: string;
  timestamp: string;
  title: string;
  detail: string;
  tone: ActivityTone;
}

export interface WorkflowCompletedTask {
  taskId: string;
  owner: TaskSpec["owner"];
  title: string;
  summary: string;
  finishedAt: string;
  claimedPaths: string[];
}

export interface WorkflowAgentChanges {
  agent: "codex" | "claude";
  paths: string[];
}

export interface MissionObservability {
  totalTasks: number;
  pendingTasks: number;
  runningTasks: number;
  blockedTasks: number;
  failedTasks: number;
  completedTasks: number;
  activeRepairTasks: number;
  stalledTasks: number;
  retriesUsed: number;
  retryingTasks: number;
  latestFailure: {
    taskId: string;
    title: string;
    summary: string;
    status: TaskSpec["status"];
  } | null;
  latestProgress: {
    taskId: string;
    title: string;
    summary: string;
    createdAt: string;
  } | null;
  recentProgress: Array<{
    taskId: string;
    title: string;
    summary: string;
    kind: "change" | "heartbeat" | "stalled" | "provider";
    createdAt: string;
    provider?: AgentName | "node" | null;
    eventName?: string | null;
    source?: "notification" | "stderr" | "stdout" | "delta" | "worktree" | "hook" | "transcript" | null;
  }>;
  criticalPath: string[];
  nextReadyNodes: Array<{
    key: string;
    title: string;
    owner: "codex" | "claude";
  }>;
  activeOwners: AgentName[];
  changedPaths: number;
  changedPathList: string[];
}

export interface WorkflowSummary {
  goal: string | null;
  activeMission: Mission | null;
  missionObservability: MissionObservability | null;
  stage: {
    id: string;
    label: string;
    detail: string;
  };
  taskCounts: {
    pending: number;
    running: number;
    blocked: number;
    completed: number;
    failed: number;
  };
  approvalCounts: {
    pending: number;
  };
  reviewCounts: {
    open: number;
  };
  recommendationCounts: {
    active: number;
    dismissed: number;
  };
  landReadiness: {
    state: "idle" | "ready" | "blocked";
    blockers: string[];
    warnings: string[];
    nextActions: string[];
  };
  changedByAgent: WorkflowAgentChanges[];
  completedTasks: WorkflowCompletedTask[];
  recentActivity: WorkflowActivityEntry[];
  latestLandReport: LandReport | null;
}

export interface WorkflowAgentResult {
  agent: AgentName;
  latestTaskId: string | null;
  latestTaskTitle: string | null;
  latestSummary: string | null;
  completedTaskCount: number;
  changedPaths: string[];
  lastRunAt: string | null;
  landedPaths: string[];
}

export interface WorkflowResult {
  goal: string | null;
  activeMission: Mission | null;
  missionObservability: MissionObservability | null;
  stage: WorkflowSummary["stage"];
  headline: string;
  nextActions: string[];
  changedByAgent: WorkflowAgentChanges[];
  recentActivity: WorkflowActivityEntry[];
  completedTasks: WorkflowCompletedTask[];
  latestLandReport: LandReport | null;
  agentResults: WorkflowAgentResult[];
  summaryLines: string[];
}

function taskArtifactIndex(artifacts: TaskArtifact[]): Map<string, TaskArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.taskId, artifact]));
}

function taskIndex(snapshot: KaviSnapshot): Map<string, TaskSpec> {
  return new Map(snapshot.session.tasks.map((task) => [task.id, task]));
}

function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeTask(
  task: TaskSpec,
  artifactByTask: Map<string, TaskArtifact>
): WorkflowCompletedTask {
  const artifact = artifactByTask.get(task.id);
  return {
    taskId: task.id,
    owner: task.owner,
    title: task.title,
    summary: artifact?.summary ?? task.summary ?? task.prompt,
    finishedAt: artifact?.finishedAt ?? task.updatedAt,
    claimedPaths: artifact?.claimedPaths ?? task.claimedPaths
  };
}

function planForMission(snapshot: KaviSnapshot, mission: Mission): {
  nodes: Array<{
    key: string;
    title: string;
    owner: "codex" | "claude";
    dependsOn: string[];
    status: string;
  }>;
} | null {
  const plan =
    (mission.planId
      ? snapshot.session.plans.find((candidate) => candidate.id === mission.planId)
      : null) ??
    snapshot.session.plans.find((candidate) => candidate.missionId === mission.id && candidate.status !== "completed") ??
    snapshot.session.plans.find((candidate) => candidate.missionId === mission.id) ??
    null;
  if (!plan) {
    return null;
  }

  return {
    nodes: plan.nodes.map((node) => ({
      key: node.key,
      title: node.title,
      owner: node.owner,
      dependsOn: node.dependsOn,
      status: node.status
    }))
  };
}

function buildCriticalPath(nodes: Array<{
  key: string;
  title: string;
  dependsOn: string[];
  status: string;
}>): string[] {
  const remaining = nodes.filter((node) => node.status !== "completed");
  if (remaining.length === 0) {
    return [];
  }

  const remainingKeys = new Set(remaining.map((node) => node.key));
  const dependents = new Map<string, Array<{ key: string; title: string; dependsOn: string[]; status: string }>>();
  for (const node of remaining) {
    for (const dependency of node.dependsOn) {
      if (!remainingKeys.has(dependency)) {
        continue;
      }
      const bucket = dependents.get(dependency) ?? [];
      bucket.push(node);
      dependents.set(dependency, bucket);
    }
  }

  const roots = remaining.filter((node) =>
    node.dependsOn.every((dependency) => !remainingKeys.has(dependency))
  );
  const memo = new Map<string, string[]>();
  const visit = (node: { key: string; title: string }): string[] => {
    const cached = memo.get(node.key);
    if (cached) {
      return cached;
    }
    const children = dependents.get(node.key) ?? [];
    const bestChild = children
      .map((child) => visit(child))
      .sort((left, right) => right.length - left.length)[0] ?? [];
    const result = [node.title, ...bestChild];
    memo.set(node.key, result);
    return result;
  };

  return roots
    .map((node) => visit(node))
    .sort((left, right) => right.length - left.length)[0] ?? [];
}

export function buildMissionObservability(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = [],
  mission: Mission | null = latestMission(snapshot.session)
): MissionObservability | null {
  if (!mission) {
    return null;
  }

  const artifactByTask = taskArtifactIndex(artifacts);
  const tasks = snapshot.session.tasks.filter((task) => task.missionId === mission.id);
  const blockingTasks = tasks.filter((task) => isMissionBlockingTask(snapshot.session, mission, task));
  const activeRepairTasks = tasks.filter(
    (task) =>
      task.nodeKind === "repair" &&
      isMissionBlockingTask(snapshot.session, mission, task)
  ).length;
  const stalledTasks = tasks.filter((task) => {
    const artifact = artifactByTask.get(task.id);
    return (
      isMissionBlockingTask(snapshot.session, mission, task) &&
      task.status === "running" &&
      artifact?.progress.at(-1)?.kind === "stalled"
    );
  }).length;
  const retriesUsed = tasks.reduce((total, task) => total + task.retryCount, 0);
  const retryingTasks = blockingTasks.filter(
    (task) =>
      task.retryCount > 0
  ).length;
  const latestFailureTask = [...tasks]
    .filter((task) => task.status === "failed" || task.status === "blocked")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const latestProgress = tasks
    .flatMap((task) => {
      const entry = artifactByTask.get(task.id)?.progress.at(-1);
      if (!entry) {
        return [];
      }

      return [{
        taskId: task.id,
        title: task.title,
        summary: entry.summary,
        createdAt: entry.createdAt
      }];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  const recentProgress = tasks
    .flatMap((task) =>
      (artifactByTask.get(task.id)?.progress ?? []).map((entry) => ({
        taskId: task.id,
        title: task.title,
        summary: entry.summary,
        kind: entry.kind,
        createdAt: entry.createdAt,
        provider: entry.provider ?? null,
        eventName: entry.eventName ?? null,
        source: entry.source ?? null
      }))
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 6);
  const plan = planForMission(snapshot, mission);
  const nextReadyNodes = plan
    ? plan.nodes
        .filter((node) => node.status === "planned" || node.status === "pending")
        .filter((node) =>
          node.dependsOn.every((dependency) => {
            const dependencyNode = plan.nodes.find((candidate) => candidate.key === dependency);
            return !dependencyNode || dependencyNode.status === "completed";
          })
        )
        .slice(0, 5)
        .map((node) => ({
          key: node.key,
          title: node.title,
          owner: node.owner
        }))
    : [];
  const activeOwners = [...new Set(
    blockingTasks
      .map((task) => task.owner)
      .filter((owner): owner is AgentName => owner === "codex" || owner === "claude")
  )];
  const changedPathList = filterWorktreeChangedPaths([...new Set(
    tasks.flatMap((task) => [
      ...task.claimedPaths,
      ...(artifactByTask.get(task.id)?.progress ?? []).flatMap((entry) => entry.paths)
    ])
  )]).sort((left, right) => left.localeCompare(right));

  return {
    totalTasks: tasks.length,
    pendingTasks: blockingTasks.filter((task) => task.status === "pending").length,
    runningTasks: blockingTasks.filter((task) => task.status === "running").length,
    blockedTasks: blockingTasks.filter((task) => task.status === "blocked").length,
    failedTasks: tasks.filter((task) => task.status === "failed").length,
    completedTasks: tasks.filter((task) => task.status === "completed").length,
    activeRepairTasks,
    stalledTasks,
    retriesUsed,
    retryingTasks,
    latestFailure: latestFailureTask
      ? {
          taskId: latestFailureTask.id,
          title: latestFailureTask.title,
          summary:
            latestFailureTask.lastFailureSummary ??
            artifactByTask.get(latestFailureTask.id)?.error ??
            latestFailureTask.summary ??
            "Task failed without a recorded summary.",
          status: latestFailureTask.status
        }
      : null,
    latestProgress,
    recentProgress,
    criticalPath: plan ? buildCriticalPath(plan.nodes) : [],
    nextReadyNodes,
    activeOwners,
    changedPaths: changedPathList.length,
    changedPathList
  };
}

function deriveWorkflowStage(params: {
  snapshot: KaviSnapshot;
  changedByAgent: WorkflowAgentChanges[];
  pendingApprovals: number;
  runningTasks: number;
  stalledTasks: number;
  blockedTasks: number;
  pendingTasks: number;
  failedTasks: number;
  activeRepairTasks: number;
  hotspots: ReturnType<typeof buildClaimHotspots>;
  pendingFollowUpRecommendations: number;
  latestLandReport: LandReport | null;
}): WorkflowSummary["stage"] {
  const totalChangedPaths = params.changedByAgent.reduce(
    (count, item) => count + item.paths.length,
    0
  );
  const completedTasks = params.snapshot.session.tasks.filter(
    (task) => task.status === "completed"
  ).length;

  if (params.pendingApprovals > 0) {
    return {
      id: "waiting_for_approval",
      label: "Waiting For Approval",
      detail: `${params.pendingApprovals} approval request(s) are blocking progress.`
    };
  }

  if (latestMission(params.snapshot.session)?.status === "blocked" || params.failedTasks > 0) {
    return {
      id: "blocked",
      label: "Blocked",
      detail:
        params.failedTasks > 0
          ? `${params.failedTasks} task(s) failed and need operator attention before progress can continue.`
          : "Mission progress is blocked and needs operator attention before work can continue."
    };
  }

  if (params.activeRepairTasks > 0) {
    return {
      id: "repairing",
      label: "Repairing",
      detail: `${params.activeRepairTasks} repair task(s) are currently queued or running from failed acceptance.`
    };
  }

  if (params.blockedTasks > 0 || params.hotspots.length > 0) {
    return {
      id: "integration",
      label: "Integration Needed",
      detail:
        params.hotspots.length > 0
          ? `${params.hotspots.length} overlapping path hotspot(s) need integration work.`
          : `${params.blockedTasks} task(s) are blocked and need review.`
    };
  }

  if (params.runningTasks > 0 || params.pendingTasks > 0) {
    return {
      id: "working",
      label: "Agents Working",
      detail:
        params.stalledTasks > 0
          ? `${params.runningTasks} running (${params.stalledTasks} stalled) and ${params.pendingTasks} pending task(s) remain in flight.`
          : `${params.runningTasks} running and ${params.pendingTasks} pending task(s) remain in flight.`
    };
  }

  if (params.pendingFollowUpRecommendations > 0 && totalChangedPaths > 0) {
    return {
      id: "review_follow_ups",
      label: "Review Follow-ups",
      detail: `${params.pendingFollowUpRecommendations} follow-up recommendation(s) should be reviewed before landing.`
    };
  }

  if (
    latestMission(params.snapshot.session)?.status === "awaiting_acceptance" &&
    totalChangedPaths > 0
  ) {
    return {
      id: "awaiting_acceptance",
      label: "Awaiting Acceptance",
      detail: "Mission output is ready for verification, but acceptance has not been cleared yet."
    };
  }

  if (totalChangedPaths > 0) {
    return {
      id: "ready_to_land",
      label: "Ready To Land",
      detail: `${totalChangedPaths} changed path(s) are ready for final review and landing.`
    };
  }

  if (params.latestLandReport) {
    return {
      id: "landed",
      label: "Landed",
      detail: `Latest merge landed in ${params.latestLandReport.targetBranch} at ${params.latestLandReport.createdAt}.`
    };
  }

  if (completedTasks > 0) {
    return {
      id: "idle",
      label: "Idle",
      detail: "Completed task output exists, but there are no unlanded worktree changes."
    };
  }

  return {
    id: "bootstrapping",
    label: "Bootstrapping",
    detail: "Kavi is ready for the initial kickoff or the next operator task."
  };
}

function buildAgentResults(
  snapshot: KaviSnapshot,
  artifactByTask: Map<string, TaskArtifact>
): WorkflowAgentResult[] {
  const latestLandReport = snapshot.latestLandReport;
  return (["codex", "claude"] as AgentName[]).map((agent) => {
    const completedTasks = snapshot.session.tasks
      .filter((task) => task.owner === agent && task.status === "completed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latestTask = completedTasks[0] ?? null;
    const landedPaths =
      latestLandReport?.changedByAgent.find((changeSet) => changeSet.agent === agent)?.paths ?? [];

    return {
      agent,
      latestTaskId: latestTask?.id ?? null,
      latestTaskTitle: latestTask?.title ?? null,
      latestSummary: latestTask
        ? summarizeTask(latestTask, artifactByTask).summary
        : snapshot.session.agentStatus[agent].summary,
      completedTaskCount: completedTasks.length,
      changedPaths:
        snapshot.worktreeDiffs.find((diff) => diff.agent === agent)?.paths ?? [],
      lastRunAt: snapshot.session.agentStatus[agent].lastRunAt,
      landedPaths
    };
  });
}

function toneForEvent(type: string): ActivityTone {
  if (type === "task.failed") {
    return "bad";
  }

  if (
    type === "approval.requested" ||
    type === "land.overlap_detected" ||
    type === "review.note_added"
  ) {
    return "warn";
  }

  if (
    type === "task.completed" ||
    type === "approval.resolved" ||
    type === "land.completed" ||
    type === "recommendation.applied"
  ) {
    return "good";
  }

  return "normal";
}

function describeEvent(
  snapshot: KaviSnapshot,
  event: EventRecord,
  artifactByTask: Map<string, TaskArtifact>
): WorkflowActivityEntry {
  const payload = event.payload;
  const tasks = taskIndex(snapshot);
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  const task = taskId ? tasks.get(taskId) ?? null : null;
  const artifact = taskId ? artifactByTask.get(taskId) ?? null : null;

  switch (event.type) {
    case "tasks.kickoff_enqueued":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Kickoff queued",
        detail: snapshot.session.goal
          ? `Started a two-agent kickoff for goal: ${snapshot.session.goal}`
          : "Started the initial Codex and Claude kickoff tasks.",
        tone: "good"
      };
    case "tasks.kickoff_created":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Kickoff tasks created",
        detail: "Kavi created the initial Codex and Claude kickoff tasks.",
        tone: "good"
      };
    case "daemon.started":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Session started",
        detail: "The Kavi daemon is running and ready for operator commands.",
        tone: "good"
      };
    case "daemon.stopped":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Session stopped",
        detail: "The Kavi daemon has stopped for this repository session.",
        tone: "muted"
      };
    case "repo.initialized":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Repository initialized",
        detail: "Kavi initialized git for this project.",
        tone: "good"
      };
    case "repo.bootstrap_committed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Bootstrap commit created",
        detail: "Kavi created the first base commit needed for managed worktrees.",
        tone: "good"
      };
    case "task.enqueued":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: `Task queued for ${typeof payload.owner === "string" ? payload.owner : "agent"}`,
        detail: task
          ? `${task.title} | ${task.prompt}`
          : shortJson(payload),
        tone: "normal"
      };
    case "plan.materialized":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Execution plan materialized",
        detail:
          typeof payload.count === "number"
            ? `Codex turned the prompt into ${payload.count} scheduled task(s).`
            : "Codex turned the prompt into a scheduled execution graph.",
        tone: "good"
      };
    case "task.started":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: `Task started${task ? `: ${task.title}` : ""}`,
        detail: task
          ? `${task.owner} is working on ${task.prompt}`
          : shortJson(payload),
        tone: "normal"
      };
    case "task.completed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: `Task completed${task ? `: ${task.title}` : ""}`,
        detail:
          artifact?.summary ??
          task?.summary ??
          (typeof payload.summary === "string" ? payload.summary : shortJson(payload)),
        tone: "good"
      };
    case "task.progress":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: task
          ? `Task progress: ${task.title}`
          : "Task progress",
        detail:
          typeof payload.summary === "string"
            ? payload.summary
            : shortJson(payload),
        tone: payload.kind === "stalled" ? "warn" : "muted"
      };
    case "task.failed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: `Task failed${task ? `: ${task.title}` : ""}`,
        detail:
          typeof payload.error === "string"
            ? payload.error
            : artifact?.error ?? shortJson(payload),
        tone: "bad"
      };
    case "task.retry_queued":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: task ? `Task retry queued: ${task.title}` : "Task retry queued",
        detail:
          typeof payload.taskId === "string"
            ? `${payload.taskId}${typeof payload.owner === "string" ? ` -> ${payload.owner}` : ""}`
            : shortJson(payload),
        tone: "warn"
      };
    case "task.retried":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: task ? `Task auto-retried: ${task.title}` : "Task auto-retried",
        detail:
          typeof payload.retryCount === "number"
            ? `Retry ${payload.retryCount}${typeof payload.error === "string" ? ` | ${payload.error}` : ""}`
            : shortJson(payload),
        tone: "warn"
      };
    case "task.lease_recovered":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: task ? `Recovered stale task lease: ${task.title}` : "Recovered stale task lease",
        detail:
          typeof payload.taskId === "string"
            ? `${payload.taskId}${typeof payload.owner === "string" ? ` -> ${payload.owner}` : ""}`
            : shortJson(payload),
        tone: "warn"
      };
    case "mission.acceptance_verified":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Mission acceptance verified",
        detail:
          typeof payload.acceptanceStatus === "string"
            ? `Acceptance is now ${payload.acceptanceStatus}.`
            : shortJson(payload),
        tone:
          payload.acceptanceStatus === "passed"
            ? "good"
            : payload.acceptanceStatus === "failed"
              ? "bad"
              : "normal"
      };
    case "mission.autopilot_applied":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Autopilot queued follow-up work",
        detail:
          typeof payload.taskId === "string"
            ? `${payload.taskId}${typeof payload.owner === "string" ? ` -> ${payload.owner}` : ""}`
            : shortJson(payload),
        tone: "good"
      };
    case "approval.requested":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Approval requested",
        detail:
          typeof payload.summary === "string"
            ? payload.summary
            : shortJson(payload),
        tone: "warn"
      };
    case "approval.resolved":
    case "approval.completed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Approval resolved",
        detail: shortJson(payload),
        tone: "good"
      };
    case "recommendation.applied":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Recommendation applied",
        detail:
          typeof payload.recommendationId === "string"
            ? `${payload.recommendationId} -> ${typeof payload.owner === "string" ? payload.owner : "agent"}`
            : shortJson(payload),
        tone: "good"
      };
    case "recommendation.dismissed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Recommendation dismissed",
        detail:
          typeof payload.recommendationId === "string"
            ? `${payload.recommendationId}${typeof payload.reason === "string" ? ` | ${payload.reason}` : ""}`
            : shortJson(payload),
        tone: "muted"
      };
    case "recommendation.restored":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Recommendation restored",
        detail:
          typeof payload.recommendationId === "string"
            ? payload.recommendationId
            : shortJson(payload),
        tone: "normal"
      };
    case "review.followup_queued":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Review follow-up queued",
        detail: shortJson(payload),
        tone: "normal"
      };
    case "review.note_added":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Review note added",
        detail: shortJson(payload),
        tone: "warn"
      };
    case "review.note_status_changed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Review note status changed",
        detail: shortJson(payload),
        tone: "normal"
      };
    case "review.note_landed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Review work landed",
        detail: shortJson(payload),
        tone: "good"
      };
    case "land.overlap_detected":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Landing blocked",
        detail: `Overlapping paths detected before landing: ${Array.isArray(payload.overlappingPaths) ? payload.overlappingPaths.join(", ") : shortJson(payload)}`,
        tone: "warn"
      };
    case "land.completed":
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: "Landing completed",
        detail:
          typeof payload.targetBranch === "string"
            ? `Merged managed work into ${payload.targetBranch}`
            : shortJson(payload),
        tone: "good"
      };
    default:
      return {
        id: event.id,
        timestamp: event.timestamp,
        title: event.type,
        detail: shortJson(payload),
        tone: toneForEvent(event.type)
      };
  }
}

export function buildWorkflowActivity(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = [],
  limit = 40
): WorkflowActivityEntry[] {
  const artifactByTask = taskArtifactIndex(artifacts);
  const entries = snapshot.events
    .map((event) => describeEvent(snapshot, event, artifactByTask))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  if (snapshot.session.goal) {
    entries.push({
      id: `goal:${snapshot.session.id}`,
      timestamp: snapshot.session.createdAt,
      title: "Session goal set",
      detail: snapshot.session.goal,
      tone: "good"
    });
  }

  return entries
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, Math.max(1, limit));
}

export function buildWorkflowSummary(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = []
): WorkflowSummary {
  syncMissionStates(snapshot.session);
  const artifactByTask = taskArtifactIndex(artifacts);
  const activeRecommendations = buildOperatorRecommendations(snapshot.session);
  const pendingFollowUps = activeFollowUpRecommendations(snapshot.session);
  const allRecommendations = buildOperatorRecommendations(snapshot.session, {
    includeDismissed: true
  });
  const activeMission = latestMission(snapshot.session);
  const activeContracts = activeMission
    ? (snapshot.session.contracts ?? []).filter(
        (contract) => contract.missionId === activeMission.id && contract.status === "open"
      )
    : [];
  const blockingContracts = activeContracts.filter((contract) => contract.dependencyImpact === "blocking");
  const missionObservability = buildMissionObservability(snapshot, artifacts, activeMission);
  const missionAudit = activeMission ? buildMissionAuditReport(snapshot.session, activeMission, artifacts) : null;
  const hotspots = buildClaimHotspots(snapshot.session);
  const changedByAgent: WorkflowAgentChanges[] = ["codex", "claude"].map((agent) => ({
    agent,
    paths: snapshot.worktreeDiffs.find((diff) => diff.agent === agent)?.paths ?? []
  }));
  const completedTasks = snapshot.session.tasks
    .filter((task) => task.status === "completed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((task) => summarizeTask(task, artifactByTask));

  const blockers: string[] = [];
  const warnings: string[] = [];

  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending").length;
  const runningTasks = snapshot.session.tasks.filter((task) => task.status === "running").length;
  const stalledTasks = snapshot.session.tasks.filter((task) => {
    if (task.status !== "running") {
      return false;
    }

    const artifact = artifactByTask.get(task.id);
    return artifact?.progress.at(-1)?.kind === "stalled";
  }).length;
  const blockedTasks = snapshot.session.tasks.filter((task) => task.status === "blocked").length;
  const pendingTasks = snapshot.session.tasks.filter((task) => task.status === "pending").length;
  const activeRepairTasks = snapshot.session.tasks.filter(
    (task) =>
      task.nodeKind === "repair" &&
      (task.status === "pending" || task.status === "running" || task.status === "blocked")
  ).length;
  const openReviews = snapshot.session.reviewNotes.filter((note) => note.status === "open").length;
  const acceptanceFailureExplanations = activeMission
    ? explainMissionAcceptanceFailures(activeMission)
    : [];

  if (pendingApprovals > 0) {
    blockers.push(`${pendingApprovals} approval request(s) still need a decision.`);
  }
  if (runningTasks > 0) {
    blockers.push(
      stalledTasks > 0
        ? `${runningTasks} task(s) are still running (${stalledTasks} currently appear stalled).`
        : `${runningTasks} task(s) are still running.`
    );
  }
  if (blockedTasks > 0) {
    blockers.push(`${blockedTasks} task(s) are blocked.`);
  }
  if (pendingTasks > 0) {
    blockers.push(`${pendingTasks} task(s) are still pending.`);
  }
  if (hotspots.length > 0) {
    blockers.push(`${hotspots.length} overlapping path hotspot(s) still need integration work.`);
  }
  if (pendingFollowUps.length > 0) {
    blockers.push(
      `${pendingFollowUps.length} follow-up recommendation(s) still need to be applied or dismissed before landing.`
    );
  }
  if (blockingContracts.length > 0) {
    blockers.push(
      `${blockingContracts.length} blocking agent contract(s) still need fulfillment before landing.`
    );
  }
  if (activeMission?.acceptance.status === "failed") {
    blockers.push(
      acceptanceFailureExplanations[0]
        ? `Failed acceptance: ${acceptanceFailureExplanations[0].summary}`
        : "Mission acceptance checks are failing."
    );
  }
  if (
    activeMission?.acceptance.status === "pending" &&
    runningTasks === 0 &&
    pendingTasks === 0
  ) {
    blockers.push("Mission acceptance has not been verified yet.");
  }
  if (missionAudit?.verdict === "blocked") {
    blockers.push(
      `Quality Court blocked shipping: ${missionAudit.objections
        .filter((objection) => objection.severity === "critical")
        .slice(0, 2)
        .map((objection) => objection.title)
        .join(" | ") || missionAudit.summary}`
    );
  }

  if (openReviews > 0) {
    warnings.push(`${openReviews} review thread(s) remain open.`);
  }
  if (activeRecommendations.length > 0) {
    warnings.push(`${activeRecommendations.length} active recommendation(s) remain.`);
  }
  if (activeContracts.length > 0) {
    warnings.push(`${activeContracts.length} open agent contract(s) remain.`);
  }
  const degradedProviders = (snapshot.session.providerCapabilities ?? []).filter(
    (manifest) => manifest.status === "degraded" || manifest.status === "unsupported"
  );
  if (degradedProviders.length > 0) {
    warnings.push(
      `Provider readiness needs attention: ${degradedProviders.map((manifest) => `${manifest.provider}:${manifest.status}`).join(", ")}.`
    );
  }
  if (activeMission?.acceptance.status === "pending") {
    warnings.push("Mission acceptance has not been verified yet.");
  }
  if ((missionObservability?.retriesUsed ?? 0) > 0) {
    warnings.push(
      `Mission has already used ${missionObservability?.retriesUsed ?? 0} retry attempt(s).`
    );
  }
  if (missionAudit?.verdict === "warn") {
    warnings.push(
      `Quality Court found objections worth reviewing: ${missionAudit.objections
        .filter((objection) => objection.severity !== "minor")
        .slice(0, 2)
        .map((objection) => objection.title)
        .join(" | ") || missionAudit.summary}`
    );
  }

  const totalChangedPaths = changedByAgent.reduce((count, item) => count + item.paths.length, 0);
  const state =
    blockers.length > 0
      ? "blocked"
      : totalChangedPaths > 0
        ? "ready"
        : "idle";
  const stage = deriveWorkflowStage({
    snapshot,
    changedByAgent,
    pendingApprovals,
    runningTasks,
    stalledTasks,
    blockedTasks,
    pendingTasks,
    failedTasks: snapshot.session.tasks.filter((task) => task.status === "failed").length,
    activeRepairTasks,
    hotspots,
    pendingFollowUpRecommendations: pendingFollowUps.length,
    latestLandReport: snapshot.latestLandReport
  });

  const nextActions: string[] = [];
  if (pendingApprovals > 0) {
    nextActions.push("Resolve pending approvals in the Approvals tab.");
  }
  if (degradedProviders.length > 0) {
    nextActions.push(
      `Re-authenticate or repair provider readiness for ${degradedProviders.map((manifest) => manifest.provider).join(", ")} before retrying failed work.`
    );
  }
  if (stage.id === "blocked") {
    if (missionObservability?.latestFailure) {
      nextActions.push(
        `Inspect ${missionObservability.latestFailure.taskId}, then run \`kavi retry ${missionObservability.latestFailure.taskId}\` or reroute the blocked work.`
      );
    } else {
      nextActions.push("Inspect the failed task output, then retry or reroute the blocked work.");
    }
  }
  if (runningTasks > 0 || pendingTasks > 0) {
    nextActions.push(
      stalledTasks > 0
        ? "Review the Activity and Tasks tabs for stalled work before waiting longer."
        : "Wait for active work to finish or review the Activity and Tasks tabs for blockers."
    );
  }
  if (activeRepairTasks > 0) {
    nextActions.push("Review repair tasks generated from failed acceptance before attempting to land.");
  }
  if (blockedTasks > 0 || hotspots.length > 0) {
    nextActions.push("Address blocked work or overlap hotspots before landing.");
  }
  if (pendingFollowUps.length > 0) {
    nextActions.push("Review the Recommendations tab and apply or dismiss the outstanding follow-up work before landing.");
  }
  if (activeContracts.length > 0) {
    nextActions.push("Review `kavi contracts` to resolve or fulfill the open agent contracts before landing.");
  }
  if (activeMission?.shadowOfMissionId) {
    nextActions.push(
      `Compare this shadow mission against ${activeMission.shadowOfMissionId} with \`kavi mission compare ${activeMission.shadowOfMissionId} ${activeMission.id}\`, then select the preferred one with \`kavi mission select <mission-id>\`.`
    );
  }
  if (activeMission?.acceptance.status === "pending" && runningTasks === 0 && pendingTasks === 0) {
    nextActions.push("Run `kavi verify` to execute mission acceptance checks before landing.");
  }
  if (acceptanceFailureExplanations.length > 0) {
    nextActions.push(
      `Inspect failed acceptance with \`kavi accept latest\`; focus first on: ${acceptanceFailureExplanations[0].repairFocus[0] ?? acceptanceFailureExplanations[0].title}.`
    );
  }
  if (missionAudit?.verdict !== "approved") {
    nextActions.push("Run `kavi judge latest` to review Quality Court objections before shipping.");
  }
  if (state === "ready") {
    nextActions.push("Review the merged result summary in Results, then run `kavi land` or press `L` in the TUI.");
  }
  if (state === "idle") {
    nextActions.push("No unlanded worktree changes are currently present.");
  }

  return {
    goal: snapshot.session.goal,
    activeMission,
    missionObservability,
    stage,
    taskCounts: {
      pending: pendingTasks,
      running: runningTasks,
      blocked: blockedTasks,
      completed: snapshot.session.tasks.filter((task) => task.status === "completed").length,
      failed: snapshot.session.tasks.filter((task) => task.status === "failed").length
    },
    approvalCounts: {
      pending: pendingApprovals
    },
    reviewCounts: {
      open: openReviews
    },
    recommendationCounts: {
      active: activeRecommendations.length,
      dismissed: allRecommendations.filter((item) => item.status === "dismissed").length
    },
    landReadiness: {
      state,
      blockers,
      warnings,
      nextActions
    },
    changedByAgent,
    completedTasks,
    recentActivity: buildWorkflowActivity(snapshot, artifacts, 8),
    latestLandReport: snapshot.latestLandReport
  };
}

export function buildWorkflowResult(
  snapshot: KaviSnapshot,
  artifacts: TaskArtifact[] = []
): WorkflowResult {
  const artifactByTask = taskArtifactIndex(artifacts);
  const summary = buildWorkflowSummary(snapshot, artifacts);
  const latestLandReport = snapshot.latestLandReport;
  const agentResults = buildAgentResults(snapshot, artifactByTask);
  const headline =
    summary.stage.id === "landed" && latestLandReport
      ? `Merged work landed in ${latestLandReport.targetBranch}.`
      : summary.activeMission?.status === "awaiting_acceptance"
        ? "Mission execution finished; acceptance verification should run before final landing."
      : summary.stage.id === "ready_to_land"
        ? "Managed work is ready for final review and landing."
        : summary.stage.id === "blocked"
          ? "Mission progress is blocked and needs repair, rerouting, or provider recovery."
        : summary.stage.id === "integration"
          ? "Cross-agent integration needs attention before landing."
          : summary.stage.id === "repairing"
            ? "Kavi is actively running repair work from failed acceptance."
          : summary.stage.id === "review_follow_ups"
            ? "Agent follow-up work is waiting for operator review before landing."
          : summary.stage.id === "waiting_for_approval"
            ? "Operator approval is needed before work can continue."
            : summary.stage.id === "working"
              ? "Managed agents are actively working through the session."
              : summary.stage.id === "bootstrapping"
                ? "Kavi is ready to begin the session workflow."
                : "The session is currently idle.";

  const summaryLines: string[] = [];
  if (latestLandReport) {
    summaryLines.push(...latestLandReport.summary);
  } else {
    summaryLines.push(summary.stage.detail);
  }

  if (summary.activeMission) {
    summaryLines.push(
      `Mission ${summary.activeMission.title}: ${summary.activeMission.summary} | acceptance=${summary.activeMission.acceptance.status} | health=${summary.activeMission.health?.state ?? "-"}:${summary.activeMission.health?.score ?? "-"}`
    );
    if ((summary.activeMission.appliedPatternIds ?? []).length > 0) {
      summaryLines.push(`Patterns: ${summary.activeMission.appliedPatternIds?.join(", ")}`);
    }
  }
  if (summary.missionObservability) {
    summaryLines.push(
      `Mission runtime: tasks=${summary.missionObservability.completedTasks}/${summary.missionObservability.totalTasks} completed | running=${summary.missionObservability.runningTasks} | pending=${summary.missionObservability.pendingTasks} | repairs=${summary.missionObservability.activeRepairTasks} | retries-used=${summary.missionObservability.retriesUsed}`
    );
    summaryLines.push(
      `Observability: active-owners=${summary.missionObservability.activeOwners.join(", ") || "-"} | changed-paths=${summary.missionObservability.changedPaths} | critical-path=${summary.missionObservability.criticalPath.join(" -> ") || "-"}`
    );
    if (summary.missionObservability.latestFailure) {
      summaryLines.push(
        `Latest failure: ${summary.missionObservability.latestFailure.taskId} | ${summary.missionObservability.latestFailure.summary}`
      );
    } else if (summary.missionObservability.latestProgress) {
      summaryLines.push(
        `Latest progress: ${summary.missionObservability.latestProgress.taskId} | ${summary.missionObservability.latestProgress.summary}`
      );
    }
  }

  for (const agent of agentResults) {
    summaryLines.push(
      `${agent.agent}: ${agent.latestSummary ?? "No completed result yet."}${agent.changedPaths.length > 0 ? ` | unlanded paths=${agent.changedPaths.join(", ")}` : ""}`
    );
  }

  return {
    goal: summary.goal,
    activeMission: summary.activeMission,
    missionObservability: summary.missionObservability,
    stage: summary.stage,
    headline,
    nextActions: summary.landReadiness.nextActions,
    changedByAgent: summary.changedByAgent,
    recentActivity: summary.recentActivity,
    completedTasks: summary.completedTasks,
    latestLandReport,
    agentResults,
    summaryLines
  };
}
