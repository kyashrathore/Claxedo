# Database time inside signed requests, 2026-10-18

Every signed read on the hosted control plane (`packages/claxedo-server`, a Worker with two D1 databases) paid a chain of serial database rounds before its own work, and the Worker's clock advances only across I/O, so a request's `Server-Timing` is almost entirely those rounds. This note counts them on the Worker's real composition, derives what one round costs on staging, says where the databases and the Worker run, and records what changed.

## Measured on staging before (signed in, warm assets, `Server-Timing` in ms)

| route | auth | d1 | total | serial D1 rounds before | ms per round |
|---|---|---|---|---|---|
| `GET /api/auth/get-session` | | 100 | 100 | 2 | 50 |
| `GET /api/workspace?host=provisioner` | 305 | 748 | 843 | 7 (3 auth + principal + list + serving hosts + leases) | 107 |
| `GET /api/control/session-list?scope=projects` | 196 | 203 | 286 | 6 (3 auth + principal + project ids + page batch) | 34 |
| `GET /api/workspace/shared-sessions` | 116 | 169 | 169 | 5 (3 auth + principal + list) | 34 |
| `GET /api/claxedo/remote-access/devices` (cold) | 326 | 387 | 387 | 5 (3 auth + principal + list) | 77 |
| `GET /api/claxedo/agent-config/connections` (cold) | 248 | 312 | 312 | 5 (3 auth + me + config) | 62 |

The round counts come from `countD1Rounds` over both databases on the Worker's real Better Auth + D1 composition (`better-auth-d1-signed-rounds.d1.test.ts`), signed in by cookie as the deployment's owner. The chain every cookie-signed request paid:

1. Better Auth's `getSession`: `session` by token, then `user` by id, two serial statements on `AUTH_DB` (its adapter factory split the `join: { user: true }` its `findSession` asks for into two reads).
2. The sign-in evidence row (`authenticationEvidence ⋈ session`) on `AUTH_DB`, beside the control plane's identity row (`auth_identities ⋈ users ⋈ actors`, `ensureApplicationIdentity`) on `CONTROL_PLANE_DB`.
3. `requireHuman`, the route's own verification of the principal against the identity row, on `CONTROL_PLANE_DB`.
4. The route's reads, one after another.

So the account catalog the rail waits on was seven rounds deep, and `auth` alone (steps 1 and 2) was three.

### What a round costs, and where the databases run

`wrangler d1 info` on both staging databases answers `running_in_region ENAM` with `read_replication.mode disabled`; the Worker answers `cf-placement: remote-IAD`, inside ENAM, because `CLAXEDO_STAGING_WORKER_PLACEMENT_REGION=aws:us-east-1` maps it there ([Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/): "Cloudflare maps your specified cloud region to the data center with the lowest latency to that region"). D1 places a primary by region, not by data center, and only on creation: a location hint "does not guarantee that D1 runs in your preferred location", D1 picks "the nearest possible location (by latency) to your preference", and nothing moves a database afterwards ([data location](https://developers.cloudflare.com/d1/configuration/data-location/)). So the Worker and both primaries share a region, and the data center of the primary within ENAM is not disclosed.

Dividing `d1` by the counted rounds gives 34–50 ms per round for the requests the boot sends alone or in its small second wave (`shared-sessions`, `session-list`, `get-session`) and 77–107 ms for the ones it sends four abreast with others (`workspace?host=provisioner`, `devices`), with the identical three-round auth prefix spanning 116–326 ms across the same requests. The per-round cost is therefore a distribution, roughly 35–50 ms on its own and two to three times that when several requests of one boot hit the same isolate together; what is observed is the spread, the cause of the spread is inferred from which requests share a wave. Read replication would not help: it needs the Sessions API in every reader and serves reads from a replica in the same region as this primary anyway ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)). Fewer serial rounds help at every point of the distribution.

After this change `GET /api/auth/get-session` is exactly one D1 statement, so its `d1` field on staging *is* one round: read it ten times to get the distribution directly.

## What changed

- **Better Auth reads the session joined to its user in one statement.** `advanced.database.joins: true` in `betterAuthD1FoundationOptions` (`src/platform/auth/better-auth-d1-foundation.ts`): Better Auth 1.7's adapter factory passes `findSession`'s join to the Kysely adapter only under this flag, and the adapter writes it as one `left join "user"` D1 answers at once. Every cookie verification and `/api/auth/get-session` lose one serial round.
- **The catalog reads run beside the principal's verification instead of after it.** `namedPrincipal(auth)` (`src/authority/adapters/d1/access-context.ts`) is the principal as the auth names it; `requireHuman` refuses a principal whose identity row names another user or actor, so a read keyed by those ids either joins a verified principal or is discarded with the refusal, the pattern `usersMe` and `listOrgs` already used for the caller's organizations. `listWorkspaces`, `listSharedSessions`, `listProjectSessionPages` and `listHostDevices` now `Promise.all` the verification with their read. A write never takes `namedPrincipal`.
- **The workspace list computes `host_online` in the statement it already had.** `openableWorkspacesSql` joined each workspace's assignment and enrollment for `host_enrollment_id`; it now evaluates `HOST_SERVING_WORKSPACE_SQL` over that join as `host_online`, and the second statement that re-read the same tables for the machine rows (`workspacesWithServingHost`) is gone.
- **The shared-session list drives from the caller's grants.** `listD1SharedSessions` scanned `sessions` (`SCAN s USING INDEX sessions_by_creator`, fifteen correlated subqueries per row) with `w.owner_user_id <> ?` as its only plain predicate; it now starts from `session_share_grants` by `target_user_id` and `revoked_at is null` (`SEARCH grant_row USING COVERING INDEX session_share_grants_by_user`) and applies the same read rule to each row.

Every other statement on these routes already searched an index (`EXPLAIN QUERY PLAN` against the baseline schema on Miniflare's D1): the auth tables by their unique indexes, `auth_identities` by `(adapter, issuer, subject)`, `workspaces` by `workspaces_by_owner`, enrollments by owner and host, pages by their project indexes. `organizationRows` (`usersMe`, `listOrgs`) scans `orgs` with a correlated membership subquery per organization; a user-deployed control plane holds one organization, so it is not changed here.

## Rounds before → after

Serial rounds across both databases, cookie-signed, on the real composition (`better-auth-d1-signed-rounds.d1.test.ts`); the hosted-app pins with the stub authentication adapter (`signed-read-rounds.d1.test.ts`) count the control plane alone and read one round for each catalog route.

| route | before | after | chain after |
|---|---|---|---|
| `get-session` | 2 | 1 | session ⋈ user |
| `workspace?host=provisioner` | 7 | 4 | session ⋈ user → evidence ‖ identity → principal ‖ list (with `host_online`) → sandbox leases |
| `session-list?scope=projects` | 6 | 4 | … → principal ‖ project ids → page batch |
| `shared-sessions` | 5 | 3 | … → principal ‖ grants-driven list |
| `remote-access/devices` | 5 | 3 | … → principal ‖ machines |
| `agent-config/connections` | 5 | 4 | … → me (principal ‖ orgs ‖ profile) → config |

Staging time model, at the observed per-round costs: the catalog read drops from 7 to 4 rounds, so from 748 ms to about 430 ms at the 107 ms the four-abreast wave paid and to 140–200 ms at the 35–50 ms a lone request pays; `auth` on every signed request drops from 3 rounds to 2; `get-session` halves.

## What to read on staging after deploy

Signed in, warm assets, `Server-Timing` on each of the six routes above: `auth` should read two rounds' worth (about two thirds of before on the same request), `d1` of `get-session` one round, `d1` of `workspace?host=provisioner` four rounds. `wrangler tail` prints `[timing] GET <path> <status> …` for any request over 1 s. The round counts are pinned in the two tests named above; a route that gains a round fails there before it reaches staging.

## Not done here

- `/api/claxedo/agent-config/connections` verifies the caller through `usersMe`, which also reads the caller's organizations and the Better Auth profile it does not use; the config read then follows. A verification that answers only the principal would let the config read run beside it.
- `organizationRows` scans `orgs`; a membership-driven read (`org_memberships_by_user` plus the owned organizations) would matter on a hosted control plane with many organizations.
- The workspace list's sandbox leases are one `sandbox_leases` statement per cloud row, in parallel (one round, N statements); a `where workspace_id in (...)` read would make it one statement.
