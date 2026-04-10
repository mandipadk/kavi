import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "./paths.ts";
import {
  buildLandReport,
  listLandReports,
  loadLatestLandReport,
  saveLandReport
} from "./reports.ts";

test("land reports can be written, listed, and loaded", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kavi-reports-"));
  const paths = resolveAppPaths(repoRoot);

  const olderReport = buildLandReport({
    id: "land-1",
    sessionId: "session-1",
    goal: "Ship the feature",
    createdAt: "2026-03-25T00:00:00.000Z",
    targetBranch: "main",
    integrationBranch: "kavi/integration/one",
    integrationPath: "/tmp/integration/one",
    validationCommand: "npm test",
    validationStatus: "ran",
    validationDetail: "Validation ran with \"npm test\".",
    changedByAgent: [
      {
        agent: "codex",
        paths: ["src/server.ts"]
      }
    ],
    completedTasks: [
      {
        taskId: "task-1",
        owner: "codex",
        title: "Build API",
        summary: "done",
        claimedPaths: ["src/server.ts"],
        finishedAt: "2026-03-25T00:00:00.000Z"
      }
    ],
    snapshotCommits: [],
    commandsRun: ["npm test"],
    reviewThreadsLanded: 1,
    openReviewThreadsRemaining: 0
  });
  const newerReport = buildLandReport({
    ...olderReport,
    id: "land-2",
    createdAt: "2026-03-25T01:00:00.000Z",
    targetBranch: "release"
  });

  await saveLandReport(paths, olderReport);
  await saveLandReport(paths, newerReport);

  const listed = await listLandReports(paths);
  assert.deepEqual(
    listed.map((report) => report.id),
    ["land-2", "land-1"]
  );

  const latest = await loadLatestLandReport(paths);
  assert.equal(latest?.id, "land-2");
  assert.equal(latest?.targetBranch, "release");
});
