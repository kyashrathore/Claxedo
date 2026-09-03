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
  serviceId: "documents",
  protocolVersion: SERVICE_PROTOCOL_VERSION,
  schemaVersion: 1,
  state: "installed_disabled",
  bindingName: SERVICE_BINDINGS.documents,
  entrypoint: "DocumentsServiceV1",
  trust: { ...scope, bindingProvenance: "cloudflare-service:documents-prod" },
} satisfies FirstPartyServiceDescriptor

describe("D1 service installation ledger", () => {
  test("keeps absence canonical and executes the guarded enable/disable/uninstall lifecycle", async () => {
    const { store } = await createStore()
    expect(await store.list(scope)).toEqual([])

    const registered = await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)
    expect(registered).toEqual({ descriptor, revision: 1 })
    await expect(
      store.transition(identity("op-enable-too-soon", "2026-08-28T01:01:00Z"), "documents", 1, "enabled"),
    ).rejects.toMatchObject({ code: "probe_required" })

    const unhealthy = await store.recordProbe(identity("op-unhealthy", "2026-08-28T01:01:30Z"), "documents", 1, {
      status: "unhealthy",
      checkedAt: "2026-08-28T01:01:29Z",
      serviceBuildId: "sha256:unhealthy-build",
    })
    await expect(
      store.transition(identity("op-enable-unhealthy", "2026-08-28T01:01:31Z"), "documents", unhealthy.revision, "enabled"),
    ).rejects.toMatchObject({ code: "probe_required" })

    const probed = await store.recordProbe(identity("op-probe", "2026-08-28T01:02:00Z"), "documents", 2, {
      status: "ready",
      checkedAt: "2026-08-28T01:01:59Z",
      serviceBuildId: "sha256:service-build",
    })
    expect(probed).toMatchObject({ revision: 3, descriptor: { state: "installed_disabled" } })

    const enabled = await store.transition(identity("op-enable", "2026-08-28T01:03:00Z"), "documents", 3, "enabled")
    expect(enabled).toMatchObject({ revision: 4, descriptor: { state: "enabled" } })
    await expect(
      store.transition(identity("op-stale-disable", "2026-08-28T01:04:00Z"), "documents", 3, "installed_disabled"),
    ).rejects.toMatchObject({ code: "revision_conflict" })

    const disabled = await store.transition(
      identity("op-disable", "2026-08-28T01:05:00Z"),
      "documents",
      4,
      "installed_disabled",
    )
    expect(disabled.revision).toBe(5)
    await store.uninstall(identity("op-uninstall", "2026-08-28T01:06:00Z"), "documents", 5)
    expect(await store.get(scope, "documents")).toBeNull()
    expect((await store.audit(scope)).map((event) => event.action)).toEqual([
      "register_disabled",
      "record_probe",
      "record_probe",
      "enable",
      "disable",
      "uninstall",
    ])
  })

  test("skips a retired service's row instead of failing the whole catalog read", async () => {
    // `service_installations`'s CHECK constraint is part of an append-only
    // migration ledger, so it still admits `workgraph` — a service this build
    // no longer implements. `list()` is read on EVERY signed request through
    // `serviceCatalog()`, so validating the whole set would turn one orphaned
    // row from a retired install into a 500 on the app shell for that entire
    // deployment. Residue must not be able to take down a deployment that never
    // used it.
    const { database, store } = await createStore()
    const registered = await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)
    await database
      .prepare(
        `insert into service_installations (
          environment_id, deployment_id, service_id, protocol_version, schema_version,
          lifecycle_state, binding_name, entrypoint, binding_provenance, revision,
          last_operation_id, updated_at
        ) values (?, ?, 'workgraph', 'claxedo.service.v1', 1, 'installed_disabled', 'WORKGRAPH_SERVICE',
          'WorkGraphServiceV1', 'cloudflare-service:retired', 1, 'op-retired', ?)`,
      )
      .bind(scope.environmentId, scope.deploymentId, "2026-08-28T00:00:00Z")
      .run()

    const listed = await store.list(scope)
    expect(listed).toEqual([registered])
    // The surviving row is still validated in full — the filter is not a bypass.
    expect(listed[0]?.descriptor.serviceId).toBe("documents")
  })

  test("makes exact workflow retries idempotent and rejects operation reuse", async () => {
    const { store } = await createStore()
    const first = await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)
    expect(await store.registerDisabled(identity("op-register", "2026-08-28T01:00:00Z"), descriptor)).toEqual(first)
    await expect(
      store.recordProbe(identity("op-register", "2026-08-28T01:01:00Z"), "documents", 1, {
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
    const probed = await store.recordProbe(probeIdentity, "documents", 1, probe)
    expect(await store.recordProbe(probeIdentity, "documents", 1, probe)).toEqual(probed)
    await expect(
      store.recordProbe(probeIdentity, "documents", 1, { ...probe, serviceBuildId: "build-b" }),
    ).rejects.toMatchObject({ code: "operation_conflict" })

    const enabled = await store.transition(identity("op-enable", "2026-08-28T01:03:00Z"), "documents", 2, "enabled")
    const disabled = await store.transition(
      identity("op-disable", "2026-08-28T01:04:00Z"),
      "documents",
      enabled.revision,
      "installed_disabled",
    )
    const uninstallIdentity = identity("op-uninstall", "2026-08-28T01:05:00Z")
    await store.uninstall(uninstallIdentity, "documents", disabled.revision)
    await expect(store.uninstall(uninstallIdentity, "documents", disabled.revision)).resolves.toBeUndefined()
    await expect(store.uninstall(uninstallIdentity, "documents", disabled.revision + 1)).rejects.toMatchObject({
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
