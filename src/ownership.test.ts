import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  buildOwnershipRouteDecision,
  findOwnershipRuleConflicts
} from "./ownership.ts";
import { previewRouteDecision } from "./router.ts";

test("buildOwnershipRouteDecision prefers the more specific matching ownership rule", () => {
  const config = defaultConfig();
  config.routing.codexPaths = ["src/**"];
  config.routing.claudePaths = ["src/ui/**"];

  const decision = buildOwnershipRouteDecision(["src/ui/App.tsx"], config);
  assert.equal(decision?.owner, "claude");
  assert.equal(
    (decision?.metadata.winningRule as Record<string, unknown>)?.pattern,
    "src/ui/**"
  );
});

test("previewRouteDecision surfaces ownership ambiguity when rules collide", () => {
  const config = defaultConfig();
  config.routing.codexPaths = ["src/ui/**"];
  config.routing.claudePaths = ["src/ui/**"];

  const preview = previewRouteDecision("Refactor src/ui/App.tsx", config);
  assert.equal(
    ((preview.metadata.ownershipAmbiguity as Record<string, unknown>)?.contenders as unknown[])?.length > 0,
    true
  );
});

test("findOwnershipRuleConflicts reports exact overlapping ownership rules", () => {
  const config = defaultConfig();
  config.routing.codexPaths = ["src/ui/**"];
  config.routing.claudePaths = ["src/ui/**"];

  const conflicts = findOwnershipRuleConflicts(config);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.kind, "exact");
});
