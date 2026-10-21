import type { D1Database } from "@cloudflare/workers-types"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { SandboxPassRegister } from "@claxedo/server-core/platform/auth/sandbox-pass-register"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import { TASKS_MCP_TOOL_GROUP } from "../mcp"
import { TASKS_CAPABILITY_AUDIENCE } from "./capability"
import { createHostedTasksComposition, type HostedTasksCompositionInput } from "./composition"
import { tasksCapabilityRenewalContribution, type TasksCapabilityRenewalInput } from "./grant-renewal"
import { createTasksRootCapability, createTasksRootGrant, type TasksRootIdentity } from "./root-capability"

/** The capabilities this deployment mints for its cloud roots, and what their renewal re-reads. */
export type HostedTasksGrants = Readonly<{
  signingEnv: Record<string, string | undefined>
  passes: SandboxPassRegister
  /** Whether the root's project has `group` on now, read exactly as its launch environment was. */
  groupEnabled(group: string, root: TasksRootIdentity): Promise<boolean>
  ownerGrant?: TasksCapabilityRenewalInput["ownerGrant"]
}>

/** What a hosted deployment implements for Tasks from its own owners. */
export type HostedTasksPorts = Readonly<{
  authority: WorkspaceAuthority
  database: D1Database
  signed: HostedTasksCompositionInput["signed"]
  /** The session bridge a request's actor starts through, over the deployment's own session host. */
  bridge: HostedTasksCompositionInput["bridge"]
  cloudPlacement: boolean
  /** Whether a root's sandbox start projects the capability set a preset names. */
  cloudSelectedCapabilities: boolean
  /** Absent on a deployment with no signing key: Tasks then serves signed callers only. */
  grants?: HostedTasksGrants
}>

/**
 * Hosted Tasks as the plugin a Worker entry composes: the routes, with the
 * session bridge each request's principal is handed to, the renewal door a
 * running root's capability comes back through, and the capability a root
 * launches with while its project has the Tasks group on.
 *
 * Renewal is mounted with the routes because it verifies against the same
 * register the routes refuse revoked capabilities from; a deployment that
 * mints none — no signing key — mounts no renewal either.
 */
export function createHostedTasksPlugin(ports: HostedTasksPorts): HostedServerPlugin {
  const { grants } = ports
  const composition = createHostedTasksComposition({
    authority: ports.authority,
    database: ports.database,
    signed: ports.signed,
    cloudPlacement: ports.cloudPlacement,
    cloudSelectedCapabilities: ports.cloudSelectedCapabilities,
    ...(grants ? { signingEnv: grants.signingEnv, passes: grants.passes } : {}),
    bridge: ports.bridge,
  })
  const owners = ports.authority.resolveWorkspaceOwner?.bind(ports.authority)
  return {
    id: "claxedo-tasks",
    capability: "tasks",
    routeContributions: [
      ...composition.routeContributions,
      ...(grants && owners
        ? [tasksCapabilityRenewalContribution({
            signingEnv: grants.signingEnv,
            passes: grants.passes,
            workspaceOwner: owners,
            groupEnabled: (root) => grants.groupEnabled(TASKS_MCP_TOOL_GROUP.id, root),
            grant: createTasksRootGrant(grants),
            ...(grants.ownerGrant ? { ownerGrant: grants.ownerGrant } : {}),
          })]
        : []),
    ],
    // An account credential on this plane is granted no Tasks service, so its
    // tools are listed only to a cloud root's sessions, whose runtime holds
    // the capability.
    mcp: { groups: [TASKS_MCP_TOOL_GROUP] },
    ...(grants
      ? {
          rootGrants: [{
            group: TASKS_MCP_TOOL_GROUP.id,
            audience: TASKS_CAPABILITY_AUDIENCE,
            withdrawalReason: "tasks_group_disabled",
            mint: createTasksRootCapability(grants),
          }],
        }
      : {}),
  }
}
