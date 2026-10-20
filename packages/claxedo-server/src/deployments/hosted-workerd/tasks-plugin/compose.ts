import type { D1Database } from "@cloudflare/workers-types"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import type { WorkspaceRuntimeClientOptions } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import {
  createD1TasksHostReads,
  createHostedTasksPlugin,
  type HostedTasksGrants,
  type HostedTasksPorts,
  type TasksHostReads,
  type TasksSessionRegistrations,
} from "@claxedo/tasks/hosted"
import { isComposedAuthorityPort } from "../../../authority/composed-authority"
import type { ControlPlaneServices } from "../../../authority/services"
import {
  createCloudCreateAdmission,
  type CloudCreateAdmissionPolicy,
  type CloudCreateUsage,
} from "../../../workspace/cloud-create-admission"
import { signedOrError } from "../../../workspace/route-support"
import type { SandboxStart } from "../../../workspace/sandbox-start"
import { createHostedTasksCloudRoots, type HostedTasksCloudRootsInput } from "./cloud-roots"

export type HostedTasksPluginInput = {
  services: ControlPlaneServices
  database: D1Database
  authentication: RequestAuthenticationAdapter
  /**
   * The workspace's sandbox start, which prepares a root with its own
   * capability set. Only a build whose runtime preparation projects that set
   * names it; without it a preset naming cloud placement is refused when it
   * is saved.
   */
  sandboxStart?: SandboxStart
  sandboxUsage?: CloudCreateUsage
  /**
   * The deployment's half of the create admission a task's cloud root is
   * subject to — the same gates `POST /api/workspace/create` applies, keyed
   * on the person the root is created as. It is built once here, so its
   * create budget is one bucket per isolate rather than one per request.
   */
  cloudCreateAdmission?: CloudCreateAdmissionPolicy
  grants?: HostedTasksGrants
}

/**
 * The runtime principal Tasks dispatches as. Start reserves and creates a
 * session before any human turn exists, so it acts as the one control-plane
 * service actor the D1 runtime authority mints service tokens for — the same
 * actor the checkpoint routes and the Agent Plugins provisioner use — and the
 * bridge names the person each Start acts for on it.
 */
export function hostedTasksRuntimeClient(services: ControlPlaneServices): WorkspaceRuntimeClientOptions {
  return {
    ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
    ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    runtimeActor: CONTROL_PLANE_RUNTIME_ACTOR,
    role: "owner",
  }
}

/**
 * The reservation and compensation the composed authority implements. Its
 * type names only `WorkspaceAuthority`, so each half is recognized by its
 * methods, and a composition without one leaves Tasks without it.
 */
export function hostedTasksSessionRegistrations(services: ControlPlaneServices): TasksSessionRegistrations {
  const authority = services.authority ?? undefined
  return {
    ...(isComposedAuthorityPort<Pick<PrivateSessionAuthority, "reserveRuntimeSession">>(authority, ["reserveRuntimeSession"])
      ? { reservation: authority }
      : {}),
    ...(isComposedAuthorityPort<Pick<PrivateSessionAuthority, "beginSessionCompensation" | "completeSessionCompensation">>(
      authority,
      ["beginSessionCompensation", "completeSessionCompensation"],
    )
      ? { compensation: authority }
      : {}),
  }
}

/** Who a Tasks request is and what this deployment can place, from its authority, request authentication and sandbox manager. */
export function hostedTasksIdentityPorts(
  input: Pick<HostedTasksPluginInput, "services" | "authentication">,
): Pick<HostedTasksPorts, "authority" | "signed" | "cloudPlacement"> {
  const { services } = input
  return {
    authority: requireAuthority(services),
    signed: (request) => signedOrError(request, { authentication: input.authentication, requireSigned: true }, services),
    // The same reading the workspace routes make before they will create a
    // cloud workspace at all: without a sandbox manager this deployment has no
    // isolated root to allocate.
    cloudPlacement: Boolean(services.sandbox.sandboxManager),
  }
}

/** What a Start reads, reserves and allocates through on this deployment. */
export function hostedTasksBridgePorts(
  input: Omit<HostedTasksCloudRootsInput, "rows"> & { reads: TasksHostReads },
): Pick<HostedTasksPorts, "reads" | "registrations" | "cloudRoots"> {
  const { reads, ...roots } = input
  return {
    reads,
    registrations: hostedTasksSessionRegistrations(input.services),
    cloudRoots: createHostedTasksCloudRoots({ ...roots, rows: reads }),
  }
}

/** The Tasks plugin over this deployment's authority, D1 rows, sandbox start and create admission. */
export function composeHostedTasksPlugin(input: HostedTasksPluginInput): HostedServerPlugin {
  const { services } = input
  return createHostedTasksPlugin({
    ...hostedTasksIdentityPorts(input),
    ...hostedTasksBridgePorts({
      services,
      reads: createD1TasksHostReads({ database: input.database, cloudWorkspaceDirectory: WORKSPACE_DIR }),
      ...(input.sandboxStart ? { sandboxStart: input.sandboxStart } : {}),
      ...(input.sandboxUsage ? { sandboxUsage: input.sandboxUsage } : {}),
      cloudCreateAdmission: createCloudCreateAdmission({ services, ...input.cloudCreateAdmission }),
    }),
    database: input.database,
    runtimeClient: hostedTasksRuntimeClient(services),
    cloudSelectedCapabilities: Boolean(input.sandboxStart),
    ...(input.grants ? { grants: input.grants } : {}),
  })
}
