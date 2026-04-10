import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SessionRuntime } from "./types.ts";

type JsonRpcId = number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface TurnCompletion {
  threadId: string;
  turn: {
    id: string;
    status: string;
    error: {
      message?: string | null;
      additionalDetails?: string | null;
    } | null;
  };
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  assistantMessage: string;
  turnStatus: string;
  stderr: string;
}

interface CodexAppServerClientOptions {
  onAssistantDelta?: (delta: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
}

export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "--listen", "stdio://"];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeNotificationParams(params: Record<string, unknown>): string {
  const candidates = [
    asString(params.message),
    asString(params.detail),
    asString(params.code),
    asString(params.error)
  ].filter((value): value is string => Boolean(value?.trim()));

  if (candidates.length > 0) {
    return candidates.join(" | ");
  }

  const serialized = JSON.stringify(params);
  return serialized === "{}" ? "" : serialized;
}

function formatRpcError(method: string, error: unknown): Error {
  const errorObject = asObject(error);
  const message = asString(errorObject.message);
  return new Error(message ? `${method} failed: ${message}` : `${method} failed.`);
}

function buildTurnError(completion: TurnCompletion): Error {
  const message = completion.turn.error?.message ?? `Codex turn ${completion.turn.id} failed.`;
  const details = completion.turn.error?.additionalDetails?.trim();
  return new Error(details ? `${message}\n${details}` : message);
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly bufferedMessages = new Map<string, string>();
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnResolvers = new Map<
    string,
    {
      resolve: (value: TurnCompletion) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private readonly onRequest: (
    request: Required<Pick<JsonRpcMessage, "id" | "method">> & { params: Record<string, unknown> }
  ) => Promise<unknown>;
  private readonly onAssistantDelta?: (delta: string) => void;
  private readonly onStderrChunk?: (chunk: string) => void;
  private readonly onNotification?: (method: string, params: Record<string, unknown>) => void;
  private nextId = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    runtime: SessionRuntime,
    cwd: string,
    onRequest: (
      request: Required<Pick<JsonRpcMessage, "id" | "method">> & { params: Record<string, unknown> }
    ) => Promise<unknown>,
    options: CodexAppServerClientOptions = {}
  ) {
    this.onRequest = onRequest;
    this.onAssistantDelta = options.onAssistantDelta;
    this.onStderrChunk = options.onStderrChunk;
    this.onNotification = options.onNotification;
    this.child = spawn(
      runtime.codexExecutable,
      buildCodexAppServerArgs(),
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.handleStdout(chunk);
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      this.onStderrChunk?.(chunk);
    });
    this.child.on("error", (error) => {
      this.rejectAll(error);
    });
    this.child.on("close", (code, signal) => {
      if (!this.closed) {
        this.closed = true;
      }

      const suffix = this.stderrBuffer.trim();
      const reason = new Error(
        `Codex app-server exited before the turn completed (code=${code ?? "null"}, signal=${signal ?? "null"})${suffix ? `\n${suffix}` : ""}`
      );
      this.rejectAll(reason);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "kavi",
        title: "Kavi",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  async startThread(params: Record<string, unknown>): Promise<string> {
    const response = asObject(await this.request("thread/start", params));
    const thread = asObject(response.thread);
    const threadId = asString(thread.id);
    if (!threadId) {
      throw new Error("Codex thread/start did not return a thread id.");
    }

    return threadId;
  }

  async resumeThread(params: Record<string, unknown>): Promise<string> {
    const response = asObject(await this.request("thread/resume", params));
    const thread = asObject(response.thread);
    const threadId = asString(thread.id);
    if (!threadId) {
      throw new Error("Codex thread/resume did not return a thread id.");
    }

    return threadId;
  }

  async runTurn(params: Record<string, unknown>): Promise<CodexTurnResult> {
    const response = asObject(await this.request("turn/start", params));
    const turn = asObject(response.turn);
    const turnId = asString(turn.id);
    if (!turnId) {
      throw new Error("Codex turn/start did not return a turn id.");
    }

    const threadId = asString(params.threadId);
    if (!threadId) {
      throw new Error("Codex turn/start requires a thread id.");
    }

    const initialStatus = asString(turn.status);
    if (initialStatus === "completed") {
      return {
        threadId,
        turnId,
        assistantMessage: this.bufferedMessages.get(turnId) ?? "",
        turnStatus: initialStatus,
        stderr: this.stderrBuffer.trim()
      };
    }

    if (initialStatus === "failed" || initialStatus === "interrupted") {
      throw buildTurnError({
        threadId,
        turn: {
          id: turnId,
          status: initialStatus,
          error: asObject(turn.error)
        }
      });
    }

    const completion =
      this.completedTurns.get(turnId) ??
      (await new Promise<TurnCompletion>((resolve, reject) => {
        this.turnResolvers.set(turnId, { resolve, reject });
      }));

    const turnStatus = completion.turn.status;
    if (turnStatus !== "completed") {
      throw buildTurnError(completion);
    }

    return {
      threadId,
      turnId,
      assistantMessage: this.bufferedMessages.get(turnId) ?? "",
      turnStatus,
      stderr: this.stderrBuffer.trim()
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    this.closePromise = new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }

      this.closed = true;
      const timeout = setTimeout(() => {
        this.child.kill("SIGTERM");
      }, 1_000);

      this.child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.child.stdin.end();
    });

    await this.closePromise;
  }

  abort(reason: Error): void {
    this.rejectAll(reason);
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.child.kill("SIGTERM");
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const payload = {
      id,
      method,
      params
    };

    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        this.rejectAll(
          new Error(
            `Failed to parse Codex app-server output: ${error instanceof Error ? error.message : String(error)}\n${line}`
          )
        );
        return;
      }

      if (typeof message.id === "number" && typeof message.method === "string") {
        void this.handleServerRequest({
          id: message.id,
          method: message.method,
          params: asObject(message.params)
        });
        continue;
      }

      if (typeof message.id === "number") {
        this.handleResponse(message);
        continue;
      }

      if (typeof message.method === "string") {
        this.handleNotification(message.method, asObject(message.params));
      }
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id as JsonRpcId);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id as JsonRpcId);
    if (message.error) {
      pending.reject(formatRpcError(pending.method, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    this.onNotification?.(method, params);

    if (method === "item/agentMessage/delta") {
      const turnId = asString(params.turnId);
      const delta = asString(params.delta);
      if (turnId && delta) {
        this.bufferedMessages.set(turnId, `${this.bufferedMessages.get(turnId) ?? ""}${delta}`);
        this.onAssistantDelta?.(delta);
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = asObject(params.turn);
      const turnId = asString(turn.id);
      const threadId = asString(params.threadId);
      const status = asString(turn.status);
      if (!turnId || !threadId || !status) {
        return;
      }

      const completion: TurnCompletion = {
        threadId,
        turn: {
          id: turnId,
          status,
          error: asObject(turn.error)
        }
      };
      this.completedTurns.set(turnId, completion);
      const resolver = this.turnResolvers.get(turnId);
      if (resolver) {
        this.turnResolvers.delete(turnId);
        resolver.resolve(completion);
      }
      return;
    }

    if (method === "error") {
      const summary = summarizeNotificationParams(params);
      this.rejectAll(
        new Error(summary ? `Codex app-server returned an error notification.\n${summary}` : "Codex app-server returned an error notification.")
      );
    }
  }

  private async handleServerRequest(
    request: Required<Pick<JsonRpcMessage, "id" | "method">> & { params: Record<string, unknown> }
  ): Promise<void> {
    try {
      const result = await this.onRequest(request);
      this.child.stdin.write(
        `${JSON.stringify({
          id: request.id,
          result
        })}\n`
      );
    } catch (error) {
      this.child.stdin.write(
        `${JSON.stringify({
          id: request.id,
          error: {
            message: error instanceof Error ? error.message : String(error)
          }
        })}\n`
      );
    }
  }

  private rejectAll(error: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.reject(error);
    }

    const turnResolvers = [...this.turnResolvers.values()];
    this.turnResolvers.clear();
    for (const turn of turnResolvers) {
      turn.reject(error);
    }
  }
}
