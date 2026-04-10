import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHomeConfig } from "./config.ts";
import type { AppPaths, SessionRuntime } from "./types.ts";

const MINIMUM_NODE_MAJOR = 25;

export function parseNodeMajor(version: string): number {
  const major = Number(version.split(".")[0] ?? "");
  return Number.isFinite(major) ? major : 0;
}

export function hasSupportedNode(version = process.versions.node): boolean {
  return parseNodeMajor(version) >= MINIMUM_NODE_MAJOR;
}

export function minimumNodeMajor(): number {
  return MINIMUM_NODE_MAJOR;
}

export function resolveKaviEntrypoint(): string {
  const runtimePath = fileURLToPath(import.meta.url);
  const extension = path.extname(runtimePath) || ".js";
  return fileURLToPath(new URL(`./main${extension}`, import.meta.url));
}

export async function resolveSessionRuntime(paths: AppPaths): Promise<SessionRuntime> {
  const homeConfig = await loadHomeConfig(paths);
  return {
    nodeExecutable: homeConfig.runtime.nodeBin.trim() || process.execPath,
    codexExecutable: homeConfig.runtime.codexBin.trim() || "codex",
    claudeExecutable: homeConfig.runtime.claudeBin.trim() || "claude",
    kaviEntryPoint: resolveKaviEntrypoint()
  };
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildKaviShellCommand(runtime: SessionRuntime, args: string[]): string {
  const needsTypeStripping = path.extname(runtime.kaviEntryPoint) === ".ts";
  return [
    shellEscape(runtime.nodeExecutable),
    ...(needsTypeStripping ? ["--experimental-strip-types"] : []),
    shellEscape(runtime.kaviEntryPoint),
    ...args.map((arg) => shellEscape(arg))
  ].join(" ");
}
