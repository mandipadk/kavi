import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { loadConfig } from "./config.ts";
import { fileExists } from "./fs.ts";
import { findOwnershipRuleConflicts } from "./ownership.ts";
import { runCommand } from "./process.ts";
import { hasSupportedNode, minimumNodeMajor, resolveSessionRuntime } from "./runtime.ts";
import type { AppPaths, DoctorCheck } from "./types.ts";

export function parseClaudeAuthStatus(output: string): {
  loggedIn: boolean;
  detail: string;
} {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const loggedIn = parsed.loggedIn === true;
    const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : "unknown";
    const apiProvider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : "unknown";
    return {
      loggedIn,
      detail: loggedIn
        ? `logged in via ${authMethod} (${apiProvider})`
        : `not logged in (${authMethod}, ${apiProvider})`
    };
  } catch {
    const trimmed = output.trim();
    return {
      loggedIn: false,
      detail: trimmed || "unable to parse claude auth status"
    };
  }
}

const REQUIRED_CLAUDE_PRINT_FLAGS = [
  "--output-format",
  "--json-schema",
  "--session-id",
  "--permission-mode",
  "-p, --print"
];

export function parseClaudePrintContractIssues(helpOutput: string): string[] {
  const normalized = helpOutput.trim();
  if (!normalized) {
    return ["Claude help output was empty."];
  }

  return REQUIRED_CLAUDE_PRINT_FLAGS
    .filter((flag) => !normalized.includes(flag))
    .map((flag) => `missing ${flag}`);
}

async function runCodexAppServerCanary(
  repoRoot: string,
  paths: AppPaths
): Promise<{ ok: boolean; detail: string }> {
  const runtime = await resolveSessionRuntime(paths);
  let client: CodexAppServerClient | null = null;
  try {
    client = new CodexAppServerClient(runtime, repoRoot, async () => ({}));
    await Promise.race([
      client.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Codex app-server canary timed out during initialize.")), 4_000)
      )
    ]);
    return {
      ok: true,
      detail: "initialize handshake succeeded"
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

async function runClaudePrintContractCanary(
  repoRoot: string,
  runtime: Awaited<ReturnType<typeof resolveSessionRuntime>>
): Promise<{ ok: boolean; detail: string }> {
  const help = await runCommand(runtime.claudeExecutable, ["--help"], { cwd: repoRoot });
  if (help.code !== 0) {
    return {
      ok: false,
      detail: help.stderr.trim() || help.stdout.trim() || "claude --help failed"
    };
  }

  const issues = parseClaudePrintContractIssues(help.stdout);
  if (issues.length > 0) {
    return {
      ok: false,
      detail: issues.join("; ")
    };
  }

  return {
    ok: true,
    detail: "required print/json contract flags are present"
  };
}

function normalizeRoutingPathRule(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  const withoutPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const normalized = path.posix.normalize(withoutPrefix);
  return normalized === "." ? "" : normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function validateRoutingPathRules(config: Awaited<ReturnType<typeof loadConfig>>): string[] {
  const issues: string[] = [];
  const codexPaths = config.routing.codexPaths.map(normalizeRoutingPathRule);
  const claudePaths = config.routing.claudePaths.map(normalizeRoutingPathRule);
  const rawRules = [
    ...config.routing.codexPaths.map((rule) => ({
      owner: "codex",
      raw: rule,
      normalized: normalizeRoutingPathRule(rule)
    })),
    ...config.routing.claudePaths.map((rule) => ({
      owner: "claude",
      raw: rule,
      normalized: normalizeRoutingPathRule(rule)
    }))
  ];

  const blankRules = [...codexPaths, ...claudePaths].filter((rule) => !rule);
  if (blankRules.length > 0) {
    issues.push("Ownership path rules must not be empty.");
  }

  const absoluteRules = rawRules
    .filter(({ raw }) => {
      const trimmed = raw.trim();
      return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
    })
    .map(({ owner, raw }) => `${owner}:${raw}`);
  if (absoluteRules.length > 0) {
    issues.push(
      `Ownership path rules must be repo-relative, not absolute: ${absoluteRules.join(", ")}`
    );
  }

  const parentTraversalRules = rawRules
    .filter(({ normalized }) => normalized === ".." || normalized.startsWith("../"))
    .map(({ owner, raw }) => `${owner}:${raw}`);
  if (parentTraversalRules.length > 0) {
    issues.push(
      `Ownership path rules must stay inside the repo root: ${parentTraversalRules.join(", ")}`
    );
  }

  const duplicateRules = (rules: string[], owner: string) => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const rule of rules) {
      if (!rule) {
        continue;
      }
      if (seen.has(rule)) {
        duplicates.add(rule);
      }
      seen.add(rule);
    }
    if (duplicates.size > 0) {
      issues.push(`${owner} has duplicate ownership rules: ${[...duplicates].join(", ")}`);
    }
  };

  duplicateRules(codexPaths, "codex");
  duplicateRules(claudePaths, "claude");

  const overlappingRules = codexPaths.filter((rule) => rule && claudePaths.includes(rule));
  if (overlappingRules.length > 0) {
    issues.push(
      `codex_paths and claude_paths overlap on the same exact rules: ${[...new Set(overlappingRules)].join(", ")}`
    );
  }

  const ambiguousConflicts = findOwnershipRuleConflicts(config)
    .filter((conflict) => conflict.kind === "ambiguous-overlap")
    .map((conflict) => `${conflict.leftOwner}:${conflict.leftPattern} <> ${conflict.rightOwner}:${conflict.rightPattern}`);
  if (ambiguousConflicts.length > 0) {
    issues.push(
      `Ownership rules have ambiguous overlaps without a specificity winner: ${ambiguousConflicts.join(", ")}`
    );
  }

  return issues;
}

function normalizeVersion(output: string): string {
  return output.trim().split(/\s+/).slice(-1)[0] ?? output.trim();
}

export async function runDoctor(repoRoot: string, paths: AppPaths): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const runtime = await resolveSessionRuntime(paths);
  const config = await loadConfig(paths);

  const nodeVersion = await runCommand(runtime.nodeExecutable, ["--version"], { cwd: repoRoot });
  checks.push({
    name: "node",
    ok: nodeVersion.code === 0 && hasSupportedNode(nodeVersion.stdout.replace(/^v/, "").trim()),
    detail:
      nodeVersion.code === 0
        ? `${nodeVersion.stdout.trim()} via ${runtime.nodeExecutable} (need >= ${minimumNodeMajor()})`
        : nodeVersion.stderr.trim()
  });

  const codexVersion = await runCommand(runtime.codexExecutable, ["--version"], { cwd: repoRoot });
  checks.push({
    name: "codex",
    ok: codexVersion.code === 0,
    detail:
      codexVersion.code === 0
        ? `${normalizeVersion(codexVersion.stdout)} via ${runtime.codexExecutable}`
        : codexVersion.stderr.trim()
  });

  const claudeVersion = await runCommand(runtime.claudeExecutable, ["--version"], { cwd: repoRoot });
  checks.push({
    name: "claude",
    ok: claudeVersion.code === 0,
    detail:
      claudeVersion.code === 0
        ? `${claudeVersion.stdout.trim()} via ${runtime.claudeExecutable}`
        : claudeVersion.stderr.trim()
  });

  const claudeAuth = await runCommand(runtime.claudeExecutable, ["auth", "status"], { cwd: repoRoot });
  const claudeAuthStatus =
    claudeAuth.code === 0
      ? parseClaudeAuthStatus(claudeAuth.stdout)
      : {
          loggedIn: false,
          detail: claudeAuth.stderr.trim() || claudeAuth.stdout.trim() || "claude auth status failed"
        };
  checks.push({
    name: "claude-auth",
    ok: claudeAuth.code === 0 && claudeAuthStatus.loggedIn,
    detail:
      claudeAuth.code === 0
        ? claudeAuthStatus.detail
        : claudeAuthStatus.detail
  });

  const worktreeCheck = await runCommand("git", ["worktree", "list"], { cwd: repoRoot });
  checks.push({
    name: "git-worktree",
    ok: worktreeCheck.code === 0,
    detail: worktreeCheck.code === 0 ? "available" : worktreeCheck.stderr.trim()
  });

  const appServerCheck = await runCommand(runtime.codexExecutable, ["app-server", "--help"], {
    cwd: repoRoot
  });
  checks.push({
    name: "codex-app-server",
    ok: appServerCheck.code === 0,
    detail: appServerCheck.code === 0 ? "supported" : appServerCheck.stderr.trim()
  });

  const authCheck = await fileExists(`${process.env.HOME}/.codex/auth.json`);
  checks.push({
    name: "codex-auth-file",
    ok: authCheck,
    detail: authCheck ? "present" : "missing ~/.codex/auth.json"
  });

  const homeConfigCheck = await fileExists(paths.homeConfigFile);
  checks.push({
    name: "home-config",
    ok: true,
    detail: homeConfigCheck ? "present" : "will be created on demand"
  });

  const codexCanary = await runCodexAppServerCanary(repoRoot, paths);
  checks.push({
    name: "codex-app-server-canary",
    ok: codexCanary.ok,
    detail: codexCanary.detail
  });

  const claudePrintCanary = await runClaudePrintContractCanary(repoRoot, runtime);
  checks.push({
    name: "claude-print-contract",
    ok: claudePrintCanary.ok,
    detail: claudePrintCanary.detail
  });

  const routingRuleIssues = validateRoutingPathRules(config);
  checks.push({
    name: "routing-path-rules",
    ok: routingRuleIssues.length === 0,
    detail:
      routingRuleIssues.length === 0
        ? "valid"
        : routingRuleIssues.join("; ")
  });

  return checks;
}
