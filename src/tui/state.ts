import type { TextEditorState } from "../editor.ts";
import type { KaviRuntimeIdentity, DaemonCompatibility } from "../compatibility.ts";
import type {
  KaviSnapshot,
  ReviewAssignee,
  ReviewDisposition,
  TaskArtifact,
  WorktreeDiffReview
} from "../types.ts";

export const OPERATOR_TABS = [
  "results",
  "activity",
  "tasks",
  "recommendations",
  "approvals",
  "claims",
  "decisions",
  "messages",
  "worktrees"
] as const;

export function nextComposerOwner(current: ComposerOwner, delta = 1): ComposerOwner {
  const order: ComposerOwner[] = ["auto", "codex", "claude"];
  const currentIndex = Math.max(0, order.indexOf(current));
  return order[(currentIndex + delta + order.length) % order.length] ?? current;
}

export function nextComposerPlanningMode(
  current: ComposerState["planningMode"],
  delta = 1
): ComposerState["planningMode"] {
  const order: Array<ComposerState["planningMode"]> = ["auto", "plan", "direct"];
  const currentIndex = Math.max(0, order.indexOf(current));
  return order[(currentIndex + delta + order.length) % order.length] ?? current;
}

export const TASK_DETAIL_SECTIONS = ["overview", "prompt", "replay", "output", "diff"] as const;

export type OperatorTab = (typeof OPERATOR_TABS)[number];
export type TaskDetailSection = (typeof TASK_DETAIL_SECTIONS)[number];
export type ComposerOwner = "auto" | "codex" | "claude";
export type ToastLevel = "info" | "error";
export type ManagedAgent = "codex" | "claude";
export type InteractionMode =
  | "normal"
  | "composer"
  | "brain-search"
  | "review-composer"
  | "command-palette"
  | "info-overlay"
  | "agent-detail"
  | "confirm";

export interface OperatorView {
  snapshot: KaviSnapshot | null;
  connected: boolean;
  error: string | null;
  refreshedAt: string | null;
  clientIdentity: KaviRuntimeIdentity | null;
  compatibility: DaemonCompatibility | null;
}

export interface ArtifactCacheEntry {
  taskUpdatedAt: string;
  artifact: TaskArtifact | null;
  error: string | null;
}

export interface DiffReviewCacheEntry {
  selectedPath: string | null;
  changedSignature: string;
  review: WorktreeDiffReview | null;
  error: string | null;
}

export interface OperatorToast {
  level: ToastLevel;
  message: string;
  expiresAt: number;
}

export interface ComposerState extends TextEditorState {
  owner: ComposerOwner;
  planningMode: "auto" | "plan" | "direct";
  prompt: string;
  expanded: boolean;
  pasteCount: number;
  pasteSummary: string | null;
}

export interface ReviewComposerState extends TextEditorState {
  mode: "create" | "edit" | "reply";
  disposition: ReviewDisposition;
  noteId: string | null;
  body: string;
}

export interface ReviewFilterState {
  assignee: ReviewAssignee | "all";
  disposition: ReviewDisposition | "all";
  status: "all" | "open" | "resolved";
}

export interface BrainFilterState {
  query: string;
  category: "all" | "fact" | "decision" | "procedure" | "risk" | "artifact";
  scope: "all" | "repo" | "mission" | "personal" | "pattern";
  includeRetired: boolean;
  focusArea: "entries" | "related" | "graph" | "evidence";
  graphMode: "all" | "structural" | "knowledge";
  pathHint: string;
}

export interface CommandPaletteEntry {
  label: string;
  shortcut: string;
  action: string;
  contexts: OperatorTab[] | "all";
}

export interface CommandPaletteState {
  query: string;
  selectedIndex: number;
}

export interface ConfirmDialogState {
  title: string;
  body: string[];
  confirmLabel: string;
  confirmAction: string;
}

export interface OperatorUiState {
  activeTab: OperatorTab;
  selectedIds: Record<OperatorTab, string | null>;
  seenMarkers: Record<OperatorTab, string | null>;
  taskDetailSection: TaskDetailSection;
  composer: ComposerState | null;
  reviewComposer: ReviewComposerState | null;
  toast: OperatorToast | null;
  artifacts: Record<string, ArtifactCacheEntry>;
  loadingArtifacts: Record<string, boolean>;
  diffSelections: Record<ManagedAgent, string | null>;
  diffReviews: Record<ManagedAgent, DiffReviewCacheEntry | null>;
  loadingDiffReviews: Record<ManagedAgent, boolean>;
  hunkSelections: Record<ManagedAgent, number>;
  selectedReviewNoteId: string | null;
  selectedBrainEntryId: string | null;
  selectedBrainRelatedEntryId: string | null;
  selectedBrainGraphEntryId: string | null;
  selectedBrainEvidenceIndex: number;
  brainMergeSourceEntryId: string | null;
  brainFilters: BrainFilterState;
  brainSearch: TextEditorState | null;
  reviewFilters: ReviewFilterState;
  infoOverlay: boolean;
  agentDetailOverlay: ManagedAgent | null;
  commandPalette: CommandPaletteState | null;
  confirmDialog: ConfirmDialogState | null;
}

export interface OperatorListItem {
  id: string;
  title: string;
  detail: string;
  tone: "normal" | "good" | "warn" | "bad" | "muted";
}

export interface Column {
  lines: string[];
  width: number;
}

export interface ReviewContext {
  agent: ManagedAgent;
  taskId: string | null;
  filePath: string;
  hunkIndex: number | null;
  hunkHeader: string | null;
}
