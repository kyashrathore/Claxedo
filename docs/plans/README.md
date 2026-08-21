# Claxedo Plans

Status: retained plans index
Last updated: 2026-08-19

This directory keeps active plans and concise dated references that still help
explain a maintained package or cross-package delivery contract.

## Retained Plans

- [OpenCode is just another harness — workstream index](./2026-08-19-000-opencode-just-another-harness-index.md)
  - Strategic index for demoting the vendored OpenCode engine from privileged
    control-plane default to one harness among peers, so any agent (including
    operator-configured ACP agents) attaches through the same registry. Four
    workstreams: the pre-existing scriptable-ACP plan (2026-07-22-001, with a
    drift note), WorkGraph harness-neutral local execution
    (2026-08-19-001: connection tools, session intake, and the composer
    catalog stop requiring the engine), the credentials engine-auth bridge
    scoped to the opencode domain so a credential write never boots the engine
    (2026-08-19-002), and the capstone making the embedded engine an
    opencode-adapter implementation detail with unknown runners becoming typed
    errors instead of silent OpenCode sessions (2026-08-19-003). Records what
    is deliberately kept: the OpenCode-compat HTTP surface, the vendored fork
    packages, and the product default harness.

- [Unified usage dashboard implementation and runbook](../usage-dashboard.md)
  - Completed delivery reference for revisioned provider-exact turn metering,
    cross-machine daily projections, provenance-safe current-machine history,
    quota parity, estimated pricing, the unified account-menu dialog, and its
    release/privacy/recovery gates. Retained because it defines the operational
    boundary between Claxedo usage, classified external usage, and quarantined
    history rather than treating Total as a simple sum.

- [Cross-harness subagents](./2026-08-07-002-feat-cross-harness-subagents-plan.md)
  - Active plan (U1–U13) making a subagent a first-class object on every harness
    that has one: recognized at spawn, status-tracked, and openable beside its
    parent session. Exists because the feature works on exactly one of eight
    rails — and is broken at a different layer on each, which is why it has
    never been fixed as one thing. Claude's tool was renamed `Task` → `Agent`
    and detection never followed; Codex has the richest subagent protocol of the
    three and every child-thread event is dropped by the driver before the
    adapter runs; Cursor emits an agent *type* where a session id belongs; the
    host `session` table has no `parent_id` column at all. Leads with the
    finding that broke the first draft: the persisting turn projector is
    server-side and parent-keyed, so forwarding nested events without routing
    them corrupts the parent transcript rather than revealing subagents.
    Replaces the degenerate one-field `subagent-spawned` event with one
    idempotent `subagent-updated` upsert keyed on the subagent itself
    (`(parentSessionId, subagentKey)`), treating the spawning tool call as a
    many-to-many edge — because one Codex call can address several subagents,
    several calls can address one, and a backgrounded Claude task has no call
    id at all.

- [Follow-up steer and queue](./2026-08-07-001-feat-followup-steer-queue-plan.md)
  - Active plan (U1–U11) making a message sent while the agent is working a
    reversible object: held client-side and shown dim, editable and cancellable
    while dim, promotable into the running turn, drained in order when the turn
    ends. Exists because the shipped `Settings → Follow-up behavior` row is
    doubly dead — the provider coerces `"queue"` back to `"steer"` and nothing
    consumes the value — while sending during a live turn behaves four different
    ways across the harness fleet, from a hard refusal to an undeclared silent
    fold-in to a concurrent second run on pi. Carries upstream capability
    research against the pinned SDKs: six of eight harnesses can steer, and
    Codex loses the ability purely by being run over ACP.

- [Portable Claxedo Apps platform](./2026-08-06-004-feat-portable-claxedo-apps-platform-design.md)
  - Umbrella architecture for every supported app form: private AI-authored
    gadgets, symmetric collaborative instances, blueprints, publisher-managed
    user-scoped apps, Gatekeeper-backed external apps, and public static sites.
    Defines instance/data/distribution policies, sandbox and sharing models,
    provider portability, UX journeys, hard problems, and sequencing against
    the multiplayer plan.

- [Portable managed mini-apps — Content Engine](./2026-08-06-003-feat-portable-managed-mini-apps-content-engine-design.md)
  - Reference vertical for the umbrella Apps platform's managed user-scoped
    mode: one immutable release line, private instance and SQLite-compatible
    data per app customer, browser capture, existing Claxedo AI and skills,
    scheduler connectors, provider alternatives, publisher UX, and portability.

- [Full-matrix real e2e](./2026-08-06-001-test-full-matrix-real-e2e-plan.md)
  - Active test plan (phases 0–6) extending Tier R from two lanes to the whole
    deployment matrix — packaged desktop and hosted web, unsigned and signed,
    embedded, user-hosted and cloud — with nothing stubbed but the AI model
    endpoint. Exists because a single 2026-08-05/06 session found twelve
    defects, four already shipped in v0.0.65, and every one sat in a blind spot:
    no lane runs the packaged app (so the whole `file://` renderer bug class was
    undetectable), and the status-dot proofs deliver events through the DEV
    `__claxedoEmitTestEvent` seam, staying green while nothing reached real
    users. Carries a defect → scenario coverage table for all twelve fixed and
    six open issues, and demotes boot/render assertions to diagnostics after the
    owner's correction that the app booted fine through every failure.

- [Tier R close-to-real e2e](./2026-08-01-001-test-tier-r-close-to-real-e2e-plan.md)
  - Active test plan (phases 0–5) adding a third e2e tier where the app, server,
    embedded engine, harness binaries, workspace-runtime, and relay are all real
    and only the model HTTP endpoint is a deterministic scripted server. Exists
    because every Tier M spec mocks the exact seam the managed-server → SDK
    migration moved, so a fully broken opencode flow shipped green; phase 2's
    spec is the red repro and its product fix is the acceptance demonstration.
- [CF reliability remaining](./2026-07-30-001-fix-cf-reliability-remaining-plan.md)
  - Active plan closing every finding the 2026-07-28 hosted-Cloudflare review
    left open (W1–W7): sandbox GC visibility, live-sync room sharding past the
    256-connection ceiling, a globally-enforced rate limit, durable control-route
    idempotency, the Convex index pass, the relay Blob landmine and Clerk
    membership drift, and the benches/drill that turn the scale claim into a
    measurement. Carries two corrections to the review: B1 was overstated
    (Daytona auto-stops at 15 min by default) and the relay's APAC pin is
    deliberate.
- [Claxedo public website strategy](./2026-07-20-001-feat-claxedo-website-strategy-plan.md)
  - Repository implementation and local launch acceptance are complete. The
    production cutover remains active pending a named hosting/edge owner,
    analytics provider and data owner, deployed smoke evidence, and the
    monitored retirement of the legacy documentation deployment.
- [Universal sandbox checkpoints](./2026-07-27-004-feat-universal-sandbox-checkpoints-plan.md)
  - Active plan completing `2026-07-23-002`'s `U6`: snapshot/restore for all
    seven drivers under BYOK, native capture preferred so most providers need no
    object-storage binding, a portable runtime-level artifact as the universal
    floor, and the seven checkpoint defects found reviewing the landed code.
- [PostHog observability](./2026-07-28-001-feat-posthog-observability-plan.md)
  - Active implementation plan (W0–W7): PostHog is the single stack for
    product analytics and error tracking across every runtime. Normative
    amendment source for launch streams F1, F6, and §7 owner decision #2.
- [Connections emulator E2E](./2026-07-06-005-test-connections-e2e-emulate-plan.md)
  - Retained as an active test plan. The connections package, server host,
    settings UI, and WorkGraph consumer still exist, and emulator endpoint seams
    are still pending before the browser E2E can run.
- [Self-host hosted parity channel loop](./2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md)
  - Retained as an active self-host/channel-loop test plan. CLI deploy/creds,
    pi harness, MCP, channels, and hosted auth code anchors still exist.
- [WorkGraph v2: durable work ledger](./2026-07-18-004-feat-workgraph-execution-shape-intake-trust-plan.md)
  - Active plan (rewritten 2026-07-18 after 12-simulation + market-research
    validation): three nouns (Stream/Task/Charter), per-stream master agents on
    wakes, two stream shapes (project/flow), the evidence layer (receipts +
    audit records + anti-reward-hacking gates), and the hard charter guardrails.
- [WorkGraph v2 implementation](./2026-07-18-005-feat-workgraph-v2-implementation-plan.md)
  - Companion technical plan to 2026-07-18-004: UX per surface with backend
    needs, HLD attaching every addition to a named existing seam (gateway,
    wakes sinks, command union, launchability oracle), and phased impl with
    exact files, tests, and DoD. Evolves the existing WorkGraph; nothing rebuilt.
- [Durable agents layer](./2026-08-05-001-feat-durable-agents-layer-plan.md)
  - Active API-first plan extracting the agent-turn primitives WorkGraph already
    runs (master, intake) into `@claxedo/agents`: Agent/Turn/Receipt as frozen
    contracts first, then the master onto the generic loop, then intake as the
    falsification test. Opens with the usage snippets the phases must make
    compile and run. Phase 0 (real wake budgets on the hosted lane, where
    `maxDepth` currently bounds nothing) is independently shippable. Settles the
    turn boundary (`succeeded | continue | failed` plus a wall-clock cap for a
    hung harness), per-turn profiles so an agent can switch harness/model between
    turns, stored-not-derived session identity with a transcript-compatibility
    rule, a namespaced tool-contribution registry (WorkGraph's REST operations
    are one source among several — the package names none of them), the
    agent-vs-worker transport split that generalizes the existing
    `workgraph-run-tools` broker, and the memory port as the thing that makes
    harness-switching viable. The shape it is designed for — agent as a
    pi-central session that spawns workers, which makes channel-triggering free —
    is blocked hosted until `projectionStore`/`durableSessionLog` get Convex
    adapters, so the phases stay harness-agnostic. Carries the 2026-08-05
    survey of ten durable-agent/execution candidates as evaluated-and-declined,
    with the re-open tripwire, plus three inherited defects: the wake reason
    never reaches the prompt, charter enforcement does not read the charter, and
    the hosted lane disables three of four wake budgets.
- [Channels on the hosted Worker](./2026-08-05-002-feat-channels-on-hosted-worker-plan.md)
  - Active plan making channel ingress work on the deployed Cloudflare Worker,
    which serves no channel routes today. Organizing decision: delivery-ack and
    turn-execution are separate invocations — the webhook verifies/dedups/enqueues
    and returns, a `channel_turn` wake provisions and prompts. Phases: workflow
    path-filter + composition guards, Convex-backed channel stores behind one
    two-backend conformance suite, a durable approval bridge (the memory `Map` is
    wrong once ack and execute are different isolates), the split itself, outbound
    replies via the unimplemented `workGraphNotifyOwner` seam, staging proof.
    A channel routes a thread to ONE central agent session and decides nothing
    else — no workspace, sandbox, or session lifetime; if work needs a repo the
    agent calls `spawn_session`, which is the acceptance loop `2026-07-07-002`
    already specifies. The in-request streaming generator is deleted on the
    hosted path rather than ported. Critical path is Phase 3.0: hosted sets both
    `projectionStore` and `durableSessionLog` to fail-closed `unusedStore` stubs,
    so a central agent session has nowhere to persist — the same blocker
    `2026-08-05-001` records, and the same port Phase 1 opens. One hosted session
    adapter serves both plans; do not build two.

## Maintenance

Delete completed plans when they no longer provide a maintained implementation,
deployment, testing, or package-boundary reference.
