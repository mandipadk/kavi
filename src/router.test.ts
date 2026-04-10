import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  buildKickoffTasks,
  decomposeOperatorPrompt,
  extractPromptPathHints,
  previewRouteDecision,
  routePrompt
} from "./router.ts";

test("routePrompt prefers claude for frontend work", () => {
  assert.equal(routePrompt("Design a frontend dashboard with better ux", defaultConfig()), "claude");
});

test("routePrompt prefers codex for backend work", () => {
  assert.equal(routePrompt("Add a backend auth migration", defaultConfig()), "codex");
});

test("routePrompt prefers explicit path ownership over generic keywords", () => {
  const config = defaultConfig();
  config.routing.claudePaths = ["src/ui/**", "src/theme.css"];
  config.routing.codexPaths = ["src/server/**"];

  assert.equal(
    routePrompt("Refactor backend rendering in src/ui/App.tsx", config),
    "claude"
  );
  assert.equal(
    routePrompt("Polish the design for src/server/router.ts", config),
    "codex"
  );
});

test("previewRouteDecision keeps AI pending when no deterministic route exists", () => {
  const preview = previewRouteDecision("Investigate the next iteration of the product", defaultConfig());
  assert.equal(preview.strategy, "fallback");
  assert.equal(preview.owner, "codex");
  assert.equal(preview.metadata.aiPending, true);
});

test("buildKickoffTasks creates one task per agent", () => {
  const tasks = buildKickoffTasks("Build the system");
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((task) => task.owner),
    ["codex", "claude"]
  );
});

test("extractPromptPathHints pulls obvious file paths from prompts", () => {
  assert.deepEqual(
    extractPromptPathHints("Update `src/ui/App.tsx` and src/server/router.ts"),
    ["src/server/router.ts", "src/ui/App.tsx"]
  );
});

test("decomposeOperatorPrompt splits checklist prompts and preserves shared context", () => {
  const tasks = decomposeOperatorPrompt([
    "Build the next iteration of the app with these changes:",
    "- Create the backend API in src/server/api.ts",
    "- Design the frontend shell in src/ui/App.tsx"
  ].join("\n"));

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.source, "checklist");
  assert.equal(tasks[1]?.source, "checklist");
  assert.match(tasks[0]?.prompt ?? "", /^Build the next iteration of the app with these changes:/);
  assert.match(tasks[0]?.prompt ?? "", /Subtask:\nCreate the backend API in src\/server\/api\.ts$/);
  assert.match(tasks[1]?.prompt ?? "", /Subtask:\nDesign the frontend shell in src\/ui\/App\.tsx$/);
});
