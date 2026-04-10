import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  explainAcceptanceFailure,
  evaluateAcceptanceCheck,
  planAcceptanceRepair,
  planAcceptanceRepairs,
  synthesizeMissionAcceptanceChecks
} from "./acceptance.ts";
import { createMission } from "./missions.ts";
import type { KaviConfig, Mission, SessionRecord } from "./types.ts";

function createConfig(): KaviConfig {
  return {
    version: 1,
    baseBranch: "main",
    validationCommand: "",
    messageLimit: 12,
    routing: {
      frontendKeywords: ["frontend", "ui", "ux", "web"],
      backendKeywords: ["backend", "api", "server", "worker"],
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
    id: "session-test",
    repoRoot,
    baseCommit: "abc123",
    createdAt: timestamp,
    updatedAt: timestamp,
    socketPath: path.join(repoRoot, ".kavi.sock"),
    status: "running",
    goal: null,
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

test("synthesizeMissionAcceptanceChecks derives practical checks from repo state and completed work", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-"));
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      name: "acceptance-fixture",
      scripts: {
        test: "vitest run",
        build: "next build",
        dev: "node dev-server.js",
        start: "node server.js"
      }
    })
  );
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Fixture\n");

  const session = createSession(repoRoot);
  const mission = createMission(
    session,
    "Build a frontend and backend starter with docs, tests, and a web UI."
  );
  session.missions.push(mission);
  session.tasks.push(
    {
      id: "task-web",
      missionId: mission.id,
      title: "Build frontend",
      owner: "claude",
      kind: "execution",
      nodeKind: "frontend",
      status: "completed",
      prompt: "Build frontend",
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
      summary: "Created the web app shell.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: null,
      routeConfidence: null,
      routeMetadata: {},
      claimedPaths: ["apps/web/app/page.tsx"]
    },
    {
      id: "task-api",
      missionId: mission.id,
      title: "Build backend",
      owner: "codex",
      kind: "execution",
      nodeKind: "backend",
      status: "completed",
      prompt: "Build backend",
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
      summary: "Created the API server.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: null,
      routeConfidence: null,
      routeMetadata: {},
      claimedPaths: ["apps/api/src/server.ts"]
    }
  );

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);

  const checksByTitle = new Map(mission.acceptance.checks.map((check) => [check.title, check]));
  assert.equal(checksByTitle.get("Run project tests")?.command, "npm test");
  assert.equal(checksByTitle.get("Build the current app")?.command, "npm run build");
  assert.equal(checksByTitle.get("README exists")?.kind, "docs");
  assert.equal(checksByTitle.get("README exists")?.path, "README.md");
  assert.equal(
    checksByTitle.get("Backend implementation surface exists")?.path,
    "apps/api/src/server.ts"
  );
  assert.equal(
    checksByTitle.get("Frontend implementation surface exists")?.path,
    "apps/web/app/page.tsx"
  );
  assert.equal(checksByTitle.get("Scenario: A user can understand and use the primary UI flow without confusion.")?.kind, "scenario");
  assert.equal(checksByTitle.get("Contract surfaces exist")?.kind, "contract");
  assert.equal(checksByTitle.get("Docs expectations are represented")?.kind, "docs");
  assert.equal(checksByTitle.get("Primary API or backend route surface exists")?.kind, "http");
  assert.equal(checksByTitle.get("Primary browser flow surface exists")?.kind, "browser");
  assert.equal(checksByTitle.get("Primary API or backend route surface exists")?.serverCommand, "npm run start");
  assert.equal(checksByTitle.get("Primary browser flow surface exists")?.serverCommand, "npm run dev");
  assert.equal(checksByTitle.get("Primary API or backend route surface exists")?.urlPath, "/api");
  assert.equal(checksByTitle.get("Primary browser flow surface exists")?.urlPath, "/");
  assert.ok((checksByTitle.get("Primary API or backend route surface exists")?.routeCandidates ?? []).includes("/api"));
  assert.ok((checksByTitle.get("Primary API or backend route surface exists")?.routeCandidates ?? []).includes("/api/health"));
  assert.ok((checksByTitle.get("Primary browser flow surface exists")?.routeCandidates ?? []).includes("/"));
  assert.ok((checksByTitle.get("Primary browser flow surface exists")?.selectorCandidates ?? []).includes("app-shell"));
  assert.equal(checksByTitle.get("Primary API or backend route surface exists")?.expectedStatus, 200);
  assert.equal(checksByTitle.get("Primary API or backend route surface exists")?.method, "GET");
  assert.equal(checksByTitle.get("Primary browser flow surface exists")?.expectedContentType, "text/html");
  assert.deepEqual(checksByTitle.get("Primary API or backend route surface exists")?.likelyOwners, ["codex"]);
  assert.deepEqual(checksByTitle.get("Primary browser flow surface exists")?.likelyOwners, ["claude"]);
  assert.ok(
    (checksByTitle.get("Primary browser flow surface exists")?.expectedText ?? []).every((item) => item !== "web ui")
  );
  assert.match(checksByTitle.get("Primary API or backend route surface exists")?.likelyReason ?? "", /backend/i);
  assert.match(checksByTitle.get("Primary browser flow surface exists")?.likelyReason ?? "", /frontend/i);
  assert.match(checksByTitle.get("Scenario: A user can understand and use the primary UI flow without confusion.")?.command ?? "", /\.kavi\/runtime\/acceptance\//);
  assert.match(checksByTitle.get("Contract surfaces exist")?.command ?? "", /\.kavi\/runtime\/acceptance\//);
  assert.match(checksByTitle.get("Docs expectations are represented")?.command ?? "", /\.kavi\/runtime\/acceptance\//);
  assert.match(checksByTitle.get("Primary API or backend route surface exists")?.command ?? "", /\.kavi\/runtime\/acceptance\//);
  assert.match(checksByTitle.get("Primary browser flow surface exists")?.command ?? "", /\.kavi\/runtime\/acceptance\//);
  assert.equal(typeof checksByTitle.get("Primary browser flow surface exists")?.harnessPath, "string");
});

test("planAcceptanceRepairs can split failed checks by likely owner", () => {
  const session = createSession("/tmp/repo");
  const mission = createMission(
    session,
    "Build a frontend and backend starter with docs, tests, and a web UI."
  );
  session.missions.push(mission);
  mission.acceptance.checks.push(
    {
      id: "check-browser",
      title: "Primary browser flow surface exists",
      kind: "browser",
      command: "node .kavi/runtime/acceptance/browser-check.js",
      path: "apps/web/app/page.tsx",
      harnessPath: ".kavi/runtime/acceptance/browser-check.js",
      serverCommand: "npm run dev",
      target: null,
      urlPath: "/",
      routeCandidates: ["/"],
      method: null,
      selector: null,
      selectorCandidates: ["app-shell"],
      expectedStatus: 200,
      expectedContentType: "text/html",
      evidencePaths: ["apps/web/app/page.tsx"],
      expectedText: ["clinic"],
      likelyTaskIds: ["task-web"],
      likelyOwners: ["claude"],
      likelyReason: "frontend surface",
      status: "failed",
      detail: "Expected clinic content.",
      lastRunAt: null,
      lastOutput: "missing text"
    },
    {
      id: "check-http",
      title: "Primary API or backend route surface exists",
      kind: "http",
      command: "node .kavi/runtime/acceptance/http-check.js",
      path: "apps/api/src/server.ts",
      harnessPath: ".kavi/runtime/acceptance/http-check.js",
      serverCommand: "npm run start",
      target: null,
      urlPath: "/api/health",
      routeCandidates: ["/api", "/api/health"],
      method: "GET",
      selector: null,
      selectorCandidates: [],
      expectedStatus: 200,
      expectedContentType: "application/json",
      evidencePaths: ["apps/api/src/server.ts"],
      expectedText: [],
      likelyTaskIds: ["task-api"],
      likelyOwners: ["codex"],
      likelyReason: "backend route",
      status: "failed",
      detail: "Expected healthy response.",
      lastRunAt: null,
      lastOutput: "500"
    }
  );

  const repairPlans = planAcceptanceRepairs(session, mission, {
    owner: "codex",
    strategy: "fallback",
    confidence: 0.4,
    reason: "fallback",
    claimedPaths: [],
    metadata: {}
  });

  assert.equal(repairPlans.length, 2);
  assert.deepEqual(repairPlans.map((plan) => plan.owner).sort(), ["claude", "codex"]);
  assert.ok(repairPlans.every((plan) => plan.routeMetadata.groupedRepair !== false));
});

test("synthesizeMissionAcceptanceChecks stays docs-focused and idempotent for docs-only missions", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-docs-"));
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Tiny CLI\n");
  await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "docs", "quickstart.md"), "# Quickstart\n");

  const session = createSession(repoRoot);
  const mission = createMission(
    session,
    "Create README.md and docs/quickstart.md for a tiny CLI project. Explain setup, usage, and development workflow."
  );
  session.missions.push(mission);
  session.tasks.push({
    id: "task-docs",
    missionId: mission.id,
    title: "Write docs",
    owner: "claude",
    kind: "execution",
    nodeKind: "docs",
    status: "completed",
    prompt: "Write docs",
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
    summary: "Created README and quickstart docs.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["README.md", "docs/quickstart.md"]
  });

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);
  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);

  const titles = mission.acceptance.checks.map((check) => check.title);
  assert.equal(titles.filter((title) => title === "README exists").length, 1);
  assert.equal(
    titles.filter((title) => title === "Scenario: The repo explains how to run or understand the delivered slice.").length,
    1
  );
  assert.ok(!titles.includes("Contract surfaces exist"));

  const scenarioCheck = mission.acceptance.checks.find((check) =>
    check.title === "Scenario: The repo explains how to run or understand the delivered slice."
  );
  assert.deepEqual(
    scenarioCheck?.evidencePaths,
    ["README.md", "docs/quickstart.md"]
  );

  const scenarioResult = await evaluateAcceptanceCheck(repoRoot, mission, scenarioCheck!);
  assert.equal(scenarioResult.status, "passed");
  assert.match(scenarioResult.lastOutput, /README\.md|docs\/quickstart\.md/);
});

test("synthesizeMissionAcceptanceChecks keeps README-specific docs checks honest", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-readme-"));
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Tiny CLI\n");

  const session = createSession(repoRoot);
  const mission = createMission(
    session,
    "Document setup and usage for the tiny CLI."
  );
  session.missions.push(mission);
  session.tasks.push({
    id: "task-readme",
    missionId: mission.id,
    title: "Write readme",
    owner: "claude",
    kind: "execution",
    nodeKind: "docs",
    status: "completed",
    prompt: "Write docs",
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
    summary: "Created the README.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["README.md"]
  });

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);

  const readmeCheck = mission.acceptance.checks.find((check) => check.title === "README exists");
  assert.ok(readmeCheck);
  assert.equal(readmeCheck?.path, "README.md");
});

test("synthesizeMissionAcceptanceChecks uses a generic docs title when README is absent", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-quickstart-"));
  await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "docs", "quickstart.md"), "# Quickstart\n");

  const session = createSession(repoRoot);
  const mission = createMission(
    session,
    "Add quickstart documentation for the tiny CLI."
  );
  session.missions.push(mission);
  session.tasks.push({
    id: "task-quickstart",
    missionId: mission.id,
    title: "Write quickstart",
    owner: "claude",
    kind: "execution",
    nodeKind: "docs",
    status: "completed",
    prompt: "Write docs",
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
    summary: "Created quickstart docs.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["docs/quickstart.md"]
  });

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);

  const docsCheck = mission.acceptance.checks.find(
    (check) => check.title === "Runbook or quickstart docs exist"
  );
  assert.ok(docsCheck);
  assert.equal(docsCheck?.path, "docs/quickstart.md");
});

test("explainAcceptanceFailure surfaces expected signals and repair focus", () => {
  const explanation = explainAcceptanceFailure({
    id: "accept-browser",
    title: "Primary browser flow surface exists",
    kind: "browser",
    command: "node .kavi/runtime/acceptance/browser-check.mjs",
    path: "apps/web/app/page.tsx",
    harnessPath: ".kavi/runtime/acceptance/browser-check.mjs",
    serverCommand: "npm run dev",
    target: "apps/web/app/page.tsx",
    urlPath: "/dashboard",
    routeCandidates: ["/dashboard", "/"],
    method: null,
    selector: "[data-test=dashboard]",
    selectorCandidates: ["[data-test=dashboard]", "main"],
    expectedStatus: 200,
    expectedContentType: "text/html",
    evidencePaths: ["apps/web/app/page.tsx", "apps/web/components/dashboard.tsx"],
    expectedText: ["clinic", "dashboard"],
    likelyTaskIds: ["task-web"],
    likelyOwners: ["claude"],
    likelyReason: "frontend ownership aligns with the check",
    status: "failed",
    detail: "Failed: no browser surface matched /dashboard",
    lastRunAt: "2026-04-09T00:00:00.000Z",
    lastOutput: "Expected text clinic was not visible on /dashboard"
  });

  assert.match(explanation.summary, /Primary browser flow surface exists/);
  assert.match(explanation.summary, /expected path apps\/web\/app\/page\.tsx/);
  assert.match(explanation.summary, /likely owner claude/);
  assert.ok(explanation.expected.includes("URL /dashboard"));
  assert.ok(explanation.expected.includes("selector [data-test=dashboard]"));
  assert.ok(explanation.observed.some((item) => item.includes("Expected text clinic")));
  assert.ok(explanation.repairFocus.includes("Inspect apps/web/app/page.tsx"));
  assert.ok(explanation.repairFocus.includes("Run npm run dev"));
});

test("generated browser and http harnesses can run against a lightweight local server", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-runtime-"));
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      name: "acceptance-runtime-fixture",
      scripts: {
        start: "node server.mjs",
        dev: "node server.mjs"
      }
    })
  );
  await fs.writeFile(
    path.join(repoRoot, "server.mjs"),
    `import http from "node:http";

const port = Number(process.env.PORT || "4173");
const server = http.createServer((req, res) => {
  if (req.url === "/api/health" || req.url === "/api") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<!doctype html><html><head><title>Clinic dashboard</title></head><body><main id="app-shell">Clinic dashboard</main></body></html>');
});
server.listen(port, "127.0.0.1", () => {
  console.log(\`http://127.0.0.1:\${port}\`);
});
`
  );

  const session = createSession(repoRoot);
  const mission = createMission(
    session,
    "Build a web dashboard with an API health route for clinic operations."
  );
  session.missions.push(mission);
  session.tasks.push(
    {
      id: "task-web-runtime",
      missionId: mission.id,
      title: "Build frontend",
      owner: "claude",
      kind: "execution",
      nodeKind: "frontend",
      status: "completed",
      prompt: "Build frontend",
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
      summary: "Created the dashboard UI shell.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: null,
      routeConfidence: null,
      routeMetadata: {},
      claimedPaths: ["apps/web/app/page.tsx"]
    },
    {
      id: "task-api-runtime",
      missionId: mission.id,
      title: "Build backend",
      owner: "codex",
      kind: "execution",
      nodeKind: "backend",
      status: "completed",
      prompt: "Build backend",
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
      summary: "Created the API health route.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: null,
      routeConfidence: null,
      routeMetadata: {},
      claimedPaths: ["apps/api/health/route.ts"]
    }
  );

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);

  const browserCheck = mission.acceptance.checks.find((check) => check.kind === "browser");
  const httpCheck = mission.acceptance.checks.find((check) => check.kind === "http");
  assert.equal(browserCheck?.serverCommand, "npm run dev");
  assert.equal(httpCheck?.serverCommand, "npm run start");
  assert.ok((browserCheck?.expectedText ?? []).every((item) => item.trim().length >= 4));
  assert.ok(!(browserCheck?.expectedText ?? []).includes("web ui"));
  assert.ok((httpCheck?.routeCandidates ?? []).length >= 2);
  assert.ok((browserCheck?.selectorCandidates ?? []).includes("app-shell"));
  assert.equal(httpCheck?.expectedContentType, "application/json");
  assert.ok((httpCheck?.expectedJsonKeys ?? []).includes("status"));
  assert.equal(httpCheck?.method, "GET");
  assert.equal(browserCheck?.expectedContentType, "text/html");
  assert.match(browserCheck?.expectedTitle ?? "", /dashboard/i);

  const browserResult = await evaluateAcceptanceCheck(repoRoot, mission, browserCheck!);
  const httpResult = await evaluateAcceptanceCheck(repoRoot, mission, httpCheck!);

  assert.equal(browserResult.status, "passed");
  assert.match(browserResult.lastOutput, /runtime harness/i);
  assert.equal(httpResult.status, "passed");
  assert.match(httpResult.lastOutput, /runtime harness/i);
});

test("generated http harness can fall back across route candidates", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-route-fallback-"));
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      name: "acceptance-route-fallback",
      scripts: {
        start: "node server.mjs"
      }
    })
  );
  await fs.mkdir(path.join(repoRoot, "apps/api/status"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "apps/api/status/route.ts"),
    "export function GET() { return Response.json({ status: 'ok' }); }\n"
  );
  await fs.writeFile(
    path.join(repoRoot, "server.mjs"),
    `import http from "node:http";
const port = Number(process.env.PORT || "4173");
http.createServer((req, res) => {
  if (req.url === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "missing" }));
}).listen(port, "127.0.0.1", () => console.log(\`http://127.0.0.1:\${port}\`));
`
  );
  const session = createSession(repoRoot);
  const mission = createMission(session, "Build an API status endpoint for clinic telemetry.");
  session.missions.push(mission);
  session.tasks.push({
    id: "task-api-fallback",
    missionId: mission.id,
    title: "Build API status route",
    owner: "codex",
    kind: "execution",
    nodeKind: "backend",
    status: "completed",
    prompt: "Build API",
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
    summary: "Created API status route.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["apps/api/status/route.ts"]
  });

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);
  const check = mission.acceptance.checks.find((item) => item.kind === "http");
  assert.ok(check?.command);
  assert.ok((check?.routeCandidates ?? []).includes("/api/status"));
  assert.ok((check?.expectedJsonKeys ?? []).includes("status"));

  const result = await evaluateAcceptanceCheck(repoRoot, mission, check!);

  assert.equal(result.status, "passed");
  assert.match(result.lastOutput, /\/api\/status/);
});

test("generated http harness can exercise POST flows with inferred JSON payloads", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-post-runtime-"));
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      name: "acceptance-post-runtime",
      scripts: {
        start: "node server.mjs"
      }
    })
  );
  await fs.mkdir(path.join(repoRoot, "apps/api/auth"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "apps/api/auth/route.ts"),
    "export async function POST() { return Response.json({ token: 'abc', auth: 'ok' }); }\n"
  );
  await fs.writeFile(
    path.join(repoRoot, "server.mjs"),
    `import http from "node:http";
const port = Number(process.env.PORT || "4173");
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/auth") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: parsed.name ? "abc" : "missing", auth: "ok" }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "missing" }));
}).listen(port, "127.0.0.1", () => console.log(\`http://127.0.0.1:\${port}\`));
`
  );
  const session = createSession(repoRoot);
  const mission = createMission(session, "Create a login API so operators can authenticate into the clinic portal.");
  mission.spec = {
    normalizedPrompt: mission.prompt,
    audience: "operators",
    repoShape: "greenfield",
    workstreamKinds: ["backend"],
    stackHints: ["node"],
    requestedDeliverables: ["login api"],
    userRoles: ["operator"],
    domainEntities: ["auth token"],
    constraints: []
  };
  session.missions.push(mission);
  session.tasks.push({
    id: "task-api-auth",
    missionId: mission.id,
    title: "Build auth route",
    owner: "codex",
    kind: "execution",
    nodeKind: "backend",
    status: "completed",
    prompt: "Build auth route",
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
    summary: "Created auth route.",
    nextRecommendation: null,
    routeReason: null,
    routeStrategy: null,
    routeConfidence: null,
    routeMetadata: {},
    claimedPaths: ["apps/api/auth/route.ts"]
  });

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);
  const check = mission.acceptance.checks.find((item) => item.kind === "http");
  assert.equal(check?.method, "POST");
  assert.match(check?.requestBody ?? "", /name|auth/);
  assert.equal(check?.requestHeaders?.accept, "application/json");
  assert.equal(check?.requestHeaders?.["content-type"], "application/json");

  const result = await evaluateAcceptanceCheck(repoRoot, mission, check!);
  assert.equal(result.status, "passed");
  assert.match(result.lastOutput, /runtime harness/i);
});

test("planAcceptanceRepair prefers the agent whose completed work aligns with failed checks", () => {
  const repoRoot = "/tmp/repo";
  const session = createSession(repoRoot);
  const mission = createMission(
    session,
    "Build a frontend-heavy web UI with a landing page and polished styling."
  );
  session.missions.push(mission);
  session.tasks.push(
    {
      id: "task-web",
      missionId: mission.id,
      title: "Build frontend",
      owner: "claude",
      kind: "execution",
      nodeKind: "frontend",
      status: "completed",
      prompt: "Build frontend",
      dependsOnTaskIds: [],
      parentTaskId: null,
      planId: null,
      planNodeKey: null,
      retryCount: 0,
      maxRetries: 1,
      lastFailureSummary: null,
      lease: null,
      createdAt: session.createdAt,
      updatedAt: "2026-04-02T00:10:00.000Z",
      summary: "Created the landing page.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: "manual",
      routeConfidence: 1,
      routeMetadata: {},
      claimedPaths: ["apps/web/app/page.tsx", "apps/web/app/globals.css"]
    }
  );
  mission.acceptance.checks.push({
    id: "check-build",
    title: "Build the current app",
    kind: "command",
    command: "npm run build",
    path: null,
    status: "failed",
    detail: "Failed (1): npm run build",
    lastRunAt: "2026-04-02T00:11:00.000Z",
    lastOutput: "app build failed"
  });

  const route = planAcceptanceRepair(session, mission, {
    owner: "codex",
    strategy: "fallback",
    confidence: 0.35,
    reason: "Fallback router picked codex.",
    claimedPaths: [],
    metadata: {}
  });

  assert.equal(route.owner, "claude");
  assert.equal(route.routeStrategy, "path-claim");
  assert.match(route.routeReason, /claude/i);
  assert.equal(route.routeMetadata.repairRoutingSource, "task-alignment");
});

test("evaluateAcceptanceCheck handles scenario, contract, and docs checks", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-eval-"));
  await fs.mkdir(path.join(repoRoot, "apps/web/app"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "apps/api/src"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "packages/domain"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "apps/web/app/page.tsx"), "export default function Page() { return null; }\n");
  await fs.writeFile(path.join(repoRoot, "apps/api/src/server.ts"), "export function startServer() {}\n");
  await fs.writeFile(path.join(repoRoot, "packages/domain/patient.ts"), "export type Patient = { id: string };\n");
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Docs\n");

  const session = createSession(repoRoot);
  const mission = createMission(session, "Build a frontend and backend starter with docs and a web UI.");

  const scenario = await evaluateAcceptanceCheck(repoRoot, mission, {
    id: "scenario",
    title: "Scenario: A user can understand and use the primary UI flow without confusion.",
    kind: "scenario",
    command: null,
    path: null,
    status: "pending",
    detail: "A user can understand and use the primary UI flow without confusion.",
    lastRunAt: null,
    lastOutput: null
  });
  const contract = await evaluateAcceptanceCheck(repoRoot, mission, {
    id: "contract",
    title: "Contract surfaces exist",
    kind: "contract",
    command: null,
    path: null,
    status: "pending",
    detail: "Verify the mission produced the expected interface or contract-bearing implementation surfaces.",
    lastRunAt: null,
    lastOutput: null
  });
  const docs = await evaluateAcceptanceCheck(repoRoot, mission, {
    id: "docs",
    title: "Docs expectations are represented",
    kind: "docs",
    command: null,
    path: "README.md",
    status: "pending",
    detail: "Document how to run, verify, or inspect the delivered slice.",
    lastRunAt: null,
    lastOutput: null
  });
  const http = await evaluateAcceptanceCheck(repoRoot, mission, {
    id: "http",
    title: "Primary API or backend route surface exists",
    kind: "http",
    command: null,
    path: "apps/api/src/server.ts",
    target: "server",
    method: "GET",
    selector: null,
    evidencePaths: ["apps/api/src/server.ts"],
    status: "pending",
    detail: "Verify the mission produced a plausible API, handler, or backend route surface for the requested slice.",
    lastRunAt: null,
    lastOutput: null
  });
  const browser = await evaluateAcceptanceCheck(repoRoot, mission, {
    id: "browser",
    title: "Primary browser flow surface exists",
    kind: "browser",
    command: null,
    path: "apps/web/app/page.tsx",
    target: "apps/web/app/page.tsx",
    method: null,
    selector: "app-shell",
    evidencePaths: ["apps/web/app/page.tsx"],
    status: "pending",
    detail: "Verify the mission produced a plausible browser-facing shell or UI route for the requested slice.",
    lastRunAt: null,
    lastOutput: null
  });

  assert.equal(scenario.status, "passed");
  assert.equal(contract.status, "passed");
  assert.equal(docs.status, "passed");
  assert.equal(http.status, "passed");
  assert.equal(browser.status, "passed");
});

test("generated acceptance harnesses execute for docs, scenario, and contract checks", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-acceptance-harness-"));
  await fs.mkdir(path.join(repoRoot, "apps/web/app"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "apps/api/src"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "packages/domain"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "apps/web/app/page.tsx"), "export default function Page() { return <main>Hi</main>; }\n");
  await fs.writeFile(path.join(repoRoot, "apps/api/src/server.ts"), "export function getRoute() { return '/api/health'; }\n");
  await fs.writeFile(path.join(repoRoot, "packages/domain/schema.ts"), "export interface Patient { id: string }\n");
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Harness Docs\n");

  const session = createSession(repoRoot);
  const mission = createMission(session, "Build a frontend and backend starter with docs and a web UI.");
  session.missions.push(mission);
  session.tasks.push(
    {
      id: "task-web",
      missionId: mission.id,
      title: "Build frontend",
      owner: "claude",
      kind: "execution",
      nodeKind: "frontend",
      status: "completed",
      prompt: "Build frontend",
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
      summary: "Created frontend.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: null,
      routeConfidence: null,
      routeMetadata: {},
      claimedPaths: ["apps/web/app/page.tsx", "README.md"]
    },
    {
      id: "task-api",
      missionId: mission.id,
      title: "Build backend",
      owner: "codex",
      kind: "execution",
      nodeKind: "backend",
      status: "completed",
      prompt: "Build backend",
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
      summary: "Created backend.",
      nextRecommendation: null,
      routeReason: null,
      routeStrategy: null,
      routeConfidence: null,
      routeMetadata: {},
      claimedPaths: ["apps/api/src/server.ts", "packages/domain/schema.ts"]
    }
  );

  await synthesizeMissionAcceptanceChecks(repoRoot, session, mission);

  const docsCheck = mission.acceptance.checks.find((check) => check.kind === "docs" && check.command);
  const scenarioCheck = mission.acceptance.checks.find((check) => check.kind === "scenario" && check.command);
  const contractCheck = mission.acceptance.checks.find((check) => check.kind === "contract" && check.command);

  assert.ok(docsCheck?.command);
  assert.ok(scenarioCheck?.command);
  assert.ok(contractCheck?.command);

  const docs = await evaluateAcceptanceCheck(repoRoot, mission, docsCheck!);
  const scenario = await evaluateAcceptanceCheck(repoRoot, mission, scenarioCheck!);
  const contract = await evaluateAcceptanceCheck(repoRoot, mission, contractCheck!);

  assert.equal(docs.status, "passed");
  assert.equal(scenario.status, "passed");
  assert.equal(contract.status, "passed");
});
