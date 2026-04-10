import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./fs.ts";
import { buildSessionId } from "./paths.ts";
import { runCommand } from "./process.ts";
import type {
  AgentName,
  AppPaths,
  KaviConfig,
  WorktreeDiffReview,
  WorktreeInfo
} from "./types.ts";

export interface LandResult {
  commandsRun: string[];
  integrationBranch: string;
  integrationPath: string;
  validation: {
    command: string;
    status: "ran" | "skipped" | "not_configured";
    detail: string;
  };
  snapshotCommits: Array<{
    agent: AgentName;
    createdCommit: boolean;
    commit: string;
  }>;
}

export interface IntegrationWorkspace {
  commandsRun: string[];
  integrationBranch: string;
  integrationPath: string;
  snapshotCommits: Array<{
    agent: AgentName;
    createdCommit: boolean;
    commit: string;
  }>;
}

export interface GitRepositoryResult {
  repoRoot: string;
  createdRepository: boolean;
}

export interface BootstrapCommitResult {
  createdCommit: boolean;
  commit: string;
  stagedPaths: string[];
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    return null;
  }

  return result.stdout.trim();
}

export async function detectRepoRoot(cwd: string): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error("Not inside a git repository.");
  }

  return repoRoot;
}

export async function getHeadCommit(repoRoot: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(
      "Unable to resolve HEAD. Create an initial commit before opening a Kavi session."
    );
  }

  return result.stdout.trim();
}

async function initializeRepository(repoRoot: string): Promise<void> {
  const preferred = await runCommand("git", ["init", "--initial-branch=main"], {
    cwd: repoRoot
  });
  if (preferred.code === 0) {
    return;
  }

  const fallback = await runCommand("git", ["init"], { cwd: repoRoot });
  if (fallback.code !== 0) {
    throw new Error(
      fallback.stderr.trim() || preferred.stderr.trim() || `Unable to initialize git in ${repoRoot}.`
    );
  }
}

export async function ensureGitRepository(cwd: string): Promise<GitRepositoryResult> {
  const existing = await findRepoRoot(cwd);
  if (existing) {
    return {
      repoRoot: existing,
      createdRepository: false
    };
  }

  await initializeRepository(cwd);
  return {
    repoRoot: await detectRepoRoot(cwd),
    createdRepository: true
  };
}

export async function hasHeadCommit(repoRoot: string): Promise<boolean> {
  const result = await runCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot
  });
  return result.code === 0;
}

export async function ensureBootstrapCommit(
  repoRoot: string,
  message = "kavi: bootstrap project"
): Promise<BootstrapCommitResult> {
  if (await hasHeadCommit(repoRoot)) {
    return {
      createdCommit: false,
      commit: await getHeadCommit(repoRoot),
      stagedPaths: []
    };
  }

  const add = await runCommand("git", ["add", "-A"], { cwd: repoRoot });
  if (add.code !== 0) {
    throw new Error(add.stderr.trim() || `Unable to stage bootstrap files in ${repoRoot}.`);
  }

  const staged = await runCommand(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"],
    { cwd: repoRoot }
  );
  if (staged.code !== 0) {
    throw new Error(staged.stderr.trim() || `Unable to inspect staged bootstrap files in ${repoRoot}.`);
  }

  const commit = await runCommand(
    "git",
    [
      "-c",
      "user.name=Kavi",
      "-c",
      "user.email=kavi@local.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message
    ],
    { cwd: repoRoot }
  );
  if (commit.code !== 0) {
    throw new Error(commit.stderr.trim() || `Unable to create bootstrap commit in ${repoRoot}.`);
  }

  return {
    createdCommit: true,
    commit: await getHeadCommit(repoRoot),
    stagedPaths: parsePathList(staged.stdout)
  };
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const result = await runCommand("git", ["branch", "--show-current"], { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Unable to resolve current branch.");
  }

  return result.stdout.trim();
}

export async function getBranchCommit(repoRoot: string, ref: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", ref], { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Unable to resolve ${ref}.`);
  }

  return result.stdout.trim();
}

function parsePathList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeWorktreePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isEphemeralWorktreePath(filePath: string): boolean {
  const normalized = normalizeWorktreePath(filePath);
  return (
    path.isAbsolute(filePath) ||
    normalized === ".DS_Store" ||
    normalized === "Thumbs.db" ||
    normalized.endsWith("/.DS_Store") ||
    normalized.endsWith("/Thumbs.db") ||
    normalized.startsWith(".kavi/") ||
    normalized.includes("/.kavi/") ||
    normalized.includes("/__pycache__/") ||
    normalized.startsWith("__pycache__/") ||
    normalized.endsWith(".pyc") ||
    normalized.endsWith(".pyo") ||
    normalized.endsWith(".pyd") ||
    normalized === ".coverage" ||
    normalized.startsWith(".pytest_cache/") ||
    normalized.startsWith(".mypy_cache/") ||
    normalized.startsWith(".ruff_cache/") ||
    normalized.startsWith(".turbo/") ||
    normalized.startsWith(".cache/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/") ||
    normalized.startsWith(".next/") ||
    normalized.includes("/.next/") ||
    normalized.endsWith(".tsbuildinfo")
  );
}

export function filterWorktreeChangedPaths(values: string[]): string[] {
  return uniqueSorted(values.filter((value) => !isEphemeralWorktreePath(value)));
}

async function isUntrackedPath(worktreePath: string, filePath: string): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", filePath],
    {
      cwd: worktreePath
    }
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Unable to inspect untracked status for ${filePath}.`);
  }

  return parsePathList(result.stdout).includes(filePath);
}

async function buildSyntheticAddedFilePatch(
  worktreePath: string,
  filePath: string
): Promise<{ stat: string; patch: string }> {
  const absolutePath = path.join(worktreePath, filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const normalized = content.replaceAll("\r", "");
  const endsWithNewline = normalized.endsWith("\n");
  const lines = normalized.length === 0
    ? []
    : normalized.replace(/\n$/, "").split("\n");

  const patchLines = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`
  ];

  if (lines.length > 0) {
    patchLines.push(`@@ -0,0 +1,${lines.length} @@`);
    patchLines.push(...lines.map((line) => `+${line}`));
    if (!endsWithNewline) {
      patchLines.push("\\ No newline at end of file");
    }
  }

  return {
    stat:
      lines.length > 0
        ? `new file | ${lines.length} insertion${lines.length === 1 ? "" : "s"}(+)`
        : "new file | empty",
    patch: patchLines.join("\n")
  };
}

export async function resolveTargetBranch(repoRoot: string, configuredBranch: string): Promise<string> {
  const exists = await runCommand("git", ["show-ref", "--verify", `refs/heads/${configuredBranch}`], {
    cwd: repoRoot
  });

  if (exists.code === 0) {
    return configuredBranch;
  }

  return getCurrentBranch(repoRoot);
}

async function ensureDetachedWorktree(repoRoot: string, worktreePath: string, baseCommit: string) {
  const result = await runCommand(
    "git",
    ["worktree", "add", "--detach", worktreePath, baseCommit],
    { cwd: repoRoot }
  );

  if (result.code !== 0 && !result.stderr.includes("already exists")) {
    throw new Error(result.stderr.trim() || `Unable to create worktree ${worktreePath}.`);
  }
}

async function ensureBranch(worktreePath: string, branchName: string, baseCommit: string): Promise<void> {
  const exists = await runCommand("git", ["rev-parse", "--verify", branchName], {
    cwd: worktreePath
  });

  if (exists.code !== 0) {
    const createResult = await runCommand("git", ["checkout", "-b", branchName, baseCommit], {
      cwd: worktreePath
    });

    if (createResult.code !== 0) {
      throw new Error(createResult.stderr.trim() || `Unable to create branch ${branchName}.`);
    }

    return;
  }

  const checkoutResult = await runCommand("git", ["checkout", branchName], { cwd: worktreePath });
  if (checkoutResult.code !== 0) {
    throw new Error(checkoutResult.stderr.trim() || `Unable to checkout ${branchName}.`);
  }
}

export async function ensureWorktrees(
  repoRoot: string,
  paths: AppPaths,
  sessionId: string,
  _config: KaviConfig,
  baseCommit: string
): Promise<WorktreeInfo[]> {
  await ensureDir(paths.worktreeRoot);
  const agents: AgentName[] = ["codex", "claude"];
  const worktrees: WorktreeInfo[] = [];

  for (const agent of agents) {
    const worktreePath = path.join(paths.worktreeRoot, `${agent}-${sessionId}`);
    const branchName = `kavi/${sessionId}/${agent}`;
    await ensureDetachedWorktree(repoRoot, worktreePath, baseCommit);
    await ensureBranch(worktreePath, branchName, baseCommit);
    worktrees.push({
      agent,
      path: worktreePath,
      branch: branchName
    });
  }

  return worktrees;
}

export async function createGitignoreEntries(repoRoot: string): Promise<void> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let content = "";

  try {
    content = await fs.readFile(gitignorePath, "utf8");
  } catch {
    content = "";
  }

  const entries = [".kavi/state", ".kavi/runtime"];
  const missing = entries.filter((entry) => !content.split(/\r?\n/).includes(entry));
  if (missing.length === 0) {
    return;
  }

  const prefix = content.trimEnd() ? "\n" : "";
  await fs.writeFile(gitignorePath, `${content.trimEnd()}${prefix}${missing.join("\n")}\n`, "utf8");
}

export async function listWorktreeChangedPaths(
  worktreePath: string,
  baseCommit: string
): Promise<string[]> {
  const [committed, staged, unstaged, untracked] = await Promise.all([
    runCommand("git", ["diff", "--name-only", `${baseCommit}..HEAD`], {
      cwd: worktreePath
    }),
    runCommand("git", ["diff", "--name-only", "--cached"], {
      cwd: worktreePath
    }),
    runCommand("git", ["diff", "--name-only"], {
      cwd: worktreePath
    }),
    runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: worktreePath
    })
  ]);

  const outputs = [committed, staged, unstaged, untracked];
  const failures = outputs.filter((result) => result.code !== 0);
  if (failures.length > 0) {
    throw new Error(
      failures
        .map((result) => result.stderr.trim() || "Unable to inspect worktree changes.")
        .join("\n")
    );
  }

  return filterWorktreeChangedPaths([
    ...parsePathList(committed.stdout),
    ...parsePathList(staged.stdout),
    ...parsePathList(unstaged.stdout),
    ...parsePathList(untracked.stdout)
  ]);
}

export async function resolveValidationPlan(
  integrationPath: string,
  validationCommand: string
): Promise<LandResult["validation"]> {
  const trimmed = validationCommand.trim();
  if (!trimmed) {
    return {
      command: "",
      status: "not_configured",
      detail: "No validation command was configured."
    };
  }

  if (trimmed === "npm test") {
    try {
      await fs.access(path.join(integrationPath, "package.json"));
    } catch {
      return {
        command: trimmed,
        status: "skipped",
        detail: 'Skipped default validation command "npm test" because package.json is not present yet.'
      };
    }
  }

  return {
    command: trimmed,
    status: "ran",
    detail: `Validation ran with "${trimmed}".`
  };
}

export async function getWorktreeDiffReview(
  agent: AgentName,
  worktreePath: string,
  baseCommit: string,
  filePath: string | null
): Promise<WorktreeDiffReview> {
  const changedPaths = await listWorktreeChangedPaths(worktreePath, baseCommit);
  const selectedPath =
    filePath && changedPaths.includes(filePath)
      ? filePath
      : changedPaths[0] ?? null;

  if (!selectedPath) {
    return {
      agent,
      changedPaths,
      selectedPath: null,
      stat: "No changed files in this worktree.",
      patch: ""
    };
  }

  if (await isUntrackedPath(worktreePath, selectedPath)) {
    const synthetic = await buildSyntheticAddedFilePatch(worktreePath, selectedPath);
    return {
      agent,
      changedPaths,
      selectedPath,
      stat: synthetic.stat,
      patch: synthetic.patch
    };
  }

  const [statResult, patchResult] = await Promise.all([
    runCommand(
      "git",
      ["diff", "--stat", "--find-renames", baseCommit, "--", selectedPath],
      {
        cwd: worktreePath
      }
    ),
    runCommand(
      "git",
      ["diff", "--find-renames", "--unified=3", baseCommit, "--", selectedPath],
      {
        cwd: worktreePath
      }
    )
  ]);

  if (statResult.code !== 0) {
    throw new Error(statResult.stderr.trim() || `Unable to build diff stat for ${selectedPath}.`);
  }

  if (patchResult.code !== 0) {
    throw new Error(patchResult.stderr.trim() || `Unable to build diff patch for ${selectedPath}.`);
  }

  return {
    agent,
    changedPaths,
    selectedPath,
    stat: statResult.stdout.trim() || "No diff stat available.",
    patch: patchResult.stdout.trim() || "No textual patch available."
  };
}

export async function findOverlappingWorktreePaths(
  worktrees: WorktreeInfo[],
  baseCommit: string
): Promise<string[]> {
  const pathSets = await Promise.all(
    worktrees.map(async (worktree) => ({
      agent: worktree.agent,
      paths: await listWorktreeChangedPaths(worktree.path, baseCommit)
    }))
  );

  const overlaps: string[] = [];
  for (let index = 0; index < pathSets.length; index += 1) {
    const current = pathSets[index];
    const rest = pathSets.slice(index + 1);
    for (const other of rest) {
      for (const filePath of current.paths) {
        if (other.paths.includes(filePath)) {
          overlaps.push(filePath);
        }
      }
    }
  }

  return uniqueSorted(overlaps);
}

export async function landBranches(
  repoRoot: string,
  targetBranch: string,
  worktrees: WorktreeInfo[],
  validationCommand: string,
  sessionId: string,
  integrationRoot: string
): Promise<LandResult> {
  const workspace = await createIntegrationWorkspace(
    repoRoot,
    targetBranch,
    worktrees,
    sessionId,
    integrationRoot
  );
  const { commandsRun, snapshotCommits, integrationBranch, integrationPath } = workspace;

  const validation = await resolveValidationPlan(integrationPath, validationCommand);
  if (validation.status === "skipped") {
    commandsRun.push(`SKIP ${validation.command} (${validation.detail})`);
  }

  if (validation.status === "ran") {
    const validationRun = await runCommand("zsh", ["-lc", validation.command], { cwd: integrationPath });
    commandsRun.push(validation.command);
    if (validationRun.code !== 0) {
      throw new Error(
        `Validation command failed.\n${validationRun.stdout}\n${validationRun.stderr}`.trim()
      );
    }
  }

  const currentBranch = await getCurrentBranch(repoRoot).catch(() => "");
  if (currentBranch === targetBranch) {
    const mergeIntegration = await runCommand("git", ["merge", "--ff-only", integrationBranch], {
      cwd: repoRoot
    });
    commandsRun.push(`git merge --ff-only ${integrationBranch}`);
    if (mergeIntegration.code !== 0) {
      throw new Error(
        mergeIntegration.stderr.trim() ||
          `Unable to fast-forward ${targetBranch} to ${integrationBranch}.`
      );
    }
  } else {
    const updateRef = await runCommand(
      "git",
      ["update-ref", `refs/heads/${targetBranch}`, `refs/heads/${integrationBranch}`, targetHead],
      { cwd: repoRoot }
    );
    commandsRun.push(
      `git update-ref refs/heads/${targetBranch} refs/heads/${integrationBranch} ${targetHead}`
    );
    if (updateRef.code !== 0) {
      throw new Error(
        updateRef.stderr.trim() ||
          `Unable to advance ${targetBranch}; it changed while landing was in progress.`
      );
    }
  }

  const landedHead = await getBranchCommit(repoRoot, targetBranch);
  for (const worktree of worktrees) {
    const reset = await runCommand("git", ["reset", "--hard", landedHead], {
      cwd: worktree.path
    });
    commandsRun.push(`git -C ${worktree.path} reset --hard ${landedHead}`);
    if (reset.code !== 0) {
      throw new Error(
        reset.stderr.trim() ||
          `Unable to reset managed worktree ${worktree.path} to landed head ${landedHead}.`
      );
    }

    const clean = await runCommand("git", ["clean", "-fd"], { cwd: worktree.path });
    commandsRun.push(`git -C ${worktree.path} clean -fd`);
    if (clean.code !== 0) {
      throw new Error(
        clean.stderr.trim() || `Unable to clean managed worktree ${worktree.path}.`
      );
    }
  }

  return {
    commandsRun,
    integrationBranch,
    integrationPath,
    validation,
    snapshotCommits
  };
}

export async function createIntegrationWorkspace(
  repoRoot: string,
  targetBranch: string,
  worktrees: WorktreeInfo[],
  sessionId: string,
  integrationRoot: string
): Promise<IntegrationWorkspace> {
  const commandsRun: string[] = [];
  const snapshotCommits: IntegrationWorkspace["snapshotCommits"] = [];
  const targetHead = await getBranchCommit(repoRoot, targetBranch);
  const integrationId = buildSessionId().slice(0, 8);
  const integrationBranch = `kavi/integration/${sessionId}/${integrationId}`;
  const integrationPath = path.join(integrationRoot, `${sessionId}-${integrationId}`);

  await ensureDir(integrationRoot);
  const addIntegration = await runCommand(
    "git",
    ["worktree", "add", "-b", integrationBranch, integrationPath, targetHead],
    { cwd: repoRoot }
  );
  commandsRun.push(`git worktree add -b ${integrationBranch} ${integrationPath} ${targetHead}`);
  if (addIntegration.code !== 0) {
    throw new Error(
      addIntegration.stderr.trim() ||
        `Unable to create integration worktree at ${integrationPath}.`
    );
  }

  try {
    for (const worktree of worktrees) {
      const snapshot = await snapshotWorktree(worktree, sessionId);
      snapshotCommits.push(snapshot);
      if (snapshot.createdCommit) {
        commandsRun.push(`git -C ${worktree.path} add -A`);
        commandsRun.push(
          `git -C ${worktree.path} -c user.name=Kavi -c user.email=kavi@local.invalid commit -m "kavi: snapshot ${worktree.agent} ${sessionId}"`
        );
      }

      const merge = await runCommand("git", ["merge", "--no-ff", "--no-edit", worktree.branch], {
        cwd: integrationPath
      });
      commandsRun.push(`git -C ${integrationPath} merge --no-ff --no-edit ${worktree.branch}`);
      if (merge.code !== 0) {
        throw new Error(
          merge.stderr.trim() ||
            `Unable to merge branch ${worktree.branch} into integration branch ${integrationBranch}.`
        );
      }
    }

    return {
      commandsRun,
      integrationBranch,
      integrationPath,
      snapshotCommits
    };
  } catch (error) {
    await cleanupIntegrationWorkspace(repoRoot, {
      commandsRun,
      integrationBranch,
      integrationPath,
      snapshotCommits
    }).catch(() => {});
    throw error;
  }
}

export async function cleanupIntegrationWorkspace(
  repoRoot: string,
  workspace: Pick<IntegrationWorkspace, "integrationBranch" | "integrationPath">
): Promise<void> {
  const removeWorktree = await runCommand(
    "git",
    ["worktree", "remove", "--force", workspace.integrationPath],
    { cwd: repoRoot }
  );
  if (
    removeWorktree.code !== 0 &&
    !/not a working tree|does not exist|not found/i.test(removeWorktree.stderr)
  ) {
    throw new Error(
      removeWorktree.stderr.trim() ||
        `Unable to remove integration worktree ${workspace.integrationPath}.`
    );
  }

  const deleteBranch = await runCommand(
    "git",
    ["branch", "-D", workspace.integrationBranch],
    { cwd: repoRoot }
  );
  if (
    deleteBranch.code !== 0 &&
    !/not found|not exist|couldn't find/i.test(deleteBranch.stderr)
  ) {
    throw new Error(
      deleteBranch.stderr.trim() ||
        `Unable to delete integration branch ${workspace.integrationBranch}.`
    );
  }
}

async function snapshotWorktree(
  worktree: WorktreeInfo,
  sessionId: string
): Promise<{
  agent: AgentName;
  createdCommit: boolean;
  commit: string;
}> {
  const status = await runCommand("git", ["status", "--short"], { cwd: worktree.path });
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || `Unable to inspect worktree ${worktree.path}.`);
  }

  const changedPaths = await listWorktreeChangedPaths(worktree.path, "HEAD");
  if (!status.stdout.trim() || changedPaths.length === 0) {
    return {
      agent: worktree.agent,
      createdCommit: false,
      commit: await getBranchCommit(worktree.path, "HEAD")
    };
  }

  const add = await runCommand("git", ["add", "-A"], { cwd: worktree.path });
  if (add.code !== 0) {
    throw new Error(add.stderr.trim() || `Unable to stage worktree ${worktree.path}.`);
  }

  const stagedPaths = await runCommand("git", ["diff", "--cached", "--name-only"], {
    cwd: worktree.path
  });
  if (stagedPaths.code !== 0) {
    throw new Error(stagedPaths.stderr.trim() || `Unable to inspect staged worktree ${worktree.path}.`);
  }

  const ephemeralPaths = parsePathList(stagedPaths.stdout).filter((filePath) =>
    isEphemeralWorktreePath(filePath)
  );
  if (ephemeralPaths.length > 0) {
    const unstage = await runCommand("git", ["reset", "HEAD", "--", ...ephemeralPaths], {
      cwd: worktree.path
    });
    if (unstage.code !== 0) {
      throw new Error(
        unstage.stderr.trim() || `Unable to unstage ephemeral artifacts in ${worktree.path}.`
      );
    }
  }

  const stagedAfterFilter = await runCommand("git", ["diff", "--cached", "--name-only"], {
    cwd: worktree.path
  });
  if (stagedAfterFilter.code !== 0) {
    throw new Error(
      stagedAfterFilter.stderr.trim() || `Unable to inspect filtered staged worktree ${worktree.path}.`
    );
  }

  if (!stagedAfterFilter.stdout.trim()) {
    return {
      agent: worktree.agent,
      createdCommit: false,
      commit: await getBranchCommit(worktree.path, "HEAD")
    };
  }

  const commitMessage = `kavi: snapshot ${worktree.agent} ${sessionId}`;
  const commit = await runCommand(
    "git",
    [
      "-c",
      "user.name=Kavi",
      "-c",
      "user.email=kavi@local.invalid",
      "commit",
      "-m",
      commitMessage
    ],
    { cwd: worktree.path }
  );
  if (commit.code !== 0) {
    throw new Error(commit.stderr.trim() || `Unable to snapshot worktree ${worktree.path}.`);
  }

  return {
    agent: worktree.agent,
    createdCommit: true,
    commit: await getBranchCommit(worktree.path, "HEAD")
  };
}
