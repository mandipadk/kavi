import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists } from "./fs.ts";
import { parseToml } from "./toml.ts";
import type { AppPaths, HomeConfig, KaviConfig } from "./types.ts";

const DEFAULT_CONFIG = `version = 1
base_branch = "main"
validation_command = ""
message_limit = 6

[routing]
frontend_keywords = ["frontend", "ui", "ux", "design", "copy", "react", "css", "html"]
backend_keywords = ["backend", "api", "server", "db", "schema", "migration", "auth", "test"]
codex_paths = []
claude_paths = []

[agents.codex]
role = "planning-backend"
model = ""

[agents.claude]
role = "frontend-intent"
model = ""
`;

const DEFAULT_PROMPTS: Record<string, string> = {
  "codex.md": `You are Codex inside Kavi.

Default role:
- Own planning, architecture, backend, debugging, and review-heavy work.
- Keep updates compact and task-scoped.
- Emit peer messages only when they materially help Claude.
`,
  "claude.md": `You are Claude inside Kavi.

Default role:
- Own frontend, UX, intent-shaping, copy, and product-sense work.
- Keep updates compact and task-scoped.
- Emit peer messages only when they materially help Codex.
`
};

const DEFAULT_HOME_CONFIG = `version = 1

[runtime]
node_bin = ""
codex_bin = "codex"
claude_bin = "claude"
`;

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : fallback;
}

export function defaultConfig(): KaviConfig {
  return {
    version: 1,
    baseBranch: "main",
    validationCommand: "",
    messageLimit: 6,
    routing: {
      frontendKeywords: ["frontend", "ui", "ux", "design", "copy", "react", "css", "html"],
      backendKeywords: ["backend", "api", "server", "db", "schema", "migration", "auth", "test"],
      codexPaths: [],
      claudePaths: []
    },
    agents: {
      codex: {
        role: "planning-backend",
        model: ""
      },
      claude: {
        role: "frontend-intent",
        model: ""
      }
    }
  };
}

export function defaultHomeConfig(): HomeConfig {
  return {
    version: 1,
    runtime: {
      nodeBin: "",
      codexBin: "codex",
      claudeBin: "claude"
    }
  };
}

export async function ensureProjectScaffold(paths: AppPaths): Promise<void> {
  await ensureDir(paths.kaviDir);
  await ensureDir(paths.promptsDir);
  await ensureDir(paths.stateDir);
  await ensureDir(paths.reportsDir);
  await ensureDir(paths.runtimeDir);
  await ensureDir(paths.runsDir);

  if (!(await fileExists(paths.configFile))) {
    await fs.writeFile(paths.configFile, DEFAULT_CONFIG, "utf8");
  }

  for (const [fileName, content] of Object.entries(DEFAULT_PROMPTS)) {
    const promptPath = path.join(paths.promptsDir, fileName);
    if (!(await fileExists(promptPath))) {
      await fs.writeFile(promptPath, content, "utf8");
    }
  }
}

export async function ensureHomeConfig(paths: AppPaths): Promise<void> {
  await ensureDir(paths.homeConfigDir);

  if (!(await fileExists(paths.homeConfigFile))) {
    await fs.writeFile(paths.homeConfigFile, DEFAULT_HOME_CONFIG, "utf8");
  }
}

export async function loadConfig(paths: AppPaths): Promise<KaviConfig> {
  if (!(await fileExists(paths.configFile))) {
    return defaultConfig();
  }

  const content = await fs.readFile(paths.configFile, "utf8");
  const parsed = parseToml(content);
  const routing = (parsed.routing ?? {}) as Record<string, unknown>;
  const agents = (parsed.agents ?? {}) as Record<string, unknown>;
  const codex = (agents.codex ?? {}) as Record<string, unknown>;
  const claude = (agents.claude ?? {}) as Record<string, unknown>;

  return {
    version: asNumber(parsed.version, 1),
    baseBranch: asString(parsed.base_branch, "main"),
    validationCommand: asString(parsed.validation_command, ""),
    messageLimit: asNumber(parsed.message_limit, 6),
    routing: {
      frontendKeywords: asStringArray(
        routing.frontend_keywords,
        defaultConfig().routing.frontendKeywords
      ),
      backendKeywords: asStringArray(
        routing.backend_keywords,
        defaultConfig().routing.backendKeywords
      ),
      codexPaths: asStringArray(
        routing.codex_paths,
        defaultConfig().routing.codexPaths
      ),
      claudePaths: asStringArray(
        routing.claude_paths,
        defaultConfig().routing.claudePaths
      )
    },
    agents: {
      codex: {
        role: asString(codex.role, "planning-backend"),
        model: asString(codex.model, "")
      },
      claude: {
        role: asString(claude.role, "frontend-intent"),
        model: asString(claude.model, "")
      }
    }
  };
}

export async function loadHomeConfig(paths: AppPaths): Promise<HomeConfig> {
  if (!(await fileExists(paths.homeConfigFile))) {
    return defaultHomeConfig();
  }

  const content = await fs.readFile(paths.homeConfigFile, "utf8");
  const parsed = parseToml(content);
  const runtime = (parsed.runtime ?? {}) as Record<string, unknown>;

  return {
    version: asNumber(parsed.version, 1),
    runtime: {
      nodeBin: asString(runtime.node_bin, ""),
      codexBin: asString(runtime.codex_bin, "codex"),
      claudeBin: asString(runtime.claude_bin, "claude")
    }
  };
}
