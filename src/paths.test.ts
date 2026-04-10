import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAppPaths } from "./paths.ts";

test("resolveAppPaths honors explicit home directory overrides", () => {
  process.env.KAVI_HOME_CONFIG_DIR = "/tmp/kavi-config-test";
  process.env.KAVI_HOME_STATE_DIR = "/tmp/kavi-state-test";

  const paths = resolveAppPaths("/tmp/repo");
  assert.equal(paths.homeConfigDir, "/tmp/kavi-config-test");
  assert.equal(paths.homeStateDir, "/tmp/kavi-state-test");
  assert.equal(
    paths.integrationRoot,
    `/tmp/kavi-state-test/integration/${path.basename(paths.worktreeRoot)}`
  );
  assert.equal(paths.reportsDir, "/tmp/repo/.kavi/state/reports");

  delete process.env.KAVI_HOME_CONFIG_DIR;
  delete process.env.KAVI_HOME_STATE_DIR;
});
