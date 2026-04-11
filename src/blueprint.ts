import { createMission } from "./missions.ts";
import { compileMissionPrompt } from "./mission-kernel.ts";
import type {
  Mission,
  MissionAnchor,
  MissionBlueprint,
  MissionContract,
  MissionPolicy,
  MissionRisk,
  MissionSpec,
  SessionRecord
} from "./types.ts";

export interface BlueprintPreview {
  prompt: string;
  spec: MissionSpec;
  contract: MissionContract;
  blueprint: MissionBlueprint;
  policy: MissionPolicy;
  risks: MissionRisk[];
  anchors: MissionAnchor[];
  simulation: Mission["simulation"];
}

interface BlueprintDiffSection {
  added: string[];
  removed: string[];
  unchanged: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function diffList(before: string[] = [], after: string[] = []): BlueprintDiffSection {
  const left = unique(before);
  const right = unique(after);
  return {
    added: right.filter((value) => !left.includes(value)),
    removed: left.filter((value) => !right.includes(value)),
    unchanged: right.filter((value) => left.includes(value))
  };
}

export interface MissionBlueprintDiff {
  promptChanged: boolean;
  spec: {
    workstreamKinds: BlueprintDiffSection;
    stackHints: BlueprintDiffSection;
    requestedDeliverables: BlueprintDiffSection;
    userRoles: BlueprintDiffSection;
    domainEntities: BlueprintDiffSection;
    constraints: BlueprintDiffSection;
    audience: {
      before: string | null;
      after: string | null;
      changed: boolean;
    };
    repoShape: {
      before: MissionSpec["repoShape"];
      after: MissionSpec["repoShape"];
      changed: boolean;
    };
  };
  contract: {
    acceptanceCriteria: BlueprintDiffSection;
    scenarios: BlueprintDiffSection;
    qualityBars: BlueprintDiffSection;
    docsExpectations: BlueprintDiffSection;
  };
  blueprint: {
    personas: BlueprintDiffSection;
    domainModel: BlueprintDiffSection;
    serviceBoundaries: BlueprintDiffSection;
    uiSurfaces: BlueprintDiffSection;
    acceptanceJourneys: BlueprintDiffSection;
    architectureNotes: BlueprintDiffSection;
    productConcept: {
      before: string;
      after: string;
      changed: boolean;
    };
    overview: {
      before: string;
      after: string;
      changed: boolean;
    };
  };
  risks: {
    added: string[];
    removed: string[];
    unchanged: string[];
  };
  policy: {
    changedFields: string[];
    before: MissionPolicy | null;
    after: MissionPolicy;
  };
}

export function buildBlueprintPreview(session: SessionRecord, prompt: string): BlueprintPreview {
  const compiled = compileMissionPrompt(session, prompt);
  const draftMission = createMission(session, prompt, {
    mode: "inspect"
  });
  return {
    prompt: prompt.trim(),
    spec: compiled.spec,
    contract: compiled.contract,
    blueprint: compiled.blueprint,
    policy: compiled.policy,
    risks: compiled.risks,
    anchors: compiled.anchors,
    simulation: draftMission.simulation ?? null
  };
}

export function diffMissionBlueprint(
  mission: Mission,
  preview: BlueprintPreview
): MissionBlueprintDiff {
  const currentSpec = mission.spec ?? {
    normalizedPrompt: mission.prompt,
    audience: null,
    repoShape: "unknown" as const,
    workstreamKinds: [],
    stackHints: [],
    requestedDeliverables: [],
    userRoles: [],
    domainEntities: [],
    constraints: []
  };
  const currentContract = mission.contract ?? {
    acceptanceCriteria: [],
    scenarios: [],
    qualityBars: [],
    docsExpectations: []
  };
  const currentBlueprint = mission.blueprint ?? {
    overview: "",
    productConcept: "",
    personas: [],
    domainModel: [],
    serviceBoundaries: [],
    uiSurfaces: [],
    acceptanceJourneys: [],
    architectureNotes: []
  };
  const currentRisks = (mission.risks ?? []).map((risk) => risk.title);
  const nextRisks = preview.risks.map((risk) => risk.title);
  const changedFields = Object.entries(preview.policy)
    .filter(([key, value]) => {
      const currentValue = mission.policy?.[key as keyof MissionPolicy];
      return JSON.stringify(currentValue ?? null) !== JSON.stringify(value);
    })
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));

  return {
    promptChanged: mission.prompt.trim() !== preview.prompt.trim(),
    spec: {
      workstreamKinds: diffList(currentSpec.workstreamKinds, preview.spec.workstreamKinds),
      stackHints: diffList(currentSpec.stackHints, preview.spec.stackHints),
      requestedDeliverables: diffList(currentSpec.requestedDeliverables, preview.spec.requestedDeliverables),
      userRoles: diffList(currentSpec.userRoles, preview.spec.userRoles),
      domainEntities: diffList(currentSpec.domainEntities, preview.spec.domainEntities),
      constraints: diffList(currentSpec.constraints, preview.spec.constraints),
      audience: {
        before: currentSpec.audience,
        after: preview.spec.audience,
        changed: currentSpec.audience !== preview.spec.audience
      },
      repoShape: {
        before: currentSpec.repoShape,
        after: preview.spec.repoShape,
        changed: currentSpec.repoShape !== preview.spec.repoShape
      }
    },
    contract: {
      acceptanceCriteria: diffList(currentContract.acceptanceCriteria, preview.contract.acceptanceCriteria),
      scenarios: diffList(currentContract.scenarios, preview.contract.scenarios),
      qualityBars: diffList(currentContract.qualityBars, preview.contract.qualityBars),
      docsExpectations: diffList(currentContract.docsExpectations, preview.contract.docsExpectations)
    },
    blueprint: {
      personas: diffList(currentBlueprint.personas, preview.blueprint.personas),
      domainModel: diffList(currentBlueprint.domainModel, preview.blueprint.domainModel),
      serviceBoundaries: diffList(currentBlueprint.serviceBoundaries, preview.blueprint.serviceBoundaries),
      uiSurfaces: diffList(currentBlueprint.uiSurfaces, preview.blueprint.uiSurfaces),
      acceptanceJourneys: diffList(currentBlueprint.acceptanceJourneys, preview.blueprint.acceptanceJourneys),
      architectureNotes: diffList(currentBlueprint.architectureNotes, preview.blueprint.architectureNotes),
      productConcept: {
        before: currentBlueprint.productConcept,
        after: preview.blueprint.productConcept,
        changed: currentBlueprint.productConcept !== preview.blueprint.productConcept
      },
      overview: {
        before: currentBlueprint.overview,
        after: preview.blueprint.overview,
        changed: currentBlueprint.overview !== preview.blueprint.overview
      }
    },
    risks: diffList(currentRisks, nextRisks),
    policy: {
      changedFields,
      before: mission.policy ?? null,
      after: preview.policy
    }
  };
}

function comparableMissionFromPreview(prompt: string, preview: BlueprintPreview): Mission {
  return {
    id: "mission-preview",
    title: "Mission preview",
    prompt,
    goal: null,
    mode: "inspect",
    status: "planning",
    summary: "Mission preview",
    planningTaskId: null,
    planId: null,
    rootTaskId: null,
    activeTaskIds: [],
    autopilotEnabled: false,
    acceptance: {
      id: "accept-preview",
      summary: "Preview acceptance",
      criteria: preview.contract.acceptanceCriteria,
      checks: [],
      failurePacks: [],
      repairPlans: [],
      status: "pending",
      createdAt: "",
      updatedAt: ""
    },
    checkpoints: [],
    brainEntryIds: [],
    createdAt: "",
    updatedAt: "",
    landedAt: null,
    spec: preview.spec,
    contract: preview.contract,
    blueprint: preview.blueprint,
    policy: preview.policy,
    risks: preview.risks,
    anchors: preview.anchors,
    simulation: preview.simulation ?? undefined
  };
}

export function diffMissionPrompts(
  session: SessionRecord,
  beforePrompt: string,
  afterPrompt: string
): MissionBlueprintDiff {
  const beforePreview = buildBlueprintPreview(session, beforePrompt);
  const afterPreview = buildBlueprintPreview(session, afterPrompt);
  return diffMissionBlueprint(
    comparableMissionFromPreview(beforePrompt.trim(), beforePreview),
    afterPreview
  );
}
