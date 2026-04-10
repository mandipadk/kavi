import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { consumeCommands } from "./command-queue.ts";
import {
  captureMissionBrainEntries,
  captureRepoTopologyBrainEntries,
  captureTaskBrainEntry,
  mergeBrainEntries,
  retireBrainEntry,
  setBrainEntryPinned
} from "./brain.ts";
import { attachRelevantPatternsToMission } from "./patterns.ts";
import { buildPeerMessages as buildClaudePeerMessages, runClaudeTask } from "./adapters/claude.ts";
import { buildPeerMessages as buildCodexPeerMessages, runCodexTask } from "./adapters/codex.ts";
import { buildDecisionReplay } from "./adapters/shared.ts";
import { listApprovalRequests, resolveApprovalRequest } from "./approvals.ts";
import { synthesizeMissionAcceptanceChecks } from "./acceptance.ts";
import { detectProviderAuthIssue, markProviderCapabilityDegraded } from "./capabilities.ts";
import { loadRuntimeIdentity } from "./compatibility.ts";
import {
  addDecisionRecord,
  releaseSupersededClaims,
  upsertPathClaim
} from "./decision-ledger.ts";
import { getWorktreeDiffReview, listWorktreeChangedPaths } from "./git.ts";
import { executeLand } from "./landing.ts";
import { verifyMissionAcceptanceById } from "./mission-verify.ts";
import { nowIso } from "./paths.ts";
import {
  buildPlannerTask,
  decidePlanningMode,
  isTaskReady,
  materializeExecutionPlan,
  syncExecutionPlans
} from "./planning.ts";
import {
  activeFollowUpRecommendations,
  buildRecommendationActionPlan,
  dismissOperatorRecommendation,
  recordRecommendationApplied,
  restoreOperatorRecommendation
} from "./recommendations.ts";
import {
  addMissionCheckpoint,
  attachMissionPlan,
  createMission,
  missionHasInFlightTasks,
  selectMission,
  syncMissionStates,
  updateMissionPolicy,
  updateMissionSummaryFromTask
} from "./missions.ts";
import { loadLatestLandReport } from "./reports.ts";
import {
  canAutoRetryTask,
  createTaskLease,
  markTaskForManualRetry,
  markTaskForRetry,
  recoverExpiredTaskLeases,
  releaseTaskLease,
  renewTaskLease
} from "./scheduler.ts";
import {
  addReviewReply,
  addReviewNote,
  autoResolveReviewNotesForCompletedTask,
  linkReviewFollowUpTask,
  reviewNotesForTask,
  setReviewNoteStatus,
  updateReviewNote
} from "./reviews.ts";
import { buildAdHocTask, buildKickoffTasks } from "./router.ts";
import {
  parseClaudeRuntimeText,
  parseClaudeTranscriptLine,
  parseCodexAssistantDeltaText,
  type ProviderRuntimeEvent
} from "./provider-runtime.ts";
import { loadSessionRecord, readRecentEvents, recordEvent, saveSessionRecord } from "./session.ts";
import { loadTaskArtifact, saveTaskArtifact } from "./task-artifacts.ts";
import type {
  AgentName,
  AgentTurnEnvelope,
  AppPaths,
  ApprovalRuleDecision,
  ComposerPlanningMode,
  EventRecord,
  KaviSnapshot,
  Mission,
  MissionAutonomyLevel,
  PeerMessage,
  ReviewAssignee,
  SessionRecord,
  SnapshotSubscriptionEvent,
  TaskAttemptRecord,
  TaskProgressEntry,
  TaskSpec
} from "./types.ts";

interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  id: string;
  result?: unknown;
  error?: {
    message: string;
  };
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

interface RpcDispatchResult {
  result: unknown;
  shutdownAfterResponse?: boolean;
}

function summarizeProgressPaths(paths: string[]): string {
  if (paths.length === 0) {
    return "Task is still running; no changed paths are visible yet.";
  }

  if (paths.length <= 4) {
    return `Observed worktree changes: ${paths.join(", ")}.`;
  }

  return `Observed worktree changes: ${paths.slice(0, 4).join(", ")} (+${paths.length - 4} more).`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function truncateProgressText(value: string, max = 220): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function looksLikeStructuredEnvelope(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("{") &&
    trimmed.endsWith("}") &&
    trimmed.includes('"summary"') &&
    trimmed.includes('"status"')
  );
}

function startTaskAttempt(existing: TaskAttemptRecord[], startedAt: string, attempt: number): TaskAttemptRecord[] {
  return [
    ...existing,
    {
      id: `attempt-${Date.now()}`,
      attempt,
      startedAt,
      finishedAt: null,
      status: "running",
      summary: null
    }
  ];
}

function nextTaskAttemptNumber(existing: TaskAttemptRecord[]): number {
  const highest = existing.reduce((max, attempt) => {
    if (typeof attempt.attempt !== "number" || !Number.isFinite(attempt.attempt)) {
      return max;
    }

    return Math.max(max, Math.floor(attempt.attempt));
  }, 0);
  return highest + 1;
}

function finalizeTaskAttempt(
  existing: TaskAttemptRecord[],
  status: TaskAttemptRecord["status"],
  summary: string | null,
  finishedAt: string
): TaskAttemptRecord[] {
  const attempts = [...existing];
  const index = attempts.findLastIndex((attempt) => attempt.status === "running");
  if (index === -1) {
    attempts.push({
      id: `attempt-${Date.now()}`,
      attempt: attempts.length + 1,
      startedAt: finishedAt,
      finishedAt,
      status,
      summary
    });
    return attempts;
  }

  attempts[index] = {
    ...attempts[index],
    finishedAt,
    status,
    summary
  };
  return attempts;
}

function inferPromptNodeKind(
  title: string | null | undefined,
  prompt: string,
  owner: "codex" | "claude",
  taskKind: TaskSpec["kind"]
): TaskSpec["nodeKind"] {
  const lower = `${title ?? ""}\n${prompt}`.toLowerCase();
  if (taskKind === "planner") {
    return "research";
  }
  if (taskKind === "integration") {
    return /\brepair|fix|failed acceptance|verify\b/.test(lower) ? "repair" : "integration";
  }
  if (/\brepair|fix|failed acceptance|verify|validation|smoke|qa\b/.test(lower)) {
    return "repair";
  }
  if (/\bfront|ui|ux|screen|page|component|layout|web\b/.test(lower)) {
    return "frontend";
  }
  if (/\bback|api|server|database|auth|migration\b/.test(lower)) {
    return "backend";
  }
  if (/\bcontract|schema|shared|domain|type\b/.test(lower)) {
    return "shared_contract";
  }
  if (/\bdeploy|infra|worker|queue|cron|pipeline\b/.test(lower)) {
    return "infra";
  }
  if (/\bdoc|readme|guide|spec\b/.test(lower)) {
    return "docs";
  }
  if (/\bscaffold|bootstrap|setup|initialize|starter|from scratch\b/.test(lower)) {
    return "scaffold";
  }
  return owner === "claude" ? "frontend" : "backend";
}

function resolveTaskRetryBudget(
  session: SessionRecord,
  missionId: string | null,
  nodeKind: TaskSpec["nodeKind"],
  taskKind: TaskSpec["kind"]
): number {
  const mission = missionId ? session.missions.find((item) => item.id === missionId) ?? null : null;
  const budget = mission?.policy?.retryBudget ?? 1;
  if (taskKind === "planner") {
    return Math.max(1, budget);
  }
  if (nodeKind === "repair" || nodeKind === "integration" || nodeKind === "tests") {
    return Math.max(1, budget);
  }
  return budget;
}

function buildRuntimeActivitySummary(agent: AgentName, value: string): string {
  const label = agent === "codex" ? "Codex" : "Claude";
  return `${label} activity: ${truncateProgressText(summarizeRuntimeNarrative(value))}`;
}

function summarizeRuntimeNarrative(value: string): string {
  const normalized = stripAnsi(value).replaceAll("\r", "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return value;
  }

  const meaningful = lines.filter((line) => {
    const lower = line.toLowerCase();
    return !/^(debug|trace|info):?/i.test(lower) && !/^\[[0-9:.\- ]+\]/.test(lower);
  });
  const candidate = (meaningful[0] ?? lines[0]).replaceAll(/\s+/g, " ").trim();
  return candidate;
}

function extractRuntimeMentionedPaths(value: string): string[] {
  const matches = value.match(/[A-Za-z0-9_.\-\/]+\.(tsx|ts|jsx|js|go|py|rs|md|json|toml|yaml|yml|sql|html|css)/g) ?? [];
  return [...new Set(matches.map((item) => item.trim()).filter(Boolean))].slice(0, 8);
}

function normalizeReviewDisposition(value: unknown) {
  if (
    value === "approve" ||
    value === "concern" ||
    value === "question" ||
    value === "accepted_risk" ||
    value === "wont_fix"
  ) {
    return value;
  }

  return "note" as const;
}

function normalizeReviewAssignee(value: unknown): ReviewAssignee | null {
  if (value === "codex" || value === "claude" || value === "operator") {
    return value;
  }

  return null;
}

export class KaviDaemon {
  private readonly paths: AppPaths;
  private session!: SessionRecord;
  private daemonVersion = "0.0.0";
  private daemonProtocolVersion = 0;
  private managedSessionId = "";
  private running = false;
  private processing = false;
  private interval: NodeJS.Timeout | null = null;
  private stopResolver: (() => void) | null = null;
  private rpcServer: net.Server | null = null;
  private readonly clients = new Set<Socket>();
  private readonly subscribers = new Set<Socket>();
  private readonly runningAgents = new Set<AgentName>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(paths: AppPaths) {
    this.paths = paths;
  }

  async start(): Promise<void> {
    const identity = await loadRuntimeIdentity();
    this.daemonVersion = identity.version;
    this.daemonProtocolVersion = identity.protocolVersion;
    this.session = await loadSessionRecord(this.paths);
    this.managedSessionId = this.session.id;
    this.session.status = "running";
    this.session.daemonPid = process.pid;
    this.session.daemonHeartbeatAt = new Date().toISOString();
    this.session.daemonVersion = this.daemonVersion;
    this.session.protocolVersion = this.daemonProtocolVersion;
    await saveSessionRecord(this.paths, this.session);
    await recordEvent(this.paths, this.session.id, "daemon.started", {
      daemonPid: process.pid,
      daemonVersion: this.daemonVersion,
      protocolVersion: this.daemonProtocolVersion
    });
    await this.startRpcServer();

    this.running = true;
    void this.tick();
    this.interval = setInterval(() => {
      void this.tick();
    }, 1000);

    await new Promise<void>((resolve) => {
      this.stopResolver = resolve;
    });
  }

  private async startRpcServer(): Promise<void> {
    await fs.mkdir(path.dirname(this.paths.socketPath), { recursive: true });
    await fs.rm(this.paths.socketPath, { force: true }).catch(() => {});
    this.rpcServer = net.createServer((socket) => {
      this.clients.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) {
            return;
          }

          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let request: RpcRequest;
          try {
            request = JSON.parse(line) as RpcRequest;
          } catch (error) {
            this.writeRpc(socket, {
              id: "parse-error",
              error: {
                message:
                  error instanceof Error ? error.message : "Unable to parse RPC payload."
              }
            });
            continue;
          }

          void this.handleRpcRequest(socket, request);
        }
      });
      const cleanup = () => {
        this.clients.delete(socket);
        this.subscribers.delete(socket);
      };
      socket.on("error", cleanup);
      socket.on("close", cleanup);
    });

    await new Promise<void>((resolve, reject) => {
      this.rpcServer?.once("error", reject);
      this.rpcServer?.listen(this.paths.socketPath, () => {
        this.rpcServer?.off("error", reject);
        resolve();
      });
    });
  }

  private writeRpc(socket: Socket, response: RpcResponse, onWritten?: () => void): void {
    socket.write(`${JSON.stringify(response)}\n`, onWritten);
  }

  private writeNotification(socket: Socket, notification: RpcNotification): void {
    socket.write(`${JSON.stringify(notification)}\n`);
  }

  private async handleRpcRequest(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      const dispatch = await this.dispatchRpc(socket, request.method, request.params ?? {});
      this.writeRpc(socket, {
        id: request.id,
        result: dispatch.result
      }, () => {
        if (dispatch.shutdownAfterResponse) {
          void this.stopFromRpc();
        }
      });
    } catch (error) {
      this.writeRpc(socket, {
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async dispatchRpc(
    socket: Socket,
    method: string,
    params: Record<string, unknown>
  ): Promise<RpcDispatchResult> {
    switch (method) {
      case "ping":
        return {
          result: {
            ok: true,
            sessionId: this.session.id,
            daemonVersion: this.daemonVersion,
            protocolVersion: this.daemonProtocolVersion
          }
        };
      case "snapshot":
        return {
          result: await this.buildSnapshot()
        };
      case "subscribe":
        this.subscribers.add(socket);
        return {
          result: await this.buildSnapshot()
        };
      case "kickoff":
        await this.kickoffFromRpc(params);
        return {
          result: { ok: true }
        };
      case "enqueueTask":
        await this.enqueueRpcTask(params);
        return {
          result: { ok: true }
        };
      case "retryTask":
        await this.retryTaskFromRpc(params);
        return {
          result: { ok: true }
        };
      case "dismissRecommendation":
        await this.dismissRecommendationFromRpc(params);
        return {
          result: { ok: true }
        };
      case "restoreRecommendation":
        await this.restoreRecommendationFromRpc(params);
        return {
          result: { ok: true }
        };
      case "selectMission":
        await this.selectMissionFromRpc(params);
        return {
          result: { ok: true }
        };
      case "updateMissionPolicy":
        await this.updateMissionPolicyFromRpc(params);
        return {
          result: { ok: true }
        };
      case "shutdown":
        return {
          result: { ok: true },
          shutdownAfterResponse: true
        };
      case "resolveApproval":
        await this.resolveApprovalFromRpc(params);
        return {
          result: { ok: true }
        };
      case "land":
        return {
          result: await this.landFromRpc()
        };
      case "setFullAccessMode":
        await this.setFullAccessModeFromRpc(params);
        return {
          result: { ok: true }
        };
      case "taskArtifact":
        return {
          result: await this.getTaskArtifactFromRpc(params)
        };
      case "events":
        return {
          result: await this.getEventsFromRpc(params)
        };
      case "worktreeDiff":
        return {
          result: await this.getWorktreeDiffFromRpc(params)
        };
      case "setBrainEntryPinned":
        await this.setBrainEntryPinnedFromRpc(params);
        return {
          result: { ok: true }
        };
      case "retireBrainEntry":
        await this.retireBrainEntryFromRpc(params);
        return {
          result: { ok: true }
        };
      case "mergeBrainEntries":
        await this.mergeBrainEntriesFromRpc(params);
        return {
          result: { ok: true }
        };
      case "appendHookProgress":
        await this.appendHookProgressFromRpc(params);
        return {
          result: { ok: true }
        };
      case "notifyExternalUpdate":
        await this.runMutation(async () => {
          this.session = await loadSessionRecord(this.paths);
          this.syncSessionDerivedState();
          await saveSessionRecord(this.paths, this.session);
          await this.publishSnapshot(
            typeof params.reason === "string" && params.reason.trim()
              ? params.reason.trim()
              : "external.update"
          );
        });
        return {
          result: { ok: true }
        };
      case "addReviewNote":
        await this.addReviewNoteFromRpc(params);
        return {
          result: { ok: true }
        };
      case "updateReviewNote":
        await this.updateReviewNoteFromRpc(params);
        return {
          result: { ok: true }
        };
      case "addReviewReply":
        await this.addReviewReplyFromRpc(params);
        return {
          result: { ok: true }
        };
      case "setReviewNoteStatus":
        await this.setReviewNoteStatusFromRpc(params);
        return {
          result: { ok: true }
        };
      case "enqueueReviewFollowUp":
        await this.enqueueReviewFollowUpFromRpc(params);
        return {
          result: { ok: true }
        };
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  private async buildSnapshot(): Promise<KaviSnapshot> {
    const session = await loadSessionRecord(this.paths);
    syncExecutionPlans(session);
    syncMissionStates(session);
    const events = await readRecentEvents(this.paths, 30);
    const approvals = await listApprovalRequests(this.paths, { includeResolved: true });
    const worktreeDiffs = await Promise.all(
      session.worktrees.map(async (worktree) => ({
        agent: worktree.agent,
        paths: await listWorktreeChangedPaths(worktree.path, session.baseCommit).catch(() => [])
      }))
    );
    const latestLandReport = await loadLatestLandReport(this.paths);

    return {
      session,
      events,
      approvals,
      worktreeDiffs,
      latestLandReport
    };
  }

  private async runMutation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release: () => void = () => {};
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createMissionForPrompt(
    prompt: string,
    options: {
      missionPrompt?: string | null;
      planningTaskId?: string | null;
      rootTaskId?: string | null;
      goal?: string | null;
      mode?: "guided_autopilot" | "inspect" | "manual";
      shadowOfMissionId?: string | null;
      policyOverrides?: Partial<NonNullable<Mission["policy"]>>;
    } = {}
  ) {
    const mission = createMission(this.session, options.missionPrompt?.trim() || prompt, {
      mode: options.mode ?? "guided_autopilot",
      planningTaskId: options.planningTaskId ?? null,
      rootTaskId: options.rootTaskId ?? null,
      goal: options.goal ?? null,
      shadowOfMissionId: options.shadowOfMissionId ?? null,
      policyOverrides: options.policyOverrides
    });
    this.session.missions.push(mission);
    this.session.selectedMissionId = mission.id;
    captureMissionBrainEntries(this.session, mission);
    return mission;
  }

  private syncSessionDerivedState(): void {
    syncExecutionPlans(this.session);
    syncMissionStates(this.session);
  }

  private buildMissionPolicyOverrides(params: Record<string, unknown>): Partial<NonNullable<Mission["policy"]>> {
    const overrides: Partial<NonNullable<Mission["policy"]>> = {};
    if (
      params.missionAutonomyLevel === "inspect" ||
      params.missionAutonomyLevel === "guided" ||
      params.missionAutonomyLevel === "autonomous" ||
      params.missionAutonomyLevel === "overnight"
    ) {
      overrides.autonomyLevel = params.missionAutonomyLevel as MissionAutonomyLevel;
    }
    if (typeof params.autoVerify === "boolean") {
      overrides.autoVerify = params.autoVerify;
    }
    if (typeof params.autoLand === "boolean") {
      overrides.autoLand = params.autoLand;
    }
    return overrides;
  }

  private async autoLandBlocker(session: SessionRecord, mission: Mission): Promise<string | null> {
    if (!mission.policy?.autoLand || mission.autopilotEnabled !== true) {
      return "auto-land disabled";
    }
    if (mission.acceptance.status !== "passed" || mission.status !== "ready_to_land") {
      return "mission is not ready to land";
    }
    const openApprovals = (await listApprovalRequests(this.paths, { includeResolved: false }))
      .filter((approval) => approval.status === "pending")
      .length;
    if (openApprovals > 0) {
      return `${openApprovals} approval request(s) remain`;
    }
    const followUps = activeFollowUpRecommendations(session);
    if (followUps.length > 0) {
      return `${followUps.length} follow-up recommendation(s) remain`;
    }
    const missionTaskIds = new Set(
      session.tasks.filter((task) => task.missionId === mission.id).map((task) => task.id)
    );
    const openReviewNotes = session.reviewNotes.filter(
      (note) => note.status === "open" && (!note.taskId || missionTaskIds.has(note.taskId))
    );
    if (openReviewNotes.length > 0) {
      return `${openReviewNotes.length} open review note(s) remain`;
    }
    if (missionHasInFlightTasks(session, mission.id)) {
      return "tasks are still in flight";
    }
    const otherActiveMissions = session.missions.filter(
      (item) =>
        item.id !== mission.id &&
        !item.landedAt &&
        item.status !== "completed" &&
        item.status !== "landed"
    );
    if (otherActiveMissions.length > 0) {
      return `other missions still need attention: ${otherActiveMissions.map((item) => item.id).join(", ")}`;
    }
    return null;
  }

  private async maybeAdvanceMission(missionId: string | null, source: string): Promise<void> {
    if (!missionId) {
      return;
    }

    const session = await loadSessionRecord(this.paths);
    const mission = session.missions.find((item) => item.id === missionId) ?? null;
    if (!mission || mission.autopilotEnabled !== true) {
      return;
    }

    if (
      mission.policy?.autoVerify === true &&
      mission.acceptance.status === "pending" &&
      !missionHasInFlightTasks(session, mission.id)
    ) {
      await verifyMissionAcceptanceById(this.paths, mission.id).catch(async (error) => {
        await recordEvent(this.paths, session.id, "mission.acceptance_auto_verify_failed", {
          missionId: mission.id,
          source,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    const refreshedSession = await loadSessionRecord(this.paths);
    const refreshedMission = refreshedSession.missions.find((item) => item.id === missionId) ?? null;
    if (!refreshedMission) {
      return;
    }
    const landBlocker = await this.autoLandBlocker(refreshedSession, refreshedMission);
    if (!landBlocker) {
      const result = await executeLand(this.paths);
      await recordEvent(this.paths, refreshedSession.id, "mission.auto_landed", {
        missionId,
        source,
        status: result.status,
        targetBranch: result.targetBranch
      });
    } else if (refreshedMission.policy?.autoLand === true) {
      await recordEvent(this.paths, refreshedSession.id, "mission.auto_land_blocked", {
        missionId,
        source,
        blocker: landBlocker
      });
    }

    await this.runMutation(async () => {
      this.session = await loadSessionRecord(this.paths);
      await this.publishSnapshot("mission.auto_advanced");
    });
  }

  private async hydrateMissionContext(missionId: string | null, prompt: string): Promise<void> {
    const topologyEntries = await captureRepoTopologyBrainEntries(
      this.session,
      this.session.repoRoot,
      missionId
    );
    const mission = this.session.missions.find((item) => item.id === missionId) ?? null;
    if (mission) {
      for (const entry of topologyEntries) {
        if (!mission.brainEntryIds.includes(entry.id)) {
          mission.brainEntryIds.push(entry.id);
        }
      }
    }
    await attachRelevantPatternsToMission(this.paths, this.session, missionId, prompt);
  }

  private async maybeAutopilotFollowUp(): Promise<void> {
    const pendingApprovals = (await listApprovalRequests(this.paths, { includeResolved: false }))
      .filter((approval) => approval.status === "pending")
      .length;
    if (pendingApprovals > 0 || this.runningAgents.size > 0) {
      return;
    }

    const recommendations = activeFollowUpRecommendations(this.session)
      .filter((recommendation) => recommendation.openFollowUpTaskIds.length === 0)
      .filter((recommendation) => {
        const missionId =
          typeof recommendation.metadata.missionId === "string"
            ? recommendation.metadata.missionId
            : null;
        const mission = this.session.missions.find((item) => item.id === missionId) ?? null;
        if (mission?.autopilotEnabled !== true) {
          return false;
        }

        const sourceType =
          typeof recommendation.metadata.sourceType === "string"
            ? recommendation.metadata.sourceType
            : null;
        const sourceIntent =
          typeof recommendation.metadata.sourceIntent === "string"
            ? recommendation.metadata.sourceIntent
            : null;
        const missionHasGraph =
          Boolean(mission.planId) ||
          this.session.plans.some((plan) => plan.missionId === missionId);

        if (sourceType === "peer_message" && sourceIntent === "context_share" && !missionHasGraph) {
          return false;
        }

        if (sourceType === "next_recommendation" && !missionHasGraph) {
          return false;
        }

        return true;
      });

    const recommendation = recommendations[0];
    if (!recommendation) {
      return;
    }

    const actionPlan = buildRecommendationActionPlan(this.session, recommendation.id);
    const taskId = `task-autopilot-${Date.now()}`;
    const missionId =
      typeof actionPlan.routeMetadata.missionId === "string"
        ? actionPlan.routeMetadata.missionId
        : null;
    const nodeKind = inferPromptNodeKind(null, actionPlan.prompt, actionPlan.owner, "execution");
    const task = buildAdHocTask(actionPlan.owner, actionPlan.prompt, taskId, {
      missionId,
      nodeKind,
      retryCount: 0,
      maxRetries: resolveTaskRetryBudget(this.session, missionId, nodeKind, "execution"),
      routeReason: `${actionPlan.routeReason} Applied automatically by guided autopilot.`,
      routeStrategy: actionPlan.routeStrategy,
      routeConfidence: actionPlan.routeConfidence,
      routeMetadata: {
        ...actionPlan.routeMetadata,
        autopilotApplied: true,
        nodeKind
      },
      claimedPaths: actionPlan.claimedPaths
    });

    this.session.tasks.push(task);
    recordRecommendationApplied(this.session, recommendation.id, task.id);
    addDecisionRecord(this.session, {
      kind: "plan",
      agent: task.owner,
      taskId: task.id,
      summary: `Autopilot queued follow-up for ${task.owner}`,
      detail: recommendation.title,
      metadata: {
        recommendationId: recommendation.id,
        missionId: task.missionId
      }
    });
    await saveSessionRecord(this.paths, this.session);
    await recordEvent(this.paths, this.session.id, "mission.autopilot_applied", {
      recommendationId: recommendation.id,
      taskId: task.id,
      owner: task.owner,
      missionId: task.missionId
    });
    await this.publishSnapshot("mission.autopilot_applied");
  }

  private async enqueueRpcTask(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      if (!prompt.trim()) {
        throw new Error("enqueueTask requires a prompt.");
      }

      const owner = params.owner === "claude" ? "claude" : "codex";
      const title = typeof params.title === "string" && params.title.trim()
        ? params.title.trim()
        : undefined;
      const missionPrompt =
        typeof params.missionPrompt === "string" && params.missionPrompt.trim()
          ? params.missionPrompt.trim()
          : prompt;
      const requestedPlanningMode: ComposerPlanningMode =
        params.planningMode === "plan" || params.planningMode === "direct"
          ? params.planningMode
          : "auto";
      const missionMode =
        params.missionMode === "inspect" || params.missionMode === "manual"
          ? params.missionMode
          : "guided_autopilot";
      const policyOverrides = this.buildMissionPolicyOverrides(params);
      const planningDecision = decidePlanningMode(missionPrompt, this.session, requestedPlanningMode);
      const commandId = `rpc-${Date.now()}`;
      const taskId = `task-${commandId}`;
      const mission = this.createMissionForPrompt(prompt, {
        missionPrompt,
        mode: missionMode,
        planningTaskId: planningDecision.usePlanner ? "pending-planner" : null,
        rootTaskId: planningDecision.usePlanner ? null : taskId,
        shadowOfMissionId:
          typeof params.shadowOfMissionId === "string" ? params.shadowOfMissionId : null,
        policyOverrides
      });
      await this.hydrateMissionContext(mission.id, missionPrompt);
      const task = planningDecision.usePlanner
        ? buildPlannerTask(this.session, prompt, {
            planningMode: "operator",
            title: title ?? "Codex orchestration plan",
            missionId: mission.id
          })
        : (() => {
            const nodeKind = inferPromptNodeKind(title, prompt, owner, "execution");
            return buildAdHocTask(owner, prompt, taskId, {
              missionId: mission.id,
              ...(title ? { title } : {}),
              nodeKind,
              retryCount: 0,
              maxRetries: resolveTaskRetryBudget(this.session, mission.id, nodeKind, "execution"),
              routeReason:
                typeof params.routeReason === "string" ? params.routeReason : null,
              routeStrategy:
                params.routeStrategy === "manual" ||
                params.routeStrategy === "keyword" ||
                params.routeStrategy === "ai" ||
                params.routeStrategy === "path-claim" ||
                params.routeStrategy === "fallback"
                  ? params.routeStrategy
                  : null,
              routeConfidence:
                typeof params.routeConfidence === "number" ? params.routeConfidence : null,
              routeMetadata:
                params.routeMetadata && typeof params.routeMetadata === "object" && !Array.isArray(params.routeMetadata)
                  ? {
                      ...(params.routeMetadata as Record<string, unknown>),
                      requestedPlanningMode,
                      planningDecision: planningDecision.reason,
                      nodeKind,
                      missionMode,
                      shadowOfMissionId:
                        typeof params.shadowOfMissionId === "string" ? params.shadowOfMissionId : null
                    }
                  : {
                      requestedPlanningMode,
                      planningDecision: planningDecision.reason,
                      nodeKind,
                      missionMode,
                      shadowOfMissionId:
                        typeof params.shadowOfMissionId === "string" ? params.shadowOfMissionId : null
                    },
              claimedPaths: Array.isArray(params.claimedPaths)
                ? params.claimedPaths.map((item) => String(item))
                : []
            });
          })();
      if (planningDecision.usePlanner) {
        mission.planningTaskId = task.id;
        mission.activeTaskIds = [task.id];
      } else {
        mission.rootTaskId = task.id;
      }
      this.session.tasks.push(task);
      this.syncSessionDerivedState();
      addDecisionRecord(this.session, {
        kind: planningDecision.usePlanner ? "plan" : "route",
        agent: planningDecision.usePlanner ? "codex" : owner,
        taskId: task.id,
        summary: planningDecision.usePlanner ? "Queued orchestration planner" : `Routed task to ${owner}`,
        detail:
          planningDecision.usePlanner
            ? planningDecision.reason
            : typeof params.routeReason === "string"
              ? params.routeReason
              : `Task enqueued for ${owner}.`,
          metadata: {
            strategy:
              planningDecision.usePlanner
                ? "planner"
                : typeof params.routeStrategy === "string" ? params.routeStrategy : "unknown",
            confidence:
              planningDecision.usePlanner
                ? 1
                : typeof params.routeConfidence === "number" ? params.routeConfidence : null,
            claimedPaths: task.claimedPaths,
            routeMetadata:
              task.routeMetadata,
            planningMode: requestedPlanningMode,
            planningDecision: planningDecision.reason,
            missionId: mission.id,
            missionMode,
            shadowOfMissionId: mission.shadowOfMissionId ?? null
          }
        });
      upsertPathClaim(this.session, {
        taskId: task.id,
        agent: task.owner === "claude" ? "claude" : "codex",
        source: "route",
        paths: task.claimedPaths,
        note: task.routeReason
      });
      if (typeof params.recommendationId === "string") {
        recordRecommendationApplied(this.session, params.recommendationId, taskId);
      }
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "task.enqueued", {
        owner: task.owner,
        via: "rpc",
        planningMode: requestedPlanningMode,
        planningDecision: planningDecision.reason,
        missionId: mission.id,
        missionMode,
        shadowOfMissionId: mission.shadowOfMissionId ?? null,
        recommendationId:
          typeof params.recommendationId === "string" ? params.recommendationId : null
      });
      if (
        typeof params.recommendationId === "string" &&
        (params.recommendationKind === "handoff" ||
          params.recommendationKind === "follow_up" ||
          params.recommendationKind === "integration" ||
          params.recommendationKind === "ownership-config")
      ) {
        await recordEvent(this.paths, this.session.id, "recommendation.applied", {
          recommendationId: params.recommendationId,
          recommendationKind: params.recommendationKind,
          owner,
          taskId
        });
      }
      await this.publishSnapshot("task.enqueued");
    });
  }

  private async dismissRecommendationFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const recommendationId =
        typeof params.recommendationId === "string" ? params.recommendationId : "";
      if (!recommendationId) {
        throw new Error("dismissRecommendation requires a recommendationId.");
      }

      const reason = typeof params.reason === "string" ? params.reason : null;
      const recommendation = dismissOperatorRecommendation(this.session, recommendationId, reason);
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "recommendation.dismissed", {
        recommendationId,
        kind: recommendation.kind,
        reason
      });
      await this.publishSnapshot("recommendation.dismissed");
    });
  }

  private async retryTaskFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const taskId = typeof params.taskId === "string" ? params.taskId : "";
      if (!taskId) {
        throw new Error("retryTask requires a taskId.");
      }

      const task = this.session.tasks.find((item) => item.id === taskId) ?? null;
      if (!task) {
        throw new Error(`Task ${taskId} was not found.`);
      }

      if (task.status !== "failed" && task.status !== "blocked") {
        throw new Error(`Task ${taskId} is ${task.status} and cannot be retried.`);
      }

      markTaskForManualRetry(task);
      this.syncSessionDerivedState();
      addDecisionRecord(this.session, {
        kind: "task",
        agent: task.owner === "claude" ? "claude" : "codex",
        taskId: task.id,
        summary: `Queued manual retry for ${task.title}`,
        detail: "Operator reset the task for another execution attempt.",
        metadata: {
          missionId: task.missionId,
          nodeKind: task.nodeKind,
          maxRetries: task.maxRetries
        }
      });
      addMissionCheckpoint(this.session, task.missionId, {
        kind: "task_recovered",
        title: "Task manually retried",
        detail: `Operator reset ${task.title} for another attempt.`,
        taskId: task.id
      });

      const artifact = await loadTaskArtifact(this.paths, task.id);
      if (artifact) {
        artifact.status = "pending";
        artifact.retryCount = task.retryCount;
        artifact.lastFailureSummary = null;
        artifact.summary = task.summary;
        await saveTaskArtifact(this.paths, artifact);
      }

      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "task.retry_queued", {
        taskId: task.id,
        owner: task.owner,
        missionId: task.missionId,
        nodeKind: task.nodeKind
      });
      await this.publishSnapshot("task.retry_queued");
    });
  }

  private async restoreRecommendationFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const recommendationId =
        typeof params.recommendationId === "string" ? params.recommendationId : "";
      if (!recommendationId) {
        throw new Error("restoreRecommendation requires a recommendationId.");
      }

      const recommendation = restoreOperatorRecommendation(this.session, recommendationId);
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "recommendation.restored", {
        recommendationId,
        kind: recommendation.kind
      });
      await this.publishSnapshot("recommendation.restored");
    });
  }

  private async kickoffFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      if (!prompt.trim()) {
        throw new Error("kickoff requires a prompt.");
      }

      this.session.goal = prompt;
      const mission = this.createMissionForPrompt(prompt, {
        goal: prompt
      });
      await this.hydrateMissionContext(mission.id, prompt);
      this.session.tasks.push(...buildKickoffTasks(prompt, mission.id));
      mission.activeTaskIds = ["kickoff-codex", "kickoff-claude"];
      mission.planningTaskId = "kickoff-codex";
      this.syncSessionDerivedState();
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "tasks.kickoff_enqueued", {
        count: 2,
        via: "rpc",
        missionId: mission.id
      });
      await this.publishSnapshot("tasks.kickoff_enqueued");
    });
  }

  private async stopFromRpc(): Promise<void> {
    await this.runMutation(async () => {
      this.session.status = "stopped";
      this.running = false;
      this.session.daemonHeartbeatAt = new Date().toISOString();
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "daemon.stopped", {
        via: "rpc"
      });
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
      await this.closeRpcServer();
      this.stopResolver?.();
    });
  }

  private async resolveApprovalFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const decision: ApprovalRuleDecision = params.decision === "deny" ? "deny" : "allow";
      const remember = params.remember === true;
      if (!requestId) {
        throw new Error("resolveApproval requires a requestId.");
      }

      const request = await resolveApprovalRequest(this.paths, requestId, decision, remember);
      addDecisionRecord(this.session, {
        kind: "approval",
        agent: request.agent,
        summary: `${decision === "allow" ? "Approved" : "Denied"} ${request.toolName}`,
        detail: request.summary,
        metadata: {
          requestId: request.id,
          remember,
          toolName: request.toolName
        }
      });
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "approval.resolved", {
        requestId: request.id,
        decision,
        remember,
        agent: request.agent,
        toolName: request.toolName,
        via: "rpc"
      });
      await this.publishSnapshot("approval.resolved");
    });
  }

  private async setFullAccessModeFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const enabled = params.enabled === true;
      if (this.session.fullAccessMode === enabled) {
        return;
      }

      this.session.fullAccessMode = enabled;
      addDecisionRecord(this.session, {
        kind: "approval",
        agent: null,
        summary: `${enabled ? "Enabled" : "Disabled"} approve-all mode`,
        detail: enabled
          ? "Future Claude and Codex turns will run with full access and without Kavi approval prompts."
          : "Future Claude and Codex turns will return to standard approval and sandbox behavior.",
        metadata: {
          enabled
        }
      });
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "session.full_access_mode_changed", {
        enabled
      });
      await this.publishSnapshot("session.full_access_mode_changed");
    });
  }

  private async selectMissionFromRpc(params: Record<string, unknown>): Promise<void> {
    const missionId = typeof params.missionId === "string" && params.missionId.trim()
      ? params.missionId.trim()
      : null;
    if (!missionId) {
      throw new Error("Mission selection requires a missionId.");
    }

    await this.runMutation(async () => {
      const mission = selectMission(this.session, missionId);
      if (!mission) {
        throw new Error(`Mission ${missionId} was not found.`);
      }

      addDecisionRecord(this.session, {
        kind: "plan",
        agent: "router",
        taskId: mission.rootTaskId ?? mission.planningTaskId ?? null,
        summary: `Selected mission ${mission.id}`,
        detail: mission.shadowOfMissionId
          ? `Operator selected shadow mission ${mission.id} over ${mission.shadowOfMissionId}.`
          : `Operator selected mission ${mission.id} as the active mission focus.`,
        metadata: {
          missionId: mission.id,
          shadowOfMissionId: mission.shadowOfMissionId ?? null
        }
      });
      addMissionCheckpoint(this.session, mission.id, {
        kind: "task_progress",
        title: "Mission selected",
        detail: "Operator set this mission as the active focus for review, verification, and landing.",
        taskId: mission.rootTaskId ?? mission.planningTaskId ?? null
      });
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "mission.selected", {
        missionId: mission.id,
        shadowOfMissionId: mission.shadowOfMissionId ?? null
      });
      await this.publishSnapshot("mission.selected");
    });
  }

  private async updateMissionPolicyFromRpc(params: Record<string, unknown>): Promise<void> {
    const missionId = typeof params.missionId === "string" && params.missionId.trim()
      ? params.missionId.trim()
      : null;
    if (!missionId) {
      throw new Error("Mission policy update requires a missionId.");
    }

    await this.runMutation(async () => {
      const retryBudget =
        typeof params.retryBudget === "number" && Number.isFinite(params.retryBudget)
          ? Math.max(0, Math.min(5, Math.trunc(params.retryBudget)))
          : undefined;
      const mission = updateMissionPolicy(this.session, missionId, {
        autonomyLevel:
          params.autonomyLevel === "inspect" ||
          params.autonomyLevel === "guided" ||
          params.autonomyLevel === "autonomous" ||
          params.autonomyLevel === "overnight"
            ? params.autonomyLevel
            : undefined,
        autoVerify: typeof params.autoVerify === "boolean" ? params.autoVerify : undefined,
        autoLand: typeof params.autoLand === "boolean" ? params.autoLand : undefined,
        pauseOnRepairFailure:
          typeof params.pauseOnRepairFailure === "boolean" ? params.pauseOnRepairFailure : undefined,
        retryBudget,
        autopilotEnabled: typeof params.autopilotEnabled === "boolean" ? params.autopilotEnabled : undefined
      });
      if (!mission) {
        throw new Error(`Mission ${missionId} was not found.`);
      }

      addDecisionRecord(this.session, {
        kind: "plan",
        agent: "router",
        taskId: mission.rootTaskId ?? mission.planningTaskId ?? null,
        summary: `Updated mission policy for ${mission.id}`,
        detail: `autonomy=${mission.policy?.autonomyLevel ?? "-"} | retry=${mission.policy?.retryBudget ?? "-"} | autoVerify=${mission.policy?.autoVerify ? "on" : "off"} | autoLand=${mission.policy?.autoLand ? "on" : "off"} | pauseOnRepairFailure=${mission.policy?.pauseOnRepairFailure ? "on" : "off"} | autopilot=${mission.autopilotEnabled ? "on" : "off"}`,
        metadata: {
          missionId: mission.id,
          policy: mission.policy ?? null,
          autopilotEnabled: mission.autopilotEnabled
        }
      });
      addMissionCheckpoint(this.session, mission.id, {
        kind: "task_progress",
        title: "Mission policy updated",
        detail: `autonomy=${mission.policy?.autonomyLevel ?? "-"} | retry=${mission.policy?.retryBudget ?? "-"} | autoVerify=${mission.policy?.autoVerify ? "on" : "off"} | autoLand=${mission.policy?.autoLand ? "on" : "off"} | pauseOnRepairFailure=${mission.policy?.pauseOnRepairFailure ? "on" : "off"} | autopilot=${mission.autopilotEnabled ? "on" : "off"}`,
        taskId: mission.rootTaskId ?? mission.planningTaskId ?? null
      });
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "mission.policy_updated", {
        missionId: mission.id,
        policy: mission.policy ?? null,
        autopilotEnabled: mission.autopilotEnabled
      });
      await this.publishSnapshot("mission.policy_updated");
    });
  }

  private async setBrainEntryPinnedFromRpc(params: Record<string, unknown>): Promise<void> {
    const entryId = typeof params.entryId === "string" && params.entryId.trim() ? params.entryId.trim() : null;
    if (!entryId) {
      throw new Error("Brain pinning requires an entryId.");
    }

    await this.runMutation(async () => {
      const entry = setBrainEntryPinned(this.session, entryId, params.pinned === true);
      if (!entry) {
        throw new Error(`Brain entry ${entryId} was not found.`);
      }
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "brain.entry_pinned", {
        entryId: entry.id,
        pinned: entry.pinned
      });
      await this.publishSnapshot("brain.entry_pinned");
    });
  }

  private async retireBrainEntryFromRpc(params: Record<string, unknown>): Promise<void> {
    const entryId = typeof params.entryId === "string" && params.entryId.trim() ? params.entryId.trim() : null;
    if (!entryId) {
      throw new Error("Brain retirement requires an entryId.");
    }

    await this.runMutation(async () => {
      const entry = retireBrainEntry(this.session, entryId);
      if (!entry) {
        throw new Error(`Brain entry ${entryId} was not found.`);
      }
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "brain.entry_retired", {
        entryId: entry.id
      });
      await this.publishSnapshot("brain.entry_retired");
    });
  }

  private async mergeBrainEntriesFromRpc(params: Record<string, unknown>): Promise<void> {
    const targetEntryId = typeof params.targetEntryId === "string" && params.targetEntryId.trim()
      ? params.targetEntryId.trim()
      : null;
    const sourceEntryId = typeof params.sourceEntryId === "string" && params.sourceEntryId.trim()
      ? params.sourceEntryId.trim()
      : null;
    if (!targetEntryId || !sourceEntryId) {
      throw new Error("Brain merge requires both targetEntryId and sourceEntryId.");
    }

    await this.runMutation(async () => {
      const entry = mergeBrainEntries(this.session, targetEntryId, sourceEntryId);
      if (!entry) {
        throw new Error(`Unable to merge ${sourceEntryId} into ${targetEntryId}.`);
      }
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "brain.entry_merged", {
        targetEntryId,
        sourceEntryId
      });
      await this.publishSnapshot("brain.entry_merged");
    });
  }

  private async appendHookProgressFromRpc(params: Record<string, unknown>): Promise<void> {
    const taskId = typeof params.taskId === "string" && params.taskId.trim() ? params.taskId.trim() : null;
    const transcriptPath =
      typeof params.transcriptPath === "string" && params.transcriptPath.trim()
        ? params.transcriptPath.trim()
        : null;
    const entries = Array.isArray(params.entries)
      ? params.entries.filter((entry) => entry && typeof entry === "object")
      : [];
    if (!taskId || entries.length === 0) {
      throw new Error("Hook progress requires a taskId and at least one entry.");
    }

    if (transcriptPath) {
      await this.runMutation(async () => {
        const task = this.session.tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
          return;
        }
        task.routeMetadata = {
          ...task.routeMetadata,
          claudeTranscriptPath: transcriptPath
        };
        await saveSessionRecord(this.paths, this.session);
      });
    }

    for (const entry of entries) {
      const payload = entry as Record<string, unknown>;
      await this.appendTaskProgress(
        taskId,
        "provider",
        Array.isArray(payload.paths) ? payload.paths.map((item) => String(item)) : [],
        typeof payload.summary === "string" ? payload.summary : "Provider runtime event",
        {
          provider:
            payload.provider === "codex" || payload.provider === "claude" || payload.provider === "node"
              ? payload.provider
              : null,
          eventName: typeof payload.eventName === "string" ? payload.eventName : null,
          source:
            payload.source === "notification" ||
            payload.source === "stderr" ||
            payload.source === "stdout" ||
            payload.source === "delta" ||
            payload.source === "worktree" ||
            payload.source === "hook" ||
            payload.source === "transcript"
              ? payload.source
              : null
        }
      );
    }
  }

  private async landFromRpc() {
    return await this.runMutation(async () => {
      const pendingFollowUps = activeFollowUpRecommendations(this.session);
      if (pendingFollowUps.length > 0) {
        throw new Error(
          `Landing is blocked by ${pendingFollowUps.length} follow-up recommendation(s). Review or dismiss them before landing.`
        );
      }

      const result = await executeLand(this.paths);
      this.session = await loadSessionRecord(this.paths);
      await this.publishSnapshot(
        result.status === "landed" ? "land.completed" : "land.overlap_detected"
      );
      return result;
    });
  }

  private async getTaskArtifactFromRpc(params: Record<string, unknown>) {
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    if (!taskId) {
      throw new Error("taskArtifact requires a taskId.");
    }

    return await loadTaskArtifact(this.paths, taskId);
  }

  private async getEventsFromRpc(params: Record<string, unknown>): Promise<EventRecord[]> {
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? params.limit
        : 20;
    return await readRecentEvents(this.paths, limit);
  }

  private async getWorktreeDiffFromRpc(params: Record<string, unknown>) {
    const agent = params.agent === "claude" ? "claude" : "codex";
    const filePath = typeof params.filePath === "string" ? params.filePath : null;
    const worktree = this.session.worktrees.find((item) => item.agent === agent);
    if (!worktree) {
      throw new Error(`No managed worktree found for ${agent}.`);
    }

    return await getWorktreeDiffReview(agent, worktree.path, this.session.baseCommit, filePath);
  }

  private async addReviewNoteFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const agent = params.agent === "claude" ? "claude" : "codex";
      const filePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
      const disposition = normalizeReviewDisposition(params.disposition);
      const assignee = normalizeReviewAssignee(params.assignee) ?? agent;
      const body = typeof params.body === "string" ? params.body.trim() : "";
      const taskId = typeof params.taskId === "string" ? params.taskId : null;
      const hunkIndex = typeof params.hunkIndex === "number" ? params.hunkIndex : null;
      const hunkHeader = typeof params.hunkHeader === "string" ? params.hunkHeader : null;

      if (!filePath) {
        throw new Error("addReviewNote requires a filePath.");
      }

      if (!body) {
        throw new Error("addReviewNote requires a note body.");
      }

      const note = addReviewNote(this.session, {
        agent,
        assignee,
        taskId,
        filePath,
        hunkIndex,
        hunkHeader,
        disposition,
        body
      });
      addDecisionRecord(this.session, {
        kind: "review",
        agent,
        taskId,
        summary: note.summary,
        detail: note.body,
        metadata: {
          filePath: note.filePath,
          hunkIndex: note.hunkIndex,
          hunkHeader: note.hunkHeader,
          disposition: note.disposition,
          assignee: note.assignee,
          reviewNoteId: note.id
        }
      });
      await saveSessionRecord(this.paths, this.session);

      if (taskId) {
        await this.refreshTaskArtifactReviewNotes(taskId);
      }

      await recordEvent(this.paths, this.session.id, "review.note_added", {
        reviewNoteId: note.id,
        agent: note.agent,
        taskId: note.taskId,
        filePath: note.filePath,
        hunkIndex: note.hunkIndex,
        disposition: note.disposition,
        assignee: note.assignee
      });
      await this.publishSnapshot("review.note_added");
    });
  }

  private async updateReviewNoteFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const noteId = typeof params.noteId === "string" ? params.noteId : "";
      const body = typeof params.body === "string" ? params.body.trim() : undefined;
      const disposition =
        params.disposition === undefined
          ? undefined
          : normalizeReviewDisposition(params.disposition);
      const assignee =
        params.assignee === undefined ? undefined : normalizeReviewAssignee(params.assignee);
      if (!noteId) {
        throw new Error("updateReviewNote requires a noteId.");
      }

      if (
        (body === undefined || body.length === 0) &&
        disposition === undefined &&
        assignee === undefined
      ) {
        throw new Error("updateReviewNote requires at least one body, disposition, or assignee change.");
      }

      if (body !== undefined && body.length === 0) {
        throw new Error("updateReviewNote requires a non-empty note body.");
      }

      const note = updateReviewNote(this.session, noteId, {
        ...(body !== undefined ? { body } : {}),
        ...(disposition !== undefined ? { disposition } : {}),
        ...(assignee !== undefined ? { assignee } : {})
      });
      if (!note) {
        throw new Error(`Review note ${noteId} was not found.`);
      }

      addDecisionRecord(this.session, {
        kind: "review",
        agent: note.agent,
        taskId: note.taskId,
        summary: `Edited review note ${note.id}`,
        detail: note.body,
        metadata: {
          reviewNoteId: note.id,
          filePath: note.filePath,
          hunkIndex: note.hunkIndex,
          disposition: note.disposition,
          assignee: note.assignee
        }
      });
      await saveSessionRecord(this.paths, this.session);
      if (note.taskId) {
        await this.refreshTaskArtifactReviewNotes(note.taskId);
      }
      await recordEvent(this.paths, this.session.id, "review.note_updated", {
        reviewNoteId: note.id,
        taskId: note.taskId,
        agent: note.agent,
        filePath: note.filePath,
        disposition: note.disposition,
        assignee: note.assignee
      });
      await this.publishSnapshot("review.note_updated");
    });
  }

  private async addReviewReplyFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const noteId = typeof params.noteId === "string" ? params.noteId : "";
      const body = typeof params.body === "string" ? params.body.trim() : "";
      if (!noteId) {
        throw new Error("addReviewReply requires a noteId.");
      }

      if (!body) {
        throw new Error("addReviewReply requires a reply body.");
      }

      const note = addReviewReply(this.session, noteId, body);
      if (!note) {
        throw new Error(`Review note ${noteId} was not found.`);
      }

      addDecisionRecord(this.session, {
        kind: "review",
        agent: note.agent,
        taskId: note.taskId,
        summary: `Replied to review note ${note.id}`,
        detail: body,
        metadata: {
          reviewNoteId: note.id,
          filePath: note.filePath,
          hunkIndex: note.hunkIndex,
          replyCount: note.comments.length
        }
      });
      await saveSessionRecord(this.paths, this.session);
      if (note.taskId) {
        await this.refreshTaskArtifactReviewNotes(note.taskId);
      }
      await recordEvent(this.paths, this.session.id, "review.reply_added", {
        reviewNoteId: note.id,
        taskId: note.taskId,
        agent: note.agent,
        filePath: note.filePath,
        replyCount: note.comments.length
      });
      await this.publishSnapshot("review.reply_added");
    });
  }

  private async setReviewNoteStatusFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const noteId = typeof params.noteId === "string" ? params.noteId : "";
      const status = params.status === "resolved" ? "resolved" : "open";
      if (!noteId) {
        throw new Error("setReviewNoteStatus requires a noteId.");
      }

      const note = setReviewNoteStatus(this.session, noteId, status);
      if (!note) {
        throw new Error(`Review note ${noteId} was not found.`);
      }

      addDecisionRecord(this.session, {
        kind: "review",
        agent: note.agent,
        taskId: note.taskId,
        summary: `${status === "resolved" ? "Resolved" : "Reopened"} review note ${note.id}`,
        detail: note.summary,
        metadata: {
          reviewNoteId: note.id,
          status,
          filePath: note.filePath,
          hunkIndex: note.hunkIndex
        }
      });
      await saveSessionRecord(this.paths, this.session);
      if (note.taskId) {
        await this.refreshTaskArtifactReviewNotes(note.taskId);
      }
      await recordEvent(this.paths, this.session.id, "review.note_status_changed", {
        reviewNoteId: note.id,
        taskId: note.taskId,
        agent: note.agent,
        filePath: note.filePath,
        status: note.status
      });
      await this.publishSnapshot("review.note_status_changed");
    });
  }

  private async enqueueReviewFollowUpFromRpc(params: Record<string, unknown>): Promise<void> {
    await this.runMutation(async () => {
      const noteId = typeof params.noteId === "string" ? params.noteId : "";
      const owner = params.owner === "claude" ? "claude" : "codex";
      const mode = params.mode === "handoff" ? "handoff" : "fix";
      if (!noteId) {
        throw new Error("enqueueReviewFollowUp requires a noteId.");
      }

      const note = this.session.reviewNotes.find((item) => item.id === noteId) ?? null;
      if (!note) {
        throw new Error(`Review note ${noteId} was not found.`);
      }

      const taskId = `task-review-${Date.now()}`;
      const sourceMissionId =
        typeof note.taskId === "string"
          ? this.session.tasks.find((task) => task.id === note.taskId)?.missionId ?? null
          : null;
      const scope = note.hunkHeader
        ? `${note.filePath} ${note.hunkHeader}`
        : note.filePath;
      const promptLines = [
        `${mode === "handoff" ? "Handle a review handoff" : "Address a review note"} for ${scope}.`,
        `Disposition: ${note.disposition}.`,
        `Review note: ${note.body}`
      ];
      if (note.taskId) {
        promptLines.push(`Originating task: ${note.taskId}.`);
      }
      if (mode === "handoff") {
        promptLines.push(`This was handed off from ${note.agent} work to ${owner}.`);
      }
      promptLines.push(`Focus the change in ${note.filePath} and update the managed worktree accordingly.`);

      const task = buildAdHocTask(owner, promptLines.join(" "), taskId, {
        missionId: sourceMissionId,
        nodeKind: mode === "handoff" ? "integration" : "repair",
        retryCount: 0,
        maxRetries: resolveTaskRetryBudget(
          this.session,
          sourceMissionId,
          mode === "handoff" ? "integration" : "repair",
          "execution"
        ),
        routeReason:
          mode === "handoff"
            ? `Operator handed off review note ${note.id} to ${owner}.`
            : `Operator created a follow-up task from review note ${note.id}.`,
        routeStrategy: "manual",
        routeConfidence: 1,
        routeMetadata: {
          source: "review-follow-up",
          mode,
          reviewNoteId: note.id,
          nodeKind: mode === "handoff" ? "integration" : "repair"
        },
        claimedPaths: [note.filePath]
      });
      this.session.tasks.push(task);
      this.syncSessionDerivedState();
      linkReviewFollowUpTask(this.session, note.id, taskId, owner);
      upsertPathClaim(this.session, {
        taskId,
        agent: owner,
        source: "route",
        paths: task.claimedPaths,
        note: task.routeReason
      });
      addDecisionRecord(this.session, {
        kind: "review",
        agent: owner,
        taskId,
        summary: `Queued ${mode} follow-up from review note ${note.id}`,
        detail: note.body,
        metadata: {
          reviewNoteId: note.id,
          owner,
          mode,
          filePath: note.filePath,
          sourceAgent: note.agent,
          assignee: owner
        }
      });
      await saveSessionRecord(this.paths, this.session);
      if (note.taskId) {
        await this.refreshTaskArtifactReviewNotes(note.taskId);
      }
      await recordEvent(this.paths, this.session.id, "review.followup_queued", {
        reviewNoteId: note.id,
        followUpTaskId: taskId,
        owner,
        mode,
        filePath: note.filePath,
        assignee: owner
      });
      await this.publishSnapshot("review.followup_queued");
    });
  }

  private async refreshTaskArtifactReviewNotes(taskId: string): Promise<void> {
    const artifact = await loadTaskArtifact(this.paths, taskId);
    if (!artifact) {
      return;
    }

    artifact.reviewNotes = reviewNotesForTask(this.session, taskId);
    await saveTaskArtifact(this.paths, artifact);
  }

  private async refreshReviewArtifactsForNotes(notes: Array<{ taskId: string | null }>): Promise<void> {
    const taskIds = [...new Set(notes.map((note) => note.taskId).filter((value): value is string => Boolean(value)))];
    for (const taskId of taskIds) {
      await this.refreshTaskArtifactReviewNotes(taskId);
    }
  }

  private async publishSnapshot(reason: string): Promise<void> {
    if (this.subscribers.size === 0) {
      return;
    }

    const snapshot = await this.buildSnapshot();
    const notification: RpcNotification = {
      method: "snapshot.updated",
      params: {
        reason,
        snapshot
      } satisfies SnapshotSubscriptionEvent
    };

    for (const subscriber of this.subscribers) {
      this.writeNotification(subscriber, notification);
    }
  }

  private async closeRpcServer(): Promise<void> {
    const server = this.rpcServer;
    this.rpcServer = null;
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.subscribers.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await fs.rm(this.paths.socketPath, { force: true }).catch(() => {});
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }

    this.processing = true;

    try {
      let shouldStop = false;
      await this.runMutation(async () => {
        const onDiskSession = await loadSessionRecord(this.paths);
        if (onDiskSession.id !== this.managedSessionId || onDiskSession.status === "stopped") {
          shouldStop = true;
          return;
        }

        this.session = onDiskSession;
        this.session.daemonPid = process.pid;
        this.session.daemonHeartbeatAt = new Date().toISOString();
        this.session.daemonVersion = this.daemonVersion;
        this.session.protocolVersion = this.daemonProtocolVersion;
        await saveSessionRecord(this.paths, this.session);
        await this.consumeQueuedCommands();

        if (this.session.tasks.length === 0 && this.session.goal) {
          const mission = this.createMissionForPrompt(this.session.goal, {
            goal: this.session.goal
          });
          await this.hydrateMissionContext(mission.id, this.session.goal);
          this.session.tasks = buildKickoffTasks(this.session.goal, mission.id);
          mission.activeTaskIds = ["kickoff-codex", "kickoff-claude"];
          mission.planningTaskId = "kickoff-codex";
          this.syncSessionDerivedState();
          await saveSessionRecord(this.paths, this.session);
          await recordEvent(this.paths, this.session.id, "tasks.kickoff_created", {
            count: this.session.tasks.length,
            missionId: mission.id
          });
          await this.publishSnapshot("tasks.kickoff_created");
        }

        this.syncSessionDerivedState();
        const recoveredTasks = recoverExpiredTaskLeases(this.session, this.runningAgents);
        for (const task of recoveredTasks) {
          addMissionCheckpoint(this.session, task.missionId, {
            kind: "task_recovered",
            title: `Recovered stale task lease: ${task.title}`,
            detail: "Kavi recovered a stale running task back into the queue because its lease expired.",
            taskId: task.id
          });
          addDecisionRecord(this.session, {
            kind: "task",
            agent: task.owner,
            taskId: task.id,
            summary: `Recovered stale task lease for ${task.id}`,
            detail: task.summary ?? "Recovered a stale task lease.",
            metadata: {
              recovered: true,
              retryCount: task.retryCount,
              maxRetries: task.maxRetries
            }
          });
        }
        if (recoveredTasks.length > 0) {
          this.syncSessionDerivedState();
          await saveSessionRecord(this.paths, this.session);
          await recordEvent(this.paths, this.session.id, "task.lease_recovered", {
            taskIds: recoveredTasks.map((task) => task.id),
            count: recoveredTasks.length
          });
          await this.publishSnapshot("task.lease_recovered");
        }
        const readyTasks = this.session.tasks.filter((task) => isTaskReady(this.session, task));
        for (const agent of ["codex", "claude"] as AgentName[]) {
          if (this.runningAgents.has(agent)) {
            continue;
          }

          const nextTask = readyTasks.find((task) => task.owner === agent);
          if (!nextTask) {
            continue;
          }

          this.startTaskRun(nextTask.id, agent);
        }

        if (readyTasks.length === 0) {
          await this.maybeAutopilotFollowUp();
        }
      });

      if (shouldStop) {
        this.running = false;
        if (this.interval) {
          clearInterval(this.interval);
          this.interval = null;
        }
        await this.closeRpcServer();
        this.stopResolver?.();
        return;
      }
    } finally {
      this.processing = false;
    }
  }

  private async consumeQueuedCommands(): Promise<void> {
    const commands = await consumeCommands(this.paths);
    if (commands.length === 0) {
      return;
    }

    for (const command of commands) {
      if (command.type === "shutdown") {
        this.session.status = "stopped";
        this.running = false;
        this.session.daemonHeartbeatAt = new Date().toISOString();
        await saveSessionRecord(this.paths, this.session);
        await recordEvent(this.paths, this.session.id, "daemon.stopped", {});
        if (this.interval) {
          clearInterval(this.interval);
          this.interval = null;
        }
        await this.closeRpcServer();
        this.stopResolver?.();
        return;
      }

      if (command.type === "kickoff" && typeof command.payload.prompt === "string") {
      this.session.goal = command.payload.prompt;
      const mission = this.createMissionForPrompt(command.payload.prompt, {
        goal: command.payload.prompt
      });
      await this.hydrateMissionContext(mission.id, command.payload.prompt);
      const kickoffTasks = buildKickoffTasks(command.payload.prompt, mission.id).map((task) => ({
        ...task,
        maxRetries: resolveTaskRetryBudget(this.session, mission.id, task.nodeKind, task.kind)
      }));
      this.session.tasks.push(...kickoffTasks);
        mission.activeTaskIds = ["kickoff-codex", "kickoff-claude"];
        mission.planningTaskId = "kickoff-codex";
        this.syncSessionDerivedState();
        await saveSessionRecord(this.paths, this.session);
        await recordEvent(this.paths, this.session.id, "tasks.kickoff_enqueued", {
          count: 2,
          missionId: mission.id
        });
        await this.publishSnapshot("tasks.kickoff_enqueued");
        continue;
      }

      if (command.type === "enqueue" && typeof command.payload.prompt === "string") {
        const owner = command.payload.owner === "claude" ? "claude" : "codex";
        const missionPrompt =
          typeof command.payload.missionPrompt === "string" && command.payload.missionPrompt.trim()
            ? command.payload.missionPrompt.trim()
            : command.payload.prompt;
        const requestedPlanningMode: ComposerPlanningMode =
          command.payload.planningMode === "plan" || command.payload.planningMode === "direct"
            ? command.payload.planningMode
            : "auto";
        const missionMode =
          command.payload.missionMode === "inspect" || command.payload.missionMode === "manual"
            ? command.payload.missionMode
            : "guided_autopilot";
        const policyOverrides = this.buildMissionPolicyOverrides(command.payload);
        const planningDecision = decidePlanningMode(missionPrompt, this.session, requestedPlanningMode);
        const taskId = `task-${command.id}`;
        const mission = this.createMissionForPrompt(command.payload.prompt, {
          missionPrompt,
          mode: missionMode,
          planningTaskId: planningDecision.usePlanner ? "pending-planner" : null,
          rootTaskId: planningDecision.usePlanner ? null : taskId,
          shadowOfMissionId:
            typeof command.payload.shadowOfMissionId === "string"
              ? command.payload.shadowOfMissionId
              : null,
          policyOverrides
        });
        await this.hydrateMissionContext(mission.id, missionPrompt);
        const task = planningDecision.usePlanner
          ? buildPlannerTask(this.session, command.payload.prompt, {
              planningMode: "operator",
              missionId: mission.id,
              title:
                typeof command.payload.title === "string" && command.payload.title.trim()
                  ? command.payload.title.trim()
                  : "Codex orchestration plan"
            })
          : (() => {
              const title =
                typeof command.payload.title === "string" && command.payload.title.trim()
                  ? command.payload.title.trim()
                  : undefined;
              const nodeKind = inferPromptNodeKind(title, command.payload.prompt, owner, "execution");
              return buildAdHocTask(owner, command.payload.prompt, taskId, {
                missionId: mission.id,
                title,
                nodeKind,
                retryCount: 0,
                maxRetries: resolveTaskRetryBudget(this.session, mission.id, nodeKind, "execution"),
                routeReason:
                  typeof command.payload.routeReason === "string" ? command.payload.routeReason : null,
                routeStrategy:
                  command.payload.routeStrategy === "manual" ||
                  command.payload.routeStrategy === "keyword" ||
                  command.payload.routeStrategy === "ai" ||
                  command.payload.routeStrategy === "path-claim" ||
                  command.payload.routeStrategy === "fallback"
                    ? command.payload.routeStrategy
                    : null,
                routeConfidence:
                  typeof command.payload.routeConfidence === "number"
                    ? command.payload.routeConfidence
                    : null,
                routeMetadata:
                  command.payload.routeMetadata &&
                  typeof command.payload.routeMetadata === "object" &&
                  !Array.isArray(command.payload.routeMetadata)
                    ? {
                        ...(command.payload.routeMetadata as Record<string, unknown>),
                        requestedPlanningMode,
                        planningDecision: planningDecision.reason,
                        nodeKind,
                        missionMode,
                        shadowOfMissionId:
                          typeof command.payload.shadowOfMissionId === "string"
                            ? command.payload.shadowOfMissionId
                            : null
                      }
                    : {
                        requestedPlanningMode,
                        planningDecision: planningDecision.reason,
                        nodeKind,
                        missionMode,
                        shadowOfMissionId:
                          typeof command.payload.shadowOfMissionId === "string"
                            ? command.payload.shadowOfMissionId
                            : null
                      },
                claimedPaths: Array.isArray(command.payload.claimedPaths)
                  ? command.payload.claimedPaths.map((item) => String(item))
                  : []
              });
            })();
        if (planningDecision.usePlanner) {
          mission.planningTaskId = task.id;
          mission.activeTaskIds = [task.id];
        } else {
          mission.rootTaskId = task.id;
        }
        this.session.tasks.push(task);
        this.syncSessionDerivedState();
        addDecisionRecord(this.session, {
          kind: planningDecision.usePlanner ? "plan" : "route",
          agent: planningDecision.usePlanner ? "codex" : owner,
          taskId: task.id,
          summary: planningDecision.usePlanner ? "Queued orchestration planner" : `Routed task to ${owner}`,
          detail:
            planningDecision.usePlanner
              ? planningDecision.reason
              : typeof command.payload.routeReason === "string"
                ? command.payload.routeReason
                : `Task enqueued for ${owner}.`,
          metadata: {
            strategy:
              planningDecision.usePlanner
                ? "planner"
                : typeof command.payload.routeStrategy === "string"
                  ? command.payload.routeStrategy
                  : "unknown",
            confidence:
              planningDecision.usePlanner
                ? 1
                : typeof command.payload.routeConfidence === "number"
                  ? command.payload.routeConfidence
                  : null,
            claimedPaths: task.claimedPaths,
            routeMetadata: task.routeMetadata,
            planningMode: requestedPlanningMode,
            planningDecision: planningDecision.reason,
            missionId: mission.id,
            missionMode,
            shadowOfMissionId: mission.shadowOfMissionId ?? null
          }
        });
        upsertPathClaim(this.session, {
          taskId: task.id,
          agent: task.owner === "claude" ? "claude" : "codex",
          source: "route",
          paths: task.claimedPaths,
          note: task.routeReason
        });
        if (typeof command.payload.recommendationId === "string") {
          recordRecommendationApplied(this.session, command.payload.recommendationId, task.id);
        }
        await saveSessionRecord(this.paths, this.session);
        await recordEvent(this.paths, this.session.id, "task.enqueued", {
          owner: task.owner,
          planningMode: requestedPlanningMode,
          planningDecision: planningDecision.reason,
          missionId: mission.id,
          missionMode,
          shadowOfMissionId: mission.shadowOfMissionId ?? null,
          recommendationId:
            typeof command.payload.recommendationId === "string"
              ? command.payload.recommendationId
              : null
        });
        if (
            typeof command.payload.recommendationId === "string" &&
          (command.payload.recommendationKind === "handoff" ||
            command.payload.recommendationKind === "follow_up" ||
            command.payload.recommendationKind === "integration" ||
            command.payload.recommendationKind === "ownership-config")
        ) {
          await recordEvent(this.paths, this.session.id, "recommendation.applied", {
            recommendationId: command.payload.recommendationId,
            recommendationKind: command.payload.recommendationKind,
            owner: task.owner,
            taskId: task.id
          });
        }
        await this.publishSnapshot("task.enqueued");
      }
    }
  }

  private async runTask(task: TaskSpec): Promise<void> {
    await this.runTaskById(task.id);
  }

  private startTaskRun(taskId: string, agent: AgentName): void {
    this.runningAgents.add(agent);
    void this.runTaskById(taskId)
      .catch(async (error) => {
        await recordEvent(this.paths, this.managedSessionId, "task.run_crashed", {
          taskId,
          agent,
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => {});
      })
      .finally(() => {
        this.runningAgents.delete(agent);
      });
  }

  private async appendTaskProgress(
    taskId: string,
    kind: TaskProgressEntry["kind"],
    paths: string[],
    summary: string,
    metadata: {
      provider?: AgentName | "node" | null;
      eventName?: string | null;
      source?: TaskProgressEntry["source"] | null;
    } = {}
  ): Promise<void> {
    await this.runMutation(async () => {
      this.session = await loadSessionRecord(this.paths);
      const task = this.session.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== "running") {
        return;
      }

      const artifact = await loadTaskArtifact(this.paths, taskId);
      if (!artifact) {
        return;
      }
      renewTaskLease(task);

      const lastEntry = artifact.progress.at(-1) ?? null;
      if (
        lastEntry &&
        lastEntry.kind === kind &&
        lastEntry.summary === summary &&
        lastEntry.paths.join("\n") === paths.join("\n")
      ) {
        return;
      }

      const progressEntry: TaskProgressEntry = {
        id: `progress-${Date.now()}`,
        kind,
        summary,
        paths: [...paths],
        createdAt: nowIso(),
        provider: metadata.provider ?? null,
        eventName: metadata.eventName ?? null,
        source: metadata.source ?? null
      };
      artifact.progress.push(progressEntry);
      artifact.retryCount = task.retryCount;
      artifact.maxRetries = task.maxRetries;
      artifact.lastFailureSummary = task.lastFailureSummary;
      await saveTaskArtifact(this.paths, artifact);

      const checkpointTitle =
        kind === "stalled"
          ? `Task stalled: ${task.title}`
          : kind === "provider" && metadata.provider && metadata.eventName
            ? `${metadata.provider === "codex" ? "Codex" : metadata.provider === "claude" ? "Claude" : "Runtime"} ${metadata.eventName.replaceAll(/[-_]+/g, " ")}`
            : `Task progress: ${task.title}`;
      addMissionCheckpoint(this.session, task.missionId, {
        kind: kind === "stalled" ? "task_stalled" : "task_progress",
        title: checkpointTitle,
        detail: summary,
        taskId: task.id
      });
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "task.progress", {
        taskId: task.id,
        owner: task.owner,
        kind,
        paths,
        summary,
        provider: metadata.provider ?? null,
        eventName: metadata.eventName ?? null,
        source: metadata.source ?? null
      });
      await this.publishSnapshot("task.progress");
    });
  }

  private startTaskProgressMonitor(
    task: TaskSpec,
    session: SessionRecord,
    options: {
      onMeaningfulActivity?: (paths: string[]) => void;
    } = {}
  ): () => void {
    if (task.owner !== "codex" && task.owner !== "claude") {
      return () => {};
    }

    const worktree = session.worktrees.find((item) => item.agent === task.owner);
    if (!worktree) {
      return () => {};
    }

    let disposed = false;
    let lastSignature = "";
    let lastMeaningfulAt = Date.now();
    let lastHeartbeatAt = 0;
    const interval = setInterval(() => {
      if (disposed) {
        return;
      }

      void (async () => {
        const changedPaths = await listWorktreeChangedPaths(worktree.path, session.baseCommit);
        const signature = changedPaths.join("\n");
        if (signature !== lastSignature) {
          lastSignature = signature;
          if (changedPaths.length > 0) {
            lastMeaningfulAt = Date.now();
            options.onMeaningfulActivity?.(changedPaths);
          }
          lastHeartbeatAt = Date.now();
          await this.appendTaskProgress(
            task.id,
            changedPaths.length > 0 ? "change" : "heartbeat",
            changedPaths,
            summarizeProgressPaths(changedPaths),
            {
              source: "worktree"
            }
          );
          return;
        }

        const now = Date.now();
        if (now - lastHeartbeatAt < 30_000) {
          return;
        }

        lastHeartbeatAt = now;
        if (now - lastMeaningfulAt >= 60_000) {
          await this.appendTaskProgress(task.id, "stalled", changedPaths, "Task is still running but no new worktree changes have appeared for about a minute.", {
            source: "worktree"
          });
          return;
        }

        await this.appendTaskProgress(
          task.id,
          "heartbeat",
          changedPaths,
          changedPaths.length > 0 ? `Task is still running with ${changedPaths.length} changed path(s) in progress.` : "Task is still running; worktree output has not appeared yet.",
          {
            source: "worktree"
          }
        );
      })().catch(() => {});
    }, 5_000);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }

  private async runTaskById(taskId: string): Promise<void> {
    let startedAt = nowIso();
    let taskSnapshot: TaskSpec | null = null;
    let sessionSnapshot: SessionRecord | null = null;

    await this.runMutation(async () => {
      this.session = await loadSessionRecord(this.paths);
      this.syncSessionDerivedState();
      const task = this.session.tasks.find((candidate) => candidate.id === taskId);
      if (!task || !isTaskReady(this.session, task)) {
        taskSnapshot = null;
        return;
      }

      startedAt = nowIso();
      task.status = "running";
      if (task.owner === "codex" || task.owner === "claude") {
        task.lease = createTaskLease(task.owner, startedAt);
      }
      task.updatedAt = startedAt;
      addMissionCheckpoint(this.session, task.missionId, {
        kind: "task_started",
        title: `Task started: ${task.title}`,
        detail: `${task.owner} started ${task.kind} work.`,
        taskId: task.id
      });
      taskSnapshot = { ...task };
      sessionSnapshot = structuredClone(this.session);
      const existingArtifact = await loadTaskArtifact(this.paths, task.id);
      await saveTaskArtifact(this.paths, {
        taskId: task.id,
        sessionId: this.session.id,
        missionId: task.missionId,
        title: task.title,
        owner: task.owner,
        kind: task.kind,
        nodeKind: task.nodeKind,
        status: task.status,
        summary: task.summary,
        nextRecommendation: task.nextRecommendation,
        dependsOnTaskIds: task.dependsOnTaskIds,
        parentTaskId: task.parentTaskId,
        planId: task.planId,
        planNodeKey: task.planNodeKey,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries,
        lastFailureSummary: task.lastFailureSummary,
        routeReason: task.routeReason,
        routeStrategy: task.routeStrategy,
        routeConfidence: task.routeConfidence,
        routeMetadata: task.routeMetadata,
        claimedPaths: task.claimedPaths,
        decisionReplay: buildDecisionReplay(
          this.session,
          task,
          task.owner === "claude" ? "claude" : "codex"
        ),
        rawOutput: null,
        error: null,
        envelope: null,
        reviewNotes: reviewNotesForTask(this.session, task.id),
        progress: existingArtifact?.progress ?? [],
        attempts: startTaskAttempt(
          existingArtifact?.attempts ?? [],
          startedAt,
          nextTaskAttemptNumber(existingArtifact?.attempts ?? [])
        ),
        startedAt,
        finishedAt: null
      });
      await saveSessionRecord(this.paths, this.session);
      await recordEvent(this.paths, this.session.id, "task.started", {
        taskId: task.id,
        owner: task.owner,
        kind: task.kind
      });
      await this.publishSnapshot("task.started");
    });

    if (!taskSnapshot || !sessionSnapshot) {
      return;
    }

    const liveness = {
      lastMeaningfulAt: Date.now(),
      lastMeaningfulSummary: ""
    };
    const inactivityTimeoutMs = 120_000;
    const taskAbortController = new AbortController();
    const noteMeaningfulActivity = (summary: string | null = null): void => {
      liveness.lastMeaningfulAt = Date.now();
      if (summary?.trim()) {
        liveness.lastMeaningfulSummary = truncateProgressText(summary.trim(), 240);
      }
    };
    const stopProgressMonitor = this.startTaskProgressMonitor(taskSnapshot, sessionSnapshot, {
      onMeaningfulActivity: (paths) => {
        noteMeaningfulActivity(summarizeProgressPaths(paths));
      }
    });
    const runtimeActivity = {
      buffer: "",
      lastFlushedAt: 0
    };
    const inactivityInterval = setInterval(() => {
      if (Date.now() - liveness.lastMeaningfulAt < inactivityTimeoutMs || taskAbortController.signal.aborted) {
        return;
      }

      const reason = new Error(
        liveness.lastMeaningfulSummary
          ? `Task timed out after 120 seconds without meaningful runtime output or worktree changes. Last activity: ${liveness.lastMeaningfulSummary}`
          : "Task timed out after 120 seconds without meaningful runtime output or worktree changes."
      );
      taskAbortController.abort(reason);
    }, 5_000);

    const flushRuntimeActivity = async (force = false): Promise<void> => {
      if (taskSnapshot?.owner !== "codex" && taskSnapshot?.owner !== "claude") {
        runtimeActivity.buffer = "";
        return;
      }

      const normalized = stripAnsi(runtimeActivity.buffer)
        .replaceAll("\r", "\n")
        .replaceAll(/\s+/g, " ")
        .trim();

      if (!normalized || looksLikeStructuredEnvelope(normalized)) {
        runtimeActivity.buffer = "";
        return;
      }

      if (
        !force &&
        normalized.length < 80 &&
        !/[.!?:]$/.test(normalized) &&
        Date.now() - runtimeActivity.lastFlushedAt < 4_000
      ) {
        return;
      }

      runtimeActivity.buffer = "";
      runtimeActivity.lastFlushedAt = Date.now();
      noteMeaningfulActivity(normalized);
      const mentionedPaths = extractRuntimeMentionedPaths(normalized);
      await this.appendTaskProgress(
        taskId,
        "provider",
        mentionedPaths,
        buildRuntimeActivitySummary(taskSnapshot.owner, normalized),
        {
          provider: taskSnapshot.owner,
          eventName: "runtime",
          source: "stderr"
        }
      );
    };

    const captureRuntimeActivity = (chunk: string): void => {
      if (typeof chunk !== "string" || !chunk.trim()) {
        return;
      }

      for (const event of taskSnapshot?.owner === "claude" ? parseClaudeRuntimeText(chunk) : []) {
        noteMeaningfulActivity(event.summary);
        void this.appendTaskProgress(taskId, "provider", event.paths, event.summary, {
          provider: event.provider,
          eventName: event.eventName,
          source: event.source
        });
      }

      runtimeActivity.buffer += chunk;
      const normalizedChunk = stripAnsi(chunk).replaceAll("\r", "\n");
      if (
        runtimeActivity.buffer.length >= 180 ||
        normalizedChunk.includes("\n") ||
        /[.!?:]\s*$/.test(normalizedChunk)
      ) {
        void flushRuntimeActivity();
      }
    };

    const captureCodexAssistantDelta = (chunk: string): void => {
      if (typeof chunk !== "string" || !chunk.trim()) {
        return;
      }
      for (const event of parseCodexAssistantDeltaText(chunk)) {
        noteMeaningfulActivity(event.summary);
        void this.appendTaskProgress(taskId, "provider", event.paths, event.summary, {
          provider: event.provider,
          eventName: event.eventName,
          source: event.source
        });
      }
    };

    const claudeTranscript = {
      path:
        taskSnapshot.owner === "claude" &&
        typeof taskSnapshot.routeMetadata?.claudeTranscriptPath === "string" &&
        taskSnapshot.routeMetadata.claudeTranscriptPath.trim()
          ? taskSnapshot.routeMetadata.claudeTranscriptPath.trim()
          : null,
      seenEventIds: new Set<string>()
    };
    const flushClaudeTranscript = async (): Promise<void> => {
      if (taskSnapshot?.owner !== "claude") {
        return;
      }

      const liveTask = this.session.tasks.find((candidate) => candidate.id === taskId) ?? null;
      const transcriptPath =
        typeof liveTask?.routeMetadata?.claudeTranscriptPath === "string" &&
        liveTask.routeMetadata.claudeTranscriptPath.trim()
          ? liveTask.routeMetadata.claudeTranscriptPath.trim()
          : claudeTranscript.path;
      if (!transcriptPath) {
        return;
      }
      claudeTranscript.path = transcriptPath;

      let rawTranscript = "";
      try {
        rawTranscript = await fs.readFile(transcriptPath, "utf8");
      } catch {
        return;
      }

      const lines = rawTranscript
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const parsed = parseClaudeTranscriptLine(line);
        if (parsed.events.length === 0) {
          continue;
        }

        const baseId = parsed.id ?? `line:${lineIndex}:${line.slice(0, 160)}`;
        for (let eventIndex = 0; eventIndex < parsed.events.length; eventIndex += 1) {
          const event = parsed.events[eventIndex];
          if (!event) {
            continue;
          }

          const eventKey = `${baseId}:${eventIndex}:${event.eventName ?? "-"}:${event.summary}`;
          if (claudeTranscript.seenEventIds.has(eventKey)) {
            continue;
          }
          claudeTranscript.seenEventIds.add(eventKey);
          noteMeaningfulActivity(event.summary);
          await this.appendTaskProgress(taskId, "provider", event.paths, event.summary, {
            provider: event.provider,
            eventName: event.eventName,
            source: event.source
          });
        }
      }
    };
    const stopClaudeTranscriptMonitor =
      taskSnapshot.owner === "claude"
        ? (() => {
            let disposed = false;
            const interval = setInterval(() => {
              if (disposed || taskAbortController.signal.aborted) {
                return;
              }

              void flushClaudeTranscript();
            }, 1_500);
            return () => {
              disposed = true;
              clearInterval(interval);
            };
          })()
        : () => {};

    try {
      let envelope: AgentTurnEnvelope;
      let peerMessages: PeerMessage[];
      let rawOutput: string | null = null;
      let runtimeSessionId: string | null = null;
      let autoAdvanceMissionId: string | null = null;

      if (taskSnapshot.owner === "codex") {
        const result = await runCodexTask(sessionSnapshot, taskSnapshot, this.paths, {
          onRuntimeText: captureRuntimeActivity,
          onAssistantDelta: captureCodexAssistantDelta,
          onProviderEvent: (event) => {
            noteMeaningfulActivity(event.summary);
            void this.appendTaskProgress(taskId, "provider", event.paths, event.summary, {
              provider: event.provider,
              eventName: event.eventName,
              source: event.source
            });
          },
          signal: taskAbortController.signal
        });
        envelope = result.envelope;
        rawOutput = result.raw;
        peerMessages = buildCodexPeerMessages(result.envelope, "codex", taskSnapshot.id);
        runtimeSessionId = result.threadId;
      } else if (taskSnapshot.owner === "claude") {
        const result = await runClaudeTask(sessionSnapshot, taskSnapshot, this.paths, {
          onRuntimeText: captureRuntimeActivity,
          signal: taskAbortController.signal
        });
        envelope = result.envelope;
        rawOutput = result.raw;
        peerMessages = buildClaudePeerMessages(result.envelope, "claude", taskSnapshot.id);
        runtimeSessionId = result.sessionId;
        await flushClaudeTranscript();
      } else {
        throw new Error(`Unsupported task owner ${taskSnapshot.owner}.`);
      }

      await flushRuntimeActivity(true);

      await this.runMutation(async () => {
        this.session = await loadSessionRecord(this.paths);
        const task = this.session.tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
          return;
        }

        task.status = envelope.status === "completed" ? "completed" : "blocked";
        task.summary = envelope.summary;
        task.nextRecommendation = envelope.nextRecommendation;
        task.lastFailureSummary = null;
        releaseTaskLease(task);
        task.updatedAt = nowIso();
        this.session.agentStatus[task.owner as AgentName] = {
          ...this.session.agentStatus[task.owner as AgentName],
          lastRunAt: task.updatedAt,
          lastExitCode: 0,
          sessionId: runtimeSessionId,
          summary: envelope.summary
        };

        if (task.owner === "codex" || task.owner === "claude") {
          await this.refreshTaskClaims(task);
        }
        const mission = this.session.missions.find((item) => item.id === task.missionId) ?? null;
        if (mission) {
          updateMissionSummaryFromTask(mission, task);
        }

        addDecisionRecord(this.session, {
          kind: "task",
          agent: task.owner === "router" ? "router" : task.owner,
          taskId: task.id,
          summary: `${task.owner} task ${task.status}`,
          detail: task.summary ?? envelope.summary,
          metadata: {
            title: task.title,
            kind: task.kind,
            status: task.status,
            claimedPaths: task.claimedPaths
          }
        });

        let materializedPlanCount = 0;
        let publishReason = "task.completed";
        if (task.kind === "planner" && envelope.status === "completed" && envelope.plan) {
          const { plan, tasks } = materializeExecutionPlan(this.session, task, envelope.plan, task.prompt);
          materializedPlanCount = tasks.length;
          publishReason = "plan.materialized";
          attachMissionPlan(this.session, task.missionId, plan.id, plan.summary);
          addMissionCheckpoint(this.session, task.missionId, {
            kind: "plan_materialized",
            title: "Execution graph materialized",
            detail: `${tasks.length} planned task(s) are now scheduled for the mission.`,
            taskId: task.id
          });
          addDecisionRecord(this.session, {
            kind: "plan",
            agent: "codex",
            taskId: task.id,
            summary: `Materialized execution plan ${plan.id}`,
            detail: `${tasks.length} task(s) were generated from the planner output.`,
            metadata: {
              planId: plan.id,
              plannerTaskId: task.id,
              taskIds: tasks.map((plannedTask) => plannedTask.id)
            }
          });
          await recordEvent(this.paths, this.session.id, "plan.materialized", {
            planId: plan.id,
            plannerTaskId: task.id,
            taskIds: tasks.map((plannedTask) => plannedTask.id),
            count: tasks.length
          });
        }

        addMissionCheckpoint(this.session, task.missionId, {
          kind: "task_completed",
          title: `Task completed: ${task.title}`,
          detail: task.summary ?? envelope.summary,
          taskId: task.id
        });

        const autoResolvedNotes = autoResolveReviewNotesForCompletedTask(this.session, task.id);
        for (const note of autoResolvedNotes) {
          addDecisionRecord(this.session, {
            kind: "review",
            agent: note.agent,
            taskId: note.taskId,
            summary: `Auto-resolved review note ${note.id}`,
            detail: `Closed because linked follow-up task ${task.id} completed successfully.`,
            metadata: {
              reviewNoteId: note.id,
              filePath: note.filePath,
              followUpTaskId: task.id,
              reason: "follow-up-task-completed"
            }
          });
        }
        this.session.peerMessages.push(...peerMessages);
        const brainEntry = captureTaskBrainEntry(this.session, task);
        if (brainEntry) {
          const mission = this.session.missions.find((item) => item.id === task.missionId);
          if (mission && !mission.brainEntryIds.includes(brainEntry.id)) {
            mission.brainEntryIds.push(brainEntry.id);
          }
        }
        if (mission && task.status === "completed") {
          const worktreePath =
            this.session.worktrees.find((worktree) => worktree.agent === task.owner)?.path ??
            this.session.repoRoot;
          await synthesizeMissionAcceptanceChecks(worktreePath, this.session, mission);
        }
        this.syncSessionDerivedState();
        await saveSessionRecord(this.paths, this.session);

        const decisionReplay = buildDecisionReplay(
          this.session,
          task,
          task.owner === "claude" ? "claude" : "codex"
        );
        const existingArtifact = await loadTaskArtifact(this.paths, task.id);
        await saveTaskArtifact(this.paths, {
          taskId: task.id,
          sessionId: this.session.id,
          missionId: task.missionId,
          title: task.title,
          owner: task.owner,
          kind: task.kind,
          nodeKind: task.nodeKind,
          status: task.status,
          summary: task.summary,
          nextRecommendation: task.nextRecommendation,
          dependsOnTaskIds: task.dependsOnTaskIds,
          parentTaskId: task.parentTaskId,
          planId: task.planId,
          planNodeKey: task.planNodeKey,
          retryCount: task.retryCount,
          maxRetries: task.maxRetries,
          lastFailureSummary: task.lastFailureSummary,
          routeReason: task.routeReason,
          routeStrategy: task.routeStrategy,
          routeConfidence: task.routeConfidence,
          routeMetadata: task.routeMetadata,
          claimedPaths: task.claimedPaths,
          decisionReplay,
          rawOutput,
          error: null,
          envelope,
          reviewNotes: reviewNotesForTask(this.session, task.id),
          progress: existingArtifact?.progress ?? [],
          attempts: finalizeTaskAttempt(
            existingArtifact?.attempts ?? [],
            task.status === "completed" ? "completed" : "blocked",
            task.summary,
            task.updatedAt
          ),
          startedAt,
          finishedAt: task.updatedAt,
          nextRecommendation: task.nextRecommendation
        });
        await this.refreshReviewArtifactsForNotes(autoResolvedNotes);
        await recordEvent(this.paths, this.session.id, "task.completed", {
          taskId: task.id,
          owner: task.owner,
          kind: task.kind,
          status: task.status,
          peerMessages: peerMessages.length,
          materializedPlanCount
        });
        for (const note of autoResolvedNotes) {
          await recordEvent(this.paths, this.session.id, "review.note_auto_resolved", {
            reviewNoteId: note.id,
            taskId: note.taskId,
            followUpTaskId: task.id,
            agent: note.agent,
            filePath: note.filePath
          });
        }
        if (task.status === "completed") {
          const mission = this.session.missions.find((item) => item.id === task.missionId) ?? null;
          if (
            mission?.autopilotEnabled === true &&
            mission.policy?.autoVerify === true
          ) {
            autoAdvanceMissionId = mission.id;
          }
        }
        await this.publishSnapshot(publishReason);
      });

      if (autoAdvanceMissionId) {
        await this.maybeAdvanceMission(autoAdvanceMissionId, "task.completed");
      }
    } catch (error) {
      await flushRuntimeActivity(true);
      await this.runMutation(async () => {
        this.session = await loadSessionRecord(this.paths);
        const task = this.session.tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
          return;
        }

        const failureMessage = error instanceof Error ? error.message : String(error);
        const providerIssue =
          task.owner === "claude" || task.owner === "codex"
            ? detectProviderAuthIssue(task.owner, failureMessage)
            : null;
        if (providerIssue && (task.owner === "claude" || task.owner === "codex")) {
          markProviderCapabilityDegraded(this.session, task.owner, providerIssue);
        }
        const mission = this.session.missions.find((item) => item.id === task.missionId) ?? null;
        const shouldRetry = canAutoRetryTask(mission, task, failureMessage, providerIssue);
        const existingArtifact = await loadTaskArtifact(this.paths, task.id);

        if (shouldRetry) {
          markTaskForRetry(task, failureMessage, nowIso());
          this.session.agentStatus[task.owner as AgentName] = {
            ...this.session.agentStatus[task.owner as AgentName],
            lastRunAt: task.updatedAt,
            lastExitCode: 75,
            sessionId:
              task.owner === "claude"
                ? `${this.session.id}-claude`
                : this.session.agentStatus[task.owner as AgentName].sessionId,
            summary: task.summary
          };
          addDecisionRecord(this.session, {
            kind: "task",
            agent: task.owner === "router" ? "router" : task.owner,
            taskId: task.id,
            summary: `${task.owner} task scheduled retry`,
            detail: task.summary ?? failureMessage,
            metadata: {
              title: task.title,
              kind: task.kind,
              nodeKind: task.nodeKind,
              retryCount: task.retryCount,
              maxRetries: task.maxRetries,
              failure: failureMessage
            }
          });
          addMissionCheckpoint(this.session, task.missionId, {
            kind: "task_retried",
            title: `Task retry queued: ${task.title}`,
            detail: `Retry ${task.retryCount}/${task.maxRetries} queued after transient failure.`,
            taskId: task.id
          });
          this.syncSessionDerivedState();
          await saveSessionRecord(this.paths, this.session);
          await saveTaskArtifact(this.paths, {
            taskId: task.id,
            sessionId: this.session.id,
            missionId: task.missionId,
            title: task.title,
            owner: task.owner,
            kind: task.kind,
            nodeKind: task.nodeKind,
            status: task.status,
            summary: task.summary,
            nextRecommendation: task.nextRecommendation,
            dependsOnTaskIds: task.dependsOnTaskIds,
            parentTaskId: task.parentTaskId,
            planId: task.planId,
            planNodeKey: task.planNodeKey,
            retryCount: task.retryCount,
            maxRetries: task.maxRetries,
            lastFailureSummary: task.lastFailureSummary,
            routeReason: task.routeReason,
            routeStrategy: task.routeStrategy,
            routeConfidence: task.routeConfidence,
            routeMetadata: task.routeMetadata,
            claimedPaths: task.claimedPaths,
            decisionReplay: buildDecisionReplay(
              this.session,
              task,
              task.owner === "claude" ? "claude" : "codex"
            ),
            rawOutput: null,
            error: failureMessage,
            envelope: null,
            reviewNotes: reviewNotesForTask(this.session, task.id),
            progress: existingArtifact?.progress ?? [],
            attempts: finalizeTaskAttempt(
              existingArtifact?.attempts ?? [],
              "retrying",
              failureMessage,
              task.updatedAt
            ),
            startedAt,
            finishedAt: task.updatedAt,
            nextRecommendation: task.nextRecommendation
          });
          await recordEvent(this.paths, this.session.id, "task.retried", {
            taskId: task.id,
            owner: task.owner,
            kind: task.kind,
            retryCount: task.retryCount,
            maxRetries: task.maxRetries,
            error: failureMessage
          });
          await this.publishSnapshot("task.retried");
          return;
        }

        task.status = "failed";
        task.summary = providerIssue ?? failureMessage;
        task.nextRecommendation = null;
        task.lastFailureSummary = task.summary;
        releaseTaskLease(task);
        task.updatedAt = nowIso();
        this.session.agentStatus[task.owner as AgentName] = {
          ...this.session.agentStatus[task.owner as AgentName],
          lastRunAt: task.updatedAt,
          lastExitCode: 1,
          sessionId: task.owner === "claude" ? `${this.session.id}-claude` : this.session.agentStatus[task.owner as AgentName].sessionId,
          summary: task.summary
        };
        if (task.owner === "codex" || task.owner === "claude") {
          await this.refreshTaskClaims(task);
        }
        addDecisionRecord(this.session, {
          kind: "task",
          agent: task.owner === "router" ? "router" : task.owner,
          taskId: task.id,
          summary: `${task.owner} task failed`,
          detail: task.summary,
          metadata: {
            title: task.title,
            kind: task.kind,
            status: task.status,
            claimedPaths: task.claimedPaths
          }
        });
        addMissionCheckpoint(this.session, task.missionId, {
          kind: "task_failed",
          title: `Task failed: ${task.title}`,
          detail: task.summary,
          taskId: task.id
        });
        const brainEntry = captureTaskBrainEntry(this.session, task);
        if (brainEntry) {
          const mission = this.session.missions.find((item) => item.id === task.missionId);
          if (mission && !mission.brainEntryIds.includes(brainEntry.id)) {
            mission.brainEntryIds.push(brainEntry.id);
          }
        }
        const failedMission = this.session.missions.find((item) => item.id === task.missionId) ?? null;
        if (
          failedMission &&
          task.nodeKind === "repair" &&
          failedMission.policy?.pauseOnRepairFailure === true
        ) {
          failedMission.autopilotEnabled = false;
          addMissionCheckpoint(this.session, failedMission.id, {
            kind: "task_failed",
            title: `Repair loop paused: ${task.title}`,
            detail: "Kavi paused mission autopilot because a repair task failed and the mission policy requires operator review.",
            taskId: task.id
          });
          addDecisionRecord(this.session, {
            kind: "plan",
            agent: task.owner,
            taskId: task.id,
            summary: "Mission autopilot paused after repair failure",
            detail: `Repair task ${task.id} failed, so Kavi paused autonomous follow-up for mission ${failedMission.id}.`,
            metadata: {
              missionId: failedMission.id,
              reason: "pauseOnRepairFailure"
            }
          });
        }
        this.syncSessionDerivedState();
        await saveSessionRecord(this.paths, this.session);
        const decisionReplay = buildDecisionReplay(
          this.session,
          task,
          task.owner === "claude" ? "claude" : "codex"
        );
        await saveTaskArtifact(this.paths, {
          taskId: task.id,
          sessionId: this.session.id,
          missionId: task.missionId,
          title: task.title,
          owner: task.owner,
          kind: task.kind,
          nodeKind: task.nodeKind,
          status: task.status,
          summary: task.summary,
          nextRecommendation: task.nextRecommendation,
          dependsOnTaskIds: task.dependsOnTaskIds,
          parentTaskId: task.parentTaskId,
          planId: task.planId,
          planNodeKey: task.planNodeKey,
          retryCount: task.retryCount,
          maxRetries: task.maxRetries,
          lastFailureSummary: task.lastFailureSummary,
          routeReason: task.routeReason,
          routeStrategy: task.routeStrategy,
          routeConfidence: task.routeConfidence,
          routeMetadata: task.routeMetadata,
          claimedPaths: task.claimedPaths,
          decisionReplay,
          rawOutput: null,
          error: task.summary,
          envelope: null,
          reviewNotes: reviewNotesForTask(this.session, task.id),
          progress: existingArtifact?.progress ?? [],
          attempts: finalizeTaskAttempt(
            existingArtifact?.attempts ?? [],
            "failed",
            task.summary,
            task.updatedAt
          ),
          startedAt,
          finishedAt: task.updatedAt,
          nextRecommendation: task.nextRecommendation
        });
        await recordEvent(this.paths, this.session.id, "task.failed", {
          taskId: task.id,
          owner: task.owner,
          kind: task.kind,
          error: task.summary,
          providerIssue
        });
        await this.publishSnapshot("task.failed");
      });
    } finally {
      clearInterval(inactivityInterval);
      stopProgressMonitor();
      stopClaudeTranscriptMonitor();
    }
  }

  private async refreshTaskClaims(task: TaskSpec): Promise<void> {
    if (task.owner !== "codex" && task.owner !== "claude") {
      return;
    }

    const worktree = this.session.worktrees.find((item) => item.agent === task.owner);
    if (!worktree) {
      return;
    }

    const changedPaths = await listWorktreeChangedPaths(worktree.path, this.session.baseCommit);
    const previousClaimedPaths = [...task.claimedPaths];
    const hadClaimedSurface =
      previousClaimedPaths.length > 0 ||
      this.session.pathClaims.some((claim) => claim.taskId === task.id && claim.status === "active");
    task.claimedPaths = changedPaths;

    const claim = upsertPathClaim(this.session, {
      taskId: task.id,
      agent: task.owner,
      source: "diff",
      paths: changedPaths,
      note: task.summary
    });

    if (claim && changedPaths.length > 0) {
      const releasedClaims = releaseSupersededClaims(this.session, {
        agent: task.owner,
        taskId: task.id,
        paths: changedPaths,
        note: `Superseded by newer ${task.owner} diff claim from task ${task.id}.`
      });
      for (const releasedClaim of releasedClaims) {
        addDecisionRecord(this.session, {
          kind: "route",
          agent: task.owner,
          taskId: releasedClaim.taskId,
          summary: `Released superseded claim ${releasedClaim.id}`,
          detail: releasedClaim.paths.join(", ") || "No claimed paths.",
          metadata: {
            claimId: releasedClaim.id,
            supersededByTaskId: task.id,
            supersededByPaths: changedPaths
          }
        });
        await recordEvent(this.paths, this.session.id, "claim.superseded", {
          claimId: releasedClaim.id,
          taskId: releasedClaim.taskId,
          agent: releasedClaim.agent,
          paths: releasedClaim.paths,
          supersededByTaskId: task.id,
          supersededByPaths: changedPaths
        });
      }
      return;
    }

    if (changedPaths.length === 0 && hadClaimedSurface) {
      addDecisionRecord(this.session, {
        kind: "route",
        agent: task.owner,
        taskId: task.id,
        summary: `Released empty claim surface for ${task.id}`,
        detail: "Task finished without a remaining worktree diff for its claimed paths.",
        metadata: {
          releaseReason: "empty-diff-claim"
        }
      });
      await recordEvent(this.paths, this.session.id, "claim.released", {
        taskId: task.id,
        agent: task.owner,
        paths: previousClaimedPaths,
        reason: "empty-diff-claim"
      });
    }
  }
}
