import { WorkerEntrypoint } from "cloudflare:workers"

import type { ServiceProbeRequest, ServiceProbeResponse } from "@claxedo/service-contract"
import type {
  WorkGraphMutationRequest,
  WorkGraphMutationResult,
  WorkGraphServiceManagementRpc,
  WorkGraphServiceRpc,
} from "@claxedo/service-contract/workgraph"

import { WorkGraphSettlerRuntime, WorkGraphWakeLaneRuntime, runWorkGraphServiceScheduled } from "./background"
import { D1WorkGraphServiceLifecycleStore } from "./d1-lifecycle"
import type { WorkGraphServiceEnv } from "./env"
import { createWorkGraphServiceRpc, type WorkGraphServiceLifecycleInput } from "./service"

function lifecycleInput(env: WorkGraphServiceEnv): WorkGraphServiceLifecycleInput {
  if (env.CLAXEDO_WORKGRAPH_INITIAL_STATE !== "installed_disabled") {
    throw new Error("WorkGraph service must be deployed initially disabled")
  }
  const identity = {
    environmentId: env.CLAXEDO_WORKGRAPH_ENVIRONMENT_ID,
    deploymentId: env.CLAXEDO_WORKGRAPH_DEPLOYMENT_ID,
    serviceBuildId: env.CLAXEDO_WORKGRAPH_SERVICE_BUILD_ID,
    bindingName: "WORKGRAPH_SERVICE" as const,
    entrypoint: "WorkGraphServiceV1" as const,
    bindingProvenance: env.CLAXEDO_WORKGRAPH_BINDING_PROVENANCE,
  }
  const lifecycle = new D1WorkGraphServiceLifecycleStore(env.WORKGRAPH_DB, identity)
  return {
    ...identity,
    lifecycle,
    lifecycleWriter: lifecycle,
  }
}

export class WorkGraphServiceV1 extends WorkerEntrypoint<WorkGraphServiceEnv> implements WorkGraphServiceRpc {
  mutate(request: WorkGraphMutationRequest): Promise<WorkGraphMutationResult> {
    return createWorkGraphServiceRpc(lifecycleInput(this.env)).mutate(request)
  }
}

export class WorkGraphServiceManagementV1
  extends WorkerEntrypoint<WorkGraphServiceEnv>
  implements WorkGraphServiceManagementRpc
{
  applyLifecycle(request: Parameters<WorkGraphServiceManagementRpc["applyLifecycle"]>[0]) {
    return createWorkGraphServiceRpc(lifecycleInput(this.env)).applyLifecycle(request)
  }

  probe(request: ServiceProbeRequest): Promise<ServiceProbeResponse> {
    return createWorkGraphServiceRpc(lifecycleInput(this.env)).probe(request)
  }
}

export class WorkGraphSettler {
  private readonly runtime: WorkGraphSettlerRuntime

  constructor(_state: DurableObjectState, env: WorkGraphServiceEnv) {
    this.runtime = new WorkGraphSettlerRuntime(lifecycleInput(env))
  }

  fetch(request: Request) {
    return this.runtime.fetch(request)
  }

  alarm() {
    return this.runtime.alarm()
  }
}

export class WorkGraphWakeLane {
  private readonly runtime: WorkGraphWakeLaneRuntime

  constructor(_state: DurableObjectState, env: WorkGraphServiceEnv) {
    this.runtime = new WorkGraphWakeLaneRuntime(lifecycleInput(env))
  }

  fetch(request: Request) {
    return this.runtime.fetch(request)
  }

  alarm() {
    return this.runtime.alarm()
  }
}

export default {
  fetch() {
    return new Response("Not Found", { status: 404 })
  },
  scheduled(controller: ScheduledController, env: WorkGraphServiceEnv) {
    return runWorkGraphServiceScheduled(controller.cron, lifecycleInput(env))
  },
} satisfies ExportedHandler<WorkGraphServiceEnv>
