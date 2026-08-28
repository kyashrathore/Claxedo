import {
  requireServiceCatalog,
  requireServiceDescriptor,
  isFirstPartyServiceId,
  type FirstPartyServiceDescriptor,
  type FirstPartyServiceId,
  type InstalledServiceState,
  type ServiceHealthProbe,
} from "@claxedo/service-contract"

import {
  requireDescriptorForIdentity,
  requireWorkflowIdentity,
  type DeploymentWorkflowIdentity,
  type InstallationRevision,
  type ServiceInstallationAuditEvent,
  type ServiceInstallationStore,
} from "../installation-store"

type Scope = Pick<DeploymentWorkflowIdentity, "environmentId" | "deploymentId">

export type ConvexInstallationOperation =
  | "serviceInstallations:list"
  | "serviceInstallations:get"
  | "serviceInstallations:audit"
  | "serviceInstallations:registerDisabled"
  | "serviceInstallations:recordProbe"
  | "serviceInstallations:transition"
  | "serviceInstallations:uninstall"

/**
 * Narrow generated-API seam. The real Convex executor binds these operation
 * names to generated function references; this adapter never uses dynamic
 * table access or provider-owned identity.
 */
export interface ConvexInstallationExecutor {
  query(operation: ConvexInstallationOperation, input: Readonly<Record<string, unknown>>): Promise<unknown>
  mutation(operation: ConvexInstallationOperation, input: Readonly<Record<string, unknown>>): Promise<unknown>
}

function revision(value: unknown): InstallationRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Convex installation row")
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) <= 0) throw new Error("Invalid Convex revision")
  return { descriptor: requireServiceDescriptor(row.descriptor), revision: Number(row.revision) }
}

function requireRevision(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Invalid Convex ${field}`)
  return Number(value)
}

const auditActions = new Set(["register_disabled", "record_probe", "enable", "disable", "uninstall"])

function auditEvent(value: unknown, scope: Scope): ServiceInstallationAuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Convex service audit event")
  const event = value as Record<string, unknown>
  for (const field of ["environmentId", "deploymentId", "operationId", "occurredAt"] as const) {
    if (typeof event[field] !== "string" || !event[field] || event[field].trim() !== event[field]) {
      throw new Error(`Invalid Convex service audit ${field}`)
    }
  }
  if (event.environmentId !== scope.environmentId || event.deploymentId !== scope.deploymentId) {
    throw new Error("Convex service audit escaped the requested deployment scope")
  }
  if (!isFirstPartyServiceId(event.serviceId) || !auditActions.has(String(event.action))) {
    throw new Error("Invalid Convex service audit vocabulary")
  }
  const fromRevision = requireRevision(event.fromRevision, "audit fromRevision")
  const toRevision = requireRevision(event.toRevision, "audit toRevision")
  if (
    (event.action === "register_disabled" && (fromRevision !== null || toRevision !== 1)) ||
    (["record_probe", "enable", "disable"].includes(String(event.action)) &&
      (fromRevision === null || toRevision !== fromRevision + 1)) ||
    (event.action === "uninstall" && (fromRevision === null || toRevision !== null))
  ) {
    throw new Error("Invalid Convex service audit revision transition")
  }
  return {
    environmentId: event.environmentId as string,
    deploymentId: event.deploymentId as string,
    operationId: event.operationId as string,
    serviceId: event.serviceId,
    action: event.action as ServiceInstallationAuditEvent["action"],
    fromRevision,
    toRevision,
    occurredAt: event.occurredAt as string,
  }
}

function requireScope(row: InstallationRevision, scope: Scope, serviceId?: FirstPartyServiceId) {
  if (
    row.descriptor.trust.environmentId !== scope.environmentId ||
    row.descriptor.trust.deploymentId !== scope.deploymentId ||
    (serviceId !== undefined && row.descriptor.serviceId !== serviceId)
  ) {
    throw new Error("Convex service installation escaped the requested deployment scope")
  }
  return row
}

export class ConvexServiceInstallationStore implements ServiceInstallationStore {
  constructor(private readonly executor: ConvexInstallationExecutor) {}

  async list(scope: Scope): Promise<readonly InstallationRevision[]> {
    const value = await this.executor.query("serviceInstallations:list", scope)
    if (!Array.isArray(value)) throw new Error("Invalid Convex installation catalog")
    const rows = value.map(revision).map((row) => requireScope(row, scope))
    requireServiceCatalog(rows.map((row) => row.descriptor))
    return rows
  }

  async get(scope: Scope, serviceId: FirstPartyServiceId): Promise<InstallationRevision | null> {
    const value = await this.executor.query("serviceInstallations:get", { ...scope, serviceId })
    return value === null ? null : requireScope(revision(value), scope, serviceId)
  }

  async registerDisabled(identity: DeploymentWorkflowIdentity, descriptor: FirstPartyServiceDescriptor) {
    requireWorkflowIdentity(identity)
    const normalized = requireDescriptorForIdentity(identity, descriptor)
    return revision(await this.executor.mutation("serviceInstallations:registerDisabled", { identity, descriptor: normalized }))
  }

  async recordProbe(
    identity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
    probe: ServiceHealthProbe,
  ) {
    requireWorkflowIdentity(identity)
    return revision(
      await this.executor.mutation("serviceInstallations:recordProbe", {
        identity,
        serviceId,
        expectedRevision,
        probe,
      }),
    )
  }

  async transition(
    identity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
    state: InstalledServiceState,
  ) {
    requireWorkflowIdentity(identity)
    return revision(
      await this.executor.mutation("serviceInstallations:transition", {
        identity,
        serviceId,
        expectedRevision,
        state,
      }),
    )
  }

  async uninstall(identity: DeploymentWorkflowIdentity, serviceId: FirstPartyServiceId, expectedRevision: number) {
    requireWorkflowIdentity(identity)
    await this.executor.mutation("serviceInstallations:uninstall", { identity, serviceId, expectedRevision })
  }

  async audit(scope: Scope): Promise<readonly ServiceInstallationAuditEvent[]> {
    const value = await this.executor.query("serviceInstallations:audit", scope)
    if (!Array.isArray(value)) throw new Error("Invalid Convex service audit")
    return value.map((event) => auditEvent(event, scope))
  }
}
