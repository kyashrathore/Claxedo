import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  requireServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationResponse,
  type ServiceLocalLifecycleState,
  type ServiceProbeRequest,
} from "@claxedo/service-contract"
import type {
  WorkGraphMutationRequest,
  WorkGraphMutationResult,
  WorkGraphServiceManagementRpc,
  WorkGraphServiceRpc,
} from "@claxedo/service-contract/workgraph"

import { WORKGRAPH_SERVICE_ENTRYPOINT, WORKGRAPH_SERVICE_SCHEMA_VERSION } from "./constants"

export type WorkGraphServiceLifecycle = Readonly<{
  environmentId: string
  deploymentId: string
  serviceBuildId: string
  state: ServiceLocalLifecycleState
  revision: number
}>

export interface WorkGraphServiceLifecycleReader {
  read(): Promise<WorkGraphServiceLifecycle | undefined>
}

export interface WorkGraphServiceLifecycleWriter {
  apply(request: ServiceLifecycleMutationRequest): Promise<ServiceLifecycleMutationResponse>
}

export class WorkGraphServiceLifecycleError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "protocol_mismatch"
      | "installation_mismatch"
      | "lifecycle_uninitialized"
      | "lifecycle_mismatch"
      | "service_disabled"
      | "runtime_unavailable",
    message: string,
  ) {
    super(message)
    this.name = "WorkGraphServiceLifecycleError"
  }
}

export type WorkGraphServiceLifecycleInput = Readonly<{
  environmentId: string
  deploymentId: string
  serviceBuildId: string
  bindingName: typeof SERVICE_BINDINGS.workgraph
  entrypoint: typeof WORKGRAPH_SERVICE_ENTRYPOINT
  bindingProvenance: string
  lifecycle: WorkGraphServiceLifecycleReader
  lifecycleWriter?: WorkGraphServiceLifecycleWriter
}>

export interface WorkGraphServiceRuntime {
  probe(): Promise<void>
  mutate(request: WorkGraphMutationRequest): Promise<WorkGraphMutationResult>
}

type WorkGraphServiceRpcInput = WorkGraphServiceLifecycleInput &
  Readonly<{
    runtime?: WorkGraphServiceRuntime
  }>

function requireConfiguredText(value: string, name: string) {
  if (!value || value.trim() !== value) {
    throw new WorkGraphServiceLifecycleError("lifecycle_mismatch", `${name} is not canonical`)
  }
  return value
}

function requireProbeRequest(request: ServiceProbeRequest, input: WorkGraphServiceRpcInput) {
  if (request.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new WorkGraphServiceLifecycleError("protocol_mismatch", "WorkGraph service protocol does not match")
  }
  if (!Number.isSafeInteger(request.installationRevision) || request.installationRevision <= 0) {
    throw new WorkGraphServiceLifecycleError("invalid_request", "installationRevision must be a positive safe integer")
  }
  if (request.environmentId !== input.environmentId || request.deploymentId !== input.deploymentId) {
    throw new WorkGraphServiceLifecycleError("installation_mismatch", "WorkGraph probe targets another installation")
  }
}

export async function readWorkGraphServiceLifecycle(input: WorkGraphServiceLifecycleInput) {
  requireConfiguredText(input.environmentId, "environmentId")
  requireConfiguredText(input.deploymentId, "deploymentId")
  requireConfiguredText(input.serviceBuildId, "serviceBuildId")
  requireConfiguredText(input.bindingProvenance, "bindingProvenance")
  const lifecycle = await input.lifecycle.read()
  if (!lifecycle) return undefined
  if (
    lifecycle.environmentId !== input.environmentId ||
    lifecycle.deploymentId !== input.deploymentId ||
    lifecycle.serviceBuildId !== input.serviceBuildId ||
    !Number.isSafeInteger(lifecycle.revision) ||
    lifecycle.revision <= 0
  ) {
    throw new WorkGraphServiceLifecycleError("lifecycle_mismatch", "WorkGraph lifecycle does not match its deployment")
  }
  return lifecycle
}

async function requireLifecycle(input: WorkGraphServiceLifecycleInput) {
  const lifecycle = await readWorkGraphServiceLifecycle(input)
  if (!lifecycle) {
    throw new WorkGraphServiceLifecycleError("lifecycle_uninitialized", "WorkGraph service lifecycle is uninitialized")
  }
  return lifecycle
}

function requireRuntime(input: WorkGraphServiceRpcInput) {
  if (!input.runtime) {
    throw new WorkGraphServiceLifecycleError("runtime_unavailable", "WorkGraph D1 runtime is not installed")
  }
  return input.runtime
}

export function createWorkGraphServiceRpc(
  input: WorkGraphServiceRpcInput,
): WorkGraphServiceRpc & WorkGraphServiceManagementRpc {
  requireConfiguredText(input.environmentId, "environmentId")
  requireConfiguredText(input.deploymentId, "deploymentId")
  requireConfiguredText(input.serviceBuildId, "serviceBuildId")
  requireConfiguredText(input.bindingProvenance, "bindingProvenance")
  if (input.bindingName !== SERVICE_BINDINGS.workgraph || input.entrypoint !== WORKGRAPH_SERVICE_ENTRYPOINT) {
    throw new WorkGraphServiceLifecycleError("lifecycle_mismatch", "WorkGraph binding identity is not canonical")
  }
  return {
    async applyLifecycle(rawRequest) {
      const request = requireServiceLifecycleMutationRequest(rawRequest)
      if (
        request.serviceId !== "workgraph" ||
        request.identity.environmentId !== input.environmentId ||
        request.identity.deploymentId !== input.deploymentId ||
        request.protocolVersion !== SERVICE_PROTOCOL_VERSION ||
        request.schemaVersion !== WORKGRAPH_SERVICE_SCHEMA_VERSION ||
        request.bindingName !== SERVICE_BINDINGS.workgraph ||
        request.entrypoint !== WORKGRAPH_SERVICE_ENTRYPOINT ||
        request.bindingProvenance !== input.bindingProvenance ||
        request.serviceBuildId !== input.serviceBuildId
      ) {
        throw new WorkGraphServiceLifecycleError(
          "installation_mismatch",
          "WorkGraph lifecycle mutation does not match immutable deployment provenance",
        )
      }
      if (!input.lifecycleWriter) {
        throw new WorkGraphServiceLifecycleError("runtime_unavailable", "WorkGraph lifecycle writer is unavailable")
      }
      return input.lifecycleWriter.apply(request)
    },
    async probe(request) {
      requireProbeRequest(request, input)
      const lifecycle = await requireLifecycle(input)
      if (request.installationRevision !== lifecycle.revision) {
        throw new WorkGraphServiceLifecycleError(
          "lifecycle_mismatch",
          "WorkGraph probe revision does not match service lifecycle",
        )
      }
      if (lifecycle.state === "enabling") {
        throw new WorkGraphServiceLifecycleError("service_disabled", "WorkGraph enablement is not committed")
      }
      if (lifecycle.state === "enabled") await requireRuntime(input).probe()
      return {
        serviceId: "workgraph",
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: WORKGRAPH_SERVICE_SCHEMA_VERSION,
        state: lifecycle.state,
        serviceBuildId: lifecycle.serviceBuildId,
      }
    },
    async mutate(request) {
      const lifecycle = await requireLifecycle(input)
      if (lifecycle.state !== "enabled") {
        throw new WorkGraphServiceLifecycleError("service_disabled", "WorkGraph service is installed but disabled")
      }
      return requireRuntime(input).mutate(request)
    },
  }
}
