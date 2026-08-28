import {
  EMPTY_SERVICE_CATALOG,
  requireServiceCatalog,
  requireServiceDescriptor,
  type FirstPartyServiceCatalog,
  type FirstPartyServiceDescriptor,
  type FirstPartyServiceId,
  type InstalledServiceState,
  type ServiceHealthProbe,
} from "@claxedo/service-contract"

export type InstallationRevision = Readonly<{
  descriptor: FirstPartyServiceDescriptor
  revision: number
}>

export type DeploymentWorkflowIdentity = Readonly<{
  environmentId: string
  deploymentId: string
  operationId: string
  occurredAt: string
}>

export type ServiceInstallationAuditEvent = Readonly<{
  environmentId: string
  deploymentId: string
  operationId: string
  serviceId: FirstPartyServiceId
  action: "register_disabled" | "record_probe" | "enable" | "disable" | "uninstall"
  fromRevision: number | null
  toRevision: number | null
  occurredAt: string
}>

export interface ServiceInstallationStore {
  /** All installed rows. Absence, never a fabricated disabled row, means uninstalled. */
  list(identity: Pick<DeploymentWorkflowIdentity, "environmentId" | "deploymentId">): Promise<readonly InstallationRevision[]>
  get(
    identity: Pick<DeploymentWorkflowIdentity, "environmentId" | "deploymentId">,
    serviceId: FirstPartyServiceId,
  ): Promise<InstallationRevision | null>
  registerDisabled(identity: DeploymentWorkflowIdentity, descriptor: FirstPartyServiceDescriptor): Promise<InstallationRevision>
  recordProbe(
    identity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
    probe: ServiceHealthProbe,
  ): Promise<InstallationRevision>
  transition(
    identity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
    state: InstalledServiceState,
  ): Promise<InstallationRevision>
  uninstall(identity: DeploymentWorkflowIdentity, serviceId: FirstPartyServiceId, expectedRevision: number): Promise<void>
  audit(identity: Pick<DeploymentWorkflowIdentity, "environmentId" | "deploymentId">): Promise<readonly ServiceInstallationAuditEvent[]>
}

export class ServiceInstallationError extends Error {
  constructor(
    public readonly code:
      | "identity_mismatch"
      | "already_installed"
      | "not_installed"
      | "revision_conflict"
      | "probe_required"
      | "operation_conflict",
    message: string,
  ) {
    super(message)
    this.name = "ServiceInstallationError"
  }
}

export function requireWorkflowIdentity(identity: DeploymentWorkflowIdentity): DeploymentWorkflowIdentity {
  for (const field of ["environmentId", "deploymentId", "operationId", "occurredAt"] as const) {
    const value = identity[field]
    if (!value || value.trim() !== value) {
      throw new ServiceInstallationError("identity_mismatch", `${field} must be a non-empty, trimmed string`)
    }
  }
  return identity
}

export function requireDescriptorForIdentity(
  identity: DeploymentWorkflowIdentity,
  descriptor: FirstPartyServiceDescriptor,
): FirstPartyServiceDescriptor {
  const normalized = requireServiceDescriptor(descriptor)
  if (
    normalized.trust.environmentId !== identity.environmentId ||
    normalized.trust.deploymentId !== identity.deploymentId
  ) {
    throw new ServiceInstallationError(
      "identity_mismatch",
      "service trust metadata must name the mutating environment and deployment",
    )
  }
  if (normalized.state !== "installed_disabled") {
    throw new ServiceInstallationError("already_installed", "a service must first be registered as installed_disabled")
  }
  if (normalized.lastHealthProbe !== undefined) {
    throw new ServiceInstallationError("probe_required", "a service must be probed through its installed binding after registration")
  }
  return normalized
}

export function enabledServiceCatalog(rows: readonly InstallationRevision[]): FirstPartyServiceCatalog {
  if (!rows.length) return EMPTY_SERVICE_CATALOG
  return requireServiceCatalog(rows.filter((row) => row.descriptor.state === "enabled").map((row) => row.descriptor))
}
