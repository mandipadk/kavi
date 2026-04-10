import process from "node:process";

export type ParsedCliInvocation = {
  command: string,
  args: string[],
  cwd: string
};

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseCliInvocation(argv: string[], fallbackCwd = process.cwd()): ParsedCliInvocation {
  let command: string | null = null;
  let cwd = fallbackCwd;
  const args: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if ((token === "--cwd" || token === "--repo-root")) {
      cwd = readFlagValue(argv, index, token);
      index += 1;
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }

    args.push(token);
  }

  return {
    command: command ?? "open",
    args,
    cwd
  };
}
