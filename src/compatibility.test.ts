import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDaemonCompatibility,
  formatRestartRequiredMessage
} from "./compatibility.ts";

test("evaluateDaemonCompatibility reports missing protocol tracking as incompatible", () => {
  const compatibility = evaluateDaemonCompatibility(
    {
      daemonVersion: null,
      protocolVersion: null
    },
    {
      version: "1.1.2",
      protocolVersion: 1
    }
  );

  assert.equal(compatibility.compatible, false);
  assert.match(compatibility.reason ?? "", /predates protocol tracking/i);
});

test("evaluateDaemonCompatibility reports version mismatch when daemon and client diverge", () => {
  const compatibility = evaluateDaemonCompatibility(
    {
      daemonVersion: "1.0.0",
      protocolVersion: 1
    },
    {
      version: "1.1.2",
      protocolVersion: 1
    }
  );

  assert.equal(compatibility.compatible, false);
  assert.match(compatibility.reason ?? "", /version mismatch/i);
  assert.match(
    formatRestartRequiredMessage("Queueing a task", compatibility),
    /Run "kavi restart"/
  );
});
