import { CodexAppServerClient } from "./codex-app-server.ts";
import { findClaimConflicts } from "./decision-ledger.ts";
import {
  analyzeOwnershipRules,
  buildOwnershipRouteDecision,
  ownershipMetadataFromAnalysis
} from "./ownership.ts";
import { nowIso } from "./paths.ts";
import type { AgentName, AppPaths, KaviConfig, RouteDecision, SessionRecord, TaskSpec } from "./types.ts";

export interface DecomposedPromptTask {
  title: string;
  prompt: string;
  source: "whole_prompt" | "checklist";
}

const ROUTER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "confidence", "reason", "claimedPaths"],
  properties: {
    owner: {
      type: "string",
      enum: ["codex", "claude"]
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    reason: {
      type: "string"
    },
    claimedPaths: {
      type: "array",
      items: {
        type: "string"
      }
    }
  }
};

function containsKeyword(prompt: string, keywords: string[]): boolean {
  const lower = prompt.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function normalizeClaimedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))].sort();
}

function summarizePromptTitle(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled operator task";
  }

  return compact.length <= 72 ? compact : `${compact.slice(0, 69)}...`;
}

function buildRouteMetadata(input: Record<string, unknown> = {}): Record<string, unknown> {
  return input;
}

function ownershipAnalysisMetadata(prompt: string, config: KaviConfig): Record<string, unknown> {
  const claimedPaths = extractPromptPathHints(prompt);
  if (claimedPaths.length === 0) {
    return {};
  }

  return ownershipMetadataFromAnalysis(analyzeOwnershipRules(claimedPaths, config));
}

function buildPathOwnershipDecision(prompt: string, config: KaviConfig): RouteDecision | null {
  const claimedPaths = extractPromptPathHints(prompt);
  if (claimedPaths.length === 0) {
    return null;
  }

  return buildOwnershipRouteDecision(claimedPaths, config);
}

export function extractPromptPathHints(prompt: string): string[] {
  const candidates: string[] = [];
  const quotedMatches = prompt.matchAll(/[`'"]([^`'"\n]+)[`'"]/g);
  for (const match of quotedMatches) {
    const candidate = match[1]?.trim() ?? "";
    if (candidate.includes("/") || candidate.includes(".")) {
      candidates.push(candidate);
    }
  }

  const pathMatches = prompt.matchAll(
    /(?:^|[\s(])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)(?=$|[\s),:])/g
  );
  for (const match of pathMatches) {
    candidates.push(match[1] ?? "");
  }

  return normalizeClaimedPaths(candidates);
}

export function decomposeOperatorPrompt(prompt: string): DecomposedPromptTask[] {
  const normalized = prompt.replaceAll("\r", "").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const bulletPattern = /^(?:[-*+]|(?:\d+[.)])|(?:\[[ xX]\]))\s+(.+)$/;
  const contextLines: string[] = [];
  const bulletItems: string[] = [];
  let currentBullet = "";
  let sawBullet = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(bulletPattern);
    if (bulletMatch?.[1]) {
      sawBullet = true;
      if (currentBullet.trim()) {
        bulletItems.push(currentBullet.trim());
      }
      currentBullet = bulletMatch[1].trim();
      continue;
    }

    if (!sawBullet) {
      contextLines.push(line);
      continue;
    }

    if (!trimmed) {
      if (currentBullet.trim()) {
        bulletItems.push(currentBullet.trim());
        currentBullet = "";
      }
      continue;
    }

    currentBullet = currentBullet
      ? `${currentBullet}\n${trimmed}`
      : trimmed;
  }

  if (currentBullet.trim()) {
    bulletItems.push(currentBullet.trim());
  }

  if (bulletItems.length < 2) {
    return [
      {
        title: summarizePromptTitle(normalized),
        prompt: normalized,
        source: "whole_prompt"
      }
    ];
  }

  const sharedContext = contextLines.join("\n").trim();
  return bulletItems.map((item) => ({
    title: summarizePromptTitle(item),
    prompt: sharedContext
      ? `${sharedContext}\n\nSubtask:\n${item}`
      : item,
    source: "checklist"
  }));
}

export function routePrompt(prompt: string, config: KaviConfig): AgentName {
  const pathDecision = buildPathOwnershipDecision(prompt, config);
  if (pathDecision) {
    return pathDecision.owner;
  }

  if (containsKeyword(prompt, config.routing.frontendKeywords)) {
    return "claude";
  }

  if (containsKeyword(prompt, config.routing.backendKeywords)) {
    return "codex";
  }

  return "codex";
}

export function previewRouteDecision(
  prompt: string,
  config: KaviConfig,
  session: SessionRecord | null = null
): RouteDecision {
  const pathDecision = buildPathOwnershipDecision(prompt, config);
  if (pathDecision) {
    return session ? applyClaimRouting(session, pathDecision) : pathDecision;
  }

  const heuristic = buildKeywordDecision(prompt, config);
  if (heuristic) {
    return session ? applyClaimRouting(session, heuristic) : heuristic;
  }

  const claimedPaths = extractPromptPathHints(prompt);
  const previewDecision: RouteDecision = {
    owner: "codex",
    strategy: "fallback",
    confidence: 0.35,
    reason: "No deterministic ownership or keyword route matched yet. The AI router would decide on submit.",
    claimedPaths,
    metadata: buildRouteMetadata({
      router: "preview",
      promptHints: claimedPaths,
      aiPending: true,
      ...ownershipAnalysisMetadata(prompt, config)
    })
  };

  return session ? applyClaimRouting(session, previewDecision) : previewDecision;
}

function buildKeywordDecision(prompt: string, config: KaviConfig): RouteDecision | null {
  const frontend = containsKeyword(prompt, config.routing.frontendKeywords);
  const backend = containsKeyword(prompt, config.routing.backendKeywords);
  const claimedPaths = extractPromptPathHints(prompt);
  const ownershipMetadata = ownershipAnalysisMetadata(prompt, config);

  if (frontend && !backend) {
    return {
      owner: "claude",
      strategy: "keyword",
      confidence: 0.92,
      reason: "Matched frontend and UX routing keywords.",
      claimedPaths,
      metadata: buildRouteMetadata({
        matchedKeywordSet: "frontend",
        promptHints: claimedPaths,
        ...ownershipMetadata
      })
    };
  }

  if (backend && !frontend) {
    return {
      owner: "codex",
      strategy: "keyword",
      confidence: 0.92,
      reason: "Matched backend and architecture routing keywords.",
      claimedPaths,
      metadata: buildRouteMetadata({
        matchedKeywordSet: "backend",
        promptHints: claimedPaths,
        ...ownershipMetadata
      })
    };
  }

  return null;
}

function buildRouterPrompt(prompt: string, session: SessionRecord): string {
  const ownershipRules = [
    ...session.config.routing.codexPaths.map((pattern) => `- codex: ${pattern}`),
    ...session.config.routing.claudePaths.map((pattern) => `- claude: ${pattern}`)
  ].join("\n");
  const promptHints = extractPromptPathHints(prompt);
  const activeClaims = session.pathClaims
    .filter((claim) => claim.status === "active")
    .map((claim) => `- ${claim.agent}: ${claim.paths.join(", ")}`)
    .join("\n");

  return [
    "Route this task between Codex and Claude.",
    "Codex owns planning, architecture, backend work, debugging, and integration-heavy changes.",
    "Claude owns frontend work, UX, intent-shaping, copy, and interaction quality.",
    "Prefer Codex for ambiguous infrastructure-heavy requests and Claude for ambiguous UX-heavy requests.",
    "Return only JSON matching the provided schema.",
    "",
    "Task prompt:",
    prompt,
    "",
    "Explicit path ownership rules:",
    ownershipRules || "- none",
    "",
    "Path hints extracted from the prompt:",
    promptHints.length > 0 ? promptHints.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "Active path claims:",
    activeClaims || "- none"
  ].join("\n");
}

async function routeWithCodexAi(
  prompt: string,
  session: SessionRecord
): Promise<RouteDecision> {
  const worktreePath =
    session.worktrees.find((worktree) => worktree.agent === "codex")?.path ?? session.repoRoot;
  const client = new CodexAppServerClient(session.runtime, session.repoRoot, async (request) => {
    throw new Error(`Router turn requested unexpected server interaction: ${request.method}`);
  });

  try {
    await client.initialize();
    const threadId = await client.startThread({
      cwd: worktreePath,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      baseInstructions: "You are Kavi's route classifier. Never use tools.",
      developerInstructions:
        "Choose either codex or claude. Keep reasons short and return only JSON.",
      model: session.config.agents.codex.model.trim() || null,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
    const result = await client.runTurn({
      threadId,
      cwd: worktreePath,
      approvalPolicy: "never",
      outputSchema: ROUTER_OUTPUT_SCHEMA,
      input: [
        {
          type: "text",
          text: buildRouterPrompt(prompt, session),
          text_elements: []
        }
      ]
    });
    const parsed = JSON.parse(result.assistantMessage) as Record<string, unknown>;
    const owner = parsed.owner === "claude" ? "claude" : "codex";
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "AI router produced a fallback decision.";
    const claimedPaths = Array.isArray(parsed.claimedPaths)
      ? normalizeClaimedPaths(parsed.claimedPaths.map((item) => String(item)))
      : extractPromptPathHints(prompt);

    return {
      owner,
      strategy: "ai",
      confidence,
      reason,
      claimedPaths,
      metadata: buildRouteMetadata({
        router: "codex-ai",
        promptHints: extractPromptPathHints(prompt),
        ...ownershipAnalysisMetadata(prompt, session.config)
      })
    };
  } finally {
    await client.close();
  }
}

function applyClaimRouting(session: SessionRecord, decision: RouteDecision): RouteDecision {
  const conflicts = findClaimConflicts(session, decision.owner, decision.claimedPaths);
  if (conflicts.length === 0) {
    return decision;
  }

  const conflictingAgents = [...new Set(conflicts.map((claim) => claim.agent))];
  const owner = conflictingAgents[0] ?? decision.owner;
  const overlappingPaths = normalizeClaimedPaths(conflicts.flatMap((claim) => claim.paths));
  return {
    owner,
    strategy: "path-claim",
    confidence: 1,
    reason: `Re-routed to ${owner} because active path claims overlap: ${overlappingPaths.join(", ")}`,
    claimedPaths:
      decision.claimedPaths.length > 0 ? decision.claimedPaths : overlappingPaths,
    metadata: buildRouteMetadata({
      ...decision.metadata,
      reroutedFrom: decision.owner,
      conflictingClaims: conflicts.map((claim) => ({
        taskId: claim.taskId,
        agent: claim.agent,
        source: claim.source,
        paths: claim.paths
      })),
      overlappingPaths
    })
  };
}

export async function routeTask(
  prompt: string,
  session: SessionRecord,
  _paths: AppPaths
): Promise<RouteDecision> {
  const pathDecision = buildPathOwnershipDecision(prompt, session.config);
  if (pathDecision) {
    return applyClaimRouting(session, pathDecision);
  }

  const heuristic = buildKeywordDecision(prompt, session.config);
  if (heuristic) {
    return applyClaimRouting(session, heuristic);
  }

  try {
    const aiDecision = await routeWithCodexAi(prompt, session);
    return applyClaimRouting(session, aiDecision);
  } catch (error) {
    return applyClaimRouting(session, {
      owner: "codex",
      strategy: "fallback",
      confidence: 0.4,
      reason:
        error instanceof Error
          ? `AI routing failed, defaulted to Codex: ${error.message}`
          : "AI routing failed, defaulted to Codex.",
      claimedPaths: extractPromptPathHints(prompt),
      metadata: buildRouteMetadata({
        router: "fallback",
        error: error instanceof Error ? error.message : String(error),
        ...ownershipAnalysisMetadata(prompt, session.config)
      })
    });
  }
}

export function buildKickoffTasks(goal: string, missionId: string | null = null): TaskSpec[] {
  const timestamp = nowIso();
  return [
    {
      id: "kickoff-codex",
      missionId,
      title: "Codex kickoff plan",
      owner: "codex",
      kind: "planner",
      nodeKind: "research",
      status: "pending",
      prompt: goal,
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 1,
      lastFailureSummary: null,
      lease: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      summary: null,
      nextRecommendation: null,
      routeReason: "Kickoff task reserved for Codex planning.",
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: buildRouteMetadata({
        kickoff: true,
        reservedFor: "codex"
      }),
      claimedPaths: []
    },
    {
      id: "kickoff-claude",
      missionId,
      title: "Claude intent interpretation",
      owner: "claude",
      kind: "kickoff",
      nodeKind: "review",
      status: "pending",
      prompt: goal,
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 1,
      lastFailureSummary: null,
      lease: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      summary: null,
      nextRecommendation: null,
      routeReason: "Kickoff task reserved for Claude intent and UX interpretation.",
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: buildRouteMetadata({
        kickoff: true,
        reservedFor: "claude"
      }),
      claimedPaths: []
    }
  ];
}

export function buildAdHocTask(
  owner: AgentName,
  prompt: string,
  taskId: string,
  options: {
    missionId?: string | null;
    title?: string;
    kind?: TaskSpec["kind"];
    nodeKind?: TaskSpec["nodeKind"];
    dependsOnTaskIds?: string[];
    parentTaskId?: string | null;
    planId?: string | null;
    planNodeKey?: string | null;
    retryCount?: number;
    maxRetries?: number;
    lastFailureSummary?: string | null;
    routeReason?: string | null;
    routeStrategy?: RouteDecision["strategy"] | null;
    routeConfidence?: number | null;
    routeMetadata?: Record<string, unknown>;
    claimedPaths?: string[];
  } = {}
): TaskSpec {
  const timestamp = nowIso();
  return {
    id: taskId,
    missionId: options.missionId ?? null,
    title: options.title ?? `Ad hoc task for ${owner}`,
    owner,
    kind: options.kind ?? "execution",
    nodeKind: options.nodeKind ?? null,
    status: "pending",
    prompt,
    dependsOnTaskIds: normalizeClaimedPaths(options.dependsOnTaskIds ?? []),
    parentTaskId: options.parentTaskId ?? null,
    planId: options.planId ?? null,
    planNodeKey: options.planNodeKey ?? null,
    retryCount:
      typeof options.retryCount === "number" && Number.isFinite(options.retryCount) && options.retryCount >= 0
        ? Math.floor(options.retryCount)
        : 0,
    maxRetries:
      typeof options.maxRetries === "number" && Number.isFinite(options.maxRetries) && options.maxRetries >= 0
        ? Math.floor(options.maxRetries)
        : 0,
    lastFailureSummary: options.lastFailureSummary ?? null,
    lease: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    summary: null,
    nextRecommendation: null,
    routeReason: options.routeReason ?? null,
    routeStrategy: options.routeStrategy ?? null,
    routeConfidence:
      typeof options.routeConfidence === "number" && Number.isFinite(options.routeConfidence)
        ? options.routeConfidence
        : null,
    routeMetadata: options.routeMetadata ?? {},
    claimedPaths: normalizeClaimedPaths(options.claimedPaths ?? [])
  };
}
