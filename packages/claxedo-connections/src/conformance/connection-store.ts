// Runner-neutral conformance cases for `ConnectionStorePort`.
//
// The partition model is the whole security story of this kit: an absent
// owner is the team partition, a string owner is that opaque subject's
// partition, and `list({owner})` is the only three-way selector. The
// `ownerlessRows: "refuse"` route invariant and `connectionScopeOf` both
// assume those semantics exactly. Every host adapter (memory, SQLite) must
// agree or connections silently leak across partitions or
// vanish, so the cases below are stated once and registered by each adapter's
// own test runner.
import type { ConnectionRow, ConnectionStorePort } from "../types.js"

export const CONNECTION_STORE_CONFORMANCE_VERSION = 2 as const

export const CONNECTION_STORE_CONFORMANCE_SCOPE = {
  covered: [
    "list_without_filter_returns_every_partition",
    "list_owner_undefined_returns_every_partition",
    "list_owner_null_returns_only_the_owner_absent_team_partition",
    "list_owner_string_returns_only_that_owner_partition",
    "get_with_owner_omitted_resolves_the_owner_absent_row_only",
    "get_with_string_owner_resolves_that_owner_row_only",
    "get_returns_undefined_outside_the_stored_partition",
    "get_by_id_crosses_partitions_and_misses_cleanly",
    "upsert_round_trips_every_field_and_keeps_optionals_absent",
    "upsert_same_id_replaces_in_place_and_carries_the_supplied_timestamps",
    "upsert_same_integration_in_another_partition_creates_a_distinct_row",
    "delete_removes_only_the_target_row",
    "delete_unknown_id_reports_false",
    "partition_isolation_survives_deletion",
    "reads_return_copies_not_live_rows",
  ],
  // NOT pinned, because the two shipped adapters are KNOWN TO DISAGREE and
  // the contract does not say which is right (reported, unfixed):
  //
  //   `upsert_rekeying` — upserting a fresh row id for an integration+owner
  //   that already has a row. The memory store keys by `row.id`, so it keeps
  //   BOTH rows. The SQLite adapter keys by (integration_id, owner)
  //   (store-adapter.ts:116-121), so it silently rewrites the existing row and
  //   DISCARDS the supplied id — `getById(suppliedId)` then returns undefined
  //   even though `upsert` resolved successfully. Unreachable through
  //   `createConnectionsService`, which always resolves `existing?.id` before
  //   writing (service.ts:114-122), which is why it is stated here rather
  //   than asserted: pinning either behaviour would ratify a guess.
  //
  //   `list_ordering` — no adapter promises an order; every case here compares
  //   row-id sets, never sequences.
  remaining: ["concurrent_upsert_arbitration", "upsert_rekeying", "list_ordering"],
} as const

/** Opaque owner keys used by the cases. Values are meaningless to the port. */
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
 * Returns runner-neutral conformance cases for a `ConnectionStorePort`
 * implementation. The factory yields an empty store per case; every
 * assertion touches the adapter only through the public port.
 */
export function connectionStoreConformance(
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
      assertIds(await store.list(), ["row-alpha-notion", "row-beta-notion", "row-team-linear", "row-team-notion"], "list()")
      assertIds(await store.list({}), ["row-alpha-notion", "row-beta-notion", "row-team-linear", "row-team-notion"], "list({})")
    }),

    testCase("list with owner undefined returns every partition", async () => {
      const store = await seed()
      assertIds(
        await store.list({ owner: undefined }),
        ["row-alpha-notion", "row-beta-notion", "row-team-linear", "row-team-notion"],
        "list({owner: undefined})",
      )
    }),

    testCase("list with owner null returns only the owner-absent team partition", async () => {
      const store = await seed()
      const rows = await store.list({ owner: null })
      assertIds(rows, ["row-team-linear", "row-team-notion"], "list({owner: null})")
      for (const found of rows) {
        assert(found.owner === undefined, `list({owner: null}) returned a row carrying owner ${String(found.owner)}`)
      }
    }),

    testCase("list with a string owner returns only that owner partition", async () => {
      const store = await seed()
      assertIds(await store.list({ owner: CONFORMANCE_OWNERS.first }), ["row-alpha-notion"], "list({owner: first})")
      assertIds(await store.list({ owner: CONFORMANCE_OWNERS.second }), ["row-beta-notion"], "list({owner: second})")
      assertIds(await store.list({ owner: "conformance-owner-unknown" }), [], "list({owner: unknown})")
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
      assertEqual(await store.get("unregistered"), undefined, "get resolved an unknown integration")
    }),

    testCase("get by id crosses partitions and misses cleanly", async () => {
      const store = await seed()
      assertEqual((await store.getById("row-alpha-notion"))?.owner, CONFORMANCE_OWNERS.first, "getById lost the owner key")
      assert((await store.getById("row-team-notion"))?.owner === undefined, "getById invented an owner for a team row")
      assertEqual(await store.getById("row-missing"), undefined, "getById resolved an unknown id")
    }),

    testCase("upsert round-trips every field and keeps optionals absent", async () => {
      const { store } = await factory()
      const owned = row({
        id: "row-full",
        integrationId: "github",
        owner: CONFORMANCE_OWNERS.first,
        accountLabel: "octocat",
        grantedCapabilities: ["code-host", "work-source"],
        fields: { site_url: "https://example.invalid", email: "octocat@example.invalid" },
        createdAt: 1_710_000_000_000,
        updatedAt: 1_710_000_000_500,
      })
      await store.upsert(owned)
      assertDeepEqual(await store.getById("row-full"), owned, "upsert did not round-trip the full row")

      const bare = row({ id: "row-bare", integrationId: "linear" })
      await store.upsert(bare)
      const stored = await store.getById("row-bare")
      assertDeepEqual(stored, bare, "upsert did not round-trip a minimal row")
      assert(stored?.owner === undefined, "upsert materialised an owner on an owner-absent row")
      assert(stored?.accountLabel === undefined, "upsert materialised an accountLabel that was never supplied")
    }),

    testCase("upsert with the same id replaces in place and carries the supplied timestamps", async () => {
      const store = await seed()
      await store.upsert(
        row({
          id: "row-team-notion",
          integrationId: "notion",
          accountLabel: "Renamed Team Notion",
          grantedCapabilities: ["docs", "work-source"],
          fields: { workspace: "acme" },
          createdAt: 1_000,
          updatedAt: 9_999,
        }),
      )
      const rows = await store.list({ owner: null })
      assertIds(rows, ["row-team-linear", "row-team-notion"], "upsert of an existing id duplicated the team partition")
      const updated = await store.getById("row-team-notion")
      assertEqual(updated?.accountLabel, "Renamed Team Notion", "upsert did not replace accountLabel")
      assertEqual(updated?.createdAt, 1_000, "upsert did not carry the supplied createdAt")
      assertEqual(updated?.updatedAt, 9_999, "upsert did not carry the supplied updatedAt")
      assertDeepEqual(updated?.grantedCapabilities, ["docs", "work-source"], "upsert did not replace grantedCapabilities")
      assertDeepEqual(updated?.fields, { workspace: "acme" }, "upsert did not replace fields")
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

    testCase("delete removes only the target row", async () => {
      const store = await seed()
      assertEqual(await store.delete("row-alpha-notion"), true, "delete of an existing id did not report true")
      assertEqual(await store.getById("row-alpha-notion"), undefined, "delete left the row readable by id")
      assertEqual(await store.get("notion", CONFORMANCE_OWNERS.first), undefined, "delete left the row readable by partition")
      assertIds(await store.list(), ["row-beta-notion", "row-team-linear", "row-team-notion"], "delete removed the wrong rows")
    }),

    testCase("delete of an unknown id reports false", async () => {
      const store = await seed()
      assertEqual(await store.delete("row-missing"), false, "delete of an unknown id did not report false")
      assertEqual((await store.list()).length, 4, "delete of an unknown id mutated the store")
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

    // Every read hands back a copy. An adapter that returns its live row lets a
    // reader rewrite stored state — reassign the integration, move the row to
    // another partition — without ever calling `upsert`, which no persistent
    // adapter would have honoured. That divergence makes the in-memory store
    // behave unlike every real one, so it is pinned for all three readers
    // rather than for whichever the host happens to exercise.
    testCase("reads return copies, so mutating a returned row cannot reach the store", async () => {
      const store = await seed()
      for (const [reader, read] of [
        ["get", () => store.get("notion", CONFORMANCE_OWNERS.first)],
        ["getById", () => store.getById("row-alpha-notion")],
        ["list", async () => (await store.list({ owner: CONFORMANCE_OWNERS.first }))[0]],
      ] as const) {
        const found = await read()
        assert(!!found, `${reader}() did not resolve the seeded row`)
        found!.integrationId = "mutated-by-caller"
        found!.owner = CONFORMANCE_OWNERS.second
        found!.grantedCapabilities.push("work-source")
        found!.fields.injected = "yes"
        const reread = await store.getById("row-alpha-notion")
        assertEqual(reread?.integrationId, "notion", `mutating the row from ${reader}() rewrote the stored integration`)
        assertEqual(reread?.owner, CONFORMANCE_OWNERS.first, `mutating the row from ${reader}() moved the stored partition`)
        assertEqual(
          (await store.get("notion", CONFORMANCE_OWNERS.first))?.id,
          "row-alpha-notion",
          `mutating the row from ${reader}() made it unresolvable in its partition`,
        )
      }
    }),
  ]
}

function testCase(name: string, run: () => Promise<void>): ConnectionStoreConformanceCase {
  return { name, run }
}

function assertIds(rows: readonly ConnectionRow[], expected: readonly string[], label: string) {
  const actual = rows.map((found) => found.id).sort()
  assertDeepEqual(actual, [...expected].sort(), `${label} returned the wrong row set`)
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
