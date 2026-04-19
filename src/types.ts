export type AgentName = "codex" | "claude";
export type DecisionKind = "route" | "approval" | "task" | "integration" | "review" | "plan";
export type RouteStrategy = "manual" | "keyword" | "ai" | "path-claim" | "fallback";
export type TaskKind = "kickoff" | "planner" | "execution" | "integration";
export type ComposerPlanningMode = "auto" | "plan" | "direct";
export type PlanExecutionMode = "blocking" | "parallel" | "follow_up";
export type ExecutionPlanStatus = "draft" | "active" | "completed" | "blocked";
export type MissionMode = "guided_autopilot" | "inspect" | "manual";
export type MissionAutonomyLevel = "inspect" | "guided" | "autonomous" | "overnight";
export type MissionVerificationMode = "standard" | "strict";
export type MissionLandPolicy = "manual_review" | "acceptance_gated";
export type MissionHealthState = "healthy" | "watch" | "blocked";
export type MissionPhase =
  | "specifying"
  | "simulating"
  | "executing"
  | "repairing"
  | "verifying"
  | "landing"
  | "postmortem";
export type MissionStatus =
  | "planning"
  | "active"
  | "blocked"
  | "awaiting_acceptance"
  | "ready_to_land"
  | "landed"
  | "completed";
export type AcceptanceCheckKind =
  | "command"
  | "manual"
  | "file"
  | "scenario"
  | "contract"
  | "docs"
  | "http"
  | "browser";
export type AcceptanceCheckStatus = "pending" | "passed" | "failed" | "skipped";
export type AcceptancePackStatus = "pending" | "passed" | "failed";
export type BrainEntryCategory =
  | "fact"
  | "decision"
  | "procedure"
  | "risk"
  | "artifact"
  | "topology"
  | "contract"
  | "failure"
  | "verification";
export type BrainEntryScope = "repo" | "mission" | "personal" | "pattern";
export type BrainEntryFreshness = "live" | "recent" | "stale";
export type PatternKind = "micro" | "architecture" | "delivery" | "anti_pattern";
export type AgentContractKind =
  | "request_contract"
  | "request_stub"
  | "request_refinement"
  | "request_review"
  | "request_verification"
  | "request_risk_check"
  | "handoff_complete";
export type AgentContractStatus = "open" | "resolved" | "dismissed";
export type MissionNodeKind =
  | "research"
  | "scaffold"
  | "backend"
  | "frontend"
  | "shared_contract"
  | "infra"
  | "tests"
  | "docs"
  | "review"
  | "repair"
  | "integration";

export type ApprovalDecision = "allow_once" | "deny_once";
export type ApprovalRuleDecision = "allow" | "deny";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ReviewDisposition =
  | "approve"
  | "concern"
  | "question"
  | "note"
  | "accepted_risk"
  | "wont_fix";
export type ReviewStatus = "open" | "resolved";
export type ReviewAssignee = AgentName | "operator";
export type RecommendationKind = "handoff" | "integration" | "ownership-config" | "follow_up";
export type RecommendationStatus = "active" | "dismissed";
export type WorkflowStageId =
  | "bootstrapping"
  | "waiting_for_approval"
  | "blocked"
  | "working"
  | "repairing"
  | "integration"
  | "review_follow_ups"
  | "awaiting_acceptance"
  | "ready_to_land"
  | "landed"
  | "idle";

export type PeerMessageIntent =
  | "question"
  | "handoff"
  | "review_request"
  | "blocked"
  | "context_share";

export interface RoutingKeywords {
  frontendKeywords: string[];
  backendKeywords: string[];
  codexPaths: string[];
  claudePaths: string[];
}

export interface AgentConfig {
  role: string;
  model: string;
}

export interface HomeRuntimeConfig {
  nodeBin: string;
  codexBin: string;
  claudeBin: string;
}

export interface HomeConfig {
  version: number;
  runtime: HomeRuntimeConfig;
}

export interface KaviConfig {
  version: number;
  baseBranch: string;
  validationCommand: string;
  messageLimit: number;
  routing: RoutingKeywords;
  agents: Record<AgentName, AgentConfig>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WorktreeInfo {
  agent: AgentName;
  path: string;
  branch: string;
}

export interface AgentStatus {
  agent: AgentName;
  available: boolean;
  transport: string;
  lastRunAt: string | null;
  lastExitCode: number | null;
  sessionId: string | null;
  summary: string | null;
}

export interface PeerMessage {
  id: string;
  taskId: string;
  from: AgentName;
  to: AgentName;
  intent: PeerMessageIntent;
  subject: string;
  body: string;
  createdAt: string;
}

export interface RouteDecision {
  owner: AgentName;
  strategy: RouteStrategy;
  confidence: number;
  reason: string;
  claimedPaths: string[];
  metadata: Record<string, unknown>;
}

export interface TaskSpec {
  id: string;
  missionId: string | null;
  title: string;
  owner: AgentName | "router";
  kind: TaskKind;
  nodeKind: MissionNodeKind | null;
  status: "pending" | "running" | "blocked" | "completed" | "failed";
  prompt: string;
  dependsOnTaskIds: string[];
  parentTaskId: string | null;
  planId: string | null;
  planNodeKey: string | null;
  retryCount: number;
  maxRetries: number;
  lastFailureSummary: string | null;
  lease: TaskLease | null;
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  nextRecommendation?: string | null;
  routeReason: string | null;
  routeStrategy: RouteStrategy | null;
  routeConfidence: number | null;
  routeMetadata: Record<string, unknown>;
  claimedPaths: string[];
}

export interface AgentTurnEnvelope {
  summary: string;
  status: "completed" | "blocked" | "needs_review";
  blockers: string[];
  nextRecommendation: string | null;
  plan: PlannedTaskGraph | null;
  peerMessages: Array<{
    to: AgentName;
    intent: PeerMessageIntent;
    subject: string;
    body: string;
  }>;
}

export interface PlannedTaskDraft {
  key: string;
  title: string;
  owner: AgentName;
  prompt: string;
  nodeKind?: MissionNodeKind | null;
  dependsOn: string[];
  claimedPaths: string[];
  reason: string;
  executionMode: PlanExecutionMode;
}

export interface PlannedTaskGraph {
  summary: string;
  tasks: PlannedTaskDraft[];
}

export interface ExecutionPlanNode {
  key: string;
  taskId: string | null;
  title: string;
  owner: AgentName;
  prompt: string;
  nodeKind: MissionNodeKind | null;
  dependsOn: string[];
  claimedPaths: string[];
  reason: string;
  executionMode: PlanExecutionMode;
  status: TaskSpec["status"] | "planned";
}

export interface ExecutionPlan {
  id: string;
  missionId: string | null;
  title: string;
  sourcePrompt: string;
  sourceTaskId: string | null;
  planningMode: "kickoff" | "operator";
  plannerTaskId: string;
  summary: string;
  status: ExecutionPlanStatus;
  createdAt: string;
  updatedAt: string;
  nodes: ExecutionPlanNode[];
}

export interface SessionRuntime {
  nodeExecutable: string;
  codexExecutable: string;
  claudeExecutable: string;
  kaviEntryPoint: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  repoRoot: string;
  agent: AgentName;
  hookEvent: string;
  toolName: string;
  summary: string;
  matchKey: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decision: ApprovalRuleDecision | null;
  remember: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ApprovalRule {
  id: string;
  repoRoot: string;
  agent: AgentName;
  toolName: string;
  matchKey: string;
  summary: string;
  decision: ApprovalRuleDecision;
  createdAt: string;
  updatedAt: string;
}

export interface TaskArtifact {
  taskId: string;
  sessionId: string;
  missionId: string | null;
  title: string;
  owner: AgentName | "router";
  kind: TaskKind;
  nodeKind: MissionNodeKind | null;
  status: TaskSpec["status"];
  summary: string | null;
  dependsOnTaskIds: string[];
  parentTaskId: string | null;
  planId: string | null;
  planNodeKey: string | null;
  retryCount: number;
  maxRetries: number;
  lastFailureSummary: string | null;
  routeReason: string | null;
  routeStrategy: RouteStrategy | null;
  routeConfidence: number | null;
  routeMetadata: Record<string, unknown>;
  claimedPaths: string[];
  decisionReplay: string[];
  rawOutput: string | null;
  error: string | null;
  envelope: AgentTurnEnvelope | null;
  reviewNotes: ReviewNote[];
  progress: TaskProgressEntry[];
  attempts: TaskAttemptRecord[];
  startedAt: string;
  finishedAt: string | null;
  nextRecommendation?: string | null;
}

export interface TaskLease {
  id: string;
  agent: AgentName;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface TaskAttemptRecord {
  id: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "retrying" | "blocked";
  summary: string | null;
}

export interface ReviewNote {
  id: string;
  agent: AgentName;
  assignee: ReviewAssignee | null;
  taskId: string | null;
  filePath: string;
  hunkIndex: number | null;
  hunkHeader: string | null;
  disposition: ReviewDisposition;
  status: ReviewStatus;
  summary: string;
  body: string;
  comments: ReviewComment[];
  resolvedAt: string | null;
  landedAt: string | null;
  followUpTaskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionRecord {
  id: string;
  kind: DecisionKind;
  agent: AgentName | "router" | null;
  taskId: string | null;
  summary: string;
  detail: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface PathClaim {
  id: string;
  taskId: string;
  agent: AgentName;
  source: "route" | "diff" | "integration";
  status: "active" | "released";
  paths: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimHotspot {
  path: string;
  agents: AgentName[];
  taskIds: string[];
  claimIds: string[];
  overlapCount: number;
}

export interface OperatorRecommendation {
  id: string;
  kind: RecommendationKind;
  status: RecommendationStatus;
  title: string;
  detail: string;
  targetAgent: AgentName | "operator" | null;
  filePath: string | null;
  taskIds: string[];
  reviewNoteIds: string[];
  commandHint: string;
  fingerprint: string;
  dismissedReason: string | null;
  dismissedAt: string | null;
  lastAppliedAt: string | null;
  appliedTaskIds: string[];
  openFollowUpTaskIds: string[];
  metadata: Record<string, unknown>;
}

export interface RecommendationState {
  id: string;
  fingerprint: string;
  status: RecommendationStatus;
  dismissedReason: string | null;
  dismissedAt: string | null;
  lastAppliedAt: string | null;
  appliedTaskIds: string[];
  updatedAt: string;
}

export interface WorkflowStageInfo {
  id: WorkflowStageId;
  label: string;
  detail: string;
}

export interface AcceptanceCheck {
  id: string;
  title: string;
  kind: AcceptanceCheckKind;
  command: string | null;
  path: string | null;
  harnessPath?: string | null;
  serverCommand?: string | null;
  target?: string | null;
  urlPath?: string | null;
  routeCandidates?: string[];
  method?: string | null;
  requestBody?: string | null;
  requestHeaders?: Record<string, string>;
  selector?: string | null;
  selectorCandidates?: string[];
  expectedTitle?: string | null;
  expectedStatus?: number | null;
  expectedContentType?: string | null;
  expectedJsonKeys?: string[];
  evidencePaths?: string[];
  expectedText?: string[];
  likelyTaskIds?: string[];
  likelyOwners?: AgentName[];
  likelyReason?: string | null;
  status: AcceptanceCheckStatus;
  detail: string;
  lastRunAt: string | null;
  lastOutput: string | null;
}

export interface AcceptanceFailurePack {
  id: string;
  missionId: string;
  checkId: string;
  kind: AcceptanceCheckKind;
  title: string;
  summary: string;
  expected: string[];
  observed: string[];
  evidence: string[];
  likelyOwners: AgentName[];
  likelyTaskIds: string[];
  attribution: string | null;
  repairFocus: string[];
  command: string | null;
  harnessPath: string | null;
  serverCommand: string | null;
  request: {
    method: string | null;
    urlPath: string | null;
    routeCandidates: string[];
    headers: Record<string, string>;
    body: string | null;
    selector: string | null;
    selectorCandidates: string[];
  };
  expectedSignals: {
    title: string | null;
    status: number | null;
    contentType: string | null;
    text: string[];
    jsonKeys: string[];
  };
  runtimeCapture: {
    detail: string;
    lastOutput: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceRepairPlan {
  id: string;
  missionId: string;
  title: string;
  owner: AgentName;
  status: "proposed" | "queued" | "applied";
  failureFingerprint: string;
  failedCheckIds: string[];
  failurePackIds: string[];
  summary: string;
  prompt: string;
  routeReason: string;
  routeStrategy: RouteStrategy;
  routeConfidence: number;
  claimedPaths: string[];
  likelyOwners: AgentName[];
  likelyTaskIds: string[];
  repairFocus: string[];
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  queuedTaskId: string | null;
}

export interface AcceptancePack {
  id: string;
  summary: string;
  criteria: string[];
  checks: AcceptanceCheck[];
  failurePacks: AcceptanceFailurePack[];
  repairPlans: AcceptanceRepairPlan[];
  status: AcceptancePackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MissionSpec {
  normalizedPrompt: string;
  audience: string | null;
  repoShape: "greenfield" | "existing" | "unknown";
  workstreamKinds: string[];
  stackHints: string[];
  requestedDeliverables: string[];
  userRoles: string[];
  domainEntities: string[];
  constraints: string[];
}

export interface MissionContract {
  acceptanceCriteria: string[];
  scenarios: string[];
  qualityBars: string[];
  docsExpectations: string[];
}

export interface MissionBlueprint {
  overview: string;
  productConcept: string;
  personas: string[];
  domainModel: string[];
  serviceBoundaries: string[];
  uiSurfaces: string[];
  acceptanceJourneys: string[];
  architectureNotes: string[];
}

export interface MissionRisk {
  id: string;
  title: string;
  detail: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
}

export interface MissionPolicy {
  autonomyLevel: MissionAutonomyLevel;
  approvalMode: "standard" | "approve_all";
  retryBudget: number;
  operatorAttentionBudget: number;
  escalationPolicy: "strict" | "balanced" | "aggressive";
  verificationMode: MissionVerificationMode;
  landPolicy: MissionLandPolicy;
  gatePolicy: string[];
  autoAdvance: boolean;
  autoVerify: boolean;
  autoLand: boolean;
  pauseOnRepairFailure: boolean;
}

export interface MissionAnchor {
  id: string;
  kind: "intent" | "architecture" | "acceptance" | "progress";
  title: string;
  summary: string;
  createdAt: string;
}

export interface MissionHealth {
  score: number;
  state: MissionHealthState;
  reasons: string[];
  updatedAt: string;
}

export interface MissionConfidence {
  score: number;
  state: "high" | "medium" | "low";
  canAutopilot: boolean;
  blockers: string[];
  warnings: string[];
  strengths: string[];
  updatedAt: string;
}

export interface MissionSpecRevision {
  id: string;
  version: number;
  summary: string;
  prompt: string;
  sourceTaskId: string | null;
  createdAt: string;
}

export interface MissionSimulationIssue {
  id: string;
  kind: "coordination" | "verification" | "seriality" | "attention" | "overlap";
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
}

export interface MissionSimulation {
  generatedAt: string;
  attentionCost: number;
  attentionBudget: number;
  gatePressure: number;
  serialityScore: number;
  contractRequestCount: number;
  escalationPressure: "low" | "medium" | "high";
  escalationReasons: string[];
  autopilotViable: boolean;
  estimatedParallelism: number;
  verificationCoverage: "thin" | "partial" | "strong";
  contractCoverage: "missing" | "partial" | "explicit";
  issues: MissionSimulationIssue[];
  recommendations: string[];
}

export interface MissionCheckpoint {
  id: string;
  kind:
    | "created"
    | "planning_started"
    | "plan_materialized"
    | "task_started"
    | "task_progress"
    | "task_stalled"
    | "task_retried"
    | "task_recovered"
    | "repair_queued"
    | "task_completed"
    | "task_failed"
    | "acceptance_verified"
    | "landed";
  title: string;
  detail: string;
  taskId: string | null;
  createdAt: string;
}

export interface Mission {
  id: string;
  packetVersion?: number;
  title: string;
  prompt: string;
  goal: string | null;
  mode: MissionMode;
  status: MissionStatus;
  summary: string;
  shadowOfMissionId?: string | null;
  planningTaskId: string | null;
  planId: string | null;
  rootTaskId: string | null;
  activeTaskIds: string[];
  autopilotEnabled: boolean;
  phase?: MissionPhase;
  spec?: MissionSpec;
  specRevisions?: MissionSpecRevision[];
  contract?: MissionContract;
  blueprint?: MissionBlueprint;
  policy?: MissionPolicy;
  risks?: MissionRisk[];
  anchors?: MissionAnchor[];
  health?: MissionHealth;
  simulation?: MissionSimulation;
  appliedPatternIds?: string[];
  receiptIds?: string[];
  contractIds?: string[];
  acceptance: AcceptancePack;
  checkpoints: MissionCheckpoint[];
  brainEntryIds: string[];
  createdAt: string;
  updatedAt: string;
  landedAt: string | null;
}

export interface BrainEntry {
  id: string;
  missionId: string | null;
  taskId: string | null;
  sourceType: "task" | "mission" | "landing" | "operator" | "pattern";
  category?: BrainEntryCategory;
  scope?: BrainEntryScope;
  title: string;
  content: string;
  tags: string[];
  confidence?: number;
  freshness?: BrainEntryFreshness;
  evidence?: string[];
  commands?: string[];
  supersedes?: string[];
  supersededBy?: string | null;
  contradictions?: string[];
  retiredAt?: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PatternEntry {
  id: string;
  sourceRepoRoot: string;
  missionId: string | null;
  reportId: string | null;
  kind?: PatternKind;
  title: string;
  summary: string;
  prompt: string;
  tags: string[];
  stackSignals?: string[];
  nodeKinds?: MissionNodeKind[];
  acceptanceCriteria?: string[];
  confidence?: number;
  usageCount?: number;
  sourceMissionIds?: string[];
  antiPatternSignals?: string[];
  examplePaths: string[];
  commands: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PatternTemplate {
  id: string;
  label: string;
  kind: PatternKind;
  stacks: string[];
  nodeKinds: string[];
  patternIds: string[];
  repoRoots: string[];
  acceptanceCriteria: string[];
  commands: string[];
  antiPatternSignals: string[];
  confidence: number;
}

export interface PatternBenchmark {
  templateId: string;
  label: string;
  kind: PatternKind;
  score: number;
  trustScore: number;
  trustClass: "high_trust" | "promising" | "noisy" | "fragile";
  stabilityTrend: "improving" | "steady" | "volatile";
  successCount: number;
  recentSuccessCount: number;
  antiPatternCount: number;
  recentAntiPatternCount: number;
  deliveryCount: number;
  repoCount: number;
  averageConfidence: number;
  recencyScore: number;
  repairPressure: number;
  acceptanceDepth: number;
  commands: string[];
  acceptanceCriteria: string[];
  antiPatternSignals: string[];
}

export interface PortfolioCommandHabit {
  command: string;
  count: number;
  repoRoots: string[];
  labels: string[];
}

export interface PortfolioStartingPoint {
  templateId: string;
  label: string;
  score: number;
  benchmarkScore: number;
  trustScore: number;
  trustClass: "high_trust" | "promising" | "noisy" | "fragile";
  recencyScore: number;
  repairPressure: number;
  repoRoots: string[];
  stacks: string[];
  nodeKinds: string[];
  commands: string[];
  acceptanceCriteria: string[];
  antiPatternSignals: string[];
  reasons: string[];
}

export interface PortfolioClusterInsight {
  id: string;
  labels: string[];
  repoRoots: string[];
  repoCount: number;
  stacks: string[];
  nodeKinds: string[];
  commandHabits: PortfolioCommandHabit[];
  acceptanceCriteria: Array<{ value: string; count: number }>;
  antiPatternHotspots: Array<{ value: string; count: number }>;
  benchmarkScore: number;
  trustScore: number;
  trustClass: "high_trust" | "promising" | "noisy" | "fragile";
  recencyScore: number;
  repairPressure: number;
  templateIds: string[];
  recommendedTemplateIds: string[];
  summary: string;
  score: number;
}

export interface PatternComposition {
  prompt: string;
  templateIds: string[];
  labels: string[];
  stacks: string[];
  nodeKinds: string[];
  commands: string[];
  acceptanceCriteria: string[];
  antiPatternSignals: string[];
  conflicts: string[];
  benchmarkScore: number;
  composedPrompt: string;
}

export interface PatternConstellation {
  totalPatterns: number;
  totalTemplates: number;
  topStacks: Array<{ value: string; count: number }>;
  topNodeKinds: Array<{ value: string; count: number }>;
  topCommands: Array<{ value: string; count: number }>;
  topTags: Array<{ value: string; count: number }>;
  topRepos: Array<{ value: string; count: number }>;
  patternFamilies: Array<{
    id: string;
    label: string;
    count: number;
    stacks: string[];
    nodeKinds: string[];
  }>;
  repoProfiles: Array<{
    repoRoot: string;
    label: string;
    patternCount: number;
    templateCount: number;
    topStacks: string[];
    topNodeKinds: string[];
    antiPatternCount: number;
    deliveryPatternCount: number;
  }>;
  repoLinks: Array<{
    leftRepoRoot: string;
    rightRepoRoot: string;
    leftLabel: string;
    rightLabel: string;
    sharedStacks: string[];
    sharedNodeKinds: string[];
    sharedCommands: string[];
    score: number;
  }>;
  repoClusters: Array<{
    id: string;
    labels: string[];
    repoRoots: string[];
    stacks: string[];
    nodeKinds: string[];
    score: number;
  }>;
  antiPatternHotspots: Array<{ value: string; count: number }>;
  architecturePatterns: PatternEntry[];
  deliveryPatterns: PatternEntry[];
  antiPatterns: PatternEntry[];
  templateLinks: Array<{
    leftTemplateId: string;
    rightTemplateId: string;
    leftLabel: string;
    rightLabel: string;
    sharedStacks: string[];
    sharedNodeKinds: string[];
    sharedAcceptance: string[];
    sharedRepos: string[];
    score: number;
  }>;
  commandHabits: PortfolioCommandHabit[];
  clusterInsights: PortfolioClusterInsight[];
  startingPoints: PortfolioStartingPoint[];
  templates: PatternTemplate[];
}

export interface MissionPlaybackFrame {
  id: string;
  timestamp: string;
  kind:
    | "mission"
    | "checkpoint"
    | "task"
    | "attempt"
    | "progress"
    | "acceptance"
    | "receipt"
    | "contract"
    | "landing";
  title: string;
  detail: string;
  taskId: string | null;
}

export interface MissionPatchsetRoot {
  root: string;
  count: number;
  paths: string[];
}

export interface MissionPatchset {
  id: string;
  missionId: string;
  receiptId: string | null;
  taskId: string | null;
  owner: AgentName | "router";
  title: string;
  summary: string;
  changedPaths: string[];
  dominantRoots: MissionPatchsetRoot[];
  commands: string[];
  verificationEvidence: string[];
  followUps: string[];
  risks: string[];
  createdAt: string;
}

export type MissionDriftItemStatus = "covered" | "partial" | "missing";
export type MissionDriftItemCategory =
  | "deliverable"
  | "docs"
  | "service_boundary"
  | "ui_surface"
  | "journey";

export interface MissionDriftItem {
  id: string;
  missionId: string;
  category: MissionDriftItemCategory;
  status: MissionDriftItemStatus;
  title: string;
  detail: string;
  evidence: string[];
  likelyTaskIds: string[];
  suggestedAction: string | null;
}

export interface MissionDriftReport {
  missionId: string;
  generatedAt: string;
  coverageScore: number;
  coveredCount: number;
  partialCount: number;
  missingCount: number;
  summary: string;
  items: MissionDriftItem[];
}

export interface MissionReceipt {
  id: string;
  missionId: string;
  taskId: string;
  owner: AgentName | "router";
  nodeKind: MissionNodeKind | null;
  outcome: "completed" | "failed" | "blocked";
  title: string;
  summary: string;
  changedPaths: string[];
  commands: string[];
  verificationEvidence: string[];
  assumptions: string[];
  followUps: string[];
  risks: string[];
  createdAt: string;
}

export interface MissionRecoveryAction {
  id: string;
  kind:
    | "resolve_approvals"
    | "restore_provider"
    | "retry_task"
    | "resume_autopilot"
    | "run_verification"
    | "review_contracts"
    | "review_follow_ups"
    | "review_repairs"
    | "resolve_overlap"
    | "select_shadow"
    | "inspect_failures";
  title: string;
  detail: string;
  command: string | null;
  taskId: string | null;
  safeToAutoApply: boolean;
  recommended: boolean;
}

export interface MissionRecoveryPlan {
  missionId: string;
  generatedAt: string;
  status: "clear" | "waiting" | "actionable";
  summary: string;
  blockers: string[];
  actions: MissionRecoveryAction[];
}

export type MissionAttentionItemKind =
  | "approval"
  | "provider"
  | "audit"
  | "contract"
  | "follow_up"
  | "repair"
  | "verification"
  | "overlap"
  | "drift";

export interface MissionAttentionItem {
  id: string;
  missionId: string;
  kind: MissionAttentionItemKind;
  urgency: "critical" | "high" | "normal";
  priority: number;
  title: string;
  summary: string;
  payoff: string;
  command: string | null;
  role: QualityCourtRole | null;
  taskIds: string[];
  contractIds: string[];
  objectionIds: string[];
  recommendationIds: string[];
}

export interface MissionAttentionPacket {
  missionId: string;
  generatedAt: string;
  summary: string;
  dominantArea: MissionAttentionItemKind | null;
  criticalCount: number;
  highCount: number;
  normalCount: number;
  items: MissionAttentionItem[];
}

export interface MissionDigest {
  missionId: string;
  title: string;
  phase: MissionPhase;
  headline: string;
  confidence: MissionConfidence;
  summary: string[];
  blockers: string[];
  warnings: string[];
  nextActions: string[];
  observability: {
    totalTasks: number;
    completedTasks: number;
    runningTasks: number;
    pendingTasks: number;
    blockedTasks: number;
    failedTasks: number;
    retriesUsed: number;
    activeRepairTasks: number;
    changedPaths: number;
    activeOwners: AgentName[];
    criticalPath: string[];
    nextReadyNodes: Array<{
      key: string;
      title: string;
      owner: AgentName;
    }>;
  } | null;
  recentReceipts: MissionReceipt[];
  openContracts: AgentContract[];
  activeRepairPlans: AcceptanceRepairPlan[];
  failurePacks: AcceptanceFailurePack[];
  recoveryPlan: MissionRecoveryPlan;
  attentionPacket: MissionAttentionPacket;
  generatedAt: string;
}

export interface MissionPostmortem {
  missionId: string;
  outcome: "landed" | "failed" | "active";
  summary: string;
  wins: string[];
  pains: string[];
  followUpDebt: string[];
  reinforcedPatterns: string[];
  antiPatterns: string[];
  receiptHighlights: string[];
  generatedAt: string;
}

export interface MissionMorningBrief {
  missionId: string;
  title: string;
  generatedAt: string;
  windowHours: number;
  headline: string;
  summary: string[];
  completedTasks: Array<{
    taskId: string;
    owner: AgentName | "router";
    title: string;
    summary: string;
    finishedAt: string;
  }>;
  failedTasks: Array<{
    taskId: string;
    owner: AgentName | "router";
    title: string;
    summary: string;
    finishedAt: string;
  }>;
  resolvedContracts: AgentContract[];
  openContracts: AgentContract[];
  recentReceipts: MissionReceipt[];
  qualityCourt: MissionAuditReport | null;
  attentionPacket: MissionAttentionPacket;
  firstActions: string[];
}

export type QualityCourtRole =
  | "verifier"
  | "contract_auditor"
  | "integration_auditor"
  | "risk_auditor";

export type QualityCourtEvidencePackKind =
  | "acceptance_failure"
  | "verification_gap"
  | "verification_receipts"
  | "contract_chain"
  | "follow_up_queue"
  | "integration_overlap"
  | "failed_task_surface"
  | "receipt_surface"
  | "risk_register"
  | "simulation_risk"
  | "mission_drift";

export interface QualityCourtEvidencePack {
  id: string;
  missionId: string;
  role: QualityCourtRole;
  stance: "approval" | "objection";
  severity: MissionObjection["severity"] | null;
  kind: QualityCourtEvidencePackKind;
  title: string;
  summary: string;
  highlights: string[];
  evidence: string[];
  taskIds: string[];
  receiptIds: string[];
  contractIds: string[];
  checkIds: string[];
  suggestedAction: string | null;
}

export interface MissionObjection {
  id: string;
  missionId: string;
  role: QualityCourtRole;
  severity: "critical" | "major" | "minor";
  kind:
    | "acceptance"
    | "contract"
    | "drift"
    | "follow_up"
    | "overlap"
    | "verification"
    | "receipt"
    | "risk"
    | "simulation";
  title: string;
  detail: string;
  evidence: string[];
  likelyTaskIds: string[];
  suggestedAction: string | null;
}

export interface QualityCourtRoleReport {
  role: QualityCourtRole;
  verdict: "approved" | "warn" | "blocked";
  score: number;
  summary: string;
  approvals: string[];
  objections: MissionObjection[];
  evidencePacks: QualityCourtEvidencePack[];
}

export interface MissionAuditReport {
  missionId: string;
  verdict: "approved" | "warn" | "blocked";
  score: number;
  summary: string;
  approvals: string[];
  objections: MissionObjection[];
  roleReports: QualityCourtRoleReport[];
  evidencePacks: QualityCourtEvidencePack[];
  dominantRoles: QualityCourtRole[];
  receiptsReviewed: number;
  checksReviewed: number;
  contractsReviewed: number;
  generatedAt: string;
}

export interface AgentContract {
  id: string;
  missionId: string;
  sourceTaskId: string;
  sourceMessageId: string | null;
  sourceAgent: AgentName;
  targetAgent: AgentName | "operator";
  kind: AgentContractKind;
  status: AgentContractStatus;
  title: string;
  detail: string;
  requiredArtifacts: string[];
  acceptanceExpectations: string[];
  urgency: "low" | "normal" | "high";
  dependencyImpact: "blocking" | "sidecar";
  claimedPaths: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedByTaskId: string | null;
}

export interface TaskProgressEntry {
  id: string;
  kind: "change" | "heartbeat" | "stalled" | "provider";
  summary: string;
  paths: string[];
  createdAt: string;
  provider?: AgentName | "node" | null;
  eventName?: string | null;
  semanticKind?: ProviderSemanticKind | null;
  source?: "notification" | "stderr" | "stdout" | "delta" | "worktree" | "hook" | "transcript" | null;
}

export type ProviderSemanticKind =
  | "planning"
  | "reasoning"
  | "inspection"
  | "scaffold"
  | "editing"
  | "command"
  | "verification"
  | "blocker"
  | "approval"
  | "handoff"
  | "contract"
  | "review"
  | "tool"
  | "session"
  | "notification"
  | "runtime"
  | "failure"
  | "completion"
  | "artifact";

export interface ProviderCapabilityManifest {
  provider: AgentName | "node";
  version: string | null;
  transport: string | null;
  status: "ok" | "degraded" | "unsupported";
  capabilities: string[];
  warnings: string[];
  errors: string[];
  checkedAt: string;
}

export interface LandReportTaskResult {
  taskId: string;
  owner: AgentName | "router";
  title: string;
  summary: string;
  claimedPaths: string[];
  finishedAt: string;
}

export interface LandReportAgentChange {
  agent: AgentName;
  paths: string[];
}

export interface LandReportSnapshotCommit {
  agent: AgentName;
  commit: string;
  createdCommit: boolean;
}

export interface LandReport {
  id: string;
  sessionId: string;
  goal: string | null;
  createdAt: string;
  targetBranch: string;
  integrationBranch: string;
  integrationPath: string;
  validationCommand: string;
  validationStatus: "ran" | "skipped" | "not_configured";
  validationDetail: string;
  changedByAgent: LandReportAgentChange[];
  completedTasks: LandReportTaskResult[];
  snapshotCommits: LandReportSnapshotCommit[];
  commandsRun: string[];
  reviewThreadsLanded: number;
  openReviewThreadsRemaining: number;
  summary: string[];
}

export interface SessionRecord {
  id: string;
  repoRoot: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  socketPath: string;
  status: "starting" | "running" | "stopped";
  goal: string | null;
  selectedMissionId?: string | null;
  fullAccessMode: boolean;
  daemonPid: number | null;
  daemonHeartbeatAt: string | null;
  daemonVersion?: string | null;
  protocolVersion?: number | null;
  config: KaviConfig;
  runtime: SessionRuntime;
  worktrees: WorktreeInfo[];
  tasks: TaskSpec[];
  plans: ExecutionPlan[];
  missions: Mission[];
  receipts?: MissionReceipt[];
  contracts?: AgentContract[];
  brain: BrainEntry[];
  providerCapabilities: ProviderCapabilityManifest[];
  peerMessages: PeerMessage[];
  decisions: DecisionRecord[];
  pathClaims: PathClaim[];
  reviewNotes: ReviewNote[];
  recommendationStates: RecommendationState[];
  agentStatus: Record<AgentName, AgentStatus>;
}

export interface EventRecord {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface KaviWorktreeDiff {
  agent: AgentName;
  paths: string[];
}

export interface KaviSnapshot {
  session: SessionRecord;
  events: EventRecord[];
  approvals: ApprovalRequest[];
  worktreeDiffs: KaviWorktreeDiff[];
  latestLandReport: LandReport | null;
}

export interface SnapshotSubscriptionEvent {
  reason: string;
  snapshot: KaviSnapshot;
}

export interface WorktreeDiffReview {
  agent: AgentName;
  changedPaths: string[];
  selectedPath: string | null;
  stat: string;
  patch: string;
}

export interface HookEventPayload {
  event: string;
  sessionId: string | null;
  agent: AgentName | null;
  payload: Record<string, unknown>;
}

export interface AppPaths {
  repoRoot: string;
  kaviDir: string;
  configFile: string;
  promptsDir: string;
  stateDir: string;
  reportsDir: string;
  runtimeDir: string;
  runsDir: string;
  stateFile: string;
  eventsFile: string;
  approvalsFile: string;
  commandsFile: string;
  claudeSettingsFile: string;
  socketPath: string;
  homeConfigDir: string;
  homeConfigFile: string;
  homeApprovalRulesFile: string;
  homeStateDir: string;
  patternsFile: string;
  worktreeRoot: string;
  integrationRoot: string;
}
