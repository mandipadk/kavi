import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, ensureProjectScaffold } from "./config.ts";
import { resolveApprovalRequest, listApprovalRequests } from "./approvals.ts";
import { resolveAppPaths } from "./paths.ts";
import { PLANNER_OUTPUT_SCHEMA, buildCodexTurnParams, buildThreadParams, runCodexTask } from "./adapters/codex.ts";
import { buildCodexAppServerArgs } from "./codex-app-server.ts";
import type { SessionRecord, TaskSpec } from "./types.ts";

async function waitForPendingApproval(paths: ReturnType<typeof resolveAppPaths>) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    const pending = await listApprovalRequests(paths);
    if (pending.length > 0) {
      return pending[0];
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for a Codex approval request.");
}

test("runCodexTask bridges app-server approvals through Kavi", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-codex-appserver-"));
  process.env.KAVI_HOME_CONFIG_DIR = path.join(root, "home-config");
  process.env.KAVI_HOME_STATE_DIR = path.join(root, "home-state");

  const repoRoot = path.join(root, "repo");
  const worktreePath = path.join(root, "worktrees", "codex");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(worktreePath, { recursive: true });

  const fakeCodexPath = path.join(root, "fake-codex.mjs");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  console.error("unsupported invocation");
  process.exit(1);
}

if (args.includes("--session-source")) {
  console.error("unexpected legacy flag");
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
let approvalId = 900;
let turnCount = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-kavi-test",
        platformFamily: "unix",
        platformOs: "macos"
      }
    });
    return;
  }

  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({
      id: message.id,
      result: {
        thread: {
          id: "thread-1",
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: { type: "idle" },
          path: null,
          cwd: message.params.cwd,
          cliVersion: "fake",
          source: "cli",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: []
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: message.params.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [message.params.cwd], readOnlyAccess: { type: "fullAccess" }, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        reasoningEffort: "medium"
      }
    });
    return;
  }

  if (message.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    const requestId = approvalId++;
    send({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          items: [],
          status: "inProgress",
          error: null
        }
      }
    });
    send({
      id: requestId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: message.params.threadId,
        turnId,
        itemId: "cmd-" + turnCount,
        command: "npm run build",
        cwd: message.params.cwd,
        reason: "Need to run the build"
      }
    });
    return;
  }

  if (message.id >= 900) {
    const turnId = "turn-" + turnCount;
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "assistant-" + turnCount,
        delta: "{\\"summary\\":\\"Codex finished\\",\\"status\\":\\"completed\\",\\"blockers\\":[],\\"nextRecommendation\\":null,\\"peerMessages\\":[]}"
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: turnId,
          items: [],
          status: "completed",
          error: null
        }
      }
    });
  }
});
`,
    "utf8"
  );
  await chmod(fakeCodexPath, 0o755);

  const paths = resolveAppPaths(repoRoot);
  await ensureProjectScaffold(paths);

  const session: SessionRecord = {
    id: "session-1",
    repoRoot,
    baseCommit: "base",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    socketPath: "file://session-state",
    status: "running",
    goal: "Build the backend",
    fullAccessMode: false,
    daemonPid: null,
    daemonHeartbeatAt: null,
    config: defaultConfig(),
    runtime: {
      nodeExecutable: process.execPath,
      codexExecutable: fakeCodexPath,
      claudeExecutable: "claude",
      kaviEntryPoint: path.join(root, "main.js")
    },
    worktrees: [
      {
        agent: "codex",
        path: worktreePath,
        branch: "kavi/test-codex"
      }
    ],
    tasks: [],
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

  const task: TaskSpec = {
    id: "task-1",
    title: "Build backend",
    owner: "codex",
    status: "pending",
    prompt: "Build the API handlers",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    summary: null,
    routeReason: null,
    claimedPaths: []
  };

  const streamedChunks: string[] = [];
  const runPromise = runCodexTask(session, task, paths, {
    onAssistantDelta: (chunk) => streamedChunks.push(chunk)
  });
  const approval = await waitForPendingApproval(paths);
  assert.equal(approval.agent, "codex");
  assert.match(approval.summary, /CommandExecution: npm run build/);

  await resolveApprovalRequest(paths, approval.id, "allow", true);
  const result = await runPromise;

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.envelope.summary, "Codex finished");
  assert.equal(result.envelope.status, "completed");
  assert.match(result.raw, /Codex finished/);
  assert.ok(streamedChunks.some((chunk) => chunk.includes("Codex finished")));

  delete process.env.KAVI_HOME_CONFIG_DIR;
  delete process.env.KAVI_HOME_STATE_DIR;
});

test("buildCodexAppServerArgs omits legacy unsupported flags", () => {
  assert.deepEqual(buildCodexAppServerArgs(), ["app-server", "--listen", "stdio://"]);
});

test("Codex params switch to never approvals and danger-full-access in full-access mode", () => {
  const session: SessionRecord = {
    id: "session-2",
    repoRoot: "/tmp/repo",
    baseCommit: "base",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    socketPath: "file://session-state",
    status: "running",
    goal: "Build the backend",
    fullAccessMode: true,
    daemonPid: null,
    daemonHeartbeatAt: null,
    config: defaultConfig(),
    runtime: {
      nodeExecutable: process.execPath,
      codexExecutable: "codex",
      claudeExecutable: "claude",
      kaviEntryPoint: "/tmp/dist/main.js"
    },
    worktrees: [
      {
        agent: "codex",
        path: "/tmp/worktrees/codex",
        branch: "kavi/test-codex"
      }
    ],
    tasks: [],
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

  const worktree = session.worktrees[0]!;
  const threadParams = buildThreadParams(session, worktree, "Developer instructions");
  assert.equal(threadParams.approvalPolicy, "never");
  assert.equal(threadParams.sandbox, "danger-full-access");
  assert.equal("approvalsReviewer" in threadParams, false);

  const turnParams = buildCodexTurnParams(session, worktree, "thread-1", "Build it");
  assert.equal(turnParams.approvalPolicy, "never");
  assert.equal(turnParams.sandbox, "danger-full-access");
  assert.equal("approvalsReviewer" in turnParams, false);
});

test("planner output schema requires nodeKind on every planned task item", () => {
  const planSchema = (PLANNER_OUTPUT_SCHEMA.properties as Record<string, unknown>).plan as Record<string, unknown>;
  const taskItems = ((planSchema.properties as Record<string, unknown>).tasks as Record<string, unknown>).items as Record<string, unknown>;
  const required = Array.isArray(taskItems.required) ? taskItems.required.map((item) => String(item)) : [];

  assert.ok(required.includes("nodeKind"));
});
