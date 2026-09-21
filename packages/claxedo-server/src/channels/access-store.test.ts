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

/**
 * The rows a database repaired from before the boundary is holding: written
 * by a producer that named no version, so they carry the column default. The
 * store's own writers cannot produce them.
 */
function seedPreBoundary() {
  const db = ClaxedoDB.raw()
  db.prepare(
    "INSERT INTO claxedo_channel_allow (channel, external_user_id, approved_by, approved_at, identity_version) VALUES ('telegram', '12345', 'owner', 1, 0)",
  ).run()
  db.prepare(
    "INSERT INTO claxedo_channel_identity (channel, external_user_id, account_id, status, bound_at, bound_by, identity_version) VALUES ('telegram', '12345', 'acct_handle_holder', 'bound', 1, 'owner', 0)",
  ).run()
  db.prepare(
    "INSERT INTO claxedo_channel_pairing (code, channel, external_user_id, created_at, expires_at, last_sent_at, identity_version) VALUES ('LEGACY23', 'telegram', '999', 1, 9999999999999, 1, 0)",
  ).run()
}

function storedVersions(table: string) {
  return ClaxedoDB.raw()
    .prepare(`SELECT external_user_id, identity_version FROM ${table} ORDER BY external_user_id`)
    .all()
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

  test("deleting a pending code reports whether this call consumed a live row", async () => {
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
    expect(await store.deletePending("ABCD2345")).toBe(true)
    expect(await store.deletePending("ABCD2345")).toBe(false)
    expect(await store.findPending("ABCD2345")).toBeUndefined()

    await store.putPending({
      code: "EXPD2345",
      channel: "telegram",
      externalUserId: "43",
      createdAt: now,
      expiresAt: now + 10,
      lastSentAt: now,
    })
    now += 11
    expect(await store.deletePending("EXPD2345")).toBe(false)
    expect(await store.findPending("EXPD2345")).toBeUndefined()
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

describe("pre-boundary channel projection rows", () => {
  test("admit nobody, hand back no pairing code, and resolve no account", async () => {
    seedPreBoundary()
    const access = createSqliteChannelAccessStore(() => 1000)
    const bindings = createSqliteChannelIdentityBindingStore()

    expect(await access.isAllowed("telegram", "12345")).toBe(false)
    expect(await access.findPending("LEGACY23")).toBeUndefined()
    expect(await access.findPendingBySender("telegram", "999")).toBeUndefined()
    expect(await access.listPending("telegram")).toEqual([])
    expect(await bindings.get("telegram", "12345")).toBeUndefined()
    expect(await bindings.listBoundForAccount("acct_handle_holder")).toEqual([])
    expect(boundAccountId("telegram", "12345")).toBeNull()
  })

  test("are replaced, not blocked, when the account that owns the id is approved", async () => {
    seedPreBoundary()
    const access = createSqliteChannelAccessStore(() => 1000)
    const bindings = createSqliteChannelIdentityBindingStore()

    await access.allow("telegram", "12345", "admin:route")
    await bindings.put({
      channel: "telegram",
      externalUserId: "12345",
      accountId: "acct_account_holder",
      status: "bound",
      boundAt: 2,
      boundBy: "actor:account-holder",
    })

    expect(await access.isAllowed("telegram", "12345")).toBe(true)
    expect(boundAccountId("telegram", "12345")).toBe("acct_account_holder")
    expect(storedVersions("claxedo_channel_allow")).toEqual([{ external_user_id: "12345", identity_version: 1 }])
    expect(storedVersions("claxedo_channel_identity")).toEqual([{ external_user_id: "12345", identity_version: 1 }])
  })

  test("a pairing code issued now is current even where a legacy code for the sender is still stored", async () => {
    seedPreBoundary()
    const access = createSqliteChannelAccessStore(() => 1000)

    await access.putPending({
      code: "FRESH234",
      channel: "telegram",
      externalUserId: "999",
      createdAt: 1000,
      expiresAt: 1_000_000,
      lastSentAt: 1000,
    })

    expect(await access.findPendingBySender("telegram", "999")).toMatchObject({ code: "FRESH234" })
    expect(await access.listPending("telegram")).toHaveLength(1)
    expect(storedVersions("claxedo_channel_pairing")).toEqual([
      { external_user_id: "999", identity_version: 0 },
      { external_user_id: "999", identity_version: 1 },
    ])
  })
})
