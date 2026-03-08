import { ulid } from "ulid";
import type { DecompositionPlan, DecomposedTask, OrchestratorRunState } from "./types";
import type { AgentRecord } from "../routes/agent";
import { buildGraphFromPlan } from "./graph-builder";
import { linkRun, createItemsFromPlan } from "./workgraph-bridge";

/**
 * Build a structured prompt that instructs Claude to decompose a goal
 * into a JSON task graph.
 */
export function buildPlannerPrompt(goal: string): string {
  return `You are a task-decomposition planner. Given a high-level goal, break it down into concrete tasks that can be executed by independent AI agents.

Output ONLY a JSON object (no markdown fences, no explanation) with this exact shape:

{
  "teams": [
    { "id": "t1", "name": "Team Name" }
  ],
  "tasks": [
    {
      "id": "task1",
      "title": "Short title",
      "kind": "research|code_gen|review|test|deploy|docs|design",
      "team": "t1",
      "prompt": "Detailed instructions for the agent executing this task...",
      "depends_on": []
    },
    {
      "id": "task2",
      "title": "Another task",
      "kind": "code_gen",
      "team": "t1",
      "prompt": "Detailed instructions...",
      "depends_on": ["task1"]
    }
  ],
  "summary": "Brief summary of the decomposition"
}

Rules:
- Each task must have a unique "id" (use simple ids like task1, task2, etc.)
- "depends_on" lists task ids that must complete before this task can start
- There must be NO cycles in the dependency graph
- Group related tasks into teams
- Each task's "prompt" should be self-contained instructions an AI agent can follow
- Keep the number of tasks reasonable (2-8 for most goals)
- The "kind" field should be one of: research, code_gen, review, test, deploy, docs, design

Goal: ${goal}`;
}

/**
 * Parse the planner agent's output, extracting JSON from the stream-json output.
 * Handles both raw JSON and fenced code blocks.
 */
export function parsePlannerOutput(rawOutput: string): DecompositionPlan {
  // The agent output is stream-json format: lines of JSON objects
  // We need to extract text content from result messages
  let text = "";
  let foundStreamJson = false;

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // stream-json result message contains the final text
      if (parsed.type === "result" && parsed.result) {
        text = parsed.result;
        foundStreamJson = true;
        break;
      }
      // Content block text
      if (parsed.type === "content_block_delta" && parsed.delta?.text) {
        text += parsed.delta.text;
        foundStreamJson = true;
        continue;
      }
      // Assistant message content
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "text") text += block.text;
        }
        foundStreamJson = true;
        continue;
      }
      // Not a recognized stream-json type — treat as raw text
      if (!foundStreamJson) {
        text += trimmed + "\n";
      }
    } catch {
      // Not JSON, might be raw text
      text += trimmed + "\n";
    }
  }

  // If no text extracted, use the raw output directly
  if (!text.trim()) {
    text = rawOutput.trim();
  }

  if (!text.trim()) {
    throw new Error("Planner produced no output");
  }

  // Strip markdown fences if present
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find JSON object in the text
  const objStart = jsonStr.indexOf("{");
  const objEnd = jsonStr.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    jsonStr = jsonStr.slice(objStart, objEnd + 1);
  }

  let plan: any;
  try {
    plan = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse planner JSON: ${(e as Error).message}`);
  }

  // Validate structure
  if (!Array.isArray(plan.teams) || !Array.isArray(plan.tasks)) {
    throw new Error("Planner output missing 'teams' or 'tasks' array");
  }

  // Validate no cycles via topological sort
  validateNoCycles(plan.tasks);

  return {
    teams: plan.teams,
    tasks: plan.tasks,
    summary: plan.summary || "",
  };
}

// ---------------------------------------------------------------------------
// Plan orchestration — Phase 1 (planning) + Phase 2 (graph build)
// ---------------------------------------------------------------------------

interface SpawnAgentFn {
  (prompt: string, runId: string, nodeId: string): Promise<AgentRecord>;
}

interface WaitForAgentFn {
  (agentId: string): Promise<AgentRecord>;
}

/**
 * Run the planning phase of an orchestration: spawn a planner agent,
 * parse the output, build the DB graph, and optionally create WorkGraph items.
 *
 * Returns the state with phase="planned" — ready for execution but not yet
 * started. Call executeOrchestration() to begin execution.
 */
export async function planOrchestration(
  db: any,
  runId: string,
  goal: string,
  spawnAgentFn: SpawnAgentFn,
  waitForAgentFn: WaitForAgentFn,
  workItemId?: string,
): Promise<OrchestratorRunState> {
  const state: OrchestratorRunState = {
    run_id: runId,
    phase: "planning",
    planner_agent_id: null,
    plan: null,
    task_node_map: new Map(),
    team_id_map: new Map(),
    node_agents: new Map(),
    interval: null,
    error: null,
    created_at: new Date().toISOString(),
    result: null,
    work_item_id: workItemId,
    node_work_items: new Map(),
  };

  // Link run to WorkGraph item if provided
  if (workItemId) {
    linkRun(runId, workItemId);
  }

  // --- Phase 1: PLANNING ---
  const plannerPrompt = buildPlannerPrompt(goal);
  const plannerAgent = await spawnAgentFn(plannerPrompt, runId, "");
  state.planner_agent_id = plannerAgent.id;

  console.log(`[planner] ${runId} waiting for planner agent ${plannerAgent.id}...`);
  const finishedPlanner = await waitForAgentFn(plannerAgent.id);
  console.log(`[planner] ${runId} planner finished: status=${finishedPlanner.status} exit_code=${finishedPlanner.exit_code}`);

  if (finishedPlanner.status === "failed") {
    const stdout = finishedPlanner.output_chunks.join("");
    const stderr = (finishedPlanner as any).stderr_chunks?.join("") || "(no stderr captured)";
    console.error(`[planner] ${runId} planner FAILED`);
    console.error(`[planner] ${runId} planner stdout (last 1000 chars):\n${stdout.slice(-1000)}`);
    console.error(`[planner] ${runId} planner stderr:\n${stderr}`);
    throw new Error(
      "Planner agent failed (exit code " + finishedPlanner.exit_code + "): " + stderr.slice(0, 500)
    );
  }

  // --- Phase 2: BUILDING_GRAPH ---
  state.phase = "building_graph";
  const rawOutput = finishedPlanner.output_chunks.join("");
  console.log(`[planner] ${runId} planner output length: ${rawOutput.length} chars`);

  let plan;
  try {
    plan = parsePlannerOutput(rawOutput);
  } catch (parseErr) {
    console.error(`[planner] ${runId} failed to parse planner output:\n${rawOutput.slice(0, 2000)}`);
    throw parseErr;
  }
  state.plan = plan;

  console.log(`[planner] ${runId} plan parsed: ${plan.tasks.length} tasks, ${plan.teams.length} teams`);
  console.log(`[planner] ${runId} tasks: ${plan.tasks.map(t => `${t.id}(${t.kind})`).join(", ")}`);

  // Store planner output as a structured message
  const planMsgId = `msg_${ulid()}`;
  const planCreatedAt = new Date().toISOString();
  db.run(
    "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [planMsgId, runId, "system", state.planner_agent_id || "planner", JSON.stringify(plan), "planner_output", planCreatedAt]
  );

  const { teamIdMap, taskNodeMap } = buildGraphFromPlan(db, runId, plan);
  state.team_id_map = teamIdMap;
  state.task_node_map = taskNodeMap;
  console.log(`[planner] ${runId} graph built: ${taskNodeMap.size} nodes, ${teamIdMap.size} teams`);

  // Create WorkGraph items for each task node
  try {
    const nodeWorkItems = createItemsFromPlan(plan, taskNodeMap, runId);
    state.node_work_items = nodeWorkItems;
    console.log(`[planner] ${runId} created ${nodeWorkItems.size} WorkGraph items`);
  } catch (err) {
    console.warn(`[planner] ${runId} failed to create WorkGraph items:`, err);
    // Non-fatal: proceed without WorkGraph items
  }

  // Set phase to "planned" — ready for execution
  state.phase = "planned";
  return state;
}

/**
 * Detect cycles in the task dependency graph using DFS.
 * Throws if a cycle is found.
 */
function validateNoCycles(tasks: DecomposedTask[]): void {
  const taskIds = new Set(tasks.map((t) => t.id));
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    adj.set(task.id, task.depends_on.filter((d) => taskIds.has(d)));
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): void {
    if (inStack.has(nodeId)) {
      throw new Error(`Cycle detected in task graph involving '${nodeId}'`);
    }
    if (visited.has(nodeId)) return;

    inStack.add(nodeId);
    for (const dep of adj.get(nodeId) || []) {
      dfs(dep);
    }
    inStack.delete(nodeId);
    visited.add(nodeId);
  }

  for (const task of tasks) {
    dfs(task.id);
  }
}
