/**
 * MockAgent — a deterministic SpawnAgentFn for testing the orchestrator.
 *
 * Matches each spawned node against a list of scripts (by kind/role/title).
 * For matched nodes it fires the configured MCP tool calls and drives the
 * executor through to completion without needing real AI agents.
 *
 * Usage:
 *   const db = new FakeDb(runId);
 *   const agent = new MockAgent(db.sqlite, db, eventStore);
 *   agent.addScript({ match: { kind: "code_gen" }, tools: [...], status: "completed" });
 *   const spawnFn = agent.spawnFn();
 *   await startOrchestration(db, runId, "goal", spawnFn);
 */

import { handleToolCall } from "../../src/mcp/tools";
import { openSqlitePlannerStore } from "../../src/sdk/planner";
import {
  onNodeStatusUpdate,
  onPlanningComplete,
  type SpawnAgentFn,
} from "../../src/orchestrator/executor";
import type { IExecutionStore } from "../../src/sdk/execution-store";
import type { IEventStore } from "../../src/orchestrator/core/services/event-store";

export interface ScriptTool {
  name: string;
  args: Record<string, unknown>;
}

export interface Script {
  /** Match criteria — all specified fields must match (substring for title) */
  match: {
    kind?: string;
    role?: string;
    /** substring match on title */
    title?: string;
    /** true to match the planner (nodeId === "") */
    planner?: boolean;
  };
  /** MCP tool calls to fire before updating status */
  tools?: ScriptTool[];
  /** Node status to set after tools run. Defaults to "completed" */
  status?: "completed" | "failed";
  /** Token count to attribute to this agent (for future metrics use) */
  tokens?: number;
  /** Delay before completing, in ms. Default 0 */
  delayMs?: number;
  /** If true, this script is removed after the first time it matches */
  once?: boolean;
  /**
   * For planner scripts: nodes to create via create_node, plus an optional
   * depends_on chain between them (in listed order).
   */
  planNodes?: Array<{
    title: string;
    kind: string;
    role?: string;
    prompt?: string;
    depends_on?: string[];
  }>;
}

let _agentSeq = 0;

function nextAgentId() {
  return `mock_agent_${++_agentSeq}`;
}

function matchesScript(
  script: Script,
  nodeId: string,
  meta: { kind?: string; role?: string; title?: string },
): boolean {
  const m = script.match;
  if (m.planner !== undefined) {
    if (m.planner !== (nodeId === "")) return false;
  }
  if (m.kind !== undefined && meta.kind !== m.kind) return false;
  if (m.role !== undefined && meta.role !== m.role) return false;
  if (m.title !== undefined) {
    if (!(meta.title ?? "").toLowerCase().includes(m.title.toLowerCase())) return false;
  }
  return true;
}

export class MockAgent {
  private sqliteDb: any;
  private executionStore: IExecutionStore;
  private eventStore: IEventStore;
  private scripts: Script[] = [];
  private _spawnFn: SpawnAgentFn | null = null;

  /**
   * @param sqliteDb  Raw bun:sqlite Database (for planner SQL operations)
   * @param executionStore  IExecutionStore (for orchestrator callbacks)
   * @param eventStore  IEventStore (for event emission in planner tools)
   */
  constructor(sqliteDb: any, executionStore: IExecutionStore, eventStore: IEventStore, scripts?: Script[]) {
    this.sqliteDb = sqliteDb;
    this.executionStore = executionStore;
    this.eventStore = eventStore;
    if (scripts) this.scripts = scripts;
  }

  addScript(script: Script): this {
    this.scripts.push(script);
    return this;
  }

  /**
   * Returns a SpawnAgentFn. The returned function is stable — calling spawnFn()
   * multiple times returns the same function (needed for recursive spawn calls).
   */
  spawnFn(): SpawnAgentFn {
    if (!this._spawnFn) {
      this._spawnFn = this._makeSpawnFn();
    }
    return this._spawnFn;
  }

  private _makeSpawnFn(): SpawnAgentFn {
    const self = this;

    const fn: SpawnAgentFn = async (
      prompt: string,
      runId: string,
      nodeId: string,
      meta?: { role?: string; kind?: string; title?: string; directory?: string },
    ) => {
      const agentId = nextAgentId();
      const agentDir = meta?.directory ?? `/tmp/mock/${agentId}`;

      // Find matching script (first match wins); remove it if once: true
      const idx = self.scripts.findIndex((s) =>
        matchesScript(s, nodeId, {
          kind: meta?.kind,
          role: meta?.role,
          title: meta?.title,
        }),
      );
      const script = idx >= 0 ? self.scripts[idx] : undefined;
      if (script?.once) self.scripts.splice(idx, 1);

      // Schedule async execution (fire and forget, just like real agents)
      const delay = script?.delayMs ?? 0;
      setTimeout(async () => {
        try {
          await self._executeScript(runId, nodeId, script, fn);
        } catch (err) {
          console.error(`[MockAgent] error executing script for node ${nodeId}:`, err);
        }
      }, delay);

      return {
        id: agentId,
        session_id: agentId,
        runtime_type: "workspace",
        directory: agentDir,
        worktree_path: agentDir,
        status: "running",
      };
    };

    return fn;
  }

  private async _executeScript(
    runId: string,
    nodeId: string,
    script: Script | undefined,
    spawnFn: SpawnAgentFn,
  ): Promise<void> {
    const db = this.sqliteDb;
    const eventStore = this.eventStore;

    // Planner node (nodeId === "")
    if (nodeId === "") {
      await this._executePlannerScript(runId, script, spawnFn);
      return;
    }

    // Task node
    const ctx = { plannerStore: openSqlitePlannerStore(db), eventStore, runId, nodeId };

    // Fire any configured tool calls
    if (script?.tools) {
      for (const tool of script.tools) {
        await handleToolCall(ctx, tool.name, { node_id: nodeId, ...tool.args });
      }
    }

    // Write a default scratchpad if no write_scratchpad in tools
    const hasWrite = script?.tools?.some((t) => t.name === "write_scratchpad");
    if (!hasWrite) {
      await handleToolCall(ctx, "write_scratchpad", {
        node_id: nodeId,
        content: `MockAgent: completed node ${nodeId}`,
      });
    }

    const status = script?.status ?? "completed";
    await onNodeStatusUpdate(this.executionStore, runId, nodeId, status, spawnFn);
  }

  private async _executePlannerScript(
    runId: string,
    script: Script | undefined,
    spawnFn: SpawnAgentFn,
  ): Promise<void> {
    const db = this.sqliteDb;
    const eventStore = this.eventStore;
    const ctx = { plannerStore: openSqlitePlannerStore(db), eventStore, runId };

    if (script?.planNodes && script.planNodes.length > 0) {
      // Create the specified nodes
      const nodeIds: string[] = [];
      for (const nodeSpec of script.planNodes) {
        const result = await handleToolCall(ctx, "create_node", {
          title: nodeSpec.title,
          kind: nodeSpec.kind,
          role: nodeSpec.role ?? "developer",
          prompt: nodeSpec.prompt ?? `Execute: ${nodeSpec.title}`,
          depends_on: nodeSpec.depends_on ?? [],
        });
        nodeIds.push(result.node_id);
      }
      await onPlanningComplete(this.executionStore, runId, "MockAgent plan complete", spawnFn);
    } else if (script?.tools) {
      // Fire arbitrary tools (e.g. create_node calls)
      for (const tool of script.tools) {
        await handleToolCall(ctx, tool.name, tool.args);
      }
      await onPlanningComplete(this.executionStore, runId, "MockAgent plan complete", spawnFn);
    } else {
      // Default: no nodes, complete immediately
      await onPlanningComplete(this.executionStore, runId, "MockAgent: no nodes", spawnFn);
    }
  }
}

/**
 * Create a simple MockAgent that completes all task nodes successfully
 * and uses the provided planNodes for the planning phase.
 */
export function createSimpleMockAgent(
  sqliteDb: any,
  executionStore: IExecutionStore,
  eventStore: IEventStore,
  planNodes: Script["planNodes"] = [],
): MockAgent {
  const agent = new MockAgent(sqliteDb, executionStore, eventStore);
  // Planner script
  agent.addScript({
    match: { planner: true },
    planNodes,
  });
  // Default task script: complete everything
  agent.addScript({
    match: {},
    status: "completed",
  });
  return agent;
}
