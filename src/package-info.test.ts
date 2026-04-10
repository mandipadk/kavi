import test from "node:test";
import assert from "node:assert/strict";
import { loadPackageInfo } from "./package-info.ts";

test("loadPackageInfo reads package metadata from package.json", async () => {
  const info = await loadPackageInfo();
  assert.match(info.name, /kavi/);
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});
