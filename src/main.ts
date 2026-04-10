#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createApprovalRequest,
  describeToolUse,
  findApprovalRule,
  listApprovalRequests,
  resolveApprovalRequest,
  waitForApprovalDecision
} from "./approvals.ts";
import { parseCliInvocation } from "./cli.ts";
import { appendCommand } from "./command-queue.ts";
import { collectProviderCapabilities, providerCapabilityErrors } from "./capabilities.ts";
import {
  evaluateDaemonCompatibility,
  formatRestartRequiredMessage,
  loadRuntimeIdentity
} from "./compatibility.ts";
import { ensureHomeConfig, ensureProjectScaffold, loadConfig } from "./config.ts";
import { KaviDaemon } from "./daemon.ts";
import {
  addDecisionRecord,
  buildClaimHotspots
} from "./decision-ledger.ts";
import { runDoctor } from "./doctor.ts";
import { writeJson } from "./fs.ts";
import {
  createGitignoreEntries,
  detectRepoRoot,
  ensureBootstrapCommit,
  ensureGitRepository,
  ensureWorktrees,
  findRepoRoot,
  listWorktreeChangedPaths
} from "./git.ts";
import { executeLand } from "./landing.ts";
import { compareMissionFamily, compareMissions } from "./mission-compare.ts";
import {
  addMissionCheckpoint,
  latestMission,
  selectMission,
  syncMissionStates,
  updateMissionPolicy
} from "./missions.ts";
import {
  explainAcceptanceFailure,
  explainMissionAcceptanceFailures
} from "./acceptance.ts";
import { verifyMissionAcceptanceById } from "./mission-verify.ts";
import { loadPackageInfo } from "./package-info.ts";
import {
  buildPatternAppliedPrompt,
  buildPatternConstellation,
  buildPatternTemplatePrompt,
  buildPatternTemplates,
  listPatterns,
  rankPatterns,
  rankPatternTemplates,
  searchPatterns
} from "./patterns.ts";
import { buildSessionId, nowIso, resolveAppPaths } from "./paths.ts";
import { buildMissionPlayback } from "./playback.ts";
import { currentExecutionPlan, decidePlanningMode } from "./planning.ts";
import { isProcessAlive, runCommand, runInteractiveCommand, spawnDetachedNode } from "./process.ts";
import { parseClaudeHookEvent } from "./provider-runtime.ts";
import { loadLatestLandReport } from "./reports.ts";
import {
  pingRpc,
  rpcAppendHookProgress,
  readSnapshot,
  rpcDismissRecommendation,
  rpcEnqueueTask,
  rpcMergeBrainEntries,
  rpcSelectMission,
  rpcUpdateMissionPolicy,
  rpcRetryTask,
  rpcNotifyExternalUpdate,
  rpcKickoff,
  rpcRecentEvents,
  rpcRetireBrainEntry,
  rpcResolveApproval,
  rpcSetBrainEntryPinned,
  rpcSetFullAccessMode,
  rpcRestoreRecommendation,
  rpcShutdown,
  rpcTaskArtifact
} from "./rpc.ts";
import {
  activeFollowUpRecommendations,
  buildOperatorRecommendations,
  buildRecommendationActionPlan,
  dismissOperatorRecommendation,
  restoreOperatorRecommendation
} from "./recommendations.ts";
import {
  buildBrainGraph,
  explainBrainEntry,
  mergeBrainEntries,
  queryBrainEntries,
  retireBrainEntry,
  searchBrainEntries,
  setBrainEntryPinned
} from "./brain.ts";
import { findOwnershipRuleConflicts } from "./ownership.ts";
import { filterReviewNotes } from "./reviews.ts";
import { resolveSessionRuntime } from "./runtime.ts";
import { markTaskForManualRetry, renewTaskLease } from "./scheduler.ts";
import {
  buildAdHocTask,
  extractPromptPathHints,
  previewRouteDecision,
  routeTask
} from "./router.ts";
import {
  createSessionRecord,
  loadSessionRecord,
  readRecentEvents,
  recordEvent,
  saveSessionRecord,
  sessionExists,
  sessionHeartbeatAgeMs
} from "./session.ts";
import { listTaskArtifacts, loadTaskArtifact, saveTaskArtifact } from "./task-artifacts.ts";
import { attachTui } from "./tui.ts";
import { buildUpdatePlan, parseRegistryVersion } from "./update.ts";
import {
  buildWorkflowActivity,
  buildMissionObservability,
  buildWorkflowResult,
  buildWorkflowSummary
} from "./workflow.ts";
import type {
  AgentName,
  ApprovalRequest,
  ApprovalRuleDecision,
  HookEventPayload,
  KaviSnapshot,
  RecommendationKind,
  RecommendationStatus,
  TaskSpec
} from "./types.ts";

const HEARTBEAT_STALE_MS = 10_000;
const CLAUDE_AUTO_ALLOW_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function getFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function getGoal(args: string[]): string | null {
  const explicit = getFlag(args, "--goal");
  if (explicit) {
    return explicit;
  }

  const filtered = args.filter((arg, index) => {
    if (arg === "--goal" || args[index - 1] === "--goal") {
      return false;
    }

    return !arg.startsWith("--");
  });

  return filtered.length > 0 ? filtered.join(" ") : null;
}

function getOptionalFilter(args: string[], name: string): string | null {
  const value = getFlag(args, name);
  if (!value || value.startsWith("--")) {
    return null;
  }

  return value;
}

function parseToggleValue(value: string | null, label: string): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be one of: on, off, true, false, yes, no.`);
}

function parseRecommendationKind(value: string | null): RecommendationKind | "all" | null {
  if (!value) {
    return null;
  }

  if (
    value === "all" ||
    value === "handoff" ||
    value === "follow_up" ||
    value === "integration" ||
    value === "ownership-config"
  ) {
    return value;
  }

  throw new Error(`Unsupported recommendation kind "${value}".`);
}

function parseRecommendationStatus(value: string | null): RecommendationStatus | "all" | null {
  if (!value) {
    return null;
  }

  if (value === "all" || value === "active" || value === "dismissed") {
    return value;
  }

  throw new Error(`Unsupported recommendation status "${value}".`);
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  let content = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    content += chunk;
  }

  return content;
}

async function confirmAction(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question(`${prompt} [y/N]: `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

function renderUsage(): string {
  return [
    "Usage:",
    "  kavi [--cwd PATH] <command> [...args]",
    "  kavi version",
    "  kavi init [--home] [--no-commit]",
    "  kavi doctor [--json]",
    "  kavi update [--check] [--dry-run] [--yes] [--tag latest|beta] [--version X.Y.Z]",
    "  kavi start [--goal \"...\"] [--approve-all]",
    "  kavi open [--goal \"...\"] [--approve-all]",
    "  kavi resume",
    "  kavi restart",
    "  kavi summary [--json]",
    "  kavi result [--json]",
    "  kavi mission [mission-id|latest] [--json]",
    "  kavi mission shadow [mission-id|latest] --prompt \"...\" [--inspect] [--direct] [--json]",
    "  kavi mission compare <left-mission-id|latest> <right-mission-id> [--json]",
    "  kavi mission compare --family <mission-id|latest> [--json]",
    "  kavi mission select <mission-id|latest> [--json]",
    "  kavi mission policy <mission-id|latest> [--guided|--autonomous|--overnight|--inspect] [--autopilot on|off] [--auto-verify on|off] [--auto-land on|off] [--pause-on-repair-failure on|off] [--retry-budget N] [--json]",
    "  kavi missions [--json]",
    "  kavi playback [mission-id|latest] [--json]",
    "  kavi accept [mission-id|latest] [--json]",
    "  kavi verify [mission-id|latest] [--json]",
    "  kavi brain [--json] [--all] [--query \"...\"] [--path FILE] [--category fact|decision|procedure|risk|artifact] [--scope repo|mission|personal|pattern] [--mission <mission-id>] [--retired] [--explain <entry-id>] [--graph] [--entry <entry-id>]",
    "  kavi brain-pin <entry-id>",
    "  kavi brain-unpin <entry-id>",
    "  kavi brain-retire <entry-id>",
    "  kavi brain-merge <target-entry-id> <source-entry-id>",
    "  kavi patterns [--json] [--all] [--query \"...\"]",
    "  kavi patterns constellation [--json]",
    "  kavi patterns graph [--json]",
    "  kavi patterns templates [--json] [--query \"...\"]",
    "  kavi patterns rank <prompt> [--json]",
    "  kavi patterns apply <pattern-id> --prompt \"...\" [--json]",
    "  kavi patterns template-apply <template-id> --prompt \"...\" [--json]",
    "  kavi status [--json]",
    "  kavi activity [--json] [--limit N]",
    "  kavi route [--json] [--no-ai] <prompt>",
    "  kavi routes [--json] [--limit N]",
    "  kavi paths [--json]",
    "  kavi task [--agent codex|claude|auto] [--plan|--direct] <prompt>",
    "  kavi retry <task-id|latest>",
    "  kavi plan [--json]",
    "  kavi recommend [--json] [--all] [--kind handoff|follow_up|integration|ownership-config] [--status active|dismissed] [--agent codex|claude|operator]",
    "  kavi recommend-apply <recommendation-id> [--force]",
    "  kavi recommend-dismiss <recommendation-id> [--reason \"...\"]",
    "  kavi recommend-restore <recommendation-id>",
    "  kavi tasks [--json]",
    "  kavi task-output <task-id|latest> [--json]",
    "  kavi decisions [--json] [--limit N]",
    "  kavi claims [--json] [--all]",
    "  kavi reviews [--json] [--all] [--agent codex|claude] [--assignee codex|claude|operator|unassigned] [--status open|resolved] [--disposition approve|concern|question|note|accepted_risk|wont_fix]",
    "  kavi approvals [--json] [--all]",
    "  kavi approve <request-id|latest> [--remember]",
    "  kavi deny <request-id|latest> [--remember]",
    "  kavi events [--limit N]",
    "  kavi stop",
    "  kavi land",
    "  kavi help"
  ].join("\n");
}

async function commandVersion(args: string[]): Promise<void> {
  const packageInfo = await loadPackageInfo();
  const payload = {
    name: packageInfo.name,
    version: packageInfo.version,
    node: process.version
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${packageInfo.name} ${packageInfo.version}`);
}

function isSessionLive(session: Awaited<ReturnType<typeof loadSessionRecord>>): boolean {
  if (session.status !== "running") {
    return false;
  }

  const heartbeatAgeMs = sessionHeartbeatAgeMs(session);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs < HEARTBEAT_STALE_MS;
  const pidAlive = isProcessAlive(session.daemonPid);
  if (heartbeatFresh) {
    return true;
  }

  return pidAlive;
}

async function waitForSession(
  paths: ReturnType<typeof resolveAppPaths>,
  expectedState: "running" | "stopped" = "running"
): Promise<void> {
  const timeoutMs = 10_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await sessionExists(paths)) {
        const session = await loadSessionRecord(paths);
        if (expectedState === "running" && isSessionLive(session) && (await pingRpc(paths))) {
          return;
        }

        if (expectedState === "stopped" && session.status === "stopped") {
          return;
        }
      }
    } catch {
      // ignore and retry
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for session state ${expectedState} in ${paths.stateFile}.`);
}

async function prepareProjectContext(
  cwd: string,
  options: {
    createRepository: boolean;
    ensureHeadCommit: boolean;
    ensureHomeConfig: boolean;
  }
): Promise<{
  repoRoot: string;
  paths: ReturnType<typeof resolveAppPaths>;
  createdRepository: boolean;
  bootstrapCommit: Awaited<ReturnType<typeof ensureBootstrapCommit>> | null;
}> {
  let repoRoot: string;
  let createdRepository = false;
  let hasGitRepository = false;

  if (options.createRepository) {
    const repository = await ensureGitRepository(cwd);
    repoRoot = repository.repoRoot;
    createdRepository = repository.createdRepository;
    hasGitRepository = true;
  } else {
    const existingRepoRoot = await findRepoRoot(cwd);
    repoRoot = existingRepoRoot ?? cwd;
    hasGitRepository = existingRepoRoot !== null;
  }

  const paths = resolveAppPaths(repoRoot);
  await ensureProjectScaffold(paths);
  if (hasGitRepository) {
    await createGitignoreEntries(repoRoot);
  }
  if (options.ensureHomeConfig) {
    await ensureHomeConfig(paths);
  }

  return {
    repoRoot,
    paths,
    createdRepository,
    bootstrapCommit: options.ensureHeadCommit ? await ensureBootstrapCommit(repoRoot) : null
  };
}

async function commandInit(cwd: string, args: string[]): Promise<void> {
  const skipCommit = args.includes("--no-commit");
  const prepared = await prepareProjectContext(cwd, {
    createRepository: true,
    ensureHeadCommit: !skipCommit,
    ensureHomeConfig: args.includes("--home")
  });
  if (args.includes("--home")) {
    console.log(`Initialized user-local Kavi config in ${prepared.paths.homeConfigFile}`);
  }

  if (prepared.createdRepository) {
    console.log(`Initialized git repository in ${prepared.repoRoot}`);
  }

  console.log(`Initialized Kavi project scaffold in ${prepared.paths.kaviDir}`);

  if (skipCommit) {
    console.log("Skipped bootstrap commit creation (--no-commit).");
    console.log('Kavi will create the first base commit automatically on "kavi open" or "kavi start".');
    return;
  }

  if (prepared.bootstrapCommit?.createdCommit) {
    console.log(
      `Created bootstrap commit ${prepared.bootstrapCommit.commit.slice(0, 12)} with ${prepared.bootstrapCommit.stagedPaths.length} tracked path${prepared.bootstrapCommit.stagedPaths.length === 1 ? "" : "s"}.`
    );
  }
}

async function commandDoctor(cwd: string, args: string[]): Promise<void> {
  const prepared = await prepareProjectContext(cwd, {
    createRepository: false,
    ensureHeadCommit: false,
    ensureHomeConfig: false
  });
  const checks = await runDoctor(prepared.repoRoot, prepared.paths);

  if (args.includes("--json")) {
    console.log(JSON.stringify(checks, null, 2));
    process.exitCode = checks.some((check) => !check.ok) ? 1 : 0;
    return;
  }

  let failed = false;
  for (const check of checks) {
    if (!check.ok) {
      failed = true;
    }

    console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  process.exitCode = failed ? 1 : 0;
}

async function commandUpdate(cwd: string, args: string[]): Promise<void> {
  const packageInfo = await loadPackageInfo();
  const tag = getOptionalFilter(args, "--tag");
  const version = getOptionalFilter(args, "--version");
  const plan = buildUpdatePlan(packageInfo.name, {
    tag,
    version
  });
  const repoRoot = (await findRepoRoot(cwd)) ?? cwd;
  const paths = resolveAppPaths(repoRoot);
  const hasSession = await sessionExists(paths);
  const session = hasSession ? await loadSessionRecord(paths) : null;
  const registry = await runCommand("npm", plan.viewArgs, {
    cwd: repoRoot
  });

  if (registry.code !== 0) {
    const detail = registry.stderr.trim() || registry.stdout.trim() || "npm view failed";
    if (session) {
      await recordEvent(paths, session.id, "update.failed", {
        packageName: packageInfo.name,
        targetSpecifier: plan.targetSpecifier,
        detail
      });
    }
    throw new Error(`Unable to resolve update target for ${packageInfo.name}@${plan.targetSpecifier}: ${detail}`);
  }

  const targetVersion = parseRegistryVersion(registry.stdout);
  if (!targetVersion) {
    throw new Error(`Unable to parse npm registry version for ${packageInfo.name}@${plan.targetSpecifier}.`);
  }

  if (session) {
    await recordEvent(paths, session.id, "update.checked", {
      packageName: packageInfo.name,
      currentVersion: packageInfo.version,
      targetVersion,
      targetSpecifier: plan.targetSpecifier
    });
  }

  const payload = {
    packageName: packageInfo.name,
    currentVersion: packageInfo.version,
    targetVersion,
    targetSpecifier: plan.targetSpecifier,
    command: ["npm", ...plan.installArgs]
  };

  if (args.includes("--check") || args.includes("--dry-run")) {
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Package: ${payload.packageName}`);
    console.log(`Current version: ${payload.currentVersion}`);
    console.log(`Target version: ${payload.targetVersion}`);
    console.log(`Target specifier: ${payload.targetSpecifier}`);
    console.log(`Command: ${payload.command.join(" ")}`);
    return;
  }

  if (targetVersion === packageInfo.version) {
    console.log(`${packageInfo.name} is already at ${packageInfo.version}.`);
    return;
  }

  const confirmed =
    args.includes("--yes") ||
    (await confirmAction(`Update ${packageInfo.name} from ${packageInfo.version} to ${targetVersion} using npm?`));
  if (!confirmed) {
    console.log("Update cancelled.");
    return;
  }

  if (session) {
    await recordEvent(paths, session.id, "update.started", {
      packageName: packageInfo.name,
      currentVersion: packageInfo.version,
      targetVersion,
      targetSpecifier: plan.targetSpecifier
    });
  }

  const exitCode = await runInteractiveCommand("npm", plan.installArgs, {
    cwd: repoRoot
  });
  if (exitCode !== 0) {
    if (session) {
      await recordEvent(paths, session.id, "update.failed", {
        packageName: packageInfo.name,
        currentVersion: packageInfo.version,
        targetVersion,
        targetSpecifier: plan.targetSpecifier,
        exitCode
      });
    }
    throw new Error(`npm install returned exit code ${exitCode}.`);
  }

  if (session) {
    await recordEvent(paths, session.id, "update.completed", {
      packageName: packageInfo.name,
      previousVersion: packageInfo.version,
      targetVersion,
      targetSpecifier: plan.targetSpecifier
    });
  }

  console.log(`Updated ${packageInfo.name} from ${packageInfo.version} to ${targetVersion}.`);
}

function renderFullAccessWarning(): string {
  return "WARNING: approve-all is enabled. Claude and Codex will run with full access, and Kavi approval prompts will be bypassed for future turns.";
}

async function daemonCompatibilityForSession(session: Awaited<ReturnType<typeof loadSessionRecord>>) {
  const identity = await loadRuntimeIdentity();
  return evaluateDaemonCompatibility(session, identity);
}

async function ensureMutableActionAllowed(
  paths: ReturnType<typeof resolveAppPaths>,
  session: Awaited<ReturnType<typeof loadSessionRecord>>,
  action: string
): Promise<void> {
  if (!isSessionLive(session) || !(await pingRpc(paths))) {
    return;
  }

  const compatibility = await daemonCompatibilityForSession(session);
  if (!compatibility.compatible) {
    throw new Error(formatRestartRequiredMessage(action, compatibility));
  }
}

async function ensureLandingAllowed(
  session: Awaited<ReturnType<typeof loadSessionRecord>>
): Promise<void> {
  syncMissionStates(session);
  const pendingFollowUps = activeFollowUpRecommendations(session);
  if (pendingFollowUps.length > 0) {
    throw new Error(
      `Landing is blocked by ${pendingFollowUps.length} follow-up recommendation(s). Review or dismiss them in the Recommendations tab before landing.`
    );
  }

  const mission = latestMission(session);
  if (mission?.acceptance.status === "failed") {
    throw new Error(
      "Landing is blocked because the active mission has failing acceptance checks. Re-run `kavi verify` or fix the failing work first."
    );
  }
  if (mission?.acceptance.status === "pending") {
    throw new Error(
      "Landing is blocked because the active mission has not passed acceptance yet. Run `kavi verify` after reviewing the result, then land once acceptance is cleared."
    );
  }
}

async function startOrAttachSession(
  cwd: string,
  goal: string | null,
  enableFullAccessMode: boolean
): Promise<string> {
  const prepared = await prepareProjectContext(cwd, {
    createRepository: true,
    ensureHeadCommit: false,
    ensureHomeConfig: true
  });
  const { repoRoot, paths } = prepared;

  if (await sessionExists(paths)) {
    try {
      const session = await loadSessionRecord(paths);
      if (isSessionLive(session) && (await pingRpc(paths))) {
        const compatibility = await daemonCompatibilityForSession(session);
        if (!compatibility.compatible) {
          await recordEvent(paths, session.id, "daemon.stale_detected", {
            daemonPid: session.daemonPid,
            daemonHeartbeatAt: session.daemonHeartbeatAt,
            daemonVersion: compatibility.remoteVersion,
            protocolVersion: compatibility.remoteProtocolVersion,
            clientVersion: compatibility.localVersion,
            clientProtocolVersion: compatibility.localProtocolVersion,
            reason: compatibility.reason
          });
          if (goal || enableFullAccessMode) {
            throw new Error(formatRestartRequiredMessage("This action", compatibility));
          }
          return session.socketPath;
        }
        if (enableFullAccessMode && !session.fullAccessMode) {
          await rpcSetFullAccessMode(paths, {
            enabled: true
          });
        }
        if (goal) {
          await rpcKickoff(paths, goal);
        }
        return session.socketPath;
      }

      await recordEvent(paths, session.id, "daemon.stale_detected", {
        daemonPid: session.daemonPid,
        daemonHeartbeatAt: session.daemonHeartbeatAt,
        daemonVersion: session.daemonVersion ?? null,
        protocolVersion: session.protocolVersion ?? null
      });
    } catch {
      // stale session, continue and rebuild
    }
  }

  await ensureStartupReady(repoRoot, paths);

  const config = await loadConfig(paths);
  const runtime = await resolveSessionRuntime(paths);
  const providerCapabilities = await collectProviderCapabilities(repoRoot, paths);
  const bootstrapCommit = await ensureBootstrapCommit(repoRoot);
  const baseCommit = bootstrapCommit.commit;
  const sessionId = buildSessionId();
  const rpcEndpoint = paths.socketPath;
  await fs.writeFile(paths.commandsFile, "", "utf8");
  const worktrees = await ensureWorktrees(repoRoot, paths, sessionId, config, baseCommit);
  await createSessionRecord(
    paths,
    config,
    runtime,
    sessionId,
    baseCommit,
    worktrees,
    goal,
    rpcEndpoint,
    enableFullAccessMode,
    providerCapabilities
  );
  if (prepared.createdRepository) {
    await recordEvent(paths, sessionId, "repo.initialized", {
      repoRoot
    });
  }
  if (bootstrapCommit.createdCommit) {
    await recordEvent(paths, sessionId, "repo.bootstrap_committed", {
      commit: bootstrapCommit.commit,
      stagedPaths: bootstrapCommit.stagedPaths
    });
  }

  const pid = spawnDetachedNode(
    runtime.nodeExecutable,
    [
      fileURLToPath(import.meta.url),
      "__daemon",
      "--repo-root",
      repoRoot
    ],
    repoRoot
  );

  const session = await loadSessionRecord(paths);
  session.daemonPid = pid;
  await writeJson(paths.stateFile, session);

  await waitForSession(paths);
  return rpcEndpoint;
}

async function ensureStartupReady(
  repoRoot: string,
  paths: ReturnType<typeof resolveAppPaths>
): Promise<void> {
  const checks = await runDoctor(repoRoot, paths);
  const required = new Set([
    "node",
    "codex",
    "claude",
    "claude-auth",
    "git-worktree",
    "codex-app-server",
    "codex-auth-file",
    "codex-app-server-canary",
    "claude-print-contract"
  ]);
  const failures = checks.filter((check) => required.has(check.name) && !check.ok);
  const providerCapabilities = await collectProviderCapabilities(repoRoot, paths);
  const capabilityFailures = providerCapabilityErrors(providerCapabilities);
  if (failures.length === 0 && capabilityFailures.length === 0) {
    return;
  }

  const details = [
    ...failures.map((check) => `${check.name}: ${check.detail}`),
    ...capabilityFailures
  ].join("\n");
  throw new Error(
    `Kavi startup blocked by failing readiness checks.\n${details}\nRun "kavi doctor" for the full report.`
  );
}

async function requireSession(cwd: string) {
  const repoRoot = await detectRepoRoot(cwd);
  const paths = resolveAppPaths(repoRoot);
  if (!(await sessionExists(paths))) {
    throw new Error("No Kavi session found for this repository.");
  }

  return { repoRoot, paths };
}

async function tryRpcSnapshot(paths: ReturnType<typeof resolveAppPaths>) {
  if (!(await pingRpc(paths))) {
    return null;
  }

  return await readSnapshot(paths);
}

async function loadSnapshot(
  paths: ReturnType<typeof resolveAppPaths>,
  eventLimit = 80
): Promise<KaviSnapshot> {
  const rpcSnapshot = await tryRpcSnapshot(paths);
  if (rpcSnapshot) {
    return rpcSnapshot;
  }

  const session = await loadSessionRecord(paths);
  syncMissionStates(session);
  const approvals = await listApprovalRequests(paths, {
    includeResolved: true
  });
  const events = await readRecentEvents(paths, eventLimit);
  const worktreeDiffs = await Promise.all(
    session.worktrees.map(async (worktree) => ({
      agent: worktree.agent,
      paths: await listWorktreeChangedPaths(worktree.path, session.baseCommit)
    }))
  );
  const latestLandReport = await loadLatestLandReport(paths);

  return {
    session,
    approvals,
    events,
    worktreeDiffs,
    latestLandReport
  };
}

async function notifyOperatorSurface(
  paths: ReturnType<typeof resolveAppPaths>,
  reason: string
): Promise<void> {
  if (!(await pingRpc(paths))) {
    return;
  }

  try {
    await rpcNotifyExternalUpdate(paths, reason);
  } catch {
    // best-effort notification only
  }
}

function runningTaskForAgent(
  session: Awaited<ReturnType<typeof loadSessionRecord>>,
  agent: AgentName
): TaskSpec | null {
  return [...session.tasks]
    .filter((task) => task.owner === agent && task.status === "running")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

async function appendClaudeHookProgress(
  paths: ReturnType<typeof resolveAppPaths>,
  session: Awaited<ReturnType<typeof loadSessionRecord>>,
  eventName: string,
  payload: Record<string, unknown>
): Promise<void> {
  const task = runningTaskForAgent(session, "claude");
  if (!task) {
    return;
  }

  const artifact = await loadTaskArtifact(paths, task.id);
  if (!artifact) {
    return;
  }

  const runtimeEvents = parseClaudeHookEvent(eventName, payload);
  if (runtimeEvents.length === 0) {
    return;
  }

  const transcriptPath =
    typeof payload.transcript_path === "string" && payload.transcript_path.trim()
      ? payload.transcript_path.trim()
      : typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()
        ? payload.transcriptPath.trim()
        : null;

  if (await pingRpc(paths)) {
    try {
      await rpcAppendHookProgress(paths, {
        taskId: task.id,
        entries: runtimeEvents.map((runtimeEvent) => ({
          summary: runtimeEvent.summary,
          paths: runtimeEvent.paths,
          provider: runtimeEvent.provider,
          eventName: runtimeEvent.eventName,
          source: runtimeEvent.source
        })),
        ...(transcriptPath ? { transcriptPath } : {})
      });
      return;
    } catch {
      // Fall back to direct session mutation if the live daemon does not yet expose hook progress RPC.
    }
  }

  const timestamp = nowIso();
  let appended = false;
  for (const runtimeEvent of runtimeEvents) {
    const pathsSignature = runtimeEvent.paths.join("\n");
    const lastEntry = artifact.progress.at(-1) ?? null;
    if (
      lastEntry &&
      lastEntry.kind === "provider" &&
      lastEntry.summary === runtimeEvent.summary &&
      lastEntry.eventName === runtimeEvent.eventName &&
      (lastEntry.source ?? null) === runtimeEvent.source &&
      lastEntry.paths.join("\n") === pathsSignature
    ) {
      continue;
    }

    artifact.progress.push({
      id: `progress-hook-${Date.now()}-${artifact.progress.length + 1}`,
      kind: "provider",
      summary: runtimeEvent.summary,
      paths: [...runtimeEvent.paths],
      createdAt: timestamp,
      provider: runtimeEvent.provider,
      eventName: runtimeEvent.eventName,
      source: runtimeEvent.source
    });
    appended = true;

    addMissionCheckpoint(session, task.missionId, {
      kind: "task_progress",
      title: `Claude runtime: ${task.title}`,
      detail: runtimeEvent.summary,
      taskId: task.id
    });
    await recordEvent(paths, session.id, "task.progress", {
      taskId: task.id,
      owner: task.owner,
      kind: "provider",
      paths: runtimeEvent.paths,
      summary: runtimeEvent.summary,
      provider: runtimeEvent.provider,
      eventName: runtimeEvent.eventName,
      source: runtimeEvent.source
    });
  }

  if (!appended) {
    return;
  }

  if (transcriptPath) {
    task.routeMetadata = {
      ...task.routeMetadata,
      claudeTranscriptPath: transcriptPath
    };
  }
  renewTaskLease(task, timestamp);
  task.updatedAt = timestamp;
  artifact.retryCount = task.retryCount;
  artifact.maxRetries = task.maxRetries;
  artifact.lastFailureSummary = task.lastFailureSummary;
  await saveTaskArtifact(paths, artifact);
  await saveSessionRecord(paths, session);
  await notifyOperatorSurface(paths, "claude.hook.progress");
}

function buildRouteAnalytics(
  tasks: TaskSpec[]
): {
  byOwner: Record<AgentName, number>;
  byStrategy: Record<string, number>;
} {
  const byOwner: Record<AgentName, number> = {
    codex: 0,
    claude: 0
  };
  const byStrategy: Record<string, number> = {};

  for (const task of tasks) {
    if (task.owner === "codex" || task.owner === "claude") {
      byOwner[task.owner] += 1;
    }

    if (task.routeStrategy) {
      byStrategy[task.routeStrategy] = (byStrategy[task.routeStrategy] ?? 0) + 1;
    }
  }

  return {
    byOwner,
    byStrategy
  };
}

async function commandOpen(cwd: string, args: string[]): Promise<void> {
  const goal = getGoal(args);
  await startOrAttachSession(cwd, goal, hasFlag(args, "--approve-all"));
  const repoRoot = await detectRepoRoot(cwd);
  const paths = resolveAppPaths(repoRoot);
  const session = await loadSessionRecord(paths);
  if (session.fullAccessMode) {
    console.log(renderFullAccessWarning());
  }
  await attachTui(paths);
}

async function commandResume(cwd: string): Promise<void> {
  const { paths } = await requireSession(cwd);
  await waitForSession(paths);
  await attachTui(paths);
}

async function commandStart(cwd: string, args: string[]): Promise<void> {
  const goal = getGoal(args);
  const socketPath = await startOrAttachSession(cwd, goal, hasFlag(args, "--approve-all"));
  const repoRoot = await detectRepoRoot(cwd);
  const paths = resolveAppPaths(repoRoot);
  const session = await loadSessionRecord(paths);
  const compatibility = await daemonCompatibilityForSession(session);
  console.log(`Started Kavi session ${session.id}`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Control: ${socketPath}`);
  console.log(`Access: ${session.fullAccessMode ? "approve-all" : "standard"}`);
  console.log(
    `Runtime: node=${session.runtime.nodeExecutable} codex=${session.runtime.codexExecutable} claude=${session.runtime.claudeExecutable}`
  );
  if (!compatibility.compatible) {
    console.log(formatRestartRequiredMessage("Mutating this session", compatibility));
  }
  if (session.fullAccessMode) {
    console.log(renderFullAccessWarning());
  }
  for (const worktree of session.worktrees) {
    console.log(`- ${worktree.agent}: ${worktree.path}`);
  }
}

async function commandStatus(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const snapshot = await loadSnapshot(paths, 60);
  const session = snapshot.session;
  const pendingApprovals = snapshot.approvals.filter((item) => item.status === "pending");
  const heartbeatAgeMs = sessionHeartbeatAgeMs(session);
  const routeAnalytics = buildRouteAnalytics(session.tasks);
  const ownershipConflicts = findOwnershipRuleConflicts(session.config);
  const claimHotspots = buildClaimHotspots(session);
  const recommendations = buildOperatorRecommendations(session, {
    includeDismissed: true
  });
  const compatibility = await daemonCompatibilityForSession(session);
  const workflowSummary = buildWorkflowSummary(snapshot);
  const activePlan = currentExecutionPlan(session);
  const activeMission = latestMission(session);
  const artifacts = await listTaskArtifacts(paths);
  const missionObservability = buildMissionObservability(snapshot, artifacts, activeMission);
  const payload = {
    id: session.id,
    status: session.status,
    repoRoot: session.repoRoot,
    socketPath: session.socketPath,
    goal: session.goal,
    daemonPid: session.daemonPid,
    daemonHeartbeatAt: session.daemonHeartbeatAt,
    daemonVersion: session.daemonVersion ?? null,
    protocolVersion: session.protocolVersion ?? null,
    fullAccessMode: session.fullAccessMode,
    daemonHealthy: isSessionLive(session),
    rpcConnected: await pingRpc(paths),
    daemonCompatible: compatibility.compatible,
    daemonCompatibilityReason: compatibility.reason,
    clientVersion: compatibility.localVersion,
    clientProtocolVersion: compatibility.localProtocolVersion,
    heartbeatAgeMs,
    workflowStage: workflowSummary.stage,
    latestLandReport: workflowSummary.latestLandReport
      ? {
          id: workflowSummary.latestLandReport.id,
          createdAt: workflowSummary.latestLandReport.createdAt,
          targetBranch: workflowSummary.latestLandReport.targetBranch
        }
      : null,
    runtime: session.runtime,
    providerCapabilities: session.providerCapabilities,
    missionCounts: {
      total: session.missions.length,
      active: session.missions.filter((mission) => mission.status === "active" || mission.status === "planning").length,
      blocked: session.missions.filter((mission) => mission.status === "blocked").length,
      readyToLand: session.missions.filter((mission) => mission.status === "ready_to_land").length
    },
    activeMission: activeMission
      ? {
          id: activeMission.id,
          title: activeMission.title,
          status: activeMission.status,
          mode: activeMission.mode,
          planId: activeMission.planId,
          acceptanceStatus: activeMission.acceptance.status,
          activeTaskIds: activeMission.activeTaskIds,
          health: activeMission.health ?? null,
          observability: missionObservability,
          policy: activeMission.policy ?? null,
          workstreams: activeMission.spec?.workstreamKinds ?? [],
          stackHints: activeMission.spec?.stackHints ?? [],
          appliedPatternIds: activeMission.appliedPatternIds ?? []
        }
      : null,
    taskCounts: {
      total: session.tasks.length,
      pending: session.tasks.filter((task) => task.status === "pending").length,
      running: session.tasks.filter((task) => task.status === "running").length,
      blocked: session.tasks.filter((task) => task.status === "blocked").length,
      completed: session.tasks.filter((task) => task.status === "completed").length,
      failed: session.tasks.filter((task) => task.status === "failed").length
    },
    approvalCounts: {
      pending: pendingApprovals.length
    },
    decisionCounts: {
      total: session.decisions.length
    },
    reviewCounts: {
      open: session.reviewNotes.filter((note) => note.status === "open").length,
      total: session.reviewNotes.length
    },
    activePlan: activePlan
      ? {
          id: activePlan.id,
          title: activePlan.title,
          status: activePlan.status,
          plannerTaskId: activePlan.plannerTaskId,
          nodeCount: activePlan.nodes.length,
          completedNodeCount: activePlan.nodes.filter((node) => node.status === "completed").length
        }
      : null,
    pathClaimCounts: {
      active: session.pathClaims.filter((claim) => claim.status === "active").length
    },
    recommendationCounts: {
      total: recommendations.length,
      active: recommendations.filter((item) => item.status === "active").length,
      dismissed: recommendations.filter((item) => item.status === "dismissed").length,
      withOpenFollowUps: recommendations.filter((item) => item.openFollowUpTaskIds.length > 0).length,
      followUp: recommendations.filter((item) => item.kind === "follow_up").length,
      integration: recommendations.filter((item) => item.kind === "integration").length,
      handoff: recommendations.filter((item) => item.kind === "handoff").length,
      ownershipConfig: recommendations.filter((item) => item.kind === "ownership-config").length
    },
    routeCounts: routeAnalytics,
    ownershipConflicts: ownershipConflicts.length,
    claimHotspots: claimHotspots.length,
    routingOwnership: {
      codexPaths: session.config.routing.codexPaths,
      claudePaths: session.config.routing.claudePaths
    },
    worktrees: session.worktrees
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Session: ${payload.id}`);
  console.log(`Status: ${payload.status}${payload.daemonHealthy ? " (healthy)" : " (stale or stopped)"}`);
  console.log(`Repo: ${payload.repoRoot}`);
  console.log(`Control: ${payload.socketPath}${payload.rpcConnected ? " (connected)" : " (disconnected)"}`);
  console.log(
    `Daemon version: ${payload.daemonVersion ?? "unknown"} | protocol=${payload.protocolVersion ?? "unknown"} | client=${payload.clientVersion} | client-protocol=${payload.clientProtocolVersion}${payload.daemonCompatible ? "" : " | restart required"}`
  );
  if (payload.daemonCompatibilityReason) {
    console.log(`Compatibility: ${payload.daemonCompatibilityReason}`);
  }
  console.log(`Access: ${payload.fullAccessMode ? "approve-all" : "standard"}`);
  console.log(`Goal: ${payload.goal ?? "-"}`);
  console.log(`Workflow stage: ${payload.workflowStage.label} | ${payload.workflowStage.detail}`);
  if (payload.latestLandReport) {
    console.log(
      `Latest land: ${payload.latestLandReport.createdAt} -> ${payload.latestLandReport.targetBranch}`
    );
  }
  console.log(`Daemon PID: ${payload.daemonPid ?? "-"}`);
  console.log(`Heartbeat: ${payload.daemonHeartbeatAt ?? "-"}${heartbeatAgeMs === null ? "" : ` (${heartbeatAgeMs} ms ago)`}`);
  console.log(
    `Runtime: node=${payload.runtime.nodeExecutable} codex=${payload.runtime.codexExecutable} claude=${payload.runtime.claudeExecutable}`
  );
  console.log(
    `Providers: ${payload.providerCapabilities.map((manifest) => `${manifest.provider}:${manifest.status}${manifest.version ? `(${manifest.version})` : ""}`).join(" | ")}`
  );
  console.log(
    `Missions: total=${payload.missionCounts.total} active=${payload.missionCounts.active} blocked=${payload.missionCounts.blocked} ready=${payload.missionCounts.readyToLand}`
  );
  if (payload.activeMission) {
    console.log(
      `Active mission: ${payload.activeMission.title} | ${payload.activeMission.status} | ${payload.activeMission.mode} | acceptance=${payload.activeMission.acceptanceStatus}`
    );
    if (payload.activeMission.policy) {
      console.log(
        `  policy: autonomy=${payload.activeMission.policy.autonomyLevel} approvals=${payload.activeMission.policy.approvalMode} retry=${payload.activeMission.policy.retryBudget} verify=${payload.activeMission.policy.autoVerify ? "auto" : "manual"} land=${payload.activeMission.policy.autoLand ? "auto" : "manual"} pause-on-repair-failure=${payload.activeMission.policy.pauseOnRepairFailure ? "yes" : "no"}`
      );
    }
  }
  console.log(
    `Tasks: total=${payload.taskCounts.total} pending=${payload.taskCounts.pending} running=${payload.taskCounts.running} blocked=${payload.taskCounts.blocked} completed=${payload.taskCounts.completed} failed=${payload.taskCounts.failed}`
  );
  console.log(`Approvals: pending=${payload.approvalCounts.pending}`);
  console.log(`Reviews: open=${payload.reviewCounts.open} total=${payload.reviewCounts.total}`);
  if (payload.activePlan) {
    console.log(
      `Execution plan: ${payload.activePlan.title} | ${payload.activePlan.status} | nodes=${payload.activePlan.completedNodeCount}/${payload.activePlan.nodeCount}`
    );
  } else {
    console.log("Execution plan: none active");
  }
  console.log(`Decisions: total=${payload.decisionCounts.total}`);
  console.log(`Path claims: active=${payload.pathClaimCounts.active}`);
  console.log(
    `Recommendations: total=${payload.recommendationCounts.total} active=${payload.recommendationCounts.active} dismissed=${payload.recommendationCounts.dismissed} open-followups=${payload.recommendationCounts.withOpenFollowUps} follow-up=${payload.recommendationCounts.followUp} integration=${payload.recommendationCounts.integration} handoff=${payload.recommendationCounts.handoff} ownership-config=${payload.recommendationCounts.ownershipConfig}`
  );
  console.log(
    `Routes: codex=${payload.routeCounts.byOwner.codex} claude=${payload.routeCounts.byOwner.claude} | strategies=${Object.entries(payload.routeCounts.byStrategy).map(([strategy, count]) => `${strategy}:${count}`).join(", ") || "-"}`
  );
  console.log(`Ownership conflicts: ${payload.ownershipConflicts} | Claim hotspots: ${payload.claimHotspots}`);
  console.log(
    `Routing ownership: codex=${payload.routingOwnership.codexPaths.join(", ") || "-"} | claude=${payload.routingOwnership.claudePaths.join(", ") || "-"}`
  );
  for (const worktree of payload.worktrees) {
    console.log(`- ${worktree.agent}: ${worktree.path}`);
  }
}

async function commandSummary(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const snapshot = await loadSnapshot(paths, 120);
  const artifacts = await listTaskArtifacts(paths);
  const summary = buildWorkflowSummary(snapshot, artifacts);
  const result = buildWorkflowResult(snapshot, artifacts);
  const activePlan = currentExecutionPlan(snapshot.session);
  const mission = latestMission(snapshot.session);

  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Goal: ${summary.goal ?? "-"}`);
  console.log(`Stage: ${summary.stage.label} | ${summary.stage.detail}`);
  console.log(`Headline: ${result.headline}`);
  if (mission) {
    console.log(`Mission: ${mission.title} | ${mission.status} | ${mission.mode} | acceptance=${mission.acceptance.status}`);
    console.log(`Mission summary: ${mission.summary}`);
    if (missionObservability) {
      console.log(
        `Mission runtime: tasks=${missionObservability.completedTasks}/${missionObservability.totalTasks} completed | running=${missionObservability.runningTasks} | pending=${missionObservability.pendingTasks} | repairs=${missionObservability.activeRepairTasks} | retries-used=${missionObservability.retriesUsed}`
      );
      if (missionObservability.latestFailure) {
        console.log(
          `Mission failure: ${missionObservability.latestFailure.taskId} | ${missionObservability.latestFailure.summary}`
        );
      } else if (missionObservability.latestProgress) {
        console.log(
          `Mission progress: ${missionObservability.latestProgress.taskId} | ${missionObservability.latestProgress.summary}`
        );
      }
    }
  }
  console.log(
    `Tasks: pending=${summary.taskCounts.pending} running=${summary.taskCounts.running} blocked=${summary.taskCounts.blocked} completed=${summary.taskCounts.completed} failed=${summary.taskCounts.failed}`
  );
  console.log(
    `Approvals: pending=${summary.approvalCounts.pending} | Reviews: open=${summary.reviewCounts.open} | Recommendations: active=${summary.recommendationCounts.active} dismissed=${summary.recommendationCounts.dismissed}`
  );
  if (activePlan) {
    console.log(
      `Execution plan: ${activePlan.title} | ${activePlan.status} | nodes=${activePlan.nodes.filter((node) => node.status === "completed").length}/${activePlan.nodes.length}`
    );
  }
  console.log(`Land readiness: ${summary.landReadiness.state}`);
  if (summary.latestLandReport) {
    console.log(
      `Latest landed result: ${summary.latestLandReport.createdAt} -> ${summary.latestLandReport.targetBranch}`
    );
  }

  if (summary.landReadiness.blockers.length > 0) {
    console.log("Blockers:");
    for (const blocker of summary.landReadiness.blockers) {
      console.log(`- ${blocker}`);
    }
  }

  if (summary.landReadiness.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of summary.landReadiness.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log("Current changes:");
  for (const changeSet of summary.changedByAgent) {
    console.log(
      `- ${changeSet.agent}: ${changeSet.paths.length} path(s)${changeSet.paths.length > 0 ? ` | ${changeSet.paths.join(", ")}` : ""}`
    );
  }

  if (summary.completedTasks.length > 0) {
    console.log("Completed results:");
    for (const task of summary.completedTasks.slice(0, 8)) {
      console.log(
        `- ${task.taskId} | ${task.owner} | ${task.title} | ${task.summary}${task.claimedPaths.length > 0 ? ` | paths=${task.claimedPaths.join(", ")}` : ""}`
      );
    }
  }

  if (summary.recentActivity.length > 0) {
    console.log("Recent activity:");
    for (const entry of summary.recentActivity.slice(0, 8)) {
      console.log(`- ${entry.timestamp} | ${entry.title} | ${entry.detail}`);
    }
  }

  if (summary.landReadiness.nextActions.length > 0) {
    console.log("Next actions:");
    for (const action of summary.landReadiness.nextActions) {
      console.log(`- ${action}`);
    }
  }
}

async function commandResult(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const snapshot = await loadSnapshot(paths, 120);
  const artifacts = await listTaskArtifacts(paths);
  const result = buildWorkflowResult(snapshot, artifacts);
  const activePlan = currentExecutionPlan(snapshot.session);
  const mission = latestMission(snapshot.session);

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Goal: ${result.goal ?? "-"}`);
  console.log(`Stage: ${result.stage.label} | ${result.stage.detail}`);
  console.log(`Headline: ${result.headline}`);
  if (mission) {
    console.log(`Mission: ${mission.title} | ${mission.status} | ${mission.mode}`);
    console.log(`Mission acceptance: ${mission.acceptance.status}`);
    console.log(`Mission summary: ${mission.summary}`);
    if (result.missionObservability) {
      console.log(
        `Mission runtime: tasks=${result.missionObservability.completedTasks}/${result.missionObservability.totalTasks} completed | running=${result.missionObservability.runningTasks} | pending=${result.missionObservability.pendingTasks} | repairs=${result.missionObservability.activeRepairTasks} | retries-used=${result.missionObservability.retriesUsed}`
      );
      console.log(
        `Mission observability: active owners=${result.missionObservability.activeOwners.join(", ") || "-"} | changed paths=${result.missionObservability.changedPaths} | critical path=${result.missionObservability.criticalPath.join(" -> ") || "-"}`
      );
      if (result.missionObservability.nextReadyNodes.length > 0) {
        console.log(
          `Next ready nodes: ${result.missionObservability.nextReadyNodes.map((node) => `${node.owner}:${node.key}`).join(", ")}`
        );
      }
      if (result.missionObservability.latestFailure) {
        console.log(
          `Latest failure: ${result.missionObservability.latestFailure.taskId} | ${result.missionObservability.latestFailure.summary}`
        );
      } else if (result.missionObservability.latestProgress) {
        console.log(
          `Latest progress: ${result.missionObservability.latestProgress.taskId} | ${result.missionObservability.latestProgress.summary}`
        );
      }
    }
  }
  if (activePlan) {
    console.log(`Execution plan: ${activePlan.title} | ${activePlan.status}`);
    console.log(`Planner task: ${activePlan.plannerTaskId}`);
    for (const node of activePlan.nodes) {
      console.log(
        `- ${node.key} | ${node.owner} | ${node.status} | ${node.executionMode}${node.dependsOn.length ? ` | depends=${node.dependsOn.join(", ")}` : ""} | ${node.title}`
      );
    }
  } else {
    console.log("Execution plan: none active");
  }

  if (result.latestLandReport) {
    console.log(
      `Latest land: ${result.latestLandReport.createdAt} | ${result.latestLandReport.targetBranch}`
    );
    console.log(
      `Validation: ${result.latestLandReport.validationCommand.trim() || "(none configured)"} | ${result.latestLandReport.validationStatus} | ${result.latestLandReport.validationDetail}`
    );
    console.log(`Review threads landed: ${result.latestLandReport.reviewThreadsLanded}`);
  } else {
    console.log("Latest land: none yet");
  }

  console.log("Agent results:");
  for (const agent of result.agentResults) {
    console.log(
      `- ${agent.agent}: completed=${agent.completedTaskCount} | latest=${agent.latestTaskTitle ?? "-"} | ${agent.latestSummary ?? "No completed result yet."}`
    );
    if (agent.changedPaths.length > 0) {
      console.log(`  unlanded: ${agent.changedPaths.join(", ")}`);
    } else if (agent.landedPaths.length > 0) {
      console.log(`  landed: ${agent.landedPaths.join(", ")}`);
    }
  }

  if (result.completedTasks.length > 0) {
    console.log("Completed outputs:");
    for (const task of result.completedTasks.slice(0, 8)) {
      console.log(
        `- ${task.owner} | ${task.title} | ${task.summary}${task.claimedPaths.length > 0 ? ` | paths=${task.claimedPaths.join(", ")}` : ""}`
      );
    }
  }

  if (result.latestLandReport?.summary.length) {
    console.log("Merged result summary:");
    for (const line of result.latestLandReport.summary) {
      console.log(`- ${line}`);
    }
  } else {
    console.log("Result summary:");
    for (const line of result.summaryLines.slice(0, 6)) {
      console.log(`- ${line}`);
    }
  }

  if (result.nextActions.length > 0) {
    console.log("Next actions:");
    for (const action of result.nextActions) {
      console.log(`- ${action}`);
    }
  }
}

async function commandMission(cwd: string, args: string[]): Promise<void> {
  if (args[0] === "compare") {
    const compareFlags = args.slice(1);
    const familyTarget = getOptionalFilter(compareFlags, "--family");
    const { paths } = await requireSession(cwd);
    const session = await loadSessionRecord(paths);
    syncMissionStates(session);
    const artifacts = await listTaskArtifacts(paths);
    const missionCandidates = session.missions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((mission) => mission.id);
    const snapshot = {
      session,
      approvals: [],
      events: [],
      worktreeDiffs: [],
      latestLandReport: null
    };

    if (familyTarget) {
      const focusMissionId = resolveRequestedMissionId([familyTarget], missionCandidates);
      const focusMission = session.missions.find((item) => item.id === focusMissionId) ?? null;
      if (!focusMission) {
        throw new Error(`Mission ${focusMissionId} could not be found for comparison.`);
      }

      const comparisons = compareMissionFamily(snapshot, focusMission, artifacts);
      const payload = {
        focusMission,
        comparisons: comparisons.map((comparison) => ({
          alternativeMission: comparison.rightMission,
          focusScore: comparison.leftScore,
          alternativeScore: comparison.rightScore,
          scoreDelta: comparison.rightScore - comparison.leftScore,
          preferredMissionId: comparison.preferredMissionId,
          changedPathOverlap: comparison.changedPathOverlap,
          focusOnlyPaths: comparison.leftOnlyPaths,
          alternativeOnlyPaths: comparison.rightOnlyPaths,
          focusAcceptanceFailures: comparison.leftAcceptanceFailures,
          alternativeAcceptanceFailures: comparison.rightAcceptanceFailures,
          recommendation: comparison.recommendation,
          dimensions: comparison.dimensions
        }))
      };

      if (args.includes("--json")) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`Focus mission: ${focusMission.id} | ${focusMission.title}`);
      if (comparisons.length === 0) {
        console.log("No related shadow or sibling missions found.");
        return;
      }
      console.log("Shadow family:");
      for (const comparison of comparisons) {
        console.log(
          `- ${comparison.rightMission.id} | score=${comparison.rightScore} vs focus=${comparison.leftScore} | preferred=${comparison.preferredMissionId ?? "tie"}`
        );
        console.log(
          `  acceptance=${comparison.rightMission.acceptance.status} | health=${comparison.rightMission.health?.state ?? "-"} (${comparison.rightMission.health?.score ?? "-"}) | overlap=${comparison.changedPathOverlap.join(", ") || "-"}`
        );
        console.log(
          `  exclusive-paths: focus=${comparison.leftOnlyPaths.length} alt=${comparison.rightOnlyPaths.length} | alt failed acceptance=${comparison.rightAcceptanceFailures.length}`
        );
        const topDimensions = comparison.dimensions
          .filter((dimension) => dimension.preferred === "right")
          .sort((left, right) => right.weight - left.weight)
          .slice(0, 3)
          .map((dimension) => `${dimension.label} (${dimension.weight})`);
        console.log(`  top factors: ${topDimensions.join(" | ") || "-"}`);
        console.log(`  recommendation: ${comparison.recommendation}`);
      }
      return;
    }

    const compareArgs = compareFlags.filter((arg) => !arg.startsWith("--"));
    if (compareArgs.length < 2) {
      throw new Error("mission compare requires <left-mission-id|latest> <right-mission-id>.");
    }
    const leftId = resolveRequestedMissionId([compareArgs[0] ?? "latest"], missionCandidates);
    const rightId = resolveRequestedMissionId([compareArgs[1] ?? "latest"], missionCandidates);
    const leftMission = session.missions.find((item) => item.id === leftId) ?? null;
    const rightMission = session.missions.find((item) => item.id === rightId) ?? null;
    if (!leftMission || !rightMission) {
      throw new Error("One or both missions could not be found for comparison.");
    }
    const comparison = compareMissions(snapshot, leftMission, rightMission, artifacts);
    const payload = {
      left: {
        mission: leftMission,
        observability: comparison.leftObservability,
        score: comparison.leftScore,
        failedAcceptance: comparison.leftAcceptanceFailures
      },
      right: {
        mission: rightMission,
        observability: comparison.rightObservability,
        score: comparison.rightScore,
        failedAcceptance: comparison.rightAcceptanceFailures
      },
      dimensions: comparison.dimensions,
      changedPathOverlap: comparison.changedPathOverlap,
      leftOnlyPaths: comparison.leftOnlyPaths,
      rightOnlyPaths: comparison.rightOnlyPaths,
      preferredMissionId: comparison.preferredMissionId,
      recommendation: comparison.recommendation
    };

    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Left: ${leftMission.id} | ${leftMission.title}`);
    console.log(
      `  status=${leftMission.status} | acceptance=${leftMission.acceptance.status} | health=${leftMission.health?.state ?? "-"} (${leftMission.health?.score ?? "-"})`
    );
    console.log(
      `  score=${comparison.leftScore} | tasks=${comparison.leftObservability?.completedTasks ?? 0}/${comparison.leftObservability?.totalTasks ?? 0} completed | active owners=${comparison.leftObservability?.activeOwners.join(", ") || "-"} | critical path=${comparison.leftObservability?.criticalPath.join(" -> ") || "-"} | changed paths=${comparison.leftObservability?.changedPaths ?? 0}`
    );
    console.log(`  patterns=${(leftMission.appliedPatternIds ?? []).length} | risks=${(leftMission.risks ?? []).length}`);
    if (comparison.leftAcceptanceFailures.length > 0) {
      console.log(`  failed acceptance: ${comparison.leftAcceptanceFailures.join(" | ")}`);
    }
    console.log(`Right: ${rightMission.id} | ${rightMission.title}`);
    console.log(
      `  status=${rightMission.status} | acceptance=${rightMission.acceptance.status} | health=${rightMission.health?.state ?? "-"} (${rightMission.health?.score ?? "-"})`
    );
    console.log(
      `  score=${comparison.rightScore} | tasks=${comparison.rightObservability?.completedTasks ?? 0}/${comparison.rightObservability?.totalTasks ?? 0} completed | active owners=${comparison.rightObservability?.activeOwners.join(", ") || "-"} | critical path=${comparison.rightObservability?.criticalPath.join(" -> ") || "-"} | changed paths=${comparison.rightObservability?.changedPaths ?? 0}`
    );
    console.log(`  patterns=${(rightMission.appliedPatternIds ?? []).length} | risks=${(rightMission.risks ?? []).length}`);
    if (comparison.rightAcceptanceFailures.length > 0) {
      console.log(`  failed acceptance: ${comparison.rightAcceptanceFailures.join(" | ")}`);
    }
    console.log(`Path overlap: ${comparison.changedPathOverlap.join(", ") || "-"}`);
    console.log(`Left-only paths: ${comparison.leftOnlyPaths.join(", ") || "-"}`);
    console.log(`Right-only paths: ${comparison.rightOnlyPaths.join(", ") || "-"}`);
    const topLeftDimensions = comparison.dimensions
      .filter((dimension) => dimension.preferred === "left")
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 3)
      .map((dimension) => `${dimension.label} (${dimension.weight})`);
    const topRightDimensions = comparison.dimensions
      .filter((dimension) => dimension.preferred === "right")
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 3)
      .map((dimension) => `${dimension.label} (${dimension.weight})`);
    console.log(`Top left factors: ${topLeftDimensions.join(" | ") || "-"}`);
    console.log(`Top right factors: ${topRightDimensions.join(" | ") || "-"}`);
    console.log("Dimensions:");
    for (const dimension of comparison.dimensions) {
      console.log(
        `- ${dimension.label}: left=${dimension.leftValue} | right=${dimension.rightValue} | preferred=${dimension.preferred} | ${dimension.detail}`
      );
    }
    console.log(`Recommendation: ${comparison.recommendation}`);
    return;
  }

  if (args[0] === "select") {
    const { paths } = await requireSession(cwd);
    const session = await loadSessionRecord(paths);
    syncMissionStates(session);
    const missionId = resolveRequestedMissionId(
      [args[1] ?? "latest"],
      session.missions
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((mission) => mission.id)
    );
    const mission = session.missions.find((item) => item.id === missionId) ?? null;
    if (!mission) {
      throw new Error(`Mission ${missionId} was not found.`);
    }
    if (isSessionLive(session) && (await pingRpc(paths))) {
      await ensureMutableActionAllowed(paths, session, "Selecting a mission");
      await rpcSelectMission(paths, {
        missionId: mission.id
      });
    } else {
      const selected = selectMission(session, mission.id);
      if (!selected) {
        throw new Error(`Mission ${mission.id} was not found.`);
      }
      addDecisionRecord(session, {
        kind: "plan",
        agent: "router",
        taskId: selected.rootTaskId ?? selected.planningTaskId ?? null,
        summary: `Selected mission ${selected.id}`,
        detail: selected.shadowOfMissionId
          ? `Operator selected shadow mission ${selected.id} over ${selected.shadowOfMissionId}.`
          : `Operator selected mission ${selected.id} as the active mission focus.`,
        metadata: {
          missionId: selected.id,
          shadowOfMissionId: selected.shadowOfMissionId ?? null
        }
      });
      addMissionCheckpoint(session, selected.id, {
        kind: "task_progress",
        title: "Mission selected",
        detail: "Operator set this mission as the active focus for review, verification, and landing.",
        taskId: selected.rootTaskId ?? selected.planningTaskId ?? null
      });
      await saveSessionRecord(paths, session);
      await recordEvent(paths, session.id, "mission.selected", {
        missionId: selected.id,
        shadowOfMissionId: selected.shadowOfMissionId ?? null
      });
      await rpcNotifyExternalUpdate(paths).catch(() => {});
    }

    if (args.includes("--json")) {
      console.log(JSON.stringify({
        selectedMissionId: mission.id,
        shadowOfMissionId: mission.shadowOfMissionId ?? null
      }, null, 2));
      return;
    }

    console.log(`Selected mission ${mission.id}`);
    if (mission.shadowOfMissionId) {
      console.log(`Shadow of: ${mission.shadowOfMissionId}`);
    }
    return;
  }

  if (args[0] === "policy") {
    const { paths } = await requireSession(cwd);
    const rpcSnapshot = await tryRpcSnapshot(paths);
    const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
    syncMissionStates(session);
    const missionId = resolveRequestedMissionId(
      [args[1] ?? "latest"],
      session.missions
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((mission) => mission.id)
    );
    const mission = session.missions.find((item) => item.id === missionId) ?? null;
    if (!mission) {
      throw new Error(`Mission ${missionId} was not found.`);
    }

    const autonomyLevel =
      hasFlag(args, "--inspect")
        ? "inspect"
        : hasFlag(args, "--guided")
          ? "guided"
          : hasFlag(args, "--autonomous")
            ? "autonomous"
            : hasFlag(args, "--overnight")
              ? "overnight"
              : undefined;
    const autopilotEnabled = parseToggleValue(getOptionalFilter(args, "--autopilot"), "--autopilot");
    const autoVerify = parseToggleValue(getOptionalFilter(args, "--auto-verify"), "--auto-verify");
    const autoLand = parseToggleValue(getOptionalFilter(args, "--auto-land"), "--auto-land");
    const pauseOnRepairFailure = parseToggleValue(
      getOptionalFilter(args, "--pause-on-repair-failure"),
      "--pause-on-repair-failure"
    );
    const retryBudgetRaw = getOptionalFilter(args, "--retry-budget");
    const retryBudget =
      retryBudgetRaw === null
        ? undefined
        : Math.max(0, Math.min(5, Number.parseInt(retryBudgetRaw, 10)));
    const shouldMutate =
      autonomyLevel !== undefined ||
      typeof autopilotEnabled === "boolean" ||
      typeof autoVerify === "boolean" ||
      typeof autoLand === "boolean" ||
      typeof pauseOnRepairFailure === "boolean" ||
      typeof retryBudget === "number";

    if (shouldMutate) {
      if (isSessionLive(session) && (await pingRpc(paths))) {
        await ensureMutableActionAllowed(paths, session, "Updating mission policy");
        await rpcUpdateMissionPolicy(paths, {
          missionId: mission.id,
          ...(autonomyLevel ? { autonomyLevel } : {}),
          ...(typeof autopilotEnabled === "boolean" ? { autopilotEnabled } : {}),
          ...(typeof autoVerify === "boolean" ? { autoVerify } : {}),
          ...(typeof autoLand === "boolean" ? { autoLand } : {}),
          ...(typeof pauseOnRepairFailure === "boolean" ? { pauseOnRepairFailure } : {}),
          ...(typeof retryBudget === "number" && Number.isFinite(retryBudget) ? { retryBudget } : {})
        });
      } else {
        const updated = updateMissionPolicy(session, mission.id, {
          ...(autonomyLevel ? { autonomyLevel } : {}),
          ...(typeof autopilotEnabled === "boolean" ? { autopilotEnabled } : {}),
          ...(typeof autoVerify === "boolean" ? { autoVerify } : {}),
          ...(typeof autoLand === "boolean" ? { autoLand } : {}),
          ...(typeof pauseOnRepairFailure === "boolean" ? { pauseOnRepairFailure } : {}),
          ...(typeof retryBudget === "number" && Number.isFinite(retryBudget) ? { retryBudget } : {})
        });
        if (!updated) {
          throw new Error(`Mission ${mission.id} was not found.`);
        }
        addDecisionRecord(session, {
          kind: "plan",
          agent: "router",
          taskId: updated.rootTaskId ?? updated.planningTaskId ?? null,
          summary: `Updated mission policy for ${updated.id}`,
          detail: `autonomy=${updated.policy?.autonomyLevel ?? "-"} | retry=${updated.policy?.retryBudget ?? "-"} | autoVerify=${updated.policy?.autoVerify ? "on" : "off"} | autoLand=${updated.policy?.autoLand ? "on" : "off"} | pauseOnRepairFailure=${updated.policy?.pauseOnRepairFailure ? "on" : "off"} | autopilot=${updated.autopilotEnabled ? "on" : "off"}`,
          metadata: {
            missionId: updated.id,
            policy: updated.policy ?? null,
            autopilotEnabled: updated.autopilotEnabled
          }
        });
        addMissionCheckpoint(session, updated.id, {
          kind: "task_progress",
          title: "Mission policy updated",
          detail: `autonomy=${updated.policy?.autonomyLevel ?? "-"} | retry=${updated.policy?.retryBudget ?? "-"} | autoVerify=${updated.policy?.autoVerify ? "on" : "off"} | autoLand=${updated.policy?.autoLand ? "on" : "off"} | pauseOnRepairFailure=${updated.policy?.pauseOnRepairFailure ? "on" : "off"} | autopilot=${updated.autopilotEnabled ? "on" : "off"}`,
          taskId: updated.rootTaskId ?? updated.planningTaskId ?? null
        });
        await saveSessionRecord(paths, session);
        await recordEvent(paths, session.id, "mission.policy_updated", {
          missionId: updated.id,
          policy: updated.policy ?? null,
          autopilotEnabled: updated.autopilotEnabled
        });
        await rpcNotifyExternalUpdate(paths).catch(() => {});
      }
    }

    const refreshedSession = isSessionLive(session) && (await pingRpc(paths))
      ? (await readSnapshot(paths)).session
      : (await loadSessionRecord(paths));
    const refreshedMission = refreshedSession.missions.find((item) => item.id === mission.id) ?? mission;
    const payload = {
      missionId: refreshedMission.id,
      autopilotEnabled: refreshedMission.autopilotEnabled,
      policy: refreshedMission.policy ?? null
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Mission policy: ${refreshedMission.id}`);
    console.log(`  autopilot: ${refreshedMission.autopilotEnabled ? "on" : "off"}`);
    console.log(`  autonomy: ${refreshedMission.policy?.autonomyLevel ?? "-"}`);
    console.log(`  approvals: ${refreshedMission.policy?.approvalMode ?? "-"}`);
    console.log(`  retry budget: ${refreshedMission.policy?.retryBudget ?? "-"}`);
    console.log(`  auto verify: ${refreshedMission.policy?.autoVerify ? "on" : "off"}`);
    console.log(`  auto land: ${refreshedMission.policy?.autoLand ? "on" : "off"}`);
    console.log(`  pause on repair failure: ${refreshedMission.policy?.pauseOnRepairFailure ? "on" : "off"}`);
    console.log(`  verification mode: ${refreshedMission.policy?.verificationMode ?? "-"}`);
    console.log(`  land policy: ${refreshedMission.policy?.landPolicy ?? "-"}`);
    console.log(`  gates: ${(refreshedMission.policy?.gatePolicy ?? []).join(", ") || "-"}`);
    return;
  }

  if (args[0] === "shadow") {
    const shadowArgs = args.slice(1);
    const { paths } = await requireSession(cwd);
    const rpcSnapshot = await tryRpcSnapshot(paths);
    const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
    await ensureMutableActionAllowed(paths, session, "Creating a shadow mission");
    const missionCandidates = session.missions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((mission) => mission.id);
    const sourceMissionId = resolveRequestedMissionId(
      [
        shadowArgs.find((arg, index) => !arg.startsWith("--") && shadowArgs[index - 1] !== "--prompt") ?? "latest"
      ],
      missionCandidates
    );
    const sourceMission = session.missions.find((item) => item.id === sourceMissionId) ?? null;
    if (!sourceMission) {
      throw new Error(`Mission ${sourceMissionId} was not found.`);
    }

    const prompt = getOptionalFilter(shadowArgs, "--prompt");
    if (!prompt?.trim()) {
      throw new Error("mission shadow requires --prompt.");
    }

    const shadowMissionPrompt = [
      sourceMission.prompt.trim(),
      `Alternative direction: ${prompt.trim()}`
    ].filter(Boolean).join("\n\n");

    const shadowPrompt = [
      `Create a shadow mission for ${sourceMission.title}.`,
      `Original mission summary: ${sourceMission.summary}`,
      sourceMission.blueprint?.productConcept
        ? `Original product concept: ${sourceMission.blueprint.productConcept}`
        : null,
      sourceMission.contract?.scenarios?.length
        ? `Original scenarios: ${sourceMission.contract.scenarios.join(" | ")}`
        : null,
      sourceMission.appliedPatternIds?.length
        ? `Applied patterns on the original mission: ${sourceMission.appliedPatternIds.join(", ")}`
        : null,
      `Alternative direction: ${prompt.trim()}`
    ].filter(Boolean).join("\n");

    const planningMode = hasFlag(shadowArgs, "--direct") ? "direct" : "plan";
    const planningDecision = decidePlanningMode(shadowMissionPrompt, session, planningMode);
    const routeDecision =
      planningDecision.usePlanner
        ? {
            owner: "codex" as const,
            strategy: "manual" as const,
            confidence: 1,
            reason: planningDecision.reason,
            claimedPaths: [] as string[],
            metadata: {
              planner: true,
              requestedPlanningMode: planningMode
            }
          }
        : await routeTask(shadowMissionPrompt, session, paths);

    const rpcParams = {
      owner: routeDecision.owner,
      title: `Shadow mission for ${sourceMission.title}`,
      prompt: shadowPrompt,
      planningMode,
      routeReason: routeDecision.reason,
      routeMetadata: {
        ...routeDecision.metadata,
        source: "mission-shadow",
        shadowOfMissionId: sourceMission.id,
        missionMode: hasFlag(shadowArgs, "--inspect") ? "inspect" : "guided_autopilot"
      },
      claimedPaths: routeDecision.claimedPaths,
      routeStrategy: routeDecision.strategy,
      routeConfidence: routeDecision.confidence,
      missionPrompt: shadowMissionPrompt,
      shadowOfMissionId: sourceMission.id,
      missionMode: hasFlag(shadowArgs, "--inspect") ? "inspect" : "guided_autopilot"
    };

    if (rpcSnapshot) {
      await rpcEnqueueTask(paths, rpcParams);
    } else {
      await appendCommand(paths, "enqueue", rpcParams);
    }

    const payload = {
      sourceMissionId: sourceMission.id,
      planningMode,
      owner: routeDecision.owner,
      prompt: shadowPrompt,
      missionPrompt: shadowMissionPrompt
    };
    if (shadowArgs.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Queued shadow mission from ${sourceMission.id} via ${routeDecision.owner}.`);
    console.log(`Route: ${routeDecision.reason}`);
    return;
  }

  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  syncMissionStates(session);
  const artifacts = await listTaskArtifacts(paths);
  const missionId = resolveRequestedMissionId(
    args,
    session.missions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((mission) => mission.id)
  );
  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    throw new Error(`Mission ${missionId} was not found.`);
  }
  const observability = buildMissionObservability(
    {
      session,
      approvals: [],
      events: [],
      worktreeDiffs: [],
      latestLandReport: null
    },
    artifacts,
    mission
  );

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      ...mission,
      selected: session.selectedMissionId === mission.id,
      observability,
      acceptanceExplanations: explainMissionAcceptanceFailures(mission)
    }, null, 2));
    return;
  }

  console.log(`Mission: ${mission.id}`);
  console.log(`Packet version: ${mission.packetVersion ?? 1}`);
  console.log(`Title: ${mission.title}`);
  console.log(`Mode: ${mission.mode}`);
  console.log(`Status: ${mission.status}`);
  console.log(`Shadow of: ${mission.shadowOfMissionId ?? "-"}`);
  console.log(`Selected: ${session.selectedMissionId === mission.id ? "yes" : "no"}`);
  console.log(`Summary: ${mission.summary}`);
  console.log(`Planning task: ${mission.planningTaskId ?? "-"}`);
  console.log(`Plan: ${mission.planId ?? "-"}`);
  if (mission.health) {
    console.log(`Health: ${mission.health.state} | score=${mission.health.score}`);
    if (mission.health.reasons.length > 0) {
      console.log(`Health reasons: ${mission.health.reasons.join(" | ")}`);
    }
  }
  if (mission.policy) {
    console.log(
      `Policy: autonomy=${mission.policy.autonomyLevel} | approvals=${mission.policy.approvalMode} | retry=${mission.policy.retryBudget} | verify=${mission.policy.verificationMode} | land=${mission.policy.landPolicy}`
    );
  }
  console.log(`Acceptance: ${mission.acceptance.status}`);
  if (mission.spec) {
    console.log(`Audience: ${mission.spec.audience ?? "-"}`);
    console.log(`Repo shape: ${mission.spec.repoShape}`);
    console.log(`Workstreams: ${mission.spec.workstreamKinds.join(", ") || "-"}`);
    console.log(`Stack hints: ${mission.spec.stackHints.join(", ") || "-"}`);
    console.log(`Deliverables: ${mission.spec.requestedDeliverables.join(", ") || "-"}`);
    console.log(`Roles: ${mission.spec.userRoles.join(", ") || "-"}`);
    console.log(`Entities: ${mission.spec.domainEntities.join(", ") || "-"}`);
    console.log(`Constraints: ${mission.spec.constraints.join(" | ") || "-"}`);
  }
  if (mission.contract) {
    console.log(`Scenarios: ${mission.contract.scenarios.join(" | ") || "-"}`);
    console.log(`Quality bars: ${mission.contract.qualityBars.join(" | ") || "-"}`);
    console.log(`Docs expectations: ${mission.contract.docsExpectations.join(" | ") || "-"}`);
  }
  if (mission.blueprint) {
    console.log("Blueprint:");
    console.log(`  overview: ${mission.blueprint.overview}`);
    console.log(`  product concept: ${mission.blueprint.productConcept}`);
    console.log(`  personas: ${mission.blueprint.personas.join(", ") || "-"}`);
    console.log(`  domain model: ${mission.blueprint.domainModel.join(", ") || "-"}`);
    console.log(`  service boundaries: ${mission.blueprint.serviceBoundaries.join(", ") || "-"}`);
    console.log(`  ui surfaces: ${mission.blueprint.uiSurfaces.join(", ") || "-"}`);
    console.log(`  journeys: ${mission.blueprint.acceptanceJourneys.join(" | ") || "-"}`);
    console.log(`  architecture notes: ${mission.blueprint.architectureNotes.join(" | ") || "-"}`);
  }
  console.log("Criteria:");
  for (const criterion of mission.acceptance.criteria) {
    console.log(`- ${criterion}`);
  }
  console.log("Checks:");
  for (const check of mission.acceptance.checks) {
    const explanation = check.status === "failed" ? explainAcceptanceFailure(check) : null;
    console.log(`- ${check.kind} | ${check.status} | ${check.title}`);
    console.log(`  target: ${check.target ?? "-"}`);
    console.log(`  url: ${check.urlPath ?? "-"}`);
    console.log(`  method: ${check.method ?? "-"}`);
    console.log(`  request body: ${check.requestBody ?? "-"}`);
    console.log(`  request headers: ${Object.keys(check.requestHeaders ?? {}).length > 0 ? JSON.stringify(check.requestHeaders) : "-"}`);
    console.log(`  route candidates: ${(check.routeCandidates ?? []).join(" | ") || "-"}`);
    console.log(`  selector: ${check.selector ?? "-"}`);
    console.log(`  selector candidates: ${(check.selectorCandidates ?? []).join(" | ") || "-"}`);
    console.log(`  expected title: ${check.expectedTitle ?? "-"}`);
    console.log(`  expected status: ${check.expectedStatus ?? "-"}`);
    console.log(`  expected content-type: ${check.expectedContentType ?? "-"}`);
    console.log(`  expected json keys: ${(check.expectedJsonKeys ?? []).join(" | ") || "-"}`);
    console.log(`  server: ${check.serverCommand ?? "-"}`);
    console.log(`  evidence: ${(check.evidencePaths ?? []).join(", ") || "-"}`);
    console.log(`  likely owners: ${(check.likelyOwners ?? []).join(", ") || "-"}`);
    console.log(`  likely tasks: ${(check.likelyTaskIds ?? []).join(", ") || "-"}`);
    console.log(`  attribution: ${check.likelyReason ?? "-"}`);
    if (explanation) {
      console.log(`  explanation: ${explanation.summary}`);
      console.log(`  repair focus: ${explanation.repairFocus.join(" | ") || "-"}`);
    }
    console.log(`  detail: ${check.detail}`);
  }
  if ((mission.risks ?? []).length > 0) {
    console.log("Risks:");
    for (const risk of mission.risks ?? []) {
      console.log(`- ${risk.severity} | ${risk.title}`);
      console.log(`  detail: ${risk.detail}`);
      console.log(`  mitigation: ${risk.mitigation}`);
    }
  }
  if ((mission.anchors ?? []).length > 0) {
    console.log("Anchors:");
    for (const anchor of mission.anchors ?? []) {
      console.log(`- ${anchor.kind} | ${anchor.title} | ${anchor.summary}`);
    }
  }
  if ((mission.appliedPatternIds ?? []).length > 0) {
    console.log(`Applied patterns: ${mission.appliedPatternIds.join(", ")}`);
  }
  console.log(`Active tasks: ${mission.activeTaskIds.join(", ") || "-"}`);
  if (observability) {
    console.log(
      `Runtime: tasks=${observability.completedTasks}/${observability.totalTasks} completed | running=${observability.runningTasks} | pending=${observability.pendingTasks} | blocked=${observability.blockedTasks} | failed=${observability.failedTasks}`
    );
    console.log(
      `Repair/Retry: active repairs=${observability.activeRepairTasks} | stalled=${observability.stalledTasks} | retries-used=${observability.retriesUsed} | retrying=${observability.retryingTasks}`
    );
    console.log(`Active owners: ${observability.activeOwners.join(", ") || "-"}`);
    console.log(`Changed paths: ${observability.changedPaths}`);
    console.log(`Critical path: ${observability.criticalPath.join(" -> ") || "-"}`);
    if (observability.nextReadyNodes.length > 0) {
      console.log("Next ready nodes:");
      for (const node of observability.nextReadyNodes) {
        console.log(`- ${node.owner} | ${node.key} | ${node.title}`);
      }
    }
    if (observability.latestFailure) {
      console.log(`Latest failure: ${observability.latestFailure.taskId} | ${observability.latestFailure.summary}`);
    }
    if (observability.latestProgress) {
      console.log(`Latest progress: ${observability.latestProgress.taskId} | ${observability.latestProgress.summary}`);
    }
    if (observability.recentProgress.length > 0) {
      console.log("Recent runtime activity:");
      for (const entry of observability.recentProgress.slice(0, 5)) {
        console.log(`- ${entry.kind} | ${entry.taskId} | ${entry.summary}`);
      }
    }
  }
  if (mission.checkpoints.length > 0) {
    console.log("Checkpoints:");
    for (const checkpoint of mission.checkpoints.slice(-8)) {
      console.log(`- ${checkpoint.createdAt} | ${checkpoint.title} | ${checkpoint.detail}`);
    }
  }
}

async function commandMissions(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  syncMissionStates(session);
  const payload = [...session.missions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.length === 0) {
    console.log("No missions recorded for this session.");
    return;
  }

  for (const mission of payload) {
    console.log(`${mission.id} | ${mission.status} | ${mission.mode}`);
    console.log(`  title: ${mission.title}`);
    console.log(`  selected: ${session.selectedMissionId === mission.id ? "yes" : "no"} | shadow of: ${mission.shadowOfMissionId ?? "-"}`);
    console.log(`  summary: ${mission.summary}`);
    console.log(`  plan: ${mission.planId ?? "-"} | active tasks: ${mission.activeTaskIds.join(", ") || "-"}`);
    console.log(`  acceptance: ${mission.acceptance.status}`);
  }
}

async function commandAccept(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  syncMissionStates(session);
  const missionId = resolveRequestedMissionId(
    args,
    session.missions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((mission) => mission.id)
  );
  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    throw new Error(`Mission ${missionId} was not found.`);
  }

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ...mission.acceptance,
          explanations: explainMissionAcceptanceFailures(mission)
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Mission: ${mission.title}`);
  console.log(`Acceptance: ${mission.acceptance.status}`);
  console.log(`Summary: ${mission.acceptance.summary}`);
  console.log("Criteria:");
  for (const criterion of mission.acceptance.criteria) {
    console.log(`- ${criterion}`);
  }
  console.log("Checks:");
  for (const check of mission.acceptance.checks) {
    const explanation = check.status === "failed" ? explainAcceptanceFailure(check) : null;
    console.log(`- ${check.kind} | ${check.status} | ${check.title}`);
    console.log(`  command: ${check.command ?? "-"}`);
    console.log(`  path: ${check.path ?? "-"}`);
    console.log(`  harness: ${check.harnessPath ?? "-"}`);
    console.log(`  server: ${check.serverCommand ?? "-"}`);
    console.log(`  target: ${check.target ?? "-"}`);
    console.log(`  url: ${check.urlPath ?? "-"}`);
    console.log(`  method: ${check.method ?? "-"}`);
    console.log(`  request body: ${check.requestBody ?? "-"}`);
    console.log(`  request headers: ${Object.keys(check.requestHeaders ?? {}).length > 0 ? JSON.stringify(check.requestHeaders) : "-"}`);
    console.log(`  route candidates: ${(check.routeCandidates ?? []).join(" | ") || "-"}`);
    console.log(`  selector: ${check.selector ?? "-"}`);
    console.log(`  selector candidates: ${(check.selectorCandidates ?? []).join(" | ") || "-"}`);
    console.log(`  expected title: ${check.expectedTitle ?? "-"}`);
    console.log(`  expected status: ${check.expectedStatus ?? "-"}`);
    console.log(`  expected content-type: ${check.expectedContentType ?? "-"}`);
    console.log(`  expected json keys: ${(check.expectedJsonKeys ?? []).join(" | ") || "-"}`);
    console.log(`  expected text: ${(check.expectedText ?? []).join(" | ") || "-"}`);
    console.log(`  evidence: ${(check.evidencePaths ?? []).join(", ") || "-"}`);
    console.log(`  likely owners: ${(check.likelyOwners ?? []).join(", ") || "-"}`);
    console.log(`  likely tasks: ${(check.likelyTaskIds ?? []).join(", ") || "-"}`);
    console.log(`  attribution: ${check.likelyReason ?? "-"}`);
    if (explanation) {
      console.log(`  explanation: ${explanation.summary}`);
      console.log(`  repair focus: ${explanation.repairFocus.join(" | ") || "-"}`);
    }
    console.log(`  detail: ${check.detail}`);
  }
}

async function commandVerify(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  syncMissionStates(session);
  const missionId = resolveRequestedMissionId(
    args,
    session.missions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((mission) => mission.id)
  );
  await ensureMutableActionAllowed(paths, session, "Verifying a mission");
  const mission = await verifyMissionAcceptanceById(paths, missionId);
  await notifyOperatorSurface(paths, "mission.acceptance_verified");
  if (!mission) {
    throw new Error(`Mission ${missionId} was not found after verification.`);
  }
  const refreshedSession = await loadSessionRecord(paths);
  const queuedRepairTasks = refreshedSession.tasks
    .filter((task) => task.missionId === mission.id && task.routeMetadata?.source === "acceptance-repair")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  if (args.includes("--json")) {
    const explanations = explainMissionAcceptanceFailures(mission);
    console.log(
      JSON.stringify(
        {
          acceptance: mission.acceptance,
          acceptanceExplanations: explanations,
          queuedRepairTask: queuedRepairTasks[0]
            ? {
                id: queuedRepairTasks[0].id,
                owner: queuedRepairTasks[0].owner,
                status: queuedRepairTasks[0].status,
                title: queuedRepairTasks[0].title,
                routeReason: queuedRepairTasks[0].routeReason,
                routeMetadata: queuedRepairTasks[0].routeMetadata
              }
            : null,
          queuedRepairTasks: queuedRepairTasks.map((task) => ({
            id: task.id,
            owner: task.owner,
            status: task.status,
            title: task.title,
            routeReason: task.routeReason,
            routeMetadata: task.routeMetadata
          }))
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Verified mission ${mission.id}`);
  console.log(`Acceptance: ${mission.acceptance.status}`);
  for (const check of mission.acceptance.checks) {
    const explanation = check.status === "failed" ? explainAcceptanceFailure(check) : null;
    console.log(`- ${check.kind} | ${check.status} | ${check.title}`);
    console.log(`  path: ${check.path ?? "-"}`);
    console.log(`  url: ${check.urlPath ?? "-"}`);
    console.log(`  method: ${check.method ?? "-"}`);
    console.log(`  request body: ${check.requestBody ?? "-"}`);
    console.log(`  request headers: ${Object.keys(check.requestHeaders ?? {}).length > 0 ? JSON.stringify(check.requestHeaders) : "-"}`);
    console.log(`  route candidates: ${(check.routeCandidates ?? []).join(" | ") || "-"}`);
    console.log(`  selector candidates: ${(check.selectorCandidates ?? []).join(" | ") || "-"}`);
    console.log(`  expected title: ${check.expectedTitle ?? "-"}`);
    console.log(`  expected status: ${check.expectedStatus ?? "-"}`);
    console.log(`  expected content-type: ${check.expectedContentType ?? "-"}`);
    console.log(`  expected json keys: ${(check.expectedJsonKeys ?? []).join(" | ") || "-"}`);
    console.log(`  likely owners: ${(check.likelyOwners ?? []).join(", ") || "-"}`);
    console.log(`  likely tasks: ${(check.likelyTaskIds ?? []).join(", ") || "-"}`);
    console.log(`  attribution: ${check.likelyReason ?? "-"}`);
    if (explanation) {
      console.log(`  explanation: ${explanation.summary}`);
      console.log(`  repair focus: ${explanation.repairFocus.join(" | ") || "-"}`);
    }
    console.log(`  detail: ${check.detail}`);
  }
  if (queuedRepairTasks.length > 0 && mission.acceptance.status === "failed") {
    for (const queuedRepairTask of queuedRepairTasks) {
      console.log(`Repair queued: ${queuedRepairTask.id} -> ${queuedRepairTask.owner}`);
      console.log(`  title: ${queuedRepairTask.title}`);
      if (queuedRepairTask.routeReason) {
        console.log(`  route: ${queuedRepairTask.routeReason}`);
      }
    }
  }
}

async function commandBrain(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  const graphEntryId = getOptionalFilter(args, "--entry");
  if (args.includes("--graph")) {
    const graph = buildBrainGraph(session, {
      entryId: graphEntryId,
      missionId: getOptionalFilter(args, "--mission"),
      path: getOptionalFilter(args, "--path"),
      includeRetired: args.includes("--retired"),
      limit: args.includes("--all") ? session.brain.length : 16
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(graph, null, 2));
      return;
    }

    if (graph.nodes.length === 0) {
      console.log("No project brain graph could be built yet.");
      return;
    }

    console.log(`Brain graph focus: ${graph.focusEntryId ?? "-"}`);
    console.log(`Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}`);
    const edgeKinds = [...new Set(graph.edges.map((edge) => edge.kind))];
    console.log(`Edge kinds: ${edgeKinds.join(", ") || "-"}`);
    console.log("");
    console.log("Nodes");
    for (const node of graph.nodes) {
      console.log(
        `- ${node.id} | ${node.title} | ${node.category ?? "artifact"} | ${node.scope ?? "-"} | pinned=${node.pinned ? "yes" : "no"} | retired=${node.retired ? "yes" : "no"}`
      );
    }
    console.log("");
    console.log("Edges");
    for (const edge of graph.edges) {
      console.log(`- ${edge.kind} | ${edge.from} -> ${edge.to} | ${edge.label}`);
    }
    return;
  }
  const explainId = getOptionalFilter(args, "--explain");
  if (explainId) {
    const payload = explainBrainEntry(session, explainId);
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (payload.length === 0) {
      throw new Error(`Brain entry ${explainId} was not found.`);
    }
    for (const line of payload) {
      console.log(line);
    }
    return;
  }
  const query = getOptionalFilter(args, "--query");
  const payload = queryBrainEntries(session, {
    query: query ?? "",
    path: getOptionalFilter(args, "--path"),
    category:
      getOptionalFilter(args, "--category") === "fact" ||
      getOptionalFilter(args, "--category") === "decision" ||
      getOptionalFilter(args, "--category") === "procedure" ||
      getOptionalFilter(args, "--category") === "risk" ||
      getOptionalFilter(args, "--category") === "artifact"
        ? (getOptionalFilter(args, "--category") as "fact" | "decision" | "procedure" | "risk" | "artifact")
        : "all",
    scope:
      getOptionalFilter(args, "--scope") === "repo" ||
      getOptionalFilter(args, "--scope") === "mission" ||
      getOptionalFilter(args, "--scope") === "personal" ||
      getOptionalFilter(args, "--scope") === "pattern"
        ? (getOptionalFilter(args, "--scope") as "repo" | "mission" | "personal" | "pattern")
        : "all",
    missionId: getOptionalFilter(args, "--mission"),
    includeRetired: args.includes("--retired"),
    limit: args.includes("--all") ? session.brain.length : 20
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.length === 0) {
    console.log("No project brain entries recorded yet.");
    return;
  }

  for (const entry of payload) {
    console.log(
      `${entry.id} | ${entry.sourceType}/${entry.category ?? "artifact"} | scope=${entry.scope ?? "-"} | pinned=${entry.pinned ? "yes" : "no"}`
    );
    console.log(`  title: ${entry.title}`);
    console.log(`  mission: ${entry.missionId ?? "-"} | task: ${entry.taskId ?? "-"}`);
    console.log(
      `  confidence: ${((entry.confidence ?? 0.6) * 100).toFixed(0)}% | freshness: ${entry.freshness ?? "-"} | retired: ${entry.retiredAt ?? "no"}`
    );
    console.log(`  superseded by: ${entry.supersededBy ?? "-"} | contradictions: ${(entry.contradictions ?? []).join(", ") || "-"}`);
    console.log(`  tags: ${entry.tags.join(", ") || "-"}`);
    console.log(`  evidence: ${(entry.evidence ?? []).join(", ") || "-"}`);
    console.log(`  commands: ${(entry.commands ?? []).join(" | ") || "-"}`);
    console.log(`  content: ${entry.content}`);
  }
}

async function commandBrainPinned(cwd: string, args: string[], pinned: boolean): Promise<void> {
  const entryId = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!entryId) {
    throw new Error(`brain-${pinned ? "pin" : "unpin"} requires an entry id.`);
  }

  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  const entry = session.brain.find((item) => item.id === entryId) ?? null;
  if (!entry) {
    throw new Error(`Brain entry ${entryId} was not found.`);
  }

  if (isSessionLive(session) && (await pingRpc(paths))) {
    await ensureMutableActionAllowed(paths, session, pinned ? "Pinning a brain entry" : "Unpinning a brain entry");
    await rpcSetBrainEntryPinned(paths, {
      entryId: entry.id,
      pinned
    });
  } else {
    const updated = setBrainEntryPinned(session, entryId, pinned);
    if (!updated) {
      throw new Error(`Brain entry ${entryId} was not found.`);
    }
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "brain.entry_pinned", {
      entryId: updated.id,
      pinned
    });
  }
  console.log(`${pinned ? "Pinned" : "Unpinned"} ${entry.id}`);
}

async function commandBrainRetire(cwd: string, args: string[]): Promise<void> {
  const entryId = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!entryId) {
    throw new Error("brain-retire requires an entry id.");
  }

  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  const entry = session.brain.find((item) => item.id === entryId) ?? null;
  if (!entry) {
    throw new Error(`Brain entry ${entryId} was not found.`);
  }

  if (isSessionLive(session) && (await pingRpc(paths))) {
    await ensureMutableActionAllowed(paths, session, "Retiring a brain entry");
    await rpcRetireBrainEntry(paths, {
      entryId: entry.id
    });
  } else {
    const updated = retireBrainEntry(session, entryId);
    if (!updated) {
      throw new Error(`Brain entry ${entryId} was not found.`);
    }
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "brain.entry_retired", {
      entryId: updated.id
    });
  }
  console.log(`Retired ${entry.id}`);
}

async function commandBrainMerge(cwd: string, args: string[]): Promise<void> {
  const [targetEntryId, sourceEntryId] = args.filter((arg) => !arg.startsWith("--"));
  if (!targetEntryId || !sourceEntryId) {
    throw new Error("brain-merge requires <target-entry-id> <source-entry-id>.");
  }

  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  const target = session.brain.find((item) => item.id === targetEntryId) ?? null;
  const source = session.brain.find((item) => item.id === sourceEntryId) ?? null;
  if (!target || !source) {
    throw new Error(`Unable to merge ${sourceEntryId} into ${targetEntryId}.`);
  }

  if (isSessionLive(session) && (await pingRpc(paths))) {
    await ensureMutableActionAllowed(paths, session, "Merging brain entries");
    await rpcMergeBrainEntries(paths, {
      targetEntryId,
      sourceEntryId
    });
  } else {
    const entry = mergeBrainEntries(session, targetEntryId, sourceEntryId);
    if (!entry) {
      throw new Error(`Unable to merge ${sourceEntryId} into ${targetEntryId}.`);
    }
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "brain.entry_merged", {
      targetEntryId,
      sourceEntryId
    });
  }
  console.log(`Merged ${sourceEntryId} into ${targetEntryId}`);
}

async function commandPatterns(cwd: string, args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0]?.startsWith("--") ? args[0] : null;
  const repoRoot = (await findRepoRoot(cwd)) ?? cwd;
  const paths = resolveAppPaths(repoRoot);

  if (subcommand === "constellation") {
    const payload = await buildPatternConstellation(paths);
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Patterns: ${payload.totalPatterns}`);
    console.log(`Templates: ${payload.totalTemplates}`);
    console.log(`Top stacks: ${payload.topStacks.map((item) => `${item.value} (${item.count})`).join(", ") || "-"}`);
    console.log(`Top node kinds: ${payload.topNodeKinds.map((item) => `${item.value} (${item.count})`).join(", ") || "-"}`);
    console.log(`Top commands: ${payload.topCommands.map((item) => `${item.value} (${item.count})`).join(" | ") || "-"}`);
    console.log(`Top tags: ${payload.topTags.map((item) => `${item.value} (${item.count})`).join(", ") || "-"}`);
    console.log(`Top repos: ${payload.topRepos.map((item) => `${item.value} (${item.count})`).join(", ") || "-"}`);
    console.log(`Architecture patterns: ${payload.architecturePatterns.length}`);
    console.log(`Delivery patterns: ${payload.deliveryPatterns.length}`);
    console.log(`Anti-patterns: ${payload.antiPatterns.length}`);
    if (payload.repoProfiles.length > 0) {
      console.log("Repo profiles:");
      for (const profile of payload.repoProfiles.slice(0, 6)) {
        console.log(
          `- ${profile.label}: patterns=${profile.patternCount} templates=${profile.templateCount} anti=${profile.antiPatternCount} delivery=${profile.deliveryPatternCount}`
        );
        console.log(`  stacks: ${profile.topStacks.join(", ") || "-"}`);
        console.log(`  node kinds: ${profile.topNodeKinds.join(", ") || "-"}`);
      }
    }
    if (payload.patternFamilies.length > 0) {
      console.log("Pattern families:");
      for (const family of payload.patternFamilies.slice(0, 6)) {
        console.log(`- ${family.label} (${family.count})`);
      }
    }
    if (payload.repoLinks.length > 0) {
      console.log("Repo links:");
      for (const link of payload.repoLinks.slice(0, 6)) {
        console.log(`- ${link.leftLabel} <-> ${link.rightLabel} | score=${link.score}`);
        console.log(`  stacks: ${link.sharedStacks.join(", ") || "-"}`);
        console.log(`  nodes: ${link.sharedNodeKinds.join(", ") || "-"}`);
        console.log(`  commands: ${link.sharedCommands.join(" | ") || "-"}`);
      }
    }
    if (payload.repoClusters.length > 0) {
      console.log("Repo clusters:");
      for (const cluster of payload.repoClusters.slice(0, 6)) {
        console.log(`- ${cluster.labels.join(" + ")} | score=${cluster.score}`);
        console.log(`  stacks: ${cluster.stacks.join(", ") || "-"}`);
        console.log(`  nodes: ${cluster.nodeKinds.join(", ") || "-"}`);
      }
    }
    if (payload.templates.length > 0) {
      console.log("Portfolio templates:");
      for (const template of payload.templates.slice(0, 6)) {
        console.log(`- ${template.label} (${template.patternIds.length} patterns)`);
      }
    }
    if (payload.templateLinks.length > 0) {
      console.log("Template links:");
      for (const link of payload.templateLinks.slice(0, 6)) {
        console.log(`- ${link.leftLabel} <-> ${link.rightLabel} | score=${link.score}`);
        console.log(`  stacks: ${link.sharedStacks.join(", ") || "-"}`);
        console.log(`  nodes: ${link.sharedNodeKinds.join(", ") || "-"}`);
        console.log(`  acceptance: ${link.sharedAcceptance.join(" | ") || "-"}`);
      }
    }
    if (payload.antiPatternHotspots.length > 0) {
      console.log(`Anti-pattern hotspots: ${payload.antiPatternHotspots.map((item) => `${item.value} (${item.count})`).join(" | ")}`);
    }
    for (const entry of payload.antiPatterns.slice(0, 5)) {
      console.log(`- anti-pattern | ${entry.title}`);
      console.log(`  signals: ${(entry.antiPatternSignals ?? []).join(" | ") || "-"}`);
      console.log(`  summary: ${entry.summary}`);
    }
    return;
  }

  if (subcommand === "graph") {
    const payload = await buildPatternConstellation(paths);
    const graph = {
      repos: payload.repoProfiles.map((profile) => ({
        id: profile.repoRoot,
        label: profile.label,
        patternCount: profile.patternCount,
        templateCount: profile.templateCount,
        topStacks: profile.topStacks,
        topNodeKinds: profile.topNodeKinds
      })),
      repoLinks: payload.repoLinks,
      repoClusters: payload.repoClusters,
      templateLinks: payload.templateLinks
    };

    if (args.includes("--json")) {
      console.log(JSON.stringify(graph, null, 2));
      return;
    }

    console.log(`Portfolio repos: ${graph.repos.length}`);
    console.log(`Repo links: ${graph.repoLinks.length}`);
    console.log(`Repo clusters: ${graph.repoClusters.length}`);
    console.log(`Template links: ${graph.templateLinks.length}`);
    if (graph.repoLinks.length > 0) {
      console.log("Strongest repo links:");
      for (const link of graph.repoLinks.slice(0, 8)) {
        console.log(`- ${link.leftLabel} <-> ${link.rightLabel} | score=${link.score}`);
        console.log(`  stacks: ${link.sharedStacks.join(", ") || "-"}`);
        console.log(`  nodes: ${link.sharedNodeKinds.join(", ") || "-"}`);
      }
    }
    if (graph.repoClusters.length > 0) {
      console.log("Repo clusters:");
      for (const cluster of graph.repoClusters.slice(0, 8)) {
        console.log(`- ${cluster.labels.join(" + ")} | score=${cluster.score}`);
        console.log(`  roots: ${cluster.repoRoots.join(" | ")}`);
      }
    }
    if (graph.templateLinks.length > 0) {
      console.log("Template links:");
      for (const link of graph.templateLinks.slice(0, 8)) {
        console.log(`- ${link.leftLabel} <-> ${link.rightLabel} | score=${link.score}`);
        console.log(`  shared repos: ${link.sharedRepos.join(" | ") || "-"}`);
        console.log(`  shared acceptance: ${link.sharedAcceptance.join(" | ") || "-"}`);
      }
    }
    return;
  }

  if (subcommand === "templates") {
    const query = getOptionalFilter(args, "--query");
    const payload = query
      ? await rankPatternTemplates(paths, query, hasFlag(args, "--all") ? 20 : 8)
      : (await buildPatternTemplates(paths)).slice(0, hasFlag(args, "--all") ? Number.MAX_SAFE_INTEGER : 12);
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (payload.length === 0) {
      console.log("No portfolio templates recorded yet.");
      return;
    }
    if (query) {
      for (const item of payload) {
        console.log(`${item.template.id} | score=${item.score} | ${item.template.label}`);
        console.log(`  repos: ${item.template.repoRoots.join(", ") || "-"}`);
        console.log(`  patterns: ${item.template.patternIds.length} | reasons: ${item.reasons.join(", ") || "-"}`);
        console.log(`  stack: ${item.template.stacks.join(", ") || "-"}`);
        console.log(`  nodes: ${item.template.nodeKinds.join(", ") || "-"}`);
        console.log(`  acceptance defaults: ${item.template.acceptanceCriteria.join(" | ") || "-"}`);
      }
      return;
    }
    for (const template of payload) {
      console.log(`${template.id} | ${template.label}`);
      console.log(`  kind: ${template.kind} | confidence: ${(template.confidence * 100).toFixed(0)}%`);
      console.log(`  repos: ${template.repoRoots.join(", ") || "-"}`);
      console.log(`  stack: ${template.stacks.join(", ") || "-"}`);
      console.log(`  node kinds: ${template.nodeKinds.join(", ") || "-"}`);
      console.log(`  commands: ${template.commands.join(" | ") || "-"}`);
      console.log(`  acceptance defaults: ${template.acceptanceCriteria.join(" | ") || "-"}`);
      console.log(`  anti-pattern signals: ${template.antiPatternSignals.join(" | ") || "-"}`);
    }
    return;
  }

  if (subcommand === "rank") {
    const prompt = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!prompt) {
      throw new Error("patterns rank requires a prompt query.");
    }
    const payload = await rankPatterns(paths, prompt, hasFlag(args, "--all") ? 20 : 8);
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (payload.length === 0) {
      console.log("No matching patterns.");
      return;
    }
    for (const item of payload) {
      console.log(`${item.entry.id} | score=${item.score} | ${item.entry.title}`);
      console.log(`  kind: ${item.entry.kind ?? "architecture"} | reasons: ${item.reasons.join(", ") || "-"}`);
      console.log(`  stack: ${(item.entry.stackSignals ?? []).join(", ") || "-"}`);
      console.log(`  nodes: ${(item.entry.nodeKinds ?? []).join(", ") || "-"}`);
      console.log(`  summary: ${item.entry.summary}`);
    }
    return;
  }

  if (subcommand === "apply") {
    const patternId = args[1] && !args[1].startsWith("--") ? args[1] : "";
    if (!patternId) {
      throw new Error("patterns apply requires a pattern id.");
    }
    const prompt = getOptionalFilter(args, "--prompt");
    if (!prompt?.trim()) {
      throw new Error("patterns apply requires --prompt.");
    }
    const patterns = await listPatterns(paths);
    const pattern = patterns.find((entry) => entry.id === patternId) ?? null;
    if (!pattern) {
      throw new Error(`Pattern ${patternId} was not found.`);
    }
    const payload = {
      patternId: pattern.id,
      title: pattern.title,
      composedPrompt: buildPatternAppliedPrompt(pattern, prompt),
      stackSignals: pattern.stackSignals ?? [],
      nodeKinds: pattern.nodeKinds ?? [],
      acceptanceCriteria: pattern.acceptanceCriteria ?? []
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Pattern: ${pattern.title}`);
    console.log(`Kind: ${pattern.kind ?? "architecture"}`);
    console.log("Composed prompt:");
    console.log(payload.composedPrompt);
    return;
  }

  if (subcommand === "template-apply") {
    const templateId = args[1] && !args[1].startsWith("--") ? args[1] : "";
    if (!templateId) {
      throw new Error("patterns template-apply requires a template id.");
    }
    const prompt = getOptionalFilter(args, "--prompt");
    if (!prompt?.trim()) {
      throw new Error("patterns template-apply requires --prompt.");
    }
    const templates = await buildPatternTemplates(paths);
    const template = templates.find((entry) => entry.id === templateId) ?? null;
    if (!template) {
      throw new Error(`Template ${templateId} was not found.`);
    }
    const payload = {
      templateId: template.id,
      label: template.label,
      composedPrompt: buildPatternTemplatePrompt(template, prompt),
      stacks: template.stacks,
      nodeKinds: template.nodeKinds,
      acceptanceCriteria: template.acceptanceCriteria
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Template: ${template.label}`);
    console.log("Composed prompt:");
    console.log(payload.composedPrompt);
    return;
  }

  const query = getOptionalFilter(args, "--query");
  const payload = query
    ? await searchPatterns(paths, query, args.includes("--all") ? 50 : 12)
    : (await listPatterns(paths)).slice(0, args.includes("--all") ? Number.MAX_SAFE_INTEGER : 20);

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.length === 0) {
    console.log("No personal patterns recorded yet.");
    return;
  }

  for (const entry of payload) {
    console.log(`${entry.id} | ${entry.title}`);
    console.log(`  repo: ${entry.sourceRepoRoot}`);
    console.log(`  kind: ${entry.kind ?? "architecture"} | confidence: ${((entry.confidence ?? 0.65) * 100).toFixed(0)}% | used=${entry.usageCount ?? 1}`);
    console.log(`  tags: ${entry.tags.join(", ") || "-"}`);
    console.log(`  stack: ${(entry.stackSignals ?? []).join(", ") || "-"}`);
    console.log(`  node kinds: ${(entry.nodeKinds ?? []).join(", ") || "-"}`);
    console.log(`  acceptance defaults: ${(entry.acceptanceCriteria ?? []).join(" | ") || "-"}`);
    console.log(`  anti-pattern signals: ${(entry.antiPatternSignals ?? []).join(" | ") || "-"}`);
    console.log(`  example paths: ${entry.examplePaths.join(", ") || "-"}`);
    console.log(`  commands: ${entry.commands.join(" | ") || "-"}`);
    console.log(`  summary: ${entry.summary}`);
  }
}

async function commandPlayback(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  syncMissionStates(session);
  const artifacts = await listTaskArtifacts(paths);
  const latestReport = await loadLatestLandReport(paths);
  const missionId = resolveRequestedMissionId(
    args,
    session.missions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((mission) => mission.id)
  );
  const frames = buildMissionPlayback(session, artifacts, missionId, latestReport);
  if (args.includes("--json")) {
    console.log(JSON.stringify(frames, null, 2));
    return;
  }
  if (frames.length === 0) {
    console.log("No mission playback is available.");
    return;
  }
  for (const frame of frames) {
    console.log(`${frame.timestamp} | ${frame.kind} | ${frame.title}`);
    console.log(`  ${frame.detail}`);
  }
}

async function commandPlan(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const snapshot = await loadSnapshot(paths, 120);
  const plan = currentExecutionPlan(snapshot.session);

  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (!plan) {
    console.log("No active execution plan.");
    return;
  }

  console.log(`Plan: ${plan.title}`);
  console.log(`Status: ${plan.status}`);
  console.log(`Mission: ${plan.missionId ?? "-"}`);
  console.log(`Planner task: ${plan.plannerTaskId}`);
  console.log(`Summary: ${plan.summary}`);
  console.log(`Source prompt: ${plan.sourcePrompt}`);
  console.log("Nodes:");
  for (const node of plan.nodes) {
    console.log(
      `- ${node.key} | ${node.owner} | ${node.status} | ${node.executionMode}${node.dependsOn.length ? ` | depends=${node.dependsOn.join(", ")}` : ""} | ${node.title}`
    );
    if (node.claimedPaths.length > 0) {
      console.log(`  paths: ${node.claimedPaths.join(", ")}`);
    }
    if (node.taskId) {
      console.log(`  task: ${node.taskId}`);
    }
  }
}

async function commandActivity(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const limitArg = getFlag(args, "--limit");
  const limit = limitArg ? Number(limitArg) : 30;
  const snapshot = await loadSnapshot(paths, Math.max(50, Number.isFinite(limit) ? limit : 30));
  const artifacts = await listTaskArtifacts(paths);
  const activity = buildWorkflowActivity(
    snapshot,
    artifacts,
    Math.max(1, Number.isFinite(limit) ? limit : 30)
  );

  if (args.includes("--json")) {
    console.log(JSON.stringify(activity, null, 2));
    return;
  }

  for (const entry of activity) {
    console.log(`${entry.timestamp} ${entry.title}`);
    console.log(`  ${entry.detail}`);
  }
}

async function commandRoute(cwd: string, args: string[]): Promise<void> {
  const prompt = getGoal(args);
  if (!prompt) {
    throw new Error("A route preview prompt is required. Example: kavi route \"Refactor src/ui/App.tsx\"");
  }

  const repoRoot = (await findRepoRoot(cwd)) ?? cwd;
  const paths = resolveAppPaths(repoRoot);
  const allowAi = !args.includes("--no-ai");
  const hasSession = await sessionExists(paths);
  const session = hasSession ? await loadSessionRecord(paths) : null;
  const config = session?.config ?? (await loadConfig(paths));
  const planningDecision = session
    ? decidePlanningMode(prompt, session, hasFlag(args, "--plan") ? "plan" : hasFlag(args, "--direct") ? "direct" : "auto")
    : null;
  const routeDecision =
    planningDecision?.usePlanner
      ? {
          owner: "codex" as const,
          strategy: "manual" as const,
          confidence: 1,
          reason: planningDecision.reason,
          claimedPaths: [] as string[],
          metadata: {
            planner: true
          }
        }
      : allowAi && session
      ? await routeTask(prompt, session, paths)
      : previewRouteDecision(prompt, config, session);
  const payload = {
    prompt,
    mode: allowAi && session ? "live" : "preview",
    planning: planningDecision,
    route: routeDecision
  };

  if (session) {
    await recordEvent(paths, session.id, "route.previewed", {
      prompt,
      mode: payload.mode,
      owner: routeDecision.owner,
      strategy: routeDecision.strategy,
      confidence: routeDecision.confidence,
      claimedPaths: routeDecision.claimedPaths
    });
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Mode: ${payload.mode}`);
  console.log(`Owner: ${routeDecision.owner}`);
  console.log(`Strategy: ${routeDecision.strategy}`);
  console.log(`Confidence: ${routeDecision.confidence.toFixed(2)}`);
  if (planningDecision) {
    console.log(`Planning: ${planningDecision.usePlanner ? "planner" : "direct"} | ${planningDecision.reason}`);
  }
  console.log(`Reason: ${routeDecision.reason}`);
  console.log(`Claimed paths: ${routeDecision.claimedPaths.join(", ") || "-"}`);
  if (Object.keys(routeDecision.metadata).length > 0) {
    console.log(`Metadata: ${JSON.stringify(routeDecision.metadata)}`);
  }
}

async function commandRoutes(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const limitArg = getFlag(args, "--limit");
  const limit = limitArg ? Number(limitArg) : 20;
  const routes = [...session.tasks]
    .filter((task) => task.routeStrategy !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, Number.isFinite(limit) ? limit : 20))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      owner: task.owner,
      status: task.status,
      updatedAt: task.updatedAt,
      routeStrategy: task.routeStrategy,
      routeConfidence: task.routeConfidence,
      routeReason: task.routeReason,
      routeMetadata: task.routeMetadata,
      claimedPaths: task.claimedPaths
    }));

  if (args.includes("--json")) {
    console.log(JSON.stringify(routes, null, 2));
    return;
  }

  if (routes.length === 0) {
    console.log("No routed tasks recorded.");
    return;
  }

  for (const route of routes) {
    console.log(
      `${route.taskId} | ${route.owner} | ${route.status} | ${route.routeStrategy ?? "-"}${route.routeConfidence === null ? "" : ` (${route.routeConfidence.toFixed(2)})`}`
    );
    console.log(`  title: ${route.title}`);
    console.log(`  updated: ${route.updatedAt}`);
    console.log(`  reason: ${route.routeReason ?? "-"}`);
    console.log(`  paths: ${route.claimedPaths.join(", ") || "-"}`);
    if (Object.keys(route.routeMetadata).length > 0) {
      console.log(`  metadata: ${JSON.stringify(route.routeMetadata)}`);
    }
  }
}

async function commandRecommend(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const kind = parseRecommendationKind(getOptionalFilter(args, "--kind"));
  const status = parseRecommendationStatus(getOptionalFilter(args, "--status"));
  const targetAgent = getOptionalFilter(args, "--agent");
  if (
    targetAgent &&
    targetAgent !== "codex" &&
    targetAgent !== "claude" &&
    targetAgent !== "operator" &&
    targetAgent !== "all"
  ) {
    throw new Error(`Unsupported recommendation agent "${targetAgent}".`);
  }

  const recommendations = buildOperatorRecommendations(session, {
    includeDismissed: args.includes("--all") || status === "dismissed" || status === "all",
    kind: kind ?? undefined,
    status: status ?? undefined,
    targetAgent: targetAgent ?? undefined
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(recommendations, null, 2));
    return;
  }

  if (recommendations.length === 0) {
    console.log("No operator recommendations right now.");
    return;
  }

  for (const recommendation of recommendations) {
    console.log(
      `${recommendation.id} | ${recommendation.status} | ${recommendation.kind} | ${recommendation.targetAgent ?? "-"}`
    );
    console.log(`  title: ${recommendation.title}`);
    console.log(`  detail: ${recommendation.detail}`);
    console.log(`  open follow-ups: ${recommendation.openFollowUpTaskIds.join(", ") || "-"}`);
    if (recommendation.dismissedReason) {
      console.log(`  dismissed reason: ${recommendation.dismissedReason}`);
    }
    console.log(`  command: ${recommendation.commandHint}`);
  }
}

async function commandRecommendApply(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  await ensureMutableActionAllowed(paths, session, "Applying a recommendation");
  const recommendationId = args.find((arg) => !arg.startsWith("--"));
  if (!recommendationId) {
    throw new Error("A recommendation id is required. Example: kavi recommend-apply integration:src/ui/App.tsx");
  }
  const plan = buildRecommendationActionPlan(session, recommendationId, {
    force: args.includes("--force")
  });

  if (rpcSnapshot) {
    await rpcEnqueueTask(paths, {
      owner: plan.owner,
      prompt: plan.prompt,
      planningMode: "direct",
      routeReason: plan.routeReason,
      routeMetadata: plan.routeMetadata,
      claimedPaths: plan.claimedPaths,
      routeStrategy: plan.routeStrategy,
      routeConfidence: plan.routeConfidence,
      recommendationId: plan.recommendation.id,
      recommendationKind: plan.recommendation.kind
    });
  } else {
    await appendCommand(paths, "enqueue", {
      owner: plan.owner,
      prompt: plan.prompt,
      planningMode: "direct",
      routeReason: plan.routeReason,
      routeMetadata: plan.routeMetadata,
      claimedPaths: plan.claimedPaths,
      routeStrategy: plan.routeStrategy,
      routeConfidence: plan.routeConfidence,
      recommendationId: plan.recommendation.id,
      recommendationKind: plan.recommendation.kind
    });
  }
  console.log(`Queued ${plan.owner} task from recommendation ${plan.recommendation.id}.`);
}

async function commandRecommendDismiss(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const recommendationId = args.find((arg) => !arg.startsWith("--"));
  if (!recommendationId) {
    throw new Error("A recommendation id is required. Example: kavi recommend-dismiss integration:src/ui");
  }

  const reason = getOptionalFilter(args, "--reason");
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  await ensureMutableActionAllowed(paths, session, "Dismissing a recommendation");
  const recommendation = dismissOperatorRecommendation(session, recommendationId, reason);

  if (rpcSnapshot) {
    await rpcDismissRecommendation(paths, {
      recommendationId,
      reason
    });
  } else {
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "recommendation.dismissed", {
      recommendationId,
      reason
    });
    await notifyOperatorSurface(paths, "recommendation.dismissed");
  }
  console.log(`Dismissed recommendation ${recommendation.id}.`);
}

async function commandRecommendRestore(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const recommendationId = args.find((arg) => !arg.startsWith("--"));
  if (!recommendationId) {
    throw new Error("A recommendation id is required. Example: kavi recommend-restore integration:src/ui");
  }

  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  await ensureMutableActionAllowed(paths, session, "Restoring a recommendation");
  const recommendation = restoreOperatorRecommendation(session, recommendationId);

  if (rpcSnapshot) {
    await rpcRestoreRecommendation(paths, {
      recommendationId
    });
  } else {
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "recommendation.restored", {
      recommendationId
    });
    await notifyOperatorSurface(paths, "recommendation.restored");
  }
  console.log(`Restored recommendation ${recommendation.id}.`);
}

async function commandPaths(cwd: string, args: string[]): Promise<void> {
  const repoRoot = (await findRepoRoot(cwd)) ?? cwd;
  const paths = resolveAppPaths(repoRoot);
  const runtime = await resolveSessionRuntime(paths);
  const payload = {
    repoRoot,
    kaviDir: paths.kaviDir,
    configFile: paths.configFile,
    homeConfigFile: paths.homeConfigFile,
    homeStateDir: paths.homeStateDir,
    worktreeRoot: paths.worktreeRoot,
    integrationRoot: paths.integrationRoot,
    stateFile: paths.stateFile,
    eventsFile: paths.eventsFile,
    reportsDir: paths.reportsDir,
    approvalsFile: paths.approvalsFile,
    commandsFile: paths.commandsFile,
    socketPath: paths.socketPath,
    runsDir: paths.runsDir,
    claudeSettingsFile: paths.claudeSettingsFile,
    homeApprovalRulesFile: paths.homeApprovalRulesFile,
    runtime
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Repo: ${payload.repoRoot}`);
  console.log(`Kavi dir: ${payload.kaviDir}`);
  console.log(`Repo config: ${payload.configFile}`);
  console.log(`Home config: ${payload.homeConfigFile}`);
  console.log(`Home state: ${payload.homeStateDir}`);
  console.log(`Worktrees: ${payload.worktreeRoot}`);
  console.log(`Integration: ${payload.integrationRoot}`);
  console.log(`State file: ${payload.stateFile}`);
  console.log(`Events file: ${payload.eventsFile}`);
  console.log(`Reports: ${payload.reportsDir}`);
  console.log(`Approvals file: ${payload.approvalsFile}`);
  console.log(`Command queue: ${payload.commandsFile}`);
  console.log(`Control socket: ${payload.socketPath}`);
  console.log(`Task artifacts: ${payload.runsDir}`);
  console.log(`Claude settings: ${payload.claudeSettingsFile}`);
  console.log(`Approval rules: ${payload.homeApprovalRulesFile}`);
  console.log(
    `Runtime: node=${runtime.nodeExecutable} codex=${runtime.codexExecutable} claude=${runtime.claudeExecutable}`
  );
}

async function commandTask(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  await ensureMutableActionAllowed(paths, session, "Queueing a task");
  const requestedAgent = getFlag(args, "--agent");
  const planningMode = hasFlag(args, "--plan")
    ? "plan"
    : hasFlag(args, "--direct")
      ? "direct"
      : "auto";
  const missionMode = hasFlag(args, "--inspect")
    ? "inspect"
    : hasFlag(args, "--manual")
      ? "manual"
      : "guided_autopilot";
  const missionAutonomyLevel = hasFlag(args, "--overnight")
    ? "overnight"
    : hasFlag(args, "--autonomous")
      ? "autonomous"
      : hasFlag(args, "--guided")
        ? "guided"
        : hasFlag(args, "--mission-inspect")
          ? "inspect"
          : undefined;
  const autoVerify = parseToggleValue(getOptionalFilter(args, "--auto-verify"), "--auto-verify") ??
    (hasFlag(args, "--auto-verify")
      ? true
      : hasFlag(args, "--no-auto-verify")
        ? false
        : undefined);
  const autoLand = parseToggleValue(getOptionalFilter(args, "--auto-land"), "--auto-land") ??
    (hasFlag(args, "--auto-land")
      ? true
      : hasFlag(args, "--no-auto-land")
        ? false
        : undefined);
  const prompt = getGoal(
    args.filter((arg, index) =>
      arg !== "--agent" &&
      args[index - 1] !== "--agent" &&
      arg !== "--plan" &&
      arg !== "--direct" &&
      arg !== "--inspect" &&
      arg !== "--manual" &&
      arg !== "--guided" &&
      arg !== "--autonomous" &&
      arg !== "--overnight" &&
      arg !== "--mission-inspect" &&
      arg !== "--auto-verify" &&
      args[index - 1] !== "--auto-verify" &&
      arg !== "--no-auto-verify" &&
      arg !== "--auto-land" &&
      args[index - 1] !== "--auto-land" &&
      arg !== "--no-auto-land"
    )
  );

  if (!prompt) {
    throw new Error("A task prompt is required. Example: kavi task --agent auto \"Build auth route\"");
  }

  const planningDecision = decidePlanningMode(prompt, session, planningMode);
  const routeDecision =
    planningDecision.usePlanner
      ? {
          owner: "codex" as const,
          strategy: "manual" as const,
          confidence: 1,
          reason: planningDecision.reason,
          claimedPaths: [] as string[],
          metadata: {
            planner: true,
            requestedPlanningMode: planningMode
          }
        }
      : requestedAgent === "codex" || requestedAgent === "claude"
        ? {
            owner: requestedAgent,
            strategy: "manual" as const,
            confidence: 1,
            reason: `User explicitly assigned the task to ${requestedAgent}.`,
            claimedPaths: extractPromptPathHints(prompt),
            metadata: {
              manualAssignment: true,
              requestedAgent
            }
          }
        : await routeTask(prompt, session, paths);

  if (rpcSnapshot) {
    await rpcEnqueueTask(paths, {
      owner: routeDecision.owner,
      prompt,
      planningMode,
      routeReason: routeDecision.reason,
      routeMetadata: routeDecision.metadata,
      claimedPaths: routeDecision.claimedPaths,
      routeStrategy: routeDecision.strategy,
      routeConfidence: routeDecision.confidence,
      missionMode,
      ...(missionAutonomyLevel ? { missionAutonomyLevel } : {}),
      ...(typeof autoVerify === "boolean" ? { autoVerify } : {}),
      ...(typeof autoLand === "boolean" ? { autoLand } : {})
    });
  } else {
    await appendCommand(paths, "enqueue", {
      owner: routeDecision.owner,
      prompt,
      planningMode,
      routeReason: routeDecision.reason,
      routeMetadata: routeDecision.metadata,
      claimedPaths: routeDecision.claimedPaths,
      routeStrategy: routeDecision.strategy,
      routeConfidence: routeDecision.confidence,
      missionMode,
      ...(missionAutonomyLevel ? { missionAutonomyLevel } : {}),
      ...(typeof autoVerify === "boolean" ? { autoVerify } : {}),
      ...(typeof autoLand === "boolean" ? { autoLand } : {})
    });
  }
  await recordEvent(paths, session.id, "task.cli_enqueued", {
    owner: routeDecision.owner,
    prompt,
    planningMode,
    strategy: routeDecision.strategy,
    confidence: routeDecision.confidence,
    claimedPaths: routeDecision.claimedPaths,
    routeMetadata: routeDecision.metadata
  });
  console.log(
    `${planningDecision.usePlanner ? "Queued orchestration planner" : `Queued task for ${routeDecision.owner}`}: ${prompt}\nRoute: ${routeDecision.strategy} (${routeDecision.confidence.toFixed(2)}) ${routeDecision.reason}`
  );
}

async function commandRetry(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  await ensureMutableActionAllowed(paths, session, "Retrying a task");
  const retryableTaskIds = session.tasks
    .filter((task) => task.status === "failed" || task.status === "blocked")
    .map((task) => task.id);
  if (args.filter((arg) => !arg.startsWith("--")).length === 0 && retryableTaskIds.length === 0) {
    throw new Error("No failed or blocked tasks are available to retry.");
  }

  const taskId = resolveRequestedTaskId(args, retryableTaskIds);
  const task = session.tasks.find((item) => item.id === taskId) ?? null;
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  if (task.status !== "failed" && task.status !== "blocked") {
    throw new Error(`Task ${task.id} is ${task.status} and cannot be retried.`);
  }

  if (rpcSnapshot) {
    await rpcRetryTask(paths, task.id);
  } else {
    markTaskForManualRetry(task);
    addDecisionRecord(session, {
      kind: "task",
      agent: task.owner === "claude" ? "claude" : "codex",
      taskId: task.id,
      summary: `Queued manual retry for ${task.title}`,
      detail: "Operator reset the task for another execution attempt.",
      metadata: {
        missionId: task.missionId,
        nodeKind: task.nodeKind,
        maxRetries: task.maxRetries
      }
    });
    addMissionCheckpoint(session, task.missionId, {
      kind: "task_recovered",
      title: "Task manually retried",
      detail: `Operator reset ${task.title} for another attempt.`,
      taskId: task.id
    });
    const artifact = await loadTaskArtifact(paths, task.id);
    if (artifact) {
      artifact.status = "pending";
      artifact.retryCount = task.retryCount;
      artifact.lastFailureSummary = null;
      artifact.summary = task.summary;
      await saveTaskArtifact(paths, artifact);
    }
    syncMissionStates(session);
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "task.retry_queued", {
      taskId: task.id,
      owner: task.owner,
      missionId: task.missionId,
      nodeKind: task.nodeKind
    });
    await notifyOperatorSurface(paths, "task.retry_queued");
  }

  console.log(`Queued manual retry for ${task.id}: ${task.title}`);
}

async function commandTasks(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const artifacts = await listTaskArtifacts(paths);
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.taskId, artifact]));
  const activeMissionId = latestMission(session)?.id ?? null;
  const sortedTasks = [...session.tasks].sort((left, right) => {
    const leftActive = left.missionId && left.missionId === activeMissionId ? 1 : 0;
    const rightActive = right.missionId && right.missionId === activeMissionId ? 1 : 0;
    return rightActive - leftActive || right.updatedAt.localeCompare(left.updatedAt);
  });
  const payload = sortedTasks.map((task) => ({
    id: task.id,
    missionId: task.missionId,
    title: task.title,
    owner: task.owner,
    kind: task.kind,
    nodeKind: task.nodeKind,
    status: task.status,
    retryCount: task.retryCount,
    maxRetries: task.maxRetries,
    lastFailureSummary: task.lastFailureSummary,
    lease: task.lease,
    dependsOnTaskIds: task.dependsOnTaskIds,
    parentTaskId: task.parentTaskId,
    planId: task.planId,
    planNodeKey: task.planNodeKey,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    summary: task.summary,
    routeReason: task.routeReason,
    routeStrategy: task.routeStrategy,
    routeConfidence: task.routeConfidence,
    routeMetadata: task.routeMetadata,
    claimedPaths: task.claimedPaths,
    hasArtifact: artifactMap.has(task.id)
  }));

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  for (const task of payload) {
    console.log(
      `${task.id} | ${task.owner} | ${task.status} | artifact=${task.hasArtifact ? "yes" : "no"}`
    );
    console.log(`  title: ${task.title}`);
    console.log(`  kind: ${task.kind}${task.nodeKind ? ` | node=${task.nodeKind}` : ""}`);
    console.log(`  mission: ${task.missionId ?? "-"}`);
    console.log(`  retries: ${task.retryCount}/${task.maxRetries}`);
    if (task.lastFailureSummary) {
      console.log(`  last-failure: ${task.lastFailureSummary}`);
    }
    if (task.lease) {
      console.log(`  lease: ${task.lease.id} | expires=${task.lease.expiresAt}`);
    }
    console.log(`  depends-on: ${task.dependsOnTaskIds.join(", ") || "-"}`);
    console.log(`  parent: ${task.parentTaskId ?? "-"}`);
    console.log(`  plan: ${task.planId ?? "-"}${task.planNodeKey ? ` | node=${task.planNodeKey}` : ""}`);
    console.log(`  updated: ${task.updatedAt}`);
    console.log(
      `  route: ${task.routeStrategy ?? "-"}${task.routeConfidence === null ? "" : ` (${task.routeConfidence.toFixed(2)})`} ${task.routeReason ?? "-"}`
    );
    console.log(`  paths: ${task.claimedPaths.join(", ") || "-"}`);
    if (Object.keys(task.routeMetadata).length > 0) {
      console.log(`  route-meta: ${JSON.stringify(task.routeMetadata)}`);
    }
    console.log(`  summary: ${task.summary ?? "-"}`);
  }
}

function resolveRequestedTaskId(args: string[], knownTaskIds: string[]): string {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const requested = positional[0] ?? "latest";
  if (requested !== "latest") {
    return requested;
  }

  const latest = [...knownTaskIds].pop();
  if (!latest) {
    throw new Error("No tasks found for this session.");
  }

  return latest;
}

function resolveRequestedMissionId(args: string[], knownMissionIds: string[]): string {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const requested = positional[0] ?? "latest";
  if (requested !== "latest") {
    return requested;
  }

  const latest = [...knownMissionIds].pop();
  if (!latest) {
    throw new Error("No missions found for this session.");
  }

  return latest;
}

async function commandTaskOutput(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const sortedTasks = [...session.tasks].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const taskId = resolveRequestedTaskId(
    args,
    sortedTasks.map((task) => task.id)
  );
  const artifact = rpcSnapshot
    ? await rpcTaskArtifact(paths, taskId)
    : await loadTaskArtifact(paths, taskId);
  if (!artifact) {
    const task = sortedTasks.find((item) => item.id === taskId) ?? null;
    if (task && (task.status === "pending" || task.status === "running" || task.status === "blocked")) {
      if (args.includes("--json")) {
        console.log(
          JSON.stringify(
            {
              taskId: task.id,
              owner: task.owner,
              status: task.status,
              summary: task.summary,
              message: "Task artifact is not available yet because the task has not completed."
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`Task: ${task.id}`);
      console.log(`Owner: ${task.owner}`);
      console.log(`Status: ${task.status}`);
      console.log(`Summary: ${task.summary ?? "-"}`);
      console.log("Artifact: not available yet because the task has not completed.");
      return;
    }

    throw new Error(`No task artifact found for ${taskId}.`);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

  console.log(`Task: ${artifact.taskId}`);
  console.log(`Mission: ${artifact.missionId ?? "-"}`);
  console.log(`Owner: ${artifact.owner}`);
  console.log(`Kind: ${artifact.kind}${artifact.nodeKind ? ` | node=${artifact.nodeKind}` : ""}`);
  console.log(`Status: ${artifact.status}`);
  console.log(`Retries: ${artifact.retryCount}/${artifact.maxRetries}`);
  console.log(`Last failure: ${artifact.lastFailureSummary ?? "-"}`);
  console.log(`Depends on: ${artifact.dependsOnTaskIds.join(", ") || "-"}`);
  console.log(`Parent: ${artifact.parentTaskId ?? "-"}`);
  console.log(`Plan: ${artifact.planId ?? "-"}${artifact.planNodeKey ? ` | node=${artifact.planNodeKey}` : ""}`);
  console.log(`Started: ${artifact.startedAt}`);
  console.log(`Finished: ${artifact.finishedAt ?? "-"}`);
  console.log(`Summary: ${artifact.summary ?? "-"}`);
  console.log(`Next recommendation: ${artifact.nextRecommendation ?? "-"}`);
  console.log(
    `Route: ${artifact.routeStrategy ?? "-"}${artifact.routeConfidence === null ? "" : ` (${artifact.routeConfidence.toFixed(2)})`} ${artifact.routeReason ?? "-"}`
  );
  console.log(`Route Metadata: ${JSON.stringify(artifact.routeMetadata ?? {})}`);
  console.log(`Claimed paths: ${artifact.claimedPaths.join(", ") || "-"}`);
  console.log(`Error: ${artifact.error ?? "-"}`);
  console.log("Attempts:");
  if (artifact.attempts.length === 0) {
    console.log("-");
  } else {
    for (const attempt of artifact.attempts) {
      console.log(
        `${attempt.attempt} | ${attempt.status} | started=${attempt.startedAt} | finished=${attempt.finishedAt ?? "-"}`
      );
      if (attempt.summary) {
        console.log(`  ${attempt.summary}`);
      }
    }
  }
  console.log("Decision Replay:");
  for (const line of artifact.decisionReplay) {
    console.log(line);
  }
  console.log("Envelope:");
  console.log(JSON.stringify(artifact.envelope, null, 2));
  console.log("Review Notes:");
  if (artifact.reviewNotes.length === 0) {
    console.log("-");
  } else {
    for (const note of artifact.reviewNotes) {
      console.log(
        `${note.createdAt} | ${note.disposition} | ${note.status} | ${note.filePath}${note.hunkIndex === null ? "" : ` | hunk ${note.hunkIndex + 1}`}`
      );
      console.log(`  assignee: ${note.assignee ?? "-"}`);
      console.log(`  comments: ${note.comments.length}`);
      for (const [index, comment] of note.comments.entries()) {
        console.log(`  ${index === 0 ? "root" : `reply-${index}`}: ${comment.body}`);
      }
      console.log(`  landed: ${note.landedAt ?? "-"}`);
      console.log(`  follow-ups: ${note.followUpTaskIds.join(", ") || "-"}`);
    }
  }
  console.log("Progress:");
  if (artifact.progress.length === 0) {
    console.log("-");
  } else {
    for (const entry of artifact.progress.slice(-10)) {
      console.log(`${entry.createdAt} | ${entry.kind} | ${entry.summary}`);
      if (entry.paths.length > 0) {
        console.log(`  paths: ${entry.paths.join(", ")}`);
      }
    }
  }
  console.log("Raw Output:");
  console.log(artifact.rawOutput ?? "");
}

async function commandDecisions(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const limitArg = getFlag(args, "--limit");
  const limit = limitArg ? Number(limitArg) : 20;
  const decisions = [...session.decisions]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-Math.max(1, Number.isFinite(limit) ? limit : 20));

  if (args.includes("--json")) {
    console.log(JSON.stringify(decisions, null, 2));
    return;
  }

  if (decisions.length === 0) {
    console.log("No decisions recorded.");
    return;
  }

  for (const decision of decisions) {
    console.log(
      `${decision.createdAt} | ${decision.kind} | ${decision.agent ?? "-"} | ${decision.summary}`
    );
    console.log(`  task: ${decision.taskId ?? "-"}`);
    console.log(`  detail: ${decision.detail}`);
    if (Object.keys(decision.metadata).length > 0) {
      console.log(`  metadata: ${JSON.stringify(decision.metadata)}`);
    }
  }
}

async function commandClaims(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const claims = args.includes("--all")
    ? session.pathClaims
    : session.pathClaims.filter((claim) => claim.status === "active");

  if (args.includes("--json")) {
    console.log(JSON.stringify(claims, null, 2));
    return;
  }

  if (claims.length === 0) {
    console.log("No path claims recorded.");
    return;
  }

  for (const claim of claims) {
    console.log(
      `${claim.id} | ${claim.agent} | ${claim.status} | ${claim.source} | ${claim.paths.join(", ") || "-"}`
    );
    console.log(`  task: ${claim.taskId}`);
    console.log(`  updated: ${claim.updatedAt}`);
    console.log(`  note: ${claim.note ?? "-"}`);
  }
}

async function commandReviews(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  const filters = {
    agent: getOptionalFilter(args, "--agent"),
    assignee: getOptionalFilter(args, "--assignee"),
    disposition: getOptionalFilter(args, "--disposition"),
    status: getOptionalFilter(args, "--status") ?? (args.includes("--all") ? null : "open")
  };
  const notes = filterReviewNotes(session.reviewNotes, filters);

  if (args.includes("--json")) {
    console.log(JSON.stringify(notes, null, 2));
    return;
  }

  if (notes.length === 0) {
    console.log("No review notes matched the current filters.");
    return;
  }

  for (const note of notes) {
    console.log(
      `${note.id} | ${note.agent} | ${note.status} | ${note.disposition} | ${note.filePath}${note.hunkIndex === null ? "" : ` | hunk ${note.hunkIndex + 1}`}`
    );
    console.log(`  task: ${note.taskId ?? "-"}`);
    console.log(`  assignee: ${note.assignee ?? "-"}`);
    console.log(`  updated: ${note.updatedAt}`);
    console.log(`  comments: ${note.comments.length}`);
    console.log(`  landed: ${note.landedAt ?? "-"}`);
    console.log(`  follow-ups: ${note.followUpTaskIds.join(", ") || "-"}`);
    console.log(`  body: ${note.body}`);
  }
}

async function commandApprovals(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const requests = rpcSnapshot
    ? rpcSnapshot.approvals.filter((request) => args.includes("--all") || request.status === "pending")
    : await listApprovalRequests(paths, {
        includeResolved: args.includes("--all")
      });

  if (args.includes("--json")) {
    console.log(JSON.stringify(requests, null, 2));
    return;
  }

  if (requests.length === 0) {
    console.log("No approval requests.");
    return;
  }

  for (const request of requests) {
    console.log(
      `${request.id} | ${request.agent} | ${request.status} | ${request.summary}${request.remember ? " | remembered" : ""}`
    );
    console.log(`  created: ${request.createdAt}`);
    console.log(`  decision: ${request.decision ?? "-"}`);
  }
}

function resolveApprovalRequestId(
  requests: ApprovalRequest[],
  requested: string | null
): string {
  if (requested && requested !== "latest") {
    return requested;
  }

  const latest = [...requests]
    .filter((request) => request.status === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .pop();

  if (!latest) {
    throw new Error("No pending approval requests.");
  }

  return latest.id;
}

async function commandResolveApproval(
  cwd: string,
  args: string[],
  decision: ApprovalRuleDecision
): Promise<void> {
  const { paths } = await requireSession(cwd);
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const session = rpcSnapshot?.session ?? (await loadSessionRecord(paths));
  await ensureMutableActionAllowed(paths, session, "Resolving an approval");
  const requests = rpcSnapshot?.approvals ?? (await listApprovalRequests(paths, { includeResolved: true }));
  const requestedId = args.find((arg) => !arg.startsWith("--")) ?? "latest";
  const requestId = resolveApprovalRequestId(requests, requestedId);
  const remember = args.includes("--remember");
  const request = requests.find((item) => item.id === requestId);
  if (!request) {
    throw new Error(`Approval request ${requestId} not found.`);
  }

  if (rpcSnapshot) {
    await rpcResolveApproval(paths, {
      requestId,
      decision,
      remember
    });
  } else {
    const resolved = await resolveApprovalRequest(paths, requestId, decision, remember);
    const session = await loadSessionRecord(paths);
    addDecisionRecord(session, {
      kind: "approval",
      agent: resolved.agent,
      summary: `${decision === "allow" ? "Approved" : "Denied"} ${resolved.toolName}`,
      detail: resolved.summary,
      metadata: {
        requestId: resolved.id,
        remember,
        toolName: resolved.toolName
      }
    });
    await saveSessionRecord(paths, session);
    await recordEvent(paths, session.id, "approval.resolved", {
      requestId: resolved.id,
      decision,
      remember,
      agent: resolved.agent,
      toolName: resolved.toolName
    });
  }
  console.log(
    `${decision === "allow" ? "Approved" : "Denied"} ${request.id}: ${request.summary}${remember ? " (remembered)" : ""}`
  );
}

async function commandEvents(cwd: string, args: string[]): Promise<void> {
  const { paths } = await requireSession(cwd);
  const limitArg = getFlag(args, "--limit");
  const limit = limitArg ? Number(limitArg) : 20;
  const rpcSnapshot = await tryRpcSnapshot(paths);
  const events = rpcSnapshot
    ? await rpcRecentEvents(paths, Number.isFinite(limit) ? limit : 20)
    : await readRecentEvents(paths, Number.isFinite(limit) ? limit : 20);
  for (const event of events) {
    console.log(`${event.timestamp} ${event.type} ${JSON.stringify(event.payload)}`);
  }
}

async function commandStop(cwd: string): Promise<void> {
  const { paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);
  if (!isSessionLive(session)) {
    session.status = "stopped";
    session.daemonHeartbeatAt = new Date().toISOString();
    await writeJson(paths.stateFile, session);
    console.log(`Marked stale Kavi session ${session.id} as stopped`);
    return;
  }

  if (await pingRpc(paths)) {
    await rpcShutdown(paths);
  } else {
    await appendCommand(paths, "shutdown", {});
    await recordEvent(paths, session.id, "daemon.stop_requested", {});
  }
  await waitForSession(paths, "stopped");
  console.log(`Stopped Kavi session ${session.id}`);
}

async function commandRestart(cwd: string): Promise<void> {
  const { repoRoot, paths } = await requireSession(cwd);
  const session = await loadSessionRecord(paths);

  if (await pingRpc(paths)) {
    await rpcShutdown(paths);
    await waitForSession(paths, "stopped");
  } else if (isSessionLive(session)) {
    session.status = "stopped";
    session.daemonHeartbeatAt = new Date().toISOString();
    await writeJson(paths.stateFile, session);
  }

  await ensureStartupReady(repoRoot, paths);

  const runtime = await resolveSessionRuntime(paths);
  const providerCapabilities = await collectProviderCapabilities(repoRoot, paths);
  const restartedSession = await loadSessionRecord(paths);
  restartedSession.status = "starting";
  restartedSession.runtime = runtime;
  restartedSession.daemonPid = null;
  restartedSession.daemonHeartbeatAt = null;
  restartedSession.daemonVersion = null;
  restartedSession.protocolVersion = null;
  restartedSession.providerCapabilities = providerCapabilities;
  await saveSessionRecord(paths, restartedSession);
  await recordEvent(paths, restartedSession.id, "daemon.restart_requested", {
    previousDaemonPid: session.daemonPid,
    previousDaemonVersion: session.daemonVersion ?? null,
    previousProtocolVersion: session.protocolVersion ?? null
  });

  const pid = spawnDetachedNode(
    runtime.nodeExecutable,
    [
      fileURLToPath(import.meta.url),
      "__daemon",
      "--repo-root",
      repoRoot
    ],
    repoRoot
  );

  const sessionForPid = await loadSessionRecord(paths);
  sessionForPid.daemonPid = pid;
  await writeJson(paths.stateFile, sessionForPid);

  await waitForSession(paths);
  const current = await loadSessionRecord(paths);
  console.log(`Restarted Kavi session ${current.id}`);
  console.log(`Control: ${current.socketPath}`);
  console.log(`Daemon: ${current.daemonVersion ?? "unknown"} | protocol ${current.protocolVersion ?? "unknown"}`);
}

async function commandLand(cwd: string): Promise<void> {
  const repoRoot = await detectRepoRoot(cwd);
  const paths = resolveAppPaths(repoRoot);
  if (await sessionExists(paths)) {
    const session = await loadSessionRecord(paths);
    await ensureMutableActionAllowed(paths, session, "Landing");
    await ensureLandingAllowed(session);
  }
  const result = await executeLand(paths);
  await notifyOperatorSurface(
    paths,
    result.status === "landed" ? "land.completed" : "land.overlap_detected"
  );

  if (result.status === "blocked") {
    console.log("Landing blocked because both agent worktrees changed overlapping paths.");
    console.log("Current change surface:");
    for (const changeSet of result.preLandChanges) {
      console.log(
        `- ${changeSet.agent}: ${changeSet.paths.length} path(s)${changeSet.paths.length > 0 ? ` | ${changeSet.paths.join(", ")}` : ""}`
      );
    }
    console.log("Queued integration task for codex:");
    for (const filePath of result.overlappingPaths) {
      console.log(`- ${filePath}`);
    }
    return;
  }
  console.log(`Landed branches into ${result.targetBranch}`);
  console.log(`Integration branch: ${result.integrationBranch}`);
  console.log(`Integration worktree: ${result.integrationPath}`);
  console.log("Merged change surface:");
  for (const changeSet of result.preLandChanges) {
    console.log(
      `- ${changeSet.agent}: ${changeSet.paths.length} path(s)${changeSet.paths.length > 0 ? ` | ${changeSet.paths.join(", ")}` : ""}`
    );
  }
  console.log(
    `Validation: ${result.validation?.command || "(none configured)"} | ${result.validation?.status ?? "not_configured"} | ${result.validation?.detail ?? "No validation command was configured."}`
  );
  console.log(`Review threads landed: ${result.landedReviewThreads}`);
  console.log(`Result report: ${result.landReportId}`);
  console.log("Inspect result: kavi result");
  for (const snapshot of result.snapshotCommits) {
    console.log(
      `Snapshot ${snapshot.agent}: ${snapshot.commit}${snapshot.createdCommit ? " (created)" : " (unchanged)"}`
    );
  }
  for (const command of result.commandsRun) {
    console.log(`- ${command}`);
  }
}

async function commandDaemon(cwd: string, args: string[]): Promise<void> {
  const paths = resolveAppPaths(cwd);
  const daemon = new KaviDaemon(paths);
  await daemon.start();
}

async function commandHook(cwd: string, args: string[]): Promise<void> {
  const agent = (getFlag(args, "--agent") as AgentName | null) ?? null;
  const eventName = getFlag(args, "--event") ?? "Unknown";
  const stdin = await readStdinText();
  const payload = stdin.trim() ? (JSON.parse(stdin) as Record<string, unknown>) : {};
  const paths = resolveAppPaths(cwd);
  const session = (await sessionExists(paths)) ? await loadSessionRecord(paths) : null;

  const hookPayload: HookEventPayload = {
    event: eventName,
    sessionId: session?.id ?? null,
    agent,
    payload
  };

  if (session && agent === "claude") {
    await appendClaudeHookProgress(paths, session, eventName, payload);
  }

  if (session && agent === "claude" && eventName === "PreToolUse") {
    const descriptor = describeToolUse(payload);
    if (session.fullAccessMode) {
      console.log(
        JSON.stringify({
          continue: true,
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: `Kavi approve-all bypassed approval: ${descriptor.summary}`
          }
        })
      );
      return;
    }

    if (CLAUDE_AUTO_ALLOW_TOOLS.has(descriptor.toolName)) {
      await recordEvent(paths, session.id, "approval.auto_allowed", {
        agent,
        toolName: descriptor.toolName,
        summary: descriptor.summary
      });
      await notifyOperatorSurface(paths, "approval.auto_allowed");
      console.log(
        JSON.stringify({
          continue: true,
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: `Kavi auto-allowed read-only tool: ${descriptor.summary}`
          }
        })
      );
      return;
    }

    const rule = await findApprovalRule(paths, {
      repoRoot: session.repoRoot,
      agent,
      toolName: descriptor.toolName,
      matchKey: descriptor.matchKey
    });

    if (rule) {
      await recordEvent(paths, session.id, "approval.auto_decided", {
        agent,
        toolName: descriptor.toolName,
        decision: rule.decision,
        summary: descriptor.summary
      });
      await notifyOperatorSurface(paths, "approval.auto_decided");
      console.log(
        JSON.stringify({
          continue: true,
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: rule.decision === "allow" ? "allow" : "deny",
            permissionDecisionReason: `Kavi ${rule.decision} rule matched: ${descriptor.summary}`
          }
        })
      );
      return;
    }

    const request = await createApprovalRequest(paths, {
      sessionId: session.id,
      repoRoot: session.repoRoot,
      agent,
      hookEvent: eventName,
      payload
    });
    await recordEvent(paths, session.id, "approval.requested", {
      requestId: request.id,
      agent,
      toolName: request.toolName,
      summary: request.summary
    });
    await notifyOperatorSurface(paths, "approval.requested");

    const resolved = await waitForApprovalDecision(paths, request.id);
    const approved = resolved?.status === "approved";
    const denied = resolved?.status === "denied";
    const timedOut = resolved?.status === "expired" || !resolved;

    await recordEvent(paths, session.id, "approval.completed", {
      requestId: request.id,
      outcome: approved ? "approved" : denied ? "denied" : "expired"
    });
    await notifyOperatorSurface(paths, "approval.completed");
    console.log(
      JSON.stringify({
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: approved ? "allow" : "deny",
          permissionDecisionReason: approved
            ? `Approved by Kavi: ${request.summary}`
            : timedOut
              ? `Kavi approval timed out: ${request.summary}`
              : `Denied by Kavi: ${request.summary}`
        }
      })
    );
    return;
  }

  if (session) {
    await recordEvent(paths, session.id, "claude.hook", hookPayload as unknown as Record<string, unknown>);
    await notifyOperatorSurface(paths, "claude.hook");
  }

  console.log(JSON.stringify({ continue: true }));
}

async function main(): Promise<void> {
  const { command, args, cwd } = parseCliInvocation(process.argv.slice(2));

  switch (command) {
    case "version":
    case "--version":
    case "-v":
      await commandVersion(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(renderUsage());
      break;
    case "init":
      await commandInit(cwd, args);
      break;
    case "doctor":
      await commandDoctor(cwd, args);
      break;
    case "update":
      await commandUpdate(cwd, args);
      break;
    case "start":
      await commandStart(cwd, args);
      break;
    case "open":
      await commandOpen(cwd, args);
      break;
    case "resume":
      await commandResume(cwd);
      break;
    case "restart":
      await commandRestart(cwd);
      break;
    case "summary":
      await commandSummary(cwd, args);
      break;
    case "result":
      await commandResult(cwd, args);
      break;
    case "mission":
      await commandMission(cwd, args);
      break;
    case "missions":
      await commandMissions(cwd, args);
      break;
    case "playback":
      await commandPlayback(cwd, args);
      break;
    case "accept":
      await commandAccept(cwd, args);
      break;
    case "verify":
      await commandVerify(cwd, args);
      break;
    case "brain":
      await commandBrain(cwd, args);
      break;
    case "brain-pin":
      await commandBrainPinned(cwd, args, true);
      break;
    case "brain-unpin":
      await commandBrainPinned(cwd, args, false);
      break;
    case "brain-retire":
      await commandBrainRetire(cwd, args);
      break;
    case "brain-merge":
      await commandBrainMerge(cwd, args);
      break;
    case "patterns":
      await commandPatterns(cwd, args);
      break;
    case "plan":
      await commandPlan(cwd, args);
      break;
    case "status":
      await commandStatus(cwd, args);
      break;
    case "activity":
      await commandActivity(cwd, args);
      break;
    case "route":
      await commandRoute(cwd, args);
      break;
    case "routes":
      await commandRoutes(cwd, args);
      break;
    case "paths":
      await commandPaths(cwd, args);
      break;
    case "task":
      await commandTask(cwd, args);
      break;
    case "retry":
      await commandRetry(cwd, args);
      break;
    case "recommend":
      await commandRecommend(cwd, args);
      break;
    case "recommend-apply":
      await commandRecommendApply(cwd, args);
      break;
    case "recommend-dismiss":
      await commandRecommendDismiss(cwd, args);
      break;
    case "recommend-restore":
      await commandRecommendRestore(cwd, args);
      break;
    case "tasks":
      await commandTasks(cwd, args);
      break;
    case "task-output":
      await commandTaskOutput(cwd, args);
      break;
    case "decisions":
      await commandDecisions(cwd, args);
      break;
    case "claims":
      await commandClaims(cwd, args);
      break;
    case "reviews":
      await commandReviews(cwd, args);
      break;
    case "approvals":
      await commandApprovals(cwd, args);
      break;
    case "approve":
      await commandResolveApproval(cwd, args, "allow");
      break;
    case "deny":
      await commandResolveApproval(cwd, args, "deny");
      break;
    case "events":
      await commandEvents(cwd, args);
      break;
    case "stop":
      await commandStop(cwd);
      break;
    case "land":
      await commandLand(cwd);
      break;
    case "__daemon":
      await commandDaemon(cwd, args);
      break;
    case "__hook":
      await commandHook(cwd, args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
