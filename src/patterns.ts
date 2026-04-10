import { randomUUID } from "node:crypto";
import path from "node:path";
import { addBrainEntry } from "./brain.ts";
import { ensureDir, fileExists, readJson, writeJson } from "./fs.ts";
import { nowIso } from "./paths.ts";
import type {
  AppPaths,
  BrainEntry,
  LandReport,
  Mission,
  PatternConstellation,
  PatternEntry,
  PatternTemplate,
  SessionRecord
} from "./types.ts";

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9/.\-\s]+/g, " ").replaceAll(/\s+/g, " ").trim();
}

const STOPWORDS = new Set([
  "build",
  "create",
  "make",
  "small",
  "tiny",
  "called",
  "with",
  "and",
  "plus",
  "include",
  "includes",
  "including",
  "simple",
  "minimal"
]);

const GENERIC_PATH_SEGMENTS = new Set([
  "app",
  "apps",
  "internal",
  "package",
  "packages",
  "src",
  "lib"
]);

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function countValues(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function countBy<T>(
  values: T[],
  keyFn: (value: T) => string
): Array<{ value: string; count: number }> {
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

function overlapValues(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map((value) => normalizeText(value)));
  return unique(left.filter((value) => rightSet.has(normalizeText(value))));
}

function buildRepoClusters(
  repoProfiles: Array<{
    repoRoot: string;
    label: string;
    topStacks: string[];
    topNodeKinds: string[];
  }>,
  repoLinks: Array<{
    leftRepoRoot: string;
    rightRepoRoot: string;
    score: number;
  }>
): Array<{
  id: string;
  labels: string[];
  repoRoots: string[];
  stacks: string[];
  nodeKinds: string[];
  score: number;
}> {
  const adjacency = new Map<string, Set<string>>();
  const linkScores = new Map<string, number>();
  for (const profile of repoProfiles) {
    adjacency.set(profile.repoRoot, adjacency.get(profile.repoRoot) ?? new Set<string>());
  }
  for (const link of repoLinks) {
    adjacency.set(link.leftRepoRoot, adjacency.get(link.leftRepoRoot) ?? new Set<string>());
    adjacency.set(link.rightRepoRoot, adjacency.get(link.rightRepoRoot) ?? new Set<string>());
    adjacency.get(link.leftRepoRoot)?.add(link.rightRepoRoot);
    adjacency.get(link.rightRepoRoot)?.add(link.leftRepoRoot);
    linkScores.set(
      [link.leftRepoRoot, link.rightRepoRoot].sort().join("::"),
      link.score
    );
  }

  const visited = new Set<string>();
  const profileByRepo = new Map(repoProfiles.map((profile) => [profile.repoRoot, profile] as const));
  const clusters: Array<{
    id: string;
    labels: string[];
    repoRoots: string[];
    stacks: string[];
    nodeKinds: string[];
    score: number;
  }> = [];

  for (const profile of repoProfiles) {
    if (visited.has(profile.repoRoot)) {
      continue;
    }

    const queue = [profile.repoRoot];
    const component: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    if (component.length <= 1) {
      continue;
    }

    const labels = component
      .map((repoRoot) => profileByRepo.get(repoRoot)?.label ?? path.basename(repoRoot))
      .sort((left, right) => left.localeCompare(right));
    const score = component.reduce((total, repoRoot, index) => {
      const remaining = component.slice(index + 1);
      return total + remaining.reduce((inner, candidate) => {
        return inner + (linkScores.get([repoRoot, candidate].sort().join("::")) ?? 0);
      }, 0);
    }, 0);
    clusters.push({
      id: `cluster:${labels.join("+").toLowerCase()}`,
      labels,
      repoRoots: component.sort((left, right) => left.localeCompare(right)),
      stacks: countValues(
        component.flatMap((repoRoot) => profileByRepo.get(repoRoot)?.topStacks ?? [])
      )
        .slice(0, 6)
        .map((item) => item.value),
      nodeKinds: countValues(
        component.flatMap((repoRoot) => profileByRepo.get(repoRoot)?.topNodeKinds ?? [])
      )
        .slice(0, 6)
        .map((item) => item.value),
      score
    });
  }

  return clusters.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function buildTemplateLinks(templates: PatternTemplate[]): Array<{
  leftTemplateId: string;
  rightTemplateId: string;
  leftLabel: string;
  rightLabel: string;
  sharedStacks: string[];
  sharedNodeKinds: string[];
  sharedAcceptance: string[];
  sharedRepos: string[];
  score: number;
}> {
  return templates
    .flatMap((left, leftIndex) =>
      templates.slice(leftIndex + 1).map((right) => {
        const sharedStacks = overlapValues(left.stacks, right.stacks);
        const sharedNodeKinds = overlapValues(left.nodeKinds, right.nodeKinds);
        const sharedAcceptance = overlapValues(left.acceptanceCriteria, right.acceptanceCriteria);
        const sharedRepos = overlapValues(left.repoRoots, right.repoRoots);
        const score =
          sharedStacks.length * 3 +
          sharedNodeKinds.length * 2 +
          sharedAcceptance.length +
          sharedRepos.length;
        return {
          leftTemplateId: left.id,
          rightTemplateId: right.id,
          leftLabel: left.label,
          rightLabel: right.label,
          sharedStacks,
          sharedNodeKinds,
          sharedAcceptance,
          sharedRepos,
          score
        };
      })
    )
    .filter((link) => link.score > 0)
    .sort((left, right) => right.score - left.score || left.leftLabel.localeCompare(right.leftLabel))
    .slice(0, 12);
}

function truncate(value: string, max = 220): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function patternFingerprint(entry: Pick<PatternEntry, "title" | "tags" | "sourceRepoRoot">): string {
  return [
    normalizeText(entry.title),
    unique(entry.tags).sort().join("|"),
    normalizeText(entry.sourceRepoRoot)
  ].join("::");
}

function commandHints(report: LandReport): string[] {
  const hints = new Set<string>();
  if (report.validationCommand.trim()) {
    hints.add(report.validationCommand.trim());
  }

  for (const command of report.commandsRun) {
    if (/npm test|pnpm test|yarn test|go test|pytest|cargo test|npm run build|pnpm build|yarn build/i.test(command)) {
      hints.add(command.trim());
    }
  }

  return [...hints].slice(0, 6);
}

function inferPatternKind(entry: Pick<PatternEntry, "examplePaths" | "commands">): PatternEntry["kind"] {
  if (entry.commands.some((command) => /test|verify|lint|build/i.test(command))) {
    return "delivery";
  }
  if (entry.examplePaths.some((filePath) => /apps\/|packages\/|src\/|app\//i.test(filePath))) {
    return "architecture";
  }
  return "micro";
}

function inferStackSignals(prompt: string, report: LandReport): string[] {
  const lower = `${prompt} ${report.changedByAgent.flatMap((item) => item.paths).join(" ")}`.toLowerCase();
  return unique([
    /\breact|next\b/.test(lower) ? "react" : "",
    /\btypescript\b|\.ts\b|\.tsx\b/.test(lower) ? "typescript" : "",
    /\bgo|\.go\b/.test(lower) ? "go" : "",
    /\bpython|\.py\b/.test(lower) ? "python" : "",
    /\bworker|queue|cron\b/.test(lower) ? "worker" : "",
    /\bapi|backend|server\b/.test(lower) ? "backend" : "",
    /\bweb|frontend|page|ui\b/.test(lower) ? "frontend" : ""
  ]);
}

function inferNodeKinds(prompt: string): NonNullable<PatternEntry["nodeKinds"]> {
  const lower = prompt.toLowerCase();
  return unique([
    /\bscaffold|bootstrap|starter|from scratch|greenfield\b/.test(lower) ? "scaffold" : "",
    /\bbackend|api|server|database|worker|queue\b/.test(lower) ? "backend" : "",
    /\bfrontend|ui|ux|web|page|screen|layout\b/.test(lower) ? "frontend" : "",
    /\bshared|types|contracts|schema|domain\b/.test(lower) ? "shared_contract" : "",
    /\btest|verify|qa|validation\b/.test(lower) ? "tests" : "",
    /\bdocs|readme|documentation|spec\b/.test(lower) ? "docs" : "",
    /\breview|polish|refine\b/.test(lower) ? "review" : ""
  ]) as NonNullable<PatternEntry["nodeKinds"]>;
}

function extractPathTags(report: LandReport): string[] {
  const tags = new Set<string>();
  for (const changeSet of report.changedByAgent) {
    for (const filePath of changeSet.paths) {
      const ext = path.extname(filePath).replace(/^\./, "");
      if (ext) {
        tags.add(ext);
      }
      const segments = filePath.split("/").filter(Boolean);
      for (const segment of segments.slice(0, 2)) {
        tags.add(segment);
      }
    }
  }
  return [...tags];
}

function deriveStackSignals(entry: Pick<PatternEntry, "stackSignals" | "prompt" | "examplePaths" | "tags">): string[] {
  const seeded = unique(entry.stackSignals ?? []);
  if (seeded.length > 0) {
    return seeded;
  }

  const combined = `${entry.prompt} ${(entry.tags ?? []).join(" ")} ${(entry.examplePaths ?? []).join(" ")}`.toLowerCase();
  return unique([
    /\b(next|react)\b|\.tsx?\b/.test(combined) ? "typescript" : "",
    /\bnext\b|react|\.tsx\b/.test(combined) ? "frontend" : "",
    /\bapi|server|backend|worker|queue\b/.test(combined) ? "backend" : "",
    /\bgo\b|\.go\b/.test(combined) ? "go" : "",
    /\bpython\b|\.py\b/.test(combined) ? "python" : "",
    /\brust\b|cargo|\.rs\b/.test(combined) ? "rust" : ""
  ]);
}

function deriveNodeKinds(entry: Pick<PatternEntry, "nodeKinds" | "prompt" | "summary" | "tags">): NonNullable<PatternEntry["nodeKinds"]> {
  const seeded = unique((entry.nodeKinds ?? []).filter(Boolean)) as NonNullable<PatternEntry["nodeKinds"]>;
  if (seeded.length > 0) {
    return seeded;
  }

  const combined = `${entry.prompt} ${entry.summary} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
  return unique([
    /\bscaffold|bootstrap|starter|initialize|greenfield\b/.test(combined) ? "scaffold" : "",
    /\bbackend|api|server|database|worker|queue\b/.test(combined) ? "backend" : "",
    /\bfrontend|ui|ux|screen|page|layout|component|web\b/.test(combined) ? "frontend" : "",
    /\bcontract|schema|shared|domain|types?\b/.test(combined) ? "shared_contract" : "",
    /\btest|verify|validation|smoke|qa\b/.test(combined) ? "tests" : "",
    /\breadme|docs|documentation|guide|spec\b/.test(combined) ? "docs" : "",
    /\breview|polish|refine\b/.test(combined) ? "review" : "",
    /\brepair|fix|debug\b/.test(combined) ? "repair" : "",
    /\bintegration|merge|land\b/.test(combined) ? "integration" : ""
  ]) as NonNullable<PatternEntry["nodeKinds"]>;
}

function filterSignalTags(values: string[]): string[] {
  return values.filter((value) => {
    const normalized = normalizeText(value);
    if (!normalized || STOPWORDS.has(normalized) || GENERIC_PATH_SEGMENTS.has(normalized)) {
      return false;
    }
    return normalized.length >= 3;
  });
}

function normalizePatternEntry(entry: PatternEntry): PatternEntry {
  return {
    id: String(entry.id),
    sourceRepoRoot: typeof entry.sourceRepoRoot === "string" ? entry.sourceRepoRoot : "",
    missionId: typeof entry.missionId === "string" ? entry.missionId : null,
    reportId: typeof entry.reportId === "string" ? entry.reportId : null,
    kind:
      entry.kind === "micro" || entry.kind === "delivery" || entry.kind === "anti_pattern"
        ? entry.kind
        : "architecture",
    title: typeof entry.title === "string" ? entry.title : "Pattern",
    summary: typeof entry.summary === "string" ? entry.summary : "",
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    tags: Array.isArray(entry.tags) ? entry.tags.map((item) => String(item)) : [],
    stackSignals: Array.isArray(entry.stackSignals) ? entry.stackSignals.map((item) => String(item)) : [],
    nodeKinds: Array.isArray(entry.nodeKinds) ? entry.nodeKinds.map((item) => String(item)) as NonNullable<PatternEntry["nodeKinds"]> : [],
    acceptanceCriteria: Array.isArray(entry.acceptanceCriteria)
      ? entry.acceptanceCriteria.map((item) => String(item))
      : [],
    confidence:
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.max(0, Math.min(1, entry.confidence))
        : 0.65,
    usageCount:
      typeof entry.usageCount === "number" && Number.isFinite(entry.usageCount)
        ? Math.max(1, Math.trunc(entry.usageCount))
        : 1,
    sourceMissionIds: Array.isArray(entry.sourceMissionIds)
      ? entry.sourceMissionIds.map((item) => String(item))
      : [],
    antiPatternSignals: Array.isArray(entry.antiPatternSignals)
      ? entry.antiPatternSignals.map((item) => String(item))
      : [],
    examplePaths: Array.isArray(entry.examplePaths) ? entry.examplePaths.map((item) => String(item)) : [],
    commands: Array.isArray(entry.commands) ? entry.commands.map((item) => String(item)) : [],
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso()
  };
}

export async function listPatterns(paths: AppPaths): Promise<PatternEntry[]> {
  if (!(await fileExists(paths.patternsFile))) {
    return [];
  }

  const raw = await readJson<PatternEntry[]>(paths.patternsFile);
  const patterns = Array.isArray(raw) ? raw.map((item) => normalizePatternEntry(item)) : [];
  return patterns.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function savePatterns(paths: AppPaths, patterns: PatternEntry[]): Promise<void> {
  await ensureDir(path.dirname(paths.patternsFile));
  await writeJson(paths.patternsFile, patterns);
}

function scorePattern(entry: PatternEntry, query: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = new Set([
    ...tokenize(entry.title),
    ...tokenize(entry.summary),
    ...tokenize(entry.prompt),
    ...entry.tags.map((tag) => normalizeText(tag)),
    ...entry.examplePaths.flatMap((filePath) => tokenize(filePath))
  ]);

  let matchScore = 0;
  let exactMatches = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      matchScore += 3;
      exactMatches += 1;
    } else if ([...haystack].some((candidate) => candidate.includes(token) || token.includes(candidate))) {
      matchScore += 1;
    }
  }

  if (normalizeText(entry.title).includes(normalizeText(query))) {
    matchScore += 4;
    exactMatches += 1;
  }

  if (matchScore === 0 || (exactMatches === 0 && matchScore <= 3)) {
    return 0;
  }

  let score = matchScore;
  score += Math.round((entry.confidence ?? 0.65) * 2);
  score += Math.min(3, entry.usageCount ?? 1);

  if ((entry.kind ?? "architecture") === "architecture") {
    score += 1;
  }
  if ((entry.kind ?? "architecture") === "anti_pattern") {
    score -= 1;
  }

  return score;
}

export interface RankedPattern {
  entry: PatternEntry;
  score: number;
  reasons: string[];
}

export interface RankedPatternTemplate {
  template: PatternTemplate;
  score: number;
  reasons: string[];
}

export async function searchPatterns(
  paths: AppPaths,
  query: string,
  limit = 5
): Promise<PatternEntry[]> {
  const patterns = await listPatterns(paths);
  return patterns
    .map((entry) => ({
      entry,
      score: scorePattern(entry, query)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry);
}

export async function rankPatterns(
  paths: AppPaths,
  query: string,
  limit = 5
): Promise<RankedPattern[]> {
  const patterns = await listPatterns(paths);
  const normalizedQuery = normalizeText(query);
  const ranked = patterns
    .map((entry) => {
      const reasons: string[] = [];
      if (normalizedQuery && normalizeText(entry.title).includes(normalizedQuery)) {
        reasons.push("title-match");
      }
      if ((entry.stackSignals ?? []).some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("stack-match");
      }
      if ((entry.nodeKinds ?? []).some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("node-kind-match");
      }
      if ((entry.examplePaths ?? []).some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("path-match");
      }
      if ((entry.antiPatternSignals ?? []).some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("anti-pattern-signal");
      }
      if (reasons.length === 0 && scorePattern(entry, query) > 0) {
        reasons.push("semantic-match");
      }
      return {
        entry,
        score: scorePattern(entry, query),
        reasons
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));

  const topScore = ranked[0]?.score ?? 0;
  const cutoff = Math.max(6, topScore - 4);
  return ranked
    .filter((item) => item.score >= cutoff)
    .slice(0, Math.max(1, limit));
}

export function buildPatternAppliedPrompt(entry: PatternEntry, prompt: string): string {
  const sections = [
    prompt.trim(),
    "Pattern context selected by Kavi:",
    `Pattern: ${entry.title}`,
    `Kind: ${entry.kind ?? "architecture"}`,
    `Summary: ${entry.summary}`,
    `Stack signals: ${(entry.stackSignals ?? []).join(", ") || "-"}`,
    `Node kinds: ${(entry.nodeKinds ?? []).join(", ") || "-"}`,
    `Example paths: ${entry.examplePaths.join(", ") || "-"}`,
    `Helpful commands: ${entry.commands.join(" | ") || "-"}`,
    `Acceptance defaults: ${(entry.acceptanceCriteria ?? []).join(" | ") || "-"}`,
    `Anti-pattern signals: ${(entry.antiPatternSignals ?? []).join(" | ") || "-"}`
  ];
  return sections.filter(Boolean).join("\n\n");
}

function templateKey(entry: Pick<PatternEntry, "kind" | "stackSignals" | "nodeKinds">): string {
  return [
    entry.kind ?? "architecture",
    unique(entry.stackSignals ?? []).sort().join("|"),
    unique((entry.nodeKinds ?? []).filter(Boolean)).sort().join("|")
  ].join("::");
}

function buildPatternTemplateLabel(entry: Pick<PatternEntry, "kind" | "stackSignals" | "nodeKinds">): string {
  const stacks = unique(entry.stackSignals ?? []).slice(0, 3);
  const nodes = unique((entry.nodeKinds ?? []).filter(Boolean)).slice(0, 3);
  return [
    entry.kind ?? "architecture",
    stacks.length > 0 ? stacks.join("/") : "general",
    nodes.length > 0 ? nodes.join("+") : "mixed"
  ].join(" | ");
}

export function buildPatternTemplatesFromEntries(patterns: PatternEntry[]): PatternTemplate[] {
  const groups = new Map<string, PatternEntry[]>();
  for (const entry of patterns.map((item) => ({
    ...item,
    stackSignals: deriveStackSignals(item),
    nodeKinds: deriveNodeKinds(item)
  }))) {
    const key = templateKey(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([key, entries]) => {
      const representative = entries[0]!;
      const confidence = entries.reduce((sum, entry) => sum + (entry.confidence ?? 0.65), 0) / entries.length;
      return {
        id: `template:${key}`,
        label: buildPatternTemplateLabel(representative),
        kind: representative.kind ?? "architecture",
        stacks: unique(entries.flatMap((entry) => entry.stackSignals ?? [])).slice(0, 8),
        nodeKinds: unique(entries.flatMap((entry) => (entry.nodeKinds ?? []).filter(Boolean))).slice(0, 8),
        patternIds: entries.map((entry) => entry.id),
        repoRoots: unique(entries.map((entry) => entry.sourceRepoRoot)).slice(0, 10),
        acceptanceCriteria: unique(entries.flatMap((entry) => entry.acceptanceCriteria ?? [])).slice(0, 12),
        commands: unique(entries.flatMap((entry) => entry.commands)).slice(0, 12),
        antiPatternSignals: unique(entries.flatMap((entry) => entry.antiPatternSignals ?? [])).slice(0, 12),
        confidence: Number(confidence.toFixed(2))
      } satisfies PatternTemplate;
    })
    .sort((left, right) => right.patternIds.length - left.patternIds.length || right.confidence - left.confidence);
}

function scoreTemplate(template: PatternTemplate, query: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = new Set([
    ...tokenize(template.label),
    ...template.stacks.flatMap((item) => tokenize(item)),
    ...template.nodeKinds.flatMap((item) => tokenize(item)),
    ...template.commands.flatMap((item) => tokenize(item)),
    ...template.acceptanceCriteria.flatMap((item) => tokenize(item)),
    ...template.antiPatternSignals.flatMap((item) => tokenize(item))
  ]);
  let score = Math.round(template.confidence * 4) + Math.min(5, template.patternIds.length);
  for (const token of tokens) {
    if (haystack.has(token)) {
      score += 3;
    } else if ([...haystack].some((candidate) => candidate.includes(token) || token.includes(candidate))) {
      score += 1;
    }
  }
  if (normalizeText(template.label).includes(normalizeText(query))) {
    score += 4;
  }
  return score;
}

export async function buildPatternTemplates(paths: AppPaths): Promise<PatternTemplate[]> {
  return buildPatternTemplatesFromEntries(await listPatterns(paths));
}

export async function rankPatternTemplates(
  paths: AppPaths,
  query: string,
  limit = 5
): Promise<RankedPatternTemplate[]> {
  const templates = await buildPatternTemplates(paths);
  return templates
    .map((template) => {
      const normalizedQuery = normalizeText(query);
      const reasons: string[] = [];
      if (normalizedQuery && normalizeText(template.label).includes(normalizedQuery)) {
        reasons.push("label-match");
      }
      if (template.stacks.some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("stack-match");
      }
      if (template.nodeKinds.some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("node-kind-match");
      }
      if (template.antiPatternSignals.some((item) => normalizedQuery.includes(normalizeText(item)))) {
        reasons.push("anti-pattern-signal");
      }
      const score = scoreTemplate(template, query);
      if (reasons.length === 0 && score > 0) {
        reasons.push("portfolio-match");
      }
      return { template, score, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.template.patternIds.length - left.template.patternIds.length)
    .slice(0, Math.max(1, limit));
}

export function buildPatternTemplatePrompt(template: PatternTemplate, prompt: string): string {
  return [
    prompt.trim(),
    "Portfolio template context selected by Kavi:",
    `Template: ${template.label}`,
    `Kind: ${template.kind}`,
    `Stacks: ${template.stacks.join(", ") || "-"}`,
    `Node kinds: ${template.nodeKinds.join(", ") || "-"}`,
    `Source repos: ${template.repoRoots.join(", ") || "-"}`,
    `Helpful commands: ${template.commands.join(" | ") || "-"}`,
    `Acceptance defaults: ${template.acceptanceCriteria.join(" | ") || "-"}`,
    `Anti-pattern signals: ${template.antiPatternSignals.join(" | ") || "-"}`
  ].filter(Boolean).join("\n\n");
}

export async function captureLandingPatterns(
  paths: AppPaths,
  session: SessionRecord,
  report: LandReport
): Promise<PatternEntry[]> {
  const mission = [...session.missions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const nextPattern: PatternEntry = {
    id: `pattern-${randomUUID()}`,
    sourceRepoRoot: session.repoRoot,
    missionId: mission?.id ?? null,
    reportId: report.id,
    kind: "architecture",
    title: mission?.title ?? `Pattern from ${path.basename(session.repoRoot)}`,
    summary: truncate(mission?.summary || report.summary.join(" "), 280),
    prompt: mission?.prompt ?? session.goal ?? "",
    tags: unique([
      ...filterSignalTags(extractPathTags(report)),
      ...tokenize(mission?.title ?? ""),
      ...tokenize(mission?.prompt ?? ""),
      ...(mission?.spec?.requestedDeliverables ?? []),
      ...(mission?.spec?.domainEntities ?? []),
      ...(mission?.spec?.userRoles ?? [])
    ]).slice(0, 20),
    stackSignals: unique([
      ...(mission?.spec?.stackHints ?? []),
      ...inferStackSignals(mission?.prompt ?? session.goal ?? "", report)
    ]),
    nodeKinds: unique([
      ...(mission?.spec?.workstreamKinds ?? []),
      ...inferNodeKinds(mission?.prompt ?? session.goal ?? "")
    ]).filter((item) => Boolean(item)) as NonNullable<PatternEntry["nodeKinds"]>,
    acceptanceCriteria: mission?.contract?.acceptanceCriteria ?? mission?.acceptance.criteria ?? [],
    confidence: 0.72,
    usageCount: 1,
    sourceMissionIds: unique([mission?.id ?? ""]).filter(Boolean),
    antiPatternSignals: [],
    examplePaths: unique(report.changedByAgent.flatMap((changeSet) => changeSet.paths)).slice(0, 12),
    commands: commandHints(report),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  nextPattern.kind = inferPatternKind(nextPattern);

  const patterns = await listPatterns(paths);
  const existing = patterns.find((entry) => patternFingerprint(entry) === patternFingerprint(nextPattern));
  if (existing) {
    existing.updatedAt = nowIso();
    existing.summary = nextPattern.summary;
    existing.prompt = nextPattern.prompt;
    existing.reportId = nextPattern.reportId;
    existing.missionId = nextPattern.missionId;
    existing.kind = nextPattern.kind;
    existing.tags = unique([...existing.tags, ...nextPattern.tags]).slice(0, 24);
    existing.stackSignals = unique([...(existing.stackSignals ?? []), ...(nextPattern.stackSignals ?? [])]).slice(0, 16);
    existing.nodeKinds = unique([...(existing.nodeKinds ?? []), ...(nextPattern.nodeKinds ?? [])]).slice(0, 12) as NonNullable<PatternEntry["nodeKinds"]>;
    existing.acceptanceCriteria = unique([...(existing.acceptanceCriteria ?? []), ...(nextPattern.acceptanceCriteria ?? [])]).slice(0, 12);
    existing.confidence = Math.max(existing.confidence ?? 0.65, nextPattern.confidence ?? 0.65);
    existing.usageCount = (existing.usageCount ?? 1) + 1;
    existing.sourceMissionIds = unique([...(existing.sourceMissionIds ?? []), ...(nextPattern.sourceMissionIds ?? [])]);
    existing.antiPatternSignals = unique([...(existing.antiPatternSignals ?? []), ...(nextPattern.antiPatternSignals ?? [])]);
    existing.examplePaths = unique([...existing.examplePaths, ...nextPattern.examplePaths]).slice(0, 16);
    existing.commands = unique([...existing.commands, ...nextPattern.commands]).slice(0, 8);
    await savePatterns(paths, patterns);
    return [existing];
  }

  patterns.push(nextPattern);
  await savePatterns(paths, patterns);
  return [nextPattern];
}

export async function captureMissionAntiPatterns(
  paths: AppPaths,
  session: SessionRecord,
  mission: Mission
): Promise<PatternEntry[]> {
  const failingChecks = mission.acceptance.checks.filter((check) => check.status === "failed");
  const failedTasks = session.tasks.filter(
    (task) => task.missionId === mission.id && (task.status === "failed" || task.nodeKind === "repair")
  );
  const signals = unique([
    ...failingChecks.map((check) => normalizeText(check.title)),
    ...failedTasks.map((task) => normalizeText(task.title)),
    ...mission.risks?.map((risk) => normalizeText(risk.title)) ?? []
  ]).filter(Boolean);

  if (signals.length === 0) {
    return [];
  }

  const antiPattern: PatternEntry = {
    id: `pattern-${randomUUID()}`,
    sourceRepoRoot: session.repoRoot,
    missionId: mission.id,
    reportId: null,
    kind: "anti_pattern",
    title: `Anti-pattern from ${mission.title}`,
    summary: `Avoid repeating the failure signals observed on this mission: ${signals.slice(0, 4).join(", ")}.`,
    prompt: mission.prompt,
    tags: unique([
      "anti-pattern",
      ...(mission.spec?.workstreamKinds ?? []),
      ...(mission.spec?.stackHints ?? []),
      ...signals
    ]).slice(0, 24),
    stackSignals: mission.spec?.stackHints ?? [],
    nodeKinds: (mission.spec?.workstreamKinds ?? [])
      .filter((item) =>
        item === "research" ||
        item === "scaffold" ||
        item === "backend" ||
        item === "frontend" ||
        item === "shared_contract" ||
        item === "infra" ||
        item === "tests" ||
        item === "docs" ||
        item === "review" ||
        item === "repair" ||
        item === "integration"
      ) as NonNullable<PatternEntry["nodeKinds"]>,
    acceptanceCriteria: mission.acceptance.criteria,
    confidence: 0.61,
    usageCount: 1,
    sourceMissionIds: [mission.id],
    antiPatternSignals: signals,
    examplePaths: unique([
      ...failingChecks.map((check) => check.path ?? ""),
      ...failedTasks.flatMap((task) => task.claimedPaths)
    ]).filter(Boolean).slice(0, 12),
    commands: unique(failingChecks.map((check) => check.command ?? "").filter(Boolean)).slice(0, 8),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  const patterns = await listPatterns(paths);
  const existing = patterns.find(
    (entry) =>
      entry.kind === "anti_pattern" &&
      normalizeText(entry.title) === normalizeText(antiPattern.title)
  );
  if (existing) {
    existing.updatedAt = nowIso();
    existing.summary = antiPattern.summary;
    existing.tags = unique([...existing.tags, ...antiPattern.tags]).slice(0, 24);
    existing.examplePaths = unique([...existing.examplePaths, ...antiPattern.examplePaths]).slice(0, 16);
    existing.commands = unique([...existing.commands, ...antiPattern.commands]).slice(0, 8);
    existing.sourceMissionIds = unique([...(existing.sourceMissionIds ?? []), mission.id]);
    existing.antiPatternSignals = unique([...(existing.antiPatternSignals ?? []), ...signals]).slice(0, 16);
    existing.usageCount = (existing.usageCount ?? 1) + 1;
    await savePatterns(paths, patterns);
    return [existing];
  }

  patterns.push(antiPattern);
  await savePatterns(paths, patterns);
  return [antiPattern];
}

export async function attachRelevantPatternsToMission(
  paths: AppPaths,
  session: SessionRecord,
  missionId: string | null,
  prompt: string
): Promise<BrainEntry[]> {
  if (!missionId || !prompt.trim()) {
    return [];
  }

  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    return [];
  }

  const patterns = (await rankPatterns(paths, prompt, 5)).map((item) => item.entry);
  const entries: BrainEntry[] = [];
  const topTemplate = (await rankPatternTemplates(paths, prompt, 1))[0]?.template ?? null;
  if (topTemplate) {
    const templateEntry = addBrainEntry(session, {
      missionId,
      taskId: null,
      sourceType: "pattern",
      category: topTemplate.kind === "anti_pattern" ? "risk" : "procedure",
      scope: "pattern",
      title: `Pattern template: ${topTemplate.label}`,
      content: [
        `Stacks: ${topTemplate.stacks.join(", ") || "-"}`,
        `Node kinds: ${topTemplate.nodeKinds.join(", ") || "-"}`,
        `Portfolio repos: ${topTemplate.repoRoots.join(", ") || "-"}`,
        topTemplate.acceptanceCriteria.length > 0
          ? `Acceptance defaults: ${topTemplate.acceptanceCriteria.join(" | ")}`
          : null,
        topTemplate.antiPatternSignals.length > 0
          ? `Anti-pattern signals: ${topTemplate.antiPatternSignals.join(" | ")}`
          : null
      ].filter(Boolean).join("\n"),
      tags: [...topTemplate.stacks, ...topTemplate.nodeKinds, ...topTemplate.antiPatternSignals],
      confidence: topTemplate.confidence,
      freshness: "recent",
      evidence: [...topTemplate.repoRoots],
      commands: [...topTemplate.commands],
      pinned: false
    });
    if (!mission.brainEntryIds.includes(templateEntry.id)) {
      mission.brainEntryIds.push(templateEntry.id);
    }
    entries.push(templateEntry);
  }
  for (const pattern of patterns) {
    const entry = addBrainEntry(session, {
      missionId,
      taskId: null,
      sourceType: "pattern",
      category: pattern.kind === "anti_pattern" ? "risk" : "procedure",
      scope: "pattern",
      title: `Pattern: ${pattern.title}`,
      content: [
        truncate(pattern.summary, 240),
        pattern.stackSignals?.length ? `Stack signals: ${pattern.stackSignals.join(", ")}` : null,
        pattern.nodeKinds?.length ? `Node kinds: ${pattern.nodeKinds.join(", ")}` : null,
        pattern.examplePaths.length > 0 ? `Example paths: ${pattern.examplePaths.join(", ")}` : null,
        pattern.commands.length > 0 ? `Helpful commands: ${pattern.commands.join(" | ")}` : null,
        pattern.antiPatternSignals?.length ? `Anti-pattern signals: ${pattern.antiPatternSignals.join(" | ")}` : null
      ].filter(Boolean).join("\n"),
      tags: [...pattern.tags, ...pattern.examplePaths, ...(pattern.stackSignals ?? []), ...(pattern.nodeKinds ?? []), ...(pattern.antiPatternSignals ?? [])],
      confidence: pattern.confidence ?? 0.65,
      freshness: "recent",
      evidence: [...pattern.examplePaths],
      commands: [...pattern.commands],
      pinned: false
    });
    if (!mission.brainEntryIds.includes(entry.id)) {
      mission.brainEntryIds.push(entry.id);
    }
    mission.appliedPatternIds = Array.isArray(mission.appliedPatternIds) ? mission.appliedPatternIds : [];
    if (pattern.kind !== "anti_pattern" && !mission.appliedPatternIds.includes(pattern.id)) {
      mission.appliedPatternIds.push(pattern.id);
    }
    entries.push(entry);
  }

  return entries;
}

export async function buildPatternConstellation(paths: AppPaths): Promise<PatternConstellation> {
  const patterns = await listPatterns(paths);
  const derivedPatterns = patterns.map((entry) => ({
    ...entry,
    stackSignals: deriveStackSignals(entry),
    nodeKinds: deriveNodeKinds(entry),
    tags: filterSignalTags(entry.tags)
  }));
  const familyMap = new Map<
    string,
    {
      count: number;
      stacks: string[];
      nodeKinds: string[];
    }
  >();
  for (const entry of derivedPatterns) {
    const stacks = unique(entry.stackSignals ?? []).sort();
    const nodeKinds = unique(entry.nodeKinds ?? []).sort();
    const familyId = `${stacks.join("+") || "unknown"}::${nodeKinds.join("+") || "general"}`;
    const existing = familyMap.get(familyId) ?? {
      count: 0,
      stacks,
      nodeKinds
    };
    existing.count += 1;
    familyMap.set(familyId, existing);
  }

  const templates = buildPatternTemplatesFromEntries(derivedPatterns);
  const repoProfiles = countBy(patterns, (entry) => entry.sourceRepoRoot)
    .map(({ value, count }) => {
      const repoEntries = derivedPatterns.filter((entry) => entry.sourceRepoRoot === value);
      const repoTemplates = templates.filter((template) => template.repoRoots.includes(value));
      return {
        repoRoot: value,
        label: path.basename(value),
        patternCount: count,
        templateCount: repoTemplates.length,
        topStacks: countValues(repoEntries.flatMap((entry) => entry.stackSignals ?? []))
          .slice(0, 4)
          .map((item) => item.value),
        topNodeKinds: countValues(repoEntries.flatMap((entry) => entry.nodeKinds ?? []))
          .slice(0, 4)
          .map((item) => item.value),
        antiPatternCount: repoEntries.filter((entry) => entry.kind === "anti_pattern").length,
        deliveryPatternCount: repoEntries.filter((entry) => entry.kind === "delivery").length
      };
    })
    .sort((left, right) => right.patternCount - left.patternCount || left.label.localeCompare(right.label))
    .slice(0, 12);
  const repoLinks = repoProfiles
    .flatMap((left, leftIndex) =>
      repoProfiles.slice(leftIndex + 1).map((right) => {
        const sharedStacks = overlapValues(left.topStacks, right.topStacks);
        const sharedNodeKinds = overlapValues(left.topNodeKinds, right.topNodeKinds);
        const leftEntries = derivedPatterns.filter((entry) => entry.sourceRepoRoot === left.repoRoot);
        const rightEntries = derivedPatterns.filter((entry) => entry.sourceRepoRoot === right.repoRoot);
        const sharedCommands = overlapValues(
          unique(leftEntries.flatMap((entry) => entry.commands)).slice(0, 12),
          unique(rightEntries.flatMap((entry) => entry.commands)).slice(0, 12)
        );
        const score =
          sharedStacks.length * 3 +
          sharedNodeKinds.length * 2 +
          sharedCommands.length +
          Math.min(left.templateCount, right.templateCount);
        return {
          leftRepoRoot: left.repoRoot,
          rightRepoRoot: right.repoRoot,
          leftLabel: left.label,
          rightLabel: right.label,
          sharedStacks,
          sharedNodeKinds,
          sharedCommands,
          score
        };
      })
    )
    .filter((link) => link.score > 0)
    .sort((left, right) => right.score - left.score || left.leftLabel.localeCompare(right.leftLabel))
    .slice(0, 12);
  const repoClusters = buildRepoClusters(repoProfiles, repoLinks);
  const templateLinks = buildTemplateLinks(templates);

  return {
    totalPatterns: patterns.length,
    totalTemplates: templates.length,
    topStacks: countValues(derivedPatterns.flatMap((entry) => entry.stackSignals ?? [])).slice(0, 8),
    topNodeKinds: countValues(derivedPatterns.flatMap((entry) => entry.nodeKinds ?? [])).slice(0, 8),
    topCommands: countValues(patterns.flatMap((entry) => entry.commands)).slice(0, 8),
    topTags: countValues(derivedPatterns.flatMap((entry) => entry.tags)).slice(0, 10),
    topRepos: countBy(patterns, (entry) => path.basename(entry.sourceRepoRoot)).slice(0, 8),
    patternFamilies: [...familyMap.entries()]
      .map(([id, family]) => ({
        id,
        label: `${family.stacks.join(" + ") || "unknown"} -> ${family.nodeKinds.join(" + ") || "general"}`,
        count: family.count,
        stacks: family.stacks,
        nodeKinds: family.nodeKinds
      }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
      .slice(0, 10),
    repoProfiles,
    repoLinks,
    repoClusters,
    antiPatternHotspots: countValues(
      derivedPatterns.flatMap((entry) => entry.kind === "anti_pattern" ? (entry.antiPatternSignals ?? []) : [])
    ).slice(0, 10),
    architecturePatterns: derivedPatterns.filter((entry) => (entry.kind ?? "architecture") === "architecture").slice(0, 8),
    deliveryPatterns: derivedPatterns.filter((entry) => entry.kind === "delivery").slice(0, 8),
    antiPatterns: derivedPatterns.filter((entry) => entry.kind === "anti_pattern").slice(0, 8),
    templateLinks,
    templates: templates.slice(0, 12)
  };
}
