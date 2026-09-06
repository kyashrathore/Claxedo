// Runner-neutral conformance cases for `ConnectionStorePort`.
//
// The partition model is the whole security story of this kit: an absent
// owner is the team partition, a string owner is that opaque subject's
// partition, and `list({owner})` is the only three-way selector. The
// `ownerlessRows: "refuse"` route invariant and `connectionScopeOf` both
// assume those semantics exactly. Every host adapter must agree or connections
// silently leak across partitions or vanish, so the cases below are stated once
// and registered by each adapter's own test runner.
//
// The cases come in two groups because one shipped adapter cannot hold the
// three-way model at all. The hosted D1 store serves ONE (org, user) pair per
// instance and refuses every other owner key by design, so it can never
// produce the three partitions the model describes. Splitting is what lets it
// run the rest — row identity, upsert arbitration, delete, copy-on-read — which
// it previously ran none of:
//
//   `connectionStoreCoreConformance` — one partition, named by the factory.
//   Every adapter runs these, D1 included.
//   `connectionStorePartitionConformance` — the three-way model. Only an
//   adapter with a team partition can run these.
//   `connectionStoreConformance` — both, for an adapter that has both.
import { ConnectionExistsError } from "../types.js"
import type { ConnectionRow, ConnectionStorePort } from "../types.js"

export const CONNECTION_STORE_CONFORMANCE_VERSION = 3 as const

export const CONNECTION_STORE_CONFORMANCE_SCOPE = {
  /** Runs against any adapter, in whichever single partition it names. */
  core: [
    "upsert_round_trips_every_field_and_keeps_optionals_absent",
    "upsert_same_id_replaces_in_place_and_carries_the_supplied_timestamps",
    "upsert_rekeying_is_refused",
    "get_and_get_by_id_miss_cleanly",
    "delete_removes_only_the_target_row",
    "delete_unknown_id_reports_false",
    "reads_return_copies_not_live_rows",
  ],
  /** Requires the three-way owner model; a single-partition host cannot run these. */
  partition: [
    "list_without_filter_returns_every_partition",
    "list_owner_undefined_returns_every_partition",
    "list_owner_null_returns_only_the_owner_absent_team_partition",
    "list_owner_string_returns_only_that_owner_partition",
    "owner_absent_row_is_never_returned_for_a_specific_owner_list",
    "get_with_owner_omitted_resolves_the_owner_absent_row_only",
    "get_with_string_owner_resolves_that_owner_row_only",
    "get_returns_undefined_outside_the_stored_partition",
    "get_by_id_crosses_partitions",
    "upsert_same_integration_in_another_partition_creates_a_distinct_row",
    "partition_isolation_survives_deletion",
  ],
  // NOT pinned:
  //
  //   `concurrent_upsert_arbitration` — which of two simultaneous writes wins.
  //   Only D1 can lose one, and only under a real transaction.
  //
  //   `upsert_id_reuse_across_partitions` — an id already held by ANOTHER
  //   partition. D1 refuses it (`HostedConnectionPartitionError`, deliberately
  //   not `ConnectionExistsError` — nothing a caller retries fixes it); the
  //   SQLite adapter surfaces a raw primary-key write error; the memory store
  //   moves the row. Unreachable through `createConnectionsService`, which only
  //   ever writes an id it read from the same partition or a fresh UUID, so
  //   pinning any of the three would ratify a guess.
  //
  //   `list_ordering` — no adapter promises an order; every case here compares
  //   row-id sets, never sequences.
  remaining: ["concurrent_upsert_arbitration", "upsert_id_reuse_across_partitions", "list_ordering"],
} as const

/** Opaque owner keys used by the partition cases. Values are meaningless to the port. */
export const CONFORMANCE_OWNERS = {
  /** The owner-absent team partition. */
  team: undefined,
  first: "conformance-owner-alpha",
  second: "conformance-owner-beta",
} as const

export type ConnectionStoreConformanceFactory = () => Promise<
  Readonly<{
    /** A store containing no connection rows. */
    store: ConnectionStorePort
  }>
>

/**
 * A store plus the ONE partition the core cases may write into. A
 * single-partition host names the owner key it accepts; a host with a team
 * partition omits it.
 */
export type ConnectionStoreCoreConformanceFactory = () => Promise<
  Readonly<{
    store: ConnectionStorePort
    owner?: string
  }>
>

export type ConnectionStoreConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

function row(input: Partial<ConnectionRow> & Pick<ConnectionRow, "id" | "integrationId">): ConnectionRow {
  return {
    integrationId: input.integrationId,
    id: input.id,
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
    grantedCapabilities: input.grantedCapabilities ?? ["docs"],
    fields: input.fields ?? {},
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 2_000,
  }
}

/**
 * The partition-agnostic cases: row identity, upsert arbitration, deletion and
 * copy-on-read, all inside the single partition the factory names. Nothing
 * here reads or writes a second partition, so an adapter that serves exactly
 * one still runs every case.
 */
export function connectionStoreCoreConformance(
  factory: ConnectionStoreCoreConformanceFactory,
): readonly ConnectionStoreConformanceCase[] {
  const owned = (input: Partial<ConnectionRow> & Pick<ConnectionRow, "id" | "integrationId">, owner?: string) =>
    row({ ...input, ...(owner !== undefined ? { owner } : {}) })

  const start = async () => {
    const { store, owner } = await factory()
    assertEqual((await store.list()).length, 0, "Conformance factory must yield an empty connection store")
    return { store, owner }
  }

  const seed = async () => {
    const { store, owner } = await start()
    await store.upsert(owned({ id: "row-core-notion", integrationId: "notion", accountLabel: "Core Notion" }, owner))
    await store.upsert(owned({ id: "row-core-linear", integrationId: "linear" }, owner))
    return { store, owner }
  }

  return [
    testCase("upsert round-trips every field and keeps optionals absent", async () => {
      const { store, owner } = await start()
      const full = owned(
        {
          id: "row-full",
          integrationId: "github",
          accountLabel: "octocat",
          grantedCapabilities: ["code-host", "work-source"],
          fields: { site_url: "https://example.invalid", email: "octocat@example.invalid" },
          createdAt: 1_710_000_000_000,
          updatedAt: 1_710_000_000_500,
        },
        owner,
      )
      await store.upsert(full)
      assertDeepEqual(await store.getById("row-full"), full, "upsert did not round-trip the full row")

      const bare = owned({ id: "row-bare", integrationId: "linear" }, owner)
      await store.upsert(bare)
      const stored = await store.getById("row-bare")
      assertDeepEqual(stored, bare, "upsert did not round-trip a minimal row")
      assertEqual(stored?.owner, owner, "upsert did not preserve the partition it was given")
      assert(stored?.accountLabel === undefined, "upsert materialised an accountLabel that was never supplied")
    }),

    testCase("upsert with the same id replaces in place and carries the supplied timestamps", async () => {
      const { store, owner } = await seed()
      await store.upsert(
        owned(
          {
            id: "row-core-notion",
            integrationId: "notion",
            accountLabel: "Renamed Core Notion",
            grantedCapabilities: ["docs", "work-source"],
            fields: { workspace: "acme" },
            createdAt: 1_000,
            updatedAt: 9_999,
          },
          owner,
        ),
      )
      assertIds(await store.list(), ["row-core-linear", "row-core-notion"], "upsert of an existing id duplicated the row")
      const updated = await store.getById("row-core-notion")
      assertEqual(updated?.accountLabel, "Renamed Core Notion", "upsert did not replace accountLabel")
      assertEqual(updated?.createdAt, 1_000, "upsert did not carry the supplied createdAt")
      // The service owns the clock. A store that stamps its own write time
      // makes the row report an `updatedAt` its caller never recorded.
      assertEqual(updated?.updatedAt, 9_999, "upsert did not carry the supplied updatedAt")
      assertDeepEqual(updated?.grantedCapabilities, ["docs", "work-source"], "upsert did not replace grantedCapabilities")
      assertDeepEqual(updated?.fields, { workspace: "acme" }, "upsert did not replace fields")
    }),

    // The id is the key. A fresh id for a partition that already holds the
    // integration is refused, because both other answers corrupt: keeping both
    // rows makes `get(integrationId, owner)` pick an arbitrary winner, and
    // rewriting the existing row under its OLD id discards the supplied id —
    // `getById` then misses after an `upsert` that resolved, and the credential
    // stored under the supplied id is stranded where no route can reach it.
    testCase("upsert refuses a second id for a partition that already holds the integration", async () => {
      const { store, owner } = await seed()
      const rekeyed = owned({ id: "row-core-rekeyed", integrationId: "notion", accountLabel: "Rekeyed" }, owner)
      let refusal: unknown
      try {
        await store.upsert(rekeyed)
      } catch (cause) {
        refusal = cause
      }
      assert(
        refusal instanceof ConnectionExistsError,
        `upsert of a second id for an occupied partition was not refused with ConnectionExistsError (got ${String(refusal)})`,
      )
      assertEqual(await store.getById("row-core-rekeyed"), undefined, "the refused upsert still wrote its row")
      const held = await store.getById("row-core-notion")
      assertEqual(held?.accountLabel, "Core Notion", "the refused upsert overwrote the row already in the partition")
      assertEqual((await store.get("notion", owner))?.id, "row-core-notion", "the refused upsert rekeyed the partition")
      assertIds(await store.list(), ["row-core-linear", "row-core-notion"], "the refused upsert changed the row set")
    }),

    testCase("get and getById miss cleanly", async () => {
      const { store, owner } = await seed()
      assertEqual(await store.get("unregistered", owner), undefined, "get resolved an unknown integration")
      assertEqual(await store.getById("row-missing"), undefined, "getById resolved an unknown id")
      assertEqual((await store.get("notion", owner))?.id, "row-core-notion", "get did not resolve the seeded row")
      assertEqual((await store.getById("row-core-linear"))?.integrationId, "linear", "getById lost the integration")
    }),

    testCase("delete removes only the target row", async () => {
      const { store, owner } = await seed()
      assertEqual(await store.delete("row-core-notion"), true, "delete of an existing id did not report true")
      assertEqual(await store.getById("row-core-notion"), undefined, "delete left the row readable by id")
      assertEqual(await store.get("notion", owner), undefined, "delete left the row readable by integration")
      assertIds(await store.list(), ["row-core-linear"], "delete removed the wrong rows")
    }),

    testCase("delete of an unknown id reports false", async () => {
      const { store } = await seed()
      assertEqual(await store.delete("row-missing"), false, "delete of an unknown id did not report false")
      assertEqual((await store.list()).length, 2, "delete of an unknown id mutated the store")
    }),

    // Every read hands back a copy. An adapter that returns its live row lets a
    // reader rewrite stored state — reassign the integration, grant itself a
    // capability — without ever calling `upsert`, which no persistent adapter
    // would have honoured. That divergence makes the in-memory store behave
    // unlike every real one, so it is pinned for all three readers rather than
    // for whichever the host happens to exercise.
    testCase("reads return copies, so mutating a returned row cannot reach the store", async () => {
      const { store, owner } = await seed()
      for (const [reader, read] of [
        ["get", () => store.get("notion", owner)],
        ["getById", () => store.getById("row-core-notion")],
        ["list", async () => (await store.list()).find((found) => found.id === "row-core-notion")],
      ] as const) {
        const found = await read()
        assert(!!found, `${reader}() did not resolve the seeded row`)
        found.integrationId = "mutated-by-caller"
        found.accountLabel = "mutated-by-caller"
        found.grantedCapabilities.push("code-host")
        found.fields.injected = "yes"
        const reread = await store.getById("row-core-notion")
        assertEqual(reread?.integrationId, "notion", `mutating the row from ${reader}() rewrote the stored integration`)
        assertEqual(reread?.accountLabel, "Core Notion", `mutating the row from ${reader}() rewrote the stored label`)
        assertDeepEqual(
          reread?.grantedCapabilities,
          ["docs"],
          `mutating the row from ${reader}() granted the connection a capability it was never given`,
        )
        assertDeepEqual(reread?.fields, {}, `mutating the row from ${reader}() wrote a field into the stored row`)
        assertEqual((await store.get("notion", owner))?.id, "row-core-notion", `mutating the row from ${reader}() made it unresolvable`)
      }
    }),
  ]
}

/**
 * The three-way partition cases. An adapter that has no team partition — the
 * hosted D1 store refuses the owner-absent partition outright — cannot run
 * these and registers `connectionStoreCoreConformance` alone.
 */
export function connectionStorePartitionConformance(
  factory: ConnectionStoreConformanceFactory,
): readonly ConnectionStoreConformanceCase[] {
  const seed = async () => {
    const { store } = await factory()
    assertEqual((await store.list()).length, 0, "Conformance factory must yield an empty connection store")
    await store.upsert(row({ id: "row-team-notion", integrationId: "notion", accountLabel: "Team Notion" }))
    await store.upsert(row({ id: "row-team-linear", integrationId: "linear" }))
    await store.upsert(row({ id: "row-alpha-notion", integrationId: "notion", owner: CONFORMANCE_OWNERS.first }))
    await store.upsert(row({ id: "row-beta-notion", integrationId: "notion", owner: CONFORMANCE_OWNERS.second }))
    return store
  }

  return [
    testCase("list without a filter returns every partition", async () => {
      const store = await seed()
      const every = ["row-alpha-notion", "row-beta-notion", "row-team-linear", "row-team-notion"]
      assertIds(await store.list(), every, "list() returned the wrong row set")
      assertIds(await store.list({}), every, "list({}) returned the wrong row set")
    }),

    testCase("list with owner undefined returns every partition", async () => {
      const store = await seed()
      assertIds(
        await store.list({ owner: undefined }),
        ["row-alpha-notion", "row-beta-notion", "row-team-linear", "row-team-notion"],
        "list({owner: undefined}) returned the wrong row set",
      )
    }),

    testCase("list with owner null returns only the owner-absent team partition", async () => {
      const store = await seed()
      const rows = await store.list({ owner: null })
      assertIds(rows, ["row-team-linear", "row-team-notion"], "list({owner: null}) returned the wrong row set")
      for (const found of rows) {
        assert(found.owner === undefined, `list({owner: null}) returned a row carrying owner ${String(found.owner)}`)
      }
    }),

    testCase("list with a string owner returns only that owner partition", async () => {
      const store = await seed()
      const first = await store.list({ owner: CONFORMANCE_OWNERS.first })
      assertIds(first, ["row-alpha-notion"], "list({owner: first}) returned the wrong row set")
      const second = await store.list({ owner: CONFORMANCE_OWNERS.second })
      assertIds(second, ["row-beta-notion"], "list({owner: second}) returned the wrong row set")
      const unknown = await store.list({ owner: "conformance-owner-unknown" })
      assertIds(unknown, [], "list({owner: unknown}) returned a row for an owner with none")
    }),

    testCase("an owner-absent row is never returned for a specific-owner list", async () => {
      const store = await seed()
      const owned = await store.list({ owner: CONFORMANCE_OWNERS.first })
      assert(
        owned.every((found) => found.owner === CONFORMANCE_OWNERS.first),
        "list({owner: string}) leaked a row from another partition",
      )
      const team = await store.list({ owner: null })
      assert(
        team.every((found) => found.owner === undefined),
        "list({owner: null}) leaked an owned row into the team partition",
      )
    }),

    testCase("get with owner omitted resolves the owner-absent row only", async () => {
      const store = await seed()
      const found = await store.get("notion")
      assertEqual(found?.id, "row-team-notion", "get(integrationId) did not resolve the owner-absent row")
      assert(found?.owner === undefined, "get(integrationId) returned an owned row")
      assertEqual(
        (await store.get("notion", undefined))?.id,
        "row-team-notion",
        "get(integrationId, undefined) diverged from get(integrationId)",
      )
    }),

    testCase("get with a string owner resolves that owner row only", async () => {
      const store = await seed()
      const first = await store.get("notion", CONFORMANCE_OWNERS.first)
      assertEqual(first?.id, "row-alpha-notion", "get(integrationId, owner) did not resolve the owner partition")
      assertEqual(first?.owner, CONFORMANCE_OWNERS.first, "get(integrationId, owner) returned a foreign partition row")
      const second = await store.get("notion", CONFORMANCE_OWNERS.second)
      assertEqual(second?.id, "row-beta-notion", "get(integrationId, owner) crossed owner partitions")
    }),

    testCase("get returns undefined outside the stored partition", async () => {
      const store = await seed()
      assertEqual(
        await store.get("linear", CONFORMANCE_OWNERS.first),
        undefined,
        "get resolved a team row for a specific-owner query",
      )
      assertEqual(await store.get("notion", "conformance-owner-unknown"), undefined, "get resolved an unknown owner partition")
    }),

    testCase("get by id crosses partitions", async () => {
      const store = await seed()
      assertEqual((await store.getById("row-alpha-notion"))?.owner, CONFORMANCE_OWNERS.first, "getById lost the owner key")
      assert((await store.getById("row-team-notion"))?.owner === undefined, "getById invented an owner for a team row")
    }),

    testCase("upsert of the same integration in another partition creates a distinct row", async () => {
      const { store } = await factory()
      await store.upsert(row({ id: "row-team", integrationId: "notion", accountLabel: "team" }))
      await store.upsert(row({ id: "row-owned", integrationId: "notion", owner: CONFORMANCE_OWNERS.first, accountLabel: "owned" }))
      assertIds(await store.list(), ["row-owned", "row-team"], "partitioned upsert collapsed two partitions into one row")
      assertEqual((await store.get("notion"))?.accountLabel, "team", "partitioned upsert overwrote the team row")
      assertEqual(
        (await store.get("notion", CONFORMANCE_OWNERS.first))?.accountLabel,
        "owned",
        "partitioned upsert overwrote the owner row",
      )
    }),

    testCase("partition isolation survives deletion", async () => {
      const store = await seed()
      await store.delete("row-team-notion")
      assertEqual(
        (await store.get("notion", CONFORMANCE_OWNERS.first))?.id,
        "row-alpha-notion",
        "deleting the team row disturbed an owner partition",
      )
      assertEqual(await store.get("notion"), undefined, "deleting the team row left it resolvable")
      await store.delete("row-beta-notion")
      assertIds(await store.list({ owner: null }), ["row-team-linear"], "deleting an owned row disturbed the team partition")
    }),
  ]
}

/**
 * Both groups, for an adapter that has a team partition: the core cases run in
 * it, then the three-way model is exercised on top.
 */
export function connectionStoreConformance(
  factory: ConnectionStoreConformanceFactory,
): readonly ConnectionStoreConformanceCase[] {
  return [...connectionStoreCoreConformance(factory), ...connectionStorePartitionConformance(factory)]
}

function testCase(name: string, run: () => Promise<void>): ConnectionStoreConformanceCase {
  return { name, run }
}

function assertIds(rows: readonly ConnectionRow[], expected: readonly string[], message: string) {
  assertDeepEqual(rows.map((found) => found.id).sort(), [...expected].sort(), message)
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`)
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}
