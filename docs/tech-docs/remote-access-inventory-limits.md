# Remote access inventory limits

Status: **constants derived, load drills outstanding** (U8 Unit 1).
Consumed by Unit 6 (`packages/claxedo-host-connector/src/inventory/limits.ts`)
and by both Workspace Authority adapters.

## What is being bounded

One machine enrollment publishes the machine's **complete** canonical local
workspace inventory, and republishes the complete set on every change and every
reconnect. That makes the snapshot a hot object on three paths at once: an
authority transaction, a Relay registration frame, and a reconnect storm after
a Relay restart.

It also makes it a rejection decision rather than a truncation decision. A
truncated snapshot is not a smaller snapshot — it is a **wrong** one, and it
would be accepted as authoritative, silently unpublishing whatever fell off the
end. So every bound below rejects the whole snapshot before any write.

## The bounds

| Bound | Value | Rationale |
|---|---|---|
| Workspaces per machine | 256 | Rejection threshold, not a target. See headroom below. |
| Stable workspace ID | 256 UTF-8 bytes | Accommodates a path-derived or UUID-derived ID with room to spare. |
| Display label | **128 UTF-8 bytes** | Adjusted down from 256 — see "The 256/256/128 KiB set does not close". |
| Encoded snapshot | 128 KiB | The binding constraint; the per-field caps are derived from it. |
| Concurrent Cloudflare room reconnects per host | 8 | Bounds a single host's contribution to a reconnect storm. |

Bytes, not code points. A label of 128 emoji is 512 bytes and must be rejected;
a limit measured in `String.length` would accept it and then overshoot the
encoded bound by 4×.

## The 256/256/128 KiB set does not close

The plan's initial targets were 256 workspaces, 256 bytes per ID **and** label,
and a 128 KiB encoded snapshot. Those three cannot all hold. The canonical
encoding of one entry is:

```
{"id":"<256 bytes>","label":"<256 bytes>"}
```

which is `1 + 4 + 1 + 258 + 1 + 7 + 1 + 258 + 1` = **532 bytes**, plus one
separator byte = 533. At 256 entries:

```
256 × 533 = 136,448 bytes = 133.25 KiB
```

That is 5.25 KiB **over** the 128 KiB cap before the envelope
(`hostId`, `generation`, `inventoryVersion`) is counted. A machine satisfying
every per-field bound would be rejected by the encoded bound.

That is not a theoretical corner. It is the shape a fuzz test finds
immediately, and the failure mode is the worst available: remote access breaks
for the machine with the most workspaces, which is the machine whose owner
cares most.

**Resolution: the display-label cap drops to 128 bytes.** A 256-byte stable ID
is defensible — IDs are derived, not typed. A 256-byte *display label* is not;
it is longer than this sentence and no UI renders it. Recomputing:

```
{"id":"<256 bytes>","label":"<128 bytes>"}
  = 1 + 4 + 1 + 258 + 1 + 7 + 1 + 130 + 1 = 404 bytes  (+1 separator = 405)
256 × 405 = 103,680 bytes = 101.25 KiB
```

101.25 KiB against a 128 KiB cap leaves **26.75 KiB** for the envelope and
future fields — roughly 26% headroom on the worst legal snapshot. Unit 6 freezes
`{ workspaces: 256, idBytes: 256, labelBytes: 128, encodedBytes: 131_072 }` as
one shared constant object, consumed by the connector and both adapters, so the
three cannot drift apart again.

## Headroom over real profiles

The bound has to sit far above what real machines do, or it becomes a product
limit rather than an abuse limit. The plan requires ≥4×.

| Profile | Workspaces | Headroom to 256 |
|---|---|---|
| Single-project developer | 1–3 | ~85× |
| Typical multi-repo developer | 8–20 | ~13× |
| Monorepo with many worktrees | 30–60 | ~4.3× |
| Bound | 256 | — |

The tightest realistic case is the worktree-heavy monorepo user, and it still
clears 4×. **This row is the one that needs field data**: it is reasoned from
the worktree feature's own design rather than measured across real profiles. If
telemetry later shows a population above ~64 workspaces, the bound moves before
the feature ships, not after.

## Over-limit behaviour

Crossing a bound is a **product state**, not an error toast:

- Remote Access shows `Inventory limit exceeded (257/256)` alongside the
  accepted and reachable counts, so the owner can see that publication is still
  serving the last accepted set.
- The last server-accepted link set and its healthy tunnels stay up. Nothing
  that was reachable becomes unreachable because a 257th workspace appeared.
- Local forwarding still intersects with the **current** canonical inventory, so
  a locally deleted workspace is unreachable immediately even while the
  reconcile is blocked. Failing closed on membership outranks staying published.
- The over-limit additions are not published, and no partial set is written to
  authority.
- The owner clears it by removing or archiving workspaces, or by Stop Sharing.

## Cost evidence

| Measurement | Status | How to produce |
|---|---|---|
| Convex reconcile transaction at 256 entries | **not measured** | `convex/host-enrollments.policy.test.ts` (Unit 6) with a 256-entry fixture; record document reads/writes and bandwidth. |
| SQLite reconcile transaction at 256 entries | **not measured** | `packages/claxedo-server/src/authority/adapters/sqlite/workspace-authority.test.ts` (Unit 6). |
| Bun registration replacement at 256 IDs | **not measured** | `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.e2e.test.ts` against the Bun Relay fixture. |
| Cloudflare room recovery at concurrency 1 / 4 / 8 / 16 | **not measured** | Same suite against the Durable Object fixture; the concurrency cap is what this drill validates or moves. |

These four are load drills against Relay fixtures that Unit 6 creates; they
cannot be run before that unit exists. **The 8-concurrent-reconnect cap is
therefore a starting value, not a validated one** — it is the only bound in this
document with no arithmetic behind it, and Unit 6's acceptance depends on the
Cloudflare drill either confirming it or replacing it.

The size bounds above are different: they are arithmetic on a fixed encoding
and hold independently of any drill.
