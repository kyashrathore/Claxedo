/**
 * Prompt builders for item execution — pure string functions, no DB access.
 * MCP tool names, node-kind classification, the completion contract, and the
 * task-agent prompt. (Relocated from orchestrator/prompts.ts; the planner
 * prompt stayed behind and dies with the orchestrator.)
 */

// ---------------------------------------------------------------------------
// MCP tool names
// ---------------------------------------------------------------------------

export const tool = {
  create: "workgraph_propose_create_node",
  validate: "workgraph_validate_graph",
  finish: "workgraph_propose_finish_planning",
  read: "workgraph_read_scratchpads",
  write: "workgraph_write_scratchpad",
  status: "workgraph_update_status",
  artifact: "workgraph_create_artifact",
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
  agentRunId?: string,
): string {
  return `You are a ${role}. Execute the following task. Use these MCP tools exactly by name:
- ${tool.read}
- ${tool.write}
- ${tool.status}
- ${tool.artifact}

For every MCP call, include run_id = ${runId}. For node-scoped tools other than ${tool.write}, use node_id = ${nodeId}. Use ${tool.read} to get context from upstream tasks. Use ${tool.write} to record findings and execution summaries.
${agentRunId ? `When calling ${tool.write}, include subject_type = run_node, subject_id = ${nodeId}, agent_run_id = ${agentRunId}, and kind = executor.` : `When calling ${tool.write}, include subject_type = run_node and subject_id = ${nodeId}.`}

Output vs done:
- Output is what you produced: files, code changes, artifacts, comments, reports, summaries, PRs, or other side effects.
- Done means the node's contract is satisfied and downstream work can safely continue.
- Do not mark the node completed just because you thought about the task or wrote a partial note.
- If this node covers several closely related checks, analyses, or implementation slices, you may decompose and parallelize them internally using your own harness. Keep ownership at this node boundary and return one consolidated result for this node.

${contract(kind, title)}

Task: ${title}

${nodePrompt}`;
}
