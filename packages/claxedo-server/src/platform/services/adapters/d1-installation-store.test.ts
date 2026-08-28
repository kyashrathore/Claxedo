import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { SERVICE_BINDINGS, SERVICE_PROTOCOL_VERSION, type FirstPartyServiceDescriptor } from "@claxedo/service-contract"

import { D1ServiceInstallationStore } from "./d1-installation-store"

const MIGRATION_PATH = fileURLToPath(
  new URL("../../../../migrations/control-plane/0001_service_installations.sql", import.meta.url),
)
const active: Miniflare[] = []

async function createStore() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  const migration = (await readFile(MIGRATION_PATH, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run()
  }
  return { database, store: new D1ServiceInstallationStore(database) }
}

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const scope = { environmentId: "production", deploymentId: "deployment-1" }
const identity = (operationId: string, occurredAt: string) => ({ ...scope, operationId, occurredAt })
const descriptor = {
  serviceId: "workgraph",
  protocolVersion: SERVICE_PROTOCOL_VERSION,
  schemaVersion: 1,
  state: "installed_disabled",
  bindingName: SERVICE_BINDINGS.workgraph,
  entrypoint: "WorkGraphServiceV1",
  trust: { ...scope, bindingProvenance: "cloudflare-service:workgraph-prod" },
} satisfies FirstPartyServiceDescriptor

describe("D1 service installation ledger", () => {
  test("keeps absence canonical and executes the guarded enable/disable/uninstall lifecycle", async () => {
    const { store } = await createStore()
    expect(await store.list(scope)).toEqual([])

    const registered = await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)
    expect(registered).toEqual({ descriptor, revision: 1 })
    await expect(
      store.transition(identity("op-enable-too-soon", "2026-08-28T01:01:00Z"), "workgraph", 1, "enabled"),
    ).rejects.toMatchObject({ code: "probe_required" })

    const unhealthy = await store.recordProbe(identity("op-unhealthy", "2026-08-28T01:01:30Z"), "workgraph", 1, {
      status: "unhealthy",
      checkedAt: "2026-08-28T01:01:29Z",
      serviceBuildId: "sha256:unhealthy-build",
    })
    await expect(
      store.transition(identity("op-enable-unhealthy", "2026-08-28T01:01:31Z"), "workgraph", unhealthy.revision, "enabled"),
    ).rejects.toMatchObject({ code: "probe_required" })

    const probed = await store.recordProbe(identity("op-probe", "2026-08-28T01:02:00Z"), "workgraph", 2, {
      status: "ready",
      checkedAt: "2026-08-28T01:01:59Z",
      serviceBuildId: "sha256:service-build",
    })
    expect(probed).toMatchObject({ revision: 3, descriptor: { state: "installed_disabled" } })

    const enabled = await store.transition(identity("op-enable", "2026-08-28T01:03:00Z"), "workgraph", 3, "enabled")
    expect(enabled).toMatchObject({ revision: 4, descriptor: { state: "enabled" } })
    await expect(
      store.transition(identity("op-stale-disable", "2026-08-28T01:04:00Z"), "workgraph", 3, "installed_disabled"),
    ).rejects.toMatchObject({ code: "revision_conflict" })

    const disabled = await store.transition(
      identity("op-disable", "2026-08-28T01:05:00Z"),
      "workgraph",
      4,
      "installed_disabled",
    )
    expect(disabled.revision).toBe(5)
    await store.uninstall(identity("op-uninstall", "2026-08-28T01:06:00Z"), "workgraph", 5)
    expect(await store.get(scope, "workgraph")).toBeNull()
    expect((await store.audit(scope)).map((event) => event.action)).toEqual([
      "register_disabled",
      "record_probe",
      "record_probe",
      "enable",
      "disable",
      "uninstall",
    ])
  })

  test("makes exact workflow retries idempotent and rejects operation reuse", async () => {
    const { store } = await createStore()
    const first = await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)
    expect(await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)).toEqual(first)
    await expect(
      store.recordProbe(identity("op-register", "2026-08-28T01:01:00Z"), "workgraph", 1, {
        status: "ready",
        checkedAt: "2026-08-28T01:01:00Z",
        serviceBuildId: "build",
      }),
    ).rejects.toMatchObject({ code: "operation_conflict" })

    const probeIdentity = identity("op-probe", "2026-08-28T01:02:00Z")
    const probe = {
      status: "ready" as const,
      checkedAt: "2026-08-28T01:01:59Z",
      serviceBuildId: "build-a",
    }
    const probed = await store.recordProbe(probeIdentity, "workgraph", 1, probe)
    expect(await store.recordProbe(probeIdentity, "workgraph", 1, probe)).toEqual(probed)
    await expect(
      store.recordProbe(probeIdentity, "workgraph", 1, { ...probe, serviceBuildId: "build-b" }),
    ).rejects.toMatchObject({ code: "operation_conflict" })

    const enabled = await store.transition(identity("op-enable", "2026-08-28T01:03:00Z"), "workgraph", 2, "enabled")
    const disabled = await store.transition(
      identity("op-disable", "2026-08-28T01:04:00Z"),
      "workgraph",
      enabled.revision,
      "installed_disabled",
    )
    const uninstallIdentity = identity("op-uninstall", "2026-08-28T01:05:00Z")
    await store.uninstall(uninstallIdentity, "workgraph", disabled.revision)
    await expect(store.uninstall(uninstallIdentity, "workgraph", disabled.revision)).resolves.toBeUndefined()
    await expect(store.uninstall(uninstallIdentity, "workgraph", disabled.revision + 1)).rejects.toMatchObject({
      code: "operation_conflict",
    })
  })

  test("binds descriptors to the deployment identity and preserves audit rows as append-only", async () => {
    const { database, store } = await createStore()
    await expect(
      store.registerDisabled(identity("op-wrong", "2026-08-28T01:00:00Z"), {
        ...descriptor,
        trust: { ...descriptor.trust, deploymentId: "another-deployment" },
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" })

    await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)
    await expect(database.prepare("delete from service_installation_audit").run()).rejects.toThrow(/append-only/)
  })
})
