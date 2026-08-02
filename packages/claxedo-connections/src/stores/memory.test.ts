import { describe, expect, test } from "bun:test"
import { connectionStoreConformance, credentialStoreConformance } from "../conformance/index.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./memory.js"

describe("memory ConnectionStorePort conformance", () => {
  for (const testCase of connectionStoreConformance(async () => ({ store: createMemoryConnectionStore() }))) {
    test(testCase.name, testCase.run)
  }
})

describe("memory CredentialStorePort conformance", () => {
  for (const testCase of credentialStoreConformance(async () => ({ store: createMemoryCredentialStore() }))) {
    test(testCase.name, testCase.run)
  }
})

describe("memory store isolation", () => {
  test("each store instance is independent", async () => {
    const first = createMemoryConnectionStore()
    const second = createMemoryConnectionStore()
    await first.upsert({
      id: "row",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    expect(await second.list()).toEqual([])
  })

  // Every read is a copy. A reader that keeps the live row can rename the
  // integration or move the connection to another owner from outside the store,
  // and a persistent store would never have honoured the write.
  test("mutating a returned row does not mutate the store", async () => {
    const store = createMemoryConnectionStore()
    await store.upsert({
      id: "row",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
      createdAt: 1,
      updatedAt: 1,
    })
    const [row] = await store.list()
    row!.integrationId = "mutated"
    expect((await store.getById("row"))?.integrationId).toBe("notion")

    const byId = await store.getById("row")
    byId!.integrationId = "mutated-by-id"
    expect((await store.getById("row"))?.integrationId).toBe("notion")

    const fetched = await store.get("notion")
    expect(fetched?.integrationId).toBe("notion")
    fetched!.integrationId = "mutated-by-get"
    expect((await store.getById("row"))?.integrationId).toBe("notion")
    expect((await store.get("notion"))?.integrationId).toBe("notion")
  })
})
