/**
 * Execution backend abstraction — supports both OpenCode sessions and CLI subprocesses.
 *
 * Both backends are first-class. The executor calls backend.launch() and handle.await()
 * with the same code path regardless of backend.
 */

import type { TaskInfo } from "./types";
import type { AgentRecord } from "../routes/agent";
import {
  createChildSession,
  awaitSessionIdle,
  getSessionResult,
} from "./session-bridge";
import { loadRegistry } from "./acp/acp-registry";
import { AcpBackend } from "./acp/acp-backend";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface TaskHandle {
  /** Session ID or agent ID */
  id: string;
  /** Resolves when the task finishes. Returns output text. */
  await(): Promise<{ output: string; status: "completed" | "failed"; error?: string }>;
  /** Cancel the running task */
  cancel(): void;
}

export interface ExecutionBackend {
  /** Launch a task and return a handle */
  launch(
    task: TaskInfo,
    runId: string,
    nodeId: string,
    parentSessionID?: string,
  ): Promise<TaskHandle>;
}

// ---------------------------------------------------------------------------
// SessionBackend — uses OpenCode sessions
// ---------------------------------------------------------------------------

export class SessionBackend implements ExecutionBackend {
  async launch(
    task: TaskInfo,
    runId: string,
    nodeId: string,
    parentSessionID?: string,
  ): Promise<TaskHandle> {
    if (!parentSessionID) {
      throw new Error("SessionBackend requires a parentSessionID");
    }

    const sessionId = await createChildSession(parentSessionID, task, nodeId, runId);
    if (!sessionId) {
      throw new Error(`Failed to create child session for node ${nodeId}`);
    }

    let cancelled = false;

    return {
      id: sessionId,
      async await() {
        try {
          await awaitSessionIdle(sessionId);
          if (cancelled) {
            return { output: "", status: "failed", error: "Cancelled" };
          }
          const result = await getSessionResult(sessionId);
          return {
            output: result ?? "",
            status: "completed",
          };
        } catch (err) {
          return {
            output: "",
            status: "failed",
            error: (err as Error).message,
          };
        }
      },
      cancel() {
        cancelled = true;
        const serverUrl = process.env.OPENCODE_SERVER_URL;
        if (serverUrl) {
          fetch(`${serverUrl}/session/${sessionId}/cancel`, { method: "POST" }).catch(() => {});
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// SubprocessBackend — uses Claude CLI via agent.ts
// ---------------------------------------------------------------------------

interface SpawnAgentFn {
  (prompt: string, runId: string, nodeId: string): Promise<AgentRecord>;
}

interface WaitForAgentFn {
  (agentId: string): Promise<AgentRecord>;
}

interface KillAgentFn {
  (agentId: string): void;
}

export class SubprocessBackend implements ExecutionBackend {
  constructor(
    private spawnAgentFn: SpawnAgentFn,
    private waitForAgentFn: WaitForAgentFn,
    private killAgentFn?: KillAgentFn,
  ) {}

  async launch(
    task: TaskInfo,
    runId: string,
    nodeId: string,
  ): Promise<TaskHandle> {
    const agent = await this.spawnAgentFn(task.prompt, runId, nodeId);
    const waitFn = this.waitForAgentFn;
    const killFn = this.killAgentFn;

    return {
      id: agent.id,
      async await() {
        try {
          const finished = await waitFn(agent.id);
          const output = finished.output_chunks?.join("") ?? "";
          const stderr = (finished as any).stderr_chunks?.join("") ?? "";

          if (finished.status === "completed") {
            return { output, status: "completed" };
          } else {
            return {
              output,
              status: "failed",
              error: stderr || `Agent failed with exit code ${finished.exit_code}`,
            };
          }
        } catch (err) {
          return {
            output: "",
            status: "failed",
            error: (err as Error).message,
          };
        }
      },
      cancel() {
        if (killFn) {
          try {
            killFn(agent.id);
          } catch {
            // agent may have already exited
          }
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * Create the appropriate execution backend based on environment.
 * Priority: ACP agents → OpenCode sessions → Claude CLI subprocess.
 */
export function createBackend(
  spawnAgentFn: SpawnAgentFn,
  waitForAgentFn: WaitForAgentFn,
  killAgentFn?: KillAgentFn,
): ExecutionBackend {
  // Priority 1: ACP agents configured
  const registry = loadRegistry();
  if (registry && registry.entries.length > 0) {
    return new AcpBackend(registry);
  }
  // Priority 2: OpenCode sessions
  if (process.env.OPENCODE_SERVER_URL) {
    return new SessionBackend();
  }
  // Fallback: Claude CLI subprocess
  return new SubprocessBackend(spawnAgentFn, waitForAgentFn, killAgentFn);
}
