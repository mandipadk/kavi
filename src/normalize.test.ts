import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskSpec } from "./normalize.ts";

test("normalizeTaskSpec fills missing planning arrays and metadata", () => {
  const normalized = normalizeTaskSpec({
    id: "task-1",
    title: "Legacy task",
    owner: "claude",
    status: "completed",
    prompt: "do the work",
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:01:00.000Z",
    planId: "plan-1"
  });

  assert.equal(normalized.kind, "execution");
  assert.deepEqual(normalized.dependsOnTaskIds, []);
  assert.deepEqual(normalized.claimedPaths, []);
  assert.deepEqual(normalized.routeMetadata, {});
  assert.equal(normalized.parentTaskId, null);
  assert.equal(normalized.planNodeKey, null);
  assert.equal(normalized.routeStrategy, null);
  assert.equal(normalized.routeConfidence, null);
});
