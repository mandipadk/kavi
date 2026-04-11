import { randomUUID } from "node:crypto";
import { nowIso } from "./paths.ts";
import type {
  Mission,
  MissionAnchor,
  MissionBlueprint,
  MissionContract,
  MissionHealth,
  MissionPolicy,
  MissionRisk,
  MissionSpec,
  SessionRecord
} from "./types.ts";

function normalizePrompt(value: string): string {
  return value.replaceAll("\r", "").replaceAll(/\s+/g, " ").trim();
}

function promptHas(lower: string, pattern: RegExp): boolean {
  return pattern.test(lower);
}

function phrasePattern(source: string): RegExp {
  return new RegExp(`\\b(?:${source})\\b`);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractSignals(lower: string, patterns: Array<[string, RegExp]>): string[] {
  return patterns.filter(([, pattern]) => promptHas(lower, pattern)).map(([label]) => label);
}

function extractUserRoles(lower: string): string[] {
  return extractSignals(lower, [
    ["admin", /\badmin|administrator\b/],
    ["operator", /\boperator|ops|reviewer\b/],
    ["developer", /\bdeveloper|engineer\b/],
    ["patient", /\bpatient\b/],
    ["clinician", /\bclinician|doctor|physician|nurse|provider\b/],
    ["manager", /\bmanager|lead|supervisor\b/],
    ["customer", /\bcustomer|client|buyer|seller|merchant\b/]
  ]);
}

function extractDomainEntities(lower: string): string[] {
  return extractSignals(lower, [
    ["patient", /\bpatient|chart|encounter\b/],
    ["issue", /\bissue|ticket|thread|triage\b/],
    ["queue", /\bqueue|intake|handoff|shift\b/],
    ["order", /\border|prescription|medication\b/],
    ["user", /\buser|account|profile\b/],
    ["agent", /\bagent|assistant|copilot\b/],
    ["payment", /\bpayment|invoice|billing\b/],
    ["audit", /\baudit|history|timeline\b/]
  ]);
}

function buildMissionSpec(prompt: string): MissionSpec {
  const normalized = normalizePrompt(prompt);
  const lower = normalized.toLowerCase();
  const workstreamKinds = unique([
    ...extractSignals(lower, [
      ["scaffold", phrasePattern("scaffold|setup|bootstrap|initialize|starter|greenfield|from scratch")],
      ["backend", phrasePattern("api|backend|server|database|schema|worker|queue|auth")],
      ["frontend", phrasePattern("frontend|front-end|ui|ux|screen|page|component|layout|web")],
      ["shared_contract", phrasePattern("shared|contract|schema|types|domain")],
      ["tests", phrasePattern("test|tests|testing|qa|verify|validation")],
      ["docs", phrasePattern("docs|documentation|readme|spec|guide")],
      ["review", phrasePattern("review|refine|polish")],
      ["infra", phrasePattern("deploy|deployment|infra|worker|queue|cron|pipeline")]
    ])
  ]);
  const stackHints = unique([
    ...extractSignals(lower, [
      ["react", phrasePattern("react|next\\.?js|nextjs")],
      ["typescript", /\b(?:typescript|\.ts|\.tsx)\b/],
      ["node", phrasePattern("node|express|fastify|nest")],
      ["go", phrasePattern("go|golang")],
      ["python", phrasePattern("python|fastapi|flask|django")],
      ["rust", phrasePattern("rust|cargo")],
      ["workers", phrasePattern("worker|cloudflare")],
      ["postgres", phrasePattern("postgres|postgresql")],
      ["sqlite", phrasePattern("sqlite")]
    ])
  ]);
  const requestedDeliverables = unique([
    ...extractSignals(lower, [
      ["web_ui", phrasePattern("web ui|frontend|page|screen|dashboard|layout")],
      ["api", phrasePattern("api|backend|server|endpoint")],
      ["shared_types", phrasePattern("shared|types|contracts|schema|domain")],
      ["tests", phrasePattern("tests|testing|qa|verify|validation")],
      ["docs", phrasePattern("docs|documentation|readme|spec")]
    ])
  ]);

  const constraints: string[] = [];
  if (promptHas(lower, phrasePattern("small|minimal|tiny|lightweight"))) {
    constraints.push("Keep the implementation intentionally small and lean.");
  }
  if (promptHas(lower, /\b(?:production[- ]?shaped|production)\b/)) {
    constraints.push("Preserve a production-shaped structure even if the first slice stays small.");
  }
  if (promptHas(lower, phrasePattern("from scratch|greenfield"))) {
    constraints.push("Assume the repo may be greenfield and needs initial scaffolding.");
  }

  return {
    normalizedPrompt: normalized,
    audience:
      extractSignals(lower, [
        ["developers", phrasePattern("developer|engineer")],
        ["operators", phrasePattern("operator|ops|reviewer")],
        ["clinicians", phrasePattern("clinician|doctor|nurse|provider")],
        ["end_users", phrasePattern("user|customer|patient|buyer|seller")]
      ])[0] ?? null,
    repoShape: promptHas(lower, phrasePattern("from scratch|greenfield|scaffold|bootstrap"))
      ? "greenfield"
      : promptHas(lower, phrasePattern("refactor|extend|existing|current repo"))
        ? "existing"
        : "unknown",
    workstreamKinds,
    stackHints,
    requestedDeliverables,
    userRoles: extractUserRoles(lower),
    domainEntities: extractDomainEntities(lower),
    constraints
  };
}

function buildMissionContract(prompt: string, spec: MissionSpec): MissionContract {
  const lower = spec.normalizedPrompt.toLowerCase();
  const scenarios = unique([
    spec.requestedDeliverables.includes("web_ui")
      ? "A user can understand and use the primary UI flow without confusion."
      : "",
    spec.requestedDeliverables.includes("api")
      ? "The primary backend path responds coherently for the intended slice."
      : "",
    spec.requestedDeliverables.includes("docs")
      ? "The repo explains how to run or understand the delivered slice."
      : "",
    spec.requestedDeliverables.includes("tests")
      ? "At least one practical validation path exists for the delivered slice."
      : ""
  ]);
  const qualityBars = unique([
    spec.workstreamKinds.includes("shared_contract")
      ? "Shared contracts should be explicit and understandable."
      : "",
    promptHas(lower, /\b(?:production[- ]?shaped|production)\b/)
      ? "Folder structure and interfaces should stay production-shaped."
      : "",
    promptHas(lower, phrasePattern("polish|refine|beautiful|modern"))
      ? "User-facing surfaces should feel deliberate and polished."
      : ""
  ]);
  const docsExpectations = unique([
    spec.requestedDeliverables.includes("docs")
      ? "Document how to run, verify, or inspect the delivered slice."
      : "",
    spec.repoShape === "greenfield"
      ? "Explain the new repo shape and primary entrypoints."
      : ""
  ]);

  return {
    acceptanceCriteria: unique([
      "The requested slice is implemented in a coherent, runnable state.",
      spec.requestedDeliverables.includes("web_ui")
        ? "User-facing behavior is understandable and coherent for the requested flow."
        : "",
      spec.requestedDeliverables.includes("api")
        ? "Backend and contract behavior match the requested implementation scope."
        : "",
      spec.requestedDeliverables.includes("tests")
        ? "At least one practical verification path exists."
        : "",
      spec.requestedDeliverables.includes("docs")
        ? "The repo explains how to run or understand the delivered slice."
        : ""
    ]),
    scenarios,
    qualityBars,
    docsExpectations
  };
}

function buildMissionBlueprint(
  spec: MissionSpec,
  contract: MissionContract,
  risks: MissionRisk[]
): MissionBlueprint {
  const workstreamSummary = spec.workstreamKinds.length > 0
    ? spec.workstreamKinds.join(", ")
    : "a focused implementation slice";
  const productConcept = [
    spec.audience ? `for ${spec.audience}` : "",
    spec.repoShape === "greenfield" ? "starting from zero-context scaffolding" : ""
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  const serviceBoundaries = unique([
    spec.workstreamKinds.includes("frontend") ? "user-facing web or app shell" : "",
    spec.workstreamKinds.includes("backend") ? "backend API and service logic" : "",
    spec.workstreamKinds.includes("shared_contract") ? "shared contracts and domain model" : "",
    spec.workstreamKinds.includes("infra") ? "deployment or worker infrastructure" : "",
    spec.workstreamKinds.includes("docs") ? "operator-facing docs and run guidance" : ""
  ]);

  const uiSurfaces = unique([
    spec.requestedDeliverables.includes("web_ui") ? "primary UI shell" : "",
    spec.workstreamKinds.includes("frontend") ? "interactive frontend flows" : "",
    spec.workstreamKinds.includes("review") ? "polished result and review surfaces" : ""
  ]);

  return {
    overview: `Mission packet targets ${workstreamSummary}.`,
    productConcept: productConcept || `Deliver ${workstreamSummary}.`,
    personas: spec.userRoles,
    domainModel: spec.domainEntities,
    serviceBoundaries,
    uiSurfaces,
    acceptanceJourneys: contract.scenarios,
    architectureNotes: unique([
      ...spec.constraints,
      ...risks.map((risk) => `${risk.severity}: ${risk.title} -> ${risk.mitigation}`)
    ])
  };
}

function buildMissionPolicy(session: SessionRecord, spec: MissionSpec): MissionPolicy {
  const gatePolicy = unique([
    "acceptance",
    spec.workstreamKinds.includes("review") || spec.workstreamKinds.includes("docs") ? "operator_review" : "",
    spec.workstreamKinds.includes("frontend") && spec.workstreamKinds.includes("backend") ? "integration" : "",
    spec.workstreamKinds.includes("infra") ? "risk" : ""
  ]);
  const autonomyLevel =
    spec.repoShape !== "greenfield" && spec.workstreamKinds.length <= 1
      ? "autonomous"
      : "guided";
  const autoVerify = autonomyLevel === "autonomous" || autonomyLevel === "overnight";
  const autoLand =
    autonomyLevel === "overnight" &&
    !gatePolicy.includes("operator_review") &&
    !gatePolicy.includes("integration") &&
    !gatePolicy.includes("risk");
  const operatorAttentionBudget =
    spec.repoShape === "greenfield"
      ? 8
      : spec.workstreamKinds.length >= 3
        ? 7
        : spec.workstreamKinds.length <= 1
          ? 4
          : 6;
  const escalationPolicy =
    gatePolicy.includes("risk") || spec.workstreamKinds.includes("infra")
      ? "strict"
      : spec.repoShape === "greenfield" || spec.workstreamKinds.length >= 3
        ? "balanced"
        : "aggressive";
  return {
    autonomyLevel,
    approvalMode: session.fullAccessMode ? "approve_all" : "standard",
    retryBudget: spec.workstreamKinds.includes("infra") || spec.workstreamKinds.includes("backend") ? 2 : 1,
    operatorAttentionBudget,
    escalationPolicy,
    verificationMode: spec.workstreamKinds.includes("tests") || spec.requestedDeliverables.includes("api")
      ? "strict"
      : "standard",
    landPolicy: "acceptance_gated",
    gatePolicy,
    autoAdvance: true,
    autoVerify,
    autoLand,
    pauseOnRepairFailure: true
  };
}

function buildMissionRisks(spec: MissionSpec): MissionRisk[] {
  const risks: MissionRisk[] = [];
  const pushRisk = (
    title: string,
    detail: string,
    severity: MissionRisk["severity"],
    mitigation: string
  ) => {
    risks.push({
      id: `risk-${randomUUID()}`,
      title,
      detail,
      severity,
      mitigation
    });
  };

  if (spec.repoShape === "greenfield") {
    pushRisk(
      "Greenfield ambiguity",
      "New projects tend to hide structural choices that are expensive to unwind later.",
      "medium",
      "Bias toward explicit contracts, entrypoints, and README guidance early."
    );
  }
  if (spec.workstreamKinds.includes("frontend") && spec.workstreamKinds.includes("backend")) {
    pushRisk(
      "Full-stack coordination",
      "UI and backend slices can drift without explicit shared contracts.",
      "high",
      "Keep shared domain types or API contracts explicit before parallel refinement."
    );
  }
  if (!spec.workstreamKinds.includes("tests")) {
    pushRisk(
      "Thin verification",
      "The prompt did not ask for tests directly, so silent regressions are more likely.",
      "medium",
      "Synthesize acceptance checks and at least one runnable validation path."
    );
  }
  return risks;
}

function buildMissionAnchors(spec: MissionSpec, contract: MissionContract): MissionAnchor[] {
  const timestamp = nowIso();
  return [
    {
      id: `anchor-${randomUUID()}`,
      kind: "intent",
      title: "Intent anchor",
      summary: `Deliver ${spec.requestedDeliverables.join(", ") || "the requested slice"} for ${spec.audience ?? "the intended users"}.`,
      createdAt: timestamp
    },
    {
      id: `anchor-${randomUUID()}`,
      kind: "architecture",
      title: "Architecture anchor",
      summary: `Workstreams: ${spec.workstreamKinds.join(", ") || "execution"} | stack hints: ${spec.stackHints.join(", ") || "-"}.`,
      createdAt: timestamp
    },
    {
      id: `anchor-${randomUUID()}`,
      kind: "acceptance",
      title: "Acceptance anchor",
      summary: contract.acceptanceCriteria.slice(0, 2).join(" | "),
      createdAt: timestamp
    }
  ];
}

export function compileMissionPrompt(
  session: SessionRecord,
  prompt: string
): {
  spec: MissionSpec;
  contract: MissionContract;
  blueprint: MissionBlueprint;
  policy: MissionPolicy;
  risks: MissionRisk[];
  anchors: MissionAnchor[];
} {
  const spec = buildMissionSpec(prompt);
  const contract = buildMissionContract(prompt, spec);
  const risks = buildMissionRisks(spec);
  const blueprint = buildMissionBlueprint(spec, contract, risks);
  const policy = buildMissionPolicy(session, spec);
  const anchors = buildMissionAnchors(spec, contract);
  return {
    spec,
    contract,
    blueprint,
    policy,
    risks,
    anchors
  };
}

export function computeMissionHealth(session: SessionRecord, mission: Mission): MissionHealth {
  const tasks = session.tasks.filter((task) => task.missionId === mission.id);
  const reasons: string[] = [];
  let score = 100;

  const failed = tasks.filter((task) => task.status === "failed").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const hasExecutionProgress =
    tasks.some((task) => task.kind !== "planner" && task.status !== "pending") ||
    tasks.some((task) => task.kind === "planner" && task.status === "completed") ||
    Boolean(mission.planId);
  const activeRepairs = tasks.filter(
    (task) =>
      task.nodeKind === "repair" &&
      task.status !== "completed"
  ).length;
  const retriesUsed = tasks.reduce((total, task) => total + task.retryCount, 0);
  const stalled = mission.checkpoints.filter((item) => item.kind === "task_stalled").length;

  if (failed > 0) {
    score -= 50;
    reasons.push(`${failed} mission task(s) failed.`);
  }
  if (blocked > 0) {
    score -= 25;
    reasons.push(`${blocked} mission task(s) are blocked.`);
  }
  if (stalled > 0) {
    score -= 15;
    reasons.push(`${stalled} task checkpoint(s) reported stalls.`);
  }
  if (activeRepairs > 0) {
    score -= 10;
    reasons.push(`${activeRepairs} repair task(s) are active from failed acceptance.`);
  }
  if (retriesUsed > 0) {
    score -= Math.min(12, retriesUsed * 4);
    reasons.push(`${retriesUsed} retry attempt(s) have been used on this mission.`);
  }
  if (mission.acceptance.status === "pending" && running === 0 && hasExecutionProgress) {
    score -= 10;
    reasons.push("Acceptance has not been cleared yet.");
  }
  if ((mission.risks ?? []).some((risk) => risk.severity === "high")) {
    score -= 10;
    reasons.push("Mission carries at least one high-severity execution risk.");
  }

  const state =
    failed > 0 || mission.status === "blocked"
      ? "blocked"
      : score < 75
        ? "watch"
        : "healthy";

  return {
    score: Math.max(0, Math.min(100, score)),
    state,
    reasons,
    updatedAt: nowIso()
  };
}
