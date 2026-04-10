import path from "node:path";
import process from "node:process";
import { fileExists } from "./fs.ts";
import { nowIso } from "./paths.ts";
import { runCommand } from "./process.ts";
import { hasSupportedNode, minimumNodeMajor, resolveSessionRuntime } from "./runtime.ts";
import type { AppPaths, ProviderCapabilityManifest, SessionRecord } from "./types.ts";

function normalizeVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.split(/\s+/).slice(-1)[0] ?? trimmed;
}

function parseClaudeAuth(output: string): { loggedIn: boolean; detail: string } {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const loggedIn = parsed.loggedIn === true;
    const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : "unknown";
    const provider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : "unknown";
    return {
      loggedIn,
      detail: loggedIn ? `${authMethod} (${provider})` : `not logged in (${authMethod}, ${provider})`
    };
  } catch {
    const trimmed = output.trim();
    return {
      loggedIn: false,
      detail: trimmed || "unable to parse auth status"
    };
  }
}

export async function collectProviderCapabilities(
  repoRoot: string,
  paths: AppPaths
): Promise<ProviderCapabilityManifest[]> {
  const runtime = await resolveSessionRuntime(paths);
  const checkedAt = nowIso();

  const nodeVersion = await runCommand(runtime.nodeExecutable, ["--version"], { cwd: repoRoot });
  const nodeVersionString = nodeVersion.code === 0 ? nodeVersion.stdout.trim().replace(/^v/, "") : null;
  const nodeErrors =
    nodeVersion.code === 0
      ? hasSupportedNode(nodeVersionString ?? undefined)
        ? []
        : [`Need Node >= ${minimumNodeMajor()}; found ${nodeVersionString ?? "unknown"}.`]
      : [nodeVersion.stderr.trim() || "node --version failed"];

  const codexVersion = await runCommand(runtime.codexExecutable, ["--version"], { cwd: repoRoot });
  const codexAppServer = await runCommand(runtime.codexExecutable, ["app-server", "--help"], { cwd: repoRoot });
  const codexAuth = await fileExists(path.join(process.env.HOME ?? "", ".codex", "auth.json"));

  const claudeVersion = await runCommand(runtime.claudeExecutable, ["--version"], { cwd: repoRoot });
  const claudeAuthStatus = await runCommand(runtime.claudeExecutable, ["auth", "status"], { cwd: repoRoot });
  const parsedClaudeAuth =
    claudeAuthStatus.code === 0
      ? parseClaudeAuth(claudeAuthStatus.stdout)
      : {
          loggedIn: false,
          detail: claudeAuthStatus.stderr.trim() || claudeAuthStatus.stdout.trim() || "auth status failed"
        };

  const manifests: ProviderCapabilityManifest[] = [
    {
      provider: "node",
      version: nodeVersionString,
      transport: null,
      status: nodeErrors.length > 0 ? "unsupported" : "ok",
      capabilities: nodeErrors.length > 0 ? [] : [`node-${nodeVersionString}`],
      warnings: [],
      errors: nodeErrors,
      checkedAt
    },
    {
      provider: "codex",
      version: codexVersion.code === 0 ? normalizeVersion(codexVersion.stdout) : null,
      transport: "codex-app-server",
      status:
        codexVersion.code === 0 && codexAppServer.code === 0 && codexAuth
          ? "ok"
          : codexVersion.code === 0
            ? "degraded"
            : "unsupported",
      capabilities: [
        ...(codexAppServer.code === 0 ? ["app-server"] : []),
        "structured-output",
        "workspace-write",
        "danger-full-access"
      ],
      warnings: codexAuth ? [] : ["Missing ~/.codex/auth.json."],
      errors: [
        ...(codexVersion.code === 0 ? [] : [codexVersion.stderr.trim() || "codex --version failed"]),
        ...(codexAppServer.code === 0 ? [] : [codexAppServer.stderr.trim() || "codex app-server unsupported"]),
        ...(codexAuth ? [] : ["Codex auth file missing."])
      ],
      checkedAt
    },
    {
      provider: "claude",
      version: claudeVersion.code === 0 ? claudeVersion.stdout.trim() : null,
      transport: "claude-print",
      status:
        claudeVersion.code === 0 && claudeAuthStatus.code === 0 && parsedClaudeAuth.loggedIn
          ? "ok"
          : claudeVersion.code === 0
            ? "degraded"
            : "unsupported",
      capabilities: ["print", "hooks", "dangerously-skip-permissions"],
      warnings:
        claudeAuthStatus.code === 0 && !parsedClaudeAuth.loggedIn
          ? [parsedClaudeAuth.detail]
          : [],
      errors: [
        ...(claudeVersion.code === 0 ? [] : [claudeVersion.stderr.trim() || "claude --version failed"]),
        ...(claudeAuthStatus.code === 0 && parsedClaudeAuth.loggedIn
          ? []
          : [parsedClaudeAuth.detail])
      ],
      checkedAt
    }
  ];

  return manifests;
}

export function providerCapabilityErrors(manifests: ProviderCapabilityManifest[]): string[] {
  return manifests.flatMap((manifest) =>
    manifest.status === "unsupported"
      ? manifest.errors.map((error) => `${manifest.provider}: ${error}`)
      : []
  );
}

export function detectProviderAuthIssue(
  provider: ProviderCapabilityManifest["provider"],
  detail: string
): string | null {
  const normalized = detail.trim();
  if (!normalized) {
    return null;
  }

  if (
    provider === "claude" &&
    (/invalid_grant/i.test(normalized) ||
      /invalid_rapt/i.test(normalized) ||
      /reauth/i.test(normalized) ||
      /not logged in/i.test(normalized))
  ) {
    return "Claude authentication needs to be refreshed. Run `claude auth status` or re-authenticate, then retry the task.";
  }

  if (
    provider === "codex" &&
    (/unauthorized/i.test(normalized) ||
      /authrequired/i.test(normalized) ||
      /www_authenticate/i.test(normalized) ||
      /resource_metadata/i.test(normalized) ||
      /oauth/i.test(normalized) ||
      /forbidden/i.test(normalized) ||
      /not logged in/i.test(normalized) ||
      /authentication/i.test(normalized))
  ) {
    return "Codex authentication needs attention. Re-authenticate Codex, then retry the task.";
  }

  return null;
}

export function markProviderCapabilityDegraded(
  session: SessionRecord,
  provider: ProviderCapabilityManifest["provider"],
  detail: string
): void {
  session.providerCapabilities = Array.isArray(session.providerCapabilities)
    ? session.providerCapabilities
    : [];

  const checkedAt = nowIso();
  const existing = session.providerCapabilities.find((manifest) => manifest.provider === provider);
  if (existing) {
    existing.status = existing.status === "unsupported" ? "unsupported" : "degraded";
    existing.errors = [...new Set([detail, ...existing.errors])];
    existing.warnings = [...new Set([detail, ...existing.warnings])];
    existing.checkedAt = checkedAt;
    return;
  }

  session.providerCapabilities.push({
    provider,
    version: null,
    transport: null,
    status: "degraded",
    capabilities: [],
    warnings: [detail],
    errors: [detail],
    checkedAt
  });
}
