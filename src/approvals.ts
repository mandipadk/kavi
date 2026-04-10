import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, readJson, writeJson } from "./fs.ts";
import { nowIso } from "./paths.ts";
import type {
  AgentName,
  ApprovalRequest,
  ApprovalRule,
  ApprovalRuleDecision,
  AppPaths
} from "./types.ts";

interface ToolUseDescriptor {
  toolName: string;
  summary: string;
  matchKey: string;
}

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function readObject(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function describeToolUse(payload: Record<string, unknown>): ToolUseDescriptor {
  const toolName = readString(payload, "tool_name") ?? "UnknownTool";
  const toolInput = readObject(payload, "tool_input");

  let detail = "";
  switch (toolName) {
    case "Bash":
      detail = normalizeWhitespace(readString(toolInput, "command") ?? safeJson(toolInput));
      break;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "Read":
      detail = readString(toolInput, "file_path") ?? safeJson(toolInput);
      break;
    case "Glob":
    case "Grep":
      detail = readString(toolInput, "pattern") ?? safeJson(toolInput);
      break;
    case "WebFetch":
      detail = readString(toolInput, "url") ?? safeJson(toolInput);
      break;
    default:
      detail = safeJson(toolInput);
      break;
  }

  const normalized = normalizeWhitespace(detail);
  return {
    toolName,
    summary: `${toolName}: ${truncate(normalized || "(no details)", 140)}`,
    matchKey: `${toolName}:${normalized.toLowerCase()}`
  };
}

export function describeCodexApprovalRequest(
  method: string,
  params: Record<string, unknown>
): ToolUseDescriptor {
  const reason = readString(params, "reason") ?? "";

  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = normalizeWhitespace(readString(params, "command") ?? "");
      const detail = command || normalizeWhitespace(reason) || safeJson(params);
      return {
        toolName: "CommandExecution",
        summary: `CommandExecution: ${truncate(detail || "(no details)", 140)}`,
        matchKey: `CommandExecution:${detail.toLowerCase()}`
      };
    }
    case "item/fileChange/requestApproval": {
      const grantRoot = normalizeWhitespace(readString(params, "grantRoot") ?? "");
      const detail = grantRoot || normalizeWhitespace(reason) || safeJson(params);
      return {
        toolName: "FileChange",
        summary: `FileChange: ${truncate(detail || "(no details)", 140)}`,
        matchKey: `FileChange:${detail.toLowerCase()}`
      };
    }
    case "item/permissions/requestApproval": {
      const permissions = readObject(params, "permissions");
      const detail = normalizeWhitespace(
        [reason, safeJson(permissions)].filter(Boolean).join(" ")
      );
      return {
        toolName: "Permissions",
        summary: `Permissions: ${truncate(detail || "(no details)", 140)}`,
        matchKey: `Permissions:${detail.toLowerCase()}`
      };
    }
    case "execCommandApproval": {
      const command = Array.isArray(params.command)
        ? normalizeWhitespace(params.command.map((part) => String(part)).join(" "))
        : normalizeWhitespace(readString(params, "command") ?? "");
      const detail = command || normalizeWhitespace(reason) || safeJson(params);
      return {
        toolName: "ExecCommand",
        summary: `ExecCommand: ${truncate(detail || "(no details)", 140)}`,
        matchKey: `ExecCommand:${detail.toLowerCase()}`
      };
    }
    case "applyPatchApproval": {
      const grantRoot = normalizeWhitespace(readString(params, "grantRoot") ?? "");
      const detail = grantRoot || normalizeWhitespace(reason) || safeJson(params);
      return {
        toolName: "ApplyPatch",
        summary: `ApplyPatch: ${truncate(detail || "(no details)", 140)}`,
        matchKey: `ApplyPatch:${detail.toLowerCase()}`
      };
    }
    default: {
      const detail = normalizeWhitespace(reason) || safeJson(params);
      return {
        toolName: method,
        summary: `${method}: ${truncate(detail || "(no details)", 140)}`,
        matchKey: `${method}:${detail.toLowerCase()}`
      };
    }
  }
}

async function loadRequests(paths: AppPaths): Promise<ApprovalRequest[]> {
  if (!(await fileExists(paths.approvalsFile))) {
    return [];
  }

  return readJson<ApprovalRequest[]>(paths.approvalsFile);
}

async function saveRequests(paths: AppPaths, requests: ApprovalRequest[]): Promise<void> {
  await writeJson(paths.approvalsFile, requests);
}

export async function listApprovalRequests(
  paths: AppPaths,
  options: { includeResolved?: boolean } = {}
): Promise<ApprovalRequest[]> {
  const requests = await loadRequests(paths);
  const filtered = options.includeResolved
    ? requests
    : requests.filter((request) => request.status === "pending");

  return filtered.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function createApprovalRequest(
  paths: AppPaths,
  input: {
    sessionId: string;
    repoRoot: string;
    agent: AgentName;
    hookEvent: string;
    payload: Record<string, unknown>;
    toolName?: string;
    summary?: string;
    matchKey?: string;
  }
): Promise<ApprovalRequest> {
  const descriptor =
    input.toolName && input.summary && input.matchKey
      ? {
          toolName: input.toolName,
          summary: input.summary,
          matchKey: input.matchKey
        }
      : describeToolUse(input.payload);
  const timestamp = nowIso();
  const request: ApprovalRequest = {
    id: randomUUID(),
    sessionId: input.sessionId,
    repoRoot: input.repoRoot,
    agent: input.agent,
    hookEvent: input.hookEvent,
    toolName: descriptor.toolName,
    summary: descriptor.summary,
    matchKey: descriptor.matchKey,
    payload: input.payload,
    status: "pending",
    decision: null,
    remember: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null
  };

  const requests = await loadRequests(paths);
  requests.push(request);
  await saveRequests(paths, requests);
  return request;
}

export async function loadApprovalRequest(
  paths: AppPaths,
  requestId: string
): Promise<ApprovalRequest | null> {
  const requests = await loadRequests(paths);
  return requests.find((request) => request.id === requestId) ?? null;
}

export async function resolveApprovalRequest(
  paths: AppPaths,
  requestId: string,
  decision: ApprovalRuleDecision,
  remember: boolean
): Promise<ApprovalRequest> {
  const requests = await loadRequests(paths);
  const request = requests.find((item) => item.id === requestId);
  if (!request) {
    throw new Error(`Approval request ${requestId} not found.`);
  }

  request.status = decision === "allow" ? "approved" : "denied";
  request.decision = decision;
  request.remember = remember;
  request.updatedAt = nowIso();
  request.resolvedAt = request.updatedAt;
  await saveRequests(paths, requests);

  if (remember) {
    await upsertApprovalRule(paths, request, decision);
  }

  return request;
}

export async function expireApprovalRequest(
  paths: AppPaths,
  requestId: string
): Promise<void> {
  const requests = await loadRequests(paths);
  const request = requests.find((item) => item.id === requestId);
  if (!request || request.status !== "pending") {
    return;
  }

  request.status = "expired";
  request.updatedAt = nowIso();
  request.resolvedAt = request.updatedAt;
  await saveRequests(paths, requests);
}

export async function waitForApprovalDecision(
  paths: AppPaths,
  requestId: string,
  timeoutMs = 300_000
): Promise<ApprovalRequest | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const request = await loadApprovalRequest(paths, requestId);
    if (request && request.status !== "pending") {
      return request;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await expireApprovalRequest(paths, requestId);
  return loadApprovalRequest(paths, requestId);
}

async function loadRules(paths: AppPaths): Promise<ApprovalRule[]> {
  if (!(await fileExists(paths.homeApprovalRulesFile))) {
    return [];
  }

  return readJson<ApprovalRule[]>(paths.homeApprovalRulesFile);
}

async function saveRules(paths: AppPaths, rules: ApprovalRule[]): Promise<void> {
  await ensureDir(path.dirname(paths.homeApprovalRulesFile));
  await writeJson(paths.homeApprovalRulesFile, rules);
}

export async function findApprovalRule(
  paths: AppPaths,
  input: {
    repoRoot: string;
    agent: AgentName;
    toolName: string;
    matchKey: string;
  }
): Promise<ApprovalRule | null> {
  const rules = await loadRules(paths);
  return (
    rules.find(
      (rule) =>
        rule.repoRoot === input.repoRoot &&
        rule.agent === input.agent &&
        rule.toolName === input.toolName &&
        rule.matchKey === input.matchKey
    ) ?? null
  );
}

async function upsertApprovalRule(
  paths: AppPaths,
  request: ApprovalRequest,
  decision: ApprovalRuleDecision
): Promise<void> {
  const rules = await loadRules(paths);
  const existing = rules.find(
    (rule) =>
      rule.repoRoot === request.repoRoot &&
      rule.agent === request.agent &&
      rule.toolName === request.toolName &&
      rule.matchKey === request.matchKey
  );

  if (existing) {
    existing.decision = decision;
    existing.summary = request.summary;
    existing.updatedAt = nowIso();
    await saveRules(paths, rules);
    return;
  }

  const timestamp = nowIso();
  rules.push({
    id: randomUUID(),
    repoRoot: request.repoRoot,
    agent: request.agent,
    toolName: request.toolName,
    matchKey: request.matchKey,
    summary: request.summary,
    decision,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await saveRules(paths, rules);
}
