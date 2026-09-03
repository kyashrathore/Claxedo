import {
  requireServiceDescriptor,
  serviceLifecycleStepIdentity,
  type FirstPartyServiceDescriptor,
  type FirstPartyServiceId,
  type ServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationResponse,
  type ServiceLifecycleRpc,
} from "@claxedo/service-contract"

import type { ServiceDeploymentStepStore } from "./deployment-step-store"
import {
  OptionalServiceLifecycleError,
  type OptionalServiceDeploymentDriver,
  type ServiceDeploymentStepIdentity,
} from "./lifecycle-coordinator"

export type CloudflareProvisionedServiceResources = Readonly<{
  databaseId: string
  bucketName?: string
}>

export interface CloudflareOptionalServiceResources {
  provision(input: Readonly<{
    serviceId: FirstPartyServiceId
    workerName: string
    databaseName: string
    bucketName?: string
  }>): Promise<CloudflareProvisionedServiceResources>
  inspect(input: Readonly<{
    serviceId: FirstPartyServiceId
    workerName: string
    databaseName: string
    bucketName?: string
  }>): Promise<CloudflareProvisionedServiceResources>
  retire(input: Readonly<{
    serviceId: FirstPartyServiceId
    workerName: string
    databaseName: string
    databaseId: string
    bucketName?: string
    retirementAuthorization: string
  }>): Promise<void>
}

export interface CloudflareOptionalServiceRelease {
  applyMigrations(input: Readonly<{
    serviceId: FirstPartyServiceId
    workerName: string
    databaseId: string
    bucketName?: string
  }>): Promise<void>
  deployDark(input: Readonly<{
    serviceId: FirstPartyServiceId
    workerName: string
    databaseId: string
    bucketName?: string
  }>): Promise<void>
  deployCoreBinding(input: Readonly<{
    serviceId: FirstPartyServiceId
    descriptor: FirstPartyServiceDescriptor
    workerName: string
    present: boolean
  }>): Promise<void>
  deleteServiceWorker(input: Readonly<{
    serviceId: FirstPartyServiceId
    workerName: string
    databaseId: string
    bucketName?: string
    retirementAuthorization: string
  }>): Promise<void>
}

export interface CloudflareOptionalServiceSafety {
  drainOperations(input: Readonly<{
    serviceId: FirstPartyServiceId
    environmentId: string
    deploymentId: string
    workflowOperationId: string
  }>): Promise<void>
  revokeBridge(input: Readonly<{
    serviceId: FirstPartyServiceId
    environmentId: string
    deploymentId: string
    workflowOperationId: string
  }>): Promise<void>
}

export type CloudflareOptionalServiceDeploymentInput = Readonly<{
  serviceId: FirstPartyServiceId
  workerName: string
  databaseName: string
  bucketName?: string
  retirementAuthorization?: string
  receipts: ServiceDeploymentStepStore
  resources: CloudflareOptionalServiceResources
  release: CloudflareOptionalServiceRelease
  safety: CloudflareOptionalServiceSafety
  management: ServiceLifecycleRpc
}>

function required(value: string, field: string) {
  if (!value || value.trim() !== value) throw new Error(`${field} must be a non-empty trimmed string`)
  return value
}

function requireResources(
  serviceId: FirstPartyServiceId,
  value: Readonly<Record<string, unknown>> | null,
): CloudflareProvisionedServiceResources {
  const databaseId = value?.databaseId
  if (
    typeof databaseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)
  ) {
    throw new Error("provision_resources did not persist a D1 database UUID")
  }
  const bucketName = value?.bucketName
  if (serviceId === "documents" && (typeof bucketName !== "string" || !bucketName)) {
    throw new Error("Documents provisioning did not persist its R2 bucket")
  }
  if (serviceId === "workgraph" && bucketName !== undefined) {
    throw new Error("WorkGraph provisioning unexpectedly owns an R2 bucket")
  }
  return Object.freeze({ databaseId, ...(typeof bucketName === "string" ? { bucketName } : {}) })
}

/**
 * Production lifecycle driver shared by the two first-party Cloudflare
 * services. Resource/release/safety ports are deliberately capability split:
 * the install identity cannot be replaced with a user or service credential.
 */
export class CloudflareOptionalServiceDeploymentDriver implements OptionalServiceDeploymentDriver {
  readonly serviceId: FirstPartyServiceId

  constructor(private readonly input: CloudflareOptionalServiceDeploymentInput) {
    this.serviceId = input.serviceId
    required(input.workerName, "workerName")
    required(input.databaseName, "databaseName")
    if (input.serviceId === "documents") required(input.bucketName ?? "", "bucketName")
    if (input.serviceId === "workgraph" && input.bucketName !== undefined) {
      throw new Error("WorkGraph driver cannot own a Documents bucket")
    }
  }

  applyLifecycle(request: ServiceLifecycleMutationRequest): Promise<ServiceLifecycleMutationResponse> {
    if (request.serviceId !== this.serviceId) {
      throw new OptionalServiceLifecycleError("driver_mismatch", "lifecycle request targets another service")
    }
    return this.input.management.applyLifecycle(request)
  }

  async runStep(rawIdentity: ServiceDeploymentStepIdentity, rawDescriptor: FirstPartyServiceDescriptor) {
    const descriptor = requireServiceDescriptor(rawDescriptor)
    if (rawIdentity.serviceId !== this.serviceId || descriptor.serviceId !== this.serviceId) {
      throw new OptionalServiceLifecycleError("driver_mismatch", "deployment step targets another service")
    }
    if (
      rawIdentity.environmentId !== descriptor.trust.environmentId ||
      rawIdentity.deploymentId !== descriptor.trust.deploymentId ||
      rawIdentity.bindingProvenance !== descriptor.trust.bindingProvenance
    ) {
      throw new OptionalServiceLifecycleError("provenance_mismatch", "deployment step provenance is not canonical")
    }
    const operationIntent = JSON.stringify({
      version: 1,
      identity: rawIdentity,
      descriptor,
      workerName: this.input.workerName,
      databaseName: this.input.databaseName,
      bucketName: this.input.bucketName ?? null,
      retirementAuthorization: this.input.retirementAuthorization ?? null,
    })
    const current = await this.input.receipts.begin(rawIdentity, operationIntent)
    if (current.state === "completed") return

    let result: Readonly<Record<string, unknown>> = Object.freeze({ completed: true })
    switch (rawIdentity.step) {
      case "provision_resources":
        result = requireResources(
          this.serviceId,
          await this.input.resources.provision({
            serviceId: this.serviceId,
            workerName: this.input.workerName,
            databaseName: this.input.databaseName,
            ...(this.input.bucketName ? { bucketName: this.input.bucketName } : {}),
          }),
        )
        break
      case "apply_migrations": {
        const resources = await this.provisioned(rawIdentity)
        await this.input.release.applyMigrations({
          serviceId: this.serviceId,
          workerName: this.input.workerName,
          ...resources,
        })
        break
      }
      case "deploy_dark": {
        const resources = await this.provisioned(rawIdentity)
        await this.input.release.deployDark({
          serviceId: this.serviceId,
          workerName: this.input.workerName,
          ...resources,
        })
        break
      }
      case "add_core_binding":
      case "remove_core_binding":
        await this.input.release.deployCoreBinding({
          serviceId: this.serviceId,
          descriptor,
          workerName: this.input.workerName,
          present: rawIdentity.step === "add_core_binding",
        })
        break
      case "drain_operations":
        await this.input.safety.drainOperations({
          serviceId: this.serviceId,
          environmentId: rawIdentity.environmentId,
          deploymentId: rawIdentity.deploymentId,
          workflowOperationId: rawIdentity.workflowOperationId,
        })
        break
      case "revoke_bridge":
        await this.input.safety.revokeBridge({
          serviceId: this.serviceId,
          environmentId: rawIdentity.environmentId,
          deploymentId: rawIdentity.deploymentId,
          workflowOperationId: rawIdentity.workflowOperationId,
        })
        break
      case "retire_resources": {
        const retirementAuthorization = required(
          this.input.retirementAuthorization ?? "",
          "retirementAuthorization",
        )
        const resources = requireResources(
          this.serviceId,
          await this.input.resources.inspect({
            serviceId: this.serviceId,
            workerName: this.input.workerName,
            databaseName: this.input.databaseName,
            ...(this.input.bucketName ? { bucketName: this.input.bucketName } : {}),
          }),
        )
        await this.input.release.deleteServiceWorker({
          serviceId: this.serviceId,
          workerName: this.input.workerName,
          ...resources,
          retirementAuthorization,
        })
        await this.input.resources.retire({
          serviceId: this.serviceId,
          workerName: this.input.workerName,
          databaseName: this.input.databaseName,
          ...resources,
          retirementAuthorization,
        })
        break
      }
    }
    await this.input.receipts.complete(rawIdentity, operationIntent, result)
  }

  private async provisioned(identity: ServiceDeploymentStepIdentity) {
    const root = {
      environmentId: identity.environmentId,
      deploymentId: identity.deploymentId,
      operationId: identity.workflowOperationId,
      occurredAt: identity.occurredAt,
    }
    const provisionOperationId = serviceLifecycleStepIdentity(root, "provision_resources").operationId
    const receipt = await this.input.receipts.get(identity, provisionOperationId)
    if (!receipt || receipt.state !== "completed") {
      throw new Error("optional-service resources have not completed provisioning")
    }
    return requireResources(this.serviceId, receipt.result)
  }
}
