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
            appliedPatternIds: Array.isArray(mission.appliedPatternIds)
              ? mission.appliedPatternIds.map((item) => String(item))
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
              entry.category === "risk"
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
