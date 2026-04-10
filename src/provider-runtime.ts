import type { AgentName } from "./types.ts";

export interface ProviderRuntimeEvent {
  provider: AgentName;
  summary: string;
  paths: string[];
  eventName: string | null;
  source: "notification" | "stderr" | "stdout" | "delta" | "hook" | "transcript";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function normalizeLine(value: string): string {
  return stripAnsi(value).replaceAll("\r", " ").replaceAll(/\s+/g, " ").trim();
}

function truncate(value: string, max = 240): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function summarizeShellCommand(command: string, max = 96): string {
  const normalized = stripTrailingPunctuation(normalizeLine(command));
  if (!normalized) {
    return "command";
  }
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isAbsoluteLikePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeExtractedPath(value: string): string {
  return value.replace(/^\.\/+/, "").trim();
}

function extractPaths(value: string): string[] {
  const matches =
    value.match(
      /[A-Za-z0-9_.\-\/]+\.(tsx|jsx|scss|json|toml|yaml|yml|html|sql|css|ts|js|go|py|rs|md)\b/g
    ) ?? [];
  return unique(
    matches
      .map((match) => normalizeExtractedPath(match))
      .filter((match) => match && !isAbsoluteLikePath(match))
  ).slice(0, 8);
}

function extractPathsFromParams(params: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const payload = value as Record<string, unknown>;
    for (const key of ["path", "file", "filePath", "file_path", "files", "changedFiles", "target", "paths"]) {
      if (key in payload) {
        visit(payload[key]);
      }
    }
  };
  visit(params);
  return unique(candidates.flatMap((item) => extractPaths(item))).slice(0, 8);
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.:\s]+$/g, "").trim();
}

function sentenceCase(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeMethodSegment(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
}

function methodTail(method: string): string {
  const parts = method.split("/").filter(Boolean);
  return normalizeMethodSegment(parts.at(-1) ?? method);
}

function methodFamily(method: string): string {
  const parts = method.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return normalizeMethodSegment(parts[0] ?? method);
  }
  return normalizeMethodSegment(parts.slice(0, -1).join(" "));
}

function firstNonEmptyString(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function summarizeToolInputPath(params: Record<string, unknown>): string[] {
  return extractPathsFromParams(params);
}

function summarizeClaudeToolUse(
  toolName: string,
  input: Record<string, unknown>
): { eventName: string; summary: string; paths: string[] } {
  const lower = toolName.trim().toLowerCase();
  const paths = summarizeToolInputPath(input);
  const command =
    asString(input.command) ??
    asString(input.cmd) ??
    asString(asObject(input.input).command) ??
    null;
  const query =
    asString(input.pattern) ??
    asString(input.query) ??
    asString(input.description) ??
    null;
  const route =
    asString(input.target) ??
    asString(input.url) ??
    asString(input.path) ??
    null;

  if (lower === "bash") {
    return {
      eventName: "command-running",
      summary: `Claude started \`${summarizeShellCommand(command ?? "command")}\`.`,
      paths
    };
  }
  if (lower === "write" || lower === "edit" || lower === "multiedit") {
    const label =
      paths[0] ??
      asString(input.file_path) ??
      asString(input.path) ??
      "a file";
    return {
      eventName: "file-change",
      summary: `Claude prepared ${lower === "write" ? "writes" : "edits"} for ${label}.`,
      paths
    };
  }
  if (lower === "read" || lower === "glob" || lower === "grep") {
    const target = paths[0] ?? query ?? route ?? "the repo";
    return {
      eventName: "inspection",
      summary: `Claude inspected ${target}.`,
      paths
    };
  }
  return {
    eventName: "tool-use",
    summary: `Claude prepared ${toolName}${command ? ` | ${summarizeShellCommand(command)}` : ""}.`,
    paths
  };
}

function summarizeClaudeToolResult(
  payload: Record<string, unknown>,
  rawOutput: string
): { eventName: string | null; summary: string | null; paths: string[] } {
  const filePath =
    asString(payload.filePath) ??
    asString(payload.file_path) ??
    asString(payload.path) ??
    null;
  const kind = asString(payload.type)?.toLowerCase() ?? null;
  const toolName = asString(payload.toolName)?.toLowerCase() ?? null;
  const exitCode =
    typeof payload.exitCode === "number"
      ? payload.exitCode
      : typeof payload.exit_code === "number"
        ? payload.exit_code
        : null;
  const success =
    typeof payload.success === "boolean"
      ? payload.success
      : typeof exitCode === "number"
        ? exitCode === 0
        : null;
  const paths = unique([...(filePath ? [filePath] : []), ...extractPaths(rawOutput)]).slice(0, 8);

  if (kind && ["create", "update", "edit"].includes(kind) && filePath) {
    return {
      eventName: "file-change",
      summary: `Claude ${kind}d ${filePath}.`,
      paths
    };
  }
  if ((toolName === "bash" || kind === "bash" || exitCode !== null) && rawOutput) {
    const command =
      asString(payload.command) ??
      asString(asObject(payload.input).command) ??
      null;
    const prefix =
      success === false ? "Claude command failed" : success === true ? "Claude completed" : "Claude command update";
    return {
      eventName: success === false ? "command-failed" : "command-complete",
      summary: `${prefix}: \`${summarizeShellCommand(command ?? rawOutput)}\`${success === false ? ` | exit ${exitCode}` : ""}.`,
      paths
    };
  }

  const normalized = normalizeLine(rawOutput);
  if (!normalized) {
    return { eventName: null, summary: null, paths };
  }
  const lower = normalized.toLowerCase();
  const eventName =
    /error|failed|traceback|exception/.test(lower)
      ? "tool-failed"
      : /verified|passed|ok|success/.test(lower)
        ? "verification"
        : "tool-result";
  const prefix =
    eventName === "verification"
      ? "Claude verification"
      : eventName === "tool-failed"
        ? "Claude tool failure"
        : "Claude tool result";
  return {
    eventName,
    summary: `${prefix}: ${truncate(normalized)}.`,
    paths
  };
}

function classifyClaudeAssistantText(text: string): string {
  const lower = text.toLowerCase();
  if (/blocked|cannot|can't|unable|waiting on|need\b|required|missing/.test(lower)) {
    return "blocker";
  }
  if (/verify|validated|tests?\b|lint|typecheck|smoke/.test(lower)) {
    return "verification";
  }
  if (/plan|milestone|graph|scaffold|next I'?ll|next,? i will|first I'?ll/.test(lower)) {
    return "planning";
  }
  if (/create|implement|build|update|edit|write|add|remove|refactor/.test(lower)) {
    return "edit";
  }
  return "assistant-text";
}

function summarizeClaudeHookEvent(
  eventName: string,
  payload: Record<string, unknown>
): { eventName: string | null; summary: string | null } {
  const toolName =
    asString(payload.tool_name) ??
    asString(payload.toolName) ??
    asString(payload.name) ??
    null;
  const detail = [
    asString(payload.message),
    asString(payload.detail),
    asString(payload.reason),
    asString(payload.notification),
    asString(payload.status)
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" | ");

  switch (eventName) {
    case "PreToolUse":
      return {
        eventName: "tool-request",
        summary: toolName
          ? `Claude requested ${toolName}${detail ? ` | ${detail}` : ""}.`
          : `Claude requested a tool${detail ? ` | ${detail}` : ""}.`
      };
    case "PostToolUse":
      return {
        eventName: "tool-complete",
        summary: toolName
          ? `Claude completed ${toolName}${detail ? ` | ${detail}` : ""}.`
          : `Claude completed a tool call${detail ? ` | ${detail}` : ""}.`
      };
    case "SessionStart": {
      const source =
        asString(payload.source) ??
        asString(payload.session_source) ??
        asString(payload.sessionSource) ??
        "session";
      return {
        eventName: "session",
        summary: `Claude session ${source} started.`
      };
    }
    case "Notification":
      return {
        eventName: "notification",
        summary: detail ? `Claude notification: ${detail}.` : "Claude emitted a notification."
      };
    case "Stop":
      return {
        eventName: "stop",
        summary: detail ? `Claude stopped: ${detail}.` : "Claude completed the active turn."
      };
    default:
      return {
        eventName: eventName ? eventName.toLowerCase() : null,
        summary: detail ? `Claude hook ${eventName}: ${detail}.` : null
      };
  }
}

export function parseClaudeHookEvent(
  eventName: string,
  payload: Record<string, unknown>
): ProviderRuntimeEvent[] {
  const summary = summarizeClaudeHookEvent(eventName, payload);
  if (!summary.summary) {
    return [];
  }

  return [
    {
      provider: "claude",
      summary: truncate(summary.summary),
      paths: extractPathsFromParams(payload),
      eventName: summary.eventName,
      source: "hook"
    }
  ];
}

export function parseClaudeTranscriptLine(
  line: string
): { id: string | null; events: ProviderRuntimeEvent[] } {
  const normalized = normalizeLine(line);
  if (!normalized) {
    return { id: null, events: [] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { id: null, events: [] };
  }

  const entryType = asString(parsed.type) ?? null;
  const uuid = asString(parsed.uuid) ?? null;

  if (entryType === "assistant") {
    const message = asObject(parsed.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const events: ProviderRuntimeEvent[] = [];
    for (const item of content) {
      const payload = asObject(item);
      const contentType = asString(payload.type) ?? null;
      if (contentType === "text") {
        const text = normalizeLine(asString(payload.text) ?? "");
        if (text) {
          const eventName = classifyClaudeAssistantText(text);
          const prefix =
            eventName === "planning"
              ? "Claude planning"
              : eventName === "verification"
                ? "Claude verification"
                : eventName === "blocker"
                  ? "Claude blocker"
                  : eventName === "edit"
                    ? "Claude progress"
                    : "Claude draft";
          events.push({
            provider: "claude",
            summary: truncate(`${prefix}: ${text}`),
            paths: extractPaths(text),
            eventName,
            source: "transcript"
          });
        }
        continue;
      }

      if (contentType === "tool_use") {
        const toolName = asString(payload.name) ?? "tool";
        const input = asObject(payload.input);
        const event = summarizeClaudeToolUse(toolName, input);
        events.push({
          provider: "claude",
          summary: truncate(event.summary),
          paths: event.paths,
          eventName: event.eventName,
          source: "transcript"
        });
      }
    }
    return { id: uuid, events };
  }

  if (entryType === "user" && parsed.toolUseResult) {
    const toolUse = asObject(parsed.toolUseResult);
    const filePath =
      asString(toolUse.filePath) ??
      asString(toolUse.file_path) ??
      null;
    const output = [
      asString(toolUse.stdout),
      asString(toolUse.stderr),
      asString(toolUse.content),
      asString(parsed.toolUseResult)
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" | ");
    const kind = asString(toolUse.type);
    const event = summarizeClaudeToolResult(toolUse, output);
    const summary = event.summary;
    if (!summary) {
      return { id: uuid, events: [] };
    }
    return {
      id: uuid,
      events: [
        {
          provider: "claude",
          summary: truncate(summary),
          paths: event.paths,
          eventName: event.eventName,
          source: "transcript"
        }
      ]
    };
  }

  if (entryType === "attachment") {
    const attachment = asObject(parsed.attachment);
    const attachmentType = asString(attachment.type) ?? null;
    if (attachmentType === "structured_output") {
      return {
        id: uuid,
        events: [
          {
            provider: "claude",
            summary: "Claude emitted structured output.",
            paths: [],
            eventName: "structured-output",
            source: "transcript"
          }
        ]
      };
    }
  }

  return { id: uuid, events: [] };
}

function summarizeCodexMethod(method: string, params: Record<string, unknown>): {
  eventName: string | null;
  summary: string | null;
} {
  const turn = asObject(params.turn);
  const permissions = asObject(params.permissions);
  const itemType = firstNonEmptyString(
    asString(params.type),
    asString(params.kind),
    asString(params.itemType),
    asString(params.item_type),
    asString(params.title),
    asString(params.name)
  );
  const filePath = firstNonEmptyString(
    asString(params.file),
    asString(params.path),
    asString(params.filePath),
    asString(params.file_path),
    extractPathsFromParams(params)[0] ?? null
  );
  const command = firstNonEmptyString(
    asString(params.command),
    asString(asObject(params.commandExecution).command),
    asString(asObject(params.input).command)
  );
  const detailLine = firstNonEmptyString(
    asString(params.message),
    asString(params.detail),
    asString(params.reason),
    asString(params.status),
    asString(turn.status),
    asString(params.name),
    asString(params.title)
  );
  const detail = [
    command,
    detailLine
  ].filter((value): value is string => Boolean(value?.trim())).join(" | ");

  if (method === "item/agentMessage/delta") {
    return { eventName: "assistant-delta", summary: null };
  }
  if (method === "turn/completed") {
    return {
      eventName: "turn-completed",
      summary: `Codex turn completed: ${asString(turn.status) ?? "unknown"}.`
    };
  }

  if (/commandExecution/i.test(method)) {
    const action = methodTail(method);
    if (action.includes("request approval")) {
      return {
        eventName: "command-approval",
        summary: command
          ? `Codex requested approval to run \`${stripTrailingPunctuation(command)}\`.`
          : `Codex requested command approval${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    if (action.includes("completed") || action.includes("finished")) {
      return {
        eventName: "command-complete",
        summary: command
          ? `Codex completed \`${stripTrailingPunctuation(command)}\`${detailLine && detailLine !== command ? ` | ${detailLine}` : ""}.`
          : `Codex completed a command${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    if (action.includes("failed") || action.includes("error")) {
      return {
        eventName: "command-failed",
        summary: command
          ? `Codex command failed: \`${stripTrailingPunctuation(command)}\`${detailLine && detailLine !== command ? ` | ${detailLine}` : ""}.`
          : `Codex command failed${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    if (action.includes("started") || action.includes("running") || action.includes("executing")) {
      return {
        eventName: "command-running",
        summary: command
          ? `Codex started \`${stripTrailingPunctuation(command)}\`.`
          : `Codex started a command${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    return {
      eventName: "command",
      summary: command
        ? `Codex command update: \`${stripTrailingPunctuation(command)}\`${detailLine && detailLine !== command ? ` | ${detailLine}` : ""}.`
        : `Codex command event: ${detail || method}.`
    };
  }
  if (/fileChange/i.test(method)) {
    const action = methodTail(method);
    if (action.includes("request approval")) {
      return {
        eventName: "file-approval",
        summary: filePath
          ? `Codex requested approval to edit ${filePath}.`
          : `Codex requested file-change approval${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    if (action.includes("applied") || action.includes("completed") || action.includes("updated")) {
      return {
        eventName: "file-change",
        summary: filePath
          ? `Codex updated ${filePath}${detailLine ? ` | ${detailLine}` : ""}.`
          : `Codex applied file changes${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    if (action.includes("planned") || action.includes("prepared")) {
      return {
        eventName: "file-plan",
        summary: filePath
          ? `Codex prepared changes for ${filePath}${detailLine ? ` | ${detailLine}` : ""}.`
          : `Codex prepared file changes${detailLine ? ` | ${detailLine}` : ""}.`
      };
    }
    return {
      eventName: "file-change",
      summary: filePath
        ? `Codex file change: ${filePath}${detailLine ? ` | ${detailLine}` : ""}.`
        : `Codex file change event: ${detail || method}.`
    };
  }
  if (/reason|plan|thinking/i.test(method)) {
    const action = firstNonEmptyString(
      detailLine,
      asString(params.delta),
      asString(params.text)
    );
    return {
      eventName: /plan/i.test(method) ? "planning" : "reasoning",
      summary: action
        ? `Codex ${/plan/i.test(method) ? "planning" : "reasoning"}: ${stripTrailingPunctuation(action)}.`
        : `Codex reasoning event: ${detail || method}.`
      };
  }
  if (/approval/i.test(method)) {
    const requestedPermission = firstNonEmptyString(
      asString(permissions.network),
      asString(permissions.fileSystem),
      detailLine
    );
    return {
      eventName: "approval",
      summary: requestedPermission
        ? `Codex approval update: ${requestedPermission}.`
        : `Codex approval event: ${detail || method}.`
    };
  }
  if (/thread|turn/i.test(method)) {
    const action = methodTail(method);
    return {
      eventName: "turn",
      summary: `Codex ${action || "turn"}${detailLine ? ` | ${detailLine}` : ""}.`
    };
  }
  if (method === "item/started" || method === "item/completed" || method === "item/failed") {
    const action = methodTail(method);
    const itemLabel = sentenceCase(itemType ?? "step");
    return {
      eventName:
        action.includes("started")
          ? "step-started"
          : action.includes("completed")
            ? "step-completed"
            : "step-failed",
      summary: `${itemLabel} ${action}${detailLine && detailLine !== itemType ? ` | ${detailLine}` : ""}.`
    };
  }
  if (/agentMessage|message/i.test(method)) {
    const content = firstNonEmptyString(asString(params.message), asString(params.delta), detailLine);
    return {
      eventName: "assistant-message",
      summary: content
        ? `Codex message: ${stripTrailingPunctuation(content)}.`
        : `Codex message event: ${methodFamily(method)}.`
    };
  }
  return {
    eventName: method.replaceAll("/", ":"),
    summary: detail
      ? `Codex ${methodFamily(method)}: ${detail}.`
      : `Codex runtime event: ${method}.`
  };
}

export function parseCodexNotificationEvent(
  method: string,
  params: Record<string, unknown>
): ProviderRuntimeEvent | null {
  const { eventName, summary } = summarizeCodexMethod(method, params);
  if (!summary) {
    return null;
  }
  return {
    provider: "codex",
    summary: truncate(summary),
    paths: extractPathsFromParams(params),
    eventName,
    source: "notification"
  };
}

function classifyClaudeLine(line: string): string | null {
  const lower = line.toLowerCase();
  if (!lower) {
    return null;
  }
  if (/^thinking\b|^plan\b|^reasoning\b/.test(lower)) {
    return "reasoning";
  }
  if (/^tool\b|^bash\b|^write\b|^edit\b|^read\b|^grep\b|^glob\b/.test(lower)) {
    return "tool";
  }
  if (/approval|permission/.test(lower)) {
    return "approval";
  }
  if (/running|executing|creating|editing|writing|updating|patching|searching|reading/.test(lower)) {
    return "activity";
  }
  if (/warning|error|failed|retry/.test(lower)) {
    return "warning";
  }
  return "activity";
}

export function parseClaudeRuntimeText(chunk: string): ProviderRuntimeEvent[] {
  const lines = stripAnsi(chunk)
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  return lines
    .map((line) => {
      const eventName = classifyClaudeLine(line);
      if (!eventName) {
        return null;
      }
      return {
        provider: "claude" as const,
        summary: `Claude runtime: ${truncate(line)}`,
        paths: extractPaths(line),
        eventName,
        source: "stderr" as const
      };
    })
    .filter((event): event is ProviderRuntimeEvent => event !== null);
}

function parseQuotedDeltaValues(chunk: string): string[] {
  const values = [...chunk.matchAll(/"([^"\n]{16,})"/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean)
    .filter((value) => !/^(summary|status|nextRecommendation|title|detail|body|subject)$/i.test(value));
  return unique(values);
}

function classifyCodexDelta(summary: string): string {
  const lower = summary.toLowerCase();
  if (/tool\b|apply_patch|bash|write_stdin|exec_command|read_mcp_resource/.test(lower)) {
    return "tool";
  }
  if (/blocked|cannot|can't|unable|stuck|missing|need\b|required|waiting on/.test(lower)) {
    return "blocker";
  }
  if (/verify|verified|test|lint|typecheck|validated|checks? passed|smoke/.test(lower)) {
    return "verification";
  }
  if (/create|created|update|updated|write|wrote|edit|edited|patch|patched|refactor|implemented|added|removed/.test(lower)) {
    return "edit";
  }
  if (/plan|planning|blueprint|graph|decompose|milestone|scaffold/.test(lower)) {
    return "planning";
  }
  if (/run|running|execute|executing|install|installed|build|built|compile|compiled/.test(lower)) {
    return "command";
  }
  return "assistant-delta";
}

export function parseCodexAssistantDeltaText(chunk: string): ProviderRuntimeEvent[] {
  const normalized = stripAnsi(chunk).replaceAll("\r", " ");
  if (!normalized.trim()) {
    return [];
  }

  const summaries = parseQuotedDeltaValues(normalized);
  if (summaries.length === 0) {
    const compact = normalizeLine(normalized.replaceAll(/[{}[\],]/g, " "));
    if (!compact || compact.length < 24 || /^[:"]+$/.test(compact)) {
      return [];
    }
    summaries.push(compact);
  }

  return summaries
    .slice(0, 2)
    .map((summary) => {
      const compact = stripTrailingPunctuation(normalizeLine(summary));
      const eventName = classifyCodexDelta(compact);
      const prefix =
        eventName === "planning"
          ? "Codex planning"
          : eventName === "edit"
            ? "Codex progress"
            : eventName === "verification"
              ? "Codex verification"
              : eventName === "command"
                ? "Codex runtime"
                : eventName === "tool"
                  ? "Codex tool"
                : eventName === "blocker"
                  ? "Codex blocker"
                  : "Codex draft";
      return {
        provider: "codex" as const,
        summary: `${prefix}: ${truncate(compact)}`,
        paths: extractPaths(compact),
        eventName,
        source: "delta" as const
      };
    });
}
