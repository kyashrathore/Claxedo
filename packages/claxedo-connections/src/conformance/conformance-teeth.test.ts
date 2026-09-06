/**
 * Proof that the store-port conformance suites detect the divergences they
 * claim to pin.
 *
 * A suite is a security artifact here — it is the only thing keeping four
 * adapters agreeing about partition isolation and the two secret seams — and a
 * suite whose assertion was weakened is indistinguishable from a suite that is
 * passing honestly. So every pinned case is paired below with a store that
 * breaks exactly what the case names, and the case is required to fail against
 * it.
 *
 * The pairing is positional: mutant `i` is checked against case `i` of the
 * scope list, and the counts are asserted to match. A case added to a scope
 * without a mutant fails this file rather than joining the suite unproven.
 */
import { describe, expect, test } from "bun:test"
import {
  CONNECTION_STORE_CONFORMANCE_SCOPE,
  CREDENTIAL_STORE_CONFORMANCE_SCOPE,
  connectionStoreCoreConformance,
  connectionStorePartitionConformance,
  credentialStoreConformance,
} from "./index.js"
import { CONFORMANCE_OWNERS } from "./connection-store.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "../stores/memory.js"
import type { ConnectionRow, ConnectionStorePort, CredentialRecord, CredentialStorePort } from "../types.js"

type Mutant<Port> = Readonly<{
  /** What this store gets wrong, in the words of the case that must catch it. */
  breaks: string
  apply: (store: Port) => Port
}>

/**
 * Each mutant is the smallest wrapper that produces one wrong answer. Wrapping
 * a real memory store rather than hand-rolling a broken one keeps every OTHER
 * behavior correct, so a case that fails here failed for the named reason and
 * not because the fixture was uniformly useless.
 */
const CREDENTIAL_MUTANTS: readonly Mutant<CredentialStorePort>[] = [
  {
    breaks: "reports a freshly stored credential as errored",
    apply: (store) => ({ ...store, get: async (id) => mapRecord(await store.get(id), (record) => ({ ...record, status: "error" })) }),
  },
  {
    breaks: "echoes a secret-bearing key through the metadata reader",
    apply: (store) => ({
      ...store,
      get: async (id) => mapRecord(await store.get(id), (record) => ({ ...record, token: "leaked" }) as CredentialRecord),
    }),
  },
  {
    breaks: "invents an expiry that was never supplied",
    apply: (store) => ({ ...store, get: async (id) => mapRecord(await store.get(id), (record) => ({ ...record, expiresAt: 1 })) }),
  },
  {
    breaks: "ignores a put onto a provider id that already holds a credential",
    apply: (store) => ({ ...store, put: async (input) => void ((await store.get(input.providerId)) ?? (await store.put(input))) }),
  },
  {
    breaks: "applies a status change to every provider at once",
    apply: (store) => ({
      ...store,
      setStatus: async (id, status, lastError) => {
        for (const each of [id, "integration:conformance-connection-a", "integration:conformance-connection-b"]) {
          await store.setStatus(each, status, lastError)
        }
      },
    }),
  },
  {
    breaks: "serves the token path from the status-blind reader",
    apply: (store) => ({ ...store, resolveSecret: (id) => store.readSecret(id) }),
  },
  {
    breaks: "refuses re-verify the same way the token path does",
    apply: (store) => ({ ...store, readSecret: (id) => store.resolveSecret(id) }),
  },
  {
    breaks: "repairs status on the way through the re-verify reader",
    apply: (store) => ({
      ...store,
      readSecret: async (id) => {
        if (await store.get(id)) await store.setStatus(id, "available")
        return store.readSecret(id)
      },
    }),
  },
  {
    breaks: "never clears an error status back to available",
    apply: (store) => ({
      ...store,
      setStatus: async (id, status, lastError) => {
        if (status === "available") return
        await store.setStatus(id, status, lastError)
      },
    }),
  },
  {
    breaks: "materialises a credential for a provider it has never stored",
    apply: (store) => ({
      ...store,
      setStatus: async (id, status, lastError) => {
        if (!(await store.get(id))) await store.put({ providerId: id, kind: "api_key", secret: "materialised" })
        await store.setStatus(id, status, lastError)
      },
    }),
  },
  {
    breaks: "deletes the metadata but leaves the re-verify seam readable",
    apply: (store) => {
      const orphaned = new Map<string, string>()
      return {
        ...store,
        put: async (input) => {
          orphaned.set(input.providerId, input.secret)
          await store.put(input)
        },
        deleteByProvider: (id) => store.deleteByProvider(id),
        readSecret: async (id) => (await store.readSecret(id)) ?? orphaned.get(id) ?? null,
      }
    },
  },
]

const CONNECTION_CORE_MUTANTS: readonly Mutant<ConnectionStorePort>[] = [
  {
    breaks: "drops the fields map on the way in",
    apply: (store) => ({ ...store, upsert: (row) => store.upsert({ ...row, fields: {} }) }),
  },
  {
    breaks: "stamps its own write time over the caller's",
    apply: (store) => ({ ...store, upsert: (row) => store.upsert({ ...row, updatedAt: 424_242 }) }),
  },
  {
    breaks: "swallows the refusal instead of raising it",
    apply: (store) => ({
      ...store,
      upsert: async (row) => {
        try {
          await store.upsert(row)
        } catch {
          // Silently accepting the duplicate is the divergence.
        }
      },
    }),
  },
  {
    breaks: "answers an unknown id with some other row",
    apply: (store) => ({ ...store, getById: async (id) => (await store.getById(id)) ?? (await store.list())[0] }),
  },
  {
    breaks: "reports a delete it never performed",
    apply: (store) => ({ ...store, delete: async () => true }),
  },
  {
    breaks: "reports true for an id it does not hold",
    apply: (store) => ({ ...store, delete: async (id) => ((await store.delete(id)), true) }),
  },
  {
    breaks: "hands back the live stored row instead of a copy",
    apply: (store) => {
      const live = new Map<string, ConnectionRow>()
      return {
        ...store,
        upsert: async (row) => {
          await store.upsert(row)
          live.set(row.id, row)
        },
        getById: async (id) => (live.has(id) ? live.get(id) : await store.getById(id)),
        get: async (integrationId, owner) => {
          const found = await store.get(integrationId, owner)
          return found ? (live.get(found.id) ?? found) : undefined
        },
        list: async (filter) => (await store.list(filter)).map((found) => live.get(found.id) ?? found),
      }
    },
  },
]

const CONNECTION_PARTITION_MUTANTS: readonly Mutant<ConnectionStorePort>[] = [
  {
    breaks: "returns only the team partition when no filter is given",
    apply: (store) => ({ ...store, list: (filter) => store.list(filter ?? { owner: null }) }),
  },
  {
    breaks: "treats an explicit undefined owner as a filter rather than as every partition",
    apply: (store) => ({
      ...store,
      list: async (filter) => (filter && "owner" in filter && filter.owner === undefined ? [] : store.list(filter)),
    }),
  },
  {
    breaks: "answers the team partition with every row",
    apply: (store) => ({ ...store, list: (filter) => store.list(filter?.owner === null ? undefined : filter) }),
  },
  {
    breaks: "answers a specific owner with nothing",
    apply: (store) => ({ ...store, list: async (filter) => (typeof filter?.owner === "string" ? [] : store.list(filter)) }),
  },
  {
    breaks: "leaks the team partition into a specific-owner list",
    apply: (store) => ({
      ...store,
      list: async (filter) =>
        typeof filter?.owner === "string"
          ? [...(await store.list(filter)), ...(await store.list({ owner: null }))]
          : store.list(filter),
    }),
  },
  {
    breaks: "resolves an owned row when the owner is omitted",
    apply: (store) => ({
      ...store,
      get: async (integrationId, owner) =>
        owner === undefined ? store.get(integrationId, CONFORMANCE_OWNERS.first) : store.get(integrationId, owner),
    }),
  },
  {
    breaks: "resolves one owner's row for every owner",
    apply: (store) => ({
      ...store,
      get: (integrationId, owner) =>
        store.get(integrationId, typeof owner === "string" ? CONFORMANCE_OWNERS.first : owner),
    }),
  },
  {
    breaks: "falls back to a cross-partition scan when the partition misses",
    apply: (store) => ({
      ...store,
      get: async (integrationId, owner) =>
        (await store.get(integrationId, owner)) ?? (await store.list()).find((row) => row.integrationId === integrationId),
    }),
  },
  {
    breaks: "loses the owner key on a read by id",
    apply: (store) => ({
      ...store,
      getById: async (id) => mapRow(await store.getById(id), ({ owner: _owner, ...rest }) => rest as ConnectionRow),
    }),
  },
  {
    breaks: "treats one integration as one row across every partition",
    apply: (store) => ({
      ...store,
      upsert: async (row) => {
        for (const held of await store.list()) {
          if (held.integrationId === row.integrationId && held.id !== row.id) await store.delete(held.id)
        }
        await store.upsert(row)
      },
    }),
  },
  {
    breaks: "deletes every partition's row for the integration it was asked about",
    apply: (store) => ({
      ...store,
      delete: async (id) => {
        const target = await store.getById(id)
        const removed = await store.delete(id)
        for (const held of await store.list()) {
          if (target && held.integrationId === target.integrationId) await store.delete(held.id)
        }
        return removed
      },
    }),
  },
]

function mapRecord(record: CredentialRecord | undefined, change: (record: CredentialRecord) => CredentialRecord) {
  return record ? change(record) : undefined
}

function mapRow(row: ConnectionRow | undefined, change: (row: ConnectionRow) => ConnectionRow) {
  return row ? change(row) : undefined
}

async function expectCaseToFail(run: () => Promise<void>, label: string) {
  let failure: unknown
  try {
    await run()
  } catch (cause) {
    failure = cause
  }
  expect(failure, `${label} passed against a store that ${label}`).toBeInstanceOf(Error)
}

describe("conformance suites have teeth", () => {
  test("every pinned credential-store case is paired with a store that breaks it", () => {
    expect(CREDENTIAL_MUTANTS.length).toBe(CREDENTIAL_STORE_CONFORMANCE_SCOPE.covered.length)
  })

  CREDENTIAL_MUTANTS.forEach((mutant, index) => {
    const pinned = CREDENTIAL_STORE_CONFORMANCE_SCOPE.covered[index]
    test(`credential ${pinned} catches a store that ${mutant.breaks}`, async () => {
      const cases = credentialStoreConformance(async () => ({ store: mutant.apply(createMemoryCredentialStore()) }))
      expect(cases.length).toBe(CREDENTIAL_STORE_CONFORMANCE_SCOPE.covered.length)
      await expectCaseToFail(cases[index].run, mutant.breaks)
    })
  })

  test("every pinned connection-store case is paired with a store that breaks it", () => {
    expect(CONNECTION_CORE_MUTANTS.length).toBe(CONNECTION_STORE_CONFORMANCE_SCOPE.core.length)
    expect(CONNECTION_PARTITION_MUTANTS.length).toBe(CONNECTION_STORE_CONFORMANCE_SCOPE.partition.length)
  })

  CONNECTION_CORE_MUTANTS.forEach((mutant, index) => {
    const pinned = CONNECTION_STORE_CONFORMANCE_SCOPE.core[index]
    test(`connection core ${pinned} catches a store that ${mutant.breaks}`, async () => {
      const cases = connectionStoreCoreConformance(async () => ({ store: mutant.apply(createMemoryConnectionStore()) }))
      expect(cases.length).toBe(CONNECTION_STORE_CONFORMANCE_SCOPE.core.length)
      await expectCaseToFail(cases[index].run, mutant.breaks)
    })
  })

  CONNECTION_PARTITION_MUTANTS.forEach((mutant, index) => {
    const pinned = CONNECTION_STORE_CONFORMANCE_SCOPE.partition[index]
    test(`connection partition ${pinned} catches a store that ${mutant.breaks}`, async () => {
      const cases = connectionStorePartitionConformance(async () => ({ store: mutant.apply(createMemoryConnectionStore()) }))
      expect(cases.length).toBe(CONNECTION_STORE_CONFORMANCE_SCOPE.partition.length)
      await expectCaseToFail(cases[index].run, mutant.breaks)
    })
  })

  // The suites must also agree with themselves: an honest store passes every
  // case. Without this a mutant that broke the fixture outright — or a case
  // that throws unconditionally — would read as teeth.
  test("an honest memory store passes every case in both suites", async () => {
    for (const each of credentialStoreConformance(async () => ({ store: createMemoryCredentialStore() }))) await each.run()
    for (const each of connectionStoreCoreConformance(async () => ({ store: createMemoryConnectionStore() }))) await each.run()
    for (const each of connectionStorePartitionConformance(async () => ({ store: createMemoryConnectionStore() }))) await each.run()
  })
})
