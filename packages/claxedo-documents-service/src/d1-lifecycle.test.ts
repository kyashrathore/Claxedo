import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"

import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  serviceLifecycleStepIdentity,
  type ServiceLifecycleMutationAction,
} from "@claxedo/service-contract"

import { D1DocumentsServiceLifecycleStore } from "./d1-lifecycle"

const active: Miniflare[] = []
const migrationPath = fileURLToPath(new URL("../migrations/0001_service_lifecycle.sql", import.meta.url))
const identity = {
  environmentId: "environment-staging",
  deploymentId: "deployment-staging",
  serviceBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
}

async function createStore() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["DOCUMENTS_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("DOCUMENTS_DB")
  const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run()
  }
  return { database, store: new D1DocumentsServiceLifecycleStore(database, identity) }
}

function request(action: ServiceLifecycleMutationAction, operationId: string, expectedRevision: number) {
  return {
    action,
    identity: { ...identity, operationId, occurredAt: `2026-08-28T00:00:0${expectedRevision}Z` },
    serviceId: "documents" as const,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    bindingName: SERVICE_BINDINGS.documents,
    entrypoint: "DocumentsServiceV1",
    bindingProvenance: "cloudflare-service:documents-staging",
    serviceBuildId: identity.serviceBuildId,
    expectedRevision,
  }
}

function initializeRequest(rootOperationId: string) {
  const value = request("initialize_disabled", rootOperationId, 0)
  return { ...value, identity: serviceLifecycleStepIdentity(value.identity, "initialize") }
}

afterEach(async () => Promise.all(active.splice(0).map((instance) => instance.dispose())))

describe("Documents D1 lifecycle state", () => {
  test("advances an exact crash-resumable ledger without claiming installation during migration", async () => {
    const { database, store } = await createStore()
    await expect(store.read()).resolves.toBeUndefined()

    const ownerInitialization = initializeRequest("install-owner")
    const initialized = await store.apply(ownerInitialization)
    await expect(store.apply(ownerInitialization)).resolves.toEqual(initialized)
    await expect(
      store.apply({ ...ownerInitialization, serviceBuildId: "other" }),
    ).rejects.toThrow(/reused/)
    await expect(store.apply(request("record_probe", "probe", 1))).resolves.toMatchObject({
      state: "installed_disabled",
      revision: 2,
    })
    await expect(store.apply(request("prepare_enable", "enable", 2))).resolves.toMatchObject({
      state: "enabling",
      revision: 3,
    })
    await expect(store.apply(request("commit_enable", "enable-commit", 3))).resolves.toMatchObject({
      state: "enabled",
      revision: 3,
    })
    await expect(store.apply(request("disable", "disable", 3))).resolves.toMatchObject({
      state: "installed_disabled",
      revision: 4,
    })
    const removed = await store.apply(request("uninstall", "uninstall", 4))
    await expect(store.apply(request("uninstall", "uninstall", 4))).resolves.toEqual(removed)
    await expect(store.read()).resolves.toBeUndefined()

    await expect(database.prepare("delete from documents_service_lifecycle_audit").run()).rejects.toThrow(/append-only/)
  })

  test("keeps the committed initializer authoritative across a pre-registration crash", async () => {
    const { database, store } = await createStore()
    const ownerInitialization = initializeRequest("install-owner")
    const initialized = await store.apply(ownerInitialization)

    await expect(store.apply(initializeRequest("install-takeover"))).rejects.toThrow(/precondition/)
    await expect(store.apply(ownerInitialization)).resolves.toEqual(initialized)
    await expect(
      database
        .prepare(
          `select initializer_operation_id as initializerOperationId
           from documents_service_lifecycle where singleton = 1`,
        )
        .first(),
    ).resolves.toEqual({ initializerOperationId: ownerInitialization.identity.operationId })
    await expect(
      database.prepare(`select count(*) as count from documents_service_lifecycle_audit`).first(),
    ).resolves.toEqual({ count: 1 })
  })
})
