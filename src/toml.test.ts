import test from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "./toml.ts";

test("parseToml handles root keys and nested sections", () => {
  const parsed = parseToml(`
version = 1
name = "kavi"

[routing]
frontend_keywords = ["ui", "ux"]
`);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.name, "kavi");
  assert.deepEqual(parsed.routing, {
    frontend_keywords: ["ui", "ux"]
  });
});
