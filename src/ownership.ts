import path from "node:path";
import type { AgentName, KaviConfig, RouteDecision } from "./types.ts";

export interface OwnershipRuleCandidate {
  owner: AgentName;
  pattern: string;
  normalizedPattern: string;
  declaredIndex: number;
  matchedPaths: string[];
  coverage: number;
  exactCoverage: number;
  staticPrefixLength: number;
  literalLength: number;
  segmentCount: number;
  wildcardCount: number;
}

export interface OwnershipRuleConflict {
  leftOwner: AgentName;
  leftPattern: string;
  rightOwner: AgentName;
  rightPattern: string;
  kind: "exact" | "ambiguous-overlap";
  detail: string;
}

export interface OwnershipAnalysis {
  claimedPaths: string[];
  candidates: OwnershipRuleCandidate[];
  winningCandidate: OwnershipRuleCandidate | null;
  ambiguousCandidates: OwnershipRuleCandidate[];
}

export function normalizeOwnershipPattern(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  const withoutPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const normalized = path.posix.normalize(withoutPrefix);
  return normalized === "." ? "" : normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function globToRegex(pattern: string): RegExp {
  const normalized = normalizeOwnershipPattern(pattern);
  const escaped = normalized.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const regexSource = escaped
    .replaceAll("**", "::double-star::")
    .replaceAll("*", "[^/]*")
    .replaceAll("::double-star::", ".*");
  return new RegExp(`^${regexSource}$`);
}

export function matchesOwnershipPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeOwnershipPattern(filePath);
  const normalizedPattern = normalizeOwnershipPattern(pattern);
  if (!normalizedPath || !normalizedPattern) {
    return false;
  }

  return globToRegex(normalizedPattern).test(normalizedPath);
}

function ownershipStaticPrefix(pattern: string): string {
  const normalized = normalizeOwnershipPattern(pattern);
  const wildcardIndex = normalized.indexOf("*");
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, "");
}

function wildcardCount(pattern: string): number {
  return (pattern.match(/\*/g) ?? []).length;
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

function segmentCount(pattern: string): number {
  return pattern.split("/").filter(Boolean).length;
}

function exactCoverage(pattern: string, matchedPaths: string[]): number {
  const normalizedPattern = normalizeOwnershipPattern(pattern);
  if (normalizedPattern.includes("*")) {
    return 0;
  }

  return matchedPaths.filter((filePath) => normalizeOwnershipPattern(filePath) === normalizedPattern).length;
}

function buildOwnershipRuleCandidate(
  owner: AgentName,
  pattern: string,
  declaredIndex: number,
  claimedPaths: string[]
): OwnershipRuleCandidate | null {
  const normalizedPattern = normalizeOwnershipPattern(pattern);
  if (!normalizedPattern) {
    return null;
  }

  const matchedPaths = claimedPaths.filter((filePath) => matchesOwnershipPattern(filePath, normalizedPattern));
  if (matchedPaths.length === 0) {
    return null;
  }

  return {
    owner,
    pattern,
    normalizedPattern,
    declaredIndex,
    matchedPaths,
    coverage: matchedPaths.length,
    exactCoverage: exactCoverage(normalizedPattern, matchedPaths),
    staticPrefixLength: ownershipStaticPrefix(normalizedPattern).length,
    literalLength: literalLength(normalizedPattern),
    segmentCount: segmentCount(normalizedPattern),
    wildcardCount: wildcardCount(normalizedPattern)
  };
}

function compareRulePriority(
  left: OwnershipRuleCandidate,
  right: OwnershipRuleCandidate
): number {
  const comparisons: Array<[number, number, boolean]> = [
    [left.coverage, right.coverage, false],
    [left.exactCoverage, right.exactCoverage, false],
    [left.staticPrefixLength, right.staticPrefixLength, false],
    [left.literalLength, right.literalLength, false],
    [left.segmentCount, right.segmentCount, false],
    [left.wildcardCount, right.wildcardCount, true]
  ];

  for (const [leftValue, rightValue, preferLower] of comparisons) {
    if (leftValue === rightValue) {
      continue;
    }

    if (preferLower) {
      return leftValue < rightValue ? 1 : -1;
    }

    return leftValue > rightValue ? 1 : -1;
  }

  return 0;
}

function compareRuleCandidates(
  left: OwnershipRuleCandidate,
  right: OwnershipRuleCandidate
): number {
  const priority = compareRulePriority(left, right);
  if (priority !== 0) {
    return priority;
  }

  if (left.owner === right.owner && left.declaredIndex !== right.declaredIndex) {
    return left.declaredIndex < right.declaredIndex ? 1 : -1;
  }

  return 0;
}

function pathAncestorsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function patternsMayOverlap(leftPattern: string, rightPattern: string): boolean {
  const left = normalizeOwnershipPattern(leftPattern);
  const right = normalizeOwnershipPattern(rightPattern);
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftPrefix = ownershipStaticPrefix(left);
  const rightPrefix = ownershipStaticPrefix(right);
  if (!leftPrefix || !rightPrefix) {
    return false;
  }

  return pathAncestorsOverlap(leftPrefix, rightPrefix);
}

function summarizeCandidate(candidate: OwnershipRuleCandidate): Record<string, unknown> {
  return {
    owner: candidate.owner,
    pattern: candidate.pattern,
    declaredIndex: candidate.declaredIndex,
    matchedPaths: candidate.matchedPaths,
    coverage: candidate.coverage,
    exactCoverage: candidate.exactCoverage,
    staticPrefixLength: candidate.staticPrefixLength,
    literalLength: candidate.literalLength,
    segmentCount: candidate.segmentCount,
    wildcardCount: candidate.wildcardCount
  };
}

export function analyzeOwnershipRules(
  claimedPaths: string[],
  config: KaviConfig
): OwnershipAnalysis {
  const candidates = [
    ...config.routing.codexPaths
      .map((pattern, index) => buildOwnershipRuleCandidate("codex", pattern, index, claimedPaths))
      .filter((candidate): candidate is OwnershipRuleCandidate => candidate !== null),
    ...config.routing.claudePaths
      .map((pattern, index) => buildOwnershipRuleCandidate("claude", pattern, index, claimedPaths))
      .filter((candidate): candidate is OwnershipRuleCandidate => candidate !== null)
  ].sort((left, right) => compareRuleCandidates(right, left));

  const winningCandidate = candidates[0] ?? null;
  if (!winningCandidate) {
    return {
      claimedPaths,
      candidates,
      winningCandidate: null,
      ambiguousCandidates: []
    };
  }

  const ambiguousCandidates = candidates.filter(
    (candidate) =>
      candidate.owner !== winningCandidate.owner &&
      compareRulePriority(candidate, winningCandidate) === 0
  );

  return {
    claimedPaths,
    candidates,
    winningCandidate: ambiguousCandidates.length > 0 ? null : winningCandidate,
    ambiguousCandidates
  };
}

export function ownershipMetadataFromAnalysis(
  analysis: OwnershipAnalysis
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (analysis.winningCandidate) {
    metadata.winningRule = summarizeCandidate(analysis.winningCandidate);
    metadata.matchedRules = analysis.candidates.slice(0, 4).map(summarizeCandidate);
  }

  if (analysis.ambiguousCandidates.length > 0 && analysis.candidates[0]) {
    metadata.ownershipAmbiguity = {
      claimedPaths: analysis.claimedPaths,
      contenders: [analysis.candidates[0], ...analysis.ambiguousCandidates].map(summarizeCandidate)
    };
  }

  return metadata;
}

export function buildOwnershipRouteDecision(
  claimedPaths: string[],
  config: KaviConfig
): RouteDecision | null {
  const analysis = analyzeOwnershipRules(claimedPaths, config);
  if (!analysis.winningCandidate) {
    return null;
  }

  const candidate = analysis.winningCandidate;
  return {
    owner: candidate.owner,
    strategy: "manual",
    confidence: 0.97,
    reason: `Matched explicit ${candidate.owner} ownership rule ${candidate.pattern} for: ${candidate.matchedPaths.join(", ")}.`,
    claimedPaths,
    metadata: {
      ownershipSource: "config-routing-paths",
      ...ownershipMetadataFromAnalysis(analysis)
    }
  };
}

export function findOwnershipRuleConflicts(config: KaviConfig): OwnershipRuleConflict[] {
  const conflicts: OwnershipRuleConflict[] = [];
  const leftRules = config.routing.codexPaths.map((pattern, index) => ({
    owner: "codex" as const,
    pattern,
    normalizedPattern: normalizeOwnershipPattern(pattern),
    declaredIndex: index
  }));
  const rightRules = config.routing.claudePaths.map((pattern, index) => ({
    owner: "claude" as const,
    pattern,
    normalizedPattern: normalizeOwnershipPattern(pattern),
    declaredIndex: index
  }));

  for (const left of leftRules) {
    if (!left.normalizedPattern) {
      continue;
    }

    for (const right of rightRules) {
      if (!right.normalizedPattern || !patternsMayOverlap(left.pattern, right.pattern)) {
        continue;
      }

      if (left.normalizedPattern === right.normalizedPattern) {
        conflicts.push({
          leftOwner: left.owner,
          leftPattern: left.pattern,
          rightOwner: right.owner,
          rightPattern: right.pattern,
          kind: "exact",
          detail: `Both agents claim the same ownership rule ${left.pattern}.`
        });
        continue;
      }

      const syntheticPath = [
        ownershipStaticPrefix(left.normalizedPattern),
        ownershipStaticPrefix(right.normalizedPattern)
      ].filter(Boolean).sort((a, b) => b.length - a.length)[0];
      if (!syntheticPath) {
        continue;
      }

      const leftCandidate = buildOwnershipRuleCandidate(left.owner, left.pattern, left.declaredIndex, [syntheticPath]);
      const rightCandidate = buildOwnershipRuleCandidate(right.owner, right.pattern, right.declaredIndex, [syntheticPath]);
      if (!leftCandidate || !rightCandidate) {
        continue;
      }

      if (compareRulePriority(leftCandidate, rightCandidate) === 0) {
        conflicts.push({
          leftOwner: left.owner,
          leftPattern: left.pattern,
          rightOwner: right.owner,
          rightPattern: right.pattern,
          kind: "ambiguous-overlap",
          detail: `Ownership rules ${left.pattern} and ${right.pattern} can overlap without a specificity winner.`
        });
      }
    }
  }

  return conflicts;
}
