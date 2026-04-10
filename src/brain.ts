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
}

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
    | "category";
  weight: number;
  label: string;
}

export interface BrainGraph {
  focusEntryId: string | null;
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
    return (
      (normalizeText(entry.title) === normalizeText(input.title) || entrySimilarity(entry, input) >= 0.45) &&
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
        category: "procedure",
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
  const content = [
    shortText(task.summary, 240),
    task.claimedPaths.length > 0 ? `Paths: ${task.claimedPaths.join(", ")}` : null,
    task.routeReason ? `Route: ${task.routeReason}` : null
  ]
    .filter(Boolean)
    .join("\n");

  return addBrainEntry(session, {
    missionId: task.missionId,
    taskId: task.id,
    sourceType: "task",
    category: task.kind === "planner" ? "decision" : "artifact",
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
  const files = await collectRepoTree(repoRoot, ".", 2);
  if (files.length === 0) {
    return [];
  }

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

  const topology = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "fact",
    scope: "repo",
    title: "Repo topology",
    content: [
      `Root directories: ${rootDirectories.join(", ") || "-"}`,
      `Entry surfaces: ${entrypoints.join(", ") || "-"}`,
      `Signals: ${tags.join(", ") || "-"}`,
      `Representative files: ${files.slice(0, 18).join(", ")}`
    ].join("\n"),
    tags: [...tags, ...rootDirectories],
    confidence: 0.82,
    freshness: "live",
    evidence: [...entrypoints, ...files.slice(0, 18)],
    commands,
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
      `Likely verification commands: ${commands.join(" | ") || "-"}`,
      packageScripts.length > 0 ? `Package scripts: ${packageScripts.join(" | ")}` : "Package scripts: -"
    ].join("\n"),
    tags: [...tags, "runbook", "verification"],
    confidence: 0.8,
    freshness: "live",
    evidence: [...entrypoints],
    commands,
    pinned: false
  });

  const structure = addBrainEntry(session, {
    missionId: null,
    taskId: null,
    sourceType: "mission",
    category: "decision",
    scope: "repo",
    title: "Repo structure graph",
    content: [
      `Local module edges: ${localEdges.length > 0 ? localEdges.slice(0, 16).map((edge) => `${edge.from} -> ${edge.to}`).join(" | ") : "-"}`,
      `External dependencies: ${commonExternalTargets.join(", ") || "-"}`,
      `Internal dependency hotspots: ${commonLocalTargets.join(", ") || "-"}`
    ].join("\n"),
    tags: [...tags, ...commonLocalTargets, ...commonExternalTargets],
    confidence: 0.74,
    freshness: "live",
    evidence: unique([
      ...localEdges.slice(0, 12).map((edge) => edge.from),
      ...entrypoints
    ]),
    commands,
    pinned: false
  });

  return [topology, runbook, structure];
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
    confidence: typeof entry.confidence === "number" ? entry.confidence : null
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
