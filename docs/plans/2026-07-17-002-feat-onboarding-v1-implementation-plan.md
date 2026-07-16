---
title: "Onboarding v1 — Implementation Plan"
type: feat
date: 2026-07-17
status: active
companion_of: docs/plans/2026-07-16-005-feat-onboarding-product-and-ux.md
inherits: docs/plans/goal.md (operating principles + quality gates)
related:
  - docs/brainstorms/2026-07-16-claxedo-onboarding-journey.md
  - docs/plans/2026-07-16-004-feat-explicit-secrets-ux-plan.md
  - docs/plans/2026-07-17-001-review-remote-desktop-access-feasibility.md
---

# Onboarding v1 — Implementation Plan

Technical implementation plan for the onboarding experience described in the
[product companion](./2026-07-16-005-feat-onboarding-product-and-ux.md). That
doc owns the mental model and per-feature UX; this doc owns **units, contracts,
edge cases, and Definition of Done**. The brainstorm owns activation strategy
and open questions Q1–Q10.

## Inherited operating principles (from `docs/plans/goal.md`)

These are release gates for every unit below, not aspirations:

1. **One reactive data graph.** TanStack Query owns server data, Store owns
   app/layout state. `onboardingState()` is a **derived selector** over
   existing queries — no second store, no onboarding tables, no event reducer,
   no watchdog. Only *dismissals* persist.
2. **UI parity + motion parity as a release gate.** The setup card and
   checklist must not blank loaded content, jump-appear, shift unrelated
   content, or jank. Home with existing projects must look and behave exactly
   as today for a returning user.
3. **Strangler / additive.** Every unit ships additively behind a derived
   condition; old dead-ends (disabled composer, "configure in Settings"
   warnings) are only removed once their replacement has all consumers.
4. **TDD + behavior-asserting state-machine tests.** Core selectors and step
   state machines get red→green→refactor with transition tests before UI.
5. **Make illegal states unrepresentable.** A step cannot be `done` without its
   verification result; a `shared` credential cannot exist without consent
   (secrets plan); a locked step cannot be actioned.
6. **Per-slice verification loop with vision review.** Each UI unit ends with a
   browser-driven flow + vision-reviewed screenshot/video; green unit tests are
   claims, not proof (house rule: no false-positive verification).

## Dependency map & blockers

| Depends on | State | Blocks |
| --- | --- | --- |
| Secrets plan `2026-07-16-004` Phases 1–3 | planned, independent | Units O3, O4 (AI connect surfaces) |
| Device-login Phase A (`CLAXEDO_DEVICE_LOGIN_ISSUER`) | fails closed 501 by design | O4 web `claxedo connect`, O8 remote access, hosted sign-in |
| Relay + hosted control-plane staging deploy | code complete, never deployed | O7 web compute end-to-end, O8 remote access |
| pi-provider-model-selection plan `2026-07-12-002` | planned | O5 model-default tables |
| Connections framework GitHub integration | PAT `verify()` only — no repo listing, no tokened clone (verified) | O6 web repo picker |
| Provider-credential tenancy (no org column — verified) | open (Q8) | any team-scope onboarding (out of v1) |

**Sequencing rule:** Units O1–O2 (framework) unblock everything and ship
first. O3–O5 (desktop Ramp-1) are the launch-critical path and depend only on
the secrets plan. O6–O8 (web + remote) depend on external blockers above and
ship as those land — they must not gate the desktop launch.

## Units

### O1 — `onboardingState()` selector + step registry

The spine. A derived selector and a step registry; no UI.

- Selector inputs (all existing queries — no new persistence except
  dismissals): has-project (recents), AI credential + health
  (`GET /api/claxedo/credentials`, gains `health`/`scope`/`last_used_at` from
  secrets plan), runnable-harnesses (O5), sandbox-provider-configured
  (workspace-providers endpoint), first-turn / first-cloud-turn (session/turn
  queries), hosted-sign-in (auth session), remote-access-enabled (O8),
  second-device-open (O8).
- Step registry: `{ id, appliesTo(surface), isDone(state), isLocked(state),
  cta, education, verify? }`. One list drives setup card, checklist, and
  "Go further" cards.
- Surface-awareness: machine-local credentials count on this machine only;
  `shared` credentials count everywhere (so machine #2 reads "keys live on
  your other machine", not a false done/undone).
- Dismissals persist: local `Persist.global`, hosted per-user KV. Nothing else.

**DoD**
- [ ] `onboardingState()` is pure-derived; a test proves zero writes to any
      store on read, and that a Settings-driven change (e.g. credential added)
      flips the relevant step with no onboarding-specific mutation.
      Progress:
- [ ] Registry `isDone`/`isLocked`/`appliesTo` have exhaustive transition
      tests per surface (desktop/web/self-host) incl. the locked→unlocked edge
      for steps 3–4.
      Progress:
- [ ] Surface-awareness test: same account, machine A (local cred) vs machine B
      → step states differ correctly; `shared` cred counts on both.
      Progress:
- [ ] Dismissal round-trips (local + hosted stub); dismissed cards never
      re-spawn.
      Progress:

### O2 — Setup card, checklist, "Go further" cards (Home shell)

The visible container; renders O1, mounts step components (O3–O8) inline.

- Home route: replaces the bare empty state with the setup card in the hairline
  card language (step list + inline active-step content pane). Returning users
  with projects see today's Home unchanged (parity gate).
- Four steps always visible; locked steps render with unlock condition. Skip
  per step (except web required steps); whole-card dismiss → collapses to
  checklist. Post-first-turn morph → "Go further" cards (individually
  dismissible).
- **Just-in-time rule:** interventions open the step-local dialog directly, not
  the card; the card re-derives afterward.

**DoD**
- [ ] Parity: returning-user Home (has projects) is pixel/behavior-identical to
      pre-change; screenshot diff recorded.
      Progress:
- [ ] Card state machine (form → checklist → go-further) transition-tested;
      no content blank/jump/shift on any transition (motion gate; recorded
      video).
      Progress:
- [ ] Locked step shows condition, is un-actionable; unlocking (first turn /
      cloud workspace / remote toggle) activates it live.
      Progress:
- [ ] Step components are single implementations shared with Settings + JIT
      (asserted by import graph — no duplicate step UI).
      Progress:

### O3 — AI connect step (desktop Discover + surfaces)

Wraps the secrets plan's discover/save surfaces as onboarding step 2 and the
composer JIT re-entry. Owns none of the secrets mechanics; owns the placement,
verification gate, and honesty copy.

- Desktop: Discover dialog embedded as the step; API-key entry equally
  prominent (not a fallback). Cursor **not** claimed discoverable; opencode
  discovery Windows-gap surfaced honestly (verified `credentials/sync.ts`).
- Done = **proven**: after save, the credential verify op (O9) must return ok
  before the checkmark; broken states show "connected, not working" + fix.
- JIT: disabled composer selector → "Connect an AI provider to send" opens the
  Discover/Connect dialog directly (not the form).

**DoD**
- [ ] Step green only after a real verify pass; a saved-but-invalid key shows
      the amber state with the provider error (test with a stub 401/no-billing).
      Progress:
- [ ] No copy claims Cursor discovery; Windows opencode gap messaged.
      Progress:
- [ ] Composer JIT opens the dialog directly; after connect, composer becomes
      sendable with no form round-trip (state-machine test).
      Progress:
- [ ] Browser flow: discover → uncheck one → save → unchecked provider absent
      from `GET /credentials`; vision-reviewed screenshot.
      Progress:

### O4 — AI connect step (web: OAuth / `claxedo connect` / key)

Web variant of step 2: provider cards.

- OAuth where the vendor supports it; else the copyable `npx claxedo connect
  <provider>` device-code card with live "waiting for terminal…" → "Connected
  ✓" (reuses secrets-plan Phase 3 device-code push; polls existing listing).
- API-key paste for simple keys.
- **Blocker:** device-code path needs Phase A issuer; until then the card shows
  honest "coming soon / use desktop" copy, OAuth + key paths still work.

**DoD**
- [ ] `claxedo connect` card flips to Connected ✓ via listing poll after CLI
      push (integration test against a local hosted-mode server; assert secret
      never appears in browser network trace).
      Progress:
- [ ] Phase-A-unconfigured → device-code card degrades honestly, OAuth/key
      still functional.
      Progress:
- [ ] Verify gate identical to O3 (proven, not saved).
      Progress:

### O5 — Credential → harness → model resolution

Fixes the "connected but nothing runs" trap. Pure function + composer wiring.

- Map verified-credential-set → runnable harnesses from
  `agent-sdk-runtime/src/harness-types.ts` auth slots + `pi-credentials.ts`
  provider mapping (verified: default harness `opencode` is OPENAI-slotted; a
  Claude-only user runs only `claude` + anthropic-`pi`).
- On AI-step completion: set session default harness to the best runnable one;
  set a deterministic default model per provider (tables owned by
  pi-provider-model-selection plan — consume, don't duplicate).
- Composer badge renders the resolution; "any harness" education renders its
  honest inverse (which harnesses this credential unlocks).
- Fence the placeholder: `SIGNED_WORKSPACE_DEFAULT_MODEL` ("big-pickle") must
  be treated as **no model** by the blocked-composer path — never submittable
  (verified: it has no serving path).

**DoD**
- [ ] Resolution function: exhaustive table test (anthropic-only, openai-only,
      codex, cursor, multi, none) → correct runnable-harness set + default.
      Progress:
- [ ] Claude-only account lands on a runnable harness+model; first turn is not
      dead (integration test).
      Progress:
- [ ] Placeholder is unreachable for submit; blocked path routes to Connect
      (state-machine test).
      Progress:

### O6 — Web repo picker (connections framework + server)

New capability — none exists today (verified: GitHub integration is PAT
`verify()`-only; no repo listing in `IntegrationImpl`; cloud create is raw
`repoUrl`; `git clone` injects no token).

- v1: add `listRepositories` capability to the `code-host` integration
  interface; GitHub impl calls `GET /user/repos` with the stored fine-grained
  PAT. Cloud project creation accepts `{ connectionId, repo }`; server resolves
  the token at clone time and injects it (`x-access-token`) — token never in
  stored config, env, or logs.
- Access probe → read/write badges (push scope checked, not just clone).
- Escape hatches: example public repo (no auth), raw public URL, PAT/deploy-key
  for private non-GitHub.
- **Fast-follow (not v1):** GitHub App (org-approvable, per-repo install,
  installation tokens for PRs) — Q7.

**DoD**
- [ ] `listRepositories` returns the user's repos; picking one creates a
      project bound to `{connectionId, repo}` (test with a stubbed GitHub API).
      Progress:
- [ ] Private repo clones via injected token; token absent from config/env/log
      (assert by scanning the persisted workspace config + captured clone
      command).
      Progress:
- [ ] Read/write badges reflect a real permissions probe; read-only repo shows
      write ✗ with guidance.
      Progress:
- [ ] Example-public-repo path completes step 1 with zero GitHub auth.
      Progress:

### O7 — Compute step (web) + provision UX fixes

Web step 3 as a sub-funnel; also fixes the confirmed provisioning bugs.

- Provider chooser with per-driver cost/free-tier facts + what's needed; deep
  link to key page; resume deep-link back to this exact step; demo tour offered
  at the wall.
- **Verification provision = the first workspace provision** (one provision,
  not two); provisioning progress hosts the long-running-process education.
- Typed failure taxonomy (bad key / no payment method / quota / region) with
  retry in place — replaces the raw-message + Back dead end.
- **Bug fixes (confirmed, chips filed):** kill the false "Retrying
  automatically…" copy and the 120s navigate-anyway timeout in
  `create-cloud-workspace.tsx`.

**DoD**
- [ ] One provision serves both verification and first workspace (no double
      spend); asserted by provision-call count in an integration test.
      Progress:
- [ ] Each failure class renders its typed message + correct fix action + retry
      (stub each driver error).
      Progress:
- [ ] The false auto-retry copy and navigate-anyway timeout are gone;
      regression test proves no navigation without a `ready` event.
      Progress:
- [ ] Resume deep-link returns to step 3 with prior state intact.
      Progress:

### O8 — Remote access step (desktop toggle, one tunnel per machine)

Desktop step-4 unlock via "Enable remote access" (review `2026-07-17-001`).

- Toggle → hosted sign-in (if needed) → embedded claxedo-server enrolls the
  machine (app-owned host key, existing challenge/sign/register) and starts
  **one** relay tunnel registering `{ hostId, workspaceIds: [...all local
  projects] }` via `startUserHostedWorkspaceTunnel`. New projects = registration
  updates on the same socket. App is the daemon; start-at-login = reboot
  survival.
- Settings **Devices** list: enrolled machines, last-seen, revoke (rides
  `runtimeAccessTokens` revocation).
- QR panel: link to `/w/<workspaceId>`; step proven by second-device open
  (marker param → server records `second_device_open`).
- **Never expose the local control plane** — phone reaches the machine only as
  workspace backings through hosted auth (the review's showstopper boundary).
- **Blockers:** Phase A + relay/hosted deploy; until then step stays locked
  with honest copy. **Q9** (mobile viewport) and **Q10** (local-session
  visibility) resolved before ship — if mobile compose is rough, scope copy to
  "monitor + reply".

**DoD**
- [ ] One tunnel serves ≥2 workspaces concurrently (multiplex test: interleaved
      requests for two workspaces over one socket, both resolve).
      Progress:
- [ ] New project after enroll appears remotely via registration update, no new
      connection/process (asserted by tunnel/connection count).
      Progress:
- [ ] Revoke from Devices kills remote access for that machine (revocation
      test); local (loopback) app still works unauthenticated.
      Progress:
- [ ] Local control-plane routes are unreachable through the relay (negative
      test: a relayed request to a `CentralServer`-owned route is refused).
      Progress:
- [ ] Second-device open flips the step done; QR link resolves on a phone
      viewport (or copy scoped to monitor+reply per Q9).
      Progress:

### O9 — Verification operations (shared)

The "proven, not saved" backbone consumed by O3/O4/O6/O7/O8.

- `POST /api/claxedo/credentials/:id/verify` — server-side 1-token completion
  per provider; typed result `ok | auth_failed | no_billing | rate_capped |
  expired`. NEW endpoint. Feeds the `health` field the Connections page shows
  (one truth, both surfaces).
- Repo probe (`git ls-remote` + GitHub permissions) → O6 badges.
- Compute = existing provision pipeline (O7).
- First-turn error taxonomy (O10) server-side.

**DoD**
- [ ] `verify` returns each typed result against stubbed provider responses;
      never leaks secret material (snapshot redaction test).
      Progress:
- [ ] `health` in `GET /credentials` and the Connections page derive from the
      same verify result (no divergent second computation).
      Progress:

### O10 — First-prompt moment + failed-first-turn screen

The exit of the form; the highest-leverage screens.

- Starter prompts: v1 **non-AI** — two static templates + one repo-derived
  suggestion (README heading / dominant language / first TODO, cheap server
  signals), generated at project-open, cached on the project. Chips above the
  composer, only when the project has zero completed turns, gone after first
  send.
- Failed-first-turn card: error taxonomy (`credential | harness | model |
  workspace`) → one recovery action each; draft preserved; model-class offers
  one-click model switch. Lives in the session timeline error slot; taxonomy
  server-side so CLI/channels inherit it later.

**DoD**
- [ ] Starter chips appear only for zero-turn projects, disappear after first
      send (state-machine test); repo-derived suggestion reflects the repo.
      Progress:
- [ ] Each failure class renders its recovery action; draft survives; model
      switch retries in place (stub each class).
      Progress:
- [ ] Browser flow: force a `credential` failure → card → fix → successful
      turn; vision-reviewed recording.
      Progress:

### O11 — Funnel instrumentation

Events so the primary funnel isn't blind.

- Events: `signup`, `setup_form_shown/dismissed`, `step_done{step,surface}`,
  `step_verify_failed{step,class}`, `provider_connected`, `first_turn_ok`,
  `first_turn_failed{class}`, `sandbox_provider_configured`,
  `first_cloud_turn_ok`, `remote_access_enabled`, `second_device_open`,
  `gofurther_card_clicked/dismissed{card}`.
- Hosted: on. **OSS/self-host: off pending Q6** — recommended first-run
  explicit opt-in prompt. Designed now so stall-triggered lifecycle email can
  consume them later (post-launch).

**DoD**
- [ ] Every event fires at its moment (test harness asserts emission);
      OSS build defaults off; opt-in prompt gates emission when Q6 lands.
      Progress:

## Overall Definition of Done

- [ ] No credential/step is `done` without a real verification pass (O3/O4/O6/
      O7/O9) — enforced by construction (done-state requires verify result).
- [ ] Desktop Ramp-1 (O2/O3/O5/O10): fresh launch → 2-step form → first turn,
      TTFAT ≤ ~2 min zero-typing on a machine with discoverable subs; measured
      in a scripted run.
- [ ] A Claude-only account never lands on an unrunnable harness/model (O5).
- [ ] Returning-user Home is pixel/behavior-identical (O2 parity gate).
- [ ] `onboardingState()` is pure-derived; no new store or tables; only
      dismissals persist (O1).
- [ ] Web repo picker clones a private repo with an injected token that never
      appears in config/env/logs (O6).
- [ ] Remote access uses one tunnel per machine serving all workspaces; local
      control plane is never reachable through the relay; revoke works (O8).
- [ ] Confirmed provisioning bugs (false auto-retry, navigate-anyway timeout)
      are gone (O7).
- [ ] Every UI unit has a vision-reviewed screenshot/video of its real flow
      (paths recorded in Progress slots) — no unit marked done on green tests
      alone.
- [ ] Blocked units (O4 device-code, O7 end-to-end, O8) degrade honestly when
      Phase A / relay deploy are absent; none of them gate the desktop launch.

## Edge cases

- Discovery finds an already-connected credential → preview marks it, checkbox
  disabled (idempotent).
- Two Codex accounts under `~/.codex/accounts/` → both shown with account ids.
- Credential expires between discover and verify → verify returns `expired`,
  amber state, reconnect.
- Repo too large / monorepo subdir / 500-repo account (picker search) — O6.
- Provision succeeds but first turn fails → O10 taxonomy, not a dead session.
- User dismisses the whole form then hits a wall → JIT dialog opens directly;
  checklist still reflects truth.
- Machine #2, same account → surface-aware state (O1), honest "keys live on
  your other machine".
- Remote toggle enrolled, then user opens a brand-new project → appears
  remotely with no new tunnel (O8).
- Revoke a device with an open remote PTY → session drops on next auth (note:
  no mid-stream re-auth in relay v1 — documented limitation, not a blocker).

## Execution: parallelize with agents & workflows

Per goal.md operating rules (parallel agents for disjoint ownership; parallel
tool calls for independent reads/tests):

- **Wave 1 (unblocks all):** O1 selector+registry and O9 verify endpoint are
  disjoint (app selector vs server route) → two parallel agents. O2 shell
  starts once O1's types exist.
- **Wave 2 (desktop Ramp-1, launch-critical):** O3 (AI connect UI), O5
  (resolution function + composer wiring), O10 (starter prompts + failure
  card) have disjoint ownership (dialog / pure-fn+composer / timeline) → three
  parallel agents. O5's pure function lands first as O3/O10 depend on its
  output shape.
- **Wave 3 (web + remote, blocker-gated):** O4, O6, O7, O8 are mutually
  disjoint (device-code card / connections+clone / compute dialog / desktop
  tunnel+Devices) → up to four parallel agents/worktrees; each ships when its
  external blocker lands, none gate Wave 2.
- **O11** rides alongside as a thin cross-cutting agent.
- **Verification Workflow per unit:** a pipeline of targeted server test lists
  + `tsgo -b` typecheck + app unit tests (`--conditions=browser`) +
  browser-use flow drive as parallel stages; an adversarial verifier agent
  attacks each new server route (O6/O8/O9) trying to (a) get secret material
  out of a response, (b) reach a `CentralServer` route through the relay, (c)
  mark a step done without a verify pass. Findings gate the unit.
- **Research spikes (background, gate Wave 3 copy not Wave 2 code):** Q1
  Anthropic browser-OAuth availability, Q9 mobile viewport audit against the
  real app, Q10 session-placement decision.
