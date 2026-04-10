import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { filterWorktreeChangedPaths, isEphemeralWorktreePath, resolveValidationPlan } from "./git.ts";

test("resolveValidationPlan skips the default npm test placeholder without package.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-git-validation-"));
  const plan = await resolveValidationPlan(root, "npm test");

  assert.equal(plan.status, "skipped");
  assert.match(plan.detail, /package\.json is not present yet/i);
});

test("resolveValidationPlan runs npm test when package.json exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-git-validation-"));
  await writeFile(path.join(root, "package.json"), "{\n  \"name\": \"smoke\"\n}\n", "utf8");

  const plan = await resolveValidationPlan(root, "npm test");
  assert.equal(plan.status, "ran");
});

test("resolveValidationPlan handles no validation command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kavi-git-validation-"));
  const plan = await resolveValidationPlan(root, "");

  assert.equal(plan.status, "not_configured");
});

test("isEphemeralWorktreePath identifies cache and generated artifact paths", () => {
  assert.equal(isEphemeralWorktreePath("tests/__pycache__/test_smoke.cpython-314.pyc"), true);
  assert.equal(isEphemeralWorktreePath("node_modules/react/index.js"), true);
  assert.equal(isEphemeralWorktreePath(".next/cache/webpack/client-development/index"), true);
  assert.equal(isEphemeralWorktreePath("src/app.ts"), false);
  assert.equal(isEphemeralWorktreePath("README.md"), false);
});

test("filterWorktreeChangedPaths strips ephemeral artifacts from the changed surface", () => {
  assert.deepEqual(
    filterWorktreeChangedPaths([
      "README.md",
      "tests/__pycache__/test_smoke.cpython-314.pyc",
      "src/app.ts",
      "node_modules/react/index.js",
      "src/app.ts"
    ]),
    ["README.md", "src/app.ts"]
  );
});
