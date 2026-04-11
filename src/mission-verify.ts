import process from "node:process";
import {
  acceptanceFailureFingerprint,
  buildAcceptanceFailurePacks,
  buildAcceptanceRepairPrompt,
  compileAcceptanceRepairPlans,
  evaluateAcceptanceCheck,
  failingAcceptanceChecks,
  planAcceptanceRepairs,
  summarizeAcceptanceFailures,
  synthesizeMissionAcceptanceChecks
} from "./acceptance.ts";
import { addDecisionRecord, buildClaimHotspots } from "./decision-ledger.ts";
import { cleanupIntegrationWorkspace, createIntegrationWorkspace } from "./git.ts";
import { addMissionCheckpoint, missionHasInFlightTasks, refreshMissionAcceptance, syncMissionStates } from "./missions.ts";
import { captureMissionAntiPatterns } from "./patterns.ts";
import { runCommand } from "./process.ts";
import { buildAdHocTask, previewRouteDecision } from "./router.ts";
import { loadSessionRecord, recordEvent, saveSessionRecord } from "./session.ts";
import type { AppPaths, Mission, SessionRecord } from "./types.ts";

export function assertMissionVerificationReady(session: SessionRecord, mission: Mission): void {
  if (missionHasInFlightTasks(session, mission.id)) {
    throw new Error(
      "Mission verification is blocked because tasks are still pending or running. Wait for active work to finish before running `kavi verify`."
    );
  }

  const hotspots = buildClaimHotspots(session).filter((hotspot) =>
    hotspot.taskIds.some((taskId) =>
      session.tasks.some((task) => task.id === taskId && task.missionId === mission.id)
    )
  );
  if (hotspots.length > 0) {
    throw new Error(
      `Mission verification is blocked because overlapping path claims still need integration review: ${hotspots
        .map((hotspot) => hotspot.path)
        .join(", ")}. Review \`kavi recommend\` or resolve the overlap before running \`kavi verify\`.`
    );
  }
}

export async function verifyMissionAcceptanceById(
  paths: AppPaths,
  missionId: string
): Promise<Mission | null> {
  const session = await loadSessionRecord(paths);
  const mission = session.missions.find((item) => item.id === missionId) ?? null;
  if (!mission) {
    throw new Error(`Mission ${missionId} was not found.`);
  }
  assertMissionVerificationReady(session, mission);

  const verificationWorkspace = await createIntegrationWorkspace(
    session.repoRoot,
    session.config.baseBranch,
    session.worktrees,
    session.id,
    paths.integrationRoot
  );

  try {
    await synthesizeMissionAcceptanceChecks(verificationWorkspace.integrationPath, session, mission);
    const shell = process.env.SHELL || "zsh";
    for (const check of mission.acceptance.checks) {
      if (
        check.kind === "file" ||
        check.kind === "scenario" ||
        check.kind === "contract" ||
        check.kind === "docs" ||
        check.kind === "http" ||
        check.kind === "browser"
      ) {
        const evaluation = await evaluateAcceptanceCheck(
          verificationWorkspace.integrationPath,
          mission,
          check
        );
        check.status = evaluation.status;
        check.lastRunAt = new Date().toISOString();
        check.lastOutput = evaluation.lastOutput;
        check.detail = evaluation.detail;
        continue;
      }

      if (check.kind !== "command" || !check.command) {
        check.status = check.status === "pending" ? "skipped" : check.status;
        check.lastRunAt = new Date().toISOString();
        check.lastOutput = "Acknowledged during mission verification.";
        continue;
      }

      const result = await runCommand(shell, ["-lc", check.command], {
        cwd: verificationWorkspace.integrationPath
      });
      check.status = result.code === 0 ? "passed" : "failed";
      check.lastRunAt = new Date().toISOString();
      check.lastOutput = [result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000);
      check.detail = result.code === 0 ? `Passed: ${check.command}` : `Failed (${result.code}): ${check.command}`;
    }
  } finally {
    await cleanupIntegrationWorkspace(session.repoRoot, verificationWorkspace).catch(() => {});
  }

  refreshMissionAcceptance(mission);
  if (mission.acceptance.status !== "failed") {
    mission.acceptance.failurePacks = [];
    mission.acceptance.repairPlans = (mission.acceptance.repairPlans ?? []).map((plan) => ({
      ...plan,
      status: "applied",
      updatedAt: new Date().toISOString()
    }));
  }
  if (mission.acceptance.status === "failed") {
    const failurePacks = buildAcceptanceFailurePacks(mission);
    mission.acceptance.failurePacks = failurePacks;
    await captureMissionAntiPatterns(paths, session, mission);
    const failureFingerprint = acceptanceFailureFingerprint(mission);
    const openRepairFingerprints = new Set(session.tasks
      .filter((task) => {
        if (task.missionId !== mission.id) {
          return false;
        }
        if (!(task.status === "pending" || task.status === "running" || task.status === "blocked")) {
          return false;
        }
        return task.routeMetadata?.source === "acceptance-repair";
      })
      .map((task) =>
        typeof task.routeMetadata?.failureFingerprint === "string"
          ? task.routeMetadata.failureFingerprint
          : null
      )
      .filter((value): value is string => Boolean(value)));
    const hasOpenRepair = session.tasks.some((task) => {
      if (task.missionId !== mission.id) {
        return false;
      }
      if (!(task.status === "pending" || task.status === "running" || task.status === "blocked")) {
        return false;
      }
      return (
        task.routeMetadata?.source === "acceptance-repair" &&
        task.routeMetadata?.failureFingerprint === failureFingerprint
      );
    });
    const routePlans = planAcceptanceRepairs(
      session,
      mission,
      previewRouteDecision(buildAcceptanceRepairPrompt(mission), session.config, session)
    );
    const compiledRepairPlans = compileAcceptanceRepairPlans(mission, routePlans, failurePacks);
    for (const plan of compiledRepairPlans) {
      const existingTask = session.tasks.find((task) =>
        task.missionId === mission.id &&
        (task.status === "pending" || task.status === "running" || task.status === "blocked") &&
        task.routeMetadata?.source === "acceptance-repair" &&
        task.routeMetadata?.failureFingerprint === plan.failureFingerprint &&
        task.owner === plan.owner
      );
      if (existingTask) {
        plan.status = "queued";
        plan.queuedTaskId = existingTask.id;
        plan.updatedAt = new Date().toISOString();
      }
    }
    mission.acceptance.repairPlans = compiledRepairPlans;

    if (mission.autopilotEnabled && !hasOpenRepair && failingAcceptanceChecks(mission).length > 0) {
      const queuedRepairTasks = routePlans
        .filter((plan) => !openRepairFingerprints.has(plan.failureFingerprint))
        .map((plan, index) => {
          const taskId = `task-acceptance-repair-${Date.now()}-${index + 1}`;
          const titleSuffix =
            routePlans.length > 1 ? ` (${plan.owner})` : "";
          const task = buildAdHocTask(plan.owner, plan.prompt, taskId, {
            missionId: mission.id,
            title: `Repair acceptance failures for ${mission.title}${titleSuffix}`,
            kind: "integration",
            nodeKind: "repair",
            retryCount: 0,
            maxRetries: Math.max(1, mission.policy?.retryBudget ?? 1),
            routeReason: plan.routeReason,
            routeStrategy: plan.routeStrategy,
            routeConfidence: plan.routeConfidence,
            routeMetadata: {
              ...plan.routeMetadata,
              source: "acceptance-repair",
              failureFingerprint: plan.failureFingerprint,
              failedChecks: plan.failedChecks.map((check) => check.id),
              groupedRepair: routePlans.length > 1
            },
            claimedPaths:
              plan.claimedPaths.length > 0
                ? plan.claimedPaths
                : plan.failedChecks
                    .map((check) => check.path)
                    .filter((value): value is string => Boolean(value))
          });
          session.tasks.push(task);
          const compiledPlan = mission.acceptance.repairPlans.find((item) =>
            item.failureFingerprint === plan.failureFingerprint && item.owner === plan.owner
          );
          if (compiledPlan) {
            compiledPlan.status = "queued";
            compiledPlan.queuedTaskId = task.id;
            compiledPlan.updatedAt = new Date().toISOString();
          }
          return task;
        });

      for (const repairTask of queuedRepairTasks) {
        addMissionCheckpoint(session, mission.id, {
          kind: "repair_queued",
          title: "Acceptance repair queued",
          detail: summarizeAcceptanceFailures(mission).join(" | ").slice(0, 600),
          taskId: repairTask.id
        });
        addDecisionRecord(session, {
          kind: "plan",
          agent: repairTask.owner,
          taskId: repairTask.id,
          summary: `Queued acceptance repair task for ${repairTask.owner}`,
          detail: `Acceptance failed for ${mission.title}; Kavi queued a repair loop automatically.`,
          metadata: {
            missionId: mission.id,
            failureFingerprint:
              typeof repairTask.routeMetadata.failureFingerprint === "string"
                ? repairTask.routeMetadata.failureFingerprint
                : failureFingerprint,
            failedChecks:
              Array.isArray(repairTask.routeMetadata.failedChecks)
                ? repairTask.routeMetadata.failedChecks
                : failingAcceptanceChecks(mission).map((check) => check.title)
          }
        });
      }
    }
  }
  mission.checkpoints.push({
    id: `checkpoint-verify-${Date.now()}`,
    kind: "acceptance_verified",
    title: "Acceptance verified",
    detail: `Acceptance pack is now ${mission.acceptance.status}.`,
    taskId: null,
    createdAt: new Date().toISOString()
  });
  syncMissionStates(session);
  await saveSessionRecord(paths, session);
  await recordEvent(paths, session.id, "mission.acceptance_verified", {
    missionId: mission.id,
    acceptanceStatus: mission.acceptance.status
  });
  return session.missions.find((item) => item.id === missionId) ?? null;
}
