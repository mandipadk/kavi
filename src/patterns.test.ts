import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createMission } from "./missions.ts";
import { resolveAppPaths } from "./paths.ts";
import {
  attachRelevantPatternsToMission,
  buildPatternBenchmarks,
  buildPatternConstellation,
  buildPatternStudio,
  buildPatternAppliedPrompt,
  buildPatternTemplatePrompt,
  buildPatternTemplates,
  composePatternTemplates,
  captureLandingPatterns,
  captureMissionAntiPatterns,
  listPatterns,
  rankPatterns,
  rankPatternTemplates,
  searchPatterns
} from "./patterns.ts";
import type { KaviConfig, LandReport, SessionRecord } from "./types.ts";

function createConfig(): KaviConfig {
  return {
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
  };
}

function createSession(repoRoot: string): SessionRecord {
  const timestamp = "2026-04-02T00:00:00.000Z";
  return {
    id: "session-patterns",
    repoRoot,
    baseCommit: "abc123",
    createdAt: timestamp,
    updatedAt: timestamp,
    socketPath: path.join(repoRoot, ".kavi.sock"),
    status: "running",
    goal: "Build a clinic command center",
    fullAccessMode: false,
    daemonPid: null,
    daemonHeartbeatAt: null,
    daemonVersion: "1.0.0",
    protocolVersion: 1,
    config: createConfig(),
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
    brain: [],
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

function createLandReport(sessionId: string): LandReport {
  return {
    id: "report-1",
    sessionId,
    goal: "Build a clinic command center",
    createdAt: "2026-04-02T00:05:00.000Z",
    targetBranch: "main",
    integrationBranch: "kavi/integration/report-1",
    integrationPath: "/tmp/integration",
    validationCommand: "npm test",
    validationStatus: "ran",
    validationDetail: "npm test passed",
    changedByAgent: [
      {
        agent: "codex",
        paths: ["apps/api/src/server.ts", "packages/domain/patient.ts"]
      },
      {
        agent: "claude",
        paths: ["apps/web/app/page.tsx", "packages/ui/src/queue.tsx"]
      }
    ],
    completedTasks: [],
    snapshotCommits: [],
    commandsRun: ["npm test", "npm run build"],
    reviewThreadsLanded: 0,
    openReviewThreadsRemaining: 0,
    summary: ["Built a clinic command center with web and api slices."]
  };
}

test("captureLandingPatterns persists searchable patterns and avoids duplicate pattern rows", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-patterns-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  session.missions.push(mission);
  const report = createLandReport(session.id);

  const first = await captureLandingPatterns(paths, session, report);
  const second = await captureLandingPatterns(paths, session, report);
  const listed = await listPatterns(paths);
  const searched = await searchPatterns(paths, "clinic web api", 5);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(listed.length, 1);
  assert.equal(searched.length, 1);
  assert.equal(searched[0]?.title, mission.title);
  assert.ok(searched[0]?.commands.includes("npm test"));
  assert.ok(searched[0]?.examplePaths.includes("apps/web/app/page.tsx"));
  assert.equal(searched[0]?.kind, "delivery");
  assert.ok((searched[0]?.stackSignals ?? []).includes("typescript"));
  assert.ok((searched[0]?.nodeKinds ?? []).includes("frontend"));
});

test("attachRelevantPatternsToMission promotes matching patterns into mission brain context", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-brain-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  session.missions.push(mission);

  await captureLandingPatterns(paths, session, createLandReport(session.id));
  const entries = await attachRelevantPatternsToMission(
    paths,
    session,
    mission.id,
    "Refine the clinic web shell and api workflow"
  );

  assert.ok(entries.length > 0);
  assert.equal(entries[0]?.sourceType, "pattern");
  assert.ok(mission.brainEntryIds.includes(entries[0]!.id));
  assert.ok(session.brain.some((entry) => entry.id === entries[0]!.id));
  assert.ok((mission.appliedPatternIds ?? []).length > 0);
  assert.ok(entries.some((entry) => entry.title.startsWith("Pattern composition:")));
});

test("rankPatterns and buildPatternAppliedPrompt expose reusable templates", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-rank-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  session.missions.push(mission);

  const [pattern] = await captureLandingPatterns(paths, session, createLandReport(session.id));
  const ranked = await rankPatterns(paths, "clinic web api dashboard", 5);
  const applied = buildPatternAppliedPrompt(pattern, "Create a new clinic queue refinement slice.");

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0]?.entry.id, pattern.id);
  assert.ok(ranked[0]?.reasons.length);
  assert.match(applied, /Pattern context selected by Kavi/);
  assert.match(applied, /Acceptance defaults/);
});

test("buildPatternTemplates and template prompts expose portfolio-level reuse", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-templates-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  session.missions.push(mission);

  await captureLandingPatterns(paths, session, createLandReport(session.id));
  const templates = await buildPatternTemplates(paths);
  const ranked = await rankPatternTemplates(paths, "clinic frontend api dashboard", 5);
  const composed = buildPatternTemplatePrompt(templates[0]!, "Start a similar clinic dashboard product.");

  assert.ok(templates.length >= 1);
  assert.ok(ranked.length >= 1);
  assert.match(composed, /Portfolio template context selected by Kavi/);
  assert.match(composed, /Acceptance defaults/);
});

test("buildPatternBenchmarks and composePatternTemplates expose portfolio leverage", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-compose-"));
  const relatedRepoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-compose-related-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const relatedSession = createSession(relatedRepoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  const relatedMission = createMission(relatedSession, "Build a clinic dispatch board with a web shell and API.");
  session.missions.push(mission);
  relatedSession.missions.push(relatedMission);

  await captureLandingPatterns(paths, session, createLandReport(session.id));
  await captureLandingPatterns(paths, relatedSession, createLandReport(relatedSession.id));
  await captureMissionAntiPatterns(paths, session, mission);
  const benchmarks = await buildPatternBenchmarks(paths);
  const composition = await composePatternTemplates(
    paths,
    "Create a new clinic dashboard with docs and api verification."
  );

  assert.ok(benchmarks.length >= 1);
  assert.ok(benchmarks[0]!.score > 0);
  assert.ok(benchmarks[0]!.trustScore >= 0);
  assert.ok(["high_trust", "promising", "noisy", "fragile"].includes(benchmarks[0]!.trustClass));
  assert.ok(composition.templateIds.length >= 1);
  assert.ok(composition.templateIds.every((templateId) => !templateId.startsWith("template:anti_pattern")));
  assert.match(composition.composedPrompt, /Composed portfolio pattern context selected by Kavi/);
  assert.ok(composition.benchmarkScore > 0);
  assert.ok(composition.commands.every((command) => !command.includes("/private/tmp/")));
});

test("buildPatternStudio combines composition, benchmark, and constellation evidence", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-studio-"));
  const relatedRepoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-studio-related-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const relatedSession = createSession(relatedRepoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  const relatedMission = createMission(relatedSession, "Build a clinic triage dashboard with docs, web shell, and API.");
  session.missions.push(mission);
  relatedSession.missions.push(relatedMission);

  await captureLandingPatterns(paths, session, createLandReport(session.id));
  await captureLandingPatterns(paths, relatedSession, createLandReport(relatedSession.id));
  await captureMissionAntiPatterns(paths, session, mission);

  const studio = await buildPatternStudio(
    paths,
    "Create a clinic operations platform with docs, frontend dashboards, and scheduling APIs."
  );

  assert.ok(studio.rankedTemplates.length >= 1);
  assert.ok(studio.composition.templateIds.length >= 1);
  assert.ok(studio.selectedBenchmarks.length >= 1);
  assert.ok(studio.relatedRepoClusters.length >= 1);
  assert.ok(studio.relatedClusterInsights.length >= 1);
  assert.ok(studio.relatedStartingPoints.length >= 1);
  assert.ok(studio.topStacks.some((item) => item.value === "typescript"));
});

test("captureMissionAntiPatterns and buildPatternConstellation surface recurring risks", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-constellation-"));
  const relatedRepoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-related-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };
  const session = createSession(repoRoot);
  const relatedSession = createSession(relatedRepoRoot);
  const mission = createMission(session, "Build a clinic command center with a web shell and API.");
  const relatedMission = createMission(relatedSession, "Build a clinic triage dashboard with a web shell and API.");
  session.missions.push(mission);
  relatedSession.missions.push(relatedMission);
  mission.acceptance.checks.push({
    id: "check-docs",
    title: "Docs expectations are represented",
    kind: "docs",
    command: null,
    path: "README.md",
    status: "failed",
    detail: "README missing",
    lastRunAt: "2026-04-02T00:10:00.000Z",
    lastOutput: "Missing README.md"
  });

  await captureLandingPatterns(paths, session, createLandReport(session.id));
  await captureLandingPatterns(paths, relatedSession, createLandReport(relatedSession.id));
  const anti = await captureMissionAntiPatterns(paths, session, mission);
  const constellation = await buildPatternConstellation(paths);

  assert.equal(anti[0]?.kind, "anti_pattern");
  assert.ok((anti[0]?.antiPatternSignals ?? []).some((item) => item.includes("docs expectations")));
  assert.ok(constellation.totalPatterns >= 2);
  assert.ok(constellation.antiPatterns.length >= 1);
  assert.ok(constellation.totalTemplates >= 1);
  assert.ok(constellation.topStacks.some((item) => item.value === "typescript"));
  assert.ok(constellation.topRepos.some((item) => item.value === path.basename(repoRoot)));
  assert.ok(constellation.patternFamilies.length >= 1);
  assert.ok(constellation.repoProfiles.some((profile) => profile.label === path.basename(repoRoot)));
  assert.ok(constellation.repoLinks.length >= 1);
  assert.ok(constellation.repoLinks.some((link) => link.sharedStacks.includes("typescript")));
  assert.ok(constellation.repoClusters.length >= 1);
  assert.ok(constellation.repoClusters.some((cluster) => cluster.labels.includes(path.basename(repoRoot))));
  assert.ok(constellation.clusterInsights.length >= 1);
  assert.ok(constellation.clusterInsights.some((cluster) => cluster.trustScore >= 0));
  assert.ok(constellation.clusterInsights.some((cluster) => cluster.commandHabits.length >= 1));
  assert.ok(constellation.templates.length >= 1);
  assert.ok(constellation.templateLinks.length >= 1);
  assert.ok(constellation.commandHabits.some((habit) => habit.command === "npm test"));
  assert.ok(constellation.startingPoints.length >= 1);
  assert.ok(constellation.startingPoints.some((entry) => entry.benchmarkScore > 0));
  assert.ok(constellation.startingPoints.some((entry) => ["high_trust", "promising", "noisy", "fragile"].includes(entry.trustClass)));
  assert.ok(constellation.antiPatternHotspots.some((item) => item.value.includes("docs expectations")));
});

test("buildPatternConstellation derives useful signals from legacy sparse patterns", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-legacy-"));
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };

  await writeFile(
    paths.patternsFile,
    JSON.stringify([
      {
        id: "pattern-legacy",
        sourceRepoRoot: repoRoot,
        missionId: null,
        reportId: null,
        kind: "architecture",
        title: "Legacy Next dashboard starter",
        summary: "Set up apps/web/app/page.tsx and apps/api/src/server.ts with a shared schema.",
        prompt: "Build a Next dashboard with an API and shared schema.",
        tags: ["apps", "web", "api", "with", "schema"],
        stackSignals: [],
        nodeKinds: [],
        acceptanceCriteria: [],
        confidence: 0.7,
        usageCount: 1,
        sourceMissionIds: [],
        antiPatternSignals: [],
        examplePaths: ["apps/web/app/page.tsx", "apps/api/src/server.ts", "packages/domain/schema.ts"],
        commands: ["npm run build"],
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z"
      }
    ]),
    "utf-8"
  );

  const constellation = await buildPatternConstellation(paths);
  assert.ok(constellation.topStacks.some((item) => item.value === "typescript"));
  assert.ok(constellation.topNodeKinds.some((item) => item.value === "frontend"));
  assert.ok(constellation.topNodeKinds.some((item) => item.value === "backend"));
  assert.ok(constellation.topCommands.every((item) => !item.value.includes(".kavi/runtime/")));
  assert.ok(constellation.commandHabits.some((habit) => habit.command === "npm run build"));
  assert.ok(constellation.startingPoints.length >= 1);
  assert.ok(!constellation.topTags.some((item) => item.value === "with"));
});

test("buildPatternBenchmarks prefers recent low-repair templates over noisy ones", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-pattern-trust-"));
  const stableRepoRoot = `${repoRoot}-stable`;
  const noisyRepoRoot = `${repoRoot}-noisy`;
  const paths = {
    ...resolveAppPaths(repoRoot),
    patternsFile: path.join(repoRoot, ".kavi-patterns.json")
  };

  await writeFile(
    paths.patternsFile,
    JSON.stringify([
      {
        id: "pattern-stable",
        sourceRepoRoot: stableRepoRoot,
        missionId: "mission-stable",
        reportId: "report-stable",
        kind: "delivery",
        title: "Reliable clinic dashboard starter",
        summary: "Recent landed dashboard with docs and validation.",
        prompt: "Build a clinic dashboard with docs and API.",
        tags: ["clinic", "dashboard", "docs"],
        stackSignals: ["typescript"],
        nodeKinds: ["frontend"],
        acceptanceCriteria: ["Docs exist", "HTTP check passes", "Browser flow loads"],
        confidence: 0.92,
        usageCount: 3,
        sourceMissionIds: ["mission-stable"],
        antiPatternSignals: [],
        examplePaths: ["apps/web/app/page.tsx", "apps/api/src/server.ts"],
        commands: ["npm run build", "npm test"],
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z"
      },
      {
        id: "pattern-noisy",
        sourceRepoRoot: noisyRepoRoot,
        missionId: "mission-noisy",
        reportId: "report-noisy",
        kind: "delivery",
        title: "Older clinic dashboard starter",
        summary: "Older landed dashboard with weaker validation.",
        prompt: "Build a clinic dashboard.",
        tags: ["clinic", "worker"],
        stackSignals: ["python"],
        nodeKinds: ["backend"],
        acceptanceCriteria: ["Docs exist"],
        confidence: 0.7,
        usageCount: 5,
        sourceMissionIds: ["mission-noisy"],
        antiPatternSignals: [],
        examplePaths: ["apps/web/app/page.tsx"],
        commands: ["npm run build"],
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2025-12-01T00:00:00.000Z"
      },
      {
        id: "pattern-noisy-anti",
        sourceRepoRoot: noisyRepoRoot,
        missionId: "mission-noisy",
        reportId: null,
        kind: "anti_pattern",
        title: "Dashboard docs drift",
        summary: "This family frequently misses docs and verification follow-through.",
        prompt: "Avoid weak docs coverage for clinic dashboards.",
        tags: ["clinic", "worker", "docs-drift"],
        stackSignals: ["python"],
        nodeKinds: ["backend"],
        acceptanceCriteria: [],
        confidence: 0.6,
        usageCount: 1,
        sourceMissionIds: ["mission-noisy"],
        antiPatternSignals: ["docs expectations", "verification drift"],
        examplePaths: ["README.md"],
        commands: [],
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z"
      }
    ]),
    "utf-8"
  );

  const benchmarks = await buildPatternBenchmarks(paths);
  assert.ok(benchmarks.length >= 2);
  assert.ok(benchmarks[0]!.trustScore >= benchmarks[1]!.trustScore);
  assert.ok(["high_trust", "promising"].includes(benchmarks[0]!.trustClass));
  assert.ok(benchmarks.some((item) => item.trustClass === "fragile" || item.trustClass === "noisy"));
});
