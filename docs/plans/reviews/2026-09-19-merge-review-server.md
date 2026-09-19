# Merge review (server half) of `d94e4250d9..518a6b9e98` — verdict: GO WITH FIXES

1. MAJOR — `event-delivery.ts`: a connection of the same actor between `open()` and `subscribe()` holds a reservation that keeps the scope alive but is not attached; frames queued behind a pending authority decision when the previous connection leaves are decided for nobody — not rung, no hole, `retainedCursor` advanced past them — and the newcomer's catch-up starts after them; its resume reads no gap. Trigger: any disconnect (overflow shed, renewal terminate, plain close) while frames await one authority round trip and the reconnect lands inside it. Scratch proof: 259 frames gone after an overflow shed, 3 after a plain close.
2. MAJOR (cost) — `renew()` force-re-asks every granted session every 5 s per connection (one plane POST each), regardless of lease remaining; O(connections × granted sessions)/5 s per runtime.
3. MINOR — the hosted `LiveSyncRoom` is a third copy of the ring-restore machinery without the round-3/9/10 hole checks.
4. MINOR (env) — the main tree's untracked `agent-sdk-runtime`/`agent-event-runtime` dists predate the branch; every process-separated runtime needs them rebuilt before packaging or push.
5. MINOR — `user-hosted-connection.ts` comment still says the unscoped arm answers 400 `session_event_scope_required`.
6. NIT — the acceptance test publishes `process.status` "a kind this diff removed" (it was not: the kind stays on `WorkspaceRuntimeEvent`; only the `RuntimeSessionBusEvent` alias went).
7. NIT — an `agent.lifecycle` naming neither workspace, directory nor terminal passes to every runtime in the daemon (not a regression).
8. NIT — `parentSessionIdFor` is a synchronous SQLite read per frame per connection.

Verified clean: every deleted server file's responsibility landed or was obsolete; no production consumer of any retired export or route; route ownership, relay streaming list, hosted guard exemption and host-serving deny list name exactly the two streams; the workspace lease is minted only on `host_read` and re-verified with the minimum role on renewal; both arms refuse with the named codes; leases clamped; child deletions scoped to the parent; aborts during open released.
