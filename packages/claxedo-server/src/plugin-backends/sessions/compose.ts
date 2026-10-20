import type { D1Database } from "@cloudflare/workers-types"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { WorkspaceRuntimeClientOptions } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { isComposedAuthorityPort } from "../../authority/composed-authority"
import type { ControlPlaneServices } from "../../authority/services"
import { createCloudCreateAdmission, type CloudCreateAdmissionPolicy, type CloudCreateUsage } from "../../workspace/cloud-create-admission"
import type { SandboxStart } from "../../workspace/sandbox-start"
import { createHostedCloudRoots, type HostedCloudRootsInput } from "./cloud-roots"
import type { HostedSessionHostInput } from "./host"
import { createD1SessionHostReads, type SessionHostReads } from "./reads"
import type { SessionRegistrations } from "./reservation"

/**
 * The runtime principal an origin session dispatches as. A start reserves and
 * creates a session before any human turn exists, so it acts as the one
 * control-plane service actor the D1 runtime authority mints service tokens
 * for — the same actor the checkpoint routes and the Agent Plugins
 * provisioner use — and the host names the person each start acts for on it.
 */
export function hostedSessionRuntimeClient(services: ControlPlaneServices): WorkspaceRuntimeClientOptions {
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
 * methods, and a composition without one leaves the host without it.
 */
export function hostedSessionRegistrations(services: ControlPlaneServices): SessionRegistrations {
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

/** What a start reads, reserves, dispatches and allocates through on this deployment, before the actor's resolvers are named. */
export type HostedSessionPorts = Pick<HostedSessionHostInput<unknown>, "reads" | "registrations" | "cloudRoots" | "runtimeClient">

export function hostedSessionPorts(input: Omit<HostedCloudRootsInput, "rows"> & { reads: SessionHostReads }): HostedSessionPorts {
  const { reads, ...roots } = input
  return {
    reads,
    registrations: hostedSessionRegistrations(input.services),
    cloudRoots: createHostedCloudRoots({ ...roots, rows: reads }),
    runtimeClient: hostedSessionRuntimeClient(input.services),
  }
}

export type HostedSessionDeploymentInput = {
  services: ControlPlaneServices
  database: D1Database
  /**
   * The workspace's sandbox start, which prepares a root with its own
   * capability set. A deployment that names none cannot start a cloud root.
   */
  sandboxStart?: SandboxStart
  sandboxUsage?: CloudCreateUsage
  /**
   * The deployment's half of the create admission an origin's cloud root is
   * subject to — the same gates `POST /api/workspace/create` applies, keyed
   * on the person the root is created as. It is built once here, so its
   * create budget is one bucket per isolate rather than one per request.
   */
  cloudCreateAdmission?: CloudCreateAdmissionPolicy
}

/** This deployment's session host ports over its D1 rows, sandbox start and create admission. */
export function composeHostedSessionPorts(input: HostedSessionDeploymentInput): HostedSessionPorts {
  const { services } = input
  return hostedSessionPorts({
    services,
    reads: createD1SessionHostReads({ database: input.database, cloudWorkspaceDirectory: WORKSPACE_DIR }),
    ...(input.sandboxStart ? { sandboxStart: input.sandboxStart } : {}),
    ...(input.sandboxUsage ? { sandboxUsage: input.sandboxUsage } : {}),
    cloudCreateAdmission: createCloudCreateAdmission({ services, ...input.cloudCreateAdmission }),
  })
}
