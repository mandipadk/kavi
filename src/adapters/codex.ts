import {
  createApprovalRequest,
  describeCodexApprovalRequest,
  findApprovalRule,
  waitForApprovalDecision
} from "../approvals.ts";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { loadAgentPrompt } from "../prompts.ts";
import { recordEvent } from "../session.ts";
import {
  buildAgentInstructions,
  buildPeerMessages,
  buildPlannerInstruction,
  buildTaskPrompt,
  extractJsonObject
} from "./shared.ts";
import { parseCodexNotificationEvent, type ProviderRuntimeEvent } from "../provider-runtime.ts";
import type { AgentTurnEnvelope, AppPaths, SessionRecord, TaskSpec, WorktreeInfo } from "../types.ts";

const ENVELOPE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "status", "blockers", "nextRecommendation", "plan", "peerMessages"],
  properties: {
    summary: {
      type: "string"
    },
    status: {
      type: "string",
      enum: ["completed", "blocked", "needs_review"]
    },
    blockers: {
      type: "array",
      items: {
        type: "string"
      }
    },
    nextRecommendation: {
      type: ["string", "null"]
    },
    plan: {
      type: "null"
    },
    peerMessages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["to", "intent", "subject", "body"],
        properties: {
          to: {
            type: "string",
            enum: ["codex", "claude"]
          },
          intent: {
            type: "string",
            enum: ["question", "handoff", "review_request", "blocked", "context_share"]
          },
          subject: {
            type: "string"
          },
          body: {
            type: "string"
          }
        }
      }
    }
  }
};

export const PLANNER_OUTPUT_SCHEMA = {
  ...ENVELOPE_OUTPUT_SCHEMA,
  required: ["summary", "status", "blockers", "nextRecommendation", "plan", "peerMessages"],
  properties: {
    ...ENVELOPE_OUTPUT_SCHEMA.properties,
    plan: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["summary", "tasks"],
      properties: {
        summary: {
          type: "string"
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "title", "owner", "prompt", "nodeKind", "dependsOn", "claimedPaths", "reason", "executionMode"],
            properties: {
              key: {
                type: "string"
              },
              title: {
                type: "string"
              },
              owner: {
                type: "string",
                enum: ["codex", "claude"]
              },
              prompt: {
                type: "string"
              },
              nodeKind: {
                type: ["string", "null"],
                enum: [
                  "research",
                  "scaffold",
                  "backend",
                  "frontend",
                  "shared_contract",
                  "infra",
                  "tests",
                  "docs",
                  "review",
                  "repair",
                  "integration",
                  null
                ]
              },
              dependsOn: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              claimedPaths: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              reason: {
                type: "string"
              },
              executionMode: {
                type: "string",
                enum: ["blocking", "parallel", "follow_up"]
              }
            }
          }
        }
      }
    }
  }
};

function findWorktree(session: SessionRecord, agent: "codex"): WorktreeInfo {
  const worktree = session.worktrees.find((item) => item.agent === agent);
  if (!worktree) {
    throw new Error(`Missing worktree for ${agent}.`);
  }

  return worktree;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function supportsSessionApproval(params: Record<string, unknown>): boolean {
  return Array.isArray(params.availableDecisions)
    ? params.availableDecisions.some((value) => value === "acceptForSession")
    : false;
}

function buildPermissionsGrant(params: Record<string, unknown>): Record<string, unknown> {
  const requested = asObject(params.permissions);
  const granted: Record<string, unknown> = {};

  if (requested.network !== null && requested.network !== undefined) {
    granted.network = requested.network;
  }

  if (requested.fileSystem !== null && requested.fileSystem !== undefined) {
    granted.fileSystem = requested.fileSystem;
  }

  return granted;
}

function buildApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  approved: boolean,
  remember: boolean
): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return {
        decision: approved
          ? remember && supportsSessionApproval(params)
            ? "acceptForSession"
            : "accept"
          : "decline"
      };
    case "item/fileChange/requestApproval":
      return {
        decision: approved ? (remember ? "acceptForSession" : "accept") : "decline"
      };
    case "item/permissions/requestApproval":
      return {
        permissions: approved ? buildPermissionsGrant(params) : {},
        scope: remember ? "session" : "turn"
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: approved
          ? remember
            ? "approved_for_session"
            : "approved"
          : "denied"
      };
    default:
      throw new Error(`Unsupported Codex approval request: ${method}`);
  }
}

export function buildThreadParams(
  session: SessionRecord,
  worktree: WorktreeInfo,
  developerInstructions: string
): Record<string, unknown> {
  const configuredModel = session.config.agents.codex.model.trim();
  return {
    cwd: worktree.path,
    approvalPolicy: session.fullAccessMode ? "never" : "on-request",
    sandbox: session.fullAccessMode ? "danger-full-access" : "workspace-write",
    baseInstructions: "You are Codex inside Kavi. Operate inside the assigned worktree and keep work task-scoped.",
    developerInstructions,
    model: configuredModel || null,
    ephemeral: false,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    ...(session.fullAccessMode ? {} : { approvalsReviewer: "user" })
  };
}

export function buildCodexTurnParams(
  session: SessionRecord,
  worktree: WorktreeInfo,
  threadId: string,
  inputText: string,
  outputSchema: Record<string, unknown> = ENVELOPE_OUTPUT_SCHEMA
): Record<string, unknown> {
  return {
    threadId,
    cwd: worktree.path,
    approvalPolicy: session.fullAccessMode ? "never" : "on-request",
    sandbox: session.fullAccessMode ? "danger-full-access" : "workspace-write",
    model: session.config.agents.codex.model.trim() || null,
    outputSchema,
    input: [
      {
        type: "text",
        text: inputText,
        text_elements: []
      }
    ],
    ...(session.fullAccessMode ? {} : { approvalsReviewer: "user" })
  };
}

async function ensureThread(
  client: CodexAppServerClient,
  session: SessionRecord,
  paths: AppPaths,
  worktree: WorktreeInfo,
  developerInstructions: string
): Promise<string> {
  const threadParams = buildThreadParams(session, worktree, developerInstructions);
  const existingThreadId = session.agentStatus.codex.sessionId;

  if (existingThreadId) {
    try {
      return await client.resumeThread({
        threadId: existingThreadId,
        ...threadParams
      });
    } catch (error) {
      await recordEvent(paths, session.id, "codex.thread_resume_failed", {
        threadId: existingThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return await client.startThread(threadParams);
}

async function handleCodexApproval(
  session: SessionRecord,
  paths: AppPaths,
  request: {
    id: number;
    method: string;
    params: Record<string, unknown>;
  }
): Promise<unknown> {
  const descriptor = describeCodexApprovalRequest(request.method, request.params);
  if (session.fullAccessMode) {
    await recordEvent(paths, session.id, "approval.full_access_bypassed", {
      agent: "codex",
      requestId: request.id,
      method: request.method,
      toolName: descriptor.toolName,
      summary: descriptor.summary
    });
    return buildApprovalResponse(request.method, request.params, true, true);
  }

  const rule = await findApprovalRule(paths, {
    repoRoot: session.repoRoot,
    agent: "codex",
    toolName: descriptor.toolName,
    matchKey: descriptor.matchKey
  });

  if (rule) {
    await recordEvent(paths, session.id, "approval.auto_decided", {
      agent: "codex",
      requestId: request.id,
      method: request.method,
      toolName: descriptor.toolName,
      summary: descriptor.summary,
      decision: rule.decision
    });
    return buildApprovalResponse(request.method, request.params, rule.decision === "allow", true);
  }

  const approval = await createApprovalRequest(paths, {
    sessionId: session.id,
    repoRoot: session.repoRoot,
    agent: "codex",
    hookEvent: request.method,
    payload: request.params,
    toolName: descriptor.toolName,
    summary: descriptor.summary,
    matchKey: descriptor.matchKey
  });
  await recordEvent(paths, session.id, "approval.requested", {
    requestId: approval.id,
    agent: "codex",
    method: request.method,
    toolName: approval.toolName,
    summary: approval.summary
  });

  const resolved = await waitForApprovalDecision(paths, approval.id);
  const approved = resolved?.status === "approved";
  const remember = resolved?.remember ?? false;
  await recordEvent(paths, session.id, "approval.completed", {
    requestId: approval.id,
    agent: "codex",
    method: request.method,
    outcome: approved ? "approved" : resolved?.status === "denied" ? "denied" : "expired"
  });

  return buildApprovalResponse(request.method, request.params, approved, remember);
}

export async function runCodexTask(
  session: SessionRecord,
  task: TaskSpec,
  paths: AppPaths,
  options: {
    onRuntimeText?: (chunk: string) => void;
    onAssistantDelta?: (chunk: string) => void;
    onProviderEvent?: (event: ProviderRuntimeEvent) => void;
    signal?: AbortSignal;
  } = {}
): Promise<{ envelope: AgentTurnEnvelope; raw: string; threadId: string }> {
  const worktree = findWorktree(session, "codex");
  const repoPrompt = await loadAgentPrompt(paths, "codex");
  const developerInstructions =
    task.kind === "planner"
      ? [repoPrompt.trim(), buildPlannerInstruction(worktree.path)].filter(Boolean).join("\n\n")
      : buildAgentInstructions("codex", worktree.path, repoPrompt);
  const client = new CodexAppServerClient(
    session.runtime,
    session.repoRoot,
    async (request) => {
      return await handleCodexApproval(session, paths, request);
    },
    {
      onAssistantDelta: options.onAssistantDelta,
      onStderrChunk: options.onRuntimeText,
      onNotification: (method, params) => {
        const event = parseCodexNotificationEvent(method, params);
        if (event) {
          options.onProviderEvent?.(event);
        }
      }
    }
  );
  const abortHandler = () => {
    const reason = options.signal?.reason;
    client.abort(reason instanceof Error ? reason : new Error(String(reason ?? "Codex task aborted.")));
  };

  try {
    if (options.signal?.aborted) {
      abortHandler();
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error(String(options.signal.reason ?? "Codex task aborted."));
    }
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    await client.initialize();
    const threadId = await ensureThread(client, session, paths, worktree, developerInstructions);
    const result = await client.runTurn(
      buildCodexTurnParams(
        session,
        worktree,
        threadId,
        buildTaskPrompt(session, task, "codex"),
        task.kind === "planner" ? PLANNER_OUTPUT_SCHEMA : ENVELOPE_OUTPUT_SCHEMA
      )
    );

    const rawOutput = `${result.assistantMessage}${result.stderr ? `\n\n[stderr]\n${result.stderr}` : ""}`;
    const envelope = extractJsonObject(result.assistantMessage);
    return {
      envelope,
      raw: rawOutput,
      threadId
    };
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    await client.close();
  }
}

export { buildPeerMessages };
