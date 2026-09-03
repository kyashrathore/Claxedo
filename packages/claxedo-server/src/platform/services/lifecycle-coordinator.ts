import {
  SERVICE_PROTOCOL_VERSION,
  requireServiceDescriptor,
  serviceLifecycleStepIdentity,
  type FirstPartyServiceDescriptor,
  type FirstPartyServiceId,
  type ServiceInstallationOperationIdentity,
  type ServiceLifecycleMutationAction,
  type ServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationResponse,
} from "@claxedo/service-contract"

import {
  ServiceInstallationError,
  requireWorkflowIdentity,
  type DeploymentWorkflowIdentity,
  type InstallationRevision,
  type ServiceInstallationAuditEvent,
  type ServiceInstallationStore,
} from "./installation-ledger"

export type ServiceDeploymentStep =
  | "provision_resources"
  | "apply_migrations"
  | "deploy_dark"
  | "add_core_binding"
  | "drain_operations"
  | "revoke_bridge"
  | "remove_core_binding"
  | "retire_resources"

export type ServiceDeploymentStepIdentity = Readonly<{
  environmentId: string
  deploymentId: string
  workflowOperationId: string
  stepOperationId: string
  occurredAt: string
  serviceId: FirstPartyServiceId
  serviceBuildId: string
  bindingProvenance: string
  step: ServiceDeploymentStep
}>

/**
 * Every method is required to durably bind stepOperationId to the full input.
 * Repeating the exact call resumes; reusing the id for another input rejects.
 */
export interface OptionalServiceDeploymentDriver {
  readonly serviceId: FirstPartyServiceId
  runStep(identity: ServiceDeploymentStepIdentity, descriptor: FirstPartyServiceDescriptor): Promise<void>
  applyLifecycle(request: ServiceLifecycleMutationRequest): Promise<ServiceLifecycleMutationResponse>
}

/** The lock scope intentionally omits serviceId so both optional services serialize per deployment. */
export interface ServiceDeploymentLock {
  withDeploymentLock<T>(
    scope: Readonly<{ environmentId: string; deploymentId: string }>,
    operationId: string,
    work: () => Promise<T>,
  ): Promise<T>
}

export class OptionalServiceLifecycleError extends Error {
  constructor(
    public readonly code:
      "driver_mismatch" | "provenance_mismatch" | "lifecycle_mismatch" | "operation_conflict" | "service_not_disabled",
    message: string,
  ) {
    super(message)
    this.name = "OptionalServiceLifecycleError"
  }
}

export type OptionalServiceLifecycleInput = Readonly<{
  identity: DeploymentWorkflowIdentity
  descriptor: FirstPartyServiceDescriptor
  serviceBuildId: string
  driver: OptionalServiceDeploymentDriver
}>

export class OptionalServiceLifecycleCoordinator {
  constructor(
    private readonly installations: ServiceInstallationStore,
    private readonly lock: ServiceDeploymentLock,
  ) {}

  install(input: OptionalServiceLifecycleInput): Promise<InstallationRevision> {
    return this.locked(input, async (normalized) => {
      await this.step(normalized, "provision_resources")
      await this.step(normalized, "apply_migrations")
      await this.step(normalized, "deploy_dark")

      const initializeIdentity = this.stageIdentity(normalized.identity, "initialize")
      await this.local(normalized, "initialize_disabled", initializeIdentity, 0, "installed_disabled", 1)
      const current = await this.installations.get(normalized.identity, normalized.descriptor.serviceId)
      if (current) {
        const event = await this.operationEvent(normalized, initializeIdentity)
        if (
          event?.serviceId !== normalized.descriptor.serviceId ||
          event.action !== "register_disabled" ||
          event.fromRevision !== null ||
          event.toRevision !== 1
        ) {
          throw new OptionalServiceLifecycleError("operation_conflict", "service was installed by another operation")
        }
        this.requireCoreRevision(current, normalized, "installed_disabled", current.revision)
      } else {
        const registered = await this.installations.registerDisabled(initializeIdentity, normalized.descriptor)
        this.requireCoreRevision(registered, normalized, "installed_disabled", 1)
      }

      await this.step(normalized, "add_core_binding")

      const probeIdentity = this.stageIdentity(normalized.identity, "probe")
      await this.local(normalized, "record_probe", probeIdentity, 1, "installed_disabled", 2)
      const probed = await this.installations.recordProbe(probeIdentity, normalized.descriptor.serviceId, 1, {
        status: "ready",
        checkedAt: probeIdentity.occurredAt,
        serviceBuildId: normalized.serviceBuildId,
      })
      this.requireCoreRevision(probed, normalized, "installed_disabled", 2)
      return probed
    })
  }

  enable(input: OptionalServiceLifecycleInput): Promise<InstallationRevision> {
    return this.locked(input, async (normalized) => {
      const identity = this.stageIdentity(normalized.identity, "enable")
      const expectedRevision = await this.expectedRevision(normalized, identity, "enable")
      await this.local(normalized, "prepare_enable", identity, expectedRevision, "enabling", expectedRevision + 1)
      const enabled = await this.installations.transition(
        identity,
        normalized.descriptor.serviceId,
        expectedRevision,
        "enabled",
      )
      this.requireCoreRevision(enabled, normalized, "enabled", expectedRevision + 1)
      await this.local(
        normalized,
        "commit_enable",
        this.stageIdentity(normalized.identity, "enable_commit"),
        expectedRevision + 1,
        "enabled",
        expectedRevision + 1,
      )
      return enabled
    })
  }

  disable(input: OptionalServiceLifecycleInput): Promise<InstallationRevision> {
    return this.locked(input, async (normalized) => {
      const identity = this.stageIdentity(normalized.identity, "disable")
      const expectedRevision = await this.expectedRevision(normalized, identity, "disable")
      const disabled = await this.installations.transition(
        identity,
        normalized.descriptor.serviceId,
        expectedRevision,
        "installed_disabled",
      )
      this.requireCoreRevision(disabled, normalized, "installed_disabled", expectedRevision + 1)
      await this.step(normalized, "drain_operations")
      await this.local(normalized, "disable", identity, expectedRevision, "installed_disabled", expectedRevision + 1)
      await this.step(normalized, "revoke_bridge")
      return disabled
    })
  }

  drain(input: OptionalServiceLifecycleInput): Promise<void> {
    return this.locked(input, async (normalized) => {
      await this.requireDisabled(normalized)
      await this.step(normalized, "drain_operations")
    })
  }

  revoke(input: OptionalServiceLifecycleInput): Promise<void> {
    return this.locked(input, async (normalized) => {
      await this.requireDisabled(normalized)
      await this.step(normalized, "revoke_bridge")
    })
  }

  unbind(input: OptionalServiceLifecycleInput): Promise<void> {
    return this.locked(input, async (normalized) => {
      await this.requireDisabled(normalized)
      await this.step(normalized, "drain_operations")
      await this.step(normalized, "revoke_bridge")
      await this.step(normalized, "remove_core_binding")
    })
  }

  uninstall(input: OptionalServiceLifecycleInput): Promise<void> {
    return this.locked(input, async (normalized) => {
      const identity = this.stageIdentity(normalized.identity, "uninstall")
      const expectedRevision = await this.expectedRevision(normalized, identity, "uninstall")
      const existing = await this.installations.get(normalized.identity, normalized.descriptor.serviceId)
      if (existing) {
        this.requireCoreRevision(existing, normalized, "installed_disabled", expectedRevision)
        await this.step(normalized, "drain_operations")
        await this.step(normalized, "revoke_bridge")
        await this.step(normalized, "remove_core_binding")
        await this.local(normalized, "uninstall", identity, expectedRevision, "uninstalled", null)
      }
      await this.installations.uninstall(identity, normalized.descriptor.serviceId, expectedRevision)
      await this.step(normalized, "retire_resources")
    })
  }

  private async locked<T>(
    rawInput: OptionalServiceLifecycleInput,
    work: (input: OptionalServiceLifecycleInput) => Promise<T>,
  ): Promise<T> {
    const input = this.normalize(rawInput)
    return this.lock.withDeploymentLock(
      { environmentId: input.identity.environmentId, deploymentId: input.identity.deploymentId },
      input.identity.operationId,
      () => work(input),
    )
  }

  private normalize(input: OptionalServiceLifecycleInput): OptionalServiceLifecycleInput {
    const identity = requireWorkflowIdentity(input.identity)
    const descriptor = requireServiceDescriptor(input.descriptor)
    if (input.driver.serviceId !== descriptor.serviceId) {
      throw new OptionalServiceLifecycleError("driver_mismatch", "deployment driver owns another optional service")
    }
    if (
      descriptor.trust.environmentId !== identity.environmentId ||
      descriptor.trust.deploymentId !== identity.deploymentId
    ) {
      throw new OptionalServiceLifecycleError("provenance_mismatch", "descriptor does not belong to this deployment")
    }
    if (!input.serviceBuildId || input.serviceBuildId.trim() !== input.serviceBuildId) {
      throw new OptionalServiceLifecycleError("provenance_mismatch", "serviceBuildId must be canonical")
    }
    return { ...input, identity, descriptor }
  }

  private stageIdentity(identity: DeploymentWorkflowIdentity, stage: string): DeploymentWorkflowIdentity {
    return serviceLifecycleStepIdentity(identity, stage)
  }

  private lifecycleRequest(
    input: OptionalServiceLifecycleInput,
    action: ServiceLifecycleMutationAction,
    identity: ServiceInstallationOperationIdentity,
    expectedRevision: number,
  ): ServiceLifecycleMutationRequest {
    return {
      action,
      identity,
      serviceId: input.descriptor.serviceId,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: input.descriptor.schemaVersion,
      bindingName: input.descriptor.bindingName,
      entrypoint: input.descriptor.entrypoint,
      bindingProvenance: input.descriptor.trust.bindingProvenance,
      serviceBuildId: input.serviceBuildId,
      expectedRevision,
    }
  }

  private async local(
    input: OptionalServiceLifecycleInput,
    action: ServiceLifecycleMutationAction,
    identity: ServiceInstallationOperationIdentity,
    expectedRevision: number,
    expectedState: ServiceLifecycleMutationResponse["state"],
    expectedResultRevision: number | null,
  ) {
    const response = await input.driver.applyLifecycle(this.lifecycleRequest(input, action, identity, expectedRevision))
    if (
      response.serviceId !== input.descriptor.serviceId ||
      response.action !== action ||
      response.operationId !== identity.operationId ||
      response.state !== expectedState ||
      response.revision !== expectedResultRevision ||
      response.serviceBuildId !== input.serviceBuildId
    ) {
      throw new OptionalServiceLifecycleError("lifecycle_mismatch", "service returned another lifecycle operation")
    }
    return response
  }

  private async step(input: OptionalServiceLifecycleInput, step: ServiceDeploymentStep) {
    const identity = this.stageIdentity(input.identity, step)
    await input.driver.runStep(
      {
        environmentId: identity.environmentId,
        deploymentId: identity.deploymentId,
        workflowOperationId: input.identity.operationId,
        stepOperationId: identity.operationId,
        occurredAt: identity.occurredAt,
        serviceId: input.descriptor.serviceId,
        serviceBuildId: input.serviceBuildId,
        bindingProvenance: input.descriptor.trust.bindingProvenance,
        step,
      },
      input.descriptor,
    )
  }

  private async expectedRevision(
    input: OptionalServiceLifecycleInput,
    identity: DeploymentWorkflowIdentity,
    action: "enable" | "disable" | "uninstall",
  ) {
    const audit = await this.installations.audit(input.identity)
    const event = audit.find((item) => item.operationId === identity.operationId)
    if (event) {
      if (event.serviceId !== input.descriptor.serviceId || event.action !== action || event.fromRevision === null) {
        throw new OptionalServiceLifecycleError(
          "operation_conflict",
          "lifecycle operation id belongs to another intent",
        )
      }
      return event.fromRevision
    }
    const current = await this.installations.get(input.identity, input.descriptor.serviceId)
    if (!current) throw new ServiceInstallationError("not_installed", "optional service is not installed")
    return current.revision
  }

  private async operationEvent(
    input: OptionalServiceLifecycleInput,
    identity: DeploymentWorkflowIdentity,
  ): Promise<ServiceInstallationAuditEvent | undefined> {
    return (await this.installations.audit(input.identity)).find((item) => item.operationId === identity.operationId)
  }

  private async requireDisabled(input: OptionalServiceLifecycleInput) {
    const current = await this.installations.get(input.identity, input.descriptor.serviceId)
    if (!current || current.descriptor.state !== "installed_disabled") {
      throw new OptionalServiceLifecycleError("service_not_disabled", "optional service must be disabled first")
    }
    this.requireCoreRevision(current, input, "installed_disabled", current.revision)
    return current
  }

  private requireCoreRevision(
    row: InstallationRevision,
    input: OptionalServiceLifecycleInput,
    state: "installed_disabled" | "enabled",
    revision: number,
  ) {
    const descriptor = row.descriptor
    if (
      descriptor.serviceId !== input.descriptor.serviceId ||
      descriptor.trust.environmentId !== input.identity.environmentId ||
      descriptor.trust.deploymentId !== input.identity.deploymentId ||
      descriptor.trust.bindingProvenance !== input.descriptor.trust.bindingProvenance ||
      descriptor.bindingName !== input.descriptor.bindingName ||
      descriptor.entrypoint !== input.descriptor.entrypoint ||
      descriptor.schemaVersion !== input.descriptor.schemaVersion ||
      descriptor.state !== state ||
      row.revision !== revision
    ) {
      throw new OptionalServiceLifecycleError("lifecycle_mismatch", "core and service installation provenance diverged")
    }
  }
}
