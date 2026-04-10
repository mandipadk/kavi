import { randomUUID } from "node:crypto";
import { relevantBrainEntries } from "../brain.ts";
import { findMission } from "../missions.ts";
import { nowIso } from "../paths.ts";
import type {
  AgentName,
  AgentTurnEnvelope,
  PeerMessage,
  PlannedTaskDraft,
  PlannedTaskGraph,
  SessionRecord,
  TaskSpec
} from "../types.ts";

function formatDecisionLine(summary: string, detail: string): string {
  return detail.trim() ? `- ${summary}: ${detail}` : `- ${summary}`;
}

export function buildDecisionReplay(session: SessionRecord, task: TaskSpec, agent: AgentName): string[] {
  const winningRule =
    task.routeMetadata?.winningRule &&
    typeof task.routeMetadata.winningRule === "object" &&
    !Array.isArray(task.routeMetadata.winningRule) &&
    typeof (task.routeMetadata.winningRule as Record<string, unknown>).pattern === "string"
      ? String((task.routeMetadata.winningRule as Record<string, unknown>).pattern)
      : null;
  const taskDecisions = session.decisions
    .filter((decision) => decision.taskId === task.id)
    .slice(-6)
    .map((decision) => formatDecisionLine(`[${decision.kind}] ${decision.summary}`, decision.detail));

  const sharedDecisions = session.decisions
    .filter((decision) => decision.taskId !== task.id && (decision.agent === agent || decision.agent === null))
    .slice(-4)
    .map((decision) => formatDecisionLine(`[${decision.kind}] ${decision.summary}`, decision.detail));

  const relevantClaims = session.pathClaims
    .filter((claim) => claim.status === "active" && (claim.taskId === task.id || claim.agent !== agent))
    .slice(-6)
    .map(
      (claim) =>
        `- ${claim.agent} ${claim.source} claim on ${claim.paths.join(", ")}${claim.note ? `: ${claim.note}` : ""}`
    );

  const replay = [
    `- Current route reason: ${task.routeReason ?? "not recorded"}`,
    `- Winning ownership rule: ${winningRule ?? "none"}`,
    `- Current claimed paths: ${task.claimedPaths.join(", ") || "none"}`,
    ...taskDecisions,
    ...sharedDecisions,
    ...relevantClaims
  ];

  return replay.slice(0, 16);
}

function normalizeEnvelopeShape(parsed: unknown): AgentTurnEnvelope {
  const payload =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};

  const normalizePlan = (value: unknown): PlannedTaskGraph | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const plan = value as Record<string, unknown>;
    const tasks = Array.isArray(plan.tasks)
      ? plan.tasks
          .map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return null;
            }

            const task = item as Record<string, unknown>;
            return {
              key:
                typeof task.key === "string" && task.key.trim()
                  ? task.key.trim()
                  : `task-${index + 1}`,
              title: String(task.title ?? `Planned task ${index + 1}`),
              owner: task.owner === "claude" ? "claude" : "codex",
              prompt: String(task.prompt ?? ""),
              nodeKind:
                task.nodeKind === "research" ||
                task.nodeKind === "scaffold" ||
                task.nodeKind === "backend" ||
                task.nodeKind === "frontend" ||
                task.nodeKind === "shared_contract" ||
                task.nodeKind === "infra" ||
                task.nodeKind === "tests" ||
                task.nodeKind === "docs" ||
                task.nodeKind === "review" ||
                task.nodeKind === "repair" ||
                task.nodeKind === "integration"
                  ? task.nodeKind
                  : null,
              dependsOn: Array.isArray(task.dependsOn)
                ? task.dependsOn.map((dependency) => String(dependency))
                : [],
              claimedPaths: Array.isArray(task.claimedPaths)
                ? task.claimedPaths.map((path) => String(path))
                : [],
              reason: String(task.reason ?? ""),
              executionMode:
                task.executionMode === "blocking" || task.executionMode === "follow_up"
                  ? task.executionMode
                  : "parallel"
            } satisfies PlannedTaskDraft;
          })
          .filter((task): task is PlannedTaskDraft => task !== null)
      : [];

    return {
      summary: typeof plan.summary === "string" ? plan.summary : "",
      tasks
    };
  };

  return {
    summary: typeof payload.summary === "string" ? payload.summary : "",
    status:
      payload.status === "blocked" || payload.status === "needs_review"
        ? payload.status
        : "completed",
    blockers: Array.isArray(payload.blockers) ? payload.blockers.map((item) => String(item)) : [],
    nextRecommendation:
      payload.nextRecommendation === null || typeof payload.nextRecommendation === "string"
        ? payload.nextRecommendation
        : null,
    plan: normalizePlan(payload.plan),
    peerMessages: Array.isArray(payload.peerMessages)
      ? payload.peerMessages.map((message) => {
          const item =
            message && typeof message === "object" && !Array.isArray(message)
              ? message as Record<string, unknown>
              : {};
          return {
            to: item.to === "codex" ? "codex" : "claude",
            intent:
              item.intent === "handoff" ||
              item.intent === "review_request" ||
              item.intent === "blocked" ||
              item.intent === "context_share"
                ? item.intent
                : "question",
            subject: String(item.subject ?? ""),
            body: String(item.body ?? "")
          };
        })
      : []
  };
}

function parseJsonCandidate(candidate: string): AgentTurnEnvelope | null {
  try {
    return normalizeEnvelopeShape(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function extractBalancedJsonObjects(rawOutput: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = 0; index < rawOutput.length; index += 1) {
    const char = rawOutput[index];
    if (char === undefined) {
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\") {
        escape = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(rawOutput.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

export function extractJsonObject(rawOutput: string): AgentTurnEnvelope {
  const trimmed = rawOutput.trim();
  const direct = parseJsonCandidate(trimmed);
  if (direct) {
    return direct;
  }

  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim() ?? "";
    const parsed = candidate ? parseJsonCandidate(candidate) : null;
    if (parsed) {
      return parsed;
    }
  }

  const candidates = extractBalancedJsonObjects(trimmed);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }

    const parsed = parseJsonCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  if (!trimmed.includes("{")) {
    throw new Error(`Unable to find JSON object in output:\n${rawOutput}`);
  }

  throw new Error(`Unable to parse JSON object in output:\n${rawOutput}`);
}

export function buildUnstructuredEnvelope(rawOutput: string): AgentTurnEnvelope {
  const firstMeaningfulLine = rawOutput
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const compact = rawOutput.replaceAll(/\s+/g, " ").trim();
  const source = firstMeaningfulLine || compact;
  const summary =
    source && source.length <= 140
      ? source
      : source
        ? `${source.slice(0, 137)}...`
        : "Task output was produced, but Kavi could not extract the structured summary envelope.";

  return {
    summary,
    status: "completed",
    blockers: [],
    nextRecommendation: "Review the raw output and changed files because the agent returned unstructured output.",
    plan: null,
    peerMessages: []
  };
}

export function buildPeerMessages(
  envelope: AgentTurnEnvelope,
  from: AgentName,
  taskId: string
): PeerMessage[] {
  return envelope.peerMessages.map((message) => ({
    id: randomUUID(),
    taskId,
    from,
    to: message.to,
    intent: message.intent,
    subject: message.subject,
    body: message.body,
    createdAt: nowIso()
  }));
}

export function buildSharedContext(
  session: SessionRecord,
  task: TaskSpec,
  agent: AgentName
): string {
  const mission = findMission(session, task.missionId);
  const inbox = session.peerMessages
    .filter((message) => message.to === agent)
    .slice(-session.config.messageLimit)
    .map((message) => `- [${message.intent}] ${message.subject}: ${message.body}`)
    .join("\n");

  const tasks = session.tasks
    .map((item) => `- ${item.id} | ${item.owner} | ${item.status} | ${item.title}`)
    .join("\n");

  const decisionReplay = buildDecisionReplay(session, task, agent).join("\n");

  const claims = session.pathClaims
    .filter((claim) => claim.status === "active")
    .slice(-6)
    .map((claim) => `- ${claim.agent} | ${claim.paths.join(", ")}`)
    .join("\n");

  const brain = relevantBrainEntries(session, task)
    .map((entry) => {
      const meta = [
        entry.category ?? "artifact",
        entry.scope ?? (entry.missionId ? "mission" : "repo"),
        `${Math.round((entry.confidence ?? 0.6) * 100)}%`
      ].join(" | ");
      const evidence = (entry.evidence ?? []).join(", ");
      return `- ${entry.title} [${meta}]${evidence ? ` evidence=${evidence}` : ""}: ${entry.content}`;
    })
    .join("\n");

  const missionLines = mission
    ? [
        `Mission: ${mission.title}`,
        `Mission status: ${mission.status}`,
        `Mission mode: ${mission.mode}`,
        `Mission summary: ${mission.summary}`,
        `Mission acceptance: ${mission.acceptance.status}`,
        `Mission criteria: ${mission.acceptance.criteria.join(" | ") || "-"}`,
        `Mission health: ${mission.health?.state ?? "-"} | score=${mission.health?.score ?? "-"}`,
        `Mission workstreams: ${mission.spec?.workstreamKinds.join(", ") || "-"}`,
        `Mission stack hints: ${mission.spec?.stackHints.join(", ") || "-"}`,
        `Mission deliverables: ${mission.spec?.requestedDeliverables.join(", ") || "-"}`,
        `Mission roles: ${mission.spec?.userRoles.join(", ") || "-"}`,
        `Mission blueprint concept: ${mission.blueprint?.productConcept ?? "-"}`,
        `Mission blueprint boundaries: ${mission.blueprint?.serviceBoundaries.join(", ") || "-"}`,
        `Mission blueprint UI surfaces: ${mission.blueprint?.uiSurfaces.join(", ") || "-"}`,
        `Mission journeys: ${mission.blueprint?.acceptanceJourneys.join(" | ") || "-"}`,
        `Mission policy: autonomy=${mission.policy?.autonomyLevel ?? "-"} approvals=${mission.policy?.approvalMode ?? "-"} retry=${mission.policy?.retryBudget ?? "-"} verify=${mission.policy?.verificationMode ?? "-"}`,
        `Mission gates: ${mission.policy?.gatePolicy?.join(", ") || "-"}`,
        `Mission contract scenarios: ${mission.contract?.scenarios.join(" | ") || "-"}`,
        `Mission risks: ${(mission.risks ?? []).map((risk) => `${risk.severity}:${risk.title}`).join(" | ") || "-"}`,
        `Mission anchors: ${(mission.anchors ?? []).map((anchor) => `${anchor.kind}:${anchor.summary}`).join(" | ") || "-"}`,
        `Applied patterns: ${(mission.appliedPatternIds ?? []).join(", ") || "-"}`
      ]
    : ["Mission: none"];

  return [
    `Session goal: ${session.goal ?? "No goal recorded."}`,
    ...missionLines,
    `Current task: ${task.title}`,
    "Task board:",
    tasks || "- none",
    "Compaction-safe replay:",
    decisionReplay || "- empty",
    "Active path claims:",
    claims || "- empty",
    "Relevant project memory:",
    brain || "- empty",
    `Peer inbox for ${agent}:`,
    inbox || "- empty"
  ].join("\n");
}

export function buildTaskPrompt(
  session: SessionRecord,
  task: TaskSpec,
  agent: AgentName
): string {
  return [
    buildSharedContext(session, task, agent),
    "",
    `User goal or prompt:\n${task.prompt}`
  ].join("\n");
}

export function buildEnvelopeInstruction(agent: AgentName, worktreePath: string): string {
  const peer = agent === "codex" ? "claude" : "codex";
  const focus =
    agent === "codex"
      ? "Focus on planning, architecture, backend concerns, codebase structure, and implementation risks."
      : "Focus on intent, user experience, frontend structure, and interaction quality.";

  return [
    focus,
    `You are working inside the worktree at ${worktreePath}.`,
    `Return JSON only with this exact shape:`,
    "{",
    '  "summary": "short summary",',
    '  "status": "completed" | "blocked" | "needs_review",',
    '  "blockers": ["optional blockers"],',
    '  "nextRecommendation": "optional next step or null",',
    '  "plan": null,',
    '  "peerMessages": [',
    `    { "to": "${peer}", "intent": "question|handoff|review_request|blocked|context_share", "subject": "short", "body": "short" }`,
    "  ]",
    "}",
    "Do not wrap the JSON in Markdown."
  ].join("\n");
}

export function buildPlannerInstruction(worktreePath: string): string {
  return [
    "You are the orchestration planner inside Kavi.",
    `You are working inside the worktree at ${worktreePath}.`,
    "Turn the prompt into an execution graph for Codex and Claude.",
    "Use the fewest tasks that still preserve clear ownership and dependencies.",
    "Only create dependencies that are truly blocking; independent work should be parallel.",
    "Prefer Codex for planning, architecture, backend, debugging, and test-heavy implementation.",
    "Prefer Claude for frontend, UX, interaction quality, and intent-shaping implementation.",
    "Return JSON only with this exact shape:",
    "{",
    '  "summary": "short plan summary",',
    '  "status": "completed" | "blocked" | "needs_review",',
    '  "blockers": ["optional blockers"],',
    '  "nextRecommendation": "optional next step or null",',
    '  "plan": {',
    '    "summary": "short operator-facing graph summary",',
    '    "tasks": [',
    '      {',
    '        "key": "short-stable-id",',
    '        "title": "task title",',
    '        "owner": "codex" | "claude",',
    '        "prompt": "full task prompt",',
    '        "nodeKind": "scaffold" | "backend" | "frontend" | "shared_contract" | "infra" | "tests" | "docs" | "review" | "repair" | "integration" | null,',
    '        "dependsOn": ["other-key"],',
    '        "claimedPaths": ["optional/path.ts"],',
    '        "reason": "why this task exists and why this owner",',
    '        "executionMode": "blocking" | "parallel" | "follow_up"',
    "      }",
    "    ]",
    "  },",
    '  "peerMessages": []',
    "}",
    "If you are blocked and cannot produce a safe graph, set \"plan\" to null and explain the blockers.",
    "Do not wrap the JSON in Markdown."
  ].join("\n");
}

export function buildAgentInstructions(
  agent: AgentName,
  worktreePath: string,
  repoPrompt: string
): string {
  return [repoPrompt.trim(), buildEnvelopeInstruction(agent, worktreePath)]
    .filter(Boolean)
    .join("\n\n");
}
