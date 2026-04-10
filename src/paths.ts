import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AppPaths } from "./types.ts";

export function resolveAppPaths(repoRoot: string): AppPaths {
  const home = os.homedir();
  const safeRepoId = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
  const kaviDir = path.join(repoRoot, ".kavi");
  const homeConfigDir =
    process.env.KAVI_HOME_CONFIG_DIR ?? path.join(home, ".config", "kavi");
  const homeStateDir =
    process.env.KAVI_HOME_STATE_DIR ?? path.join(home, ".local", "state", "kavi");
  const runtimeDir = path.join(kaviDir, "runtime");
  const stateDir = path.join(kaviDir, "state");
  const reportsDir = path.join(stateDir, "reports");
  const runsDir = path.join(runtimeDir, "runs");

  return {
    repoRoot,
    kaviDir,
    configFile: path.join(kaviDir, "config.toml"),
    promptsDir: path.join(kaviDir, "prompts"),
    stateDir,
    reportsDir,
    runtimeDir,
    runsDir,
    stateFile: path.join(stateDir, "session.json"),
    eventsFile: path.join(stateDir, "events.jsonl"),
    approvalsFile: path.join(stateDir, "approvals.json"),
    commandsFile: path.join(runtimeDir, "commands.jsonl"),
    claudeSettingsFile: path.join(runtimeDir, "claude.settings.json"),
    socketPath: path.join(homeStateDir, "sockets", `${safeRepoId}.sock`),
    homeConfigDir,
    homeConfigFile: path.join(homeConfigDir, "config.toml"),
    homeApprovalRulesFile: path.join(homeConfigDir, "approval-rules.json"),
    homeStateDir,
    patternsFile: path.join(homeStateDir, "patterns.json"),
    worktreeRoot: path.join(homeStateDir, "worktrees", safeRepoId),
    integrationRoot: path.join(homeStateDir, "integration", safeRepoId)
  };
}

export function buildSessionId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
