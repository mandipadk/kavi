#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {
    tag: null,
    version: null,
    dryRun: false,
    allowDowngrade: false,
    promoteExisting: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      args.tag = arg.slice("--tag=".length);
      continue;
    }

    if (arg === "--version") {
      args.version = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      args.version = arg.slice("--version=".length);
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--allow-downgrade") {
      args.allowDowngrade = true;
      continue;
    }

    if (arg === "--promote-existing") {
      args.promoteExisting = true;
    }
  }

  return args;
}

function isValidSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function compareSemver(left, right) {
  const leftMatch = left.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  const rightMatch = right.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  if (!leftMatch || !rightMatch) {
    return 0;
  }

  const leftParts = leftMatch.slice(1, 4).map((part) => Number(part));
  const rightParts = rightMatch.slice(1, 4).map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function nextPatchVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    return version;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

function packageHomepage(packageName) {
  return `https://www.npmjs.com/package/${packageName}`;
}

function buildPublishedPackageJson(packageJson, version) {
  const published = {
    ...packageJson,
    version,
    homepage: packageHomepage(packageJson.name)
  };

  delete published.repository;
  delete published.bugs;
  return published;
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited on signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

async function runCapture(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited on signal ${signal}`));
        return;
      }

      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function registryVersionExists(packageName, version, cwd) {
  const result = await runCapture("npm", ["view", `${packageName}@${version}`, "version", "--json"], cwd);
  if (result.code === 0) {
    return true;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found|No match found/i.test(output)) {
    return false;
  }

  throw new Error(
    `Unable to query npm registry for ${packageName}@${version}.\n${output.trim()}`
  );
}

async function promptPromoteExisting(packageName, version, tag) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question(
      `${packageName}@${version} already exists on npm. Promote the existing published version to tag ${tag} instead of republishing? [Y/n]: `
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function promptReleaseInfo(currentVersion, defaultTag, requestedVersion) {
  if (requestedVersion) {
    if (!isValidSemver(requestedVersion)) {
      throw new Error(`Invalid version: ${requestedVersion}`);
    }

    return {
      version: requestedVersion,
      tag: defaultTag
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const suggestedVersion = nextPatchVersion(currentVersion);
    const versionAnswer = await rl.question(`Version to publish [${suggestedVersion}]: `);
    const version = versionAnswer.trim() || suggestedVersion;
    if (!isValidSemver(version)) {
      throw new Error(`Invalid version: ${version}`);
    }

    const tagAnswer = await rl.question(`Tag to publish [${defaultTag}]: `);
    const tag = (tagAnswer.trim() || defaultTag).toLowerCase();
    if (!["beta", "latest"].includes(tag)) {
      throw new Error(`Unsupported tag: ${tag}`);
    }

    return { version, tag };
  } finally {
    rl.close();
  }
}

async function main() {
  if (
    process.env.npm_lifecycle_event === "publish" &&
    process.env.npm_command === "publish"
  ) {
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(scriptDir, "..");
  const packageFile = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8"));
  const packageName = String(packageJson.name);
  const args = parseArgs(process.argv.slice(2));
  const defaultTag = args.tag === "latest" ? "latest" : "beta";
  const { version, tag } = await promptReleaseInfo(
    packageJson.version,
    defaultTag,
    args.version
  );
  if (!args.allowDowngrade && compareSemver(version, packageJson.version) < 0) {
    throw new Error(
      `Refusing to downgrade package version from ${packageJson.version} to ${version}. Re-run with --allow-downgrade if that is intentional.`
    );
  }

  if (!args.dryRun) {
    const exists = await registryVersionExists(packageName, version, repoRoot);
    if (exists) {
      const promoteExisting =
        args.promoteExisting || (await promptPromoteExisting(packageName, version, tag));
      if (!promoteExisting) {
        throw new Error(
          `${packageName}@${version} already exists on npm. Choose a new version, or re-run with --promote-existing to move an existing version onto the ${tag} tag.`
        );
      }

      console.log(`Promoting existing ${packageName}@${version} to dist-tag ${tag}.`);
      console.log(`Package homepage remains ${packageHomepage(packageName)}.`);
      await run("npm", ["dist-tag", "add", `${packageName}@${version}`, tag], repoRoot);
      return;
    }
  }

  const restoredPackageJson = {
    ...packageJson,
    version: args.dryRun ? packageJson.version : version
  };
  const publishPackageJson = buildPublishedPackageJson(restoredPackageJson, version);
  await fs.writeFile(packageFile, `${JSON.stringify(publishPackageJson, null, 2)}\n`, "utf8");

  try {
    if (version !== packageJson.version) {
      console.log(`Prepared package version: ${packageJson.version} -> ${version}`);
    } else {
      console.log(`Publishing existing package version ${version}`);
    }

    console.log(
      `Publish package metadata uses the bundled README, strips private GitHub links, and points homepage to ${packageHomepage(packageName)}.`
    );

    await run("npm", ["run", "release:check"], repoRoot);

    if (args.dryRun) {
      console.log(
        `Dry run complete. Next publish command: npm publish --access public${tag !== "latest" ? ` --tag ${tag}` : ""}`
      );
      return;
    }

    const publishArgs = ["publish", "--access", "public"];
    if (tag !== "latest") {
      publishArgs.push("--tag", tag);
    }

    await run("npm", publishArgs, repoRoot);
  } finally {
    await fs.writeFile(packageFile, `${JSON.stringify(restoredPackageJson, null, 2)}\n`, "utf8");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
