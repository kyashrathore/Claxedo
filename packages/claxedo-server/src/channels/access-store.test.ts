import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ClaxedoDB } from "../platform/db"
import {
  boundAccountId,
  createSqliteChannelAccessStore,
  createSqliteChannelIdentityBindingStore,
} from "./access-store"

function clearTables() {
  const db = ClaxedoDB.raw()
  db.prepare("DELETE FROM claxedo_channel_pairing").run()
  db.prepare("DELETE FROM claxedo_channel_allow").run()
  db.prepare("DELETE FROM claxedo_channel_identity").run()
}

beforeEach(() => clearTables())
afterEach(() => clearTables())

describe("sqlite channel access store", () => {
  test("pending pairing round-trips and is pruned on expiry", async () => {
    let now = 1_000_000
    const store = createSqliteChannelAccessStore(() => now)
    await store.putPending({
      code: "ABCD2345",
      channel: "telegram",
      externalUserId: "42",
      createdAt: now,
      expiresAt: now + 3_600_000,
      lastSentAt: now,
    })
    expect(await store.findPending("ABCD2345")).toMatchObject({ externalUserId: "42" })
    expect(await store.findPendingBySender("telegram", "42")).toMatchObject({ code: "ABCD2345" })
    expect(await store.listPending("telegram")).toHaveLength(1)

    // Advance past expiry — lazy prune removes it on the next read.
    now += 3_700_000
    expect(await store.findPending("ABCD2345")).toBeUndefined()
    expect(await store.listPending("telegram")).toHaveLength(0)
  })

  test("allow persists and is queryable", async () => {
    const store = createSqliteChannelAccessStore()
    expect(await store.isAllowed("telegram", "42")).toBe(false)
    await store.allow("telegram", "42", "owner:1")
    expect(await store.isAllowed("telegram", "42")).toBe(true)
    // Idempotent upsert.
    await store.allow("telegram", "42", "owner:2")
    expect(await store.isAllowed("telegram", "42")).toBe(true)
    await store.disallow("telegram", "42")
    await store.disallow("telegram", "42")
    expect(await store.isAllowed("telegram", "42")).toBe(false)
  })
})

describe("sqlite identity binding store", () => {
  test("round-trips a binding and resolves the bound account", async () => {
    const store = createSqliteChannelIdentityBindingStore()
    expect(await store.get("telegram", "42")).toBeUndefined()
    expect(boundAccountId("telegram", "42")).toBeNull()

    await store.put({ channel: "telegram", externalUserId: "42", accountId: null, status: "pending", boundAt: 1, boundBy: "owner" })
    expect(await store.get("telegram", "42")).toMatchObject({ status: "pending", accountId: null })
    // Pending binding does not yet resolve an account.
    expect(boundAccountId("telegram", "42")).toBeNull()

    await store.put({ channel: "telegram", externalUserId: "42", accountId: "acct_9", status: "bound", boundAt: 2 })
    expect(await store.get("telegram", "42")).toMatchObject({ status: "bound", accountId: "acct_9" })
    expect(boundAccountId("telegram", "42")).toBe("acct_9")

    await store.put({ channel: "telegram", externalUserId: "42", accountId: "acct_9", status: "blocked", boundAt: 3 })
    expect(boundAccountId("telegram", "42")).toBeNull() // blocked → no account served
    await store.delete("telegram", "42")
    await store.delete("telegram", "42")
    expect(await store.get("telegram", "42")).toBeUndefined()
  })
})
