#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");

function rewriteTypeScriptSpecifiers(source) {
  return source
    .replaceAll(/(from\s+["'])([^"']+)\.ts(["'])/g, "$1$2.js$3")
    .replaceAll(/(import\s*\(\s*["'])([^"']+)\.ts(["']\s*\))/g, "$1$2.js$3")
    .replaceAll(/(export\s+\*\s+from\s+["'])([^"']+)\.ts(["'])/g, "$1$2.js$3");
}

async function listSourceFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

async function cleanDist() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });
}

async function buildFile(filePath) {
  const relativePath = path.relative(srcDir, filePath);
  const outputPath = path.join(distDir, relativePath.replace(/\.ts$/, ".js"));
  const source = await fs.readFile(filePath, "utf8");
  const transformed = stripTypeScriptTypes(source, {
    mode: "transform",
    sourceUrl: relativePath
  });
  const output = rewriteTypeScriptSpecifiers(transformed);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output, "utf8");
}

async function main() {
  await cleanDist();
  const files = await listSourceFiles(srcDir);

  for (const filePath of files) {
    await buildFile(filePath);
  }

  console.log(`Built ${files.length} files into ${distDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
