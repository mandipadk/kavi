export interface UpdatePlan {
  targetSpecifier: string;
  installArgs: string[];
  viewArgs: string[];
}

export function buildUpdatePlan(
  packageName: string,
  options: {
    tag?: string | null;
    version?: string | null;
  } = {}
): UpdatePlan {
  const targetSpecifier = options.version ?? options.tag ?? "latest";
  return {
    targetSpecifier,
    installArgs: ["install", "-g", `${packageName}@${targetSpecifier}`],
    viewArgs: ["view", `${packageName}@${targetSpecifier}`, "version", "--json"]
  };
}

export function parseRegistryVersion(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") {
      return parsed;
    }

    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return parsed[0];
    }
  } catch {
    // fall through to raw parsing
  }

  return trimmed.replaceAll(/^"+|"+$/g, "");
}
