import { randomUUID } from "node:crypto";
import { buildAdHocTask, decomposeOperatorPrompt, extractPromptPathHints } from "./router.ts";
import { nowIso } from "./paths.ts";
import type {
  ComposerPlanningMode,
  ExecutionPlan,
  ExecutionPlanNode,
  Mission,
  MissionNodeKind,
  PlanExecutionMode,
  PlannedTaskDraft,
  PlannedTaskGraph,
  SessionRecord,
  TaskSpec
} from "./types.ts";

function normalizePrompt(value: string): string {
  return value.replaceAll("\r", "").trim();
}

function promptWordCount(prompt: string): number {
  return normalizePrompt(prompt)
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function promptWorkKinds(prompt: string): Set<string> {
  const lower = prompt.toLowerCase();
  const kinds = new Set<string>();

  if (/\b(scaffold|scaffolding|setup|bootstrap|initialize|starter|from scratch|greenfield)\b/.test(lower)) {
    kinds.add("scaffold");
  }
  if (/\b(api|apis|backend|database|databases|migration|migrations|schema|schemas|server|servers|auth|worker|workers|queue|queues)\b/.test(lower)) {
    kinds.add("backend");
  }
  if (/\b(frontend|front-end|full-stack|fullstack|ui|ux|design|screen|screens|page|pages|component|components|layout|layouts|styling|web|website|client)\b/.test(lower)) {
    kinds.add("frontend");
  }
  if (/\b(test|tests|testing|review|reviews|qa|validation|validations|bug|bugs|debug|debugging|fix|fixes|refactor|refactoring)\b/.test(lower)) {
    kinds.add("quality");
  }
  if (/\b(doc|docs|documentation|readme|spec|specs|architecture|architectural|plan|plans)\b/.test(lower)) {
    kinds.add("docs");
  }

  return kinds;
}

function taskIdForPlanNode(planId: string, key: string, index: number): string {
  const safeKey = key
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 24);
  return `task-${planId}-${safeKey || `node-${index + 1}`}`;
}

function normalizePlanExecutionMode(value: unknown): PlanExecutionMode {
  return value === "blocking" || value === "follow_up" ? value : "parallel";
}

function normalizeNodeKind(value: unknown): MissionNodeKind | null {
  return value === "research" ||
    value === "scaffold" ||
    value === "backend" ||
    value === "frontend" ||
    value === "shared_contract" ||
    value === "infra" ||
    value === "tests" ||
    value === "docs" ||
    value === "review" ||
    value === "repair" ||
    value === "integration"
    ? value
    : null;
}

function inferNodeKind(title: string, prompt: string, owner: "codex" | "claude", executionMode: PlanExecutionMode): MissionNodeKind {
  const lower = `${title}\n${prompt}`.toLowerCase();
  if (executionMode === "follow_up") {
    return "integration";
  }
  if (/\brepair|fix|debug|unblock|resolve failure\b/.test(lower)) {
    return "repair";
  }
  if (/\btest|verify|validation|smoke|qa\b/.test(lower)) {
    return "tests";
  }
  if (/\bfront|ui|ux|screen|page|component|layout|web\b/.test(lower)) {
    return "frontend";
  }
  if (/\bback|api|server|database|auth|migration\b/.test(lower)) {
    return "backend";
  }
  if (/\bscaffold|setup|bootstrap|initialize|starter|from scratch\b/.test(lower)) {
    return "scaffold";
  }
  if (/\bdeploy|infra|worker|queue|cron|pipeline\b/.test(lower)) {
    return "infra";
  }
  if (/\bcontract|schema|domain|shared|type\b/.test(lower)) {
    return "shared_contract";
  }
  if (/\bdoc|readme|guide|spec\b/.test(lower)) {
    return "docs";
  }
  return owner === "claude" ? "frontend" : "backend";
}

function taskRetryBudget(mission: Mission | null, nodeKind: MissionNodeKind | null, taskKind: TaskSpec["kind"]): number {
  const missionBudget = mission?.policy?.retryBudget ?? 1;
  if (taskKind === "planner") {
    return Math.max(1, missionBudget);
  }
  if (nodeKind === "repair" || nodeKind === "tests" || nodeKind === "integration") {
    return Math.max(1, missionBudget);
  }
  return missionBudget;
}

function explicitPlanningRequested(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    /\b(plan|replan|roadmap|decompose|break (it|this) down|orchestrate|milestones?)\b/.test(lower) ||
    lower.includes("task graph") ||
    lower.includes("dependency graph")
  );
}

function activePlanCount(session: SessionRecord): number {
  const plans = Array.isArray(session.plans) ? session.plans : [];
  return plans.filter((plan) => plan.status === "active" || plan.status === "draft").length;
}

export function hasActiveExecutionPlan(session: SessionRecord): boolean {
  return activePlanCount(session) > 0;
}

export function decidePlanningMode(
  prompt: string,
  session: SessionRecord,
  requestedMode: ComposerPlanningMode
): {
  usePlanner: boolean;
  requestedMode: ComposerPlanningMode;
  reason: string;
} {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return {
      usePlanner: false,
      requestedMode,
      reason: "Prompt is empty."
    };
  }

  if (requestedMode === "plan") {
    return {
      usePlanner: true,
      requestedMode,
      reason: "Operator explicitly requested planning mode."
    };
  }

  if (requestedMode === "direct") {
    return {
      usePlanner: false,
      requestedMode,
      reason: "Operator explicitly requested direct execution."
    };
  }

  if (hasActiveExecutionPlan(session) && !explicitPlanningRequested(normalized)) {
    return {
      usePlanner: false,
      requestedMode,
      reason: "An active execution plan already exists, so Kavi will not re-plan automatically."
    };
  }

  const checklistTasks = decomposeOperatorPrompt(normalized).filter((item) => item.source === "checklist");
  const workKinds = promptWorkKinds(normalized);
  const multiline = normalized.split("\n").length;
  const words = promptWordCount(normalized);

  if (explicitPlanningRequested(normalized)) {
    return {
      usePlanner: true,
      requestedMode,
      reason: "The prompt explicitly asks for planning or decomposition."
    };
  }

  if (checklistTasks.length >= 2) {
    return {
      usePlanner: true,
      requestedMode,
      reason: "The prompt already describes multiple work items that should be scheduled as a graph."
    };
  }

  if (workKinds.size >= 3 || (workKinds.has("backend") && workKinds.has("frontend") && workKinds.has("quality"))) {
    return {
      usePlanner: true,
      requestedMode,
      reason: "The prompt spans multiple implementation domains and should be orchestrated."
    };
  }

  if (words >= 90 || multiline >= 8) {
    return {
      usePlanner: true,
      requestedMode,
      reason: "The prompt is large enough that Kavi should plan before execution."
    };
  }

  return {
    usePlanner: false,
    requestedMode,
    reason: "The prompt looks narrow enough to route directly without a planning pass."
  };
}

function normalizeDraftKey(value: unknown, index: number): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate || `task-${index + 1}`;
}

function normalizePlannedTaskDrafts(
  graph: PlannedTaskGraph,
  fallbackPrompt: string
): PlannedTaskDraft[] {
  const keys = new Set<string>();
  const normalized: PlannedTaskDraft[] = [];

  const drafts = Array.isArray(graph.tasks) ? graph.tasks : [];
  for (const [index, item] of drafts.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const payload = item as Record<string, unknown>;
    let key = normalizeDraftKey(payload.key, index);
    while (keys.has(key)) {
      key = `${key}-${normalized.length + 1}`;
    }
    keys.add(key);

    const prompt =
      typeof payload.prompt === "string" && payload.prompt.trim()
        ? payload.prompt.trim()
        : fallbackPrompt;
    normalized.push({
      key,
      title:
        typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim()
          : `Planned task ${normalized.length + 1}`,
      owner: payload.owner === "claude" ? "claude" : "codex",
      prompt,
      nodeKind: normalizeNodeKind(payload.nodeKind),
      dependsOn: Array.isArray(payload.dependsOn)
        ? payload.dependsOn.map((dependency) => String(dependency)).filter(Boolean)
        : [],
      claimedPaths: Array.isArray(payload.claimedPaths)
        ? payload.claimedPaths.map((path) => String(path)).filter(Boolean)
        : extractPromptPathHints(prompt),
      reason:
        typeof payload.reason === "string" && payload.reason.trim()
          ? payload.reason.trim()
          : "Planned by Codex during orchestration.",
      executionMode: normalizePlanExecutionMode(payload.executionMode)
    });
  }

  return normalized;
}

export function buildPlannerTask(
  session: SessionRecord,
  prompt: string,
  options: {
    planningMode: "kickoff" | "operator";
    parentTaskId?: string | null;
    title?: string;
    missionId?: string | null;
  }
): TaskSpec {
  const taskId = `planner-${randomUUID()}`;
  const title =
    options.title ??
    (options.planningMode === "kickoff"
      ? "Codex kickoff execution plan"
      : "Codex orchestration plan");

  return buildAdHocTask("codex", prompt, taskId, {
    missionId: options.missionId ?? null,
    title,
    kind: "planner",
    nodeKind: "research",
    parentTaskId: options.parentTaskId ?? null,
    maxRetries: 1,
    routeReason:
      options.planningMode === "kickoff"
        ? "Kickoff planning reserved for Codex before execution begins."
        : "Kavi selected planning mode so Codex can build an execution graph before work starts.",
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {
      planner: true,
      planningMode: options.planningMode,
      activePlanCount: activePlanCount(session)
    },
    claimedPaths: []
  });
}

export function materializeExecutionPlan(
  session: SessionRecord,
  plannerTask: TaskSpec,
  graph: PlannedTaskGraph,
  fallbackPrompt: string
): {
  plan: ExecutionPlan;
  tasks: TaskSpec[];
} {
  const normalizedTasks = normalizePlannedTaskDrafts(graph, fallbackPrompt);
  const planId = `plan-${randomUUID()}`;
  const createdAt = nowIso();
  const mission =
    plannerTask.missionId
      ? session.missions.find((item) => item.id === plannerTask.missionId) ?? null
      : null;

  const drafts =
    normalizedTasks.length > 0
      ? normalizedTasks
      : [
          {
            key: "task-1",
            title: "Execute planned follow-up",
            owner: "codex" as const,
            prompt: fallbackPrompt,
            dependsOn: [],
            claimedPaths: extractPromptPathHints(fallbackPrompt),
            reason: "Planner returned no executable breakdown, so Kavi created a single fallback task.",
            executionMode: "blocking" as const
          }
        ];

  const taskIdByKey = new Map<string, string>();
  drafts.forEach((draft, index) => {
    taskIdByKey.set(draft.key, taskIdForPlanNode(planId, draft.key, index));
  });
  const kickoffDependencyTaskIds =
    plannerTask.routeMetadata.planningMode === "kickoff" && session.tasks.some((task) => task.id === "kickoff-claude")
      ? ["kickoff-claude"]
      : [];

  const tasks = drafts.map((draft, index) =>
    (() => {
      const nodeKind = draft.nodeKind ?? inferNodeKind(draft.title, draft.prompt, draft.owner, draft.executionMode);
      const taskKind = draft.executionMode === "follow_up" ? "integration" : "execution";
      return buildAdHocTask(
        draft.owner,
        draft.prompt,
        taskIdByKey.get(draft.key) ?? taskIdForPlanNode(planId, draft.key, index),
        {
          missionId: plannerTask.missionId,
          title: draft.title,
          kind: taskKind,
          nodeKind,
          dependsOnTaskIds: [
            ...kickoffDependencyTaskIds,
            ...draft.dependsOn
              .map((dependency) => taskIdByKey.get(dependency) ?? null)
              .filter((dependency): dependency is string => dependency !== null)
          ],
          parentTaskId: plannerTask.id,
          planId,
          planNodeKey: draft.key,
          retryCount: 0,
          maxRetries: taskRetryBudget(mission, nodeKind, taskKind),
          routeReason: `Planned by Codex orchestration: ${draft.reason}`,
          routeStrategy: "manual",
          routeConfidence: 1,
          routeMetadata: {
            planned: true,
            planId,
            planNodeKey: draft.key,
            plannerTaskId: plannerTask.id,
            executionMode: draft.executionMode,
            planningMode: plannerTask.routeMetadata.planningMode ?? "operator",
            nodeKind
          },
          claimedPaths: draft.claimedPaths
        }
      );
    })()
  );

  const plan: ExecutionPlan = {
    id: planId,
    missionId: plannerTask.missionId,
    title: graph.summary.trim() ? graph.summary.trim() : plannerTask.title,
    sourcePrompt: fallbackPrompt,
    sourceTaskId: plannerTask.parentTaskId ?? plannerTask.id,
    planningMode: plannerTask.routeMetadata.planningMode === "kickoff" ? "kickoff" : "operator",
    plannerTaskId: plannerTask.id,
    summary: graph.summary.trim() ? graph.summary.trim() : plannerTask.summary ?? "Execution plan created.",
    status: "active",
    createdAt,
    updatedAt: createdAt,
    nodes: drafts.map((draft) => ({
      key: draft.key,
      taskId: taskIdByKey.get(draft.key) ?? null,
      title: draft.title,
      owner: draft.owner,
      prompt: draft.prompt,
      nodeKind: draft.nodeKind ?? inferNodeKind(draft.title, draft.prompt, draft.owner, draft.executionMode),
      dependsOn: [
        ...kickoffDependencyTaskIds,
        ...draft.dependsOn
          .map((dependency) => taskIdByKey.get(dependency) ?? null)
          .filter((dependency): dependency is string => dependency !== null)
      ],
      claimedPaths: draft.claimedPaths,
      reason: draft.reason,
      executionMode: draft.executionMode,
      status: "pending"
    }))
  };

  session.tasks.push(...tasks);
  session.plans = Array.isArray(session.plans) ? session.plans : [];
  session.plans.push(plan);
  syncExecutionPlans(session);

  return {
    plan,
    tasks
  };
}

export function syncExecutionPlans(session: SessionRecord): void {
  session.plans = Array.isArray(session.plans) ? session.plans : [];
  for (const plan of session.plans) {
    plan.updatedAt = nowIso();
    for (const node of plan.nodes) {
      const task = node.taskId ? session.tasks.find((candidate) => candidate.id === node.taskId) : null;
      node.status = task ? task.status : "planned";
    }

    if (plan.nodes.length === 0) {
      plan.status = "draft";
      continue;
    }

    if (plan.nodes.some((node) => node.status === "blocked" || node.status === "failed")) {
      plan.status = "blocked";
      continue;
    }

    if (plan.nodes.every((node) => node.status === "completed")) {
      plan.status = "completed";
      continue;
    }

    plan.status = "active";
  }
}

export function currentExecutionPlan(session: SessionRecord): ExecutionPlan | null {
  const plans = [...(Array.isArray(session.plans) ? session.plans : [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return plans.find((plan) => plan.status === "active" || plan.status === "blocked") ?? plans[0] ?? null;
}

export function isTaskReady(session: SessionRecord, task: TaskSpec): boolean {
  if (task.status !== "pending") {
    return false;
  }

  const dependencies = Array.isArray(task.dependsOnTaskIds) ? task.dependsOnTaskIds : [];
  return dependencies.every((dependencyId) => {
    const dependency = session.tasks.find((candidate) => candidate.id === dependencyId);
    return dependency?.status === "completed";
  });
}
