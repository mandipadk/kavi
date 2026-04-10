import { randomUUID } from "node:crypto";
import { compileMissionPrompt, computeMissionHealth } from "./mission-kernel.ts";
import { nowIso } from "./paths.ts";
import type {
  AcceptanceCheck,
  AcceptancePack,
  KaviConfig,
  Mission,
  MissionCheckpoint,
  MissionMode,
  MissionStatus,
  SessionRecord,
  TaskSpec
} from "./types.ts";

function normalizePrompt(prompt: string): string {
  return prompt.replaceAll("\r", "").trim();
}

function summarizeTitle(prompt: string): string {
  const compact = normalizePrompt(prompt).replaceAll(/\s+/g, " ");
  if (!compact) {
    return "Untitled mission";
  }

  return compact.length <= 96 ? compact : `${compact.slice(0, 93)}...`;
}

function promptHas(lower: string, pattern: RegExp): boolean {
  return pattern.test(lower);
}

function buildAcceptanceCriteria(prompt: string): string[] {
  const lower = normalizePrompt(prompt).toLowerCase();
  const criteria = new Set<string>();

  criteria.add("The requested slice is implemented in a coherent, runnable state.");

  if (promptHas(lower, /\b(ui|ux|frontend|design|screen|page|component|layout)\b/)) {
    criteria.add("User-facing behavior is understandable and coherent for the requested flow.");
  }

  if (promptHas(lower, /\b(api|backend|server|database|worker|queue|contract|schema)\b/)) {
    criteria.add("Backend and contract behavior match the requested implementation scope.");
  }

  if (promptHas(lower, /\b(test|smoke|verify|validation|qa|review)\b/)) {
    criteria.add("There is at least one practical validation path for the delivered work.");
  }

  if (promptHas(lower, /\b(readme|docs|documentation|onboard|setup)\b/)) {
    criteria.add("The repo explains how to run or understand the delivered slice.");
  }

  return [...criteria];
}

function buildAcceptanceChecks(config: KaviConfig): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [];
  const validationCommand = config.validationCommand.trim();

  if (validationCommand) {
    checks.push({
      id: `accept-check-${randomUUID()}`,
      title: "Run the configured validation command",
      kind: "command",
      command: validationCommand,
      path: null,
      status: "pending",
      detail: validationCommand,
      lastRunAt: null,
      lastOutput: null
    });
  }

  checks.push({
    id: `accept-check-${randomUUID()}`,
    title: "Operator review of mission output",
    kind: "manual",
    command: null,
    path: null,
    status: "pending",
    detail: "Review the mission graph, changed paths, and results before final landing.",
    lastRunAt: null,
    lastOutput: null
  });

  return checks.map((check) => ({
    ...check,
    lastRunAt: check.lastRunAt ?? null,
    lastOutput: check.lastOutput ?? null
  }));
}

export function computeAcceptanceStatus(acceptance: AcceptancePack): AcceptancePack["status"] {
  if (acceptance.checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  if (acceptance.checks.length === 0) {
    return "pending";
  }

  if (acceptance.checks.every((check) => check.status === "passed" || check.status === "skipped")) {
    return "passed";
  }

  return "pending";
}

export function createMission(
  session: SessionRecord,
  prompt: string,
  options: {
    mode?: MissionMode;
    goal?: string | null;
    planningTaskId?: string | null;
    rootTaskId?: string | null;
    summary?: string | null;
    shadowOfMissionId?: string | null;
    policyOverrides?: Partial<NonNullable<Mission["policy"]>>;
  } = {}
): Mission {
  const createdAt = nowIso();
  const compiled = compileMissionPrompt(session, prompt);
  const acceptance: AcceptancePack = {
    id: `accept-${randomUUID()}`,
    summary: "Mission acceptance pack",
    criteria: compiled.contract.acceptanceCriteria.length > 0
      ? compiled.contract.acceptanceCriteria
      : buildAcceptanceCriteria(prompt),
    checks: buildAcceptanceChecks(session.config),
    status: "pending",
    createdAt,
    updatedAt: createdAt
  };
  const missionId = `mission-${randomUUID()}`;
  const checkpoints: MissionCheckpoint[] = [
    {
      id: `checkpoint-${randomUUID()}`,
      kind: "created",
      title: "Mission created",
      detail: "Kavi created a mission from the operator prompt.",
      taskId: options.rootTaskId ?? options.planningTaskId ?? null,
      createdAt
    }
  ];

  if (options.planningTaskId) {
    checkpoints.push({
      id: `checkpoint-${randomUUID()}`,
      kind: "planning_started",
      title: "Planning started",
      detail: "Codex will turn the prompt into an execution graph before implementation continues.",
      taskId: options.planningTaskId,
      createdAt
    });
  }

  return {
    id: missionId,
    packetVersion: 2,
    title: summarizeTitle(prompt),
    prompt: normalizePrompt(prompt),
    goal: options.goal ?? null,
    mode: options.mode ?? "guided_autopilot",
    status: options.planningTaskId ? "planning" : "active",
    summary:
      options.summary?.trim() ||
      (options.planningTaskId
        ? "Mission is waiting for orchestration planning."
        : "Mission is executing directly without a separate planning pass."),
    shadowOfMissionId: options.shadowOfMissionId ?? null,
    planningTaskId: options.planningTaskId ?? null,
    planId: null,
    rootTaskId: options.rootTaskId ?? null,
    activeTaskIds: [options.rootTaskId ?? options.planningTaskId].filter(
      (value): value is string => Boolean(value)
    ),
    autopilotEnabled: (options.mode ?? "guided_autopilot") === "guided_autopilot",
    spec: compiled.spec,
    contract: compiled.contract,
    blueprint: compiled.blueprint,
    policy: {
      ...compiled.policy,
      ...(options.policyOverrides ?? {})
    },
    risks: compiled.risks,
    anchors: compiled.anchors,
    health: {
      score: 100,
      state: "healthy",
      reasons: [],
      updatedAt: createdAt
    },
    appliedPatternIds: [],
    acceptance,
    checkpoints,
    brainEntryIds: [],
    createdAt,
    updatedAt: createdAt,
    landedAt: null
  };
}

export function findMission(session: SessionRecord, missionId: string | null): Mission | null {
  if (!missionId) {
    return null;
  }

  return session.missions.find((mission) => mission.id === missionId) ?? null;
}

export function latestMission(session: SessionRecord): Mission | null {
  if (session.selectedMissionId) {
    const selected = session.missions.find((mission) => mission.id === session.selectedMissionId) ?? null;
    if (selected) {
      return selected;
    }
  }

  return [...(Array.isArray(session.missions) ? session.missions : [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function selectMission(session: SessionRecord, missionId: string | null): Mission | null {
  if (!missionId) {
    session.selectedMissionId = null;
    return null;
  }

  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    return null;
  }

  session.selectedMissionId = mission.id;
  session.updatedAt = nowIso();
  return mission;
}

export function updateMissionPolicy(
  session: SessionRecord,
  missionId: string,
  patch: Partial<NonNullable<Mission["policy"]>> & {
    autopilotEnabled?: boolean;
  }
): Mission | null {
  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    return null;
  }

  mission.policy = {
    ...(mission.policy ?? buildMissionPolicy(mission.prompt)),
    ...Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => key !== "autopilotEnabled" && value !== undefined)
    )
  };
  if (typeof patch.autopilotEnabled === "boolean") {
    mission.autopilotEnabled = patch.autopilotEnabled;
  }
  mission.updatedAt = nowIso();
  session.updatedAt = mission.updatedAt;
  return mission;
}

export function missionHasInFlightTasks(session: SessionRecord, missionId: string | null): boolean {
  if (!missionId) {
    return false;
  }

  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    return false;
  }

  return session.tasks.some((task) => isMissionBlockingTask(session, mission, task));
}

function isSupplementalKickoffTask(
  session: SessionRecord,
  mission: Mission,
  task: TaskSpec
): boolean {
  if (task.missionId !== mission.id || task.kind !== "kickoff") {
    return false;
  }
  if (task.id === mission.planningTaskId) {
    return false;
  }
  if (!mission.planId && !mission.rootTaskId) {
    return false;
  }

  return session.tasks.some(
    (candidate) =>
      candidate.missionId === mission.id &&
      candidate.id !== task.id &&
      candidate.kind !== "kickoff" &&
      (candidate.status === "pending" ||
        candidate.status === "running" ||
        candidate.status === "blocked" ||
        candidate.status === "completed")
  );
}

export function isMissionBlockingTask(
  session: SessionRecord,
  mission: Mission,
  task: TaskSpec
): boolean {
  if (task.missionId !== mission.id) {
    return false;
  }
  if (!(task.status === "pending" || task.status === "running" || task.status === "blocked")) {
    return false;
  }
  if (isSupplementalKickoffTask(session, mission, task)) {
    return false;
  }
  return true;
}

export function addMissionCheckpoint(
  session: SessionRecord,
  missionId: string | null,
  input: Omit<MissionCheckpoint, "id" | "createdAt">
): MissionCheckpoint | null {
  const mission = findMission(session, missionId);
  if (!mission) {
    return null;
  }

  const checkpoint: MissionCheckpoint = {
    id: `checkpoint-${randomUUID()}`,
    createdAt: nowIso(),
    ...input
  };
  mission.checkpoints.push(checkpoint);
  mission.updatedAt = checkpoint.createdAt;
  return checkpoint;
}

export function attachMissionPlan(
  session: SessionRecord,
  missionId: string | null,
  planId: string,
  summary: string
): void {
  const mission = findMission(session, missionId);
  if (!mission) {
    return;
  }

  mission.planId = planId;
  mission.summary = summary.trim() || mission.summary;
  mission.updatedAt = nowIso();
}

export function refreshMissionAcceptance(mission: Mission): void {
  mission.acceptance.status = computeAcceptanceStatus(mission.acceptance);
  mission.acceptance.updatedAt = nowIso();
}

export function syncMissionStates(session: SessionRecord): void {
  session.missions = Array.isArray(session.missions) ? session.missions : [];
  for (const mission of session.missions) {
    refreshMissionAcceptance(mission);
    const tasks = session.tasks.filter((task) => task.missionId === mission.id);
    const blockingTasks = tasks.filter((task) => isMissionBlockingTask(session, mission, task));
    const substantiveTasks = tasks.filter(
      (task) => !(task.kind === "kickoff" && task.id !== mission.planningTaskId)
    );
    const planningTaskActive = Boolean(
      mission.planningTaskId &&
        tasks.some(
          (task) =>
            task.id === mission.planningTaskId &&
            (task.status === "pending" || task.status === "running" || task.status === "blocked")
        )
    );
    const hasDirectRootTask = Boolean(mission.rootTaskId);
    mission.activeTaskIds = blockingTasks.map((task) => task.id);

    if (mission.landedAt) {
      mission.status = "landed";
      mission.updatedAt = nowIso();
      continue;
    }

    if (tasks.length === 0 && mission.planId === null && planningTaskActive && !hasDirectRootTask) {
      mission.status = "planning";
      mission.updatedAt = nowIso();
      continue;
    }

    if (tasks.some((task) => task.status === "failed" || isMissionBlockingTask(session, mission, task) && task.status === "blocked")) {
      mission.status = "blocked";
    } else if (blockingTasks.length > 0) {
      mission.status = planningTaskActive && !mission.planId && !hasDirectRootTask ? "planning" : "active";
    } else if (substantiveTasks.length > 0 && substantiveTasks.every((task) => task.status === "completed")) {
      mission.status =
        mission.acceptance.status === "failed"
          ? "blocked"
          : mission.acceptance.status === "passed"
            ? "ready_to_land"
            : "awaiting_acceptance";
    } else if (mission.planId) {
      mission.status = "completed";
    }

    mission.health = computeMissionHealth(session, mission);
    mission.updatedAt = nowIso();
  }
}

export function markLatestMissionLanded(session: SessionRecord, targetBranch: string): Mission | null {
  const mission = latestMission(session);
  if (!mission) {
    return null;
  }

  const landedAt = nowIso();
  mission.status = "landed";
  mission.landedAt = landedAt;
  mission.summary = `${mission.summary}${mission.summary ? " " : ""}Landed into ${targetBranch}.`.trim();
  mission.updatedAt = landedAt;
  mission.checkpoints.push({
    id: `checkpoint-${randomUUID()}`,
    kind: "landed",
    title: "Mission landed",
    detail: `Managed work for this mission landed into ${targetBranch}.`,
    taskId: null,
    createdAt: landedAt
  });
  return mission;
}

export function updateMissionSummaryFromTask(mission: Mission, task: TaskSpec): void {
  if (task.summary?.trim()) {
    mission.summary = task.summary.trim();
    mission.updatedAt = nowIso();
  }
}
