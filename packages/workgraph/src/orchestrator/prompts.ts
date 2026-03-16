/**
 * Prompt builders for the orchestrator — pure string functions, no DB access.
 *
 * All prompt templates and builder functions live here. The executor imports
 * these; nothing in this file imports from executor.ts.
 */

// ---------------------------------------------------------------------------
// MCP tool names
// ---------------------------------------------------------------------------

export const tool = {
  create: "claxedo-mcp_workgraph_create_node",
  validate: "claxedo-mcp_workgraph_validate_graph",
  finish: "claxedo-mcp_workgraph_finish_planning",
  read: "claxedo-mcp_workgraph_read_scratchpads",
  write: "claxedo-mcp_workgraph_write_scratchpad",
  status: "claxedo-mcp_workgraph_update_status",
  artifact: "claxedo-mcp_workgraph_create_artifact",
} as const;

// ---------------------------------------------------------------------------
// Node kind classification
// ---------------------------------------------------------------------------

/** Returns true for "shared output" node kinds (research, docs, design, etc.). */
export function shared(kind: string): boolean {
  return ["research", "docs", "design", "review", "synthesis"].includes(kind);
}

/** Create a filesystem-safe slug from a title. */
export function slug(text: string): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return value || "workgraph-output";
}

/** Returns true when a node should produce a durable plan/document output. */
export function plan(kind: string, title: string): boolean {
  if (shared(kind)) return true;
  return /\b(plan|design|spec|brief|summary|report|proposal)\b/i.test(title);
}

/** Build the completion contract section of a task prompt. */
export function contract(kind: string, title: string): string {
  if (plan(kind, title)) {
    const file = `.workgraph/${slug(title)}.md`;
    return [
      "Completion contract:",
      `1. Create a durable markdown deliverable in the current working directory at ${file}.`,
      "2. Put the full plan, design, report, or summary in that file.",
      `3. Call ${tool.artifact} with the final deliverable content and type 'file'.`,
      `4. Call ${tool.write} with a concise summary that includes the file path and key decisions.`,
      `5. Only after the file and artifact exist, call ${tool.status} with status 'completed'.`,
      "6. If you are blocked or cannot produce the deliverable, explain why in a scratchpad and call update_status with status 'failed'.",
    ].join("\n");
  }

  return [
    "Completion contract:",
    "1. Perform the requested work in the current working directory.",
    "2. Finish the main side effect for the node before marking it complete. Examples: code changed, tests run, PR prepared, comment posted, or data updated.",
    `3. Call ${tool.write} with a concise execution summary, including changed files, validations, and any follow-up risks.`,
    `4. If the node produced a durable deliverable worth viewing later, also call ${tool.artifact} with that output.`,
    `5. Only after the work and summary are complete, call ${tool.status} with status 'completed'.`,
    "6. If you are blocked or the work failed, write the blocker to a scratchpad and call update_status with status 'failed'.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Planner prompt
// ---------------------------------------------------------------------------

const PLANNER_PROMPT_PREFIX = `You are a technical project planner. Break the following goal into durable, user-visible tasks sized for one execution context. Do not default to tiny PR-sized microtasks. Use the provided MCP tools to build a task graph. Do not use ToolSearch for this. Call these tools exactly by name:
- ${tool.create}
- ${tool.validate}
- ${tool.finish}

For every MCP call, include the current run_id exactly as provided below. For each task, call ${tool.create} with run_id, title, kind, role, prompt, depends_on, and when needed node_type plus parent_node_id. Use node_type='mission' only for aggregate-only grouping nodes that should not run directly. Use node_type='synthesis' for consolidation nodes that merge outputs from sibling work. Available roles: architect, developer, code_reviewer, qa, pm, designer.

Planning rules:
- Prefer fewer cohesive tasks when one capable executor can decompose or parallelize the internal work with its own harness.
- Split work into separate sibling nodes only when they need separate outputs, blockers, retries, ownership, or user-visible tracking.
- Do not create broad specialist buckets like API/UI/tests/infra just for coverage. Only split that way when those are truly separate deliverables or externally defined tasks.
- For broad review, audit, research, or implementation tasks, group nearby work by subsystem, flow, or question so one node can return one consolidated result.
- When a node can internally decompose or parallelize, say that explicitly in its prompt and ask for one consolidated output for the node.

When the graph is complete, call ${tool.validate} with run_id to check for issues, then call ${tool.finish} with run_id and a summary.

Goal: `;

export interface PlannerSource {
  kind: string;
  title: string;
  content: string;
  source_path: string | null;
}

/**
 * Build the planner agent prompt.
 * @param runId  The current run ID (embedded in the prompt for the planner agent).
 * @param goal   The run goal.
 * @param source Optional source document attached to the run.
 */
export function buildPlannerPrompt(runId: string, goal: string, source?: PlannerSource | null): string {
  if (!source?.content) {
    return PLANNER_PROMPT_PREFIX + goal;
  }

  const body = source.content.slice(0, 16_000);
  return [
    PLANNER_PROMPT_PREFIX + goal,
    "",
    `Current run_id: ${runId}`,
    "",
    "Primary source context:",
    `- kind: ${source.kind}`,
    source.title ? `- title: ${source.title}` : "",
    source.source_path ? `- path: ${source.source_path}` : "",
    "",
    "Use the source below as the main brief. Preserve explicit requirements, constraints, and implied follow-up work.",
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Task agent prompt
// ---------------------------------------------------------------------------

/**
 * Build the full prompt for a task agent.
 * @param role       The agent's role (developer, qa, etc.)
 * @param runId      The current run ID.
 * @param nodeId     The node ID this agent is executing.
 * @param kind       The node kind (task, research, etc.)
 * @param title      The node title.
 * @param nodePrompt The task description from the scratchpad.
 */
export function buildTaskPrompt(
  role: string,
  runId: string,
  nodeId: string,
  kind: string,
  title: string,
  nodePrompt: string,
): string {
  return `You are a ${role}. Execute the following task. Use these MCP tools exactly by name:
- ${tool.read}
- ${tool.write}
- ${tool.status}
- ${tool.artifact}

For every MCP call, include run_id = ${runId}. For node-scoped tools, use node_id = ${nodeId}. Use ${tool.read} to get context from upstream tasks. Use ${tool.write} to record findings and execution summaries.

Output vs done:
- Output is what you produced: files, code changes, artifacts, comments, reports, summaries, PRs, or other side effects.
- Done means the node's contract is satisfied and downstream work can safely continue.
- Do not mark the node completed just because you thought about the task or wrote a partial note.
- If this node covers several closely related checks, analyses, or implementation slices, you may decompose and parallelize them internally using your own harness. Keep ownership at this node boundary and return one consolidated result for this node.

${contract(kind, title)}

Task: ${title}

${nodePrompt}`;
}
