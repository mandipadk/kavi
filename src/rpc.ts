import net from "node:net";
import type { ExecuteLandResult } from "./landing.ts";
import { normalizeTaskSpecs } from "./normalize.ts";
import type {
  AppPaths,
  ApprovalRuleDecision,
  ComposerPlanningMode,
  EventRecord,
  KaviSnapshot,
  MissionAutonomyLevel,
  RecommendationKind,
  ReviewAssignee,
  ReviewDisposition,
  SnapshotSubscriptionEvent,
  TaskArtifact,
  WorktreeDiffReview
} from "./types.ts";

const RPC_TIMEOUT_MS = 4_000;

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

export interface SnapshotRpcSubscription {
  close: () => void;
  connected: Promise<void>;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeSnapshot(snapshot: KaviSnapshot): KaviSnapshot {
  const record = asObject(snapshot);
  const session = asObject(record.session);

  return {
    ...snapshot,
    session: {
      ...(snapshot.session ?? {}),
      ...session,
      daemonVersion:
        typeof session.daemonVersion === "string" && session.daemonVersion.trim()
          ? session.daemonVersion
          : null,
      protocolVersion:
        typeof session.protocolVersion === "number" && Number.isFinite(session.protocolVersion)
          ? session.protocolVersion
          : null,
      tasks: normalizeTaskSpecs(session.tasks)
    }
  } as KaviSnapshot;
}

export async function sendRpcRequest<T>(
  paths: AppPaths,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    timeoutMs?: number;
  } = {}
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath);
    const requestId = randomId();
    let buffer = "";
    let settled = false;
    const timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : RPC_TIMEOUT_MS;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.setTimeout(0);
      socket.end();
      callback();
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      finish(() => reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms.`)));
    });
    socket.on("connect", () => {
      const payload: RpcRequest = {
        id: requestId,
        method,
        params
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });
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

        let response: RpcResponse;
        try {
          response = JSON.parse(line) as RpcResponse;
        } catch (error) {
          if (error instanceof Error && /Unexpected end of JSON input/i.test(error.message)) {
            buffer = `${line}\n${buffer}`;
            return;
          }
          finish(() => {
            reject(
              new Error(
                error instanceof Error
                  ? error.message
                  : `Unable to parse RPC response for ${method}.`
              )
            );
          });
          return;
        }
        if (response.id !== requestId) {
          continue;
        }

        if (response.error) {
          finish(() => reject(new Error(response.error?.message ?? `${method} failed.`)));
          return;
        }

        finish(() => resolve(response.result as T));
        return;
      }
    });
    socket.on("error", (error) => {
      finish(() => reject(error));
    });
    socket.on("end", () => {
      if (!settled) {
        finish(() => reject(new Error(`Socket closed before completing ${method}.`)));
      }
    });
  });
}

export async function pingRpc(paths: AppPaths): Promise<boolean> {
  try {
    await sendRpcRequest(paths, "ping");
    return true;
  } catch {
    return false;
  }
}

export async function readSnapshot(paths: AppPaths): Promise<KaviSnapshot> {
  return normalizeSnapshot(await sendRpcRequest<KaviSnapshot>(paths, "snapshot"));
}

export async function rpcKickoff(paths: AppPaths, prompt: string): Promise<void> {
  await sendRpcRequest(paths, "kickoff", {
    prompt
  });
}

export async function rpcEnqueueTask(
  paths: AppPaths,
  params: {
    owner: string;
    title?: string;
    prompt: string;
    missionPrompt?: string;
    planningMode?: ComposerPlanningMode;
    missionMode?: "guided_autopilot" | "inspect" | "manual";
    missionAutonomyLevel?: MissionAutonomyLevel;
    autoVerify?: boolean;
    autoLand?: boolean;
    shadowOfMissionId?: string;
    routeReason: string | null;
    routeMetadata: Record<string, unknown>;
    claimedPaths: string[];
    routeStrategy: string;
    routeConfidence: number;
    recommendationId?: string;
    recommendationKind?: RecommendationKind;
  }
): Promise<void> {
  await sendRpcRequest(paths, "enqueueTask", {
    owner: params.owner,
    ...(typeof params.title === "string" && params.title.trim()
      ? { title: params.title.trim() }
      : {}),
    prompt: params.prompt,
    ...(typeof params.missionPrompt === "string" && params.missionPrompt.trim()
      ? { missionPrompt: params.missionPrompt.trim() }
      : {}),
    ...(params.planningMode ? { planningMode: params.planningMode } : {}),
    ...(params.missionMode ? { missionMode: params.missionMode } : {}),
    ...(params.missionAutonomyLevel ? { missionAutonomyLevel: params.missionAutonomyLevel } : {}),
    ...(typeof params.autoVerify === "boolean" ? { autoVerify: params.autoVerify } : {}),
    ...(typeof params.autoLand === "boolean" ? { autoLand: params.autoLand } : {}),
    ...(params.shadowOfMissionId ? { shadowOfMissionId: params.shadowOfMissionId } : {}),
    routeReason: params.routeReason,
    routeMetadata: params.routeMetadata,
    claimedPaths: params.claimedPaths,
    routeStrategy: params.routeStrategy,
    routeConfidence: params.routeConfidence,
    ...(params.recommendationId ? { recommendationId: params.recommendationId } : {}),
    ...(params.recommendationKind ? { recommendationKind: params.recommendationKind } : {})
  });
}

export async function rpcRetryTask(paths: AppPaths, taskId: string): Promise<void> {
  await sendRpcRequest(paths, "retryTask", {
    taskId
  });
}

export async function rpcDismissRecommendation(
  paths: AppPaths,
  params: {
    recommendationId: string;
    reason?: string | null;
  }
): Promise<void> {
  await sendRpcRequest(paths, "dismissRecommendation", {
    recommendationId: params.recommendationId,
    ...(params.reason ? { reason: params.reason } : {})
  });
}

export async function rpcRestoreRecommendation(
  paths: AppPaths,
  params: {
    recommendationId: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "restoreRecommendation", {
    recommendationId: params.recommendationId
  });
}

export async function rpcSelectMission(
  paths: AppPaths,
  params: {
    missionId: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "selectMission", {
    missionId: params.missionId
  });
}

export async function rpcUpdateMissionPolicy(
  paths: AppPaths,
  params: {
    missionId: string;
    autonomyLevel?: MissionAutonomyLevel;
    autoVerify?: boolean;
    autoLand?: boolean;
    pauseOnRepairFailure?: boolean;
    retryBudget?: number;
    autopilotEnabled?: boolean;
  }
): Promise<void> {
  await sendRpcRequest(paths, "updateMissionPolicy", {
    missionId: params.missionId,
    ...(params.autonomyLevel ? { autonomyLevel: params.autonomyLevel } : {}),
    ...(typeof params.autoVerify === "boolean" ? { autoVerify: params.autoVerify } : {}),
    ...(typeof params.autoLand === "boolean" ? { autoLand: params.autoLand } : {}),
    ...(typeof params.pauseOnRepairFailure === "boolean"
      ? { pauseOnRepairFailure: params.pauseOnRepairFailure }
      : {}),
    ...(typeof params.retryBudget === "number" ? { retryBudget: params.retryBudget } : {}),
    ...(typeof params.autopilotEnabled === "boolean" ? { autopilotEnabled: params.autopilotEnabled } : {})
  });
}

export async function rpcApplyMissionBlueprint(
  paths: AppPaths,
  params: {
    missionId: string;
    prompt: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "applyMissionBlueprint", {
    missionId: params.missionId,
    prompt: params.prompt
  });
}

export async function rpcSetAgentContractStatus(
  paths: AppPaths,
  params: {
    contractId: string;
    status: "open" | "resolved" | "dismissed";
    resolvedByTaskId?: string | null;
  }
): Promise<void> {
  await sendRpcRequest(paths, "setAgentContractStatus", {
    contractId: params.contractId,
    status: params.status,
    ...(typeof params.resolvedByTaskId === "string" ? { resolvedByTaskId: params.resolvedByTaskId } : {})
  });
}

export async function rpcResolveApproval(
  paths: AppPaths,
  params: {
    requestId: string;
    decision: ApprovalRuleDecision;
    remember: boolean;
  }
): Promise<void> {
  await sendRpcRequest(paths, "resolveApproval", params as unknown as Record<string, unknown>);
}

export async function rpcSetFullAccessMode(
  paths: AppPaths,
  params: {
    enabled: boolean;
  }
): Promise<void> {
  await sendRpcRequest(paths, "setFullAccessMode", {
    enabled: params.enabled === true
  });
}

export async function rpcLand(
  paths: AppPaths
): Promise<ExecuteLandResult> {
  return await sendRpcRequest<ExecuteLandResult>(
    paths,
    "land",
    {},
    {
      timeoutMs: 10 * 60 * 1000
    }
  );
}

export async function rpcShutdown(paths: AppPaths): Promise<void> {
  await sendRpcRequest(paths, "shutdown");
}

export async function rpcNotifyExternalUpdate(paths: AppPaths, reason: string): Promise<void> {
  await sendRpcRequest(paths, "notifyExternalUpdate", {
    reason
  });
}

export async function rpcTaskArtifact(
  paths: AppPaths,
  taskId: string
): Promise<TaskArtifact | null> {
  return await sendRpcRequest<TaskArtifact | null>(paths, "taskArtifact", {
    taskId
  });
}

export async function rpcRecentEvents(
  paths: AppPaths,
  limit: number
): Promise<EventRecord[]> {
  return await sendRpcRequest<EventRecord[]>(paths, "events", {
    limit
  });
}

export async function rpcAddReviewNote(
  paths: AppPaths,
  params: {
    agent: "codex" | "claude";
    taskId: string | null;
    filePath: string;
    hunkIndex: number | null;
    hunkHeader: string | null;
    disposition: ReviewDisposition;
    assignee?: ReviewAssignee | null;
    body: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "addReviewNote", {
    agent: params.agent,
    taskId: params.taskId,
    filePath: params.filePath,
    hunkIndex: params.hunkIndex,
    hunkHeader: params.hunkHeader,
    disposition: params.disposition,
    assignee: params.assignee ?? null,
    body: params.body
  });
}

export async function rpcUpdateReviewNote(
  paths: AppPaths,
  params: {
    noteId: string;
    body?: string;
    disposition?: ReviewDisposition;
    assignee?: ReviewAssignee | null;
  }
): Promise<void> {
  await sendRpcRequest(paths, "updateReviewNote", {
    noteId: params.noteId,
    ...(typeof params.body === "string" ? { body: params.body } : {}),
    ...(params.disposition ? { disposition: params.disposition } : {}),
    ...(params.assignee === undefined ? {} : { assignee: params.assignee })
  });
}

export async function rpcAddReviewReply(
  paths: AppPaths,
  params: {
    noteId: string;
    body: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "addReviewReply", {
    noteId: params.noteId,
    body: params.body
  });
}

export async function rpcSetReviewNoteStatus(
  paths: AppPaths,
  params: {
    noteId: string;
    status: "open" | "resolved";
  }
): Promise<void> {
  await sendRpcRequest(paths, "setReviewNoteStatus", {
    noteId: params.noteId,
    status: params.status
  });
}

export async function rpcEnqueueReviewFollowUp(
  paths: AppPaths,
  params: {
    noteId: string;
    owner: "codex" | "claude";
    mode: "fix" | "handoff";
  }
): Promise<void> {
  await sendRpcRequest(paths, "enqueueReviewFollowUp", {
    noteId: params.noteId,
    owner: params.owner,
    mode: params.mode
  });
}

export async function rpcWorktreeDiff(
  paths: AppPaths,
  agent: "codex" | "claude",
  filePath: string | null
): Promise<WorktreeDiffReview> {
  return await sendRpcRequest<WorktreeDiffReview>(paths, "worktreeDiff", {
    agent,
    filePath
  });
}

export async function rpcSetBrainEntryPinned(
  paths: AppPaths,
  params: {
    entryId: string;
    pinned: boolean;
  }
): Promise<void> {
  await sendRpcRequest(paths, "setBrainEntryPinned", {
    entryId: params.entryId,
    pinned: params.pinned === true
  });
}

export async function rpcRetireBrainEntry(
  paths: AppPaths,
  params: {
    entryId: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "retireBrainEntry", {
    entryId: params.entryId
  });
}

export async function rpcMergeBrainEntries(
  paths: AppPaths,
  params: {
    targetEntryId: string;
    sourceEntryId: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "mergeBrainEntries", {
    targetEntryId: params.targetEntryId,
    sourceEntryId: params.sourceEntryId
  });
}

export async function rpcAppendHookProgress(
  paths: AppPaths,
  params: {
    taskId: string;
    entries: Array<{
      summary: string;
      paths: string[];
      provider: "codex" | "claude" | "node";
      eventName: string | null;
      source: "notification" | "stderr" | "stdout" | "delta" | "worktree" | "hook" | "transcript" | null;
    }>;
    transcriptPath?: string;
  }
): Promise<void> {
  await sendRpcRequest(paths, "appendHookProgress", {
    taskId: params.taskId,
    entries: params.entries,
    ...(typeof params.transcriptPath === "string" && params.transcriptPath.trim()
      ? { transcriptPath: params.transcriptPath.trim() }
      : {})
  });
}

export function subscribeSnapshotRpc(
  paths: AppPaths,
  handlers: {
    onSnapshot: (event: SnapshotSubscriptionEvent) => void;
    onDisconnect?: () => void;
    onError?: (error: Error) => void;
  }
): SnapshotRpcSubscription {
  const socket = net.createConnection(paths.socketPath);
  const requestId = randomId();
  let buffer = "";
  let closed = false;
  let connectedResolver: (() => void) | null = null;
  let connectedRejecter: ((error: Error) => void) | null = null;
  const connected = new Promise<void>((resolve, reject) => {
    connectedResolver = resolve;
    connectedRejecter = reject;
  });

  const finishWithError = (error: Error) => {
    handlers.onError?.(error);
    if (connectedRejecter) {
      connectedRejecter(error);
      connectedRejecter = null;
      connectedResolver = null;
    }
  };

  socket.setEncoding("utf8");
  socket.setTimeout(RPC_TIMEOUT_MS, () => {
    finishWithError(new Error(`Subscription timed out after ${RPC_TIMEOUT_MS}ms.`));
    socket.end();
  });
  socket.on("connect", () => {
    const payload: RpcRequest = {
      id: requestId,
      method: "subscribe"
    };
    socket.write(`${JSON.stringify(payload)}\n`);
  });
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

      let message: RpcResponse | RpcNotification;
      try {
        message = JSON.parse(line) as RpcResponse | RpcNotification;
      } catch (error) {
        finishWithError(
          new Error(
            error instanceof Error
              ? error.message
              : "Unable to parse snapshot subscription payload."
          )
        );
        socket.end();
        return;
      }

      if ("id" in message && message.id === requestId) {
        if (message.error) {
          finishWithError(new Error(message.error.message));
          socket.end();
          return;
        }

        socket.setTimeout(0);
        connectedResolver?.();
        connectedResolver = null;
        connectedRejecter = null;
        handlers.onSnapshot({
          reason: "subscribe",
          snapshot: normalizeSnapshot(message.result as KaviSnapshot)
        });
        continue;
      }

      if ("method" in message && message.method === "snapshot.updated") {
        const event = message.params as SnapshotSubscriptionEvent;
        handlers.onSnapshot({
          ...event,
          snapshot: normalizeSnapshot(event.snapshot)
        });
      }
    }
  });
  socket.on("error", (error) => {
    if (!closed) {
      finishWithError(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("close", () => {
    if (!closed) {
      handlers.onDisconnect?.();
    }
  });

  return {
    connected,
    close: () => {
      closed = true;
      socket.end();
    }
  };
}

export function parseRpcParams<T extends Record<string, unknown>>(value: unknown): T {
  return asObject(value) as T;
}
