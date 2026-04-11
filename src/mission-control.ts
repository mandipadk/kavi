import { randomUUID } from "node:crypto";
import { buildClaimHotspots } from "./decision-ledger.ts";
import { nowIso } from "./paths.ts";
import { buildAdHocTask } from "./router.ts";
import type {
  AgentContract,
  AgentContractKind,
  AgentName,
  AgentTurnEnvelope,
  Mission,
  MissionPhase,
  MissionReceipt,
  MissionSimulation,
  MissionSimulationIssue,
  MissionPostmortem,
  SessionRecord,
  TaskArtifact,
  TaskProgressEntry,
  TaskSpec
} from "./types.ts";

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function missionTasks(session: SessionRecord, missionId: string): TaskSpec[] {
  return session.tasks.filter((task) => task.missionId === missionId);
}

function missionHotspotPaths(session: SessionRecord, missionId: string): string[] {
  return buildClaimHotspots(session)
    .filter((hotspot) =>
      hotspot.taskIds.some((taskId) =>
        session.tasks.some((task) => task.id === taskId && task.missionId === missionId)
      )
    )
    .map((hotspot) => hotspot.path);
}

function missionPlanNodes(session: SessionRecord, mission: Mission) {
  const plan =
    (mission.planId
      ? session.plans.find((candidate) => candidate.id === mission.planId)
      : null) ??
    session.plans.find((candidate) => candidate.missionId === mission.id && candidate.status !== "completed") ??
    session.plans.find((candidate) => candidate.missionId === mission.id) ??
    null;
  return plan?.nodes ?? [];
}

function severityWeight(severity: MissionSimulationIssue["severity"]): number {
  switch (severity) {
    case "high":
      return 5;
    case "medium":
      return 3;
    default:
      return 1;
  }
}

export function computeMissionPhase(session: SessionRecord, mission: Mission): MissionPhase {
  if (mission.landedAt || mission.status === "landed" || mission.status === "completed") {
    return "postmortem";
  }

  const tasks = missionTasks(session, mission.id);
  const activeRepair = tasks.some(
    (task) =>
      task.nodeKind === "repair" &&
      (task.status === "pending" || task.status === "running" || task.status === "blocked")
  );
  if (activeRepair) {
    return "repairing";
  }

  if (mission.status === "planning") {
    return "simulating";
  }

  if (
    mission.status === "awaiting_acceptance" ||
    (mission.acceptance.status === "pending" &&
      tasks.length > 0 &&
      tasks.every((task) => task.status === "completed" || task.status === "failed"))
  ) {
    return "verifying";
  }

  if (mission.status === "ready_to_land") {
    return "landing";
  }

  if (tasks.length === 0 && !mission.planId && !mission.rootTaskId && !mission.planningTaskId) {
    return "specifying";
  }

  return "executing";
}

export function buildMissionSimulation(session: SessionRecord, mission: Mission): MissionSimulation {
  const tasks = missionTasks(session, mission.id);
  const planNodes = missionPlanNodes(session, mission);
  const openContracts = (session.contracts ?? []).filter(
    (contract) => contract.missionId === mission.id && contract.status === "open"
  );
  const issues: MissionSimulationIssue[] = [];
  const recommendations: string[] = [];
  const escalationReasons: string[] = [];
  const workstreams = mission.spec?.workstreamKinds ?? [];
  const acceptanceChecks = mission.acceptance.checks ?? [];
  const claimedPaths = unique(tasks.flatMap((task) => task.claimedPaths));
  const overlapPaths = missionHotspotPaths(session, mission.id);
  const gatePressure = mission.policy?.gatePolicy.length ?? 0;
  const attentionBudget = mission.policy?.operatorAttentionBudget ?? 6;
  const hasSharedContractWork =
    workstreams.includes("shared_contract") ||
    tasks.some((task) => task.nodeKind === "shared_contract") ||
    planNodes.some((node) => node.nodeKind === "shared_contract");
  const frontendAndBackend =
    workstreams.includes("frontend") &&
    workstreams.includes("backend");

  if (frontendAndBackend && !hasSharedContractWork) {
    issues.push({
      id: `sim-${randomUUID()}`,
      kind: "coordination",
      severity: "high",
      title: "Frontend/backend contract gap",
      detail: "Mission spans frontend and backend work without an explicit shared-contract workstream."
    });
    recommendations.push("Add or materialize a shared-contract node before deeper frontend/backend parallelism.");
  }

  const hasStrongVerification =
    acceptanceChecks.some((check) => check.kind === "command") ||
    acceptanceChecks.some((check) => check.kind === "http") ||
    acceptanceChecks.some((check) => check.kind === "browser");
  const hasPartialVerification =
    hasStrongVerification ||
    acceptanceChecks.some((check) => check.kind === "scenario" || check.kind === "contract" || check.kind === "file");
  if (!hasPartialVerification) {
    issues.push({
      id: `sim-${randomUUID()}`,
      kind: "verification",
      severity: "high",
      title: "Thin acceptance coverage",
      detail: "Mission has no generated executable verification path beyond operator review."
    });
    recommendations.push("Synthesize at least one command, http, browser, scenario, or contract check before landing.");
  } else if (!hasStrongVerification) {
    issues.push({
      id: `sim-${randomUUID()}`,
      kind: "verification",
      severity: "medium",
      title: "Partial acceptance coverage",
      detail: "Mission has lightweight acceptance checks but no stronger runtime-backed validation yet."
    });
    recommendations.push("Prefer at least one runtime-backed command/http/browser validation path if the mission is runnable.");
  }

  const nodes = planNodes.length > 0
    ? planNodes.map((node) => ({
        key: node.key,
        dependsOn: node.dependsOn,
        status: node.status
      }))
    : tasks.map((task) => ({
        key: task.id,
        dependsOn: task.dependsOnTaskIds,
        status: task.status
      }));
  const readyNodes = nodes.filter((node) =>
    node.status === "planned" ||
    node.status === "pending" ||
    node.status === "running"
  );
  const dependencyCounts = readyNodes.map((node) => node.dependsOn.length);
  const serialityScore =
    readyNodes.length === 0
      ? 0
      : Math.round(
          (dependencyCounts.reduce((total, count) => total + count, 0) / Math.max(1, readyNodes.length)) * 25
        );
  const estimatedParallelism =
    readyNodes.length === 0
      ? 1
      : Math.max(
          1,
          readyNodes.filter((node) => node.dependsOn.length === 0).length
        );
  if (readyNodes.length >= 4 && dependencyCounts.every((count) => count > 0)) {
    issues.push({
      id: `sim-${randomUUID()}`,
      kind: "seriality",
      severity: "medium",
      title: "Execution graph is highly serial",
      detail: "Most runnable work appears dependency-chained, which will slow down mission throughput."
    });
    recommendations.push("Split at least one node into a sidecar or follow-up lane to preserve parallelism.");
  }

  if (overlapPaths.length > 0) {
    issues.push({
      id: `sim-${randomUUID()}`,
      kind: "overlap",
      severity: "high",
      title: "Path overlap hotspots detected",
      detail: `Mission already carries overlapping ownership pressure at ${overlapPaths.join(", ")}.`
    });
    recommendations.push("Resolve overlap hotspots before enabling aggressive autopilot or landing.");
  }

  const attentionDrivers = [
    gatePressure,
    mission.risks?.length ?? 0,
    overlapPaths.length,
    tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
    openContracts.filter((contract) => contract.dependencyImpact === "blocking").length
  ];
  const attentionCost = attentionDrivers.reduce((total, value) => total + value, 0) +
    issues.reduce((total, issue) => total + severityWeight(issue.severity), 0);
  if (attentionCost > attentionBudget) {
    issues.push({
      id: `sim-${randomUUID()}`,
      kind: "attention",
      severity: "medium",
      title: "High operator attention cost",
      detail: `Mission is likely to interrupt the operator repeatedly unless contracts, verification, or overlaps are tightened. Budget=${attentionBudget}, projected=${attentionCost}.`
    });
    recommendations.push("Reduce operator load by tightening contracts, verification, and lane ownership before long unattended runs.");
    escalationReasons.push(`Projected attention cost ${attentionCost} exceeds budget ${attentionBudget}.`);
  }

  if (gatePressure >= 3) {
    escalationReasons.push(`Mission is carrying ${gatePressure} explicit gates.`);
  }
  if (openContracts.length > 0) {
    escalationReasons.push(`${openContracts.length} open typed contract(s) still need fulfillment.`);
  }
  if (overlapPaths.length > 0) {
    escalationReasons.push(`Ownership overlap exists at ${overlapPaths.join(", ")}.`);
  }
  if (!hasStrongVerification) {
    escalationReasons.push("Runtime-backed verification is not strong enough yet.");
  }

  const contractCoverage: MissionSimulation["contractCoverage"] =
    hasSharedContractWork
      ? "explicit"
      : frontendAndBackend || workstreams.includes("shared_contract")
      ? "partial"
      : "missing";
  const verificationCoverage: MissionSimulation["verificationCoverage"] =
    hasStrongVerification ? "strong" : hasPartialVerification ? "partial" : "thin";
  const escalationPressure: MissionSimulation["escalationPressure"] =
    attentionCost > attentionBudget + 3 ||
    issues.some((issue) => issue.severity === "high") ||
    openContracts.some((contract) => contract.dependencyImpact === "blocking")
      ? "high"
      : attentionCost > attentionBudget || issues.length >= 2
        ? "medium"
        : "low";
  const autopilotViable =
    escalationPressure !== "high" &&
    overlapPaths.length === 0 &&
    openContracts.filter((contract) => contract.dependencyImpact === "blocking").length === 0 &&
    verificationCoverage !== "thin";

  if (recommendations.length === 0) {
    recommendations.push("Mission simulation sees no major coordination gaps at the current level of detail.");
  }

  return {
    generatedAt: nowIso(),
    attentionCost,
    attentionBudget,
    gatePressure,
    serialityScore,
    contractRequestCount: openContracts.length,
    escalationPressure,
    escalationReasons: unique(escalationReasons),
    autopilotViable,
    estimatedParallelism,
    verificationCoverage,
    contractCoverage,
    issues,
    recommendations: unique(recommendations)
  };
}

function extractCommandsFromProgress(progress: TaskProgressEntry[]): string[] {
  const commands: string[] = [];
  for (const entry of progress) {
    const matches = entry.summary.match(/`([^`]+)`/g) ?? [];
    for (const match of matches) {
      const command = match.slice(1, -1).trim();
      if (command) {
        commands.push(command);
      }
    }
  }
  return unique(commands);
}

function extractVerificationEvidence(progress: TaskProgressEntry[], envelope: AgentTurnEnvelope | null): string[] {
  const evidence = progress
    .filter(
      (entry) =>
        entry.eventName === "verification" ||
        /verify|verification|test|passed|validated/i.test(entry.summary)
    )
    .map((entry) => normalizeText(entry.summary));
  if (envelope?.status === "completed" && /test|verify|validated/i.test(envelope.summary)) {
    evidence.push(normalizeText(envelope.summary));
  }
  return unique(evidence).slice(0, 8);
}

function summarizeAssumptions(task: TaskSpec, envelope: AgentTurnEnvelope | null): string[] {
  const assumptions: string[] = [];
  if (task.routeReason?.trim()) {
    assumptions.push(task.routeReason.trim());
  }
  if (envelope?.blockers.length) {
    assumptions.push(...envelope.blockers.map((item) => normalizeText(item)));
  }
  return unique(assumptions).slice(0, 8);
}

export function upsertMissionReceipt(
  session: SessionRecord,
  mission: Mission,
  task: TaskSpec,
  artifact: Pick<TaskArtifact, "progress" | "claimedPaths"> | null,
  envelope: AgentTurnEnvelope | null
): MissionReceipt {
  session.receipts = Array.isArray(session.receipts) ? session.receipts : [];
  mission.receiptIds = Array.isArray(mission.receiptIds) ? mission.receiptIds : [];
  const progress = artifact?.progress ?? [];
  const existing = session.receipts.find((receipt) => receipt.taskId === task.id && receipt.missionId === mission.id) ?? null;
  const receipt: MissionReceipt = {
    id: existing?.id ?? `receipt-${randomUUID()}`,
    missionId: mission.id,
    taskId: task.id,
    owner: task.owner,
    nodeKind: task.nodeKind,
    outcome: task.status === "failed" ? "failed" : task.status === "blocked" ? "blocked" : "completed",
    title: task.title,
    summary: task.summary ?? envelope?.summary ?? task.prompt,
    changedPaths: unique([...(artifact?.claimedPaths ?? []), ...task.claimedPaths]),
    commands: extractCommandsFromProgress(progress),
    verificationEvidence: extractVerificationEvidence(progress, envelope),
    assumptions: summarizeAssumptions(task, envelope),
    followUps: unique([
      ...(envelope?.peerMessages.map((message) => `${message.to}: ${message.subject}`) ?? []),
      task.nextRecommendation?.trim() ?? ""
    ]).slice(0, 8),
    risks: unique((mission.risks ?? []).map((risk) => risk.title)).slice(0, 8),
    createdAt: existing?.createdAt ?? nowIso()
  };

  if (existing) {
    const index = session.receipts.findIndex((item) => item.id === existing.id);
    session.receipts[index] = receipt;
  } else {
    session.receipts.push(receipt);
    mission.receiptIds.push(receipt.id);
  }

  return receipt;
}

function inferContractKind(intent: string, detail: string): AgentContractKind {
  const lower = `${intent} ${detail}`.toLowerCase();
  if (/review/.test(lower)) {
    return "request_review";
  }
  if (/verify|test|validation|acceptance/.test(lower)) {
    return "request_verification";
  }
  if (/risk|security|fragile|danger/.test(lower)) {
    return "request_risk_check";
  }
  if (/refine|polish|ui|frontend|copy|ux/.test(lower)) {
    return "request_refinement";
  }
  if (/stub|contract|schema|types|api/.test(lower)) {
    return "request_stub";
  }
  if (/handoff|context_share/.test(lower)) {
    return "handoff_complete";
  }
  return "request_contract";
}

function inferDependencyImpact(intent: string): AgentContract["dependencyImpact"] {
  return intent === "blocked" || intent === "question" ? "blocking" : "sidecar";
}

function inferUrgency(intent: string, detail: string): AgentContract["urgency"] {
  const lower = `${intent} ${detail}`.toLowerCase();
  if (/blocked|urgent|must|required/.test(lower)) {
    return "high";
  }
  if (/later|optional|nice to have/.test(lower)) {
    return "low";
  }
  return "normal";
}

function inferRecommendationTargetAgent(
  detail: string,
  sourceAgent: AgentName | "operator"
): AgentName | "operator" {
  const normalized = normalizeText(detail).toLowerCase();
  if (/\bcodex\b/.test(normalized)) {
    return "codex";
  }
  if (/\bclaude\b/.test(normalized)) {
    return "claude";
  }
  if (/\b(frontend|ui|ux|copy|visual|design)\b/.test(normalized)) {
    return "claude";
  }
  if (/\b(backend|api|schema|contract|types|verify|verification|test|tests|server|endpoint)\b/.test(normalized)) {
    return "codex";
  }
  return sourceAgent === "operator" ? "operator" : "operator";
}

function draftsOverlap(left: string, right: string): boolean {
  const a = normalizeText(left).toLowerCase();
  const b = normalizeText(right).toLowerCase();
  if (!a || !b) {
    return false;
  }
  return a.includes(b) || b.includes(a);
}

function hasDuplicateDraft(
  drafts: Array<{
    sourceMessageId: string | null;
    targetAgent: AgentName | "operator";
    kind: AgentContractKind;
    title: string;
    detail: string;
  }>,
  candidate: {
    sourceMessageId: string | null;
    targetAgent: AgentName | "operator";
    kind: AgentContractKind;
    title: string;
    detail: string;
  }
): boolean {
  return drafts.some((draft) =>
    draft.targetAgent === candidate.targetAgent &&
    draft.kind === candidate.kind &&
    (draftsOverlap(draft.title, candidate.title) ||
      draftsOverlap(draft.title, candidate.detail) ||
      draftsOverlap(draft.detail, candidate.title) ||
      draftsOverlap(draft.detail, candidate.detail))
  );
}

function contractAcceptance(messageTitle: string): string[] {
  return unique([
    `Fulfill the requested contract: ${messageTitle}.`,
    "Attach artifacts or changed paths that prove the contract was fulfilled."
  ]);
}

function existingContractForMessage(
  session: SessionRecord,
  missionId: string,
  sourceMessageId: string | null,
  sourceTaskId: string,
  kind: AgentContractKind
): AgentContract | null {
  return (session.contracts ?? []).find((contract) =>
    contract.missionId === missionId &&
    contract.sourceTaskId === sourceTaskId &&
    contract.kind === kind &&
    ((sourceMessageId && contract.sourceMessageId === sourceMessageId) ||
      (!sourceMessageId && contract.sourceMessageId === null))
  ) ?? null;
}

export function buildAgentContractTaskPrompt(contract: AgentContract): string {
  return [
    `Fulfill the open agent contract for ${contract.targetAgent}.`,
    `Contract id: ${contract.id}`,
    `Kind: ${contract.kind}`,
    `Source agent: ${contract.sourceAgent}`,
    `Title: ${contract.title}`,
    `Detail: ${contract.detail}`,
    contract.requiredArtifacts.length > 0
      ? `Required artifacts: ${contract.requiredArtifacts.join(", ")}`
      : null,
    contract.acceptanceExpectations.length > 0
      ? `Acceptance expectations: ${contract.acceptanceExpectations.join(" | ")}`
      : null,
    contract.claimedPaths.length > 0
      ? `Claimed paths: ${contract.claimedPaths.join(", ")}`
      : null,
    "Return a structured summary of what changed and how the contract was fulfilled."
  ].filter(Boolean).join("\n");
}

export function contractTaskNodeKind(contract: AgentContract): TaskSpec["nodeKind"] {
  switch (contract.kind) {
    case "request_review":
      return "review";
    case "request_verification":
      return "tests";
    case "request_refinement":
      return "frontend";
    case "request_stub":
    case "request_contract":
      return "shared_contract";
    case "request_risk_check":
      return "review";
    case "handoff_complete":
      return "integration";
    default:
      return null;
  }
}

export function buildAutoAppliedContractTask(
  contract: AgentContract,
  taskId: string,
  options: {
    routeReason: string;
    maxRetries: number;
  }
): TaskSpec {
  const nodeKind = contractTaskNodeKind(contract);
  return buildAdHocTask(contract.targetAgent === "operator" ? "codex" : contract.targetAgent, buildAgentContractTaskPrompt(contract), taskId, {
    missionId: contract.missionId,
    title: `Fulfill contract: ${contract.title}`,
    nodeKind,
    retryCount: 0,
    maxRetries: options.maxRetries,
    routeReason: options.routeReason,
    routeStrategy: "manual",
    routeConfidence: 1,
    routeMetadata: {
      source: "agent-contract",
      contractId: contract.id,
      sourceTaskId: contract.sourceTaskId,
      sourceMessageId: contract.sourceMessageId,
      missionId: contract.missionId,
      autopilotApplied: true,
      overnightApplied: true,
      nodeKind
    },
    claimedPaths: contract.claimedPaths
  });
}

export function upsertAgentContractsFromTask(
  session: SessionRecord,
  mission: Mission,
  task: TaskSpec,
  envelope: AgentTurnEnvelope | null
): AgentContract[] {
  session.contracts = Array.isArray(session.contracts) ? session.contracts : [];
  mission.contractIds = Array.isArray(mission.contractIds) ? mission.contractIds : [];
  const drafts: Array<{
    sourceMessageId: string | null;
    targetAgent: AgentName | "operator";
    kind: AgentContractKind;
    title: string;
    detail: string;
    requiredArtifacts: string[];
    acceptanceExpectations: string[];
    urgency: AgentContract["urgency"];
    dependencyImpact: AgentContract["dependencyImpact"];
    claimedPaths: string[];
  }> = [];

  for (const message of session.peerMessages.filter((item) => item.taskId === task.id)) {
    const detail = `${message.subject}\n${message.body}`;
    drafts.push({
      sourceMessageId: message.id,
      targetAgent: message.to,
      kind: inferContractKind(message.intent, detail),
      title: message.subject,
      detail: message.body,
      requiredArtifacts: unique([message.subject, ...task.claimedPaths]).slice(0, 8),
      acceptanceExpectations: contractAcceptance(message.subject),
      urgency: inferUrgency(message.intent, detail),
      dependencyImpact: inferDependencyImpact(message.intent),
      claimedPaths: task.claimedPaths
    });
  }

  const recommendation = task.nextRecommendation?.trim() ?? "";
  if (recommendation) {
    const targetAgent = inferRecommendationTargetAgent(recommendation, task.owner);
    const candidate = {
      sourceMessageId: null,
      targetAgent,
      kind: inferContractKind("next_recommendation", recommendation),
      title: `Follow-up from ${task.title}`,
      detail: recommendation,
      requiredArtifacts: task.claimedPaths,
      acceptanceExpectations: contractAcceptance(task.title),
      urgency: "normal",
      dependencyImpact: targetAgent === "operator" ? "sidecar" : "blocking",
      claimedPaths: task.claimedPaths
    };
    if (!hasDuplicateDraft(drafts, candidate)) {
      drafts.push(candidate);
    }
  }

  const created: AgentContract[] = [];
  for (const draft of drafts) {
    const existing = existingContractForMessage(
      session,
      mission.id,
      draft.sourceMessageId,
      task.id,
      draft.kind
    );
    const next: AgentContract = {
      id: existing?.id ?? `contract-${randomUUID()}`,
      missionId: mission.id,
      sourceTaskId: task.id,
      sourceMessageId: draft.sourceMessageId,
      sourceAgent: task.owner === "claude" || task.owner === "codex" ? task.owner : "codex",
      targetAgent: draft.targetAgent,
      kind: draft.kind,
      status: existing?.status === "resolved" ? "resolved" : "open",
      title: draft.title,
      detail: draft.detail,
      requiredArtifacts: draft.requiredArtifacts,
      acceptanceExpectations: draft.acceptanceExpectations,
      urgency: draft.urgency,
      dependencyImpact: draft.dependencyImpact,
      claimedPaths: draft.claimedPaths,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      resolvedAt: existing?.resolvedAt ?? null,
      resolvedByTaskId: existing?.resolvedByTaskId ?? null
    };
    if (existing) {
      const index = session.contracts.findIndex((item) => item.id === existing.id);
      session.contracts[index] = next;
      created.push(next);
    } else {
      session.contracts.push(next);
      mission.contractIds.push(next.id);
      created.push(next);
    }
  }

  return created;
}

export function resolveAgentContractsForTask(
  session: SessionRecord,
  task: TaskSpec
): AgentContract[] {
  session.contracts = Array.isArray(session.contracts) ? session.contracts : [];
  const sourceMessageId =
    typeof task.routeMetadata?.sourceMessageId === "string"
      ? task.routeMetadata.sourceMessageId
      : null;
  const sourceTaskId =
    typeof task.routeMetadata?.sourceTaskId === "string"
      ? task.routeMetadata.sourceTaskId
      : null;
  const resolved: AgentContract[] = [];

  for (const contract of session.contracts) {
    if (contract.status !== "open") {
      continue;
    }
    if (contract.missionId !== task.missionId) {
      continue;
    }
    if (contract.targetAgent !== task.owner) {
      continue;
    }

    const messageMatch = sourceMessageId && contract.sourceMessageId === sourceMessageId;
    const taskMatch = sourceTaskId && contract.sourceTaskId === sourceTaskId;
    const pathMatch =
      contract.claimedPaths.length > 0 &&
      task.claimedPaths.some((candidate) =>
        contract.claimedPaths.some((path) => pathsOverlap(candidate, path))
      );

    if (!messageMatch && !taskMatch && !pathMatch) {
      continue;
    }

    contract.status = "resolved";
    contract.updatedAt = nowIso();
    contract.resolvedAt = contract.updatedAt;
    contract.resolvedByTaskId = task.id;
    resolved.push(contract);
  }

  return resolved;
}

export function setAgentContractStatus(
  session: SessionRecord,
  contractId: string,
  status: AgentContract["status"],
  options: {
    resolvedByTaskId?: string | null;
  } = {}
): AgentContract | null {
  session.contracts = Array.isArray(session.contracts) ? session.contracts : [];
  const contract = session.contracts.find((item) => item.id === contractId) ?? null;
  if (!contract) {
    return null;
  }

  contract.status = status;
  contract.updatedAt = nowIso();
  if (status === "resolved") {
    contract.resolvedAt = contract.updatedAt;
    contract.resolvedByTaskId = options.resolvedByTaskId ?? contract.resolvedByTaskId ?? null;
  } else {
    contract.resolvedAt = null;
    contract.resolvedByTaskId = null;
  }
  return contract;
}

export function buildMissionPostmortem(
  session: SessionRecord,
  mission: Mission,
  artifacts: TaskArtifact[] = []
): MissionPostmortem {
  const receipts = (session.receipts ?? [])
    .filter((receipt) => receipt.missionId === mission.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const openContracts = (session.contracts ?? []).filter(
    (contract) => contract.missionId === mission.id && contract.status === "open"
  );
  const resolvedContracts = (session.contracts ?? []).filter(
    (contract) => contract.missionId === mission.id && contract.status === "resolved"
  );
  const failurePacks = mission.acceptance.failurePacks ?? [];
  const repairPlans = mission.acceptance.repairPlans ?? [];
  const receiptHighlights = receipts
    .slice(0, 5)
    .map((receipt) => `${receipt.owner}: ${receipt.title} | ${receipt.summary}`);
  const wins = unique([
    mission.acceptance.status === "passed" ? "Acceptance passed for the current mission state." : "",
    resolvedContracts.length > 0 ? `${resolvedContracts.length} agent contract(s) were fulfilled.` : "",
    ...receipts
      .filter((receipt) => receipt.outcome === "completed")
      .slice(0, 4)
      .map((receipt) => `${receipt.owner} completed ${receipt.title}.`)
  ]);
  const pains = unique([
    ...failurePacks.map((pack) => pack.summary),
    ...repairPlans
      .filter((plan) => plan.status !== "applied")
      .map((plan) => `Repair work remains around ${plan.summary}`),
    ...receipts
      .filter((receipt) => receipt.outcome !== "completed")
      .slice(0, 4)
      .map((receipt) => `${receipt.owner} ${receipt.outcome} ${receipt.title}.`)
  ]);
  const followUpDebt = unique([
    ...openContracts.map((contract) => `${contract.targetAgent}: ${contract.title}`),
    ...receipts.flatMap((receipt) => receipt.followUps)
  ]).slice(0, 8);
  const reinforcedPatterns = unique([
    ...(mission.appliedPatternIds ?? []).map((patternId) => `pattern:${patternId}`),
    ...receipts
      .flatMap((receipt) => receipt.commands)
      .slice(0, 6)
      .map((command) => `command:${command}`)
  ]);
  const antiPatterns = unique([
    ...failurePacks.flatMap((pack) => pack.repairFocus),
    ...artifacts
      .filter((artifact) => artifact.missionId === mission.id && artifact.error)
      .map((artifact) => artifact.error as string)
  ]).slice(0, 8);

  const outcome: MissionPostmortem["outcome"] =
    mission.landedAt || mission.status === "landed" || mission.status === "completed"
      ? "landed"
      : mission.acceptance.status === "failed" || pains.length > 0
        ? "failed"
        : "active";
  const summary =
    outcome === "landed"
      ? "Mission landed; this postmortem focuses on what worked, what hurt, and what should be reused."
      : outcome === "failed"
        ? "Mission still carries unresolved failures, debt, or repair work that should shape the next attempt."
        : "Mission is still active; this postmortem is an interim briefing rather than a final verdict.";

  return {
    missionId: mission.id,
    outcome,
    summary,
    wins,
    pains,
    followUpDebt,
    reinforcedPatterns,
    antiPatterns,
    receiptHighlights,
    generatedAt: nowIso()
  };
}
