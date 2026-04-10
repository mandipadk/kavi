import test from "node:test";
import assert from "node:assert/strict";
import { buildUpdatePlan, parseRegistryVersion } from "./update.ts";

test("buildUpdatePlan builds npm install and lookup args", () => {
  const plan = buildUpdatePlan("@mandipadk7/kavi", {
    tag: "beta"
  });

  assert.equal(plan.targetSpecifier, "beta");
  assert.deepEqual(plan.installArgs, ["install", "-g", "@mandipadk7/kavi@beta"]);
  assert.deepEqual(plan.viewArgs, ["view", "@mandipadk7/kavi@beta", "version", "--json"]);
});

test("parseRegistryVersion handles json strings, arrays, and raw output", () => {
  assert.equal(parseRegistryVersion('"0.1.6"'), "0.1.6");
  assert.equal(parseRegistryVersion('["0.1.6"]'), "0.1.6");
  assert.equal(parseRegistryVersion("0.1.6"), "0.1.6");
});
