import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeHookEvent,
  parseClaudeRuntimeText,
  parseClaudeTranscriptLine,
  parseCodexAssistantDeltaText,
  parseCodexNotificationEvent
} from "./provider-runtime.ts";

test("parseClaudeRuntimeText extracts runtime events and mentioned paths", () => {
  const events = parseClaudeRuntimeText(`
Tool: Bash
Running npm test in apps/web
Updated apps/web/app/page.tsx successfully
`);

  assert.ok(events.length >= 2);
  assert.equal(events[0]?.provider, "claude");
  assert.ok(events.some((event) => event.paths.includes("apps/web/app/page.tsx")));
});

test("parseCodexNotificationEvent summarizes notifications with paths", () => {
  const event = parseCodexNotificationEvent("item/fileChange/applied", {
    file: "apps/api/src/server.ts",
    detail: "patched file"
  });

  assert.ok(event);
  assert.equal(event?.provider, "codex");
  assert.equal(event?.eventName, "file-change");
  assert.ok(event?.paths.includes("apps/api/src/server.ts"));
  assert.match(event?.summary ?? "", /updated apps\/api\/src\/server\.ts/i);
});

test("parseClaudeHookEvent summarizes structured Claude hook payloads", () => {
  const events = parseClaudeHookEvent("PostToolUse", {
    tool_name: "Write",
    file_path: "apps/web/app/page.tsx",
    status: "success"
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.provider, "claude");
  assert.equal(events[0]?.source, "hook");
  assert.equal(events[0]?.eventName, "tool-complete");
  assert.ok(events[0]?.paths.includes("apps/web/app/page.tsx"));
});

test("parseCodexAssistantDeltaText extracts semantic draft progress from streamed deltas", () => {
  const events = parseCodexAssistantDeltaText(`"summary":"Created apps/api/src/server.ts and wired the queue worker for intake triage."`);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.provider, "codex");
  assert.equal(events[0]?.source, "delta");
  assert.equal(events[0]?.eventName, "edit");
  assert.equal(events[0]?.semanticKind, "editing");
  assert.match(events[0]?.summary ?? "", /Codex progress:/);
  assert.ok(events[0]?.paths.includes("apps/api/src/server.ts"));
});

test("parseCodexNotificationEvent extracts command and planning semantics", () => {
  const command = parseCodexNotificationEvent("item/commandExecution/completed", {
    command: "npm test",
    status: "success"
  });
  const planning = parseCodexNotificationEvent("item/reasoning/plan", {
    detail: "Split the work into backend, frontend, and verification nodes"
  });

  assert.equal(command?.eventName, "command-complete");
  assert.equal(command?.semanticKind, "command");
  assert.match(command?.summary ?? "", /completed `npm test`/i);
  assert.equal(planning?.eventName, "planning");
  assert.equal(planning?.semanticKind, "planning");
  assert.match(planning?.summary ?? "", /Codex planning:/);
});

test("parseCodexNotificationEvent upgrades generic item lifecycle events when item metadata exists", () => {
  const started = parseCodexNotificationEvent("item/started", {
    type: "search",
    detail: "finding route ownership hints"
  });
  const completed = parseCodexNotificationEvent("item/completed", {
    title: "write",
    file: "apps/web/app/page.tsx"
  });

  assert.equal(started?.eventName, "step-started");
  assert.match(started?.summary ?? "", /Search started/i);
  assert.equal(completed?.eventName, "step-completed");
  assert.match(completed?.summary ?? "", /Write completed/i);
});

test("parseCodexAssistantDeltaText classifies verification and blockers", () => {
  const verification = parseCodexAssistantDeltaText(`Verified apps/api/src/server.ts with npm test and smoke checks.`);
  const blocker = parseCodexAssistantDeltaText(`Blocked on missing DATABASE_URL before I can run migrations.`);

  assert.equal(verification[0]?.eventName, "verification");
  assert.match(verification[0]?.summary ?? "", /Codex verification:/);
  assert.equal(blocker[0]?.eventName, "blocker");
  assert.match(blocker[0]?.summary ?? "", /Codex blocker:/);
});

test("parseClaudeTranscriptLine extracts assistant text and tool activity from transcript jsonl", () => {
  const assistant = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    uuid: "assistant-1",
    message: {
      content: [
        {
          type: "text",
          text: "Now I'll create the clinic dashboard shell."
        },
        {
          type: "tool_use",
          name: "Write",
          input: {
            file_path: "apps/web/app/page.tsx"
          }
        }
      ]
    }
  }));

  assert.equal(assistant.id, "assistant-1");
  assert.equal(assistant.events.length, 2);
  assert.equal(assistant.events[0]?.source, "transcript");
  assert.equal(assistant.events[0]?.eventName, "edit");
  assert.equal(assistant.events[0]?.semanticKind, "scaffold");
  assert.equal(assistant.events[1]?.eventName, "file-change");
  assert.equal(assistant.events[1]?.semanticKind, "editing");
  assert.ok(assistant.events[1]?.paths.includes("apps/web/app/page.tsx"));
});

test("parseClaudeTranscriptLine derives command and verification semantics from tool results", () => {
  const result = parseClaudeTranscriptLine(JSON.stringify({
    type: "user",
    uuid: "assistant-3",
    toolUseResult: {
      toolName: "Bash",
      command: "npm test",
      exitCode: 0,
      stdout: "verified api contract"
    }
  }));

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.eventName, "command-complete");
  assert.match(result.events[0]?.summary ?? "", /completed: `npm test`/i);
});

test("parseClaudeTranscriptLine ignores absolute paths in transcript tool activity", () => {
  const assistant = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    uuid: "assistant-2",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: {
            file_path: "/Users/test/project/CLAUDE.md"
          }
        }
      ]
    }
  }));

  assert.equal(assistant.events.length, 1);
  assert.deepEqual(assistant.events[0]?.paths ?? [], []);
});

test("parseClaudeRuntimeText keeps full extensions and normalizes relative prefixes", () => {
  const events = parseClaudeRuntimeText(`
Updated ./main.go successfully
Wrote tasks.json and styles.scss
`);

  const paths = events.flatMap((event) => event.paths);
  assert.ok(paths.includes("main.go"));
  assert.ok(paths.includes("tasks.json"));
  assert.ok(paths.includes("styles.scss"));
  assert.equal(paths.includes("tasks.js"), false);
});

test("parseClaudeTranscriptLine classifies blockers from assistant text", () => {
  const parsed = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    uuid: "assistant-4",
    message: {
      content: [
        {
          type: "text",
          text: "Blocked on missing DATABASE_URL before I can run migrations."
        }
      ]
    }
  }));

  assert.equal(parsed.events[0]?.eventName, "blocker");
  assert.equal(parsed.events[0]?.semanticKind, "blocker");
  assert.match(parsed.events[0]?.summary ?? "", /Claude blocker/i);
});

test("parseCodexAssistantDeltaText classifies tool lifecycle summaries", () => {
  const events = parseCodexAssistantDeltaText(`Called exec_command to inspect apps/api/src/server.ts before patching it.`);
  assert.equal(events[0]?.eventName, "tool");
  assert.equal(events[0]?.semanticKind, "inspection");
  assert.match(events[0]?.summary ?? "", /Codex tool:/);
});

test("provider runtime classification upgrades handoff and contract semantics", () => {
  const handoff = parseCodexAssistantDeltaText(
    `Next for Claude: take the dashboard shell in apps/web and refine the intake UX after this backend scaffold lands.`
  );
  const contract = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    uuid: "assistant-5",
    message: {
      content: [
        {
          type: "text",
          text: "I need an API contract stub for the visit summary endpoint before I can finish the UI."
        }
      ]
    }
  }));

  assert.equal(handoff[0]?.semanticKind, "handoff");
  assert.equal(contract.events[0]?.semanticKind, "contract");
});
