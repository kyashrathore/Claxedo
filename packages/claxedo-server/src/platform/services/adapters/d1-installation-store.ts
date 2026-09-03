import type { D1Database } from "@cloudflare/workers-types"
import {
  isFirstPartyServiceId,
  requireServiceCatalog,
  requireServiceDescriptor,
  serializeServiceInstallationOperationIntent,
  type FirstPartyServiceDescriptor,
  type FirstPartyServiceId,
  type InstalledServiceState,
  type ServiceHealthProbe,
} from "@claxedo/service-contract"

import {
  ServiceInstallationError,
  requireDescriptorForIdentity,
  requireWorkflowIdentity,
  type DeploymentWorkflowIdentity,
  type InstallationRevision,
  type ServiceInstallationAuditEvent,
  type ServiceInstallationStore,
} from "../installation-ledger"

type Scope = Pick<DeploymentWorkflowIdentity, "environmentId" | "deploymentId">

type InstallationRow = {
  environmentId: string
  deploymentId: string
  serviceId: FirstPartyServiceId
  protocolVersion: string
  schemaVersion: number
  lifecycleState: InstalledServiceState
  bindingName: string
  entrypoint: string
  bindingProvenance: string
  probeStatus: "ready" | "unhealthy" | null
  probeCheckedAt: string | null
  serviceBuildId: string | null
  revision: number
  lastOperationId: string
}

type AuditRow = {
  environmentId: string
  deploymentId: string
  operationId: string
  operationIntent: string
  serviceId: FirstPartyServiceId
  action: ServiceInstallationAuditEvent["action"]
  fromRevision: number | null
  toRevision: number | null
  occurredAt: string
}

const INSTALLATION_COLUMNS = `
  environment_id as environmentId,
  deployment_id as deploymentId,
  service_id as serviceId,
  protocol_version as protocolVersion,
  schema_version as schemaVersion,
  lifecycle_state as lifecycleState,
  binding_name as bindingName,
  entrypoint,
  binding_provenance as bindingProvenance,
  probe_status as probeStatus,
  probe_checked_at as probeCheckedAt,
  service_build_id as serviceBuildId,
  revision,
  last_operation_id as lastOperationId
`

function descriptorFromRow(row: InstallationRow): FirstPartyServiceDescriptor {
  return requireServiceDescriptor({
    serviceId: row.serviceId,
    protocolVersion: row.protocolVersion,
    schemaVersion: row.schemaVersion,
    state: row.lifecycleState,
    bindingName: row.bindingName,
    entrypoint: row.entrypoint,
    trust: {
      environmentId: row.environmentId,
      deploymentId: row.deploymentId,
      bindingProvenance: row.bindingProvenance,
    },
    ...(row.probeStatus && row.probeCheckedAt && row.serviceBuildId
      ? {
          lastHealthProbe: {
            status: row.probeStatus,
            checkedAt: row.probeCheckedAt,
            serviceBuildId: row.serviceBuildId,
          },
        }
      : {}),
  })
}

function revisionFromRow(row: InstallationRow): InstallationRevision {
  return { descriptor: descriptorFromRow(row), revision: row.revision }
}

function sameDescriptor(left: FirstPartyServiceDescriptor, right: FirstPartyServiceDescriptor) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class D1ServiceInstallationStore implements ServiceInstallationStore {
  constructor(private readonly database: D1Database) {}

  private async row(scope: Scope, serviceId: FirstPartyServiceId): Promise<InstallationRow | null> {
    return this.database
      .prepare(`select ${INSTALLATION_COLUMNS} from service_installations where environment_id = ? and deployment_id = ? and service_id = ?`)
      .bind(scope.environmentId, scope.deploymentId, serviceId)
      .first<InstallationRow>()
  }

  private async auditOperation(identity: DeploymentWorkflowIdentity): Promise<AuditRow | null> {
    return this.database
      .prepare(`
        select environment_id as environmentId, deployment_id as deploymentId, operation_id as operationId,
          operation_intent as operationIntent, service_id as serviceId, action,
          from_revision as fromRevision, to_revision as toRevision,
          occurred_at as occurredAt
        from service_installation_audit
        where environment_id = ? and deployment_id = ? and operation_id = ?
      `)
      .bind(identity.environmentId, identity.deploymentId, identity.operationId)
      .first<AuditRow>()
  }

  async list(scope: Scope): Promise<readonly InstallationRevision[]> {
    const result = await this.database
      .prepare(`select ${INSTALLATION_COLUMNS} from service_installations where environment_id = ? and deployment_id = ? order by service_id`)
      .bind(scope.environmentId, scope.deploymentId)
      .all<InstallationRow>()
    // Rows for a RETIRED service are skipped, not rejected. The table's CHECK
    // constraint is part of an append-only migration ledger, so it still admits
    // service ids this build no longer implements — and this list is read on
    // every signed request through `serviceCatalog()`. Validating the whole set
    // would turn one orphaned row from a retired install into a 500 on the app
    // shell for that entire deployment. An id this build cannot render is not a
    // service; it is residue, and residue must not be able to take down a
    // deployment that never used it. Everything that survives the filter is
    // still validated in full.
    const live = result.results.filter((row) => isFirstPartyServiceId(row.serviceId))
    requireServiceCatalog(live.map((row) => descriptorFromRow(row)))
    return live.map(revisionFromRow)
  }

  async get(scope: Scope, serviceId: FirstPartyServiceId): Promise<InstallationRevision | null> {
    const row = await this.row(scope, serviceId)
    return row ? revisionFromRow(row) : null
  }

  async registerDisabled(
    rawIdentity: DeploymentWorkflowIdentity,
    rawDescriptor: FirstPartyServiceDescriptor,
  ): Promise<InstallationRevision> {
    const identity = requireWorkflowIdentity(rawIdentity)
    const descriptor = requireDescriptorForIdentity(identity, rawDescriptor)
    const operationIntent = serializeServiceInstallationOperationIntent({
      action: "register_disabled",
      identity,
      descriptor,
    })
    await this.database.batch([
      this.database
        .prepare(`
          insert or ignore into service_installations (
            environment_id, deployment_id, service_id, protocol_version, schema_version, lifecycle_state,
            binding_name, entrypoint, binding_provenance, revision, last_operation_id, updated_at
          )
          select ?, ?, ?, ?, ?, 'installed_disabled', ?, ?, ?, 1, ?, ?
          where not exists (
            select 1 from service_installation_audit
            where environment_id = ? and deployment_id = ? and operation_id = ?
          )
        `)
        .bind(
          identity.environmentId,
          identity.deploymentId,
          descriptor.serviceId,
          descriptor.protocolVersion,
          descriptor.schemaVersion,
          descriptor.bindingName,
          descriptor.entrypoint,
          descriptor.trust.bindingProvenance,
          identity.operationId,
          identity.occurredAt,
          identity.environmentId,
          identity.deploymentId,
          identity.operationId,
        ),
      this.database
        .prepare(`
          insert or ignore into service_installation_audit (
            environment_id, deployment_id, operation_id, operation_intent, service_id, action,
            from_revision, to_revision, occurred_at
          )
          select environment_id, deployment_id, ?, ?, service_id, 'register_disabled', null, 1, ?
          from service_installations
          where environment_id = ? and deployment_id = ? and service_id = ? and revision = 1
            and last_operation_id = ? and protocol_version = ? and schema_version = ?
            and lifecycle_state = 'installed_disabled' and binding_name = ? and entrypoint = ?
            and binding_provenance = ?
        `)
        .bind(
          identity.operationId,
          operationIntent,
          identity.occurredAt,
          identity.environmentId,
          identity.deploymentId,
          descriptor.serviceId,
          identity.operationId,
          descriptor.protocolVersion,
          descriptor.schemaVersion,
          descriptor.bindingName,
          descriptor.entrypoint,
          descriptor.trust.bindingProvenance,
        ),
    ])
    const [row, event] = await Promise.all([
      this.row(identity, descriptor.serviceId),
      this.auditOperation(identity),
    ])
    if (
      !row ||
      !event ||
      event.serviceId !== descriptor.serviceId ||
      event.action !== "register_disabled" ||
      event.operationIntent !== operationIntent
    ) {
      throw new ServiceInstallationError(
        event ? "operation_conflict" : "already_installed",
        "service registration did not create the requested immutable operation",
      )
    }
    const result = revisionFromRow(row)
    if (result.revision !== 1 || !sameDescriptor(result.descriptor, descriptor)) {
      throw new ServiceInstallationError("already_installed", "service is already installed with different metadata")
    }
    return result
  }

  async recordProbe(
    rawIdentity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
    probe: ServiceHealthProbe,
  ): Promise<InstallationRevision> {
    const identity = requireWorkflowIdentity(rawIdentity)
    const operationIntent = serializeServiceInstallationOperationIntent({
      action: "record_probe",
      identity,
      serviceId,
      expectedRevision,
      probe,
    })
    await this.database.batch([
      this.database
        .prepare(`
          update service_installations
          set probe_status = ?, probe_checked_at = ?, service_build_id = ?, revision = revision + 1,
            last_operation_id = ?, updated_at = ?
          where environment_id = ? and deployment_id = ? and service_id = ? and revision = ?
            and not exists (
              select 1 from service_installation_audit
              where environment_id = ? and deployment_id = ? and operation_id = ?
            )
        `)
        .bind(
          probe.status,
          probe.checkedAt,
          probe.serviceBuildId,
          identity.operationId,
          identity.occurredAt,
          identity.environmentId,
          identity.deploymentId,
          serviceId,
          expectedRevision,
          identity.environmentId,
          identity.deploymentId,
          identity.operationId,
        ),
      this.auditInsertFromCurrent(identity, serviceId, "record_probe", expectedRevision, operationIntent),
    ])
    return this.requireMutation(identity, serviceId, "record_probe", expectedRevision + 1, operationIntent)
  }

  async transition(
    rawIdentity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
    state: InstalledServiceState,
  ): Promise<InstallationRevision> {
    const identity = requireWorkflowIdentity(rawIdentity)
    const currentState = state === "enabled" ? "installed_disabled" : "enabled"
    const action = state === "enabled" ? "enable" : "disable"
    const operationIntent = serializeServiceInstallationOperationIntent({
      action,
      identity,
      serviceId,
      expectedRevision,
    })
    await this.database.batch([
      this.database
        .prepare(`
          update service_installations
          set lifecycle_state = ?, revision = revision + 1, last_operation_id = ?, updated_at = ?
          where environment_id = ? and deployment_id = ? and service_id = ? and revision = ?
            and lifecycle_state = ?
            ${state === "enabled" ? "and probe_status = 'ready'" : ""}
            and not exists (
              select 1 from service_installation_audit
              where environment_id = ? and deployment_id = ? and operation_id = ?
            )
        `)
        .bind(
          state,
          identity.operationId,
          identity.occurredAt,
          identity.environmentId,
          identity.deploymentId,
          serviceId,
          expectedRevision,
          currentState,
          identity.environmentId,
          identity.deploymentId,
          identity.operationId,
        ),
      this.auditInsertFromCurrent(identity, serviceId, action, expectedRevision, operationIntent),
    ])
    const row = await this.row(identity, serviceId)
    if (state === "enabled" && row?.revision === expectedRevision && row.probeStatus !== "ready") {
      throw new ServiceInstallationError("probe_required", "a ready health probe is required before enablement")
    }
    return this.requireMutation(identity, serviceId, action, expectedRevision + 1, operationIntent)
  }

  async uninstall(
    rawIdentity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    expectedRevision: number,
  ): Promise<void> {
    const identity = requireWorkflowIdentity(rawIdentity)
    const operationIntent = serializeServiceInstallationOperationIntent({
      action: "uninstall",
      identity,
      serviceId,
      expectedRevision,
    })
    await this.database.batch([
      this.database
        .prepare(`
          update service_installations
          set last_operation_id = ?, updated_at = ?
          where environment_id = ? and deployment_id = ? and service_id = ? and revision = ?
            and lifecycle_state = 'installed_disabled'
            and not exists (
              select 1 from service_installation_audit
              where environment_id = ? and deployment_id = ? and operation_id = ?
            )
        `)
        .bind(
          identity.operationId,
          identity.occurredAt,
          identity.environmentId,
          identity.deploymentId,
          serviceId,
          expectedRevision,
          identity.environmentId,
          identity.deploymentId,
          identity.operationId,
        ),
      this.database
        .prepare(`
          insert or ignore into service_installation_audit (
            environment_id, deployment_id, operation_id, operation_intent, service_id, action,
            from_revision, to_revision, occurred_at
          )
          select environment_id, deployment_id, ?, ?, service_id, 'uninstall', revision, null, ?
          from service_installations
          where environment_id = ? and deployment_id = ? and service_id = ? and revision = ?
            and lifecycle_state = 'installed_disabled'
            and last_operation_id = ?
        `)
        .bind(
          identity.operationId,
          operationIntent,
          identity.occurredAt,
          identity.environmentId,
          identity.deploymentId,
          serviceId,
          expectedRevision,
          identity.operationId,
        ),
      this.database
        .prepare(`
          delete from service_installations
          where environment_id = ? and deployment_id = ? and service_id = ? and revision = ?
            and lifecycle_state = 'installed_disabled'
            and last_operation_id = ?
            and exists (
              select 1 from service_installation_audit
              where environment_id = ? and deployment_id = ? and operation_id = ? and service_id = ?
                and action = 'uninstall' and operation_intent = ? and from_revision = ? and to_revision is null
            )
        `)
        .bind(
          identity.environmentId,
          identity.deploymentId,
          serviceId,
          expectedRevision,
          identity.operationId,
          identity.environmentId,
          identity.deploymentId,
          identity.operationId,
          serviceId,
          operationIntent,
          expectedRevision,
        ),
    ])
    const [row, event] = await Promise.all([this.row(identity, serviceId), this.auditOperation(identity)])
    if (
      row ||
      !event ||
      event.serviceId !== serviceId ||
      event.action !== "uninstall" ||
      event.operationIntent !== operationIntent
    ) {
      throw new ServiceInstallationError(
        event ? "operation_conflict" : row ? "revision_conflict" : "not_installed",
        "service uninstall precondition failed",
      )
    }
  }

  async audit(scope: Scope): Promise<readonly ServiceInstallationAuditEvent[]> {
    const result = await this.database
      .prepare(`
        select environment_id as environmentId, deployment_id as deploymentId, operation_id as operationId,
          service_id as serviceId, action, from_revision as fromRevision, to_revision as toRevision,
          occurred_at as occurredAt
        from service_installation_audit
        where environment_id = ? and deployment_id = ?
        order by occurred_at, operation_id
      `)
      .bind(scope.environmentId, scope.deploymentId)
      .all<AuditRow>()
    return result.results
  }

  private auditInsertFromCurrent(
    identity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    action: "record_probe" | "enable" | "disable",
    expectedRevision: number,
    operationIntent: string,
  ) {
    return this.database
      .prepare(`
        insert or ignore into service_installation_audit (
          environment_id, deployment_id, operation_id, operation_intent, service_id, action,
          from_revision, to_revision, occurred_at
        )
        select environment_id, deployment_id, ?, ?, service_id, ?, ?, revision, ?
        from service_installations
        where environment_id = ? and deployment_id = ? and service_id = ? and revision = ?
          and last_operation_id = ?
      `)
      .bind(
        identity.operationId,
        operationIntent,
        action,
        expectedRevision,
        identity.occurredAt,
        identity.environmentId,
        identity.deploymentId,
        serviceId,
        expectedRevision + 1,
        identity.operationId,
      )
  }

  private async requireMutation(
    identity: DeploymentWorkflowIdentity,
    serviceId: FirstPartyServiceId,
    action: ServiceInstallationAuditEvent["action"],
    revision: number,
    operationIntent: string,
  ): Promise<InstallationRevision> {
    const [row, event] = await Promise.all([this.row(identity, serviceId), this.auditOperation(identity)])
    if (
      !row ||
      !event ||
      event.serviceId !== serviceId ||
      event.action !== action ||
      event.operationIntent !== operationIntent ||
      event.toRevision !== revision ||
      row.revision !== revision ||
      row.lastOperationId !== identity.operationId
    ) {
      throw new ServiceInstallationError(
        event ? "operation_conflict" : row ? "revision_conflict" : "not_installed",
        "service installation mutation precondition failed",
      )
    }
    return revisionFromRow(row)
  }
}
