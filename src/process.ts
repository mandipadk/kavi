import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions extends SpawnOptionsWithoutStdio {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const {
      onStdoutChunk,
      onStderrChunk,
      ...spawnOptions
    } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onStdoutChunk?.(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      onStderrChunk?.(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        code: options.signal?.aborted ? 124 : 127,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runInteractiveCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited on signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

export function spawnDetachedNode(nodeExecutable: string, args: string[], cwd: string): number {
  const child = spawn(nodeExecutable, ["--experimental-strip-types", ...args], {
    cwd,
    detached: true,
    stdio: "ignore"
  });

  child.unref();
  return child.pid ?? -1;
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
