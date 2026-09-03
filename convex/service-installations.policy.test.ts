import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { anyApi } from "convex/server"
import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")
const serviceInstallations = (anyApi as any).serviceInstallations
const serviceToken = { service_token: "service-secret" }
const scope = { environmentId: "production", deploymentId: "deployment-1" }
const identity = (operationId: string, occurredAt: string) => ({ ...scope, operationId, occurredAt })
const descriptor = {
  serviceId: "workgraph" as const,
  protocolVersion: SERVICE_PROTOCOL_VERSION,
  schemaVersion: 1,
  state: "installed_disabled" as const,
  bindingName: SERVICE_BINDINGS.workgraph,
  entrypoint: "WorkGraphServiceV1",
  trust: { ...scope, bindingProvenance: "cloudflare-service:workgraph-production" },
}

beforeEach(() => vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", serviceToken.service_token))
afterEach(() => vi.unstubAllEnvs())

describe("Convex service installation ledger", () => {
  test("executes a deployment-scoped lifecycle with exact idempotency and conflicting-reuse denial", async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(serviceInstallations.list, { ...serviceToken, ...scope })).resolves.toEqual([])

    const registerArgs = {
      ...serviceToken,
      identity: identity("op-register", "2026-08-28T01:00:00Z"),
      descriptor,
    }
    const registered = await t.mutation(serviceInstallations.registerDisabled, registerArgs)
    expect(registered).toEqual({ descriptor, revision: 1 })
    await expect(t.mutation(serviceInstallations.registerDisabled, registerArgs)).resolves.toEqual(registered)
    await expect(
      t.mutation(serviceInstallations.registerDisabled, {
        ...registerArgs,
        descriptor: { ...descriptor, entrypoint: "DifferentEntrypoint" },
      }),
    ).rejects.toThrow(/operation id was already used/)

    const probeArgs = {
      ...serviceToken,
      identity: identity("op-probe", "2026-08-28T01:01:00Z"),
      serviceId: "workgraph",
      expectedRevision: 1,
      probe: { status: "ready", checkedAt: "2026-08-28T01:00:59Z", serviceBuildId: "build-a" },
    }
    const probed = await t.mutation(serviceInstallations.recordProbe, probeArgs)
    await expect(t.mutation(serviceInstallations.recordProbe, probeArgs)).resolves.toEqual(probed)
    await expect(
      t.mutation(serviceInstallations.recordProbe, {
        ...probeArgs,
        probe: { ...probeArgs.probe, serviceBuildId: "build-b" },
      }),
    ).rejects.toThrow(/operation id was already used/)

    const enableArgs = {
      ...serviceToken,
      identity: identity("op-enable", "2026-08-28T01:02:00Z"),
      serviceId: "workgraph",
      expectedRevision: 2,
      state: "enabled",
    }
    const enabled = await t.mutation(serviceInstallations.transition, enableArgs)
    await expect(t.mutation(serviceInstallations.transition, enableArgs)).resolves.toEqual(enabled)

    const disableArgs = {
      ...serviceToken,
      identity: identity("op-disable", "2026-08-28T01:03:00Z"),
      serviceId: "workgraph",
      expectedRevision: 3,
      state: "installed_disabled",
    }
    await t.mutation(serviceInstallations.transition, disableArgs)
    const uninstallArgs = {
      ...serviceToken,
      identity: identity("op-uninstall", "2026-08-28T01:04:00Z"),
      serviceId: "workgraph",
      expectedRevision: 4,
    }
    await t.mutation(serviceInstallations.uninstall, uninstallArgs)
    await expect(t.mutation(serviceInstallations.uninstall, uninstallArgs)).resolves.toBeNull()
    await expect(
      t.mutation(serviceInstallations.uninstall, { ...uninstallArgs, expectedRevision: 5 }),
    ).rejects.toThrow(/operation id was already used/)
    await expect(t.query(serviceInstallations.get, { ...serviceToken, ...scope, serviceId: "workgraph" })).resolves.toBeNull()
    expect((await t.query(serviceInstallations.audit, { ...serviceToken, ...scope })).map((event: any) => event.action)).toEqual([
      "register_disabled",
      "record_probe",
      "enable",
      "disable",
      "uninstall",
    ])
  })

  test("fails closed for the wrong service token and keeps deployments isolated", async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(serviceInstallations.list, { service_token: "wrong", ...scope })).rejects.toThrow("Unauthenticated")
    await t.mutation(serviceInstallations.registerDisabled, {
      ...serviceToken,
      identity: identity("op-register", "2026-08-28T01:00:00Z"),
      descriptor,
    })
    await expect(
      t.query(serviceInstallations.list, {
        ...serviceToken,
        environmentId: scope.environmentId,
        deploymentId: "deployment-2",
      }),
    ).resolves.toEqual([])
  })
})
