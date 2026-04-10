import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import { fileExists, readJson } from "./fs.ts";
import { runCommand } from "./process.ts";
import type { AcceptanceCheck, AgentName, Mission, RouteStrategy, SessionRecord, TaskSpec } from "./types.ts";

type PackageManifest = {
  scripts?: Record<string, string>;
};

function lowerPrompt(mission: Mission): string {
  return `${mission.title}\n${mission.prompt}`.toLowerCase();
}

function wantsDocs(mission: Mission): boolean {
  return /\b(readme|docs|documentation|setup)\b/.test(lowerPrompt(mission));
}

function wantsFrontend(mission: Mission): boolean {
  return /\b(frontend|front-end|ui|ux|page|screen|component|layout|web)\b/.test(lowerPrompt(mission));
}

function wantsBackend(mission: Mission): boolean {
  return /\b(api|backend|server|worker|queue|database|schema|auth)\b/.test(lowerPrompt(mission));
}

type AcceptanceCheckDraft = Omit<
  AcceptanceCheck,
  "id" | "status" | "lastRunAt" | "lastOutput" | "harnessPath"
>;

function buildCheckKey(check: AcceptanceCheck): string {
  return [
    check.kind,
    check.title,
    check.path ?? "",
    check.urlPath ?? "",
    (check.routeCandidates ?? []).join("|"),
    check.target ?? "",
    check.method ?? "",
    check.requestBody ?? "",
    JSON.stringify(check.requestHeaders ?? {}),
    check.selector ?? "",
    (check.selectorCandidates ?? []).join("|"),
    check.expectedTitle ?? "",
    String(check.expectedStatus ?? ""),
    check.expectedContentType ?? "",
    uniqueStrings(check.expectedJsonKeys ?? []).join("|")
  ].join("::");
}

function buildDraftKey(check: AcceptanceCheckDraft): string {
  return [
    check.kind,
    check.title,
    check.path ?? "",
    check.urlPath ?? "",
    (check.routeCandidates ?? []).join("|"),
    check.target ?? "",
    check.method ?? "",
    check.requestBody ?? "",
    JSON.stringify(check.requestHeaders ?? {}),
    check.selector ?? "",
    (check.selectorCandidates ?? []).join("|"),
    check.expectedTitle ?? "",
    String(check.expectedStatus ?? ""),
    check.expectedContentType ?? "",
    uniqueStrings(check.expectedJsonKeys ?? []).join("|")
  ].join("::");
}

function normalizeLine(value: string): string {
  return value.replaceAll("\r", " ").replaceAll(/\s+/g, " ").trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function isGeneratedHarnessKind(kind: AcceptanceCheck["kind"]): boolean {
  return (
    kind === "http" ||
    kind === "browser" ||
    kind === "scenario" ||
    kind === "contract" ||
    kind === "docs" ||
    kind === "file"
  );
}

function isDocsScenario(detail: string): boolean {
  return /\b(readme|docs|documentation|setup|usage|run|understand|guide|quickstart)\b/i.test(detail);
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function isFrontendPath(filePath: string): boolean {
  return (
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".html") ||
    filePath.endsWith(".css") ||
    filePath.endsWith(".scss") ||
    filePath.includes("/web/") ||
    filePath.includes("/ui/") ||
    filePath.includes("/app/")
  );
}

function isBackendPath(filePath: string): boolean {
  return (
    filePath === "server.mjs" ||
    filePath === "server.js" ||
    filePath === "server.cjs" ||
    filePath.endsWith(".go") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs") ||
    filePath.endsWith(".rs") ||
    filePath.endsWith(".py") ||
    filePath.endsWith(".sql") ||
    filePath.includes("/api/") ||
    filePath.includes("/server/") ||
    filePath.includes("/worker/") ||
    filePath.includes("/schema/") ||
    filePath.includes("/db/")
  );
}

function isDocsPath(filePath: string): boolean {
  return (
    filePath === "README.md" ||
    filePath.startsWith("docs/") ||
    filePath.includes("/docs/") ||
    filePath.endsWith(".md")
  );
}

function isApiRouteLike(filePath: string): boolean {
  return (
    /route\.(ts|js)$/.test(filePath) ||
    /controller|handler|endpoint|router|routes/i.test(filePath) ||
    filePath.includes("/api/") ||
    /^server\.(mjs|js|cjs)$/i.test(filePath)
  );
}

function isBrowserSurfaceContent(content: string): boolean {
  return /<!doctype|<html|<body|<main|<section|component|app-shell|render\(|res\.end\(.+<|return\s*\(/is.test(content);
}

function isApiSurfaceContent(content: string): boolean {
  return /\/api\/|server\.listen|createServer|app\.(get|post|put|delete)\(|router|handler|endpoint|res\.writeHead|application\/json/is.test(content);
}

function isContractBearingContent(content: string): boolean {
  return /schema|contract|interface\s|type\s|zod|dto|domain|\/api\/|application\/json|server\.listen|createServer/is.test(content);
}

function summarizeEvidencePaths(paths: string[], fallback = "-"): string {
  return paths.length > 0 ? paths.join(", ") : fallback;
}

async function collectRepoFiles(
  repoRoot: string,
  relativeDir = ".",
  depth = 4
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
    if (entry.name === ".git" || entry.name === ".kavi" || entry.name === "node_modules" || entry.name === ".next") {
      continue;
    }

    const relativePath = relativeDir === "." ? entry.name : path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRepoFiles(repoRoot, relativePath, depth - 1)));
      continue;
    }

    files.push(relativePath);
  }
  return files;
}

async function readLikelySourceFiles(
  repoRoot: string,
  repoFiles: string[],
  predicate: (filePath: string) => boolean,
  limit = 12
): Promise<Array<{ path: string; content: string }>> {
  const matches = repoFiles
    .filter(predicate)
    .filter((filePath) => /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|md|html|json)$/i.test(filePath))
    .slice(0, limit);

  const contents = await Promise.all(matches.map(async (filePath) => {
    try {
      const content = await fs.readFile(path.join(repoRoot, filePath), "utf8");
      return { path: filePath, content };
    } catch {
      return null;
    }
  }));

  return contents.filter((item): item is { path: string; content: string } => item !== null);
}

function addDraftIfMissing(checks: AcceptanceCheckDraft[], next: AcceptanceCheckDraft): void {
  const key = buildDraftKey(next);
  if (checks.some((check) => buildDraftKey(check) === key)) {
    return;
  }

  checks.push(next);
}

function relevantDraftShape(check: AcceptanceCheckDraft | AcceptanceCheck): string {
  return JSON.stringify({
    kind: check.kind,
    title: check.title,
    command: check.command ?? null,
    path: check.path ?? null,
    serverCommand: check.serverCommand ?? null,
      target: check.target ?? null,
      urlPath: check.urlPath ?? null,
      routeCandidates: uniqueStrings(check.routeCandidates ?? []),
      method: check.method ?? null,
      requestBody: check.requestBody ?? null,
      requestHeaders: check.requestHeaders ?? {},
      selector: check.selector ?? null,
      selectorCandidates: uniqueStrings(check.selectorCandidates ?? []),
      expectedTitle: check.expectedTitle ?? null,
      expectedStatus: check.expectedStatus ?? null,
      expectedContentType: check.expectedContentType ?? null,
      expectedJsonKeys: uniqueStrings(check.expectedJsonKeys ?? []),
      detail: check.detail,
      evidencePaths: uniqueStrings(check.evidencePaths ?? []),
      expectedText: uniqueStrings(check.expectedText ?? [])
  });
}

function reconcileAcceptanceChecks(
  existingChecks: AcceptanceCheck[],
  drafts: AcceptanceCheckDraft[]
): AcceptanceCheck[] {
  const existingByKey = new Map(existingChecks.map((check) => [buildCheckKey(check), check]));
  const manualChecks = existingChecks.filter((check) => check.kind === "manual");
  const nextChecks: AcceptanceCheck[] = [];
  const seenKeys = new Set<string>();

  for (const check of manualChecks) {
    const key = buildCheckKey(check);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    nextChecks.push(check);
  }

  for (const draft of drafts) {
    const key = buildDraftKey(draft);
    if (seenKeys.has(key)) {
      continue;
    }
    const existing = existingByKey.get(key);
    const draftShape = relevantDraftShape(draft);
    const existingShape = existing ? relevantDraftShape(existing) : null;
    const shapeChanged = existingShape !== draftShape;
    const shouldRegenerateHarness = isGeneratedHarnessKind(draft.kind);
    seenKeys.add(key);
    nextChecks.push({
      id: existing?.id ?? `accept-check-${randomUUID()}`,
      status: existing && !shapeChanged ? existing.status : "pending",
      lastRunAt: existing && !shapeChanged ? existing.lastRunAt : null,
      lastOutput: existing && !shapeChanged ? existing.lastOutput : null,
      harnessPath: shouldRegenerateHarness ? null : (existing?.harnessPath ?? null),
      ...draft,
      command: shouldRegenerateHarness ? null : draft.command,
      routeCandidates: uniqueStrings(draft.routeCandidates ?? []),
      evidencePaths: uniqueStrings(draft.evidencePaths ?? []),
      expectedText: uniqueStrings(draft.expectedText ?? []),
      selectorCandidates: uniqueStrings(draft.selectorCandidates ?? []),
      expectedTitle: draft.expectedTitle ?? null,
      expectedStatus: draft.expectedStatus ?? null,
      expectedContentType: draft.expectedContentType ?? null,
      expectedJsonKeys: uniqueStrings(draft.expectedJsonKeys ?? []),
      likelyTaskIds: existing?.likelyTaskIds ?? [],
      likelyOwners: existing?.likelyOwners ?? [],
      likelyReason: existing?.likelyReason ?? null
    });
  }

  return nextChecks;
}

function acceptanceCheckSignals(check: AcceptanceCheck): {
  frontend: boolean;
  backend: boolean;
  docs: boolean;
} {
  return {
    frontend:
      check.kind === "browser" ||
      (check.path ? isFrontendPath(check.path) : false) ||
      /\b(frontend|web|ui|ux|page|screen|layout|component|browser)\b/i.test(
        `${check.title} ${check.detail} ${check.target ?? ""} ${check.selector ?? ""}`
      ),
    backend:
      check.kind === "http" ||
      check.kind === "contract" ||
      (check.path ? isBackendPath(check.path) : false) ||
      /\b(api|backend|server|worker|queue|schema|database|auth|contract)\b/i.test(
        `${check.title} ${check.detail} ${check.target ?? ""}`
      ),
    docs:
      check.kind === "docs" ||
      (check.path ? isDocsPath(check.path) : false) ||
      /\b(readme|docs|documentation|guide|quickstart|usage|setup)\b/i.test(
        `${check.title} ${check.detail}`
      )
  };
}

function attributeAcceptanceCheck(
  session: SessionRecord,
  mission: Mission,
  check: AcceptanceCheck
): {
  taskIds: string[];
  owners: AgentName[];
  reason: string | null;
} {
  const tasks = session.tasks
    .filter((task) => task.missionId === mission.id)
    .filter((task) => task.owner === "codex" || task.owner === "claude")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (tasks.length === 0) {
    return {
      taskIds: [],
      owners: [],
      reason: null
    };
  }

  const signals = acceptanceCheckSignals(check);
  const ranked = tasks
    .map((task) => {
      let score = 0;
      const reasons: string[] = [];
      const overlaps = task.claimedPaths.filter((filePath) => {
        if (!check.path) {
          return false;
        }
        return pathsOverlap(filePath, check.path);
      });
      if (overlaps.length > 0) {
        score += overlaps.length * 7;
        reasons.push(`touches ${overlaps.join(", ")}`);
      }
      const evidenceOverlaps = task.claimedPaths.filter((filePath) =>
        (check.evidencePaths ?? []).some((evidencePath) => pathsOverlap(filePath, evidencePath))
      );
      if (evidenceOverlaps.length > 0) {
        score += Math.min(6, evidenceOverlaps.length * 2);
        reasons.push("matches acceptance evidence paths");
      }
      if (signals.frontend && (task.nodeKind === "frontend" || task.claimedPaths.some(isFrontendPath))) {
        score += 4;
        reasons.push("frontend ownership aligns with the check");
      }
      if (
        signals.backend &&
        (
          task.nodeKind === "backend" ||
          task.nodeKind === "shared_contract" ||
          task.nodeKind === "infra" ||
          task.nodeKind === "tests" ||
          task.claimedPaths.some(isBackendPath)
        )
      ) {
        score += 4;
        reasons.push("backend or contract ownership aligns with the check");
      }
      if (signals.docs && (task.nodeKind === "docs" || task.claimedPaths.some(isDocsPath))) {
        score += 4;
        reasons.push("docs ownership aligns with the check");
      }
      if (task.status === "failed") {
        score += 1;
        reasons.push("task already failed and may have left the mission incomplete");
      }
      if (task.status === "completed") {
        score += 1;
      }
      if (check.kind === "scenario" && task.nodeKind === "integration") {
        score += 2;
        reasons.push("integration work aligns with scenario validation");
      }
      if (task.kind === "planner") {
        score -= 2;
      }
      return { task, score, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.task.updatedAt.localeCompare(left.task.updatedAt));

  if (ranked.length === 0) {
    return {
      taskIds: [],
      owners: [],
      reason: null
    };
  }

  const bestScore = ranked[0]?.score ?? 0;
  const top = ranked
    .filter((item) => item.score >= Math.max(4, bestScore - 2))
    .slice(0, 3);
  return {
    taskIds: top.map((item) => item.task.id),
    owners: uniqueStrings(top.map((item) => item.task.owner)).filter(
      (owner): owner is AgentName => owner === "codex" || owner === "claude"
    ),
    reason: top[0]?.reasons.join("; ") || null
  };
}

function annotateAcceptanceChecks(
  session: SessionRecord,
  mission: Mission,
  checks: AcceptanceCheck[]
): AcceptanceCheck[] {
  return checks.map((check) => {
    const attribution = attributeAcceptanceCheck(session, mission, check);
    return {
      ...check,
      likelyTaskIds: attribution.taskIds,
      likelyOwners: attribution.owners,
      likelyReason: attribution.reason
    };
  });
}

async function readPackageManifest(repoRoot: string): Promise<PackageManifest | null> {
  const manifestPath = path.join(repoRoot, "package.json");
  if (!(await fileExists(manifestPath))) {
    return null;
  }

  try {
    return await readJson<PackageManifest>(manifestPath);
  } catch {
    return null;
  }
}

async function detectPackageManager(repoRoot: string): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  if (await fileExists(path.join(repoRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await fileExists(path.join(repoRoot, "yarn.lock"))) {
    return "yarn";
  }
  if ((await fileExists(path.join(repoRoot, "bun.lockb"))) || (await fileExists(path.join(repoRoot, "bun.lock")))) {
    return "bun";
  }
  return "npm";
}

function packageScriptCommand(packageManager: "npm" | "pnpm" | "yarn" | "bun", script: string): string {
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  if (packageManager === "bun") {
    return `bun run ${script}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  return script === "test" ? "npm test" : `npm run ${script}`;
}

function inferServerScriptName(
  scripts: Record<string, string>,
  kind: "http" | "browser"
): string | null {
  const orderedNames =
    kind === "browser"
      ? ["dev", "start", "preview", "web", "frontend", "site", "app", "serve"]
      : ["start", "dev", "serve", "api", "server", "backend", "worker"];

  const scriptNames = Object.keys(scripts);
  for (const preferred of orderedNames) {
    const exact = scriptNames.find((name) => name.toLowerCase() === preferred);
    if (exact) {
      return exact;
    }
    const fuzzy = scriptNames.find((name) => name.toLowerCase().includes(preferred));
    if (fuzzy) {
      return fuzzy;
    }
  }

  return null;
}

function inferNodeServerCommand(repoFiles: string[], kind: "http" | "browser"): string | null {
  const candidates =
    kind === "browser"
      ? [
          "server.js",
          "app.js",
          "index.js",
          "main.js",
          "server.mjs",
          "app.mjs",
          "index.mjs"
        ]
      : [
          "server.js",
          "api/server.js",
          "src/server.js",
          "server.mjs",
          "api/server.mjs",
          "src/server.mjs",
          "app.js",
          "main.js"
        ];

  const match = candidates.find((candidate) => repoFiles.includes(candidate)) ?? null;
  return match ? `node ${shellQuote(match)}` : null;
}

function inferBrowserUrlPath(target: string | null): string {
  if (!target?.trim()) {
    return "/";
  }

  const normalized = target.trim();
  if (normalized.startsWith("/")) {
    return normalized;
  }

  const match = normalized.match(/app\/(.+)\/page\.(tsx|jsx|ts|js)$/i);
  if (match?.[1]) {
    const route = match[1]
      .split("/")
      .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("["))
      .join("/");
    return route ? `/${route}` : "/";
  }

  if (/index\.html$/i.test(normalized) || /page\.(tsx|jsx|ts|js)$/i.test(normalized)) {
    return "/";
  }

  const slug = normalized
    .split("/")
    .find((segment) => /dashboard|home|landing|settings|admin|portal|app/i.test(segment));
  return slug ? `/${slug}` : "/";
}

function inferHttpUrlPath(target: string | null): string {
  if (!target?.trim()) {
    return "/api/health";
  }

  const normalized = target.trim();
  if (normalized.startsWith("/")) {
    return normalized;
  }

  const routeMatch =
    normalized.match(/(?:^|\/)(api\/.+)\/route\.(ts|js)$/i) ??
    normalized.match(/src\/routes\/(.+)\.(ts|js)$/i) ??
    normalized.match(/routes\/(.+)\.(ts|js)$/i);
  if (routeMatch?.[1]) {
    const route = routeMatch[1]
      .replace(/index$/i, "")
      .replaceAll(/\/+/g, "/")
      .replace(/\/$/, "");
    return route.startsWith("api/") ? `/${route}` : `/api/${route}`;
  }

  const segment = normalized
    .split("/")
    .find((item) => /health|status|api|auth|users|tasks|jobs|queue/i.test(item));
  return segment ? (segment.startsWith("api") ? `/${segment}` : `/api/${segment}`) : "/api/health";
}

const GENERIC_UI_EXPECTATION_TOKENS = new Set([
  "app",
  "browser",
  "component",
  "components",
  "experience",
  "flow",
  "frontend",
  "interface",
  "page",
  "screen",
  "shell",
  "site",
  "surface",
  "ui",
  "web"
]);

const UI_PHRASE_ANCHORS = [
  "dashboard",
  "portal",
  "console",
  "workspace",
  "clinic",
  "admin",
  "panel",
  "landing",
  "home",
  "app",
  "shell"
];

const UI_PHRASE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "based",
  "build",
  "create",
  "for",
  "the",
  "tiny",
  "using",
  "visible",
  "web",
  "with"
]);

function isMeaningfulUiExpectation(value: string | null | undefined): boolean {
  const normalized = normalizeLine(String(value ?? ""))
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }

  const nonGenericTokens = tokens.filter((token) => !GENERIC_UI_EXPECTATION_TOKENS.has(token));
  if (nonGenericTokens.length === 0) {
    return false;
  }

  return (
    nonGenericTokens.length >= 2 ||
    nonGenericTokens.some((token) => token.length >= 6 || UI_PHRASE_ANCHORS.includes(token))
  );
}

function inferPromptUiPhrases(mission: Mission): string[] {
  const prompt = normalizeLine(`${mission.title} ${mission.prompt}`.replaceAll(/[_-]+/g, " "));
  if (!prompt) {
    return [];
  }

  const phrases = [
    ...prompt.matchAll(
      /\b([a-z0-9]+(?:\s+[a-z0-9]+){0,2}\s+(?:dashboard|portal|console|workspace|clinic|admin|panel|landing|home|app|shell))\b/gi
    )
  ]
    .map((match) => match[1]?.trim() ?? "")
    .map((phrase) => {
      const tokens = phrase
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/[^a-z0-9-]/g, ""))
        .filter(Boolean)
        .filter((token) => !UI_PHRASE_STOPWORDS.has(token))
        .filter((token) => !/^(node|react|next|frontend|backend|starter|template|slice|flow|screen|page|view)$/.test(token));
      if (tokens.length === 0) {
        return "";
      }
      const anchorIndex = tokens.findLastIndex((token) => UI_PHRASE_ANCHORS.includes(token));
      if (anchorIndex === -1) {
        return "";
      }
      const start = Math.max(0, anchorIndex - 2);
      return tokens.slice(start, anchorIndex + 1).join(" ").trim();
    })
    .filter((phrase) => isMeaningfulUiExpectation(phrase));

  return uniqueStrings(phrases).slice(0, 4);
}

function inferExpectedText(
  mission: Mission,
  target: string | null,
  selector: string | null,
  kind: "http" | "browser"
): string[] {
  const targetSegment = target
    ? target
        .split("/")
        .map((segment) => segment.replace(/\.[^.]+$/, ""))
        .find((segment) => segment && segment.length >= 4 && !/^(page|index|app|src|apps|components?)$/i.test(segment)) ?? null
    : null;

  if (kind === "http") {
    return [];
  }

  return uniqueStrings([
    selector,
    ...inferPromptUiPhrases(mission),
    ...(mission.spec?.requestedDeliverables ?? [])
      .map((value) => value.replaceAll(/[_-]+/g, " "))
      .filter((value) =>
        !/\b(api|backend|worker|queue|docs?|frontend|browser)\b/i.test(value) &&
        isMeaningfulUiExpectation(value)
      )
      .slice(0, 2),
    ...(mission.spec?.userRoles ?? []).filter((value) => isMeaningfulUiExpectation(value)).slice(0, 2),
    targetSegment &&
    !/\b(api|backend|worker|route|server)\b/i.test(targetSegment) &&
    isMeaningfulUiExpectation(targetSegment)
      ? targetSegment
      : null
  ])
    .filter((value) => isMeaningfulUiExpectation(value))
    .slice(0, 4);
}

function inferExpectedHttpText(
  mission: Mission,
  target: string | null,
  sourceFiles: Array<{ path: string; content: string }>
): string[] {
  const candidates = new Set<string>();
  const lowerPrompt = `${mission.title} ${mission.prompt}`.toLowerCase();
  const targetSource = target
    ? sourceFiles.find((file) => file.path === target || pathsOverlap(file.path, target))
    : null;
  const targetContent = targetSource?.content ?? "";

  if (/health|status/i.test(target ?? "") || /health|status/i.test(targetContent)) {
    candidates.add("status");
    candidates.add("ok");
    candidates.add("healthy");
  }
  if (/json/i.test(targetContent) || /application\/json/i.test(targetContent)) {
    candidates.add("status");
  }
  if (/auth/i.test(target ?? "") || /auth/i.test(lowerPrompt)) {
    candidates.add("auth");
    candidates.add("token");
  }
  if (/patient|clinic|hospital/i.test(lowerPrompt)) {
    candidates.add("clinic");
    candidates.add("patient");
  }

  return [...candidates].slice(0, 4);
}

function inferHttpMethod(mission: Mission, target: string | null): string {
  const lower = `${mission.title} ${mission.prompt} ${target ?? ""}`.toLowerCase();
  if (/\b(create|submit|register|signup|sign up|login|log in|authenticate|ingest|enqueue|send|post)\b/.test(lower)) {
    return "POST";
  }
  if (/\b(update|edit|patch|modify)\b/.test(lower)) {
    return "PATCH";
  }
  if (/\b(delete|remove)\b/.test(lower)) {
    return "DELETE";
  }
  return "GET";
}

function inferHttpRequestBody(mission: Mission, method: string): string | null {
  if (method === "GET" || method === "DELETE") {
    return null;
  }

  const keys = uniqueStrings([
    ...(mission.spec?.domainEntities ?? []).map((value) =>
      normalizeLine(value)
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .find((token) => token.length >= 4) ?? ""
    ),
    ...(mission.spec?.userRoles ?? []).map((value) =>
      normalizeLine(value)
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .find((token) => token.length >= 4) ?? ""
    )
  ])
    .filter((value) => value.length >= 4)
    .slice(0, 3);

  const payload = Object.fromEntries(
    (keys.length > 0 ? keys : ["name"]).map((key, index) => [
      key,
      index === 0 ? "example" : index === 1 ? "sample" : "placeholder"
    ])
  );
  return JSON.stringify(payload);
}

function inferExpectedJsonKeys(
  mission: Mission,
  target: string | null,
  sourceFiles: Array<{ path: string; content: string }>
): string[] {
  const keys = new Set<string>();
  const lowerPrompt = `${mission.title} ${mission.prompt}`.toLowerCase();
  const targetSource = target
    ? sourceFiles.find((file) => file.path === target || pathsOverlap(file.path, target))
    : null;
  const targetContent = targetSource?.content ?? "";

  if (/health|status/i.test(target ?? "") || /health|status/i.test(targetContent)) {
    keys.add("status");
    keys.add("ok");
  }
  if (/auth/i.test(target ?? "") || /auth/i.test(lowerPrompt)) {
    keys.add("token");
    keys.add("auth");
  }
  if (/patient|clinic|hospital/i.test(lowerPrompt)) {
    if (/patient/i.test(targetContent)) {
      keys.add("patient");
    }
    if (/clinic|hospital/i.test(targetContent)) {
      keys.add("clinic");
    }
  }
  for (const match of targetContent.matchAll(/["'`]([a-zA-Z][a-zA-Z0-9_-]{1,40})["'`]\s*:/g)) {
    const key = normalizeLine(match[1] ?? "").toLowerCase();
    if (key && !/^(type|id|name|title)$/.test(key)) {
      keys.add(key);
    }
    if (keys.size >= 4) {
      break;
    }
  }
  for (const match of targetContent.matchAll(/\b(status|ok|healthy|health|message|error|result|data)\s*:/gi)) {
    keys.add(normalizeLine(match[1] ?? "").toLowerCase());
    if (keys.size >= 4) {
      break;
    }
  }
  return [...keys].slice(0, 4);
}

function inferRouteCandidates(
  mission: Mission,
  target: string | null,
  evidencePaths: string[],
  kind: "http" | "browser"
): string[] {
  const candidates = new Set<string>();
  const pushCandidate = (value: string | null): void => {
    if (!value?.trim()) {
      return;
    }
    const normalized = value.startsWith("/") ? value : `/${value}`;
    candidates.add(normalized.replace(/\/+/g, "/"));
  };

  pushCandidate(kind === "http" ? inferHttpUrlPath(target) : inferBrowserUrlPath(target));
  for (const evidencePath of evidencePaths) {
    pushCandidate(kind === "http" ? inferHttpUrlPath(evidencePath) : inferBrowserUrlPath(evidencePath));
  }

  if (kind === "browser") {
    pushCandidate("/");
    for (const phrase of inferPromptUiPhrases(mission)) {
      const slug = phrase
        .split(/\s+/)
        .map((token) => token.replace(/[^a-z0-9-]/gi, ""))
        .filter(Boolean)
        .join("-");
      if (slug && slug !== "app") {
        pushCandidate(`/${slug}`);
      }
    }
  } else {
    pushCandidate("/api/health");
    pushCandidate("/api/status");
    pushCandidate("/health");
  }

  return [...candidates].slice(0, 8);
}

function inferSelectorCandidates(
  target: string | null,
  selector: string | null,
  sourceFiles: Array<{ path: string; content: string }>
): string[] {
  const candidates = new Set<string>();
  if (selector?.trim()) {
    candidates.add(selector.trim());
  }

  const likelySources = sourceFiles.filter((file) =>
    target ? file.path === target || pathsOverlap(file.path, target) : isFrontendPath(file.path)
  );
  for (const file of likelySources.slice(0, 4)) {
    const content = file.content;
    for (const match of content.matchAll(/(?:id|data-testid|data-test|aria-label)\s*=\s*["'`]([^"'`]{2,80})["'`]/g)) {
      const value = normalizeLine(match[1] ?? "");
      if (value) {
        candidates.add(value);
      }
    }
    for (const match of content.matchAll(/className\s*=\s*["'`]([^"'`]{2,120})["'`]/g)) {
      const firstClass = normalizeLine(match[1] ?? "").split(/\s+/)[0] ?? "";
      if (firstClass) {
        candidates.add(firstClass);
      }
    }
  }

  for (const generic of ["app-shell", "main", "root", "dashboard", "page"]) {
    candidates.add(generic);
  }
  return [...candidates].slice(0, 8);
}

function inferExpectedContentType(
  target: string | null,
  sourceFiles: Array<{ path: string; content: string }>,
  kind: "http" | "browser"
): string | null {
  if (kind === "browser") {
    return "text/html";
  }
  const candidateSources = target
    ? sourceFiles.filter((file) => file.path === target || pathsOverlap(file.path, target))
    : sourceFiles;
  const content = (candidateSources.length > 0 ? candidateSources : sourceFiles)
    .map((file) => file.content)
    .join("\n");
  if (/application\/json|json\.stringify|res\.json|Response\.json/i.test(content)) {
    return "application/json";
  }
  if (/text\/plain|res\.send|res\.end/i.test(content)) {
    return "text/plain";
  }
  return null;
}

function inferExpectedTitle(
  mission: Mission,
  target: string | null
): string | null {
  return (
    inferPromptUiPhrases(mission)[0] ??
    inferExpectedText(mission, target, null, "browser")[0] ??
    null
  );
}

function findScriptName(
  scripts: Record<string, string>,
  matcher: RegExp
): string | null {
  return Object.keys(scripts).find((name) => matcher.test(name)) ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function acceptanceHarnessDir(session: SessionRecord, mission: Mission): string {
  return path.join(session.repoRoot, ".kavi", "runtime", "acceptance", mission.id);
}

function buildAcceptanceHarnessCommand(harnessPath: string): string {
  return `node ${shellQuote(harnessPath)} .`;
}

async function ensureAcceptanceHarness(
  session: SessionRecord,
  mission: Mission,
  check: AcceptanceCheck
): Promise<AcceptanceCheck> {
  if (
    check.kind !== "http" &&
    check.kind !== "browser" &&
    check.kind !== "scenario" &&
    check.kind !== "contract" &&
    check.kind !== "docs" &&
    check.kind !== "file"
  ) {
    return check;
  }
  if (check.command?.trim()) {
    return check;
  }

  const harnessDir = acceptanceHarnessDir(session, mission);
  await fs.mkdir(harnessDir, { recursive: true });
  const harnessPath = path.join(harnessDir, `${check.id}.mjs`);
  const payload = {
    kind: check.kind,
    title: check.title,
    detail: check.detail,
    path: check.path,
    serverCommand: check.serverCommand ?? null,
    target: check.target ?? null,
    urlPath: check.urlPath ?? null,
    routeCandidates: check.routeCandidates ?? [],
    method: check.method ?? "GET",
    requestBody: check.requestBody ?? null,
    requestHeaders: check.requestHeaders ?? {},
    selector: check.selector ?? null,
    selectorCandidates: check.selectorCandidates ?? [],
    expectedTitle: check.expectedTitle ?? null,
    expectedStatus: check.expectedStatus ?? null,
    expectedContentType: check.expectedContentType ?? null,
    expectedJsonKeys: check.expectedJsonKeys ?? [],
    expectedText: check.expectedText ?? [],
    evidencePaths: check.evidencePaths ?? []
  };
  const script = `import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const spec = ${JSON.stringify(payload, null, 2)};
const COMMON_PORTS = ["4173", "3000", "3001", "4321", "5173", "8080", "8000"];

async function readFileSafe(root, relativePath) {
  try {
    const absolute = path.join(root, relativePath);
    const content = await fs.readFile(absolute, "utf8");
    return { path: relativePath, content };
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLower(value) {
  return String(value || "").toLowerCase();
}

function normalizedSearch(value) {
  return safeLower(value).replace(/[^a-z0-9]+/g, " ");
}

function buildCandidateUrls(routeCandidates, announcedUrls, ports) {
  const normalizedRoutes = unique(
    (Array.isArray(routeCandidates) && routeCandidates.length > 0 ? routeCandidates : ["/"]).map((value) =>
      String(value || "/").startsWith("/") ? String(value || "/") : \`/\${String(value || "/")}\`
    )
  );
  const announced = announcedUrls.flatMap((value) => {
    try {
      const parsed = new URL(value);
      return normalizedRoutes.flatMap((route) => [\`\${parsed.origin}\${route}\`, value]);
    } catch {
      return [];
    }
  });
  const probed = ports.flatMap((port) =>
    normalizedRoutes.flatMap((route) => [
      \`http://127.0.0.1:\${port}\${route}\`,
      \`http://localhost:\${port}\${route}\`
    ])
  );
  return unique([...announced, ...probed]);
}

function createServerRunner(root, command) {
  const shell = process.env.SHELL || "zsh";
  const preferredPort = process.env.PORT || "4173";
  const readyUrls = [];
  let logs = "";
  const child = spawn(shell, ["-lc", command], {
    cwd: root,
    env: {
      ...process.env,
      PORT: preferredPort
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const capture = (chunk) => {
    const text = String(chunk || "");
    logs = \`\${logs}\${text}\`.slice(-8000);
    const matches = text.match(/https?:\\/\\/(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|localhost):\\d+[^\\s"'\\x60]+/g) || [];
    for (const match of matches) {
      readyUrls.push(match.replace("0.0.0.0", "127.0.0.1"));
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return {
    child,
    preferredPort,
    getLogs: () => logs,
    getReadyUrls: () => [...readyUrls]
  };
}

async function waitForServer(routeCandidates, runner, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    if (runner.child.exitCode !== null) {
      throw new Error(\`Server command exited before becoming ready. Logs: \${runner.getLogs() || "-"}\`);
    }
    const ports =
      runner.getReadyUrls().length > 0
        ? COMMON_PORTS
        : Date.now() - startedAt > 4_000
          ? COMMON_PORTS
          : [runner.preferredPort];
    const urls = buildCandidateUrls(routeCandidates, runner.getReadyUrls(), ports);
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          redirect: "manual"
        });
        return {
          url,
          response
        };
      } catch {
        continue;
      }
    }
    await sleep(500);
  }
  throw new Error(\`Server did not become ready for \${spec.title}. Logs: \${runner.getLogs() || "-"}\`);
}

async function stopServer(runner) {
  if (!runner) {
    return;
  }
  if (runner.child.exitCode !== null) {
    return;
  }
  runner.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => runner.child.once("close", resolve)),
    sleep(1500).then(() => {
      if (runner.child.exitCode === null) {
        runner.child.kill("SIGKILL");
      }
    })
  ]);
}

async function main() {
  const root = path.resolve(process.argv[2] || ".");
  let runner = null;
  if ((spec.kind === "http" || spec.kind === "browser") && spec.serverCommand) {
    runner = createServerRunner(root, spec.serverCommand);
    try {
      const routeCandidates =
        Array.isArray(spec.routeCandidates) && spec.routeCandidates.length > 0
          ? spec.routeCandidates
          : [spec.urlPath || (spec.kind === "http" ? "/api/health" : "/")];
      await waitForServer(routeCandidates, runner);
      const expectations = unique((spec.expectedText || []).map((value) => normalizedSearch(value)).filter(Boolean));
      const selectorCandidates = unique(
        [spec.selector, ...(Array.isArray(spec.selectorCandidates) ? spec.selectorCandidates : [])]
          .map((value) => normalizedSearch(value))
          .filter(Boolean)
      );
      const expectedStatus =
        typeof spec.expectedStatus === "number" && Number.isFinite(spec.expectedStatus)
          ? spec.expectedStatus
          : 200;
      const expectedContentType = safeLower(spec.expectedContentType || "");
      const expectedJsonKeys = unique((spec.expectedJsonKeys || []).map((value) => safeLower(value)).filter(Boolean));
      const expectedTitle = normalizedSearch(spec.expectedTitle || "");
      const requestHeaders =
        spec.requestHeaders && typeof spec.requestHeaders === "object" && !Array.isArray(spec.requestHeaders)
          ? spec.requestHeaders
          : {};
      const attempted = [];
      for (const url of buildCandidateUrls(routeCandidates, runner.getReadyUrls(), COMMON_PORTS)) {
        try {
          const response = await fetch(url, {
            method: spec.method || "GET",
            headers: requestHeaders,
            body: spec.requestBody || undefined,
            redirect: "manual"
          });
          const body = await response.text();
          const lowered = safeLower(body);
          const normalizedBody = normalizedSearch(body);
          const contentType = safeLower(response.headers.get("content-type") || "");
          const htmlTitle =
            body.match(/<title[^>]*>([^<]+)<\\/title>/i)?.[1]?.trim()?.toLowerCase() ?? "";
          attempted.push(\`\${spec.method || "GET"} \${url} [\${response.status} \${contentType || "-"}]\`);
          if (response.status >= 500) {
            continue;
          }
          if (response.status !== expectedStatus && !(expectedStatus === 200 && response.ok)) {
            continue;
          }
          if (expectedContentType && !contentType.includes(expectedContentType)) {
            continue;
          }
          if (spec.kind === "browser") {
            if (!/<html|<body|<main|<div|<!doctype/i.test(body)) {
              continue;
            }
            if (expectations.length > 0 && !expectations.some((value) => normalizedBody.includes(value))) {
              continue;
            }
            if (expectedTitle && !normalizedSearch(htmlTitle).includes(expectedTitle)) {
              continue;
            }
            if (selectorCandidates.length > 0 && !selectorCandidates.some((value) => normalizedBody.includes(value))) {
              continue;
            }
          } else if (expectations.length > 0 && !expectations.some((value) => lowered.includes(value) || normalizedBody.includes(value))) {
            continue;
          }
          if (spec.kind === "http" && expectedJsonKeys.length > 0 && contentType.includes("json")) {
            let parsed = null;
            try {
              parsed = JSON.parse(body);
            } catch {
              continue;
            }
            const serialized = normalizedSearch(JSON.stringify(parsed));
            if (!expectedJsonKeys.every((value) => serialized.includes(normalizedSearch(value)))) {
              continue;
            }
          }
          console.log(\`ok: \${spec.kind} runtime harness matched \${url}\`);
          return;
        } catch (error) {
          attempted.push(\`\${url} [error: \${error instanceof Error ? error.message : String(error)}]\`);
        }
      }
      throw new Error(
        \`\${spec.kind === "browser" ? "Browser" : "HTTP"} harness could not find a matching runtime surface for \${spec.title}. Tried: \${attempted.join(" | ")}\`
      );
    } finally {
      await stopServer(runner);
    }
  }

  const fallbackPaths =
    spec.kind === "docs"
      ? ["README.md", "docs"]
      : [];
  const candidatePaths = unique([spec.path, spec.target, ...(spec.evidencePaths || []), ...fallbackPaths]);
  const files = (await Promise.all(candidatePaths.map((filePath) => readFileSafe(root, filePath)))).filter(Boolean);
  if (spec.kind === "file" && spec.path) {
    const matched = files.some((file) => file.path === spec.path);
    if (!matched) {
      throw new Error(\`Expected file \${spec.path} was not found.\`);
    }
    console.log(\`ok: file harness matched \${spec.path}\`);
    return;
  }

  if (files.length === 0) {
    throw new Error(\`No evidence files were found for \${spec.title}.\`);
  }

  const joined = files.map((file) => \`\${file.path}\\n\${file.content}\`).join("\\n\\n").toLowerCase();
  if (spec.kind === "docs") {
    const hasDocsSignals = files.some((file) => file.path === "README.md" || file.path.startsWith("docs/"));
    if (!hasDocsSignals) {
      throw new Error(\`Docs harness could not find README.md or docs/ surfaces for \${spec.title}.\`);
    }
  } else if (spec.kind === "contract") {
    const contractSignals = [
      "schema",
      "contract",
      "type ",
      "interface ",
      "zod",
      "dto",
      "domain",
      "/api/",
      spec.target,
      spec.path
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    const matched = contractSignals.some((signal) => joined.includes(signal));
    if (!matched) {
      throw new Error(\`Contract harness could not find interface or schema signals for \${spec.title}.\`);
    }
  } else if (spec.kind === "scenario") {
    const detail = String(spec.detail || "").toLowerCase();
    const requiresFrontend = /(ui|frontend|screen|page|layout|browser|user)/.test(detail);
    const requiresBackend = /(api|backend|server|queue|worker|auth|database)/.test(detail);
    const hasFrontend = /app\\/page|index\\.html|layout|component|screen|return\\s*\\(|<main|<section/.test(joined);
    const hasBackend = /route\\.|router|handler|endpoint|server|queue|worker|schema|database|app\\.(get|post|put|delete)\\(/.test(joined);
    if ((requiresFrontend && !hasFrontend) || (requiresBackend && !hasBackend)) {
      throw new Error(
        \`Scenario harness missing implied surfaces for \${spec.title}: frontend=\${hasFrontend ? "yes" : "no"} backend=\${hasBackend ? "yes" : "no"}.\`
      );
    }
  } else if (spec.kind === "http") {
    const apiSignals = [
      "/api/",
      "route.",
      "router",
      "handler",
      "endpoint",
      "app.get(",
      "app.post(",
      "get(",
      "post(",
      "fetch(",
      ...(Array.isArray(spec.routeCandidates) ? spec.routeCandidates : []),
      spec.target,
      spec.path
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    const matched = apiSignals.some((signal) => joined.includes(signal));
    if (!matched) {
      throw new Error(\`API harness could not find route or handler signals for \${spec.target || spec.path || spec.title}.\`);
    }
  } else if (spec.kind === "browser") {
    const browserSignals = [
      "<main",
      "<section",
      "export default",
      "return (",
      "return(",
      "component",
      "hero",
      "layout",
      ...(Array.isArray(spec.selectorCandidates) ? spec.selectorCandidates : []),
      ...(Array.isArray(spec.routeCandidates) ? spec.routeCandidates : []),
      spec.selector,
      spec.target,
      spec.path
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    const matched = browserSignals.some((signal) => joined.includes(signal));
    if (!matched) {
      throw new Error(\`Browser harness could not find UI structure signals for \${spec.target || spec.path || spec.title}.\`);
    }
  }

  console.log(\`ok: \${spec.kind} harness matched \${files.map((file) => file.path).join(", ")}\`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

  await fs.writeFile(harnessPath, script, "utf8");
  check.harnessPath = harnessPath;
  check.command = buildAcceptanceHarnessCommand(harnessPath);
  return check;
}

export async function synthesizeMissionAcceptanceChecks(
  repoRoot: string,
  session: SessionRecord,
  mission: Mission
): Promise<void> {
  const drafts: AcceptanceCheckDraft[] = [];
  const packageManifest = await readPackageManifest(repoRoot);
  const packageManager = await detectPackageManager(repoRoot);
  const scripts = packageManifest?.scripts ?? {};
  const repoFiles = await collectRepoFiles(repoRoot);
  const sourceFiles = await readLikelySourceFiles(
    repoRoot,
    uniqueStrings([...repoFiles, ...session.tasks.flatMap((task) => task.missionId === mission.id ? task.claimedPaths : [])]),
    () => true,
    24
  );
  const completedTasks = session.tasks.filter(
    (task) => task.missionId === mission.id && task.status === "completed"
  );
  const changedPaths = new Set(completedTasks.flatMap((task) => task.claimedPaths));
  const changedPathList = [...changedPaths];
  const frontendPaths = uniqueStrings([
    ...changedPathList.filter(isFrontendPath),
    ...sourceFiles.filter((file) => isBrowserSurfaceContent(file.content)).map((file) => file.path)
  ]);
  const backendPaths = uniqueStrings([
    ...changedPathList.filter(isBackendPath),
    ...sourceFiles.filter((file) => isApiSurfaceContent(file.content)).map((file) => file.path)
  ]);
  const readmeExists =
    changedPathList.includes("README.md") || await fileExists(path.join(repoRoot, "README.md"));
  const docsPaths = uniqueStrings([
    ...(readmeExists ? ["README.md"] : []),
    ...changedPathList.filter(isDocsPath).slice(0, 12)
  ]);
  const contractPaths = uniqueStrings(
    [
      ...changedPathList.filter((filePath) =>
        filePath.includes("domain") ||
        filePath.includes("schema") ||
        filePath.includes("types") ||
        filePath.includes("contract") ||
        filePath.includes("api")
      ),
      ...sourceFiles.filter((file) => isContractBearingContent(file.content)).map((file) => file.path)
    ].slice(0, 12)
  );
  const hasContractSignals =
    wantsBackend(mission) ||
    backendPaths.length > 0 ||
    contractPaths.length > 0 ||
    (mission.spec?.workstreamKinds ?? []).some((item) => item === "shared_contract" || item === "backend");
  const browserScript =
    findScriptName(scripts, /^(test:)?e2e$/i) ??
    findScriptName(scripts, /playwright|cypress|test:ui|test:browser/i);
  const apiScript =
    findScriptName(scripts, /test:api|test:server|api:test|contract/i) ??
    findScriptName(scripts, /integration/i);
  const browserServerScript = inferServerScriptName(scripts, "browser");
  const apiServerScript = inferServerScriptName(scripts, "http");
  const browserServerCommand = browserServerScript
    ? packageScriptCommand(packageManager, browserServerScript)
    : inferNodeServerCommand(repoFiles, "browser");
  const apiServerCommand = apiServerScript
    ? packageScriptCommand(packageManager, apiServerScript)
    : inferNodeServerCommand(repoFiles, "http");

  if (scripts.test) {
    addDraftIfMissing(drafts, {
      title: "Run project tests",
      kind: "command",
      command: packageScriptCommand(packageManager, "test"),
      path: null,
      detail: "Exercise the current project test suite."
    });
  }

  if ((wantsFrontend(mission) || [...changedPaths].some((filePath) => filePath.includes("web") || filePath.endsWith(".tsx") || filePath.endsWith(".html"))) && scripts.build) {
    addDraftIfMissing(drafts, {
      title: "Build the current app",
      kind: "command",
      command: packageScriptCommand(packageManager, "build"),
      path: null,
      detail: "Build the current project to catch integration and bundling issues."
    });
  }

  if (await fileExists(path.join(repoRoot, "go.mod"))) {
    addDraftIfMissing(drafts, {
      title: "Run Go tests",
      kind: "command",
      command: "go test ./...",
      path: null,
      detail: "Exercise the Go package test suite."
    });
  }

  if (await fileExists(path.join(repoRoot, "Cargo.toml"))) {
    addDraftIfMissing(drafts, {
      title: "Run Rust tests",
      kind: "command",
      command: "cargo test",
      path: null,
      detail: "Exercise the Rust crate test suite."
    });
  }

  if (
    (await fileExists(path.join(repoRoot, "pyproject.toml"))) ||
    (await fileExists(path.join(repoRoot, "pytest.ini"))) ||
    (await fileExists(path.join(repoRoot, "tests")))
  ) {
    addDraftIfMissing(drafts, {
      title: "Run Python tests",
      kind: "command",
      command: "pytest",
      path: null,
      detail: "Exercise the Python test suite."
    });
  }

  if (wantsDocs(mission) || await fileExists(path.join(repoRoot, "README.md"))) {
    const primaryDocsPath = docsPaths.find((filePath) => filePath === "README.md") ?? docsPaths[0] ?? "README.md";
    const isReadmePrimary = primaryDocsPath === "README.md";
    addDraftIfMissing(drafts, {
      title: isReadmePrimary ? "README exists" : "Runbook or quickstart docs exist",
      kind: "docs",
      command: null,
      path: primaryDocsPath,
      evidencePaths: docsPaths,
      detail: isReadmePrimary
        ? "Verify the repository includes a README for setup and usage."
        : `Verify the repository includes usage or quickstart documentation such as ${primaryDocsPath}.`
    });
  }

  if (wantsBackend(mission) && completedTasks.some((task) => task.claimedPaths.some((filePath) => filePath.includes("api") || filePath.includes("server")))) {
    addDraftIfMissing(drafts, {
      title: "Backend implementation surface exists",
      kind: "file",
      command: null,
      path: [...changedPaths].find((filePath) => filePath.includes("api") || filePath.includes("server")) ?? null,
      evidencePaths: backendPaths.slice(0, 8),
      detail: "Verify the mission produced backend implementation files."
    });
  }

  if (wantsFrontend(mission) && completedTasks.some((task) => task.claimedPaths.some((filePath) => filePath.includes("web") || filePath.endsWith(".tsx") || filePath.endsWith(".html")))) {
    addDraftIfMissing(drafts, {
      title: "Frontend implementation surface exists",
      kind: "file",
      command: null,
      path: [...changedPaths].find((filePath) => filePath.includes("web") || filePath.endsWith(".tsx") || filePath.endsWith(".html")) ?? null,
      evidencePaths: frontendPaths.slice(0, 8),
      detail: "Verify the mission produced frontend implementation files."
    });
  }

  if (wantsBackend(mission) || backendPaths.length > 0) {
    const apiTarget = backendPaths.find(isApiRouteLike) ?? backendPaths[0] ?? null;
    const routeCandidates = inferRouteCandidates(mission, apiTarget, backendPaths, "http");
    const method = inferHttpMethod(mission, apiTarget);
    const requestBody = inferHttpRequestBody(mission, method);
    addDraftIfMissing(drafts, {
      title: apiScript ? "Run API or integration check" : "Primary API or backend route surface exists",
      kind: "http",
      command: apiScript ? packageScriptCommand(packageManager, apiScript) : null,
      path: backendPaths[0] ?? null,
      serverCommand: apiScript ? null : apiServerCommand,
      target: apiTarget,
      urlPath: routeCandidates[0] ?? inferHttpUrlPath(apiTarget),
      routeCandidates,
      method,
      requestBody,
      requestHeaders: requestBody
        ? {
            "content-type": "application/json",
            accept: "application/json"
          }
        : {
            accept: "application/json"
          },
      evidencePaths: backendPaths.slice(0, 8),
      expectedText: inferExpectedHttpText(mission, apiTarget, sourceFiles),
      expectedStatus: 200,
      expectedContentType: inferExpectedContentType(apiTarget, sourceFiles, "http"),
      expectedJsonKeys: inferExpectedJsonKeys(mission, apiTarget, sourceFiles),
      detail: apiScript
        ? `Run ${apiScript} to validate the backend/API slice for this mission.`
        : "Verify the mission produced a plausible API, handler, or backend route surface for the requested slice."
    });
  }

  if (wantsFrontend(mission) || frontendPaths.length > 0) {
    const browserTarget =
      frontendPaths.find((filePath) => /app\/page|index\.html|page\.(tsx|jsx|ts|js)$/i.test(filePath)) ??
      frontendPaths[0] ??
      null;
    const selector = frontendPaths.some((filePath) => filePath.includes("/app/")) ? "app-shell" : null;
    const routeCandidates = inferRouteCandidates(mission, browserTarget, frontendPaths, "browser");
    const selectorCandidates = inferSelectorCandidates(browserTarget, selector, sourceFiles);
    addDraftIfMissing(drafts, {
      title: browserScript ? "Run browser or end-to-end UI check" : "Primary browser flow surface exists",
      kind: "browser",
      command: browserScript ? packageScriptCommand(packageManager, browserScript) : null,
      path: frontendPaths[0] ?? null,
      serverCommand: browserScript ? null : browserServerCommand,
      target: browserTarget,
      urlPath: routeCandidates[0] ?? inferBrowserUrlPath(browserTarget),
      routeCandidates,
      selector,
      selectorCandidates,
      expectedTitle: inferExpectedTitle(mission, browserTarget),
      evidencePaths: frontendPaths.slice(0, 8),
      expectedText: inferExpectedText(mission, browserTarget, selector, "browser"),
      expectedStatus: 200,
      expectedContentType: inferExpectedContentType(browserTarget, sourceFiles, "browser"),
      detail: browserScript
        ? `Run ${browserScript} to validate the user-facing flow.`
        : "Verify the mission produced a plausible browser-facing shell or UI route for the requested slice."
    });
  }

  for (const scenario of mission.contract?.scenarios ?? []) {
    const docsScenario = isDocsScenario(scenario);
    const scenarioEvidencePaths = uniqueStrings([
      ...frontendPaths.slice(0, 6),
      ...backendPaths.slice(0, 6),
      ...(docsScenario || (frontendPaths.length === 0 && backendPaths.length === 0) ? docsPaths.slice(0, 6) : [])
    ]);
    addDraftIfMissing(drafts, {
      title: `Scenario: ${scenario}`,
      kind: "scenario",
      command: null,
      path: null,
      evidencePaths: scenarioEvidencePaths,
      detail: scenario
    });
  }

  if (hasContractSignals) {
    addDraftIfMissing(drafts, {
      title: "Contract surfaces exist",
      kind: "contract",
      command: null,
      path: null,
      evidencePaths: contractPaths,
      detail: "Verify the mission produced the expected interface or contract-bearing implementation surfaces."
    });
  }

  if ((mission.contract?.docsExpectations ?? []).length > 0) {
    addDraftIfMissing(drafts, {
      title: "Docs expectations are represented",
      kind: "docs",
      command: null,
      path: "README.md",
      evidencePaths: docsPaths,
      detail: mission.contract.docsExpectations.join(" | ")
    });
  }

  mission.acceptance.checks = annotateAcceptanceChecks(
    session,
    mission,
    reconcileAcceptanceChecks(mission.acceptance.checks, drafts)
  );

  for (const check of mission.acceptance.checks) {
    await ensureAcceptanceHarness(session, mission, check);
  }
}

export function failingAcceptanceChecks(mission: Mission): AcceptanceCheck[] {
  return mission.acceptance.checks.filter((check) => check.status === "failed");
}

export function acceptanceFailureFingerprint(mission: Mission): string {
  return acceptanceFailureFingerprintForChecks(failingAcceptanceChecks(mission));
}

export function acceptanceFailureFingerprintForChecks(checks: AcceptanceCheck[]): string {
  return checks
    .map((check) => buildCheckKey(check))
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
}

export function summarizeAcceptanceFailures(mission: Mission): string[] {
  return explainMissionAcceptanceFailures(mission).map((explanation) => explanation.summary);
}

export interface AcceptanceFailureExplanation {
  checkId: string;
  title: string;
  summary: string;
  expected: string[];
  observed: string[];
  evidence: string[];
  likelyOwners: AgentName[];
  likelyTaskIds: string[];
  attribution: string | null;
  repairFocus: string[];
}

function buildExpectedAcceptanceSignals(check: AcceptanceCheck): string[] {
  return uniqueStrings([
    check.path ? `path ${check.path}` : null,
    check.command ? `command ${check.command}` : null,
    check.serverCommand ? `server ${check.serverCommand}` : null,
    check.urlPath ? `URL ${check.urlPath}` : null,
    ...(check.routeCandidates ?? []).map((candidate) => `route ${candidate}`),
    check.method ? `method ${check.method}` : null,
    check.requestBody ? `request-body ${check.requestBody}` : null,
    ...Object.entries(check.requestHeaders ?? {}).map(([key, value]) => `header ${key}:${value}`),
    check.selector ? `selector ${check.selector}` : null,
    ...(check.selectorCandidates ?? []).map((candidate) => `selector ${candidate}`),
    check.expectedTitle ? `title ${check.expectedTitle}` : null,
    typeof check.expectedStatus === "number" ? `HTTP ${check.expectedStatus}` : null,
    check.expectedContentType ? `content-type ${check.expectedContentType}` : null,
    ...(check.expectedJsonKeys ?? []).map((key) => `json-key ${key}`),
    ...(check.expectedText ?? []).map((text) => `text ${text}`)
  ]);
}

function buildObservedAcceptanceSignals(check: AcceptanceCheck): string[] {
  return uniqueStrings([
    check.lastOutput ? normalizeLine(check.lastOutput).slice(0, 320) : null,
    check.detail ? normalizeLine(check.detail).slice(0, 220) : null
  ]);
}

function buildRepairFocus(check: AcceptanceCheck): string[] {
  return uniqueStrings([
    check.path ? `Inspect ${check.path}` : null,
    check.serverCommand ? `Run ${check.serverCommand}` : null,
    check.urlPath ? `Validate ${check.urlPath}` : null,
    check.method && check.method !== "GET" ? `Exercise ${check.method} flow` : null,
    check.requestBody ? "Confirm request payload handling" : null,
    check.selector ? `Confirm selector ${check.selector}` : null,
    check.expectedTitle ? `Render title ${check.expectedTitle}` : null,
    ...(check.expectedJsonKeys ?? []).slice(0, 3).map((key) => `Return JSON key ${key}`),
    ...(check.expectedText ?? []).slice(0, 3).map((text) => `Render ${text}`),
    ...(check.evidencePaths ?? []).slice(0, 4).map((evidence) => `Check ${evidence}`)
  ]);
}

export function explainAcceptanceFailure(check: AcceptanceCheck): AcceptanceFailureExplanation {
  const expected = buildExpectedAcceptanceSignals(check);
  const observed = buildObservedAcceptanceSignals(check);
  const evidence = uniqueStrings(check.evidencePaths ?? []);
  const likelyOwners = (check.likelyOwners ?? []).filter(
    (owner): owner is AgentName => owner === "codex" || owner === "claude"
  );
  const likelyTaskIds = uniqueStrings(check.likelyTaskIds ?? []);
  const attribution = check.likelyReason ?? null;
  const repairFocus = buildRepairFocus(check);

  const summaryParts = [
    check.title,
    expected.length > 0 ? `expected ${expected.slice(0, 3).join(", ")}` : null,
    observed[0] ? `observed ${observed[0]}` : null,
    likelyOwners.length > 0 ? `likely owner ${likelyOwners.join("/")}` : null
  ].filter(Boolean);

  return {
    checkId: check.id,
    title: check.title,
    summary: summaryParts.join(" | "),
    expected,
    observed,
    evidence,
    likelyOwners,
    likelyTaskIds,
    attribution,
    repairFocus
  };
}

export function explainMissionAcceptanceFailures(mission: Mission): AcceptanceFailureExplanation[] {
  return failingAcceptanceChecks(mission).map((check) => explainAcceptanceFailure(check));
}

export function buildAcceptanceRepairPrompt(
  mission: Mission,
  checks: AcceptanceCheck[] = failingAcceptanceChecks(mission)
): string {
  const failedChecks = checks;
  const explanations = failedChecks.map((check) => explainAcceptanceFailure(check));
  const lines = [
    `Repair the mission so the acceptance suite passes for: ${mission.title}.`,
    `Mission summary: ${mission.summary}`,
    "The last verification failed on these checks:"
  ];

  for (const [index, check] of failedChecks.entries()) {
    const explanation = explanations[index] ?? null;
    lines.push(
      `- ${check.title}${check.path ? ` [path=${check.path}]` : check.command ? ` [command=${check.command}]` : ""}: ${normalizeLine(check.lastOutput ?? check.detail).slice(0, 320)}`
    );
    if ((check.likelyOwners ?? []).length > 0 || (check.likelyTaskIds ?? []).length > 0) {
      lines.push(
        `  likely owners: ${(check.likelyOwners ?? []).join(", ") || "-"} | likely tasks: ${(check.likelyTaskIds ?? []).join(", ") || "-"}`
      );
    }
    if (check.likelyReason) {
      lines.push(`  attribution: ${check.likelyReason}`);
    }
    if (explanation) {
      if (explanation.expected.length > 0) {
        lines.push(`  expected: ${explanation.expected.join(" | ")}`);
      }
      if (explanation.evidence.length > 0) {
        lines.push(`  evidence: ${explanation.evidence.join(", ")}`);
      }
      if (explanation.repairFocus.length > 0) {
        lines.push(`  repair focus: ${explanation.repairFocus.join(" | ")}`);
      }
    }
  }

  if (mission.contract?.acceptanceCriteria?.length) {
    lines.push("Acceptance contract:");
    for (const criterion of mission.contract.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }

  lines.push("Make the smallest coherent set of changes needed, keep the repo runnable, and update docs/tests if the fix changes behavior.");
  return lines.join("\n");
}

export interface AcceptanceRepairRoutePlan {
  owner: AgentName;
  claimedPaths: string[];
  routeReason: string;
  routeStrategy: RouteStrategy;
  routeConfidence: number;
  routeMetadata: Record<string, unknown>;
}

export interface AcceptanceRepairTaskPlan extends AcceptanceRepairRoutePlan {
  failedChecks: AcceptanceCheck[];
  failureFingerprint: string;
  prompt: string;
}

export async function evaluateAcceptanceCheck(
  repoRoot: string,
  mission: Mission,
  check: AcceptanceCheck
): Promise<{
  status: AcceptanceCheck["status"];
  detail: string;
  lastOutput: string;
}> {
  if (
    check.kind !== "command" &&
    check.command?.trim()
  ) {
    const shell = process.env.SHELL || "zsh";
    const result = await runCommand(shell, ["-lc", check.command], {
      cwd: repoRoot
    });
    return {
      status: result.code === 0 ? "passed" : "failed",
      detail:
        result.code === 0
          ? `Passed: ${check.command}`
          : `Failed (${result.code}): ${check.command}`,
      lastOutput: [result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000)
    };
  }

  if (check.kind === "file" && check.path) {
    const exists = await fs.access(path.join(repoRoot, check.path))
      .then(() => true)
      .catch(() => false);
    return {
      status: exists ? "passed" : "failed",
      detail: exists ? `Passed: ${check.path} exists.` : `Failed: ${check.path} does not exist.`,
      lastOutput: exists ? `Found ${check.path}` : `Missing ${check.path}`
    };
  }

  if (check.kind === "docs") {
    const readmeExists = await fileExists(path.join(repoRoot, "README.md"));
    const docsExists = await fileExists(path.join(repoRoot, "docs"));
    const passed = readmeExists || docsExists;
    return {
      status: passed ? "passed" : "failed",
      detail: passed ? "Passed: docs surface exists." : "Failed: no README or docs surface was found.",
      lastOutput: passed
        ? `Found ${readmeExists ? "README.md" : "docs/"}`
        : "Missing README.md and docs/"
    };
  }

  const repoFiles = await collectRepoFiles(repoRoot);

  if (check.kind === "contract") {
    const sourceFiles = await readLikelySourceFiles(repoRoot, repoFiles, () => true, 24);
    const hasContractSurface =
      repoFiles.some((filePath) =>
        filePath.includes("domain") ||
        filePath.includes("schema") ||
        filePath.includes("types") ||
        filePath.includes("contract") ||
        filePath.includes("api") ||
        filePath.endsWith(".go") ||
        filePath.endsWith(".ts") ||
        filePath.endsWith(".tsx") ||
        filePath.endsWith(".mjs") ||
        filePath.endsWith(".js")
      ) ||
      sourceFiles.some(({ content }) => isContractBearingContent(content));
    return {
      status: hasContractSurface ? "passed" : "failed",
      detail: hasContractSurface
        ? "Passed: contract-bearing implementation surfaces exist."
        : "Failed: no obvious contract-bearing implementation surfaces were found.",
      lastOutput: hasContractSurface
        ? `Matched: ${sourceFiles.find((file) => isContractBearingContent(file.content))?.path ?? repoFiles.find((filePath) =>
            filePath.includes("domain") ||
            filePath.includes("schema") ||
            filePath.includes("types") ||
            filePath.includes("contract") ||
            filePath.includes("api")
          ) ?? repoFiles[0] ?? "-"}`
        : "No shared/domain/api/type surface matched."
    };
  }

  if (check.kind === "http") {
    const sourceFiles = await readLikelySourceFiles(
      repoRoot,
      repoFiles,
      (filePath) => isBackendPath(filePath) || isApiRouteLike(filePath)
    );
    const targetTokens = uniqueStrings([
      check.target,
      ...(check.evidencePaths ?? []),
      check.path
    ])
      .flatMap((value) => normalizeLine(value).split(/[^a-z0-9]+/i))
      .filter((token) => token.length >= 3);
    const matchingSources = sourceFiles.filter(({ path: filePath, content }) => {
      if (targetTokens.length === 0) {
        return isApiRouteLike(filePath);
      }
      const haystack = `${filePath}\n${content}`.toLowerCase();
      return targetTokens.some((token) => haystack.includes(token.toLowerCase()));
    });
    const hasJsonKeySignals =
      (check.expectedJsonKeys ?? []).length === 0 ||
      matchingSources.some(({ content }) => {
        const lowered = content.toLowerCase();
        return (check.expectedJsonKeys ?? []).every((key) => lowered.includes(key.toLowerCase()));
      });
    const hasMethodSignals =
      !check.method ||
      check.method === "GET" ||
      matchingSources.some(({ content }) => {
        const lowered = content.toLowerCase();
        return (
          lowered.includes(check.method!.toLowerCase()) ||
          lowered.includes(`app.${check.method!.toLowerCase()}`) ||
          lowered.includes(`router.${check.method!.toLowerCase()}`)
        );
      });
    const passed =
      (matchingSources.length > 0 || sourceFiles.some(({ content }) => isApiSurfaceContent(content)) || repoFiles.some(isApiRouteLike)) &&
      hasJsonKeySignals &&
      hasMethodSignals;
    return {
      status: passed ? "passed" : "failed",
      detail: passed
        ? "Passed: backend/API route-bearing surfaces exist for the mission."
        : !hasMethodSignals
          ? `Failed: backend sources exist, but they do not align with the expected ${check.method} flow.`
          : hasJsonKeySignals
          ? "Failed: no plausible backend/API route surfaces were found for this mission."
          : "Failed: backend/API sources exist, but they do not expose the expected JSON contract signals.",
      lastOutput: passed
        ? `Matched: ${summarizeEvidencePaths(matchingSources.map((item) => item.path), summarizeEvidencePaths((check.evidencePaths ?? []).slice(0, 4), repoFiles.find(isApiRouteLike) ?? "-"))}`
        : !hasMethodSignals
          ? `Missing ${check.method} route or handler signals for ${check.target ?? check.title}`
          : hasJsonKeySignals
          ? `Missing API evidence for ${check.target ?? check.title}`
          : `Missing JSON key signals ${(check.expectedJsonKeys ?? []).join(", ")}`
    };
  }

  if (check.kind === "browser") {
    const sourceFiles = await readLikelySourceFiles(
      repoRoot,
      repoFiles,
      (filePath) => isFrontendPath(filePath) || isBackendPath(filePath)
    );
    const matchingSources = sourceFiles.filter(({ path: filePath, content }) => {
      const haystack = `${filePath}\n${content}`.toLowerCase();
      return (
        isBrowserSurfaceContent(haystack) ||
        (check.target ? haystack.includes(check.target.toLowerCase()) : false) ||
        (check.selector ? haystack.includes(check.selector.toLowerCase()) : false)
      );
    });
    const hasTitleSignals =
      !check.expectedTitle ||
      matchingSources.some(({ content }) => content.toLowerCase().includes(check.expectedTitle!.toLowerCase()));
    const passed = (matchingSources.length > 0 || repoFiles.some(isFrontendPath)) && hasTitleSignals;
    return {
      status: passed ? "passed" : "failed",
      detail: passed
        ? "Passed: browser-facing UI surfaces exist for the mission."
        : hasTitleSignals
          ? "Failed: no plausible browser-facing UI surfaces were found for this mission."
          : "Failed: UI surfaces exist, but they do not expose the expected title or visible browser text.",
      lastOutput: passed
        ? `Matched: ${summarizeEvidencePaths(matchingSources.map((item) => item.path), summarizeEvidencePaths((check.evidencePaths ?? []).slice(0, 4), repoFiles.find(isFrontendPath) ?? "-"))}`
        : hasTitleSignals
          ? `Missing UI evidence for ${check.target ?? check.title}`
          : `Missing browser title/text signals for ${check.expectedTitle ?? check.title}`
    };
  }

  if (check.kind === "scenario") {
    const sourceFiles = await readLikelySourceFiles(repoRoot, repoFiles, () => true, 24);
    const needsFrontend = wantsFrontend(mission) || /ui|frontend|screen|page|layout|user/i.test(check.detail);
    const needsBackend = wantsBackend(mission) || /backend|api|server|queue|provider|worker/i.test(check.detail);
    const needsDocs = isDocsScenario(check.detail);
    const hasFrontend = repoFiles.some(isFrontendPath) || sourceFiles.some(({ content }) => isBrowserSurfaceContent(content));
    const hasBackend = repoFiles.some(isBackendPath) || sourceFiles.some(({ content }) => isApiSurfaceContent(content));
    const hasDocs = repoFiles.some(isDocsPath);
    const passed = (!needsFrontend || hasFrontend) && (!needsBackend || hasBackend) && (!needsDocs || hasDocs);
    return {
      status: passed ? "passed" : "failed",
      detail: passed
        ? "Passed: the repo contains implementation surfaces for the scenario."
        : "Failed: the repo is missing one or more implementation surfaces implied by the scenario.",
      lastOutput: [
        needsFrontend ? `frontend=${hasFrontend ? "yes" : "no"}` : null,
        needsBackend ? `backend=${hasBackend ? "yes" : "no"}` : null,
        needsDocs ? `docs=${hasDocs ? "yes" : "no"}` : null
      ].filter(Boolean).join(" | ")
    };
  }

  return {
    status: check.status === "pending" ? "skipped" : check.status,
    detail: check.detail,
    lastOutput: check.lastOutput ?? ""
  };
}

function ownerForAcceptanceCheck(
  check: AcceptanceCheck,
  missionWorkstreams: string[]
): AgentName | null {
  const explicitOwners = uniqueStrings(check.likelyOwners ?? []);
  if (explicitOwners.length === 1) {
    return explicitOwners[0] as AgentName;
  }

  const combined = `${check.title} ${check.command ?? ""} ${check.detail}`.toLowerCase();
  const frontendSignals =
    (check.path ? isFrontendPath(check.path) : false) ||
    check.kind === "browser" ||
    /\b(frontend|web|ui|ux|page|screen|component)\b/.test(combined);
  const backendSignals =
    (check.path ? isBackendPath(check.path) : false) ||
    check.kind === "http" ||
    /\b(api|backend|server|worker|queue|schema|database|auth)\b/.test(combined);
  const docsSignals =
    (check.path ? isDocsPath(check.path) : false) ||
    /\b(readme|docs|documentation|quickstart)\b/.test(combined);

  if (frontendSignals && !backendSignals && !missionWorkstreams.includes("backend")) {
    return "claude";
  }
  if (backendSignals && !frontendSignals && !missionWorkstreams.includes("frontend")) {
    return "codex";
  }
  if (docsSignals && !frontendSignals && !backendSignals) {
    return missionWorkstreams.includes("frontend") ? "claude" : "codex";
  }
  return null;
}

function planAcceptanceRepairForChecks(
  session: SessionRecord,
  mission: Mission,
  failedChecks: AcceptanceCheck[],
  fallback: {
    owner: AgentName;
    strategy: RouteStrategy;
    confidence: number;
    reason: string;
    claimedPaths: string[];
    metadata: Record<string, unknown>;
  }
): AcceptanceRepairRoutePlan {
  const failedPaths = uniqueStrings(failedChecks.map((check) => check.path));
  const recentTasks = session.tasks
    .filter((task) => task.missionId === mission.id && task.status === "completed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const missionWorkstreams = mission.spec?.workstreamKinds ?? [];
  const frontendSignals = failedChecks.some(
    (check) =>
      (check.path ? isFrontendPath(check.path) : false) ||
      check.kind === "browser" ||
      /\b(frontend|web|ui|ux|page|screen|component|build the current app)\b/i.test(
        `${check.title} ${check.command ?? ""} ${check.detail}`
      )
  );
  const backendSignals = failedChecks.some(
    (check) =>
      (check.path ? isBackendPath(check.path) : false) ||
      check.kind === "http" ||
      /\b(api|backend|server|worker|queue|schema|database|go test|pytest|cargo test|auth)\b/i.test(
        `${check.title} ${check.command ?? ""} ${check.detail}`
      )
  );
  const docsSignals = failedChecks.some(
    (check) =>
      (check.path ? isDocsPath(check.path) : false) ||
      /\b(readme|docs|documentation)\b/i.test(`${check.title} ${check.detail}`)
  );

  const ownerScores = new Map<AgentName, number>([
    ["codex", 0],
    ["claude", 0]
  ]);
  const ownerReasons = new Map<AgentName, string[]>([
    ["codex", []],
    ["claude", []]
  ]);

  for (const task of recentTasks) {
    if (task.owner !== "codex" && task.owner !== "claude") {
      continue;
    }

    let score = 0;
    const reasons: string[] = [];
    const overlapPaths = task.claimedPaths.filter((filePath) =>
      failedPaths.some((failedPath) => pathsOverlap(filePath, failedPath))
    );
    if (overlapPaths.length > 0) {
      score += overlapPaths.length * 6;
      reasons.push(`recent task already touched ${overlapPaths.join(", ")}`);
    }
    if (frontendSignals && (task.nodeKind === "frontend" || task.claimedPaths.some(isFrontendPath))) {
      score += 3;
      reasons.push("task ownership aligns with frontend-oriented failed checks");
    }
    if (
      backendSignals &&
      (
        task.nodeKind === "backend" ||
        task.nodeKind === "shared_contract" ||
        task.nodeKind === "infra" ||
        task.nodeKind === "tests" ||
        task.claimedPaths.some(isBackendPath)
      )
    ) {
      score += 3;
      reasons.push("task ownership aligns with backend-oriented failed checks");
    }
    if (docsSignals && (task.nodeKind === "docs" || task.claimedPaths.some(isDocsPath))) {
      score += 2;
      reasons.push("task ownership aligns with documentation-related failed checks");
    }
    if (score > 0) {
      ownerScores.set(task.owner, (ownerScores.get(task.owner) ?? 0) + score);
      ownerReasons.set(task.owner, [...(ownerReasons.get(task.owner) ?? []), ...reasons]);
    }
  }

  for (const check of failedChecks) {
    for (const owner of check.likelyOwners ?? []) {
      ownerScores.set(owner, (ownerScores.get(owner) ?? 0) + 5);
      ownerReasons.get(owner)?.push(`acceptance attribution for ${check.title}`);
    }
    const attributedTasks = recentTasks.filter((task) => (check.likelyTaskIds ?? []).includes(task.id));
    for (const task of attributedTasks) {
      ownerScores.set(task.owner, (ownerScores.get(task.owner) ?? 0) + 2);
      ownerReasons.get(task.owner)?.push(`recent attributed task ${task.id} aligns with ${check.title}`);
    }
  }

  const sortedOwners = (["codex", "claude"] as AgentName[])
    .map((owner) => ({
      owner,
      score: ownerScores.get(owner) ?? 0,
      reasons: ownerReasons.get(owner) ?? []
    }))
    .sort((left, right) => right.score - left.score);
  const strongestOwner = sortedOwners[0] ?? null;
  const secondOwner = sortedOwners[1] ?? null;
  const winningMargin = strongestOwner && secondOwner ? strongestOwner.score - secondOwner.score : 0;

  if (strongestOwner && strongestOwner.score > 0 && winningMargin > 0) {
    return {
      owner: strongestOwner.owner,
      claimedPaths:
        failedPaths.length > 0
          ? failedPaths
          : uniqueStrings(
              recentTasks
                .filter((task) => task.owner === strongestOwner.owner)
                .flatMap((task) => task.claimedPaths)
                .slice(0, 6)
            ),
      routeReason: `Acceptance repair routed to ${strongestOwner.owner} because ${strongestOwner.reasons[0] ?? "recent completed work aligned most strongly with the failed checks"}.`,
      routeStrategy: "path-claim",
      routeConfidence: Math.min(0.98, 0.72 + strongestOwner.score / 20),
      routeMetadata: {
        ...fallback.metadata,
        repairRoutingSource: "task-alignment",
        repairOwnerScores: sortedOwners,
        failedCheckTitles: failedChecks.map((check) => check.title),
        failedPaths
      }
    };
  }

  if (frontendSignals && !backendSignals && !missionWorkstreams.includes("backend")) {
    return {
      owner: "claude",
      claimedPaths: failedPaths.length > 0 ? failedPaths : fallback.claimedPaths,
      routeReason: "Acceptance repair routed to claude because the failed checks are frontend-oriented.",
      routeStrategy: "keyword",
      routeConfidence: 0.84,
      routeMetadata: {
        ...fallback.metadata,
        repairRoutingSource: "frontend-signals",
        failedCheckTitles: failedChecks.map((check) => check.title),
        failedPaths
      }
    };
  }

  if (backendSignals && !frontendSignals && !missionWorkstreams.includes("frontend")) {
    return {
      owner: "codex",
      claimedPaths: failedPaths.length > 0 ? failedPaths : fallback.claimedPaths,
      routeReason: "Acceptance repair routed to codex because the failed checks are backend-oriented.",
      routeStrategy: "keyword",
      routeConfidence: 0.84,
      routeMetadata: {
        ...fallback.metadata,
        repairRoutingSource: "backend-signals",
        failedCheckTitles: failedChecks.map((check) => check.title),
        failedPaths
      }
    };
  }

  if (docsSignals && recentTasks.length > 0) {
    return {
      owner: recentTasks[0]?.owner === "claude" ? "claude" : "codex",
      claimedPaths: failedPaths.length > 0 ? failedPaths : fallback.claimedPaths,
      routeReason: `Acceptance repair routed to ${recentTasks[0]?.owner === "claude" ? "claude" : "codex"} because the failed checks are documentation-oriented and that agent touched the latest completed slice.`,
      routeStrategy: "fallback",
      routeConfidence: 0.66,
      routeMetadata: {
        ...fallback.metadata,
        repairRoutingSource: "docs-latest-owner",
        failedCheckTitles: failedChecks.map((check) => check.title),
        failedPaths
      }
    };
  }

  return {
    owner: fallback.owner,
    claimedPaths: failedPaths.length > 0 ? failedPaths : fallback.claimedPaths,
    routeReason: `Acceptance repair fell back to ${fallback.owner}. ${fallback.reason}`,
    routeStrategy: fallback.strategy,
    routeConfidence: fallback.confidence,
    routeMetadata: {
      ...fallback.metadata,
      repairRoutingSource: "fallback",
      failedCheckTitles: failedChecks.map((check) => check.title),
      failedPaths
    }
  };
}

export function planAcceptanceRepair(
  session: SessionRecord,
  mission: Mission,
  fallback: {
    owner: AgentName;
    strategy: RouteStrategy;
    confidence: number;
    reason: string;
    claimedPaths: string[];
    metadata: Record<string, unknown>;
  }
): AcceptanceRepairRoutePlan {
  return planAcceptanceRepairForChecks(session, mission, failingAcceptanceChecks(mission), fallback);
}

export function planAcceptanceRepairs(
  session: SessionRecord,
  mission: Mission,
  fallback: {
    owner: AgentName;
    strategy: RouteStrategy;
    confidence: number;
    reason: string;
    claimedPaths: string[];
    metadata: Record<string, unknown>;
  }
): AcceptanceRepairTaskPlan[] {
  const failedChecks = failingAcceptanceChecks(mission);
  if (failedChecks.length === 0) {
    return [];
  }

  const missionWorkstreams = mission.spec?.workstreamKinds ?? [];
  const grouped = new Map<AgentName | "shared", AcceptanceCheck[]>();
  for (const check of failedChecks) {
    const owner = ownerForAcceptanceCheck(check, missionWorkstreams) ?? "shared";
    grouped.set(owner, [...(grouped.get(owner) ?? []), check]);
  }

  if ((grouped.size === 1 && !grouped.has("shared")) || failedChecks.length === 1) {
    const route = planAcceptanceRepairForChecks(session, mission, failedChecks, fallback);
    return [{
      ...route,
      failedChecks,
      failureFingerprint: acceptanceFailureFingerprintForChecks(failedChecks),
      prompt: buildAcceptanceRepairPrompt(mission, failedChecks)
    }];
  }

  const sharedChecks = grouped.get("shared") ?? [];
  const ownerGroups = (["codex", "claude"] as AgentName[])
    .map((owner) => ({
      owner,
      checks: [...(grouped.get(owner) ?? [])]
    }))
    .filter((group) => group.checks.length > 0);

  if (ownerGroups.length === 0) {
    const route = planAcceptanceRepairForChecks(session, mission, failedChecks, fallback);
    return [{
      ...route,
      failedChecks,
      failureFingerprint: acceptanceFailureFingerprintForChecks(failedChecks),
      prompt: buildAcceptanceRepairPrompt(mission, failedChecks)
    }];
  }

  if (sharedChecks.length > 0) {
    const ranked = ownerGroups
      .map((group) => ({
        owner: group.owner,
        route: planAcceptanceRepairForChecks(session, mission, group.checks, fallback)
      }))
      .sort((left, right) => right.route.routeConfidence - left.route.routeConfidence);
    const targetOwner = ranked[0]?.owner ?? fallback.owner;
    grouped.set(targetOwner, [...(grouped.get(targetOwner) ?? []), ...sharedChecks]);
    grouped.delete("shared");
  }

  const plans: AcceptanceRepairTaskPlan[] = [];
  for (const owner of ["codex", "claude"] as AgentName[]) {
    const checks = grouped.get(owner) ?? [];
    if (checks.length === 0) {
      continue;
    }
    const route = planAcceptanceRepairForChecks(session, mission, checks, fallback);
    plans.push({
      ...route,
      owner,
      routeReason:
        ownerGroups.length > 1
          ? `${route.routeReason} This repair loop was split by owner-specific failed checks.`
          : route.routeReason,
      failedChecks: checks,
      failureFingerprint: acceptanceFailureFingerprintForChecks(checks),
      prompt: buildAcceptanceRepairPrompt(mission, checks)
    });
  }

  return plans.length > 0
    ? plans
    : [{
        ...planAcceptanceRepairForChecks(session, mission, failedChecks, fallback),
        failedChecks,
        failureFingerprint: acceptanceFailureFingerprintForChecks(failedChecks),
        prompt: buildAcceptanceRepairPrompt(mission, failedChecks)
      }];
}
