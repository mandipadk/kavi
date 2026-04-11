import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./paths.ts";
import type { BrainEntry, Mission, SessionRecord, TaskSpec } from "./types.ts";

export interface BrainSearchOptions {
  query?: string;
  path?: string | null;
  category?: BrainEntry["category"] | "all";
  scope?: BrainEntry["scope"] | "all";
  missionId?: string | null;
  includeRetired?: boolean;
  limit?: number;
}

export interface BrainGraphNode {
  id: string;
  title: string;
  category: BrainEntry["category"] | null;
  scope: BrainEntry["scope"] | null;
  missionId: string | null;
  taskId: string | null;
  pinned: boolean;
  retired: boolean;
  freshness: BrainEntry["freshness"] | null;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export type BrainGraphMode =
  | "all"
  | "structural"
  | "knowledge"
  | "topology"
  | "failure"
  | "contract"
  | "timeline";

export interface BrainGraphEdge {
  from: string;
  to: string;
  kind:
    | "supersedes"
    | "contradicts"
    | "mission"
    | "task"
    | "tag"
    | "evidence"
    | "command"
    | "scope"
    | "category"
    | "timeline";
  weight: number;
  label: string;
}

export interface BrainGraph {
  focusEntryId: string | null;
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
}

export type BrainPackPhase = "planning" | "implementation" | "repair" | "verification";

export interface BrainPackSection {
  key: string;
  title: string;
  rationale: string;
  entries: BrainEntry[];
}

export interface BrainPack {
  missionId: string | null;
  phase: BrainPackPhase;
  summary: string;
  pathHint: string | null;
  sections: BrainPackSection[];
}

export interface BrainReviewItem {
  entryId: string;
  title: string;
  category: BrainEntry["category"] | null;
  scope: BrainEntry["scope"] | null;
  severity: "low" | "medium" | "high";
  reasons: string[];
  recommendedAction: string;
}

export interface BrainDistillationPlan {
  title: string;
  category: BrainEntry["category"];
  scope: BrainEntry["scope"];
  missionId: string | null;
  sourceEntryIds: string[];
  content: string;
  tags: string[];
  evidence: string[];
  commands: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function countBy<T>(values: T[], keyFn: (value: T) => string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyFn(value).trim();
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9/.\-\s]+/g, " ").replaceAll(/\s+/g, " ").trim();
}

function normalizePathLike(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replaceAll(/\/+/g, "/")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function shortText(value: string, max = 180): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function inferFreshness(updatedAt: string): BrainEntry["freshness"] {
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 3 * 24 * 60 * 60 * 1000) {
    return "live";
  }
  if (ageMs < 30 * 24 * 60 * 60 * 1000) {
    return "recent";
  }
  return "stale";
}

function overlapCount(left: string[], right: string[]): number {
  const set = new Set(left.map((value) => normalizeText(value)));
  let count = 0;
  for (const value of right) {
    if (set.has(normalizeText(value))) {
      count += 1;
    }
  }
  return count;
}

function pathSignals(values: string[]): string[] {
  const signals = new Set<string>();
  for (const value of values) {
    const normalized = normalizePathLike(value);
    if (!normalized) {
      continue;
    }
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    for (let index = 1; index <= parts.length; index += 1) {
      signals.add(parts.slice(0, index).join("/"));
    }
  }
  return [...signals];
}

function commandFamily(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

function commandFamilies(commands: string[]): string[] {
  return unique(commands.map(commandFamily).filter(Boolean));
}

function brainPathSignals(entry: BrainEntry): string[] {
  return pathSignals([...(entry.evidence ?? []), ...(entry.tags ?? [])]);
}

function brainCommandSignals(entry: BrainEntry): string[] {
  return commandFamilies(entry.commands ?? []);
}

function tokenizePath(filePath: string): string[] {
  return filePath
    .split("/")
    .flatMap((segment) => tokenize(segment.replaceAll(".", " ")));
}

function structuralTokenOverlap(entry: BrainEntry, claimedPaths: string[]): number {
  if (claimedPaths.length === 0) {
    return 0;
  }

  const entryTokens = new Set([
    ...entry.tags.flatMap((tag) => tokenizePath(tag)),
    ...(entry.evidence ?? []).flatMap((value) => tokenizePath(value))
  ]);
  if (entryTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const filePath of claimedPaths) {
    for (const token of tokenizePath(filePath)) {
      if (entryTokens.has(token)) {
        overlap += 1;
      }
    }
  }
  return overlap;
}

async function collectRepoTree(
  repoRoot: string,
  relativeDir = ".",
  depth = 2
): Promise<string[]> {
  if (depth < 0) {
    return [];
  }

  const absoluteDir = path.join(repoRoot, relativeDir);
  let entries: Awaited<ReturnType<typeof fs.readdir>> = [];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === ".kavi" ||
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === "__pycache__"
    ) {
      continue;
    }

    const relativePath = relativeDir === "." ? entry.name : path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(relativePath);
      files.push(...(await collectRepoTree(repoRoot, relativePath, depth - 1)));
      continue;
    }

    files.push(relativePath);
  }

  return files;
}

async function readPackageScripts(repoRoot: string): Promise<string[]> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Object.entries(parsed.scripts ?? {})
      .map(([name, command]) => `${name}: ${command}`)
      .slice(0, 12);
  } catch {
    return [];
  }
}

async function collectStructuralEdges(
  repoRoot: string,
  files: string[],
  limit = 80
): Promise<Array<{ from: string; to: string; kind: "local" | "external" }>> {
  const sourceFiles = files
    .filter((filePath) => /\.(ts|tsx|js|jsx|go|py|rs)$/i.test(filePath))
    .slice(0, limit);
  const edges: Array<{ from: string; to: string; kind: "local" | "external" }> = [];

  for (const filePath of sourceFiles) {
    let content = "";
    try {
      content = await fs.readFile(path.join(repoRoot, filePath), "utf8");
    } catch {
      continue;
    }

    const matches = [
      ...content.matchAll(/from\s+["']([^"']+)["']/g),
      ...content.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
      ...content.matchAll(/import\s+["']([^"']+)["']/g),
      ...content.matchAll(/^\s*import\s+([a-zA-Z0-9_./-]+)\s*$/gm),
      ...content.matchAll(/^\s*from\s+([a-zA-Z0-9_./-]+)\s+import\s+/gm)
    ];

    for (const match of matches) {
      const target = match[1]?.trim();
      if (!target) {
        continue;
      }
      edges.push({
        from: filePath,
        to: target,
        kind: target.startsWith(".") || target.startsWith("/") ? "local" : "external"
      });
    }
  }

  return edges;
}

function inferRepoCommands(repoRoot: string, files: string[], packageScripts: string[]): string[] {
  const commands = [...packageScripts];
  if (files.includes("go.mod")) {
    commands.push("go test ./...");
  }
  if (files.includes("Cargo.toml")) {
    commands.push("cargo test");
  }
  if (files.includes("pytest.ini") || files.some((filePath) => filePath.startsWith("tests/"))) {
    commands.push("pytest");
  }
  if (files.includes("README.md")) {
    commands.push("Open README.md for run/setup guidance");
  }
  return unique(commands).slice(0, 12);
}

function inferRepoTags(files: string[]): string[] {
  const joined = files.join(" ").toLowerCase();
  return unique([
    files.some((item) => item.startsWith("apps/")) ? "monorepo" : "",
    files.some((item) => item.startsWith("packages/")) ? "packages" : "",
    files.some((item) => item.includes("app/page.") || item.includes("src/app/")) ? "app-router" : "",
    files.some((item) => item.endsWith(".tsx") || item.endsWith(".jsx")) ? "frontend" : "",
    files.some((item) => item.endsWith(".go") || item.includes("/api/") || item.includes("/server/")) ? "backend" : "",
    files.some((item) => item.includes("/worker/") || item.includes("queue")) ? "worker" : "",
    /\bnext\.config|next-env\.d\.ts|app\/page\./.test(joined) ? "nextjs" : "",
    files.some((item) => item.endsWith(".ts") || item.endsWith(".tsx")) ? "typescript" : "",
    files.includes("go.mod") ? "go" : "",
    files.includes("pyproject.toml") ? "python" : "",
    files.includes("Cargo.toml") ? "rust" : "",
    files.includes("README.md") ? "docs" : ""
  ]);
}

function inferBrainPackPhase(task: TaskSpec | null): BrainPackPhase {
  if (!task) {
    return "planning";
  }
  if (task.kind === "planner" || task.kind === "kickoff" || task.nodeKind === "research") {
    return "planning";
  }
  if (task.status === "failed" || task.nodeKind === "repair") {
    return "repair";
  }
  if (
    task.nodeKind === "tests" ||
    task.nodeKind === "review" ||
    /verify|verification|test|acceptance/i.test(task.title) ||
    /verify|verification|test|acceptance/i.test(task.prompt)
  ) {
    return "verification";
  }
  return "implementation";
}

interface RepoCartography {
  files: string[];
  packageScripts: string[];
  structuralEdges: Array<{ from: string; to: string; kind: "local" | "external" }>;
  rootDirectories: string[];
  entrypoints: string[];
  tags: string[];
  commands: string[];
  localEdges: Array<{ from: string; to: string; kind: "local" | "external" }>;
  externalEdges: Array<{ from: string; to: string; kind: "local" | "external" }>;
  commonLocalTargets: string[];
  commonExternalTargets: string[];
  contractSurfaces: string[];
  routeSurfaces: string[];
  verificationSurfaces: string[];
  serviceSurfaces: string[];
  dependencyHotspots: string[];
  testCommands: string[];
  buildCommands: string[];
  routeEntrypoints: string[];
}

async function cartographRepo(repoRoot: string): Promise<RepoCartography> {
  const files = await collectRepoTree(repoRoot, ".", 2);
  const packageScripts = await readPackageScripts(repoRoot);
  const structuralEdges = await collectStructuralEdges(repoRoot, files);
  const rootDirectories = unique(
    files
      .filter((filePath) => filePath.includes("/"))
      .map((filePath) => filePath.split("/")[0] ?? "")
  ).slice(0, 10);
  const entrypoints = files
    .filter((filePath) =>
      /(^README\.md$|^main\.(go|py|rs|ts)$|^src\/main\.(ts|tsx)$|^app\/page\.(ts|tsx|js|jsx)$|^apps\/[^/]+\/app\/page\.(ts|tsx|js|jsx)$|^apps\/[^/]+\/src\/main\.(ts|tsx)$)/i.test(
        filePath
      )
    )
    .slice(0, 12);
  const tags = inferRepoTags(files);
  const commands = inferRepoCommands(repoRoot, files, packageScripts);
  const localEdges = structuralEdges.filter((edge) => edge.kind === "local");
  const externalEdges = structuralEdges.filter((edge) => edge.kind === "external");
  const commonLocalTargets = unique(localEdges.map((edge) => edge.to)).slice(0, 12);
  const commonExternalTargets = unique(externalEdges.map((edge) => edge.to)).slice(0, 12);
  const dependencyHotspots = unique(
    countBy(localEdges, (edge) => edge.to)
      .slice(0, 10)
      .map((item) => item.value)
  );
  const contractSurfaces = files
    .filter((filePath) =>
      /(schema|contract|types?|openapi|graphql|proto|dto|interface)/i.test(filePath)
    )
    .slice(0, 14);
  const routeSurfaces = files
    .filter((filePath) =>
      /(route|router|page|layout|endpoint|handler|controller|api)/i.test(filePath)
    )
    .slice(0, 14);
  const verificationSurfaces = files
    .filter((filePath) =>
      /(^tests\/|\.test\.|\.spec\.|playwright|cypress|vitest|jest|pytest|integration|acceptance)/i.test(filePath)
    )
    .slice(0, 14);
  const serviceSurfaces = unique([
    ...files.filter((filePath) => /(apps\/[^/]+|packages\/[^/]+|services\/[^/]+)/i.test(filePath)),
    ...files.filter((filePath) => /(api|worker|server|web|frontend|backend)/i.test(filePath))
  ]).slice(0, 14);
  const testCommands = commands.filter((command) => /test|verify|pytest|cargo test|go test/i.test(command)).slice(0, 8);
  const buildCommands = commands.filter((command) => /build|compile/i.test(command)).slice(0, 8);
  const routeEntrypoints = unique([
    ...routeSurfaces,
    ...entrypoints.filter((filePath) => /(page|route|handler|controller|api)/i.test(filePath))
  ]).slice(0, 14);

  return {
    files,
    packageScripts,
    structuralEdges,
    rootDirectories,
    entrypoints,
    tags,
    commands,
    localEdges,
    externalEdges,
    commonLocalTargets,
    commonExternalTargets,
    contractSurfaces,
    routeSurfaces,
    verificationSurfaces,
    serviceSurfaces,
    dependencyHotspots,
    testCommands,
    buildCommands,
    routeEntrypoints
  };
}

function sourceAuthority(sourceType: BrainEntry["sourceType"]): number {
  switch (sourceType) {
    case "operator":
      return 6;
    case "landing":
      return 5;
    case "mission":
      return 4;
    case "task":
      return 3;
    case "pattern":
      return 2;
    default:
      return 1;
  }
}

function entrySimilarity(left: BrainEntry, right: Omit<BrainEntry, "id" | "createdAt" | "updatedAt">): number {
  const leftTokens = new Set([
    ...tokenize(left.title),
    ...tokenize(left.content),
    ...left.tags.flatMap((tag) => tokenize(tag)),
    ...(left.evidence ?? []).flatMap((item) => tokenize(item))
  ]);
  const rightTokens = new Set([
    ...tokenize(right.title),
    ...tokenize(right.content),
    ...right.tags.flatMap((tag) => tokenize(tag)),
    ...(right.evidence ?? []).flatMap((item) => tokenize(item))
  ]);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tagOverlap = overlapCount(left.tags, right.tags);
  return shared / Math.max(leftTokens.size, rightTokens.size) + tagOverlap * 0.08;
}

function shouldSupersede(existing: BrainEntry, incoming: Omit<BrainEntry, "id" | "createdAt" | "updatedAt">): boolean {
  const incomingAuthority = sourceAuthority(incoming.sourceType);
  const existingAuthority = sourceAuthority(existing.sourceType);
  if (incomingAuthority > existingAuthority) {
    return true;
  }
  if ((incoming.confidence ?? 0.6) > (existing.confidence ?? 0.6) + 0.08) {
    return true;
  }
  return Date.parse(existing.updatedAt) < Date.now() - 14 * 24 * 60 * 60 * 1000;
}

export function refreshBrainLifecycle(session: SessionRecord): void {
  session.brain = Array.isArray(session.brain) ? session.brain : [];
  for (const entry of session.brain) {
    if (!entry.freshness || entry.freshness === "recent" || entry.freshness === "live" || entry.freshness === "stale") {
      entry.freshness = inferFreshness(entry.updatedAt);
    }
    entry.supersedes = unique(entry.supersedes ?? []);
    entry.contradictions = unique(entry.contradictions ?? []);
    entry.evidence = unique(entry.evidence ?? []);
    entry.commands = unique(entry.commands ?? []);
    entry.supersededBy = typeof entry.supersededBy === "string" ? entry.supersededBy : null;
    entry.retiredAt = typeof entry.retiredAt === "string" ? entry.retiredAt : null;
  }
}

export function addBrainEntry(
  session: SessionRecord,
  input: Omit<BrainEntry, "id" | "createdAt" | "updatedAt">
): BrainEntry {
  session.brain = Array.isArray(session.brain) ? session.brain : [];
  refreshBrainLifecycle(session);
  const existing = session.brain.find(
    (entry) =>
      entry.missionId === input.missionId &&
      entry.taskId === input.taskId &&
      entry.sourceType === input.sourceType &&
      entry.title === input.title &&
      entry.content === input.content
  );
  if (existing) {
    existing.updatedAt = nowIso();
    existing.tags = unique([...existing.tags, ...input.tags]);
    existing.pinned = existing.pinned || input.pinned;
    existing.evidence = unique([...(existing.evidence ?? []), ...(input.evidence ?? [])]);
    existing.commands = unique([...(existing.commands ?? []), ...(input.commands ?? [])]);
    existing.confidence = Math.max(existing.confidence ?? 0.6, input.confidence ?? 0.6);
    existing.freshness = input.freshness ?? existing.freshness ?? "recent";
    existing.retiredAt = input.retiredAt ?? existing.retiredAt ?? null;
    existing.supersedes = unique([...(existing.supersedes ?? []), ...(input.supersedes ?? [])]);
    existing.contradictions = unique([...(existing.contradictions ?? []), ...(input.contradictions ?? [])]);
    existing.supersededBy = input.supersededBy ?? existing.supersededBy ?? null;
    return existing;
  }

  const timestamp = nowIso();
  const entryId = `brain-${randomUUID()}`;
  const comparableEntries = session.brain.filter((entry) => {
    if (entry.retiredAt) {
      return false;
    }
    if (entry.category !== (input.category ?? "artifact")) {
      return false;
    }
    if (entry.scope !== (input.scope ?? (input.missionId ? "mission" : "repo"))) {
      return false;
    }
    const strictTitleMatch =
      (input.category ?? "artifact") === "topology" ||
      (input.category ?? "artifact") === "verification" ||
      (input.category ?? "artifact") === "contract";
    return (
      (
        normalizeText(entry.title) === normalizeText(input.title) ||
        (!strictTitleMatch && entrySimilarity(entry, input) >= 0.45)
      ) &&
      normalizeText(entry.content) !== normalizeText(input.content)
    );
  });

  const supersedes = unique(input.supersedes ?? []);
  const contradictions = unique(input.contradictions ?? []);
  for (const candidate of comparableEntries) {
    if (shouldSupersede(candidate, input)) {
      candidate.retiredAt = timestamp;
      candidate.freshness = "stale";
      candidate.supersededBy = entryId;
      supersedes.push(candidate.id);
    } else {
      contradictions.push(candidate.id);
    }
  }

  const entry: BrainEntry = {
    id: entryId,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
    category: input.category ?? "artifact",
    scope: input.scope ?? (input.missionId ? "mission" : "repo"),
    tags: unique(input.tags),
    confidence:
      typeof input.confidence === "number" && Number.isFinite(input.confidence)
        ? Math.max(0, Math.min(1, input.confidence))
        : 0.6,
    freshness: input.freshness ?? "live",
    evidence: unique(input.evidence ?? []),
    commands: unique(input.commands ?? []),
    supersedes: unique(supersedes),
    supersededBy: input.supersededBy ?? null,
    contradictions: unique(contradictions),
    retiredAt: input.retiredAt ?? null
  };
  session.brain.push(entry);
  return entry;
}

export function captureMissionBrainEntries(session: SessionRecord, mission: Mission): BrainEntry[] {
  const entries: BrainEntry[] = [];
  const missionFacts = addBrainEntry(session, {
    missionId: mission.id,
    taskId: null,
    sourceType: "mission",
    category: "fact",
    scope: "mission",
    title: `Mission blueprint: ${mission.title}`,
    content: [
      mission.blueprint?.overview ?? mission.summary,
      mission.blueprint?.productConcept ? `Product concept: ${mission.blueprint.productConcept}` : null,
      mission.blueprint?.serviceBoundaries?.length ? `Boundaries: ${mission.blueprint.serviceBoundaries.join(", ")}` : null,
      mission.blueprint?.uiSurfaces?.length ? `UI surfaces: ${mission.blueprint.uiSurfaces.join(", ")}` : null
    ].filter(Boolean).join("\n"),
    tags: [
      ...(mission.spec?.stackHints ?? []),
      ...(mission.spec?.workstreamKinds ?? []),
      ...(mission.spec?.userRoles ?? []),
      ...(mission.spec?.domainEntities ?? [])
    ],
    confidence: 0.84,
    freshness: "live",
    evidence: [...(mission.blueprint?.serviceBoundaries ?? []), ...(mission.blueprint?.uiSurfaces ?? [])],
    commands: [],
    pinned: false
  });
  entries.push(missionFacts);

  if ((mission.contract?.acceptanceCriteria ?? []).length > 0 || (mission.policy?.gatePolicy ?? []).length > 0) {
    entries.push(
      addBrainEntry(session, {
        missionId: mission.id,
        taskId: null,
        sourceType: "mission",
        category: "contract",
        scope: "mission",
        title: `Acceptance contract: ${mission.title}`,
        content: [
          `Criteria: ${(mission.contract?.acceptanceCriteria ?? []).join(" | ") || "-"}`,
          `Scenarios: ${(mission.contract?.scenarios ?? []).join(" | ") || "-"}`,
          `Gates: ${(mission.policy?.gatePolicy ?? []).join(", ") || "-"}`,
          `Verification mode: ${mission.policy?.verificationMode ?? "standard"}`
        ].join("\n"),
        tags: ["acceptance", ...(mission.spec?.requestedDeliverables ?? []), ...(mission.spec?.workstreamKinds ?? [])],
        confidence: 0.88,
        freshness: "live",
        evidence: [...(mission.contract?.acceptanceCriteria ?? [])],
        commands: [],
        pinned: false
      })
    );
  }

  for (const risk of mission.risks ?? []) {
    entries.push(
      addBrainEntry(session, {
        missionId: mission.id,
        taskId: null,
        sourceType: "mission",
        category: "risk",
        scope: "mission",
        title: `Mission risk: ${risk.title}`,
        content: `${risk.detail}\nMitigation: ${risk.mitigation}`,
        tags: [risk.severity, ...(mission.spec?.workstreamKinds ?? [])],
        confidence: risk.severity === "high" ? 0.92 : 0.78,
        freshness: "live",
        evidence: [risk.title, risk.mitigation],
        commands: [],
        pinned: false
      })
    );
  }

  for (const entry of entries) {
    if (!mission.brainEntryIds.includes(entry.id)) {
      mission.brainEntryIds.push(entry.id);
    }
  }
  return entries;
}

export function captureTaskBrainEntry(session: SessionRecord, task: TaskSpec): BrainEntry | null {
  if (!task.summary?.trim()) {
    return null;
  }

  const title = task.kind === "planner" ? `Mission plan: ${task.title}` : `Task result: ${task.title}`;
  const lowerSummary = task.summary.toLowerCase();
  const category =
    task.status === "failed"
      ? "failure"
      : task.kind === "planner"
        ? "decision"
        : /verify|verification|validated|test|tests|passed/i.test(lowerSummary) || task.nodeKind === "tests"
          ? "verification"
          : "artifact";
  const content = [
    shortText(task.summary, 240),
    task.claimedPaths.length > 0 ? `Paths: ${task.claimedPaths.join(", ")}` : null,
    task.routeReason ? `Route: ${task.routeReason}` : null,
    task.lastFailureSummary ? `Failure: ${task.lastFailureSummary}` : null
  ]
    .filter(Boolean)
    .join("\n");

  return addBrainEntry(session, {
    missionId: task.missionId,
    taskId: task.id,
    sourceType: "task",
    category,
    scope: task.missionId ? "mission" : "repo",
    title,
    content,
    tags: [...task.claimedPaths, task.owner, task.kind],
    confidence: task.summary?.trim() ? 0.76 : 0.6,
    freshness: "live",
    evidence: [...task.claimedPaths],
    commands: [],
    pinned: false
  });
}

export function captureLandingBrainEntry(
  session: SessionRecord,
  targetBranch: string,
  summaryLines: string[]
): BrainEntry {
  return addBrainEntry(session, {
    missionId: session.missions.at(-1)?.id ?? null,
    taskId: null,
    sourceType: "landing",
    category: "artifact",
    scope: "repo",
    title: `Landing report for ${targetBranch}`,
    content: summaryLines.join("\n"),
    tags: [targetBranch, "landing"],
    confidence: 0.95,
    freshness: "live",
    evidence: [],
    commands: [],
    pinned: false
  });
}

export function setBrainEntryPinned(
  session: SessionRecord,
  entryId: string,
  pinned: boolean
): BrainEntry | null {
  const entry = (Array.isArray(session.brain) ? session.brain : []).find((item) => item.id === entryId) ?? null;
  if (!entry) {
    return null;
  }

  entry.pinned = pinned;
  entry.updatedAt = nowIso();
  return entry;
}

export async function captureRepoTopologyBrainEntries(
  session: SessionRecord,
  repoRoot: string,
  _missionId: string | null = null
): Promise<BrainEntry[]> {
  const cartography = await cartographRepo(repoRoot);
  if (cartography.files.length === 0) {
    return [];
  }

  const topology = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "topology",
    scope: "repo",
    title: "Repo topology",
    content: [
      `Root directories: ${cartography.rootDirectories.join(", ") || "-"}`,
      `Entry surfaces: ${cartography.entrypoints.join(", ") || "-"}`,
      `Signals: ${cartography.tags.join(", ") || "-"}`,
      `Representative files: ${cartography.files.slice(0, 18).join(", ")}`
    ].join("\n"),
    tags: [...cartography.tags, ...cartography.rootDirectories],
    confidence: 0.82,
    freshness: "live",
    evidence: [...cartography.entrypoints, ...cartography.files.slice(0, 18)],
    commands: cartography.commands,
    pinned: false
  });

  const runbook = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "procedure",
    scope: "repo",
    title: "Repo runbook",
    content: [
      `Likely verification commands: ${cartography.commands.join(" | ") || "-"}`,
      cartography.packageScripts.length > 0
        ? `Package scripts: ${cartography.packageScripts.join(" | ")}`
        : "Package scripts: -"
    ].join("\n"),
    tags: [...cartography.tags, "runbook", "verification"],
    confidence: 0.8,
    freshness: "live",
    evidence: [...cartography.entrypoints],
    commands: cartography.commands,
    pinned: false
  });

  const structure = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "topology",
    scope: "repo",
    title: "Repo structure graph",
    content: [
      `Local module edges: ${cartography.localEdges.length > 0 ? cartography.localEdges.slice(0, 16).map((edge) => `${edge.from} -> ${edge.to}`).join(" | ") : "-"}`,
      `External dependencies: ${cartography.commonExternalTargets.join(", ") || "-"}`,
      `Internal dependency hotspots: ${cartography.commonLocalTargets.join(", ") || "-"}`
    ].join("\n"),
    tags: [...cartography.tags, ...cartography.commonLocalTargets, ...cartography.commonExternalTargets],
    confidence: 0.74,
    freshness: "live",
    evidence: unique([
      ...cartography.localEdges.slice(0, 12).map((edge) => edge.from),
      ...cartography.entrypoints
    ]),
    commands: cartography.commands,
    pinned: false
  });

  const contracts = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "contract",
    scope: "repo",
    title: "Repo contract surfaces",
    content: [
      `Contract surfaces: ${cartography.contractSurfaces.join(", ") || "-"}`,
      `Route surfaces: ${cartography.routeSurfaces.join(", ") || "-"}`,
      `Service surfaces: ${cartography.serviceSurfaces.join(", ") || "-"}`
    ].join("\n"),
    tags: [...cartography.tags, ...cartography.contractSurfaces.slice(0, 8), ...cartography.routeSurfaces.slice(0, 6)],
    confidence: 0.77,
    freshness: "live",
    evidence: unique([
      ...cartography.contractSurfaces.slice(0, 10),
      ...cartography.routeSurfaces.slice(0, 8)
    ]),
    commands: cartography.commands,
    pinned: false
  });

  const verification = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "verification",
    scope: "repo",
    title: "Repo verification surfaces",
    content: [
      `Verification files: ${cartography.verificationSurfaces.join(", ") || "-"}`,
      `Likely commands: ${cartography.commands.join(" | ") || "-"}`,
      `External dependencies: ${cartography.commonExternalTargets.join(", ") || "-"}`
    ].join("\n"),
    tags: [...cartography.tags, "verification", ...cartography.verificationSurfaces.slice(0, 8)],
    confidence: 0.79,
    freshness: "live",
    evidence: unique([
      ...cartography.verificationSurfaces.slice(0, 10),
      ...cartography.entrypoints.slice(0, 4)
    ]),
    commands: cartography.commands,
    pinned: false
  });

  const routes = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "topology",
    scope: "repo",
    title: "Repo route and entry surfaces",
    content: [
      `Route entrypoints: ${cartography.routeEntrypoints.join(", ") || "-"}`,
      `Service surfaces: ${cartography.serviceSurfaces.join(", ") || "-"}`,
      `Dependency hotspots: ${cartography.dependencyHotspots.join(", ") || "-"}`
    ].join("\n"),
    tags: [...cartography.tags, "routes", ...cartography.routeEntrypoints.slice(0, 8)],
    confidence: 0.76,
    freshness: "live",
    evidence: unique([
      ...cartography.routeEntrypoints.slice(0, 10),
      ...cartography.serviceSurfaces.slice(0, 8)
    ]),
    commands: cartography.commands,
    pinned: false
  });

  const verificationMatrix = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "verification",
    scope: "repo",
    title: "Repo verification matrix",
    content: [
      `Test commands: ${cartography.testCommands.join(" | ") || "-"}`,
      `Build commands: ${cartography.buildCommands.join(" | ") || "-"}`,
      `Verification surfaces: ${cartography.verificationSurfaces.join(", ") || "-"}`
    ].join("\n"),
    tags: [...cartography.tags, "verification-matrix", ...cartography.verificationSurfaces.slice(0, 8)],
    confidence: 0.81,
    freshness: "live",
    evidence: unique([
      ...cartography.verificationSurfaces.slice(0, 10),
      ...cartography.routeEntrypoints.slice(0, 4)
    ]),
    commands: unique([...cartography.testCommands, ...cartography.buildCommands]),
    pinned: false
  });

  return [topology, runbook, structure, contracts, verification, routes, verificationMatrix];
}

export function retireBrainEntry(
  session: SessionRecord,
  entryId: string
): BrainEntry | null {
  const entry = (Array.isArray(session.brain) ? session.brain : []).find((item) => item.id === entryId) ?? null;
  if (!entry) {
    return null;
  }

  entry.retiredAt = nowIso();
  entry.freshness = "stale";
  entry.updatedAt = entry.retiredAt;
  return entry;
}

export function mergeBrainEntries(
  session: SessionRecord,
  targetEntryId: string,
  sourceEntryId: string
): BrainEntry | null {
  const target = (Array.isArray(session.brain) ? session.brain : []).find((item) => item.id === targetEntryId) ?? null;
  const source = (Array.isArray(session.brain) ? session.brain : []).find((item) => item.id === sourceEntryId) ?? null;
  if (!target || !source || target.id === source.id) {
    return null;
  }

  target.tags = unique([...target.tags, ...source.tags]);
  target.evidence = unique([...(target.evidence ?? []), ...(source.evidence ?? [])]);
  target.commands = unique([...(target.commands ?? []), ...(source.commands ?? [])]);
  target.supersedes = unique([...(target.supersedes ?? []), source.id, ...(source.supersedes ?? [])]);
  target.contradictions = unique(
    [ ...(target.contradictions ?? []), ...(source.contradictions ?? []) ].filter((item) => item !== source.id)
  );
  target.content = unique([target.content, source.content]).join("\n\n");
  target.confidence = Math.max(target.confidence ?? 0.6, source.confidence ?? 0.6);
  target.updatedAt = nowIso();

  source.retiredAt = target.updatedAt;
  source.freshness = "stale";
  source.supersededBy = target.id;
  return target;
}

export function searchBrainEntries(
  session: SessionRecord,
  query: string,
  limit = 8
): BrainEntry[] {
  return queryBrainEntries(session, {
    query,
    limit
  });
}

export function queryBrainEntries(
  session: SessionRecord,
  options: BrainSearchOptions = {}
): BrainEntry[] {
  const tokens = tokenize(options.query ?? "");
  const pathTokens = tokenizePath(options.path ?? "");
  const normalizedQuery = normalizeText(options.query ?? "");
  const normalizedPath = normalizeText(options.path ?? "");
  const limit = Math.max(1, options.limit ?? 8);
  const includeRetired = options.includeRetired === true;

  const scopedEntries = [...(Array.isArray(session.brain) ? session.brain : [])]
    .filter((entry) => includeRetired || !entry.retiredAt)
    .filter((entry) => options.category && options.category !== "all" ? (entry.category ?? "artifact") === options.category : true)
    .filter((entry) => options.scope && options.scope !== "all" ? (entry.scope ?? "repo") === options.scope : true)
    .filter((entry) => options.missionId ? entry.missionId === options.missionId : true);

  if (tokens.length === 0 && pathTokens.length === 0) {
    return scopedEntries
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  return scopedEntries
    .map((entry) => {
      const haystack = new Set([
        ...tokenize(entry.title),
        ...tokenize(entry.content),
        ...entry.tags.map((tag) => normalizeText(tag)),
        ...(entry.evidence ?? []).flatMap((item) => tokenize(item)),
        ...(entry.commands ?? []).flatMap((item) => tokenize(item))
      ]);
      let score = entry.pinned ? 5 : 0;
      score += Math.round((entry.confidence ?? 0.6) * 4);
      score += inferFreshness(entry.updatedAt) === "live" ? 2 : inferFreshness(entry.updatedAt) === "recent" ? 1 : -1;
      if ((entry.category ?? "artifact") === "fact" || (entry.category ?? "artifact") === "decision") {
        score += 1;
      }
      if ((entry.contradictions ?? []).length > 0) {
        score -= 1;
      }
      if (entry.supersededBy) {
        score -= 2;
      }
      for (const token of tokens) {
        if (haystack.has(token)) {
          score += 3;
        } else if ([...haystack].some((candidate) => candidate.includes(token) || token.includes(candidate))) {
          score += 1;
        }
      }

      if (normalizedQuery && normalizeText(entry.title).includes(normalizedQuery)) {
        score += 4;
      }

      if (normalizedPath) {
        score += structuralTokenOverlap(entry, [normalizedPath]) * 2;
      }

      if (pathTokens.length > 0 && (entry.evidence ?? []).some((item) => pathTokens.some((token) => normalizeText(item).includes(token)))) {
        score += 4;
      }

      if (entry.sourceType === "pattern") {
        score += 1;
      }

      return {
        entry,
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function relevantBrainEntries(
  session: SessionRecord,
  task: TaskSpec | null,
  limit = 4
): BrainEntry[] {
  const missionId = task?.missionId ?? null;
  const claimedPaths = new Set(task?.claimedPaths ?? []);
  const query = [
    task?.title ?? "",
    task?.prompt ?? "",
    [...claimedPaths].join(" ")
  ].join(" ");

  const weighted = [...(Array.isArray(session.brain) ? session.brain : [])]
    .filter((entry) => !entry.retiredAt)
    .map((entry) => {
      let score = 0;
      if (entry.pinned) {
        score += 8;
      }
      if (missionId && entry.missionId === missionId) {
        score += 6;
      }
      if (entry.tags.some((tag) => claimedPaths.has(tag))) {
        score += 4;
      }
      if ((entry.evidence ?? []).some((item) => claimedPaths.has(item))) {
        score += 4;
      }
      score += Math.min(6, structuralTokenOverlap(entry, [...claimedPaths]));
      if (entry.sourceType === "pattern") {
        score += 2;
      }
      if (entry.scope === "repo") {
        score += 1;
      }
      if (entry.category === "fact" || entry.category === "procedure") {
        score += 1;
      }
      if (task?.nodeKind === "frontend" && entry.tags.some((tag) => /web|ui|frontend|page|component/i.test(tag))) {
        score += 3;
      }
      if (task?.nodeKind === "backend" && entry.tags.some((tag) => /api|server|backend|schema|worker|domain/i.test(tag))) {
        score += 3;
      }
      if (task?.nodeKind === "repair" && (entry.category === "risk" || entry.sourceType === "pattern")) {
        score += 3;
      }
      if (entry.supersededBy) {
        score -= 3;
      }
      if ((entry.contradictions ?? []).length > 0) {
        score -= 1;
      }
      score += Math.round((entry.confidence ?? 0.6) * 4);
      if (inferFreshness(entry.updatedAt) === "live") {
        score += 2;
      }
      const searchScore = searchBrainEntries({
        ...session,
        brain: [entry]
      }, query, 1).length > 0 ? 2 : 0;
      score += searchScore;
      return {
        entry,
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry);

  if (weighted.length > 0) {
    return weighted;
  }

  return searchBrainEntries(session, query, limit);
}

function dominantValue<T extends string>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
}

function packSection(
  key: string,
  title: string,
  rationale: string,
  entries: BrainEntry[],
  limit: number
): BrainPackSection | null {
  const uniqueEntries = uniqBrainEntries(entries).slice(0, limit);
  if (uniqueEntries.length === 0) {
    return null;
  }
  return {
    key,
    title,
    rationale,
    entries: uniqueEntries
  };
}

export function buildBrainPack(
  session: SessionRecord,
  options: {
    missionId?: string | null;
    task?: TaskSpec | null;
    phase?: BrainPackPhase;
    path?: string | null;
    includeRetired?: boolean;
    limit?: number;
  } = {}
): BrainPack {
  const limit = Math.max(2, options.limit ?? 4);
  const includeRetired = options.includeRetired === true;
  const missionId = options.task?.missionId ?? options.missionId ?? null;
  const task = options.task ?? null;
  const phase = options.phase ?? inferBrainPackPhase(task);
  const pathHint = options.path ?? task?.claimedPaths[0] ?? null;
  const missionEntries = (Array.isArray(session.brain) ? session.brain : [])
    .filter((entry) => (includeRetired || !entry.retiredAt))
    .filter((entry) => (missionId ? entry.missionId === missionId : false));
  const pathEntries = queryBrainEntries(session, {
    missionId,
    path: pathHint,
    includeRetired,
    limit: Math.max(limit * 2, 8)
  });
  const relevant = task
    ? relevantBrainEntries(session, task, Math.max(limit * 2, 8))
    : queryBrainEntries(session, {
        missionId,
        path: pathHint,
        includeRetired,
        limit: Math.max(limit * 2, 8)
      });
  const repoTopology = queryBrainEntries(session, {
    category: "topology",
    scope: "repo",
    includeRetired,
    limit
  });
  const contracts = uniqBrainEntries([
    ...missionEntries.filter((entry) => entry.category === "contract"),
    ...queryBrainEntries(session, {
      missionId,
      category: "contract",
      includeRetired,
      limit
    })
  ]);
  const procedures = queryBrainEntries(session, {
    missionId,
    category: "procedure",
    includeRetired,
    limit: Math.max(limit * 2, 8)
  });
  const risks = uniqBrainEntries([
    ...missionEntries.filter((entry) => entry.category === "risk" || entry.category === "failure"),
    ...queryBrainEntries(session, {
      missionId,
      category: "risk",
      includeRetired,
      limit
    }),
    ...queryBrainEntries(session, {
      missionId,
      category: "failure",
      includeRetired,
      limit
    })
  ]);
  const verification = uniqBrainEntries([
    ...missionEntries.filter((entry) => entry.category === "verification" || entry.category === "contract"),
    ...queryBrainEntries(session, {
      missionId,
      category: "verification",
      includeRetired,
      limit: Math.max(limit * 2, 8)
    })
  ]);
  const patterns = (Array.isArray(session.brain) ? session.brain : [])
    .filter((entry) => (includeRetired || !entry.retiredAt))
    .filter((entry) => entry.sourceType === "pattern")
    .filter((entry) => relevant.some((item) => item.id === entry.id) || pathEntries.some((item) => item.id === entry.id));

  const sections: BrainPackSection[] = [];
  const maybeSections = phase === "planning"
    ? [
        packSection("mission", "Mission frame", "Spec, blueprint, and explicit mission decisions to preserve intent.", missionEntries.filter((entry) => entry.category === "fact" || entry.category === "decision" || entry.category === "contract"), limit),
        packSection("topology", "Repo cartography", "Structural repo map and service/layout signals for planning.", repoTopology, limit),
        packSection("procedures", "Procedures", "Runnable commands and repo runbook context.", procedures, limit),
        packSection("patterns", "Pattern leverage", "Prior successful patterns relevant to this mission slice.", patterns, limit),
        packSection("risks", "Risks", "Known mission risks, contradictions, or failure signals before execution.", risks, limit)
      ]
    : phase === "repair"
      ? [
          packSection("failures", "Failure context", "Recent failures and risky areas most relevant to the current repair.", risks, limit),
          packSection("verification", "Verification signals", "Checks, acceptance, and evidence needed to close the repair loop.", verification, limit),
          packSection("topology", "Repo cartography", "Structural targets and file surfaces touched by the repair.", uniqBrainEntries([...pathEntries, ...repoTopology]), limit),
          packSection("procedures", "Recovery procedures", "Commands and runbook steps useful during repair work.", procedures, limit)
        ]
      : phase === "verification"
        ? [
            packSection("verification", "Verification context", "Acceptance, test, and verification knowledge for this mission.", verification, limit),
            packSection("contracts", "Contracts and expectations", "Shared contracts and acceptance obligations to validate.", contracts, limit),
            packSection("topology", "Touched surfaces", "Structural targets and changed-path context for verification.", uniqBrainEntries([...pathEntries, ...repoTopology]), limit),
            packSection("risks", "Residual risks", "Known contradictions or unresolved risks that can invalidate done-ness.", risks, limit)
          ]
        : [
            packSection("implementation", "Implementation context", "Most relevant repo and mission memory for the current execution slice.", uniqBrainEntries([...relevant, ...pathEntries]), limit),
            packSection("contracts", "Shared contracts", "Constraints, interfaces, and mission contract expectations.", contracts, limit),
            packSection("topology", "Repo cartography", "Structural map of the code surfaces most likely to matter.", uniqBrainEntries([...pathEntries, ...repoTopology]), limit),
            packSection("procedures", "Runbook and procedures", "Helpful commands and repo-specific working habits.", procedures, limit),
            packSection("risks", "Risks", "Known fragile areas or failure signals to keep in mind while editing.", risks, limit)
          ];

  for (const section of maybeSections) {
    if (section) {
      sections.push(section);
    }
  }

  const summary = [
    `Phase: ${phase}`,
    `Mission entries: ${missionEntries.length}`,
    `Relevant memory: ${relevant.length}`,
    `Topology signals: ${repoTopology.length}`,
    `Contracts: ${contracts.length}`,
    `Verification signals: ${verification.length}`,
    `Risks/failures: ${risks.length}`
  ].join(" | ");

  return {
    missionId,
    phase,
    summary,
    pathHint,
    sections
  };
}

export function buildBrainReviewQueue(
  session: SessionRecord,
  options: {
    missionId?: string | null;
    includeRetired?: boolean;
    limit?: number;
  } = {}
): BrainReviewItem[] {
  const includeRetired = options.includeRetired === true;
  const limit = Math.max(1, options.limit ?? 20);
  const entries = (Array.isArray(session.brain) ? session.brain : [])
    .filter((entry) => includeRetired || !entry.retiredAt || entry.pinned)
    .filter((entry) => (options.missionId ? entry.missionId === options.missionId : true));

  const duplicateTitleCounts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.category ?? "artifact"}:${entry.scope ?? "repo"}:${normalizeText(entry.title)}`;
    duplicateTitleCounts.set(key, (duplicateTitleCounts.get(key) ?? 0) + 1);
  }

  const reviewItems = entries
    .map((entry) => {
      const reasons: string[] = [];
      if ((entry.contradictions ?? []).length > 0) {
        reasons.push(`Contradicted by ${(entry.contradictions ?? []).length} related entr${(entry.contradictions ?? []).length === 1 ? "y" : "ies"}.`);
      }
      if (entry.supersededBy && !entry.retiredAt) {
        reasons.push(`Superseded by ${entry.supersededBy} but still active.`);
      }
      if ((entry.freshness ?? inferFreshness(entry.updatedAt)) === "stale" && !entry.retiredAt) {
        reasons.push("Stale and should be reviewed for freshness.");
      }
      if (entry.pinned && entry.retiredAt) {
        reasons.push("Pinned entry is retired and may need operator cleanup.");
      }
      const duplicateKey = `${entry.category ?? "artifact"}:${entry.scope ?? "repo"}:${normalizeText(entry.title)}`;
      if ((duplicateTitleCounts.get(duplicateKey) ?? 0) > 1 && !entry.retiredAt) {
        reasons.push("Shares a duplicated title cluster and may benefit from distillation.");
      }
      if ((entry.confidence ?? 0.6) < 0.55 && !entry.retiredAt) {
        reasons.push("Low confidence entry is still active.");
      }
      if (reasons.length === 0) {
        return null;
      }

      const severity: BrainReviewItem["severity"] =
        reasons.some((reason) => /Contradicted|Superseded/.test(reason))
          ? "high"
          : reasons.some((reason) => /Stale|Pinned/.test(reason))
            ? "medium"
            : "low";
      const recommendedAction =
        severity === "high"
          ? "Compare, merge, or retire this entry before relying on it heavily."
          : severity === "medium"
            ? "Review freshness or pin state and decide whether to keep it active."
            : "Consider distilling or merging this entry to reduce Brain noise.";

      return {
        entryId: entry.id,
        title: entry.title,
        category: entry.category ?? null,
        scope: entry.scope ?? null,
        severity,
        reasons,
        recommendedAction
      } satisfies BrainReviewItem;
    })
    .filter((item): item is BrainReviewItem => item !== null)
    .sort((left, right) => {
      const severityWeight = { high: 3, medium: 2, low: 1 };
      return severityWeight[right.severity] - severityWeight[left.severity] ||
        left.title.localeCompare(right.title);
    })
    .slice(0, limit);

  return reviewItems;
}

export function buildBrainDistillationPlan(
  session: SessionRecord,
  options: {
    missionId?: string | null;
    category?: BrainEntry["category"] | "all";
    scope?: BrainEntry["scope"] | "all";
    query?: string;
    limit?: number;
  } = {}
): BrainDistillationPlan | null {
  const limit = Math.max(2, options.limit ?? 8);
  const candidates = queryBrainEntries(session, {
    missionId: options.missionId ?? null,
    query: options.query ?? "",
    category: options.category ?? "all",
    scope: options.scope ?? "all",
    includeRetired: false,
    limit: Math.max(limit * 2, 12)
  }).filter((entry) => !entry.retiredAt);

  if (candidates.length < 2) {
    return null;
  }

  const selected = candidates.slice(0, limit);
  const category = dominantValue(
    selected.map((entry) => entry.category ?? "artifact"),
    "artifact"
  );
  const scope = dominantValue(
    selected.map((entry) => entry.scope ?? (entry.missionId ? "mission" : "repo")),
    options.missionId ? "mission" : "repo"
  );
  const missionId = options.missionId ?? dominantValue(
    selected.map((entry) => entry.missionId ?? "__repo__"),
    "__repo__"
  );
  const realMissionId = missionId === "__repo__" ? null : missionId;
  const tags = unique(selected.flatMap((entry) => entry.tags)).slice(0, 12);
  const evidence = unique(selected.flatMap((entry) => entry.evidence ?? [])).slice(0, 12);
  const commands = unique(selected.flatMap((entry) => entry.commands ?? [])).slice(0, 8);
  const headline = realMissionId
    ? `Distilled ${category} context for ${realMissionId}`
    : `Distilled ${scope} ${category} context`;
  const content = [
    `Distilled from ${selected.length} Brain entries.`,
    `Key entries: ${selected.map((entry) => entry.title).join(" | ")}`,
    `Shared signals: ${tags.join(", ") || "-"}`,
    `Evidence: ${evidence.join(", ") || "-"}`,
    `Commands: ${commands.join(" | ") || "-"}`,
    "Key points:",
    ...selected.slice(0, 5).map((entry) => `- ${entry.title}: ${shortText(entry.content, 180)}`)
  ].join("\n");

  return {
    title: headline,
    category,
    scope,
    missionId: realMissionId,
    sourceEntryIds: selected.map((entry) => entry.id),
    content,
    tags,
    evidence,
    commands
  };
}

export function applyBrainDistillationPlan(
  session: SessionRecord,
  plan: BrainDistillationPlan
): BrainEntry {
  const entry = addBrainEntry(session, {
    missionId: plan.missionId,
    taskId: null,
    sourceType: "operator",
    category: plan.category,
    scope: plan.scope,
    title: plan.title,
    content: plan.content,
    tags: plan.tags,
    confidence: 0.9,
    freshness: "live",
    evidence: plan.evidence,
    commands: plan.commands,
    supersedes: plan.sourceEntryIds,
    pinned: false
  });

  const retiredAt = nowIso();
  for (const sourceId of plan.sourceEntryIds) {
    const source = (Array.isArray(session.brain) ? session.brain : []).find((item) => item.id === sourceId) ?? null;
    if (!source || source.id === entry.id || source.pinned) {
      continue;
    }
    source.retiredAt = retiredAt;
    source.updatedAt = retiredAt;
    source.freshness = "stale";
    source.supersededBy = entry.id;
  }

  return entry;
}

export function relatedBrainEntries(
  session: SessionRecord,
  entryId: string,
  limit = 5
): BrainEntry[] {
  const entries = Array.isArray(session.brain) ? session.brain : [];
  const selected = entries.find((item) => item.id === entryId) ?? null;
  if (!selected) {
    return [];
  }

  const selectedTokens = new Set([
    ...tokenize(selected.title),
    ...tokenize(selected.content),
    ...(selected.tags ?? []).flatMap((tag) => tokenize(tag)),
    ...(selected.evidence ?? []).flatMap((item) => tokenize(item))
  ]);

  return entries
    .filter((entry) => entry.id !== selected.id)
    .map((entry) => {
      let score = 0;
      if (entry.id === selected.supersededBy || selected.supersededBy === entry.id) {
        score += 12;
      }
      if ((selected.supersedes ?? []).includes(entry.id) || (entry.supersedes ?? []).includes(selected.id)) {
        score += 10;
      }
      if ((selected.contradictions ?? []).includes(entry.id) || (entry.contradictions ?? []).includes(selected.id)) {
        score += 9;
      }
      if (selected.missionId && entry.missionId === selected.missionId) {
        score += 4;
      }
      if (selected.taskId && entry.taskId === selected.taskId) {
        score += 3;
      }
      const sharedPathCount = overlapCount(brainPathSignals(selected), brainPathSignals(entry));
      score += Math.min(6, sharedPathCount * 2);
      const sharedCommandCount = overlapCount(brainCommandSignals(selected), brainCommandSignals(entry));
      score += Math.min(4, sharedCommandCount * 2);
      if ((selected.scope ?? "repo") === (entry.scope ?? "repo")) {
        score += 1;
      }
      if ((selected.category ?? "artifact") === (entry.category ?? "artifact")) {
        score += 1;
      }
      const entryTokens = new Set([
        ...tokenize(entry.title),
        ...tokenize(entry.content),
        ...(entry.tags ?? []).flatMap((tag) => tokenize(tag)),
        ...(entry.evidence ?? []).flatMap((item) => tokenize(item))
      ]);
      const sharedTokens = [...selectedTokens].filter((token) => entryTokens.has(token)).length;
      score += Math.min(8, sharedTokens);
      if (entry.pinned) {
        score += 2;
      }
      if (!entry.retiredAt) {
        score += 1;
      }
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry);
}

function uniqBrainEntries(entries: BrainEntry[]): BrainEntry[] {
  const seen = new Set<string>();
  const uniqueEntries: BrainEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    uniqueEntries.push(entry);
  }
  return uniqueEntries;
}

function brainGraphNode(entry: BrainEntry): BrainGraphNode {
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category ?? null,
    scope: entry.scope ?? null,
    missionId: entry.missionId ?? null,
    taskId: entry.taskId ?? null,
    pinned: entry.pinned === true,
    retired: Boolean(entry.retiredAt),
    freshness: entry.freshness ?? null,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function graphModeNodePredicate(mode: BrainGraphMode, node: BrainGraphNode): boolean {
  switch (mode) {
    case "all":
      return true;
    case "structural":
      return node.category === "topology" || node.category === "contract" || node.category === "verification";
    case "knowledge":
      return node.category !== "topology" && node.category !== "verification";
    case "topology":
      return node.category === "topology" || node.category === "contract";
    case "failure":
      return node.category === "failure" || node.category === "risk" || node.category === "verification";
    case "contract":
      return node.category === "contract" || node.category === "topology" || node.category === "verification";
    case "timeline":
      return true;
  }
}

function graphModeEdgePredicate(mode: BrainGraphMode, edge: BrainGraphEdge): boolean {
  switch (mode) {
    case "all":
      return true;
    case "structural":
      return ["mission", "task", "evidence", "command", "scope", "category"].includes(edge.kind);
    case "knowledge":
      return ["supersedes", "contradicts", "tag", "category"].includes(edge.kind);
    case "topology":
      return ["evidence", "command", "scope", "category", "tag"].includes(edge.kind);
    case "failure":
      return ["contradicts", "supersedes", "tag", "evidence", "timeline"].includes(edge.kind);
    case "contract":
      return ["mission", "task", "evidence", "command", "tag", "timeline"].includes(edge.kind);
    case "timeline":
      return edge.kind === "timeline" || edge.kind === "mission" || edge.kind === "task";
  }
}

export function filterBrainGraphMode(
  graph: BrainGraph,
  mode: BrainGraphMode
): BrainGraph {
  if (mode === "all") {
    return graph;
  }

  const visibleNodeIds = new Set(
    graph.nodes.filter((node) => graphModeNodePredicate(mode, node)).map((node) => node.id)
  );
  if (graph.focusEntryId) {
    visibleNodeIds.add(graph.focusEntryId);
  }

  const edges = graph.edges.filter((edge) =>
    graphModeEdgePredicate(mode, edge) &&
    visibleNodeIds.has(edge.from) &&
    visibleNodeIds.has(edge.to)
  );
  for (const edge of edges) {
    visibleNodeIds.add(edge.from);
    visibleNodeIds.add(edge.to);
  }

  return {
    ...graph,
    edges,
    nodes: graph.nodes.filter((node) => visibleNodeIds.has(node.id))
  };
}

function sharedBrainSignals(entry: BrainEntry): string[] {
  return unique([
    ...(entry.tags ?? []),
    ...((entry.evidence ?? []).slice(0, 8))
  ]);
}

function pushBrainGraphEdge(
  edges: BrainGraphEdge[],
  edge: BrainGraphEdge
): void {
  if (edge.from === edge.to) {
    return;
  }

  if (
    edges.some(
      (item) =>
        item.from === edge.from &&
        item.to === edge.to &&
        item.kind === edge.kind
    )
  ) {
    return;
  }
  edges.push(edge);
}

export function buildBrainGraph(
  session: SessionRecord,
  options: {
    entryId?: string | null;
    missionId?: string | null;
    path?: string | null;
    includeRetired?: boolean;
    limit?: number;
  } = {}
): BrainGraph {
  const entries = Array.isArray(session.brain) ? session.brain : [];
  const includeRetired = options.includeRetired === true;
  const limit = Math.max(1, options.limit ?? 12);
  const focus =
    typeof options.entryId === "string" && options.entryId.trim()
      ? entries.find((entry) => entry.id === options.entryId.trim()) ?? null
      : null;

  const pool: BrainEntry[] = [];
  if (focus) {
    pool.push(focus);
    const explicitIds = unique([
      ...(focus.supersedes ?? []),
      ...(focus.supersededBy ? [focus.supersededBy] : []),
      ...(focus.contradictions ?? [])
    ]);
    for (const entryId of explicitIds) {
      const entry = entries.find((candidate) => candidate.id === entryId) ?? null;
      if (entry) {
        pool.push(entry);
      }
    }
    pool.push(...relatedBrainEntries(session, focus.id, Math.max(1, limit - pool.length)));
  }

  if (options.missionId) {
    pool.push(
      ...entries
        .filter((entry) => entry.missionId === options.missionId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
    );
  }

  if (options.path) {
    pool.push(
      ...queryBrainEntries(session, {
        path: options.path,
        missionId: options.missionId ?? null,
        includeRetired,
        limit
      })
    );
  }

  if (pool.length === 0) {
    pool.push(
      ...queryBrainEntries(session, {
        missionId: options.missionId ?? null,
        includeRetired,
        limit
      })
    );
  }

  const scopedEntries = uniqBrainEntries(
    pool.filter((entry) => includeRetired || !entry.retiredAt)
  ).slice(0, limit);
  const scopedIds = new Set(scopedEntries.map((entry) => entry.id));
  const edges: BrainGraphEdge[] = [];

  for (const entry of scopedEntries) {
    for (const supersededEntryId of entry.supersedes ?? []) {
      if (scopedIds.has(supersededEntryId)) {
        pushBrainGraphEdge(edges, {
          from: entry.id,
          to: supersededEntryId,
          kind: "supersedes",
          weight: 5,
          label: "supersedes"
        });
      }
    }

    if (entry.supersededBy && scopedIds.has(entry.supersededBy)) {
      pushBrainGraphEdge(edges, {
        from: entry.supersededBy,
        to: entry.id,
        kind: "supersedes",
        weight: 5,
        label: "supersedes"
      });
    }

    for (const contradiction of entry.contradictions ?? []) {
      if (scopedIds.has(contradiction) && entry.id < contradiction) {
        pushBrainGraphEdge(edges, {
          from: entry.id,
          to: contradiction,
          kind: "contradicts",
          weight: 4,
          label: "contradicts"
        });
      }
    }
  }

  for (let index = 0; index < scopedEntries.length; index += 1) {
    const left = scopedEntries[index];
    if (!left) {
      continue;
    }
    for (let innerIndex = index + 1; innerIndex < scopedEntries.length; innerIndex += 1) {
      const right = scopedEntries[innerIndex];
      if (!right) {
        continue;
      }

      if (left.missionId && right.missionId && left.missionId === right.missionId) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "mission",
          weight: 2,
          label: "same mission"
        });
      }

      if (left.taskId && right.taskId && left.taskId === right.taskId) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "task",
          weight: 2,
          label: "same task"
        });
      }

      const sharedSignals = overlapCount(sharedBrainSignals(left), sharedBrainSignals(right));
      if (sharedSignals >= 2) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "tag",
          weight: Math.min(5, sharedSignals),
          label: `${sharedSignals} shared signals`
        });
      }

      const sharedPathCount = overlapCount(brainPathSignals(left), brainPathSignals(right));
      if (sharedPathCount >= 1) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "evidence",
          weight: Math.min(5, sharedPathCount + 1),
          label: `${sharedPathCount} shared path signal${sharedPathCount === 1 ? "" : "s"}`
        });
      }

      const sharedCommandCount = overlapCount(brainCommandSignals(left), brainCommandSignals(right));
      if (sharedCommandCount >= 1) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "command",
          weight: Math.min(5, sharedCommandCount + 1),
          label: `${sharedCommandCount} shared command famil${sharedCommandCount === 1 ? "y" : "ies"}`
        });
      }

      if ((left.scope ?? "repo") === (right.scope ?? "repo")) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "scope",
          weight: 1,
          label: `same scope: ${left.scope ?? "repo"}`
        });
      }

      if ((left.category ?? "artifact") === (right.category ?? "artifact")) {
        pushBrainGraphEdge(edges, {
          from: left.id,
          to: right.id,
          kind: "category",
          weight: 1,
          label: `same category: ${left.category ?? "artifact"}`
        });
      }
    }
  }

  const timelineEntries = [...scopedEntries].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  for (let index = 1; index < timelineEntries.length; index += 1) {
    const previous = timelineEntries[index - 1];
    const next = timelineEntries[index];
    if (!previous || !next) {
      continue;
    }
    if (
      previous.missionId &&
      next.missionId &&
      previous.missionId !== next.missionId &&
      previous.scope !== next.scope
    ) {
      continue;
    }
    pushBrainGraphEdge(edges, {
      from: previous.id,
      to: next.id,
      kind: "timeline",
      weight: 1,
      label: "next in time"
    });
  }

  return {
    focusEntryId: focus?.id ?? null,
    nodes: scopedEntries.map(brainGraphNode),
    edges: edges.sort((left, right) => right.weight - left.weight || left.kind.localeCompare(right.kind))
  };
}

export function explainBrainEntry(session: SessionRecord, entryId: string): string[] {
  const entry = (Array.isArray(session.brain) ? session.brain : []).find((item) => item.id === entryId) ?? null;
  if (!entry) {
    return [];
  }

  const related = relatedBrainEntries(session, entryId, 4);
  const graph = buildBrainGraph(session, {
    entryId,
    missionId: entry.missionId ?? null,
    limit: 8
  });
  const neighborhood = graph.edges
    .filter((edge) => edge.from === entry.id || edge.to === entry.id)
    .map((edge) => {
      const adjacentId = edge.from === entry.id ? edge.to : edge.from;
      return `${edge.label} -> ${adjacentId}`;
    });

  return [
    `Title: ${entry.title}`,
    `Category: ${entry.category ?? "artifact"} | Scope: ${entry.scope ?? (entry.missionId ? "mission" : "repo")}`,
    `Confidence: ${((entry.confidence ?? 0.6) * 100).toFixed(0)}% | Freshness: ${entry.freshness ?? inferFreshness(entry.updatedAt)}`,
    `Source: ${entry.sourceType} | Mission: ${entry.missionId ?? "-"} | Task: ${entry.taskId ?? "-"}`,
    `Evidence: ${(entry.evidence ?? []).join(", ") || "-"}`,
    `Commands: ${(entry.commands ?? []).join(" | ") || "-"}`,
    `Command families: ${brainCommandSignals(entry).join(", ") || "-"}`,
    `Structural signals: ${unique([...(entry.tags ?? []), ...((entry.evidence ?? []).slice(0, 8))]).join(", ") || "-"}`,
    `Path signals: ${brainPathSignals(entry).join(", ") || "-"}`,
    `Supersedes: ${(entry.supersedes ?? []).join(", ") || "-"}`,
    `Superseded by: ${entry.supersededBy ?? "-"}`,
    `Contradictions: ${(entry.contradictions ?? []).join(", ") || "-"}`,
    `Retired: ${entry.retiredAt ?? "no"}`,
    `Tags: ${entry.tags.join(", ") || "-"}`,
    `Related: ${related.map((item) => `${item.id}:${item.title}`).join(" | ") || "-"}`,
    `Graph neighbors: ${neighborhood.join(" | ") || "-"}`
  ];
}
