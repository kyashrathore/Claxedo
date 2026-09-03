# 2026-09-02-151 — What the client caches, and what the web needs

Status: REVIEW + PLAN. Executes after plan 149 step 3 (event-driven lists),
which supplies the change signals this plan relies on.

## Why the desktop never noticed

The desktop reads its own daemon on loopback at about 1 ms per request. The
same code on the hosted web pays 0.3–1.3 s per control-plane read and
0.4–0.9 s per relay read. Every cache decision below was tuned, implicitly,
for the first case.

## What exists today (observed on disk)

**Query cache** (`platform/query/query-client.ts`): `staleTime` unset, so the
default is 0 — every observer mount refetches unless a key overrides it;
`refetchOnWindowFocus: false`; `retry: false`; `gcTime` 30 min. Overrides
that matter on the web: catalog and providers 5 min; provider auth 0;
**session list 0** (`session-list.ts:130-168`) — the rail's rows refetch on
every remount and every reload even though they paint from persistence;
`session.status` and `session.requests` poll every 5 s while a pane is open;
MCP/LSP status 0; session config and harness options 30 s; VCS `Infinity`
and event-owned (the right shape); workspace runtime records 15 s with the
routing read pinned to `Infinity`.

**Persisted across reloads**: localStorage buckets via `Persist.*` (layout,
model store, draft defaults, prompts, terminal buffers, …; 500 entries /
8 MiB in-memory mirror, quota eviction largest-first). IndexedDB
`claxedo-query-cache`: one blob, **2 MiB cap and the whole blob is deleted
when exceeded**, 1-day age, principal- and build-scoped, written on a 1 s
throttle; only five policies persist (catalog + providers, commands, session
lists, the `directory.*` family, `session.row`/`diff`/`messages head`).
IndexedDB `claxedo-conversations`: one entry per session, no cap. The
directory session cache is memory-only (40 sessions / 128 MiB). Session
prefetch is memory-only with a 5 min TTL and fires on pointerdown, not on
hover or route intent.

**HTTP**: no `ETag`, `If-None-Match` or `Cache-Control` on any data route
(control plane, relay, runtime); the only cache headers are JWKS `max-age=300`
and `no-store` on auth. No service worker. Every refetch transfers a full
body over the relay.

**Server-side**: relay target cache 5 s, revocation cache 10 s; control-plane
idempotency 5 min; runtime-client ensure 30 s; daemon list dedupe 3 s.

**Net effect on a warm web reload**: `get-session` always (1.3 s); catalog
paints from IndexedDB then holds 5 min; the workspace record and connection
mint are never persisted, so each reload re-resolves and re-mints (1.1 s);
the session list paints from persistence and then refetches anyway (2.6 s
cold); the transcript paints from `claxedo-conversations`; config, options,
provider auth, MCP/LSP refetch on every boot.

## Target policy

One rule: **a read is cached by who owns its change signal, not by a clock.**

1. **Event-owned reads** — session lists, transcripts and message pages,
   session row/status/todo/diff, session config and harness options, VCS:
   `staleTime: Infinity`, invalidated or patched by the workspace's event
   stream (plan 149 step 3 for lists; sessions already publish
   `message.*`/`session.*`; harness options need the runtime's
   `harness-config` change event). Delete the 5 s status/requests polls for
   relay-backed workspaces once the stream carries the same facts.
2. **Principal-owned reads** — catalog, provider catalogs, provider auth,
   service catalog: keep the 5 min clock and refresh on the account
   stream's `workspace.*`/`provider.*` events; provider auth joins them (its
   staleTime 0 buys nothing).
3. **Boot-critical, never cached** — `get-session` only.
4. **Persist what a warm reload needs to paint without a request**: the
   catalog with roles and host state, per-workspace session lists, the
   workspace runtime records, the connection *metadata* (relay URL, token
   expiry; never the token), session config and harness options, and the
   first fold of the last N transcripts. Replace the 2 MiB whole-blob
   deletion with per-policy budgets and LRU trimming; keep the principal and
   build scoping and the 1-day age.
5. **Cheap revalidation on the wire**: runtime and control-plane list and
   page routes return an `ETag` derived from the workspace's max event
   ordinal (lists) or the page's last ordinal (messages); the relay forwards
   validators; the app sends `If-None-Match` and treats 304 as "unchanged".
   Persisted data then costs one small round trip to confirm, not a body.
6. **Prefetch by intent**: mint the focused workspace's connection as soon
   as the catalog lands; prefetch a row's first fold on hover with the
   existing 5 min TTL; prefetch the connection for workspaces the rail is
   about to expand.
7. **Measure**: per-read hit source (memory / persisted / network / 304)
   recorded in `__claxedoSessionPerf` and reported next to the plan-148
   numbers after each step.

The desktop keeps the same policy; on loopback the difference is invisible,
and event ownership is already how VCS works there.

## Steps and definition of done

1. Query policy: session list and event-owned keys to `Infinity` with stream
   invalidation; provider auth to 5 min; delete the relay-path polls. DoD: a
   warm reload of a session route issues no session-list request and no
   status poll for a user-hosted workspace (browser probe).
2. Persistence: per-policy budgets in `platform/query/persister.ts`; persist
   runtime records, connection metadata, config/options. DoD: warm reload
   paints rail, transcript and composer from cache; the only pre-paint
   network calls are `get-session` and the catalog/list validators.
3. Validators: `ETag`/`If-None-Match` on runtime `/session`, `/session/:id/
   message`, control-plane `/api/control/session-list` and workspace list;
   the relay passes them through. DoD: a validator hit returns 304 in ≤ 0.3 s
   over the relay (measured), and the app's persisted list is confirmed
   without a body.
4. Intent prefetch. DoD: hover-to-open of a cold session shows its first
   fold within 100 ms of the click.
5. Metrics in session-perf and the plan-148 table updated with hit sources.
