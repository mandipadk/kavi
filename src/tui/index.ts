import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import { buildBrainGraph, explainBrainEntry, filterBrainGraphMode, queryBrainEntries, relatedBrainEntries } from "../brain.ts";
import {
  evaluateDaemonCompatibility,
  formatRestartRequiredMessage,
  loadRuntimeIdentity,
  type DaemonCompatibility,
  type KaviRuntimeIdentity
} from "../compatibility.ts";
import { compareMissionFamily, compareMissions } from "../mission-compare.ts";
import { buildClaimHotspots } from "../decision-ledger.ts";
import {
  backspaceEditorText,
  clearEditorState,
  countEditorLines,
  deleteEditorText,
  editorCursorPosition,
  insertEditorText,
  moveEditorCursor,
  normalizeEditorInputChunk,
  type TextEditorState
} from "../editor.ts";
import { executeLand } from "../landing.ts";
import { normalizeTaskSpec, normalizeTaskSpecs } from "../normalize.ts";
import { findOwnershipRuleConflicts } from "../ownership.ts";
import { currentExecutionPlan, decidePlanningMode } from "../planning.ts";
import {
  activeFollowUpRecommendations,
  buildOperatorRecommendations,
  buildRecommendationActionPlan
} from "../recommendations.ts";
import { cycleReviewAssignee, reviewNoteMatchesFilters } from "../reviews.ts";
import {
  extractPromptPathHints,
  previewRouteDecision,
  routeTask
} from "../router.ts";
import {
  pingRpc,
  rpcAddReviewNote,
  rpcAddReviewReply,
  rpcDismissRecommendation,
  rpcEnqueueReviewFollowUp,
  rpcNotifyExternalUpdate,
  readSnapshot,
  rpcEnqueueTask,
  rpcLand,
  rpcUpdateMissionPolicy,
  rpcRetireBrainEntry,
  rpcRetryTask,
  rpcResolveApproval,
  rpcSetBrainEntryPinned,
  rpcSetFullAccessMode,
  rpcRestoreRecommendation,
  rpcSetReviewNoteStatus,
  rpcShutdown,
  rpcTaskArtifact,
  rpcUpdateReviewNote,
  rpcWorktreeDiff,
  subscribeSnapshotRpc
} from "../rpc.ts";
import type {
  AgentName,
  AppPaths,
  ApprovalRequest,
  BrainEntry,
  DecisionRecord,
  KaviSnapshot,
  KaviWorktreeDiff,
  OperatorRecommendation,
  PathClaim,
  PeerMessage,
  ReviewAssignee,
  ReviewDisposition,
  ReviewNote,
  TaskArtifact,
  TaskSpec,
  WorktreeDiffReview,
  WorktreeInfo
} from "../types.ts";
import {
  buildWorkflowActivity,
  buildWorkflowResult,
  buildWorkflowSummary,
  type WorkflowActivityEntry,
  type WorkflowResult
} from "../workflow.ts";
import {
  RESET,
  ANSI_PATTERN,
  STYLES,
  THEME,
  styleLine,
  spinner,
  advanceSpinner,
  fg,
  bgColor
} from "./theme.ts";
import {
  stripAnsi,
  visibleLength,
  sliceAnsi,
  fitAnsiLine,
  wrapText,
  wrapPreformatted,
  section,
  renderKV,
  truncateValue,
  shortTime,
  statusTone,
  statusSymbol,
  toneLine
} from "./primitives.ts";
import {
  OPERATOR_TABS,
  TASK_DETAIL_SECTIONS,
  nextComposerOwner,
  nextComposerPlanningMode,
  type OperatorTab,
  type TaskDetailSection,
  type ComposerOwner,
  type ToastLevel,
  type ManagedAgent,
  type OperatorView,
  type ArtifactCacheEntry,
  type DiffReviewCacheEntry,
  type OperatorToast,
  type ComposerState,
  type BrainFilterState,
  type ReviewComposerState,
  type ReviewFilterState,
  type CommandPaletteEntry,
  type CommandPaletteState,
  type ConfirmDialogState,
  type OperatorUiState,
  type OperatorListItem,
  type Column,
  type ReviewContext
} from "./state.ts";
import {
  parseDiffHunks,
  renderEditorViewport,
  styleDiffLine,
  renderStyledDiffBlock,
  type ParsedDiffHunk
} from "./diff.ts";

export {
  OPERATOR_TABS,
  filteredMissionBrainEntries,
  relatedBrainEntriesForSelection,
  graphNeighborEntriesForSelection,
  nextComposerOwner,
  wrapText,
  parseDiffHunks,
  type OperatorTab,
  type OperatorListItem,
  type ParsedDiffHunk
};

const SUBSCRIPTION_RETRY_MS = 1_000;
const TOAST_DURATION_MS = 4_500;

function panelTone(title: string): keyof typeof STYLES | null {
  if (title.startsWith("Codex Lane")) {
    return "codex";
  }

  if (title.startsWith("Claude Lane")) {
    return "claude";
  }

  if (title.includes("Result")) {
    return "good";
  }

  if (title.includes("Approval") || title.includes("Recommendation")) {
    return "warn";
  }

  if (title.includes("Claim")) {
    return "bad";
  }

  if (title.includes("Activity") || title.includes("Decision") || title.startsWith("Board")) {
    return "accent";
  }

  return null;
}

function countTasks(tasks: TaskSpec[], status: TaskSpec["status"]): number {
  return tasks.filter((task) => task.status === status).length;
}

function countOpenReviewNotes(snapshot: KaviSnapshot | null, agent?: ManagedAgent): number {
  if (!snapshot) {
    return 0;
  }

  return snapshot.session.reviewNotes.filter((note) =>
    note.status === "open" && (agent ? note.agent === agent : true)
  ).length;
}

function changedPathCount(diff: KaviWorktreeDiff | undefined): number {
  return diff?.paths.length ?? 0;
}

function findWorktreeDiff(snapshot: KaviSnapshot, agent: "codex" | "claude"): KaviWorktreeDiff | undefined {
  return snapshot.worktreeDiffs.find((diff) => diff.agent === agent);
}

function taskPriority(task: TaskSpec): number {
  switch (task.status) {
    case "running":
      return 0;
    case "blocked":
      return 1;
    case "pending":
      return 2;
    case "failed":
      return 3;
    case "completed":
      return 4;
    default:
      return 5;
  }
}

function recommendationTone(recommendation: OperatorRecommendation): OperatorListItem["tone"] {
  if (recommendation.status === "dismissed") {
    return "muted";
  }

  if (recommendation.openFollowUpTaskIds.length > 0) {
    return "good";
  }

  switch (recommendation.kind) {
    case "follow_up":
      return "warn";
    case "integration":
      return "warn";
    case "handoff":
      return "normal";
    case "ownership-config":
      return "bad";
    default:
      return "normal";
  }
}

function workflowStageTone(stageId: WorkflowResult["stage"]["id"]): OperatorListItem["tone"] {
  switch (stageId) {
    case "ready_to_land":
    case "landed":
      return "good";
    case "review_follow_ups":
    case "waiting_for_approval":
    case "integration":
      return "warn";
    case "bootstrapping":
      return "muted";
    default:
      return "normal";
  }
}

function compatibilityForView(view: OperatorView): DaemonCompatibility | null {
  if (!view.snapshot || !view.clientIdentity) {
    return null;
  }

  return evaluateDaemonCompatibility(view.snapshot.session, view.clientIdentity);
}

function mutationCompatibilityError(view: OperatorView, action: string): string | null {
  const compatibility = compatibilityForView(view);
  if (!compatibility || compatibility.compatible) {
    return null;
  }

  return formatRestartRequiredMessage(action, compatibility);
}

function assertMutableActionAllowed(view: OperatorView, action: string): void {
  const error = mutationCompatibilityError(view, action);
  if (error) {
    throw new Error(error);
  }
}

function resultTabItems(snapshot: KaviSnapshot): OperatorListItem[] {
  const result = buildWorkflowResult(snapshot);
  const items: OperatorListItem[] = [
    {
      id: "result:current",
      title: `[${result.stage.label}] Session Result`,
      detail: result.activeMission
        ? `${result.activeMission.title} | ${result.headline}`
        : result.headline,
      tone: workflowStageTone(result.stage.id)
    }
  ];

  if (result.activeMission) {
    items.push({
      id: `result:mission:${result.activeMission.id}`,
      title: `Mission | ${result.activeMission.title}`,
      detail: `${result.activeMission.status} | acceptance=${result.activeMission.acceptance.status} | ${result.activeMission.summary}`,
      tone:
        result.activeMission.status === "blocked"
          ? "bad"
          : result.activeMission.status === "ready_to_land" || result.activeMission.status === "landed"
            ? "good"
            : "warn"
    });

    if (result.missionObservability?.nextReadyNodes.length) {
      const nextNode = result.missionObservability.nextReadyNodes[0];
      items.push({
        id: `result:next-node:${nextNode.key}`,
        title: `Next Node | ${nextNode.owner} ${nextNode.title}`,
        detail: `critical-path ready | ${nextNode.key}`,
        tone: "good"
      });
    }

    if (result.missionObservability?.latestFailure) {
      items.push({
        id: `result:failure:${result.missionObservability.latestFailure.taskId}`,
        title: `Latest Failure | ${result.missionObservability.latestFailure.taskId}`,
        detail: result.missionObservability.latestFailure.summary,
        tone: "bad"
      });
    }

    const failedChecks = result.activeMission.acceptance.checks.filter((check) => check.status === "failed");
    if (failedChecks.length > 0) {
      items.push({
        id: `result:acceptance:${result.activeMission.id}`,
        title: `Acceptance Gate | ${failedChecks.length} failing check(s)`,
        detail: failedChecks.slice(0, 2).map((check) => check.title).join(" | "),
        tone: "bad"
      });
    }
  }

  if (result.latestLandReport) {
    items.push({
      id: `result:land:${result.latestLandReport.id}`,
      title: `Latest Land | ${result.latestLandReport.targetBranch}`,
      detail: result.latestLandReport.summary[0] ?? "Merged managed work.",
      tone: "good"
    });
  }

  for (const agent of result.agentResults) {
    items.push({
      id: `result:agent:${agent.agent}`,
      title: `${agent.agent} Result`,
      detail:
        agent.latestSummary ??
        (agent.changedPaths.length > 0
          ? `${agent.changedPaths.length} unlanded path(s).`
          : "No completed result yet."),
      tone:
        agent.changedPaths.length > 0
          ? "warn"
          : agent.completedTaskCount > 0
            ? "good"
            : "muted"
    });
  }

  return items;
}

export function buildTabItems(snapshot: KaviSnapshot | null, tab: OperatorTab): OperatorListItem[] {
  if (!snapshot) {
    return [];
  }

  const { session } = snapshot;
  switch (tab) {
    case "activity":
      return buildWorkflowActivity(snapshot, [], 80).map((entry) => ({
        id: entry.id,
        title: entry.title,
        detail: entry.detail,
        tone: entry.tone
      }));
    case "results":
      return resultTabItems(snapshot);
    case "tasks":
      const activeMissionId = buildWorkflowResult(snapshot).activeMission?.id ?? null;
      return [...normalizeTaskSpecs(session.tasks)]
        .sort((left, right) => {
          const missionDelta =
            Number(right.missionId === activeMissionId) - Number(left.missionId === activeMissionId);
          if (missionDelta !== 0) {
            return missionDelta;
          }
          const priority = taskPriority(left) - taskPriority(right);
          if (priority !== 0) {
            return priority;
          }

          return right.updatedAt.localeCompare(left.updatedAt);
        })
        .map((task) => ({
          id: task.id,
          title: `[${task.status}] ${task.owner} ${task.nodeKind ?? task.kind} ${task.title}`,
          detail:
            [
              task.missionId === activeMissionId ? "active mission" : `mission ${task.missionId.slice(0, 8)}`,
              `deps=${task.dependsOnTaskIds.length}`,
              task.retryCount > 0 ? `retry=${task.retryCount}/${task.maxRetries}` : null,
              task.summary ?? task.routeReason ?? truncateValue(task.prompt, 140)
            ]
              .filter((value): value is string => Boolean(value))
              .join(" | "),
          tone: statusTone(task.status)
        }));
    case "recommendations":
      return buildOperatorRecommendations(session, {
        includeDismissed: true
      }).map((recommendation) => ({
        id: recommendation.id,
        title: `[${recommendation.status}] ${recommendation.kind} ${recommendation.title}`,
        detail:
          recommendation.openFollowUpTaskIds.length > 0
            ? `follow-up: ${recommendation.openFollowUpTaskIds.join(", ")}`
            : recommendation.detail,
        tone: recommendationTone(recommendation)
      }));
    case "approvals":
      return [...snapshot.approvals]
        .sort((left, right) => {
          const pendingDelta = Number(right.status === "pending") - Number(left.status === "pending");
          if (pendingDelta !== 0) {
            return pendingDelta;
          }

          return right.updatedAt.localeCompare(left.updatedAt);
        })
        .map((approval) => ({
          id: approval.id,
          title: `[${approval.status}] ${approval.agent} ${approval.toolName}`,
          detail: approval.summary,
          tone: statusTone(
            approval.status === "approved"
              ? "approved"
              : approval.status === "denied"
                ? "denied"
                : approval.status
          )
        }));
    case "claims":
      return [...session.pathClaims]
        .sort((left, right) => {
          const activeDelta = Number(right.status === "active") - Number(left.status === "active");
          if (activeDelta !== 0) {
            return activeDelta;
          }

          return right.updatedAt.localeCompare(left.updatedAt);
        })
        .map((claim) => ({
          id: claim.id,
          title: `[${claim.status}] ${claim.agent} ${claim.source}`,
          detail: claim.paths.join(", ") || "(no paths)",
          tone: claim.status === "active" ? "warn" : "muted"
        }));
    case "decisions":
      return [...session.decisions]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((decision) => ({
          id: decision.id,
          title: `[${decision.kind}] ${decision.summary}`,
          detail: decision.detail,
          tone: decision.kind === "integration" ? "warn" : "normal"
        }));
    case "messages":
      return [...session.peerMessages]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((message) => ({
          id: message.id,
          title: `${message.from} -> ${message.to} [${message.intent}]`,
          detail: message.subject,
          tone: "normal"
        }));
    case "worktrees":
      return session.worktrees.map((worktree) => ({
        id: worktree.agent,
        title: `${worktree.agent} ${worktree.branch}`,
        detail: `${changedPathCount(findWorktreeDiff(snapshot, worktree.agent))} changed | ${path.basename(worktree.path)}`,
        tone: changedPathCount(findWorktreeDiff(snapshot, worktree.agent)) > 0 ? "warn" : "good"
      }));
    default:
      return [];
  }
}

function emptySelectionMap(): Record<OperatorTab, string | null> {
  return {
    activity: null,
    results: null,
    tasks: null,
    recommendations: null,
    approvals: null,
    claims: null,
    decisions: null,
    messages: null,
    worktrees: null
  };
}

function emptySeenMarkerMap(): Record<OperatorTab, string | null> {
  return {
    activity: null,
    results: null,
    tasks: null,
    recommendations: null,
    approvals: null,
    claims: null,
    decisions: null,
    messages: null,
    worktrees: null
  };
}

function tabMarker(snapshot: KaviSnapshot | null, tab: OperatorTab): string | null {
  if (!snapshot) {
    return null;
  }

  switch (tab) {
    case "activity":
      return snapshot.events.at(-1)?.id ?? null;
    case "results": {
      const result = buildWorkflowResult(snapshot);
      return JSON.stringify({
        stage: result.stage.id,
        activeMissionId: result.activeMission?.id ?? null,
        activeMissionStatus: result.activeMission?.status ?? null,
        activeMissionAcceptance: result.activeMission?.acceptance.status ?? null,
        latestLandReportId: snapshot.latestLandReport?.id ?? null,
        agents: result.agentResults.map((agent) => [
          agent.agent,
          agent.latestTaskId,
          agent.lastRunAt,
          agent.changedPaths.join(", ")
        ])
      });
    }
    case "tasks":
      return JSON.stringify(
        [...normalizeTaskSpecs(snapshot.session.tasks)]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 10)
          .map((task) => [task.id, task.status, task.updatedAt])
      );
    case "recommendations":
      return JSON.stringify(
        buildOperatorRecommendations(snapshot.session, {
          includeDismissed: true
        }).map((recommendation) => [
          recommendation.id,
          recommendation.status,
          recommendation.openFollowUpTaskIds.join(", ")
        ])
      );
    case "approvals":
      return JSON.stringify(
        snapshot.approvals.map((approval) => [approval.id, approval.status, approval.updatedAt])
      );
    case "claims":
      return JSON.stringify(
        snapshot.session.pathClaims.map((claim) => [claim.id, claim.status, claim.updatedAt])
      );
    case "decisions":
      return snapshot.session.decisions.at(-1)?.id ?? null;
    case "messages":
      return snapshot.session.peerMessages.at(-1)?.id ?? null;
    case "worktrees":
      return JSON.stringify(
        snapshot.worktreeDiffs.map((diff) => [diff.agent, diff.paths.join(", ")])
      );
    default:
      return null;
  }
}

function markTabSeen(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  tab: OperatorTab
): void {
  ui.seenMarkers[tab] = tabMarker(snapshot, tab);
}

function currentTabAttention(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  tab: OperatorTab
): { marker: string; tone: keyof typeof STYLES } | null {
  if (!snapshot || tab === ui.activeTab) {
    return null;
  }

  const current = tabMarker(snapshot, tab);
  if (!current || current === ui.seenMarkers[tab]) {
    return null;
  }

  switch (tab) {
    case "approvals":
      return snapshot.approvals.some((approval) => approval.status === "pending")
        ? { marker: "!", tone: "warn" }
        : { marker: "*", tone: "muted" };
    case "results": {
      const summary = buildWorkflowSummary(snapshot);
      return summary.stage.id === "ready_to_land"
        ? { marker: "!", tone: "good" }
        : summary.stage.id === "review_follow_ups"
          ? { marker: "!", tone: "warn" }
        : summary.stage.id === "landed"
          ? { marker: "*", tone: "good" }
          : { marker: "*", tone: "accent" };
    }
    case "tasks":
      return normalizeTaskSpecs(snapshot.session.tasks).some(
        (task) => task.status === "failed" || task.status === "blocked"
      )
        ? { marker: "!", tone: "warn" }
        : { marker: "*", tone: "good" };
    case "recommendations":
      return activeFollowUpRecommendations(snapshot.session).length > 0
        ? { marker: "!", tone: "warn" }
        : buildOperatorRecommendations(snapshot.session).length > 0
        ? { marker: "!", tone: "warn" }
        : { marker: "*", tone: "muted" };
    case "messages":
      return { marker: "*", tone: "accent" };
    default:
      return { marker: "*", tone: "muted" };
  }
}

export function moveSelectionId(
  items: OperatorListItem[],
  currentId: string | null,
  delta: number
): string | null {
  if (items.length === 0) {
    return null;
  }

  const currentIndex = Math.max(0, items.findIndex((item) => item.id === currentId));
  const nextIndex = (currentIndex + delta + items.length) % items.length;
  return items[nextIndex]?.id ?? items[0]?.id ?? null;
}

export function nextTab(current: OperatorTab, delta: number): OperatorTab {
  const index = OPERATOR_TABS.indexOf(current);
  const nextIndex = (index + delta + OPERATOR_TABS.length) % OPERATOR_TABS.length;
  return OPERATOR_TABS[nextIndex] ?? current;
}

function defaultSelectionForTab(snapshot: KaviSnapshot, tab: OperatorTab): string | null {
  const items = buildTabItems(snapshot, tab);
  return items[0]?.id ?? null;
}

function syncSelections(
  selectedIds: Record<OperatorTab, string | null>,
  snapshot: KaviSnapshot | null
): Record<OperatorTab, string | null> {
  if (!snapshot) {
    return emptySelectionMap();
  }

  const next = { ...selectedIds };
  for (const tab of OPERATOR_TABS) {
    const items = buildTabItems(snapshot, tab);
    next[tab] = items.some((item) => item.id === selectedIds[tab])
      ? selectedIds[tab]
      : defaultSelectionForTab(snapshot, tab);
  }

  return next;
}

function selectedItem(snapshot: KaviSnapshot | null, ui: OperatorUiState): OperatorListItem | null {
  const items = buildTabItems(snapshot, ui.activeTab);
  return items.find((item) => item.id === ui.selectedIds[ui.activeTab]) ?? items[0] ?? null;
}

function selectedTask(snapshot: KaviSnapshot | null, ui: OperatorUiState): TaskSpec | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.tasks;
  const task = snapshot.session.tasks.find((candidate) => candidate.id === selectedId);
  return task ? normalizeTaskSpec(task) : null;
}

function selectedResultItem(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): OperatorListItem | null {
  if (!snapshot) {
    return null;
  }

  const items = resultTabItems(snapshot);
  return items.find((item) => item.id === ui.selectedIds.results) ?? items[0] ?? null;
}

function selectedRecommendation(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): OperatorRecommendation | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.recommendations;
  return buildOperatorRecommendations(snapshot.session, {
    includeDismissed: true
  }).find((recommendation) => recommendation.id === selectedId) ?? null;
}

function selectedApproval(snapshot: KaviSnapshot | null, ui: OperatorUiState): ApprovalRequest | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.approvals;
  return snapshot.approvals.find((approval) => approval.id === selectedId)
    ?? latestPendingApproval(snapshot.approvals);
}

function selectedClaim(snapshot: KaviSnapshot | null, ui: OperatorUiState): PathClaim | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.claims;
  return snapshot.session.pathClaims.find((claim) => claim.id === selectedId) ?? null;
}

function selectedDecision(snapshot: KaviSnapshot | null, ui: OperatorUiState): DecisionRecord | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.decisions;
  return snapshot.session.decisions.find((decision) => decision.id === selectedId) ?? null;
}

function selectedActivityEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): WorkflowActivityEntry | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.activity;
  return buildWorkflowActivity(snapshot, [], 80).find((entry) => entry.id === selectedId) ?? null;
}

function selectedMessage(snapshot: KaviSnapshot | null, ui: OperatorUiState): PeerMessage | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.messages;
  return snapshot.session.peerMessages.find((message) => message.id === selectedId) ?? null;
}

function selectedWorktree(snapshot: KaviSnapshot | null, ui: OperatorUiState): WorktreeInfo | null {
  if (!snapshot) {
    return null;
  }

  const selectedId = ui.selectedIds.worktrees;
  return snapshot.session.worktrees.find((worktree) => worktree.agent === selectedId) ?? snapshot.session.worktrees[0] ?? null;
}

function managedAgentForTask(task: TaskSpec | null): ManagedAgent | null {
  if (task?.owner === "codex" || task?.owner === "claude") {
    return task.owner;
  }

  return null;
}

function reviewAgentForUi(snapshot: KaviSnapshot | null, ui: OperatorUiState): ManagedAgent | null {
  if (!snapshot) {
    return null;
  }

  if (ui.activeTab === "worktrees") {
    return selectedWorktree(snapshot, ui)?.agent ?? null;
  }

  if (ui.activeTab === "tasks" && ui.taskDetailSection === "diff") {
    return managedAgentForTask(selectedTask(snapshot, ui));
  }

  return null;
}

function changedPathsForAgent(
  snapshot: KaviSnapshot | null,
  agent: ManagedAgent
): string[] {
  return findWorktreeDiff(snapshot ?? null, agent)?.paths ?? [];
}

function changedPathSignature(paths: string[]): string {
  return paths.join("\n");
}

function firstMatchingPath(candidates: string[], availablePaths: string[]): string | null {
  for (const candidate of candidates) {
    if (availablePaths.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function syncDiffSelections(
  current: Record<ManagedAgent, string | null>,
  snapshot: KaviSnapshot | null,
  task: TaskSpec | null = null
): Record<ManagedAgent, string | null> {
  const next = { ...current };

  for (const agent of ["codex", "claude"] as const) {
    const changedPaths = changedPathsForAgent(snapshot, agent);
    const currentSelection = current[agent];
    const taskPreferred =
      task?.owner === agent
        ? firstMatchingPath(task.claimedPaths, changedPaths)
        : null;

    if (changedPaths.length === 0) {
      next[agent] = null;
      continue;
    }

    if (taskPreferred) {
      next[agent] = taskPreferred;
      continue;
    }

    next[agent] = currentSelection && changedPaths.includes(currentSelection)
      ? currentSelection
      : changedPaths[0] ?? null;
  }

  return next;
}

function diffEntryForAgent(
  ui: OperatorUiState,
  agent: ManagedAgent | null
): DiffReviewCacheEntry | null {
  return agent ? ui.diffReviews[agent] ?? null : null;
}

function selectedDiffPath(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  agent: ManagedAgent
): string | null {
  const changedPaths = changedPathsForAgent(snapshot, agent);
  if (changedPaths.length === 0) {
    return null;
  }

  return ui.diffSelections[agent] && changedPaths.includes(ui.diffSelections[agent])
    ? ui.diffSelections[agent]
    : changedPaths[0] ?? null;
}

function diffFooter(agent: ManagedAgent | null): string {
  if (!agent) {
    return styleLine("Diff review is available for managed Codex and Claude worktrees.", "muted");
  }

  return styleLine(
    `Diff keys: , previous file | . next file | { previous hunk | } next hunk | current agent ${agent}`,
    "muted"
  );
}

function selectedHunkIndex(
  ui: OperatorUiState,
  agent: ManagedAgent,
  review: WorktreeDiffReview | null
): number | null {
  const hunks = parseDiffHunks(review?.patch ?? "");
  if (hunks.length === 0) {
    return null;
  }

  const current = ui.hunkSelections[agent] ?? 0;
  return Math.max(0, Math.min(current, hunks.length - 1));
}

function reviewDispositionTone(disposition: ReviewDisposition): OperatorListItem["tone"] {
  switch (disposition) {
    case "approve":
      return "good";
    case "concern":
      return "bad";
    case "question":
    case "accepted_risk":
      return "warn";
    case "wont_fix":
      return "muted";
    default:
      return "muted";
  }
}

function reviewDispositionLabel(disposition: ReviewDisposition): string {
  switch (disposition) {
    case "approve":
      return "Approve";
    case "concern":
      return "Concern";
    case "question":
      return "Question";
    case "accepted_risk":
      return "Accepted Risk";
    case "wont_fix":
      return "Won't Fix";
    case "note":
      return "Note";
    default:
      return disposition;
  }
}

function reviewAssigneeLabel(assignee: ReviewAssignee | null): string {
  switch (assignee) {
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    case "operator":
      return "operator";
    default:
      return "unassigned";
  }
}

function reviewFilterLabel(filters: ReviewFilterState): string {
  return `status=${filters.status} | assignee=${filters.assignee === "all" ? "all" : reviewAssigneeLabel(filters.assignee)} | disposition=${filters.disposition === "all" ? "all" : reviewDispositionLabel(filters.disposition)}`;
}

function cycleReviewFilterAssignee(current: ReviewFilterState["assignee"]): ReviewFilterState["assignee"] {
  const sequence: ReviewFilterState["assignee"][] = ["all", "codex", "claude", "operator"];
  const index = sequence.findIndex((item) => item === current);
  return sequence[(index + 1) % sequence.length] ?? "all";
}

function cycleReviewFilterDisposition(
  current: ReviewFilterState["disposition"]
): ReviewFilterState["disposition"] {
  const sequence: ReviewFilterState["disposition"][] = [
    "all",
    "approve",
    "concern",
    "question",
    "note",
    "accepted_risk",
    "wont_fix"
  ];
  const index = sequence.findIndex((item) => item === current);
  return sequence[(index + 1) % sequence.length] ?? "all";
}

function cycleReviewFilterStatus(current: ReviewFilterState["status"]): ReviewFilterState["status"] {
  const sequence: ReviewFilterState["status"][] = ["all", "open", "resolved"];
  const index = sequence.findIndex((item) => item === current);
  return sequence[(index + 1) % sequence.length] ?? "all";
}

function activeReviewContext(snapshot: KaviSnapshot | null, ui: OperatorUiState): ReviewContext | null {
  const agent = reviewAgentForUi(snapshot, ui);
  if (!agent) {
    return null;
  }

  const review = ui.diffReviews[agent]?.review ?? null;
  const filePath = review?.selectedPath ?? selectedDiffPath(snapshot, ui, agent);
  if (!filePath) {
    return null;
  }

  const task = ui.activeTab === "tasks" ? selectedTask(snapshot, ui) : null;
  const hunkIndex = selectedHunkIndex(ui, agent, review);
  const hunkHeader =
    hunkIndex === null
      ? null
      : parseDiffHunks(review?.patch ?? "")[hunkIndex]?.header ?? null;

  return {
    agent,
    taskId: task?.owner === agent ? task.id : null,
    filePath,
    hunkIndex,
    hunkHeader
  };
}

function reviewNotesForContext(
  snapshot: KaviSnapshot | null,
  context: ReviewContext | null,
  filters: ReviewFilterState
): ReviewNote[] {
  if (!snapshot || !context) {
    return [];
  }

  return [...snapshot.session.reviewNotes]
    .filter((note) => {
      if (note.agent !== context.agent || note.filePath !== context.filePath) {
        return false;
      }

      if (context.hunkIndex !== null && !(note.hunkIndex === context.hunkIndex || note.hunkIndex === null)) {
        return false;
      }

      if (!reviewNoteMatchesFilters(note, {
        assignee: filters.assignee === "all" ? null : filters.assignee,
        disposition: filters.disposition === "all" ? null : filters.disposition,
        status: filters.status === "all" ? null : filters.status
      })) {
        return false;
      }

      return true;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function composerRoutePreview(
  snapshot: KaviSnapshot | null,
  composer: ComposerState
) {
  if (!snapshot) {
    return null;
  }

  const prompt = composer.prompt.trim();
  if (!prompt) {
    return null;
  }

  return composer.owner === "auto"
    ? previewRouteDecision(prompt, snapshot.session.config, snapshot.session)
    : {
        owner: composer.owner,
        strategy: "manual" as const,
        confidence: 1,
        reason: `Operator manually assigned the task to ${composer.owner}.`,
        claimedPaths: extractPromptPathHints(prompt),
        metadata: {
          manualAssignment: true,
          composerOwner: composer.owner
        }
      };
}

interface ComposerTaskPreview {
  planningDecision: ReturnType<typeof decidePlanningMode>;
  route: ReturnType<typeof composerRoutePreview> | null;
  activePlanTitle: string | null;
}

function countPromptLines(prompt: string): number {
  return countEditorLines(prompt);
}

export function normalizePastedInputChunk(input: string | undefined): string {
  return normalizeEditorInputChunk(input);
}

export function shouldExpandComposer(prompt: string): boolean {
  return countPromptLines(prompt) > 4 || prompt.length > 240;
}

function isPasteChunk(input: string): boolean {
  return (
    input.includes("\u001b[200~") ||
    input.includes("\u001b[201~") ||
    input.includes("\n") ||
    input.includes("\r") ||
    input.length > 1
  );
}

function appendComposerText(
  composer: ComposerState,
  input: string | undefined
): boolean {
  const result = insertEditorText(composer.prompt, composer, input);
  if (!result.inserted) {
    return false;
  }

  composer.prompt = result.value;
  if (typeof input === "string" && isPasteChunk(input)) {
    composer.pasteCount += 1;
    if (result.lineCount > 1 || normalizePastedInputChunk(input).length > 240) {
      composer.expanded = true;
      composer.pasteSummary = `[Pasted text #${composer.pasteCount} | ${result.lineCount} ${result.lineCount === 1 ? "line" : "lines"}] Opened in the expanded editor before submit.`;
    }
  }

  if (shouldExpandComposer(composer.prompt)) {
    composer.expanded = true;
  }

  return true;
}

function appendReviewComposerText(
  composer: ReviewComposerState,
  input: string | undefined
): boolean {
  const result = insertEditorText(composer.body, composer, input);
  if (!result.inserted) {
    return false;
  }

  composer.body = result.value;
  return true;
}

function editorCursorSummary(value: string, editor: TextEditorState): string {
  const position = editorCursorPosition(value, editor.cursorOffset);
  return `line ${position.line + 1}/${position.totalLines} | col ${position.column + 1}`;
}

function buildComposerTaskPreview(
  snapshot: KaviSnapshot | null,
  composer: ComposerState
) : ComposerTaskPreview | null {
  if (!snapshot) {
    return null;
  }

  const prompt = composer.prompt.trim();
  if (!prompt) {
    return null;
  }

  const planningDecision = decidePlanningMode(prompt, snapshot.session, composer.planningMode);
  const route =
    planningDecision.usePlanner
      ? null
      : composer.owner === "auto"
        ? previewRouteDecision(prompt, snapshot.session.config, snapshot.session)
        : {
            owner: composer.owner,
            strategy: "manual" as const,
            confidence: 1,
            reason: `Operator manually assigned the task to ${composer.owner}.`,
            claimedPaths: extractPromptPathHints(prompt),
            metadata: {
              manualAssignment: true,
              composerOwner: composer.owner
            }
          };

  return {
    planningDecision,
    route,
    activePlanTitle: currentExecutionPlan(snapshot.session)?.title ?? null
  };
}

function composerPreviewSummary(preview: ComposerTaskPreview | null): string {
  if (!preview) {
    return "Preview: waiting for prompt";
  }

  if (preview.planningDecision.usePlanner) {
    return `Planner: codex orchestration | ${preview.planningDecision.reason}`;
  }

  return preview.route
    ? `Route: ${preview.route.owner} via ${preview.route.strategy} (${preview.route.confidence.toFixed(2)}) | ${preview.route.reason}`
    : `Planning: ${preview.planningDecision.reason}`;
}

function recommendationsForClaim(
  snapshot: KaviSnapshot | null,
  claim: PathClaim | null
) {
  if (!snapshot || !claim) {
    return [];
  }

  return buildOperatorRecommendations(snapshot.session).filter((recommendation) =>
    recommendation.taskIds.includes(claim.taskId) ||
    (claim.paths.length > 0 &&
      recommendation.filePath !== null &&
      claim.paths.some((filePath) => recommendation.filePath === filePath || recommendation.filePath.startsWith(`${filePath}/`) || filePath.startsWith(`${recommendation.filePath}/`)))
  );
}

function recommendationsForDecision(
  snapshot: KaviSnapshot | null,
  decision: DecisionRecord | null
) {
  if (!snapshot || !decision) {
    return [];
  }

  return buildOperatorRecommendations(snapshot.session).filter((recommendation) =>
    (decision.taskId !== null && recommendation.taskIds.includes(decision.taskId)) ||
    (typeof decision.metadata?.hotspot === "string" &&
      recommendation.filePath === decision.metadata.hotspot)
  );
}

function syncSelectedReviewNote(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): void {
  const notes = reviewNotesForContext(snapshot, activeReviewContext(snapshot, ui), ui.reviewFilters);
  ui.selectedReviewNoteId = notes.some((note) => note.id === ui.selectedReviewNoteId)
    ? ui.selectedReviewNoteId
    : notes[0]?.id ?? null;
}

function selectedReviewNote(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): ReviewNote | null {
  const notes = reviewNotesForContext(snapshot, activeReviewContext(snapshot, ui), ui.reviewFilters);
  return notes.find((note) => note.id === ui.selectedReviewNoteId) ?? notes[0] ?? null;
}

function missionBrainEntries(
  snapshot: KaviSnapshot | null
): BrainEntry[] {
  if (!snapshot) {
    return [];
  }
  const mission = buildWorkflowResult(snapshot).activeMission;
  if (!mission) {
    return [];
  }
  return snapshot.session.brain.filter((entry) => mission.brainEntryIds.includes(entry.id));
}

function filteredMissionBrainEntries(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): BrainEntry[] {
  const entries = missionBrainEntries(snapshot);
  if (entries.length === 0) {
    return [];
  }

  const category = ui.brainFilters.category;
  const scope = ui.brainFilters.scope;
  const query = ui.brainFilters.query.trim();
  const pathHint = ui.brainFilters.pathHint.trim();
  const filteredByFlags = entries
    .filter((entry) => ui.brainFilters.includeRetired || !entry.retiredAt)
    .filter((entry) => (category === "all" ? true : (entry.category ?? "artifact") === category))
    .filter((entry) => (scope === "all" ? true : (entry.scope ?? "repo") === scope));

  if (!query && !pathHint) {
    return filteredByFlags;
  }

  return queryBrainEntries(
    {
      ...snapshot!.session,
      brain: filteredByFlags
    },
    {
      query,
      path: pathHint || null,
      includeRetired: ui.brainFilters.includeRetired,
      limit: filteredByFlags.length
    }
  );
}

function candidateBrainPathHints(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): string[] {
  if (!snapshot) {
    return [];
  }
  const result = buildWorkflowResult(snapshot);
  const activeMission = result.activeMission;
  const selectedTaskId = ui.selectedIds.tasks;
  const selectedTask = selectedTaskId
    ? snapshot.session.tasks.find((task) => task.id === selectedTaskId) ?? null
    : null;
  const progressPaths = result.missionObservability?.recentProgress.flatMap((entry) => entry.paths ?? []) ?? [];
  const taskPaths = selectedTask?.claimedPaths ?? [];
  const nodePaths = activeMission
    ? currentExecutionPlan(snapshot.session, activeMission)?.nodes.flatMap((node) => node.claimedPaths) ?? []
    : [];
  return [...new Set([...taskPaths, ...progressPaths, ...nodePaths].filter(Boolean))].slice(0, 12);
}

function filteredBrainGraph(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): ReturnType<typeof buildBrainGraph> | null {
  const selected = selectedBrainEntry(snapshot, ui);
  if (!snapshot || !selected) {
    return null;
  }
  const missionId = selected.missionId ?? buildWorkflowResult(snapshot).activeMission?.id ?? null;
  const graph = buildBrainGraph(snapshot.session, {
    entryId: selected.id,
    missionId,
    path: ui.brainFilters.pathHint.trim() || null,
    includeRetired: ui.brainFilters.includeRetired,
    limit: 12
  });
  return filterBrainGraphMode(graph, ui.brainFilters.graphMode);
}

function relatedBrainEntriesForSelection(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): BrainEntry[] {
  const selected = selectedBrainEntry(snapshot, ui);
  if (!snapshot || !selected) {
    return [];
  }
  return relatedBrainEntries(snapshot.session, selected.id, 8)
    .filter((entry) => ui.brainFilters.includeRetired || !entry.retiredAt);
}

function graphNeighborEntriesForSelection(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): BrainEntry[] {
  const selected = selectedBrainEntry(snapshot, ui);
  if (!snapshot || !selected) {
    return [];
  }
  const graph = filteredBrainGraph(snapshot, ui);
  if (!graph) {
    return [];
  }
  const missionId = selected.missionId ?? buildWorkflowResult(snapshot).activeMission?.id ?? null;
  const neighborIds = new Set(
    graph.edges
    .filter((edge) => edge.from === selected.id || edge.to === selected.id)
    .map((edge) => (edge.from === selected.id ? edge.to : edge.from))
  );
  const pathHint = ui.brainFilters.pathHint.trim();
  if (pathHint) {
    for (const entry of queryBrainEntries(snapshot.session, {
      missionId,
      path: pathHint,
      includeRetired: ui.brainFilters.includeRetired,
      limit: 8
    })) {
      if (entry.id !== selected.id) {
        neighborIds.add(entry.id);
      }
    }
  }
  return [...neighborIds]
    .map((entryId) => snapshot.session.brain.find((entry) => entry.id === entryId) ?? null)
    .filter((entry): entry is BrainEntry => Boolean(entry))
    .filter((entry) => ui.brainFilters.includeRetired || !entry.retiredAt);
}

function selectedBrainEvidenceTargets(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): string[] {
  const selected = selectedBrainEntry(snapshot, ui);
  if (!selected) {
    return [];
  }
  return [...new Set([...(selected.evidence ?? []), ...(selected.commands ?? [])])].slice(0, 16);
}

function syncSelectedBrainEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): void {
  const entries = filteredMissionBrainEntries(snapshot, ui);
  ui.selectedBrainEntryId = entries.some((entry) => entry.id === ui.selectedBrainEntryId)
    ? ui.selectedBrainEntryId
    : entries[0]?.id ?? null;
  ui.brainMergeSourceEntryId = entries.some((entry) => entry.id === ui.brainMergeSourceEntryId)
    ? ui.brainMergeSourceEntryId
    : null;
  const related = relatedBrainEntriesForSelection(snapshot, ui);
  ui.selectedBrainRelatedEntryId = related.some((entry) => entry.id === ui.selectedBrainRelatedEntryId)
    ? ui.selectedBrainRelatedEntryId
    : related[0]?.id ?? null;
  const graphEntries = graphNeighborEntriesForSelection(snapshot, ui);
  ui.selectedBrainGraphEntryId = graphEntries.some((entry) => entry.id === ui.selectedBrainGraphEntryId)
    ? ui.selectedBrainGraphEntryId
    : graphEntries[0]?.id ?? null;
  const evidenceTargets = selectedBrainEvidenceTargets(snapshot, ui);
  ui.selectedBrainEvidenceIndex = Math.max(
    0,
    Math.min(ui.selectedBrainEvidenceIndex, Math.max(0, evidenceTargets.length - 1))
  );
}

function selectedBrainEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): BrainEntry | null {
  const entries = filteredMissionBrainEntries(snapshot, ui);
  return entries.find((entry) => entry.id === ui.selectedBrainEntryId) ?? entries[0] ?? null;
}

function brainMergeSourceEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): BrainEntry | null {
  const entries = missionBrainEntries(snapshot);
  return entries.find((entry) => entry.id === ui.brainMergeSourceEntryId) ?? null;
}

function brainExplanationLines(
  snapshot: KaviSnapshot | null,
  entryId: string | null
): string[] {
  if (!snapshot || !entryId) {
    return [];
  }

  return explainBrainEntry(snapshot.session, entryId);
}

function cycleSelectedBrainEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): boolean {
  const entries = filteredMissionBrainEntries(snapshot, ui);
  if (entries.length === 0) {
    return false;
  }
  const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === ui.selectedBrainEntryId));
  const nextIndex = (currentIndex + delta + entries.length) % entries.length;
  ui.selectedBrainEntryId = entries[nextIndex]?.id ?? entries[0]?.id ?? null;
  return true;
}

function cycleSelectedBrainRelatedEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): boolean {
  const entries = relatedBrainEntriesForSelection(snapshot, ui);
  if (entries.length === 0) {
    return false;
  }
  const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === ui.selectedBrainRelatedEntryId));
  const nextIndex = (currentIndex + delta + entries.length) % entries.length;
  ui.selectedBrainRelatedEntryId = entries[nextIndex]?.id ?? entries[0]?.id ?? null;
  return true;
}

function cycleSelectedBrainGraphEntry(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): boolean {
  const entries = graphNeighborEntriesForSelection(snapshot, ui);
  if (entries.length === 0) {
    return false;
  }
  const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === ui.selectedBrainGraphEntryId));
  const nextIndex = (currentIndex + delta + entries.length) % entries.length;
  ui.selectedBrainGraphEntryId = entries[nextIndex]?.id ?? entries[0]?.id ?? null;
  return true;
}

function cycleBrainFilterCategory(ui: OperatorUiState): void {
  const order: BrainFilterState["category"][] = [
    "all",
    "fact",
    "decision",
    "procedure",
    "risk",
    "artifact",
    "topology",
    "contract",
    "failure",
    "verification"
  ];
  const currentIndex = Math.max(0, order.indexOf(ui.brainFilters.category));
  ui.brainFilters.category = order[(currentIndex + 1) % order.length] ?? "all";
}

function cycleBrainFilterScope(ui: OperatorUiState): void {
  const order: BrainFilterState["scope"][] = ["all", "mission", "repo", "personal", "pattern"];
  const currentIndex = Math.max(0, order.indexOf(ui.brainFilters.scope));
  ui.brainFilters.scope = order[(currentIndex + 1) % order.length] ?? "all";
}

function cycleBrainFocusArea(ui: OperatorUiState): void {
  const order: BrainFilterState["focusArea"][] = ["entries", "related", "graph", "evidence"];
  const currentIndex = Math.max(0, order.indexOf(ui.brainFilters.focusArea));
  ui.brainFilters.focusArea = order[(currentIndex + 1) % order.length] ?? "entries";
}

function cycleBrainGraphMode(ui: OperatorUiState): void {
  const order: BrainFilterState["graphMode"][] = ["all", "structural", "knowledge", "topology", "failure", "contract", "timeline"];
  const currentIndex = Math.max(0, order.indexOf(ui.brainFilters.graphMode));
  ui.brainFilters.graphMode = order[(currentIndex + 1) % order.length] ?? "all";
}

function cycleBrainPathHint(snapshot: KaviSnapshot | null, ui: OperatorUiState): void {
  const hints = candidateBrainPathHints(snapshot, ui);
  if (hints.length === 0) {
    ui.brainFilters.pathHint = "";
    return;
  }
  const order = ["", ...hints];
  const currentIndex = Math.max(0, order.indexOf(ui.brainFilters.pathHint));
  ui.brainFilters.pathHint = order[(currentIndex + 1) % order.length] ?? "";
}

function cycleSelectedBrainEvidenceTarget(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): boolean {
  const targets = selectedBrainEvidenceTargets(snapshot, ui);
  if (targets.length === 0) {
    return false;
  }
  const nextIndex = (ui.selectedBrainEvidenceIndex + delta + targets.length) % targets.length;
  ui.selectedBrainEvidenceIndex = nextIndex;
  return true;
}

function focusSelectedBrainTarget(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): boolean {
  if (!snapshot) {
    return false;
  }

  if (ui.brainFilters.focusArea === "related") {
    const targetId = ui.selectedBrainRelatedEntryId;
    if (!targetId) {
      return false;
    }
    ui.selectedBrainEntryId = targetId;
    return true;
  }

  if (ui.brainFilters.focusArea === "graph") {
    const targetId = ui.selectedBrainGraphEntryId;
    if (!targetId) {
      return false;
    }
    ui.selectedBrainEntryId = targetId;
    return true;
  }

  if (ui.brainFilters.focusArea === "evidence") {
    const targets = selectedBrainEvidenceTargets(snapshot, ui);
    const target = targets[ui.selectedBrainEvidenceIndex] ?? null;
    if (!target) {
      return false;
    }
    if (target.includes("/") || /\.[a-z0-9]+$/i.test(target)) {
      ui.brainFilters.pathHint = target;
      ui.brainFilters.focusArea = "graph";
      return true;
    }
    ui.brainFilters.query = target;
    ui.brainFilters.focusArea = "entries";
    return true;
  }

  return Boolean(ui.selectedBrainEntryId);
}

function renderReviewNotesSection(
  notes: ReviewNote[],
  selectedNoteId: string | null,
  width: number
): string[] {
  if (notes.length === 0) {
    return ["- none"];
  }

  return notes.flatMap((note) => {
    const stateLabel = note.landedAt ? `${note.status}+landed` : note.status;
    const prefix = `${note.id === selectedNoteId ? ">" : "-"} [${reviewDispositionLabel(note.disposition)} ${stateLabel}] ${shortTime(note.createdAt)}`;
    const followUps = note.followUpTaskIds.length > 0
      ? ` | follow-ups=${note.followUpTaskIds.length}`
      : "";
    const replies = note.comments.length > 1 ? ` | replies=${note.comments.length - 1}` : "";
    const assignee = ` | assignee=${reviewAssigneeLabel(note.assignee)}`;
    const landed = note.landedAt ? ` | landed=${shortTime(note.landedAt)}` : "";
    const detail = note.body || note.summary;
    return wrapText(`${prefix} ${detail}${assignee}${followUps}${replies}${landed}`, width).map((line) =>
      toneLine(line, note.status === "resolved" ? "muted" : reviewDispositionTone(note.disposition), note.id === selectedNoteId)
    );
  });
}

function renderSelectedReviewNoteSection(
  note: ReviewNote | null,
  width: number
): string[] {
  if (!note) {
    return ["- none"];
  }

  return [
    ...wrapText(
      `Status: ${note.status} | Disposition: ${reviewDispositionLabel(note.disposition)} | Updated: ${shortTime(note.updatedAt)}`,
      width
    ),
    ...wrapText(
      `Assignee: ${reviewAssigneeLabel(note.assignee)}`,
      width
    ),
    ...wrapText(
      `Landed: ${note.landedAt ? shortTime(note.landedAt) : "-"}`,
      width
    ),
    ...wrapText(
      `Follow-up tasks: ${note.followUpTaskIds.join(", ") || "-"}`,
      width
    ),
    ...note.comments.flatMap((comment, index) =>
      wrapText(
        `${index === 0 ? "Root" : `Reply ${index}`}: ${comment.body} (${shortTime(comment.updatedAt)})`,
        width
      )
    )
  ];
}

function latestPendingApproval(approvals: ApprovalRequest[]): ApprovalRequest | null {
  return [...approvals]
    .filter((request) => request.status === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .pop() ?? null;
}

function tabLabel(tab: OperatorTab): string {
  switch (tab) {
    case "activity":
      return "Stream";
    case "results":
      return "Mission";
    case "tasks":
      return "Nodes";
    case "recommendations":
      return "Recommendations";
    case "approvals":
      return "Approvals";
    case "claims":
      return "Claims";
    case "decisions":
      return "Decisions";
    case "messages":
      return "Messages";
    case "worktrees":
      return "Worktrees";
    default:
      return tab;
  }
}

function tabShortcut(tab: OperatorTab): string {
  const index = OPERATOR_TABS.indexOf(tab);
  return index === -1 ? "?" : String(index + 1);
}

function toneForPanel(title: string, focused: boolean): string {
  if (focused) {
    return styleLine(title, "accent", "strong");
  }

  return styleLine(title, "strong");
}

function renderPanel(
  title: string,
  width: number,
  height: number,
  content: string[],
  options: {
    focused?: boolean;
    muted?: boolean;
  } = {}
): string[] {
  const safeWidth = Math.max(12, width);
  const safeHeight = Math.max(3, height);
  const titleLine = ` ${truncateValue(title, safeWidth - 6)} `;
  const border = "─".repeat(Math.max(0, safeWidth - 2 - titleLine.length));
  const top = `╭${titleLine}${border}╮`;
  const bottom = `╰${"─".repeat(safeWidth - 2)}╯`;

  const visibleRows = safeHeight - 2;
  const paddedContent = [...content];
  while (paddedContent.length < visibleRows) {
    paddedContent.push("");
  }

  const innerWidth = safeWidth - 4;

  const resolvedTone: keyof typeof STYLES = options.muted
    ? "muted"
    : options.focused
      ? "borderFocus"
      : panelTone(title) ?? "border";
  const bl = styleLine("│", resolvedTone);
  const body = paddedContent.slice(0, visibleRows).map(
    (line) => `${bl} ${fitAnsiLine(line, innerWidth)} ${bl}`
  );
  const styledTop = styleLine(top, resolvedTone);
  const styledBottom = styleLine(bottom, resolvedTone);

  return [styledTop, ...body, styledBottom];
}

function combineColumns(columns: Column[]): string[] {
  const height = Math.max(...columns.map((column) => column.lines.length), 0);
  const rows: string[] = [];

  for (let index = 0; index < height; index += 1) {
    rows.push(
      columns
        .map((column) => column.lines[index] ?? " ".repeat(column.width))
        .join(" ")
    );
  }

  return rows;
}

function renderListPanel(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  const items = buildTabItems(snapshot, ui.activeTab);
  const currentId = ui.selectedIds[ui.activeTab];
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === currentId));
  const title = `${tabLabel(ui.activeTab)} (${items.length})`;
  const visibleRows = Math.max(1, height - 2);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleRows / 2), Math.max(0, items.length - visibleRows))
  );

  const content =
    items.length === 0
      ? [styleLine("  No items in this view.", "dim")]
      : items.slice(start, start + visibleRows).map((item) => {
          const selected = item.id === currentId;
          const toneSymbol = item.tone === "good" ? styleLine("✓", "good")
            : item.tone === "warn" ? styleLine("●", "warn")
            : item.tone === "bad" ? styleLine("✗", "bad")
            : styleLine("○", "dim");
          const prefix = selected ? styleLine("▸", "accent") : " ";
          const detail = item.detail ? ` ${styleLine(item.detail, "dim")}` : "";
          const line = `${prefix} ${toneSymbol} ${item.title}${detail}`;
          return selected
            ? `${STYLES.surfaceHover}${line}${RESET}`
            : line;
        });

  return renderPanel(title, width, height, content, {
    focused: true
  });
}

function formatJson(value: unknown, width: number): string[] {
  return wrapPreformatted(JSON.stringify(value, null, 2), width);
}

function artifactForTask(ui: OperatorUiState, task: TaskSpec | null): ArtifactCacheEntry | null {
  if (!task) {
    return null;
  }

  return ui.artifacts[task.id] ?? null;
}

function taskDetailTitle(ui: OperatorUiState): string {
  return `Inspector | Task ${ui.taskDetailSection}`;
}

function renderTaskInspector(
  task: TaskSpec | null,
  artifactEntry: ArtifactCacheEntry | null,
  loading: boolean,
  diffEntry: DiffReviewCacheEntry | null,
  loadingDiff: boolean,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  if (!task) {
    return renderPanel("Inspector", width, height, [styleLine("No task selected.", "muted")]);
  }

  task = normalizeTaskSpec(task);
  const innerWidth = Math.max(16, width - 4);
  const artifact = artifactEntry?.artifact ?? null;
  const lines: string[] = [];

  if (ui.taskDetailSection === "overview") {
    const ownerColor = task.owner === "codex" ? "codex" : task.owner === "claude" ? "claude" : "text";
    lines.push(...section("Task", renderKV([
      ["Id", task.id],
      ["Owner", styleLine(task.owner, ownerColor as keyof typeof STYLES)],
      ["Status", `${statusSymbol(task.status)} ${task.status}`],
      ["Kind", task.kind ?? "-"],
      ["Node", task.nodeKind ?? "-"],
      ["Retries", `${task.retryCount}/${task.maxRetries}`],
      ["Updated", shortTime(task.updatedAt)],
      ["Route", `${task.routeStrategy ?? "-"}${task.routeConfidence === null ? "" : ` (${task.routeConfidence.toFixed(2)})`}`],
      ["Paths", task.claimedPaths.join(", ") || styleLine("none", "dim")],
    ], innerWidth)));
    if (task.summary) {
      lines.push(...section("Summary", wrapText(task.summary, innerWidth)));
    }
    if (Object.keys(task.routeMetadata).length > 0) {
      lines.push(...section("Route Metadata", wrapText(JSON.stringify(task.routeMetadata), innerWidth)));
    }

    if (loading) {
      lines.push(...section("Artifact", [`${spinner()} Loading artifact...`]));
    } else if (artifactEntry?.error) {
      lines.push(...section("Artifact", wrapText(`Artifact load failed: ${artifactEntry.error}`, innerWidth)));
    } else if (artifact) {
      lines.push(...section("Artifact", renderKV([
        ["Started", shortTime(artifact.startedAt)],
        ["Finished", artifact.finishedAt ? shortTime(artifact.finishedAt) : styleLine("running", "warn")],
        ["Status", artifact.envelope?.status ?? "-"],
        ["Attempts", `${artifact.attempts.length}`],
        ["Next", artifact.envelope?.nextRecommendation ?? styleLine("none", "dim")],
        ...(artifact.error ? [["Error", styleLine(artifact.error, "bad")] as [string, string]] : []),
      ], innerWidth)));

      if (artifact.attempts.length > 0 || task.lastFailureSummary) {
        const latestAttempt = artifact.attempts.at(-1) ?? null;
        lines.push(...section("Recovery", [
          `Attempts: ${artifact.attempts.length}`,
          `Retries used: ${task.retryCount}/${task.maxRetries}`,
          `Latest attempt: ${latestAttempt ? `${latestAttempt.attempt} | ${latestAttempt.status}` : "-"}`,
          `Last failure: ${task.lastFailureSummary ?? artifact.error ?? "none"}`,
          ...(task.status === "failed" || task.status === "blocked"
            ? [styleLine(`Press t to retry ${task.id} from this panel.`, "warn", "strong")]
            : [])
        ].flatMap((line) => wrapText(line, innerWidth))));
      }

      lines.push(...section(
        "Recent Progress",
        artifact.progress.length > 0
          ? artifact.progress
              .slice(-6)
              .flatMap((entry) =>
                [
                  ...wrapText(
                    `- ${shortTime(entry.createdAt)} | ${entry.kind} | ${entry.summary}`,
                    innerWidth
                  ),
                  ...(entry.paths.length > 0
                    ? wrapText(`  paths: ${entry.paths.join(", ")}`, innerWidth)
                    : [])
                ]
              )
          : ["- none yet"]
      ));

      lines.push(...section(
        "Blockers",
        artifact.envelope?.blockers.length
          ? artifact.envelope.blockers.flatMap((blocker) => wrapText(`- ${blocker}`, innerWidth))
          : [styleLine("  none", "dim")]
      ));

      lines.push(...section(
        "Peer Messages",
        artifact.envelope?.peerMessages.length
          ? artifact.envelope.peerMessages.flatMap((message) =>
              wrapText(`- ${message.to} [${message.intent}] ${message.subject}`, innerWidth)
            )
          : [styleLine("  none", "dim")]
      ));
    } else {
      lines.push(...section("Artifact", [styleLine("  No artifact recorded yet.", "dim")]));
    }
    if (!artifact && (task.lastFailureSummary || task.status === "failed" || task.status === "blocked")) {
      lines.push(...section("Recovery", [
        `Retries used: ${task.retryCount}/${task.maxRetries}`,
        `Last failure: ${task.lastFailureSummary ?? "Task failed without a recorded artifact."}`,
        ...(task.status === "failed" || task.status === "blocked"
          ? [styleLine(`Press t to retry ${task.id} from this panel.`, "warn", "strong")]
          : [])
      ].flatMap((line) => wrapText(line, innerWidth))));
    }
  } else if (ui.taskDetailSection === "prompt") {
    lines.push(...section("Prompt", wrapText(task.prompt, innerWidth)));
  } else if (ui.taskDetailSection === "replay") {
    if (loading) {
      lines.push(`${spinner()} Loading artifact...`);
    } else if (artifactEntry?.error) {
      lines.push(...wrapText(`Artifact load failed: ${artifactEntry.error}`, innerWidth));
    } else if (artifact?.decisionReplay.length) {
      lines.push(...artifact.decisionReplay.flatMap((line) => wrapText(line, innerWidth)));
    } else {
      lines.push("No decision replay available.");
    }
  } else if (ui.taskDetailSection === "output") {
    if (loading) {
      lines.push(`${spinner()} Loading artifact...`);
    } else if (artifactEntry?.error) {
      lines.push(...wrapText(`Artifact load failed: ${artifactEntry.error}`, innerWidth));
    } else if (artifact?.rawOutput) {
      lines.push(...wrapPreformatted(artifact.rawOutput, innerWidth));
    } else {
      lines.push("No raw output captured.");
    }
  } else {
    const agent = managedAgentForTask(task);
    lines.push(...section("Task Scope", [
      `Owner: ${task.owner}`,
      `Claimed paths: ${task.claimedPaths.join(", ") || "-"}`,
      `Route reason: ${task.routeStrategy ?? "-"}${task.routeConfidence === null ? "" : ` (${task.routeConfidence.toFixed(2)})`} ${task.routeReason ?? "-"}`
    ].flatMap((line) => wrapText(line, innerWidth))));

    if (!agent) {
      lines.push(...section("Diff Review", [
        "Diff review is only available for Codex and Claude managed tasks."
      ]));
    } else if (loadingDiff) {
      lines.push(...section("Diff Review", [`${spinner()} Loading diff...`]));
    } else if (diffEntry?.error) {
      lines.push(...section("Diff Review", wrapText(`Diff load failed: ${diffEntry.error}`, innerWidth)));
    } else if (diffEntry?.review) {
      const review = diffEntry.review;
      const hunks = parseDiffHunks(review.patch);
      const hunkIndex = agent ? selectedHunkIndex(ui, agent, review) : null;
      const selectedHunk = hunkIndex === null ? null : hunks[hunkIndex] ?? null;
      const reviewNotes = reviewNotesForContext(snapshot, activeReviewContext(snapshot, ui), ui.reviewFilters);
      const rvAgentColor = review.agent === "codex" ? "codex" : "claude";
      lines.push(...section("Review", renderKV([
        ["Agent", styleLine(review.agent, rvAgentColor as keyof typeof STYLES)],
        ["File", review.selectedPath ?? "-"],
        ["Hunk", hunkIndex === null ? "-" : `${hunkIndex + 1}/${hunks.length}`],
        ["Notes", `${reviewNotes.length}`],
        ["Stat", review.stat],
      ], innerWidth)));
      lines.push(...section(
        "Changed Files",
        review.changedPaths.length
          ? review.changedPaths.flatMap((filePath) => {
              const selected = filePath === review.selectedPath;
              return wrapText(
                `${selected ? styleLine("▸", "accent") : " "} ${filePath}`,
                innerWidth
              );
            })
          : [styleLine("  clean", "good")]
      ));
      if (selectedHunk) {
        lines.push(...section(
          "Current Hunk",
          renderStyledDiffBlock(
            [selectedHunk.header, ...selectedHunk.lines].join("\n")
          )
        ));
      }
      lines.push(...section(
        "Patch",
        review.patch
          ? renderStyledDiffBlock(review.patch)
          : [styleLine("  No patch available.", "dim")]
      ));
      lines.push(...section(
        "Review Notes",
        renderReviewNotesSection(reviewNotes, ui.selectedReviewNoteId, innerWidth)
      ));
      lines.push(...section(
        "Selected Review Note",
        renderSelectedReviewNoteSection(selectedReviewNote(snapshot, ui), innerWidth)
      ));
    } else {
      lines.push(...section("Diff Review", [styleLine("  No diff review available.", "dim")]));
    }
  }

  const footerLines = [
    styleLine("Detail keys: [ ] cycle task sections", "muted")
  ];
  if (ui.taskDetailSection === "diff") {
    footerLines.push(diffFooter(managedAgentForTask(task)));
  }

  return renderPanel(taskDetailTitle(ui), width, height, [...lines, "", ...footerLines], {
    focused: true
  });
}

function renderRecommendationInspector(
  snapshot: KaviSnapshot | null,
  recommendation: OperatorRecommendation | null,
  width: number,
  height: number
): string[] {
  if (!snapshot || !recommendation) {
    return renderPanel("Inspector | Recommendation", width, height, [
      styleLine("No recommendation selected.", "muted")
    ]);
  }

  const innerWidth = Math.max(16, width - 4);
  const relatedTasks = recommendation.taskIds
    .map((taskId) => snapshot.session.tasks.find((task) => task.id === taskId))
    .filter((task): task is TaskSpec => task !== undefined)
    .map((task) => normalizeTaskSpec(task));
  const relatedReviews = recommendation.reviewNoteIds
    .map((noteId) => snapshot.session.reviewNotes.find((note) => note.id === noteId))
    .filter((note): note is ReviewNote => note !== undefined);
  const targetColor = recommendation.targetAgent === "codex" ? "codex" : recommendation.targetAgent === "claude" ? "claude" : "text";
  const lines = [
    ...section("Recommendation", renderKV([
      ["Status", `${statusSymbol(recommendation.status)} ${recommendation.status}`],
      ["Kind", recommendation.kind],
      ["Target", recommendation.targetAgent ? styleLine(recommendation.targetAgent, targetColor as keyof typeof STYLES) : "-"],
      ["File", recommendation.filePath ?? styleLine("none", "dim")],
      ...(recommendation.dismissedReason ? [["Dismissed", recommendation.dismissedReason] as [string, string]] : []),
    ], innerWidth)),
    ...section("Detail", wrapText(recommendation.detail, innerWidth)),
    ...section(
      "Related Tasks",
      relatedTasks.length > 0
        ? relatedTasks.flatMap((task) =>
            wrapText(`- ${task.id} | ${task.owner} | ${task.status} | ${task.title}`, innerWidth)
          )
        : [styleLine("  none", "dim")]
    ),
    ...section(
      "Related Reviews",
      relatedReviews.length > 0
        ? relatedReviews.flatMap((note) =>
            wrapText(`- ${note.id} | ${note.agent} | ${note.filePath} | ${note.disposition}`, innerWidth)
          )
        : [styleLine("  none", "dim")]
    ),
    ...section("Metadata", formatJson(recommendation.metadata, innerWidth)),
    "",
    styleLine(
      recommendation.status === "dismissed"
        ? "Actions: Z restore"
        : recommendation.kind === "ownership-config"
          ? "Actions: z dismiss"
          : "Actions: Enter apply | P force apply | z dismiss | Z restore",
      "muted"
    )
  ];

  return renderPanel("Inspector | Recommendation", width, height, lines, {
    focused: true
  });
}

function renderApprovalInspector(
  approval: ApprovalRequest | null,
  width: number,
  height: number
): string[] {
  if (!approval) {
    return renderPanel("Inspector | Approval", width, height, [styleLine("No approval selected.", "muted")]);
  }

  const innerWidth = Math.max(16, width - 4);
  const agentColor = approval.agent === "codex" ? "codex" : approval.agent === "claude" ? "claude" : "text";
  const lines = [
    ...section("Approval", renderKV([
      ["Agent", styleLine(approval.agent, agentColor as keyof typeof STYLES)],
      ["Status", `${statusSymbol(approval.status)} ${approval.status}`],
      ["Tool", approval.toolName],
      ["Summary", approval.summary],
      ["Match", styleLine(approval.matchKey, "dim")],
      ["Created", shortTime(approval.createdAt)],
    ], innerWidth)),
    ...section("Payload", formatJson(approval.payload, innerWidth)),
  ];

  return renderPanel("Inspector | Approval", width, height, lines, {
    focused: true
  });
}

function renderClaimInspector(
  snapshot: KaviSnapshot | null,
  claim: PathClaim | null,
  width: number,
  height: number
): string[] {
  const innerWidth = Math.max(16, width - 4);
  const hotspots = snapshot ? buildClaimHotspots(snapshot.session) : [];
  const ownershipConflicts = snapshot ? findOwnershipRuleConflicts(snapshot.session.config) : [];
  const recommendations = recommendationsForClaim(snapshot, claim);
  const lines: string[] = [];

  if (claim) {
    const claimAgentColor = claim.agent === "codex" ? "codex" : claim.agent === "claude" ? "claude" : "text";
    lines.push(
      ...section("Claim", renderKV([
        ["Agent", styleLine(claim.agent, claimAgentColor as keyof typeof STYLES)],
        ["Status", `${statusSymbol(claim.status)} ${claim.status}`],
        ["Source", claim.source],
        ["Task", claim.taskId],
        ...(claim.note ? [["Note", claim.note] as [string, string]] : []),
      ], innerWidth)),
      ...section(
        "Paths",
        claim.paths.length > 0
          ? claim.paths.flatMap((filePath) => wrapText(`- ${filePath}`, innerWidth))
          : [styleLine("  none", "dim")]
      )
    );
  } else {
    lines.push(...section("Claim", ["No claim selected."]));
  }

  lines.push(
    ...section(
      "Hotspots",
      hotspots.length > 0
        ? hotspots.slice(0, 6).flatMap((hotspot) =>
            wrapText(
              `- ${hotspot.path} | agents=${hotspot.agents.join(", ")} | tasks=${hotspot.taskIds.length} | overlaps=${hotspot.overlapCount}`,
              innerWidth
            )
          )
        : [styleLine("  none", "dim")]
    ),
    ...section(
      "Ownership Conflicts",
      ownershipConflicts.length > 0
        ? ownershipConflicts.slice(0, 6).flatMap((conflict) =>
            wrapText(
              `- [${conflict.kind}] ${conflict.leftOwner}:${conflict.leftPattern} <> ${conflict.rightOwner}:${conflict.rightPattern}`,
              innerWidth
            )
          )
        : [styleLine("  none", "dim")]
    )
  );

  lines.push(
    ...section(
      "Recommended Actions",
      recommendations.length > 0
        ? recommendations.slice(0, 4).flatMap((recommendation) =>
            wrapText(`- ${recommendation.title} | ${recommendation.commandHint}`, innerWidth)
          )
        : [styleLine("  none", "dim")]
    )
  );

  return renderPanel("Inspector | Claim", width, height, lines, {
    focused: true
  });
}

function renderDecisionInspector(
  snapshot: KaviSnapshot | null,
  decision: DecisionRecord | null,
  width: number,
  height: number
): string[] {
  if (!decision) {
    return renderPanel("Inspector | Decision", width, height, [styleLine("No decision selected.", "muted")]);
  }

  const innerWidth = Math.max(16, width - 4);
  const recommendations = recommendationsForDecision(snapshot, decision);
  const decAgentColor = decision.agent === "codex" ? "codex" : decision.agent === "claude" ? "claude" : "text";
  const lines = [
    ...section("Decision", renderKV([
      ["Kind", decision.kind],
      ["Agent", decision.agent ? styleLine(decision.agent, decAgentColor as keyof typeof STYLES) : "-"],
      ["Task", decision.taskId ?? styleLine("none", "dim")],
      ["Created", shortTime(decision.createdAt)],
    ], innerWidth)),
    ...section("Summary", wrapText(decision.summary, innerWidth)),
    ...section("Detail", wrapText(decision.detail, innerWidth)),
    ...section(
      "Recommended Actions",
      recommendations.length > 0
        ? recommendations.slice(0, 4).flatMap((recommendation) =>
            wrapText(`- ${recommendation.title} | ${recommendation.commandHint}`, innerWidth)
          )
        : [styleLine("  none", "dim")]
    )
  ];

  return renderPanel("Inspector | Decision", width, height, lines, {
    focused: true
  });
}

function renderActivityInspector(
  snapshot: KaviSnapshot | null,
  entry: WorkflowActivityEntry | null,
  width: number,
  height: number
): string[] {
  if (!snapshot) {
    return renderPanel("Inspector | Activity", width, height, [styleLine("No activity selected.", "muted")]);
  }

  const innerWidth = Math.max(16, width - 4);
  const summary = buildWorkflowSummary(snapshot);
  const lines = [
    ...section("Workflow", renderKV([
      ["Goal", summary.goal ?? "-"],
      ["Stage", summary.stage.label],
      ["Detail", summary.stage.detail],
      ["Land", summary.landReadiness.state],
    ], innerWidth)),
    ...section("Tasks", [
      `  ${styleLine("●", "warn")} ${summary.taskCounts.running} running  ${styleLine("○", "muted")} ${summary.taskCounts.pending} pending  ${styleLine("✓", "good")} ${summary.taskCounts.completed} done  ${styleLine("✗", "bad")} ${summary.taskCounts.failed} failed`,
      `  ${styleLine("Approvals:", "dim")} ${summary.approvalCounts.pending > 0 ? styleLine(`${summary.approvalCounts.pending} pending`, "warn") : "0"}  ${styleLine("Reviews:", "dim")} ${summary.reviewCounts.open > 0 ? styleLine(`${summary.reviewCounts.open} open`, "warn") : "0"}`,
      `Recommendations: active=${summary.recommendationCounts.active} dismissed=${summary.recommendationCounts.dismissed}`
    ].flatMap((line) => wrapText(line, innerWidth))),
    ...section(
      "Latest Land",
      summary.latestLandReport
        ? renderKV([
            ["Target", summary.latestLandReport.targetBranch],
            ["When", shortTime(summary.latestLandReport.createdAt)],
          ], innerWidth)
        : [styleLine("  No landed result recorded yet.", "dim")]
    ),
    ...section(
      "Changed Surface",
      summary.changedByAgent.flatMap((changeSet) =>
        wrapText(
          `- ${changeSet.agent}: ${changeSet.paths.length} path(s)${changeSet.paths.length > 0 ? ` | ${changeSet.paths.join(", ")}` : ""}`,
          innerWidth
        )
      )
    ),
    ...section(
      "Next Actions",
      summary.landReadiness.nextActions.length > 0
        ? summary.landReadiness.nextActions.flatMap((action) => wrapText(`- ${action}`, innerWidth))
        : [styleLine("  none", "dim")]
    ),
    ...section(
      "Selected Activity",
      entry
        ? [
            ...wrapText(`Title: ${entry.title}`, innerWidth),
            ...wrapText(`When: ${shortTime(entry.timestamp)}`, innerWidth),
            ...wrapText(`Detail: ${entry.detail}`, innerWidth)
          ]
        : ["No activity entry selected."]
    )
  ];

  return renderPanel("Inspector | Activity", width, height, lines, {
    focused: true
  });
}

function renderResultInspector(
  snapshot: KaviSnapshot | null,
  selectedId: string | null,
  width: number,
  height: number
): string[] {
  if (!snapshot) {
    return renderPanel("Inspector | Result", width, height, [styleLine("No result selected.", "muted")]);
  }

  const innerWidth = Math.max(16, width - 4);
  const result = buildWorkflowResult(snapshot);
  const activePlan = currentExecutionPlan(snapshot.session);

  if (!selectedId || selectedId === "result:current") {
    const lines = [
      ...(result.activeMission
        ? section("Mission", renderKV([
            ["Title", result.activeMission.title],
            ["Status", `${statusSymbol(result.activeMission.status)} ${result.activeMission.status}`],
            ["Acceptance", result.activeMission.acceptance.status],
          ], innerWidth))
        : []),
      ...(result.missionObservability
        ? section("Mission Runtime", renderKV([
            ["Tasks", `${result.missionObservability.completedTasks}/${result.missionObservability.totalTasks} completed`],
            ["Running", `${result.missionObservability.runningTasks}`],
            ["Pending", `${result.missionObservability.pendingTasks}`],
            ["Repairs", `${result.missionObservability.activeRepairTasks}`],
            ["Retries", `${result.missionObservability.retriesUsed}`],
            ["Stalled", `${result.missionObservability.stalledTasks}`],
            ["Active Owners", `${result.missionObservability.activeOwners.join(", ") || "-"}`],
            ["Changed Paths", `${result.missionObservability.changedPaths}`],
          ], innerWidth))
        : []),
      ...(result.missionObservability?.criticalPath.length
        ? section(
            "Critical Path",
            wrapText(result.missionObservability.criticalPath.join(" -> "), innerWidth)
          )
        : []),
      ...(result.missionObservability?.nextReadyNodes.length
        ? section(
            "Next Ready Nodes",
            result.missionObservability.nextReadyNodes.flatMap((node) =>
              wrapText(`- ${node.owner} | ${node.key} | ${node.title}`, innerWidth)
            )
          )
        : []),
      ...section("Workflow", renderKV([
        ["Goal", result.goal ?? "-"],
        ["Stage", result.stage.label],
        ["Headline", result.headline],
      ], innerWidth)),
      ...(result.missionObservability?.latestFailure
        ? section(
            "Latest Failure",
            wrapText(
              `${result.missionObservability.latestFailure.taskId} | ${result.missionObservability.latestFailure.summary}`,
              innerWidth
            )
          )
        : result.missionObservability?.latestProgress
          ? section(
              "Latest Progress",
              wrapText(
                `${result.missionObservability.latestProgress.taskId} | ${result.missionObservability.latestProgress.summary}`,
                innerWidth
              )
            )
          : []),
      ...section(
        "Changed Surface",
        result.changedByAgent.flatMap((changeSet) =>
          wrapText(
            `- ${changeSet.agent}: ${changeSet.paths.length} path(s)${changeSet.paths.length > 0 ? ` | ${changeSet.paths.join(", ")}` : ""}`,
            innerWidth
          )
        )
      ),
      ...section(
        "Next Actions",
        result.nextActions.length > 0
          ? result.nextActions.flatMap((action) => wrapText(`- ${action}`, innerWidth))
          : [styleLine("  none", "dim")]
      ),
      ...section(
        "Result Summary",
        result.summaryLines.flatMap((line) => wrapText(`- ${line}`, innerWidth))
      ),
      ...section(
        "Execution Plan",
        activePlan
          ? [
              ...renderKV([
                ["Plan", activePlan.title],
                ["Status", `${statusSymbol(activePlan.status)} ${activePlan.status}`],
              ], innerWidth),
              ...(activePlan.summary ? wrapText(`  ${activePlan.summary}`, innerWidth) : []),
              "",
              ...activePlan.nodes.flatMap((node) => {
                const nodeOwnerColor = node.owner === "codex" ? "codex" : node.owner === "claude" ? "claude" : "dim";
                return wrapText(
                  `  ${statusSymbol(node.status)} ${styleLine(node.owner, nodeOwnerColor as keyof typeof STYLES)} ${node.title}${node.dependsOn.length ? styleLine(` ← ${node.dependsOn.join(", ")}`, "dim") : ""}`,
                  innerWidth
                );
              })
            ]
          : [styleLine("  No execution plan yet.", "dim")]
      )
    ];

    return renderPanel("Inspector | Result", width, height, lines, {
      focused: true
    });
  }

  if (selectedId.startsWith("result:mission:")) {
    const mission = result.activeMission;
    if (!mission) {
      return renderPanel("Inspector | Result", width, height, [styleLine("No mission is active.", "muted")]);
    }
    const observability = result.missionObservability;
    const missionBrainEntries = filteredMissionBrainEntries(snapshot, ui);
    const selectedBrain = selectedBrainEntry(snapshot, ui);
    const mergeSourceBrain = brainMergeSourceEntry(snapshot, ui);
    const selectedBrainExplanation = brainExplanationLines(snapshot, selectedBrain?.id ?? null);
    const selectedBrainRelated = relatedBrainEntriesForSelection(snapshot, ui);
    const selectedBrainGraph = filteredBrainGraph(snapshot, ui);
    const selectedBrainGraphEntries = graphNeighborEntriesForSelection(snapshot, ui);
    const selectedBrainEvidence = selectedBrainEvidenceTargets(snapshot, ui);
    const selectedBrainEvidenceTarget = selectedBrainEvidence[ui.selectedBrainEvidenceIndex] ?? null;
    const shadowFamily = snapshot.session.missions.filter((item) =>
      item.id === mission.id ||
      item.shadowOfMissionId === mission.id ||
      item.id === mission.shadowOfMissionId ||
      (mission.shadowOfMissionId && item.shadowOfMissionId === mission.shadowOfMissionId)
    );
    const shadowComparisons = compareMissionFamily(snapshot, mission);
    const preferredShadowComparison = shadowComparisons[0] ?? null;

    const lines = [
      ...section("Mission", renderKV([
        ["Title", mission.title],
        ["Status", `${statusSymbol(mission.status)} ${mission.status}`],
        ["Mode", mission.mode],
        ["Autopilot", mission.autopilotEnabled ? styleLine("guided", "good") : "manual"],
        ["Acceptance", mission.acceptance.status],
        ["Health", mission.health ? `${mission.health.state} (${mission.health.score})` : "-"],
        ["Policy", mission.policy ? `${mission.policy.autonomyLevel} | ${mission.policy.approvalMode} | retry ${mission.policy.retryBudget}` : "-"],
        ["Patterns", (mission.appliedPatternIds ?? []).length > 0 ? mission.appliedPatternIds!.length.toString() : "-"],
        ["Selected", snapshot.session.selectedMissionId === mission.id ? "yes" : "no"],
      ], innerWidth)),
      ...section("Recovery Controls", renderKV([
        ["Autonomy", mission.policy?.autonomyLevel ?? "-"],
        ["Retry Budget", mission.policy ? String(mission.policy.retryBudget) : "-"],
        ["Auto Verify", mission.policy?.autoVerify ? "on" : "off"],
        ["Auto Land", mission.policy?.autoLand ? "on" : "off"],
        ["Pause On Repair Fail", mission.policy?.pauseOnRepairFailure ? "on" : "off"],
        ["Autopilot", mission.autopilotEnabled ? "on" : "off"]
      ], innerWidth)),
      ...(mission.summary ? section("Summary", wrapText(mission.summary, innerWidth)) : []),
      ...(shadowFamily.length > 1
        ? section(
            "Shadow Family",
            shadowFamily.flatMap((item) =>
              wrapText(
                `${item.id === mission.id ? ">" : "-"} ${item.title} | ${item.status} | acceptance=${item.acceptance.status} | health=${item.health?.state ?? "-"}:${item.health?.score ?? "-"}${item.shadowOfMissionId ? ` | shadow of ${item.shadowOfMissionId}` : ""}`,
                innerWidth
              )
            )
          )
        : []),
      ...(shadowComparisons.length > 0
        ? section(
            "Shadow League",
            shadowComparisons.flatMap((comparison) =>
              wrapText(
                `- ${comparison.rightMission.title} (${comparison.rightMission.id}) | alt=${comparison.rightScore} vs focus=${comparison.leftScore} | preferred=${comparison.preferredMissionId ?? "tie"} | overlap=${comparison.changedPathOverlap.length} | acceptance=${comparison.rightMission.acceptance.status} | failed=${comparison.rightAcceptanceFailures.length}`,
                innerWidth
              )
            )
          )
        : []),
      ...(preferredShadowComparison
        ? section(
            "Shadow Comparison",
            [
              `Current score: ${preferredShadowComparison.leftScore}`,
              `Alternative: ${preferredShadowComparison.rightMission.title} (${preferredShadowComparison.rightMission.id})`,
              `Alternative score: ${preferredShadowComparison.rightScore}`,
              `Recommendation: ${preferredShadowComparison.recommendation}`,
              `Changed overlap: ${preferredShadowComparison.changedPathOverlap.join(", ") || "-"}`,
              `Current-only paths: ${preferredShadowComparison.leftOnlyPaths.join(", ") || "-"}`,
              `Alternative-only paths: ${preferredShadowComparison.rightOnlyPaths.join(", ") || "-"}`,
              `Current failed acceptance: ${preferredShadowComparison.leftAcceptanceFailures.join(" | ") || "-"}`,
              `Alternative failed acceptance: ${preferredShadowComparison.rightAcceptanceFailures.join(" | ") || "-"}`,
              `Top alternative factors: ${preferredShadowComparison.dimensions
                .filter((dimension) => dimension.preferred === "right")
                .sort((left, right) => right.weight - left.weight)
                .slice(0, 3)
                .map((dimension) => `${dimension.label} (${dimension.weight})`)
                .join(" | ") || "-"}`,
              ...preferredShadowComparison.dimensions.slice(0, 4).map((dimension) =>
                `${dimension.label}: ${dimension.preferred} | left=${dimension.leftValue} | right=${dimension.rightValue}`
              )
            ].flatMap((line) => wrapText(line, innerWidth))
          )
        : []),
      ...(observability
        ? section("Observability", renderKV([
            ["Tasks", `${observability.completedTasks}/${observability.totalTasks} completed`],
            ["Running", `${observability.runningTasks}`],
            ["Pending", `${observability.pendingTasks}`],
            ["Repairs", `${observability.activeRepairTasks}`],
            ["Retries", `${observability.retriesUsed}`],
            ["Stalled", `${observability.stalledTasks}`],
            ["Active Owners", `${observability.activeOwners.join(", ") || "-"}`],
            ["Changed Paths", `${observability.changedPaths}`],
          ], innerWidth))
        : []),
      ...(observability?.criticalPath.length
        ? section("Critical Path", wrapText(observability.criticalPath.join(" -> "), innerWidth))
        : []),
      ...(observability?.nextReadyNodes.length
        ? section(
            "Next Ready Nodes",
            observability.nextReadyNodes.flatMap((node) =>
              wrapText(`- ${node.owner} | ${node.key} | ${node.title}`, innerWidth)
            )
          )
        : []),
      ...(observability?.latestFailure
        ? section("Latest Failure", wrapText(`${observability.latestFailure.taskId} | ${observability.latestFailure.summary}`, innerWidth))
        : observability?.latestProgress
          ? section("Latest Progress", wrapText(`${observability.latestProgress.taskId} | ${observability.latestProgress.summary}`, innerWidth))
          : []),
      ...(observability?.recentProgress.length
        ? section(
            "Recent Runtime Activity",
            observability.recentProgress.flatMap((entry) =>
              wrapText(
                `- ${entry.provider ?? entry.kind}${entry.eventName ? `:${entry.eventName}` : ""}${entry.source ? `@${entry.source}` : ""} | ${shortTime(entry.createdAt)} | ${entry.summary}`,
                innerWidth
              )
            )
          )
        : []),
      ...section(
        "Mission Packet",
        [
          `Workstreams: ${mission.spec?.workstreamKinds.join(", ") || "-"}`,
          `Stack hints: ${mission.spec?.stackHints.join(", ") || "-"}`,
          `Deliverables: ${mission.spec?.requestedDeliverables.join(", ") || "-"}`,
          `Roles: ${mission.spec?.userRoles.join(", ") || "-"}`,
          `Entities: ${mission.spec?.domainEntities.join(", ") || "-"}`,
          `Constraints: ${mission.spec?.constraints.join(" | ") || "-"}`
        ].flatMap((line) => wrapText(line, innerWidth))
      ),
      ...section(
        "Brain Context",
        [
          ...wrapText(
            `Filters: query=${ui.brainFilters.query || "-"} | category=${ui.brainFilters.category} | scope=${ui.brainFilters.scope} | retired=${ui.brainFilters.includeRetired ? "on" : "off"} | focus=${ui.brainFilters.focusArea} | graph=${ui.brainFilters.graphMode} | path=${ui.brainFilters.pathHint || "-"}`,
            innerWidth
          ),
          ...(missionBrainEntries.length > 0
          ? missionBrainEntries
              .slice(0, 8)
              .flatMap((entry) =>
                wrapText(
                  `${entry.id === ui.selectedBrainEntryId ? (ui.brainFilters.focusArea === "entries" ? ">" : "*") : "-"} ${entry.pinned ? "[pinned] " : ""}${entry.category ?? "artifact"} | ${entry.title} | ${entry.content}`,
                  innerWidth
                ).map((line) =>
                  toneLine(
                    line,
                    entry.retiredAt ? "muted" : entry.pinned ? "good" : "normal",
                    entry.id === ui.selectedBrainEntryId
                  )
                )
              )
          : [styleLine("  none", "dim")])
        ]
      ),
      ...(selectedBrain
        ? section(
            "Selected Brain Entry",
            [
              ...renderKV([
                ["Title", selectedBrain.title],
                ["Category", selectedBrain.category ?? "artifact"],
                ["Scope", selectedBrain.scope ?? "-"],
                ["Pinned", selectedBrain.pinned ? "yes" : "no"],
                ["Freshness", selectedBrain.freshness ?? "-"],
                ["Retired", selectedBrain.retiredAt ?? "no"],
                ["Confidence", typeof selectedBrain.confidence === "number" ? selectedBrain.confidence.toFixed(2) : "-"],
                ["Supersedes", (selectedBrain.supersedes ?? []).length ? String(selectedBrain.supersedes?.length ?? 0) : "0"],
                ["Superseded By", selectedBrain.supersededBy ?? "-"],
                ["Contradictions", (selectedBrain.contradictions ?? []).length ? String(selectedBrain.contradictions?.length ?? 0) : "0"],
              ], innerWidth),
              ...wrapText(selectedBrain.content, innerWidth),
              ...section(
                "Evidence Trail",
                (selectedBrain.evidence ?? []).length > 0
                  ? selectedBrain.evidence!.flatMap((item) => wrapText(`- ${item}`, innerWidth))
                  : [styleLine("  none", "dim")]
              ),
              ...section(
                "Commands",
                (selectedBrain.commands ?? []).length > 0
                  ? selectedBrain.commands!.flatMap((item) => wrapText(`- ${item}`, innerWidth))
                  : [styleLine("  none", "dim")]
              )
            ]
          )
        : []),
      ...(selectedBrainRelated.length > 0
        ? section(
            "Related Brain Entries",
            selectedBrainRelated.flatMap((entry) =>
              wrapText(
                `${entry.id === ui.selectedBrainRelatedEntryId ? (ui.brainFilters.focusArea === "related" ? ">" : "*") : "-"} ${entry.retiredAt ? "[retired] " : ""}${entry.title} | ${entry.category ?? "artifact"} | ${entry.scope ?? "-"} | ${entry.id}`,
                innerWidth
              )
            )
          )
        : []),
      ...(selectedBrainExplanation.length > 0
        ? section("Brain Explanation", selectedBrainExplanation.flatMap((line) => wrapText(line, innerWidth)))
        : []),
      ...(selectedBrain
        ? section(
            "Brain Graph Lens",
            [
              `Mode: ${ui.brainFilters.graphMode}`,
              `Path focus: ${ui.brainFilters.pathHint || "-"}`,
              `Neighbors: ${selectedBrainGraphEntries.length}`,
              `Edges: ${selectedBrainGraph?.edges.length ?? 0}`
            ].flatMap((line) => wrapText(line, innerWidth))
          )
        : []),
      ...(selectedBrain && selectedBrainGraph
        ? section(
            "Brain Graph Neighborhood",
            selectedBrainGraphEntries.flatMap((entry) => {
              const edge = selectedBrainGraph.edges.find((candidate) =>
                (candidate.from === selectedBrain.id && candidate.to === entry.id) ||
                (candidate.to === selectedBrain.id && candidate.from === entry.id)
              ) ?? null;
              return wrapText(
                `${entry.id === ui.selectedBrainGraphEntryId ? (ui.brainFilters.focusArea === "graph" ? ">" : "*") : "-"} ${edge?.kind ?? "graph"} | ${edge?.label ?? "related"} | ${entry.title} (${entry.id})`,
                innerWidth
              );
            })
          )
        : []),
      ...(selectedBrainEvidence.length > 0
        ? section(
            "Brain Evidence Targets",
            selectedBrainEvidence.flatMap((item, index) =>
              wrapText(
                `${index === ui.selectedBrainEvidenceIndex ? (ui.brainFilters.focusArea === "evidence" ? ">" : "*") : "-"} ${item}`,
                innerWidth
              )
            ).concat(
              selectedBrainEvidenceTarget
                ? wrapText(`Focus action: ${selectedBrainEvidenceTarget.includes("/") || /\.[a-z0-9]+$/i.test(selectedBrainEvidenceTarget) ? "set path lens and graph focus" : "search entries using this target"}`, innerWidth)
                : []
            )
          )
        : []),
      ...(mergeSourceBrain
        ? section(
            "Brain Merge Draft",
            [
              `Source: ${mergeSourceBrain.title}`,
              `Target: ${selectedBrain?.title ?? "-"}`,
              mergeSourceBrain.id === selectedBrain?.id
                ? "Choose a different selected entry before merging."
                : "Press U to merge the marked source into the current selected entry."
            ].flatMap((line) => wrapText(line, innerWidth))
          )
        : []),
      ...section(
        "Pattern Lineage",
        (mission.appliedPatternIds ?? []).length > 0
          ? mission.appliedPatternIds!.flatMap((patternId) => wrapText(`- ${patternId}`, innerWidth))
          : [styleLine("  none", "dim")]
      ),
      ...section(
        "Risks",
        (mission.risks ?? []).length > 0
          ? (mission.risks ?? []).flatMap((risk) =>
              wrapText(`- ${risk.severity} | ${risk.title} | ${risk.mitigation}`, innerWidth)
            )
          : [styleLine("  none", "dim")]
      ),
      ...section(
        "Acceptance Criteria",
        mission.acceptance.criteria.length > 0
          ? mission.acceptance.criteria.flatMap((item) => wrapText(`- ${item}`, innerWidth))
          : [styleLine("  none", "dim")]
      ),
      ...section(
        "Acceptance Checks",
        mission.acceptance.checks.length > 0
          ? mission.acceptance.checks.flatMap((check) =>
              wrapText(`- ${check.kind} | ${check.status} | ${check.title} | ${check.detail}`, innerWidth)
            )
          : [styleLine("  none", "dim")]
      ),
      ...section(
        "Recent Checkpoints",
        mission.checkpoints.length > 0
          ? mission.checkpoints
              .slice(-8)
              .flatMap((checkpoint) => wrapText(`- ${shortTime(checkpoint.createdAt)} | ${checkpoint.title} | ${checkpoint.detail}`, innerWidth))
          : [styleLine("  none", "dim")]
      )
    ];

    return renderPanel("Inspector | Result", width, height, lines, {
      focused: true
    });
  }

  if (selectedId.startsWith("result:land:")) {
    const report = snapshot.latestLandReport;
    if (!report) {
      return renderPanel("Inspector | Result", width, height, [styleLine("No land report is available yet.", "muted")]);
    }

    const lines = [
      ...section("Latest Land", [
        `Report: ${report.id}`,
        `Created: ${shortTime(report.createdAt)}`,
        `Target branch: ${report.targetBranch}`,
        `Integration branch: ${report.integrationBranch}`,
        `Integration path: ${report.integrationPath}`,
        `Validation: ${report.validationCommand.trim() || "(none configured)"} | ${report.validationStatus}`,
        `Validation detail: ${report.validationDetail}`,
        `Review threads landed: ${report.reviewThreadsLanded}`,
        `Open review threads remaining: ${report.openReviewThreadsRemaining}`
      ].flatMap((line) => wrapText(line, innerWidth))),
      ...section(
        "Merged Surface",
        report.changedByAgent.flatMap((changeSet) =>
          wrapText(
            `- ${changeSet.agent}: ${changeSet.paths.length} path(s)${changeSet.paths.length > 0 ? ` | ${changeSet.paths.join(", ")}` : ""}`,
            innerWidth
          )
        )
      ),
      ...section(
        "Summary",
        report.summary.flatMap((line) => wrapText(`- ${line}`, innerWidth))
      ),
      ...section(
        "Commands",
        report.commandsRun.length > 0
          ? report.commandsRun.flatMap((command) => wrapText(`- ${command}`, innerWidth))
          : [styleLine("  none", "dim")]
      )
    ];

    return renderPanel("Inspector | Result", width, height, lines, {
      focused: true
    });
  }

  if (selectedId.startsWith("result:agent:")) {
    const agentName = selectedId.replace("result:agent:", "") as AgentName;
    const agent = result.agentResults.find((item) => item.agent === agentName) ?? null;
    if (!agent) {
      return renderPanel("Inspector | Result", width, height, [styleLine("No agent result selected.", "muted")]);
    }

    const lines = [
      ...section("Agent Result", [
        `Agent: ${agent.agent}`,
        `Completed tasks: ${agent.completedTaskCount}`,
        `Latest task: ${agent.latestTaskTitle ?? "-"}`,
        `Latest task id: ${agent.latestTaskId ?? "-"}`,
        `Last run: ${shortTime(agent.lastRunAt)}`
      ].flatMap((line) => wrapText(line, innerWidth))),
      ...section(
        "Latest Summary",
        wrapText(agent.latestSummary ?? "No completed result yet.", innerWidth)
      ),
      ...section(
        "Current Paths",
        agent.changedPaths.length > 0
          ? agent.changedPaths.flatMap((filePath) => wrapText(`- ${filePath}`, innerWidth))
          : [styleLine("  clean", "good")]
      ),
      ...section(
        "Latest Landed Paths",
        agent.landedPaths.length > 0
          ? agent.landedPaths.flatMap((filePath) => wrapText(`- ${filePath}`, innerWidth))
          : [styleLine("  none", "dim")]
      )
    ];

    return renderPanel("Inspector | Result", width, height, lines, {
      focused: true
    });
  }

  return renderPanel("Inspector | Result", width, height, [styleLine("No result selected.", "muted")]);
}

function renderMessageInspector(
  message: PeerMessage | null,
  width: number,
  height: number
): string[] {
  if (!message) {
    return renderPanel("Inspector | Message", width, height, [styleLine("No peer message selected.", "muted")]);
  }

  const innerWidth = Math.max(16, width - 4);
  const fromColor = message.from === "codex" ? "codex" : message.from === "claude" ? "claude" : "text";
  const toColor = message.to === "codex" ? "codex" : message.to === "claude" ? "claude" : "text";
  const lines = [
    ...section("Message", renderKV([
      ["From", styleLine(message.from, fromColor as keyof typeof STYLES)],
      ["To", styleLine(message.to, toColor as keyof typeof STYLES)],
      ["Intent", message.intent],
      ["Subject", message.subject],
      ["Created", shortTime(message.createdAt)],
    ], innerWidth)),
    ...section("Body", wrapText(message.body, innerWidth))
  ];

  return renderPanel("Inspector | Message", width, height, lines, {
    focused: true
  });
}

function renderWorktreeInspector(
  snapshot: KaviSnapshot | null,
  worktree: WorktreeInfo | null,
  diffEntry: DiffReviewCacheEntry | null,
  loadingDiff: boolean,
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  if (!snapshot || !worktree) {
    return renderPanel("Inspector | Worktree", width, height, [styleLine("No worktree selected.", "muted")]);
  }

  const diff = findWorktreeDiff(snapshot, worktree.agent);
  const status = snapshot.session.agentStatus[worktree.agent];
  const ownedTasks = normalizeTaskSpecs(snapshot.session.tasks)
    .filter((task) => task.owner === worktree.agent)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4);
  const innerWidth = Math.max(16, width - 4);
  const wtAgentColor = worktree.agent === "codex" ? "codex" : "claude";
  const lines = [
    ...section("Worktree", renderKV([
      ["Agent", styleLine(worktree.agent, wtAgentColor as keyof typeof STYLES)],
      ["Branch", worktree.branch],
      ["Transport", status.transport],
      ["Status", status.available ? styleLine("● available", "good") : styleLine("● unavailable", "bad")],
    ], innerWidth)),
    ...section(
      "Changed Paths",
      diff?.paths.length
        ? diff.paths.flatMap((filePath) => {
            const selected = filePath === diffEntry?.review?.selectedPath;
            return wrapText(
              `${selected ? styleLine("▸", "accent") : " "} ${filePath}`,
              innerWidth
            );
          })
        : [styleLine("  clean", "good")]
    ),
    ...section(
      "Recent Tasks",
      ownedTasks.length
        ? ownedTasks.flatMap((task) => wrapText(`  ${statusSymbol(task.status)} ${task.title}`, innerWidth))
        : [styleLine("  none", "dim")]
    )
  ];

  if (loadingDiff) {
    lines.push(...section("Diff Review", [`${spinner()} Loading diff...`]));
  } else if (diffEntry?.error) {
    lines.push(...section("Diff Review", wrapText(`Diff load failed: ${diffEntry.error}`, innerWidth)));
  } else if (diffEntry?.review) {
    const hunks = parseDiffHunks(diffEntry.review.patch);
    const hunkIndex = selectedHunkIndex(ui, worktree.agent, diffEntry.review);
    const selectedHunk = hunkIndex === null ? null : hunks[hunkIndex] ?? null;
    const reviewNotes = reviewNotesForContext(snapshot, activeReviewContext(snapshot, ui), ui.reviewFilters);
    lines.push(...section("Review", renderKV([
      ["File", diffEntry.review.selectedPath ?? "-"],
      ["Hunk", hunkIndex === null ? "-" : `${hunkIndex + 1}/${hunks.length}`],
      ["Notes", `${reviewNotes.length}`],
      ["Stat", diffEntry.review.stat],
    ], innerWidth)));
    if (selectedHunk) {
      lines.push(...section(
        "Current Hunk",
        [selectedHunk.header, ...selectedHunk.lines].map(styleDiffLine)
      ));
    }
    lines.push(...section(
      "Patch",
      diffEntry.review.patch
        ? renderStyledDiffBlock(diffEntry.review.patch)
        : [styleLine("  No patch available.", "dim")]
    ));
    lines.push(...section(
      "Review Notes",
      renderReviewNotesSection(reviewNotes, ui.selectedReviewNoteId, innerWidth)
    ));
    lines.push(...section(
      "Selected Review Note",
      renderSelectedReviewNoteSection(selectedReviewNote(snapshot, ui), innerWidth)
    ));
  } else {
    lines.push(...section("Diff Review", [styleLine("  No diff review available.", "dim")]));
  }

  lines.push("");
  lines.push(diffFooter(worktree.agent));

  return renderPanel("Inspector | Worktree", width, height, lines, {
    focused: true
  });
}

function renderInspector(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  switch (ui.activeTab) {
    case "activity":
      return renderActivityInspector(snapshot, selectedActivityEntry(snapshot, ui), width, height);
    case "results":
      return renderResultInspector(snapshot, selectedResultItem(snapshot, ui)?.id ?? null, width, height);
    case "tasks":
      return renderTaskInspector(
        selectedTask(snapshot, ui),
        artifactForTask(ui, selectedTask(snapshot, ui)),
        selectedTask(snapshot, ui) ? ui.loadingArtifacts[selectedTask(snapshot, ui)?.id ?? ""] === true : false,
        diffEntryForAgent(ui, managedAgentForTask(selectedTask(snapshot, ui))),
        managedAgentForTask(selectedTask(snapshot, ui))
          ? ui.loadingDiffReviews[managedAgentForTask(selectedTask(snapshot, ui)) ?? "codex"] === true
          : false,
        snapshot,
        ui,
        width,
        height
      );
    case "recommendations":
      return renderRecommendationInspector(snapshot, selectedRecommendation(snapshot, ui), width, height);
    case "approvals":
      return renderApprovalInspector(selectedApproval(snapshot, ui), width, height);
    case "claims":
      return renderClaimInspector(snapshot, selectedClaim(snapshot, ui), width, height);
    case "decisions":
      return renderDecisionInspector(snapshot, selectedDecision(snapshot, ui), width, height);
    case "messages":
      return renderMessageInspector(selectedMessage(snapshot, ui), width, height);
    case "worktrees":
      return renderWorktreeInspector(
        snapshot,
        selectedWorktree(snapshot, ui),
        diffEntryForAgent(ui, selectedWorktree(snapshot, ui)?.agent ?? null),
        selectedWorktree(snapshot, ui)
          ? ui.loadingDiffReviews[selectedWorktree(snapshot, ui)?.agent ?? "codex"] === true
          : false,
        ui,
        width,
        height
      );
    default:
      return renderPanel("Inspector", width, height, [styleLine("No inspector data.", "muted")]);
  }
}

function renderAgentStripLine(
  snapshot: KaviSnapshot | null,
  agent: "codex" | "claude",
  width: number
): string {
  const agentColor = agent === "codex" ? "codex" : "claude";
  const label = agent === "codex" ? "Codex" : "Claude";
  if (!snapshot) {
    return fitAnsiLine(`  ${styleLine("●", "dim")} ${styleLine(label, agentColor as keyof typeof STYLES)}  ${styleLine("no snapshot", "dim")}`, width);
  }

  const status = snapshot.session.agentStatus[agent];
  const diff = findWorktreeDiff(snapshot, agent);
  const tasks = normalizeTaskSpecs(snapshot.session.tasks).filter((t) => t.owner === agent);
  const running = tasks.filter((t) => t.status === "running");
  const statusDot = status.available ? styleLine("●", "good") : styleLine("●", "bad");
  const taskInfo = running.length > 0
    ? `${styleLine("●", "warn")} ${styleLine(`"${running[0].title}"`, "text")}`
    : styleLine("○ idle", "dim");
  const diffCount = diff?.paths.length ?? 0;
  const diffInfo = diffCount > 0
    ? styleLine(`${diffCount} file${diffCount > 1 ? "s" : ""} changed`, "info")
    : styleLine("clean", "dim");
  const elapsed = status.lastRunAt
    ? (() => {
        const ms = Date.now() - new Date(status.lastRunAt).getTime();
        const mins = Math.floor(ms / 60000);
        return mins < 1 ? "just now" : `${mins}m ago`;
      })()
    : "";
  const lastRun = !running.length && elapsed ? styleLine(`last: ${elapsed}`, "dim") : "";

  const parts = [
    `  ${statusDot} ${styleLine(label, agentColor as keyof typeof STYLES)}`,
    `  ${taskInfo}`,
    `  ${diffInfo}`,
    lastRun ? `  ${lastRun}` : ""
  ].filter(Boolean);

  return fitAnsiLine(parts.join(""), width);
}

function renderAgentStrip(
  snapshot: KaviSnapshot | null,
  width: number
): string[] {
  return [
    renderAgentStripLine(snapshot, "codex", width),
    renderAgentStripLine(snapshot, "claude", width)
  ];
}

function renderLane(
  snapshot: KaviSnapshot | null,
  agent: "codex" | "claude",
  width: number,
  height: number
): string[] {
  if (!snapshot) {
    return renderPanel(
      `${agent === "codex" ? "Codex" : "Claude"} Lane`,
      width,
      height,
      [styleLine("No session snapshot available.", "muted")]
    );
  }

  const status = snapshot.session.agentStatus[agent];
  const worktree = snapshot.session.worktrees.find((item) => item.agent === agent);
  const diff = findWorktreeDiff(snapshot, agent);
  const tasks = normalizeTaskSpecs(snapshot.session.tasks)
    .filter((task) => task.owner === agent)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const approvals = snapshot.approvals.filter(
    (approval) => approval.agent === agent && approval.status === "pending"
  );
  const claims = snapshot.session.pathClaims.filter(
    (claim) => claim.agent === agent && claim.status === "active"
  );
  const innerWidth = Math.max(16, width - 4);
  const lines = [
    ...section("Status", [
      `${status.available ? styleLine("● Available", "good") : styleLine("● Unavailable", "bad")}`,
      `Transport: ${status.transport}`,
      `Last run: ${shortTime(status.lastRunAt)}`,
      `Exit: ${status.lastExitCode ?? "-"}`
    ].flatMap((line) => wrapText(line, innerWidth))),
    ...section("Session", [
      `Session: ${status.sessionId ?? styleLine("none", "dim")}`,
      `Worktree: ${worktree ? path.basename(worktree.path) : styleLine("none", "dim")}`,
      `Branch: ${worktree?.branch ?? styleLine("none", "dim")}`,
      `Approvals: ${approvals.length > 0 ? styleLine(`${approvals.length} pending`, "warn") : "0"}`,
      `Changed: ${(diff?.paths.length ?? 0) > 0 ? styleLine(`${diff?.paths.length} paths`, "info") : "0"}`,
      `Reviews: ${countOpenReviewNotes(snapshot, agent) > 0 ? styleLine(`${countOpenReviewNotes(snapshot, agent)} open`, "warn") : "0"}`
    ].flatMap((line) => wrapText(line, innerWidth))),
    ...section("Summary", wrapText(status.summary ?? styleLine("No summary yet.", "dim"), innerWidth)),
    ...section(
      "Tasks",
      tasks.length
        ? tasks.slice(0, 4).flatMap((task) => wrapText(`${statusSymbol(task.status)} ${task.title}`, innerWidth))
        : [styleLine("none", "dim")]
    ),
    ...section(
      "Claims",
      claims.length
        ? claims.slice(0, 3).flatMap((claim) => wrapText(`  ${claim.paths.join(", ")}`, innerWidth))
        : [styleLine("none", "dim")]
    ),
    ...section(
      "Diff",
      diff?.paths.length
        ? diff.paths.slice(0, 4).flatMap((filePath) => wrapText(`  ${filePath}`, innerWidth))
        : [styleLine("clean", "good")]
    )
  ];

  return renderPanel(`${agent === "codex" ? "Codex" : "Claude"} Lane`, width, height, lines);
}

function renderHeader(
  view: OperatorView,
  ui: OperatorUiState,
  width: number
): string[] {
  const snapshot = view.snapshot;
  const session = snapshot?.session ?? null;
  const tasks = session ? normalizeTaskSpecs(session.tasks) : [];
  const workflowSummary = snapshot ? buildWorkflowSummary(snapshot) : null;
  const mission = workflowSummary?.activeMission ?? null;
  const compatibility = view.compatibility ?? compatibilityForView(view);
  const repoName = path.basename(session?.repoRoot ?? process.cwd());
  const connectionDot = view.connected
    ? styleLine("●", "good")
    : styleLine("●", "bad");
  const connectionLabel = view.connected ? "connected" : "disconnected";
  const taskSummaryParts: string[] = [];
  if (session) {
    const running = countTasks(tasks, "running");
    const pending = countTasks(tasks, "pending");
    const completed = countTasks(tasks, "completed");
    const failed = countTasks(tasks, "failed");
    const blocked = countTasks(tasks, "blocked");
    if (running > 0) taskSummaryParts.push(`${styleLine("●", "warn")} ${running} running`);
    if (pending > 0) taskSummaryParts.push(`${styleLine("○", "muted")} ${pending} pending`);
    if (blocked > 0) taskSummaryParts.push(`${styleLine("◆", "bad")} ${blocked} blocked`);
    if (completed > 0) taskSummaryParts.push(`${styleLine("✓", "good")} ${completed} done`);
    if (failed > 0) taskSummaryParts.push(`${styleLine("✗", "bad")} ${failed} failed`);
  }
  const sep = styleLine(" │ ", "dim");
  const taskSummary = taskSummaryParts.length > 0 ? taskSummaryParts.join("  ") : styleLine("no tasks", "dim");
  const missionLabel = mission ? `${mission.title}` : "";
  const goalLabel = session?.goal ? truncateValue(session.goal, Math.max(20, Math.floor(width * 0.3))) : "";
  const contextLabel = missionLabel || goalLabel;
  const accessBadge = session?.fullAccessMode ? styleLine(" FULL ACCESS ", "warn", "strong") : "";
  const line1 = fitAnsiLine(
    `${styleLine("◆ Kavi", "accent", "strong")}${sep}${repoName}${sep}${connectionDot} ${connectionLabel}${sep}${taskSummary}${accessBadge ? `${sep}${accessBadge}` : ""}`,
    width
  );
  const line2 = contextLabel
    ? fitAnsiLine(
        `${styleLine(contextLabel, "text")}${mission ? `${sep}${styleLine(mission.status, statusTone(mission.status) === "good" ? "good" : statusTone(mission.status) === "warn" ? "warn" : statusTone(mission.status) === "bad" ? "bad" : "muted")}` : ""}${workflowSummary ? `${sep}${styleLine(workflowSummary.stage.label, "dim")}` : ""}`,
        width
      )
    : null;

  const tabs = OPERATOR_TABS.map((tab, index) => {
    const count = buildTabItems(snapshot, tab).length;
    const attention = currentTabAttention(snapshot, ui, tab);
    const marker = attention ? ` ${styleLine(attention.marker, attention.tone, "strong")}` : "";
    const badge = count > 0 ? styleLine(` ${count}`, "dim") : "";
    const label = `${tabLabel(tab)}${badge}${marker}`;
    return tab === ui.activeTab
      ? styleLine(` ${label} `, "accent", "reverse")
      : styleLine(` ${label} `, "dim");
  }).join(" ");
  const tabLine = fitAnsiLine(tabs, width);
  const headerLines = [line1];
  if (line2) headerLines.push(line2);
  headerLines.push(tabLine);
  return headerLines;
}

function currentToast(ui: OperatorUiState): OperatorToast | null {
  if (!ui.toast) {
    return null;
  }

  return ui.toast.expiresAt > Date.now() ? ui.toast : null;
}

function toastTone(toast: OperatorToast): "good" | "bad" | "muted" {
  const remaining = toast.expiresAt - Date.now();
  if (remaining < 1000) return "muted";
  return toast.level === "error" ? "bad" : "good";
}

function footerSelectionSummary(snapshot: KaviSnapshot | null, ui: OperatorUiState, width: number): string {
  const item = selectedItem(snapshot, ui);
  if (!item) {
    return fitAnsiLine("Selection: none", width);
  }

  return fitAnsiLine(`Selection: ${item.title}${item.detail ? ` | ${item.detail}` : ""}`, width);
}

function renderFooter(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  width: number,
  view?: OperatorView
): string[] {
  const toast = currentToast(ui);
  const reviewContext = activeReviewContext(snapshot, ui);
  const workflowSummary = snapshot ? buildWorkflowSummary(snapshot) : null;
  const compatibility = view?.compatibility ?? null;
  if (ui.reviewComposer) {
    const composerHeader = fitAnsiLine(
      styleLine(
        ui.reviewComposer.mode === "edit"
          ? "Edit Review Note"
          : ui.reviewComposer.mode === "reply"
            ? "Reply To Review Note"
            : "Capture Review Note",
        "accent",
        "strong"
      ),
      width
    );
    const khr = (key: string, label: string): string =>
      `${styleLine(key, "text", "strong")} ${styleLine(label, "dim")}`;
    const composerLine = fitAnsiLine(
      `${styleLine(reviewDispositionLabel(ui.reviewComposer.disposition), "accent")}   ${khr("Enter", "save")}   ${khr("Esc", "cancel")}   ${khr("Ctrl+U", "clear")}`,
      width
    );
    const scopeLine = fitAnsiLine(
      `${styleLine("Scope:", "dim")} ${reviewContext?.agent ?? "-"} ${styleLine("│", "dim")} ${reviewContext?.filePath ?? "-"}${reviewContext?.hunkIndex === null || reviewContext?.hunkIndex === undefined ? "" : ` ${styleLine("│", "dim")} hunk ${reviewContext.hunkIndex + 1}`}`,
      width
    );
    return [
      composerHeader,
      composerLine,
      scopeLine
    ];
  }

  if (ui.composer) {
    if (ui.composer.expanded) {
      const khc = (key: string, label: string): string =>
        `${styleLine(key, "text", "strong")} ${styleLine(label, "dim")}`;
      const routeColor = ui.composer.owner === "codex" ? "codex" : ui.composer.owner === "claude" ? "claude" : "accent";
      return [
        fitAnsiLine(
          `${styleLine("Route:", "dim")} ${styleLine(ui.composer.owner, routeColor as keyof typeof STYLES)}   ${styleLine("Plan:", "dim")} ${ui.composer.planningMode}   ${khc("Ctrl+S", "submit")}   ${khc("Tab", "route")}   ${khc("Ctrl+P", "plan")}   ${khc("Esc", "cancel")}`,
          width
        ),
        fitAnsiLine(
          toast
            ? styleLine(toast.message, toastTone(toast))
            : styleLine(composerPreviewSummary(buildComposerTaskPreview(snapshot, ui.composer)), "muted"),
          width
        )
      ];
    }
    return [
      fitAnsiLine(
        toast
          ? styleLine(toast.message, toastTone(toast))
          : compatibility && !compatibility.compatible
            ? styleLine(formatRestartRequiredMessage("Submitting new work", compatibility), "warn", "strong")
          : styleLine(composerPreviewSummary(buildComposerTaskPreview(snapshot, ui.composer)), "muted"),
        width
      )
    ];
  }

  const kh = (key: string, label: string): string =>
    `${styleLine(key, "text", "strong")} ${styleLine(label, "dim")}`;
  const contextKeys: string[] = [kh("j/k", "nav"), kh("c", "compose")];
  switch (ui.activeTab) {
    case "results":
      contextKeys.push(kh("(/)", "brain"), kh("p", "pin"), kh("m", "mark"), kh("U", "merge"), kh("S", "shadow"));
      break;
    case "tasks":
      contextKeys.push(kh("[ ]", "section"), kh(",/.", "diff"), kh("{/}", "hunk"), kh("t", "retry"));
      break;
    case "approvals":
      contextKeys.push(kh("y", "allow"), kh("n", "deny"), kh("Y/N", "remember"));
      break;
    case "recommendations":
      contextKeys.push(kh("Enter", "apply"), kh("z", "dismiss"), kh("Z", "restore"));
      break;
    case "worktrees":
      contextKeys.push(kh(",/.", "file"), kh("{/}", "hunk"), kh("A/C/Q", "note"));
      break;
    case "claims":
    case "decisions":
    case "messages":
      break;
    default:
      break;
  }
  contextKeys.push(kh("!", "access"), kh("L", "land"), kh("r", "refresh"), kh("i/I", "agents"), kh("?", "help"), kh("q", "quit"));
  return [
    fitAnsiLine(contextKeys.join("   "), width),
    footerSelectionSummary(snapshot, ui, width),
      fitAnsiLine(
      toast
        ? styleLine(toast.message, toastTone(toast))
        : compatibility && !compatibility.compatible
          ? styleLine(formatRestartRequiredMessage("Mutating this session", compatibility), "warn", "strong")
        : workflowSummary?.stage.id === "ready_to_land"
          ? styleLine(
              ui.activeTab === "results"
                ? "Ready to land: review the result summary, then press L to land without leaving the TUI."
                : `Ready to land: Mission has new output. Press ${tabShortcut("results")} to review it, then press L to land.`,
              "good",
              "strong"
            )
        : workflowSummary?.stage.id === "review_follow_ups"
          ? styleLine(
              ui.activeTab === "recommendations"
                ? "Outstanding follow-up work is waiting here. Apply or dismiss it before landing."
                : `Recommendations has actionable follow-up work. Press ${tabShortcut("recommendations")} to review it before landing.`,
              "warn",
              "strong"
            )
        : styleLine(
            snapshot?.session.fullAccessMode
              ? "Approve-all is enabled: Claude and Codex may run commands and edit files without Kavi approval prompts."
              : "Operator surface is live over the daemon socket with pushed snapshots.",
            snapshot?.session.fullAccessMode ? "warn" : "muted"
          ),
      width
    )
  ];
}

function renderComposerPanel(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  width: number
): string[] {
  const composer = ui.composer;
  if (!composer) return [];
  const innerWidth = Math.max(20, width - 4);
  const routeColor = composer.owner === "codex" ? "codex" : composer.owner === "claude" ? "claude" : "accent";
  const routeDot = composer.owner === "codex"
    ? styleLine("●", "codex")
    : composer.owner === "claude"
      ? styleLine("●", "claude")
      : styleLine("◌", "muted");
  const khc = (key: string, label: string): string =>
    `${styleLine(key, "text", "strong")} ${styleLine(label, "dim")}`;

  const routeInfo = `${styleLine("Route:", "dim")} ${routeDot} ${styleLine(composer.owner, routeColor as keyof typeof STYLES)}    ${styleLine("Plan:", "dim")} ${composer.planningMode}`;
  const separator = styleLine("─".repeat(innerWidth), "border");
  const promptSummary = countPromptLines(composer.prompt) > 1
    ? `${styleLine(`${countPromptLines(composer.prompt)} lines`, "dim")} ${styleLine("│", "dim")} ${styleLine(`${composer.prompt.length} chars`, "dim")} ${styleLine("│", "dim")} cursor ${editorCursorSummary(composer.prompt, composer)}`
    : "";
  const promptLine = `${styleLine(">", "accent")} ${composer.prompt || styleLine("type your prompt here...", "dim")}`;
  const shortcuts = `${khc("Tab", "route")}  ${khc("Ctrl+P", "plan")}  ${khc("Enter", "submit")}  ${khc("Esc", "×")}`;
  const content = [
    `  ${routeInfo}`,
    `  ${separator}`,
    `  ${fitAnsiLine(promptLine, innerWidth)}`,
    promptSummary ? `  ${styleLine(promptSummary, "dim")}` : null,
    "",
    `  ${shortcuts}`
  ].filter((line): line is string => line !== null);

  return renderPanel("Compose", width, content.length + 2, content, { focused: true });
}

function renderExpandedComposer(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  const composer = ui.composer;
  if (!snapshot || !composer) {
    return renderPanel("Compose Task", width, height, [styleLine("Composer is not active.", "muted")], {
      focused: true
    });
  }

  const previewState = buildComposerTaskPreview(snapshot, composer);
  const innerWidth = Math.max(20, width - 4);
  const routeColor = composer.owner === "codex" ? "codex" : composer.owner === "claude" ? "claude" : "accent";
  const editorIntro = section("Editor", [
    `Route: ${styleLine(composer.owner, routeColor as keyof typeof STYLES)}   Planning: ${composer.planningMode}`,
    `${styleLine(`${countPromptLines(composer.prompt)} lines`, "dim")} ${styleLine("│", "dim")} ${styleLine(`${composer.prompt.length} chars`, "dim")} ${styleLine("│", "dim")} cursor ${editorCursorSummary(composer.prompt, composer)}`,
    `${styleLine("Ctrl+S", "text")} ${styleLine("submit", "dim")}   ${styleLine("Tab", "text")} ${styleLine("route", "dim")}   ${styleLine("Ctrl+P", "text")} ${styleLine("plan", "dim")}   ${styleLine("Esc", "text")} ${styleLine("cancel", "dim")}`
  ].flatMap((line) => wrapText(line, innerWidth)));
  const pasteSection = composer.pasteSummary
    ? section("Paste", wrapText(composer.pasteSummary, innerWidth))
    : [];
  const previewSection = section(
    previewState?.planningDecision.usePlanner ? "Execution Plan Preview" : "Route Preview",
    previewState
      ? previewState.planningDecision.usePlanner
        ? [
            ...wrapText(previewState.planningDecision.reason, innerWidth),
            ...wrapText(
              previewState.activePlanTitle
                ? `Existing active plan: ${previewState.activePlanTitle}`
                : "No active plan exists yet. Codex will create a new execution graph after submit.",
              innerWidth
            )
          ]
        : previewState.route
          ? wrapText(
              `${previewState.route.owner} via ${previewState.route.strategy} (${previewState.route.confidence.toFixed(2)}) | ${previewState.route.reason}${previewState.route.claimedPaths.length ? ` | paths=${previewState.route.claimedPaths.join(", ")}` : ""}`,
              innerWidth
            )
          : [styleLine("  none", "dim")]
      : [styleLine("  none", "dim")]
  );
  const promptHeader = section("Prompt", []);
  const promptViewportRows = Math.max(
    6,
    height - 2 - editorIntro.length - pasteSection.length - previewSection.length - promptHeader.length
  );
  const lines = [
    ...editorIntro,
    ...pasteSection,
    ...previewSection,
    ...promptHeader,
    ...renderEditorViewport(composer.prompt, composer, innerWidth, promptViewportRows)
  ];

  return renderPanel("Compose Task | Expanded", width, height, lines, {
    focused: true
  });
}

function buildLayout(width: number, height: number): Array<{ kind: "wide" | "narrow" | "compact"; columns?: number[]; bodyHeights?: number[] }> {
  if (width >= 120) {
    const left = Math.max(32, Math.min(44, Math.floor(width * 0.34)));
    const middle = Math.max(28, Math.min(38, Math.floor(width * 0.26)));
    const right = Math.max(36, width - left - middle - 2);
    return [{ kind: "wide", columns: [left, middle, right] }];
  }

  if (width >= 88) {
    const left = Math.max(28, Math.floor(width * 0.4));
    const right = Math.max(36, width - left - 1);
    return [{ kind: "narrow", columns: [left, right] }];
  }

  return [{ kind: "compact" }];
}

const COMMAND_REGISTRY: CommandPaletteEntry[] = [
  { label: "Compose task", shortcut: "c", action: "compose", contexts: "all" },
  { label: "Session info", shortcut: "?", action: "info", contexts: "all" },
  { label: "Codex agent detail", shortcut: "i", action: "agent-detail-codex", contexts: "all" },
  { label: "Claude agent detail", shortcut: "I", action: "agent-detail-claude", contexts: "all" },
  { label: "Refresh snapshot", shortcut: "r", action: "refresh", contexts: "all" },
  { label: "Toggle approve-all", shortcut: "!", action: "toggle-access", contexts: "all" },
  { label: "Land mission", shortcut: "L", action: "land", contexts: "all" },
  { label: "Retry selected task", shortcut: "t", action: "retry-task", contexts: ["tasks"] },
  { label: "Stop daemon", shortcut: "s", action: "stop", contexts: "all" },
  { label: "Quit", shortcut: "q", action: "quit", contexts: "all" },
  { label: "Apply recommendation", shortcut: "Enter", action: "apply-rec", contexts: ["recommendations"] },
  { label: "Force apply recommendation", shortcut: "P", action: "force-apply-rec", contexts: ["recommendations"] },
  { label: "Dismiss recommendation", shortcut: "z", action: "dismiss-rec", contexts: ["recommendations"] },
  { label: "Restore recommendation", shortcut: "Z", action: "restore-rec", contexts: ["recommendations"] },
  { label: "Allow approval", shortcut: "y", action: "allow", contexts: ["approvals"] },
  { label: "Deny approval", shortcut: "n", action: "deny", contexts: ["approvals"] },
  { label: "Allow + remember", shortcut: "Y", action: "allow-remember", contexts: ["approvals"] },
  { label: "Deny + remember", shortcut: "N", action: "deny-remember", contexts: ["approvals"] },
  { label: "Next task section", shortcut: "]", action: "next-section", contexts: ["tasks"] },
  { label: "Previous task section", shortcut: "[", action: "prev-section", contexts: ["tasks"] },
  { label: "Next diff file", shortcut: ".", action: "next-diff-file", contexts: ["tasks", "worktrees"] },
  { label: "Previous diff file", shortcut: ",", action: "prev-diff-file", contexts: ["tasks", "worktrees"] },
  { label: "Next diff hunk", shortcut: "}", action: "next-hunk", contexts: ["tasks", "worktrees"] },
  { label: "Previous diff hunk", shortcut: "{", action: "prev-hunk", contexts: ["tasks", "worktrees"] },
  { label: "Add approval note", shortcut: "A", action: "note-approve", contexts: ["tasks", "worktrees"] },
  { label: "Add concern note", shortcut: "C", action: "note-concern", contexts: ["tasks", "worktrees"] },
  { label: "Add question note", shortcut: "Q", action: "note-question", contexts: ["tasks", "worktrees"] },
  { label: "Add general note", shortcut: "M", action: "note-general", contexts: ["tasks", "worktrees"] },
  { label: "Next brain entry", shortcut: ")", action: "next-brain", contexts: ["results"] },
  { label: "Previous brain entry", shortcut: "(", action: "prev-brain", contexts: ["results"] },
  { label: "Search mission brain", shortcut: "/", action: "brain-search", contexts: ["results"] },
  { label: "Cycle brain category", shortcut: "b", action: "brain-cycle-category", contexts: ["results"] },
  { label: "Cycle brain scope", shortcut: "B", action: "brain-cycle-scope", contexts: ["results"] },
  { label: "Toggle retired brain entries", shortcut: "v", action: "brain-toggle-retired", contexts: ["results"] },
  { label: "Cycle brain focus area", shortcut: "f", action: "brain-cycle-focus", contexts: ["results"] },
  { label: "Cycle brain graph mode", shortcut: "e", action: "brain-cycle-graph-mode", contexts: ["results"] },
  { label: "Cycle brain path lens", shortcut: "P", action: "brain-cycle-path", contexts: ["results"] },
  { label: "Cycle focused brain neighbor", shortcut: "o/O", action: "brain-cycle-target", contexts: ["results"] },
  { label: "Jump to focused brain target", shortcut: "Enter", action: "brain-focus-target", contexts: ["results"] },
  { label: "Cycle mission autonomy", shortcut: "u", action: "mission-cycle-autonomy", contexts: ["results"] },
  { label: "Toggle mission autopilot", shortcut: "a", action: "mission-toggle-autopilot", contexts: ["results"] },
  { label: "Toggle auto verify", shortcut: "V", action: "mission-toggle-auto-verify", contexts: ["results"] },
  { label: "Toggle auto land", shortcut: "J", action: "mission-toggle-auto-land", contexts: ["results"] },
  { label: "Toggle pause on repair failure", shortcut: "K", action: "mission-toggle-pause-on-repair", contexts: ["results"] },
  { label: "Pin or unpin brain entry", shortcut: "p", action: "toggle-brain-pin", contexts: ["results"] },
  { label: "Mark merge source", shortcut: "m", action: "mark-brain-merge-source", contexts: ["results"] },
  { label: "Merge marked brain entry", shortcut: "U", action: "merge-brain", contexts: ["results"] },
  { label: "Select recommended shadow mission", shortcut: "S", action: "select-shadow", contexts: ["results"] },
  { label: "Retire brain entry", shortcut: "X", action: "retire-brain", contexts: ["results"] },
  { label: "Reply to note", shortcut: "T", action: "reply-note", contexts: ["tasks", "worktrees"] },
  { label: "Resolve note", shortcut: "R", action: "resolve-note", contexts: ["tasks", "worktrees"] },
  { label: "Mark won't fix", shortcut: "w", action: "wont-fix", contexts: ["tasks"] },
  { label: "Mark accepted risk", shortcut: "x", action: "accepted-risk", contexts: ["tasks"] },
  { label: "Create fix task", shortcut: "F", action: "fix-task", contexts: ["tasks"] },
  { label: "Handoff to agent", shortcut: "H", action: "handoff", contexts: ["tasks"] },
  { label: "Jump to top", shortcut: "g", action: "go-top", contexts: "all" },
  { label: "Jump to bottom", shortcut: "G", action: "go-bottom", contexts: "all" },
];

function fuzzyMatch(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function filteredCommands(
  query: string,
  activeTab: OperatorTab
): CommandPaletteEntry[] {
  return COMMAND_REGISTRY.filter((entry) => {
    const contextMatch = entry.contexts === "all" || entry.contexts.includes(activeTab);
    if (!contextMatch) return false;
    if (!query) return true;
    return fuzzyMatch(query, entry.label) || fuzzyMatch(query, entry.shortcut);
  });
}

function renderCommandPalette(
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  const palette = ui.commandPalette;
  if (!palette) return [];

  const commands = filteredCommands(palette.query, ui.activeTab);
  const overlayWidth = Math.min(56, width - 4);
  const maxVisible = Math.min(12, height - 6);
  const overlayHeight = Math.min(commands.length + 4, maxVisible + 4);
  const innerWidth = overlayWidth - 4;

  const content: string[] = [
    "",
    `  ${styleLine(">", "accent")} ${palette.query}${styleLine("▎", "accent")}`,
    "",
  ];

  const visible = commands.slice(0, maxVisible);
  const entryWidth = innerWidth - 4; // after "  ▸ " prefix
  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const selected = i === palette.selectedIndex;
    const prefix = selected ? styleLine("▸", "accent") : " ";
    const label = selected ? styleLine(entry.label, "text", "strong") : entry.label;
    const shortcut = styleLine(entry.shortcut.padStart(entryWidth - entry.label.length), "dim");
    content.push(`  ${prefix} ${label}${shortcut}`);
  }

  if (commands.length === 0) {
    content.push(styleLine("    No matching commands", "dim"));
  }

  return renderPanel("Commands", overlayWidth, overlayHeight, content, { focused: true });
}

function renderBrainSearchOverlay(
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  const search = ui.brainSearch;
  if (!search) return [];

  const overlayWidth = Math.min(64, width - 4);
  const innerWidth = overlayWidth - 4;
  const query = search.value ?? "";
  const content: string[] = [
    "",
    `  ${styleLine("Query", "dim")} ${styleLine(ui.brainFilters.query || "none", "muted")}`,
    `  ${styleLine(">", "accent")} ${query}${styleLine("▎", "accent")}`,
    "",
    ...wrapText(
      `Filters: category=${ui.brainFilters.category} | scope=${ui.brainFilters.scope} | retired=${ui.brainFilters.includeRetired ? "on" : "off"} | focus=${ui.brainFilters.focusArea}`,
      innerWidth
    ).map((line) => `  ${line}`),
    "",
    `  ${styleLine("Enter", "text", "strong")} apply    ${styleLine("Esc", "text", "strong")} close    ${styleLine("Ctrl+U", "text", "strong")} clear`,
  ];

  return renderPanel("Brain Search", overlayWidth, Math.min(height - 4, content.length + 2), content, {
    focused: true
  });
}

function renderConfirmDialog(
  ui: OperatorUiState,
  width: number,
  _height: number
): string[] {
  const dialog = ui.confirmDialog;
  if (!dialog) return [];

  const overlayWidth = Math.min(48, width - 4);
  const content: string[] = [
    "",
    ...dialog.body.map((line) => `  ${line}`),
    "",
    `  ${styleLine("Enter", "text", "strong")} ${styleLine(dialog.confirmLabel, "dim")}    ${styleLine("Esc", "text", "strong")} ${styleLine("cancel", "dim")}`,
  ];

  return renderPanel(dialog.title, overlayWidth, content.length + 2, content, { focused: true });
}

function renderInfoOverlay(
  view: OperatorView,
  width: number,
  height: number
): string[] {
  const snapshot = view.snapshot;
  const session = snapshot?.session ?? null;
  const workflowSummary = snapshot ? buildWorkflowSummary(snapshot) : null;
  const mission = workflowSummary?.activeMission ?? null;
  const compatibility = view.compatibility ?? compatibilityForView(view);
  const kv = (key: string, value: string): string =>
    `  ${styleLine(key.padEnd(16), "dim")}${value}`;

  const content: string[] = [
    "",
    ...section("Session", [
      kv("ID", session?.id ?? "-"),
      kv("Goal", session?.goal ?? "-"),
      kv("Status", session?.status ?? "-"),
      kv("Access", session?.fullAccessMode ? styleLine("approve-all", "warn") : "standard"),
      kv("Repo", session?.repoRoot ?? "-"),
    ]),
    "",
    ...section("Versions", [
      kv("Daemon", `${session?.daemonVersion ?? "?"} / proto ${session?.protocolVersion ?? "?"}`),
      kv("Client", `${view.clientIdentity?.version ?? "?"} / proto ${view.clientIdentity?.protocolVersion ?? "?"}`),
      ...(compatibility && !compatibility.compatible ? [styleLine("  ⚠ Restart required", "warn")] : []),
    ]),
    "",
    ...section("Mission", mission ? [
      kv("Title", mission.title),
      kv("Status", mission.status),
      kv("Stage", workflowSummary?.stage.label ?? "-"),
      kv("Acceptance", mission.acceptance?.status ?? "-"),
      kv("Next", workflowSummary?.landReadiness.nextActions[0] ?? "-"),
    ] : [styleLine("  No active mission", "dim")]),
    "",
    ...section("Agents", [
      kv("Codex", session?.agentStatus.codex.available
        ? `${styleLine("● available", "good")} (${session.agentStatus.codex.transport})`
        : styleLine("● unavailable", "bad")),
      kv("Claude", session?.agentStatus.claude.available
        ? `${styleLine("● available", "good")} (${session.agentStatus.claude.transport})`
        : styleLine("● unavailable", "bad")),
    ]),
    "",
    styleLine("  Press ? or Esc to close", "dim"),
  ];

  const overlayWidth = Math.min(60, width - 4);
  const overlayHeight = Math.min(content.length + 2, height - 2);
  return renderPanel("Session Info", overlayWidth, overlayHeight, content, { focused: true });
}

function renderAgentDetailOverlay(
  snapshot: KaviSnapshot | null,
  agent: ManagedAgent,
  width: number,
  height: number
): string[] {
  const overlayWidth = Math.min(56, width - 4);
  const overlayHeight = Math.min(height - 2, 28);
  const lane = renderLane(snapshot, agent, overlayWidth, overlayHeight);
  return lane;
}

function compositeOverlay(
  base: string[],
  overlay: string[],
  width: number
): string[] {
  const result = [...base];
  const overlayWidth = Math.max(...overlay.map((line) => visibleLength(line)));
  const startCol = Math.max(0, Math.floor((width - overlayWidth) / 2));
  const startRow = Math.max(0, Math.floor((base.length - overlay.length) / 2));

  for (let i = 0; i < overlay.length; i++) {
    const row = startRow + i;
    if (row < result.length) {
      const before = sliceAnsi(result[row], startCol);
      const afterStart = startCol + visibleLength(overlay[i]);
      const after = afterStart < width
        ? sliceAnsi(result[row], width).slice(0) // preserve trailing
        : "";
      result[row] = `${fitAnsiLine(before, startCol)}${overlay[i]}${" ".repeat(Math.max(0, width - afterStart))}`;
    }
  }
  return result;
}

function renderBody(
  view: OperatorView,
  ui: OperatorUiState,
  width: number,
  height: number
): string[] {
  if (ui.composer?.expanded) {
    return renderExpandedComposer(view.snapshot, ui, width, height);
  }

  const composerPanel = ui.composer && !ui.composer.expanded
    ? renderComposerPanel(view.snapshot, ui, width)
    : [];
  const mainHeight = Math.max(12, height - composerPanel.length);

  const layout = buildLayout(width, mainHeight)[0];
  if (!layout) {
    return [...composerPanel];
  }

  let mainBody: string[];

  if (layout.kind === "wide" && layout.columns) {
    const [leftWidth, _middleWidth, rightWidth] = layout.columns;
    const strip = renderAgentStrip(view.snapshot, width);
    const columnsHeight = Math.max(12, mainHeight - strip.length);
    const inspectorWidth = Math.max(36, width - leftWidth - 1);
    mainBody = [
      ...strip,
      ...combineColumns([
        {
          width: leftWidth,
          lines: renderListPanel(view.snapshot, ui, leftWidth, columnsHeight)
        },
        {
          width: inspectorWidth,
          lines: renderInspector(view.snapshot, ui, inspectorWidth, columnsHeight)
        }
      ])
    ];
  } else if (layout.kind === "narrow" && layout.columns) {
    const [leftWidth, rightWidth] = layout.columns;
    const inspectorHeight = Math.max(9, Math.floor(mainHeight * 0.58));
    const laneHeight = Math.max(6, Math.floor((mainHeight - inspectorHeight) / 2));
    const remaining = Math.max(6, mainHeight - inspectorHeight - laneHeight);
    mainBody = combineColumns([
      {
        width: leftWidth,
        lines: renderListPanel(view.snapshot, ui, leftWidth, mainHeight)
      },
      {
        width: rightWidth,
        lines: [
          ...renderInspector(view.snapshot, ui, rightWidth, inspectorHeight),
          ...renderLane(view.snapshot, "codex", rightWidth, laneHeight),
          ...renderLane(view.snapshot, "claude", rightWidth, remaining)
        ]
      }
    ]);
  } else {
    const listHeight = Math.max(8, Math.floor(mainHeight * 0.34));
    const inspectorHeight = Math.max(8, Math.floor(mainHeight * 0.34));
    const laneHeight = Math.max(6, Math.floor((mainHeight - listHeight - inspectorHeight) / 2));
    const finalLaneHeight = Math.max(6, mainHeight - listHeight - inspectorHeight - laneHeight);
    mainBody = [
      ...renderListPanel(view.snapshot, ui, width, listHeight),
      ...renderInspector(view.snapshot, ui, width, inspectorHeight),
      ...renderLane(view.snapshot, "codex", width, laneHeight),
      ...renderLane(view.snapshot, "claude", width, finalLaneHeight)
    ];
  }

  return [...mainBody, ...composerPanel];
}

let previousFrame: string[] = [];
let previousWidth = 0;
let previousHeight = 0;

function renderScreen(
  view: OperatorView,
  ui: OperatorUiState,
  paths: AppPaths
): string {
  const width = process.stdout.columns ?? 120;
  const height = process.stdout.rows ?? 36;
  const header = renderHeader(view, ui, width);
  const footer = renderFooter(view.snapshot, ui, width, view);
  const bodyHeight = Math.max(12, height - header.length - footer.length);
  let body = renderBody(view, ui, width, bodyHeight);
  if (ui.infoOverlay) {
    const overlay = renderInfoOverlay(view, width, bodyHeight);
    body = compositeOverlay(body, overlay, width);
  }
  if (ui.agentDetailOverlay) {
    const overlay = renderAgentDetailOverlay(view.snapshot, ui.agentDetailOverlay, width, bodyHeight);
    body = compositeOverlay(body, overlay, width);
  }
  if (ui.commandPalette) {
    const overlay = renderCommandPalette(ui, width, bodyHeight);
    body = compositeOverlay(body, overlay, width);
  }
  if (ui.brainSearch) {
    const overlay = renderBrainSearchOverlay(ui, width, bodyHeight);
    body = compositeOverlay(body, overlay, width);
  }
  if (ui.confirmDialog) {
    const overlay = renderConfirmDialog(ui, width, bodyHeight);
    body = compositeOverlay(body, overlay, width);
  }
  const nextFrame = [
    ...header,
    ...body,
    ...footer
  ].slice(0, height);

  const forceRedraw = width !== previousWidth || height !== previousHeight;
  previousWidth = width;
  previousHeight = height;

  if (forceRedraw || previousFrame.length === 0) {
    previousFrame = nextFrame;
    return `\u001b[?25l\u001b[H\u001b[2J${nextFrame.join("\n")}`;
  }

  const commands: string[] = ["\u001b[?25l"];
  const maxLines = Math.max(previousFrame.length, nextFrame.length);
  for (let i = 0; i < maxLines; i++) {
    const prev = previousFrame[i] ?? "";
    const next = nextFrame[i] ?? " ".repeat(width);
    if (prev !== next) {
      commands.push(`\u001b[${i + 1};1H${fitAnsiLine(next, width)}`);
    }
  }
  previousFrame = nextFrame;

  return commands.length > 1 ? commands.join("") : "";
}

function setToast(ui: OperatorUiState, level: ToastLevel, message: string): void {
  ui.toast = {
    level,
    message,
    expiresAt: Date.now() + TOAST_DURATION_MS
  };
}

async function queueManualTask(
  paths: AppPaths,
  view: OperatorView,
  ui: OperatorUiState
): Promise<void> {
  assertMutableActionAllowed(view, "Queueing a task");
  const snapshot = view.snapshot;
  const composer = ui.composer;
  if (!snapshot || !composer) {
    throw new Error("No live session snapshot is available for task composition.");
  }

  const prompt = composer.prompt.trim();
  if (!prompt) {
    throw new Error("Task prompt cannot be empty.");
  }

  const planningDecision = decidePlanningMode(prompt, snapshot.session, composer.planningMode);
  const routeDecision =
    planningDecision.usePlanner
      ? {
          owner: "codex" as const,
          strategy: "manual" as const,
          confidence: 1,
          reason: planningDecision.reason,
          claimedPaths: [] as string[],
          metadata: {
            planner: true,
            requestedPlanningMode: composer.planningMode
          }
        }
      : composer.owner === "auto"
        ? await routeTask(prompt, snapshot.session, paths)
        : {
            owner: composer.owner,
            strategy: "manual" as const,
            confidence: 1,
            reason: `Operator manually assigned the task to ${composer.owner}.`,
            claimedPaths: extractPromptPathHints(prompt),
            metadata: {
              manualAssignment: true,
              composerOwner: composer.owner
            }
          };

  await rpcEnqueueTask(paths, {
    owner: routeDecision.owner,
    title: planningDecision.usePlanner ? "Codex orchestration plan" : undefined,
    prompt,
    planningMode: composer.planningMode,
    routeReason: routeDecision.reason,
    routeMetadata: routeDecision.metadata,
    claimedPaths: routeDecision.claimedPaths,
    routeStrategy: routeDecision.strategy,
    routeConfidence: routeDecision.confidence
  });

  ui.composer = null;
  ui.activeTab = planningDecision.usePlanner ? "results" : "tasks";
  setToast(
    ui,
    "info",
    planningDecision.usePlanner
      ? "Queued Codex orchestration planner. Mission will show the execution graph after planning finishes."
      : `Queued ${routeDecision.owner} task from composer.`
  );
}

async function applySelectedRecommendation(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  force: boolean,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Applying a recommendation");
  const recommendation = selectedRecommendation(snapshot, ui);
  if (!snapshot || !recommendation) {
    throw new Error("No recommendation is selected.");
  }

  const plan = buildRecommendationActionPlan(snapshot.session, recommendation.id, {
    force
  });
  await rpcEnqueueTask(paths, {
    owner: plan.owner,
    prompt: plan.prompt,
    planningMode: "direct",
    routeReason: plan.routeReason,
    routeMetadata: plan.routeMetadata,
    claimedPaths: plan.claimedPaths,
    routeStrategy: plan.routeStrategy,
    routeConfidence: plan.routeConfidence,
    recommendationId: plan.recommendation.id,
    recommendationKind: plan.recommendation.kind
  });
  setToast(ui, "info", `Queued ${plan.owner} task from recommendation ${plan.recommendation.id}.`);
}

async function dismissSelectedRecommendation(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Dismissing a recommendation");
  const recommendation = selectedRecommendation(snapshot, ui);
  if (!snapshot || !recommendation) {
    throw new Error("No recommendation is selected.");
  }

  await rpcDismissRecommendation(paths, {
    recommendationId: recommendation.id
  });
  setToast(ui, "info", `Dismissed recommendation ${recommendation.id}.`);
}

async function restoreSelectedRecommendation(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Restoring a recommendation");
  const recommendation = selectedRecommendation(snapshot, ui);
  if (!snapshot || !recommendation) {
    throw new Error("No recommendation is selected.");
  }

  await rpcRestoreRecommendation(paths, {
    recommendationId: recommendation.id
  });
  setToast(ui, "info", `Restored recommendation ${recommendation.id}.`);
}

async function resolveApprovalSelection(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  decision: "allow" | "deny",
  remember: boolean,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Resolving an approval");
  const approval =
    ui.activeTab === "approvals"
      ? selectedApproval(snapshot, ui)
      : snapshot
        ? latestPendingApproval(snapshot.approvals)
        : null;
  if (!approval) {
    throw new Error("No approval request is available to resolve.");
  }

  await rpcResolveApproval(paths, {
    requestId: approval.id,
    decision,
    remember
  });
  setToast(
    ui,
    "info",
    `${decision === "allow" ? "Approved" : "Denied"} ${approval.toolName}${remember ? " with remembered rule" : ""}.`
  );
}

async function submitReviewNote(
  paths: AppPaths,
  view: OperatorView,
  ui: OperatorUiState
): Promise<void> {
  assertMutableActionAllowed(view, "Saving a review note");
  const composer = ui.reviewComposer;
  const context = activeReviewContext(view.snapshot, ui);
  if (!composer || !context) {
    throw new Error("No active diff review context is available.");
  }

  const body = composer.body.trim();
  if (!body) {
    throw new Error("Review note cannot be empty.");
  }

  if (composer.mode === "edit" && composer.noteId) {
    await rpcUpdateReviewNote(paths, {
      noteId: composer.noteId,
      body
    });
  } else if (composer.mode === "reply" && composer.noteId) {
    await rpcAddReviewReply(paths, {
      noteId: composer.noteId,
      body
    });
  } else {
    await rpcAddReviewNote(paths, {
      agent: context.agent,
      taskId: context.taskId,
      filePath: context.filePath,
      hunkIndex: context.hunkIndex,
      hunkHeader: context.hunkHeader,
      disposition: composer.disposition,
      body
    });
  }
  ui.reviewComposer = null;
  setToast(
    ui,
    "info",
    composer.mode === "reply"
      ? `Added reply to review note ${composer.noteId ?? "-"}.`
      : `${reviewDispositionLabel(composer.disposition)} note ${composer.mode === "edit" ? "updated" : "saved"} for ${context.filePath}${context.hunkIndex === null ? "" : ` hunk ${context.hunkIndex + 1}`}.`
  );
}

async function toggleSelectedReviewNoteStatus(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Updating a review note");
  const note = selectedReviewNote(snapshot, ui);
  if (!note) {
    throw new Error("No review note is selected.");
  }

  const status = note.status === "resolved" ? "open" : "resolved";
  await rpcSetReviewNoteStatus(paths, {
    noteId: note.id,
    status
  });
  setToast(
    ui,
    "info",
    `${status === "resolved" ? "Resolved" : "Reopened"} review note ${note.id}.`
  );
}

async function enqueueSelectedReviewFollowUp(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  mode: "fix" | "handoff",
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Queueing review follow-up work");
  const note = selectedReviewNote(snapshot, ui);
  if (!note) {
    throw new Error("No review note is selected.");
  }

  const owner =
    mode === "fix"
      ? note.agent
      : note.agent === "codex"
        ? "claude"
        : "codex";
  await rpcEnqueueReviewFollowUp(paths, {
    noteId: note.id,
    owner,
    mode
  });
  setToast(
    ui,
    "info",
    `Queued ${mode === "fix" ? "fix" : "handoff"} follow-up for review note ${note.id} to ${owner}.`
  );
}

async function retrySelectedTask(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Retrying a task");
  const task = selectedTask(snapshot, ui);
  if (!task) {
    throw new Error("No task is selected.");
  }

  if (task.status !== "failed" && task.status !== "blocked") {
    throw new Error(`Task ${task.id} is ${task.status} and cannot be retried.`);
  }

  await rpcRetryTask(paths, task.id);
  setToast(ui, "info", `Queued manual retry for ${task.id}.`);
}

async function updateActiveMissionPolicyFromTui(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView,
  patch: {
    autonomyLevel?: "inspect" | "guided" | "autonomous" | "overnight";
    autoVerify?: boolean;
    autoLand?: boolean;
    pauseOnRepairFailure?: boolean;
    autopilotEnabled?: boolean;
  }
): Promise<void> {
  assertMutableActionAllowed(view, "Updating mission policy");
  const mission = buildWorkflowResult(snapshot).activeMission;
  if (!mission) {
    throw new Error("No active mission is available.");
  }
  await rpcUpdateMissionPolicy(paths, {
    missionId: mission.id,
    ...patch
  });
  const fragments = [
    patch.autonomyLevel ? `autonomy=${patch.autonomyLevel}` : null,
    typeof patch.autopilotEnabled === "boolean" ? `autopilot=${patch.autopilotEnabled ? "on" : "off"}` : null,
    typeof patch.autoVerify === "boolean" ? `auto-verify=${patch.autoVerify ? "on" : "off"}` : null,
    typeof patch.autoLand === "boolean" ? `auto-land=${patch.autoLand ? "on" : "off"}` : null,
    typeof patch.pauseOnRepairFailure === "boolean"
      ? `pause-on-repair-failure=${patch.pauseOnRepairFailure ? "on" : "off"}`
      : null
  ].filter(Boolean);
  setToast(ui, "info", `Updated mission policy for ${mission.id}: ${fragments.join(" | ")}.`);
}

async function toggleSelectedBrainEntryPinned(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Updating a brain entry");
  const entry = selectedBrainEntry(snapshot, ui);
  if (!entry) {
    throw new Error("No brain entry is selected.");
  }
  await rpcSetBrainEntryPinned(paths, {
    entryId: entry.id,
    pinned: !entry.pinned
  });
  setToast(ui, "info", `${entry.pinned ? "Unpinned" : "Pinned"} brain entry ${entry.id}.`);
}

async function retireSelectedBrainEntry(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Retiring a brain entry");
  const entry = selectedBrainEntry(snapshot, ui);
  if (!entry) {
    throw new Error("No brain entry is selected.");
  }
  await rpcRetireBrainEntry(paths, {
    entryId: entry.id
  });
  setToast(ui, "info", `Retired brain entry ${entry.id}.`);
}

function markSelectedBrainMergeSource(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState
): void {
  const entry = selectedBrainEntry(snapshot, ui);
  if (!entry) {
    throw new Error("No brain entry is selected.");
  }

  ui.brainMergeSourceEntryId = entry.id;
  setToast(ui, "info", `Marked ${entry.id} as the brain merge source.`);
}

async function mergeMarkedBrainEntry(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Merging brain entries");
  const source = brainMergeSourceEntry(snapshot, ui);
  const target = selectedBrainEntry(snapshot, ui);
  if (!source) {
    throw new Error("No brain merge source is marked.");
  }
  if (!target) {
    throw new Error("No brain entry is selected.");
  }
  if (source.id === target.id) {
    throw new Error("Select a different target brain entry before merging.");
  }

  await rpcMergeBrainEntries(paths, {
    targetEntryId: target.id,
    sourceEntryId: source.id
  });
  ui.brainMergeSourceEntryId = null;
  ui.selectedBrainEntryId = target.id;
  setToast(ui, "info", `Merged ${source.id} into ${target.id}.`);
}

async function selectRecommendedShadowMission(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Selecting a shadow mission");
  const mission = snapshot ? buildWorkflowResult(snapshot).activeMission : null;
  if (!snapshot || !mission) {
    throw new Error("No active mission is available.");
  }

  const shadowFamily = snapshot.session.missions.filter((item) =>
    item.id === mission.id ||
    item.shadowOfMissionId === mission.id ||
    item.id === mission.shadowOfMissionId ||
    (mission.shadowOfMissionId && item.shadowOfMissionId === mission.shadowOfMissionId)
  );
  const comparison = shadowFamily
    .filter((item) => item.id !== mission.id)
    .map((candidate) => compareMissions(snapshot, mission, candidate))
    .sort((left, right) => right.scoreDelta - left.scoreDelta)[0] ?? null;
  if (!comparison?.preferredMissionId) {
    throw new Error("No recommended shadow mission is available.");
  }
  if (comparison.preferredMissionId === mission.id) {
    setToast(ui, "info", "The current mission is already the recommended shadow.");
    return;
  }

  await rpcSelectMission(paths, {
    missionId: comparison.preferredMissionId
  });
  setToast(ui, "info", `Selected recommended shadow mission ${comparison.preferredMissionId}.`);
}

async function cycleSelectedReviewNoteAssignee(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Reassigning a review note");
  const note = selectedReviewNote(snapshot, ui);
  if (!note) {
    throw new Error("No review note is selected.");
  }

  const assignee = cycleReviewAssignee(note.assignee, note.agent);
  await rpcUpdateReviewNote(paths, {
    noteId: note.id,
    assignee
  });
  setToast(ui, "info", `Assigned review note ${note.id} to ${reviewAssigneeLabel(assignee)}.`);
}

async function resolveSelectedReviewNoteWithDisposition(
  paths: AppPaths,
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  disposition: Extract<ReviewDisposition, "accepted_risk" | "wont_fix">,
  view: OperatorView
): Promise<void> {
  assertMutableActionAllowed(view, "Resolving a review note");
  const note = selectedReviewNote(snapshot, ui);
  if (!note) {
    throw new Error("No review note is selected.");
  }

  await rpcUpdateReviewNote(paths, {
    noteId: note.id,
    disposition,
    assignee: "operator"
  });
  await rpcSetReviewNoteStatus(paths, {
    noteId: note.id,
    status: "resolved"
  });
  setToast(
    ui,
    "info",
    `Marked review note ${note.id} as ${reviewDispositionLabel(disposition).toLowerCase()}.`
  );
}

function cycleSelectedReviewNote(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): boolean {
  const notes = reviewNotesForContext(snapshot, activeReviewContext(snapshot, ui), ui.reviewFilters);
  if (notes.length === 0) {
    ui.selectedReviewNoteId = null;
    return false;
  }

  const currentIndex = Math.max(0, notes.findIndex((note) => note.id === ui.selectedReviewNoteId));
  const nextIndex = (currentIndex + delta + notes.length) % notes.length;
  ui.selectedReviewNoteId = notes[nextIndex]?.id ?? notes[0]?.id ?? null;
  return true;
}

async function ensureSelectedTaskArtifact(
  paths: AppPaths,
  view: OperatorView,
  ui: OperatorUiState,
  render: () => void
): Promise<void> {
  if (!view.connected || ui.activeTab !== "tasks") {
    return;
  }

  const task = selectedTask(view.snapshot, ui);
  if (!task) {
    return;
  }

  const existing = ui.artifacts[task.id];
  if (existing && existing.taskUpdatedAt === task.updatedAt) {
    return;
  }

  if (ui.loadingArtifacts[task.id]) {
    return;
  }

  ui.loadingArtifacts[task.id] = true;
  render();
  try {
    const artifact = await rpcTaskArtifact(paths, task.id);
    ui.artifacts[task.id] = {
      taskUpdatedAt: task.updatedAt,
      artifact,
      error: null
    };
  } catch (error) {
    ui.artifacts[task.id] = {
      taskUpdatedAt: task.updatedAt,
      artifact: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    delete ui.loadingArtifacts[task.id];
    render();
  }
}

async function ensureSelectedDiffReview(
  paths: AppPaths,
  view: OperatorView,
  ui: OperatorUiState,
  render: () => void
): Promise<void> {
  if (!view.connected) {
    return;
  }

  const agent = reviewAgentForUi(view.snapshot, ui);
  if (!agent) {
    return;
  }

  const changedPaths = changedPathsForAgent(view.snapshot, agent);
  const selectedPath = selectedDiffPath(view.snapshot, ui, agent);
  const changedSignature = changedPathSignature(changedPaths);
  const existing = ui.diffReviews[agent];
  if (
    existing &&
    existing.selectedPath === selectedPath &&
    existing.changedSignature === changedSignature
  ) {
    return;
  }

  if (ui.loadingDiffReviews[agent]) {
    return;
  }

  ui.loadingDiffReviews[agent] = true;
  render();
  try {
    const review = await rpcWorktreeDiff(paths, agent, selectedPath);
    ui.diffSelections[agent] = review.selectedPath;
    ui.hunkSelections[agent] = 0;
    ui.diffReviews[agent] = {
      selectedPath: review.selectedPath,
      changedSignature: changedPathSignature(review.changedPaths),
      review,
      error: null
    };
  } catch (error) {
    ui.diffReviews[agent] = {
      selectedPath,
      changedSignature,
      review: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    ui.loadingDiffReviews[agent] = false;
    syncSelectedReviewNote(view.snapshot, ui);
    render();
  }
}

function cycleDiffSelection(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): ManagedAgent | null {
  const agent = reviewAgentForUi(snapshot, ui);
  if (!agent) {
    return null;
  }

  const changedPaths = changedPathsForAgent(snapshot, agent);
  if (changedPaths.length === 0) {
    ui.diffSelections[agent] = null;
    return agent;
  }

  const current = selectedDiffPath(snapshot, ui, agent);
  const currentIndex = Math.max(0, changedPaths.findIndex((filePath) => filePath === current));
  const nextIndex = (currentIndex + delta + changedPaths.length) % changedPaths.length;
  ui.diffSelections[agent] = changedPaths[nextIndex] ?? changedPaths[0] ?? null;
  ui.hunkSelections[agent] = 0;
  return agent;
}

function cycleDiffHunk(
  snapshot: KaviSnapshot | null,
  ui: OperatorUiState,
  delta: number
): ManagedAgent | null {
  const agent = reviewAgentForUi(snapshot, ui);
  if (!agent) {
    return null;
  }

  const review = ui.diffReviews[agent]?.review ?? null;
  const hunks = parseDiffHunks(review?.patch ?? "");
  if (hunks.length === 0) {
    ui.hunkSelections[agent] = 0;
    return agent;
  }

  const currentIndex = selectedHunkIndex(ui, agent, review) ?? 0;
  ui.hunkSelections[agent] = (currentIndex + delta + hunks.length) % hunks.length;
  return agent;
}

export async function attachTui(paths: AppPaths): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The operator UI requires an interactive terminal.");
  }

  const clientIdentity = await loadRuntimeIdentity();
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write("\u001b[?2004h");

  let closed = false;
  let refreshing = false;
  let subscribing = false;
  let actionQueue: Promise<void> = Promise.resolve();
  let closeResolver: (() => void) | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let snapshotSubscription: ReturnType<typeof subscribeSnapshotRpc> | null = null;
  const view: OperatorView = {
    snapshot: null,
    connected: false,
    error: null,
    refreshedAt: null,
    clientIdentity,
    compatibility: null
  };
  const ui: OperatorUiState = {
    activeTab: "results",
    selectedIds: emptySelectionMap(),
    seenMarkers: emptySeenMarkerMap(),
    taskDetailSection: "overview",
    composer: null,
    reviewComposer: null,
    toast: null,
    artifacts: {},
    loadingArtifacts: {},
    diffSelections: {
      codex: null,
      claude: null
    },
    diffReviews: {
      codex: null,
      claude: null
    },
    loadingDiffReviews: {
      codex: false,
      claude: false
    },
    hunkSelections: {
      codex: 0,
      claude: 0
    },
    selectedReviewNoteId: null,
    selectedBrainEntryId: null,
    selectedBrainRelatedEntryId: null,
    selectedBrainGraphEntryId: null,
    selectedBrainEvidenceIndex: 0,
    brainMergeSourceEntryId: null,
    brainFilters: {
      query: "",
      category: "all",
      scope: "all",
      includeRetired: false,
      focusArea: "entries",
      graphMode: "all",
      pathHint: ""
    },
    brainSearch: null,
    reviewFilters: {
      assignee: "all",
      disposition: "all",
      status: "all"
    },
    infoOverlay: false,
    agentDetailOverlay: null,
    commandPalette: null,
    confirmDialog: null
  };

  const render = () => {
    const output = renderScreen(view, ui, paths);
    if (output) process.stdout.write(output);
  };

  const spinnerInterval = setInterval(() => {
    advanceSpinner();
    const hasLoading = Object.values(ui.loadingArtifacts).some(Boolean)
      || Object.values(ui.loadingDiffReviews).some(Boolean);
    if (hasLoading) render();
  }, 80);

  const syncUiForSnapshot = (snapshot: KaviSnapshot | null) => {
    ui.selectedIds = syncSelections(ui.selectedIds, snapshot);
    ui.diffSelections = syncDiffSelections(
      ui.diffSelections,
      snapshot,
      ui.activeTab === "tasks" ? selectedTask(snapshot, ui) : null
    );
    syncSelectedReviewNote(snapshot, ui);
    syncSelectedBrainEntry(snapshot, ui);
    markTabSeen(snapshot, ui, ui.activeTab);
  };

  const applySnapshot = (snapshot: KaviSnapshot, reason: string) => {
    view.snapshot = snapshot;
    view.connected = true;
    view.error = null;
    view.refreshedAt = new Date().toISOString();
    view.compatibility = compatibilityForView(view);
    if (reason === "plan.materialized" && !ui.composer && !ui.reviewComposer) {
      ui.activeTab = "results";
      ui.selectedIds.results = "result:current";
      setToast(
        ui,
        "info",
        "Codex finished orchestration. Mission now shows the execution graph and assigned tasks."
      );
    }
    syncUiForSnapshot(snapshot);
    render();
    void ensureSelectedTaskArtifact(paths, view, ui, render);
    void ensureSelectedDiffReview(paths, view, ui, render);
    if (reason !== "subscribe") {
      ui.toast = currentToast(ui);
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      runAction(connectSubscription);
    }, SUBSCRIPTION_RETRY_MS);
  };

  const markDisconnected = (message: string) => {
    view.connected = false;
    view.error = message;
    view.refreshedAt = new Date().toISOString();
    render();
    scheduleReconnect();
  };

  const connectSubscription = async (): Promise<void> => {
    if (closed || subscribing || snapshotSubscription) {
      return;
    }

    subscribing = true;
    const candidate = subscribeSnapshotRpc(paths, {
      onSnapshot: (event) => {
        if (snapshotSubscription !== candidate || closed) {
          return;
        }

        applySnapshot(event.snapshot, event.reason);
      },
      onError: (error) => {
        if (snapshotSubscription !== candidate || closed) {
          return;
        }

        snapshotSubscription = null;
        markDisconnected(error.message);
      },
      onDisconnect: () => {
        if (snapshotSubscription !== candidate || closed) {
          return;
        }

        snapshotSubscription = null;
        markDisconnected("RPC subscription disconnected.");
      }
    });
    snapshotSubscription = candidate;

    try {
      await candidate.connected;
    } catch (error) {
      if (snapshotSubscription === candidate && !closed) {
        snapshotSubscription = null;
        markDisconnected(error instanceof Error ? error.message : String(error));
      }
    } finally {
      subscribing = false;
      render();
    }
  };

  const refresh = async (): Promise<void> => {
    if (refreshing || closed) {
      return;
    }

    refreshing = true;
    try {
      const snapshot = await readSnapshot(paths);
      applySnapshot(snapshot, "manual.refresh");
    } catch (error) {
      view.connected = await pingRpc(paths);
      view.error = error instanceof Error ? error.message : String(error);
      view.refreshedAt = new Date().toISOString();
      if (!view.connected && snapshotSubscription) {
        snapshotSubscription.close();
        snapshotSubscription = null;
        scheduleReconnect();
      }
      render();
    } finally {
      refreshing = false;
    }
  };

  const runAction = (fn: () => Promise<void>) => {
    actionQueue = actionQueue
      .then(async () => {
        try {
          await fn();
        } catch (error) {
          setToast(ui, "error", error instanceof Error ? error.message : String(error));
          render();
        }
      });
  };

  const toggleFullAccessMode = async () => {
    assertMutableActionAllowed(view, "Changing approve-all mode");
    const session = view.snapshot?.session ?? null;
    if (!session) {
      throw new Error("No session snapshot is loaded yet.");
    }

    const enabled = !session.fullAccessMode;
    await rpcSetFullAccessMode(paths, {
      enabled
    });
    setToast(
      ui,
      "info",
      enabled
        ? "Approve-all enabled. Future Claude and Codex turns will run with full access and without Kavi approval prompts."
        : "Approve-all disabled. Future Claude and Codex turns will return to standard approval and sandbox behavior."
    );
    render();
  };

  const landFromTui = async () => {
    assertMutableActionAllowed(view, "Landing this session");
    setToast(ui, "info", "Landing managed work...");
    render();
    const result = await rpcLand(paths);
    await refresh();

    if (result.status === "blocked") {
      ui.activeTab = "tasks";
      ui.selectedIds.tasks = result.integrationTaskId;
      syncUiForSnapshot(view.snapshot);
      render();
      setToast(
        ui,
        "error",
        `Landing blocked by overlapping worktree paths. Review task ${result.integrationTaskId ?? "-"}.`
      );
      render();
      return;
    }

    ui.activeTab = "results";
    ui.selectedIds.results = result.landReportId ? `result:land:${result.landReportId}` : "result:current";
    syncUiForSnapshot(view.snapshot);
    render();
    setToast(
      ui,
      "info",
      `Landed managed work into ${result.targetBranch}. Mission tab has the merged report.`
    );
    render();
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    snapshotSubscription?.close();
    snapshotSubscription = null;
    clearInterval(spinnerInterval);
    process.stdin.setRawMode(false);
    process.stdin.off("keypress", keypressHandler);
    process.stdout.off("resize", resizeHandler);
    process.stdout.write("\u001b[0m\u001b[?2004l\u001b[?25h\n");
    closeResolver?.();
  };

  const selectTab = (tab: OperatorTab) => {
    ui.activeTab = tab;
    syncUiForSnapshot(view.snapshot);
    markTabSeen(view.snapshot, ui, tab);
    render();
    void ensureSelectedTaskArtifact(paths, view, ui, render);
    void ensureSelectedDiffReview(paths, view, ui, render);
  };

  const moveSelection = (delta: number) => {
    const items = buildTabItems(view.snapshot, ui.activeTab);
    ui.selectedIds[ui.activeTab] = moveSelectionId(items, ui.selectedIds[ui.activeTab], delta);
    ui.diffSelections = syncDiffSelections(
      ui.diffSelections,
      view.snapshot,
      ui.activeTab === "tasks" ? selectedTask(view.snapshot, ui) : null
    );
    syncSelectedReviewNote(view.snapshot, ui);
    render();
    void ensureSelectedTaskArtifact(paths, view, ui, render);
    void ensureSelectedDiffReview(paths, view, ui, render);
  };

  const openConfirmDialog = (title: string, body: string[], confirmLabel: string, confirmAction: string) => {
    ui.confirmDialog = { title, body, confirmLabel, confirmAction };
    render();
  };

  const executeCommandAction = (action: string) => {
    switch (action) {
      case "compose":
        ui.composer = {
          owner: "auto",
          planningMode: "auto",
          prompt: "",
          pasteCount: 0,
          expanded: false,
          pasteSummary: null,
          cursorOffset: 0,
          preferredColumn: null
        };
        render();
        break;
      case "info":
        ui.infoOverlay = true;
        render();
        break;
      case "agent-detail-codex":
        ui.agentDetailOverlay = "codex";
        render();
        break;
      case "agent-detail-claude":
        ui.agentDetailOverlay = "claude";
        render();
        break;
      case "refresh":
        runAction(refresh);
        break;
      case "toggle-access":
        openConfirmDialog(
          "Toggle Approve-All",
          [
            view.snapshot?.session?.fullAccessMode
              ? "Disable approve-all mode?"
              : "Enable approve-all mode?",
            "",
            view.snapshot?.session?.fullAccessMode
              ? "Agents will return to standard approval flow."
              : "Agents will run with full access, no approval prompts."
          ],
          "confirm",
          "toggle-access"
        );
        break;
      case "land":
        openConfirmDialog(
          "Land Changes",
          [
            "Merge managed work into main?",
            "",
            `Changed paths: ${(view.snapshot?.worktreeDiffs ?? []).reduce((s, d) => s + d.paths.length, 0)}`,
            `Open reviews: ${(view.snapshot?.session?.reviewNotes ?? []).filter((n) => n.status === "open").length}`
          ],
          "confirm",
          "land"
        );
        break;
      case "retry-task":
        if (ui.activeTab === "tasks") {
          runAction(async () => {
            await retrySelectedTask(paths, view.snapshot, ui, view);
            await refresh();
          });
        }
        break;
      case "stop":
        openConfirmDialog(
          "Stop Daemon",
          ["Stop the Kavi daemon and exit?", "", "Running agents will be terminated."],
          "stop",
          "stop"
        );
        break;
      case "quit":
        close();
        break;
      case "apply-rec":
        if (ui.activeTab === "recommendations") {
          runAction(async () => {
            await applySelectedRecommendation(paths, view.snapshot, ui, false, view);
            await refresh();
          });
        }
        break;
      case "force-apply-rec":
        if (ui.activeTab === "recommendations") {
          runAction(async () => {
            await applySelectedRecommendation(paths, view.snapshot, ui, true, view);
            await refresh();
          });
        }
        break;
      case "dismiss-rec":
        if (ui.activeTab === "recommendations") {
          runAction(async () => {
            await dismissSelectedRecommendation(paths, view.snapshot, ui, view);
            await refresh();
          });
        }
        break;
      case "restore-rec":
        if (ui.activeTab === "recommendations") {
          runAction(async () => {
            await restoreSelectedRecommendation(paths, view.snapshot, ui, view);
            await refresh();
          });
        }
        break;
      case "allow":
        runAction(async () => {
          await resolveApprovalSelection(paths, view.snapshot, ui, "allow", false, view);
          await refresh();
        });
        break;
      case "deny":
        runAction(async () => {
          await resolveApprovalSelection(paths, view.snapshot, ui, "deny", false, view);
          await refresh();
        });
        break;
      case "allow-remember":
        runAction(async () => {
          await resolveApprovalSelection(paths, view.snapshot, ui, "allow", true, view);
          await refresh();
        });
        break;
      case "deny-remember":
        runAction(async () => {
          await resolveApprovalSelection(paths, view.snapshot, ui, "deny", true, view);
          await refresh();
        });
        break;
      case "next-section":
      case "prev-section": {
        if (ui.activeTab === "tasks") {
          const currentIndex = TASK_DETAIL_SECTIONS.indexOf(ui.taskDetailSection);
          const delta = action === "prev-section" ? -1 : 1;
          const nextIndex = (currentIndex + delta + TASK_DETAIL_SECTIONS.length) % TASK_DETAIL_SECTIONS.length;
          ui.taskDetailSection = TASK_DETAIL_SECTIONS[nextIndex] ?? ui.taskDetailSection;
          ui.diffSelections = syncDiffSelections(ui.diffSelections, view.snapshot, selectedTask(view.snapshot, ui));
          syncSelectedReviewNote(view.snapshot, ui);
          render();
          void ensureSelectedTaskArtifact(paths, view, ui, render);
          void ensureSelectedDiffReview(paths, view, ui, render);
        }
        break;
      }
      case "next-diff-file":
      case "prev-diff-file": {
        const agent = cycleDiffSelection(view.snapshot, ui, action === "prev-diff-file" ? -1 : 1);
        if (agent) {
          render();
          syncSelectedReviewNote(view.snapshot, ui);
          void ensureSelectedDiffReview(paths, view, ui, render);
        }
        break;
      }
      case "next-hunk":
      case "prev-hunk": {
        const agent = cycleDiffHunk(view.snapshot, ui, action === "prev-hunk" ? -1 : 1);
        if (agent) {
          render();
          syncSelectedReviewNote(view.snapshot, ui);
        }
        break;
      }
      case "note-approve":
      case "note-concern":
      case "note-question":
      case "note-general": {
        if (!activeReviewContext(view.snapshot, ui)) {
          setToast(ui, "error", "No active diff review context is selected.");
          render();
          break;
        }
        const dispositionMap: Record<string, string> = {
          "note-approve": "approve",
          "note-concern": "concern",
          "note-question": "question",
          "note-general": "note"
        };
        ui.reviewComposer = {
          mode: "create",
          disposition: dispositionMap[action] as "approve" | "concern" | "question" | "note",
          noteId: null,
          body: "",
          cursorOffset: 0,
          preferredColumn: null
        };
        render();
        break;
      }
      case "next-brain":
      case "prev-brain":
        if (!cycleSelectedBrainEntry(view.snapshot, ui, action === "prev-brain" ? -1 : 1)) {
          setToast(ui, "error", "No brain entries are available for the active mission.");
        }
        render();
        break;
      case "brain-search":
        ui.brainSearch = {
          value: ui.brainFilters.query,
          cursorOffset: ui.brainFilters.query.length,
          preferredColumn: null
        };
        render();
        break;
      case "brain-cycle-category":
        cycleBrainFilterCategory(ui);
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        break;
      case "brain-cycle-scope":
        cycleBrainFilterScope(ui);
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        break;
      case "brain-toggle-retired":
        ui.brainFilters.includeRetired = !ui.brainFilters.includeRetired;
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        break;
      case "brain-cycle-focus":
        cycleBrainFocusArea(ui);
        render();
        break;
      case "brain-cycle-graph-mode":
        cycleBrainGraphMode(ui);
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        break;
      case "brain-cycle-path":
        cycleBrainPathHint(view.snapshot, ui);
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        break;
      case "brain-cycle-target": {
        const moved =
          ui.brainFilters.focusArea === "entries"
            ? cycleSelectedBrainEntry(view.snapshot, ui, 1)
            : ui.brainFilters.focusArea === "related"
              ? cycleSelectedBrainRelatedEntry(view.snapshot, ui, 1)
              : ui.brainFilters.focusArea === "graph"
                ? cycleSelectedBrainGraphEntry(view.snapshot, ui, 1)
                : cycleSelectedBrainEvidenceTarget(view.snapshot, ui, 1);
        if (!moved) {
          setToast(ui, "error", "No brain targets are available for the current focus.");
        }
        render();
        break;
      }
      case "brain-focus-target":
        if (!focusSelectedBrainTarget(view.snapshot, ui)) {
          setToast(ui, "error", "No brain target is selected.");
        } else {
          syncSelectedBrainEntry(view.snapshot, ui);
        }
        render();
        break;
      case "mission-cycle-autonomy":
        runAction(async () => {
          const mission = buildWorkflowResult(view.snapshot).activeMission;
          if (!mission) {
            throw new Error("No active mission is available.");
          }
          const order = ["inspect", "guided", "autonomous", "overnight"] as const;
          const currentIndex = Math.max(0, order.indexOf(mission.policy?.autonomyLevel ?? "guided"));
          const nextLevel = order[(currentIndex + 1) % order.length] ?? "guided";
          await updateActiveMissionPolicyFromTui(paths, view.snapshot, ui, view, {
            autonomyLevel: nextLevel
          });
          await refresh();
        });
        break;
      case "mission-toggle-autopilot":
        runAction(async () => {
          const mission = buildWorkflowResult(view.snapshot).activeMission;
          if (!mission) {
            throw new Error("No active mission is available.");
          }
          await updateActiveMissionPolicyFromTui(paths, view.snapshot, ui, view, {
            autopilotEnabled: !mission.autopilotEnabled
          });
          await refresh();
        });
        break;
      case "mission-toggle-auto-verify":
        runAction(async () => {
          const mission = buildWorkflowResult(view.snapshot).activeMission;
          if (!mission) {
            throw new Error("No active mission is available.");
          }
          await updateActiveMissionPolicyFromTui(paths, view.snapshot, ui, view, {
            autoVerify: !(mission.policy?.autoVerify === true)
          });
          await refresh();
        });
        break;
      case "mission-toggle-auto-land":
        runAction(async () => {
          const mission = buildWorkflowResult(view.snapshot).activeMission;
          if (!mission) {
            throw new Error("No active mission is available.");
          }
          await updateActiveMissionPolicyFromTui(paths, view.snapshot, ui, view, {
            autoLand: !(mission.policy?.autoLand === true)
          });
          await refresh();
        });
        break;
      case "mission-toggle-pause-on-repair":
        runAction(async () => {
          const mission = buildWorkflowResult(view.snapshot).activeMission;
          if (!mission) {
            throw new Error("No active mission is available.");
          }
          await updateActiveMissionPolicyFromTui(paths, view.snapshot, ui, view, {
            pauseOnRepairFailure: !(mission.policy?.pauseOnRepairFailure === true)
          });
          await refresh();
        });
        break;
      case "toggle-brain-pin":
        runAction(async () => {
          await toggleSelectedBrainEntryPinned(paths, view.snapshot, ui, view);
          await refresh();
        });
        break;
      case "mark-brain-merge-source":
        try {
          markSelectedBrainMergeSource(view.snapshot, ui);
        } catch (error) {
          setToast(ui, "error", error instanceof Error ? error.message : String(error));
        }
        render();
        break;
      case "merge-brain":
        runAction(async () => {
          await mergeMarkedBrainEntry(paths, view.snapshot, ui, view);
          await refresh();
        });
        break;
      case "select-shadow":
        runAction(async () => {
          await selectRecommendedShadowMission(paths, view.snapshot, ui, view);
          await refresh();
        });
        break;
      case "retire-brain":
        runAction(async () => {
          await retireSelectedBrainEntry(paths, view.snapshot, ui, view);
          await refresh();
        });
        break;
      case "reply-note": {
        const note = selectedReviewNote(view.snapshot, ui);
        if (!note) {
          setToast(ui, "error", "No review note is selected.");
          render();
          break;
        }
        ui.reviewComposer = {
          mode: "reply",
          disposition: note.disposition,
          noteId: note.id,
          body: "",
          cursorOffset: 0,
          preferredColumn: null
        };
        render();
        break;
      }
      case "resolve-note":
        runAction(async () => {
          await toggleSelectedReviewNoteStatus(paths, view.snapshot, ui, view);
          await refresh();
        });
        break;
      case "wont-fix":
        runAction(async () => {
          await resolveSelectedReviewNoteWithDisposition(paths, view.snapshot, ui, "wont_fix", view);
          await refresh();
        });
        break;
      case "accepted-risk":
        runAction(async () => {
          await resolveSelectedReviewNoteWithDisposition(paths, view.snapshot, ui, "accepted_risk", view);
          await refresh();
        });
        break;
      case "fix-task":
        runAction(async () => {
          await enqueueSelectedReviewFollowUp(paths, view.snapshot, ui, "fix", view);
          await refresh();
        });
        break;
      case "handoff":
        runAction(async () => {
          await enqueueSelectedReviewFollowUp(paths, view.snapshot, ui, "handoff", view);
          await refresh();
        });
        break;
      case "go-top": {
        const items = buildTabItems(view.snapshot, ui.activeTab);
        ui.selectedIds[ui.activeTab] = items[0]?.id ?? null;
        ui.diffSelections = syncDiffSelections(
          ui.diffSelections,
          view.snapshot,
          ui.activeTab === "tasks" ? selectedTask(view.snapshot, ui) : null
        );
        syncSelectedReviewNote(view.snapshot, ui);
        render();
        void ensureSelectedTaskArtifact(paths, view, ui, render);
        void ensureSelectedDiffReview(paths, view, ui, render);
        break;
      }
      case "go-bottom": {
        const items = buildTabItems(view.snapshot, ui.activeTab);
        ui.selectedIds[ui.activeTab] = items.at(-1)?.id ?? null;
        ui.diffSelections = syncDiffSelections(
          ui.diffSelections,
          view.snapshot,
          ui.activeTab === "tasks" ? selectedTask(view.snapshot, ui) : null
        );
        syncSelectedReviewNote(view.snapshot, ui);
        render();
        void ensureSelectedTaskArtifact(paths, view, ui, render);
        void ensureSelectedDiffReview(paths, view, ui, render);
        break;
      }
      default:
        break;
    }
  };

  const keypressHandler = (input: string, key: readline.Key) => {
    if (closed) {
      return;
    }

    if (ui.brainSearch) {
      if (key.name === "escape") {
        ui.brainSearch = null;
        render();
        return;
      }

      if (key.ctrl && key.name === "u") {
        ui.brainSearch.value = "";
        clearEditorState(ui.brainSearch);
        ui.brainFilters.query = "";
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        return;
      }

      if (key.name === "backspace") {
        ui.brainSearch.value = backspaceEditorText(ui.brainSearch.value, ui.brainSearch);
        ui.brainFilters.query = ui.brainSearch.value;
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        return;
      }

      if (key.name === "delete") {
        ui.brainSearch.value = deleteEditorText(ui.brainSearch.value, ui.brainSearch);
        ui.brainFilters.query = ui.brainSearch.value;
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        return;
      }

      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "home" ||
        key.name === "end"
      ) {
        moveEditorCursor(ui.brainSearch.value, ui.brainSearch, key.name);
        render();
        return;
      }

      if (key.name === "return") {
        ui.brainFilters.query = ui.brainSearch.value.trim();
        ui.brainSearch = null;
        syncSelectedBrainEntry(view.snapshot, ui);
        render();
        return;
      }

      if (!key.ctrl && !key.meta) {
        const normalized = normalizeEditorInputChunk(input);
        if (normalized) {
          const result = insertEditorText(ui.brainSearch.value, ui.brainSearch, normalized);
          ui.brainSearch.value = result.value;
          ui.brainFilters.query = result.value;
          syncSelectedBrainEntry(view.snapshot, ui);
          render();
        }
      }
      return;
    }

    if (ui.reviewComposer) {
      runAction(async () => {
        if (key.name === "escape") {
          ui.reviewComposer = null;
          setToast(ui, "info", "Review note capture cancelled.");
          render();
          return;
        }

        if (key.ctrl && key.name === "u") {
          ui.reviewComposer!.body = "";
          clearEditorState(ui.reviewComposer!);
          render();
          return;
        }

        if (key.name === "backspace") {
          ui.reviewComposer!.body = backspaceEditorText(ui.reviewComposer!.body, ui.reviewComposer!);
          render();
          return;
        }

        if (key.name === "delete") {
          ui.reviewComposer!.body = deleteEditorText(ui.reviewComposer!.body, ui.reviewComposer!);
          render();
          return;
        }

        if (
          key.name === "left" ||
          key.name === "right" ||
          key.name === "up" ||
          key.name === "down" ||
          key.name === "home" ||
          key.name === "end"
        ) {
          moveEditorCursor(ui.reviewComposer!.body, ui.reviewComposer!, key.name);
          render();
          return;
        }

        if (key.name === "return") {
          if (key.meta || key.shift) {
            appendReviewComposerText(ui.reviewComposer!, "\n");
            render();
            return;
          }

          await submitReviewNote(paths, view, ui);
          await refresh();
          render();
          return;
        }

        if (!key.ctrl && !key.meta && appendReviewComposerText(ui.reviewComposer!, input)) {
          render();
        }
      });
      return;
    }

    if (ui.composer) {
      runAction(async () => {
        if (key.name === "escape") {
          ui.composer = null;
          setToast(ui, "info", "Task composition cancelled.");
          render();
          return;
        }

        if (key.ctrl && key.name === "u") {
          ui.composer.prompt = "";
          ui.composer.pasteCount = 0;
          ui.composer.pasteSummary = null;
          clearEditorState(ui.composer);
          render();
          return;
        }

        if (key.name === "backspace") {
          ui.composer.prompt = backspaceEditorText(ui.composer.prompt, ui.composer);
          if (!ui.composer.prompt) {
            ui.composer.pasteCount = 0;
            ui.composer.pasteSummary = null;
          }
          render();
          return;
        }

        if (key.name === "delete") {
          ui.composer.prompt = deleteEditorText(ui.composer.prompt, ui.composer);
          render();
          return;
        }

        if (key.ctrl && key.name === "p") {
          ui.composer.planningMode = nextComposerPlanningMode(ui.composer.planningMode);
          render();
          return;
        }

        if (key.ctrl && key.name === "s") {
          await queueManualTask(paths, view, ui);
          await refresh();
          if (ui.activeTab === "tasks") {
            ui.selectedIds.tasks = buildTabItems(view.snapshot, "tasks")[0]?.id ?? null;
          } else if (ui.activeTab === "results") {
            ui.selectedIds.results = "result:current";
          }
          ui.diffSelections = syncDiffSelections(
            ui.diffSelections,
            view.snapshot,
            selectedTask(view.snapshot, ui)
          );
          syncSelectedReviewNote(view.snapshot, ui);
          render();
          void ensureSelectedTaskArtifact(paths, view, ui, render);
          void ensureSelectedDiffReview(paths, view, ui, render);
          return;
        }

        if (
          key.name === "left" ||
          key.name === "right" ||
          key.name === "up" ||
          key.name === "down" ||
          key.name === "home" ||
          key.name === "end"
        ) {
          moveEditorCursor(ui.composer.prompt, ui.composer, key.name);
          render();
          return;
        }

        if (key.name === "return") {
          if (ui.composer.expanded || key.meta || key.shift) {
            if (!ui.composer.expanded && (key.meta || key.shift)) {
              ui.composer.expanded = true;
            }
            appendComposerText(ui.composer, "\n");
            render();
            return;
          }

          await queueManualTask(paths, view, ui);
          await refresh();
          if (ui.activeTab === "tasks") {
            ui.selectedIds.tasks = buildTabItems(view.snapshot, "tasks")[0]?.id ?? null;
          } else if (ui.activeTab === "results") {
            ui.selectedIds.results = "result:current";
          }
          ui.diffSelections = syncDiffSelections(
            ui.diffSelections,
            view.snapshot,
            selectedTask(view.snapshot, ui)
          );
          syncSelectedReviewNote(view.snapshot, ui);
          render();
          void ensureSelectedTaskArtifact(paths, view, ui, render);
          void ensureSelectedDiffReview(paths, view, ui, render);
          return;
        }

        if (key.name === "tab" || input === "\t") {
          ui.composer.owner = nextComposerOwner(ui.composer.owner, key.shift ? -1 : 1);
          render();
          return;
        }

        if (!key.ctrl && !key.meta && appendComposerText(ui.composer, input)) {
          render();
        }
      });
      return;
    }

    if (ui.confirmDialog) {
      if (key.name === "escape") {
        ui.confirmDialog = null;
        render();
        return;
      }

      if (key.name === "return") {
        const action = ui.confirmDialog.confirmAction;
        ui.confirmDialog = null;
        render();

        if (action === "land") {
          runAction(async () => {
            await landFromTui();
          });
        } else if (action === "stop") {
          runAction(async () => {
            await rpcShutdown(paths);
            close();
          });
        } else if (action === "toggle-access") {
          runAction(async () => {
            await toggleFullAccessMode();
          });
        }
        return;
      }

      return;
    }

    if (ui.commandPalette) {
      if (key.name === "escape") {
        ui.commandPalette = null;
        render();
        return;
      }

      if (key.name === "return") {
        const commands = filteredCommands(ui.commandPalette.query, ui.activeTab);
        const selected = commands[ui.commandPalette.selectedIndex];
        ui.commandPalette = null;
        if (selected) {
          executeCommandAction(selected.action);
        } else {
          render();
        }
        return;
      }

      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        const commands = filteredCommands(ui.commandPalette.query, ui.activeTab);
        if (commands.length > 0) {
          ui.commandPalette.selectedIndex =
            (ui.commandPalette.selectedIndex - 1 + commands.length) % commands.length;
        }
        render();
        return;
      }

      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        const commands = filteredCommands(ui.commandPalette.query, ui.activeTab);
        if (commands.length > 0) {
          ui.commandPalette.selectedIndex =
            (ui.commandPalette.selectedIndex + 1) % commands.length;
        }
        render();
        return;
      }

      if (key.name === "backspace") {
        ui.commandPalette.query = ui.commandPalette.query.slice(0, -1);
        ui.commandPalette.selectedIndex = 0;
        render();
        return;
      }

      if (!key.ctrl && !key.meta && input && input.length === 1) {
        ui.commandPalette.query += input;
        ui.commandPalette.selectedIndex = 0;
        render();
        return;
      }

      return;
    }

    if (ui.infoOverlay) {
      if (input === "?" || key.name === "escape") {
        ui.infoOverlay = false;
        render();
      }
      return;
    }

    if (ui.agentDetailOverlay) {
      if (key.name === "escape" || input === "i") {
        ui.agentDetailOverlay = null;
        render();
      }
      return;
    }

    if (key.ctrl && key.name === "k") {
      ui.commandPalette = { query: "", selectedIndex: 0 };
      render();
      return;
    }

    if (input === "?") {
      ui.infoOverlay = true;
      render();
      return;
    }

    if (input === "i") {
      ui.agentDetailOverlay = ui.agentDetailOverlay ? null : "codex";
      render();
      return;
    }

    if (input === "I") {
      ui.agentDetailOverlay = ui.agentDetailOverlay ? null : "claude";
      render();
      return;
    }

    if (input === "q" || (key.ctrl && key.name === "c")) {
      close();
      return;
    }

    const numericTab = Number(input);
    if (Number.isInteger(numericTab) && numericTab >= 1 && numericTab <= OPERATOR_TABS.length) {
      const tab = OPERATOR_TABS[numericTab - 1];
      if (tab) {
        selectTab(tab);
      }
      return;
    }

    if (key.name === "tab") {
      selectTab(nextTab(ui.activeTab, key.shift ? -1 : 1));
      return;
    }

    if (key.name === "left" || input === "h") {
      selectTab(nextTab(ui.activeTab, -1));
      return;
    }

    if (key.name === "right" || input === "l") {
      selectTab(nextTab(ui.activeTab, 1));
      return;
    }

    if (key.name === "down" || input === "j") {
      moveSelection(1);
      return;
    }

    if (key.name === "up" || input === "k") {
      moveSelection(-1);
      return;
    }

    if (input === "g" && !key.shift) {
      const items = buildTabItems(view.snapshot, ui.activeTab);
      ui.selectedIds[ui.activeTab] = items[0]?.id ?? null;
      ui.diffSelections = syncDiffSelections(
        ui.diffSelections,
        view.snapshot,
        ui.activeTab === "tasks" ? selectedTask(view.snapshot, ui) : null
      );
      syncSelectedReviewNote(view.snapshot, ui);
      render();
      void ensureSelectedTaskArtifact(paths, view, ui, render);
      void ensureSelectedDiffReview(paths, view, ui, render);
      return;
    }

    if (key.name === "g" && key.shift) {
      const items = buildTabItems(view.snapshot, ui.activeTab);
      ui.selectedIds[ui.activeTab] = items.at(-1)?.id ?? null;
      ui.diffSelections = syncDiffSelections(
        ui.diffSelections,
        view.snapshot,
        ui.activeTab === "tasks" ? selectedTask(view.snapshot, ui) : null
      );
      syncSelectedReviewNote(view.snapshot, ui);
      render();
      void ensureSelectedTaskArtifact(paths, view, ui, render);
      void ensureSelectedDiffReview(paths, view, ui, render);
      return;
    }

    if (input === "[" || input === "]") {
      if (ui.activeTab !== "tasks") {
        return;
      }

      const currentIndex = TASK_DETAIL_SECTIONS.indexOf(ui.taskDetailSection);
      const delta = input === "[" ? -1 : 1;
      const nextIndex = (currentIndex + delta + TASK_DETAIL_SECTIONS.length) % TASK_DETAIL_SECTIONS.length;
      ui.taskDetailSection = TASK_DETAIL_SECTIONS[nextIndex] ?? ui.taskDetailSection;
      ui.diffSelections = syncDiffSelections(
        ui.diffSelections,
        view.snapshot,
        selectedTask(view.snapshot, ui)
      );
      syncSelectedReviewNote(view.snapshot, ui);
      render();
      void ensureSelectedTaskArtifact(paths, view, ui, render);
      void ensureSelectedDiffReview(paths, view, ui, render);
      return;
    }

    if (input === "r") {
      runAction(refresh);
      return;
    }

    if (ui.activeTab === "results" && (input === "(" || input === ")")) {
      executeCommandAction(input === "(" ? "prev-brain" : "next-brain");
      return;
    }

    if (ui.activeTab === "results" && input === "/") {
      executeCommandAction("brain-search");
      return;
    }

    if (ui.activeTab === "results" && input === "b") {
      executeCommandAction("brain-cycle-category");
      return;
    }

    if (ui.activeTab === "results" && input === "B") {
      executeCommandAction("brain-cycle-scope");
      return;
    }

    if (ui.activeTab === "results" && input === "v") {
      executeCommandAction("brain-toggle-retired");
      return;
    }

    if (ui.activeTab === "results" && input === "f") {
      executeCommandAction("brain-cycle-focus");
      return;
    }

    if (ui.activeTab === "results" && input === "e") {
      executeCommandAction("brain-cycle-graph-mode");
      return;
    }

    if (ui.activeTab === "results" && input === "P") {
      executeCommandAction("brain-cycle-path");
      return;
    }

    if (ui.activeTab === "results" && (input === "o" || input === "O")) {
      const moved =
        ui.brainFilters.focusArea === "entries"
          ? cycleSelectedBrainEntry(view.snapshot, ui, input === "O" ? -1 : 1)
          : ui.brainFilters.focusArea === "related"
            ? cycleSelectedBrainRelatedEntry(view.snapshot, ui, input === "O" ? -1 : 1)
            : ui.brainFilters.focusArea === "graph"
              ? cycleSelectedBrainGraphEntry(view.snapshot, ui, input === "O" ? -1 : 1)
              : cycleSelectedBrainEvidenceTarget(view.snapshot, ui, input === "O" ? -1 : 1);
      if (!moved) {
        setToast(ui, "error", "No brain targets are available for the current focus.");
      }
      render();
      return;
    }

    if (ui.activeTab === "results" && key.name === "return") {
      executeCommandAction("brain-focus-target");
      return;
    }

    if (ui.activeTab === "results" && input === "u") {
      executeCommandAction("mission-cycle-autonomy");
      return;
    }

    if (ui.activeTab === "results" && input === "a") {
      executeCommandAction("mission-toggle-autopilot");
      return;
    }

    if (ui.activeTab === "results" && input === "V") {
      executeCommandAction("mission-toggle-auto-verify");
      return;
    }

    if (ui.activeTab === "results" && input === "J") {
      executeCommandAction("mission-toggle-auto-land");
      return;
    }

    if (ui.activeTab === "results" && input === "K") {
      executeCommandAction("mission-toggle-pause-on-repair");
      return;
    }

    if (ui.activeTab === "results" && input === "p") {
      executeCommandAction("toggle-brain-pin");
      return;
    }

    if (ui.activeTab === "results" && input === "m") {
      executeCommandAction("mark-brain-merge-source");
      return;
    }

    if (ui.activeTab === "results" && input === "U") {
      executeCommandAction("merge-brain");
      return;
    }

    if (ui.activeTab === "results" && input === "S") {
      executeCommandAction("select-shadow");
      return;
    }

    if (ui.activeTab === "results" && input === "X") {
      executeCommandAction("retire-brain");
      return;
    }

    if (input === "!") {
      executeCommandAction("toggle-access");
      return;
    }

    if (input === "L") {
      executeCommandAction("land");
      return;
    }

    if (input === "t" && ui.activeTab === "tasks") {
      executeCommandAction("retry-task");
      return;
    }

    if (input === "c") {
      ui.composer = {
        owner: "auto",
        planningMode: "auto",
        prompt: "",
        pasteCount: 0,
        expanded: false,
        pasteSummary: null,
        cursorOffset: 0,
        preferredColumn: null
      };
      render();
      return;
    }

    if (input === "s") {
      executeCommandAction("stop");
      return;
    }

    if (ui.activeTab === "recommendations" && key.name === "return") {
      runAction(async () => {
        await applySelectedRecommendation(paths, view.snapshot, ui, false, view);
        await refresh();
      });
      return;
    }

    if (ui.activeTab === "recommendations" && input === "P") {
      runAction(async () => {
        await applySelectedRecommendation(paths, view.snapshot, ui, true, view);
        await refresh();
      });
      return;
    }

    if (ui.activeTab === "recommendations" && input === "z") {
      runAction(async () => {
        await dismissSelectedRecommendation(paths, view.snapshot, ui, view);
        await refresh();
      });
      return;
    }

    if (ui.activeTab === "recommendations" && input === "Z") {
      runAction(async () => {
        await restoreSelectedRecommendation(paths, view.snapshot, ui, view);
        await refresh();
      });
      return;
    }

    if (input === "y" || input === "n") {
      runAction(async () => {
        await resolveApprovalSelection(
          paths,
          view.snapshot,
          ui,
          input === "y" ? "allow" : "deny",
          key.shift === true,
          view
        );
        await refresh();
      });
      return;
    }

    if (input === "A" || input === "C" || input === "Q" || input === "M") {
      if (!activeReviewContext(view.snapshot, ui)) {
        setToast(ui, "error", "No active diff review context is selected.");
        render();
        return;
      }

      ui.reviewComposer = {
        mode: "create",
        disposition:
          input === "A"
            ? "approve"
            : input === "C"
              ? "concern"
              : input === "Q"
                ? "question"
                : "note",
        noteId: null,
        body: "",
        cursorOffset: 0,
        preferredColumn: null
      };
      render();
      return;
    }

    if (input === "o" || input === "O") {
      if (!cycleSelectedReviewNote(view.snapshot, ui, input === "O" ? -1 : 1)) {
        setToast(ui, "error", "No review notes are available in the current diff context.");
      }
      render();
      return;
    }

    if (input === "E") {
      const note = selectedReviewNote(view.snapshot, ui);
      if (!note) {
        setToast(ui, "error", "No review note is selected.");
        render();
        return;
      }

      ui.reviewComposer = {
        mode: "edit",
        disposition: note.disposition,
        noteId: note.id,
        body: note.body,
        cursorOffset: note.body.length,
        preferredColumn: null
      };
      render();
      return;
    }

    if (input === "T") {
      const note = selectedReviewNote(view.snapshot, ui);
      if (!note) {
        setToast(ui, "error", "No review note is selected.");
        render();
        return;
      }

      ui.reviewComposer = {
        mode: "reply",
        disposition: note.disposition,
        noteId: note.id,
        body: "",
        cursorOffset: 0,
        preferredColumn: null
      };
      render();
      return;
    }

    if (input === "R") {
      runAction(async () => {
        await toggleSelectedReviewNoteStatus(paths, view.snapshot, ui, view);
        await refresh();
      });
      return;
    }

    if (input === "a") {
      runAction(async () => {
        await cycleSelectedReviewNoteAssignee(paths, view.snapshot, ui, view);
        await refresh();
      });
      return;
    }

    if (input === "u") {
      ui.reviewFilters.assignee = cycleReviewFilterAssignee(ui.reviewFilters.assignee);
      syncSelectedReviewNote(view.snapshot, ui);
      setToast(ui, "info", `Review assignee filter: ${ui.reviewFilters.assignee === "all" ? "all" : reviewAssigneeLabel(ui.reviewFilters.assignee)}.`);
      render();
      return;
    }

    if (input === "v") {
      ui.reviewFilters.status = cycleReviewFilterStatus(ui.reviewFilters.status);
      syncSelectedReviewNote(view.snapshot, ui);
      setToast(ui, "info", `Review status filter: ${ui.reviewFilters.status}.`);
      render();
      return;
    }

    if (input === "d") {
      ui.reviewFilters.disposition = cycleReviewFilterDisposition(ui.reviewFilters.disposition);
      syncSelectedReviewNote(view.snapshot, ui);
      setToast(
        ui,
        "info",
        `Review disposition filter: ${ui.reviewFilters.disposition === "all" ? "all" : reviewDispositionLabel(ui.reviewFilters.disposition)}.`
      );
      render();
      return;
    }

    if (input === "w" || input === "x") {
      runAction(async () => {
        await resolveSelectedReviewNoteWithDisposition(
          paths,
          view.snapshot,
          ui,
          input === "w" ? "wont_fix" : "accepted_risk",
          view
        );
        await refresh();
      });
      return;
    }

    if (input === "F" || input === "H") {
      runAction(async () => {
        await enqueueSelectedReviewFollowUp(
          paths,
          view.snapshot,
          ui,
          input === "F" ? "fix" : "handoff",
          view
        );
        await refresh();
      });
      return;
    }

    if (input === "," || input === ".") {
      const agent = cycleDiffSelection(view.snapshot, ui, input === "," ? -1 : 1);
      if (!agent) {
        return;
      }

      render();
      syncSelectedReviewNote(view.snapshot, ui);
      void ensureSelectedDiffReview(paths, view, ui, render);
      return;
    }

    if (input === "{" || input === "}") {
      const agent = cycleDiffHunk(view.snapshot, ui, input === "{" ? -1 : 1);
      if (!agent) {
        return;
      }

      render();
      syncSelectedReviewNote(view.snapshot, ui);
      return;
    }

    if (key.name === "return" && ui.activeTab === "tasks") {
      const currentIndex = TASK_DETAIL_SECTIONS.indexOf(ui.taskDetailSection);
      ui.taskDetailSection = TASK_DETAIL_SECTIONS[(currentIndex + 1) % TASK_DETAIL_SECTIONS.length] ?? ui.taskDetailSection;
      ui.diffSelections = syncDiffSelections(
        ui.diffSelections,
        view.snapshot,
        selectedTask(view.snapshot, ui)
      );
      syncSelectedReviewNote(view.snapshot, ui);
      render();
      void ensureSelectedTaskArtifact(paths, view, ui, render);
      void ensureSelectedDiffReview(paths, view, ui, render);
    }
  };

  const resizeHandler = () => {
    render();
  };

  process.stdin.on("keypress", keypressHandler);
  process.stdout.on("resize", resizeHandler);
  await connectSubscription();
  if (!view.snapshot) {
    await refresh();
  }
  render();

  await new Promise<void>((resolve) => {
    closeResolver = resolve;
  });
}
