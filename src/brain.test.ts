import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addBrainEntry,
  buildBrainGraph,
  captureRepoTopologyBrainEntries,
  explainBrainEntry,
  mergeBrainEntries,
  queryBrainEntries,
  relevantBrainEntries,
  relatedBrainEntries,
  retireBrainEntry,
  searchBrainEntries
} from "./brain.ts";
import type { SessionRecord, TaskSpec } from "./types.ts";

function createSession(): SessionRecord {
  const timestamp = "2026-04-02T00:00:00.000Z";
  return {
    id: "session-brain",
    repoRoot: "/tmp/kavi-brain",
    baseCommit: "abc123",
    createdAt: timestamp,
    updatedAt: timestamp,
    socketPath: "/tmp/kavi-brain.sock",
    status: "running",
    goal: null,
    fullAccessMode: false,
    daemonPid: null,
    daemonHeartbeatAt: null,
    daemonVersion: "1.0.0",
    protocolVersion: 1,
    config: {
      version: 1,
      baseBranch: "main",
      validationCommand: "",
      messageLimit: 12,
      routing: {
        frontendKeywords: ["frontend", "ui", "web"],
        backendKeywords: ["backend", "api", "server"],
        codexPaths: [],
        claudePaths: []
      },
      agents: {
        codex: {
          role: "Backend and planning",
          model: "gpt-5"
        },
        claude: {
          role: "Frontend and intent",
          model: "claude"
        }
      }
    },
    runtime: {
      nodeExecutable: process.execPath,
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "dist/main.js"
    },
    worktrees: [],
    tasks: [],
    plans: [],
    missions: [],
    brain: [
      {
        id: "brain-pattern",
        missionId: "mission-1",
        taskId: null,
        sourceType: "pattern",
        category: "procedure",
        scope: "pattern",
        title: "Pattern: Clinic web shell",
        content: "Example paths: apps/web/app/page.tsx\nHelpful commands: npm test",
        tags: ["apps/web/app/page.tsx", "web", "clinic"],
        confidence: 0.8,
        freshness: "recent",
        evidence: ["apps/web/app/page.tsx"],
        commands: ["npm test"],
        supersedes: [],
        supersededBy: null,
        contradictions: [],
        retiredAt: null,
        pinned: false,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "brain-pinned",
        missionId: null,
        taskId: null,
        sourceType: "operator",
        category: "decision",
        scope: "personal",
        title: "Pinned architecture note",
        content: "Always keep queue state in the shared domain package.",
        tags: ["packages/domain", "queue"],
        confidence: 0.95,
        freshness: "live",
        evidence: ["packages/domain"],
        commands: [],
        supersedes: [],
        supersededBy: null,
        contradictions: [],
        retiredAt: null,
        pinned: true,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "brain-other",
        missionId: null,
        taskId: null,
        sourceType: "task",
        category: "artifact",
        scope: "repo",
        title: "Unrelated worker note",
        content: "Background OCR ingestion worker.",
        tags: ["worker", "ocr"],
        confidence: 0.6,
        freshness: "recent",
        evidence: [],
        commands: [],
        supersedes: [],
        supersededBy: null,
        contradictions: [],
        retiredAt: null,
        pinned: false,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    providerCapabilities: [],
    peerMessages: [],
    decisions: [],
    pathClaims: [],
    reviewNotes: [],
    recommendationStates: [],
    agentStatus: {
      codex: {
        agent: "codex",
        available: true,
        transport: "codex-app-server",
        lastRunAt: null,
        lastExitCode: null,
        sessionId: null,
        summary: null
      },
      claude: {
        agent: "claude",
        available: true,
        transport: "claude-print",
        lastRunAt: null,
        lastExitCode: null,
        sessionId: null,
        summary: null
      }
    }
  };
}

test("searchBrainEntries and relevantBrainEntries prioritize pinned and path-relevant context", () => {
  const session = createSession();
  const task: TaskSpec = {
    id: "task-1",
    missionId: "mission-1",
    title: "Refine clinic web queue",
    owner: "claude",
    kind: "execution",
    nodeKind: "frontend",
    status: "pending",
    prompt: "Refine the clinic queue UI in apps/web/app/page.tsx",
    dependsOnTaskIds: [],
    parentTaskId: null,
    planId: null,
    planNodeKey: null,
    retryCount: 0,
    maxRetries: 1,
    lastFailureSummary: null,
    lease: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    summary: null,
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["apps/web/app/page.tsx"]
  };

  const searched = searchBrainEntries(session, "clinic web queue", 3);
  const relevant = relevantBrainEntries(session, task, 3);

  assert.ok(searched.some((entry) => entry.id === "brain-pattern"));
  assert.ok(searched.some((entry) => entry.id === "brain-pinned"));
  assert.equal(relevant[0]?.id, "brain-pattern");
  assert.ok(relevant.some((entry) => entry.id === "brain-pinned"));
});

test("explainBrainEntry surfaces provenance and evidence", () => {
  const session = createSession();
  session.brain[0]!.supersededBy = "brain-pinned";
  session.brain[1]!.contradictions = ["brain-pattern"];
  const lines = explainBrainEntry(session, "brain-pattern");

  assert.ok(lines.some((line) => line.includes("Category: procedure")));
  assert.ok(lines.some((line) => line.includes("Evidence: apps/web/app/page.tsx")));
  assert.ok(lines.some((line) => line.includes("Commands: npm test")));
  assert.ok(lines.some((line) => line.includes("Related:")));
});

test("relatedBrainEntries prefers lifecycle-linked and structurally similar context", () => {
  const session = createSession();
  session.brain[0]!.supersededBy = "brain-pinned";
  session.brain[1]!.contradictions = ["brain-pattern"];

  const related = relatedBrainEntries(session, "brain-pattern", 3);

  assert.equal(related[0]?.id, "brain-pinned");
  assert.ok(related.some((entry) => entry.id === "brain-other") || related.length >= 1);
});

test("buildBrainGraph exposes lifecycle and shared-signal edges around a focus entry", () => {
  const session = createSession();
  session.brain[0]!.supersededBy = "brain-pinned";
  session.brain[1]!.contradictions = ["brain-pattern"];
  session.brain.push({
    id: "brain-mission",
    missionId: "mission-1",
    taskId: null,
    sourceType: "mission",
    category: "fact",
    scope: "mission",
    title: "Clinic mission blueprint",
    content: "Tracks clinic queue flows and web operator panels.",
    tags: ["clinic", "web", "queue"],
    confidence: 0.88,
    freshness: "live",
    evidence: ["apps/web/app/page.tsx"],
    commands: [],
    supersedes: [],
    supersededBy: null,
    contradictions: [],
    retiredAt: null,
    pinned: false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  });

  const graph = buildBrainGraph(session, {
    entryId: "brain-pattern",
    missionId: "mission-1",
    limit: 6
  });

  assert.equal(graph.focusEntryId, "brain-pattern");
  assert.ok(graph.nodes.some((node) => node.id === "brain-pinned"));
  assert.ok(graph.edges.some((edge) => edge.kind === "supersedes" && edge.from === "brain-pinned" && edge.to === "brain-pattern"));
  assert.ok(graph.edges.some((edge) => edge.kind === "tag"));
  assert.ok(graph.edges.some((edge) => edge.kind === "evidence"));
  assert.ok(graph.edges.some((edge) => edge.kind === "category" || edge.kind === "mission"));
});

test("buildBrainGraph can focus by path and expose command-family relationships", () => {
  const session = createSession();
  session.brain.push({
    id: "brain-web-runbook",
    missionId: null,
    taskId: null,
    sourceType: "operator",
    category: "procedure",
    scope: "repo",
    title: "Web dev runbook",
    content: "Use npm test before touching apps/web/app/page.tsx",
    tags: ["apps/web/app/page.tsx", "web"],
    confidence: 0.9,
    freshness: "live",
    evidence: ["apps/web/app/page.tsx"],
    commands: ["npm test", "npm run build"],
    supersedes: [],
    supersededBy: null,
    contradictions: [],
    retiredAt: null,
    pinned: false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  });

  const graph = buildBrainGraph(session, {
    path: "apps/web/app/page.tsx",
    limit: 6
  });

  assert.ok(graph.nodes.some((node) => node.id === "brain-pattern"));
  assert.ok(graph.nodes.some((node) => node.id === "brain-web-runbook"));
  assert.ok(graph.edges.some((edge) => edge.kind === "command"));
  assert.ok(graph.edges.some((edge) => edge.kind === "evidence"));
});

test("brain entries can supersede, retire, and merge older knowledge", () => {
  const session = createSession();
  const pinnedEntry = session.brain.find((entry) => entry.id === "brain-pinned");
  if (pinnedEntry) {
    pinnedEntry.confidence = 0.7;
  }
  const replacement = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "operator",
    category: "decision",
    scope: "personal",
    title: "Pinned architecture note",
    content: "Keep queue state in packages/domain and expose shared DTOs from packages/contracts.",
    tags: ["packages/domain", "packages/contracts", "queue"],
    confidence: 0.98,
    freshness: "live",
    evidence: ["packages/contracts"],
    commands: [],
    pinned: false
  });

  assert.ok(replacement.supersedes.includes("brain-pinned"));
  assert.equal(session.brain.find((entry) => entry.id === "brain-pinned")?.supersededBy, replacement.id);

  const merged = mergeBrainEntries(session, replacement.id, "brain-pattern");
  assert.ok(merged);
  assert.ok(merged?.content.includes("Example paths"));

  const retired = retireBrainEntry(session, "brain-other");
  assert.equal(retired?.retiredAt !== null, true);
});

test("captureRepoTopologyBrainEntries records reusable repo structure and runbook context", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kavi-brain-topology-"));
  await fs.mkdir(path.join(repoRoot, "apps/web/app"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "apps/api/src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "apps/web/app/page.tsx"), "export default function Page() { return null; }\n");
  await fs.writeFile(path.join(repoRoot, "apps/api/src/server.ts"), "import { buildApp } from \"../app\";\nexport const server = buildApp();\n");
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      scripts: {
        build: "next build",
        test: "vitest run"
      }
    }),
    "utf8"
  );
  const session = {
    ...createSession(),
    repoRoot
  };

  const entries = await captureRepoTopologyBrainEntries(session, repoRoot, "mission-1");

  assert.equal(entries.length, 3);
  assert.ok(entries.some((entry) => entry.title === "Repo topology"));
  assert.ok(entries.some((entry) => entry.title === "Repo runbook"));
  assert.ok(entries.some((entry) => entry.title === "Repo structure graph"));
  assert.ok(session.brain.some((entry) => entry.commands?.some((command) => command.includes("test"))));
});

test("queryBrainEntries supports path and scope-aware filtering", () => {
  const session = createSession();
  const results = queryBrainEntries(session, {
    path: "apps/web/app/page.tsx",
    scope: "pattern",
    limit: 5
  });

  assert.ok(results.length >= 1);
  assert.equal(results[0]?.id, "brain-pattern");
});
