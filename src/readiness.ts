import path from "node:path";
import { buildBrainReviewQueue } from "./brain.ts";
import { loadConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { fileExists } from "./fs.ts";
import { resolveValidationPlan } from "./git.ts";
import { buildMissionAttentionPacket } from "./mission-controller.ts";
import { buildMissionDriftReport, buildMissionPatchsets } from "./mission-evidence.ts";
import { latestMission } from "./missions.ts";
import { buildPatternBenchmarks, buildPatternConstellation } from "./patterns.ts";
import { nowIso } from "./paths.ts";
import { buildMissionAuditReport } from "./quality-court.ts";
import { loadSessionRecord, sessionExists } from "./session.ts";
import { listTaskArtifacts } from "./task-artifacts.ts";
import type {
  AppPaths,
  DoctorCheck,
  KaviConfig,
  ReadinessAreaId,
  ReadinessAreaReport,
  ReadinessFinding,
  ReadinessFindingStatus,
  ReadinessLevel,
  ReadinessReport,
  SessionRecord,
  TaskArtifact
} from "./types.ts";

interface BuildReadinessInputs {
  repoRoot: string;
  generatedAt?: string;
  checks: DoctorCheck[];
  config: KaviConfig;
  guidanceFiles: string[];
  hasDocsSurface: boolean;
  validation: Awaited<ReturnType<typeof resolveValidationPlan>>;
  session: SessionRecord | null;
  artifacts: TaskArtifact[];
  patternBenchmarks: Awaited<ReturnType<typeof buildPatternBenchmarks>>;
  patternConstellation: Awaited<ReturnType<typeof buildPatternConstellation>>;
}

const AREA_TITLES: Record<ReadinessAreaId, string> = {
  environment: "Environment",
  guidance: "Guidance",
  verification: "Verification",
  evidence: "Evidence",
  memory: "Memory",
  autonomy: "Autonomy"
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finding(
  area: ReadinessAreaId,
  seed: Omit<ReadinessFinding, "area">
): ReadinessFinding {
  return {
    area,
    ...seed,
    score: clamp(seed.score, 0, seed.maxScore)
  };
}

function aggregateArea(id: ReadinessAreaId, findings: ReadinessFinding[]): ReadinessAreaReport {
  const score = findings.reduce((total, item) => total + item.score, 0);
  const maxScore = findings.reduce((total, item) => total + item.maxScore, 0);
  const status: ReadinessFindingStatus = findings.some((item) => item.status === "fail")
    ? "fail"
    : findings.some((item) => item.status === "warn")
      ? "warn"
      : "pass";
  const summary =
    status === "pass"
      ? `${AREA_TITLES[id]} is ready for autonomous work.`
      : status === "warn"
        ? `${AREA_TITLES[id]} is usable but has leverage left on the table.`
        : `${AREA_TITLES[id]} has blockers that will reduce mission reliability.`;
  return {
    id,
    title: AREA_TITLES[id],
    score,
    maxScore,
    status,
    summary,
    findings
  };
}

function levelForScore(score: number): ReadinessLevel {
  if (score >= 88) {
    return "compounding";
  }
  if (score >= 75) {
    return "autonomous";
  }
  if (score >= 60) {
    return "guided";
  }
  if (score >= 40) {
    return "operational";
  }
  return "bootstrap";
}

function reportSummary(level: ReadinessLevel, score: number, missionId: string | null): string {
  const missionLine = missionId ? ` Latest mission: ${missionId}.` : " No mission evidence exists yet.";
  switch (level) {
    case "compounding":
      return `This repo is in compounding shape for Kavi: strong runtime, evidence, verification, and memory loops are already in place.${missionLine}`;
    case "autonomous":
      return `This repo is ready for sustained autonomous missions, but a few quality loops can still get tighter.${missionLine}`;
    case "guided":
      return `This repo can run guided missions reliably, but still needs stronger trust signals before fully compounding.${missionLine}`;
    case "operational":
      return `This repo is operational with Kavi, but the current setup will still require notable operator babysitting.${missionLine}`;
    case "bootstrap":
      return `This repo is not yet ready for high-trust autonomous work. Start with guidance, validation, and real mission evidence.${missionLine}`;
  }
}

function findCheck(checks: DoctorCheck[], name: string): DoctorCheck | null {
  return checks.find((check) => check.name === name) ?? null;
}

function collectGuidanceEvidence(guidanceFiles: string[]): string[] {
  return guidanceFiles.map((filePath) => path.basename(filePath));
}

async function findGuidanceFiles(repoRoot: string): Promise<string[]> {
  const candidates = [
    "AGENTS.md",
    "AGENT.md",
    "CLAUDE.md",
    ".cursorrules",
    ".cursor/rules",
    ".github/copilot-instructions.md"
  ];
  const existing: string[] = [];
  for (const relativePath of candidates) {
    if (await fileExists(path.join(repoRoot, relativePath))) {
      existing.push(relativePath);
    }
  }
  return existing;
}

async function hasDocsSurface(repoRoot: string): Promise<boolean> {
  const candidates = [
    "README.md",
    "README",
    "QUICKSTART.md",
    "docs",
    "docs/README.md"
  ];
  for (const relativePath of candidates) {
    if (await fileExists(path.join(repoRoot, relativePath))) {
      return true;
    }
  }
  return false;
}

export function buildReadinessReport(inputs: BuildReadinessInputs): ReadinessReport {
  const session = inputs.session;
  const latest = session ? latestMission(session) : null;
  const missionId = latest?.id ?? null;
  const artifacts = latest && session ? inputs.artifacts.filter((artifact) => artifact.missionId === latest.id) : [];
  const patchsets = session ? buildMissionPatchsets(session, inputs.artifacts, latest) : [];
  const drift = session ? buildMissionDriftReport(session, inputs.artifacts, latest) : null;
  const audit = latest && session ? buildMissionAuditReport(session, latest, inputs.artifacts) : null;
  const attention = latest && session
    ? buildMissionAttentionPacket(
        {
          session,
          events: [],
          approvals: [],
          worktreeDiffs: [],
          latestLandReport: null,
        },
        inputs.artifacts,
        latest
      )
    : null;
  const brainReview = session ? buildBrainReviewQueue(session, { missionId: missionId ?? null }) : [];
  const topologyCount = session?.brain.filter((entry) => entry.category === "topology").length ?? 0;
  const highTrustPatterns = inputs.patternBenchmarks.filter((entry) => entry.trustClass === "high_trust").length;
  const topPattern = inputs.patternBenchmarks[0] ?? null;

  const environmentFindings = [
    (() => {
      const nodeCheck = findCheck(inputs.checks, "node");
      const worktreeCheck = findCheck(inputs.checks, "git-worktree");
      const homeConfigCheck = findCheck(inputs.checks, "home-config");
      const passing = [nodeCheck, worktreeCheck, homeConfigCheck].filter((check) => check?.ok).length;
      const evidence = [nodeCheck, worktreeCheck, homeConfigCheck]
        .filter((check): check is DoctorCheck => Boolean(check))
        .map((check) => `${check.name}:${check.detail}`);
      return finding("environment", {
        id: "toolchain-core",
        title: "Core local runtime is wired",
        status: passing === 3 ? "pass" : passing >= 2 ? "warn" : "fail",
        score: passing === 3 ? 6 : passing >= 2 ? 4 : 1,
        maxScore: 6,
        detail: passing === 3
          ? "Node, git worktrees, and local config are ready."
          : "Kavi runtime prerequisites are incomplete or inconsistent.",
        evidence,
        suggestedAction: passing === 3 ? null : "kavi doctor"
      });
    })(),
    (() => {
      const checks = [
        findCheck(inputs.checks, "codex"),
        findCheck(inputs.checks, "codex-app-server"),
        findCheck(inputs.checks, "codex-auth-file"),
        findCheck(inputs.checks, "codex-app-server-canary")
      ];
      const passing = checks.filter((check) => check?.ok).length;
      return finding("environment", {
        id: "codex-transport",
        title: "Codex managed transport is ready",
        status: passing === 4 ? "pass" : passing >= 2 ? "warn" : "fail",
        score: passing === 4 ? 7 : passing >= 2 ? 4 : 1,
        maxScore: 7,
        detail: passing === 4
          ? "Codex CLI, app-server, auth, and canary handshake all passed."
          : "Codex transport is partially or fully degraded.",
        evidence: checks
          .filter((check): check is DoctorCheck => Boolean(check))
          .map((check) => `${check.name}:${check.detail}`),
        suggestedAction: passing === 4 ? null : "kavi doctor"
      });
    })(),
    (() => {
      const checks = [
        findCheck(inputs.checks, "claude"),
        findCheck(inputs.checks, "claude-auth"),
        findCheck(inputs.checks, "claude-print-contract")
      ];
      const passing = checks.filter((check) => check?.ok).length;
      return finding("environment", {
        id: "claude-transport",
        title: "Claude managed transport is ready",
        status: passing === 3 ? "pass" : passing >= 2 ? "warn" : "fail",
        score: passing === 3 ? 7 : passing >= 2 ? 4 : 1,
        maxScore: 7,
        detail: passing === 3
          ? "Claude CLI, auth, and print/json contract are usable."
          : "Claude transport is partially or fully degraded.",
        evidence: checks
          .filter((check): check is DoctorCheck => Boolean(check))
          .map((check) => `${check.name}:${check.detail}`),
        suggestedAction: passing === 3 ? null : "kavi doctor"
      });
    })()
  ];

  const guidanceFindings = [
    finding("guidance", {
      id: "guidance-files",
      title: "Repo guidance files exist",
      status: inputs.guidanceFiles.length > 0 ? "pass" : "warn",
      score: inputs.guidanceFiles.length > 0 ? 6 : 2,
      maxScore: 6,
      detail: inputs.guidanceFiles.length > 0
        ? "Kavi and other agents have repo-local guidance to inherit."
        : "No AGENTS/CLAUDE/copilot-style repo guidance file was found at the repo root.",
      evidence: collectGuidanceEvidence(inputs.guidanceFiles),
      suggestedAction: inputs.guidanceFiles.length > 0 ? null : "Create AGENTS.md at the repo root."
    }),
    finding("guidance", {
      id: "docs-surface",
      title: "Operator-facing docs surface exists",
      status: inputs.hasDocsSurface ? "pass" : "warn",
      score: inputs.hasDocsSurface ? 4 : 1,
      maxScore: 4,
      detail: inputs.hasDocsSurface
        ? "README/QUICKSTART/docs content exists for operator recovery and review."
        : "The repo lacks a visible README/QUICKSTART/docs surface.",
      evidence: inputs.hasDocsSurface ? ["README/docs detected"] : [],
      suggestedAction: inputs.hasDocsSurface ? null : "Add README.md or QUICKSTART.md with build/test/run guidance."
    }),
    finding("guidance", {
      id: "validation-config",
      title: "Validation command is configured",
      status:
        inputs.validation.status === "ran"
          ? "pass"
          : inputs.validation.status === "skipped"
            ? "warn"
            : "warn",
      score: inputs.validation.status === "ran" ? 5 : inputs.validation.status === "skipped" ? 3 : 1,
      maxScore: 5,
      detail: inputs.validation.detail,
      evidence: inputs.config.validationCommand ? [inputs.config.validationCommand] : [],
      suggestedAction:
        inputs.validation.status === "ran" ? null : "Set validation_command in .kavi/config.toml."
    })
  ];

  const verificationFindings = [
    finding("verification", {
      id: "mission-acceptance",
      title: "Latest mission acceptance is closed",
      status:
        !latest
          ? "warn"
          : latest.acceptance.status === "passed"
            ? "pass"
            : latest.acceptance.status === "pending"
              ? "warn"
              : "fail",
      score:
        !latest
          ? 2
          : latest.acceptance.status === "passed"
            ? 8
            : latest.acceptance.status === "pending"
              ? 4
              : 0,
      maxScore: 8,
      detail:
        !latest
          ? "No mission acceptance evidence exists yet."
          : `Latest mission acceptance is ${latest.acceptance.status}.`,
      evidence:
        latest
          ? latest.acceptance.checks.slice(0, 6).map((check) => `${check.kind}:${check.status}:${check.title}`)
          : [],
      suggestedAction:
        !latest || latest.acceptance.status !== "passed"
          ? "kavi verify latest --explain"
          : null
    }),
    finding("verification", {
      id: "quality-court",
      title: "Quality Court is clear enough to ship",
      status:
        !audit
          ? "warn"
          : audit.verdict === "approved"
            ? "pass"
            : audit.verdict === "warn"
              ? "warn"
              : "fail",
      score:
        !audit
          ? 2
          : audit.verdict === "approved"
            ? 6
            : audit.verdict === "warn"
              ? 3
              : 0,
      maxScore: 6,
      detail:
        !audit
          ? "No mission audit has been produced yet."
          : `${audit.verdict} with ${audit.objections.length} objection(s).`,
      evidence: audit?.objections.slice(0, 6).map((item) => `${item.role}:${item.title}`) ?? [],
      suggestedAction:
        !audit || audit.verdict !== "approved"
          ? "kavi audit latest --json"
          : null
    }),
    finding("verification", {
      id: "acceptance-depth",
      title: "Acceptance depth is practical, not just symbolic",
      status:
        !latest
          ? "warn"
          : latest.acceptance.checks.length >= 4
            ? "pass"
            : latest.acceptance.checks.length >= 2
              ? "warn"
              : "fail",
      score:
        !latest
          ? 2
          : latest.acceptance.checks.length >= 4
            ? 6
            : latest.acceptance.checks.length >= 2
              ? 3
              : 1,
      maxScore: 6,
      detail:
        !latest
          ? "No acceptance pack exists yet."
          : `${latest.acceptance.checks.length} acceptance check(s) are present on the latest mission.`,
      evidence: latest?.acceptance.checks.slice(0, 8).map((check) => `${check.kind}:${check.title}`) ?? [],
      suggestedAction:
        !latest || latest.acceptance.checks.length < 4
          ? "Run a real mission and inspect `kavi accept latest`."
          : null
    })
  ];

  const evidenceFindings = [
    finding("evidence", {
      id: "patchsets",
      title: "Mission patchsets and receipts exist",
      status:
        patchsets.length >= 2
          ? "pass"
          : patchsets.length === 1
            ? "warn"
            : "warn",
      score: patchsets.length >= 2 ? 6 : patchsets.length === 1 ? 4 : 1,
      maxScore: 6,
      detail:
        patchsets.length > 0
          ? `${patchsets.length} patchset(s) are available for the latest mission.`
          : "No patchsets exist yet; Kavi does not have proof-of-work slices to inspect.",
      evidence: patchsets.slice(0, 6).map((patchset) => `${patchset.owner}:${patchset.title}`),
      suggestedAction:
        patchsets.length > 0 ? null : "Finish at least one mission and inspect `kavi mission patchsets latest`."
    }),
    finding("evidence", {
      id: "drift",
      title: "Spec drift is measurable",
      status:
        !drift
          ? "warn"
          : drift.summary.missingCount === 0 && drift.summary.partialCount <= 1
            ? "pass"
            : drift.summary.missingCount <= 2
              ? "warn"
              : "fail",
      score:
        !drift
          ? 2
          : drift.summary.missingCount === 0 && drift.summary.partialCount <= 1
            ? 5
            : drift.summary.missingCount <= 2
              ? 3
              : 0,
      maxScore: 5,
      detail:
        !drift
          ? "No drift report exists yet."
          : `${drift.summary.coveredCount} covered, ${drift.summary.partialCount} partial, ${drift.summary.missingCount} missing.`,
      evidence: drift?.items.filter((item) => item.status !== "covered").slice(0, 6).map((item) => `${item.category}:${item.title}`) ?? [],
      suggestedAction:
        !drift || drift.summary.missingCount > 0
          ? "kavi mission drift latest --json"
          : null
    }),
    finding("evidence", {
      id: "runtime-trace",
      title: "Runtime traces are durable enough to explain work",
      status:
        artifacts.some((artifact) => artifact.runtimeTrace.length >= 3)
          ? "pass"
          : artifacts.some((artifact) => artifact.runtimeTrace.length > 0)
            ? "warn"
            : "warn",
      score:
        artifacts.some((artifact) => artifact.runtimeTrace.length >= 3)
          ? 4
          : artifacts.some((artifact) => artifact.runtimeTrace.length > 0)
            ? 2
            : 1,
      maxScore: 4,
      detail:
        artifacts.length === 0
          ? "No mission task artifacts exist yet."
          : `${artifacts.reduce((total, artifact) => total + artifact.runtimeTrace.length, 0)} runtime trace event(s) are persisted for the latest mission.`,
      evidence: artifacts
        .flatMap((artifact) => artifact.runtimeTrace.slice(-2).map((trace) => `${artifact.owner}:${trace.summary}`))
        .slice(0, 6),
      suggestedAction:
        artifacts.some((artifact) => artifact.runtimeTrace.length > 0)
          ? null
          : "Run `kavi task` and inspect `kavi task-output latest --json`."
    })
  ];

  const memoryFindings = [
    finding("memory", {
      id: "brain-topology",
      title: "Brain contains structural repo memory",
      status:
        topologyCount >= 3
          ? "pass"
          : topologyCount >= 1
            ? "warn"
            : "warn",
      score: topologyCount >= 3 ? 7 : topologyCount >= 1 ? 4 : 1,
      maxScore: 7,
      detail:
        topologyCount > 0
          ? `${topologyCount} topology entry/entries are available in Brain.`
          : "No topology-backed Brain entries were found yet.",
      evidence: (session?.brain ?? [])
        .filter((entry) => entry.category === "topology")
        .slice(0, 6)
        .map((entry) => entry.title),
      suggestedAction:
        topologyCount > 0 ? null : "Run a real mission so Kavi can capture topology and procedures."
    }),
    finding("memory", {
      id: "pattern-trust",
      title: "Portfolio memory has trustworthy reusable patterns",
      status:
        highTrustPatterns >= 2
          ? "pass"
          : inputs.patternBenchmarks.length > 0
            ? "warn"
            : "warn",
      score:
        highTrustPatterns >= 2
          ? 8
          : inputs.patternBenchmarks.length > 0
            ? 4
            : 1,
      maxScore: 8,
      detail:
        topPattern
          ? `Top pattern is ${topPattern.trustClass} with trust score ${topPattern.trustScore}; ${inputs.patternConstellation.totalPatterns} total pattern(s) are available locally.`
          : "No reusable pattern benchmark exists yet.",
      evidence: topPattern
        ? [`${topPattern.label}:${topPattern.trustClass}:${topPattern.trustScore}`]
        : [],
      suggestedAction:
        topPattern ? null : "Land a few real missions so Pattern Studio can learn reliable starters."
    })
  ];

  const autonomyFindings = [
    finding("autonomy", {
      id: "attention-pressure",
      title: "Operator attention is bounded",
      status:
        !attention
          ? "warn"
          : attention.criticalCount === 0 && attention.items.length <= 3
            ? "pass"
            : attention.criticalCount <= 1
              ? "warn"
              : "fail",
      score:
        !attention
          ? 2
          : attention.criticalCount === 0 && attention.items.length <= 3
            ? 7
            : attention.criticalCount <= 1
              ? 4
              : 0,
      maxScore: 7,
      detail:
        !attention
          ? "No mission attention packet exists yet."
          : `${attention.items.length} attention item(s); ${attention.criticalCount} critical.`,
      evidence: attention?.items.slice(0, 6).map((item) => `${item.kind}:${item.title}`) ?? [],
      suggestedAction:
        !attention || attention.items.length > 0 ? "kavi mission attention latest" : null
    }),
    finding("autonomy", {
      id: "contracts-and-overlap",
      title: "Cross-agent coordination pressure is manageable",
      status:
        !latest || !audit
          ? "warn"
          : audit.objections.some((item) => item.kind === "contract" || item.kind === "overlap")
            ? "fail"
            : "pass",
      score:
        !latest || !audit
          ? 2
          : audit.objections.some((item) => item.kind === "contract" || item.kind === "overlap")
            ? 0
            : 4,
      maxScore: 4,
      detail:
        !latest || !audit
          ? "No mission coordination evidence exists yet."
          : "No blocking contract or overlap objections are open on the latest mission.",
      evidence: audit?.objections
        .filter((item) => item.kind === "contract" || item.kind === "overlap")
        .slice(0, 6)
        .map((item) => item.title) ?? [],
      suggestedAction:
        !latest || (audit?.objections.some((item) => item.kind === "contract" || item.kind === "overlap") ?? false)
          ? "kavi contracts latest && kavi audit latest --role integration_auditor --json"
          : null
    }),
    finding("autonomy", {
      id: "brain-and-pattern-noise",
      title: "Memory noise is not overwhelming the system",
      status:
        brainReview.length === 0
          ? "pass"
          : brainReview.filter((item) => item.severity === "high").length <= 1
            ? "warn"
            : "fail",
      score:
        brainReview.length === 0
          ? 4
          : brainReview.filter((item) => item.severity === "high").length <= 1
            ? 2
            : 0,
      maxScore: 4,
      detail:
        brainReview.length === 0
          ? "Brain review queue is quiet."
          : `${brainReview.length} Brain review item(s) are active.`,
      evidence: brainReview.slice(0, 5).map((item) => `${item.severity}:${item.title}`),
      suggestedAction:
        brainReview.length > 0 ? "kavi brain review" : null
    })
  ];

  const areas = [
    aggregateArea("environment", environmentFindings),
    aggregateArea("guidance", guidanceFindings),
    aggregateArea("verification", verificationFindings),
    aggregateArea("evidence", evidenceFindings),
    aggregateArea("memory", memoryFindings),
    aggregateArea("autonomy", autonomyFindings)
  ];

  const score = areas.reduce((total, area) => total + area.score, 0);
  const maxScore = areas.reduce((total, area) => total + area.maxScore, 0);
  const level = levelForScore(score);
  const topActions = areas
    .flatMap((area) => area.findings)
    .filter((item) => item.status !== "pass" && item.suggestedAction)
    .sort((left, right) => {
      const weight = { fail: 3, warn: 2, pass: 1 };
      return weight[right.status] - weight[left.status] || right.maxScore - left.maxScore || left.title.localeCompare(right.title);
    })
    .slice(0, 6)
    .map((item) => ({
      title: item.title,
      detail: item.detail,
      command: item.suggestedAction
    }));

  return {
    repoRoot: inputs.repoRoot,
    generatedAt: inputs.generatedAt ?? nowIso(),
    level,
    score,
    maxScore,
    summary: reportSummary(level, score, missionId),
    latestMissionId: missionId,
    areas,
    topActions
  };
}

export async function buildRepoReadinessReport(repoRoot: string, paths: AppPaths): Promise<ReadinessReport> {
  const [checks, config, guidanceFiles, docsSurface, hasSession, patternBenchmarks, patternConstellation] =
    await Promise.all([
      runDoctor(repoRoot, paths),
      loadConfig(paths),
      findGuidanceFiles(repoRoot),
      hasDocsSurface(repoRoot),
      sessionExists(paths),
      buildPatternBenchmarks(paths),
      buildPatternConstellation(paths)
    ]);

  const validation = await resolveValidationPlan(repoRoot, config.validationCommand);
  const session = hasSession ? await loadSessionRecord(paths) : null;
  const artifacts = hasSession ? await listTaskArtifacts(paths) : [];

  return buildReadinessReport({
    repoRoot,
    checks,
    config,
    guidanceFiles,
    hasDocsSurface: docsSurface,
    validation,
    session,
    artifacts,
    patternBenchmarks,
    patternConstellation
  });
}
