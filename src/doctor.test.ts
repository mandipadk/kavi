import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config.ts";
import {
  parseClaudeAuthStatus,
  parseClaudePrintContractIssues,
  validateRoutingPathRules
} from "./doctor.ts";

test("parseClaudeAuthStatus extracts logged-in provider details", () => {
  assert.deepEqual(
    parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"third_party","apiProvider":"vertex"}'),
    {
      loggedIn: true,
      detail: "logged in via third_party (vertex)"
    }
  );
});

test("parseClaudeAuthStatus handles malformed output", () => {
  assert.deepEqual(parseClaudeAuthStatus("not json"), {
    loggedIn: false,
    detail: "not json"
  });
});

test("parseClaudePrintContractIssues accepts complete help output", () => {
  const issues = parseClaudePrintContractIssues(`
Usage: claude [options]
  -p, --print
  --output-format <format>
  --json-schema <schema>
  --session-id <id>
  --permission-mode <mode>
`);
  assert.deepEqual(issues, []);
});

test("parseClaudePrintContractIssues reports missing required flags", () => {
  const issues = parseClaudePrintContractIssues(`
Usage: claude [options]
  -p, --print
  --output-format <format>
`);
  assert.deepEqual(issues, [
    "missing --json-schema",
    "missing --session-id",
    "missing --permission-mode"
  ]);
});

test("validateRoutingPathRules reports duplicates and overlaps", () => {
  const config = defaultConfig();
  config.routing.codexPaths = ["src/server/**", "src/server/**", "/absolute/path/**"];
  config.routing.claudePaths = ["src/server/**", "", "../outside/**"];

  const issues = validateRoutingPathRules(config);
  assert.equal(issues.some((issue) => issue.includes("duplicate ownership rules")), true);
  assert.equal(issues.some((issue) => issue.includes("overlap")), true);
  assert.equal(issues.some((issue) => issue.includes("must not be empty")), true);
  assert.equal(issues.some((issue) => issue.includes("repo-relative")), true);
  assert.equal(issues.some((issue) => issue.includes("inside the repo root")), true);
});
