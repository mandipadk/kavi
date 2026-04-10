import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "./fs.ts";
import type { AgentName, AppPaths } from "./types.ts";

export async function loadAgentPrompt(paths: AppPaths, agent: AgentName): Promise<string> {
  const promptPath = path.join(paths.promptsDir, `${agent}.md`);
  if (!(await fileExists(promptPath))) {
    return "";
  }

  return (await fs.readFile(promptPath, "utf8")).trim();
}
