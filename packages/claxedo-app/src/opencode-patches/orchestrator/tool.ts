/**
 * Orchestrate Tool — decomposes a goal into a DAG of subtasks and executes
 * them as parallel child sessions within the OpenCode session system.
 *
 * Registered via the Claxedo server patch (see opencode-patches/server/server.ts).
 *
 * Flow:
 *   1. Planning  — spawn a child session to decompose the goal into tasks
 *   2. Review    — present DAG to user for approval/editing before execution
 *   3. Execute   — run ready tasks as child sessions, respecting dependencies
 *   4. Complete  — aggregate results, emit final metadata
 *
 * The frontend OrchestratorTool component (packages/ui/src/components/orchestrator-tool.tsx)
 * renders the DAG based on metadata streamed via ctx.metadata().
 */

import { Tool } from "@/tool/tool"
import z from "zod"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Truncate } from "@/tool/truncation"
import { OrchestratorCommand, drainCommands, registerSession, unregisterSession } from "./commands"
import {
  loadRegistry,
  resolveEntry,
  AcpEventTranslator,
  createHttpConnection,
  createStdioConnection,
} from "./acp"
import type { AcpAgentEntry } from "./acp"

const log = Log.create({ service: "orchestrator.tool" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DecomposedTask {
  id: string
  title: string
  kind: string
  team: string
  prompt: string
  depends_on: string[]
}

interface NodeState {
  id: string
  title: string
  kind: string
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled"
  sessionID?: string
  agent: string
  error?: string
  prompt?: string
  lastMessage?: string
  result?: string
}

// ---------------------------------------------------------------------------
// Plan parsing
// ---------------------------------------------------------------------------

function buildPlannerPrompt(goal: string): string {
  return `You are a task-decomposition planner. Given a high-level goal, break it down into concrete, NON-OVERLAPPING tasks that can be executed by independent AI agents.

Output ONLY a JSON object (no markdown fences, no explanation) with this shape:

{
  "tasks": [
    {
      "id": "task1",
      "title": "Short title",
      "kind": "research|code_gen|review|test|docs|design",
      "team": "build",
      "prompt": "Detailed self-contained instructions for the agent...",
      "depends_on": []
    }
  ],
  "summary": "Brief summary of the plan"
}

If you need ANY clarification before decomposing (e.g., output format, scope boundaries,
technology choices), include a "questions" array in your response:

{
  "questions": ["What output format do you want?", "Should tests be included?"],
  "tasks": [...],
  "summary": "..."
}

If no clarification is needed, omit the "questions" field entirely.

Rules:
- Each task has a unique "id" (task1, task2, etc.)
- "depends_on" lists task ids that must complete before this task starts
- No cycles in the dependency graph
- Each task "prompt" must be self-contained — the executing agent has no other context
- "kind": research, code_gen, review, test, docs, design
- "team": "build" for code/test, "explore" for research, "plan" for review/design, "general" for mixed

CRITICAL — Non-overlapping scopes:
- Each task MUST cover a DISTINCT scope. If two tasks could share the same prompt, MERGE them into one.
- Each prompt MUST specify exact files, directories, or areas the agent should work on.
- Prefer 2-4 well-scoped tasks over 5-8 overlapping ones. Fewer, better tasks are always preferred.
- Do NOT create separate tasks for "analyze X" and "analyze Y" if the same agent could handle both in one pass.

CRITICAL — Dependency context:
- Dependent tasks will automatically receive the full output from their completed dependencies as context.
- When a task depends on another, its prompt should describe what it EXPECTS from that dependency (e.g., "Using the API schema from task1, generate client code...").
- Do NOT repeat instructions that a dependency already covers — just reference what you need from it.

EXAMPLE — BAD decomposition (overlapping, vague):
  task1: "Analyze the staged changes" / task2: "Analyze the unstaged changes" / task3: "Write a summary"
  (All three tasks essentially read the same diff with nearly identical prompts)

EXAMPLE — GOOD decomposition (distinct, specific):
  task1: "Read src/auth/ and document the current authentication flow and its public API surface"
  task2: "Using the auth API surface from task1, implement OAuth2 provider in src/auth/oauth2.ts" (depends_on: ["task1"])
  task3: "Write integration tests in src/auth/__tests__/oauth2.test.ts for the new OAuth2 provider" (depends_on: ["task2"])

Goal: ${goal}`
}

function parsePlan(text: string): { tasks: DecomposedTask[]; summary: string; questions?: string[] } | null {
  let jsonStr = text.trim()

  // Strip markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  // Find JSON object boundaries
  const objStart = jsonStr.indexOf("{")
  const objEnd = jsonStr.lastIndexOf("}")
  if (objStart === -1 || objEnd === -1 || objEnd <= objStart) return null
  jsonStr = jsonStr.slice(objStart, objEnd + 1)

  let plan: any
  try {
    plan = JSON.parse(jsonStr)
  } catch {
    return null
  }

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return null

  // Validate no cycles via DFS
  const ids = new Set<string>(plan.tasks.map((t: any) => t.id))
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(id: string): boolean {
    if (inStack.has(id)) return false
    if (visited.has(id)) return true
    inStack.add(id)
    const task = plan.tasks.find((t: any) => t.id === id)
    for (const dep of task?.depends_on ?? []) {
      if (ids.has(dep) && !dfs(dep)) return false
    }
    inStack.delete(id)
    visited.add(id)
    return true
  }

  for (const task of plan.tasks) {
    if (!dfs(task.id)) return null
  }

  // Extract questions if present
  const questions: string[] | undefined =
    Array.isArray(plan.questions) && plan.questions.length > 0
      ? plan.questions.map(String)
      : undefined

  return {
    tasks: plan.tasks.map((t: any) => ({
      id: String(t.id),
      title: String(t.title || t.id),
      kind: String(t.kind || "code_gen"),
      team: resolveAgentName(String(t.team || "build")),
      prompt: String(t.prompt || ""),
      depends_on: Array.isArray(t.depends_on)
        ? t.depends_on.filter((d: string) => ids.has(d)).map(String)
        : [],
    })),
    summary: String(plan.summary || ""),
    questions,
  }
}

/** Map planner agent names to actual opencode agent names. */
function resolveAgentName(name: string): string {
  switch (name) {
    case "research":
    case "explore":
    case "ask":
      return "explore"
    case "build":
    case "code_gen":
    case "code":
    case "test":
      return "build"
    case "plan":
    case "review":
    case "design":
      return "plan"
    case "general":
      return "general"
    default:
      return "build"
  }
}

// ---------------------------------------------------------------------------
// Smart result sharing
// ---------------------------------------------------------------------------

/** Prepare a dependency result for sharing with downstream tasks. */
function prepareResultForSharing(result: string, depTitle: string): string {
  let text = result

  // Strip HTML if detected
  if (text.match(/^<|<!DOCTYPE/i)) {
    text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  }

  // Small results: inline directly
  if (text.length <= 4000) return text

  // Medium results: preview + file path hint
  if (text.length <= 50000) {
    return (
      text.slice(0, 500) +
      `\n... (${text.length} chars total, showing first 500)\n` +
      `Use Read tool with offset/limit to view specific sections if needed.`
    )
  }

  // Large results: heavy truncation
  return (
    text.slice(0, 500) +
    `\n... (${text.length} chars total — heavily truncated)\n` +
    `Only a brief preview is available. The full output was too large to pass as context.`
  )
}

// ---------------------------------------------------------------------------
// ACP execution helper
// ---------------------------------------------------------------------------

/**
 * Execute a prompt via ACP instead of an OpenCode session.
 * Handles the full ACP lifecycle: initialize → newSession → prompt.
 * Returns the same shape as extracting text from a SessionPrompt result.
 */
async function executeViaAcp(
  entry: AcpAgentEntry,
  prompt: string,
  opts: {
    onProgress: (msg: string) => void
    signal: AbortSignal
  },
): Promise<{ text: string; status: "completed" | "failed"; error?: string }> {
  const messageId = Identifier.ascending("message")
  const sessionId = `acp_${messageId}`

  const translator = new AcpEventTranslator(sessionId, messageId, (event) => {
    if (event.type !== "message.part.updated") return
    const part = event.properties.part as any
    if (part?.type === "text" && part.text) {
      opts.onProgress(part.text.length > 300 ? part.text.slice(-300) : part.text)
    } else if (part?.type === "tool" && part.state?.title) {
      opts.onProgress(`Running tool: ${part.state.title}`)
    }
  })

  const { client, cleanup } =
    entry.transport.mode === "http"
      ? createHttpConnection(entry.transport, translator)
      : createStdioConnection(entry.transport, translator)

  try {
    await client.initialize()
    const { sessionId: acpSessionId } = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    })

    const onAbort = () => {
      client.cancel({ sessionId: acpSessionId }).catch(() => {})
      cleanup().catch(() => {})
    }
    opts.signal.addEventListener("abort", onAbort)

    try {
      const response = await client.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: prompt }],
      })
      return {
        text: translator.getOutput(),
        status: response.stopReason === "error" ? "failed" : "completed",
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort)
    }
  } catch (err) {
    return {
      text: translator.getOutput(),
      status: "failed",
      error: (err as Error).message,
    }
  } finally {
    await cleanup()
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const DESCRIPTION = `Orchestrate a complex task by decomposing it into a DAG of subtasks executed as parallel child sessions.

This tool handles ALL sub-task creation and execution internally. Do NOT call the task tool alongside this tool.

Use this when the goal requires multiple coordinated steps that benefit from parallelization:
- Multi-file refactoring with interdependencies
- Feature implementation spanning frontend, backend, and tests
- Research + implementation + review workflows

The orchestrator will:
1. Plan — decompose the goal into tasks with dependencies
2. Review — present the plan for user approval before execution
3. Execute — run tasks as child sessions, respecting the dependency DAG
4. Report — stream a visual DAG of progress and return aggregated results

Do NOT use this for simple single-step tasks — use the Task tool instead.`

const parameters = z.object({
  goal: z.string().describe("High-level goal to decompose into parallel subtasks and orchestrate"),
})

export const OrchestratorTool = Tool.define("orchestrate", async () => ({
  description: DESCRIPTION,
  parameters,

  async execute(params: z.infer<typeof parameters>, ctx: Tool.Context) {
    registerSession(ctx.sessionID)
    const startTime = Date.now()
    const nodes = new Map<string, NodeState>()
    const edgeList: Array<{ source: string; target: string }> = []
    let planTasks: DecomposedTask[] = []

    let paused = false
    let cancelled = false
    const commandQueue: Array<{ type: string; payload: any }> = []

    // Load ACP registry once — null means use existing OpenCode sessions
    const acpRegistry = loadRegistry()

    async function waitIfPaused() {
      while (paused && !cancelled && !ctx.abort.aborted) {
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    // ----- helpers -----

    function emitMetadata(phase: string, summary?: string, extra?: Record<string, any>) {
      ctx.metadata({
        title: params.goal,
        metadata: {
          goal: params.goal,
          phase,
          sessionID: ctx.sessionID,
          nodes: Array.from(nodes.values()),
          edges: edgeList,
          summary,
          paused,
          canSteer: true,
          startTime,
          endTime: phase === "completed" || phase === "failed" || phase === "cancelled" ? Date.now() : undefined,
          ...extra,
        },
      })
    }

    // Validate an agent name exists at runtime, fallback to "build"
    const agentCache = new Map<string, string>()
    async function ensureAgent(name: string): Promise<string> {
      if (agentCache.has(name)) return agentCache.get(name)!
      const found = await Agent.get(name).catch(() => null)
      const resolved = found ? name : "build"
      agentCache.set(name, resolved)
      return resolved
    }

    // -------------------------------------------------------------------
    // Command subscription — listen for frontend commands
    // Uses BOTH direct store (reliable) and Bus subscription (fallback)
    // -------------------------------------------------------------------

    const unsubCommands = Bus.subscribe(OrchestratorCommand, (evt) => {
      if (evt.properties.sessionID !== ctx.sessionID) return
      log.info("Bus command received", { command: evt.properties.command, sessionID: evt.properties.sessionID })
      commandQueue.push({
        type: evt.properties.command,
        payload: evt.properties.payload,
      })
    })

    /** Drain commands from direct store into the command queue. */
    function drainDirectCommands() {
      const cmds = drainCommands(ctx.sessionID)
      for (const cmd of cmds) {
        commandQueue.push({ type: cmd.command, payload: cmd.payload })
      }
    }

    /** Drain and process pending commands. Returns true if cancelled. */
    function processCommands(phase: "review" | "executing"): boolean {
      drainDirectCommands()
      while (commandQueue.length > 0) {
        const cmd = commandQueue.shift()!
        log.info("processing command", { type: cmd.type, phase })

        switch (cmd.type) {
          case "cancel":
            cancelled = true
            return true

          case "pause":
            paused = true
            emitMetadata(phase === "executing" ? "paused" : phase)
            break

          case "resume":
            paused = false
            emitMetadata(phase)
            break

          case "edit-node": {
            const p = cmd.payload as { nodeId: string; title?: string; prompt?: string; kind?: string }
            if (p?.nodeId) {
              const node = nodes.get(p.nodeId)
              const task = planTasks.find((t) => t.id === p.nodeId)
              if (node) {
                if (p.title) { node.title = p.title; if (task) task.title = p.title }
                if (p.prompt) { node.prompt = p.prompt; if (task) task.prompt = p.prompt }
                if (p.kind) { node.kind = p.kind; if (task) task.kind = p.kind }
              }
            }
            break
          }

          case "add-node": {
            const p = cmd.payload as {
              title: string; kind: string; prompt: string;
              depends_on?: string[]; inserted_before?: string
            }
            if (p?.title && p?.prompt) {
              const newId = `task${nodes.size + 1}_added`
              const agentName = resolveAgentName(p.kind || "code_gen")
              const newNode: NodeState = {
                id: newId,
                title: p.title,
                kind: p.kind || "code_gen",
                status: (p.depends_on?.length ?? 0) > 0 ? "blocked" : "pending",
                agent: agentName,
                prompt: p.prompt,
              }
              nodes.set(newId, newNode)

              const newTask: DecomposedTask = {
                id: newId,
                title: p.title,
                kind: p.kind || "code_gen",
                team: agentName,
                prompt: p.prompt,
                depends_on: p.depends_on ?? [],
              }
              planTasks.push(newTask)

              // Add dependency edges
              for (const dep of p.depends_on ?? []) {
                edgeList.push({ source: dep, target: newId })
              }

              // If inserted_before, re-wire: new node → inserted_before
              if (p.inserted_before && nodes.has(p.inserted_before)) {
                edgeList.push({ source: newId, target: p.inserted_before })
                // Update the target task's depends_on
                const targetTask = planTasks.find((t) => t.id === p.inserted_before)
                if (targetTask && !targetTask.depends_on.includes(newId)) {
                  targetTask.depends_on.push(newId)
                }
              }

              log.info("node added", { nodeId: newId, title: p.title })
            }
            break
          }

          case "remove-node": {
            const p = cmd.payload as { nodeId: string }
            if (p?.nodeId) {
              nodes.delete(p.nodeId)
              planTasks = planTasks.filter((t) => t.id !== p.nodeId)
              // Remove edges referencing this node
              for (let i = edgeList.length - 1; i >= 0; i--) {
                if (edgeList[i].source === p.nodeId || edgeList[i].target === p.nodeId) {
                  edgeList.splice(i, 1)
                }
              }
              // Remove from depends_on in other tasks
              for (const task of planTasks) {
                task.depends_on = task.depends_on.filter((d) => d !== p.nodeId)
              }
              log.info("node removed", { nodeId: p.nodeId })
            }
            break
          }

          // Execution-phase-only commands handled by execution loop
          case "cancel-task":
          case "restart-task":
            if (phase === "executing") {
              // Re-queue — these are consumed by the execution loop
              commandQueue.unshift(cmd)
              return false
            }
            break
        }
      }
      return false
    }

    try {
      // -------------------------------------------------------------------
      // Phase 1: Planning
      // -------------------------------------------------------------------

      log.info("planning", { goal: params.goal, sessionID: ctx.sessionID })
      emitMetadata("planning")

      // Get the model from the current assistant message (same pattern as task tool)
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
      const model = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // Check if ACP is configured for planning
      const plannerAcpEntry = acpRegistry ? resolveEntry(acpRegistry, "planning") : undefined

      let plannerProgress = ""
      let lastPlannerEmit = 0

      function emitPlannerProgress() {
        const now = Date.now()
        if (now - lastPlannerEmit >= 400) {
          lastPlannerEmit = now
          emitMetadata("planning", undefined, { plannerProgress })
        }
      }

      let planTextStr: string

      if (plannerAcpEntry) {
        // ----- ACP planning — full session via ACP agent -----
        log.info("planning via ACP", { entry: plannerAcpEntry.id })

        const result = await executeViaAcp(plannerAcpEntry, buildPlannerPrompt(params.goal), {
          onProgress: (msg) => {
            plannerProgress = msg
            emitPlannerProgress()
          },
          signal: ctx.abort,
        })

        planTextStr = result.text

        if (result.status === "failed" && result.error) {
          log.error("ACP planner failed", { error: result.error })
        }
      } else {
        // ----- Existing Session.create() + SessionPrompt.prompt() -----
        const plannerSession = await Session.create({
          parentID: ctx.sessionID,
          title: `Planner: ${params.goal.slice(0, 60)}`,
        })

        emitMetadata("planning", undefined, { plannerSessionID: plannerSession.id })

        function cancelPlanner() {
          SessionPrompt.cancel(plannerSession.id)
        }
        ctx.abort.addEventListener("abort", cancelPlanner)

        const unsubPartUpdated = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
          const part = evt.properties.part
          if (part.sessionID !== plannerSession.id) return

          if (part.type === "text" && "text" in part) {
            const text = part.text as string
            plannerProgress = text.length > 500 ? text.slice(-500) : text
          } else if (part.type === "tool-invocation" && "toolName" in part) {
            const status = (part as any).status
            if (status === "running" || status === "pending") {
              plannerProgress = `Running tool: ${(part as any).toolName}`
            }
          }
          emitPlannerProgress()
        })

        const unsubPartDelta = Bus.subscribe(MessageV2.Event.PartDelta, (evt) => {
          if (evt.properties.sessionID !== plannerSession.id) return
          if (evt.properties.field === "text") {
            emitPlannerProgress()
          }
        })

        const unsubPlannerProgress = () => {
          unsubPartUpdated()
          unsubPartDelta()
        }

        let planResult: MessageV2.WithParts
        try {
          planResult = await SessionPrompt.prompt({
            messageID: Identifier.ascending("message"),
            sessionID: plannerSession.id,
            model,
            agent: await ensureAgent("general"),
            parts: [{ type: "text", text: buildPlannerPrompt(params.goal) }],
          })
        } finally {
          unsubPlannerProgress()
          ctx.abort.removeEventListener("abort", cancelPlanner)
        }

        const planText = planResult.parts.findLast((p) => p.type === "text" && "text" in p)
        planTextStr = planText && "text" in planText ? planText.text : ""
      }

      // Check for cancellation during planning
      if (processCommands("review")) {
        emitMetadata("cancelled", "Cancelled during planning")
        return { title: params.goal, metadata: { goal: params.goal, phase: "cancelled", nodes: [], edges: [], summary: "Cancelled during planning", startTime, endTime: Date.now() }, output: "Orchestration cancelled during planning." }
      }
      const plan = parsePlan(planTextStr)

      if (!plan || plan.tasks.length === 0) {
        emitMetadata("failed", "Planning produced no tasks")
        return {
          title: params.goal,
          metadata: { goal: params.goal, phase: "failed", nodes: [], edges: [], summary: "Planning produced no tasks", startTime, endTime: Date.now() },
          output: "Orchestration failed: the planner did not produce a valid task decomposition.\n\nPlanner output:\n" + planTextStr,
        }
      }

      log.info("plan ready", { tasks: plan.tasks.length, summary: plan.summary, questions: plan.questions?.length ?? 0 })

      // -------------------------------------------------------------------
      // Phase 2: Initialize DAG + Enter Review Phase
      // -------------------------------------------------------------------

      planTasks = plan.tasks

      for (const task of planTasks) {
        const hasDeps = task.depends_on.length > 0
        nodes.set(task.id, {
          id: task.id,
          title: task.title,
          kind: task.kind,
          status: hasDeps ? "blocked" : "pending",
          agent: task.team,
          prompt: task.prompt,
        })
        for (const dep of task.depends_on) {
          edgeList.push({ source: dep, target: task.id })
        }
      }

      // Enter review phase — emit DAG with prompts, questions, and wait for approval
      emitMetadata("review", plan.summary, {
        questions: plan.questions,
      })

      log.info("entering review phase", { sessionID: ctx.sessionID })

      // -------------------------------------------------------------------
      // Phase 2b: Review loop — wait for approval or edits
      // -------------------------------------------------------------------

      let approved = false
      while (!approved && !cancelled && !ctx.abort.aborted) {
        await new Promise((r) => setTimeout(r, 300))

        drainDirectCommands()
        while (commandQueue.length > 0) {
          const cmd = commandQueue.shift()!
          log.info("review command", { type: cmd.type })

          switch (cmd.type) {
            case "approve":
              approved = true
              break

            case "cancel":
              cancelled = true
              break

            case "edit-node":
            case "add-node":
            case "remove-node":
              // Re-queue and process via processCommands
              commandQueue.unshift(cmd)
              processCommands("review")
              // Re-emit updated metadata
              emitMetadata("review", plan.summary, { questions: plan.questions })
              break

            case "pause":
            case "resume":
              // Handled in processCommands
              commandQueue.unshift(cmd)
              processCommands("review")
              break
          }
        }
      }

      if (cancelled || ctx.abort.aborted) {
        emitMetadata("cancelled", "Cancelled during review")
        return {
          title: params.goal,
          metadata: { goal: params.goal, phase: "cancelled", nodes: Array.from(nodes.values()), edges: edgeList, summary: "Cancelled during review", startTime, endTime: Date.now() },
          output: "Orchestration cancelled during review phase.",
        }
      }

      log.info("review approved, starting execution", { tasks: planTasks.length })

      // -------------------------------------------------------------------
      // Phase 3: Execute DAG
      // -------------------------------------------------------------------

      emitMetadata("executing", `0/${planTasks.length} tasks completed`)

      const completed = new Set<string>()
      const failed = new Set<string>()
      const running = new Set<string>()
      const taskResults = new Map<string, string>()
      const taskCancellers = new Map<string, () => void>()

      function isReady(task: DecomposedTask): boolean {
        return task.depends_on.every((d) => completed.has(d))
      }

      /** Build a prompt that includes results from completed dependencies. */
      function buildTaskPromptWithContext(task: DecomposedTask): string {
        const depContexts: string[] = []
        for (const depId of task.depends_on) {
          const depResult = taskResults.get(depId)
          if (!depResult) continue
          const depNode = nodes.get(depId)
          const depTitle = depNode?.title ?? depId
          const prepared = prepareResultForSharing(depResult, depTitle)
          depContexts.push(`### ${depTitle}\n${prepared}`)
        }
        if (depContexts.length === 0) return task.prompt
        return `## Context from completed dependencies\n${depContexts.join("\n---\n")}\n\n---\n\n## Your task\n${task.prompt}`
      }

      function summaryLine(): string {
        const parts: string[] = [`${completed.size}/${planTasks.length} completed`]
        if (running.size) parts.push(`${running.size} running`)
        if (failed.size) parts.push(`${failed.size} failed`)
        return parts.join(" \u00B7 ")
      }

      function updateBlockedStatus() {
        for (const task of planTasks) {
          const node = nodes.get(task.id)
          if (!node) continue
          if (node.status === "blocked" && isReady(task)) {
            node.status = "pending"
          }
        }
      }

      /** Process execution-phase commands (cancel-task, restart-task). */
      function processExecCommands(): boolean {
        drainDirectCommands()
        while (commandQueue.length > 0) {
          const cmd = commandQueue[0]

          switch (cmd.type) {
            case "cancel":
              commandQueue.shift()
              cancelled = true
              // Cancel all running tasks
              for (const cancel of taskCancellers.values()) cancel()
              return true

            case "pause":
              commandQueue.shift()
              paused = true
              emitMetadata("paused", summaryLine())
              break

            case "resume":
              commandQueue.shift()
              paused = false
              emitMetadata("executing", summaryLine())
              break

            case "cancel-task": {
              commandQueue.shift()
              const p = cmd.payload as { taskId: string }
              if (p?.taskId && running.has(p.taskId)) {
                const cancel = taskCancellers.get(p.taskId)
                if (cancel) cancel()
                const node = nodes.get(p.taskId)
                if (node) {
                  node.status = "cancelled"
                  node.error = "Cancelled by user"
                }
                running.delete(p.taskId)
                failed.add(p.taskId)
                taskCancellers.delete(p.taskId)
                emitMetadata("executing", summaryLine())
              }
              break
            }

            case "restart-task": {
              commandQueue.shift()
              const p = cmd.payload as { taskId: string }
              if (p?.taskId && failed.has(p.taskId)) {
                const node = nodes.get(p.taskId)
                if (node) {
                  node.status = "pending"
                  node.error = undefined
                  node.lastMessage = undefined
                  node.result = undefined
                  node.sessionID = undefined
                }
                failed.delete(p.taskId)
                taskResults.delete(p.taskId)
                emitMetadata("executing", summaryLine())
                log.info("task restarted", { taskId: p.taskId })
              }
              break
            }

            default:
              // Unknown command in exec phase, skip
              commandQueue.shift()
              break
          }
        }
        return false
      }

      while (completed.size + failed.size < planTasks.length) {
        if (ctx.abort.aborted || cancelled) break
        await waitIfPaused()
        if (cancelled) break

        // Process any pending commands
        if (processExecCommands()) break

        updateBlockedStatus()

        // Tasks that are ready and not yet started
        const ready = planTasks.filter(
          (t) =>
            !completed.has(t.id) && !failed.has(t.id) && !running.has(t.id) &&
            nodes.get(t.id)?.status !== "cancelled" &&
            isReady(t),
        )

        if (ready.length === 0 && running.size === 0) {
          // Deadlock — remaining tasks depend on failed tasks
          for (const task of planTasks) {
            const node = nodes.get(task.id)
            if (!node) continue
            if (node.status === "blocked" || node.status === "pending") {
              node.status = "failed"
              node.error = "Blocked by failed dependency"
              failed.add(task.id)
            }
          }
          break
        }

        if (ready.length === 0) {
          // Nothing new to start; wait for running tasks
          await new Promise((r) => setTimeout(r, 500))
          continue
        }

        // Launch ready tasks in parallel
        const executions = ready.map(async (task) => {
          const node = nodes.get(task.id)!
          const agentName = await ensureAgent(task.team)

          running.add(task.id)
          node.status = "running"
          node.agent = agentName
          emitMetadata("executing", summaryLine())

          // Check if ACP is configured for this task kind
          const taskAcpEntry = acpRegistry ? resolveEntry(acpRegistry, task.kind) : undefined

          if (taskAcpEntry) {
            // ----- ACP execution — no OpenCode session, direct ACP lifecycle -----
            log.info("executing task via ACP", { taskId: task.id, entry: taskAcpEntry.id })

            // Per-task AbortController so cancel-task command can cancel individual ACP tasks
            const taskAbort = new AbortController()
            const cancelOnGlobal = () => taskAbort.abort()
            ctx.abort.addEventListener("abort", cancelOnGlobal)
            taskCancellers.set(task.id, () => taskAbort.abort())

            let lastProgressEmit = 0
            try {
              const result = await executeViaAcp(taskAcpEntry, buildTaskPromptWithContext(task), {
                onProgress: (msg) => {
                  node.lastMessage = msg
                  const now = Date.now()
                  if (now - lastProgressEmit >= 500) {
                    lastProgressEmit = now
                    emitMetadata("executing", summaryLine())
                  }
                },
                signal: taskAbort.signal,
              })

              if (result.status === "completed") {
                node.status = "completed"
                completed.add(task.id)
                taskResults.set(task.id, result.text)
                node.result = result.text
                node.lastMessage = result.text.length > 200 ? result.text.slice(0, 200) + "..." : result.text
                log.info("task completed via ACP", { taskId: task.id, title: task.title })
              } else {
                node.status = "failed"
                node.error = result.error ?? "ACP execution failed"
                failed.add(task.id)
                log.error("task failed via ACP", { taskId: task.id, error: node.error })
              }
            } catch (err: any) {
              if (node.status === "cancelled") {
                // Already marked cancelled by command handler
              } else {
                node.status = "failed"
                node.error = err?.message ?? String(err)
                failed.add(task.id)
                log.error("task failed via ACP", { taskId: task.id, error: node.error })
              }
            } finally {
              running.delete(task.id)
              taskCancellers.delete(task.id)
              ctx.abort.removeEventListener("abort", cancelOnGlobal)
              emitMetadata("executing", summaryLine())
            }
          } else {
            // ----- Existing Session.create() + SessionPrompt.prompt() -----
            const session = await Session.create({
              parentID: ctx.sessionID,
              title: `${task.title} (@${agentName})`,
            })
            node.sessionID = session.id
            emitMetadata("executing", summaryLine())

            let lastProgressEmit = 0
            const unsubProgress = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
              const part = evt.properties.part
              if (part.sessionID !== session.id) return

              if (part.type === "text" && "text" in part) {
                const text = part.text as string
                node.lastMessage = text.length > 300 ? text.slice(-300) : text
              } else if (part.type === "tool-invocation" && "toolName" in part) {
                const status = (part as any).status
                if (status === "running" || status === "pending") {
                  node.lastMessage = `Running tool: ${(part as any).toolName}`
                }
              }

              const now = Date.now()
              if (now - lastProgressEmit >= 500) {
                lastProgressEmit = now
                emitMetadata("executing", summaryLine())
              }
            })

            function cancelTask() {
              SessionPrompt.cancel(session.id)
            }
            ctx.abort.addEventListener("abort", cancelTask)
            taskCancellers.set(task.id, cancelTask)

            try {
              const result = await SessionPrompt.prompt({
                messageID: Identifier.ascending("message"),
                sessionID: session.id,
                model,
                agent: agentName,
                parts: [{ type: "text", text: buildTaskPromptWithContext(task) }],
              })

              const textPart = result.parts.findLast((p) => p.type === "text" && "text" in p)
              const text = textPart && "text" in textPart ? textPart.text : ""

              node.status = "completed"
              completed.add(task.id)
              taskResults.set(task.id, text)
              node.result = text
              node.lastMessage = text.length > 200 ? text.slice(0, 200) + "..." : text
              log.info("task completed", { taskId: task.id, title: task.title })
            } catch (err: any) {
              if (node.status === "cancelled") {
                // Already marked cancelled by command handler
              } else {
                node.status = "failed"
                node.error = err?.message ?? String(err)
                failed.add(task.id)
                log.error("task failed", { taskId: task.id, error: node.error })
              }
            } finally {
              unsubProgress()
              running.delete(task.id)
              taskCancellers.delete(task.id)
              ctx.abort.removeEventListener("abort", cancelTask)
              emitMetadata("executing", summaryLine())
            }
          }
        })

        // Poll for commands while tasks execute — without this,
        // pause/cancel commands are only processed between batches.
        const settled = Promise.allSettled(executions)
        let done = false
        settled.then(() => { done = true })
        while (!done && !cancelled && !ctx.abort.aborted) {
          if (processExecCommands()) break
          await waitIfPaused()
          await Promise.race([settled, new Promise((r) => setTimeout(r, 300))])
        }
        await settled
      }

      // -------------------------------------------------------------------
      // Phase 4: Final result
      // -------------------------------------------------------------------

      const phase = cancelled ? "cancelled" : failed.size > 0 ? "failed" : "completed"
      const finalSummary = cancelled
        ? `Cancelled \u00B7 ${completed.size}/${planTasks.length} completed`
        : failed.size > 0
          ? `${completed.size}/${planTasks.length} completed \u00B7 ${failed.size} failed`
          : `All ${planTasks.length} tasks completed`

      emitMetadata(phase, finalSummary)

      const outputParts = planTasks.map((t) => {
        const node = nodes.get(t.id)
        if (!node) return `## \u2014 ${t.title}\n\nRemoved during review`
        const mark =
          node.status === "completed" ? "\u2713" :
          node.status === "failed" ? "\u2717" :
          node.status === "cancelled" ? "\u2298" :
          "\u2014"
        const result = taskResults.get(t.id)
        const body = result
          ? result.length > 2000
            ? result.slice(0, 2000) + "\n... (truncated)"
            : result
          : node.error || "No output"
        return `## ${mark} ${t.title}\n\n${body}`
      })

      return {
        title: params.goal,
        metadata: {
          goal: params.goal,
          phase,
          nodes: Array.from(nodes.values()),
          edges: edgeList,
          summary: finalSummary,
          startTime,
          endTime: Date.now(),
        },
        output: [
          "<orchestration_result>",
          `Plan: ${plan.summary}`,
          `Result: ${finalSummary}`,
          "",
          ...outputParts,
          "</orchestration_result>",
        ].join("\n"),
      }
    } finally {
      unsubCommands()
      unregisterSession(ctx.sessionID)
    }
  },
}))
