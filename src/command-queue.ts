import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { ensureDir, fileExists } from "./fs.ts";
import { nowIso } from "./paths.ts";
import type { AppPaths } from "./types.ts";

export interface QueuedCommand {
  id: string;
  type: "kickoff" | "enqueue" | "shutdown";
  createdAt: string;
  payload: Record<string, unknown>;
}

export async function appendCommand(
  paths: AppPaths,
  type: QueuedCommand["type"],
  payload: Record<string, unknown>
): Promise<QueuedCommand> {
  const command: QueuedCommand = {
    id: randomUUID(),
    type,
    createdAt: nowIso(),
    payload
  };

  await ensureDir(paths.runtimeDir);
  await fs.appendFile(paths.commandsFile, `${JSON.stringify(command)}\n`, "utf8");
  return command;
}

export async function consumeCommands(paths: AppPaths): Promise<QueuedCommand[]> {
  if (!(await fileExists(paths.commandsFile))) {
    return [];
  }

  const content = await fs.readFile(paths.commandsFile, "utf8");
  await fs.writeFile(paths.commandsFile, "", "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as QueuedCommand);
}
