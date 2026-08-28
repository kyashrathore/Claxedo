import type { ServiceDeploymentStep, ServiceDeploymentStepIdentity } from "./lifecycle-coordinator"

export type ServiceDeploymentStepReceipt = Readonly<{
  identity: ServiceDeploymentStepIdentity
  operationIntent: string
  state: "started" | "completed"
  result: Readonly<Record<string, unknown>> | null
}>

export interface ServiceDeploymentStepStore {
  begin(
    identity: ServiceDeploymentStepIdentity,
    operationIntent: string,
  ): Promise<ServiceDeploymentStepReceipt>
  complete(
    identity: ServiceDeploymentStepIdentity,
    operationIntent: string,
    result: Readonly<Record<string, unknown>>,
  ): Promise<ServiceDeploymentStepReceipt>
  get(
    scope: Readonly<{ environmentId: string; deploymentId: string }>,
    stepOperationId: string,
  ): Promise<ServiceDeploymentStepReceipt | null>
}

export class ServiceDeploymentStepError extends Error {
  constructor(
    public readonly code: "invalid_identity" | "operation_conflict" | "completion_conflict",
    message: string,
  ) {
    super(message)
    this.name = "ServiceDeploymentStepError"
  }
}

export function requireDeploymentStepIdentity(identity: ServiceDeploymentStepIdentity) {
  for (const field of [
    "environmentId",
    "deploymentId",
    "workflowOperationId",
    "stepOperationId",
    "occurredAt",
    "serviceBuildId",
    "bindingProvenance",
  ] as const) {
    const value = identity[field]
    if (!value || value.trim() !== value) {
      throw new ServiceDeploymentStepError("invalid_identity", `${field} must be a non-empty trimmed string`)
    }
  }
  const steps = new Set<ServiceDeploymentStep>([
    "provision_resources",
    "apply_migrations",
    "deploy_dark",
    "add_core_binding",
    "drain_operations",
    "revoke_bridge",
    "remove_core_binding",
    "retire_resources",
  ])
  if (!steps.has(identity.step)) {
    throw new ServiceDeploymentStepError("invalid_identity", "unknown optional-service deployment step")
  }
  if (identity.serviceId !== "workgraph" && identity.serviceId !== "documents") {
    throw new ServiceDeploymentStepError("invalid_identity", "unknown optional service")
  }
  return identity
}
