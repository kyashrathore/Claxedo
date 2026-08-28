import { describe, expect, test, vi } from "vitest"

import { SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import { WorkGraphServiceLifecycleError, createWorkGraphServiceRpc } from "./service"

const deployment = {
  environmentId: "environment-staging",
  deploymentId: "deployment-staging",
  serviceBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  bindingName: "WORKGRAPH_SERVICE" as const,
  entrypoint: "WorkGraphServiceV1" as const,
  bindingProvenance: "cloudflare-service:workgraph-staging",
}

describe("WorkGraph private service entrypoint", () => {
  test("probes as installed-disabled and refuses every mutation before runtime work", async () => {
    const service = createWorkGraphServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "installed_disabled", revision: 1 }),
      },
    })

    await expect(
      service.probe({
        environmentId: deployment.environmentId,
        deploymentId: deployment.deploymentId,
        installationRevision: 1,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({
      serviceId: "workgraph",
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      schemaVersion: 1,
      state: "installed_disabled",
      serviceBuildId: deployment.serviceBuildId,
    })

    await expect(
      service.mutate({
        operationId: "operation-1",
        operationGrant: "opaque-core-grant",
        organizationId: "organization-1",
        actorId: "actor-1",
        mutation: "record_work_item_transition",
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "service_disabled" })
  })

  test("rejects a probe for another installation before exposing lifecycle state", async () => {
    const service = createWorkGraphServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "installed_disabled", revision: 1 }),
      },
    })

    await expect(
      service.probe({
        environmentId: deployment.environmentId,
        deploymentId: "another-deployment",
        installationRevision: 1,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
      }),
    ).rejects.toBeInstanceOf(WorkGraphServiceLifecycleError)
  })

  test("rejects a stale installation revision instead of probing another lifecycle generation", async () => {
    const service = createWorkGraphServiceRpc({
      ...deployment,
      lifecycle: {
        read: async () => ({ ...deployment, state: "installed_disabled", revision: 2 }),
      },
    })

    await expect(
      service.probe({
        environmentId: deployment.environmentId,
        deploymentId: deployment.deploymentId,
        installationRevision: 1,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
      }),
    ).rejects.toMatchObject({ code: "lifecycle_mismatch" })
  })

  test("reports enabled as unhealthy until a real runtime passes its health probe", async () => {
    const request = {
      environmentId: deployment.environmentId,
      deploymentId: deployment.deploymentId,
      installationRevision: 2,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
    }
    const lifecycle = {
      read: async () => ({ ...deployment, state: "enabled" as const, revision: 2 }),
    }

    await expect(createWorkGraphServiceRpc({ ...deployment, lifecycle }).probe(request)).rejects.toMatchObject({
      code: "runtime_unavailable",
    })

    const runtime = {
      probe: vi.fn(async () => undefined),
      mutate: vi.fn(async (operation: { operationId: string }) => ({
        operationId: operation.operationId,
        committed: true,
        revision: "revision-1",
      })),
    }
    const healthy = createWorkGraphServiceRpc({ ...deployment, lifecycle, runtime })
    await expect(healthy.probe(request)).resolves.toMatchObject({ state: "enabled" })
    expect(runtime.probe).toHaveBeenCalledTimes(1)
    await expect(
      healthy.mutate({
        operationId: "operation-1",
        operationGrant: "opaque-core-grant",
        organizationId: "organization-1",
        actorId: "actor-1",
        mutation: "record_work_item_transition",
        payload: {},
      }),
    ).resolves.toEqual({ operationId: "operation-1", committed: true, revision: "revision-1" })
  })
})
