---
title: "Universal Sandbox Checkpoints - Plan"
date: 2026-07-27
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Universal Sandbox Checkpoints

## Goal

Every sandbox driver Claxedo supports can capture a workspace checkpoint and
restore it into a **different** sandbox resource.

Two constraints shape the design:

- **BYOK only.** Every sandbox runs in the customer's provider account. Claxedo
  never holds customer source, and retention lands on the customer's bill.
- **Zero added configuration wherever possible.** A customer must not be asked
  to supply object storage for a provider that can already capture natively.

This plan completes [Persistent Cloud Workspaces](./2026-07-23-002-feat-persistent-cloud-workspaces-plan.md).
That plan's `U6` landed the freeze/capture/restore state machine; this one makes
it true for all seven drivers and closes the defects found reviewing it.

## Non-goals

- Memory or process snapshots. Capture stays filesystem-scoped. A restored
  workspace resumes files, Git state, and runtime state — never an in-flight
  agent turn. Deferred by the parent plan and still deferred here.
- Hosted (non-BYOK) sandbox operation, image building, and registry policy.
- Live migration between running sandboxes.

## Current state

Verified against `dev` on 2026-07-27. The state machine in
`packages/sandbox-manager/src/checkpoint-manager.ts` is sound — epoch fencing,
freeze → flush → scrub → snapshot ordering, and a `resume()` correctly gated on
whether the provider already destroyed the source. The gaps are in transfer
semantics, lifecycle hygiene, and driver coverage.

| Driver | Native capture today | Portable needed | Customer bucket needed |
|---|---|---|---|
| daytona | `_experimental_createSnapshot` → filesystem, new-resource | fallback only | no |
| modal | `snapshotFilesystem()` → image id | fallback only | no |
| vercel | `snapshot()` → source-stop, explicit retention | fallback only | no |
| cloudflare | `createBackup`/`restoreBackup` → their own R2 | fallback only | no (worker already binds R2) |
| docker | none — declared `same-resource`, is a no-op | **yes** | no (archive to a host directory) |
| exe | **none, confirmed** — always-on persistent disk, `cp` is live-VM-to-VM only | **yes — sole path** | **yes** |
| box | **continuous automatic**, fork boots a new box — catalog is wrong | fallback only | no |

Five of seven capture natively. `docker` is local and archives to the host.
**`exe` is the only driver that requires a customer bucket**, and the only one
where the portable tier is the sole path rather than a fallback.

### Box (ASCII) — researched 2026-07-27

Per [docs.ascii.dev/box/snapshots](https://docs.ascii.dev/box/snapshots), Box is
strictly more capable than `capture: "none"` claims, and in a shape our model
does not yet express:

- Snapshots are **continuous and automatic** — one per minute while ready or
  idle, one on stop, incrementally compressed, retained for the life of the box.
  Claxedo does not *create* a Box snapshot; it *references* one.
- `box fork` boots **a new box from a snapshot**, so Box supports
  `restoreMount: "new-resource"` natively. `box resume` covers same-box.
- `box snapshot pull <snapshotId> -o ./path` downloads a snapshot, so Box can
  also feed the portable tier without a customer bucket.
- Capture scope is **filesystem only** — `/home/user`, Docker **named volumes**,
  and system paths (`/etc`, `/usr`, `/opt`, `/root`, `/srv`). Memory, running
  processes, and machine identity are excluded, which matches this plan's
  non-goals exactly.

Two consequences, both actionable and both rooted in the same decision:

**Box would capture nothing useful today.** The driver delivers the runtime by
`docker run -d --name … -p …` inside the box (`drivers/box.ts:222`) with **no
volume mount**, so the workspace root lives in the container's writable layer.
That layer is not on Box's documented include-list — named volumes are called
out specifically, which implies the layer is not covered wholesale. Workspace
state must be moved onto a captured path before Box capture means anything.

**Continuous capture defeats scrub.** `C6` assumes credentials are removed
*before* a capture we trigger. On Box, a credential written at T is already
inside the automatic snapshot at T+60s, retained for the life of the box, before
any freeze happens. Scrub cannot protect Box retroactively.

Both are solved by one explicit topology split: **workspace state on a captured
path, credential material on an uncaptured one.** That split is a Box driver
requirement, and stating it as a general rule is cheap insurance on every other
driver too.

### exe.dev — researched 2026-07-27

Per [exe.dev/docs/serverful](https://exe.dev/docs/serverful) and the full CLI
reference at [exe.dev/docs/all](https://exe.dev/docs/all), exe is the mirror
image of Box, and `capture: "none"` is **correct**.

- exe is explicitly **always-on with persistent disks** — "not serverless." The
  full command set is `new`, `rm`, `restart`, `rename`, `tag`, `cp`, `resize`,
  `comment`, plus sharing/domain/integration verbs. There is **no stop/start**,
  and **no snapshot, backup, or fork-from-artifact command anywhere.**
- The only clone primitive is `cp <source-vm> [new-name]`, which copies a
  **live VM to a new VM**. It cannot produce a stored artifact and cannot
  restore a VM that has been `rm`'d.

Two consequences, and they pull in opposite directions:

**exe needs capture least.** Because the disk is always-on and persistent,
cross-session durability — the parent plan's primary goal — is satisfied on exe
with zero work. Capture on exe buys only rollback, recovery after `rm`, and
migration off the provider. It is the lowest-urgency driver, despite having the
least native support.

**But when exe does need capture, only the portable tier can serve it.** This is
what justifies building Tier P rather than shipping native-only.

Rejected: using `cp` as the checkpoint primitive. It requires a live source, so
it fails exactly the recovery case checkpoints exist for, and exe bills disk
usage across all VMs against a shared allowance with overage — a
checkpoint-per-copy strategy multiplies the customer's disk bill against a much
cheaper object-storage alternative. `cp` stays worth exposing as a **fork**
primitive for experimentation; it is not a checkpoint.

Open, not blocking: the documented REST surface covers `GET /snapshots`,
`GET /boxes/{boxId}/snapshots/latest`, and `GET /snapshots/{snapshotId}/files`.
Fork, resume, and delete appear only as CLI verbs. The driver is REST-based
(`BoxFetch`), so `C0` must confirm whether fork is reachable over the API or
must run through the box's own exec path — and whether snapshots can be deleted
at all, since "life of the Box" retention with a per-minute cadence is otherwise
unbounded on the customer's account.

### Defects this plan must close

Each is a Definition of Done item, not a follow-up:

1. **Retention is write-only.** `retentionExpiresAt` is validated by the route
   and stored in checkpoint metadata, and read by nothing. No reaper exists.
   Vercel declares `retention: "explicit"`, so its provider never GCs either.
2. **One checkpoint slot, ever.** `checkpoint: SandboxCheckpointReference | null`
   (`lease-types.ts:44`) is overwritten by each capture, while the route reads
   `/:id/checkpoints/:checkpointId/restore` as if history existed. Every
   superseded provider snapshot is orphaned and unreachable.
3. **Cloudflare restore cannot target a new resource.** `sandboxIdFor` derives
   the sandbox id from the workspace id (`drivers/cloudflare.ts:81`) before
   `bootSource` is consulted, so restore is an in-place rollback into the same
   Durable Object. A wedged DO is unrecoverable, and `restoreMount:
   "copy-on-write"` overstates what the code does.
4. **In-place restore can diverge from the lease.** The worker mounts the backup
   over the live directory *before* `ensureWorkspaceRuntime` (worker
   `index.ts:317-322`). If bring-up then fails, the manager records `restore:
   failed` while the disk already holds the restored tree.
5. **`scrub()` is Codex-only.** It removes `materializedCodexAuthPath` and
   nothing else. Any other credential material on disk rides into an artifact
   that, by design, then boots on a different machine.
6. **Destructive capture can orphan its own checkpoint.** For `captureSource:
   "stopped" | "deleted"`, a successful `snapshot()` stops the source and the
   subsequent `leaseStore.update` may fence, leaving a stopped workspace and a
   snapshot nothing points at.
7. **No coverage above the fakes.** Five tests, all in-memory. Nothing exercises
   a real provider capture → restore.

## Architecture

### Two capture tiers, selected by capability

Capture becomes a tier the manager selects from the driver's capability record,
never from user configuration:

- **Tier N (native).** The provider's own snapshot/backup. Preferred whenever
  the driver declares it. Faster, whole-filesystem, and needs no storage
  binding. Not portable across providers.
- **Tier P (portable).** `workspace-runtime` archives its own state root to an
  artifact store. Available on every driver by construction, because every
  driver runs the runtime and has outbound network by contract. Portable across
  providers and across resources.

Selection order: **native if declared → portable if an artifact store is bound →
`workspace_checkpoint_unsupported` with an actionable message naming what to
bind.** A customer on daytona/modal/vercel/cloudflare/docker never sees a
storage prompt.

Tier P also stays *explicitly* requestable on native-capable drivers, because it
is the only path that produces a cross-provider artifact. That is the migration
story, not the default.

### The portable artifact

The runtime already owns a canonical, self-contained state root
(`workspaceStorageRoot`, `workspace-runtime/src/worktree.ts:13`):

```text
$HOME/.claxedo/workspaces/<workspace-id>/
  repo.git/                   bare repository
  worktrees/<session-id>/     session checkouts
  runtime/state.db            runtime state
```

Tier P captures exactly this tree — after the existing freeze/flush/scrub, so
consistency is inherited rather than reinvented. The artifact is a single
content-addressed compressed tar plus a manifest recording workspace id, source
epoch, runtime version, image digest, tree digest, and the scrub attestation
from C6.

Worktrees are reconstructible from `repo.git`, so the archive stores the bare
repository plus per-worktree branch/base-commit metadata rather than full
checkouts. Restore rehydrates worktrees through the existing
`WorkspaceWorktreeManager` reconcile path.

### Restore always targets a fresh resource

This is the structural fix for defect 3 and the reason defect 4 disappears
rather than being patched.

`driverResourceId` becomes **authoritative on the lease** instead of derived
inside a driver. Restore allocates the next epoch — which
`restoreSandboxCheckpoint` already does, already fenced, already covered by
`"restores through exactly one new epoch"` — provisions a resource named for
that epoch, imports the checkpoint, verifies runtime health, and only then cuts
the lease over. The old resource is destroyed after cutover.

Relay routing already follows `target.hostId` off the lease, so the cutover
point is a lease update that is already fenced. Consequences: restore stops
being destructive, a wedged resource can be evacuated, and fork/clone becomes
reachable from the same seam.

Providers whose capability record genuinely cannot boot a new resource from a
checkpoint keep `restoreMount: "same-resource"` and must say so honestly. No
driver may declare a portability it does not implement.

## Implementation

### C0. Provider capture research

**Largely resolved 2026-07-27** — see the exe.dev and Box findings above. The
headline question is answered: **`exe` is the only driver that will ever ask a
customer for a bucket.** What remains is narrow and no longer blocks `C1`.

Remaining questions, each a small independent probe:

- **Box fork reachability.** Fork and resume appear only as CLI verbs while the
  driver is REST (`BoxFetch`). Confirm whether fork is available over the API or
  must run through the box's exec path.
- **Box snapshot deletion.** No delete endpoint is documented, and "life of the
  Box" retention at a per-minute cadence is otherwise unbounded on the
  customer's account. If deletion is genuinely unavailable, `C5`'s reaper cannot
  cover Box, and the capability record must say so rather than imply control we
  do not have.
- **Daytona snapshot stability.** The driver calls `_experimental_createSnapshot`.
  Confirm whether a stable equivalent exists before making it a release gate.

No API behavior may be assumed. Every capability claim entering the table cites
provider documentation.

**Acceptance:** each question resolves to a documented answer with a citation,
or to an explicit "not supported" with the doc URL checked. Any capability a
provider does not actually offer is removed from the record rather than left
aspirational.

### C1. Capability record and tier selection

Extend the persistence capability record with the tier set, and add
`capture: "portable"` alongside the existing scopes. Move tier choice into one
function so no driver branches on its own id.

Primary files:

- `packages/sandbox-manager/src/driver-catalog.ts`
- `packages/sandbox-manager/src/lease-types.ts`
- `packages/sandbox-manager/src/checkpoint-manager.ts`
- `packages/sandbox-manager/src/index.ts`

Tests: tier selection for all seven drivers; native preferred over portable;
unsupported combinations rejected before any provider call; a driver declaring a
tier it cannot serve fails validation at catalog load.

**Acceptance:** `validateSandboxPersistenceCapabilities` rejects any record whose
declared tiers exceed its implemented operations. Selecting a tier performs no
I/O.

### C2. Portable capture and restore in the runtime

Add `/api/wr/checkpoint/export` and `/api/wr/checkpoint/import` to the existing
checkpoint router, reusing freeze/flush/scrub rather than duplicating them.
Export streams the archive to a caller-supplied signed URL; import streams it
back and hands off to worktree reconcile. Neither endpoint ever sees a
long-lived storage credential.

Primary files:

- `packages/workspace-runtime/src/routes/checkpoint.ts`
- `packages/workspace-runtime/src/workspace/runtime.ts`
- `packages/workspace-runtime/src/worktree.ts`
- `packages/claxedo-server/src/workspace-checkpoints/service.ts`

Tests: round-trip fidelity (Git history, branches, base commits, `state.db`
rows); archive is byte-stable for an unchanged tree; import into an empty root;
import over a populated root; path containment on a hostile archive; export
refused unless frozen.

**Acceptance:** a workspace exported and imported into a *different* container
reports identical `git log --all`, identical registered worktrees, and identical
runtime state rows. Verified for real, not asserted from a fake.

### C3. Artifact store binding

Bind an artifact store per workspace: an S3-compatible bucket the customer
supplies, or a host directory for `docker`. Claxedo brokers short-lived signed
URLs to the runtime and never places long-lived storage credentials inside a
sandbox — the same posture as the existing egress broker.

Only drivers that `C0` confirms have no native capture may require this
binding, and the UI must not surface it for drivers that do not need it.

Primary files:

- `packages/claxedo-server/src/workspace-checkpoints/service.ts`
- `packages/claxedo-server/src/routes/workspace-checkpoints.ts`
- `packages/sandbox-manager/src/drivers/docker.ts`
- `packages/claxedo-app/src/features/workspaces/ui/panel/workspace-panel.tsx`

Tests: signed URLs are short-lived and scoped to one object; a sandbox never
receives raw storage credentials; missing binding on a portable-only driver
produces an actionable error naming the driver and the setting.

**Acceptance:** a checkpoint on `exe` or `box` lands in the customer's bucket,
and grepping the container environment and filesystem for the storage secret
returns nothing.

### C4. Authoritative resource identity and fresh-resource restore

Make `driverResourceId` lease-owned and epoch-scoped. Remove the derived
`sandboxIdFor` path in the Cloudflare driver. Restore provisions the new
resource, imports, verifies health, cuts the lease over, then destroys the old
one. Correct the Cloudflare capability record to match observed behavior.

Primary files:

- `packages/sandbox-manager/src/drivers/cloudflare.ts`
- `packages/sandbox-manager/src/checkpoint-manager.ts`
- `packages/sandbox-manager/src/index.ts`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/index.ts`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/wrangler.toml`

Also in scope: the shipped worker template pins `regions = ["APAC"]` and
`max_instances = 3`. Both are deploy-time defaults every BYOK customer inherits.
Make them documented, overridable settings rather than hardcoded values.

Tests: restore yields a resource id different from the source; a failed bring-up
leaves the *old* resource serving and the lease unchanged; concurrent restores
fence to one winner; the old resource is destroyed exactly once after cutover.

**Acceptance:** defect 3 and defect 4 are covered by tests that fail against
today's `dev`.

### C5. Checkpoint history and retention

Replace the single checkpoint slot with a bounded, ordered list. Implement the
reaper that reads `retentionExpiresAt`, deletes the provider snapshot or stored
artifact, and prunes the lease entry. Reconcile orphans left by earlier builds.

Primary files:

- `packages/sandbox-manager/src/lease-types.ts`
- `packages/sandbox-manager/src/checkpoint-manager.ts`
- `packages/claxedo-server/src/sandbox-manager-adapters/stores/sqlite.ts`
- `packages/claxedo-server/src/sandbox-manager-adapters/stores/convex.ts`
- `convex/schema.ts`, `convex/sandboxLeases.ts`

Tests: retention expiry deletes provider-side and lease-side together; deletion
is idempotent; a checkpoint referenced by an in-flight restore is never reaped;
lease-store equivalence across memory, SQLite, and Convex.

**Acceptance:** no code path can create a provider snapshot that nothing points
at. A capture followed by expiry leaves zero provider-side residue, asserted
against a real provider in `C8`.

### C6. Scrub hardening

Replace the single hardcoded Codex path with a swept deny-list covering every
credential location any harness materializes, plus workspace-local `.env` files,
git credential stores, and shell history. Emit a scrub attestation into the
checkpoint manifest.

Primary files:

- `packages/workspace-runtime/src/workspace/runtime.ts`
- `packages/agent-sdk-runtime/src/harnesses/*/`
- `packages/sandbox-manager/src/checkpoint-manager.ts`

Tests: a table-driven test plants a known secret at every path in the deny-list,
captures, and asserts none survives into the artifact. Adding a harness that
materializes credentials without extending the deny-list fails the test.

**Acceptance:** the deny-list is derived from harness code rather than
hand-maintained, and the planted-secret test covers every harness currently
shipped.

### C7. Destructive-capture durability

Persist the checkpoint reference before invoking a capture that stops or deletes
the source, then confirm it. On fence or crash between the two, the next
`ensure` reconciles from the persisted reference instead of stranding the
workspace.

Primary files:

- `packages/sandbox-manager/src/checkpoint-manager.ts`
- `packages/sandbox-manager/src/index.ts`

Tests: fault injection between `snapshot()` and `leaseStore.update` leaves a
recoverable workspace on every `captureSource` value.

**Acceptance:** defect 6 has a test that fails against today's `dev`.

### C8. Driver conformance suite

One parameterized suite, run against every driver, replacing per-driver
bespoke assertions. This is the release gate.

Cases, per driver, per supported tier:

1. capture → destroy resource → restore → Git history, worktrees, and runtime
   state are identical.
2. restore lands on a **different** resource id, or the driver declares
   `same-resource` and the suite asserts that instead.
3. capture during an active agent turn drains cleanly and produces no torn tree.
4. bring-up failure during restore leaves lease and disk mutually consistent.
5. no planted credential survives capture.
6. an expired checkpoint is fully reaped, provider-side and lease-side.
7. portable artifact captured on driver A restores on driver B.

Primary files:

- `packages/sandbox-manager/src/drivers/conformance.test.ts` (new)
- `packages/sandbox-manager/src/drivers/*.test.ts`

Real-provider runs are opt-in by credential presence and run in CI nightly, not
per-PR. Fakes stay for the fast path; they do not satisfy the gate.

**Acceptance:** every driver either passes every case for its declared tiers, or
its capability record is amended so the suite asserts the weaker truth. A driver
may not claim a capability the suite does not prove.

Implementation order: `C0` → `C1` → (`C2`, `C4`, `C5`, `C6`, `C7` in parallel)
→ `C3` → `C8`.

## Inherited quality bars

From [Persistent Cloud Workspaces](./2026-07-23-002-feat-persistent-cloud-workspaces-plan.md)
and standing repo practice:

- **Strangler/additive.** The existing native path keeps working throughout.
  No phase lands a window where a driver that captures today cannot.
- **TDD with behavior-asserting tests.** Every defect above gets a test that
  fails against current `dev` before the fix lands.
- **Make illegal states unrepresentable.** A capability a driver cannot serve
  must not be expressible in its record; `C1` enforces this at load.
- **No false-positive verification.** A green fake-backed suite is a claim about
  the state machine. The `C8` real-provider run is the evidence.
- **Per-slice verification loop.** Each phase is verified against a real
  provider before the next dependent phase starts.

## Definition of Done

- [ ] `C0` complete: Box fork reachability, Box snapshot deletion, and Daytona
      snapshot stability each resolved with a citation. Progress: exe.dev and
      Box capture models researched 2026-07-27; `exe` confirmed as the only
      driver requiring a customer bucket.
- [ ] Box captures the workspace at all — state moved onto a snapshotted path,
      credential material kept off one. Progress:
- [ ] Every driver declares a capture tier it actually implements, enforced at
      catalog load. Progress:
- [ ] Portable capture and restore work on all seven drivers. Progress:
- [ ] No customer on daytona, modal, vercel, cloudflare, or docker is asked to
      supply object storage. Progress:
- [ ] A portable artifact captured on one driver restores on another. Progress:
- [ ] Restore provisions a new resource and cuts over via the lease; a failed
      bring-up leaves the previous resource serving. Progress:
- [ ] `retentionExpiresAt` is enforced by a reaper; no path creates a provider
      snapshot nothing points at. Progress:
- [ ] Checkpoint history is bounded and ordered; the restore route's
      `:checkpointId` resolves against real history. Progress:
- [ ] The planted-secret test covers every shipped harness and passes on every
      driver. Progress:
- [ ] Destructive capture is recoverable at every interruption point. Progress:
- [ ] The `C8` conformance suite passes against real providers for every driver
      and every declared tier. Progress:
- [ ] Cloudflare's `regions` and `max_instances` are documented, overridable
      settings rather than hardcoded template values. Progress:
- [ ] Capability tables in this plan, `driver-catalog.ts`, and user-facing docs
      agree; no doc claims portability the suite does not prove. Progress:

## Execution: parallelize with agents and workflows

`C0` no longer blocks. Its three residual probes are independent and should run
as parallel agents alongside `C1`, each returning a documented finding with a
citation. Note that provider docs here are JS-rendered — exe.dev in particular
returns only a page title to a plain fetch, so a research agent must drive a
browser rather than conclude "undocumented" from an empty fetch.

`C1` is a narrow single-owner change and must land before the parallel block —
it defines the contract every other phase writes against.

Box's topology fix (workspace state onto a snapshotted path, credentials off
one) is owned by whichever agent takes `C6`, not by a separate Box agent — it is
the same decision viewed from the capture side and the secret side, and
splitting it across two agents would let them contradict each other.

The `C2`/`C4`/`C5`/`C6`/`C7` block has near-disjoint file ownership and should
run as concurrent agents:

| Agent | Owns | Must not touch |
|---|---|---|
| portable-capture | `workspace-runtime/src/routes/checkpoint.ts`, `worktree.ts` | `drivers/*` |
| resource-identity | `drivers/cloudflare.ts`, sandbox worker | `lease-types.ts` |
| retention | lease stores, `convex/` | `workspace-runtime/*` |
| scrub | `workspace/runtime.ts`, harness auth paths | `checkpoint-manager.ts` |
| durability | `checkpoint-manager.ts` | everything else |

`checkpoint-manager.ts` is the one contended file — `C7` owns it for the
duration of the block, and `C4`/`C5` submit their changes to it through that
owner rather than editing in parallel.

`C8` is a pipeline, not a barrier: each driver's conformance run is independent,
so drivers verify as soon as their dependent phases land rather than waiting for
the slowest. Run per-driver research, implementation, and verification as one
chain per driver.

Verification is itself parallel: capability research, real-provider conformance,
and doc-truthfulness checks are three independent sweeps.
