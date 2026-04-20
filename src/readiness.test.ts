import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import { buildReadinessReport } from "./readiness.ts";
import type { DoctorCheck, SessionRecord, TaskArtifact } from "./types.ts";

function passingDoctorChecks(): DoctorCheck[] {
  return [
    { name: "node", ok: true, detail: "v25.6.0" },
    { name: "codex", ok: true, detail: "codex ok" },
    { name: "claude", ok: true, detail: "claude ok" },
    { name: "claude-auth", ok: true, detail: "logged in" },
    { name: "git-worktree", ok: true, detail: "available" },
    { name: "codex-app-server", ok: true, detail: "available" },
    { name: "codex-auth-file", ok: true, detail: "present" },
    { name: "home-config", ok: true, detail: "present" },
    { name: "codex-app-server-canary", ok: true, detail: "ok" },
    { name: "claude-print-contract", ok: true, detail: "ok" },
    { name: "routing-path-rules", ok: true, detail: "ok" }
  ];
}

function baseSession(): SessionRecord {
  return {
    id: "session-readiness",
    repoRoot: "/tmp/repo",
    baseCommit: "abc123",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    socketPath: "/tmp/kavi.sock",
    status: "running",
    goal: "Ship a backend service",
    selectedMissionId: "mission-1",
    fullAccessMode: true,
    daemonPid: 123,
    daemonHeartbeatAt: "2026-04-20T00:00:00.000Z",
    daemonVersion: "1.5.2",
    protocolVersion: 1,
    config: defaultConfig(),
    runtime: {
      nodeExecutable: "node",
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "dist/main.js"
    },
    worktrees: [],
    tasks: [
      {
        id: "task-1",
        missionId: "mission-1",
        title: "Implement backend service",
        owner: "codex",
        kind: "execution",
        nodeKind: "backend",
        status: "completed",
        prompt: "Implement backend service",
        dependsOnTaskIds: [],
        parentTaskId: null,
        planId: null,
        planNodeKey: null,
        retryCount: 0,
        maxRetries: 1,
        lastFailureSummary: null,
        lease: null,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:10:00.000Z",
        summary: "Implemented backend service and docs.",
        nextRecommendation: null,
        routeReason: "manual",
        routeStrategy: "manual",
        routeConfidence: 1,
        routeMetadata: {},
        claimedPaths: ["apps/api/server.ts", "README.md"]
      }
    ],
    plans: [],
    missions: [
      {
        id: "mission-1",
        title: "Backend service",
        prompt: "Implement backend service with docs",
        goal: "Implement backend service with docs",
        mode: "guided_autopilot",
        status: "ready_to_land",
        summary: "Ready to land.",
        planningTaskId: null,
        planId: null,
        rootTaskId: "task-1",
        activeTaskIds: [],
        autopilotEnabled: true,
        phase: "landing",
        spec: {
          normalizedPrompt: "implement backend service with docs",
          audience: null,
          repoShape: "existing",
          workstreamKinds: ["backend", "docs"],
          stackHints: ["node"],
          requestedDeliverables: [],
          userRoles: [],
          domainEntities: [],
          constraints: []
        },
        contract: {
          acceptanceCriteria: [],
          scenarios: [],
          qualityBars: [],
          docsExpectations: []
        },
        blueprint: {
          overview: "",
          productConcept: "",
          personas: [],
          domainModel: [],
          serviceBoundaries: [],
          uiSurfaces: [],
          acceptanceJourneys: [],
          architectureNotes: []
        },
        policy: {
          autonomyLevel: "autonomous",
          approvalMode: "approve_all",
          retryBudget: 1,
          operatorAttentionBudget: 4,
          escalationPolicy: "balanced",
          verificationMode: "strict",
          landPolicy: "acceptance_gated",
          gatePolicy: [],
          autoAdvance: true,
          autoVerify: true,
          autoLand: false,
          pauseOnRepairFailure: true
        },
        risks: [],
        anchors: [],
        health: {
          score: 91,
          state: "healthy",
          reasons: [],
          updatedAt: "2026-04-20T00:10:00.000Z"
        },
        simulation: {
          generatedAt: "2026-04-20T00:00:00.000Z",
          attentionCost: 1,
          attentionBudget: 4,
          gatePressure: 0,
          serialityScore: 10,
          contractRequestCount: 0,
          escalationPressure: "low",
          escalationReasons: [],
          autopilotViable: true,
          estimatedParallelism: 1,
          verificationCoverage: "strong",
          contractCoverage: "explicit",
          issues: [],
          recommendations: []
        },
        appliedPatternIds: [],
        receiptIds: ["receipt-1"],
        contractIds: [],
        acceptance: {
          id: "accept-1",
          summary: "Acceptance pack",
          criteria: ["Backend service works", "Docs explain the flow"],
          checks: [
            {
              id: "check-1",
              title: "README documents backend service",
              kind: "docs",
              command: null,
              status: "passed",
              detail: "README updated",
              lastRunAt: "2026-04-20T00:11:00.000Z",
              lastOutput: "ok"
            },
            {
              id: "check-2",
              title: "Server boots",
              kind: "command",
              command: "npm test",
              status: "passed",
              detail: "Passed",
              lastRunAt: "2026-04-20T00:11:00.000Z",
              lastOutput: "ok"
            },
            {
              id: "check-3",
              title: "API contract exists",
              kind: "contract",
              command: null,
              status: "passed",
              detail: "Passed",
              lastRunAt: "2026-04-20T00:11:00.000Z",
              lastOutput: "ok"
            },
            {
              id: "check-4",
              title: "Scenario passes",
              kind: "scenario",
              command: null,
              status: "passed",
              detail: "Passed",
              lastRunAt: "2026-04-20T00:11:00.000Z",
              lastOutput: "ok"
            }
          ],
          failurePacks: [],
          repairPlans: [],
          status: "passed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:11:00.000Z"
        },
        checkpoints: [],
        brainEntryIds: ["brain-topology"],
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:11:00.000Z",
        landedAt: null
      }
    ],
    receipts: [
      {
        id: "receipt-1",
        missionId: "mission-1",
        taskId: "task-1",
        owner: "codex",
        title: "Implement backend service",
        summary: "Backend service and docs delivered.",
        changedPaths: ["apps/api/server.ts", "README.md"],
        commands: ["npm test"],
        verificationEvidence: ["command:Server boots", "docs:README documents backend service"],
        assumptions: [],
        risks: [],
        followUps: [],
        runtimeHighlights: ["Ran tests", "Updated docs"],
        createdAt: "2026-04-20T00:10:30.000Z"
      }
    ],
    contracts: [],
    brain: [
      {
        id: "brain-topology",
        missionId: "mission-1",
        taskId: null,
        sourceType: "mission",
        category: "topology",
        scope: "repo",
        title: "API layout",
        content: "apps/api contains the backend service entrypoint.",
        tags: ["api", "topology"],
        confidence: 0.9,
        freshness: "live",
        evidence: ["apps/api/server.ts"],
        commands: ["npm test"],
        pinned: false,
        supersedes: [],
        supersededBy: null,
        contradictions: [],
        retiredAt: null,
        createdAt: "2026-04-20T00:10:00.000Z",
        updatedAt: "2026-04-20T00:10:00.000Z"
      },
      {
        id: "brain-topology-2",
        missionId: "mission-1",
        taskId: null,
        sourceType: "task",
        category: "topology",
        scope: "repo",
        title: "Docs entrypoint",
        content: "README captures operator usage.",
        tags: ["docs"],
        confidence: 0.8,
        freshness: "live",
        evidence: ["README.md"],
        commands: [],
        pinned: false,
        supersedes: [],
        supersededBy: null,
        contradictions: [],
        retiredAt: null,
        createdAt: "2026-04-20T00:10:00.000Z",
        updatedAt: "2026-04-20T00:10:00.000Z"
      },
      {
        id: "brain-topology-3",
        missionId: "mission-1",
        taskId: null,
        sourceType: "landing",
        category: "topology",
        scope: "repo",
        title: "Validation path",
        content: "npm test is the default validation route.",
        tags: ["validation"],
        confidence: 0.85,
        freshness: "live",
        evidence: ["package.json"],
        commands: ["npm test"],
        pinned: false,
        supersedes: [],
        supersededBy: null,
        contradictions: [],
        retiredAt: null,
        createdAt: "2026-04-20T00:10:00.000Z",
        updatedAt: "2026-04-20T00:10:00.000Z"
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

function baseArtifacts(): TaskArtifact[] {
  return [
    {
      taskId: "task-1",
      sessionId: "session-readiness",
      missionId: "mission-1",
      title: "Implement backend service",
      owner: "codex",
      kind: "execution",
      nodeKind: "backend",
      status: "completed",
      summary: "Backend service and docs delivered.",
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 1,
      lastFailureSummary: null,
      routeReason: "manual",
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: {},
      claimedPaths: ["apps/api/server.ts", "README.md"],
      decisionReplay: [],
      rawOutput: null,
      error: null,
      envelope: null,
      reviewNotes: [],
      progress: [],
      runtimeTrace: [
        {
          id: "trace-1",
          recordedAt: "2026-04-20T00:02:00.000Z",
          provider: "codex",
          source: "notification",
          eventName: "plan",
          semanticKind: "planning",
          summary: "Planning backend work",
          detail: "Planning backend work"
        },
        {
          id: "trace-2",
          recordedAt: "2026-04-20T00:05:00.000Z",
          provider: "codex",
          source: "notification",
          eventName: "edit",
          semanticKind: "editing",
          summary: "Edited backend service",
          detail: "Edited backend service"
        },
        {
          id: "trace-3",
          recordedAt: "2026-04-20T00:09:00.000Z",
          provider: "codex",
          source: "notification",
          eventName: "verify",
          semanticKind: "verification",
          summary: "Ran tests",
          detail: "Ran tests"
        }
      ],
      attempts: [],
      startedAt: "2026-04-20T00:00:00.000Z",
      finishedAt: "2026-04-20T00:10:00.000Z",
      nextRecommendation: null
    }
  ];
}

test("buildReadinessReport highlights bootstrap gaps for an unprepared repo", () => {
  const report = buildReadinessReport({
    repoRoot: "/tmp/repo",
    checks: [
      { name: "node", ok: false, detail: "missing" },
      { name: "codex", ok: false, detail: "missing" },
      { name: "claude", ok: false, detail: "missing" }
    ],
    config: defaultConfig(),
    guidanceFiles: [],
    hasDocsSurface: false,
    validation: {
      command: "",
      status: "not_configured",
      detail: "No validation command was configured."
    },
    session: null,
    artifacts: [],
    patternBenchmarks: [],
    patternConstellation: {
      totalPatterns: 0,
      totalTemplates: 0,
      topStacks: [],
      topNodeKinds: [],
      topCommands: [],
      topTags: [],
      topRepos: [],
      patternFamilies: [],
      repoProfiles: [],
      repoLinks: [],
      repoClusters: [],
      antiPatternHotspots: [],
      architecturePatterns: [],
      deliveryPatterns: [],
      antiPatterns: [],
      templateLinks: [],
      commandHabits: [],
      clusterInsights: [],
      startingPoints: [],
      templates: []
    }
  });

  assert.equal(report.level, "bootstrap");
  assert.equal(report.topActions.some((item) => /doctor|validation|accept/i.test(item.command ?? "")), true);
  assert.equal(report.areas.find((area) => area.id === "guidance")?.status, "warn");
});

test("buildReadinessReport recognizes a high-trust repo with mission evidence", () => {
  const config = defaultConfig();
  config.validationCommand = "npm test";
  const report = buildReadinessReport({
    repoRoot: "/tmp/repo",
    checks: passingDoctorChecks(),
    config,
    guidanceFiles: ["AGENTS.md", "CLAUDE.md"],
    hasDocsSurface: true,
    validation: {
      command: "npm test",
      status: "ran",
      detail: 'Validation ran with "npm test".'
    },
    session: baseSession(),
    artifacts: baseArtifacts(),
    patternBenchmarks: [
      {
        templateId: "template-1",
        label: "Node backend starter",
        kind: "architecture",
        score: 90,
        trustScore: 92,
        trustClass: "high_trust",
        stabilityTrend: "improving",
        successCount: 4,
        recentSuccessCount: 3,
        antiPatternCount: 0,
        recentAntiPatternCount: 0,
        deliveryCount: 4,
        repoCount: 2,
        averageConfidence: 0.9,
        recencyScore: 88,
        repairPressure: 10,
        acceptanceDepth: 5,
        commands: ["npm test"],
        acceptanceCriteria: ["Server boots"],
        antiPatternSignals: []
      },
      {
        templateId: "template-2",
        label: "Docs-first backend",
        kind: "delivery",
        score: 80,
        trustScore: 84,
        trustClass: "high_trust",
        stabilityTrend: "steady",
        successCount: 3,
        recentSuccessCount: 2,
        antiPatternCount: 0,
        recentAntiPatternCount: 0,
        deliveryCount: 3,
        repoCount: 2,
        averageConfidence: 0.84,
        recencyScore: 80,
        repairPressure: 12,
        acceptanceDepth: 4,
        commands: ["npm test"],
        acceptanceCriteria: ["README updated"],
        antiPatternSignals: []
      }
    ],
    patternConstellation: {
      totalPatterns: 4,
      totalTemplates: 2,
      topStacks: [{ value: "node", count: 4 }],
      topNodeKinds: [{ value: "backend", count: 4 }],
      topCommands: [{ value: "npm test", count: 4 }],
      topTags: [],
      topRepos: [{ value: "/tmp/repo", count: 4 }],
      patternFamilies: [],
      repoProfiles: [],
      repoLinks: [],
      repoClusters: [],
      antiPatternHotspots: [],
      architecturePatterns: [],
      deliveryPatterns: [],
      antiPatterns: [],
      templateLinks: [],
      commandHabits: [],
      clusterInsights: [],
      startingPoints: [],
      templates: []
    }
  });

  assert.equal(["guided", "autonomous", "compounding"].includes(report.level), true);
  assert.equal(report.areas.find((area) => area.id === "environment")?.status, "pass");
  assert.equal(report.score >= 70, true);
});
