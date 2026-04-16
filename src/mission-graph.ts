import type { ExecutionPlanNode, Mission, SessionRecord, TaskSpec } from "./types.ts";

export interface MissionGraphNodeSummary {
  key: string;
  title: string;
  owner: TaskSpec["owner"];
  nodeKind: ExecutionPlanNode["nodeKind"];
  status: ExecutionPlanNode["status"];
  dependsOn: string[];
  claimedPaths: string[];
}

export interface MissionGraphRenderInput {
  criticalPath?: string[];
  nextReadyKeys?: string[];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sortNodeKeys(nodes: MissionGraphNodeSummary[]): MissionGraphNodeSummary[] {
  return [...nodes].sort((left, right) => {
    const ownerCompare = String(left.owner).localeCompare(String(right.owner));
    if (ownerCompare !== 0) {
      return ownerCompare;
    }
    return left.key.localeCompare(right.key);
  });
}

function statusTag(status: MissionGraphNodeSummary["status"]): string {
  switch (status) {
    case "completed":
      return "DONE";
    case "running":
      return "RUN ";
    case "failed":
      return "FAIL";
    case "blocked":
      return "BLKD";
    case "pending":
      return "WAIT";
    case "planned":
      return "PLAN";
    default:
      return "TASK";
  }
}

function describeNode(node: MissionGraphNodeSummary, input: MissionGraphRenderInput): string {
  const tags: string[] = [];
  if ((input.criticalPath ?? []).includes(node.title)) {
    tags.push("critical");
  }
  if ((input.nextReadyKeys ?? []).includes(node.key)) {
    tags.push("ready");
  }
  const ownerLabel = `${node.owner}/${node.nodeKind ?? "task"}`;
  const dependencyLabel = node.dependsOn.length > 0 ? ` | deps=${node.dependsOn.join("+")}` : "";
  const tagLabel = tags.length > 0 ? ` {${tags.join(",")}}` : "";
  return `[${statusTag(node.status)}] ${node.key} | ${ownerLabel} | ${node.title}${dependencyLabel}${tagLabel}`;
}

export function resolveMissionGraphNodes(
  session: SessionRecord,
  mission: Mission
): MissionGraphNodeSummary[] {
  const plan =
    (mission.planId
      ? session.plans.find((candidate) => candidate.id === mission.planId)
      : null) ??
    session.plans.find((candidate) => candidate.missionId === mission.id && candidate.status !== "completed") ??
    session.plans.find((candidate) => candidate.missionId === mission.id) ??
    null;
  if (plan) {
    return plan.nodes.map((node) => ({
      key: node.key,
      title: node.title,
      owner: node.owner,
      nodeKind: node.nodeKind,
      status: node.status,
      dependsOn: [...node.dependsOn],
      claimedPaths: [...node.claimedPaths]
    }));
  }

  const missionTasks = session.tasks.filter((task) => task.missionId === mission.id);
  if (missionTasks.length === 0) {
    return [];
  }

  const keyByTaskId = new Map(missionTasks.map((task) => [task.id, task.planNodeKey ?? task.id]));
  return missionTasks.map((task) => ({
    key: task.planNodeKey ?? task.id,
    title: task.title,
    owner: task.owner,
    nodeKind: task.nodeKind ?? null,
    status: task.status,
    dependsOn: task.dependsOnTaskIds.map((dependency) => keyByTaskId.get(dependency) ?? dependency),
    claimedPaths: [...task.claimedPaths]
  }));
}

export function renderMissionGraph(
  nodes: MissionGraphNodeSummary[],
  input: MissionGraphRenderInput = {}
): string[] {
  if (nodes.length === 0) {
    return ["- no graph nodes available"];
  }

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeByKey.has(dependency)) {
        continue;
      }
      const bucket = dependents.get(dependency) ?? [];
      bucket.push(node.key);
      dependents.set(dependency, unique(bucket));
    }
  }

  const roots = sortNodeKeys(
    nodes.filter((node) => node.dependsOn.length === 0 || node.dependsOn.every((dependency) => !nodeByKey.has(dependency)))
  );
  const remaining = sortNodeKeys(nodes.filter((node) => !roots.some((root) => root.key === node.key)));
  const orderedRoots = roots.length > 0 ? roots : remaining;
  const expanded = new Set<string>();
  const lines: string[] = [];

  const visit = (nodeKey: string, prefix: string, isLast: boolean): void => {
    const node = nodeByKey.get(nodeKey);
    if (!node) {
      return;
    }
    const connector = prefix ? `${prefix}${isLast ? "`-- " : "|-- "}` : "";
    const duplicate = expanded.has(nodeKey);
    const duplicateLabel = duplicate ? " {ref}" : "";
    lines.push(`${connector}${describeNode(node, input)}${duplicateLabel}`);
    if (duplicate) {
      return;
    }
    expanded.add(nodeKey);

    const children = sortNodeKeys(
      (dependents.get(nodeKey) ?? [])
        .map((key) => nodeByKey.get(key))
        .filter((candidate): candidate is MissionGraphNodeSummary => Boolean(candidate))
    );
    if (children.length === 0) {
      return;
    }
    const childPrefix = prefix ? `${prefix}${isLast ? "    " : "|   "}` : "";
    for (const [index, child] of children.entries()) {
      visit(child.key, childPrefix, index === children.length - 1);
    }
  };

  for (const [index, root] of orderedRoots.entries()) {
    visit(root.key, "", index === orderedRoots.length - 1);
  }

  return lines;
}
