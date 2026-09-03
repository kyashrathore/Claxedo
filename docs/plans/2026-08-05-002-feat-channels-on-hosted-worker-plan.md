# Channels on the hosted Worker — ack and execution are different things

Date: 2026-08-05. Status: active implementation plan.

Makes GitHub / Slack / Telegram / Discord / WhatsApp-official channels work on
the deployed hosted control plane (the Cloudflare Worker,
`src/deployments/hosted-workerd/worker.ts`), which today serves no channel
routes.

The organizing decision, and the reason this plan is tractable:

> **Delivery-ack and turn-execution are separate invocations.** The webhook
> request verifies, dedups, enqueues, and returns. A wake fires later and does
> the provisioning, prompting, and replying.

Everything below follows from that split. It is not a new pattern: the hosted
wake substrate already runs this shape (`WakeLane` DO → hosted runtime → sandbox
+ relay + prompt). This plan attaches channels to that seam rather than
inventing a second one.

Related: [`2026-07-07-002`](./2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md)
(self-host channel loop, the working reference implementation).

---

## Where things stand

| Composition | Channels? | Deployed by |
| --- | --- | --- |
| `deployments/hosted-workerd/worker.ts` | **no** | `deploy-control-plane.yml` (this plan's target) |
| `deployments/hosted-node/index.ts` | yes, fully wired | **nothing** |
| `deployments/local/server.ts` | yes | `fly.toml` → `local/main.ts` |

The Worker's exclusion is enforced, not accidental:
`worker.import-graph.test.ts:31` forbids the bare import `@claxedo/channels`;
`:64-68` forbids local `channels/control-plane`, `channels/dedup`,
`channels/delivery`, `channels/run-audit`, `channels/whatsapp-baileys-auth-state`.
The reason is storage: those modules are Drizzle-on-SQLite through `ClaxedoDB`,
and the hosted Worker's `projectionStore` is
`unusedStore<ProjectionStore>(...)` (`authority/hosted-services.ts:442`).

Those entries are **the gate, not the obstacle**. They stay until the thing they
describe is no longer true. `@claxedo/channels` core is Hono + pure logic and
comes off `FORBIDDEN_BARE` only once nothing beneath it touches SQLite. The
local `channels/*` entries stay forbidden **permanently** and gain
control-plane-database-backed siblings beside them.

### Hosted execution is already real, sandboxed, and Worker-driven

The hosted runtime provisions a cloud sandbox from
inside the Worker and prompts it over the relay: `manager` /
`provider.mintRuntimeAccessToken` / `provider.getRelayEndpoint`, then
`POST /api/session` with `location: { directory: "/workspace" }` (`:406-418`)
and `POST /api/session/:id/prompt` (`:494`). Real tools, real repo. Phase 3
reuses this path with a channel trigger.

The `central_hybrid_virtual_tools_only` throw in
`deployments/hosted-node/index.ts:71-80` is scoped to a different composition —
the `createEnv`/`SessionEnv` seam of the **in-process central runtime**, which
has no signed-auth context and so cannot resolve a hosted workspace. The Worker
path never reaches that seam, and this plan is not constrained by it.

### Already built, reusable as-is

- **Hosted channel *authorization*.** The `channel_identities` table, reached
  through the workspace-authority identity adapter
  (`authorizeChannelProject` / `authorizeChannelWorkspace`). Done.
- **The dedup-store seam.** `channels/dedup.ts:27-32` already degrades to memory
  when the optional `ProjectionStore` methods are absent — designed for a second
  backend.
- **A declared, unimplemented hosted outbound seam.** `hosted-app.ts` threads an
  owner-notification hook; `worker.ts` never passes it, and the hosted operation
  throws `"Hosted owner channel notification is unavailable"`. Phase 4 lights
  this up.
- **The wake substrate.** `WakeLane` / `LiveSyncRoom` DOs
  are deployed (`wrangler.toml`, `worker.ts:44-50`); sinks register in
  `hosts/wakes/hosted-wakes.ts:207+`.

### Genuinely missing

1. D1 implementations of the optional `ProjectionStore` channel methods
   (`authority/projection-store.ts:45-53`) + the access/pairing/binding stores.
2. A channel wake kind and its sink.
3. Durable approvals — `createMemoryApprovalBridge`
   (`channels/control-plane.ts:512`) is a `Map`.
4. Outbound reply delivery from a DO.

Note that `centralSessionRouteEvents` (`channels/control-plane.ts:160-205`) —
the async generator that streams a turn inside the request — is **deleted on the
hosted path, not ported**. It is the one construct that cannot survive a Worker
request lifetime, and the ack/execute split removes the need for it.

### Out of scope: WhatsApp personal / Baileys

**Not in scope for this plan, on lifetime rather than dependency grounds.**

The disqualifier is the execution model, not the import graph. Baileys holds a
**stateful, long-lived, authenticated WebSocket** that it owns and reconnects
(`createBaileysWhatsAppSocket` in `transport/whatsapp-baileys-socket.ts` keeps a
live `WASocket` with `messages.upsert` / `creds.update` / `connection.update`
handlers and mutable `state.auth` in closure). A Worker isolate is
request-scoped and evictable; there is no invocation that owns a socket for
days. Every other channel here is webhook-shaped — a provider POSTs, we ack —
which is precisely why the ack/execute split works for them and not for this.

Worth recording accurately, because it bounds any future attempt:

- **Our own code is Worker-clean.** `whatsapp-baileys.ts`,
  `whatsapp-baileys-socket.ts`, and `channels/whatsapp-baileys-auth-state.ts`
  contain no `node:` imports; auth state already persists through the
  credentials port, not the filesystem.
- **The library's hard blockers are narrower than "node deps".** Baileys 7.0.0-rc13
  pulls `crypto`, `stream`, `events`, `util`, `url`, `zlib`, `https` — largely
  covered by `nodejs_compat`. `whatsapp-rust-bridge` is **WASM, not a native
  `.node` addon**, so it is not itself disqualifying. The genuinely
  Worker-hostile imports (`fs`, `fs/promises`, `child_process`, `os`) are
  confined to `messages-media.js`, `use-multi-file-auth-state.js`,
  `business.js`, `browser-utils.js`, `messages.js` — media and file-auth
  helpers, not the socket core. It also ships an `engine-requirements.js`
  asserting `process.versions.node >= 20`.
- **A Durable Object is the only plausible host** if this is ever revisited: DOs
  have identity and hibernation, which is closer to a socket owner than a
  `fetch` handler. It remains a separate, larger investigation and is not
  assumed by anything in this plan.

For now the registry (`registry.ts:73-84`) already selects `baileys` vs
`chat-sdk` by `CLAXEDO_CHANNEL_WHATSAPP_MODE`; hosted must hard-fail `personal`
at composition rather than silently degrade. WhatsApp **official** (Cloud API,
`chat-sdk` transport) is webhook-shaped and fully in scope.

---

## A channel talks to one central agent; the agent decides everything else

**The channel layer does not choose workspaces, sandboxes, or session
lifetimes.** It routes a thread to a single central agent session and stops
there. If work needs a repo, the agent spawns a background session for it.

This is the acceptance scenario `2026-07-07-002` already states:

> Send a message from Telegram/Discord → an AI session is created (**central pi,
> no sandbox tool / no workspace dir**) → it understands intent (which workspace
> / sandbox / repo) → it creates a background session via claxedo-mcp → streams
> the reply back → the background session creates a PR

The dispatch tool exists: `spawn_session` (`session/runtime.ts:825-855`),
described in-tree as the in-process equivalent of the claxedo-mcp tool, "no MCP
hop needed for the pi central harness". It takes a prompt and an optional
`workspace_id`, creates the session, and fires the initial prompt
fire-and-forget.

**Why this is the right seam, not merely a convenient one.** A channel knows a
thread and a sender. It cannot tell whether "what's the status of PR 42" needs a
sandbox (it doesn't) or "fix the failing test" does (it does). That judgment
requires reading the message. Any sandbox policy chosen at the channel layer is
therefore chosen blind, and would be wrong for half of all traffic. Pushing the
decision to the agent puts it where the intent is.

What this removes from the channel layer outright:

- No sticky-vs-ephemeral-vs-hybrid workspace policy.
- No resolve-or-provision path, and no reaped-sandbox recovery. A central
  session has no sandbox to reap.
- `channel_thread_session` (`channels/run-audit.ts:100`) keeps its **current**
  meaning — thread → central session — so nothing is reinterpreted.

Sandbox lifetime still gets decided; it is decided per-request by the agent,
with intent in hand, through `spawn_session`'s existing path. Background
sessions provision through the hosted runtime exactly as today,
including the hosted `autoStopMinutes` of 30 min (`hosted-services.ts:167`,
`CLAXEDO_SANDBOX_AUTO_STOP_MS`).

### The blocker this inherits: hosted has no session storage

Not a design question — a named dependency with a known cause.

`spawn_session` and the central agent live in `session/runtime.ts` behind
`createCentralControlApp` (`central-runtime.ts`), which `hosted-node` composes
and `worker.ts` does not. `central-runtime` is in `FORBIDDEN_LOCAL`
(`worker.import-graph.test.ts:61`). `session/runtime.ts:1` imports
`node:crypto`, and the pi harness reaches `node:fs`/`os`/`path` through
`harnesses/pi/local-auth.ts`. The central runtime is a Node in-process runtime;
it does not run on workerd, and this plan does not port it.

The underlying reason is storage, not placement.
`hosted-services.ts:442-443` sets **both** `projectionStore` and
`durableSessionLog` to `unusedStore(...)` — a Proxy that throws on any method
call, deliberately fail-closed ("not part of the hosted Worker surface"). A
central agent session is a session: it has meta, messages, and a durable log.
Hosted currently has nowhere to put any of it.

The agent-as-pi-central-session shape, which makes channel-triggering free, is
blocked hosted until `projectionStore`/`durableSessionLog` get D1 adapters.

**This is the same seam Phase 1 already opens**, at larger surface. Phase 1 does
the four channel-specific `ProjectionStore` methods; the central agent
additionally needs the session-meta/message surface and `durableSessionLog`.
One dependency, two consumers — so the sequencing is Phase 1 first, and the
central agent lands on top of it rather than beside it.

The hosted execution precedent, once storage exists, is the hosted agent turn:
the Worker mints a RAT, opens a relay session, and prompts it — Worker
orchestrates, harness runs in a sandbox over the relay.

Note that pi is no longer the stub `2026-07-07-002:123` describes —
`harnesses/pi/index.ts` imports real `@mariozechner/pi-agent-core` and
`runPiModelTurn` is implemented. The harness is real; its hosted storage is what
is missing.

### The tenant rule rides along

An inbound channel message needs an `(organizationId, ownerUserId)` tenant to
key wakes and control-plane writes. `channel_identities` resolves sender→user, and
`notifyOwner` (`channels/control-plane.ts:597-660`) already walks
account→bound-recipients. The reverse direction (sender → org for an *unpaired*
sender in a repo-linked thread) needs an explicit rule. Proposal, to confirm in
Phase 0: **the workspace's org wins**, and an unpaired sender gets pairing,
never implicit tenancy.

---

## Phase 0 — Close the gate honestly (independently shippable)

Small, correct regardless of everything downstream.

- [ ] `deploy-control-plane.yml:72` says `packages/channels/**`; the package is
      `packages/claxedo-channels`. That filter has never matched. Fixed, and a
      test asserts every `packages/*` path filter in the workflow resolves to a
      real directory. Progress:
- [ ] Hosted composition **hard-fails** `CLAXEDO_CHANNEL_WHATSAPP_MODE=personal`
      with a `HostedWorkerCompositionError` naming the socket-lifetime reason,
      rather than registering a transport that has no invocation able to own its
      socket. Test asserts the throw; `official` mode still composes. Progress:
- [ ] The sender→tenant rule is a typed function with a name (not inlined at a
      call site), encoding "workspace org wins; unpaired sender gets pairing,
      never implicit tenancy", with the negative test: an unpaired sender in a
      repo-linked thread does NOT inherit tenancy. Progress:
- [ ] `worker.import-graph.test.ts` gains a comment block naming which
      `FORBIDDEN_*` entries are permanent (local `channels/*`) vs conditional
      (`@claxedo/channels`, pending Phase 1). Progress:
- [ ] `bun run typecheck` + `claxedo-server` suite green. Progress:

## Phase 1 — D1-backed channel stores (the mechanical half)

No behavior change on any existing deployment. Self-host keeps SQLite.

- [ ] D1 schema and queries for channel delivery, run audit, and
      thread→session binding, mirroring `channels/delivery.sql.ts` /
      `run-audit.sql.ts`. Progress:
- [ ] D1 implementations of the optional `ProjectionStore` methods:
      `claim_channel_delivery`, `remember_channel_delivery_session`,
      `release_channel_delivery`, `count_channel_deliveries_by_user_day`,
      `record_channel_run_audit`, `channel_run_audit`, `channel_run_audits`,
      `channel_thread_session`, `clear_channel_thread_session`. Progress:
- [ ] **The claim is atomic in ONE mutation.** `claimChannelDelivery`
      (`channels/delivery.ts:57`) is a SQLite transaction doing
      read-check-insert; splitting it across separate statements double-spends the daily
      ceiling under concurrent provider retries. A test fires N concurrent
      identical deliveries and asserts exactly one non-duplicate. Progress:
- [ ] **`initialized_at` semantics preserved.** `delivery.ts:38-45` seeds
      `now - 24h` and rejects older `receivedAt` as `stale_delivery`. Test: a
      fresh store refuses a stale replay, an established store accepts a normal
      retry. Progress:
- [ ] D1-backed `ChannelAccessStore` + `ChannelIdentityBindingStore`
      (pairing requests, approved-sender allowlist, identity bindings), matching
      `channels/access-store.ts` including lazy expired-pairing pruning. Progress:
- [ ] **One conformance suite runs against both backends** (SQLite + D1) and
      passes identically. This is the phase's real deliverable — not two
      implementations, one contract. Progress:
- [ ] Negative proof: a store missing one method degrades exactly as
      `dedup.ts:27-32` documents, and a test pins that the *fallback is memory*,
      so nobody mistakes it for durability. Progress:
- [ ] Self-host behavior byte-identical: existing channel tests pass unmodified. Progress:
- [ ] `bun run typecheck` green; `claxedo-server` + `claxedo-channels` suites green. Progress:

## Phase 2 — Durable approvals (blocking for any multi-isolate deploy)

`createMemoryApprovalBridge` is a `Map`. In-process it is restart-fragile; split
across ack and execute it is **wrong** — the prompt is created in one isolate and
answered in another.

- [ ] A durable `ApprovalBridge` backed by the projection store, implementing the
      same port (`core/approval-bridge.ts:20-40`). Progress:
- [ ] Test: prompt created in one store instance, decided through a *separate*
      instance, resolves correctly. This is the isolate-crossing proof. Progress:
- [ ] Token→callId lookup and `pendingForThread` newest-first ordering
      (`:28-30`, which a bare "yes" depends on) preserved under the durable
      backend. Progress:
- [ ] Expiry: an approval older than a configured TTL is refused with a distinct,
      user-legible reason — not a bare "no longer pending". Progress:
- [ ] Negative proof: reverting to the memory bridge turns the cross-instance
      test red. Progress:
- [ ] Self-host may adopt the durable bridge too (its restart-loss of pending
      approvals is a real defect). If deferred, say so explicitly here. Progress:

## Phase 3 — The split: ack in the Worker, central turn on a wake

**Ingress (Worker `fetch`, target < 50 ms):** verify provider signature →
`InboundEnvelope` → access gate + rate limit → `claim_channel_delivery` →
enqueue wake → 200. **No session work whatsoever.**

**Execution (`WakeLane` DO):** resolve the thread's **central agent session**
(create on first message) → prompt it. No workspace resolution, no sandbox
provisioning, no repo. If the agent decides work is needed, it calls
`spawn_session` and that path provisions exactly as it does today.

### Phase 3.0 — The hosted central agent (gate; depends on Phase 1)

Blocks 3.1. This is build work, not a spike: the shape is settled (relay-hosted
central session, driven by the Worker, spawning workers via `spawn_session`),
and what is missing is hosted session storage.

- [ ] `projectionStore`'s session surface (meta + messages) and
      `durableSessionLog` have D1 adapters, replacing the fail-closed
      `unusedStore` stubs at `hosted-services.ts:442-443`. Extends Phase 1's
      work on the same port rather than duplicating it. Progress:
- [ ] A hosted central agent session can be created and prompted **with no
      workspace directory** — a central agent has no repo. Proven by execution.
      If the hosted session path turns out to require a workspace, that is a
      finding, and this checkbox records it rather than papering over it. Progress:
- [ ] `spawn_session` is reachable from the hosted central agent. The in-process
      tool (`session/runtime.ts:825`) is Node-only, so hosted uses the
      claxedo-mcp path; the chosen mechanism is named here once real. Progress:
- [ ] A spawned worker session provisions a sandbox through the existing hosted
      runtime path, unchanged by this plan. Progress:
- [ ] `central-runtime` and `session/runtime` stay in `FORBIDDEN_LOCAL` — the
      hosted central agent is a relay-hosted session the Worker drives, never a
      port of the Node in-process runtime. Import-graph test still green. Progress:

### Phase 3.1 — The split itself

- [ ] A `channel_turn` wake kind + intent parser in
      `hosts/wakes/hosted-wakes.ts`, with its sink registered in the same
      `sinks:` map (`:207+`). Progress:
- [ ] **Lane key = `(channel, threadKey)`**, so two messages in one thread
      serialize and never race a central session into existence twice. Test: two
      concurrent inbound messages on one thread produce exactly one session. Progress:
- [ ] The channel path **never names a workspace or sandbox**. Asserted
      structurally: no `workspaceId` is resolved on the inbound path, and a test
      proves a message needing no repo provisions nothing. Progress:
- [ ] `spawn_session` from a channel-originated central session produces a
      background session whose sandbox provisioning is the existing path,
      untouched by this plan. Progress:
- [ ] `centralSessionRouteEvents` is **not present** in the hosted path, asserted
      by the import-graph test. Progress:
- [ ] Ingress returns 200 without awaiting turn execution, proven by a test that
      makes the execution path block indefinitely and still observes a fast 200. Progress:
- [ ] **Ack does not imply admission.** A claimed-but-rejected delivery (access
      denied, budget exceeded) releases its claim — `release_channel_delivery`
      exists for this and is already used in `notifyOwner` (`:645`, `:658`).
      Test: a denied message does not permanently consume its idempotency key. Progress:
- [ ] Turn failure is durable and visible: a failed turn parks with a reason,
      does not silently vanish, and does not wedge the lane. Progress:
- [ ] Wake budgets on this lane are **real**, not `MAX_SAFE_INTEGER`. Hosted
      wakes currently disable budgets wholesale (`hosted-wakes.ts:200-204`)
      because settle wakes are infra bookkeeping — **channel turns are
      attacker-reachable and must not inherit that**. A channel message must not
      be able to fan out unbounded `spawn_session` calls; `maxDepth` is the
      relevant bound and it currently bounds nothing hosted. Progress:
- [ ] `@claxedo/channels` core comes off `FORBIDDEN_BARE` **only** if nothing it
      pulls touches SQLite/node — verified by the import-graph walk, not by
      inspection. Local `channels/*` stay forbidden. Progress:
- [ ] `bun run typecheck` green; worker import-graph + security-header +
      scheduled tests green. Progress:

## Phase 4 — Outbound replies from the DO

In-process streaming gave incremental message edits for free. Split, the turn's
outcome has to reach the thread from a different invocation.

- [ ] Outbound delivery generalized from `notifyOwner`
      (`channels/control-plane.ts:597-660`) — it already does channel selection,
      dedup-claim, rate-limit, post, and release-on-failure. Generalize it; do not
      write a second one. Progress:
- [ ] `worker.ts` passes the owner-notification hook into `createHostedApp`, and
      the `"Hosted owner channel notification is unavailable"` throw becomes
      unreachable on a configured deployment. Test asserts the `notify_owner`
      operation succeeds hosted. Progress:
- [ ] Reply posting is idempotent under wake re-drive: a wake that fires twice
      (lease lapse, crash recovery) does **not** double-post. The delivery claim
      is the mechanism; the test must exercise an actual re-drive. Progress:
- [ ] Streaming posture is an explicit, documented decision — post-on-completion
      vs periodic edit — not an accident of the split. Whichever is chosen, the
      user-visible latency story is written down here. Progress:
- [ ] Approval prompts round-trip end-to-end hosted: agent requests → prompt in
      thread → user answers → decision reaches the session. Progress:

## Phase 5 — Prove it on staging

Repository-green is not evidence for this one. Per
[[feedback-no-false-positive-verification]] and
[[feedback-local-first-deploys]], replay locally first, then deploy once.

- [ ] `workerd` local run (miniflare/wrangler dev) exercises ingress → wake →
      turn → reply against a scripted provider webhook, before any deploy. Progress:
- [ ] A channel smoke joins `deploy-control-plane.yml` beside `smoke:interactive`,
      asserting a real inbound webhook produces a real session and a real reply on
      staging. Progress:
- [ ] The smoke asserts the **fail-closed** direction too: a forged/unsigned
      webhook is rejected. Fail-closed on garbage credentials is already the house
      pattern for the existing smoke. Progress:
- [ ] Staging evidence is quoted inline in the PR (error text / response bodies),
      never as a bare artifact path — artifacts are consumable and the next run
      deletes them ([[reference-playwright-artifacts-are-consumable]]). Progress:
- [ ] Rollback note added to `public-docs/deploy-runbook.md`: how to disable
      channel ingress on a live Worker without a redeploy (registry env flags are
      the intended lever — confirm they actually are). Progress:

---

## Definition of Done

- [ ] A GitHub mention on a linked repo, sent to the **deployed staging Worker**,
      reaches a central agent session and replies in-thread. Progress:
- [ ] That agent, when the message warrants it, spawns a background session that
      does sandboxed work — proving the channel→central→spawn loop end to end
      rather than only the conversational half. Progress:
- [ ] The channel layer chooses no workspace, sandbox, or session lifetime;
      every such decision is the agent's, via `spawn_session`. Progress:
- [ ] Provider webhooks are acked in milliseconds; no turn executes inside a
      `fetch` handler. Progress:
- [ ] Every channel store the hosted path touches is D1-backed; one
      conformance suite passes against both backends. Progress:
- [ ] No approval, dedup claim, or thread binding lives in process memory on the
      hosted path. Progress:
- [ ] A duplicate provider delivery, and a re-driven wake, each produce exactly
      one session and one reply. Progress:
- [ ] Local `channels/*` remain in `FORBIDDEN_LOCAL`; any `FORBIDDEN_BARE`
      relaxation is justified by the graph walk, not by assertion. Progress:
- [ ] `CLAXEDO_CHANNEL_WHATSAPP_MODE=personal` fails hosted composition loudly. Progress:
- [ ] Self-host channel behavior is unchanged — its tests pass unmodified. Progress:
- [ ] `bun run typecheck` + full suite green in a CI-equivalent container
      ([[feedback-simulate-ci-locally]]), then pushed once. Progress:
- [ ] Staging smoke green in both directions (works / fail-closed), evidence
      quoted inline. Progress:

## Operating principles inherited

`docs/plans/goal.md` is not in the repository (referenced by older plans and by
the plan-doc conventions; `git log` finds no version of it on any branch). The
principles below are carried from the surviving plan corpus and this repo's
enforced gates. If goal.md is restored, re-derive this section from it verbatim.

- **Strangler/additive.** Every addition attaches to a named existing seam
  (`ProjectionStore` optional methods, the `sinks:` map, the owner-notification
  hook, `ApprovalBridge`). Nothing is rebuilt; the self-host path is not disturbed.
- **TDD, behavior-asserting.** Each phase names a negative proof — the test that
  must go red when the fix is reverted. A test whose assertions cannot fail is
  not evidence ([[reference-includes-assertions-dont-bite]]).
- **Make illegal states unrepresentable.** Hosted + `whatsapp: personal` should
  not typecheck-and-then-fail; it should not compose.
- **Verify against the right thing.** `workerd` locally before staging;
  repository-green is not deployment evidence
  ([[feedback-no-false-positive-verification]]).
- **Diagnose, don't dismiss.** A flaky channel test gets a read cause, not a
  retry ([[feedback-dont-dismiss-flake-without-diagnosis]]).

## Execution: parallelize with agents & workflows

Disjoint file ownership, so agents do not collide:

- **Phase 0** is a single small agent — it touches
  `.github/workflows/deploy-control-plane.yml` and composition guards only, and
  should land first because everything else assumes the path filter works.
- **Phases 1 and 2 run fully in parallel.** Phase 1 owns
  `authority/adapters/d1/**`; Phase 2 owns `channels/approval-*` +
  `claxedo-channels/src/core/approval-bridge.ts`. No shared files.
- **Phase 3.0 is the critical path.** It extends Phase 1's D1 port to the
  session surface, so it cannot start clean-room — but its *design* work
  (session-meta/message adapter shape, `durableSessionLog` semantics) can run
  concurrently with Phase 1 and land immediately after.
- **Phase 3.1 is the join** and must be one agent — the ack/execute split is a
  single coherent change across ingress and the wakes sink.
- **Phase 4** can start against a stubbed turn result while Phase 3.1 finishes.
- **Research in parallel, always:** the `durableSessionLog` D1 shape, the
  transaction shape for the atomic claim, and the streaming posture are
  three independent investigations that should run concurrently.

Cross-plan coordination: Phase 3.0 opens the hosted session-storage port. Build
exactly one D1 session adapter; later consumers reuse it.

Two standing hazards for parallel agents in this repo: **never `git stash`** on a
shared worktree ([[feedback-no-stash-shared-worktree]]), and `git commit --only`
is file-granular — a shared file touched by two agents needs a per-hunk "does
another commit make this stale?" check
([[reference-commit-only-is-file-granular]]).
