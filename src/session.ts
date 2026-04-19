import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { appendEvent, readJson, writeJson, fileExists } from "./fs.ts";
import { EventHistory } from "./history.ts";
import { normalizeTaskSpecs } from "./normalize.ts";
import { nowIso } from "./paths.ts";
import { resolveSessionRuntime } from "./runtime.ts";
import type {
  AcceptanceCheck,
  AcceptancePack,
  AgentContract,
  AgentName,
  AgentStatus,
  AppPaths,
  BrainEntry,
  DecisionRecord,
  ExecutionPlan,
  EventRecord,
  KaviConfig,
  Mission,
  MissionCheckpoint,
  MissionReceipt,
  PathClaim,
  ProviderCapabilityManifest,
  ReviewNote,
  SessionRuntime,
  PeerMessage,
  SessionRecord,
  TaskSpec,
  WorktreeInfo
} from "./types.ts";

function initialAgentStatus(agent: AgentName, transport: string): AgentStatus {
  return {
    agent,
    available: true,
    transport,
    lastRunAt: null,
    lastExitCode: null,
    sessionId: null,
    summary: null
  };
}

export async function createSessionRecord(
  paths: AppPaths,
  config: KaviConfig,
  runtime: SessionRuntime,
  sessionId: string,
  baseCommit: string,
  worktrees: WorktreeInfo[],
  goal: string | null,
  rpcEndpoint: string,
  fullAccessMode = false,
  providerCapabilities: ProviderCapabilityManifest[] = []
): Promise<SessionRecord> {
  const timestamp = nowIso();
  const record: SessionRecord = {
    id: sessionId,
    repoRoot: paths.repoRoot,
    baseCommit,
    createdAt: timestamp,
    updatedAt: timestamp,
    socketPath: rpcEndpoint,
    status: "starting",
    goal,
    selectedMissionId: null,
    fullAccessMode,
    daemonPid: null,
    daemonHeartbeatAt: null,
    daemonVersion: null,
    protocolVersion: null,
    config,
    runtime,
    worktrees,
    tasks: [],
    plans: [],
    missions: [],
    receipts: [],
    contracts: [],
    brain: [],
    providerCapabilities,
    peerMessages: [],
    decisions: [],
    pathClaims: [],
    reviewNotes: [],
    recommendationStates: [],
    agentStatus: {
      codex: initialAgentStatus("codex", "codex-app-server"),
      claude: initialAgentStatus("claude", "claude-print")
    }
  };

  await writeJson(paths.stateFile, record);
  return record;
}

export async function loadSessionRecord(paths: AppPaths): Promise<SessionRecord> {
  const record = await readJson<SessionRecord>(paths.stateFile);
  if (!record.runtime) {
    record.runtime = await resolveSessionRuntime(paths);
  }
  record.fullAccessMode = record.fullAccessMode === true;
  record.selectedMissionId =
    typeof record.selectedMissionId === "string" && record.selectedMissionId.trim()
      ? record.selectedMissionId
      : null;
  record.daemonVersion =
    typeof record.daemonVersion === "string" && record.daemonVersion.trim()
      ? record.daemonVersion
      : null;
  record.protocolVersion =
    typeof record.protocolVersion === "number" && Number.isFinite(record.protocolVersion)
      ? record.protocolVersion
      : null;

  record.tasks = normalizeTaskSpecs(record.tasks);
  record.receipts = Array.isArray(record.receipts)
    ? record.receipts
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const receipt = item as Record<string, unknown>;
          return {
            id: String(receipt.id),
            missionId: String(receipt.missionId),
            taskId: String(receipt.taskId),
            owner: receipt.owner === "claude" || receipt.owner === "router" ? receipt.owner : "codex",
            nodeKind:
              receipt.nodeKind === "research" ||
              receipt.nodeKind === "scaffold" ||
              receipt.nodeKind === "backend" ||
              receipt.nodeKind === "frontend" ||
              receipt.nodeKind === "shared_contract" ||
              receipt.nodeKind === "infra" ||
              receipt.nodeKind === "tests" ||
              receipt.nodeKind === "docs" ||
              receipt.nodeKind === "review" ||
              receipt.nodeKind === "repair" ||
              receipt.nodeKind === "integration"
                ? receipt.nodeKind
                : null,
            outcome:
              receipt.outcome === "failed" || receipt.outcome === "blocked"
                ? receipt.outcome
                : "completed",
            title: typeof receipt.title === "string" ? receipt.title : "Mission receipt",
            summary: typeof receipt.summary === "string" ? receipt.summary : "",
            changedPaths: Array.isArray(receipt.changedPaths)
              ? receipt.changedPaths.map((value) => String(value))
              : [],
            commands: Array.isArray(receipt.commands)
              ? receipt.commands.map((value) => String(value))
              : [],
            verificationEvidence: Array.isArray(receipt.verificationEvidence)
              ? receipt.verificationEvidence.map((value) => String(value))
              : [],
            runtimeHighlights: Array.isArray(receipt.runtimeHighlights)
              ? receipt.runtimeHighlights.map((value) => String(value))
              : [],
            assumptions: Array.isArray(receipt.assumptions)
              ? receipt.assumptions.map((value) => String(value))
              : [],
            followUps: Array.isArray(receipt.followUps)
              ? receipt.followUps.map((value) => String(value))
              : [],
            risks: Array.isArray(receipt.risks)
              ? receipt.risks.map((value) => String(value))
              : [],
            createdAt: typeof receipt.createdAt === "string" ? receipt.createdAt : nowIso()
          } satisfies MissionReceipt;
        })
    : [];
  record.contracts = Array.isArray(record.contracts)
    ? record.contracts
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const contract = item as Record<string, unknown>;
          return {
            id: String(contract.id),
            missionId: String(contract.missionId),
            sourceTaskId: String(contract.sourceTaskId),
            sourceMessageId: typeof contract.sourceMessageId === "string" ? contract.sourceMessageId : null,
            sourceAgent: contract.sourceAgent === "claude" ? "claude" : "codex",
            targetAgent:
              contract.targetAgent === "claude" ||
              contract.targetAgent === "operator"
                ? contract.targetAgent
                : "codex",
            kind:
              contract.kind === "request_contract" ||
              contract.kind === "request_stub" ||
              contract.kind === "request_refinement" ||
              contract.kind === "request_review" ||
              contract.kind === "request_verification" ||
              contract.kind === "request_risk_check" ||
              contract.kind === "handoff_complete"
                ? contract.kind
                : "request_contract",
            status:
              contract.status === "resolved" || contract.status === "dismissed"
                ? contract.status
                : "open",
            title: typeof contract.title === "string" ? contract.title : "Agent contract",
            detail: typeof contract.detail === "string" ? contract.detail : "",
            requiredArtifacts: Array.isArray(contract.requiredArtifacts)
              ? contract.requiredArtifacts.map((value) => String(value))
              : [],
            acceptanceExpectations: Array.isArray(contract.acceptanceExpectations)
              ? contract.acceptanceExpectations.map((value) => String(value))
              : [],
            urgency:
              contract.urgency === "low" || contract.urgency === "high"
                ? contract.urgency
                : "normal",
            dependencyImpact: contract.dependencyImpact === "sidecar" ? "sidecar" : "blocking",
            claimedPaths: Array.isArray(contract.claimedPaths)
              ? contract.claimedPaths.map((value) => String(value))
              : [],
            createdAt: typeof contract.createdAt === "string" ? contract.createdAt : nowIso(),
            updatedAt: typeof contract.updatedAt === "string" ? contract.updatedAt : nowIso(),
            resolvedAt: typeof contract.resolvedAt === "string" ? contract.resolvedAt : null,
            resolvedByTaskId: typeof contract.resolvedByTaskId === "string" ? contract.resolvedByTaskId : null
          } satisfies AgentContract;
        })
    : [];
  record.plans = Array.isArray(record.plans)
    ? record.plans.map((plan) => ({
        id: String(plan.id),
        missionId: typeof plan.missionId === "string" ? plan.missionId : null,
        title: typeof plan.title === "string" ? plan.title : "Execution plan",
        sourcePrompt: typeof plan.sourcePrompt === "string" ? plan.sourcePrompt : "",
        sourceTaskId: typeof plan.sourceTaskId === "string" ? plan.sourceTaskId : null,
        planningMode: plan.planningMode === "kickoff" ? "kickoff" : "operator",
        plannerTaskId: typeof plan.plannerTaskId === "string" ? plan.plannerTaskId : "",
        summary: typeof plan.summary === "string" ? plan.summary : "",
        status:
          plan.status === "draft" ||
          plan.status === "completed" ||
          plan.status === "blocked"
            ? plan.status
            : "active",
        createdAt: typeof plan.createdAt === "string" ? plan.createdAt : nowIso(),
        updatedAt: typeof plan.updatedAt === "string" ? plan.updatedAt : nowIso(),
        nodes: Array.isArray(plan.nodes)
          ? plan.nodes.map((node) => ({
              key: String(node.key),
              taskId: typeof node.taskId === "string" ? node.taskId : null,
              title: typeof node.title === "string" ? node.title : "Planned task",
              owner: node.owner === "claude" ? "claude" : "codex",
              prompt: typeof node.prompt === "string" ? node.prompt : "",
              nodeKind:
                node.nodeKind === "research" ||
                node.nodeKind === "scaffold" ||
                node.nodeKind === "backend" ||
                node.nodeKind === "frontend" ||
                node.nodeKind === "shared_contract" ||
                node.nodeKind === "infra" ||
                node.nodeKind === "tests" ||
                node.nodeKind === "docs" ||
                node.nodeKind === "review" ||
                node.nodeKind === "repair" ||
                node.nodeKind === "integration"
                  ? node.nodeKind
                  : null,
              dependsOn: Array.isArray(node.dependsOn)
                ? node.dependsOn.map((item) => String(item))
                : [],
              claimedPaths: Array.isArray(node.claimedPaths)
                ? node.claimedPaths.map((item) => String(item))
                : [],
              reason: typeof node.reason === "string" ? node.reason : "",
              executionMode:
                node.executionMode === "blocking" ||
                node.executionMode === "follow_up"
                  ? node.executionMode
                  : "parallel",
              status:
                node.status === "pending" ||
                node.status === "running" ||
                node.status === "blocked" ||
                node.status === "completed" ||
                node.status === "failed"
                  ? node.status
                  : "planned"
            }))
          : []
      }) satisfies ExecutionPlan)
    : [];
  record.missions = Array.isArray(record.missions)
    ? record.missions
        .map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          const mission = value as Record<string, unknown>;
          const createdAt = typeof mission.createdAt === "string" ? mission.createdAt : nowIso();
          const normalizeCheck = (item: unknown): AcceptanceCheck | null => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return null;
            }
            const check = item as Record<string, unknown>;
            return {
              id: String(check.id),
              title: typeof check.title === "string" ? check.title : "Acceptance check",
              kind:
                check.kind === "manual" ||
                check.kind === "file" ||
                check.kind === "scenario" ||
                check.kind === "contract" ||
                check.kind === "docs" ||
                check.kind === "http" ||
                check.kind === "browser"
                  ? check.kind
                  : "command",
              command: typeof check.command === "string" ? check.command : null,
              path: typeof check.path === "string" ? check.path : null,
              harnessPath: typeof check.harnessPath === "string" ? check.harnessPath : null,
              serverCommand: typeof check.serverCommand === "string" ? check.serverCommand : null,
              target: typeof check.target === "string" ? check.target : null,
              urlPath: typeof check.urlPath === "string" ? check.urlPath : null,
              routeCandidates: Array.isArray(check.routeCandidates)
                ? check.routeCandidates.map((item) => String(item))
                : [],
              method: typeof check.method === "string" ? check.method : null,
              requestBody: typeof check.requestBody === "string" ? check.requestBody : null,
              requestHeaders:
                check.requestHeaders && typeof check.requestHeaders === "object" && !Array.isArray(check.requestHeaders)
                  ? Object.fromEntries(
                      Object.entries(check.requestHeaders as Record<string, unknown>).map(([key, value]) => [
                        key,
                        String(value)
                      ])
                    )
                  : {},
              selector: typeof check.selector === "string" ? check.selector : null,
              selectorCandidates: Array.isArray(check.selectorCandidates)
                ? check.selectorCandidates.map((item) => String(item))
                : [],
              expectedTitle: typeof check.expectedTitle === "string" ? check.expectedTitle : null,
              expectedStatus:
                typeof check.expectedStatus === "number" && Number.isFinite(check.expectedStatus)
                  ? check.expectedStatus
                  : null,
              expectedContentType:
                typeof check.expectedContentType === "string" ? check.expectedContentType : null,
              expectedJsonKeys: Array.isArray(check.expectedJsonKeys)
                ? check.expectedJsonKeys.map((item) => String(item))
                : [],
              evidencePaths: Array.isArray(check.evidencePaths)
                ? check.evidencePaths.map((item) => String(item))
                : [],
              expectedText: Array.isArray(check.expectedText)
                ? check.expectedText.map((item) => String(item))
                : [],
              likelyTaskIds: Array.isArray(check.likelyTaskIds)
                ? check.likelyTaskIds.map((item) => String(item))
                : [],
              likelyOwners: Array.isArray(check.likelyOwners)
                ? check.likelyOwners
                    .map((item) => (item === "claude" ? "claude" : item === "codex" ? "codex" : null))
                    .filter((item): item is AgentName => item !== null)
                : [],
              likelyReason: typeof check.likelyReason === "string" ? check.likelyReason : null,
              status:
                check.status === "passed" ||
                check.status === "failed" ||
                check.status === "skipped"
                  ? check.status
                  : "pending",
              detail: typeof check.detail === "string" ? check.detail : "",
              lastRunAt: typeof check.lastRunAt === "string" ? check.lastRunAt : null,
              lastOutput: typeof check.lastOutput === "string" ? check.lastOutput : null
            };
          };
          const normalizeAcceptance = (input: unknown): AcceptancePack => {
            const acceptance =
              input && typeof input === "object" && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {};
            return {
              id: typeof acceptance.id === "string" ? acceptance.id : `accept-${randomUUID()}`,
              summary:
                typeof acceptance.summary === "string" ? acceptance.summary : "Mission acceptance pack",
              criteria: Array.isArray(acceptance.criteria)
                ? acceptance.criteria.map((item) => String(item))
                : [],
              checks: Array.isArray(acceptance.checks)
                ? acceptance.checks
                    .map((item) => normalizeCheck(item))
                    .filter((item): item is AcceptanceCheck => item !== null)
                : [],
              failurePacks: Array.isArray(acceptance.failurePacks)
                ? acceptance.failurePacks
                    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                    .map((item) => {
                      const pack = item as Record<string, unknown>;
                      return {
                        id: typeof pack.id === "string" ? pack.id : `failure-${randomUUID()}`,
                        missionId: typeof pack.missionId === "string" ? pack.missionId : "",
                        checkId: typeof pack.checkId === "string" ? pack.checkId : "",
                        kind:
                          pack.kind === "command" ||
                          pack.kind === "file" ||
                          pack.kind === "docs" ||
                          pack.kind === "scenario" ||
                          pack.kind === "contract" ||
                          pack.kind === "http" ||
                          pack.kind === "browser"
                            ? pack.kind
                            : "command",
                        title: typeof pack.title === "string" ? pack.title : "Acceptance failure",
                        summary: typeof pack.summary === "string" ? pack.summary : "",
                        expected: Array.isArray(pack.expected) ? pack.expected.map((value) => String(value)) : [],
                        observed: Array.isArray(pack.observed) ? pack.observed.map((value) => String(value)) : [],
                        evidence: Array.isArray(pack.evidence) ? pack.evidence.map((value) => String(value)) : [],
                        likelyOwners: Array.isArray(pack.likelyOwners)
                          ? pack.likelyOwners.filter((value): value is AgentName => value === "codex" || value === "claude")
                          : [],
                        likelyTaskIds: Array.isArray(pack.likelyTaskIds)
                          ? pack.likelyTaskIds.map((value) => String(value))
                          : [],
                        attribution: typeof pack.attribution === "string" ? pack.attribution : null,
                        repairFocus: Array.isArray(pack.repairFocus) ? pack.repairFocus.map((value) => String(value)) : [],
                        command: typeof pack.command === "string" ? pack.command : null,
                        harnessPath: typeof pack.harnessPath === "string" ? pack.harnessPath : null,
                        serverCommand: typeof pack.serverCommand === "string" ? pack.serverCommand : null,
                        request:
                          pack.request && typeof pack.request === "object" && !Array.isArray(pack.request)
                            ? {
                                method: typeof (pack.request as Record<string, unknown>).method === "string" ? String((pack.request as Record<string, unknown>).method) : null,
                                urlPath: typeof (pack.request as Record<string, unknown>).urlPath === "string" ? String((pack.request as Record<string, unknown>).urlPath) : null,
                                routeCandidates: Array.isArray((pack.request as Record<string, unknown>).routeCandidates)
                                  ? ((pack.request as Record<string, unknown>).routeCandidates as unknown[]).map((value) => String(value))
                                  : [],
                                headers:
                                  (pack.request as Record<string, unknown>).headers &&
                                  typeof (pack.request as Record<string, unknown>).headers === "object" &&
                                  !Array.isArray((pack.request as Record<string, unknown>).headers)
                                    ? Object.fromEntries(
                                        Object.entries((pack.request as Record<string, unknown>).headers as Record<string, unknown>)
                                          .map(([key, value]) => [key, String(value)])
                                      )
                                    : {},
                                body: typeof (pack.request as Record<string, unknown>).body === "string" ? String((pack.request as Record<string, unknown>).body) : null,
                                selector: typeof (pack.request as Record<string, unknown>).selector === "string" ? String((pack.request as Record<string, unknown>).selector) : null,
                                selectorCandidates: Array.isArray((pack.request as Record<string, unknown>).selectorCandidates)
                                  ? ((pack.request as Record<string, unknown>).selectorCandidates as unknown[]).map((value) => String(value))
                                  : []
                              }
                            : {
                                method: null,
                                urlPath: null,
                                routeCandidates: [],
                                headers: {},
                                body: null,
                                selector: null,
                                selectorCandidates: []
                              },
                        expectedSignals:
                          pack.expectedSignals && typeof pack.expectedSignals === "object" && !Array.isArray(pack.expectedSignals)
                            ? {
                                title: typeof (pack.expectedSignals as Record<string, unknown>).title === "string" ? String((pack.expectedSignals as Record<string, unknown>).title) : null,
                                status:
                                  typeof (pack.expectedSignals as Record<string, unknown>).status === "number" &&
                                  Number.isFinite((pack.expectedSignals as Record<string, unknown>).status)
                                    ? Number((pack.expectedSignals as Record<string, unknown>).status)
                                    : null,
                                contentType: typeof (pack.expectedSignals as Record<string, unknown>).contentType === "string" ? String((pack.expectedSignals as Record<string, unknown>).contentType) : null,
                                text: Array.isArray((pack.expectedSignals as Record<string, unknown>).text)
                                  ? ((pack.expectedSignals as Record<string, unknown>).text as unknown[]).map((value) => String(value))
                                  : [],
                                jsonKeys: Array.isArray((pack.expectedSignals as Record<string, unknown>).jsonKeys)
                                  ? ((pack.expectedSignals as Record<string, unknown>).jsonKeys as unknown[]).map((value) => String(value))
                                  : []
                              }
                            : {
                                title: null,
                                status: null,
                                contentType: null,
                                text: [],
                                jsonKeys: []
                              },
                        runtimeCapture:
                          pack.runtimeCapture && typeof pack.runtimeCapture === "object" && !Array.isArray(pack.runtimeCapture)
                            ? {
                                detail: typeof (pack.runtimeCapture as Record<string, unknown>).detail === "string" ? String((pack.runtimeCapture as Record<string, unknown>).detail) : "",
                                lastOutput: typeof (pack.runtimeCapture as Record<string, unknown>).lastOutput === "string" ? String((pack.runtimeCapture as Record<string, unknown>).lastOutput) : ""
                              }
                            : {
                                detail: typeof pack.detail === "string" ? pack.detail : "",
                                lastOutput: typeof pack.lastOutput === "string" ? pack.lastOutput : ""
                              },
                        createdAt: typeof pack.createdAt === "string" ? pack.createdAt : createdAt,
                        updatedAt: typeof pack.updatedAt === "string" ? pack.updatedAt : createdAt
                      };
                    })
                : [],
              repairPlans: Array.isArray(acceptance.repairPlans)
                ? acceptance.repairPlans
                    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                    .map((item) => {
                      const plan = item as Record<string, unknown>;
                      return {
                        id: typeof plan.id === "string" ? plan.id : `repair-${randomUUID()}`,
                        missionId: typeof plan.missionId === "string" ? plan.missionId : "",
                        title: typeof plan.title === "string" ? plan.title : "Acceptance repair plan",
                        owner: plan.owner === "claude" ? "claude" : "codex",
                        status:
                          plan.status === "queued" || plan.status === "applied"
                            ? plan.status
                            : "proposed",
                        failureFingerprint: typeof plan.failureFingerprint === "string" ? plan.failureFingerprint : "",
                        failedCheckIds: Array.isArray(plan.failedCheckIds) ? plan.failedCheckIds.map((value) => String(value)) : [],
                        failurePackIds: Array.isArray(plan.failurePackIds) ? plan.failurePackIds.map((value) => String(value)) : [],
                        summary: typeof plan.summary === "string" ? plan.summary : "",
                        prompt: typeof plan.prompt === "string" ? plan.prompt : "",
                        routeReason: typeof plan.routeReason === "string" ? plan.routeReason : "",
                        routeStrategy:
                          plan.routeStrategy === "path-claim" ||
                          plan.routeStrategy === "keyword" ||
                          plan.routeStrategy === "manual" ||
                          plan.routeStrategy === "owner-path" ||
                          plan.routeStrategy === "ai" ||
                          plan.routeStrategy === "fallback"
                            ? plan.routeStrategy
                            : "fallback",
                        routeConfidence:
                          typeof plan.routeConfidence === "number" && Number.isFinite(plan.routeConfidence)
                            ? Math.max(0, Math.min(1, plan.routeConfidence))
                            : 0.5,
                        claimedPaths: Array.isArray(plan.claimedPaths) ? plan.claimedPaths.map((value) => String(value)) : [],
                        likelyOwners: Array.isArray(plan.likelyOwners)
                          ? plan.likelyOwners.filter((value): value is AgentName => value === "codex" || value === "claude")
                          : [],
                        likelyTaskIds: Array.isArray(plan.likelyTaskIds) ? plan.likelyTaskIds.map((value) => String(value)) : [],
                        repairFocus: Array.isArray(plan.repairFocus) ? plan.repairFocus.map((value) => String(value)) : [],
                        evidence: Array.isArray(plan.evidence) ? plan.evidence.map((value) => String(value)) : [],
                        createdAt: typeof plan.createdAt === "string" ? plan.createdAt : createdAt,
                        updatedAt: typeof plan.updatedAt === "string" ? plan.updatedAt : createdAt,
                        queuedTaskId: typeof plan.queuedTaskId === "string" ? plan.queuedTaskId : null
                      };
                    })
                : [],
              status:
                acceptance.status === "passed" || acceptance.status === "failed"
                  ? acceptance.status
                  : "pending",
              createdAt:
                typeof acceptance.createdAt === "string" ? acceptance.createdAt : createdAt,
              updatedAt:
                typeof acceptance.updatedAt === "string" ? acceptance.updatedAt : createdAt
            };
          };
          const normalizeCheckpoint = (item: unknown): MissionCheckpoint | null => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return null;
            }
            const checkpoint = item as Record<string, unknown>;
            return {
              id: String(checkpoint.id),
              kind:
                checkpoint.kind === "planning_started" ||
                checkpoint.kind === "plan_materialized" ||
                checkpoint.kind === "task_started" ||
                checkpoint.kind === "task_progress" ||
                checkpoint.kind === "task_stalled" ||
                checkpoint.kind === "task_retried" ||
                checkpoint.kind === "task_recovered" ||
                checkpoint.kind === "repair_queued" ||
                checkpoint.kind === "task_completed" ||
                checkpoint.kind === "task_failed" ||
                checkpoint.kind === "acceptance_verified" ||
                checkpoint.kind === "landed"
                  ? checkpoint.kind
                  : "created",
              title: typeof checkpoint.title === "string" ? checkpoint.title : "Mission event",
              detail: typeof checkpoint.detail === "string" ? checkpoint.detail : "",
              taskId: typeof checkpoint.taskId === "string" ? checkpoint.taskId : null,
              createdAt:
                typeof checkpoint.createdAt === "string" ? checkpoint.createdAt : createdAt
            };
          };
          const missionSpec =
            mission.spec && typeof mission.spec === "object" && !Array.isArray(mission.spec)
              ? (mission.spec as Record<string, unknown>)
              : null;
          const missionContract =
            mission.contract && typeof mission.contract === "object" && !Array.isArray(mission.contract)
              ? (mission.contract as Record<string, unknown>)
              : null;
          const missionPolicy =
            mission.policy && typeof mission.policy === "object" && !Array.isArray(mission.policy)
              ? (mission.policy as Record<string, unknown>)
              : null;
          const missionBlueprint =
            mission.blueprint && typeof mission.blueprint === "object" && !Array.isArray(mission.blueprint)
              ? (mission.blueprint as Record<string, unknown>)
              : null;
          const missionHealth =
            mission.health && typeof mission.health === "object" && !Array.isArray(mission.health)
              ? (mission.health as Record<string, unknown>)
              : null;
          const missionRisks = Array.isArray(mission.risks)
            ? mission.risks
                .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                .map((item) => {
                  const risk = item as Record<string, unknown>;
                  return {
                    id: typeof risk.id === "string" ? risk.id : `risk-${randomUUID()}`,
                    title: typeof risk.title === "string" ? risk.title : "Mission risk",
                    detail: typeof risk.detail === "string" ? risk.detail : "",
                    severity:
                      risk.severity === "low" || risk.severity === "high" ? risk.severity : "medium",
                    mitigation: typeof risk.mitigation === "string" ? risk.mitigation : ""
                  };
                })
            : [];
          const missionAnchors = Array.isArray(mission.anchors)
            ? mission.anchors
                .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                .map((item) => {
                  const anchor = item as Record<string, unknown>;
                  return {
                    id: typeof anchor.id === "string" ? anchor.id : `anchor-${randomUUID()}`,
                    kind:
                      anchor.kind === "architecture" ||
                      anchor.kind === "acceptance" ||
                      anchor.kind === "progress"
                        ? anchor.kind
                        : "intent",
                    title: typeof anchor.title === "string" ? anchor.title : "Mission anchor",
                    summary: typeof anchor.summary === "string" ? anchor.summary : "",
                    createdAt: typeof anchor.createdAt === "string" ? anchor.createdAt : createdAt
                  };
                })
            : [];

          return {
            id: String(mission.id),
            packetVersion:
              typeof mission.packetVersion === "number" && Number.isFinite(mission.packetVersion)
                ? Math.max(1, Math.trunc(mission.packetVersion))
                : 1,
            title: typeof mission.title === "string" ? mission.title : "Mission",
            prompt: typeof mission.prompt === "string" ? mission.prompt : "",
            goal: typeof mission.goal === "string" ? mission.goal : null,
            mode:
              mission.mode === "inspect" || mission.mode === "manual"
                ? mission.mode
                : "guided_autopilot",
            status:
              mission.status === "active" ||
              mission.status === "blocked" ||
              mission.status === "awaiting_acceptance" ||
              mission.status === "ready_to_land" ||
              mission.status === "landed" ||
              mission.status === "completed"
                ? mission.status
                : "planning",
            summary: typeof mission.summary === "string" ? mission.summary : "",
            shadowOfMissionId:
              typeof mission.shadowOfMissionId === "string" ? mission.shadowOfMissionId : null,
            planningTaskId: typeof mission.planningTaskId === "string" ? mission.planningTaskId : null,
            planId: typeof mission.planId === "string" ? mission.planId : null,
            rootTaskId: typeof mission.rootTaskId === "string" ? mission.rootTaskId : null,
            activeTaskIds: Array.isArray(mission.activeTaskIds)
              ? mission.activeTaskIds.map((item) => String(item))
              : [],
            autopilotEnabled: mission.autopilotEnabled !== false,
            phase:
              mission.phase === "specifying" ||
              mission.phase === "simulating" ||
              mission.phase === "executing" ||
              mission.phase === "repairing" ||
              mission.phase === "verifying" ||
              mission.phase === "landing" ||
              mission.phase === "postmortem"
                ? mission.phase
                : undefined,
            spec: missionSpec
              ? {
                  normalizedPrompt:
                    typeof missionSpec.normalizedPrompt === "string"
                      ? missionSpec.normalizedPrompt
                      : (typeof mission.prompt === "string" ? mission.prompt : ""),
                  audience: typeof missionSpec.audience === "string" ? missionSpec.audience : null,
                  repoShape:
                    missionSpec.repoShape === "greenfield" || missionSpec.repoShape === "existing"
                      ? missionSpec.repoShape
                      : "unknown",
                  workstreamKinds: Array.isArray(missionSpec.workstreamKinds)
                    ? missionSpec.workstreamKinds.map((item) => String(item))
                    : [],
                  stackHints: Array.isArray(missionSpec.stackHints)
                    ? missionSpec.stackHints.map((item) => String(item))
                    : [],
                  requestedDeliverables: Array.isArray(missionSpec.requestedDeliverables)
                    ? missionSpec.requestedDeliverables.map((item) => String(item))
                    : [],
                  userRoles: Array.isArray(missionSpec.userRoles)
                    ? missionSpec.userRoles.map((item) => String(item))
                    : [],
                  domainEntities: Array.isArray(missionSpec.domainEntities)
                    ? missionSpec.domainEntities.map((item) => String(item))
                    : [],
                  constraints: Array.isArray(missionSpec.constraints)
                    ? missionSpec.constraints.map((item) => String(item))
                    : []
                }
              : undefined,
            contract: missionContract
              ? {
                  acceptanceCriteria: Array.isArray(missionContract.acceptanceCriteria)
                    ? missionContract.acceptanceCriteria.map((item) => String(item))
                    : [],
                  scenarios: Array.isArray(missionContract.scenarios)
                    ? missionContract.scenarios.map((item) => String(item))
                    : [],
                  qualityBars: Array.isArray(missionContract.qualityBars)
                    ? missionContract.qualityBars.map((item) => String(item))
                    : [],
                  docsExpectations: Array.isArray(missionContract.docsExpectations)
                    ? missionContract.docsExpectations.map((item) => String(item))
                    : []
                }
              : undefined,
            blueprint: missionBlueprint
              ? {
                  overview: typeof missionBlueprint.overview === "string" ? missionBlueprint.overview : "",
                  productConcept:
                    typeof missionBlueprint.productConcept === "string" ? missionBlueprint.productConcept : "",
                  personas: Array.isArray(missionBlueprint.personas)
                    ? missionBlueprint.personas.map((item) => String(item))
                    : [],
                  domainModel: Array.isArray(missionBlueprint.domainModel)
                    ? missionBlueprint.domainModel.map((item) => String(item))
                    : [],
                  serviceBoundaries: Array.isArray(missionBlueprint.serviceBoundaries)
                    ? missionBlueprint.serviceBoundaries.map((item) => String(item))
                    : [],
                  uiSurfaces: Array.isArray(missionBlueprint.uiSurfaces)
                    ? missionBlueprint.uiSurfaces.map((item) => String(item))
                    : [],
                  acceptanceJourneys: Array.isArray(missionBlueprint.acceptanceJourneys)
                    ? missionBlueprint.acceptanceJourneys.map((item) => String(item))
                    : [],
                  architectureNotes: Array.isArray(missionBlueprint.architectureNotes)
                    ? missionBlueprint.architectureNotes.map((item) => String(item))
                    : []
                }
              : undefined,
            policy: missionPolicy
              ? {
                  autonomyLevel:
                    missionPolicy.autonomyLevel === "inspect" ||
                    missionPolicy.autonomyLevel === "autonomous" ||
                    missionPolicy.autonomyLevel === "overnight"
                      ? missionPolicy.autonomyLevel
                      : "guided",
                  approvalMode: missionPolicy.approvalMode === "approve_all" ? "approve_all" : "standard",
                  retryBudget:
                    typeof missionPolicy.retryBudget === "number" && Number.isFinite(missionPolicy.retryBudget)
                      ? missionPolicy.retryBudget
                      : 1,
                  operatorAttentionBudget:
                    typeof missionPolicy.operatorAttentionBudget === "number" && Number.isFinite(missionPolicy.operatorAttentionBudget)
                      ? Math.max(0, Math.trunc(missionPolicy.operatorAttentionBudget))
                      : 6,
                  escalationPolicy:
                    missionPolicy.escalationPolicy === "strict" || missionPolicy.escalationPolicy === "aggressive"
                      ? missionPolicy.escalationPolicy
                      : "balanced",
                  verificationMode: missionPolicy.verificationMode === "strict" ? "strict" : "standard",
                  landPolicy: missionPolicy.landPolicy === "manual_review" ? "manual_review" : "acceptance_gated",
                  gatePolicy: Array.isArray(missionPolicy.gatePolicy)
                    ? missionPolicy.gatePolicy.map((item) => String(item))
                    : [],
                  autoAdvance: missionPolicy.autoAdvance !== false,
                  autoVerify: missionPolicy.autoVerify !== false,
                  autoLand: missionPolicy.autoLand === true,
                  pauseOnRepairFailure: missionPolicy.pauseOnRepairFailure !== false
                }
              : undefined,
            risks: missionRisks,
            anchors: missionAnchors,
            health: missionHealth
              ? {
                  score:
                    typeof missionHealth.score === "number" && Number.isFinite(missionHealth.score)
                      ? missionHealth.score
                      : 100,
                  state:
                    missionHealth.state === "watch" || missionHealth.state === "blocked"
                      ? missionHealth.state
                      : "healthy",
                  reasons: Array.isArray(missionHealth.reasons)
                    ? missionHealth.reasons.map((item) => String(item))
                    : [],
                  updatedAt: typeof missionHealth.updatedAt === "string" ? missionHealth.updatedAt : createdAt
                }
              : undefined,
            specRevisions: Array.isArray(mission.specRevisions)
              ? mission.specRevisions
                  .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                  .map((item) => {
                    const revision = item as Record<string, unknown>;
                    return {
                      id: typeof revision.id === "string" ? revision.id : `spec-revision-${randomUUID()}`,
                      version:
                        typeof revision.version === "number" && Number.isFinite(revision.version)
                          ? Math.max(1, Math.trunc(revision.version))
                          : 1,
                      summary: typeof revision.summary === "string" ? revision.summary : "Mission spec revision",
                      prompt: typeof revision.prompt === "string" ? revision.prompt : "",
                      sourceTaskId: typeof revision.sourceTaskId === "string" ? revision.sourceTaskId : null,
                      createdAt: typeof revision.createdAt === "string" ? revision.createdAt : createdAt
                    };
                  })
              : [],
            simulation:
              mission.simulation && typeof mission.simulation === "object" && !Array.isArray(mission.simulation)
                ? {
                    generatedAt:
                      typeof (mission.simulation as Record<string, unknown>).generatedAt === "string"
                        ? String((mission.simulation as Record<string, unknown>).generatedAt)
                        : createdAt,
                    attentionCost:
                      typeof (mission.simulation as Record<string, unknown>).attentionCost === "number"
                        ? Number((mission.simulation as Record<string, unknown>).attentionCost)
                        : 0,
                    attentionBudget:
                      typeof (mission.simulation as Record<string, unknown>).attentionBudget === "number"
                        ? Number((mission.simulation as Record<string, unknown>).attentionBudget)
                        : 6,
                    gatePressure:
                      typeof (mission.simulation as Record<string, unknown>).gatePressure === "number"
                        ? Number((mission.simulation as Record<string, unknown>).gatePressure)
                        : 0,
                    serialityScore:
                      typeof (mission.simulation as Record<string, unknown>).serialityScore === "number"
                        ? Number((mission.simulation as Record<string, unknown>).serialityScore)
                        : 0,
                    contractRequestCount:
                      typeof (mission.simulation as Record<string, unknown>).contractRequestCount === "number"
                        ? Number((mission.simulation as Record<string, unknown>).contractRequestCount)
                        : 0,
                    escalationPressure:
                      (mission.simulation as Record<string, unknown>).escalationPressure === "high" ||
                      (mission.simulation as Record<string, unknown>).escalationPressure === "medium"
                        ? ((mission.simulation as Record<string, unknown>).escalationPressure as "high" | "medium")
                        : "low",
                    escalationReasons: Array.isArray((mission.simulation as Record<string, unknown>).escalationReasons)
                      ? ((mission.simulation as Record<string, unknown>).escalationReasons as unknown[]).map((item) => String(item))
                      : [],
                    autopilotViable: (mission.simulation as Record<string, unknown>).autopilotViable !== false,
                    estimatedParallelism:
                      typeof (mission.simulation as Record<string, unknown>).estimatedParallelism === "number"
                        ? Number((mission.simulation as Record<string, unknown>).estimatedParallelism)
                        : 1,
                    verificationCoverage:
                      (mission.simulation as Record<string, unknown>).verificationCoverage === "strong" ||
                      (mission.simulation as Record<string, unknown>).verificationCoverage === "partial"
                        ? ((mission.simulation as Record<string, unknown>).verificationCoverage as "strong" | "partial")
                        : "thin",
                    contractCoverage:
                      (mission.simulation as Record<string, unknown>).contractCoverage === "explicit" ||
                      (mission.simulation as Record<string, unknown>).contractCoverage === "partial"
                        ? ((mission.simulation as Record<string, unknown>).contractCoverage as "explicit" | "partial")
                        : "missing",
                    issues: Array.isArray((mission.simulation as Record<string, unknown>).issues)
                      ? ((mission.simulation as Record<string, unknown>).issues as unknown[])
                          .filter((item) => item && typeof item === "object" && !Array.isArray(item))
                          .map((item) => {
                            const issue = item as Record<string, unknown>;
                            return {
                              id: typeof issue.id === "string" ? issue.id : `sim-${randomUUID()}`,
                              kind:
                                issue.kind === "coordination" ||
                                issue.kind === "verification" ||
                                issue.kind === "seriality" ||
                                issue.kind === "attention" ||
                                issue.kind === "overlap"
                                  ? issue.kind
                                  : "attention",
                              severity:
                                issue.severity === "low" || issue.severity === "high"
                                  ? issue.severity
                                  : "medium",
                              title: typeof issue.title === "string" ? issue.title : "Mission simulation issue",
                              detail: typeof issue.detail === "string" ? issue.detail : ""
                            };
                          })
                      : [],
                    recommendations: Array.isArray((mission.simulation as Record<string, unknown>).recommendations)
                      ? ((mission.simulation as Record<string, unknown>).recommendations as unknown[]).map((item) => String(item))
                      : []
                  }
                : undefined,
            appliedPatternIds: Array.isArray(mission.appliedPatternIds)
              ? mission.appliedPatternIds.map((item) => String(item))
              : [],
            receiptIds: Array.isArray(mission.receiptIds)
              ? mission.receiptIds.map((item) => String(item))
              : [],
            contractIds: Array.isArray(mission.contractIds)
              ? mission.contractIds.map((item) => String(item))
              : [],
            acceptance: normalizeAcceptance(mission.acceptance),
            checkpoints: Array.isArray(mission.checkpoints)
              ? mission.checkpoints
                  .map((item) => normalizeCheckpoint(item))
                  .filter((item): item is MissionCheckpoint => item !== null)
              : [],
            brainEntryIds: Array.isArray(mission.brainEntryIds)
              ? mission.brainEntryIds.map((item) => String(item))
              : [],
            createdAt,
            updatedAt: typeof mission.updatedAt === "string" ? mission.updatedAt : createdAt,
            landedAt: typeof mission.landedAt === "string" ? mission.landedAt : null
          } satisfies Mission;
        })
        .filter((item): item is Mission => item !== null)
    : [];
  if (
    record.selectedMissionId &&
    !record.missions.some((mission) => mission.id === record.selectedMissionId)
  ) {
    record.selectedMissionId = null;
  }
  record.brain = Array.isArray(record.brain)
    ? record.brain
        .map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          const entry = value as Record<string, unknown>;
          const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : nowIso();
          return {
            id: String(entry.id),
            missionId: typeof entry.missionId === "string" ? entry.missionId : null,
            taskId: typeof entry.taskId === "string" ? entry.taskId : null,
            sourceType:
              entry.sourceType === "mission" ||
              entry.sourceType === "landing" ||
              entry.sourceType === "operator" ||
              entry.sourceType === "pattern"
                ? entry.sourceType
              : "task",
            category:
              entry.category === "fact" ||
              entry.category === "decision" ||
              entry.category === "procedure" ||
              entry.category === "risk" ||
              entry.category === "topology" ||
              entry.category === "contract" ||
              entry.category === "failure" ||
              entry.category === "verification"
                ? entry.category
                : "artifact",
            scope:
              entry.scope === "repo" ||
              entry.scope === "personal" ||
              entry.scope === "pattern"
                ? entry.scope
                : "mission",
            title: typeof entry.title === "string" ? entry.title : "Brain entry",
            content: typeof entry.content === "string" ? entry.content : "",
            tags: Array.isArray(entry.tags) ? entry.tags.map((item) => String(item)) : [],
            confidence:
              typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
                ? Math.max(0, Math.min(1, entry.confidence))
                : 0.6,
            freshness:
              entry.freshness === "live" || entry.freshness === "stale"
                ? entry.freshness
                : "recent",
            evidence: Array.isArray(entry.evidence) ? entry.evidence.map((item) => String(item)) : [],
            commands: Array.isArray(entry.commands) ? entry.commands.map((item) => String(item)) : [],
            supersedes: Array.isArray(entry.supersedes) ? entry.supersedes.map((item) => String(item)) : [],
            supersededBy: typeof entry.supersededBy === "string" ? entry.supersededBy : null,
            contradictions: Array.isArray(entry.contradictions)
              ? entry.contradictions.map((item) => String(item))
              : [],
            retiredAt: typeof entry.retiredAt === "string" ? entry.retiredAt : null,
            pinned: entry.pinned === true,
            createdAt,
            updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : createdAt
          } satisfies BrainEntry;
        })
        .filter((item): item is BrainEntry => item !== null)
    : [];
  record.providerCapabilities = Array.isArray(record.providerCapabilities)
    ? record.providerCapabilities
        .map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          const manifest = value as Record<string, unknown>;
          return {
            provider:
              manifest.provider === "claude" || manifest.provider === "node"
                ? manifest.provider
                : "codex",
            version: typeof manifest.version === "string" ? manifest.version : null,
            transport: typeof manifest.transport === "string" ? manifest.transport : null,
            status:
              manifest.status === "degraded" || manifest.status === "unsupported"
                ? manifest.status
                : "ok",
            capabilities: Array.isArray(manifest.capabilities)
              ? manifest.capabilities.map((item) => String(item))
              : [],
            warnings: Array.isArray(manifest.warnings)
              ? manifest.warnings.map((item) => String(item))
              : [],
            errors: Array.isArray(manifest.errors)
              ? manifest.errors.map((item) => String(item))
              : [],
            checkedAt: typeof manifest.checkedAt === "string" ? manifest.checkedAt : nowIso()
          } satisfies ProviderCapabilityManifest;
        })
        .filter((item): item is ProviderCapabilityManifest => item !== null)
    : [];
  record.decisions = Array.isArray(record.decisions)
    ? (record.decisions as DecisionRecord[])
    : [];
  record.pathClaims = Array.isArray(record.pathClaims)
    ? (record.pathClaims as PathClaim[])
    : [];
  record.reviewNotes = Array.isArray(record.reviewNotes)
    ? (record.reviewNotes as ReviewNote[]).map((note) => ({
        ...note,
        body: typeof note.body === "string" ? note.body : "",
        assignee:
          note.assignee === "codex" || note.assignee === "claude" || note.assignee === "operator"
            ? note.assignee
            : null,
        taskId: typeof note.taskId === "string" ? note.taskId : null,
        hunkIndex: typeof note.hunkIndex === "number" ? note.hunkIndex : null,
        hunkHeader: typeof note.hunkHeader === "string" ? note.hunkHeader : null,
        disposition:
          note.disposition === "approve" ||
          note.disposition === "concern" ||
          note.disposition === "question" ||
          note.disposition === "accepted_risk" ||
          note.disposition === "wont_fix"
            ? note.disposition
            : "note",
        status: note.status === "resolved" ? "resolved" : "open",
        comments: Array.isArray(note.comments)
          ? note.comments.map((comment) => ({
              id: String(comment.id),
              body: typeof comment.body === "string" ? comment.body : "",
              createdAt: String(comment.createdAt),
              updatedAt: String(comment.updatedAt)
            }))
          : typeof note.body === "string" && note.body
            ? [{
                id: `${note.id}-root`,
                body: note.body,
                createdAt: typeof note.createdAt === "string" ? note.createdAt : nowIso(),
                updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : nowIso()
              }]
          : [],
        resolvedAt: typeof note.resolvedAt === "string" ? note.resolvedAt : null,
        landedAt: typeof note.landedAt === "string" ? note.landedAt : null,
        followUpTaskIds: Array.isArray(note.followUpTaskIds)
          ? note.followUpTaskIds.map((item) => String(item))
          : []
      }))
    : [];
  record.peerMessages = Array.isArray(record.peerMessages)
    ? record.peerMessages
        .map((message) =>
          message && typeof message === "object" && !Array.isArray(message)
            ? {
                id: String(message.id),
                taskId: typeof message.taskId === "string" ? message.taskId : "",
                from: message.from === "claude" ? "claude" : "codex",
                to: message.to === "claude" ? "claude" : "codex",
                intent:
                  message.intent === "question" ||
                  message.intent === "handoff" ||
                  message.intent === "review_request" ||
                  message.intent === "blocked"
                    ? message.intent
                    : "context_share",
                subject: typeof message.subject === "string" ? message.subject : "",
                body: typeof message.body === "string" ? message.body : "",
                createdAt: typeof message.createdAt === "string" ? message.createdAt : nowIso()
              }
            : null
        )
        .filter((message): message is PeerMessage => message !== null)
    : [];
  record.recommendationStates = Array.isArray(record.recommendationStates)
    ? record.recommendationStates.map((state) => ({
        id: String(state.id),
        fingerprint: typeof state.fingerprint === "string" ? state.fingerprint : "",
        status: state.status === "dismissed" ? "dismissed" : "active",
        dismissedReason: typeof state.dismissedReason === "string" ? state.dismissedReason : null,
        dismissedAt: typeof state.dismissedAt === "string" ? state.dismissedAt : null,
        lastAppliedAt: typeof state.lastAppliedAt === "string" ? state.lastAppliedAt : null,
        appliedTaskIds: Array.isArray(state.appliedTaskIds)
          ? state.appliedTaskIds.map((item) => String(item))
          : [],
        updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : nowIso()
      }))
    : [];

  return record;
}

export async function saveSessionRecord(paths: AppPaths, record: SessionRecord): Promise<void> {
  record.updatedAt = nowIso();
  await writeJson(paths.stateFile, record);
}

export async function recordEvent(
  paths: AppPaths,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const event: EventRecord = {
    id: randomUUID(),
    type,
    timestamp: nowIso(),
    payload
  };

  await appendEvent(paths.eventsFile, event);
  const history = await EventHistory.open(paths, sessionId);
  if (history) {
    history.insert(sessionId, event);
    history.close();
  }
}

export async function sessionExists(paths: AppPaths): Promise<boolean> {
  return fileExists(paths.stateFile);
}

export async function updateTask(paths: AppPaths, task: TaskSpec): Promise<void> {
  const session = await loadSessionRecord(paths);
  const tasks = session.tasks.filter((item) => item.id !== task.id);
  tasks.push(task);
  session.tasks = tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await saveSessionRecord(paths, session);
}

export async function addPeerMessages(paths: AppPaths, messages: PeerMessage[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const session = await loadSessionRecord(paths);
  session.peerMessages.push(...messages);
  await saveSessionRecord(paths, session);
}

export async function markAgentRun(
  paths: AppPaths,
  agent: AgentName,
  summary: string,
  exitCode: number,
  sessionId: string | null
): Promise<void> {
  const session = await loadSessionRecord(paths);
  session.agentStatus[agent] = {
    ...session.agentStatus[agent],
    lastRunAt: nowIso(),
    lastExitCode: exitCode,
    sessionId,
    summary
  };
  await saveSessionRecord(paths, session);
}

export async function readRecentEvents(paths: AppPaths, limit = 20): Promise<EventRecord[]> {
  if (!(await fileExists(paths.eventsFile))) {
    return [];
  }

  const content = await fs.readFile(paths.eventsFile, "utf8");
  return content
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as EventRecord);
}

export function sessionHeartbeatAgeMs(session: SessionRecord): number | null {
  if (!session.daemonHeartbeatAt) {
    return null;
  }

  return Date.now() - new Date(session.daemonHeartbeatAt).getTime();
}
