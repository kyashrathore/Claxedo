/**
 * Workspaces and the compute behind them.
 *
 * Every tool here is served to a person's credential only, and the three that
 * destroy or rewind compute are annotated destructive so a host prompts, are
 * confirmed through elicitation where the host offers it, and send
 * `approved: true` only because the registry got that confirmation — never
 * because a model put it in an argument.
 */
import { z } from "zod"
import { workspaceRuntimeClientError } from "@claxedo/workspace-runtime/client"
import { record, text } from "../json"
import type { ClaxedoFetch, WorkspaceSummary } from "../client/contract"
import type { McpToolContext } from "../context"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { toolJson, toolText } from "./target"

const WORKSPACE_ARG = { workspace: z.string().trim().min(1).describe("Workspace id.") } as const

const LIFECYCLE_OPERATIONS = ["stop", "replace", "cleanup", "destroy"] as const

export function registerWorkspaceTools(registry: ToolRegistrar) {
  registry.tool(
    "workspaces_list",
    {
      description: "List every workspace the account can see: the cloud ones and the machines enrolled to it, with whether each machine is reachable.",
      inputSchema: {},
      access: declaredToolAccess({ audiences: ["user"], write: false, scope: "read" }),
    },
    async (_args, ctx) => {
      const workspaces = await ctx.client.workspaces()
      if (workspaces.length === 0) return toolText("This account can see no workspaces.")
      return toolText(workspaces.map(renderWorkspace).join("\n"))
    },
  )

  registry.tool(
    "workspace_status",
    {
      description:
        "Inspect one workspace's compute: its sandbox and epoch, the provider's capabilities, the runtime image it is running, its latest checkpoint, any restore in progress, and its registered worktrees.",
      inputSchema: { ...WORKSPACE_ARG },
      access: declaredToolAccess({ audiences: ["user"], write: false, scope: "read" }),
    },
    async (args, ctx) => toolJson(await controlPlaneJson(ctx, "workspace.status", checkpointsPath(args.workspace))),
  )

  registry.tool(
    "workspace_checkpoint",
    {
      description:
        "Freeze writes, drain or interrupt the work in flight, flush durable state, scrub runtime credentials, and capture a provider checkpoint of one workspace.",
      inputSchema: {
        ...WORKSPACE_ARG,
        policy: z.enum(["drain", "interrupt"]).optional().describe("drain waits for the turns in flight; interrupt aborts them first. Defaults to drain."),
      },
      access: declaredToolAccess({ audiences: ["user"], write: true, scope: "admin" }),
    },
    async (args, ctx) =>
      toolJson(
        await controlPlaneJson(ctx, "workspace.checkpoint", checkpointsPath(args.workspace), {
          method: "POST",
          body: { policy: args.policy ?? "drain" },
        }),
      ),
  )

  registry.tool(
    "workspace_restore",
    {
      description: "Restore a workspace from a checkpoint, replacing whatever its sandbox holds now. This cannot be undone.",
      inputSchema: {
        ...WORKSPACE_ARG,
        checkpoint: z.string().trim().min(1).optional().describe("Checkpoint id. Defaults to the workspace's latest."),
      },
      access: declaredToolAccess({ audiences: ["user"], write: true, scope: "admin", destructive: true }),
    },
    async (args, ctx) => {
      const checkpointId = args.checkpoint ?? (await latestCheckpoint(ctx, args.workspace))
      if (!checkpointId) return toolText(`Workspace ${args.workspace} has no checkpoint to restore.`)
      return toolJson(
        await controlPlaneJson(ctx, "workspace.restore", `${checkpointsPath(args.workspace)}/${encodeURIComponent(checkpointId)}/restore`, {
          method: "POST",
          // The route refuses an unapproved restore with 409. The registry has
          // already confirmed this call with the host, so the approval states
          // what happened rather than repeating an argument the model chose.
          body: { approved: true },
        }),
      )
    },
  )

  registry.tool(
    "workspace_lifecycle",
    {
      description:
        "Stop a workspace's compute, replace it, force it to be cleaned up, or destroy it. Everything but stop discards the running sandbox.",
      inputSchema: {
        ...WORKSPACE_ARG,
        operation: z.enum(LIFECYCLE_OPERATIONS).describe("stop pauses compute; replace rebuilds it; cleanup forces a stuck workspace down; destroy removes it."),
        checkpoint: z.string().trim().min(1).optional().describe("Checkpoint to replace from. Defaults to the workspace's latest."),
      },
      access: declaredToolAccess({ audiences: ["user"], write: true, scope: "admin", destructive: true }),
    },
    async (args, ctx) =>
      toolJson(
        await controlPlaneJson(ctx, `workspace.${args.operation}`, `/api/workspace/${encodeURIComponent(args.workspace)}/lifecycle/${args.operation}`, {
          method: "POST",
          body: {
            ...(args.checkpoint ? { checkpointId: args.checkpoint } : {}),
            ...(args.operation === "stop" ? {} : { approved: true }),
          },
        }),
      ),
  )
}

function renderWorkspace(workspace: WorkspaceSummary): string {
  const name = workspace.name ? ` (${workspace.name})` : ""
  const where = workspace.host === "provisioner" ? " — cloud VM" : workspace.host === "machine" ? " — machine" : ""
  const reachable = workspace.machineOnline === undefined ? "" : workspace.machineOnline ? "  online" : "  offline"
  const directory = workspace.directory ? `  ${workspace.directory}` : ""
  return `${workspace.id}${name}${where}${reachable}${directory}`
}

function checkpointsPath(workspaceId: string) {
  return `/api/workspace/${encodeURIComponent(workspaceId)}/checkpoints`
}

function controlPlane(ctx: McpToolContext): ClaxedoFetch {
  const { controlPlane } = ctx.client
  if (!controlPlane) throw new Error("Workspace compute is managed by the control plane, and no account credential is reachable here")
  return controlPlane
}

async function controlPlaneJson(
  ctx: McpToolContext,
  operation: string,
  path: string,
  input: Readonly<{ method?: string; body?: unknown }> = {},
): Promise<unknown> {
  const response = await controlPlane(ctx)(path, {
    method: input.method ?? "GET",
    ...(input.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) }),
  })
  if (!response.ok) throw await workspaceRuntimeClientError(operation, response)
  return await response.json()
}

async function latestCheckpoint(ctx: McpToolContext, workspaceId: string): Promise<string | undefined> {
  const inspected = record(await controlPlaneJson(ctx, "workspace.status", checkpointsPath(workspaceId)))
  return text(record(inspected?.checkpoint)?.id)
}
