import fs from "node:fs/promises";
import {
  buildAgentInstructions,
  buildPeerMessages,
  buildTaskPrompt,
  buildUnstructuredEnvelope,
  extractJsonObject
} from "./shared.ts";
import { runCommand } from "../process.ts";
import { loadAgentPrompt } from "../prompts.ts";
import { buildKaviShellCommand } from "../runtime.ts";
import type { AgentTurnEnvelope, AppPaths, SessionRecord, TaskSpec, WorktreeInfo } from "../types.ts";

const CLAUDE_ENVELOPE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["summary", "status", "blockers", "nextRecommendation", "peerMessages"],
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
});

function findWorktree(session: SessionRecord, agent: "claude"): WorktreeInfo {
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

function collectTextFragments(value: unknown, fragments: string[]): void {
  if (typeof value === "string") {
    fragments.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, fragments);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const payload = value as Record<string, unknown>;
  const directText = [
    payload.text,
    payload.content,
    payload.result,
    payload.message,
    payload.output_text,
    payload.outputText,
    payload.body
  ];
  for (const item of directText) {
    collectTextFragments(item, fragments);
  }
}

function parseLooseJson(rawOutput: string): unknown {
  try {
    return JSON.parse(rawOutput);
  } catch {
    const lines = rawOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!candidate) {
        continue;
      }

      try {
        return JSON.parse(candidate);
      } catch {
        // keep trying
      }
    }
  }

  return rawOutput;
}

function normalizeEnvelope(value: unknown): AgentTurnEnvelope {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parsed = value as Record<string, unknown>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      status:
        parsed.status === "blocked" || parsed.status === "needs_review"
          ? parsed.status
          : "completed",
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map((item) => String(item)) : [],
      nextRecommendation:
        parsed.nextRecommendation === null || typeof parsed.nextRecommendation === "string"
          ? parsed.nextRecommendation
          : null,
      plan: null,
      peerMessages: Array.isArray(parsed.peerMessages)
        ? parsed.peerMessages.map((message) => {
            const payload = asObject(message);
            return {
              to: payload.to === "codex" ? "codex" : "claude",
              intent:
                payload.intent === "handoff" ||
                payload.intent === "review_request" ||
                payload.intent === "blocked" ||
                payload.intent === "context_share"
                  ? payload.intent
                  : "question",
              subject: String(payload.subject ?? ""),
              body: String(payload.body ?? "")
            };
          })
      : []
    };
  }

  const fragments: string[] = [];
  collectTextFragments(value, fragments);
  if (fragments.length > 0) {
    return extractJsonObject(fragments.join("\n\n"));
  }

  return extractJsonObject(String(value ?? ""));
}

export function parseClaudeStructuredOutput(
  rawOutput: string,
  fallbackSessionId: string
): { envelope: AgentTurnEnvelope; sessionId: string; raw: string } {
  const parsed = parseLooseJson(rawOutput);
  const wrapper = Array.isArray(parsed)
    ? asObject(parsed[parsed.length - 1])
    : asObject(parsed);

  const sessionId =
    asString(wrapper.session_id) ??
    asString(wrapper.sessionId) ??
    fallbackSessionId;
  const structuredOutput =
    "structured_output" in wrapper
      ? wrapper.structured_output
      : "structuredOutput" in wrapper
        ? wrapper.structuredOutput
        : null;
  const resultPayload =
    structuredOutput ??
    ("result" in wrapper
      ? (wrapper.result as unknown)
      : "content" in wrapper
        ? wrapper.content
        : parsed);

  if ((wrapper.is_error as boolean | undefined) === true) {
    throw new Error(asString(wrapper.result) ?? "Claude returned an error response.");
  }

  return {
    envelope: normalizeEnvelope(resultPayload),
    sessionId,
    raw: rawOutput
  };
}

export async function writeClaudeSettings(paths: AppPaths, session: SessionRecord): Promise<void> {
  const buildHookCommand = (event: string) =>
    buildKaviShellCommand(session.runtime, [
      "__hook",
      "--repo-root",
      paths.repoRoot,
      "--agent",
      "claude",
      "--event",
      event
    ]);
  const toolHooks = session.fullAccessMode
    ? {}
    : {
        PreToolUse: [
          {
            matcher: "Bash|Edit|Write|MultiEdit",
            hooks: [
              {
                type: "command",
                command: buildHookCommand("PreToolUse")
              }
            ]
          }
        ],
        PostToolUse: [
          {
            matcher: "Bash|Edit|Write|MultiEdit",
            hooks: [
              {
                type: "command",
                command: buildHookCommand("PostToolUse")
              }
            ]
          }
        ]
      };

  const settings = {
    permissions: {
      defaultMode: session.fullAccessMode ? "bypassPermissions" : "plan"
    },
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|compact",
          hooks: [
            {
              type: "command",
              command: buildHookCommand("SessionStart")
            }
          ]
        }
      ],
      ...toolHooks,
      Notification: [
        {
          matcher: "permission_prompt|idle_prompt|auth_success",
          hooks: [
            {
              type: "command",
              command: buildHookCommand("Notification")
            }
          ]
        }
      ],
      Stop: [
        {
          matcher: "stop",
          hooks: [
            {
              type: "command",
              command: buildHookCommand("Stop")
            }
          ]
        }
      ]
    },
    env: {
      KAVI_SESSION_ID: session.id
    }
  };

  await fs.writeFile(paths.claudeSettingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function resolveClaudeSessionId(session: SessionRecord): string {
  return session.agentStatus.claude.sessionId ?? session.id;
}

export function buildClaudeCommandArgs(
  session: SessionRecord,
  claudeSessionId: string,
  prompt: string,
  settingsPath: string
): string[] {
  const sessionArgs = session.agentStatus.claude.sessionId
    ? ["--resume", claudeSessionId]
    : ["--session-id", claudeSessionId];

  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    CLAUDE_ENVELOPE_SCHEMA,
    "--settings",
    settingsPath,
    ...(session.fullAccessMode
      ? [
          "--permission-mode",
          "bypassPermissions",
          "--dangerously-skip-permissions"
        ]
      : [
          "--permission-mode",
          "plan"
        ]),
    ...sessionArgs,
    prompt
  ];
}

export async function runClaudeTask(
  session: SessionRecord,
  task: TaskSpec,
  paths: AppPaths,
  options: {
    onRuntimeText?: (chunk: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<{ envelope: AgentTurnEnvelope; raw: string; sessionId: string }> {
  const worktree = findWorktree(session, "claude");
  const claudeSessionId = resolveClaudeSessionId(session);
  await writeClaudeSettings(paths, session);
  const repoPrompt = await loadAgentPrompt(paths, "claude");

  const prompt = [
    buildAgentInstructions("claude", worktree.path, repoPrompt),
    "",
    buildTaskPrompt(session, task, "claude")
  ].join("\n");

  const result = await runCommand(
    session.runtime.claudeExecutable,
    buildClaudeCommandArgs(session, claudeSessionId, prompt, paths.claudeSettingsFile),
    {
      cwd: worktree.path,
      signal: options.signal,
      onStderrChunk: options.onRuntimeText
    }
  );

  const rawOutput = result.code === 0 ? result.stdout : `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error(String(options.signal.reason ?? "Claude task aborted."));
    }
    throw new Error(rawOutput.trim() || "Claude task failed.");
  }

  try {
    return parseClaudeStructuredOutput(rawOutput, claudeSessionId);
  } catch {
    return {
      envelope: buildUnstructuredEnvelope(rawOutput),
      raw: rawOutput,
      sessionId: claudeSessionId
    };
  }
}

export { buildPeerMessages };
