import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.ts";

const MAIN_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

function buildTestEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KAVI_HOME_CONFIG_DIR: path.join(root, "home-config"),
    KAVI_HOME_STATE_DIR: path.join(root, "home-state")
  };
}

test("kavi init bootstraps an empty folder into a git-backed Kavi project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-init-"));
  const env = buildTestEnv(root);

  const result = await runCommand(
    process.execPath,
    ["--experimental-strip-types", MAIN_ENTRY, "init", "--home"],
    {
      cwd: root,
      env
    }
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Initialized git repository in/);
  assert.match(result.stdout, /Created bootstrap commit/);

  const head = await runCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    env
  });
  assert.equal(head.code, 0, head.stderr);

  const tree = await runCommand("git", ["ls-tree", "--name-only", "-r", "HEAD"], {
    cwd: root,
    env
  });
  assert.equal(tree.code, 0, tree.stderr);
  assert.match(tree.stdout, /\.gitignore/);
  assert.match(tree.stdout, /\.kavi\/config\.toml/);
  assert.match(tree.stdout, /\.kavi\/prompts\/codex\.md/);
  assert.match(tree.stdout, /\.kavi\/prompts\/claude\.md/);

  const homeConfig = await readFile(path.join(root, "home-config", "config.toml"), "utf8");
  assert.match(homeConfig, /\[runtime\]/);
});

test("kavi init seeds the first commit in an existing repo without HEAD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-init-no-head-"));
  const env = buildTestEnv(root);

  const initRepo = await runCommand("git", ["init"], {
    cwd: root,
    env
  });
  assert.equal(initRepo.code, 0, initRepo.stderr);

  await writeFile(path.join(root, "README.md"), "# Fresh app\n", "utf8");

  const result = await runCommand(
    process.execPath,
    ["--experimental-strip-types", MAIN_ENTRY, "init"],
    {
      cwd: root,
      env
    }
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Created bootstrap commit/);

  const tree = await runCommand("git", ["ls-tree", "--name-only", "-r", "HEAD"], {
    cwd: root,
    env
  });
  assert.equal(tree.code, 0, tree.stderr);
  assert.match(tree.stdout, /README\.md/);
  assert.match(tree.stdout, /\.kavi\/config\.toml/);

  const log = await runCommand("git", ["log", "--format=%s", "-1"], {
    cwd: root,
    env
  });
  assert.equal(log.code, 0, log.stderr);
  assert.equal(log.stdout.trim(), "kavi: bootstrap project");
});
