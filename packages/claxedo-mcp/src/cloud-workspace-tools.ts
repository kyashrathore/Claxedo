import { z } from "zod"
import { record, text } from "./json"
import {
  assertCloudWorkspaceLifecycleApproval,
  type CloudWorkspaceLifecycleAction,
} from "./tool-policy"
import type { ControlPlaneRequest } from "./control-plane-request"
import type { RegisterMcpTool } from "./mcp-tool"

export function registerCloudWorkspaceTools(register: RegisterMcpTool, request: ControlPlaneRequest, readOnly = false) {
  register(
    "cloud_workspace_status",
    {
      description:
        "[Cloud workspace] Inspect the current sandbox, epoch, provider capabilities, runtime image/version, latest checkpoint, restore progress, and registered worktrees.",
      inputSchema: {
        workspace_id: z.string().min(1).describe("Cloud workspace id."),
      },
    },
    async (args) => result(await request(checkpointsPath(args.workspace_id), { method: "GET" })),
  )

  if (readOnly) return

  register(
    "cloud_workspace_checkpoint",
    {
      description:
        "[Cloud workspace] Freeze writes, drain or interrupt active work, flush durable state, scrub runtime credentials, and capture a provider checkpoint.",
      inputSchema: {
        workspace_id: z.string().min(1).describe("Cloud workspace id."),
        policy: z.enum(["drain", "interrupt"]).optional().describe("drain waits for active turns; interrupt aborts them first."),
      },
    },
    async (args) => result(await request(checkpointsPath(args.workspace_id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: args.policy ?? "drain" }),
    })),
  )

  register(
    "cloud_workspace_lifecycle",
    {
      description:
        "[Cloud workspace] Stop, restore, replace, forcibly clean up, or destroy cloud compute. " +
        "Restore, replace, cleanup, and destroy are consequential and require approved=true after explicit user approval.",
      inputSchema: {
        workspace_id: z.string().min(1).describe("Cloud workspace id."),
        action: z.enum(["stop", "restore", "replace", "cleanup", "destroy"]).describe("Lifecycle operation."),
        checkpoint_id: z.string().optional().describe("Checkpoint id for restore or replacement. Defaults to latest."),
        approved: z.boolean().optional().describe("Must be true only after explicit user approval for restore/replace/cleanup/destroy."),
      },
      _meta: {
        "claxedo/approvalActions": ["restore", "replace", "cleanup", "destroy"],
      },
    },
    async (args) => {
      const action = args.action as CloudWorkspaceLifecycleAction
      assertCloudWorkspaceLifecycleApproval(action, args.approved)
      if (action === "restore") {
        const inspected = args.checkpoint_id
          ? undefined
          : record(await request(checkpointsPath(args.workspace_id), { method: "GET" }))
        const checkpointId = args.checkpoint_id ?? text(record(inspected?.checkpoint)?.id)
        if (!checkpointId) throw new Error("workspace has no checkpoint to restore")
        return result(await request(
          `${checkpointsPath(args.workspace_id)}/${encodeURIComponent(checkpointId)}/restore`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approved: true }),
          },
        ))
      }
      return result(await request(
        `/api/workspace/${encodeURIComponent(args.workspace_id)}/lifecycle/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(args.checkpoint_id ? { checkpointId: args.checkpoint_id } : {}),
            ...(args.approved === true ? { approved: true } : {}),
          }),
        },
      ))
    },
  )
}

function checkpointsPath(workspaceId: string) {
  return `/api/workspace/${encodeURIComponent(workspaceId)}/checkpoints`
}

function result(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(value, null, 2),
    }],
  }
}
