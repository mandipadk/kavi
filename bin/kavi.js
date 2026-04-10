#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function nodeMajor(version) {
  return Number(version.split(".")[0] ?? 0);
}

if (nodeMajor(process.versions.node) < 25) {
  console.error(`Kavi requires Node 25 or newer. Current runtime: ${process.version}`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntrypoint = path.join(here, "..", "dist", "main.js");
const srcEntrypoint = path.join(here, "..", "src", "main.ts");
const useDist = fs.existsSync(distEntrypoint);
const entrypoint = useDist ? distEntrypoint : srcEntrypoint;
const nodeArgs = useDist
  ? [entrypoint, ...process.argv.slice(2)]
  : ["--experimental-strip-types", entrypoint, ...process.argv.slice(2)];

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
