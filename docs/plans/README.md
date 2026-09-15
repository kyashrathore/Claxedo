# Claxedo Plans

Status: retained plans index
Last updated: 2026-09-14

This directory keeps active plans and concise dated references that still help
explain a maintained package or cross-package delivery contract.

## Retained Plans

- [Session titles: harness-native where it exists, runtime-generated elsewhere](./2026-09-15-002-fix-session-auto-title.md) — proposed; not started.
  - Today the title is the first 72 characters of the first prompt, written
    by three separate owners and never replaced. Verified per harness: Claude
    Code and OpenCode generate titles natively (Claude's arrives only through
    `sessionStore.append` as an `ai-title` entry); ACP may
    (`session_info_update`); Codex, Pi and Cursor-local never do — Codex's
    own TUI generates client-side. Plan: `titleSource` rank
    (`user` > `harness` > `prompt`) enforced in the store, `runtime.ts` as the
    single producer, native titles ingested where they exist, and a
    per-harness `generateTitle` side turn (ephemeral Codex thread with
    structured output, one-shot `pi -p`, temp ACP session) written back to
    the harness's own listing. Fixes the Codex `threadName` field and the
    ACP `session-info` empty-title overwrite on the way.

- [Remote machine connection: implementation plan](./2026-09-14-003-feat-connect-implementation-plan.md) — P1–P3 implemented on `feat/connect`, live acceptance green; P4–P7 not started. Companions: [investigation](./2026-09-14-001-feat-connect-enrollment-foundation-proposal.md), [components and flows](./2026-09-14-002-feat-connect-components-and-flows.md).
  - First slice = invitation-file bootstrap with idempotent redeem,
    route-local machine verifier keyed by enrollment id with key-version and
    nonce guards, revision-aware assignment discovery, serving-generation
    fencing including relay host-tunnel checks, durable host state, serving
    with private sessions, Tier R fixture host with named fixture deliverables.
    Deferred: pending approvals, host folder ops and machine worktrees, project
    regrouping, idle metadata, desktop provenance work.

- [Onboarding v1: make setup yield to a working product](./2026-09-14-002-feat-onboarding-v1-repair.md) — proposed; not started.
  - Setup shows only when it has something to ask: first turn becomes a
    server-served inventory fact, harness logins are discovered at mount,
    project → AI → first turn is the required path, cloud and remote access
    become go-further cards, Skip setup writes the dismissal the mode already
    reads, and the first-project canvas is the no-project screen. Six observed
    defects listed with their owners.

- [Provider accounts: one provider, many logins, one active](./2026-09-12-001-feat-provider-accounts-design.md) — proposed; not started.
  - One explicit active account per provider, set in Settings → Providers
    with a Make active button; every session inherits it at its next turn.
    `is_active` column with a partial unique index replaces the invisible
    preference order; snapshot shape unchanged; Codex refresh writes back to
    the registry instead of `~/.codex/auth.json`; Claude second accounts via
    `claude setup-token`; provider env stripped because the CLI ranks an
    ambient API key above the OAuth token. Prior art: Orca, t3code
    `ProviderInstanceId`, the CLIs themselves. Per-session accounts are a
    recorded non-goal.

- [Claxedo mobile (Expo)](./2026-09-07-004-feat-claxedo-mobile-expo-app-plan.md) — proposed; not started.
  - Thin Expo 57 / RN 0.86 app for the attention loop only: card list, last
    turn + composer + plain diff, push notifications with Allow/Deny from the
    lock screen. Reuses the control-plane client and the three server
    additions from the MCP redesign; adds push registration and an attention
    notifier. Includes a stack survey of t3code, orca, superset, paseo and
    synara. No terminal, editor, relay or pairing — Claxedo already has the
    relay and account auth those apps had to build.

- [claxedo-mcp redesign](./2026-09-07-003-feat-claxedo-mcp-redesign-plan.md) — proposed; not started.
  - One streamable-HTTP MCP endpoint served by the running Claxedo (Worker,
    local server, self-hosted node) and installed by URL like any remote MCP;
    no stdio binary, no npm package; one client over the control plane with a
    per-workspace relay hop; tools
    derived from `SESSION_CORE_ROUTE_ACCESS`; attention tools with elicitation
    on terminal hosts (no MCP App; the phone UI is the Expo app, plan 004);
    `create_subagent` as the single cross-harness channel; one login per user.
    Supersedes the current `@claxedo/mcp` package and its defects.

- [Permissions, questions, and todos as transcript records](./2026-09-07-001-feat-transcript-interaction-records-plan.md) — proposed; not started.
  - Explains why the docks are transient today (pending tables deleted on
    reply; the transcript is parts only) and turns the three interactions into
    persisted parts materialized by the store's journal projection. Deletes the
    client-side request and todo caches; docks become views over pending parts.

- [Pi is a native harness; remove the central/VM split](./2026-09-05-004-pi-native-harness-remove-central-plan.md) — **implemented in worktree; acceptance pending**.
  - Standalone refactor. Pi uses the shared native adapter and its RPC process
    on local or cloud machines. Removes the central/hybrid/tools-only execution
    dimension, SessionEnv bridge and embedded Pi model backend. Includes
    credentials, native configuration, composer defaults, channel/wake/MCP
    consumer cutover and real local/cloud proof. This is a clean break: no
    legacy adapters, old-session migration or backward compatibility.
    Bootless agents remain a separate future feature. No Think dependency.
  - Supersedes the placement proposals 001–003; no longer folded into 005.
  - Native Pi, consumer cutover and Local browser checks pass. Packaged desktop,
    live provider refresh and staging Cloud acceptance remain open; the browser
    Cloud test is blocked by the existing account transport binding. See
    [cutover evidence](../tech-docs/pi-native-harness-cutover.md). Plan 005 stays blocked.

- [Claxedo agent base tier: durable agents on Cloudflare, machines on demand](./2026-09-05-005-think-agent-base-tier-plan.md) — **proposed; execute after 004 completes**.
  - New durable work-session feature using Project Think, with memory,
    workspace, scheduling, gateway and machine access. Code sessions retain
    the native harness architecture delivered by 004. This feature neither
    supersedes nor duplicates the Pi refactor, and its implementation does not
    run concurrently with it. Resolve its design-review findings before execution.

- [Reliable product reporting, error reporting, and distributed tracing](./2026-09-05-1600-feat-product-errors-tracing-plan.md) — proposed implementation plan.
  - Covers unsigned/signed local, hosted and user-hosted modes; separate product,
    error and trace policies; safe offline journals and reviewed support uploads;
    canonical usage/funnels; durable delivery and privacy/deletion qualification.
    Includes 17 implementation units, an explicit 18-journey inventory, a
    consolidation/deletion map, agent-app benchmark performance integration,
    and real packaged/deployed release gates.
    Runtime integration follows the settled Pi refactor in 004. Supersedes the
    tracing exclusion in the July 28 PostHog observability plan.

- [Pi is a native harness; remove the central/VM split](./2026-09-05-004-pi-native-harness-remove-central-plan.md) — **active; execute first**.
  - Standalone refactor. Pi uses the shared native adapter and its RPC process
    on local or cloud machines. Removes the central/hybrid/tools-only execution
    dimension, SessionEnv bridge and embedded Pi model backend. Includes
    credentials, native configuration, composer defaults, channel/wake/MCP
    consumer cutover and real local/cloud proof. This is a clean break: no
    legacy adapters, old-session migration or backward compatibility.
    Bootless agents remain a separate future feature. No Think dependency.
  - Supersedes the placement proposals 001–003; no longer folded into 005.

- [Claxedo agent base tier: durable agents on Cloudflare, machines on demand](./2026-09-05-005-think-agent-base-tier-plan.md) — **proposed; execute after 004 completes**.
  - New durable work-session feature using Project Think, with memory,
    workspace, scheduling, gateway and machine access. Code sessions retain
    the native harness architecture delivered by 004. This feature neither
    supersedes nor duplicates the Pi refactor, and its implementation does not
    run concurrently with it. Resolve its design-review findings before execution.

- [OpenCode v2 worker runtime on workerd with a credential gateway](./2026-09-05-003-opencode-v2-worker-runtime-plan.md) — superseded by 004.
- [Pi worker runtime and credential gateway on workerd](./2026-09-05-002-pi-worker-runtime-and-gateway-plan.md) — superseded by 004.

- [workerd agents: bootless chat with coding environments on demand](./2026-09-05-001-agent-worker-chat-and-coding-design.md) — superseded by 004.
  - Original architecture and UX grounded in current Pi execution, session
    authority, frontend routing and sandbox lifecycle code. Separates harness
    placement, working files and compute; preserves workspace-less chat, adds
    coding environments on demand, and defines capability gates for embedded
    OpenCode and extended Pi in workerd through the existing extension lifecycle,
    isolated module bundles, scoped bindings and durable session coordination.
    Runtime/extension/machine-work proposals are superseded by reviewed 002;
    retain its current-code analysis and composer/defaults design. The user
    guide follows 002. No runtime implementation yet.

- [OpenCode is just another harness — workstream index](./2026-08-19-000-opencode-just-another-harness-index.md)
  - Strategic index for demoting the vendored OpenCode engine from privileged
    control-plane default to one harness among peers, so any agent (including
    operator-configured ACP agents) attaches through the same registry. Three
    workstreams: the pre-existing scriptable-ACP plan (2026-07-22-001, with a
    drift note), the credentials engine-auth bridge
    scoped to the opencode domain so a credential write never boots the engine
    (2026-08-19-002), and the capstone making the embedded engine an
    opencode-adapter implementation detail with unknown runners becoming typed
    errors instead of silent OpenCode sessions (2026-08-19-003). Records what
    is deliberately kept: the OpenCode-compat HTTP surface, the vendored fork
    packages, and the product default harness.

- [Cross-harness subagents](./2026-08-07-002-feat-cross-harness-subagents-plan.md)
  - Plan (U1–U13) making a subagent a first-class object on every harness
    that has one: recognized at spawn, status-tracked, and openable beside its
    parent session. The runtime half landed in `425358fab3`: Claude's `Agent`
    tool is detected, Codex child-thread notifications are routed by
    `parentThreadId`/`senderThreadId` instead of dropped, Cursor promotes the
    real `agentId`/`transcriptPath`, the host `session` table has `parent_id`,
    and every adapter declares the `subagents` capability. Its per-rail defect
    table is therefore a record, not a backlog; the open items are the
    unchecked Definition of Done entries (child-pane UX, transcript handles,
    reload and crash semantics, fixture regeneration). Leads with the finding
    that broke the first draft: the persisting turn projector is server-side
    and parent-keyed, so forwarding nested events without routing them corrupts
    the parent transcript rather than revealing subagents. Replaces the
    degenerate one-field `subagent-spawned` event with one idempotent
    `subagent-updated` upsert keyed on the subagent itself
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
    left open: sandbox GC visibility, live-sync room sharding past the
    256-connection ceiling, a globally-enforced rate limit, the relay Blob
    landmine, and the benches/drill that turn the scale claim into a
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
  - Retained as an active test plan. The connections package, server host, and
    settings UI still exist, and emulator endpoint seams are still pending
    before the browser E2E can run.
- [Self-host hosted parity channel loop](./2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md)
  - Retained as an active self-host/channel-loop test plan. CLI deploy/creds,
    pi harness, MCP, channels, and hosted auth code anchors still exist.
- [Channels on the hosted Worker](./2026-08-05-002-feat-channels-on-hosted-worker-plan.md)
  - Active plan making channel ingress work on the deployed Cloudflare Worker,
    which serves no channel routes today. Organizing decision: delivery-ack and
    turn-execution are separate invocations — the webhook verifies/dedups/enqueues
    and returns, a `channel_turn` wake provisions and prompts. Phases: workflow
    path-filter + composition guards, D1-backed channel stores behind one
    two-backend conformance suite, a durable approval bridge (the memory `Map` is
    wrong once ack and execute are different isolates), the split itself, outbound
    replies via the unimplemented owner-notification seam, staging proof.
    Sequencing amendment: plan 004 removes this central-execution assumption;
    machine-backed channel delivery must use its native session path. A durable
    bootless channel agent belongs to the later plan 005. The original proposal
    below describes the pre-cutover design: a channel routes a thread to ONE
    central agent session and decides nothing
    else — no workspace, sandbox, or session lifetime; if work needs a repo the
    agent calls `spawn_session`, which is the acceptance loop `2026-07-07-002`
    already specifies. The in-request streaming generator is deleted on the
    hosted path rather than ported. Critical path is Phase 3.0: hosted sets both
    `projectionStore` and `durableSessionLog` to fail-closed `unusedStore` stubs,
    so a central agent session has nowhere to persist — the same port Phase 1
    opens. Build exactly one hosted session adapter.

## Maintenance

Delete completed plans when they no longer provide a maintained implementation,
deployment, testing, or package-boundary reference.
